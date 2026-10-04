/**
 * What a deployed instance has to get right: answer a health check, let a
 * pharmacy open its own account, and refuse the obvious abuse.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import type { Server } from "node:http";
import { freshTestDatabase } from "../src/testing.ts";
import { startServer } from "../src/server.ts";
import { RateLimitError, RateLimiter } from "../src/ratelimit.ts";

const db = await freshTestDatabase();
// Generous limits here: the rate limiter gets its own test below.
const server: Server = await startServer(db, 0, undefined, "127.0.0.1", { loginLimit: 100, signupLimit: 100 });
const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;

test.after(() => {
  server.close();
});

const post = (path: string, body: unknown): Promise<Response> =>
  fetch(`${base}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });

const registration = {
  pharmacyName: "Adenta Community Pharmacy",
  ownerName: "Nana Adjei",
  email: "Nana@Adenta.example",
  password: "goodpassword",
  planId: "standard",
  branchName: "Adenta Main",
};

test("the health check answers without a token", async () => {
  const res = await fetch(`${base}/healthz`);
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { status: "ok" });
});

test("every response carries the security headers", async () => {
  const res = await fetch(`${base}/healthz`);
  assert.equal(res.headers.get("x-content-type-options"), "nosniff");
  assert.equal(res.headers.get("x-frame-options"), "DENY");
  assert.match(res.headers.get("content-security-policy") ?? "", /default-src 'self'/);
});

test("a pharmacy can open its own account and lands signed in", async () => {
  const res = await post("/api/signup", registration);
  assert.equal(res.status, 201);
  const body = (await res.json()) as Record<string, never>;
  assert.ok(body.token);
  assert.equal((body.tenant as { name: string }).name, "Adenta Community Pharmacy");
  assert.equal((body.tenant as { plan: { id: string } }).plan.id, "standard");
  assert.equal((body.user as { role: string }).role, "owner");
  assert.equal((body.branches as unknown[]).length, 1);
  assert.equal((body.permissions as Record<string, boolean>).assets, true);
});

test("the email is stored lower-cased, so sign-in is forgiving", async () => {
  const res = await post("/api/login", { email: "NANA@adenta.example", password: "goodpassword" });
  assert.equal(res.status, 200);
  const body = (await res.json()) as { tenant: { name: string } };
  assert.equal(body.tenant.name, "Adenta Community Pharmacy");
});

test("a second pharmacy cannot reuse an email", async () => {
  const res = await post("/api/signup", { ...registration, pharmacyName: "Copycat Pharmacy" });
  assert.equal(res.status, 409);
  assert.match(((await res.json()) as { error: string }).error, /already has an account/);
});

test("registration refuses a short password, a bad email and an unknown plan", async () => {
  const weak = await post("/api/signup", { ...registration, email: "a@b.example", password: "short" });
  assert.equal(weak.status, 400);
  assert.match(((await weak.json()) as { error: string }).error, /8 characters/);

  const badEmail = await post("/api/signup", { ...registration, email: "not-an-email" });
  assert.equal(badEmail.status, 400);

  const badPlan = await post("/api/signup", { ...registration, email: "c@d.example", planId: "enterprise" });
  assert.equal(badPlan.status, 400);
  assert.match(((await badPlan.json()) as { error: string }).error, /Unknown plan/);
});

test("a pharmacy that registers arrives empty, not sharing anyone's stock", async () => {
  const res = await post("/api/signup", {
    ...registration,
    pharmacyName: "Kaneshie Pharmacy",
    email: "owner@kaneshie.example",
  });
  const { token } = (await res.json()) as { token: string };
  const products = await fetch(`${base}/api/products?branchId=`, {
    headers: { authorization: `Bearer ${token}` },
  });
  assert.equal(products.status, 400); // no branch id given
  const session = await fetch(`${base}/api/session`, { headers: { authorization: `Bearer ${token}` } });
  const body = (await session.json()) as { branches: { branch_id: string }[] };
  const listed = await fetch(`${base}/api/products?branchId=${body.branches[0].branch_id}`, {
    headers: { authorization: `Bearer ${token}` },
  });
  assert.deepEqual(((await listed.json()) as { products: unknown[] }).products, []);
});

test("a body that is not JSON is a 400, not a crash", async () => {
  const res = await fetch(`${base}/api/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: "{ not json",
  });
  assert.equal(res.status, 400);
  assert.match(((await res.json()) as { error: string }).error, /not valid JSON/);
});

test("the limiter stops a burst and then lets the window roll over", () => {
  const limiter = new RateLimiter(3, 1000);
  const start = Date.now();
  limiter.hit("1.2.3.4", start);
  limiter.hit("1.2.3.4", start);
  limiter.hit("1.2.3.4", start);
  assert.throws(() => limiter.hit("1.2.3.4", start), RateLimitError);
  limiter.hit("5.6.7.8", start); // another caller is unaffected
  limiter.hit("1.2.3.4", start + 5000); // and the window does roll over
});

test("signup is rate limited out of the box", async () => {
  const strict = await freshTestDatabase();
  const limited = await startServer(strict, 0, undefined, "127.0.0.1");
  const port = (limited.address() as { port: number }).port;
  try {
    let last = 0;
    for (let i = 0; i < 6; i += 1) {
      const res = await fetch(`http://127.0.0.1:${port}/api/signup`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ ...registration, email: `burst${i}@example.com` }),
      });
      last = res.status;
    }
    assert.equal(last, 429);
  } finally {
    limited.close();
  }
});
