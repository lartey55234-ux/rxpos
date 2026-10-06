/**
 * Recurring plan billing.
 *
 * A paid plan is never activated because the browser says it paid. The owner is
 * sent to Paystack's hosted card checkout; the server verifies the transaction,
 * then switches the tenant plan in the same transaction that records the billing
 * state. Paystack owns the monthly schedule and card details.
 */

import type { Actor } from "./actor.ts";
import type { Database } from "./storage/index.ts";
import { TenantScope } from "./tenant.ts";
import type { PaymentGateway } from "./payments.ts";
import { PaymentError, newPaymentReference } from "./payments.ts";
import { PLAN_SEED, type PlanSeed } from "./plans.ts";
import { writeAudit } from "./audit.ts";
import { AuthError } from "./auth.ts";
import { ValidationError, newId, nowIso } from "./util.ts";

export type BillingCheckout = {
  reference: string;
  authorizationUrl: string;
  accessCode: string;
  planId: string;
  amountPesewas: number;
};

type CheckoutRow = {
  checkout_id: string;
  tenant_id: string;
  user_id: string;
  plan_id: string;
  reference: string;
  provider: string;
  provider_plan_code: string;
  amount_pesewas: number;
  status: string;
};

type BillingRow = {
  billing_id: string;
  tenant_id: string;
  subscription_id: string | null;
  plan_id: string;
  provider: string;
  provider_plan_code: string;
  provider_subscription_code: string | null;
  provider_email_token: string | null;
  provider_customer_code: string | null;
  status: string;
  current_period_start: string | null;
  current_period_end: string | null;
  next_payment_at: string | null;
  last_reference: string | null;
  updated_at: string;
};

const RESERVED_EMAIL = /\.(example|local|localhost|invalid|test)$/i;

function nextMonth(from = new Date()): string {
  const date = new Date(from);
  date.setUTCMonth(date.getUTCMonth() + 1);
  return date.toISOString();
}

function paidPlan(planId: string): PlanSeed {
  const plan = PLAN_SEED.find((candidate) => candidate.plan_id === planId);
  if (!plan || plan.price_pesewas <= 0) throw new ValidationError("Choose a paid plan");
  return plan;
}

async function ownerEmail(actor: Actor): Promise<string> {
  if (actor.role !== "owner") throw new AuthError("Only the owner can manage billing");
  const row = await actor.scope.get<{ email: string }>(
    "SELECT email FROM users WHERE tenant_id = {{tenant}} AND user_id = ? AND role = 'owner'",
    actor.userId,
  );
  const email = (row?.email ?? "").trim().toLowerCase();
  if (!email || RESERVED_EMAIL.test(email)) {
    throw new ValidationError("Add a real owner email before starting a subscription");
  }
  return email;
}

async function providerPlan(db: Database, gateway: PaymentGateway, plan: PlanSeed): Promise<string> {
  const existing = await db.get<{ provider_plan_code: string }>(
    "SELECT provider_plan_code FROM billing_plan_links WHERE plan_id = ? AND provider = ?",
    [plan.plan_id, gateway.name],
  );
  if (existing) return existing.provider_plan_code;

  const created = await gateway.createSubscriptionPlan({
    name: `rxpos ${plan.name} — monthly`,
    amountPesewas: plan.price_pesewas,
    interval: "monthly",
  });
  await db.run(
    "INSERT INTO billing_plan_links (plan_id, provider, provider_plan_code, created_at) VALUES (?, ?, ?, ?)",
    [plan.plan_id, gateway.name, created.planCode, nowIso()],
  );
  return created.planCode;
}

export async function startSubscriptionCheckout(
  actor: Actor,
  gateway: PaymentGateway,
  planId: string,
): Promise<BillingCheckout> {
  const email = await ownerEmail(actor);
  const plan = paidPlan(planId);
  const current = await actor.scope.tenant<{ plan_id: string }>();
  const billing = await actor.scope.get<BillingRow>(
    "SELECT * FROM subscription_billing WHERE tenant_id = {{tenant}}",
  );
  if (current.plan_id === planId && billing?.status === "active") {
    throw new ValidationError(`${plan.name} is already the active plan`);
  }

  const planCode = await providerPlan(actor.scope.db, gateway, plan);
  const reference = `rxsub_${newPaymentReference().slice("rxpos_".length)}`;
  const initialised = await gateway.initializeSubscription({
    email,
    planCode,
    reference,
    metadata: { tenantId: actor.scope.tenantId, userId: actor.userId, planId },
  });

  await actor.scope.run(
    "UPDATE billing_checkouts SET status = 'abandoned' WHERE tenant_id = {{tenant}} AND status = 'pending'",
  );
  await actor.scope.insert("billing_checkouts", {
    checkout_id: newId("bco"),
    user_id: actor.userId,
    plan_id: planId,
    reference: initialised.reference,
    provider: gateway.name,
    provider_plan_code: planCode,
    amount_pesewas: plan.price_pesewas,
    status: "pending",
    created_at: nowIso(),
    confirmed_at: null,
  });

  return {
    reference: initialised.reference,
    authorizationUrl: initialised.authorizationUrl,
    accessCode: initialised.accessCode,
    planId,
    amountPesewas: plan.price_pesewas,
  };
}

