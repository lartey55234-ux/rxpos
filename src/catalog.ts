import type { Actor } from "./actor.ts";
import { assertCan } from "./permissions.ts";
import { assertWithinPlan } from "./plans.ts";
import { writeAudit } from "./audit.ts";
import { recordControlledEntry } from "./controlled.ts";
import { bool, newId, nowIso, todayIso } from "./util.ts";

export type ControlledClass = "none" | "B" | "A";

export type ProductInput = {
  name: string;
  form?: string | null;
  strength?: string | null;
  brand?: string | null;
  unit?: string | null;
  barcode?: string | null;
  categoryId?: string | null;
  defaultPricePesewas: number;
  costPricePesewas?: number;
  reorderLevel?: number;
  prescriptionRequired?: boolean;
  controlledClass?: ControlledClass;
  perishable?: boolean;
};

export function createCategory(actor: Actor, name: string, description?: string): string {
  assertCan(actor.role, "products");
  const categoryId = newId("cat");
  actor.scope.insert("categories", { category_id: categoryId, name, description: description ?? null });
  return categoryId;
}

export function createSupplier(
  actor: Actor,
  input: { name: string; phone?: string | null; email?: string | null; address?: string | null },
): string {
  assertCan(actor.role, "suppliers");
  assertWithinPlan(actor.scope, "suppliers");
  const supplierId = newId("sup");
  actor.scope.insert("suppliers", {
    supplier_id: supplierId,
    name: input.name,
    phone: input.phone ?? null,
    email: input.email ?? null,
    address: input.address ?? null,
    created_at: nowIso(),
  });
  writeAudit(actor.scope, {
    userId: actor.userId,
    entityType: "supplier",
    entityId: supplierId,
    action: "create",
    after: { name: input.name },
  });
  return supplierId;
}

export function createProduct(actor: Actor, input: ProductInput): string {
  assertCan(actor.role, "products");
  assertWithinPlan(actor.scope, "products");
  const productId = newId("prd");
  actor.scope.insert("products", {
    product_id: productId,
    category_id: input.categoryId ?? null,
    name: input.name,
    brand: input.brand ?? null,
    form: input.form ?? null,
    strength: input.strength ?? null,
    unit: input.unit ?? null,
    barcode: input.barcode ?? null,
    default_price_pesewas: input.defaultPricePesewas,
    cost_price_pesewas: input.costPricePesewas ?? 0,
    reorder_level: input.reorderLevel ?? 0,
    prescription_required: bool(input.prescriptionRequired),
    controlled_class: input.controlledClass ?? "none",
    perishable: bool(input.perishable ?? true),
    status: "active",
    created_at: nowIso(),
  });
  writeAudit(actor.scope, {
    userId: actor.userId,
    entityType: "product",
    entityId: productId,
    action: "create",
    after: { name: input.name, controlledClass: input.controlledClass ?? "none" },
  });
  return productId;
}

export function createBranch(
  actor: Actor,
  input: { name: string; address?: string | null; phone?: string | null },
): string {
  assertCan(actor.role, "plans");
  assertWithinPlan(actor.scope, "shops");
  const branchId = newId("br");
  actor.scope.insert("branches", {
    branch_id: branchId,
    name: input.name,
    address: input.address ?? null,
    phone: input.phone ?? null,
    created_at: nowIso(),
  });
  return branchId;
}

export type ReceiveInput = {
  branchId: string;
  productId: string;
  batchNumber: string;
  expiryDate: string | null;
  quantity: number;
  costPricePesewas?: number;
  sellingPricePesewas?: number;
  supplierId?: string | null;
};

/**
 * Receive stock into a batch. Writes the batch, a stock movement for the ledger,
 * and — for a controlled product — the receipt side of the Controlled Drugs Register.
 */
export function receiveBatch(actor: Actor, input: ReceiveInput): string {
  assertCan(actor.role, "stock");
  if (input.quantity <= 0) throw new Error("Quantity must be greater than zero");

  const product = actor.scope.get<{
    product_id: string;
    name: string;
    perishable: number;
    controlled_class: ControlledClass;
    default_price_pesewas: number;
    cost_price_pesewas: number;
  }>(
    "SELECT product_id, name, perishable, controlled_class, default_price_pesewas, cost_price_pesewas FROM products WHERE tenant_id = {{tenant}} AND product_id = ?",
    input.productId,
  );
  if (!product) throw new Error(`Unknown product ${input.productId}`);
  if (product.perishable === 1 && !input.expiryDate) {
    throw new Error(`${product.name} is perishable: an expiry date is required`);
  }

  const batchId = newId("bat");
  actor.scope.insert("batches", {
    batch_id: batchId,
    product_id: input.productId,
    branch_id: input.branchId,
    supplier_id: input.supplierId ?? null,
    batch_number: input.batchNumber,
    expiry_date: input.expiryDate,
    quantity: input.quantity,
    cost_price_pesewas: input.costPricePesewas ?? product.cost_price_pesewas,
    selling_price_pesewas: input.sellingPricePesewas ?? product.default_price_pesewas,
    received_at: nowIso(),
  });

  actor.scope.insert("stock_movements", {
    movement_id: newId("mov"),
    batch_id: batchId,
    branch_id: input.branchId,
    user_id: actor.userId,
    movement_type: "receipt",
    quantity_delta: input.quantity,
    reference_type: "purchase",
    reference_id: null,
    note: `Batch ${input.batchNumber}`,
    created_at: nowIso(),
  });

  if (product.controlled_class !== "none") {
    recordControlledEntry(actor.scope, {
      branchId: input.branchId,
      direction: "received",
      productId: input.productId,
      batchId,
      batchNumber: input.batchNumber,
      quantity: input.quantity,
      supplierId: input.supplierId ?? null,
      dispenserUserId: actor.userId,
      referenceType: "batch",
      referenceId: batchId,
    });
  }

  writeAudit(actor.scope, {
    userId: actor.userId,
    entityType: "batch",
    entityId: batchId,
    action: "receive",
    after: { product: product.name, batchNumber: input.batchNumber, quantity: input.quantity },
  });
  return batchId;
}

