/**
 * rxpos counter UI.
 *
 * Deliberately thin: every rule that matters — first-expiry-first-out, expired
 * batches, prescriptions for controlled drugs, role permissions, plan limits —
 * is enforced by the API. This client decides what to show, never what is allowed.
 */

type Role = "owner" | "admin" | "salesperson";

type Session = {
  user: { id: string; name: string; role: Role };
  tenant: { id: string; name: string; plan: { id: string; name: string; pricePesewas: number }; usage: Record<string, number> };
  branches: { branch_id: string; name: string; address: string | null }[];
  permissions: Record<string, boolean>;
  /** False when the deployment has no payment keys. */
  payments: { enabled: boolean };
};

type ProductRow = {
  product_id: string;
  name: string;
  brand: string | null;
  /** Only sent to a caller allowed to see what the pharmacy paid. */
  cost_price_pesewas?: number;
  form: string | null;
  strength: string | null;
  barcode: string | null;
  price_pesewas: number;
  reorder_level: number;
  prescription_required: number;
  controlled_class: "none" | "B" | "A";
  sellable: number;
  on_hand: number;
  nearest_expiry: string | null;
};

type Receipt = {
  saleId: string;
  at: string;
  branch: string;
  servedBy: string;
  paymentMethod: string;
  subtotalPesewas: number;
  discountPesewas: number;
  totalPesewas: number;
  amountTenderedPesewas: number;
  changePesewas: number;
  lines: { name: string; strength: string | null; quantity: number; unitPricePesewas: number; lineTotalPesewas: number; batchNumber: string }[];
  controlled: { name: string; quantity: number; batchNumber: string; recipient: string | null }[];
  prescriptionNumber: string | null;
};

type ImportRow = {
  line: number;
  name: string;
  status: "ok" | "error" | "skipped";
  message: string;
  preview?: { price: number; cost: number; quantity: number; expiry: string | null };
  notes?: string[];
};

type ImportReport = {
  dryRun: boolean;
  headers: string[];
  mapping: Record<string, string>;
  total: number;
  ok: number;
  errors: number;
  skipped: number;
  rows: ImportRow[];
};

type CartLine = { productId: string; quantity: number; name: string; price: number; controlled: boolean; needsRx: boolean; sellable: number };

const byId = <T extends HTMLElement = HTMLElement>(id: string): T => document.getElementById(id) as T;

/**
 * The request never reached the server. Distinct from a refusal, because the two
 * need opposite treatment: a refusal must be shown and the sale abandoned, while
 * a lost connection is exactly what the queue exists for.
 */
class NoConnection extends Error {
  constructor() {
    super("No connection to the server — nothing has been recorded. Try again when the signal returns.");
    this.name = "NoConnection";
  }
}
const money = (pesewas: number): string => `GHS ${(pesewas / 100).toFixed(2)}`;
const esc = (value: unknown): string =>
  String(value ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c] as string);

let token = localStorage.getItem("rxpos.token") ?? "";
let session: Session | null = null;
let branchId = "";
let view = "counter";
let cart: CartLine[] = [];
let discountPesewas = 0;
let prescriptionId: string | null = null;
let prescriptionLabel = "";
let query = "";
let products: ProductRow[] = [];

async function api<T>(path: string, init: RequestInit = {}): Promise<T> {
  let res: Response;
  try {
    res = await fetch(path, {
      ...init,
      headers: {
        "content-type": "application/json",
        ...(token ? { authorization: `Bearer ${token}` } : {}),
        ...(init.headers ?? {}),
      },
    });
  } catch {
    // "Failed to fetch" is what the browser says. A cashier needs to know what it
    // means for the sale in front of them.
    throw new NoConnection();
  }
  const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  if (!res.ok) {
    if (res.status === 401) signOut();
    throw new Error(String(body.error ?? res.statusText));
  }
  return body as T;
}

function toast(message: string, isError = false): void {
  const node = byId("toast");
  node.textContent = message;
  node.className = `toast on${isError ? " err" : ""}`;
  window.setTimeout(() => (node.className = "toast"), 3200);
}

function openModal(html: string, wide = false): void {
  const modal = byId("modal");
  modal.innerHTML = `<div class="sheet${wide ? " wide" : ""}">${html}</div>`;
  modal.classList.remove("hidden");
}
function closeModal(): void {
  const modal = byId("modal");
  modal.classList.add("hidden");
  modal.innerHTML = "";
}

function signOut(): void {
  token = "";
  session = null;
  localStorage.removeItem("rxpos.token");
  authMode = "signin";
  renderLogin();
}

function debounce<T extends (...args: never[]) => void>(fn: T, ms: number): T {
  let handle = 0;
  return ((...args: never[]) => {
    window.clearTimeout(handle);
    handle = window.setTimeout(() => fn(...args), ms);
  }) as T;
}

/* ------------------------------- login ------------------------------- */

type AuthMode = "signin" | "signup" | "forgot";
let authMode: AuthMode = "signin";

const PLANS = [
  { id: "free", label: "Free — 20 products, 1 shop" },
  { id: "starter", label: "Starter — GHS 60/month" },
  { id: "standard", label: "Standard — GHS 100/month" },
  { id: "pro", label: "Pro — GHS 150/month" },
];

function forgotCard(): string {
  return `<div class="login"><div class="card">
    <h1>Forgot your password?</h1>
    <p>Enter the email you sign in with, and we will send a link to choose a new one.</p>
    <div class="fld"><label>Email</label><input id="email" type="email" autocomplete="username"></div>
    <button class="btn primary" id="submit" style="width:100%;margin-top:16px">Send the link</button>
    <button class="btn ghost" id="swap" style="width:100%;margin-top:8px">Back to sign in</button>
  </div></div>`;
}

/**
 * Where an emailed reset link lands. This runs before anything else, because
 * whoever followed the link is not signed in — that is rather the point.
 */
async function renderReset(token: string): Promise<void> {
  byId("app").innerHTML = `<div class="login"><div class="card"><div class="empty">Checking that link…</div></div></div>`;

  let check: { valid: boolean; reason: string | null };
  try {
    check = await api<{ valid: boolean; reason: string | null }>(
      `/api/password/reset?token=${encodeURIComponent(token)}`,
    );
  } catch (err) {
    check = { valid: false, reason: err instanceof Error ? err.message : "Could not check that link." };
  }

  const backToSignIn = (): void => {
    history.replaceState(null, "", "/");
    authMode = "signin";
    renderLogin();
  };

  if (!check.valid) {
    byId("app").innerHTML = `<div class="login"><div class="card">
      <h1>That link cannot be used</h1>
      <p>${esc(check.reason ?? "Ask for a new one.")}</p>
      <button class="btn primary" id="toLogin" style="width:100%">Back to sign in</button>
    </div></div>`;
    byId("toLogin").addEventListener("click", backToSignIn);
    return;
  }

  byId("app").innerHTML = `<div class="login"><div class="card">
    <h1>Choose a new password</h1>
    <p>The link works once, and anything already signed in with the old password is signed out.</p>
    <div class="fld"><label>New password</label><input id="newPassword" type="password" autocomplete="new-password"></div>
    <div class="fld" style="margin-top:10px"><label>Type it again</label><input id="againPassword" type="password" autocomplete="new-password"></div>
    <button class="btn primary" id="submit" style="width:100%;margin-top:16px">Set the password</button>
  </div></div>`;

  const submit = async (): Promise<void> => {
    const password = (byId("newPassword") as HTMLInputElement).value;
    if (password !== (byId("againPassword") as HTMLInputElement).value) {
      toast("Those two do not match", true);
      return;
    }
    try {
      await api("/api/password/reset", { method: "POST", body: JSON.stringify({ token, password }) });
      backToSignIn();
      toast("Password changed — sign in with the new one");
    } catch (err) {
      toast(err instanceof Error ? err.message : "Could not set the password", true);
    }
  };
  byId("submit").addEventListener("click", () => void submit());
  byId("againPassword").addEventListener("keydown", (event) => {
    if ((event as KeyboardEvent).key === "Enter") void submit();
  });
}

function renderLogin(): void {
  byId("app").innerHTML =
    authMode === "signin"
      ? `<div class="login"><div class="card">
          <h1>rxpos</h1>
          <p>Counter, stock and expiry for pharmacies.</p>
          <div class="fld"><label>Email</label><input id="email" type="email" autocomplete="username"></div>
          <div class="fld" style="margin-top:10px"><label>Password</label><input id="password" type="password" autocomplete="current-password"></div>
          <button class="btn primary" id="submit" style="width:100%;margin-top:16px">Sign in</button>
          <button class="btn ghost" id="swap" style="width:100%;margin-top:8px">New pharmacy? Create an account</button>
          <button class="btn ghost" id="forgot" style="width:100%;margin-top:8px">Forgot your password?</button>
        </div></div>`
      : authMode === "forgot"
        ? forgotCard()
        : `<div class="login wide"><div class="card">
          <h1>Create your pharmacy</h1>
          <p>You can add staff and stock as soon as you are in.</p>
          <div class="fld"><label>Pharmacy name</label><input id="pharmacyName" type="text" autocomplete="organization"></div>
          <div class="fld" style="margin-top:10px"><label>Your name</label><input id="ownerName" type="text" autocomplete="name"></div>
          <div class="fld" style="margin-top:10px"><label>Email</label><input id="email" type="email" autocomplete="username"></div>
          <div class="fld" style="margin-top:10px"><label>Password</label><input id="password" type="password" autocomplete="new-password"></div>
          <div class="fld" style="margin-top:10px"><label>Branch name</label><input id="branchName" type="text" placeholder="Main Pharmacy"></div>
          <div class="fld" style="margin-top:10px"><label>Plan</label><select id="planId">${PLANS.map(
            (plan) =>
              `<option value="${plan.id}"${plan.id === "starter" ? " selected" : ""}>${esc(plan.label)}</option>`,
          ).join("")}</select></div>
          <button class="btn primary" id="submit" style="width:100%;margin-top:16px">Create pharmacy</button>
          <button class="btn ghost" id="swap" style="width:100%;margin-top:8px">Already have an account? Sign in</button>
        </div></div>`;

  const submit = async (): Promise<void> => {
    if (authMode === "forgot") {
      const email = (byId("email") as HTMLInputElement).value;
      try {
        const body = await api<{ message: string }>("/api/password/forgot", {
          method: "POST",
          body: JSON.stringify({ email }),
        });
        // The same wording whether or not the address is known, so this screen
        // cannot be used to find out who works at a pharmacy.
        byId("app").innerHTML = `<div class="login"><div class="card">
          <h1>Check your email</h1>
          <p>${esc(body.message)}</p>
          <button class="btn primary" id="toLogin" style="width:100%">Back to sign in</button>
        </div></div>`;
        byId("toLogin").addEventListener("click", () => {
          authMode = "signin";
          renderLogin();
        });
      } catch (err) {
        toast(err instanceof Error ? err.message : "Could not send the link", true);
      }
      return;
    }

    const signingIn = authMode === "signin";
    const email = (byId("email") as HTMLInputElement).value;
    const password = (byId("password") as HTMLInputElement).value;
    const payload: Record<string, unknown> = signingIn
      ? { email, password }
      : {
          email,
          password,
          pharmacyName: (byId("pharmacyName") as HTMLInputElement).value,
          ownerName: (byId("ownerName") as HTMLInputElement).value,
          branchName: (byId("branchName") as HTMLInputElement).value,
          planId: (byId("planId") as HTMLSelectElement).value,
        };

    try {
      const body = await api<{ token: string } & Session>(signingIn ? "/api/login" : "/api/signup", {
        method: "POST",
        body: JSON.stringify(payload),
      });
      token = body.token;
      localStorage.setItem("rxpos.token", token);
      session = body;
      // Keep the session on the device, so the network going away later is not a
      // sign-out. Without this the till is unusable the moment the internet blinks.
      await localPut(LOCAL_STORE, "session", { at: Date.now(), session: body }).catch(() => {});
      branchId = body.branches[0]?.branch_id ?? "";
      view = "counter";
      renderApp();
    } catch (err) {
      toast(err instanceof Error ? err.message : "That did not work", true);
    }
  };

  byId("submit").addEventListener("click", () => void submit());
  byId("swap").addEventListener("click", () => {
    authMode = authMode === "signin" ? "signup" : "signin";
    renderLogin();
  });
  const forgot = document.getElementById("forgot");
  if (forgot) {
    forgot.addEventListener("click", () => {
      authMode = "forgot";
      renderLogin();
    });
  }
  // The forgot screen has no password field, so this cannot assume one.
  const passwordField = document.getElementById("password");
  if (passwordField) {
    passwordField.addEventListener("keydown", (event) => {
      if ((event as KeyboardEvent).key === "Enter") void submit();
    });
  }
}

