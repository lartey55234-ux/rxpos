import { createServer, type IncomingMessage, type ServerResponse, type Server } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";
import type { Db } from "./db.ts";
import { AuthError, authenticate, login } from "./auth.ts";
import { PermissionError, can, type Permission, type Role } from "./permissions.ts";
import { PlanLimitError, planFor, usageFor } from "./plans.ts";
import { SaleError, createSale, getReceipt } from "./sales.ts";
import { createPrescription } from "./prescriptions.ts";
import { readRegister } from "./controlled.ts";
import {
  assertBranch,
  branchesFor,
  createProduct,
  createSupplier,
  expiredBatches,
  expiringWithin,
  lowStock,
  receiveBatch,
  searchProducts,
} from "./catalog.ts";
import { assetValues, salesSummary, todayTotals, topProducts } from "./reports.ts";
import { ValidationError } from "./util.ts";
import type { Actor } from "./actor.ts";

const here = fileURLToPath(new URL("..", import.meta.url));
const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
};

const PERMISSIONS: Permission[] = [
  "sell",
  "dispense_controlled",
  "stock",
  "products",
  "suppliers",
  "users",
  "assets",
  "plans",
  "reports",
];

function send(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(payload),
    "cache-control": "no-store",
  });
  res.end(payload);
}

async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  const raw = Buffer.concat(chunks).toString("utf8");
  return raw ? (JSON.parse(raw) as Record<string, unknown>) : {};
}

function statusFor(err: unknown): number {
  if (err instanceof AuthError) return 401;
  if (err instanceof PermissionError) return 403;
  if (err instanceof PlanLimitError || err instanceof SaleError || err instanceof ValidationError) return 400;
  return 500;
}

/**
 * The HTTP surface for the counter UI. The client never sends a tenant id: the
 * bearer token resolves to one actor, and every query runs through that actor's
 * TenantScope.
 */
export function createRequestHandler(db: Db, publicDir = join(here, "public")) {
  return async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? "/", "http://localhost");
    const path = url.pathname;
    const method = req.method ?? "GET";

    if (!path.startsWith("/api/")) {
      await serveStatic(res, publicDir, path);
      return;
    }

    try {
      const actor = (): Actor => {
        const header = req.headers.authorization ?? "";
        const token = header.startsWith("Bearer ") ? header.slice(7) : "";
        if (!token) throw new AuthError("Missing bearer token");
        return authenticate(db, token);
      };

      if (method === "POST" && path === "/api/login") {
        const body = await readJson(req);
        const session = login(db, String(body.email ?? ""), String(body.password ?? ""));
        send(res, 200, { token: session.token, ...sessionPayload(db, authenticate(db, session.token)) });
        return;
      }

      if (method === "GET" && path === "/api/session") {
        send(res, 200, sessionPayload(db, actor()));
        return;
      }

      if (method === "GET" && path === "/api/products") {
        const me = actor();
        const branchId = String(url.searchParams.get("branchId") ?? "");
        assertBranch(me, branchId);
        send(res, 200, { products: searchProducts(me, branchId, url.searchParams.get("q") ?? "") });
        return;
      }

      if (method === "GET" && path === "/api/alerts") {
        const me = actor();
        const branchId = String(url.searchParams.get("branchId") ?? "");
        assertBranch(me, branchId);
        send(res, 200, {
          expired: expiredBatches(me, branchId),
          expiring: expiringWithin(me, branchId, 90),
          low: lowStock(me, branchId),
        });
        return;
      }

      if (method === "GET" && path === "/api/reports") {
        const me = actor();
        const branchId = String(url.searchParams.get("branchId") ?? "");
        assertBranch(me, branchId);
        send(res, 200, {
          today: todayTotals(me, branchId),
          week: salesSummary(me, branchId, 7),
          top: topProducts(me, branchId, 7),
          assets: can(me.role, "assets") ? assetValues(me, branchId) : null,
        });
        return;
      }

      if (method === "GET" && path === "/api/register") {
        const me = actor();
        const branchId = String(url.searchParams.get("branchId") ?? "");
        assertBranch(me, branchId);
        const to = url.searchParams.get("to") ?? new Date().toISOString().slice(0, 10);
        const from = url.searchParams.get("from") ?? to;
        send(res, 200, { entries: readRegister(me, branchId, from, to) });
        return;
      }

      if (method === "POST" && path === "/api/prescriptions") {
        const me = actor();
        const body = await readJson(req);
        const prescriptionId = createPrescription(me, {
          branchId: String(body.branchId ?? ""),
          prescriptionNumber: String(body.prescriptionNumber ?? ""),
          patientName: String(body.patientName ?? ""),
          patientAddress: body.patientAddress ? String(body.patientAddress) : null,
          prescriberName: String(body.prescriberName ?? ""),
          prescriberLicence: body.prescriberLicence ? String(body.prescriberLicence) : null,
        });
        send(res, 201, { prescriptionId });
        return;
      }

      if (method === "POST" && path === "/api/sales") {
        const me = actor();
        const body = await readJson(req);
        const result = createSale(me, {
          branchId: String(body.branchId ?? ""),
          lines: (body.lines as { productId: string; quantity: number }[]) ?? [],
          paymentMethod: (body.paymentMethod as "Cash" | "Mobile Money" | "Card") ?? "Cash",
          amountTenderedPesewas: body.amountTenderedPesewas === undefined ? undefined : Number(body.amountTenderedPesewas),
          discountPesewas: body.discountPesewas === undefined ? undefined : Number(body.discountPesewas),
          prescriptionId: body.prescriptionId ? String(body.prescriptionId) : null,
          recipientName: body.recipientName ? String(body.recipientName) : null,
          recipientAddress: body.recipientAddress ? String(body.recipientAddress) : null,
        });
        send(res, 201, { sale: result, receipt: getReceipt(me, result.saleId) });
        return;
      }

      const receiptMatch = /^\/api\/sales\/([^/]+)\/receipt$/.exec(path);
      if (method === "GET" && receiptMatch) {
        send(res, 200, { receipt: getReceipt(actor(), receiptMatch[1]) });
        return;
      }

      if (method === "POST" && path === "/api/batches") {
        const me = actor();
        const body = await readJson(req);
        const batchId = receiveBatch(me, {
          branchId: String(body.branchId ?? ""),
          productId: String(body.productId ?? ""),
          batchNumber: String(body.batchNumber ?? ""),
          expiryDate: body.expiryDate ? String(body.expiryDate) : null,
          quantity: Number(body.quantity ?? 0),
          supplierId: body.supplierId ? String(body.supplierId) : null,
        });
        send(res, 201, { batchId });
        return;
      }

      if (method === "POST" && path === "/api/products") {
        const me = actor();
        const body = await readJson(req);
        const productId = createProduct(me, {
          name: String(body.name ?? ""),
          form: body.form ? String(body.form) : null,
          strength: body.strength ? String(body.strength) : null,
          barcode: body.barcode ? String(body.barcode) : null,
          defaultPricePesewas: Number(body.pricePesewas ?? 0),
          reorderLevel: body.reorderLevel === undefined ? 0 : Number(body.reorderLevel),
          prescriptionRequired: Boolean(body.prescriptionRequired),
          controlledClass: (body.controlledClass as "none" | "B" | "A") ?? "none",
          perishable: body.perishable === undefined ? true : Boolean(body.perishable),
        });
        send(res, 201, { productId });
        return;
      }

      if (method === "POST" && path === "/api/suppliers") {
        const me = actor();
        const body = await readJson(req);
        send(res, 201, { supplierId: createSupplier(me, { name: String(body.name ?? "") }) });
        return;
      }

      send(res, 404, { error: `No route for ${method} ${path}` });
    } catch (err) {
      const message = err instanceof Error ? err.message : "Unexpected error";
      if (statusFor(err) === 500) console.error(`[rxpos] ${method} ${path}:`, err);
      send(res, statusFor(err), { error: message });
    }
  };
}

