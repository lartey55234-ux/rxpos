// src/client/app.ts
var byId = (id) => document.getElementById(id);
var money = (pesewas) => `GHS ${(pesewas / 100).toFixed(2)}`;
var esc = (value) => String(value ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
var token = localStorage.getItem("rxpos.token") ?? "";
var session = null;
var branchId = "";
var view = "counter";
var cart = [];
var discountPesewas = 0;
var prescriptionId = null;
var prescriptionLabel = "";
var query = "";
var products = [];
async function api(path, init = {}) {
  const res = await fetch(path, {
    ...init,
    headers: {
      "content-type": "application/json",
      ...token ? { authorization: `Bearer ${token}` } : {},
      ...init.headers ?? {}
    }
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    if (res.status === 401) signOut();
    throw new Error(String(body.error ?? res.statusText));
  }
  return body;
}
function toast(message, isError = false) {
  const node = byId("toast");
  node.textContent = message;
  node.className = `toast on${isError ? " err" : ""}`;
  window.setTimeout(() => node.className = "toast", 3200);
}
function openModal(html) {
  const modal = byId("modal");
  modal.innerHTML = `<div class="sheet">${html}</div>`;
  modal.classList.remove("hidden");
}
function closeModal() {
  const modal = byId("modal");
  modal.classList.add("hidden");
  modal.innerHTML = "";
}
function signOut() {
  token = "";
  session = null;
  localStorage.removeItem("rxpos.token");
  authMode = "signin";
  renderLogin();
}
function debounce(fn, ms) {
  let handle = 0;
  return ((...args) => {
    window.clearTimeout(handle);
    handle = window.setTimeout(() => fn(...args), ms);
  });
}
var authMode = "signin";
var PLANS = [
  { id: "free", label: "Free \u2014 20 products, 1 shop" },
  { id: "starter", label: "Starter \u2014 GHS 60/month" },
  { id: "standard", label: "Standard \u2014 GHS 100/month" },
  { id: "pro", label: "Pro \u2014 GHS 150/month" }
];
function renderLogin() {
  byId("app").innerHTML = authMode === "signin" ? `<div class="login"><div class="card">
          <h1>rxpos</h1>
          <p>Counter, stock and expiry for pharmacies.</p>
          <div class="fld"><label>Email</label><input id="email" type="email" autocomplete="username"></div>
          <div class="fld" style="margin-top:10px"><label>Password</label><input id="password" type="password" autocomplete="current-password"></div>
          <button class="btn primary" id="submit" style="width:100%;margin-top:16px">Sign in</button>
          <button class="btn ghost" id="swap" style="width:100%;margin-top:8px">New pharmacy? Create an account</button>
        </div></div>` : `<div class="login wide"><div class="card">
          <h1>Create your pharmacy</h1>
          <p>You can add staff and stock as soon as you are in.</p>
          <div class="fld"><label>Pharmacy name</label><input id="pharmacyName" type="text" autocomplete="organization"></div>
          <div class="fld" style="margin-top:10px"><label>Your name</label><input id="ownerName" type="text" autocomplete="name"></div>
          <div class="fld" style="margin-top:10px"><label>Email</label><input id="email" type="email" autocomplete="username"></div>
          <div class="fld" style="margin-top:10px"><label>Password</label><input id="password" type="password" autocomplete="new-password"></div>
          <div class="fld" style="margin-top:10px"><label>Branch name</label><input id="branchName" type="text" placeholder="Main Pharmacy"></div>
          <div class="fld" style="margin-top:10px"><label>Plan</label><select id="planId">${PLANS.map(
    (plan) => `<option value="${plan.id}"${plan.id === "starter" ? " selected" : ""}>${esc(plan.label)}</option>`
  ).join("")}</select></div>
          <button class="btn primary" id="submit" style="width:100%;margin-top:16px">Create pharmacy</button>
          <button class="btn ghost" id="swap" style="width:100%;margin-top:8px">Already have an account? Sign in</button>
        </div></div>`;
  const submit = async () => {
    const signingIn = authMode === "signin";
    const email = byId("email").value;
    const password = byId("password").value;
    const payload = signingIn ? { email, password } : {
      email,
      password,
      pharmacyName: byId("pharmacyName").value,
      ownerName: byId("ownerName").value,
      branchName: byId("branchName").value,
      planId: byId("planId").value
    };
    try {
      const body = await api(signingIn ? "/api/login" : "/api/signup", {
        method: "POST",
        body: JSON.stringify(payload)
      });
      token = body.token;
      localStorage.setItem("rxpos.token", token);
      session = body;
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
  byId("password").addEventListener("keydown", (event) => {
    if (event.key === "Enter") void submit();
  });
}
function branchName() {
  return session?.branches.find((b) => b.branch_id === branchId)?.name ?? "\u2014";
}
function renderApp() {
  if (!session) return;
  const tabs = [
    { id: "counter", label: "Counter" },
    { id: "stock", label: "Stock" },
    ...session.permissions.products ? [{ id: "products", label: "Products" }] : [],
    ...session.permissions.suppliers ? [{ id: "suppliers", label: "Suppliers" }] : [],
    ...session.permissions.users ? [{ id: "team", label: "Team" }] : [],
    { id: "alerts", label: "Alerts" },
    ...session.permissions.reports ? [{ id: "register", label: "Register" }] : [],
    ...session.permissions.reports ? [{ id: "reports", label: "Reports" }] : []
  ];
  byId("app").innerHTML = `<div class="app">
    <header class="topbar">
      <div class="brand"><span class="mark">Rx</span><div>
        <b>${esc(session.tenant.name)}</b>
        <span>${esc(session.tenant.plan.name)} plan \xB7 ${esc(session.user.name)} \xB7 ${esc(session.user.role)}</span>
      </div></div>
      <nav class="tabs">${tabs.map((t) => `<button data-tab="${t.id}" class="${view === t.id ? "on" : ""}">${t.label}</button>`).join("")}</nav>
      <div class="ctx">
        <label>Branch <select id="branchSel">${session.branches.map((b) => `<option value="${b.branch_id}"${b.branch_id === branchId ? " selected" : ""}>${esc(b.name)}</option>`).join("")}</select></label>
        <button class="btn sm ghost" id="signOut">Sign out</button>
      </div>
    </header>
    <main id="main"></main>
  </div>`;
  byId("signOut").addEventListener("click", signOut);
  byId("branchSel").addEventListener("change", (event) => {
    branchId = event.target.value;
    cart = [];
    prescriptionId = null;
    renderApp();
  });
  byId("app").addEventListener("click", (event) => {
    const tab = event.target.closest("[data-tab]");
    if (!tab) return;
    view = tab.getAttribute("data-tab") ?? "counter";
    renderApp();
  });
  renderView();
}
function renderView() {
  if (view === "counter") renderCounter();
  else if (view === "stock") renderStock();
  else if (view === "products") void renderProducts();
  else if (view === "suppliers") void renderSuppliers();
  else if (view === "team") void renderTeam();
  else if (view === "alerts") renderAlerts();
  else if (view === "register") renderRegister();
  else renderReports();
}
function renderCounter() {
  byId("main").innerHTML = `<section class="grid counter">
    <div class="card">
      <h2>Counter <span class="badge b-mute">${esc(branchName())}</span></h2>
      <div class="scanrow">
        <input id="scan" placeholder="Scan a barcode, or type a product name, then press Enter" autocomplete="off">
        <button class="btn ghost" id="clearSearch">Clear</button>
      </div>
      <div class="rows" id="results"><div class="empty">Loading\u2026</div></div>
    </div>
    <aside class="card cart">
      <h2>Sale <button class="btn sm ghost" id="clearCart">Clear</button></h2>
      <div class="lines" id="lines"></div>
      <div id="cartFoot"></div>
    </aside>
  </section>`;
  const scan = byId("scan");
  scan.focus();
  scan.addEventListener(
    "input",
    debounce(() => {
      query = scan.value;
      void loadProducts();
    }, 160)
  );
  scan.addEventListener("keydown", (event) => {
    if (event.key !== "Enter") return;
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
async function loadProducts() {
  const box = document.getElementById("results");
  if (!box) return;
  try {
    const data = await api(
      `/api/products?branchId=${encodeURIComponent(branchId)}&q=${encodeURIComponent(query)}`
    );
    products = data.products;
    if (!products.length) {
      box.innerHTML = `<div class="empty">No product matches "${esc(query)}"</div>`;
      return;
    }
    box.innerHTML = products.map((p) => {
      const badges = [];
      if (p.sellable <= 0) badges.push(`<span class="badge b-out">${p.on_hand > 0 ? "expired only" : "out of stock"}</span>`);
      else if (p.sellable <= p.reorder_level) badges.push(`<span class="badge b-low">low \xB7 ${p.sellable} left</span>`);
      else badges.push(`<span class="badge b-ok">${p.sellable} in stock</span>`);
      if (p.controlled_class !== "none") badges.push(`<span class="badge b-exp">Class ${p.controlled_class}</span>`);
      else if (p.prescription_required) badges.push(`<span class="badge b-rx">Rx</span>`);
      if (p.nearest_expiry) badges.push(`<span class="badge b-mute">exp ${esc(p.nearest_expiry)}</span>`);
      return `<button class="row" data-add="${p.product_id}"${p.sellable <= 0 ? " disabled style=opacity:.55" : ""}>
          <span class="nm"><b>${esc(p.name)} ${esc(p.strength)}</b><span>${esc(p.form)} \xB7 ${esc(p.barcode ?? "no barcode")}</span></span>
          ${badges.join("")}<span class="price">${money(p.price_pesewas)}</span></button>`;
    }).join("");
  } catch (err) {
    box.innerHTML = `<div class="empty">${esc(err instanceof Error ? err.message : "Could not load products")}</div>`;
  }
}
function addToCart(product) {
  if (product.controlled_class !== "none" && !session?.permissions.dispense_controlled) {
    toast(`${product.name} is a Class ${product.controlled_class} controlled drug \u2014 your role cannot dispense it`, true);
    return;
  }
  if (product.sellable <= 0) {
    toast(
      `${product.name} has no sellable stock in ${branchName()}${product.on_hand > 0 ? " \u2014 the remaining batches are expired" : ""}`,
      true
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
      sellable: product.sellable
    });
  }
  renderCart();
}
function cartTotals() {
  const subtotal = cart.reduce((sum, line) => sum + line.price * line.quantity, 0);
  const discount = Math.min(discountPesewas, subtotal);
  return { subtotal, discount, total: subtotal - discount };
}
function renderCart() {
  const lines = document.getElementById("lines");
  const foot = document.getElementById("cartFoot");
  if (!lines || !foot) return;
  if (!cart.length) {
    lines.innerHTML = `<div class="empty">Scan or search a product to start a sale.</div>`;
    foot.innerHTML = `<div class="totals"><div class="tline grand"><span>Total</span><span>GHS 0.00</span></div></div>`;
    return;
  }
  lines.innerHTML = cart.map(
    (line) => `<div class="cline">
        <span><b>${esc(line.name)}</b><span>${money(line.price)} each${line.controlled ? " \xB7 controlled" : ""}</span></span>
        <span class="qty"><button data-dec="${line.productId}">\u2212</button><b>${line.quantity}</b><button data-inc="${line.productId}">+</button></span>
        <span class="price">${money(line.price * line.quantity)}</span>
      </div>`
  ).join("");
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
    discountPesewas = Math.round(Number(event.target.value || 0) * 100);
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
function refreshChange() {
  const tender = document.getElementById("tender");
  const change = document.getElementById("change");
  if (!tender || !change) return;
  change.textContent = money(Math.max(0, Math.round(Number(tender.value || 0) * 100) - cartTotals().total));
}
function prescriptionModal() {
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
      const number = byId("rxNumber").value.trim();
      const patient = byId("rxPatient").value.trim();
      const prescriber = byId("rxPrescriber").value.trim();
      if (!number || !patient || !prescriber) {
        toast("Prescription number, patient and prescriber are required", true);
        return;
      }
      const created = await api("/api/prescriptions", {
        method: "POST",
        body: JSON.stringify({
          branchId,
          prescriptionNumber: number,
          patientName: patient,
          patientAddress: byId("rxAddress").value.trim() || null,
          prescriberName: prescriber
        })
      });
      prescriptionId = created.prescriptionId;
      prescriptionLabel = `${number} \xB7 ${patient}`;
      closeModal();
      renderCart();
    } catch (err) {
      toast(err instanceof Error ? err.message : "Could not attach the prescription", true);
    }
  });
}
async function completeSale() {
  if (!cart.length) return;
  const method = byId("method").value;
  const tendered = Math.round(Number(byId("tender").value || 0) * 100);
  try {
    const result = await api("/api/sales", {
      method: "POST",
      body: JSON.stringify({
        branchId,
        lines: cart.map((line) => ({ productId: line.productId, quantity: line.quantity })),
        paymentMethod: method,
        amountTenderedPesewas: tendered,
        discountPesewas: cartTotals().discount,
        prescriptionId
      })
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
function receiptHTML(receipt) {
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
    ${receipt.lines.map(
    (line) => `<div class="r"><span>${esc(line.name)} ${esc(line.strength ?? "")}<br>&nbsp;&nbsp;${line.quantity} \xD7 ${money(line.unitPricePesewas)} <span style="font-size:10.5px">(batch ${esc(line.batchNumber)})</span></span><span>${money(line.lineTotalPesewas)}</span></div>`
  ).join("")}
    <hr>
    <div class="r"><span>Subtotal</span><span>${money(receipt.subtotalPesewas)}</span></div>
    ${receipt.discountPesewas ? `<div class="r"><span>Discount</span><span>\u2212${money(receipt.discountPesewas)}</span></div>` : ""}
    <div class="r"><b>TOTAL</b><b>${money(receipt.totalPesewas)}</b></div>
    <div class="r"><span>Paid (${esc(receipt.paymentMethod)})</span><span>${money(receipt.amountTenderedPesewas)}</span></div>
    <div class="r"><span>Change</span><span>${money(receipt.changePesewas)}</span></div>
    ${receipt.controlled.length ? `<hr><div style="font-size:11px">Controlled drugs supplied \u2014 recorded in the register:<br>${receipt.controlled.map((c) => `${esc(c.name)} \xD7 ${c.quantity} (batch ${esc(c.batchNumber)})`).join("<br>")}</div>` : ""}
    <hr><div style="text-align:center;font-size:11px">Thank you \u2014 get well soon.</div>
  </div>`;
}
function showReceipt(receipt) {
  openModal(`<h2>Sale complete</h2>${receiptHTML(receipt)}
    <div class="foot"><button class="btn ghost" id="mClose">Close</button><button class="btn primary" id="mPrint">Print receipt</button></div>`);
  byId("mClose").addEventListener("click", closeModal);
  byId("mPrint").addEventListener("click", () => {
    byId("printArea").innerHTML = receiptHTML(receipt);
    window.print();
  });
}
async function renderStock() {
  byId("main").innerHTML = `<section class="card">
    <h2>Stock <span class="badge b-mute">${esc(branchName())}</span></h2>
    <div class="scanrow"><input id="stockSearch" placeholder="Filter by name or barcode" autocomplete="off"></div>
    <div id="stockTable"><div class="empty">Loading\u2026</div></div>
  </section>`;
  const search = byId("stockSearch");
  search.addEventListener(
    "input",
    debounce(() => void loadStock(search.value), 160)
  );
  await loadStock("");
}
async function loadStock(filter) {
  const box = document.getElementById("stockTable");
  if (!box) return;
  try {
    const data = await api(
      `/api/products?branchId=${encodeURIComponent(branchId)}&q=${encodeURIComponent(filter)}`
    );
    if (!data.products.length) {
      box.innerHTML = `<div class="empty">Nothing matches that filter.</div>`;
      return;
    }
    box.innerHTML = `<table><thead><tr><th>Product</th><th>Barcode</th><th class="num">Sellable</th><th class="num">On hand</th><th>Nearest expiry</th><th class="num">Price</th><th></th></tr></thead><tbody>
      ${data.products.map((p) => {
      const status = p.sellable <= 0 ? `<span class="badge b-out">${p.on_hand > 0 ? "expired only" : "out"}</span>` : p.sellable <= p.reorder_level ? `<span class="badge b-low">low</span>` : `<span class="badge b-ok">ok</span>`;
      return `<tr>
            <td><b>${esc(p.name)}</b> <span style="color:var(--muted)">${esc(p.strength ?? "")}</span>${p.controlled_class !== "none" ? ` <span class="badge b-exp">Class ${p.controlled_class}</span>` : p.prescription_required ? ` <span class="badge b-rx">Rx</span>` : ""}</td>
            <td>${esc(p.barcode ?? "\u2014")}</td>
            <td class="num"><b>${p.sellable}</b> ${status}</td>
            <td class="num">${p.on_hand}${p.on_hand !== p.sellable ? `<br><span style="font-size:11px;color:var(--muted)">+${p.on_hand - p.sellable} expired</span>` : ""}</td>
            <td>${p.nearest_expiry ? esc(p.nearest_expiry) : `<span class="badge b-mute">non-perishable</span>`}</td>
            <td class="num">${money(p.price_pesewas)}</td>
            <td class="num">${session?.permissions.stock ? `<button class="btn sm ghost" data-receive="${p.product_id}" data-name="${esc(p.name)}">Receive</button>` : ""}</td>
          </tr>`;
    }).join("")}
    </tbody></table>`;
    box.querySelectorAll("[data-receive]").forEach(
      (btn) => btn.addEventListener(
        "click",
        () => void receiveModal(btn.getAttribute("data-receive") ?? "", btn.getAttribute("data-name") ?? "")
      )
    );
  } catch (err) {
    box.innerHTML = `<div class="empty">${esc(err instanceof Error ? err.message : "Could not load stock")}</div>`;
  }
}
async function renderAlerts() {
  byId("main").innerHTML = `<div id="alertBody"><div class="card"><div class="empty">Loading\u2026</div></div></div>`;
  try {
    const data = await api(`/api/alerts?branchId=${encodeURIComponent(branchId)}`);
    const list = (title, rows, tone) => `<div class="card" style="margin-bottom:14px">
      <h2>${title} <span class="badge ${rows.length ? tone : "b-ok"}">${rows.length}</span></h2>
      ${rows.length ? `<div class="rows">${rows.join("")}</div>` : `<div class="empty">All clear.</div>`}
    </div>`;
    byId("alertBody").innerHTML = [
      list(
        "Expired batches",
        data.expired.map(
          (row) => `<div class="row"><span class="nm"><b>${esc(row.product)}</b><span>Batch ${esc(row.batch_number)} \xB7 expired ${esc(row.expiry_date)}</span></span><span class="badge b-exp">${row.quantity} units</span></div>`
        ),
        "b-exp"
      ),
      list(
        "Expiring within 90 days",
        data.expiring.map(
          (row) => `<div class="row"><span class="nm"><b>${esc(row.product)}</b><span>Batch ${esc(row.batch_number)}</span></span><span class="badge b-soon">${esc(row.expiry_date)}</span><span class="badge b-mute">${row.quantity} units</span></div>`
        ),
        "b-soon"
      ),
      list(
        "At or below reorder level",
        data.low.map(
          (row) => `<div class="row"><span class="nm"><b>${esc(row.name)}</b><span>Reorder at ${row.reorder_level}</span></span><span class="badge b-low">${row.on_hand} on hand</span></div>`
        ),
        "b-low"
      )
    ].join("");
  } catch (err) {
    byId("alertBody").innerHTML = `<div class="card"><div class="empty">${esc(err instanceof Error ? err.message : "Could not load alerts")}</div></div>`;
  }
}
async function renderRegister() {
  const today = (/* @__PURE__ */ new Date()).toISOString().slice(0, 10);
  byId("main").innerHTML = `<section class="card">
    <h2>Controlled Drugs Register <span class="badge b-mute">${esc(branchName())}</span></h2>
    <div class="inline" style="max-width:420px;margin-bottom:12px">
      <div class="fld"><label>From</label><input id="regFrom" type="date" value="${today}"></div>
      <div class="fld"><label>To</label><input id="regTo" type="date" value="${today}"></div>
    </div>
    <div id="regTable"><div class="empty">Loading\u2026</div></div>
  </section>`;
  const reload = () => void loadRegister();
  byId("regFrom").addEventListener("change", reload);
  byId("regTo").addEventListener("change", reload);
  await loadRegister();
}
async function loadRegister() {
  const box = document.getElementById("regTable");
  if (!box) return;
  const from = byId("regFrom").value;
  const to = byId("regTo").value;
  try {
    const data = await api(
      `/api/register?branchId=${encodeURIComponent(branchId)}&from=${from}&to=${to}`
    );
    if (!data.entries.length) {
      box.innerHTML = `<div class="empty">No register entries in this period.</div>`;
      return;
    }
    box.innerHTML = `<table><thead><tr><th>Date</th><th>Direction</th><th>Drug</th><th>Batch</th><th class="num">Qty</th><th>Recipient</th><th>Dispenser</th><th>Reference</th></tr></thead><tbody>
      ${data.entries.map(
      (entry) => `<tr>
            <td>${esc(entry.entry_date)}</td>
            <td><span class="badge ${entry.direction === "supplied" ? "b-exp" : "b-ok"}">${esc(entry.direction)}</span></td>
            <td><b>${esc(entry.product)}</b> <span style="color:var(--muted)">${esc(entry.strength ?? "")}</span></td>
            <td>${esc(entry.batch_number ?? "\u2014")}</td>
            <td class="num">${esc(entry.quantity)}</td>
            <td>${esc(entry.recipient_name ?? "\u2014")}${entry.recipient_address ? `<br><span style="font-size:11px;color:var(--muted)">${esc(entry.recipient_address)}</span>` : ""}</td>
            <td>${esc(entry.dispenser)}</td>
            <td>${esc(entry.prescription_id ? "prescription" : entry.reference_type ?? "\u2014")}</td>
          </tr>`
    ).join("")}
    </tbody></table>
    <div class="note">Append-only. Records are kept and available for inspection for at least two years.</div>`;
  } catch (err) {
    box.innerHTML = `<div class="empty">${esc(err instanceof Error ? err.message : "Could not load the register")}</div>`;
  }
}
async function renderReports() {
  byId("main").innerHTML = `<div id="reportBody"><div class="card"><div class="empty">Loading\u2026</div></div></div>`;
  try {
    const data = await api(`/api/reports?branchId=${encodeURIComponent(branchId)}`);
    byId("reportBody").innerHTML = `
      <div class="kpis">
        <div class="kpi"><span>Today</span><b>${money(data.today.revenuePesewas)}</b><i>${data.today.transactions} transactions</i></div>
        <div class="kpi"><span>Last 7 days</span><b>${money(data.week.revenuePesewas)}</b><i>${data.week.transactions} transactions</i></div>
        <div class="kpi"><span>Average basket</span><b>${money(data.week.averageBasketPesewas)}</b><i>per sale</i></div>
        <div class="kpi"><span>Gross profit (7d)</span><b>${money(data.week.grossProfitPesewas)}</b><i>before operating costs</i></div>
      </div>
      <div class="grid" style="grid-template-columns:repeat(auto-fit,minmax(300px,1fr))">
        <div class="card"><h2>Top products (7 days)</h2>
          ${data.top.length ? `<table><thead><tr><th>Product</th><th class="num">Units</th><th class="num">Revenue</th></tr></thead><tbody>
                ${data.top.map((row) => `<tr><td>${esc(row.name)}</td><td class="num">${row.units}</td><td class="num">${money(row.revenue_pesewas)}</td></tr>`).join("")}
              </tbody></table>` : `<div class="empty">No sales in this period.</div>`}
        </div>
        <div class="card"><h2>Asset values</h2>
          ${data.assets ? `<table><tbody>
                <tr><td>Total asset</td><td class="num"><b>${money(data.assets.totalPesewas)}</b></td></tr>
                <tr><td>Safe asset <span style="color:var(--muted)">(safe for 12+ months)</span></td><td class="num">${money(data.assets.safePesewas)}</td></tr>
                <tr><td>Asset to run loss <span style="color:var(--muted)">(expiring within 12 months)</span></td><td class="num">${money(data.assets.atRiskPesewas)}</td></tr>
                <tr><td>Lost asset <span style="color:var(--muted)">(already expired)</span></td><td class="num" style="color:var(--red)">${money(data.assets.lostPesewas)}</td></tr>
                <tr><td>Non-perishable assets</td><td class="num">${money(data.assets.nonPerishablePesewas)}</td></tr>
              </tbody></table>
              <div class="note">Owner-only figures \u2014 staff accounts never see these.</div>` : `<div class="empty">Asset values are hidden for this role.<br><span style="font-size:12px">Sign in as the owner to see them.</span></div>`}
        </div>
      </div>`;
  } catch (err) {
    byId("reportBody").innerHTML = `<div class="card"><div class="empty">${esc(err instanceof Error ? err.message : "Could not load reports")}</div></div>`;
  }
}
document.addEventListener("click", (event) => {
  const target = event.target.closest("[data-add],[data-inc],[data-dec]");
  if (!target) return;
  if (target.hasAttribute("data-add")) {
    const product = products.find((p) => p.product_id === target.getAttribute("data-add"));
    if (product) addToCart(product);
    return;
  }
  if (target.hasAttribute("data-inc")) {
    const line2 = cart.find((l) => l.productId === target.getAttribute("data-inc"));
    if (!line2) return;
    if (line2.quantity + 1 > line2.sellable) {
      toast(`Only ${line2.sellable} sellable ${line2.name} in this branch`, true);
      return;
    }
    line2.quantity += 1;
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
  if (event.key === "Escape") closeModal();
});
var PRODUCT_FORMS = ["Tablets", "Capsules", "Syrup", "Suspension", "Injection", "Sachet", "Cream", "Ointment", "Drops", "Inhaler", "Device", "Other"];
function toPesewas(value) {
  const amount = Number(value);
  return Number.isFinite(amount) && amount > 0 ? Math.round(amount * 100) : 0;
}
var fld = (label, control) => `<div class="fld"><label>${label}</label>${control}</div>`;
var flagsFor = (p) => p.controlled_class !== "none" ? ` <span class="badge b-exp">Class ${p.controlled_class}</span>` : p.prescription_required ? ` <span class="badge b-rx">Rx</span>` : "";
async function renderProducts() {
  byId("main").innerHTML = `<section class="card">
    <h2>Products <span class="badge b-mute">${esc(branchName())}</span>
      <button class="btn sm primary" id="addProduct">Add product</button></h2>
    <div class="scanrow"><input id="productSearch" placeholder="Filter by name, barcode or brand" autocomplete="off"></div>
    <div id="productTable"><div class="empty">Loading\u2026</div></div>
    <div class="note">Stock is counted per batch, not per product. A product with no batch has no stock \u2014 use <b>Receive stock</b> to add some.</div>
  </section>`;
  const search = byId("productSearch");
  search.addEventListener("input", debounce(() => void loadCatalogue(search.value), 160));
  byId("addProduct").addEventListener("click", () => void productModal());
  await loadCatalogue("");
}
async function loadCatalogue(filter) {
  const box = document.getElementById("productTable");
  if (!box) return;
  const showCost = session?.permissions.assets ?? false;
  try {
    const data = await api(
      `/api/products?branchId=${encodeURIComponent(branchId)}&q=${encodeURIComponent(filter)}&limit=200`
    );
    if (!data.products.length) {
      box.innerHTML = `<div class="empty">${filter ? "Nothing matches that filter." : "No products yet. Add the first one."}</div>`;
      return;
    }
    box.innerHTML = `<table><thead><tr>
        <th>Product</th><th>Barcode</th><th class="num">Price</th>${showCost ? `<th class="num">Cost</th>` : ""}
        <th class="num">On hand</th><th class="num">Reorder</th><th></th></tr></thead><tbody>
      ${data.products.map((p) => {
      const detail = [p.brand, p.form, p.strength].filter(Boolean).join(" \xB7 ");
      return `<tr>
            <td><b>${esc(p.name)}</b>${flagsFor(p)}<br><span style="font-size:11.5px;color:var(--muted)">${esc(detail || "\u2014")}</span></td>
            <td>${esc(p.barcode ?? "\u2014")}</td>
            <td class="num">${money(p.price_pesewas)}</td>
            ${showCost ? `<td class="num">${p.cost_price_pesewas ? money(p.cost_price_pesewas) : "\u2014"}</td>` : ""}
            <td class="num">${p.on_hand}</td>
            <td class="num">${p.reorder_level || "\u2014"}</td>
            <td class="num"><button class="btn sm ghost" data-receive="${p.product_id}" data-name="${esc(p.name)}">Receive stock</button></td>
          </tr>`;
    }).join("")}
    </tbody></table>`;
    box.querySelectorAll("[data-receive]").forEach(
      (btn) => btn.addEventListener(
        "click",
        () => void receiveModal(btn.getAttribute("data-receive") ?? "", btn.getAttribute("data-name") ?? "")
      )
    );
  } catch (err) {
    box.innerHTML = `<div class="empty">${esc(err instanceof Error ? err.message : "Could not load products")}</div>`;
  }
}
async function productModal() {
  let categories = [];
  try {
    categories = (await api("/api/categories")).categories;
  } catch {
  }
  openModal(`<h2>Add a product</h2>
    <div class="inline">
      ${fld("Name", `<input id="pName" placeholder="Paracetamol">`)}
      ${fld("Brand", `<input id="pBrand" placeholder="Kinapharma">`)}
      ${fld("Form", `<select id="pForm">${PRODUCT_FORMS.map((f) => `<option>${f}</option>`).join("")}</select>`)}
      ${fld("Strength", `<input id="pStrength" placeholder="500 mg">`)}
      ${fld("Unit", `<input id="pUnit" placeholder="Blister of 10">`)}
      ${fld("Barcode", `<input id="pBarcode" placeholder="PCM500">`)}
      ${fld("Category", `<input id="pCategory" list="catList" placeholder="Analgesics"><datalist id="catList">${categories.map((c) => `<option value="${esc(c.name)}"></option>`).join("")}</datalist>`)}
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
    const name = byId("pName").value.trim();
    if (!name) {
      toast("Give the product a name", true);
      return;
    }
    const typed = byId("pCategory").value.trim();
    try {
      let categoryId = null;
      if (typed) {
        const existing = categories.find((c) => c.name.toLowerCase() === typed.toLowerCase());
        categoryId = existing ? existing.category_id : (await api("/api/categories", {
          method: "POST",
          body: JSON.stringify({ name: typed })
        })).categoryId;
      }
      await api("/api/products", {
        method: "POST",
        body: JSON.stringify({
          name,
          brand: byId("pBrand").value,
          form: byId("pForm").value,
          strength: byId("pStrength").value,
          unit: byId("pUnit").value,
          barcode: byId("pBarcode").value,
          categoryId,
          pricePesewas: toPesewas(byId("pPrice").value),
          costPricePesewas: toPesewas(byId("pCost").value),
          reorderLevel: Number(byId("pReorder").value || 0),
          prescriptionRequired: byId("pRx").checked,
          controlledClass: byId("pControlled").value,
          perishable: byId("pPerishable").checked
        })
      });
      closeModal();
      toast(`${name} added`);
      await loadCatalogue(document.getElementById("productSearch")?.value ?? "");
    } catch (err) {
      toast(err instanceof Error ? err.message : "Could not add the product", true);
    }
  });
}
async function receiveModal(productId, productName) {
  if (!productId) return;
  let suppliers = [];
  try {
    suppliers = (await api("/api/suppliers")).suppliers;
  } catch {
  }
  openModal(`<h2>Receive stock</h2>
    <p style="color:var(--muted);font-size:13px;margin:-6px 0 14px">${esc(productName)} into ${esc(branchName())}.</p>
    <div class="inline">
      ${fld("Batch number", `<input id="bNumber" placeholder="PCM-26A">`)}
      ${fld("Expiry date", `<input id="bExpiry" type="date">`)}
      ${fld("Quantity", `<input id="bQty" type="number" min="1" placeholder="240">`)}
      ${fld("Supplier", `<select id="bSupplier"><option value="">\u2014 none \u2014</option>${suppliers.map((s) => `<option value="${s.supplier_id}">${esc(s.name)}</option>`).join("")}</select>`)}
      ${fld("Cost price (GHS)", `<input id="bCost" type="number" step="0.01" min="0" placeholder="leave blank to use the product's">`)}
      ${fld("Selling price (GHS)", `<input id="bPrice" type="number" step="0.01" min="0" placeholder="leave blank to use the product's">`)}
    </div>
    <div class="foot">
      <button class="btn ghost" id="cancel">Cancel</button>
      <button class="btn primary" id="save">Receive stock</button>
    </div>`);
  byId("cancel").addEventListener("click", closeModal);
  byId("save").addEventListener("click", async () => {
    const quantity = Number(byId("bQty").value || 0);
    const batchNumber = byId("bNumber").value.trim();
    if (!batchNumber) {
      toast("Give the batch a number", true);
      return;
    }
    if (quantity <= 0) {
      toast("Quantity must be more than zero", true);
      return;
    }
    const cost = byId("bCost").value;
    const price = byId("bPrice").value;
    try {
      await api("/api/batches", {
        method: "POST",
        body: JSON.stringify({
          branchId,
          productId,
          batchNumber,
          expiryDate: byId("bExpiry").value || null,
          quantity,
          supplierId: byId("bSupplier").value || null,
          ...cost ? { costPricePesewas: toPesewas(cost) } : {},
          ...price ? { sellingPricePesewas: toPesewas(price) } : {}
        })
      });
      closeModal();
      toast(`${quantity} received`);
      if (view === "products") await loadCatalogue(document.getElementById("productSearch")?.value ?? "");
      else if (view === "stock") await loadStock(document.getElementById("stockSearch")?.value ?? "");
    } catch (err) {
      toast(err instanceof Error ? err.message : "Could not receive the stock", true);
    }
  });
}
async function renderSuppliers() {
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
    <div id="supplierList"><div class="empty">Loading\u2026</div></div>
  </section>`;
  byId("saveSupplier").addEventListener("click", async () => {
    const name = byId("sName").value.trim();
    if (!name) {
      toast("Give the supplier a name", true);
      return;
    }
    try {
      await api("/api/suppliers", {
        method: "POST",
        body: JSON.stringify({
          name,
          phone: byId("sPhone").value,
          email: byId("sEmail").value,
          address: byId("sAddress").value
        })
      });
      toast(`${name} added`);
      renderSuppliers();
    } catch (err) {
      toast(err instanceof Error ? err.message : "Could not add the supplier", true);
    }
  });
  await loadSuppliers();
}
async function loadSuppliers() {
  const box = document.getElementById("supplierList");
  if (!box) return;
  try {
    const data = await api("/api/suppliers");
    if (!data.suppliers.length) {
      box.innerHTML = `<div class="empty">No suppliers yet.</div>`;
      return;
    }
    box.innerHTML = `<table><thead><tr><th>Supplier</th><th>Phone</th><th>Email</th><th>Address</th></tr></thead><tbody>
      ${data.suppliers.map(
      (s) => `<tr><td><b>${esc(s.name)}</b></td><td>${esc(s.phone ?? "\u2014")}</td><td>${esc(s.email ?? "\u2014")}</td><td>${esc(s.address ?? "\u2014")}</td></tr>`
    ).join("")}
    </tbody></table>`;
  } catch (err) {
    box.innerHTML = `<div class="empty">${esc(err instanceof Error ? err.message : "Could not load suppliers")}</div>`;
  }
}
async function renderTeam() {
  byId("main").innerHTML = `<section class="card">
    <h2>Add someone to the team</h2>
    <div class="inline">
      ${fld("Name", `<input id="uName" placeholder="Ama Boateng">`)}
      ${fld("Email", `<input id="uEmail" type="email" placeholder="ama@pharmacy.com">`)}
      ${fld("Password", `<input id="uPassword" type="text" placeholder="at least 8 characters">`)}
      ${fld("Role", `<select id="uRole"><option value="salesperson">Salesperson \u2014 sells only</option><option value="admin">Administrator \u2014 stock, products, sales, reports</option></select>`)}
      ${fld("Branch", `<select id="uBranch"><option value="">All branches</option>${(session?.branches ?? []).map((b) => `<option value="${b.branch_id}"${b.branch_id === branchId ? " selected" : ""}>${esc(b.name)}</option>`).join("")}</select>`)}
    </div>
    <div class="foot"><button class="btn primary" id="saveStaff">Add account</button></div>
  </section>

  <section class="card" style="margin-top:16px">
    <h2>Team</h2>
    <div id="staffList"><div class="empty">Loading\u2026</div></div>
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
    const name = byId("uName").value.trim();
    const email = byId("uEmail").value.trim();
    const password = byId("uPassword").value;
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
          role: byId("uRole").value,
          branchId: byId("uBranch").value || null
        })
      });
      toast(`${name} can now sign in`);
      renderTeam();
    } catch (err) {
      toast(err instanceof Error ? err.message : "Could not add the account", true);
    }
  });
  byId("saveBranch").addEventListener("click", async () => {
    const name = byId("brName").value.trim();
    if (!name) {
      toast("Give the branch a name", true);
      return;
    }
    try {
      await api("/api/branches", {
        method: "POST",
        body: JSON.stringify({ name, address: byId("brAddress").value })
      });
      toast(`${name} added`);
      session = await api("/api/session");
      renderApp();
    } catch (err) {
      toast(err instanceof Error ? err.message : "Could not add the branch", true);
    }
  });
  await loadStaff();
  renderBranchList();
}
async function loadStaff() {
  const box = document.getElementById("staffList");
  if (!box) return;
  try {
    const data = await api("/api/staff");
    const branchOf = (id) => id ? session?.branches.find((b) => b.branch_id === id)?.name ?? "\u2014" : "All branches";
    box.innerHTML = `<table><thead><tr><th>Name</th><th>Email</th><th>Role</th><th>Branch</th></tr></thead><tbody>
      ${data.staff.map(
      (u) => `<tr><td><b>${esc(u.name)}</b></td><td>${esc(u.email)}</td><td>${esc(u.role)}</td><td>${esc(branchOf(u.branch_id))}</td></tr>`
    ).join("")}
    </tbody></table>`;
  } catch (err) {
    box.innerHTML = `<div class="empty">${esc(err instanceof Error ? err.message : "Could not load the team")}</div>`;
  }
}
function renderBranchList() {
  const box = document.getElementById("branchList");
  if (!box || !session) return;
  const plan = session.tenant.plan.name;
  box.innerHTML = `<table><thead><tr><th>Branch</th><th>Address</th></tr></thead><tbody>
    ${session.branches.map((b) => `<tr><td><b>${esc(b.name)}</b></td><td>${esc(b.address ?? "\u2014")}</td></tr>`).join("")}
  </tbody></table>
  <div class="note">The ${esc(plan)} plan allows ${session.tenant.usage.shops} branch${session.tenant.usage.shops === 1 ? "" : "es"} right now.</div>`;
}
async function boot() {
  if (!token) {
    renderLogin();
    return;
  }
  try {
    session = await api("/api/session");
    branchId = session.branches[0]?.branch_id ?? "";
    renderApp();
  } catch {
    signOut();
  }
}
void boot();