/* -------------------------------- shell ------------------------------- */

function branchName(): string {
  return session?.branches.find((b) => b.branch_id === branchId)?.name ?? "—";
}

function renderApp(): void {
  if (!session) return;
  const tabs = [
    { id: "counter", label: "Counter" },
    { id: "stock", label: "Stock" },
    ...(session.permissions.products ? [{ id: "products", label: "Products" }] : []),
    ...(session.permissions.suppliers ? [{ id: "suppliers", label: "Suppliers" }] : []),
    ...(session.permissions.users ? [{ id: "team", label: "Team" }] : []),
    { id: "alerts", label: "Alerts" },
    ...(session.permissions.reports ? [{ id: "register", label: "Register" }] : []),
    ...(session.permissions.reports ? [{ id: "reports", label: "Reports" }] : []),
  ];
  byId("app").innerHTML = `<div class="app">
    <header class="topbar">
      <div class="brand"><span class="mark">Rx</span><div>
        <b>${esc(session.tenant.name)}</b>
        <span>${esc(session.tenant.plan.name)} plan · ${esc(session.user.name)} · ${esc(session.user.role)}</span>
      </div></div>
      <nav class="tabs">${tabs
        .map((t) => `<button data-tab="${t.id}" class="${view === t.id ? "on" : ""}">${t.label}</button>`)
        .join("")}</nav>
      <div class="ctx">
        <label>Branch <select id="branchSel">${session.branches
          .map((b) => `<option value="${b.branch_id}"${b.branch_id === branchId ? " selected" : ""}>${esc(b.name)}</option>`)
          .join("")}</select></label>
        <button class="btn sm ghost" id="syncNow" style="display:none"></button>
        <button class="btn sm ghost" id="signOut">Sign out</button>
      </div>
    </header>
    <div class="netbar hidden" id="netbar"></div>
    <main id="main"></main>
  </div>`;

  byId("signOut").addEventListener("click", signOut);
  byId("syncNow").addEventListener("click", () => void showQueue());
  void renderQueueBadge();
  byId("branchSel").addEventListener("change", (event) => {
    branchId = (event.target as HTMLSelectElement).value;
    cart = [];
    prescriptionId = null;
    renderApp();
  });
  byId("app").addEventListener("click", (event) => {
    const tab = (event.target as HTMLElement).closest("[data-tab]");
    if (!tab) return;
    view = tab.getAttribute("data-tab") ?? "counter";
    renderApp();
  });

  renderView();
  noteFreshness(offlineSince);
}

function renderView(): void {
  if (view === "counter") renderCounter();
  else if (view === "stock") renderStock();
  else if (view === "products") void renderProducts();
  else if (view === "suppliers") void renderSuppliers();
  else if (view === "team") void renderTeam();
  else if (view === "alerts") renderAlerts();
  else if (view === "register") renderRegister();
  else renderReports();
}

/* ------------------------------- counter ------------------------------ */

function renderCounter(): void {
  byId("main").innerHTML = `<section class="grid counter">
    <div class="card">
      <h2>Counter <span class="badge b-mute">${esc(branchName())}</span></h2>
      <div class="scanrow">
        <input id="scan" placeholder="Scan a barcode, or type a product name, then press Enter" autocomplete="off">
        <button class="btn ghost" id="clearSearch">Clear</button>
      </div>
      <div class="rows" id="results"><div class="empty">Loading…</div></div>
    </div>
    <aside class="card cart">
      <h2>Sale <button class="btn sm ghost" id="clearCart">Clear</button></h2>
      <div class="lines" id="lines"></div>
      <div id="cartFoot"></div>
    </aside>
  </section>`;

  const scan = byId<HTMLInputElement>("scan");
  scan.focus();
  scan.addEventListener(
    "input",
    debounce(() => {
      query = scan.value;
      void loadProducts();
    }, 160),
  );
  scan.addEventListener("keydown", (event) => {
    if ((event as KeyboardEvent).key !== "Enter") return;
    event.preventDefault();
    const typed = scan.value.trim().toLowerCase();
    const exact = products.find((p) => (p.barcode ?? "").toLowerCase() === typed);
    const pick = exact ?? products[0];
    if (!pick) {
      toast(`Nothing found for "${scan.value}"`, true);
      return;
    }
    addToCart(pick);
    scan.value = "";
    query = "";
    void loadProducts();
  });
  byId("clearSearch").addEventListener("click", () => {
    scan.value = "";
    query = "";
    void loadProducts();
  });
  byId("clearCart").addEventListener("click", () => {
    cart = [];
    discountPesewas = 0;
    prescriptionId = null;
    prescriptionLabel = "";
    renderCart();
  });

  void loadProducts();
  renderCart();
}

async function loadProducts(): Promise<void> {
  const box = document.getElementById("results");
  if (!box) return;
  try {
    const { products: found, cachedAt } = await productsFor(branchId, query);
    noteFreshness(cachedAt);
    products = found;
    if (!products.length) {
      box.innerHTML = `<div class="empty">No product matches "${esc(query)}"</div>`;
      return;
    }
    box.innerHTML = products
      .map((p) => {
        const badges: string[] = [];
        if (p.sellable <= 0) badges.push(`<span class="badge b-out">${p.on_hand > 0 ? "expired only" : "out of stock"}</span>`);
        else if (p.sellable <= p.reorder_level) badges.push(`<span class="badge b-low">low · ${p.sellable} left</span>`);
        else badges.push(`<span class="badge b-ok">${p.sellable} in stock</span>`);
        if (p.controlled_class !== "none") badges.push(`<span class="badge b-exp">Class ${p.controlled_class}</span>`);
        else if (p.prescription_required) badges.push(`<span class="badge b-rx">Rx</span>`);
        if (p.nearest_expiry) badges.push(`<span class="badge b-mute">exp ${esc(p.nearest_expiry)}</span>`);
        return `<button class="row" data-add="${p.product_id}"${p.sellable <= 0 ? " disabled style=opacity:.55" : ""}>
          <span class="nm"><b>${esc(p.name)} ${esc(p.strength)}</b><span>${esc(p.form)} · ${esc(p.barcode ?? "no barcode")}</span></span>
          ${badges.join("")}<span class="price">${money(p.price_pesewas)}</span></button>`;
      })
      .join("");
  } catch (err) {
    box.innerHTML = `<div class="empty">${esc(err instanceof Error ? err.message : "Could not load products")}</div>`;
  }
}

function addToCart(product: ProductRow): void {
  if (product.controlled_class !== "none" && !session?.permissions.dispense_controlled) {
    toast(`${product.name} is a Class ${product.controlled_class} controlled drug — your role cannot dispense it`, true);
    return;
  }
  if (product.sellable <= 0) {
    toast(
      `${product.name} has no sellable stock in ${branchName()}${product.on_hand > 0 ? " — the remaining batches are expired" : ""}`,
      true,
    );
    return;
  }
  const existing = cart.find((line) => line.productId === product.product_id);
  if (existing) {
    if (existing.quantity + 1 > product.sellable) {
      toast(`Only ${product.sellable} sellable ${product.name} in this branch`, true);
      return;
    }
    existing.quantity += 1;
  } else {
    cart.push({
      productId: product.product_id,
      quantity: 1,
      name: product.name,
      price: product.price_pesewas,
      controlled: product.controlled_class !== "none",
      needsRx: product.controlled_class !== "none" || product.prescription_required === 1,
      sellable: product.sellable,
    });
  }
  renderCart();
}

function cartTotals() {
  const subtotal = cart.reduce((sum, line) => sum + line.price * line.quantity, 0);
  const discount = Math.min(discountPesewas, subtotal);
  return { subtotal, discount, total: subtotal - discount };
}

