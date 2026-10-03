import { createHash, randomBytes, scryptSync, timingSafeEqual } from "node:crypto";
import type { Db } from "./db.ts";
import { tx } from "./db.ts";
import { TenantScope } from "./tenant.ts";
import type { Actor } from "./actor.ts";
import { PLAN_SEED, assertWithinPlan } from "./plans.ts";
import { writeAudit } from "./audit.ts";
import { newId, nowIso } from "./util.ts";
import { assertCan, type Role } from "./permissions.ts";

const KEYLEN = 64;
const SESSION_DAYS = 30;

export function hashPassword(password: string, salt = randomBytes(16).toString("hex")) {
  return { hash: scryptSync(password, salt, KEYLEN).toString("hex"), salt };
}

export function verifyPassword(password: string, hash: string, salt: string): boolean {
  const candidate = scryptSync(password, salt, KEYLEN);
  const expected = Buffer.from(hash, "hex");
  return candidate.length === expected.length && timingSafeEqual(candidate, expected);
}

function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

export function seedPlans(db: Db): void {
  const row = db.prepare("SELECT COUNT(*) AS n FROM plans").get() as { n: number };
  if (row.n > 0) return;
  const stmt = db.prepare(
    "INSERT INTO plans (plan_id, name, price_pesewas, max_products, max_shops, max_staff, max_suppliers) VALUES (?, ?, ?, ?, ?, ?, ?)",
  );
  for (const p of PLAN_SEED) {
    stmt.run(p.plan_id, p.name, p.price_pesewas, p.max_products, p.max_shops, p.max_staff, p.max_suppliers);
  }
}

export type RegisterInput = {
  pharmacyName: string;
  ownerName: string;
  email: string;
  password: string;
  planId?: string;
  branchName?: string;
  phone?: string | null;
};

export type RegisterResult = {
  tenantId: string;
  branchId: string;
  userId: string;
  token: string;
  expiresAt: string;
};

/** Create a pharmacy (tenant) with its first branch and an owner account. */
export function registerPharmacy(db: Db, input: RegisterInput): RegisterResult {
  seedPlans(db);
  const planId = input.planId ?? "starter";
  const email = input.email.trim().toLowerCase();

  return tx(db, () => {
    const tenantId = newId("ten");
    const branchId = newId("br");
    const userId = newId("usr");
    const createdAt = nowIso();
    const { hash, salt } = hashPassword(input.password);

    db.prepare(
      "INSERT INTO tenants (tenant_id, name, phone, email, plan_id, status, created_at) VALUES (?, ?, ?, ?, ?, 'active', ?)",
    ).run(tenantId, input.pharmacyName, input.phone ?? null, email, planId, createdAt);

    db.prepare(
      "INSERT INTO branches (branch_id, tenant_id, name, address, phone, created_at) VALUES (?, ?, ?, ?, ?, ?)",
    ).run(branchId, tenantId, input.branchName ?? "Main Pharmacy", null, null, createdAt);

    db.prepare(
      "INSERT INTO users (user_id, tenant_id, branch_id, name, email, phone, password_hash, password_salt, role, status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'owner', 'active', ?)",
    ).run(userId, tenantId, null, input.ownerName, email, null, hash, salt, createdAt);

    db.prepare(
      "INSERT INTO subscriptions (subscription_id, tenant_id, plan_id, started_at, expires_at, amount_pesewas, status) VALUES (?, ?, ?, ?, ?, 0, 'active')",
    ).run(newId("sub"), tenantId, planId, createdAt, null);

    const session = createSession(db, tenantId, userId);
    const scope = new TenantScope(db, tenantId);
    writeAudit(scope, {
      userId,
      entityType: "tenant",
      entityId: tenantId,
      action: "register",
      after: { pharmacyName: input.pharmacyName, planId },
    });

    return { tenantId, branchId, userId, token: session.token, expiresAt: session.expiresAt };
  });
}

