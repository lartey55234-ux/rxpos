/**
 * A sale must be recorded once, however many times the request arrives.
 *
 * This is not a hypothetical: a cashier double-tapping, a browser retrying after
 * a dropped connection, or two requests racing each other all reach the server as
 * the same sale. Before this, each one deducted stock again and printed another
 * receipt.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import type { Server } from "node:http";
import { randomBytes } from "node:crypto";
import { freshTestDatabase, seedBatch, seedProduct } from "../src/testing.ts";
import { authenticate, registerPharmacy } from "../src/auth.ts";
import { startServer } from "../src/server.ts";
import { createSale, existingSale } from "../src/sales.ts";
import { stockIncludingExpired } from "../src/catalog.ts";
import { todayIso, addDays } from "../src/util.ts";

const db = await freshTestDatabase();
const server: Server = await startServer(db, 0, undefined, "127.0.0.1", { signupLimit: 1000 });
const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
test.after(() => server.close());

const runId = randomBytes(4).toString("hex");
let counter = 0;

/**
 * A shop on the *same* database the server is using, so the HTTP test can sign in.
 * newPharmacy() makes its own database, which is right for the domain tests and
 * useless for anything going over the wire.
 */
async function shop(label: string, quantity = 10) {
  counter += 1;
  const email = `idem${counter}.${label}.${runId}@example.com`;
  const reg = await registerPharmacy(db, {
    pharmacyName: `Idempotency ${counter}`,
    ownerName: "Test Owner",
    email,
    password: "secret123",
    planId: "pro",
  });
  const owner = await authenticate(db, reg.token);
  const product = await seedProduct(owner, { name: "Paracetamol", pricePesewas: 500, costPesewas: 250 });
  await seedBatch(owner, reg.branchId, product, {
    batchNumber: "PCM1",
    expiryDate: addDays(todayIso(), 200),
    quantity,
  });
  const line = { productId: product, quantity: 4 };
  const sale = { branchId: reg.branchId, lines: [line], paymentMethod: "Cash" as const };
  return { db, owner, token: reg.token, tenantId: reg.tenantId, branchId: reg.branchId, email, product, sale };
}

test("the same sale id twice records one sale and deducts stock once", async () => {
  const f = await shop("once");
  const id = "sal_1a2b3c4d-5e6f-7890-abcd-ef1234567890";

  const first = await createSale(f.owner, { ...f.sale, saleId: id });
  const second = await createSale(f.owner, { ...f.sale, saleId: id });

  assert.equal(first.saleId, id);
  assert.equal(second.saleId, id, "the same sale comes back, not a new one");
  assert.deepEqual(second.items, first.items, "with the same lines and batches");
  assert.equal(second.totalPesewas, first.totalPesewas);

  const sales = await f.owner.scope.all("SELECT sale_id FROM sales WHERE tenant_id = {{tenant}}");
  assert.equal(sales.length, 1, "only one sale was written");

  const movements = await f.owner.scope.all(
    "SELECT movement_id FROM stock_movements WHERE tenant_id = {{tenant}} AND movement_type = 'sale'",
  );
  assert.equal(movements.length, 1, "stock moved once");

  assert.equal(await stockIncludingExpired(f.owner, f.product, f.branchId), 6, "and only four units left the shelf");
});

test("the receipt a repeat caller gets is the original, not a fresh one", async () => {
  const f = await shop("receipt");
  const id = "sal_repeat_receipt_0001";
  const first = await createSale(f.owner, { ...f.sale, saleId: id, discountPesewas: 100, amountTenderedPesewas: 5000 });
  const second = await createSale(f.owner, { ...f.sale, saleId: id });

  // The second call says nothing about a discount. It must not get a new sale
  // priced without one — it gets the sale that already exists.
  assert.equal(second.discountPesewas, 100);
  assert.equal(second.totalPesewas, first.totalPesewas);
  assert.equal(second.changePesewas, first.changePesewas);
});

test("a different sale id is a different sale", async () => {
  const f = await shop("twice");
  await createSale(f.owner, { ...f.sale, saleId: "sal_first_sale_000001" });
  await createSale(f.owner, { ...f.sale, saleId: "sal_second_sale_00002" });

  const sales = await f.owner.scope.all("SELECT sale_id FROM sales WHERE tenant_id = {{tenant}}");
  assert.equal(sales.length, 2);
  assert.equal(await stockIncludingExpired(f.owner, f.product, f.branchId), 2);
});

test("omitting the id still works, and the server names the sale", async () => {
  const f = await shop("anon");
  const sale = await createSale(f.owner, f.sale);
  assert.match(sale.saleId, /^sal_/);
  assert.equal((await existingSale(f.owner, sale.saleId))?.saleId, sale.saleId);
});

test("an unusable sale id is refused rather than trusted", async () => {
  const f = await shop("badid");
  for (const bad of ["x", "has spaces in it", "sal_" + "a".repeat(80), "'; DROP TABLE sales; --"]) {
    await assert.rejects(
      () => createSale(f.owner, { ...f.sale, saleId: bad }),
      /not usable/,
      `accepted ${JSON.stringify(bad)}`,
    );
  }
  const sales = await f.owner.scope.all("SELECT sale_id FROM sales WHERE tenant_id = {{tenant}}");
  assert.equal(sales.length, 0);
});

test("another pharmacy can neither see my sale nor take its id", async () => {
  const mine = await shop("mine");
  const theirs = await shop("theirs");
  const id = "sal_shared_identifier_01";

  await createSale(mine.owner, { ...mine.sale, saleId: id });

  // sale_id is the primary key across the whole table, so the id is taken. Refuse
  // clearly rather than crashing, and never hand over the other pharmacy's sale.
  await assert.rejects(() => createSale(theirs.owner, { ...theirs.sale, saleId: id }), /already in use/);

  assert.equal(await existingSale(theirs.owner, id), null, "and it is not visible from the other tenant");

  const mineAgain = await createSale(mine.owner, { ...mine.sale, saleId: id });
  assert.equal(mineAgain.totalPesewas, 2000, "still my sale, unchanged");
  assert.equal(await stockIncludingExpired(mine.owner, mine.product, mine.branchId), 6);
  assert.equal(await stockIncludingExpired(theirs.owner, theirs.product, theirs.branchId), 10, "and theirs untouched");
});

test("two requests arriving together still produce one sale", async () => {
  const f = await shop("race", 20);
  const id = "sal_concurrent_request_1";

  const login = await fetch(`${base}/api/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email: f.email, password: "secret123" }),
  });
  const { token } = (await login.json()) as { token: string };

  const body = JSON.stringify({
    saleId: id,
    branchId: f.branchId,
    lines: [{ productId: f.product, quantity: 4 }],
    paymentMethod: "Cash",
  });
  const send = () =>
    fetch(`${base}/api/sales`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
      body,
    });

  const [a, b] = await Promise.all([send(), send()]);
  assert.ok(a.status === 201 || a.status === 200, `first: ${a.status}`);
  assert.ok(b.status === 201 || b.status === 200, `second: ${b.status}`);

  const sales = await f.owner.scope.all("SELECT sale_id FROM sales WHERE tenant_id = {{tenant}}");
  assert.equal(sales.length, 1, "the database settled the race, not the check before it");
  assert.equal(await stockIncludingExpired(f.owner, f.product, f.branchId), 16);
});
