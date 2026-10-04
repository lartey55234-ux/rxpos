import { createServer, type IncomingMessage, type ServerResponse, type Server } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";
import type { Db } from "./db.ts";
import { AuthError, addStaff, authenticate, login, registerPharmacy, seedPlans } from "./auth.ts";
import { RateLimitError, RateLimiter } from "./ratelimit.ts";
import { PermissionError, can, type Permission, type Role } from "./permissions.ts";
import { PlanLimitError, planFor, usageFor } from "./plans.ts";
import { SaleError, createSale, getReceipt } from "./sales.ts";
import { createPrescription } from "./prescriptions.ts";
import { readRegister } from "./controlled.ts";
import {
  assertBranch,
  branchesFor,
  createBranch,
  createCategory,
  createProduct,
  createSupplier,
  expiredBatches,
  expiringWithin,
  lowStock,
  receiveBatch,
  searchProducts,
  writeOffBatch,
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

const MAX_BODY_BYTES = 256 * 1024;

/**
 * Sent with every response. The client is one bundled module and never talks to
 * another origin, so the policy can stay this tight.
 */
const SECURITY_HEADERS: Record<string, string> = {
  "x-content-type-options": "nosniff",
  "x-frame-options": "DENY",
  "referrer-policy": "no-referrer",
  "strict-transport-security": "max-age=31536000; includeSubDomains",
  "content-security-policy":
    "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; " +
    "img-src 'self' data:; connect-src 'self'; object-src 'none'; " +
    "base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
};

function secure(res: ServerResponse): void {
  for (const [name, value] of Object.entries(SECURITY_HEADERS)) res.setHeader(name, value);
}

/** Behind a proxy the socket address is the proxy, so trust the first forwarded hop. */
function clientKey(req: IncomingMessage): string {
  const forwarded = req.headers["x-forwarded-for"];
  const first = (Array.isArray(forwarded) ? forwarded[0] : forwarded)?.split(",")[0]?.trim();
  return first || req.socket.remoteAddress || "unknown";
}

/** Body values arrive as unknown; these two keep the routes readable. */
function str(value: unknown): string {
  return value === undefined || value === null ? "" : String(value);
}

function optional(value: unknown): string | null {
  const text = str(value).trim();
  return text === "" ? null : text;
}

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
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > MAX_BODY_BYTES) throw new ValidationError("Request body is too large");
    chunks.push(chunk as Buffer);
  }
  const raw = Buffer.concat(chunks).toString("utf8");
  if (!raw) return {};
  try {
    return JSON.parse(raw) as Record<string, unknown>;
  } catch {
    throw new ValidationError("Request body is not valid JSON");
  }
}

function statusFor(err: unknown): number {
  if (err instanceof AuthError) return 401;
  if (err instanceof RateLimitError) return 429;
  if (err instanceof PermissionError) return 403;
  if (err instanceof PlanLimitError || err instanceof SaleError || err instanceof ValidationError) return 400;
  return 500;
}

/**
 * The HTTP surface for the counter UI. The client never sends a tenant id: the
 * bearer token resolves to one actor, and every query runs through that actor's
 * TenantScope.
 */
export type HandlerOptions = {
  /** Attempts allowed per IP before a cooldown. Defaults suit a public instance. */
  loginLimit?: number;
  signupLimit?: number;
};

