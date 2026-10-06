/**
 * Where a fault goes.
 *
 * The point is that a fault at a pharmacy stops being only a phone call, and that
 * recording one never leaks the thing that caused it — a sign-in body holds a
 * password, and an error report is not worth leaking one for.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import type { Server } from "node:http";
import { randomBytes } from "node:crypto";
import { freshTestDatabase } from "../src/testing.ts";
import { startServer } from "../src/server.ts";
import { authenticate, login, registerPharmacy } from "../src/auth.ts";
import { errorSummary, fingerprintOf, listErrors, recordError } from "../src/errors.ts";

const db = await freshTestDatabase();
const server: Server = await startServer(db, 0, undefined, "127.0.0.1", { signupLimit: 1000 });
const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
test.after(() => server.close());

const runId = randomBytes(4).toString("hex");
let counter = 0;

async function pharmacy() {
  counter += 1;
  const email = `errors${counter}.${runId}@example.com`;
  const reg = await registerPharmacy(db, {
    pharmacyName: `Errors ${counter}`,
    ownerName: "Emmanuel Lartey",
    email,
    password: "secret123",
    planId: "pro",
  });
  return { email, token: reg.token, owner: await authenticate(db, reg.token), tenantId: reg.tenantId };
}

test("two occurrences of one fault are one row with a count", async () => {
  await db.run("DELETE FROM error_reports");

  const fault = (batch: string) => ({
    source: "server" as const,
    message: `Unknown batch ${batch}`,
    stack: "Error: Unknown batch\n    at receiveBatch (catalog.ts:150:11)",
    path: `/api/batches/${batch}`,
  });

  await recordError(db, fault("bat_9f3e2c1a-4b5d"));
  await recordError(db, fault("bat_2c1f9e8d-7a6b"));
  await recordError(db, fault("bat_7a1b3c5d-9e2f"));

  const rows = await listErrors(db);
  assert.equal(rows.length, 1, "a loop that fails three times is one line to read");
  assert.equal(rows[0].count, 3);
  assert.match(rows[0].message, /bat_7a1b3c5d/, "the message is kept verbatim, not normalised");
});

test("a genuinely different fault is a separate row", async () => {
  await recordError(db, {
    source: "server",
    message: "Stock changed while selling Paracetamol",
    stack: "Error: Stock changed\n    at createSale (sales.ts:132:15)",
    path: "POST /api/sales",
  });
  const rows = await listErrors(db);
  assert.equal(rows.length, 2);
  assert.ok(rows.some((row) => /Stock changed/.test(row.message)));
});

test("the browser can report a fault, and it is attributed when signed in", async () => {
  const shop = await pharmacy();
  await db.run("DELETE FROM error_reports");

  const res = await fetch(`${base}/api/errors`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${shop.token}` },
    body: JSON.stringify({
      message: "Cannot read properties of undefined (reading 'sellable')",
      stack: "TypeError: Cannot read properties of undefined\n    at renderCart (app.js:420:18)",
      path: "/counter",
    }),
  });
  assert.equal(res.status, 202);

  const rows = await listErrors(db);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].source, "client");
  assert.equal(rows[0].tenant_id, shop.tenantId, "attributed to the pharmacy that hit it");
  assert.match(rows[0].stack ?? "", /renderCart/);
});

test("a fault on the sign-in screen is still recorded, with nobody signed in", async () => {
  await db.run("DELETE FROM error_reports");
  const res = await fetch(`${base}/api/errors`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ message: "Something broke before anyone signed in", path: "/" }),
  });
  assert.equal(res.status, 202, "which is exactly when you would want to hear about it");
  const rows = await listErrors(db);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].tenant_id, null);
});

test("a password never ends up in an error report", async () => {
  const shop = await pharmacy();
  await db.run("DELETE FROM error_reports");

  // A request that fails, carrying a password in its body.
  await fetch(`${base}/api/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email: shop.email, password: "secret123" }),
  });

  // And one that the server cannot handle, carrying one too.
  await fetch(`${base}/api/batches`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${shop.token}` },
    body: JSON.stringify({
      branchId: "br_nope",
      productId: "prd_nope",
      batchNumber: "X",
      quantity: "not-a-number",
      password: "secret123",
    }),
  });

  const rows = await db.all<{ message: string; stack: string | null; context_json: string | null }>(
    "SELECT message, stack, context_json FROM error_reports",
  );
  const everything = JSON.stringify(rows);
  assert.ok(!everything.includes("secret123"), `a password was recorded: ${everything.slice(0, 300)}`);
});

test("a server fault is recorded without anyone having to report it", async () => {
  const shop = await pharmacy();
  await db.run("DELETE FROM error_reports");

  const res = await fetch(`${base}/api/batches`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${shop.token}` },
    body: JSON.stringify({ branchId: "br_nope", productId: "prd_nope", batchNumber: "X", quantity: "not-a-number" }),
  });
  assert.equal(res.status, 500, "the request failed in a way the code did not expect");

  const rows = await listErrors(db);
  assert.equal(rows.length, 1, "and the server wrote it down on its own");
  assert.equal(rows[0].source, "server");
  assert.match(rows[0].path ?? "", /POST \/api\/batches/);
});

test("only the owner may read or clear them", async () => {
  const shop = await pharmacy();
  const signIn = await login(db, shop.email, "secret123");
  assert.ok(signIn.token);

  const ownerRead = await fetch(`${base}/api/errors`, { headers: { authorization: `Bearer ${shop.token}` } });
  assert.equal(ownerRead.status, 200);
  const body = (await ownerRead.json()) as { errors: unknown[]; summary: { faults: number } };
  assert.ok(Array.isArray(body.errors));
  assert.ok(typeof body.summary.faults === "number");

  // an administrator is not the owner, and a stack trace can name a patient
  const { addStaff } = await import("../src/auth.ts");
  await addStaff(db, shop.owner, {
    name: "Admin",
    email: `admin.${runId}@example.com`,
    password: "pw123456",
    role: "admin",
  });
  const admin = await login(db, `admin.${runId}@example.com`, "pw123456");
  const adminRead = await fetch(`${base}/api/errors`, { headers: { authorization: `Bearer ${admin.token}` } });
  assert.equal(adminRead.status, 403);

  const anonymous = await fetch(`${base}/api/errors`);
  assert.equal(anonymous.status, 401);
});

test("the summary counts the last day", async () => {
  await db.run("DELETE FROM error_reports");
  await recordError(db, { source: "server", message: "One", path: "/a" });
  await recordError(db, { source: "server", message: "One", path: "/a" });
  await recordError(db, { source: "client", message: "Two", path: "/b" });

  const summary = await errorSummary(db);
  assert.equal(summary.faults, 2, "two distinct faults");
  assert.equal(summary.occurrences, 3, "that happened three times between them");
});

test("an old fault is pruned rather than kept for ever", async () => {
  await db.run("DELETE FROM error_reports");
  await db.run(
    "INSERT INTO error_reports (report_id, fingerprint, source, message, count, first_seen_at, last_seen_at) VALUES (?, ?, ?, ?, 1, ?, ?)",
    ["err_old", "old-fingerprint", "server", "Ancient history", "2020-01-01T00:00:00.000Z", "2020-01-01T00:00:00.000Z"],
  );
  await recordError(db, { source: "server", message: "Something recent", path: "/now" });

  const rows = await listErrors(db);
  assert.equal(rows.length, 1, "the old one is gone");
  assert.match(rows[0].message, /recent/);
});

test("fingerprints are stable and do not collide across sources", () => {
  const base = { message: "boom", stack: "Error: boom\n    at x (a.ts:1:1)", path: "/api/things" };
  assert.equal(fingerprintOf({ source: "server", ...base }), fingerprintOf({ source: "server", ...base }));
  assert.notEqual(fingerprintOf({ source: "server", ...base }), fingerprintOf({ source: "client", ...base }));
});
