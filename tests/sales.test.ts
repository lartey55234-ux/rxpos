import { test } from "node:test";
import assert from "node:assert/strict";
import { newPharmacy, seedProduct, seedBatch } from "../src/testing.ts";
import { createSale, SaleError } from "../src/sales.ts";
import { sellableStock, stockIncludingExpired, expiredBatches, lowStock } from "../src/catalog.ts";
import { assetValues, salesSummary, topProducts } from "../src/reports.ts";
import { addStaff, authenticate, login } from "../src/auth.ts";
import { PermissionError } from "../src/permissions.ts";
import { addDays, todayIso } from "../src/util.ts";

test("stock is drawn first-expiry-first-out", () => {
  const f = newPharmacy();
  const product = seedProduct(f.owner, { name: "Paracetamol" });
  seedBatch(f.owner, f.branchId, product, { batchNumber: "LATE", expiryDate: addDays(todayIso(), 300), quantity: 10 });
  seedBatch(f.owner, f.branchId, product, { batchNumber: "SOON", expiryDate: addDays(todayIso(), 30), quantity: 5 });

  const sale = createSale(f.owner, {
    branchId: f.branchId,
    lines: [{ productId: product, quantity: 7 }],
    paymentMethod: "Cash",
  });

  assert.equal(sale.items.length, 2);
  assert.equal(sale.items[0].batchNumber, "SOON");
  assert.equal(sale.items[0].quantity, 5);
  assert.equal(sale.items[1].batchNumber, "LATE");
  assert.equal(sale.items[1].quantity, 2);
});

test("an expired batch can never be supplied", () => {
  const f = newPharmacy();
  const product = seedProduct(f.owner, { name: "Old Amoxicillin" });
  seedBatch(f.owner, f.branchId, product, { batchNumber: "EXPIRED", expiryDate: addDays(todayIso(), -5), quantity: 100 });

  assert.equal(sellableStock(f.owner, product, f.branchId), 0);
  assert.equal(stockIncludingExpired(f.owner, product, f.branchId), 100);
  assert.equal(expiredBatches(f.owner, f.branchId).length, 1);
  assert.throws(
    () => createSale(f.owner, { branchId: f.branchId, lines: [{ productId: product, quantity: 1 }], paymentMethod: "Cash" }),
    /only 0 sellable unit\(s\)/,
  );
});

test("a sale that exceeds sellable stock is refused and changes nothing", () => {
  const f = newPharmacy();
  const product = seedProduct(f.owner, { name: "ORS" });
  seedBatch(f.owner, f.branchId, product, { batchNumber: "ORS1", expiryDate: addDays(todayIso(), 400), quantity: 3 });

  assert.throws(
    () => createSale(f.owner, { branchId: f.branchId, lines: [{ productId: product, quantity: 4 }], paymentMethod: "Cash" }),
    (err: Error) => err instanceof SaleError,
  );
  assert.equal(sellableStock(f.owner, product, f.branchId), 3);
  assert.equal(f.owner.scope.all("SELECT * FROM sales WHERE tenant_id = {{tenant}}").length, 0);
});

test("the stock ledger and the batch quantity always agree", () => {
  const f = newPharmacy();
  const product = seedProduct(f.owner, { name: "Vitamin C" });
  const batch = seedBatch(f.owner, f.branchId, product, { batchNumber: "VC1", expiryDate: addDays(todayIso(), 200), quantity: 10 });

  createSale(f.owner, { branchId: f.branchId, lines: [{ productId: product, quantity: 4 }], paymentMethod: "Cash" });

  const ledger = f.owner.scope.get<{ total: number }>(
    "SELECT COALESCE(SUM(quantity_delta), 0) AS total FROM stock_movements WHERE tenant_id = {{tenant}} AND batch_id = ?",
    batch,
  );
  const onHand = f.owner.scope.get<{ quantity: number }>(
    "SELECT quantity FROM batches WHERE tenant_id = {{tenant}} AND batch_id = ?",
    batch,
  );
  assert.equal(ledger?.total, 6);
  assert.equal(onHand?.quantity, 6);
});

