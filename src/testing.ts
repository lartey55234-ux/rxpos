import { openMigratedDb, type Db } from "./db.ts";
import { registerPharmacy, authenticate } from "./auth.ts";
import { createProduct, receiveBatch, type ControlledClass } from "./catalog.ts";
import type { Actor } from "./actor.ts";

let counter = 0;

export type Fixture = {
  db: Db;
  owner: Actor;
  token: string;
  tenantId: string;
  branchId: string;
  email: string;
};

/** A fresh, migrated database with one registered pharmacy and an owner session. */
export function newPharmacy(planId = "pro", label = "pharmacy"): Fixture {
  counter += 1;
  const db = openMigratedDb();
  const email = `owner${counter}.${label}@example.com`;
  const reg = registerPharmacy(db, {
    pharmacyName: `${label} ${counter}`,
    ownerName: "Test Owner",
    email,
    password: "secret123",
    planId,
  });
  const owner = authenticate(db, reg.token);
  return { db, owner, token: reg.token, tenantId: reg.tenantId, branchId: reg.branchId, email };
}

export type ProductFixture = {
  name?: string;
  pricePesewas?: number;
  costPesewas?: number;
  controlledClass?: ControlledClass;
  prescriptionRequired?: boolean;
  perishable?: boolean;
  reorderLevel?: number;
};

export function seedProduct(actor: Actor, input: ProductFixture = {}): string {
  return createProduct(actor, {
    name: input.name ?? "Paracetamol",
    form: "Tablets",
    strength: "500 mg",
    defaultPricePesewas: input.pricePesewas ?? 500,
    costPricePesewas: input.costPesewas ?? 250,
    reorderLevel: input.reorderLevel ?? 0,
    controlledClass: input.controlledClass ?? "none",
    prescriptionRequired: input.prescriptionRequired ?? false,
    perishable: input.perishable ?? true,
  });
}

export function seedBatch(
  actor: Actor,
  branchId: string,
  productId: string,
  opts: { batchNumber: string; expiryDate: string | null; quantity: number; pricePesewas?: number },
): string {
  return receiveBatch(actor, {
    branchId,
    productId,
    batchNumber: opts.batchNumber,
    expiryDate: opts.expiryDate,
    quantity: opts.quantity,
    sellingPricePesewas: opts.pricePesewas,
  });
}
