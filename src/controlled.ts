import type { TenantScope } from "./tenant.ts";
import type { Actor } from "./actor.ts";
import { assertCan } from "./permissions.ts";
import { newId, nowIso, todayIso } from "./util.ts";

export type ControlledEntry = {
  branchId: string;
  direction: "received" | "supplied";
  productId: string;
  batchId: string | null;
  batchNumber: string | null;
  quantity: number;
  supplierId?: string | null;
  recipientName?: string | null;
  recipientAddress?: string | null;
  recipientSignatureRef?: string | null;
  dispenserUserId: string;
  prescriptionId?: string | null;
  referenceType?: string | null;
  referenceId?: string | null;
};

/**
 * Append-only by design. There is no update and no delete path: Act 489 s.34
 * requires the Dangerous Drugs Record to show the drug and quantity, the name
 * and address of the person supplied, the signature of the person supplying,
 * and the date of supply — and the FDA requires those records to survive at
 * least two years and be available for inspection.
 */
export function recordControlledEntry(scope: TenantScope, entry: ControlledEntry): string {
  const entryId = newId("cdr");
  scope.insert("controlled_register", {
    entry_id: entryId,
    branch_id: entry.branchId,
    direction: entry.direction,
    product_id: entry.productId,
    batch_id: entry.batchId,
    batch_number: entry.batchNumber,
    quantity: entry.quantity,
    supplier_id: entry.supplierId ?? null,
    recipient_name: entry.recipientName ?? null,
    recipient_address: entry.recipientAddress ?? null,
    recipient_signature_ref: entry.recipientSignatureRef ?? null,
    dispenser_user_id: entry.dispenserUserId,
    prescription_id: entry.prescriptionId ?? null,
    reference_type: entry.referenceType ?? null,
    reference_id: entry.referenceId ?? null,
    entry_date: todayIso(),
    created_at: nowIso(),
  });
  return entryId;
}

/** The register as an inspector would read it: oldest first, with batch numbers. */
export function readRegister(
  actor: Actor,
  branchId: string,
  fromDate: string,
  toDate: string,
): Record<string, unknown>[] {
  assertCan(actor.role, "reports");
  return actor.scope.all(
    `SELECT r.entry_date, r.direction, p.name AS product, p.strength, r.batch_number, r.quantity,
            r.recipient_name, r.recipient_address, r.recipient_signature_ref, u.name AS dispenser,
            r.prescription_id, r.reference_type, r.reference_id
       FROM controlled_register r
       JOIN products p ON p.product_id = r.product_id
       JOIN users u ON u.user_id = r.dispenser_user_id
      WHERE r.tenant_id = {{tenant}} AND r.branch_id = ? AND r.entry_date >= ? AND r.entry_date <= ?
      ORDER BY r.entry_date ASC, r.created_at ASC`,
    branchId,
    fromDate,
    toDate,
  );
}
