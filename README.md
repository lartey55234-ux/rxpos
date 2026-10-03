# rxpos — Pharmacy POS

Multi-tenant point-of-sale and stock system for pharmacies, with the batch, expiry
and controlled-drug rules enforced in the data layer rather than in the UI.

Working today: tenancy, authentication, roles, plan limits, the catalogue and batch
model, the counter with first-expiry-first-out selling, prescriptions, the Controlled
Drugs Register, asset values, and a counter UI that talks to the API.

## Run it

```bash
npm run demo   # builds the UI, seeds a pharmacy, serves http://localhost:4173
npm test       # 40 tests: isolation, auth, sales, compliance, HTTP API
npm run seed   # the same pharmacy, printed as a day of trading
```

`npm run demo` signs you in as any of three roles, all with password `secret123`:

| Account | Role | What they can do |
| --- | --- | --- |
| `owner@osupharmacy.example` | owner | everything, including asset values and the register |
| `kofi@osupharmacy.example` | administrator | stock, products, sales, analytics — but no asset values |
| `ama@osupharmacy.example` | salesperson | sell only |

The demo database is in memory, so it resets on every restart.

## Decisions recorded

**Offline — online-only for the pilot, UUID keys from day one.** Sales go straight to
the server. Primary keys are UUIDs anyway, so an offline queue can be added later
without migrating a single key.

**Regulatory — the register is required, so it is in v1.** Act 489 s.34 requires anyone
supplying Class A or B drugs to keep a Dangerous Drugs Record showing the drug and
quantity, the name and address of the person supplied, the signature of the person
supplying, and the date of supply. s.32 requires a dispensed prescription to be
retained on the premises for two years. The FDA's controlled drugs guideline
(FDA/DRI/TSA/GL-SSCS/2020/07 §4.3.1) requires a Controlled Drugs Register for
everything obtained and supplied, available for inspection for at least two years,
and restricts pharmacy supply to a valid prescription or signed order.

## Rules enforced in code

| Rule | Where |
| --- | --- |
| A tenant can only ever read its own rows | `src/tenant.ts` |
| Stock is drawn first-expiry-first-out | `src/sales.ts` |
| Expired batches can never be supplied | `src/sales.ts`, `src/catalog.ts` |
| Controlled drugs need a prescription | `src/sales.ts` |
| Only owner or administrator may dispense a controlled drug | `src/permissions.ts` |
| Asset values are owner-only | `src/permissions.ts`, `src/reports.ts` |
| Plan limits block an over-limit action | `src/plans.ts` |
| Every quantity change writes a stock movement | `src/catalog.ts`, `src/sales.ts` |
| Every mutation writes an audit row | `src/audit.ts` |

The client decides what to show, never what is allowed. Every rule above is checked
again on the server, and the HTTP tests assert that directly — including that a
salesperson posting a controlled sale by hand gets a 403.

## Tenancy

Every tenant-owned query goes through a `TenantScope` and marks its tenant filter:

```sql
SELECT * FROM batches WHERE tenant_id = {{tenant}} AND branch_id = ?
```

The scope substitutes the acting tenant's id at exactly that marker, and refuses any
query with zero or two markers. Binding by marker rather than by position matters: a
query that filters the tenant inside a JOIN orders its placeholders differently from
one that filters in WHERE, and positional binding then silently reads the wrong
column. A test asserts the wrong-parameter case directly.

The API never accepts a tenant id from the client. The bearer token resolves to one
actor, and every query runs through that actor's scope.

## Layout

```
db/schema.sql        portable DDL — SQLite in dev, PostgreSQL in production
src/tenant.ts        tenant-scoped data access
src/auth.ts          registration, login, sessions, staff
src/permissions.ts   role matrix
src/plans.ts         tiers and limit enforcement
src/catalog.ts       products, suppliers, branches, batches, stock, expiry
src/sales.ts         the counter: FEFO, payments, movements, receipts
src/prescriptions.ts prescriptions and the two-year retention window
src/controlled.ts    the Controlled Drugs Register (append-only)
src/reports.ts       asset values, sales summary, top products
src/audit.ts         audit trail
src/server.ts        the HTTP API
src/demo.ts          a seeded pharmacy for the demo
src/client/app.ts    the counter UI (compiled to public/app.js)
public/              index.html, styles.css, built app.js
tests/               isolation, auth, sales, compliance, HTTP API
```

## Storage

`db/schema.sql` sticks to portable SQL: TEXT ids, INTEGER pesewas, TEXT ISO-8601
timestamps, no vendor-specific types. Development and tests use SQLite through
`node:sqlite`. Moving to PostgreSQL means swapping the driver inside `src/db.ts`;
no query changes.

Money is integer pesewas everywhere. Floats drift, and a pharmacy notices a
one-pesewa discrepancy at the till.

The UI has one build step (`esbuild`, a dev dependency). Everything else runs on
Node alone.

## Known gaps

- Receipt printing uses the browser's print dialog; no thermal printer driver yet.
- Purchases exist in the schema and on the receipt path, but there is no ordering flow.
- Paystack and mobile money are recorded, not charged.
- Email is globally unique, so one login cannot yet belong to two pharmacies.
- No CI, no deploy target, no git remote.
- The Dangerous Drugs Record is stored electronically. Whether an inspector accepts a
  printed electronic register or expects the physical book should be confirmed with
  the Pharmacy Council before a pilot.
