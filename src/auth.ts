import { createHash, randomBytes, scryptSync, timingSafeEqual } from "node:crypto";
import type { Database } from "./storage/index.ts";
import { TenantScope } from "./tenant.ts";
import type { Actor } from "./actor.ts";
import { PLAN_SEED, assertWithinPlan } from "./plans.ts";
import { writeAudit } from "./audit.ts";
import { ValidationError, newId, nowIso } from "./util.ts";
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

export async function seedPlans(db: Database): Promise<void> {
  const row = await db.get<{ n: number }>("SELECT COUNT(*) AS n FROM plans");
  if ((row?.n ?? 0) > 0) return;
  for (const plan of PLAN_SEED) {
    await db.run(
      "INSERT INTO plans (plan_id, name, price_pesewas, max_products, max_shops, max_staff, max_suppliers) VALUES (?, ?, ?, ?, ?, ?, ?)",
      [plan.plan_id, plan.name, plan.price_pesewas, plan.max_products, plan.max_shops, plan.max_staff, plan.max_suppliers],
    );
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

/**
 * Reject registrations that cannot work, in words a pharmacy owner can act on.
 * Called from registerPharmacy so every entry point is covered.
 */
export function validateRegistration(input: RegisterInput): void {
  if ((input.pharmacyName ?? "").trim().length < 2) {
    throw new ValidationError("Enter the pharmacy name");
  }
  if ((input.ownerName ?? "").trim().length < 2) {
    throw new ValidationError("Enter your name");
  }
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test((input.email ?? "").trim())) {
    throw new ValidationError("Enter a valid email address");
  }
  if ((input.password ?? "").length < 8) {
    throw new ValidationError("Choose a password of at least 8 characters");
  }
}

/** Create a pharmacy (tenant) with its first branch and an owner account. */
export async function registerPharmacy(db: Database, input: RegisterInput): Promise<RegisterResult> {
  validateRegistration(input);
  await seedPlans(db);
  const planId = input.planId ?? "starter";
  const email = input.email.trim().toLowerCase();

  const tenantId = newId("ten");
  const branchId = newId("br");
  const userId = newId("usr");
  const createdAt = nowIso();
  const { hash, salt } = hashPassword(input.password);

  // One transaction, so a failure part-way leaves no half-built pharmacy behind.
  return db.transaction(async (trx) => {
    await trx.run(
      "INSERT INTO tenants (tenant_id, name, phone, email, plan_id, status, created_at) VALUES (?, ?, ?, ?, ?, 'active', ?)",
      [tenantId, input.pharmacyName, input.phone ?? null, email, planId, createdAt],
    );

    await trx.run(
      "INSERT INTO branches (branch_id, tenant_id, name, address, phone, created_at) VALUES (?, ?, ?, ?, ?, ?)",
      [branchId, tenantId, input.branchName ?? "Main Pharmacy", null, null, createdAt],
    );

    await trx.run(
      "INSERT INTO users (user_id, tenant_id, branch_id, name, email, phone, password_hash, password_salt, role, status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'owner', 'active', ?)",
      [userId, tenantId, null, input.ownerName, email, null, hash, salt, createdAt],
    );

    await trx.run(
      "INSERT INTO subscriptions (subscription_id, tenant_id, plan_id, started_at, expires_at, amount_pesewas, status) VALUES (?, ?, ?, ?, ?, 0, 'active')",
      [newId("sub"), tenantId, planId, createdAt, null],
    );

    const session = await createSession(trx, tenantId, userId);
    await writeAudit(new TenantScope(trx, tenantId), {
      userId,
      entityType: "tenant",
      entityId: tenantId,
      action: "register",
      after: { pharmacyName: input.pharmacyName, planId },
    });

    return { tenantId, branchId, userId, token: session.token, expiresAt: session.expiresAt };
  });
}

async function createSession(db: Database, tenantId: string, userId: string) {
  const token = randomBytes(32).toString("base64url");
  const createdAt = nowIso();
  const expiresAt = new Date(Date.now() + SESSION_DAYS * 86_400_000).toISOString();
  await db.run(
    "INSERT INTO sessions (session_id, tenant_id, user_id, token_hash, created_at, expires_at, revoked_at) VALUES (?, ?, ?, ?, ?, ?, NULL)",
    [newId("ses"), tenantId, userId, hashToken(token), createdAt, expiresAt],
  );
  return { token, expiresAt };
}

export class AuthError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AuthError";
  }
}

export async function login(db: Database, email: string, password: string) {
  const row = await db.get<{
    user_id: string;
    tenant_id: string;
    role: Role;
    password_hash: string;
    password_salt: string;
    status: string;
  }>(
    "SELECT user_id, tenant_id, role, password_hash, password_salt, status FROM users WHERE email = ?",
    [email.trim().toLowerCase()],
  );

  // Same error for unknown user and wrong password: do not leak which emails exist.
  if (!row) throw new AuthError("Invalid email or password");
  if (!verifyPassword(password, row.password_hash, row.password_salt)) {
    throw new AuthError("Invalid email or password");
  }
  if (row.status !== "active") throw new AuthError("This account is not active");

  const session = await createSession(db, row.tenant_id, row.user_id);
  await writeAudit(new TenantScope(db, row.tenant_id), {
    userId: row.user_id,
    entityType: "user",
    entityId: row.user_id,
    action: "login",
  });
  return { token: session.token, expiresAt: session.expiresAt, tenantId: row.tenant_id, userId: row.user_id, role: row.role };
}

/** Resolve a bearer token to an actor. Expired and revoked sessions are rejected. */
export async function authenticate(db: Database, token: string): Promise<Actor> {
  const row = await db.get<{ tenant_id: string; user_id: string; expires_at: string; revoked_at: string | null }>(
    "SELECT tenant_id, user_id, expires_at, revoked_at FROM sessions WHERE token_hash = ?",
    [hashToken(token)],
  );

  if (!row) throw new AuthError("Unknown session");
  if (row.revoked_at) throw new AuthError("Session revoked");
  if (row.expires_at <= nowIso()) throw new AuthError("Session expired");

  const user = await db.get<{ role: Role; status: string }>(
    "SELECT role, status FROM users WHERE user_id = ? AND tenant_id = ?",
    [row.user_id, row.tenant_id],
  );
  if (!user || user.status !== "active") throw new AuthError("Account is not active");

  return { scope: new TenantScope(db, row.tenant_id), userId: row.user_id, role: user.role };
}

export async function logout(db: Database, token: string): Promise<void> {
  await db.run("UPDATE sessions SET revoked_at = ? WHERE token_hash = ? AND revoked_at IS NULL", [nowIso(), hashToken(token)]);
}

/** Owner-only: add a staff account. Enforces the plan's staff allowance. */
export async function addStaff(
  db: Database,
  actor: Actor,
  input: { name: string; email: string; password: string; role: Exclude<Role, "owner">; branchId?: string | null },
): Promise<string> {
  assertCan(actor.role, "users");
  await assertWithinPlan(actor.scope, "staff");

  const userId = newId("usr");
  const { hash, salt } = hashPassword(input.password);
  await actor.scope.insert("users", {
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
  await writeAudit(actor.scope, {
    userId: actor.userId,
    entityType: "user",
    entityId: userId,
    action: "create",
    after: { name: input.name, role: input.role },
  });
  return userId;
}
