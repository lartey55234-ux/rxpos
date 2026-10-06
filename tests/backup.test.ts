/**
 * Taking everything out and putting it back.
 *
 * The point of these is not that a file is written. It is that the file can be
 * loaded into a database and the data is still there — because a backup nobody has
 * restored is a hope, not a backup.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { freshTestDatabase, seedBatch, seedProduct } from "../src/testing.ts";
import { openDatabase, openMigratedDatabase } from "../src/storage/index.ts";
import { countAll, exportAll, importAll, TABLES } from "../src/backup.ts";
import { authenticate, login, registerPharmacy } from "../src/auth.ts";
import { createPrescription } from "../src/prescriptions.ts";
import { createSale } from "../src/sales.ts";
import { todayIso, addDays } from "../src/util.ts";

const runId = "backup";

/** A pharmacy with everything a real one would have by the end of a week. */
async function populate(db: Awaited<ReturnType<typeof freshTestDatabase>>, label: string) {
  const reg = await registerPharmacy(db, {
    pharmacyName: `Backup ${label}`,
    ownerName: "Emmanuel Lartey",
    email: `${label}.${runId}@example.com`,
    password: "secret123",
    planId: "pro",
  });
  const owner = await authenticate(db, reg.token);
  const product = await seedProduct(owner, { name: "Paracetamol", pricePesewas: 500, costPesewas: 250 });
  const controlled = await seedProduct(owner, {
    name: "Pethidine",
    pricePesewas: 2500,
    controlledClass: "A",
    prescriptionRequired: true,
  });
  await seedBatch(owner, reg.branchId, product, { batchNumber: "P1", expiryDate: addDays(todayIso(), 200), quantity: 40 });
  await seedBatch(owner, reg.branchId, controlled, { batchNumber: "PET1", expiryDate: addDays(todayIso(), 300), quantity: 10 });

  await createSale(owner, {
    branchId: reg.branchId,
    lines: [{ productId: product, quantity: 3 }],
    paymentMethod: "Cash",
    amountTenderedPesewas: 5000,
  });

  const rx = await createPrescription(owner, {
    branchId: reg.branchId,
    prescriptionNumber: "RX-BACKUP-1",
    patientName: "Kwame Boateng",
    patientAddress: "12 Ring Road, Accra",
    prescriberName: "Dr A. Mensah",
  });
  await createSale(owner, {
    branchId: reg.branchId,
    lines: [{ productId: controlled, quantity: 2 }],
    paymentMethod: "Cash",
    prescriptionId: rx,
  });

  return { reg, owner, product, controlled };
}

test("a backup carries every table, and restores into a database that already has data", async () => {
  const db = await freshTestDatabase();
  const shop = await populate(db, "roundtrip");

  const backup = await exportAll(db);
  const before = await countAll(db);
  assert.equal(backup.version, 1);
  assert.ok(backup.takenAt);
  assert.deepEqual(Object.keys(backup.tables), [...TABLES], "every table is in the backup");
  assert.equal(before.tenants, 1);
  assert.ok(before.sales >= 2, "the sales are there to be backed up");
  assert.equal(before.controlled_register, 2, "receipt and supply of a controlled drug");

  // Something happens after the backup: another sale, and another product.
  await seedProduct(shop.owner, { name: "Later Addition", pricePesewas: 100 });
  await createSale(shop.owner, {
    branchId: shop.reg.branchId,
    lines: [{ productId: shop.product, quantity: 1 }],
    paymentMethod: "Cash",
    amountTenderedPesewas: 500,
  });
  assert.equal((await countAll(db)).products, 3, "the extra product is there now");

  const report = await importAll(db, backup, { replace: true });
  const after = await countAll(db);

  assert.deepEqual(after, before, "every table is back to exactly what was backed up");
  assert.equal(report.total, Object.values(before).reduce((sum, n) => sum + n, 0));
  assert.equal(after.products, 2, "the later addition is gone, as it should be");
});

test("the rows that come back are the rows that went in", async () => {
  const db = await freshTestDatabase();
  const shop = await populate(db, "content");
  const backup = await exportAll(db);

  await importAll(db, backup, { replace: true });

  // The things a pharmacy would notice if they were wrong.
  const product = await db.get<{ name: string; cost_price_pesewas: number }>(
    "SELECT name, cost_price_pesewas FROM products WHERE tenant_id = ? AND name = ?",
    [shop.reg.tenantId, "Paracetamol"],
  );
  assert.equal(product?.cost_price_pesewas, 250, "money survives exactly, in pesewas");

  const register = await db.all<{ recipient_name: string; quantity: number }>(
    "SELECT recipient_name, quantity FROM controlled_register WHERE tenant_id = ? AND direction = 'supplied'",
    [shop.reg.tenantId],
  );
  assert.equal(register.length, 1);
  assert.equal(register[0].recipient_name, "Kwame Boateng", "the register is a legal record, and it comes back whole");
  assert.equal(register[0].quantity, 2);

  // and the pharmacy can still sign in, which needs the password hash to have survived
  const session = await login(db, `content.${runId}@example.com`, "secret123");
  assert.equal(session.tenantId, shop.reg.tenantId);
});

test("a backup restores into an empty database, which is the disaster case", async (t) => {
  if (process.env.DATABASE_URL) {
    t.skip("needs a second database; covered by the round trip on PostgreSQL");
    return;
  }

  const source = await freshTestDatabase();
  await populate(source, "disaster");
  const backup = await exportAll(source);
  const expected = await countAll(source);

  const target = openDatabase(":memory:");
  await openMigratedDatabase; // (the schema is applied by migrate below)
  const { migrate } = await import("../src/storage/index.ts");
  await migrate(target);

  const report = await importAll(target, backup);
  const landed = await countAll(target);
  assert.deepEqual(landed, expected, "a fresh database takes the whole backup");
  assert.equal(report.total, Object.values(expected).reduce((sum, n) => sum + n, 0));
  await target.close();
});

test("a file that is not a backup is refused rather than half-loaded", async () => {
  const db = await freshTestDatabase();
  await assert.rejects(
    () => importAll(db, { version: 99 } as never),
    /not a backup this version can read/,
  );
  await assert.rejects(() => importAll(db, undefined as never), /not a backup this version can read/);
});