export function createRequestHandler(
  db: Db,
  publicDir = join(here, "public"),
  options: HandlerOptions = {},
) {
  // Per process, which is all the pilot needs: enough to blunt password grinding
  // and bulk registration without pretending to be a distributed limiter.
  const loginLimiter = new RateLimiter(options.loginLimit ?? 30, 15 * 60 * 1000);
  const signupLimiter = new RateLimiter(options.signupLimit ?? 5, 60 * 60 * 1000);

  return async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? "/", "http://localhost");
    const path = url.pathname;
    const method = req.method ?? "GET";

    secure(res);

    // Load balancers and uptime monitors reach this without a token.
    if (path === "/healthz") {
      let healthy = false;
      try {
        healthy = (db.prepare("SELECT 1 AS ok").get() as { ok: number }).ok === 1;
      } catch {
        healthy = false;
      }
      send(res, healthy ? 200 : 503, { status: healthy ? "ok" : "degraded" });
      return;
    }

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
        loginLimiter.hit(clientKey(req));
        const body = await readJson(req);
        const session = login(db, String(body.email ?? ""), String(body.password ?? ""));
        send(res, 200, { token: session.token, ...sessionPayload(db, authenticate(db, session.token)) });
        return;
      }

      // Self-serve: a pharmacy owner can open their own account from the login screen.
      if (method === "POST" && path === "/api/signup") {
        signupLimiter.hit(clientKey(req));
        const body = await readJson(req);
        seedPlans(db);

        const email = String(body.email ?? "").trim().toLowerCase();
        const planId = body.planId ? String(body.planId) : "starter";
        if (!db.prepare("SELECT 1 AS x FROM plans WHERE plan_id = ?").get(planId)) {
          throw new ValidationError(`Unknown plan ${planId}`);
        }
        // Email is unique across the workspace, so catch the clash before the insert.
        if (db.prepare("SELECT 1 AS x FROM users WHERE email = ?").get(email)) {
          send(res, 409, { error: "That email already has an account. Sign in instead." });
          return;
        }

        const result = registerPharmacy(db, {
          pharmacyName: String(body.pharmacyName ?? ""),
          ownerName: String(body.ownerName ?? ""),
          email,
          password: String(body.password ?? ""),
          planId,
          branchName: body.branchName ? String(body.branchName) : undefined,
          phone: body.phone ? String(body.phone) : null,
        });
        send(res, 201, { token: result.token, ...sessionPayload(db, authenticate(db, result.token)) });
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
        const products = searchProducts(me, branchId, url.searchParams.get("q") ?? "");
        // Cost price is what the pharmacy paid for the stock, so it follows the
        // same rule as asset values: the owner sees it and nobody else does.
        if (!can(me.role, "assets")) {
          for (const product of products) delete product.cost_price_pesewas;
        }
        send(res, 200, { products });
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
          branchId: str(body.branchId),
          productId: str(body.productId),
          batchNumber: str(body.batchNumber),
          expiryDate: optional(body.expiryDate),
          quantity: Number(body.quantity ?? 0),
          costPricePesewas: body.costPricePesewas === undefined ? undefined : Number(body.costPricePesewas),
          sellingPricePesewas: body.sellingPricePesewas === undefined ? undefined : Number(body.sellingPricePesewas),
          supplierId: optional(body.supplierId),
        });
        send(res, 201, { batchId });
        return;
      }

      if (method === "POST" && path === "/api/products") {
        const me = actor();
        const body = await readJson(req);
        const productId = createProduct(me, {
          name: str(body.name),
          categoryId: optional(body.categoryId),
          brand: optional(body.brand),
          form: optional(body.form),
          strength: optional(body.strength),
          unit: optional(body.unit),
          barcode: optional(body.barcode),
          defaultPricePesewas: Number(body.pricePesewas ?? 0),
          costPricePesewas: Number(body.costPricePesewas ?? 0),
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
        send(res, 201, {
          supplierId: createSupplier(me, {
            name: str(body.name),
            phone: optional(body.phone),
            email: optional(body.email),
            address: optional(body.address),
          }),
        });
        return;
      }

      /* ------------------- setting a pharmacy up, after signup ------------------ */

      if (method === "GET" && path === "/api/suppliers") {
        const me = actor();
        send(res, 200, {
          suppliers: me.scope.all(
            "SELECT supplier_id, name, phone, email, address FROM suppliers WHERE tenant_id = {{tenant}} ORDER BY name",
          ),
        });
        return;
      }

      if (method === "GET" && path === "/api/categories") {
        const me = actor();
        send(res, 200, {
          categories: me.scope.all(
            "SELECT category_id, name, description FROM categories WHERE tenant_id = {{tenant}} ORDER BY name",
          ),
        });
        return;
      }

      if (method === "POST" && path === "/api/categories") {
        const me = actor();
        const body = await readJson(req);
        send(res, 201, {
          categoryId: createCategory(me, str(body.name), optional(body.description) ?? undefined),
        });
        return;
      }

      // Branches change what the plan charges for, so the domain gates this on "plans".
      if (method === "POST" && path === "/api/branches") {
        const me = actor();
        const body = await readJson(req);
        const branchId = createBranch(me, {
          name: str(body.name),
          address: optional(body.address),
          phone: optional(body.phone),
        });
        send(res, 201, { branchId, branches: branchesFor(me) });
        return;
      }

      if (method === "GET" && path === "/api/staff") {
        const me = actor();
        if (!can(me.role, "users")) throw new PermissionError("Only the owner can see staff accounts");
        send(res, 200, {
          staff: me.scope.all(
            "SELECT user_id, name, email, role, status, branch_id, created_at FROM users WHERE tenant_id = {{tenant}} ORDER BY created_at",
          ),
        });
        return;
      }

      if (method === "POST" && path === "/api/staff") {
        const me = actor();
        const body = await readJson(req);
        const role = str(body.role) || "salesperson";
        if (role !== "admin" && role !== "salesperson") {
          throw new ValidationError("Role must be admin or salesperson");
        }
        const userId = addStaff(db, me, {
          name: str(body.name),
          email: str(body.email),
          password: str(body.password),
          role,
          branchId: optional(body.branchId),
        });
        send(res, 201, { userId });
        return;
      }

      const writeOffMatch = /^\/api\/batches\/([^/]+)\/writeoff$/.exec(path);
      if (method === "POST" && writeOffMatch) {
        const me = actor();
        const body = await readJson(req);
        writeOffBatch(me, writeOffMatch[1], str(body.note) || "Written off");
        send(res, 200, { ok: true });
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
      // The bundle carries no content hash, so let the browser revalidate it.
      "cache-control": extname(file) === ".html" ? "no-store" : "no-cache",
    });
    res.end(body);
  } catch {
    res.writeHead(404, { "content-type": "text/plain; charset=utf-8" }).end("Not found");
  }
}

export function startServer(
  db: Db,
  port = 0,
  publicDir?: string,
  host = "0.0.0.0",
  options: HandlerOptions = {},
): Promise<Server> {
  const server = createServer(createRequestHandler(db, publicDir, options));
  return new Promise((resolve) => {
    server.listen(port, host, () => resolve(server));
  });
}
