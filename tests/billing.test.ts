/** Recurring plans: free signup, server-verified activation, provider events and cancellation. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { newPharmacy } from "../src/testing.ts";
import { addStaff, authenticate } from "../src/auth.ts";
import { FakeGateway } from "../src/payments.ts";
import {
  billingState,
  cancelSubscription,
  confirmSubscriptionCheckout,
  enforceBillingExpiry,
  handleSubscriptionWebhook,
  startSubscriptionCheckout,
  subscriptionManageLink,
} from "../src/billing.ts";

async function fixture(label: string) {
  const f = await newPharmacy("free", label);
  const gateway = new FakeGateway();
  return { ...f, gateway };
}

test("a subscription checkout creates the provider plan once and never trusts a client amount", async () => {
  const f = await fixture("billing-start");
  const first = await startSubscriptionCheckout(f.owner, f.gateway, "starter");
  assert.equal(first.amountPesewas, 6000);
  assert.equal(f.gateway.subscriptionPlans.length, 1);
  assert.equal(f.gateway.subscriptionPlans[0].amountPesewas, 6000);
  assert.equal(f.gateway.initialisedSubscriptions[0].planCode, f.gateway.subscriptionPlans[0].planCode);
  assert.equal(f.gateway.initialisedSubscriptions[0].metadata.tenantId, f.tenantId);

  await startSubscriptionCheckout(f.owner, f.gateway, "starter");
  assert.equal(f.gateway.subscriptionPlans.length, 1, "the Paystack plan is reused, not duplicated");
  const rows = await f.owner.scope.all<{ status: string }>(
    "SELECT status FROM billing_checkouts WHERE tenant_id = {{tenant}} ORDER BY created_at",
  );
  assert.deepEqual(rows.map((row) => row.status), ["abandoned", "pending"]);
});

test("only a verified matching charge activates the paid plan, exactly once", async () => {
  const f = await fixture("billing-confirm");
  const checkout = await startSubscriptionCheckout(f.owner, f.gateway, "standard");
  f.gateway.succeed(checkout.reference, 10000, "card");

  const first = await confirmSubscriptionCheckout(f.db, f.gateway, checkout.reference);
  assert.equal(first.status, "success");
  assert.equal((await f.owner.scope.tenant<{ plan_id: string }>()).plan_id, "standard");
  const state = await billingState(f.owner, true);
  assert.equal(state.status, "active");
  assert.equal(state.currentPlanId, "standard");
  assert.ok(state.nextPaymentAt);

  const second = await confirmSubscriptionCheckout(f.db, f.gateway, checkout.reference);
  assert.equal(second.alreadyConfirmed, true);
  const active = await f.owner.scope.all(
    "SELECT subscription_id FROM subscriptions WHERE tenant_id = {{tenant}} AND status = 'active'",
  );
  assert.equal(active.length, 1, "confirmation replay cannot create a second subscription");
});

test("a wrong amount is quarantined and leaves the tenant free", async () => {
  const f = await fixture("billing-mismatch");
  const checkout = await startSubscriptionCheckout(f.owner, f.gateway, "pro");
  f.gateway.succeed(checkout.reference, 100, "card");
  await assert.rejects(() => confirmSubscriptionCheckout(f.db, f.gateway, checkout.reference), /15000 GHS was expected/);
  assert.equal((await f.owner.scope.tenant<{ plan_id: string }>()).plan_id, "free");
  const row = await f.owner.scope.get<{ status: string }>(
    "SELECT status FROM billing_checkouts WHERE tenant_id = {{tenant}} AND reference = ?",
    checkout.reference,
  );
  assert.equal(row?.status, "mismatch");
});

test("staff cannot start billing", async () => {
  const f = await fixture("billing-role");
  const userId = await addStaff(f.db, f.owner, {
    name: "Ama",
    email: "ama.billing@example.com",
    password: "password123",
    role: "admin",
  }).catch(() => "");
  // Free has no staff allowance; prove the authorization boundary with a forged actor shape instead.
  await assert.rejects(
    () => startSubscriptionCheckout({ scope: f.owner.scope, userId: userId || "usr_staff", role: "admin" }, f.gateway, "starter"),
    /Only the owner/,
  );
});

test("subscription.create attaches provider controls, then manage and cancel work", async () => {
  const f = await fixture("billing-events");
  const checkout = await startSubscriptionCheckout(f.owner, f.gateway, "starter");
  f.gateway.succeed(checkout.reference, 6000, "card");
  await confirmSubscriptionCheckout(f.db, f.gateway, checkout.reference);
  const planCode = (await f.db.get<{ provider_plan_code: string }>(
    "SELECT provider_plan_code FROM billing_plan_links WHERE plan_id = 'starter'",
  ))!.provider_plan_code;

  assert.equal(
    await handleSubscriptionWebhook(f.db, f.gateway, {
      event: "subscription.create",
      data: {
        status: "active",
        subscription_code: "SUB_test_1",
        email_token: "email-token-1",
        next_payment_date: "2026-11-06T00:00:00.000Z",
        customer: { email: f.email, customer_code: "CUS_test_1" },
        plan: { plan_code: planCode },
      },
    }),
    true,
  );
  assert.match(await subscriptionManageLink(f.owner, f.gateway), /SUB_test_1/);
  await handleSubscriptionWebhook(f.db, f.gateway, {
    event: "invoice.payment_failed",
    data: { subscription: { subscription_code: "SUB_test_1" } },
  });
  assert.equal((await billingState(f.owner, true)).status, "past_due");
  await handleSubscriptionWebhook(f.db, f.gateway, {
    event: "invoice.update",
    data: {
      paid: true,
      subscription: { subscription_code: "SUB_test_1", next_payment_date: "2026-12-06T00:00:00.000Z" },
    },
  });
  assert.equal((await billingState(f.owner, true)).status, "active");
  await cancelSubscription(f.owner, f.gateway);
  assert.deepEqual(f.gateway.disabledSubscriptions, ["SUB_test_1"]);
  assert.equal((await billingState(f.owner, true)).status, "cancelling");
});

test("past-due access falls back to free only after the paid period", async () => {
  const f = await fixture("billing-expiry");
  const checkout = await startSubscriptionCheckout(f.owner, f.gateway, "starter");
  f.gateway.succeed(checkout.reference, 6000, "card");
  await confirmSubscriptionCheckout(f.db, f.gateway, checkout.reference);
  await f.owner.scope.run(
    "UPDATE subscription_billing SET status = 'past_due', current_period_end = ? WHERE tenant_id = {{tenant}}",
    new Date(Date.now() - 60_000).toISOString(),
  );
  await enforceBillingExpiry(f.db, f.tenantId);
  assert.equal((await f.owner.scope.tenant<{ plan_id: string }>()).plan_id, "free");
  assert.equal((await billingState(f.owner, true)).status, "expired");
});

test("the billing checkout and confirmation work through the HTTP API", async (t) => {
  const { freshTestDatabase } = await import("../src/testing.ts");
  const { startServer } = await import("../src/server.ts");
  const db = await freshTestDatabase();
  const gateway = new FakeGateway();
  const server = await startServer(db, 0, undefined, "127.0.0.1", {
    gateway,
    loginLimit: 1000,
    signupLimit: 1000,
  });
  t.after(() => server.close());
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const signup = await fetch(`${base}/api/signup`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      pharmacyName: "HTTP Billing Pharmacy",
      ownerName: "Owner",
      email: "owner@billing-http.com",
      password: "password123",
    }),
  });
  assert.equal(signup.status, 201);
  const signedIn = (await signup.json()) as { token: string; tenant: { plan: { id: string } } };
  assert.equal(signedIn.tenant.plan.id, "free");
  const headers = { "content-type": "application/json", authorization: `Bearer ${signedIn.token}` };

  const started = await fetch(`${base}/api/billing/checkout`, {
    method: "POST",
    headers,
    body: JSON.stringify({ planId: "starter", amountPesewas: 1 }),
  });
  assert.equal(started.status, 201);
  const checkout = ((await started.json()) as { checkout: { reference: string; amountPesewas: number } }).checkout;
  assert.equal(checkout.amountPesewas, 6000, "the server chooses the amount");
  gateway.succeed(checkout.reference, 6000, "card");

  const confirmed = await fetch(`${base}/api/billing/confirm`, {
    method: "POST",
    headers,
    body: JSON.stringify({ reference: checkout.reference }),
  });
  assert.equal(confirmed.status, 200);

  const session = await fetch(`${base}/api/session`, { headers: { authorization: `Bearer ${signedIn.token}` } });
  assert.equal(((await session.json()) as { tenant: { plan: { id: string } } }).tenant.plan.id, "starter");
});
