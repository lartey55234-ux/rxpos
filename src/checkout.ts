/**
 * Charging for a sale that has already been rung up.
 *
 * The order matters and is deliberate: the sale is written first, then charged.
 * That reserves the stock atomically through the existing sale path, and it
 * means the failure mode is a sale with an unpaid tender — visible on screen,
 * with a cashier standing at the counter who can retry the charge or take cash.
 * Charging first would leave money taken against stock that a concurrent sale
 * might already have claimed.
 *
 * What the browser may never do is decide that money arrived. It asks the server,
 * the server asks Paystack, and only then does the tender become paid. A webhook
 * does the same job when the browser never comes back, which is the normal case
 * for mobile money.
 */

import type { Database } from "./storage/index.ts";
import { TenantScope } from "./tenant.ts";
import type { Actor } from "./actor.ts";
import { assertCan } from "./permissions.ts";
import type { Channel, PaymentGateway } from "./payments.ts";
import { PaymentError, newPaymentReference } from "./payments.ts";
import { newId, nowIso } from "./util.ts";

export type Charge = {
  reference: string;
  accessCode: string;
  amountPesewas: number;
  channel: Channel;
};

type SaleRow = {
  sale_id: string;
  branch_id: string;
  total_pesewas: number;
  payment_method: string;
  status: string;
};

type IntentRow = {
  intent_id: string;
  tenant_id: string;
  sale_id: string | null;
  reference: string;
  amount_pesewas: number;
  channel: string;
  status: string;
};

/** Start a charge for a sale. The amount comes from the sale, never from the client. */
export async function startCharge(
  actor: Actor,
  gateway: PaymentGateway,
  input: { saleId: string; channel: Channel },
): Promise<Charge> {
  assertCan(actor.role, "sell");

  const sale = await actor.scope.get<SaleRow>(
    "SELECT sale_id, branch_id, total_pesewas, payment_method, status FROM sales WHERE tenant_id = {{tenant}} AND sale_id = ?",
    input.saleId,
  );
  if (!sale) throw new PaymentError(`Unknown sale ${input.saleId}`);
  if (sale.total_pesewas <= 0) throw new PaymentError("There is nothing to charge for on this sale");

  // Already charged? Hand back the same charge rather than taking money twice.
  const existing = await actor.scope.get<IntentRow>(
    "SELECT * FROM payment_intents WHERE tenant_id = {{tenant}} AND sale_id = ? AND status = 'pending' ORDER BY created_at DESC",
    input.saleId,
  );
  if (existing) {
    const again = await gateway.initialize({
      email: await payerEmail(actor),
      amountPesewas: existing.amount_pesewas,
      reference: existing.reference,
      channels: [input.channel],
    });
    return {
      reference: existing.reference,
      accessCode: again.accessCode,
      amountPesewas: existing.amount_pesewas,
      channel: input.channel,
    };
  }

  const reference = newPaymentReference();
  const initialised = await gateway.initialize({
    email: await payerEmail(actor),
    amountPesewas: sale.total_pesewas,
    reference,
    channels: [input.channel],
  });

  await actor.scope.insert("payment_intents", {
    intent_id: newId("pin"),
    branch_id: sale.branch_id,
    user_id: actor.userId,
    reference: initialised.reference,
    provider: gateway.name,
    amount_pesewas: sale.total_pesewas,
    channel: input.channel,
    payload_json: JSON.stringify({ saleId: sale.sale_id, accessCode: initialised.accessCode }),
    status: "pending",
    sale_id: sale.sale_id,
    created_at: nowIso(),
    confirmed_at: null,
  });

  return {
    reference: initialised.reference,
    accessCode: initialised.accessCode,
    amountPesewas: sale.total_pesewas,
    channel: input.channel,
  };
}

export type ConfirmResult = {
  reference: string;
  status: string;
  amountPesewas: number;
  saleId: string | null;
  alreadyConfirmed: boolean;
};

/**
 * Confirm a charge by asking Paystack. Idempotent: a webhook and a browser
 * callback racing each other must not double-record anything.
 */
export async function confirmCharge(db: Database, gateway: PaymentGateway, reference: string): Promise<ConfirmResult> {
  const scope = new TenantScope(db, "");
  const intent = await scope.db.get<IntentRow>("SELECT * FROM payment_intents WHERE reference = ?", [reference]);
  if (!intent) throw new PaymentError(`No charge found for reference ${reference}`);

  const tenant = new TenantScope(db, intent.tenant_id);

  if (intent.status === "confirmed") {
    return {
      reference,
      status: "confirmed",
      amountPesewas: intent.amount_pesewas,
      saleId: intent.sale_id,
      alreadyConfirmed: true,
    };
  }

  const verified = await gateway.verify(reference);
  const now = nowIso();

  if (verified.status !== "success") {
    await tenant.run(
      "UPDATE payment_intents SET status = ?, payload_json = ? WHERE tenant_id = {{tenant}} AND reference = ?",
      verified.status,
      JSON.stringify({ verified }),
      reference,
    );
    return {
      reference,
      status: verified.status,
      amountPesewas: verified.amountPesewas,
      saleId: intent.sale_id,
      alreadyConfirmed: false,
    };
  }

  // What Paystack says was paid must be what we asked for. Otherwise a tampered
  // or mismatched transaction could settle a larger sale for less.
  if (verified.amountPesewas !== intent.amount_pesewas) {
    await tenant.run(
      "UPDATE payment_intents SET status = 'mismatch', payload_json = ? WHERE tenant_id = {{tenant}} AND reference = ?",
      JSON.stringify({ verified, expected: intent.amount_pesewas }),
      reference,
    );
    throw new PaymentError(
      `Paystack confirmed ${verified.amountPesewas} pesewas but this sale was for ${intent.amount_pesewas}. Do not release the goods; reconcile in Paystack.`,
    );
  }

  await tenant.run(
    "UPDATE payment_intents SET status = 'confirmed', confirmed_at = ?, payload_json = ? WHERE tenant_id = {{tenant}} AND reference = ?",
    now,
    JSON.stringify({ verified }),
    reference,
  );

  if (intent.sale_id) {
    await tenant.run(
      "UPDATE payments SET provider_ref = ? WHERE tenant_id = {{tenant}} AND sale_id = ? AND provider_ref IS NULL",
      reference,
      intent.sale_id,
    );
  }

  return {
    reference,
    status: "success",
    amountPesewas: verified.amountPesewas,
    saleId: intent.sale_id,
    alreadyConfirmed: false,
  };
}

/** Whether a sale has been paid for by card or mobile money. */
export async function paymentState(actor: Actor, saleId: string): Promise<{ paid: boolean; reference: string | null; status: string | null }> {
  const intent = await actor.scope.get<IntentRow>(
    "SELECT * FROM payment_intents WHERE tenant_id = {{tenant}} AND sale_id = ? ORDER BY created_at DESC",
    saleId,
  );
  if (!intent) return { paid: false, reference: null, status: null };
  return { paid: intent.status === "confirmed", reference: intent.reference, status: intent.status };
}

/**
 * Paystack wants an email on the transaction. The pharmacy's own is the right
 * one: it is the account the money lands in, and the receipt goes there.
 */
async function payerEmail(actor: Actor): Promise<string> {
  const tenant = await actor.scope.tenant<{ email: string | null }>();
  return tenant.email ?? `pharmacy-${actor.scope.tenantId.slice(0, 8)}@rxpos.local`;
}
