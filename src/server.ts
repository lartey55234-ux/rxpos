import { createServer, type IncomingMessage, type ServerResponse, type Server } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";
import type { Database } from "./storage/index.ts";
import { AuthError, addStaff, authenticate, login, registerPharmacy, seedPlans } from "./auth.ts";
import { RateLimitError, RateLimiter } from "./ratelimit.ts";
import { PermissionError, assertCan, can, type Permission, type Role } from "./permissions.ts";
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
import { importCatalogue, type ImportField } from "./import.ts";
import { confirmCharge, paymentState, startCharge } from "./checkout.ts";
import { checkResetToken, requestPasswordReset, resetPassword } from "./password.ts";
import { ConsoleMailer, MailError, type Mailer } from "./mail.ts";
import { clearErrors, errorSummary, listErrors, recordError } from "./errors.ts";
import { PaystackGateway, verifyWebhookSignature, type Channel, type PaymentGateway } from "./payments.ts";
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
  "diagnostics",
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

/** The raw bytes, because Paystack signs the body as sent. */
async function readRaw(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > MAX_BODY_BYTES) throw new ValidationError("Request body is too large");
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks).toString("utf8");
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
  /** Absent, or null, means card and mobile money are not offered. */
  gateway?: PaymentGateway | null;
  paystackSecretKey?: string | null;
  /** Where the app answers, so reset links point at the right place. */
  publicUrl?: string;
  /** Falls back to writing messages to the log. */
  mailer?: Mailer;
};

