import type { Actor } from "./actor.ts";
import { assertCan } from "./permissions.ts";
import { writeAudit } from "./audit.ts";
import { addDays, newId, nowIso, todayIso } from "./util.ts";

/** Act 489 s.32: a dispensed prescription is retained for two years on the premises. */
export const PRESCRIPTION_RETENTION_DAYS = 730;

export type PrescriptionInput = {
  branchId: string;
  prescriptionNumber: string;
  patientName: string;
  patientAddress?: string | null;
  prescriberName: string;
  prescriberLicence?: string | null;
  issuedDate?: string;
};

export async function createPrescription(actor: Actor, input: PrescriptionInput): Promise<string> {
  assertCan(actor.role, "dispense_controlled");
  const issuedDate = input.issuedDate ?? todayIso();
  const prescriptionId = newId("rx");
  await actor.scope.insert("prescriptions", {
    prescription_id: prescriptionId,
    branch_id: input.branchId,
    prescription_number: input.prescriptionNumber,
    patient_name: input.patientName,
    patient_address: input.patientAddress ?? null,
    prescriber_name: input.prescriberName,
    prescriber_licence: input.prescriberLicence ?? null,
    issued_date: issuedDate,
    retained_until: addDays(issuedDate, PRESCRIPTION_RETENTION_DAYS),
    created_by: actor.userId,
    created_at: nowIso(),
  });
  await writeAudit(actor.scope, {
    userId: actor.userId,
    entityType: "prescription",
    entityId: prescriptionId,
    action: "create",
    after: { prescriptionNumber: input.prescriptionNumber, patient: input.patientName },
  });
  return prescriptionId;
}

export type PrescriptionRow = {
  prescription_id: string;
  patient_name: string;
  patient_address: string | null;
  prescriber_name: string;
  retained_until: string;
};

export async function getPrescription(actor: Actor, prescriptionId: string): Promise<PrescriptionRow | undefined> {
  return actor.scope.get<PrescriptionRow>(
    "SELECT prescription_id, patient_name, patient_address, prescriber_name, retained_until FROM prescriptions WHERE tenant_id = {{tenant}} AND prescription_id = ?",
    prescriptionId,
  );
}