/** Sellable stock: excludes expired batches, which may not be supplied. */
export function sellableStock(actor: Actor, productId: string, branchId: string): number {
  const row = actor.scope.get<{ n: number }>(
    `SELECT COALESCE(SUM(quantity), 0) AS n FROM batches
      WHERE tenant_id = {{tenant}} AND product_id = ? AND branch_id = ?
        AND quantity > 0 AND (expiry_date IS NULL OR expiry_date >= ?)`,
    productId,
    branchId,
    todayIso(),
  );
  return row?.n ?? 0;
}

export function stockIncludingExpired(actor: Actor, productId: string, branchId: string): number {
  const row = actor.scope.get<{ n: number }>(
    "SELECT COALESCE(SUM(quantity), 0) AS n FROM batches WHERE tenant_id = {{tenant}} AND product_id = ? AND branch_id = ?",
    productId,
    branchId,
  );
  return row?.n ?? 0;
}

export function expiredBatches(actor: Actor, branchId: string) {
  return actor.scope.all(
    `SELECT b.batch_id, b.batch_number, b.expiry_date, b.quantity, p.name AS product
       FROM batches b JOIN products p ON p.product_id = b.product_id
      WHERE b.tenant_id = {{tenant}} AND b.branch_id = ? AND b.quantity > 0
        AND b.expiry_date IS NOT NULL AND b.expiry_date < ?
      ORDER BY b.expiry_date ASC`,
    branchId,
    todayIso(),
  );
}

export function expiringWithin(actor: Actor, branchId: string, days: number) {
  const cutoff = new Date(Date.now() + days * 86_400_000).toISOString().slice(0, 10);
  return actor.scope.all(
    `SELECT b.batch_id, b.batch_number, b.expiry_date, b.quantity, p.name AS product
       FROM batches b JOIN products p ON p.product_id = b.product_id
      WHERE b.tenant_id = {{tenant}} AND b.branch_id = ? AND b.quantity > 0
        AND b.expiry_date IS NOT NULL AND b.expiry_date >= ? AND b.expiry_date <= ?
      ORDER BY b.expiry_date ASC`,
    branchId,
    todayIso(),
    cutoff,
  );
}

export function lowStock(actor: Actor, branchId: string) {
  return actor.scope.all(
    `SELECT p.product_id, p.name, p.reorder_level, COALESCE(SUM(b.quantity), 0) AS on_hand
       FROM products p
       LEFT JOIN batches b
         ON b.product_id = p.product_id AND b.tenant_id = p.tenant_id AND b.branch_id = ?
        AND b.quantity > 0 AND (b.expiry_date IS NULL OR b.expiry_date >= ?)
      WHERE p.tenant_id = {{tenant}} AND p.status = 'active'
      GROUP BY p.product_id, p.name, p.reorder_level
     HAVING on_hand <= p.reorder_level
      ORDER BY on_hand ASC`,
    branchId,
    todayIso(),
  );
}

/** Write off a batch (expired or damaged). Never deletes: the movement stays. */
export function writeOffBatch(actor: Actor, batchId: string, note: string): void {
  assertCan(actor.role, "stock");
  const batch = actor.scope.get<{
    batch_id: string;
    branch_id: string;
    quantity: number;
    batch_number: string;
  }>(
    "SELECT batch_id, branch_id, quantity, batch_number FROM batches WHERE tenant_id = {{tenant}} AND batch_id = ?",
    batchId,
  );
  if (!batch) throw new Error(`Unknown batch ${batchId}`);
  if (batch.quantity === 0) return;

  actor.scope.run("UPDATE batches SET quantity = 0 WHERE tenant_id = {{tenant}} AND batch_id = ?", batchId);
  actor.scope.insert("stock_movements", {
    movement_id: newId("mov"),
    batch_id: batchId,
    branch_id: batch.branch_id,
    user_id: actor.userId,
    movement_type: "write_off",
    quantity_delta: -batch.quantity,
    reference_type: "write_off",
    reference_id: batchId,
    note,
    created_at: nowIso(),
  });
  writeAudit(actor.scope, {
    userId: actor.userId,
    entityType: "batch",
    entityId: batchId,
    action: "write_off",
    before: { quantity: batch.quantity },
    after: { quantity: 0, note },
  });
}
