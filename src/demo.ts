import type { Database } from "./storage/index.ts";
import { registerPharmacy, authenticate, login, addStaff } from "./auth.ts";
import { createProduct, createSupplier, receiveBatch } from "./catalog.ts";
import { createPrescription } from "./prescriptions.ts";
import { createSale } from "./sales.ts";
import { addDays, todayIso } from "./util.ts";
import type { Actor } from "./actor.ts";

export type Demo = {
  owner: Actor;
  salesperson: Actor;
  branchId: string;
  credentials: { owner: string; admin: string; salesperson: string; password: string };
};

/** A pharmacy with stock, a prescription and a couple of sales already through the till. */
export async function seedDemoPharmacy(db: Database): Promise<Demo> {
  const reg = await registerPharmacy(db, {
    pharmacyName: "Osu Community Pharmacy",
    ownerName: "Emmanuel Lartey",
    email: "owner@osupharmacy.example",
    password: "secret123",
    planId: "standard",
    branchName: "Main Pharmacy — Osu",
  });
  const owner = await authenticate(db, reg.token);
  const branch = reg.branchId;

  const branchB = await addBranch(db, owner, "Adabraka Branch");
  const supplier = await createSupplier(owner, { name: "Ernest Chemists Ltd", phone: "+233 30 222 0000" });
  await createSupplier(owner, { name: "Kinapharma Ltd" });

  const paracetamol = await createProduct(owner, { name: "Paracetamol", form: "Tablets", strength: "500 mg", barcode: "PCM500", defaultPricePesewas: 500, costPricePesewas: 250, reorderLevel: 40 });
  const amoxicillin = await createProduct(owner, { name: "Amoxicillin", form: "Capsules", strength: "250 mg", barcode: "AMX250", defaultPricePesewas: 1500, costPricePesewas: 800, reorderLevel: 30, prescriptionRequired: true });
  const ors = await createProduct(owner, { name: "Oral Rehydration Salts", form: "Sachets", barcode: "ORS001", defaultPricePesewas: 250, costPricePesewas: 120, reorderLevel: 60 });
  const ibuprofen = await createProduct(owner, { name: "Ibuprofen", form: "Tablets", strength: "400 mg", barcode: "IBU400", defaultPricePesewas: 900, costPricePesewas: 450, reorderLevel: 36 });
  const pethidine = await createProduct(owner, { name: "Pethidine", form: "Injection", strength: "50 mg/ml", barcode: "PET050", defaultPricePesewas: 2500, costPricePesewas: 1400, controlledClass: "A", prescriptionRequired: true });
  const thermometer = await createProduct(owner, { name: "Digital Thermometer", form: "Device", barcode: "DTH001", defaultPricePesewas: 4500, costPricePesewas: 2500, reorderLevel: 8, perishable: false });
  const cetirizine = await createProduct(owner, { name: "Cetirizine", form: "Tablets", strength: "10 mg", barcode: "CET010", defaultPricePesewas: 700, costPricePesewas: 350, reorderLevel: 24 });

  await receiveBatch(owner, { branchId: branch, productId: paracetamol, batchNumber: "PCM-OLD", expiryDate: addDays(todayIso(), -20), quantity: 24, supplierId: supplier });
  await receiveBatch(owner, { branchId: branch, productId: paracetamol, batchNumber: "PCM-25C", expiryDate: addDays(todayIso(), 300), quantity: 240, supplierId: supplier });
  await receiveBatch(owner, { branchId: branch, productId: paracetamol, batchNumber: "PCM-25F", expiryDate: addDays(todayIso(), 60), quantity: 30, supplierId: supplier });
  await receiveBatch(owner, { branchId: branch, productId: amoxicillin, batchNumber: "AMX-26B", expiryDate: addDays(todayIso(), 500), quantity: 120, supplierId: supplier });
  await receiveBatch(owner, { branchId: branch, productId: ors, batchNumber: "ORS-25D", expiryDate: addDays(todayIso(), 700), quantity: 18, supplierId: supplier });
  await receiveBatch(owner, { branchId: branch, productId: ibuprofen, batchNumber: "IBU-26A", expiryDate: addDays(todayIso(), 420), quantity: 150, supplierId: supplier });
  await receiveBatch(owner, { branchId: branch, productId: cetirizine, batchNumber: "CET-25H", expiryDate: addDays(todayIso(), 90), quantity: 42, supplierId: supplier });
  await receiveBatch(owner, { branchId: branch, productId: pethidine, batchNumber: "PET-01", expiryDate: addDays(todayIso(), 400), quantity: 20, supplierId: supplier });
  await receiveBatch(owner, { branchId: branch, productId: thermometer, batchNumber: "—", expiryDate: null, quantity: 6, supplierId: supplier });
  await receiveBatch(owner, { branchId: branchB, productId: paracetamol, batchNumber: "PCM-25C", expiryDate: addDays(todayIso(), 300), quantity: 60, supplierId: supplier });

  await addStaff(db, owner, { name: "Ama Boateng", email: "ama@osupharmacy.example", password: "secret123", role: "salesperson", branchId: branch });
  await addStaff(db, owner, { name: "Kofi Mensah", email: "kofi@osupharmacy.example", password: "secret123", role: "admin" });
  const salesperson = await authenticate(db, (await login(db, "ama@osupharmacy.example", "secret123")).token);

  await createSale(salesperson, { branchId: branch, lines: [{ productId: paracetamol, quantity: 4 }, { productId: ors, quantity: 3 }], paymentMethod: "Cash", amountTenderedPesewas: 5000 });
  await createSale(salesperson, { branchId: branch, lines: [{ productId: cetirizine, quantity: 2 }], paymentMethod: "Mobile Money" });

  const rx = await createPrescription(owner, {
    branchId: branch,
    prescriptionNumber: "RX-2026-0041",
    patientName: "Kwame Boateng",
    patientAddress: "12 Ring Road, Accra",
    prescriberName: "Dr A. Mensah",
    prescriberLicence: "PCG/12345",
  });
  await createSale(owner, { branchId: branch, lines: [{ productId: amoxicillin, quantity: 10 }], paymentMethod: "Mobile Money", prescriptionId: rx });
  await createSale(owner, { branchId: branch, lines: [{ productId: pethidine, quantity: 2 }], paymentMethod: "Cash", prescriptionId: rx });

  return {
    owner,
    salesperson,
    branchId: branch,
    credentials: { owner: "owner@osupharmacy.example", admin: "kofi@osupharmacy.example", salesperson: "ama@osupharmacy.example", password: "secret123" },
  };
}

async function addBranch(db: Database, owner: Actor, name: string): Promise<string> {
  const branchId = `br_${Math.random().toString(36).slice(2, 10)}`;
  await owner.scope.insert("branches", { branch_id: branchId, name, address: null, phone: null, created_at: new Date().toISOString() });
  return branchId;
}
