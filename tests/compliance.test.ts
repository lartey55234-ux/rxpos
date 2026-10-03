import { test } from "node:test";
import assert from "node:assert/strict";
import { newPharmacy, seedProduct, seedBatch } from "../src/testing.ts";
import { createSale, SaleError } from "../src/sales.ts";
import { createPrescription, PRESCRIPTION_RETENTION_DAYS } from "../src/prescriptions.ts";
import { readRegister } from "../src/controlled.ts";
import { addStaff, authenticate, login } from "../src/auth.ts";
import { PermissionError } from "../src/permissions.ts";
import { addDays, todayIso } from "../src/util.ts";

function pethidineFixture(planId = "pro") {
  const f = newPharmacy(planId, "controlled");
  const product = seedProduct(f.owner, {
    name: "Pethidine",
    pricePesewas: 2500,
    controlledClass: "A",
    prescriptionRequired: true,
  });
  seedBatch(f.owner, f.branchId, product, { batchNumber: "PET-01", expiryDate: addDays(todayIso(), 300), quantity: 10 });
  return { ...f, product };
}

test("a controlled drug cannot be supplied without a prescription", () => {
  const f = pethidineFixture();
  assert.throws(
    () => createSale(f.owner, { branchId: f.branchId, lines: [{ productId: f.product, quantity: 1 }], paymentMethod: "Cash" }),
    (err: Error) => err instanceof SaleError && /needs a prescription/.test(err.message),
  );
});

test("a salesperson may not dispense a controlled drug", () => {
  const f = pethidineFixture();
  addStaff(f.db, f.owner, { name: "Ama", email: "ama.controlled@example.com", password: "pw123456", role: "salesperson" });
  const salesperson = authenticate(f.db, login(f.db, "ama.controlled@example.com", "pw123456").token);
  const rx = createPrescription(f.owner, {
    branchId: f.branchId,
    prescriptionNumber: "RX-1",
    patientName: "Patient",
    prescriberName: "Dr Mensah",
  });

  assert.throws(
    () => createSale(salesperson, { branchId: f.branchId, lines: [{ productId: f.product, quantity: 1 }], paymentMethod: "Cash", prescriptionId: rx }),
    PermissionError,
  );
});

test("a dispensed controlled drug writes the Act 489 s.34 register fields", () => {
  const f = pethidineFixture();
  const rx = createPrescription(f.owner, {
    branchId: f.branchId,
    prescriptionNumber: "RX-77",
    patientName: "Kwame Boateng",
    patientAddress: "12 Ring Road, Accra",
    prescriberName: "Dr A. Mensah",
    prescriberLicence: "PCG/12345",
  });

  const sale = createSale(f.owner, {
    branchId: f.branchId,
    lines: [{ productId: f.product, quantity: 2 }],
    paymentMethod: "Cash",
    prescriptionId: rx,
  });
  assert.equal(sale.controlledEntries, 1);

  const rows = readRegister(f.owner, f.branchId, todayIso(), todayIso());
  const supplied = rows.filter((r) => r.direction === "supplied");
  assert.equal(supplied.length, 1);
  const entry = supplied[0] as Record<string, unknown>;

  assert.equal(entry.product, "Pethidine");          // the drug supplied
  assert.equal(entry.quantity, 2);                   // and the quantity
  assert.equal(entry.recipient_name, "Kwame Boateng");       // who it went to
  assert.equal(entry.recipient_address, "12 Ring Road, Accra"); // and where they live
  assert.equal(entry.batch_number, "PET-01");
  assert.equal(entry.dispenser, "Test Owner");       // who supplied it
  assert.equal(entry.entry_date, todayIso());        // and when
  assert.equal(entry.prescription_id, rx);
});

test("receiving controlled stock writes the receipt side of the register", () => {
  const f = pethidineFixture();
  const rows = readRegister(f.owner, f.branchId, todayIso(), todayIso());
  const received = rows.filter((r) => r.direction === "received");
  assert.equal(received.length, 1);
  assert.equal((received[0] as Record<string, unknown>).quantity, 10);
  assert.equal((received[0] as Record<string, unknown>).batch_number, "PET-01");
});

test("the register is append-only: a write-off does not rewrite history", () => {
  const f = pethidineFixture();
  const before = readRegister(f.owner, f.branchId, todayIso(), todayIso()).length;
  const batches = f.owner.scope.all<{ batch_id: string }>("SELECT batch_id FROM batches WHERE tenant_id = {{tenant}}");
  f.owner.scope.run("UPDATE batches SET quantity = 0 WHERE tenant_id = {{tenant}} AND batch_id = ?", batches[0].batch_id);
  const after = readRegister(f.owner, f.branchId, todayIso(), todayIso()).length;
  assert.equal(after, before);
});

test("a dispensed prescription is retained for two years", () => {
  const f = pethidineFixture();
  const issued = todayIso();
  const rx = createPrescription(f.owner, {
    branchId: f.branchId,
    prescriptionNumber: "RX-RET",
    patientName: "Patient",
    prescriberName: "Dr Mensah",
    issuedDate: issued,
  });
  const row = f.owner.scope.get<{ retained_until: string }>(
    "SELECT retained_until FROM prescriptions WHERE tenant_id = {{tenant}} AND prescription_id = ?",
    rx,
  );
  assert.equal(row?.retained_until, addDays(issued, PRESCRIPTION_RETENTION_DAYS));
  assert.equal(PRESCRIPTION_RETENTION_DAYS, 730);
});

test("every sale and every register write lands in the audit log", () => {
  const f = pethidineFixture();
  const rx = createPrescription(f.owner, {
    branchId: f.branchId,
    prescriptionNumber: "RX-AUDIT",
    patientName: "Patient",
    prescriberName: "Dr Mensah",
  });
  createSale(f.owner, {
    branchId: f.branchId,
    lines: [{ productId: f.product, quantity: 1 }],
    paymentMethod: "Mobile Money",
    prescriptionId: rx,
  });

  const saleAudits = f.owner.scope.all<{ action: string }>(
    "SELECT action FROM audit_log WHERE tenant_id = {{tenant}} AND entity_type = 'sale'",
  );
  assert.equal(saleAudits.length, 1);

  const movements = f.owner.scope.all<{ movement_type: string; reference_type: string }>(
    "SELECT movement_type, reference_type FROM stock_movements WHERE tenant_id = {{tenant}}",
  );
  assert.ok(movements.some((m) => m.movement_type === "sale" && m.reference_type === "sale"));
  assert.ok(movements.some((m) => m.movement_type === "receipt"));
});

test("a prescription-only product is blocked without a prescription even when not controlled", () => {
  const f = newPharmacy("pro", "rxonly");
  const product = seedProduct(f.owner, { name: "Amoxicillin 500", prescriptionRequired: true });
  seedBatch(f.owner, f.branchId, product, { batchNumber: "AMX-1", expiryDate: addDays(todayIso(), 200), quantity: 5 });

  assert.throws(
    () => createSale(f.owner, { branchId: f.branchId, lines: [{ productId: product, quantity: 1 }], paymentMethod: "Cash" }),
    /needs a prescription/,
  );

  const rx = createPrescription(f.owner, {
    branchId: f.branchId,
    prescriptionNumber: "RX-AMX",
    patientName: "Patient",
    prescriberName: "Dr Mensah",
  });
  const sale = createSale(f.owner, {
    branchId: f.branchId,
    lines: [{ productId: product, quantity: 1 }],
    paymentMethod: "Cash",
    prescriptionId: rx,
  });
  assert.equal(sale.totalPesewas, 500);
  assert.equal(sale.controlledEntries, 0);
});