test("discount and cash change are computed in pesewas", () => {
  const f = newPharmacy();
  const product = seedProduct(f.owner, { name: "Amoxicillin", pricePesewas: 1500 });
  seedBatch(f.owner, f.branchId, product, { batchNumber: "AM1", expiryDate: addDays(todayIso(), 300), quantity: 10 });

  const sale = createSale(f.owner, {
    branchId: f.branchId,
    lines: [{ productId: product, quantity: 2 }],
    paymentMethod: "Cash",
    discountPesewas: 300,
    amountTenderedPesewas: 5000,
  });

  assert.equal(sale.subtotalPesewas, 3000);
  assert.equal(sale.totalPesewas, 2700);
  assert.equal(sale.changePesewas, 2300);
});

test("a cash sale cannot be tendered below the total", () => {
  const f = newPharmacy();
  const product = seedProduct(f.owner, { name: "Cetirizine", pricePesewas: 700 });
  seedBatch(f.owner, f.branchId, product, { batchNumber: "CET1", expiryDate: addDays(todayIso(), 100), quantity: 5 });
  assert.throws(
    () =>
      createSale(f.owner, {
        branchId: f.branchId,
        lines: [{ productId: product, quantity: 1 }],
        paymentMethod: "Cash",
        amountTenderedPesewas: 500,
      }),
    /less than the total/,
  );
});

test("asset values split safe, at-risk and lost, and only the owner may see them", () => {
  const f = newPharmacy();
  const perishable = seedProduct(f.owner, { name: "Perishable", pricePesewas: 1000 });
  const device = seedProduct(f.owner, { name: "Thermometer", pricePesewas: 5000, perishable: false });
  seedBatch(f.owner, f.branchId, perishable, { batchNumber: "P-LOST", expiryDate: addDays(todayIso(), -10), quantity: 2 });
  seedBatch(f.owner, f.branchId, perishable, { batchNumber: "P-RISK", expiryDate: addDays(todayIso(), 100), quantity: 3 });
  seedBatch(f.owner, f.branchId, perishable, { batchNumber: "P-SAFE", expiryDate: addDays(todayIso(), 500), quantity: 4 });
  seedBatch(f.owner, f.branchId, device, { batchNumber: "D1", expiryDate: null, quantity: 1 });

  const values = assetValues(f.owner, f.branchId);
  assert.equal(values.totalPesewas, 14_000);
  assert.equal(values.lostPesewas, 2_000);
  assert.equal(values.atRiskPesewas, 3_000);
  assert.equal(values.safePesewas, 9_000);
  assert.equal(values.nonPerishablePesewas, 5_000);

  addStaff(f.db, f.owner, { name: "Admin", email: "admin@example.com", password: "pw123456", role: "admin" });
  const admin = authenticate(f.db, login(f.db, "admin@example.com", "pw123456").token);
  assert.throws(() => assetValues(admin, f.branchId), PermissionError);
});

test("low stock is measured against the reorder level, excluding expired stock", () => {
  const f = newPharmacy();
  const product = seedProduct(f.owner, { name: "Zinc", reorderLevel: 20 });
  seedBatch(f.owner, f.branchId, product, { batchNumber: "Z1", expiryDate: addDays(todayIso(), 300), quantity: 5 });
  seedBatch(f.owner, f.branchId, product, { batchNumber: "Z-EXPIRED", expiryDate: addDays(todayIso(), -1), quantity: 50 });

  const low = lowStock(f.owner, f.branchId);
  assert.equal(low.length, 1);
  assert.equal((low[0] as { on_hand: number }).on_hand, 5);
});

test("sales reporting totals revenue, profit and the average basket", () => {
  const f = newPharmacy();
  const product = seedProduct(f.owner, { name: "Ibuprofen", pricePesewas: 900, costPesewas: 400 });
  seedBatch(f.owner, f.branchId, product, { batchNumber: "I1", expiryDate: addDays(todayIso(), 300), quantity: 20 });
  createSale(f.owner, { branchId: f.branchId, lines: [{ productId: product, quantity: 2 }], paymentMethod: "Cash" });
  createSale(f.owner, { branchId: f.branchId, lines: [{ productId: product, quantity: 1 }], paymentMethod: "Mobile Money" });

  const summary = salesSummary(f.owner, f.branchId, 7);
  assert.equal(summary.revenuePesewas, 2700);
  assert.equal(summary.grossProfitPesewas, 2700 - 1200);
  assert.equal(summary.transactions, 2);
  assert.equal(summary.averageBasketPesewas, 1350);

  const top = topProducts(f.owner, f.branchId, 7);
  assert.equal((top[0] as { units: number }).units, 3);
});
