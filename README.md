# rxpos — Pharmacy POS

Multi-tenant point-of-sale and stock system for pharmacies, with the batch, expiry
and controlled-drug rules enforced in the data layer rather than in the UI.

This is the **M1 slice**: tenancy, authentication, roles, plan limits, the catalogue
and batch model, the counter sale path, and the compliance records Ghana requires.
The counter UI is not built yet — the prototype on the project page is the visual
reference for it.

## Decisions recorded

**Offline — online-only for the pilot, UUID keys from day one.**
Sales go straight to the server. Primary keys are UUIDs anyway, so an offline queue
can be added later without migrating a single key.

**Regulatory scope — the register is required, so it is in v1.**
This is not optional. Act 489 s.34 requires anyone supplying Class A or B drugs to
keep a Dangerous Drugs Record showing the drug and quantity, the name and address of
the person supplied, the signature of the person supplying, and the date of supply.
The FDA's controlled drugs guideline (FDA/DRI/TSA/GL-SSCS/2020/07, §4.3.1) requires
a Controlled Drugs Register for everything obtained and supplied, kept and available
for inspection for at least two years. Act 489 s.32 requires a dispensed prescription
to be retained on the premises for two years.

So: `controlled_register` is append-only, `prescriptions` carry a `retained_until`
date, controlled and prescription-only items cannot be sold without a prescription,
and only an owner or administrator can dispense a controlled drug.

## Rules enforced in code

| Rule | Where |
| --- | --- |
| A tenant can only ever read its own rows | `src/tenant.ts` |
| Stock is drawn first-expiry-first-out | `src/sales.ts` |
| Expired batches can never be supplied | `src/sales.ts`, `src/catalog.ts` |
| Controlled drugs need a prescription | `src/sales.ts` |
| Only owner/admin may dispense controlled drugs | `src/permissions.ts` |
| Asset values are owner-only | `src/permissions.ts`, `src/reports.ts` |
| Plan limits block an over-limit action | `src/plans.ts` |
| Every quantity change writes a stock movement | `src/catalog.ts`, `src/sales.ts` |
| Every mutation writes an audit row | `src/audit.ts` |

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

## Running it

```bash
npm test     # 31 tests: isolation, auth, sales, compliance
npm run seed # build a demo pharmacy and print a day's worth of activity
```

No dependencies. Node 24 runs the TypeScript directly (type stripping) and ships
`node:sqlite`, so the whole thing runs offline.

## Layout

```
db/schema.sql      portable DDL — SQLite in dev, PostgreSQL in production
src/tenant.ts      tenant-scoped data access
src/auth.ts        registration, login, sessions, staff
src/permissions.ts role matrix
src/plans.ts       tiers and limit enforcement
src/catalog.ts     products, suppliers, batches, stock, expiry
src/sales.ts       the counter: FEFO, payments, movements
src/prescriptions.ts  prescriptions and the two-year retention window
src/controlled.ts  the Controlled Drugs Register (append-only)
src/reports.ts     asset values, sales summary, top products
src/audit.ts       audit trail
tests/             isolation, auth, sales, compliance
```

## Storage

`db/schema.sql` sticks to portable SQL: TEXT ids, INTEGER pesewas, TEXT ISO-8601
timestamps, no vendor-specific types. Development and tests use SQLite through
`node:sqlite`. Moving to PostgreSQL means swapping the driver inside `src/db.ts`;
no query changes.

Money is integer pesewas everywhere. Floats drift, and a pharmacy notices a
one-pesewa discrepancy at the till.

## Known gaps

- No counter UI yet (prototype is the reference), no thermal printing.
- No purchases or supplier ordering beyond the schema and receipt path.
- Payments are recorded, not charged — Paystack and mobile money are not wired.
- Email is globally unique, so one login cannot belong to two pharmacies yet.
- No CI, no deploy target, no git remote.
