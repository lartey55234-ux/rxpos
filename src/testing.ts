import { randomBytes } from "node:crypto";
import { migrate, openDatabase, openMigratedDatabase, type Database } from "./storage/index.ts";
import { registerPharmacy, authenticate } from "./auth.ts";
import { createProduct, receiveBatch, type ControlledClass } from "./catalog.ts";
import type { Actor } from "./actor.ts";

let counter = 0;
/**
 * Unique per process. Against a real server the database outlives the run, so
 * fixed fixture emails collide on the second run — which is exactly what SQLite
 * in memory hides.
 */
const runId = randomBytes(4).toString("hex");

/**
 * The database the suite runs against. SQLite in memory by default, which is
 * fast and hermetic; set DATABASE_URL to run the same tests against PostgreSQL.
 */
export function testDatabaseUrl(): string {
  return process.env.DATABASE_URL ?? ":memory:";
}

/**
 * Open the test database. Against PostgreSQL the schema is rebuilt first, so a
 * run starts clean however the last one ended. That means the suite has to run
 * one file at a time against a real server, which is what test:pg does.
 */
export async function freshTestDatabase(): Promise<Database> {
  const url = testDatabaseUrl();
  if (url === ":memory:") return openMigratedDatabase(url);
  const db = openDatabase(url);
  await db.exec("DROP SCHEMA public CASCADE; CREATE SCHEMA public;");
  await migrate(db);
  return db;
}

export type Fixture = {
  db: Database;
  owner: Actor;
  token: string;
  tenantId: string;
  branchId: string;
  email: string;
};

/** A fresh, migrated database with one registered pharmacy and an owner session. */
export async function newPharmacy(planId = "pro", label = "pharmacy"): Promise<Fixture> {
  counter += 1;
  const db = await openMigratedDatabase(testDatabaseUrl());
  const email = `owner${counter}.${label}.${runId}@example.com`;
  const reg = await registerPharmacy(db, {
    pharmacyName: `${label} ${counter}`,
    ownerName: "Test Owner",
    email,
    password: "secret123",
    planId,
  });
  const owner = await authenticate(db, reg.token);
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

export async function seedProduct(actor: Actor, input: ProductFixture = {}): Promise<string> {
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
): Promise<string> {
  return receiveBatch(actor, {
    branchId,
    productId,
    batchNumber: opts.batchNumber,
    expiryDate: opts.expiryDate,
    quantity: opts.quantity,
    sellingPricePesewas: opts.pricePesewas,
  });
}