function renderCart(): void {
  const lines = document.getElementById("lines");
  const foot = document.getElementById("cartFoot");
  if (!lines || !foot) return;

  if (!cart.length) {
    lines.innerHTML = `<div class="empty">Scan or search a product to start a sale.</div>`;
    foot.innerHTML = `<div class="totals"><div class="tline grand"><span>Total</span><span>GHS 0.00</span></div></div>`;
    return;
  }

  lines.innerHTML = cart
    .map(
      (line) => `<div class="cline">
        <span><b>${esc(line.name)}</b><span>${money(line.price)} each${line.controlled ? " · controlled" : ""}</span></span>
        <span class="qty"><button data-dec="${line.productId}">−</button><b>${line.quantity}</b><button data-inc="${line.productId}">+</button></span>
        <span class="price">${money(line.price * line.quantity)}</span>
      </div>`,
    )
    .join("");

  const totals = cartTotals();
  const needsRx = cart.some((line) => line.needsRx);
  const blocked = cart.some((line) => line.controlled) && !session?.permissions.dispense_controlled;

  foot.innerHTML = `<div class="totals">
    <div class="tline"><span>Subtotal</span><span>${money(totals.subtotal)}</span></div>
    <div class="inline">
      <div class="fld"><label>Discount (GHS)</label><input id="discount" type="number" min="0" step="0.5" value="${(totals.discount / 100).toFixed(2)}"></div>
      <div class="fld"><label>Payment</label><select id="method"><option>Cash</option><option>Mobile Money</option><option>Card</option></select></div>
    </div>
    <div class="tline grand"><span>Total</span><span id="grand">${money(totals.total)}</span></div>
    <div class="fld"><label>Amount tendered</label><input id="tender" type="number" min="0" step="0.5" value="${(totals.total / 100).toFixed(2)}"></div>
    <div class="tline"><span>Change due</span><span id="change">GHS 0.00</span></div>
    ${needsRx ? `<div class="tline" style="align-items:center">
        <span>${prescriptionId ? `Rx ${esc(prescriptionLabel)}` : "Prescription required"}</span>
        <button class="btn sm ${prescriptionId ? "ghost" : ""}" id="rxBtn">${prescriptionId ? "Change" : "Attach"}</button>
      </div>` : ""}
    ${blocked ? `<div class="tline"><span class="badge b-exp">Your role cannot dispense controlled drugs</span></div>` : ""}
    <button class="btn primary" id="complete"${blocked ? " disabled" : ""}>Complete sale</button>
  </div>`;

  byId("discount").addEventListener("input", (event) => {
    discountPesewas = Math.round(Number((event.target as HTMLInputElement).value || 0) * 100);
    const next = cartTotals();
    byId("grand").textContent = money(next.total);
    refreshChange();
  });
  byId("tender").addEventListener("input", refreshChange);
  byId("complete").addEventListener("click", () => void completeSale());
  const rxBtn = document.getElementById("rxBtn");
  if (rxBtn) rxBtn.addEventListener("click", prescriptionModal);
  refreshChange();
}

function refreshChange(): void {
  const tender = document.getElementById("tender") as HTMLInputElement | null;
  const change = document.getElementById("change");
  if (!tender || !change) return;
  change.textContent = money(Math.max(0, Math.round(Number(tender.value || 0) * 100) - cartTotals().total));
}

function prescriptionModal(): void {
  openModal(`<h2>Attach prescription</h2>
    <p class="note" style="margin:0 0 12px">A controlled or prescription-only item cannot be supplied without one. It is kept for two years.</p>
    <div class="inline">
      <div class="fld"><label>Prescription no.</label><input id="rxNumber" placeholder="RX-2026-0042"></div>
      <div class="fld"><label>Prescriber</label><input id="rxPrescriber" placeholder="Dr A. Mensah"></div>
    </div>
    <div class="fld" style="margin-top:10px"><label>Patient name</label><input id="rxPatient" placeholder="Kwame Boateng"></div>
    <div class="fld" style="margin-top:10px"><label>Patient address</label><input id="rxAddress" placeholder="12 Ring Road, Accra"></div>
    <div class="foot"><button class="btn ghost" id="mClose">Cancel</button><button class="btn primary" id="mSave">Attach</button></div>`);

  byId("mClose").addEventListener("click", closeModal);
  byId("mSave").addEventListener("click", async () => {
    try {
      const number = byId<HTMLInputElement>("rxNumber").value.trim();
      const patient = byId<HTMLInputElement>("rxPatient").value.trim();
      const prescriber = byId<HTMLInputElement>("rxPrescriber").value.trim();
      if (!number || !patient || !prescriber) {
        toast("Prescription number, patient and prescriber are required", true);
        return;
      }
      const created = await api<{ prescriptionId: string }>("/api/prescriptions", {
        method: "POST",
        body: JSON.stringify({
          branchId,
          prescriptionNumber: number,
          patientName: patient,
          patientAddress: byId<HTMLInputElement>("rxAddress").value.trim() || null,
          prescriberName: prescriber,
        }),
      });
      prescriptionId = created.prescriptionId;
      prescriptionLabel = `${number} · ${patient}`;
      closeModal();
      renderCart();
    } catch (err) {
      toast(err instanceof Error ? err.message : "Could not attach the prescription", true);
    }
  });
}

async function completeSale(): Promise<void> {
  if (!cart.length) return;
  const method = byId<HTMLSelectElement>("method").value as "Cash" | "Mobile Money" | "Card";
  const tendered = Math.round(Number(byId<HTMLInputElement>("tender").value || 0) * 100);
  const saleId = newSaleId();

  // Paystack needs the network, so offering a card button offline would be a lie.
  if (method !== "Cash" && !navigator.onLine) {
    toast("Card and mobile money need the connection. Take cash, or wait for the signal.", true);
    return;
  }

  try {
    const result = await api<{ receipt: Receipt }>("/api/sales", {
      method: "POST",
      body: JSON.stringify({
        saleId,
        branchId,
        lines: cart.map((line) => ({ productId: line.productId, quantity: line.quantity })),
        paymentMethod: method,
        amountTenderedPesewas: tendered,
        discountPesewas: cartTotals().discount,
        prescriptionId,
      }),
    });

    clearCartAfterSale();

    // Card and mobile money are charged after the sale is rung up, so the stock is
    // already reserved. If the charge does not settle, the sale stands with an
    // unpaid tender and the cashier decides what to do about it.
    if ((method === "Card" || method === "Mobile Money") && session?.payments?.enabled) {
      const paid = await chargeForSale(result.receipt, method === "Card" ? "card" : "mobile_money");
      if (!paid) {
        toast("Rung up but not paid. Retry the charge, or take cash.", true);
        return;
      }
    }

    showReceipt(result.receipt);
  } catch (err) {
    // A lost connection is what the queue is for. A refusal from the server is a
    // real refusal, and is shown rather than queued.
    if (!(err instanceof NoConnection) || method !== "Cash" || !session) {
      toast(err instanceof Error ? err.message : "The sale could not be completed", true);
      return;
    }

    const kept: QueuedSale = {
      saleId,
      tenantId: session.tenant.id,
      branchId,
      lines: cart.map((line) => ({
        productId: line.productId,
        quantity: line.quantity,
        name: line.name,
        price: line.price,
      })),
      discountPesewas: cartTotals().discount,
      amountTenderedPesewas: tendered,
      prescriptionId,
      queuedAt: Date.now(),
    };
    await queueSale(kept);
    const waiting = (await myQueue()).length;
    clearCartAfterSale();
    void renderQueueBadge();
    showQueuedSale(kept, waiting);
  }
}

function clearCartAfterSale(): void {
  cart = [];
  discountPesewas = 0;
  prescriptionId = null;
  prescriptionLabel = "";
  renderCart();
  void loadProducts();
}


/**
 * Take a card or mobile money payment.
 *
 * Deliberately does not load Paystack's script into this page: the customer pays
 * on Paystack's own site, in another tab, and this page only ever talks to our own
 * API. That keeps the content security policy intact — no third-party script runs
 * with access to the counter — and it suits mobile money, which settles after the
 * customer has put the phone down.
 *
 * Paystack is asked, never believed: the browser polling this endpoint cannot mark
 * a sale paid, because the server does the verifying.
 */
async function chargeForSale(receipt: Receipt, channel: "card" | "mobile_money"): Promise<boolean> {
  let charge: { reference: string; authorizationUrl: string; amountPesewas: number };
  try {
    const body = await api<{ charge: { reference: string; authorizationUrl: string; amountPesewas: number } }>(
      "/api/payments/charge",
      { method: "POST", body: JSON.stringify({ saleId: receipt.saleId, channel }) },
    );
    charge = body.charge;
  } catch (err) {
    toast(err instanceof Error ? err.message : "Could not start the charge", true);
    return false;
  }

  return await new Promise<boolean>((resolve) => {
    let settled = false;
    let timer = 0;

    const finish = (paid: boolean): void => {
      if (settled) return;
      settled = true;
      window.clearInterval(timer);
      closeModal();
      resolve(paid);
    };

    openModal(`<h2>Take payment</h2>
      <p style="color:var(--muted);font-size:13px;margin:-6px 0 14px">
        <b>${money(charge.amountPesewas)}</b> by ${channel === "card" ? "card" : "mobile money"}.
        Open Paystack to take the payment — this screen notices when it goes through.
      </p>
      <div class="foot" style="justify-content:space-between">
        <button class="btn ghost" id="payCancel">Cancel</button>
        <span style="display:flex;gap:8px">
          <button class="btn" id="payCheck">Check payment</button>
          <button class="btn primary" id="payOpen">Open Paystack</button>
        </span>
      </div>
      <div class="note" id="payStatus">
        <div id="payWait">Waiting for payment…</div>
        <div style="font-size:11.5px;margin-top:4px">Reference <code>${esc(charge.reference)}</code> — quote this if the payment is disputed.</div>
      </div>`);

    // The reference stays put; only the waiting line changes.
    const status = (): HTMLElement | null => document.getElementById("payWait");

    const open = (): void => {
      window.open(charge.authorizationUrl, "_blank", "noopener");
    };

    const check = async (): Promise<void> => {
      if (settled) return;
      try {
        const body = await api<{ payment: { status: string; alreadyConfirmed: boolean } }>("/api/payments/confirm", {
          method: "POST",
          body: JSON.stringify({ reference: charge.reference }),
        });
        if (body.payment.status === "success" || body.payment.alreadyConfirmed) {
          if (status()) status()!.textContent = "Paid.";
          finish(true);
          return;
        }
        if (status()) status()!.textContent = `Not paid yet — Paystack says "${body.payment.status}".`;
      } catch (err) {
        if (status()) status()!.textContent = err instanceof Error ? err.message : "Could not check the payment";
      }
    };

    byId("payOpen").addEventListener("click", open);
    byId("payCheck").addEventListener("click", () => void check());
    byId("payCancel").addEventListener("click", () => finish(false));

    open();
    void check();
    timer = window.setInterval(() => void check(), 5000);
  });
}