function createSession(db: Db, tenantId: string, userId: string) {
  const token = randomBytes(32).toString("base64url");
  const createdAt = nowIso();
  const expiresAt = new Date(Date.now() + SESSION_DAYS * 86_400_000).toISOString();
  db.prepare(
    "INSERT INTO sessions (session_id, tenant_id, user_id, token_hash, created_at, expires_at, revoked_at) VALUES (?, ?, ?, ?, ?, ?, NULL)",
  ).run(newId("ses"), tenantId, userId, hashToken(token), createdAt, expiresAt);
  return { token, expiresAt };
}

export class AuthError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AuthError";
  }
}

export function login(db: Db, email: string, password: string) {
  const row = db
    .prepare(
      "SELECT user_id, tenant_id, role, password_hash, password_salt, status FROM users WHERE email = ?",
    )
    .get(email.trim().toLowerCase()) as
    | { user_id: string; tenant_id: string; role: Role; password_hash: string; password_salt: string; status: string }
    | undefined;

  // Same error for unknown user and wrong password: do not leak which emails exist.
  if (!row) throw new AuthError("Invalid email or password");
  if (!verifyPassword(password, row.password_hash, row.password_salt)) {
    throw new AuthError("Invalid email or password");
  }
  if (row.status !== "active") throw new AuthError("This account is not active");

  const session = createSession(db, row.tenant_id, row.user_id);
  const scope = new TenantScope(db, row.tenant_id);
  writeAudit(scope, { userId: row.user_id, entityType: "user", entityId: row.user_id, action: "login" });
  return { token: session.token, expiresAt: session.expiresAt, tenantId: row.tenant_id, userId: row.user_id, role: row.role };
}

/** Resolve a bearer token to an actor. Expired and revoked sessions are rejected. */
export function authenticate(db: Db, token: string): Actor {
  const row = db
    .prepare(
      "SELECT tenant_id, user_id, expires_at, revoked_at FROM sessions WHERE token_hash = ?",
    )
    .get(hashToken(token)) as
    | { tenant_id: string; user_id: string; expires_at: string; revoked_at: string | null }
    | undefined;

  if (!row) throw new AuthError("Unknown session");
  if (row.revoked_at) throw new AuthError("Session revoked");
  if (row.expires_at <= nowIso()) throw new AuthError("Session expired");

  const user = db
    .prepare("SELECT role, status FROM users WHERE user_id = ? AND tenant_id = ?")
    .get(row.user_id, row.tenant_id) as { role: Role; status: string } | undefined;
  if (!user || user.status !== "active") throw new AuthError("Account is not active");

  return { scope: new TenantScope(db, row.tenant_id), userId: row.user_id, role: user.role };
}

export function logout(db: Db, token: string): void {
  db.prepare("UPDATE sessions SET revoked_at = ? WHERE token_hash = ? AND revoked_at IS NULL").run(
    nowIso(),
    hashToken(token),
  );
}

/** Owner-only: add a staff account. Enforces the plan's staff allowance. */
export function addStaff(
  db: Db,
  actor: Actor,
  input: { name: string; email: string; password: string; role: Exclude<Role, "owner">; branchId?: string | null },
): string {
  assertCan(actor.role, "users");
  assertWithinPlan(actor.scope, "staff");

  const userId = newId("usr");
  const { hash, salt } = hashPassword(input.password);
  actor.scope.insert("users", {
    user_id: userId,
    branch_id: input.branchId ?? null,
    name: input.name,
    email: input.email.trim().toLowerCase(),
    phone: null,
    password_hash: hash,
    password_salt: salt,
    role: input.role,
    status: "active",
    created_at: nowIso(),
  });
  writeAudit(actor.scope, {
    userId: actor.userId,
    entityType: "user",
    entityId: userId,
    action: "create",
    after: { name: input.name, role: input.role },
  });
  return userId;
}
