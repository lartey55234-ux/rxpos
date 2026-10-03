import { openMigratedDb } from "../src/db.ts";
import { registerPharmacy, authenticate, login, addStaff } from "../src/auth.ts";
import { createProduct, createSupplier, receiveBatch, lowStock, expiredBatches, expiringWithin } from "../src/catalog.ts";
import { createPrescription } from "../src/prescriptions.ts";
import { createSale } from "../src/sales.ts";
import { assetValues, salesSummary, topProducts, todayTotals } from "../src/reports.ts";
import { readRegister } from "../src/controlled.ts";
import { addDays, formatGhs, todayIso } from "../src/util.ts";

const db = openMigratedDb(":memory:");
const reg = registerPharmacy(db, {
  pharmacyName: "Osu Community Pharmacy",
  ownerName: "Emmanuel Lartey",
  email: "owner@osupharmacy.example",
  password: "secret123",
  planId: "starter",
  branchName: "Main Pharmacy — Osu",
});
const owner = authenticate(db, reg.token);
const branch = reg.branchId;
const supplier = createSupplier(owner, { name: "Ernest Chemists Ltd", phone: "+233 30 222 0000" });

const paracetamol = createProduct(owner, { name: "Paracetamol", form: "Tablets", strength: "500 mg", defaultPricePesewas: 500, costPricePesewas: 250, reorderLevel: 40 });
const amoxicillin = createProduct(owner, { name: "Amoxicillin", form: "Capsules", strength: "250 mg", defaultPricePesewas: 1500, costPricePesewas: 800, reorderLevel: 30, prescriptionRequired: true });
const ors = createProduct(owner, { name: "Oral Rehydration Salts", form: "Sachets", defaultPricePesewas: 250, costPricePesewas: 120, reorderLevel: 60 });
const pethidine = createProduct(owner, { name: "Pethidine", form: "Injection", strength: "50 mg/ml", defaultPricePesewas: 2500, costPricePesewas: 1400, controlledClass: "A", prescriptionRequired: true });
const thermometer = createProduct(owner, { name: "Digital Thermometer", form: "Device", defaultPricePesewas: 4500, costPricePesewas: 2500, perishable: false });

receiveBatch(owner, { branchId: branch, productId: paracetamol, batchNumber: "PCM-OLD", expiryDate: addDays(todayIso(), -20), quantity: 24, supplierId: supplier });
receiveBatch(owner, { branchId: branch, productId: paracetamol, batchNumber: "PCM-25C", expiryDate: addDays(todayIso(), 300), quantity: 240, supplierId: supplier });
receiveBatch(owner, { branchId: branch, productId: paracetamol, batchNumber: "PCM-25F", expiryDate: addDays(todayIso(), 60), quantity: 30, supplierId: supplier });
receiveBatch(owner, { branchId: branch, productId: amoxicillin, batchNumber: "AMX-26B", expiryDate: addDays(todayIso(), 500), quantity: 120, supplierId: supplier });
receiveBatch(owner, { branchId: branch, productId: ors, batchNumber: "ORS-25D", expiryDate: addDays(todayIso(), 700), quantity: 18, supplierId: supplier });
receiveBatch(owner, { branchId: branch, productId: pethidine, batchNumber: "PET-01", expiryDate: addDays(todayIso(), 400), quantity: 20, supplierId: supplier });
receiveBatch(owner, { branchId: branch, productId: thermometer, batchNumber: "—", expiryDate: null, quantity: 6, supplierId: supplier });

addStaff(db, owner, { name: "Ama Boateng", email: "ama@osupharmacy.example", password: "secret123", role: "salesperson", branchId: branch });
const ama = authenticate(db, login(db, "ama@osupharmacy.example", "secret123").token);

const walkIn = createSale(ama, { branchId: branch, lines: [{ productId: paracetamol, quantity: 4 }, { productId: ors, quantity: 3 }], paymentMethod: "Cash", amountTenderedPesewas: 5000 });
const rx = createPrescription(owner, { branchId: branch, prescriptionNumber: "RX-2026-0041", patientName: "Kwame Boateng", patientAddress: "12 Ring Road, Accra", prescriberName: "Dr A. Mensah", prescriberLicence: "PCG/12345" });
const script = createSale(owner, { branchId: branch, lines: [{ productId: amoxicillin, quantity: 10 }], paymentMethod: "Mobile Money", prescriptionId: rx });
const controlled = createSale(owner, { branchId: branch, lines: [{ productId: pethidine, quantity: 2 }], paymentMethod: "Cash", prescriptionId: rx });

const money = (p: number) => formatGhs(p).padStart(11);
console.log("\n=== OSU COMMUNITY PHARMACY — demo run ===\n");
console.log("walk-in sale          ", money(walkIn.totalPesewas), " change", formatGhs(walkIn.changePesewas));
console.log("prescription sale     ", money(script.totalPesewas), ` (${walkIn.items.length + script.items.length} lines)`);
console.log("controlled dispense   ", money(controlled.totalPesewas), " register entries:", controlled.controlledEntries);

const today = todayTotals(owner, branch);
console.log("\ntoday                 ", money(today.revenuePesewas), ` ${today.transactions} transactions`);

const assets = assetValues(owner, branch);
console.log("\n--- asset values (owner only) ---");
console.log("total                 ", money(assets.totalPesewas));
console.log("safe                  ", money(assets.safePesewas));
console.log("at risk (12 months)   ", money(assets.atRiskPesewas));
console.log("lost (expired)        ", money(assets.lostPesewas));
console.log("non-perishable        ", money(assets.nonPerishablePesewas));

const week = salesSummary(owner, branch, 7);
console.log("\n--- 7 day trading ---");
console.log("revenue               ", money(week.revenuePesewas));
console.log("gross profit          ", money(week.grossProfitPesewas));
console.log("average basket        ", money(week.averageBasketPesewas));
for (const row of topProducts(owner, branch, 7) as { name: string; units: number; revenue_pesewas: number }[]) {
  console.log(`  ${row.name.padEnd(26)} ${String(row.units).padStart(4)} units ${money(row.revenue_pesewas)}`);
}

console.log("\n--- expiry and reorder ---");
for (const b of expiredBatches(owner, branch) as { product: string; batch_number: string; quantity: number }[]) {
  console.log(`  expired   ${b.product} batch ${b.batch_number} — ${b.quantity} units`);
}
for (const b of expiringWithin(owner, branch, 90) as { product: string; batch_number: string; expiry_date: string }[]) {
  console.log(`  expiring  ${b.product} batch ${b.batch_number} — ${b.expiry_date}`);
}
for (const l of lowStock(owner, branch) as { name: string; on_hand: number; reorder_level: number }[]) {
  console.log(`  low stock ${l.name} — ${l.on_hand} on hand, reorder at ${l.reorder_level}`);
}

console.log("\n--- Controlled Drugs Register (as an inspector reads it) ---");
for (const e of readRegister(owner, branch, addDays(todayIso(), -1), todayIso()) as Record<string, unknown>[]) {
  const who = e.direction === "received" ? `from supplier` : `${e.recipient_name} — ${e.recipient_address}`;
  console.log(`  ${e.entry_date}  ${String(e.direction).padEnd(9)} ${String(e.product).padEnd(12)} ${String(e.batch_number).padEnd(8)} qty ${String(e.quantity).padStart(3)}  ${who}`);
  if (e.direction === "supplied") console.log(`              supplied by ${e.dispenser}, signature ref ${e.recipient_signature_ref ?? "(captured on the printed register)"}`);
}
console.log("");
