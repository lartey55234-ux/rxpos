import type { TenantScope } from "./tenant.ts";
import { newId, nowIso } from "./util.ts";

export type AuditEntry = {
  userId: string | null;
  entityType: string;
  entityId: string;
  action: string;
  before?: unknown;
  after?: unknown;
};

export async function writeAudit(scope: TenantScope, entry: AuditEntry): Promise<void> {
  await scope.insert("audit_log", {
    audit_id: newId("aud"),
    user_id: entry.userId,
    entity_type: entry.entityType,
    entity_id: entry.entityId,
    action: entry.action,
    before_json: entry.before === undefined ? null : JSON.stringify(entry.before),
    after_json: entry.after === undefined ? null : JSON.stringify(entry.after),
    created_at: nowIso(),
  });
}
