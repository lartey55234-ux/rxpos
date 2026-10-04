/**
 * Taking money. The browser is never the authority, and a charge must never
 * settle a sale for an amount nobody agreed to.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import type { Server } from "node:http";
import { randomBytes } from "node:crypto";
import { freshTestDatabase, seedBatch, seedProduct } from "../src/testing.ts";
import { authenticate, registerPharmacy } from "../src/auth.ts";
import { startServer } from "../src/server.ts";
import { createSale } from "../src/sales.ts";
import { confirmCharge, paymentState, startCharge } from "../src/checkout.ts";
import { FakeGateway, verifyWebhookSignature } from "../src/payments.ts";
import { todayIso, addDays } from "../src/util.ts";

const SECRET = "sk_test_rxpos";
const db = await freshTestDatabase();
const gateway = new FakeGateway();
const server: Server = await startServer(db, 0, undefined, "127.0.0.1", {
  loginLimit: 1000,
  signupLimit: 1000,
  gateway,
  paystackSecretKey: SECRET,
});
const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
test.after(() => server.close());

const runId = randomBytes(4).toString("hex");
let counter = 0;

/**
 * A pharmacy on the *same* database the server is using. newPharmacy() makes its
 * own database, which is right for the domain tests but would leave the server
 * unable to see this pharmacy's charges.
 */
async function signedIn() {
  counter += 1;
  const email = `pay${counter}.${runId}@example.com`;
  const reg = await registerPharmacy(db, {
    pharmacyName: `Payments ${counter}`,
    ownerName: "Test Owner",
    email,
    password: "secret123",
    planId: "pro",
  });
  const owner = await authenticate(db, reg.token);
  const product = await seedProduct(owner, { name: "Amoxicillin", pricePesewas: 1500, costPesewas: 800 });
  await seedBatch(owner, reg.branchId, product, { batchNumber: "AM1", expiryDate: addDays(todayIso(), 200), quantity: 20 });
  const sale = await createSale(owner, {
    branchId: reg.branchId,
    lines: [{ productId: product, quantity: 2 }],
    paymentMethod: "Mobile Money",
  });
  return {
    db,
    owner,
    token: reg.token,
    tenantId: reg.tenantId,
    branchId: reg.branchId,
    email,
    sale,
    product,
  };
}

test("a charge takes its amount from the sale, not from the caller", async () => {
  const f = await signedIn();
  const charge = await startCharge(f.owner, gateway, { saleId: f.sale.saleId, channel: "mobile_money" });

  assert.equal(charge.amountPesewas, 3000, "two at 15.00 is 30.00");
  assert.match(charge.reference, /^rxpos_/);
  assert.ok(charge.accessCode);

  const state = await paymentState(f.owner, f.sale.saleId);
  assert.equal(state.paid, false, "starting a charge does not pay for anything");
  assert.equal(state.status, "pending");
});

test("a charge is not started twice for the same sale", async () => {
  const f = await signedIn();
  const first = await startCharge(f.owner, gateway, { saleId: f.sale.saleId, channel: "card" });
  const second = await startCharge(f.owner, gateway, { saleId: f.sale.saleId, channel: "card" });
  assert.equal(second.reference, first.reference, "the same charge is handed back, not a new one");

  const intents = await f.owner.scope.all("SELECT intent_id FROM payment_intents WHERE tenant_id = {{tenant}} AND sale_id = ?", f.sale.saleId);
  assert.equal(intents.length, 1);
});

test("money is only paid once Paystack confirms it", async () => {
  const f = await signedIn();
  const charge = await startCharge(f.owner, gateway, { saleId: f.sale.saleId, channel: "card" });

  // Not yet paid, even though a charge exists.
  assert.equal((await paymentState(f.owner, f.sale.saleId)).paid, false);

  gateway.succeed(charge.reference, 3000, "card");
  const confirmed = await confirmCharge(f.db, gateway, charge.reference);

  assert.equal(confirmed.status, "success");
  assert.equal(confirmed.amountPesewas, 3000);
  assert.equal((await paymentState(f.owner, f.sale.saleId)).paid, true);

  const payment = await f.owner.scope.get<{ provider_ref: string | null }>(
    "SELECT provider_ref FROM payments WHERE tenant_id = {{tenant}} AND sale_id = ?",
    f.sale.saleId,
  );
  assert.equal(payment?.provider_ref, charge.reference, "the receipt now points at the transaction");
});

test("confirming twice does not double-record anything", async () => {
  const f = await signedIn();
  const charge = await startCharge(f.owner, gateway, { saleId: f.sale.saleId, channel: "card" });
  gateway.succeed(charge.reference, 3000);

  const first = await confirmCharge(f.db, gateway, charge.reference);
  const second = await confirmCharge(f.db, gateway, charge.reference);

  assert.equal(first.alreadyConfirmed, false);
  assert.equal(second.alreadyConfirmed, true, "a webhook racing the browser is harmless");

  const payments = await f.owner.scope.all("SELECT payment_id FROM payments WHERE tenant_id = {{tenant}} AND sale_id = ?", f.sale.saleId);
  assert.equal(payments.length, 1);
});

