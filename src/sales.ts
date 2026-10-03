import type { Actor } from "./actor.ts";
import { tx } from "./db.ts";
import { assertCan } from "./permissions.ts";
import { writeAudit } from "./audit.ts";
import { recordControlledEntry } from "./controlled.ts";
import { getPrescription } from "./prescriptions.ts";
import { newId, nowIso, todayIso } from "./util.ts";
import type { ControlledClass } from "./catalog.ts";

export type SaleLineInput = { productId: string; quantity: number };

export type SaleInput = {
  branchId: string;
  lines: SaleLineInput[];
  paymentMethod: "Cash" | "Mobile Money" | "Card";
  amountTenderedPesewas?: number;
  discountPesewas?: number;
  customerId?: string | null;
  prescriptionId?: string | null;
  /** Act 489 s.34: name and address of the person a controlled drug is supplied to. */
  recipientName?: string | null;
  recipientAddress?: string | null;
  recipientSignatureRef?: string | null;
};

export type SaleItemResult = {
  productId: string;
  batchId: string;
  batchNumber: string;
  expiryDate: string | null;
  quantity: number;
  unitPricePesewas: number;
  lineTotalPesewas: number;
};

export type SaleResult = {
  saleId: string;
  subtotalPesewas: number;
  discountPesewas: number;
  totalPesewas: number;
  changePesewas: number;
  items: SaleItemResult[];
  controlledEntries: number;
};

export class SaleError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SaleError";
  }
}

type ProductRow = {
  product_id: string;
  name: string;
  perishable: number;
  controlled_class: ControlledClass;
  prescription_required: number;
  status: string;
};

type BatchRow = {
  batch_id: string;
  batch_number: string;
  quantity: number;
  selling_price_pesewas: number;
  expiry_date: string | null;
};

/**
 * Take a sale. Rules enforced here, not in the UI:
 *   - stock is drawn first-expiry-first-out
 *   - expired batches can never be supplied
 *   - a controlled drug needs a prescription, and only an owner or administrator
 *     may dispense one
 *   - every quantity change writes a stock movement
 */
