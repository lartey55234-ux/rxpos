import { test } from "node:test";
import assert from "node:assert/strict";
import { freshTestDatabase, newPharmacy } from "../src/testing.ts";
import { AuthError, addStaff, authenticate, hashPassword, login, logout, registerPharmacy, verifyPassword } from "../src/auth.ts";
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
