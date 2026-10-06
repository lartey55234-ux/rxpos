import { test } from "node:test";
import assert from "node:assert/strict";
import { freshTestDatabase, newPharmacy } from "../src/testing.ts";
import { AuthError, addStaff, authenticate, hashPassword, login, logout, recoverOwnerWithCode, regenerateRecoveryCodes, registerPharmacy, resetStaffPassword, verifyPassword } from "../src/auth.ts";
import { PlanLimitError } from "../src/plans.ts";
import { PermissionError, assertCan } from "../src/permissions.ts";

test("passwords are salted and verified, never stored in the clear", () => {
  const { hash, salt } = hashPassword("secret123");
  assert.notEqual(hash, "secret123");
  assert.equal(verifyPassword("secret123", hash, salt), true);
  assert.equal(verifyPassword("wrong", hash, salt), false);
});

test("two users with the same password get different hashes", () => {
  const first = hashPassword("secret123");
  const second = hashPassword("secret123");
  assert.notEqual(first.hash, second.hash);
  assert.notEqual(first.salt, second.salt);
});

test("registering a pharmacy creates tenant, branch, owner and a working session", async () => {
  const fixture = await newPharmacy("starter", "acme");
  const tenant = await fixture.owner.scope.tenant<{ name: string; plan_id: string }>();
  assert.equal(tenant.plan_id, "starter");
  const branches = await fixture.owner.scope.all("SELECT * FROM branches WHERE tenant_id = {{tenant}}");
  assert.equal(branches.length, 1);
  assert.equal(fixture.owner.role, "owner");
});

test("login rejects a wrong password with the same message as an unknown email", async () => {
  const fixture = await newPharmacy();
  await assert.rejects(() => login(fixture.db, fixture.email, "nope"), (err: Error) => {
    assert.ok(err instanceof AuthError);
    assert.equal(err.message, "Invalid email or password");
    return true;
  });
  await assert.rejects(() => login(fixture.db, "ghost@example.com", "secret123"), /Invalid email or password/);
});

test("an unknown or revoked session cannot be used", async () => {
  const fixture = await newPharmacy();
  await assert.rejects(() => authenticate(fixture.db, "not-a-real-token"), /Unknown session/);
  await logout(fixture.db, fixture.token);
  await assert.rejects(() => authenticate(fixture.db, fixture.token), /Session revoked/);
});

test("the free plan cannot add staff, and starter stops at two", async () => {
  const free = await newPharmacy("free", "freebie");
  await assert.rejects(
    () => addStaff(free.db, free.owner, { name: "Ama", email: "ama@example.com", password: "pw123456", role: "salesperson" }),
    (err: Error) => err instanceof PlanLimitError && /Free allows 0 staff/.test(err.message),
  );

  const starter = await newPharmacy("starter", "growing");
  await addStaff(starter.db, starter.owner, { name: "Ama", email: "ama2@example.com", password: "pw123456", role: "salesperson" });
  await addStaff(starter.db, starter.owner, { name: "Kofi", email: "kofi@example.com", password: "pw123456", role: "admin" });
  await assert.rejects(
    () => addStaff(starter.db, starter.owner, { name: "Yaw", email: "yaw@example.com", password: "pw123456", role: "salesperson" }),
    /Starter allows 2 staff/,
  );
});

test("role matrix: asset values are owner-only", () => {
  assert.equal(assertCan("owner", "assets"), undefined);
  assert.throws(() => assertCan("admin", "assets"), PermissionError);
  assert.throws(() => assertCan("salesperson", "assets"), PermissionError);
  assert.throws(() => assertCan("salesperson", "stock"), PermissionError);
  assert.equal(assertCan("salesperson", "sell"), undefined);
});

test("a registered pharmacy can log in with the owner email", async () => {
  const db = await freshTestDatabase();
  const reg = await registerPharmacy(db, {
    pharmacyName: "Login Test",
    ownerName: "Owner",
    email: "login@example.com",
    password: "secret123",
    planId: "pro",
  });
  const session = await login(db, "LOGIN@example.com", "secret123");
  assert.equal(session.tenantId, reg.tenantId);
  assert.equal(session.role, "owner");
});


test("registration creates owner recovery codes that are stored only as hashes and work once", async () => {
  const db = await freshTestDatabase();
  const reg = await registerPharmacy(db, {
    pharmacyName: "Recovery Pharmacy",
    ownerName: "Owner",
    email: "recover@example.com",
    password: "original123",
    planId: "pro",
  });
  assert.equal(reg.recoveryCodes.length, 10);
  assert.equal(new Set(reg.recoveryCodes).size, 10);
  const rows = await db.all<{ code_hash: string }>("SELECT code_hash FROM owner_recovery_codes WHERE user_id = ?", [reg.userId]);
  assert.equal(rows.length, 10);
  assert.ok(rows.every((row) => /^[0-9a-f]{64}$/.test(row.code_hash)));
  assert.ok(rows.every((row) => !reg.recoveryCodes.includes(row.code_hash)));

  const oldSession = await login(db, "recover@example.com", "original123");
  await recoverOwnerWithCode(db, "RECOVER@example.com", reg.recoveryCodes[0].toLowerCase(), "recovered123");
  await assert.rejects(() => login(db, "recover@example.com", "original123"), /Invalid email or password/);
  await assert.rejects(() => authenticate(db, oldSession.token), /revoked/);
  assert.equal((await login(db, "recover@example.com", "recovered123")).role, "owner");
  await assert.rejects(
    () => recoverOwnerWithCode(db, "recover@example.com", reg.recoveryCodes[0], "another123"),
    /not valid/,
  );
});

test("owner can replace recovery codes only after proving the current password", async () => {
  const f = await newPharmacy("pro", "codes");
  await assert.rejects(() => regenerateRecoveryCodes(f.db, f.owner, "wrong"), /not correct/);
  const codes = await regenerateRecoveryCodes(f.db, f.owner, "secret123");
  assert.equal(codes.length, 10);
  const rows = await f.owner.scope.all("SELECT * FROM owner_recovery_codes WHERE tenant_id = {{tenant}} AND user_id = ?", f.owner.userId);
  assert.equal(rows.length, 10);
});

test("owner resets staff password and every old staff session is revoked", async () => {
  const f = await newPharmacy("pro", "staffreset");
  const staffId = await addStaff(f.db, f.owner, {
    name: "Ama",
    email: "ama.reset@example.com",
    password: "oldpassword",
    role: "salesperson",
  });
  const staffSession = await login(f.db, "ama.reset@example.com", "oldpassword");
  await resetStaffPassword(f.db, f.owner, staffId, "newpassword");
  await assert.rejects(() => login(f.db, "ama.reset@example.com", "oldpassword"), /Invalid email or password/);
  await assert.rejects(() => authenticate(f.db, staffSession.token), /revoked/);
  assert.equal((await login(f.db, "ama.reset@example.com", "newpassword")).role, "salesperson");
  await assert.rejects(() => resetStaffPassword(f.db, f.owner, f.owner.userId, "newpassword"), /staff account/);
});
