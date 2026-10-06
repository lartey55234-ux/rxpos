-- Pharmacy POS — schema v1
-- Portable DDL: runs on SQLite (dev/test) and PostgreSQL (production).
-- Conventions
--   ids         UUIDv4 as TEXT  (offline-ready: no server-assigned keys)
--   money       INTEGER pesewas (GHS 1.00 = 100)
--   timestamps  TEXT ISO-8601 UTC
--   every tenant-owned table carries tenant_id; reads go through TenantScope
--   no hard deletes on stock, sales, prescriptions or the controlled register

CREATE TABLE IF NOT EXISTS plans (
  plan_id        TEXT PRIMARY KEY,
  name           TEXT    NOT NULL UNIQUE,
  price_pesewas  INTEGER NOT NULL,
  max_products   INTEGER,            -- NULL = unlimited
  max_shops      INTEGER NOT NULL,
  max_staff      INTEGER NOT NULL,
  max_suppliers  INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS tenants (
  tenant_id   TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  phone       TEXT,
  email       TEXT,
  plan_id     TEXT NOT NULL REFERENCES plans(plan_id),
  status      TEXT NOT NULL DEFAULT 'active',
  created_at  TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS subscriptions (
  subscription_id  TEXT PRIMARY KEY,
  tenant_id        TEXT NOT NULL REFERENCES tenants(tenant_id),
  plan_id          TEXT NOT NULL REFERENCES plans(plan_id),
  started_at       TEXT NOT NULL,
  expires_at       TEXT,
  amount_pesewas   INTEGER NOT NULL DEFAULT 0,
  status           TEXT NOT NULL DEFAULT 'active'
);

CREATE TABLE IF NOT EXISTS branches (
  branch_id   TEXT PRIMARY KEY,
  tenant_id   TEXT NOT NULL REFERENCES tenants(tenant_id),
  name        TEXT NOT NULL,
  address     TEXT,
  phone       TEXT,
  created_at  TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS users (
  user_id        TEXT PRIMARY KEY,
  tenant_id      TEXT NOT NULL REFERENCES tenants(tenant_id),
  branch_id      TEXT REFERENCES branches(branch_id),   -- NULL = all shops
  name           TEXT NOT NULL,
  email          TEXT NOT NULL UNIQUE,
  phone          TEXT,
  password_hash  TEXT NOT NULL,
  password_salt  TEXT NOT NULL,
  role           TEXT NOT NULL CHECK (role IN ('owner','admin','salesperson')),
  status         TEXT NOT NULL DEFAULT 'active',
  created_at     TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS sessions (
  session_id   TEXT PRIMARY KEY,
  tenant_id    TEXT NOT NULL REFERENCES tenants(tenant_id),
  user_id      TEXT NOT NULL REFERENCES users(user_id),
  token_hash   TEXT NOT NULL UNIQUE,
  created_at   TEXT NOT NULL,
  expires_at   TEXT NOT NULL,
  revoked_at   TEXT
);

-- A forgotten password. The token is stored hashed, because a leaked reset token
-- is a way into somebody's pharmacy. Single use, and it expires.
CREATE TABLE IF NOT EXISTS password_resets (
  reset_id    TEXT PRIMARY KEY,
  tenant_id   TEXT NOT NULL REFERENCES tenants(tenant_id),
  user_id     TEXT NOT NULL REFERENCES users(user_id),
  token_hash  TEXT NOT NULL UNIQUE,
  created_at  TEXT NOT NULL,
  expires_at  TEXT NOT NULL,
  used_at     TEXT
);

-- One-time owner recovery codes. Only hashes are stored; the printable codes are
-- returned once when generated. They work without email and each can be spent once.
CREATE TABLE IF NOT EXISTS owner_recovery_codes (
  recovery_code_id TEXT PRIMARY KEY,
  tenant_id        TEXT NOT NULL REFERENCES tenants(tenant_id),
  user_id          TEXT NOT NULL REFERENCES users(user_id),
  code_hash        TEXT NOT NULL UNIQUE,
  created_at       TEXT NOT NULL,
  used_at          TEXT
);

-- What went wrong, so a fault at a pharmacy arrives as a stack trace rather than
-- a phone call. Grouped by fingerprint: one row per distinct fault, with a count,
-- so the table stays small and the list stays readable.
--
-- Deliberately no request bodies. A sign-in body holds a password, and an error
-- report is not worth leaking one for.
CREATE TABLE IF NOT EXISTS error_reports (
  report_id     TEXT PRIMARY KEY,
  fingerprint   TEXT NOT NULL UNIQUE,
  source        TEXT NOT NULL,
  tenant_id     TEXT,
  user_id       TEXT,
  path          TEXT,
  message       TEXT NOT NULL,
  stack         TEXT,
  context_json  TEXT,
  count         INTEGER NOT NULL DEFAULT 1,
  first_seen_at TEXT NOT NULL,
  last_seen_at  TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS categories (
  category_id  TEXT PRIMARY KEY,
  tenant_id    TEXT NOT NULL REFERENCES tenants(tenant_id),
  name         TEXT NOT NULL,
  description  TEXT
);

CREATE TABLE IF NOT EXISTS products (
  product_id             TEXT PRIMARY KEY,
  tenant_id              TEXT NOT NULL REFERENCES tenants(tenant_id),
  category_id            TEXT REFERENCES categories(category_id),
  name                   TEXT NOT NULL,
  brand                  TEXT,
  form                   TEXT,
  strength               TEXT,
  unit                   TEXT,
  barcode                TEXT,
  default_price_pesewas  INTEGER NOT NULL DEFAULT 0,
  cost_price_pesewas     INTEGER NOT NULL DEFAULT 0,
  reorder_level          INTEGER NOT NULL DEFAULT 0,
  prescription_required  INTEGER NOT NULL DEFAULT 0,
  controlled_class       TEXT NOT NULL DEFAULT 'none' CHECK (controlled_class IN ('none','B','A')),
  perishable             INTEGER NOT NULL DEFAULT 1,
  status                 TEXT NOT NULL DEFAULT 'active',
  created_at             TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS suppliers (
  supplier_id  TEXT PRIMARY KEY,
  tenant_id    TEXT NOT NULL REFERENCES tenants(tenant_id),
  name         TEXT NOT NULL,
  phone        TEXT,
  email        TEXT,
  address      TEXT,
  created_at   TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS batches (
  batch_id              TEXT PRIMARY KEY,
  tenant_id             TEXT NOT NULL REFERENCES tenants(tenant_id),
  product_id            TEXT NOT NULL REFERENCES products(product_id),
  branch_id             TEXT NOT NULL REFERENCES branches(branch_id),
  supplier_id           TEXT REFERENCES suppliers(supplier_id),
  batch_number          TEXT NOT NULL,
  expiry_date           TEXT,                     -- NULL = non-perishable
  quantity              INTEGER NOT NULL DEFAULT 0,
  cost_price_pesewas    INTEGER NOT NULL DEFAULT 0,
  selling_price_pesewas INTEGER NOT NULL DEFAULT 0,
  received_at           TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS stock_movements (
  movement_id     TEXT PRIMARY KEY,
  tenant_id       TEXT NOT NULL REFERENCES tenants(tenant_id),
  batch_id        TEXT NOT NULL REFERENCES batches(batch_id),
  branch_id       TEXT NOT NULL REFERENCES branches(branch_id),
  user_id         TEXT NOT NULL REFERENCES users(user_id),
  movement_type   TEXT NOT NULL CHECK (movement_type IN ('receipt','sale','adjustment','transfer','write_off','return')),
  quantity_delta  INTEGER NOT NULL,
  reference_type  TEXT,
  reference_id    TEXT,
  note            TEXT,
  created_at      TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS purchases (
  purchase_id     TEXT PRIMARY KEY,
  tenant_id       TEXT NOT NULL REFERENCES tenants(tenant_id),
  supplier_id     TEXT NOT NULL REFERENCES suppliers(supplier_id),
  branch_id       TEXT NOT NULL REFERENCES branches(branch_id),
  user_id         TEXT NOT NULL REFERENCES users(user_id),
  invoice_number  TEXT,
  purchase_date   TEXT NOT NULL,
  total_pesewas   INTEGER NOT NULL DEFAULT 0,
  status          TEXT NOT NULL DEFAULT 'received'
);

CREATE TABLE IF NOT EXISTS purchase_items (
  purchase_item_id  TEXT PRIMARY KEY,
  tenant_id         TEXT NOT NULL REFERENCES tenants(tenant_id),
  purchase_id       TEXT NOT NULL REFERENCES purchases(purchase_id),
  product_id        TEXT NOT NULL REFERENCES products(product_id),
  batch_id          TEXT REFERENCES batches(batch_id),
  quantity          INTEGER NOT NULL,
  unit_cost_pesewas INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS customers (
  customer_id  TEXT PRIMARY KEY,
  tenant_id    TEXT NOT NULL REFERENCES tenants(tenant_id),
  name         TEXT NOT NULL,
  phone        TEXT,
  email        TEXT,
  address      TEXT,
  created_at   TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS prescriptions (
  prescription_id     TEXT PRIMARY KEY,
  tenant_id           TEXT NOT NULL REFERENCES tenants(tenant_id),
  branch_id           TEXT NOT NULL REFERENCES branches(branch_id),
  prescription_number TEXT NOT NULL,
  patient_name        TEXT NOT NULL,
  patient_address     TEXT,
  prescriber_name     TEXT NOT NULL,
  prescriber_licence  TEXT,
  issued_date         TEXT NOT NULL,
  retained_until      TEXT NOT NULL,   -- Act 489 s.32: keep 2 years, available for inspection
  created_by          TEXT NOT NULL REFERENCES users(user_id),
  created_at          TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS sales (
  sale_id          TEXT PRIMARY KEY,
  tenant_id        TEXT NOT NULL REFERENCES tenants(tenant_id),
  branch_id        TEXT NOT NULL REFERENCES branches(branch_id),
  user_id          TEXT NOT NULL REFERENCES users(user_id),
  customer_id      TEXT REFERENCES customers(customer_id),
  prescription_id  TEXT REFERENCES prescriptions(prescription_id),
  sale_date        TEXT NOT NULL,
  subtotal_pesewas INTEGER NOT NULL,
  discount_pesewas INTEGER NOT NULL DEFAULT 0,
  tax_pesewas      INTEGER NOT NULL DEFAULT 0,
  total_pesewas    INTEGER NOT NULL,
  payment_method   TEXT NOT NULL,
  amount_tendered_pesewas INTEGER NOT NULL,
  change_pesewas   INTEGER NOT NULL DEFAULT 0,
  status           TEXT NOT NULL DEFAULT 'completed'
);

CREATE TABLE IF NOT EXISTS sale_items (
  sale_item_id       TEXT PRIMARY KEY,
  tenant_id          TEXT NOT NULL REFERENCES tenants(tenant_id),
  sale_id            TEXT NOT NULL REFERENCES sales(sale_id),
  product_id         TEXT NOT NULL REFERENCES products(product_id),
  batch_id           TEXT NOT NULL REFERENCES batches(batch_id),
  quantity           INTEGER NOT NULL,
  unit_price_pesewas INTEGER NOT NULL,
  discount_pesewas   INTEGER NOT NULL DEFAULT 0,
  line_total_pesewas INTEGER NOT NULL
);

-- A charge in progress. Created before the sale, because money is taken first and
-- stock moves only once Paystack confirms it. payload_json holds the cart so the
-- sale can be built on confirmation, including from a webhook with no browser.
CREATE TABLE IF NOT EXISTS payment_intents (
  intent_id       TEXT PRIMARY KEY,
  tenant_id       TEXT NOT NULL REFERENCES tenants(tenant_id),
  branch_id       TEXT NOT NULL REFERENCES branches(branch_id),
  user_id         TEXT NOT NULL REFERENCES users(user_id),
  reference       TEXT NOT NULL UNIQUE,
  provider        TEXT NOT NULL DEFAULT 'paystack',
  amount_pesewas  INTEGER NOT NULL,
  channel         TEXT NOT NULL,
  payload_json    TEXT NOT NULL,
  status          TEXT NOT NULL DEFAULT 'pending',
  sale_id         TEXT REFERENCES sales(sale_id),
  created_at      TEXT NOT NULL,
  confirmed_at    TEXT
);

CREATE TABLE IF NOT EXISTS payments (
  payment_id      TEXT PRIMARY KEY,
  tenant_id       TEXT NOT NULL REFERENCES tenants(tenant_id),
  sale_id         TEXT NOT NULL REFERENCES sales(sale_id),
  method          TEXT NOT NULL,
  amount_pesewas  INTEGER NOT NULL,
  provider_ref    TEXT,
  paid_at         TEXT NOT NULL
);

-- Append-only. Act 489 s.34 + FDA/DRI/TSA/GL-SSCS/2020/07 4.3.1:
-- drug and quantity, recipient name and address, signature reference, date of supply.
CREATE TABLE IF NOT EXISTS controlled_register (
  entry_id               TEXT PRIMARY KEY,
  tenant_id              TEXT NOT NULL REFERENCES tenants(tenant_id),
  branch_id              TEXT NOT NULL REFERENCES branches(branch_id),
  direction              TEXT NOT NULL CHECK (direction IN ('received','supplied')),
  product_id             TEXT NOT NULL REFERENCES products(product_id),
  batch_id               TEXT REFERENCES batches(batch_id),
  batch_number           TEXT,
  quantity               INTEGER NOT NULL,
  supplier_id            TEXT REFERENCES suppliers(supplier_id),
  recipient_name         TEXT,
  recipient_address      TEXT,
  recipient_signature_ref TEXT,
  dispenser_user_id      TEXT NOT NULL REFERENCES users(user_id),
  prescription_id        TEXT REFERENCES prescriptions(prescription_id),
  reference_type         TEXT,
  reference_id           TEXT,
  entry_date             TEXT NOT NULL,
  created_at             TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS audit_log (
  audit_id     TEXT PRIMARY KEY,
  tenant_id    TEXT NOT NULL REFERENCES tenants(tenant_id),
  user_id      TEXT REFERENCES users(user_id),
  entity_type  TEXT NOT NULL,
  entity_id    TEXT NOT NULL,
  action       TEXT NOT NULL,
  before_json  TEXT,
  after_json   TEXT,
  created_at   TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_products_tenant        ON products(tenant_id, status);
CREATE INDEX IF NOT EXISTS idx_batches_tenant_branch  ON batches(tenant_id, branch_id, product_id);
CREATE INDEX IF NOT EXISTS idx_batches_expiry         ON batches(tenant_id, expiry_date);
CREATE INDEX IF NOT EXISTS idx_movements_tenant       ON stock_movements(tenant_id, batch_id);
CREATE INDEX IF NOT EXISTS idx_sales_tenant_date      ON sales(tenant_id, sale_date);
CREATE INDEX IF NOT EXISTS idx_users_tenant           ON users(tenant_id);
CREATE INDEX IF NOT EXISTS idx_register_tenant        ON controlled_register(tenant_id, entry_date);

CREATE INDEX IF NOT EXISTS idx_intents_tenant  ON payment_intents(tenant_id, status);
CREATE INDEX IF NOT EXISTS idx_intents_ref     ON payment_intents(reference);

CREATE INDEX IF NOT EXISTS idx_resets_token ON password_resets(token_hash);
CREATE INDEX IF NOT EXISTS idx_recovery_owner ON owner_recovery_codes(tenant_id, user_id, used_at);

CREATE INDEX IF NOT EXISTS idx_errors_recent ON error_reports(last_seen_at);