function sessionPayload(db: Db, me: Actor) {
  const tenant = me.scope.tenant<{ name: string }>();
  const user = me.scope.get<{ name: string }>(
    "SELECT name FROM users WHERE tenant_id = {{tenant}} AND user_id = ?",
    me.userId,
  );
  const plan = planFor(me.scope);
  return {
    user: { id: me.userId, name: user?.name ?? "—", role: me.role },
    tenant: {
      id: me.scope.tenantId,
      name: tenant.name,
      plan: { id: plan.plan_id, name: plan.name, pricePesewas: plan.price_pesewas },
      usage: {
        products: usageFor(me.scope, "products"),
        shops: usageFor(me.scope, "shops"),
        staff: usageFor(me.scope, "staff"),
        suppliers: usageFor(me.scope, "suppliers"),
      },
    },
    branches: branchesFor(me),
    permissions: Object.fromEntries(PERMISSIONS.map((p) => [p, can(me.role as Role, p)])),
  };
}

async function serveStatic(res: ServerResponse, publicDir: string, path: string): Promise<void> {
  const relative = path === "/" ? "index.html" : normalize(path).replace(/^(\.\.[/\\])+/, "").replace(/^\//, "");
  const file = join(publicDir, relative);
  if (!file.startsWith(publicDir)) {
    res.writeHead(403).end("Forbidden");
    return;
  }
  try {
    const body = await readFile(file);
    res.writeHead(200, {
      "content-type": MIME[extname(file)] ?? "application/octet-stream",
      "content-length": body.length,
    });
    res.end(body);
  } catch {
    res.writeHead(404, { "content-type": "text/plain; charset=utf-8" }).end("Not found");
  }
}

export function startServer(db: Db, port = 0, publicDir?: string): Promise<Server> {
  const server = createServer(createRequestHandler(db, publicDir));
  return new Promise((resolve) => {
    server.listen(port, () => resolve(server));
  });
}
