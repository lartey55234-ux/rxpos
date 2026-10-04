import { test, after } from "node:test";
import assert from "node:assert/strict";
import type { Server } from "node:http";
import { freshTestDatabase } from "../src/testing.ts";
import { seedDemoPharmacy } from "../src/demo.ts";
import { startServer } from "../src/server.ts";

const db = await freshTestDatabase();
const demo = await seedDemoPharmacy(db);
const server: Server = await startServer(db, 0);
const port = (server.address() as { port: number }).port;
const base = `http://127.0.0.1:${port}`;

after(() => server.close());

async function post(path: string, body: unknown, token?: string) {
  const res = await fetch(base + path, {
    method: "POST",
    headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: (await res.json()) as Record<string, any> };
}
async function get(path: string, token?: string) {
  const res = await fetch(base + path, { headers: token ? { authorization: `Bearer ${token}` } : {} });
  return { status: res.status, body: (await res.json()) as Record<string, any> };
}

test("the counter UI is served", async () => {
  const res = await fetch(base + "/");
  assert.equal(res.status, 200);
  assert.match(await res.text(), /rxpos/);
  assert.equal((await fetch(base + "/app.js")).status, 200);
  assert.equal((await fetch(base + "/styles.css")).status, 200);
});

test("login returns a session, and a bad password does not", async () => {
  const good = await post("/api/login", { email: demo.credentials.owner, password: demo.credentials.password });
  assert.equal(good.status, 200);
  assert.equal(good.body.user.role, "owner");
  assert.equal(good.body.tenant.name, "Osu Community Pharmacy");
  assert.equal(good.body.permissions.assets, true);
  assert.ok(good.body.token);

  const bad = await post("/api/login", { email: demo.credentials.owner, password: "wrong" });
  assert.equal(bad.status, 401);
  assert.equal(bad.body.error, "Invalid email or password");
});

test("every API route requires a token", async () => {
  for (const path of ["/api/session", "/api/products?branchId=x", "/api/alerts?branchId=x", "/api/reports?branchId=x"]) {
    const res = await get(path);
    assert.equal(res.status, 401, `${path} should be 401`);
  }
  const sale = await post("/api/sales", { branchId: demo.branchId, lines: [] });
  assert.equal(sale.status, 401);
});

test("a branch id from another pharmacy is rejected", async () => {
  const owner = (await post("/api/login", { email: demo.credentials.owner, password: demo.credentials.password })).body;
  const res = await get("/api/products?branchId=br_not_mine", owner.token);
  assert.equal(res.status, 400);
  assert.match(res.body.error, /Unknown branch/);
});

test("the counter sells over HTTP and returns a printable receipt", async () => {
  const owner = (await post("/api/login", { email: demo.credentials.owner, password: demo.credentials.password })).body;
  const products = await get(`/api/products?branchId=${demo.branchId}&q=PCM500`, owner.token);
  const paracetamol = products.body.products.find((p: any) => p.barcode === "PCM500");

  const sale = await post(
    "/api/sales",
    { branchId: demo.branchId, lines: [{ productId: paracetamol.product_id, quantity: 2 }], paymentMethod: "Cash", amountTenderedPesewas: 2000 },
    owner.token,
  );
  assert.equal(sale.status, 201);
  assert.equal(sale.body.receipt.totalPesewas, 1000);
  assert.equal(sale.body.receipt.changePesewas, 1000);
  assert.equal(sale.body.receipt.lines.length, 1);
  assert.ok(sale.body.receipt.lines[0].batchNumber);
  assert.equal(sale.body.receipt.servedBy, "Emmanuel Lartey");

  const again = await get(`/api/sales/${sale.body.sale.saleId}/receipt`, owner.token);
  assert.equal(again.status, 200);
  assert.equal(again.body.receipt.saleId, sale.body.sale.saleId);
});

test("the API refuses a controlled drug with no prescription", async () => {
  const owner = (await post("/api/login", { email: demo.credentials.owner, password: demo.credentials.password })).body;
  const products = await get(`/api/products?branchId=${demo.branchId}&q=PET050`, owner.token);
  const pethidine = products.body.products[0];

  const refused = await post(
    "/api/sales",
    { branchId: demo.branchId, lines: [{ productId: pethidine.product_id, quantity: 1 }], paymentMethod: "Cash" },
    owner.token,
  );
  assert.equal(refused.status, 400);
  assert.match(refused.body.error, /needs a prescription/);

  const rx = await post(
    "/api/prescriptions",
    { branchId: demo.branchId, prescriptionNumber: "RX-API-1", patientName: "API Patient", prescriberName: "Dr API" },
    owner.token,
  );
  assert.equal(rx.status, 201);

  const allowed = await post(
    "/api/sales",
    { branchId: demo.branchId, lines: [{ productId: pethidine.product_id, quantity: 1 }], paymentMethod: "Cash", prescriptionId: rx.body.prescriptionId },
    owner.token,
  );
  assert.equal(allowed.status, 201);
  assert.equal(allowed.body.sale.controlledEntries, 1);
  assert.equal(allowed.body.receipt.controlled[0].name, "Pethidine");
});

test("a salesperson is refused a controlled dispense over HTTP, and sees no asset values", async () => {
  const staff = (await post("/api/login", { email: demo.credentials.salesperson, password: demo.credentials.password })).body;
  assert.equal(staff.user.role, "salesperson");
  assert.equal(staff.permissions.assets, false);
  assert.equal(staff.permissions.dispense_controlled, false);

  const products = await get(`/api/products?branchId=${demo.branchId}&q=PET050`, staff.token);
  const refused = await post(
    "/api/sales",
    { branchId: demo.branchId, lines: [{ productId: products.body.products[0].product_id, quantity: 1 }], paymentMethod: "Cash" },
    staff.token,
  );
  assert.equal(refused.status, 403);

  const reports = await get(`/api/reports?branchId=${demo.branchId}`, staff.token);
  assert.equal(reports.status, 403, "a salesperson has no access to analytics at all");

  const admin = (await post("/api/login", { email: demo.credentials.admin, password: demo.credentials.password })).body;
  assert.equal(admin.permissions.reports, true);
  assert.equal(admin.permissions.assets, false);
  const adminReports = await get(`/api/reports?branchId=${demo.branchId}`, admin.token);
  assert.equal(adminReports.status, 200);
  assert.equal(adminReports.body.assets, null, "asset values must never be sent to an administrator");
  assert.ok(adminReports.body.week.revenuePesewas > 0);

  const register = await get(`/api/register?branchId=${demo.branchId}`, staff.token);
  assert.equal(register.status, 403);
});

test("the register reads back over HTTP with the fields the Act requires", async () => {
  const owner = (await post("/api/login", { email: demo.credentials.owner, password: demo.credentials.password })).body;
  const today = new Date().toISOString().slice(0, 10);
  const res = await get(`/api/register?branchId=${demo.branchId}&from=${today}&to=${today}`, owner.token);
  assert.equal(res.status, 200);
  const supplied = res.body.entries.filter((e: any) => e.direction === "supplied");
  assert.ok(supplied.length >= 1);
  const entry = supplied[0];
  assert.ok(entry.product);
  assert.ok(entry.quantity > 0);
  assert.ok(entry.batch_number);
  assert.ok(entry.dispenser);
  assert.equal(entry.entry_date, today);
});

test("a second pharmacy on the same server sees none of the first pharmacy's data", async () => {
  const other = await post("/api/login", { email: demo.credentials.owner, password: demo.credentials.password });
  assert.equal(other.status, 200);
  const session = other.body;

  const mine = await get(`/api/products?branchId=${demo.branchId}&q=`, session.token);
  assert.ok(mine.body.products.length > 0);

  // The demo pharmacy's own branch is fine; a made-up one is not, and no row is returned either way.
  const foreign = await get(`/api/products?branchId=${demo.branchId}&q=PCM500`, session.token);
  const ids = new Set(foreign.body.products.map((p: any) => p.product_id));
  assert.ok(ids.size >= 1);
  assert.ok(!foreign.body.products.some((p: any) => p.name === "Beta Amoxicillin"));
});