async function putBilling(
  db: Database,
  tenantId: string,
  values: Omit<BillingRow, "billing_id" | "tenant_id" | "updated_at">,
): Promise<void> {
  const scope = new TenantScope(db, tenantId);
  const existing = await scope.get<{ billing_id: string }>(
    "SELECT billing_id FROM subscription_billing WHERE tenant_id = {{tenant}}",
  );
  const now = nowIso();
  if (!existing) {
    await scope.insert("subscription_billing", {
      billing_id: newId("bil"),
      ...values,
      updated_at: now,
    });
    return;
  }
  await scope.run(
    `UPDATE subscription_billing
        SET subscription_id = ?, plan_id = ?, provider = ?, provider_plan_code = ?,
            provider_subscription_code = ?, provider_email_token = ?, provider_customer_code = ?,
            status = ?, current_period_start = ?, current_period_end = ?, next_payment_at = ?,
            last_reference = ?, updated_at = ?
      WHERE tenant_id = {{tenant}}`,
    values.subscription_id,
    values.plan_id,
    values.provider,
    values.provider_plan_code,
    values.provider_subscription_code,
    values.provider_email_token,
    values.provider_customer_code,
    values.status,
    values.current_period_start,
    values.current_period_end,
    values.next_payment_at,
    values.last_reference,
    now,
  );
}

async function activateCheckout(db: Database, checkout: CheckoutRow, customerCode: string | null): Promise<void> {
  const now = nowIso();
  const periodEnd = nextMonth(new Date(now));
  await db.transaction(async (trx) => {
    const scope = new TenantScope(trx, checkout.tenant_id);
    const current = await scope.get<BillingRow>(
      "SELECT * FROM subscription_billing WHERE tenant_id = {{tenant}}",
    );
    const subscriptionId = newId("sub");
    await scope.run(
      "UPDATE subscriptions SET status = 'superseded', expires_at = ? WHERE tenant_id = {{tenant}} AND status = 'active'",
      now,
    );
    await scope.insert("subscriptions", {
      subscription_id: subscriptionId,
      plan_id: checkout.plan_id,
      started_at: now,
      expires_at: null,
      amount_pesewas: checkout.amount_pesewas,
      status: "active",
    });
    await scope.run("UPDATE tenants SET plan_id = ? WHERE tenant_id = {{tenant}}", checkout.plan_id);
    await scope.run(
      "UPDATE billing_checkouts SET status = 'confirmed', confirmed_at = ? WHERE tenant_id = {{tenant}} AND checkout_id = ?",
      now,
      checkout.checkout_id,
    );
    await putBilling(trx, checkout.tenant_id, {
      subscription_id: subscriptionId,
      plan_id: checkout.plan_id,
      provider: checkout.provider,
      provider_plan_code: checkout.provider_plan_code,
      provider_subscription_code: current?.provider_subscription_code ?? null,
      provider_email_token: current?.provider_email_token ?? null,
      provider_customer_code: customerCode ?? current?.provider_customer_code ?? null,
      status: "active",
      current_period_start: now,
      current_period_end: periodEnd,
      next_payment_at: periodEnd,
      last_reference: checkout.reference,
    });
    await writeAudit(scope, {
      userId: checkout.user_id,
      entityType: "subscription",
      entityId: subscriptionId,
      action: "subscription_activated",
      after: { planId: checkout.plan_id, reference: checkout.reference },
    });
  });
}