test("a failed payment leaves the sale unpaid", async () => {
  const f = await signedIn();
  const charge = await startCharge(f.owner, gateway, { saleId: f.sale.saleId, channel: "card" });
  gateway.fail(charge.reference);

  const result = await confirmCharge(f.db, gateway, charge.reference);
  assert.equal(result.status, "failed");
  assert.equal((await paymentState(f.owner, f.sale.saleId)).paid, false);
});

test("a payment for the wrong amount never settles the sale", async () => {
  const f = await signedIn();
  const charge = await startCharge(f.owner, gateway, { saleId: f.sale.saleId, channel: "card" });

  // Someone pays 5.00 for a 30.00 sale.
  gateway.succeed(charge.reference, 500);

  await assert.rejects(() => confirmCharge(f.db, gateway, charge.reference), /Paystack confirmed 500 pesewas/);
  assert.equal((await paymentState(f.owner, f.sale.saleId)).paid, false, "the goods must not be released");

  const intent = await f.owner.scope.get<{ status: string }>(
    "SELECT status FROM payment_intents WHERE tenant_id = {{tenant}} AND reference = ?",
    charge.reference,
  );
  assert.equal(intent?.status, "mismatch", "and it is flagged for a human to reconcile");
});

test("a charge cannot be started for another pharmacy's sale", async () => {
  const mine = await signedIn();
  const theirs = await signedIn();
  await assert.rejects(
    () => startCharge(mine.owner, gateway, { saleId: theirs.sale.saleId, channel: "card" }),
    /Unknown sale/,
  );
});

test("the webhook refuses a body that is not signed with the secret", async () => {
  const res = await fetch(`${base}/api/payments/webhook`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-paystack-signature": "deadbeef" },
    body: JSON.stringify({ event: "charge.success", data: { reference: "rxpos_nope" } }),
  });
  assert.equal(res.status, 401);
});

test("a signed webhook settles the charge even if the browser never came back", async () => {
  const f = await signedIn();
  const charge = await startCharge(f.owner, gateway, { saleId: f.sale.saleId, channel: "mobile_money" });
  gateway.succeed(charge.reference, 3000, "mobile_money");

  const body = JSON.stringify({ event: "charge.success", data: { reference: charge.reference } });
  const signature = createHmac("sha512", SECRET).update(body).digest("hex");

  const res = await fetch(`${base}/api/payments/webhook`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-paystack-signature": signature },
    body,
  });
  assert.equal(res.status, 200);

  assert.equal((await paymentState(f.owner, f.sale.saleId)).paid, true, "mobile money settles asynchronously");
});

test("the signature check is exact and constant time", () => {
  const body = JSON.stringify({ event: "charge.success" });
  const good = createHmac("sha512", SECRET).update(body).digest("hex");
  assert.equal(verifyWebhookSignature(body, good, SECRET), true);
  assert.equal(verifyWebhookSignature(body, good.slice(0, -1) + "0", SECRET), false);
  assert.equal(verifyWebhookSignature(body + " ", good, SECRET), false, "the bytes as sent, not a re-serialisation");
  assert.equal(verifyWebhookSignature(body, "", SECRET), false);
});

test("the charge route goes through HTTP with the amount from the sale", async () => {
  const f = await signedIn();
  const login = await fetch(`${base}/api/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email: f.email, password: "secret123" }),
  });
  assert.equal(login.status, 200, "the pharmacy can sign in on the server's database");
  const { token } = (await login.json()) as { token: string };

  const res = await fetch(`${base}/api/payments/charge`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
    body: JSON.stringify({ saleId: f.sale.saleId, channel: "mobile_money" }),
  });
  assert.equal(res.status, 201);
  const { charge } = (await res.json()) as { charge: { amountPesewas: number } };
  assert.equal(charge.amountPesewas, 3000);

  const bad = await fetch(`${base}/api/payments/charge`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
    body: JSON.stringify({ saleId: f.sale.saleId, channel: "cheque" }),
  });
  assert.equal(bad.status, 400);
});

test("a deployment with no keys does not offer card or mobile money", async () => {
  const bare = await freshTestDatabase();
  const noPayments: Server = await startServer(bare, 0, undefined, "127.0.0.1", { gateway: null, signupLimit: 1000 });
  const port = (noPayments.address() as { port: number }).port;
  try {
    const signup = await fetch(`http://127.0.0.1:${port}/api/signup`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        pharmacyName: "No Payments Pharmacy",
        ownerName: "Owner",
        email: "nopay@example.com",
        password: "nopay12345",
        planId: "starter",
      }),
    });
    const body = (await signup.json()) as { token: string; payments: { enabled: boolean } };
    assert.equal(body.payments.enabled, false, "the session tells the client not to offer it");

    const res = await fetch(`http://127.0.0.1:${port}/api/payments/charge`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${body.token}` },
      body: JSON.stringify({ saleId: "sal_whatever", channel: "card" }),
    });
    assert.equal(res.status, 400);
    assert.match(((await res.json()) as { error: string }).error, /not switched on/);
  } finally {
    noPayments.close();
  }
});
