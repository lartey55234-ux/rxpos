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
};

type ProductRow = {
  product_id: string;
  name: string;
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

type CartLine = { productId: string; quantity: number; name: string; price: number; controlled: boolean; needsRx: boolean; sellable: number };

const byId = <T extends HTMLElement = HTMLElement>(id: string): T => document.getElementById(id) as T;
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
  const res = await fetch(path, {
    ...init,
    headers: {
      "content-type": "application/json",
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(init.headers ?? {}),
    },
  });
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

function openModal(html: string): void {
  const modal = byId("modal");
  modal.innerHTML = `<div class="sheet">${html}</div>`;
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

function renderLogin(): void {
  byId("app").innerHTML = `<div class="login"><div class="card">
    <h1>rxpos</h1>
    <p>Counter, stock and expiry for pharmacies.</p>
    <div class="fld"><label>Email</label><input id="email" type="email" autocomplete="username"></div>
    <div class="fld" style="margin-top:10px"><label>Password</label><input id="password" type="password" autocomplete="current-password"></div>
    <button class="btn primary" id="signIn" style="width:100%;margin-top:16px">Sign in</button>
  </div></div>`;

  const submit = async (): Promise<void> => {
    try {
      const body = await api<{ token: string } & Session>("/api/login", {
        method: "POST",
        body: JSON.stringify({
          email: (byId("email") as HTMLInputElement).value,
          password: (byId("password") as HTMLInputElement).value,
        }),
      });
      token = body.token;
      localStorage.setItem("rxpos.token", token);
      session = body;
      branchId = body.branches[0]?.branch_id ?? "";
      view = "counter";
      renderApp();
    } catch (err) {
      toast(err instanceof Error ? err.message : "Sign in failed", true);
    }
  };

  byId("signIn").addEventListener("click", submit);
  byId("password").addEventListener("keydown", (event) => {
    if ((event as KeyboardEvent).key === "Enter") void submit();
  });
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
        <button class="btn sm ghost" id="signOut">Sign out</button>
      </div>
    </header>
    <main id="main"></main>
  </div>`;

  byId("signOut").addEventListener("click", signOut);
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
}

function renderView(): void {
  if (view === "counter") renderCounter();
  else if (view === "stock") renderStock();
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
    const data = await api<{ products: ProductRow[] }>(
      `/api/products?branchId=${encodeURIComponent(branchId)}&q=${encodeURIComponent(query)}`,
    );
    products = data.products;
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
  try {
    const result = await api<{ receipt: Receipt }>("/api/sales", {
      method: "POST",
      body: JSON.stringify({
        branchId,
        lines: cart.map((line) => ({ productId: line.productId, quantity: line.quantity })),
        paymentMethod: method,
        amountTenderedPesewas: tendered,
        discountPesewas: cartTotals().discount,
        prescriptionId,
      }),
    });
    cart = [];
    discountPesewas = 0;
    prescriptionId = null;
    prescriptionLabel = "";
    renderCart();
    void loadProducts();
    showReceipt(result.receipt);
  } catch (err) {
    toast(err instanceof Error ? err.message : "The sale could not be completed", true);
  }
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
    box.innerHTML = `<table><thead><tr><th>Product</th><th>Barcode</th><th class="num">Sellable</th><th class="num">On hand</th><th>Nearest expiry</th><th class="num">Price</th></tr></thead><tbody>
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
          </tr>`;
        })
        .join("")}
    </tbody></table>`;
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

async function boot(): Promise<void> {
  if (!token) {
    renderLogin();
    return;
  }
  try {
    session = await api<Session>("/api/session");
    branchId = session.branches[0]?.branch_id ?? "";
    renderApp();
  } catch {
    signOut();
  }
}

void boot();
