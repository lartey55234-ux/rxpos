import type { Actor } from "./actor.ts";
import { TenantScope } from "./tenant.ts";
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
export async function createSale(actor: Actor, input: SaleInput): Promise<SaleResult> {
  assertCan(actor.role, "sell");
  if (!input.lines.length) throw new SaleError("A sale needs at least one line");

  return actor.scope.db.transaction(async (trx) => {
    // The whole sale must run on one connection, so rebuild the scope against the
    // transaction handle rather than the pool.
    const me: Actor = { ...actor, scope: new TenantScope(trx, actor.scope.tenantId) };
    const saleId = newId("sal");
    const createdAt = nowIso();
    const today = todayIso();
    const items: SaleItemResult[] = [];
    let controlledEntries = 0;
    let needsPrescription = false;

    for (const line of input.lines) {
      if (line.quantity <= 0) throw new SaleError("Line quantities must be greater than zero");

      const product = await me.scope.get<ProductRow>(
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

      const batches = await me.scope.all<BatchRow>(
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

        // Conditional update: if another till sold the same batch first this changes
        // nothing, and the sale is refused rather than overselling.
        const updated = await trx.run(
          "UPDATE batches SET quantity = quantity - ? WHERE tenant_id = ? AND batch_id = ? AND quantity >= ?",
          [take, actor.scope.tenantId, batch.batch_id, take],
        );
        if (updated !== 1) throw new SaleError(`Stock changed while selling ${product.name}; retry the sale`);

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

        await me.scope.insert("stock_movements", {
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
    const prescription = input.prescriptionId ? await getPrescription(me, input.prescriptionId) : undefined;
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

    await me.scope.insert("sales", {
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
      await me.scope.insert("sale_items", {
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

    await me.scope.insert("payments", {
      payment_id: newId("pay"),
      sale_id: saleId,
      method: input.paymentMethod,
      amount_pesewas: total,
      provider_ref: null,
      paid_at: createdAt,
    });

    for (const item of items) {
      const product = await me.scope.get<ProductRow>(
        "SELECT product_id, name, perishable, controlled_class, prescription_required, status FROM products WHERE tenant_id = {{tenant}} AND product_id = ?",
        item.productId,
      );
      if (!product || product.controlled_class === "none") continue;
      await recordControlledEntry(actor.scope, {
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

    await writeAudit(actor.scope, {
      userId: actor.userId,
      entityType: "sale",
      entityId: saleId,
      action: "create",
      after: { totalPesewas: total, lines: items.length, controlledEntries },
    });

    return { saleId, subtotalPesewas: subtotal, discountPesewas: discount, totalPesewas: total, changePesewas: change, items, controlledEntries };
  });
}

export type ReceiptLine = {
  name: string;
  strength: string | null;
  form: string | null;
  quantity: number;
  unitPricePesewas: number;
  lineTotalPesewas: number;
  batchNumber: string;
};

export type Receipt = {
  saleId: string;
  at: string;
  branch: string;
  servedBy: string;
  paymentMethod: string;
  subtotalPesewas: number;
  discountPesewas: number;
  totalPesewas: number;
  amountTenderedPesewas: number;
  changePesewas: number;
  lines: ReceiptLine[];
  controlled: { name: string; quantity: number; batchNumber: string; recipient: string | null }[];
  prescriptionNumber: string | null;
};

/** Everything a printed receipt needs, read back from what was actually recorded. */
export async function getReceipt(actor: Actor, saleId: string): Promise<Receipt> {
  const sale = await actor.scope.get<{
    sale_id: string;
    sale_date: string;
    branch_id: string;
    user_id: string;
    payment_method: string;
    subtotal_pesewas: number;
    discount_pesewas: number;
    total_pesewas: number;
    amount_tendered_pesewas: number;
    change_pesewas: number;
    prescription_id: string | null;
  }>(
    "SELECT sale_id, sale_date, branch_id, user_id, payment_method, subtotal_pesewas, discount_pesewas, total_pesewas, amount_tendered_pesewas, change_pesewas, prescription_id FROM sales WHERE tenant_id = {{tenant}} AND sale_id = ?",
    saleId,
  );
  if (!sale) throw new SaleError(`Unknown sale ${saleId}`);

  const branch = await actor.scope.get<{ name: string }>(
    "SELECT name FROM branches WHERE tenant_id = {{tenant}} AND branch_id = ?",
    sale.branch_id,
  );
  const staff = await actor.scope.get<{ name: string }>(
    "SELECT name FROM users WHERE tenant_id = {{tenant}} AND user_id = ?",
    sale.user_id,
  );
  const lines = await actor.scope.all<ReceiptLine>(
    `SELECT p.name, p.strength, p.form, si.quantity, si.unit_price_pesewas AS "unitPricePesewas",
            si.line_total_pesewas AS "lineTotalPesewas", b.batch_number AS "batchNumber"
       FROM sale_items si
       JOIN products p ON p.product_id = si.product_id
       JOIN batches b ON b.batch_id = si.batch_id
      WHERE si.tenant_id = {{tenant}} AND si.sale_id = ?
      ORDER BY si.sale_item_id ASC`,
    saleId,
  );
  const controlled = await actor.scope.all<{ name: string; quantity: number; batchNumber: string; recipient: string | null }>(
    `SELECT p.name, r.quantity, r.batch_number AS "batchNumber", r.recipient_name AS recipient
       FROM controlled_register r JOIN products p ON p.product_id = r.product_id
      WHERE r.tenant_id = {{tenant}} AND r.reference_type = 'sale' AND r.reference_id = ?
      ORDER BY r.created_at ASC`,
    saleId,
  );
  const rx = sale.prescription_id
    ? await actor.scope.get<{ prescription_number: string }>(
        "SELECT prescription_number FROM prescriptions WHERE tenant_id = {{tenant}} AND prescription_id = ?",
        sale.prescription_id,
      )
    : undefined;

  return {
    saleId: sale.sale_id,
    at: sale.sale_date,
    branch: branch?.name ?? "—",
    servedBy: staff?.name ?? "—",
    paymentMethod: sale.payment_method,
    subtotalPesewas: sale.subtotal_pesewas,
    discountPesewas: sale.discount_pesewas,
    totalPesewas: sale.total_pesewas,
    amountTenderedPesewas: sale.amount_tendered_pesewas,
    changePesewas: sale.change_pesewas,
    lines,
    controlled,
    prescriptionNumber: rx?.prescription_number ?? null,
  };
}