function receiptHTML(receipt: Receipt): string {
  const at = receipt.at.replace("T", " ").slice(0, 16);
  return `<div class="receipt">
    <h3>PHARMACY POS</h3>
    <div style="text-align:center;font-size:11.5px">${esc(receipt.branch)}</div>
    <hr>
    <div class="r"><span>Receipt</span><span>${esc(receipt.saleId.slice(-8).toUpperCase())}</span></div>
    <div class="r"><span>Date</span><span>${esc(at)}</span></div>
    <div class="r"><span>Served by</span><span>${esc(receipt.servedBy)}</span></div>
    ${receipt.prescriptionNumber ? `<div class="r"><span>Prescription</span><span>${esc(receipt.prescriptionNumber)}</span></div>` : ""}
    <hr>
    ${receipt.lines
      .map(
        (line) =>
          `<div class="r"><span>${esc(line.name)} ${esc(line.strength ?? "")}<br>&nbsp;&nbsp;${line.quantity} × ${money(line.unitPricePesewas)} <span style="font-size:10.5px">(batch ${esc(line.batchNumber)})</span></span><span>${money(line.lineTotalPesewas)}</span></div>`,
      )
      .join("")}
    <hr>
    <div class="r"><span>Subtotal</span><span>${money(receipt.subtotalPesewas)}</span></div>
    ${receipt.discountPesewas ? `<div class="r"><span>Discount</span><span>−${money(receipt.discountPesewas)}</span></div>` : ""}
    <div class="r"><b>TOTAL</b><b>${money(receipt.totalPesewas)}</b></div>
    <div class="r"><span>Paid (${esc(receipt.paymentMethod)})</span><span>${money(receipt.amountTenderedPesewas)}</span></div>
    <div class="r"><span>Change</span><span>${money(receipt.changePesewas)}</span></div>
    ${receipt.controlled.length ? `<hr><div style="font-size:11px">Controlled drugs supplied — recorded in the register:<br>${receipt.controlled.map((c) => `${esc(c.name)} × ${c.quantity} (batch ${esc(c.batchNumber)})`).join("<br>")}</div>` : ""}
    <hr><div style="text-align:center;font-size:11px">Thank you — get well soon.</div>
  </div>`;
}

function showReceipt(receipt: Receipt): void {
  openModal(`<h2>Sale complete</h2>${receiptHTML(receipt)}
    <div class="foot"><button class="btn ghost" id="mClose">Close</button><button class="btn primary" id="mPrint">Print receipt</button></div>`);
  byId("mClose").addEventListener("click", closeModal);
  byId("mPrint").addEventListener("click", () => {
    byId("printArea").innerHTML = receiptHTML(receipt);
    window.print();
  });
}

/* -------------------------------- stock ------------------------------- */

async function renderStock(): Promise<void> {
  byId("main").innerHTML = `<section class="card">
    <h2>Stock <span class="badge b-mute">${esc(branchName())}</span></h2>
    <div class="scanrow"><input id="stockSearch" placeholder="Filter by name or barcode" autocomplete="off"></div>
    <div id="stockTable"><div class="empty">Loading…</div></div>
  </section>`;
  const search = byId<HTMLInputElement>("stockSearch");
  search.addEventListener(
    "input",
    debounce(() => void loadStock(search.value), 160),
  );
  await loadStock("");
}

async function loadStock(filter: string): Promise<void> {
  const box = document.getElementById("stockTable");
  if (!box) return;
  try {
    const data = await api<{ products: ProductRow[] }>(
      `/api/products?branchId=${encodeURIComponent(branchId)}&q=${encodeURIComponent(filter)}`,
    );
    if (!data.products.length) {
      box.innerHTML = `<div class="empty">Nothing matches that filter.</div>`;
      return;
    }
    box.innerHTML = `<table><thead><tr><th>Product</th><th>Barcode</th><th class="num">Sellable</th><th class="num">On hand</th><th>Nearest expiry</th><th class="num">Price</th><th></th></tr></thead><tbody>
      ${data.products
        .map((p) => {
          const status =
            p.sellable <= 0
              ? `<span class="badge b-out">${p.on_hand > 0 ? "expired only" : "out"}</span>`
              : p.sellable <= p.reorder_level
                ? `<span class="badge b-low">low</span>`
                : `<span class="badge b-ok">ok</span>`;
          return `<tr>
            <td><b>${esc(p.name)}</b> <span style="color:var(--muted)">${esc(p.strength ?? "")}</span>${p.controlled_class !== "none" ? ` <span class="badge b-exp">Class ${p.controlled_class}</span>` : p.prescription_required ? ` <span class="badge b-rx">Rx</span>` : ""}</td>
            <td>${esc(p.barcode ?? "—")}</td>
            <td class="num"><b>${p.sellable}</b> ${status}</td>
            <td class="num">${p.on_hand}${p.on_hand !== p.sellable ? `<br><span style="font-size:11px;color:var(--muted)">+${p.on_hand - p.sellable} expired</span>` : ""}</td>
            <td>${p.nearest_expiry ? esc(p.nearest_expiry) : `<span class="badge b-mute">non-perishable</span>`}</td>
            <td class="num">${money(p.price_pesewas)}</td>
            <td class="num">${session?.permissions.stock ? `<button class="btn sm ghost" data-receive="${p.product_id}" data-name="${esc(p.name)}">Receive</button>` : ""}</td>
          </tr>`;
        })
        .join("")}
    </tbody></table>`;
    box.querySelectorAll("[data-receive]").forEach((btn) =>
      btn.addEventListener("click", () =>
        void receiveModal(btn.getAttribute("data-receive") ?? "", btn.getAttribute("data-name") ?? ""),
      ),
    );
  } catch (err) {
    box.innerHTML = `<div class="empty">${esc(err instanceof Error ? err.message : "Could not load stock")}</div>`;
  }
}

/* -------------------------------- alerts ------------------------------ */

async function renderAlerts(): Promise<void> {
  byId("main").innerHTML = `<div id="alertBody"><div class="card"><div class="empty">Loading…</div></div></div>`;
  try {
    const data = await api<{
      expired: { product: string; batch_number: string; expiry_date: string; quantity: number }[];
      expiring: { product: string; batch_number: string; expiry_date: string; quantity: number }[];
      low: { name: string; on_hand: number; reorder_level: number }[];
    }>(`/api/alerts?branchId=${encodeURIComponent(branchId)}`);

    const list = (title: string, rows: string[], tone: string) => `<div class="card" style="margin-bottom:14px">
      <h2>${title} <span class="badge ${rows.length ? tone : "b-ok"}">${rows.length}</span></h2>
      ${rows.length ? `<div class="rows">${rows.join("")}</div>` : `<div class="empty">All clear.</div>`}
    </div>`;

    byId("alertBody").innerHTML = [
      list(
        "Expired batches",
        data.expired.map(
          (row) => `<div class="row"><span class="nm"><b>${esc(row.product)}</b><span>Batch ${esc(row.batch_number)} · expired ${esc(row.expiry_date)}</span></span><span class="badge b-exp">${row.quantity} units</span></div>`,
        ),
        "b-exp",
      ),
      list(
        "Expiring within 90 days",
        data.expiring.map(
          (row) => `<div class="row"><span class="nm"><b>${esc(row.product)}</b><span>Batch ${esc(row.batch_number)}</span></span><span class="badge b-soon">${esc(row.expiry_date)}</span><span class="badge b-mute">${row.quantity} units</span></div>`,
        ),
        "b-soon",
      ),
      list(
        "At or below reorder level",
        data.low.map(
          (row) => `<div class="row"><span class="nm"><b>${esc(row.name)}</b><span>Reorder at ${row.reorder_level}</span></span><span class="badge b-low">${row.on_hand} on hand</span></div>`,
        ),
        "b-low",
      ),
    ].join("");
  } catch (err) {
    byId("alertBody").innerHTML = `<div class="card"><div class="empty">${esc(err instanceof Error ? err.message : "Could not load alerts")}</div></div>`;
  }
}

/* ------------------------------- register ----------------------------- */

async function renderRegister(): Promise<void> {
  const today = new Date().toISOString().slice(0, 10);
  byId("main").innerHTML = `<section class="card">
    <h2>Controlled Drugs Register <span class="badge b-mute">${esc(branchName())}</span></h2>
    <div class="inline" style="max-width:420px;margin-bottom:12px">
      <div class="fld"><label>From</label><input id="regFrom" type="date" value="${today}"></div>
      <div class="fld"><label>To</label><input id="regTo" type="date" value="${today}"></div>
    </div>
    <div id="regTable"><div class="empty">Loading…</div></div>
  </section>`;
  const reload = () => void loadRegister();
  byId("regFrom").addEventListener("change", reload);
  byId("regTo").addEventListener("change", reload);
  await loadRegister();
}

async function loadRegister(): Promise<void> {
  const box = document.getElementById("regTable");
  if (!box) return;
  const from = byId<HTMLInputElement>("regFrom").value;
  const to = byId<HTMLInputElement>("regTo").value;
  try {
    const data = await api<{ entries: Record<string, unknown>[] }>(
      `/api/register?branchId=${encodeURIComponent(branchId)}&from=${from}&to=${to}`,
    );
    if (!data.entries.length) {
      box.innerHTML = `<div class="empty">No register entries in this period.</div>`;
      return;
    }
    box.innerHTML = `<table><thead><tr><th>Date</th><th>Direction</th><th>Drug</th><th>Batch</th><th class="num">Qty</th><th>Recipient</th><th>Dispenser</th><th>Reference</th></tr></thead><tbody>
      ${data.entries
        .map(
          (entry) => `<tr>
            <td>${esc(entry.entry_date)}</td>
            <td><span class="badge ${entry.direction === "supplied" ? "b-exp" : "b-ok"}">${esc(entry.direction)}</span></td>
            <td><b>${esc(entry.product)}</b> <span style="color:var(--muted)">${esc(entry.strength ?? "")}</span></td>
            <td>${esc(entry.batch_number ?? "—")}</td>
            <td class="num">${esc(entry.quantity)}</td>
            <td>${esc(entry.recipient_name ?? "—")}${entry.recipient_address ? `<br><span style="font-size:11px;color:var(--muted)">${esc(entry.recipient_address)}</span>` : ""}</td>
            <td>${esc(entry.dispenser)}</td>
            <td>${esc(entry.prescription_id ? "prescription" : (entry.reference_type ?? "—"))}</td>
          </tr>`,
        )
        .join("")}
    </tbody></table>
    <div class="note">Append-only. Records are kept and available for inspection for at least two years.</div>`;
  } catch (err) {
    box.innerHTML = `<div class="empty">${esc(err instanceof Error ? err.message : "Could not load the register")}</div>`;
  }
}