export function createRequestHandler(
  db: Database,
  publicDir = join(here, "public"),
  options: HandlerOptions = {},
) {
  // Per process, which is all the pilot needs: enough to blunt password grinding
  // and bulk registration without pretending to be a distributed limiter.
  const secretKey = options.paystackSecretKey ?? null;
  const gateway =
    options.gateway !== undefined
      ? options.gateway
      : secretKey
        ? new PaystackGateway(secretKey)
        : null;

  const mailer = options.mailer ?? new ConsoleMailer();
  const publicUrl = options.publicUrl ?? "http://localhost:4173";

  // A reset endpoint is a way to send mail to strangers. Keep it tight.
  const forgotLimiter = new RateLimiter(5, 60 * 60 * 1000);
  // A broken client can fail in a loop. Cap what one address can report.
  const errorLimiter = new RateLimiter(60, 60 * 60 * 1000);
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
        const row = await db.get<{ ok: number }>("SELECT 1 AS ok");
        healthy = row?.ok === 1;
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
      const actor = async (): Promise<Actor> => {
        const header = req.headers.authorization ?? "";
        const token = header.startsWith("Bearer ") ? header.slice(7) : "";
        if (!token) throw new AuthError("Missing bearer token");
        return authenticate(db, token);
      };

      // Paystack calls this when a charge settles, which for mobile money is often
      // after the browser has gone. The signature is the authentication.
      if (method === "POST" && path === "/api/payments/webhook") {
        const raw = await readRaw(req);
        const signature = String(req.headers["x-paystack-signature"] ?? "");
        if (!secretKey || !verifyWebhookSignature(raw, signature, secretKey)) {
          send(res, 401, { error: "Bad signature" });
          return;
        }
        let event: { event?: string; data?: { reference?: string } } = {};
        try {
          event = JSON.parse(raw || "{}");
        } catch {
          throw new ValidationError("Webhook body is not valid JSON");
        }
        if (event.event === "charge.success" && event.data?.reference && gateway) {
          try {
            await confirmCharge(db, gateway, event.data.reference);
          } catch (err) {
            // Answer 200 anyway: Paystack retries, and a mismatch needs a human.
            console.error("[rxpos] webhook charge.success:", err);
          }
        }
        send(res, 200, { received: true });
        return;
      }

      /* --------------------------- what broke --------------------------- */

      // Unauthenticated on purpose: a fault can happen on the sign-in screen, which
      // is exactly when you would want to hear about it. A valid token, if there is
      // one, is attached for context.
      if (method === "POST" && path === "/api/errors") {
        errorLimiter.hit(clientKey(req));
        const body = await readJson(req);

        let tenantId: string | null = null;
        let userId: string | null = null;
        try {
          const header = req.headers.authorization ?? "";
          const bearer = header.startsWith("Bearer ") ? header.slice(7) : "";
          if (bearer) {
            const me = await authenticate(db, bearer);
            tenantId = me.scope.tenantId;
            userId = me.userId;
          }
        } catch {
          /* an anonymous fault is still worth recording */
        }

        await recordError(db, {
          source: "client",
          message: str(body.message) || "Unknown error",
          stack: body.stack ? str(body.stack) : null,
          path: body.path ? str(body.path) : null,
          tenantId,
          userId,
          context:
            body.context && typeof body.context === "object"
              ? (body.context as Record<string, unknown>)
              : null,
        });
        send(res, 202, { received: true });
        return;
      }

      if (method === "GET" && path === "/api/errors") {
        const me = await actor();
        assertCan(me.role, "diagnostics");
        send(res, 200, {
          errors: await listErrors(db, Number(url.searchParams.get("limit") ?? 100)),
          summary: await errorSummary(db),
        });
        return;
      }

      if (method === "DELETE" && path === "/api/errors") {
        const me = await actor();
        assertCan(me.role, "diagnostics");
        send(res, 200, { cleared: await clearErrors(db) });
        return;
      }

      /* ------------------------- getting back in ------------------------- */

      if (method === "POST" && path === "/api/password/forgot") {
        forgotLimiter.hit(clientKey(req));
        const body = await readJson(req);
        // The same answer whether or not the address is known: anything else would
        // be a way to find out who works at a pharmacy.
        try {
          await requestPasswordReset(db, mailer, publicUrl, str(body.email));
        } catch (err) {
          console.error("[rxpos] password reset email:", err);
        }
        send(res, 200, { ok: true, message: "If that address has an account, a reset link is on its way." });
        return;
      }

      if (method === "GET" && path === "/api/password/reset") {
        send(res, 200, await checkResetToken(db, url.searchParams.get("token") ?? ""));
        return;
      }

      if (method === "POST" && path === "/api/password/reset") {
        const body = await readJson(req);
        const result = await resetPassword(db, str(body.token), str(body.password));
        send(res, 200, { email: result.email });
        return;
      }

      if (method === "POST" && path === "/api/login") {
        loginLimiter.hit(clientKey(req));
        const body = await readJson(req);
        const session = await login(db, String(body.email ?? ""), String(body.password ?? ""));
        send(res, 200, { token: session.token, ...(await sessionPayload(db, await authenticate(db, session.token), gateway)) });
        return;
      }

      // Self-serve: a pharmacy owner can open their own account from the login screen.
      if (method === "POST" && path === "/api/signup") {
        signupLimiter.hit(clientKey(req));
        const body = await readJson(req);
        await seedPlans(db);

        const email = String(body.email ?? "").trim().toLowerCase();
        const planId = body.planId ? String(body.planId) : "starter";
        if (!(await db.get("SELECT 1 AS x FROM plans WHERE plan_id = ?", [planId]))) {
          throw new ValidationError(`Unknown plan ${planId}`);
        }
        // Email is unique across the workspace, so catch the clash before the insert.
        if (await db.get("SELECT 1 AS x FROM users WHERE email = ?", [email])) {
          send(res, 409, { error: "That email already has an account. Sign in instead." });
          return;
        }

        const result = await registerPharmacy(db, {
          pharmacyName: String(body.pharmacyName ?? ""),
          ownerName: String(body.ownerName ?? ""),
          email,
          password: String(body.password ?? ""),
          planId,
          branchName: body.branchName ? String(body.branchName) : undefined,
          phone: body.phone ? String(body.phone) : null,
        });
        send(res, 201, { token: result.token, ...(await sessionPayload(db, await authenticate(db, result.token), gateway)) });
        return;
      }

      if (method === "GET" && path === "/api/session") {
        send(res, 200, await sessionPayload(db, await actor(), gateway));
        return;
      }

      if (method === "GET" && path === "/api/products") {
        const me = await actor();
        const branchId = String(url.searchParams.get("branchId") ?? "");
        await assertBranch(me, branchId);
        const limit = Number(url.searchParams.get("limit") ?? 25);
        const products = await searchProducts(me, branchId, url.searchParams.get("q") ?? "",
          Number.isFinite(limit) ? Math.min(Math.max(limit, 1), 500) : 25);
        // Cost price is what the pharmacy paid for the stock, so it follows the
        // same rule as asset values: the owner sees it and nobody else does.
        if (!can(me.role, "assets")) {
          for (const product of products) delete product.cost_price_pesewas;
        }
        send(res, 200, { products });
        return;
      }

      if (method === "GET" && path === "/api/alerts") {
        const me = await actor();
        const branchId = String(url.searchParams.get("branchId") ?? "");
        await assertBranch(me, branchId);
        send(res, 200, {
          expired: await expiredBatches(me, branchId),
          expiring: await expiringWithin(me, branchId, 90),
          low: await lowStock(me, branchId),
        });
        return;
      }

      if (method === "GET" && path === "/api/reports") {
        const me = await actor();
        const branchId = String(url.searchParams.get("branchId") ?? "");
        await assertBranch(me, branchId);
        send(res, 200, {
          today: await todayTotals(me, branchId),
          week: await salesSummary(me, branchId, 7),
          top: await topProducts(me, branchId, 7),
          assets: can(me.role, "assets") ? await assetValues(me, branchId) : null,
        });
        return;
      }

      if (method === "GET" && path === "/api/register") {
        const me = await actor();
        const branchId = String(url.searchParams.get("branchId") ?? "");
        await assertBranch(me, branchId);
        const to = url.searchParams.get("to") ?? new Date().toISOString().slice(0, 10);
        const from = url.searchParams.get("from") ?? to;
        send(res, 200, { entries: await readRegister(me, branchId, from, to) });
        return;
      }

      if (method === "POST" && path === "/api/prescriptions") {
        const me = await actor();
        const body = await readJson(req);
        const prescriptionId = await createPrescription(me, {
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
        const me = await actor();
        const body = await readJson(req);
        const result = await createSale(me, {
          // The client's id for this sale, so a retry after a dropped connection is
          // the same sale rather than a second one.
          ...(body.saleId ? { saleId: String(body.saleId) } : {}),
          branchId: String(body.branchId ?? ""),
          lines: (body.lines as { productId: string; quantity: number }[]) ?? [],
          paymentMethod: (body.paymentMethod as "Cash" | "Mobile Money" | "Card") ?? "Cash",
          amountTenderedPesewas: body.amountTenderedPesewas === undefined ? undefined : Number(body.amountTenderedPesewas),
          discountPesewas: body.discountPesewas === undefined ? undefined : Number(body.discountPesewas),
          prescriptionId: body.prescriptionId ? String(body.prescriptionId) : null,
          recipientName: body.recipientName ? String(body.recipientName) : null,
          recipientAddress: body.recipientAddress ? String(body.recipientAddress) : null,
        });
        send(res, 201, { sale: result, receipt: await getReceipt(me, result.saleId) });
        return;
      }

      const receiptMatch = /^\/api\/sales\/([^/]+)\/receipt$/.exec(path);
      if (method === "GET" && receiptMatch) {
        send(res, 200, { receipt: await getReceipt(await actor(), receiptMatch[1]) });
        return;
      }

      if (method === "POST" && path === "/api/batches") {
        const me = await actor();
        const body = await readJson(req);
        const batchId = await receiveBatch(me, {
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
        const me = await actor();
        const body = await readJson(req);
        const productId = await createProduct(me, {
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

      // Importing an existing catalogue. The preview is the same call with dryRun,
      // so what a person approves is exactly what gets written.
      if (method === "POST" && path === "/api/products/import") {
        const me = await actor();
        const body = await readJson(req);
        const branchId = str(body.branchId);
        await assertBranch(me, branchId);
        const report = await importCatalogue(me, {
          csv: str(body.csv),
          branchId,
          mapping: (body.mapping ?? undefined) as Partial<Record<ImportField, string>> | undefined,
          dryRun: Boolean(body.dryRun),
        });
        send(res, 200, { report });
        return;
      }

      if (method === "POST" && path === "/api/suppliers") {
        const me = await actor();
        const body = await readJson(req);
        send(res, 201, {
          supplierId: await createSupplier(me, {
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
        const me = await actor();
        send(res, 200, {
          suppliers: await me.scope.all(
            "SELECT supplier_id, name, phone, email, address FROM suppliers WHERE tenant_id = {{tenant}} ORDER BY name",
          ),
        });
        return;
      }

      if (method === "GET" && path === "/api/categories") {
        const me = await actor();
        send(res, 200, {
          categories: await me.scope.all(
            "SELECT category_id, name, description FROM categories WHERE tenant_id = {{tenant}} ORDER BY name",
          ),
        });
        return;
      }

      if (method === "POST" && path === "/api/categories") {
        const me = await actor();
        const body = await readJson(req);
        send(res, 201, {
          categoryId: await createCategory(me, str(body.name), optional(body.description) ?? undefined),
        });
        return;
      }

      // Branches change what the plan charges for, so the domain gates this on "plans".
      if (method === "POST" && path === "/api/branches") {
        const me = await actor();
        const body = await readJson(req);
        const branchId = await createBranch(me, {
          name: str(body.name),
          address: optional(body.address),
          phone: optional(body.phone),
        });
        send(res, 201, { branchId, branches: await branchesFor(me) });
        return;
      }

      if (method === "GET" && path === "/api/staff") {
        const me = await actor();
        if (!can(me.role, "users")) throw new PermissionError("Only the owner can see staff accounts");
        send(res, 200, {
          staff: await me.scope.all(
            "SELECT user_id, name, email, role, status, branch_id, created_at FROM users WHERE tenant_id = {{tenant}} ORDER BY created_at",
          ),
        });
        return;
      }

      if (method === "POST" && path === "/api/staff") {
        const me = await actor();
        const body = await readJson(req);
        const role = str(body.role) || "salesperson";
        if (role !== "admin" && role !== "salesperson") {
          throw new ValidationError("Role must be admin or salesperson");
        }
        const userId = await addStaff(db, me, {
          name: str(body.name),
          email: str(body.email),
          password: str(body.password),
          role,
          branchId: optional(body.branchId),
        });
        send(res, 201, { userId });
        return;
      }

      if (method === "POST" && path === "/api/payments/charge") {
        if (!gateway) throw new ValidationError("Card and mobile money are not switched on for this deployment");
        const me = await actor();
        const body = await readJson(req);
        const channel = str(body.channel) as Channel;
        if (channel !== "card" && channel !== "mobile_money") {
          throw new ValidationError("Channel must be card or mobile_money");
        }
        const charge = await startCharge(me, gateway, { saleId: str(body.saleId), channel });
        send(res, 201, { charge });
        return;
      }

      if (method === "POST" && path === "/api/payments/confirm") {
        if (!gateway) throw new ValidationError("Card and mobile money are not switched on for this deployment");
        const me = await actor();
        const body = await readJson(req);
        const result = await confirmCharge(db, gateway, str(body.reference));
        send(res, 200, {
          payment: result,
          ...(result.saleId ? { receipt: await getReceipt(me, result.saleId) } : {}),
        });
        return;
      }

      const paymentMatch = /^\/api\/sales\/([^/]+)\/payment$/.exec(path);
      if (method === "GET" && paymentMatch) {
        send(res, 200, await paymentState(await actor(), paymentMatch[1]));
        return;
      }

      const writeOffMatch = /^\/api\/batches\/([^/]+)\/writeoff$/.exec(path);
      if (method === "POST" && writeOffMatch) {
        const me = await actor();
        const body = await readJson(req);
        await writeOffBatch(me, writeOffMatch[1], str(body.note) || "Written off");
        send(res, 200, { ok: true });
        return;
      }

      send(res, 404, { error: `No route for ${method} ${path}` });
    } catch (err) {
      const status = statusFor(err);
      const message = err instanceof Error ? err.message : "Unexpected error";
      if (status === 500) {
        console.error(`[rxpos] ${method} ${path}:`, err);
        // A 500 is a fault in the software, not a refusal. Those are the ones worth
        // hearing about without waiting for the pharmacy to phone.
        await recordError(db, {
          source: "server",
          message,
          stack: err instanceof Error ? (err.stack ?? null) : null,
          path: `${method} ${path}`,
        });
      }
      send(res, status, { error: message });
    }
  };
}

async function sessionPayload(db: Database, me: Actor, gateway: PaymentGateway | null) {
  const tenant = await me.scope.tenant<{ name: string }>();
  const user = await me.scope.get<{ name: string }>(
    "SELECT name FROM users WHERE tenant_id = {{tenant}} AND user_id = ?",
    me.userId,
  );
  const plan = await planFor(me.scope);
  return {
    user: { id: me.userId, name: user?.name ?? "—", role: me.role },
    tenant: {
      id: me.scope.tenantId,
      name: tenant.name,
      plan: { id: plan.plan_id, name: plan.name, pricePesewas: plan.price_pesewas },
      usage: {
        products: await usageFor(me.scope, "products"),
        shops: await usageFor(me.scope, "shops"),
        staff: await usageFor(me.scope, "staff"),
        suppliers: await usageFor(me.scope, "suppliers"),
      },
    },
    branches: await branchesFor(me),
    payments: { enabled: gateway !== null },
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
