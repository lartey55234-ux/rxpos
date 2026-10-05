/**
 * Getting back in when the password is gone.
 *
 * Three things make this safe rather than merely present:
 *
 *   - The token is stored hashed. A leaked reset token is a way into somebody's
 *     pharmacy, so the database should not hold anything that can be used directly.
 *   - It works once, and expires. Asking again invalidates the previous link, so an
 *     old email cannot be replayed.
 *   - Resetting revokes every existing session. If someone else was signed in with
 *     the old password, changing it throws them out — which is the whole point of
 *     resetting a password you believe is compromised.
 *
 * And the endpoint says nothing about whether an address is known. Answering
 * differently for a real account than an unknown one is a way to enumerate a
 * pharmacy's staff.
 */

import { createHash, randomBytes } from "node:crypto";
import type { Database } from "./storage/index.ts";
import { TenantScope } from "./tenant.ts";
import { hashPassword } from "./auth.ts";
import { writeAudit } from "./audit.ts";
import type { Mailer } from "./mail.ts";
import { passwordResetEmail } from "./mail.ts";
import { ValidationError, newId, nowIso } from "./util.ts";

export const RESET_MINUTES = 60;
export const MIN_PASSWORD = 8;

const hashToken = (token: string): string => createHash("sha256").update(token).digest("hex");

/** Ask for a reset link. Silently does nothing if the address is unknown. */
export async function requestPasswordReset(
  db: Database,
  mailer: Mailer,
  publicUrl: string,
  email: string,
): Promise<void> {
  const normalised = (email ?? "").trim().toLowerCase();
  if (!normalised) return;

  const user = await db.get<{ user_id: string; tenant_id: string; name: string; status: string }>(
    "SELECT user_id, tenant_id, name, status FROM users WHERE email = ?",
    [normalised],
  );
  if (!user || user.status !== "active") return;

  const tenant = await db.get<{ name: string }>("SELECT name FROM tenants WHERE tenant_id = ?", [user.tenant_id]);
  const scope = new TenantScope(db, user.tenant_id);
  const now = nowIso();
  const expiresAt = new Date(Date.now() + RESET_MINUTES * 60_000).toISOString();

  // Asking again invalidates the link already in their inbox.
  await scope.run(
    "UPDATE password_resets SET used_at = ? WHERE tenant_id = {{tenant}} AND user_id = ? AND used_at IS NULL",
    now,
    user.user_id,
  );

  const token = randomBytes(32).toString("base64url");
  await scope.insert("password_resets", {
    reset_id: newId("rst"),
    user_id: user.user_id,
    token_hash: hashToken(token),
    created_at: now,
    expires_at: expiresAt,
    used_at: null,
  });

  await writeAudit(scope, {
    userId: user.user_id,
    entityType: "user",
    entityId: user.user_id,
    action: "password_reset_requested",
  });

  const link = `${publicUrl.replace(/\/+$/, "")}/?reset=${encodeURIComponent(token)}`;
  const message = passwordResetEmail({
    pharmacyName: tenant?.name ?? "your pharmacy",
    ownerName: user.name,
    link,
    minutes: RESET_MINUTES,
  });
  await mailer.send({ ...message, to: normalised });
}

export type ResetCheck = { valid: boolean; reason: string | null };

/** Whether a link is still worth typing a password into. */
export async function checkResetToken(db: Database, token: string): Promise<ResetCheck> {
  if (!token || token.length < 20) return { valid: false, reason: "That reset link is not valid." };
  const row = await db.get<{ expires_at: string; used_at: string | null }>(
    "SELECT expires_at, used_at FROM password_resets WHERE token_hash = ?",
    [hashToken(token)],
  );
  if (!row) return { valid: false, reason: "That reset link is not valid. Ask for a new one." };
  if (row.used_at) return { valid: false, reason: "That reset link has already been used. Ask for a new one." };
  if (row.expires_at <= nowIso()) return { valid: false, reason: "That reset link has expired. Ask for a new one." };
  return { valid: true, reason: null };
}

/** Set a new password. The link is spent, and every old session dies with it. */
export async function resetPassword(db: Database, token: string, newPassword: string): Promise<{ email: string }> {
  const check = await checkResetToken(db, token);
  if (!check.valid) throw new ValidationError(check.reason ?? "That reset link is not valid.");
  if ((newPassword ?? "").length < MIN_PASSWORD) {
    throw new ValidationError(`Choose a password of at least ${MIN_PASSWORD} characters`);
  }

  const row = await db.get<{ reset_id: string; tenant_id: string; user_id: string }>(
    "SELECT reset_id, tenant_id, user_id FROM password_resets WHERE token_hash = ?",
    [hashToken(token)],
  );
  if (!row) throw new ValidationError("That reset link is not valid. Ask for a new one.");

  const { hash, salt } = hashPassword(newPassword);
  const now = nowIso();

  await db.transaction(async (trx) => {
    const scope = new TenantScope(trx, row.tenant_id);
    await scope.run(
      "UPDATE users SET password_hash = ?, password_salt = ? WHERE tenant_id = {{tenant}} AND user_id = ?",
      hash,
      salt,
      row.user_id,
    );
    await scope.run("UPDATE password_resets SET used_at = ? WHERE tenant_id = {{tenant}} AND reset_id = ?", now, row.reset_id);
    // Whatever was signed in with the old password is signed out now.
    await scope.run(
      "UPDATE sessions SET revoked_at = ? WHERE tenant_id = {{tenant}} AND user_id = ? AND revoked_at IS NULL",
      now,
      row.user_id,
    );
    await writeAudit(scope, {
      userId: row.user_id,
      entityType: "user",
      entityId: row.user_id,
      action: "password_reset",
    });
  });

  const user = await new TenantScope(db, row.tenant_id).get<{ email: string }>(
    "SELECT email FROM users WHERE tenant_id = {{tenant}} AND user_id = ?",
    row.user_id,
  );
  return { email: user?.email ?? "" };
}