/* ------------------------------- reports ------------------------------ */

async function renderReports(): Promise<void> {
  byId("main").innerHTML = `<div id="reportBody"><div class="card"><div class="empty">Loading…</div></div></div>`;
  try {
    const data = await api<{
      today: { revenuePesewas: number; transactions: number };
      week: { revenuePesewas: number; grossProfitPesewas: number; transactions: number; averageBasketPesewas: number };
      top: { name: string; units: number; revenue_pesewas: number }[];
      assets: { totalPesewas: number; safePesewas: number; atRiskPesewas: number; lostPesewas: number; nonPerishablePesewas: number } | null;
    }>(`/api/reports?branchId=${encodeURIComponent(branchId)}`);

    byId("reportBody").innerHTML = `
      <div class="kpis">
        <div class="kpi"><span>Today</span><b>${money(data.today.revenuePesewas)}</b><i>${data.today.transactions} transactions</i></div>
        <div class="kpi"><span>Last 7 days</span><b>${money(data.week.revenuePesewas)}</b><i>${data.week.transactions} transactions</i></div>
        <div class="kpi"><span>Average basket</span><b>${money(data.week.averageBasketPesewas)}</b><i>per sale</i></div>
        <div class="kpi"><span>Gross profit (7d)</span><b>${money(data.week.grossProfitPesewas)}</b><i>before operating costs</i></div>
      </div>
      <div class="grid" style="grid-template-columns:repeat(auto-fit,minmax(300px,1fr))">
        <div class="card"><h2>Top products (7 days)</h2>
          ${data.top.length
            ? `<table><thead><tr><th>Product</th><th class="num">Units</th><th class="num">Revenue</th></tr></thead><tbody>
                ${data.top.map((row) => `<tr><td>${esc(row.name)}</td><td class="num">${row.units}</td><td class="num">${money(row.revenue_pesewas)}</td></tr>`).join("")}
              </tbody></table>`
            : `<div class="empty">No sales in this period.</div>`}
        </div>
        <div class="card"><h2>Asset values</h2>
          ${data.assets
            ? `<table><tbody>
                <tr><td>Total asset</td><td class="num"><b>${money(data.assets.totalPesewas)}</b></td></tr>
                <tr><td>Safe asset <span style="color:var(--muted)">(safe for 12+ months)</span></td><td class="num">${money(data.assets.safePesewas)}</td></tr>
                <tr><td>Asset to run loss <span style="color:var(--muted)">(expiring within 12 months)</span></td><td class="num">${money(data.assets.atRiskPesewas)}</td></tr>
                <tr><td>Lost asset <span style="color:var(--muted)">(already expired)</span></td><td class="num" style="color:var(--red)">${money(data.assets.lostPesewas)}</td></tr>
                <tr><td>Non-perishable assets</td><td class="num">${money(data.assets.nonPerishablePesewas)}</td></tr>
              </tbody></table>
              <div class="note">Owner-only figures — staff accounts never see these.</div>`
            : `<div class="empty">Asset values are hidden for this role.<br><span style="font-size:12px">Sign in as the owner to see them.</span></div>`}
        </div>
      </div>`;
  } catch (err) {
    byId("reportBody").innerHTML = `<div class="card"><div class="empty">${esc(err instanceof Error ? err.message : "Could not load reports")}</div></div>`;
  }
}

/* -------------------------------- wiring ------------------------------ */

document.addEventListener("click", (event) => {
  const target = (event.target as HTMLElement).closest("[data-add],[data-inc],[data-dec]") as HTMLElement | null;
  if (!target) return;
  if (target.hasAttribute("data-add")) {
    const product = products.find((p) => p.product_id === target.getAttribute("data-add"));
    if (product) addToCart(product);
    return;
  }
  if (target.hasAttribute("data-inc")) {
    const line = cart.find((l) => l.productId === target.getAttribute("data-inc"));
    if (!line) return;
    if (line.quantity + 1 > line.sellable) {
      toast(`Only ${line.sellable} sellable ${line.name} in this branch`, true);
      return;
    }
    line.quantity += 1;
    renderCart();
    return;
  }
  const id = target.getAttribute("data-dec");
  const line = cart.find((l) => l.productId === id);
  if (!line) return;
  line.quantity -= 1;
  if (line.quantity <= 0) cart = cart.filter((l) => l.productId !== id);
  renderCart();
});

document.addEventListener("keydown", (event) => {
  if ((event as KeyboardEvent).key === "Escape") closeModal();
});

/* ------------------------- working with no network ------------------------ */

/**
 * The catalogue as last seen, kept in IndexedDB.
 *
 * Stock figures go stale the moment they are written, so this is only ever used
 * to keep a cashier working, and whatever it returns is labelled with its age.
 * The counter says so on screen rather than quietly showing old numbers.
 */
const LOCAL_DB = "rxpos";
const LOCAL_STORE = "products";
const QUEUE_STORE = "queue";
const LOCAL_VERSION = 2;

