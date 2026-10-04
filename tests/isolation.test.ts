import { test } from "node:test";
import assert from "node:assert/strict";
import { newPharmacy, seedProduct, seedBatch } from "../src/testing.ts";
import { createSale } from "../src/sales.ts";
import { sellableStock } from "../src/catalog.ts";
import { todayIso, addDays } from "../src/util.ts";

test("a tenant only ever sees its own products", async () => {
  const a = await newPharmacy("pro", "alpha");
  const b = await newPharmacy("pro", "beta");
  await seedProduct(a.owner, { name: "Alpha Paracetamol" });
  await seedProduct(b.owner, { name: "Beta Amoxicillin" });

  const aNames = (await a.owner.scope.all<{ name: string }>("SELECT name FROM products WHERE tenant_id = {{tenant}}")).map((r) => r.name);
  const bNames = (await b.owner.scope.all<{ name: string }>("SELECT name FROM products WHERE tenant_id = {{tenant}}")).map((r) => r.name);

  assert.deepEqual(aNames, ["Alpha Paracetamol"]);
  assert.deepEqual(bNames, ["Beta Amoxicillin"]);
});

test("a row from another tenant is not reachable even with its id", async () => {
  const a = await newPharmacy("pro", "alpha");
  const b = await newPharmacy("pro", "beta");
  const bProduct = await seedProduct(b.owner, { name: "Beta only" });

  const stolen = await a.owner.scope.get("SELECT * FROM products WHERE tenant_id = {{tenant}} AND product_id = ?", bProduct);
  assert.equal(stolen, undefined);
});

test("unscoped SQL is refused before it reaches the database", async () => {
  const a = await newPharmacy();
  await assert.rejects(() => a.owner.scope.all("SELECT * FROM products"), /missing the \{\{tenant\}\} marker/);
  await assert.rejects(
    () => a.owner.scope.all("SELECT * FROM products WHERE tenant_id = {{tenant}} OR tenant_id = {{tenant}}"),
    /more than one \{\{tenant\}\} marker/,
  );
});

test("a caller cannot forge tenant_id on insert", async () => {
  const a = await newPharmacy();
  await assert.rejects(
    () => a.owner.scope.insert("products", { product_id: "x", tenant_id: "someone-else", name: "Sneaky" }),
    /do not set tenant_id yourself/,
  );
});

test("selling in one pharmacy never touches another pharmacy's stock", async () => {
  const a = await newPharmacy("pro", "alpha");
  const b = await newPharmacy("pro", "beta");
  const aProduct = await seedProduct(a.owner, { name: "Shared name" });
  const bProduct = await seedProduct(b.owner, { name: "Shared name" });
  await seedBatch(a.owner, a.branchId, aProduct, { batchNumber: "A1", expiryDate: addDays(todayIso(), 200), quantity: 10 });
  await seedBatch(b.owner, b.branchId, bProduct, { batchNumber: "B1", expiryDate: addDays(todayIso(), 200), quantity: 10 });

  await createSale(a.owner, { branchId: a.branchId, lines: [{ productId: aProduct, quantity: 4 }], paymentMethod: "Cash" });

  assert.equal(await sellableStock(a.owner, aProduct, a.branchId), 6);
  assert.equal(await sellableStock(b.owner, bProduct, b.branchId), 10);
});

test("a session token only ever resolves to its own tenant", async () => {
  const a = await newPharmacy("pro", "alpha");
  const b = await newPharmacy("pro", "beta");
  assert.notEqual(a.owner.scope.tenantId, b.owner.scope.tenantId);
  assert.equal(a.owner.scope.tenantId, a.tenantId);
  assert.equal(b.owner.scope.tenantId, b.tenantId);
});