export async function confirmSubscriptionCheckout(
  db: Database,
  gateway: PaymentGateway,
  reference: string,
): Promise<{ status: string; planId: string; alreadyConfirmed: boolean }> {
  const checkout = await db.get<CheckoutRow>("SELECT * FROM billing_checkouts WHERE reference = ?", [reference]);
  if (!checkout) throw new PaymentError(`No subscription checkout found for reference ${reference}`);
  if (checkout.status === "confirmed") {
    return { status: "confirmed", planId: checkout.plan_id, alreadyConfirmed: true };
  }

  const verified = await gateway.verify(reference);
  const scope = new TenantScope(db, checkout.tenant_id);
  if (verified.status !== "success") {
    await scope.run(
      "UPDATE billing_checkouts SET status = ? WHERE tenant_id = {{tenant}} AND checkout_id = ?",
      verified.status,
      checkout.checkout_id,
    );
    return { status: verified.status, planId: checkout.plan_id, alreadyConfirmed: false };
  }
  if (verified.currency !== "GHS" || verified.amountPesewas !== checkout.amount_pesewas) {
    await scope.run(
      "UPDATE billing_checkouts SET status = 'mismatch' WHERE tenant_id = {{tenant}} AND checkout_id = ?",
      checkout.checkout_id,
    );
    throw new PaymentError(
      `Paystack confirmed ${verified.amountPesewas} ${verified.currency}, but ${checkout.amount_pesewas} GHS was expected. Reconcile this payment before changing the plan.`,
    );
  }

  const previous = await scope.get<BillingRow>(
    "SELECT * FROM subscription_billing WHERE tenant_id = {{tenant}}",
  );
  if (previous?.provider_subscription_code && previous.provider_email_token && previous.plan_id !== checkout.plan_id) {
    await gateway.disableSubscription(previous.provider_subscription_code, previous.provider_email_token);
  }
  await activateCheckout(db, checkout, verified.customerCode ?? null);
  return { status: "success", planId: checkout.plan_id, alreadyConfirmed: false };
}

export async function enforceBillingExpiry(db: Database, tenantId: string): Promise<void> {
  const scope = new TenantScope(db, tenantId);
  const billing = await scope.get<BillingRow>(
    "SELECT * FROM subscription_billing WHERE tenant_id = {{tenant}}",
  );
  if (!billing || billing.status === "active" || !billing.current_period_end || billing.current_period_end > nowIso()) return;
  await db.transaction(async (trx) => {
    const txScope = new TenantScope(trx, tenantId);
    await txScope.run("UPDATE tenants SET plan_id = 'free' WHERE tenant_id = {{tenant}}");
    await txScope.run(
      "UPDATE subscriptions SET status = 'expired', expires_at = ? WHERE tenant_id = {{tenant}} AND status = 'active'",
      nowIso(),
    );
    await txScope.run(
      "UPDATE subscription_billing SET status = 'expired', updated_at = ? WHERE tenant_id = {{tenant}}",
      nowIso(),
    );
  });
}

export async function billingState(actor: Actor, enabled: boolean) {
  if (actor.role !== "owner") throw new AuthError("Only the owner can manage billing");
  await enforceBillingExpiry(actor.scope.db, actor.scope.tenantId);
  const current = await actor.scope.get<BillingRow>(
    "SELECT * FROM subscription_billing WHERE tenant_id = {{tenant}}",
  );
  const tenant = await actor.scope.tenant<{ plan_id: string }>();
  return {
    enabled,
    cardOnly: true,
    currentPlanId: tenant.plan_id,
    status: current?.status ?? (tenant.plan_id === "free" ? "free" : "unmanaged"),
    nextPaymentAt: current?.next_payment_at ?? null,
    currentPeriodEnd: current?.current_period_end ?? null,
    canManage: Boolean(current?.provider_subscription_code),
    plans: PLAN_SEED.map((plan) => ({
      id: plan.plan_id,
      name: plan.name,
      pricePesewas: plan.price_pesewas,
      maxProducts: plan.max_products,
      maxShops: plan.max_shops,
      maxStaff: plan.max_staff,
      maxSuppliers: plan.max_suppliers,
    })),
  };
}

export async function subscriptionManageLink(actor: Actor, gateway: PaymentGateway): Promise<string> {
  if (actor.role !== "owner") throw new AuthError("Only the owner can manage billing");
  const row = await actor.scope.get<BillingRow>(
    "SELECT * FROM subscription_billing WHERE tenant_id = {{tenant}}",
  );
  if (!row?.provider_subscription_code) throw new ValidationError("The subscription is still being registered by Paystack");
  return gateway.manageSubscription(row.provider_subscription_code);
}

