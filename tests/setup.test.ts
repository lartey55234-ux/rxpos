/**
 * Setting a pharmacy up: the screens that turn an empty account into a working
 * one. Everything here goes through the HTTP API, because that is what the
 * counter actually calls.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import type { Server } from "node:http";
import { openMigratedDb } from "../src/db.ts";
import { startServer } from "../src/server.ts";

const db = openMigratedDb(":memory:");
const server: Server = await startServer(db, 0, undefined, "127.0.0.1", {
  loginLimit: 1000,
  signupLimit: 1000,
});
const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
test.after(() => server.close());

type Reply = { status: number; body: Record<string, never> & Record<string, any> };

async function call(path: string, method: string, body?: unknown, token?: string): Promise<Reply> {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: {
      "content-type": "application/json",
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return { status: res.status, body: (await res.json().catch(() => ({}))) as Reply["body"] };
}

const get = (p: string, t: string) => call(p, "GET", undefined, t);
const post = (p: string, b: unknown, t: string) => call(p, "POST", b, t);

let owner = "";
let branch = "";

test("a new pharmacy starts with nothing", async () => {
  const res = await call("/api/signup", "POST", {
    pharmacyName: "Setup Pharmacy",
    ownerName: "Ama Owusu",
    email: "ama@setup.example",
    password: "setup12345",
    planId: "standard",
  });
  assert.equal(res.status, 201);
  owner = res.body.token as unknown as string;
  branch = res.body.branches[0].branch_id as unknown as string;

  const products = await get(`/api/products?branchId=${branch}`, owner);
  assert.deepEqual(products.body.products, []);
});

test("the owner adds a supplier and a category", async () => {
  const supplier = await post("/api/suppliers", { name: "Ernest Chemists Ltd", phone: "+233 30 222 0000" }, owner);
  assert.equal(supplier.status, 201);

  const category = await post("/api/categories", { name: "Analgesics" }, owner);
  assert.equal(category.status, 201);

  const suppliers = await get("/api/suppliers", owner);
  assert.equal(suppliers.body.suppliers.length, 1);
  assert.equal(suppliers.body.suppliers[0].phone, "+233 30 222 0000");

  const categories = await get("/api/categories", owner);
  assert.equal(categories.body.categories.length, 1);
});

let productId = "";

test("the owner adds a product, and the cost price survives the round trip", async () => {
  const categories = await get("/api/categories", owner);
  const res = await post(
    "/api/products",
    {
      name: "Paracetamol",
      brand: "Kinapharma",
      form: "Tablets",
      strength: "500 mg",
      unit: "Blister of 10",
      barcode: "PCM500",
      pricePesewas: 500,
      costPricePesewas: 250,
      reorderLevel: 40,
      categoryId: categories.body.categories[0].category_id,
    },
    owner,
  );
  assert.equal(res.status, 201);
  productId = res.body.productId as unknown as string;

  const listed = await get(`/api/products?branchId=${branch}&q=para`, owner);
  const row = listed.body.products[0];
  assert.equal(row.name, "Paracetamol");
  assert.equal(row.brand, "Kinapharma");
  assert.equal(row.cost_price_pesewas, 250, "the old route silently dropped the cost price");
  assert.equal(row.on_hand, 0, "a catalogue entry with no batch has no stock");
});

test("a product with no batch cannot be sold, and receiving one fixes that", async () => {
  const empty = await post("/api/sales", { branchId: branch, lines: [{ productId, quantity: 1 }] }, owner);
  assert.equal(empty.status, 400);
  assert.match(empty.body.error, /sellable/i);

  const suppliers = await get("/api/suppliers", owner);
  const batch = await post(
    "/api/batches",
    {
      branchId: branch,
      productId,
      batchNumber: "PCM-26A",
      expiryDate: "2027-06-30",
      quantity: 240,
      supplierId: suppliers.body.suppliers[0].supplier_id,
    },
    owner,
  );
  assert.equal(batch.status, 201);

  const listed = await get(`/api/products?branchId=${branch}&q=para`, owner);
  assert.equal(listed.body.products[0].on_hand, 240);
  assert.equal(listed.body.products[0].sellable, 240);

  const sold = await post("/api/sales", { branchId: branch, lines: [{ productId, quantity: 4 }], paymentMethod: "Cash", amountTenderedPesewas: 5000 }, owner);
  assert.equal(sold.status, 201);

  const after = await get(`/api/products?branchId=${branch}&q=para`, owner);
  assert.equal(after.body.products[0].on_hand, 236);
});

test("the owner adds a branch, and the plan limit is enforced on the next one", async () => {
  const second = await post("/api/branches", { name: "Adabraka Branch", address: "Adabraka, Accra" }, owner);
  assert.equal(second.status, 201);
  assert.equal(second.body.branches.length, 2);

  const third = await post("/api/branches", { name: "Tema Branch" }, owner);
  assert.equal(third.status, 201);
  const fourth = await post("/api/branches", { name: "One Too Many" }, owner);
  assert.equal(fourth.status, 400, "standard allows three shops");
  assert.match(fourth.body.error, /Standard allows 3 shops/);
});

test("the owner adds a salesperson who can sign in and sell, but not set the pharmacy up", async () => {
  const created = await post(
    "/api/staff",
    { name: "Kofi Mensah", email: "kofi@setup.example", password: "kofi12345", role: "salesperson", branchId: branch },
    owner,
  );
  assert.equal(created.status, 201);

  const signIn = await call("/api/login", "POST", { email: "kofi@setup.example", password: "kofi12345" });
  assert.equal(signIn.status, 200);
  const staff = signIn.body.token as unknown as string;
  assert.equal(signIn.body.user.role, "salesperson");

  const sell = await post("/api/sales", { branchId: branch, lines: [{ productId, quantity: 1 }], paymentMethod: "Cash", amountTenderedPesewas: 500 }, staff);
  assert.equal(sell.status, 201, "a salesperson can sell");

  const visible = await get(`/api/products?branchId=${branch}&q=para`, staff);
  assert.equal(visible.body.products[0].name, "Paracetamol", "a salesperson still sees the catalogue");
  assert.equal(
    visible.body.products[0].cost_price_pesewas,
    undefined,
    "a salesperson must never see what the pharmacy paid",
  );

  const addProduct = await post("/api/products", { name: "Ibuprofen", pricePesewas: 900 }, staff);
  assert.equal(addProduct.status, 403, "a salesperson cannot add products");

  const receive = await post("/api/batches", { branchId: branch, productId, batchNumber: "X", quantity: 5 }, staff);
  assert.equal(receive.status, 403, "a salesperson cannot receive stock");

  const staffList = await get("/api/staff", staff);
  assert.equal(staffList.status, 403, "a salesperson cannot see staff accounts");
});

test("an owner cannot create a second owner", async () => {
  const res = await post("/api/staff", { name: "Sneaky", email: "sneaky@setup.example", password: "sneaky123", role: "owner" }, owner);
  assert.equal(res.status, 400);
  assert.match(res.body.error, /admin or salesperson/);
});

test("a batch can be written off, and the stock drops without the record vanishing", async () => {
  const before = await get(`/api/products?branchId=${branch}&q=para`, owner);
  assert.equal(before.body.products[0].on_hand, 235);

  const batches = await post("/api/batches", { branchId: branch, productId, batchNumber: "PCM-BAD", expiryDate: "2026-01-31", quantity: 10 }, owner);
  assert.equal(batches.status, 201);

  const written = await post(`/api/batches/${batches.body.batchId}/writeoff`, { note: "Damaged in transit" }, owner);
  assert.equal(written.status, 200);

  const after = await get(`/api/products?branchId=${branch}&q=para`, owner);
  assert.equal(after.body.products[0].on_hand, 235, "the written-off batch no longer counts");
});

test("the free plan stops at twenty products", async () => {
  const signup = await call("/api/signup", "POST", {
    pharmacyName: "Small Pharmacy",
    ownerName: "Kofi",
    email: "kofi@small.example",
    password: "small12345",
    planId: "free",
  });
  assert.equal(signup.status, 201);
  const token = signup.body.token as unknown as string;

  let last = 0;
  for (let i = 0; i < 21; i += 1) {
    const res = await post("/api/products", { name: `Product ${i}`, pricePesewas: 100 }, token);
    last = res.status;
    if (i === 20) assert.match(res.body.error, /Free allows 20 products/);
  }
  assert.equal(last, 400, "the twenty-first product is refused");
});
