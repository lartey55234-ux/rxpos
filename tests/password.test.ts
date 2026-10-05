/**
 * Getting back in. The parts that matter are not that a link arrives, but that it
 * arrives once, expires, cannot be replayed, and throws out anyone who was signed
 * in with the password it replaces.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import type { Server } from "node:http";
import { randomBytes } from "node:crypto";
import { freshTestDatabase, seedBatch, seedProduct } from "../src/testing.ts";
import { startServer } from "../src/server.ts";
import { authenticate, login, registerPharmacy } from "../src/auth.ts";
import { checkResetToken, requestPasswordReset, resetPassword, RESET_MINUTES } from "../src/password.ts";
import { RecordingMailer } from "../src/mail.ts";
import { todayIso, addDays } from "../src/util.ts";

const PUBLIC_URL = "https://rxpos.example";
const db = await freshTestDatabase();
const mailer = new RecordingMailer();
const server: Server = await startServer(db, 0, undefined, "127.0.0.1", {
  signupLimit: 1000,
  loginLimit: 1000,
  mailer,
  publicUrl: PUBLIC_URL,
});
const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
test.after(() => server.close());

const runId = randomBytes(4).toString("hex");
let counter = 0;

async function pharmacy() {
  counter += 1;
  const email = `owner${counter}.${runId}@example.com`;
  const reg = await registerPharmacy(db, {
    pharmacyName: `Reset ${counter}`,
    ownerName: "Emmanuel Lartey",
    email,
    password: "original123",
    planId: "pro",
  });
  const owner = await authenticate(db, reg.token);
  const product = await seedProduct(owner, { name: "Paracetamol", pricePesewas: 500 });
  await seedBatch(owner, reg.branchId, product, { batchNumber: "P1", expiryDate: addDays(todayIso(), 200), quantity: 10 });
  return { email, token: reg.token, owner, branchId: reg.branchId, tenantId: reg.tenantId };
}

test("a reset link is sent, and it works once", async () => {
  const shop = await pharmacy();
  await requestPasswordReset(db, mailer, PUBLIC_URL, shop.email);

  assert.equal(mailer.sent.length, 1, "one message");
  const message = mailer.sent[0];
  assert.equal(message.to, shop.email);
  assert.match(message.text, /Reset 1|rxpos/, "the email says what it is about");
  assert.match(message.text, new RegExp(`${RESET_MINUTES} minutes`), "and how long the link lasts");
  assert.match(mailer.lastLink(), new RegExp(`^${PUBLIC_URL}/\\?reset=`), "the link points at the app");

  const token = mailer.tokenFromLastLink();
  assert.ok((await checkResetToken(db, token)).valid, "the link is good");

  const result = await resetPassword(db, token, "brandnew123");
  assert.equal(result.email, shop.email);

  // the old password is gone and the new one works
  await assert.rejects(() => login(db, shop.email, "original123"), /Invalid email or password/);
  const session = await login(db, shop.email, "brandnew123");
  assert.equal(session.role, "owner");

  // and the link cannot be used twice
  await assert.rejects(() => resetPassword(db, token, "another123"), /already been used/);
  assert.equal((await checkResetToken(db, token)).valid, false);
});

test("the token is not stored in a form that could be used directly", async () => {
  const shop = await pharmacy();
  await requestPasswordReset(db, mailer, PUBLIC_URL, shop.email);
  const token = mailer.tokenFromLastLink();

  const row = await db.get<{ token_hash: string }>(
    "SELECT token_hash FROM password_resets WHERE tenant_id = ? ORDER BY created_at DESC",
    [shop.tenantId],
  );
  assert.ok(row, "a reset row was written");
  assert.notEqual(row.token_hash, token, "the token itself is not in the database");
  assert.match(row.token_hash, /^[0-9a-f]{64}$/, "a hash is");
});

test("asking again invalidates the link already in the inbox", async () => {
  const shop = await pharmacy();
  await requestPasswordReset(db, mailer, PUBLIC_URL, shop.email);
  const first = mailer.tokenFromLastLink();

  await requestPasswordReset(db, mailer, PUBLIC_URL, shop.email);
  const second = mailer.tokenFromLastLink();
  assert.notEqual(second, first);

  await assert.rejects(() => resetPassword(db, first, "brandnew123"), /already been used/);
  await resetPassword(db, second, "brandnew123");
  const session = await login(db, shop.email, "brandnew123");
  assert.ok(session.token);
});

test("an expired link is refused", async () => {
  const shop = await pharmacy();
  await requestPasswordReset(db, mailer, PUBLIC_URL, shop.email);
  const token = mailer.tokenFromLastLink();

  await db.run("UPDATE password_resets SET expires_at = ? WHERE tenant_id = ?", [
    new Date(Date.now() - 60_000).toISOString(),
    shop.tenantId,
  ]);

  await assert.rejects(() => resetPassword(db, token, "brandnew123"), /expired/);
});

test("resetting throws out whoever was signed in with the old password", async () => {
  const shop = await pharmacy();

  // a session that exists because somebody knew the old password
  const elsewhere = await login(db, shop.email, "original123");
  assert.ok(await authenticate(db, elsewhere.token), "the other session works before the reset");

  await requestPasswordReset(db, mailer, PUBLIC_URL, shop.email);
  await resetPassword(db, mailer.tokenFromLastLink(), "brandnew123");

  await assert.rejects(
    () => authenticate(db, elsewhere.token),
    /revoked/,
    "a password reset must end every session that used the old one",
  );
});

test("an unknown address is answered the same way, and nothing is sent", async () => {
  const before = mailer.sent.length;
  const res = await fetch(`${base}/api/password/forgot`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email: "nobody@example.com" }),
  });
  assert.equal(res.status, 200, "the same answer as a real account");
  const body = (await res.json()) as { message: string };
  assert.match(body.message, /If that address has an account/);
  assert.equal(mailer.sent.length, before, "and no message is sent");
});

test("a short password is refused, and the link survives the attempt", async () => {
  const shop = await pharmacy();
  await requestPasswordReset(db, mailer, PUBLIC_URL, shop.email);
  const token = mailer.tokenFromLastLink();

  await assert.rejects(() => resetPassword(db, token, "short"), /at least 8 characters/);
  assert.equal((await checkResetToken(db, token)).valid, true, "the link is still good");
  await resetPassword(db, token, "longenough123");
});

test("a made-up token is refused", async () => {
  await assert.rejects(() => resetPassword(db, "not-a-real-token-at-all", "brandnew123"), /not valid/);
  await assert.rejects(() => resetPassword(db, "", "brandnew123"), /not valid/);
});

test("the whole thing over HTTP", async () => {
  const shop = await pharmacy();
  const before = mailer.sent.length;

  const asked = await fetch(`${base}/api/password/forgot`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email: shop.email }),
  });
  assert.equal(asked.status, 200);
  assert.equal(mailer.sent.length, before + 1, "the message went out");

  const token = mailer.tokenFromLastLink();
  const checked = await fetch(`${base}/api/password/reset?token=${encodeURIComponent(token)}`);
  assert.deepEqual(await checked.json(), { valid: true, reason: null });

  const done = await fetch(`${base}/api/password/reset`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ token, password: "overhttp123" }),
  });
  assert.equal(done.status, 200);

  const signedIn = await fetch(`${base}/api/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email: shop.email, password: "overhttp123" }),
  });
  assert.equal(signedIn.status, 200);

  const spent = await fetch(`${base}/api/password/reset?token=${encodeURIComponent(token)}`);
  assert.equal(((await spent.json()) as { valid: boolean }).valid, false, "and the link is spent");
});