export async function cancelSubscription(actor: Actor, gateway: PaymentGateway): Promise<void> {
  if (actor.role !== "owner") throw new AuthError("Only the owner can manage billing");
  const row = await actor.scope.get<BillingRow>(
    "SELECT * FROM subscription_billing WHERE tenant_id = {{tenant}}",
  );
  if (!row?.provider_subscription_code || !row.provider_email_token) {
    throw new ValidationError("The subscription is still being registered by Paystack");
  }
  await gateway.disableSubscription(row.provider_subscription_code, row.provider_email_token);
  await actor.scope.run(
    "UPDATE subscription_billing SET status = 'cancelling', updated_at = ? WHERE tenant_id = {{tenant}}",
    nowIso(),
  );
  await writeAudit(actor.scope, {
    userId: actor.userId,
    entityType: "subscription",
    entityId: row.subscription_id ?? row.billing_id,
    action: "subscription_cancelled",
  });
}

type PaystackEvent = { event?: string; data?: Record<string, unknown> };
const object = (value: unknown): Record<string, unknown> =>
  value && typeof value === "object" ? (value as Record<string, unknown>) : {};

/** Apply signed provider events that are not ordinary counter-sale payments. */
export async function handleSubscriptionWebhook(
  db: Database,
  gateway: PaymentGateway,
  event: PaystackEvent,
): Promise<boolean> {
  const data = object(event.data);
  const eventName = event.event ?? "";
  const reference = typeof data.reference === "string" ? data.reference : "";

  if (eventName === "charge.success" && reference) {
    const checkout = await db.get("SELECT 1 AS x FROM billing_checkouts WHERE reference = ?", [reference]);
    if (checkout) {
      await confirmSubscriptionCheckout(db, gateway, reference);
      return true;
    }
  }

  const subscription = object(data.subscription);
  const subscriptionCode = String(data.subscription_code ?? subscription.subscription_code ?? "");
  if (eventName === "invoice.payment_failed") {
    if (subscriptionCode) {
      await db.run(
        "UPDATE subscription_billing SET status = 'past_due', updated_at = ? WHERE provider_subscription_code = ?",
        [nowIso(), subscriptionCode],
      );
    }
    return true;
  }
  if (eventName === "invoice.update") {
    if (subscriptionCode) {
      const paid = data.paid === true || String(data.status ?? "").toLowerCase() === "success";
      const nextPayment = String(subscription.next_payment_date ?? data.next_payment_date ?? "") || null;
      if (paid) {
        await db.run(
          `UPDATE subscription_billing
              SET status = 'active', current_period_start = ?, current_period_end = ?,
                  next_payment_at = ?, updated_at = ?
            WHERE provider_subscription_code = ?`,
          [nowIso(), nextPayment, nextPayment, nowIso(), subscriptionCode],
        );
      }
    }
    return true;
  }
  if (eventName === "subscription.disable") {
    if (subscriptionCode) {
      await db.run(
        "UPDATE subscription_billing SET status = 'cancelling', updated_at = ? WHERE provider_subscription_code = ?",
        [nowIso(), subscriptionCode],
      );
    }
    return true;
  }
  if (eventName !== "subscription.create") return false;

  const customer = object(data.customer);
  const plan = object(data.plan);
  const email = String(customer.email ?? "").trim().toLowerCase();
  const planCode = String(plan.plan_code ?? data.plan_code ?? "");
  const link = await db.get<{ plan_id: string }>(
    "SELECT plan_id FROM billing_plan_links WHERE provider_plan_code = ?",
    [planCode],
  );
  const owner = await db.get<{ tenant_id: string; user_id: string }>(
    "SELECT tenant_id, user_id FROM users WHERE email = ? AND role = 'owner' AND status = 'active'",
    [email],
  );
  if (!link || !owner) throw new PaymentError("A Paystack subscription could not be matched to an rxpos owner");

  const scope = new TenantScope(db, owner.tenant_id);
  const existing = await scope.get<BillingRow>(
    "SELECT * FROM subscription_billing WHERE tenant_id = {{tenant}}",
  );
  const nextPayment = data.next_payment_date ? String(data.next_payment_date) : existing?.next_payment_at ?? nextMonth();
  await putBilling(db, owner.tenant_id, {
    subscription_id: existing?.subscription_id ?? null,
    plan_id: link.plan_id,
    provider: gateway.name,
    provider_plan_code: planCode,
    provider_subscription_code: String(data.subscription_code ?? "") || null,
    provider_email_token: String(data.email_token ?? "") || null,
    provider_customer_code: String(customer.customer_code ?? "") || null,
    status: String(data.status ?? "active"),
    current_period_start: existing?.current_period_start ?? nowIso(),
    current_period_end: nextPayment,
    next_payment_at: nextPayment,
    last_reference: existing?.last_reference ?? null,
  });
  return true;
}