export function createSale(actor: Actor, input: SaleInput): SaleResult {
  assertCan(actor.role, "sell");
  if (!input.lines.length) throw new SaleError("A sale needs at least one line");

  return tx(actor.scope.db, () => {
    const saleId = newId("sal");
    const createdAt = nowIso();
    const today = todayIso();
    const items: SaleItemResult[] = [];
    let controlledEntries = 0;
    let needsPrescription = false;

    for (const line of input.lines) {
      if (line.quantity <= 0) throw new SaleError("Line quantities must be greater than zero");

      const product = actor.scope.get<ProductRow>(
        "SELECT product_id, name, perishable, controlled_class, prescription_required, status FROM products WHERE tenant_id = {{tenant}} AND product_id = ?",
        line.productId,
      );
      if (!product) throw new SaleError(`Unknown product ${line.productId}`);
      if (product.status !== "active") throw new SaleError(`${product.name} is not active`);

      const controlled = product.controlled_class !== "none";
      if (controlled || product.prescription_required === 1) needsPrescription = true;
      if (controlled) {
        assertCan(actor.role, "dispense_controlled");
      }

      const batches = actor.scope.all<BatchRow>(
        `SELECT batch_id, batch_number, quantity, selling_price_pesewas, expiry_date FROM batches
          WHERE tenant_id = {{tenant}} AND product_id = ? AND branch_id = ? AND quantity > 0
            AND (expiry_date IS NULL OR expiry_date >= ?)
          ORDER BY expiry_date IS NULL, expiry_date ASC, received_at ASC`,
        line.productId,
        input.branchId,
        today,
      );

      const available = batches.reduce((sum, b) => sum + b.quantity, 0);
      if (available < line.quantity) {
        throw new SaleError(
          `${product.name}: only ${available} sellable unit(s) in this branch (expired batches are excluded)`,
        );
      }

      let remaining = line.quantity;
      for (const batch of batches) {
        if (remaining === 0) break;
        const take = Math.min(remaining, batch.quantity);
        remaining -= take;

        const updated = actor.scope.db
          .prepare("UPDATE batches SET quantity = quantity - ? WHERE tenant_id = ? AND batch_id = ? AND quantity >= ?")
          .run(take, actor.scope.tenantId, batch.batch_id, take);
        if (updated.changes !== 1) throw new SaleError(`Stock changed while selling ${product.name}; retry the sale`);

        const lineTotal = take * batch.selling_price_pesewas;
        items.push({
          productId: line.productId,
          batchId: batch.batch_id,
          batchNumber: batch.batch_number,
          expiryDate: batch.expiry_date,
          quantity: take,
          unitPricePesewas: batch.selling_price_pesewas,
          lineTotalPesewas: lineTotal,
        });

        actor.scope.insert("stock_movements", {
          movement_id: newId("mov"),
          batch_id: batch.batch_id,
          branch_id: input.branchId,
          user_id: actor.userId,
          movement_type: "sale",
          quantity_delta: -take,
          reference_type: "sale",
          reference_id: saleId,
          note: null,
          created_at: createdAt,
        });
      }
    }

    // A controlled drug may only be supplied against a valid prescription.
    if (needsPrescription && !input.prescriptionId) {
      throw new SaleError(
        "This sale needs a prescription: controlled and prescription-only items cannot be supplied without one",
      );
    }
    const prescription = input.prescriptionId ? getPrescription(actor, input.prescriptionId) : undefined;
    if (input.prescriptionId && !prescription) throw new SaleError(`Unknown prescription ${input.prescriptionId}`);

    const subtotal = items.reduce((sum, i) => sum + i.lineTotalPesewas, 0);
    const discount = input.discountPesewas ?? 0;
    if (discount < 0 || discount > subtotal) throw new SaleError("Discount must be between zero and the subtotal");
    const total = subtotal - discount;

    const tendered = input.amountTenderedPesewas ?? total;
    if (input.paymentMethod === "Cash" && tendered < total) {
      throw new SaleError("Amount tendered is less than the total");
    }
    const change = input.paymentMethod === "Cash" ? tendered - total : 0;

    actor.scope.insert("sales", {
      sale_id: saleId,
      branch_id: input.branchId,
      user_id: actor.userId,
      customer_id: input.customerId ?? null,
      prescription_id: input.prescriptionId ?? null,
      sale_date: createdAt,
      subtotal_pesewas: subtotal,
      discount_pesewas: discount,
      tax_pesewas: 0,
      total_pesewas: total,
      payment_method: input.paymentMethod,
      amount_tendered_pesewas: tendered,
      change_pesewas: change,
      status: "completed",
    });

    for (const item of items) {
      actor.scope.insert("sale_items", {
        sale_item_id: newId("sli"),
        sale_id: saleId,
        product_id: item.productId,
        batch_id: item.batchId,
        quantity: item.quantity,
        unit_price_pesewas: item.unitPricePesewas,
        discount_pesewas: 0,
        line_total_pesewas: item.lineTotalPesewas,
      });
    }

    actor.scope.insert("payments", {
      payment_id: newId("pay"),
      sale_id: saleId,
      method: input.paymentMethod,
      amount_pesewas: total,
      provider_ref: null,
      paid_at: createdAt,
    });

    for (const item of items) {
      const product = actor.scope.get<ProductRow>(
        "SELECT product_id, name, perishable, controlled_class, prescription_required, status FROM products WHERE tenant_id = {{tenant}} AND product_id = ?",
        item.productId,
      );
      if (!product || product.controlled_class === "none") continue;
      recordControlledEntry(actor.scope, {
        branchId: input.branchId,
        direction: "supplied",
        productId: item.productId,
        batchId: item.batchId,
        batchNumber: item.batchNumber,
        quantity: item.quantity,
        recipientName: input.recipientName ?? prescription?.patient_name ?? null,
        recipientAddress: input.recipientAddress ?? prescription?.patient_address ?? null,
        recipientSignatureRef: input.recipientSignatureRef ?? null,
        dispenserUserId: actor.userId,
        prescriptionId: input.prescriptionId ?? null,
        referenceType: "sale",
        referenceId: saleId,
      });
      controlledEntries += 1;
    }

    writeAudit(actor.scope, {
      userId: actor.userId,
      entityType: "sale",
      entityId: saleId,
      action: "create",
      after: { totalPesewas: total, lines: items.length, controlledEntries },
    });

    return { saleId, subtotalPesewas: subtotal, discountPesewas: discount, totalPesewas: total, changePesewas: change, items, controlledEntries };
  });
}