function openLocal(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(LOCAL_DB, LOCAL_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(LOCAL_STORE)) db.createObjectStore(LOCAL_STORE);
      if (!db.objectStoreNames.contains(QUEUE_STORE)) db.createObjectStore(QUEUE_STORE, { keyPath: "saleId" });
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

async function localPut(store: string, key: string, value: unknown): Promise<void> {
  const db = await openLocal();
  try {
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(store, "readwrite");
      tx.objectStore(store).put(value, key);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  } finally {
    db.close();
  }
}

/** For a store with a keyPath: supplying a key as well is an error. */
async function localPutKeyed(store: string, value: unknown): Promise<void> {
  const db = await openLocal();
  try {
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(store, "readwrite");
      tx.objectStore(store).put(value);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  } finally {
    db.close();
  }
}

async function localGet<T>(store: string, key: string): Promise<T | null> {
  const db = await openLocal();
  try {
    return await new Promise<T | null>((resolve, reject) => {
      const tx = db.transaction(store, "readonly");
      const request = tx.objectStore(store).get(key);
      request.onsuccess = () => resolve((request.result as T) ?? null);
      request.onerror = () => reject(request.error);
    });
  } finally {
    db.close();
  }
}

async function localAll<T>(store: string): Promise<T[]> {
  const db = await openLocal();
  try {
    return await new Promise<T[]>((resolve, reject) => {
      const tx = db.transaction(store, "readonly");
      const request = tx.objectStore(store).getAll();
      request.onsuccess = () => resolve((request.result as T[]) ?? []);
      request.onerror = () => reject(request.error);
    });
  } finally {
    db.close();
  }
}

async function localDelete(store: string, key: string): Promise<void> {
  const db = await openLocal();
  try {
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(store, "readwrite");
      tx.objectStore(store).delete(key);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  } finally {
    db.close();
  }
}

type LocalCatalogue = { at: number; byId: Record<string, ProductRow> };

const catalogueKey = (forBranch: string): string => `catalogue:${forBranch}`;

/** Keep every product we have seen, so a search offline has something to search. */
async function rememberProducts(forBranch: string, rows: ProductRow[]): Promise<void> {
  if (!rows.length) return;
  const key = catalogueKey(forBranch);
  const held = (await localGet<LocalCatalogue>(LOCAL_STORE, key)) ?? { at: 0, byId: {} };
  for (const row of rows) held.byId[row.product_id] = row;
  held.at = Date.now();
  await localPut(LOCAL_STORE, key, held);
}

function searchLocally(held: LocalCatalogue, query: string): ProductRow[] {
  const rows = Object.values(held.byId);
  const needle = query.trim().toLowerCase();
  const matching = needle
    ? rows.filter(
        (row) =>
          row.name.toLowerCase().includes(needle) ||
          (row.barcode ?? "").toLowerCase().includes(needle) ||
          (row.brand ?? "").toLowerCase().includes(needle),
      )
    : rows;
  return matching.sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * Products for a branch, from the server if it answers and from the cache if it
 * does not. `cachedAt` is null when the figures came from the server, so the
 * caller can say plainly which it is holding.
 */
async function productsFor(
  forBranch: string,
  query = "",
  limit = 25,
): Promise<{ products: ProductRow[]; cachedAt: number | null }> {
  try {
    const data = await api<{ products: ProductRow[] }>(
      `/api/products?branchId=${encodeURIComponent(forBranch)}&q=${encodeURIComponent(query)}&limit=${limit}`,
    );
    await rememberProducts(forBranch, data.products).catch(() => {});
    return { products: data.products, cachedAt: null };
  } catch (err) {
    const held = await localGet<LocalCatalogue>(LOCAL_STORE, catalogueKey(forBranch)).catch(() => null);
    if (!held || !Object.keys(held.byId).length) throw err;
    return { products: searchLocally(held, query), cachedAt: held.at };
  }
}

/** How long ago, in words a cashier would use. */
function agoWords(at: number): string {
  const minutes = Math.max(0, Math.round((Date.now() - at) / 60000));
  if (minutes < 1) return "a moment ago";
  if (minutes === 1) return "a minute ago";
  if (minutes < 60) return `${minutes} minutes ago`;
  const hours = Math.round(minutes / 60);
  return hours === 1 ? "an hour ago" : `${hours} hours ago`;
}

let offlineSince: number | null = null;

/** Say plainly when the screen is working from cached figures. */
function noteFreshness(cachedAt: number | null): void {
  offlineSince = cachedAt;
  const bar = document.getElementById("netbar");
  if (!bar) return;
  if (cachedAt === null) {
    bar.className = "netbar hidden";
    bar.textContent = "";
    return;
  }
  bar.className = "netbar";
  bar.textContent = `Offline — stock as it was ${agoWords(cachedAt)}. Sales cannot be taken until the connection returns.`;
}

/* ------------------------------ the queue -------------------------------- */

/**
 * A sale taken while the connection was down.
 *
 * It carries the id it was minted with, which is what makes replaying it safe:
 * the server records that sale once, however many times we send it. That is the
 * whole reason the idempotency key came before the queue.
 */
type QueuedSale = {
  saleId: string;
  tenantId: string;
  branchId: string;
  lines: { productId: string; quantity: number; name: string; price: number }[];
  discountPesewas: number;
  amountTenderedPesewas: number;
  prescriptionId: string | null;
  queuedAt: number;
  /** Set when the server refused it, so it is never retried in a loop. */
  problem?: string;
};

async function queueSale(sale: QueuedSale): Promise<void> {
  await localPutKeyed(QUEUE_STORE, sale);
}

async function queuedSales(): Promise<QueuedSale[]> {
  const all = await localAll<QueuedSale>(QUEUE_STORE).catch(() => []);
  return all.sort((a, b) => a.queuedAt - b.queuedAt);
}

/** Only this pharmacy's, because one device could be used by more than one. */
async function myQueue(): Promise<QueuedSale[]> {
  if (!session) return [];
  return (await queuedSales()).filter((sale) => sale.tenantId === session?.tenant.id);
}

let syncing = false;

/** Replay what was taken offline, oldest first, stopping the moment we lose the line. */
async function syncQueue(): Promise<void> {
  if (syncing || !navigator.onLine || !session) return;
  const waiting = (await myQueue()).filter((sale) => !sale.problem);
  if (!waiting.length) {
    void renderQueueBadge();
    return;
  }

  syncing = true;
  let sent = 0;
  try {
    for (const sale of waiting) {
      try {
        await api("/api/sales", {
          method: "POST",
          body: JSON.stringify({
            saleId: sale.saleId,
            branchId: sale.branchId,
            lines: sale.lines.map((line) => ({ productId: line.productId, quantity: line.quantity })),
            paymentMethod: "Cash",
            amountTenderedPesewas: sale.amountTenderedPesewas,
            discountPesewas: sale.discountPesewas,
            prescriptionId: sale.prescriptionId,
          }),
        });
        await localDelete(QUEUE_STORE, sale.saleId);
        sent += 1;
      } catch (err) {
        if (err instanceof NoConnection) break;
        // The server refused it — usually stock that has gone since. The goods have
        // left the shelf and the customer has paid, so it is kept and labelled
        // rather than retried forever or quietly dropped.
        await localPutKeyed(QUEUE_STORE, {
          ...sale,
          problem: err instanceof Error ? err.message : "The server refused this sale",
        });
      }
    }
  } finally {
    syncing = false;
  }

  if (sent) {
    toast(`${sent} offline sale${sent === 1 ? "" : "s"} sent`);
    void loadProducts();
  }
  void renderQueueBadge();
}

async function renderQueueBadge(): Promise<void> {
  const button = document.getElementById("syncNow");
  if (!button) return;
  const waiting = await myQueue();
  if (!waiting.length) {
    button.style.display = "none";
    return;
  }
  const stuck = waiting.filter((sale) => sale.problem).length;
  button.style.display = "";
  button.className = stuck ? "btn sm danger" : "btn sm ghost";
  button.textContent = stuck
    ? `${waiting.length} waiting · ${stuck} needs attention`
    : `${waiting.length} waiting to send`;
}

/** Show what is waiting, and why anything is stuck. */
async function showQueue(): Promise<void> {
  const waiting = await myQueue();
  if (!waiting.length) {
    toast("Nothing waiting to send");
    return;
  }
  const stuck = waiting.filter((sale) => sale.problem);
  openModal(`<h2>${waiting.length} sale${waiting.length === 1 ? "" : "s"} waiting to send</h2>
    <p style="color:var(--muted);font-size:13px;margin:-6px 0 12px">
      ${
        navigator.onLine
          ? "Sending now. Anything that cannot be sent is kept here with the reason."
          : "There is no connection yet. They will be sent when it returns."
      }
    </p>
    <table><thead><tr><th>When</th><th>Items</th><th class="num">Total</th><th></th></tr></thead><tbody>
      ${waiting
        .map((sale) => {
          const total = sale.lines.reduce((sum, line) => sum + line.price * line.quantity, 0) - sale.discountPesewas;
          return `<tr>
            <td>${esc(new Date(sale.queuedAt).toLocaleString())}</td>
            <td>${sale.lines.reduce((sum, line) => sum + line.quantity, 0)} item(s)</td>
            <td class="num">${money(total)}</td>
            <td>${
              sale.problem
                ? `<span class="badge b-out">needs attention</span><br><span style="font-size:11.5px;color:var(--muted)">${esc(sale.problem)}</span>`
                : `<span class="badge b-mute">waiting</span>`
            }</td>
          </tr>`;
        })
        .join("")}
    </tbody></table>
    <div class="foot">
      <button class="btn ghost" id="queueClose">Close</button>
      <button class="btn primary" id="queueSync">Send now</button>
    </div>`);
  byId("queueClose").addEventListener("click", closeModal);
  byId("queueSync").addEventListener("click", async () => {
    await syncQueue();
    closeModal();
  });
}

/** Shown when a sale has been kept on the device instead of sent. */
function showQueuedSale(sale: QueuedSale, waiting: number): void {
  const total = sale.lines.reduce((sum, line) => sum + line.price * line.quantity, 0) - sale.discountPesewas;
  openModal(`<h2>Sale saved on this device</h2>
    <p style="color:var(--muted);font-size:13px;margin:-6px 0 12px">
      There is no connection, so this has not reached the server. It will be sent on its own —
      ${waiting} sale${waiting === 1 ? "" : "s"} waiting.
    </p>
    <table><tbody>
      ${sale.lines
        .map(
          (line) =>
            `<tr><td>${esc(line.name)}</td><td class="num">${line.quantity}</td><td class="num">${money(line.price * line.quantity)}</td></tr>`,
        )
        .join("")}
    </tbody></table>
    <div class="tline grand" style="margin-top:10px"><span>Total</span><span>${money(total)}</span></div>
    <div class="note">The batch numbers and the final receipt come from the server, so that follows once this is sent.</div>
    <div class="foot"><button class="btn primary" id="queuedOk">Done</button></div>`);
  byId("queuedOk").addEventListener("click", closeModal);
}

/* ------------------------------- catalogue ------------------------------ */

const PRODUCT_FORMS = ["Tablets", "Capsules", "Syrup", "Suspension", "Injection", "Sachet", "Cream", "Ointment", "Drops", "Inhaler", "Device", "Other"];

/** The API counts in pesewas; a person types cedis. */
function toPesewas(value: string): number {
  const amount = Number(value);
  return Number.isFinite(amount) && amount > 0 ? Math.round(amount * 100) : 0;
}

/** The id for a sale, minted here so a retry is recognisably the same sale. */
const newSaleId = (): string => `sal_${crypto.randomUUID()}`;

const fld = (label: string, control: string): string => `<div class="fld"><label>${label}</label>${control}</div>`;

const flagsFor = (p: ProductRow): string =>
  p.controlled_class !== "none"
    ? ` <span class="badge b-exp">Class ${p.controlled_class}</span>`
    : p.prescription_required
      ? ` <span class="badge b-rx">Rx</span>`
      : "";

/* ---- products ---- */

async function renderProducts(): Promise<void> {
  byId("main").innerHTML = `<section class="card">
    <h2>Products <span class="badge b-mute">${esc(branchName())}</span>
      <span style="display:flex;gap:8px">
        <button class="btn sm ghost" id="importCatalogue">Import catalogue</button>
        <button class="btn sm primary" id="addProduct">Add product</button>
      </span></h2>
    <div class="scanrow"><input id="productSearch" placeholder="Filter by name, barcode or brand" autocomplete="off"></div>
    <div id="productTable"><div class="empty">Loading…</div></div>
    <div class="note">Stock is counted per batch, not per product. A product with no batch has no stock — use <b>Receive stock</b> to add some.</div>
  </section>`;
  const search = byId<HTMLInputElement>("productSearch");
  search.addEventListener("input", debounce(() => void loadCatalogue(search.value), 160));
  byId("addProduct").addEventListener("click", () => void productModal());
  byId("importCatalogue").addEventListener("click", () => importModal());
  await loadCatalogue("");
}

async function loadCatalogue(filter: string): Promise<void> {
  const box = document.getElementById("productTable");
  if (!box) return;
  const showCost = session?.permissions.assets ?? false;
  try {
    const { products: found, cachedAt } = await productsFor(branchId, filter, 200);
    noteFreshness(cachedAt);
    const data = { products: found };
    if (!data.products.length) {
      box.innerHTML = `<div class="empty">${filter ? "Nothing matches that filter." : "No products yet. Add the first one."}</div>`;
      return;
    }
    box.innerHTML = `<table><thead><tr>
        <th>Product</th><th>Barcode</th><th class="num">Price</th>${showCost ? `<th class="num">Cost</th>` : ""}
        <th class="num">On hand</th><th class="num">Reorder</th><th></th></tr></thead><tbody>
      ${data.products
        .map((p) => {
          const detail = [p.brand, p.form, p.strength].filter(Boolean).join(" · ");
          return `<tr>
            <td><b>${esc(p.name)}</b>${flagsFor(p)}<br><span style="font-size:11.5px;color:var(--muted)">${esc(detail || "—")}</span></td>
            <td>${esc(p.barcode ?? "—")}</td>
            <td class="num">${money(p.price_pesewas)}</td>
            ${showCost ? `<td class="num">${p.cost_price_pesewas ? money(p.cost_price_pesewas) : "—"}</td>` : ""}
            <td class="num">${p.on_hand}</td>
            <td class="num">${p.reorder_level || "—"}</td>
            <td class="num"><button class="btn sm ghost" data-receive="${p.product_id}" data-name="${esc(p.name)}">Receive stock</button></td>
          </tr>`;
        })
        .join("")}
    </tbody></table>`;
    box.querySelectorAll("[data-receive]").forEach((btn) =>
      btn.addEventListener("click", () =>
        void receiveModal(btn.getAttribute("data-receive") ?? "", btn.getAttribute("data-name") ?? ""),
      ),
    );
  } catch (err) {
    box.innerHTML = `<div class="empty">${esc(err instanceof Error ? err.message : "Could not load products")}</div>`;
  }
}

async function productModal(): Promise<void> {
  let categories: { category_id: string; name: string }[] = [];
  try {
    categories = (await api<{ categories: { category_id: string; name: string }[] }>("/api/categories")).categories;
  } catch {
    /* a brand new pharmacy has none yet */
  }

  openModal(`<h2>Add a product</h2>
    <div class="inline">
      ${fld("Name", `<input id="pName" placeholder="Paracetamol">`)}
      ${fld("Brand", `<input id="pBrand" placeholder="Kinapharma">`)}
      ${fld("Form", `<select id="pForm">${PRODUCT_FORMS.map((f) => `<option>${f}</option>`).join("")}</select>`)}
      ${fld("Strength", `<input id="pStrength" placeholder="500 mg">`)}
      ${fld("Unit", `<input id="pUnit" placeholder="Blister of 10">`)}
      ${fld("Barcode", `<input id="pBarcode" placeholder="PCM500">`)}
      ${fld("Category", `<input id="pCategory" list="catList" placeholder="Analgesics"><datalist id="catList">${categories
        .map((c) => `<option value="${esc(c.name)}"></option>`)
        .join("")}</datalist>`)}
      ${fld("Reorder level", `<input id="pReorder" type="number" min="0" placeholder="40">`)}
      ${fld("Selling price (GHS)", `<input id="pPrice" type="number" step="0.01" min="0" placeholder="5.00">`)}
      ${fld("Cost price (GHS)", `<input id="pCost" type="number" step="0.01" min="0" placeholder="2.50">`)}
      ${fld("Controlled drug", `<select id="pControlled"><option value="none">Not controlled</option><option value="B">Class B</option><option value="A">Class A</option></select>`)}
      ${fld("Rules", `<label style="display:flex;gap:8px;align-items:center;font-size:13px;text-transform:none;letter-spacing:0;color:var(--ink)"><input id="pRx" type="checkbox" style="width:auto"> Prescription only</label>
        <label style="display:flex;gap:8px;align-items:center;font-size:13px;text-transform:none;letter-spacing:0;color:var(--ink)"><input id="pPerishable" type="checkbox" checked style="width:auto"> Has an expiry date</label>`)}
    </div>
    <div class="foot">
      <button class="btn ghost" id="cancel">Cancel</button>
      <button class="btn primary" id="save">Add product</button>
    </div>`);

  byId("cancel").addEventListener("click", closeModal);
  byId("save").addEventListener("click", async () => {
    const name = (byId("pName") as HTMLInputElement).value.trim();
    if (!name) {
      toast("Give the product a name", true);
      return;
    }
    const typed = (byId("pCategory") as HTMLInputElement).value.trim();
    try {
      let categoryId: string | null = null;
      if (typed) {
        const existing = categories.find((c) => c.name.toLowerCase() === typed.toLowerCase());
        categoryId = existing
          ? existing.category_id
          : (await api<{ categoryId: string }>("/api/categories", {
              method: "POST",
              body: JSON.stringify({ name: typed }),
            })).categoryId;
      }
      await api("/api/products", {
        method: "POST",
        body: JSON.stringify({
          name,
          brand: (byId("pBrand") as HTMLInputElement).value,
          form: (byId("pForm") as HTMLSelectElement).value,
          strength: (byId("pStrength") as HTMLInputElement).value,
          unit: (byId("pUnit") as HTMLInputElement).value,
          barcode: (byId("pBarcode") as HTMLInputElement).value,
          categoryId,
          pricePesewas: toPesewas((byId("pPrice") as HTMLInputElement).value),
          costPricePesewas: toPesewas((byId("pCost") as HTMLInputElement).value),
          reorderLevel: Number((byId("pReorder") as HTMLInputElement).value || 0),
          prescriptionRequired: (byId("pRx") as HTMLInputElement).checked,
          controlledClass: (byId("pControlled") as HTMLSelectElement).value,
          perishable: (byId("pPerishable") as HTMLInputElement).checked,
        }),
      });
      closeModal();
      toast(`${name} added`);
      await loadCatalogue((document.getElementById("productSearch") as HTMLInputElement | null)?.value ?? "");
    } catch (err) {
      toast(err instanceof Error ? err.message : "Could not add the product", true);
    }
  });
}

/* ---- receiving stock ---- */

async function receiveModal(productId: string, productName: string): Promise<void> {
  if (!productId) return;
  let suppliers: { supplier_id: string; name: string }[] = [];
  try {
    suppliers = (await api<{ suppliers: { supplier_id: string; name: string }[] }>("/api/suppliers")).suppliers;
  } catch {
    /* none yet, or no permission */
  }

  openModal(`<h2>Receive stock</h2>
    <p style="color:var(--muted);font-size:13px;margin:-6px 0 14px">${esc(productName)} into ${esc(branchName())}.</p>
    <div class="inline">
      ${fld("Batch number", `<input id="bNumber" placeholder="PCM-26A">`)}
      ${fld("Expiry date", `<input id="bExpiry" type="date">`)}
      ${fld("Quantity", `<input id="bQty" type="number" min="1" placeholder="240">`)}
      ${fld("Supplier", `<select id="bSupplier"><option value="">— none —</option>${suppliers
        .map((s) => `<option value="${s.supplier_id}">${esc(s.name)}</option>`)
        .join("")}</select>`)}
      ${fld("Cost price (GHS)", `<input id="bCost" type="number" step="0.01" min="0" placeholder="leave blank to use the product's">`)}
      ${fld("Selling price (GHS)", `<input id="bPrice" type="number" step="0.01" min="0" placeholder="leave blank to use the product's">`)}
    </div>
    <div class="foot">
      <button class="btn ghost" id="cancel">Cancel</button>
      <button class="btn primary" id="save">Receive stock</button>
    </div>`);

  byId("cancel").addEventListener("click", closeModal);
  byId("save").addEventListener("click", async () => {
    const quantity = Number((byId("bQty") as HTMLInputElement).value || 0);
    const batchNumber = (byId("bNumber") as HTMLInputElement).value.trim();
    if (!batchNumber) {
      toast("Give the batch a number", true);
      return;
    }
    if (quantity <= 0) {
      toast("Quantity must be more than zero", true);
      return;
    }
    const cost = (byId("bCost") as HTMLInputElement).value;
    const price = (byId("bPrice") as HTMLInputElement).value;
    try {
      await api("/api/batches", {
        method: "POST",
        body: JSON.stringify({
          branchId,
          productId,
          batchNumber,
          expiryDate: (byId("bExpiry") as HTMLInputElement).value || null,
          quantity,
          supplierId: (byId("bSupplier") as HTMLSelectElement).value || null,
          ...(cost ? { costPricePesewas: toPesewas(cost) } : {}),
          ...(price ? { sellingPricePesewas: toPesewas(price) } : {}),
        }),
      });
      closeModal();
      toast(`${quantity} received`);
      if (view === "products") await loadCatalogue((document.getElementById("productSearch") as HTMLInputElement | null)?.value ?? "");
      else if (view === "stock") await loadStock((document.getElementById("stockSearch") as HTMLInputElement | null)?.value ?? "");
    } catch (err) {
      toast(err instanceof Error ? err.message : "Could not receive the stock", true);
    }
  });
}

/* ---- suppliers ---- */

async function renderSuppliers(): Promise<void> {
  byId("main").innerHTML = `<section class="card">
    <h2>Add a supplier</h2>
    <div class="inline">
      ${fld("Name", `<input id="sName" placeholder="Ernest Chemists Ltd">`)}
      ${fld("Phone", `<input id="sPhone" placeholder="+233 30 222 0000">`)}
      ${fld("Email", `<input id="sEmail" type="email">`)}
      ${fld("Address", `<input id="sAddress">`)}
    </div>
    <div class="foot"><button class="btn primary" id="saveSupplier">Add supplier</button></div>
  </section>
  <section class="card" style="margin-top:16px">
    <h2>Suppliers</h2>
    <div id="supplierList"><div class="empty">Loading…</div></div>
  </section>`;

  byId("saveSupplier").addEventListener("click", async () => {
    const name = (byId("sName") as HTMLInputElement).value.trim();
    if (!name) {
      toast("Give the supplier a name", true);
      return;
    }
    try {
      await api("/api/suppliers", {
        method: "POST",
        body: JSON.stringify({
          name,
          phone: (byId("sPhone") as HTMLInputElement).value,
          email: (byId("sEmail") as HTMLInputElement).value,
          address: (byId("sAddress") as HTMLInputElement).value,
        }),
      });
      toast(`${name} added`);
      renderSuppliers();
    } catch (err) {
      toast(err instanceof Error ? err.message : "Could not add the supplier", true);
    }
  });

  await loadSuppliers();
}

async function loadSuppliers(): Promise<void> {
  const box = document.getElementById("supplierList");
  if (!box) return;
  try {
    const data = await api<{ suppliers: { supplier_id: string; name: string; phone: string | null; email: string | null; address: string | null }[] }>("/api/suppliers");
    if (!data.suppliers.length) {
      box.innerHTML = `<div class="empty">No suppliers yet.</div>`;
      return;
    }
    box.innerHTML = `<table><thead><tr><th>Supplier</th><th>Phone</th><th>Email</th><th>Address</th></tr></thead><tbody>
      ${data.suppliers
        .map(
          (s) => `<tr><td><b>${esc(s.name)}</b></td><td>${esc(s.phone ?? "—")}</td><td>${esc(s.email ?? "—")}</td><td>${esc(s.address ?? "—")}</td></tr>`,
        )
        .join("")}
    </tbody></table>`;
  } catch (err) {
    box.innerHTML = `<div class="empty">${esc(err instanceof Error ? err.message : "Could not load suppliers")}</div>`;
  }
}

/* ---- staff and branches ---- */

async function renderTeam(): Promise<void> {
  byId("main").innerHTML = `<section class="card">
    <h2>Add someone to the team</h2>
    <div class="inline">
      ${fld("Name", `<input id="uName" placeholder="Ama Boateng">`)}
      ${fld("Email", `<input id="uEmail" type="email" placeholder="ama@pharmacy.com">`)}
      ${fld("Password", `<input id="uPassword" type="text" placeholder="at least 8 characters">`)}
      ${fld("Role", `<select id="uRole"><option value="salesperson">Salesperson — sells only</option><option value="admin">Administrator — stock, products, sales, reports</option></select>`)}
      ${fld("Branch", `<select id="uBranch"><option value="">All branches</option>${(session?.branches ?? [])
        .map((b) => `<option value="${b.branch_id}"${b.branch_id === branchId ? " selected" : ""}>${esc(b.name)}</option>`)
        .join("")}</select>`)}
    </div>
    <div class="foot"><button class="btn primary" id="saveStaff">Add account</button></div>
  </section>

  <section class="card" style="margin-top:16px">
    <h2>Team</h2>
    <div id="staffList"><div class="empty">Loading…</div></div>
  </section>

  <section class="card" style="margin-top:16px">
    <h2>Branches</h2>
    <div class="inline">
      ${fld("Name", `<input id="brName" placeholder="Adabraka Branch">`)}
      ${fld("Address", `<input id="brAddress" placeholder="Adabraka, Accra">`)}
    </div>
    <div class="foot"><button class="btn primary" id="saveBranch">Add branch</button></div>
    <div id="branchList" style="margin-top:12px"></div>
  </section>`;

  byId("saveStaff").addEventListener("click", async () => {
    const name = (byId("uName") as HTMLInputElement).value.trim();
    const email = (byId("uEmail") as HTMLInputElement).value.trim();
    const password = (byId("uPassword") as HTMLInputElement).value;
    if (!name || !email || !password) {
      toast("Name, email and password are all needed", true);
      return;
    }
    try {
      await api("/api/staff", {
        method: "POST",
        body: JSON.stringify({
          name,
          email,
          password,
          role: (byId("uRole") as HTMLSelectElement).value,
          branchId: (byId("uBranch") as HTMLSelectElement).value || null,
        }),
      });
      toast(`${name} can now sign in`);
      renderTeam();
    } catch (err) {
      toast(err instanceof Error ? err.message : "Could not add the account", true);
    }
  });

  byId("saveBranch").addEventListener("click", async () => {
    const name = (byId("brName") as HTMLInputElement).value.trim();
    if (!name) {
      toast("Give the branch a name", true);
      return;
    }
    try {
      await api("/api/branches", {
        method: "POST",
        body: JSON.stringify({ name, address: (byId("brAddress") as HTMLInputElement).value }),
      });
      toast(`${name} added`);
      // The new branch changes the session payload, so refresh it before redrawing.
      session = await api<Session>("/api/session");
      renderApp();
    } catch (err) {
      toast(err instanceof Error ? err.message : "Could not add the branch", true);
    }
  });

  await loadStaff();
  renderBranchList();
}

async function loadStaff(): Promise<void> {
  const box = document.getElementById("staffList");
  if (!box) return;
  try {
    const data = await api<{ staff: { user_id: string; name: string; email: string; role: string; branch_id: string | null }[] }>("/api/staff");
    const branchOf = (id: string | null): string =>
      id ? (session?.branches.find((b) => b.branch_id === id)?.name ?? "—") : "All branches";
    box.innerHTML = `<table><thead><tr><th>Name</th><th>Email</th><th>Role</th><th>Branch</th></tr></thead><tbody>
      ${data.staff
        .map(
          (u) => `<tr><td><b>${esc(u.name)}</b></td><td>${esc(u.email)}</td><td>${esc(u.role)}</td><td>${esc(branchOf(u.branch_id))}</td></tr>`,
        )
        .join("")}
    </tbody></table>`;
  } catch (err) {
    box.innerHTML = `<div class="empty">${esc(err instanceof Error ? err.message : "Could not load the team")}</div>`;
  }
}

function renderBranchList(): void {
  const box = document.getElementById("branchList");
  if (!box || !session) return;
  const plan = session.tenant.plan.name;
  box.innerHTML = `<table><thead><tr><th>Branch</th><th>Address</th></tr></thead><tbody>
    ${session.branches
      .map((b) => `<tr><td><b>${esc(b.name)}</b></td><td>${esc(b.address ?? "—")}</td></tr>`)
      .join("")}
  </tbody></table>
  <div class="note">The ${esc(plan)} plan allows ${session.tenant.usage.shops} branch${
    session.tenant.usage.shops === 1 ? "" : "es"
  } right now.</div>`;
}


/* ---- importing an existing catalogue ---- */

function importModal(): void {
  openModal(
    `<h2>Import a catalogue</h2>
    <p style="color:var(--muted);font-size:13px;margin:-6px 0 14px">
      Paste your product list or choose a CSV file. Columns are matched by name, so
      <b>Item</b>, <b>Qty</b>, <b>SP</b>, <b>Batch</b> and <b>Expiry</b> all work.
      Nothing is saved until you have seen the preview.
    </p>
    <div class="fld"><label>CSV file</label><input id="csvFile" type="file" accept=".csv,text/csv,text/plain"></div>
    <div class="fld" style="margin-top:10px"><label>Or paste it here</label>
      <textarea id="csvText" rows="7" spellcheck="false" style="border:1px solid var(--line);border-radius:9px;padding:8px 10px;background:#fcfcfe;width:100%;font-family:'Courier New',monospace;font-size:12.5px" placeholder="Name,Price,Qty,Expiry&#10;Paracetamol 500mg,5.00,240,30/06/2027"></textarea>
    </div>
    <div id="importReport"></div>
    <div class="foot">
      <button class="btn ghost" id="cancel">Cancel</button>
      <button class="btn" id="preview">Preview</button>
      <button class="btn primary" id="commit" disabled>Import</button>
    </div>`,
    true,
  );

  const csvText = byId<HTMLTextAreaElement>("csvText");
  const commit = byId<HTMLButtonElement>("commit");

  byId("cancel").addEventListener("click", closeModal);

  byId("csvFile").addEventListener("change", async (event) => {
    const file = (event.target as HTMLInputElement).files?.[0];
    if (!file) return;
    csvText.value = await file.text();
    commit.disabled = true;
    toast(`${file.name} loaded`);
  });

  csvText.addEventListener("input", () => {
    // The preview described the old text, so it no longer applies.
    commit.disabled = true;
  });

  const send = async (dryRun: boolean): Promise<ImportReport> => {
    const body = await api<{ report: ImportReport }>("/api/products/import", {
      method: "POST",
      body: JSON.stringify({ csv: csvText.value, branchId, dryRun }),
    });
    return body.report;
  };

  byId("preview").addEventListener("click", async () => {
    if (!csvText.value.trim()) {
      toast("Paste your list or choose a file first", true);
      return;
    }
    try {
      const report = await send(true);
      renderImportReport(report, false);
      commit.disabled = report.ok === 0;
      commit.textContent = report.ok ? `Import ${report.ok}` : "Import";
    } catch (err) {
      toast(err instanceof Error ? err.message : "Could not read that file", true);
    }
  });

  commit.addEventListener("click", async () => {
    try {
      const report = await send(false);
      renderImportReport(report, true);
      commit.disabled = true;
      commit.textContent = "Imported";
      toast(`${report.ok} product${report.ok === 1 ? "" : "s"} imported`);
      // The report is worth reading, so leave it up — but the way out should say so.
      byId("cancel").textContent = "Close";
      byId("cancel").className = "btn primary";
      await loadCatalogue("");
    } catch (err) {
      toast(err instanceof Error ? err.message : "The import failed", true);
    }
  });
}

function renderImportReport(report: ImportReport, committed: boolean): void {
  const box = document.getElementById("importReport");
  if (!box) return;
  const matched = Object.entries(report.mapping)
    .map(([field, header]) => `${field} \u2190 ${header}`)
    .join("  ·  ");
  const shown = report.rows.slice(0, 300);

  box.innerHTML = `<div style="margin-top:16px;padding-top:12px;border-top:1px dashed var(--line)">
    <b style="font-size:13.5px">${committed ? "Imported" : "Preview"}: ${report.total} rows read, ${report.ok} ${
      committed ? "imported" : "to import"
    }${report.errors ? `, ${report.errors} with problems` : ""}${report.skipped ? `, ${report.skipped} skipped` : ""}.</b>
    <div style="font-size:11.5px;color:var(--muted);margin:6px 0 10px">Columns matched: ${esc(matched || "none")}</div>
    <div style="max-height:300px;overflow:auto">
      <table><thead><tr><th>Line</th><th>Product</th><th>What happens</th></tr></thead><tbody>
      ${shown
        .map((row) => {
          const badge =
            row.status === "ok"
              ? `<span class="badge b-ok">${committed ? "added" : "ok"}</span>`
              : row.status === "skipped"
                ? `<span class="badge b-mute">skip</span>`
                : `<span class="badge b-out">error</span>`;
          const detail = row.preview
            ? `${money(row.preview.price)}${row.preview.quantity ? ` · ${row.preview.quantity} in stock` : ""}${
                row.preview.expiry ? ` · exp ${esc(row.preview.expiry)}` : ""
              }`
            : "";
          return `<tr>
            <td>${row.line}</td>
            <td><b>${esc(row.name)}</b>${detail ? `<br><span style="font-size:11.5px;color:var(--muted)">${detail}</span>` : ""}</td>
            <td>${badge} ${esc(row.message)}${
              row.notes?.length ? `<br><span style="font-size:11.5px;color:var(--muted)">${esc(row.notes.join("; "))}</span>` : ""
            }</td>
          </tr>`;
        })
        .join("")}
      </tbody></table>
    </div>
    ${report.rows.length > shown.length ? `<div class="note">Showing the first ${shown.length} rows.</div>` : ""}
  </div>`;
}

async function boot(): Promise<void> {
  // Offline support is a bonus, never a requirement: if the browser refuses the
  // service worker the counter still works exactly as it did.
  if ("serviceWorker" in navigator) {
    navigator.serviceWorker.register("/sw.js").catch(() => {});
  }
  window.addEventListener("online", () => {
    noteFreshness(null);
    void syncQueue();
  });
  // While anything is waiting, keep trying: a connection can come back without the
  // browser announcing it.
  window.setInterval(() => void syncQueue(), 20000);

  // Somebody followed a link out of their email. They are not signed in, and must
  // not need to be. This comes before anything else, because it is the whole point.
  const resetToken = new URLSearchParams(window.location.search).get("reset");
  if (resetToken) {
    await renderReset(resetToken);
    return;
  }

  if (!token) {
    renderLogin();
    return;
  }

  try {
    session = await api<Session>("/api/session");
    await localPut(LOCAL_STORE, "session", { at: Date.now(), session }).catch(() => {});
    branchId = session.branches[0]?.branch_id ?? "";
    renderApp();
    void syncQueue();
    return;
  } catch {
    // A network failure is not a signed-out cashier. Losing the till because the
    // internet blinked would be worse than showing figures that might be stale, so
    // fall back to the session we were last given — and only if there is none, or
    // the server actively rejected the token, is this a sign-out.
    const held = await localGet<{ at: number; session: Session }>(LOCAL_STORE, "session").catch(() => null);
    if (held?.session) {
      session = held.session;
      branchId = session.branches[0]?.branch_id ?? "";
      renderApp();
      noteFreshness(held.at);
      return;
    }
  }
  signOut();
}

void boot();
