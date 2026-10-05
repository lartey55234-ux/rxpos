/**
 * The deployed entry point.
 *
 * Opens (or creates) the database on disk, applies the schema, and serves the
 * counter. Seeding is opt-in and only ever happens on an empty database, so a
 * restart can never duplicate the sample pharmacy.
 */

import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { loadConfig } from "../src/config.ts";
import { openMigratedDatabase } from "../src/storage/index.ts";
import { seedPlans } from "../src/auth.ts";
import { seedDemoPharmacy } from "../src/demo.ts";
import { startServer } from "../src/server.ts";

const config = loadConfig();

const isSqliteFile = !config.databaseUrl.startsWith("postgres") && config.databaseUrl !== ":memory:";
if (isSqliteFile) {
  mkdirSync(dirname(config.databaseUrl), { recursive: true });
}

const db = await openMigratedDatabase(config.databaseUrl);
await seedPlans(db);

const tenants = (await db.get<{ n: number }>("SELECT COUNT(*) AS n FROM tenants"))?.n ?? 0;
const demo = config.seedDemo && tenants === 0 ? await seedDemoPharmacy(db) : null;

const server = await startServer(db, config.port, undefined, config.host, {
  paystackSecretKey: config.paystackSecretKey,
});

console.log(`[rxpos] listening on http://${config.host}:${config.port}`);
console.log(`[rxpos] database  ${describeDatabase(config.databaseUrl)}`);
console.log(
  `[rxpos] payments  ${config.paystackSecretKey ? "card and mobile money on" : "off — no PAYSTACK_SECRET_KEY"}`,
);
if (demo) {
  console.log(`[rxpos] seeded the sample pharmacy — ${demo.credentials.owner} / ${demo.credentials.password}`);
} else if (tenants > 0) {
  console.log(`[rxpos] ${tenants} existing pharmacy account(s) left untouched`);
}

let closing = false;
for (const signal of ["SIGTERM", "SIGINT"] as const) {
  process.on(signal, () => {
    if (closing) return;
    closing = true;
    console.log(`[rxpos] ${signal} received, closing`);
    server.close(async () => {
      await db.close();
      process.exit(0);
    });
    // Do not let a hung connection block a redeploy.
    setTimeout(() => process.exit(0), 5000).unref();
  });
}

/** Never print a connection string: it carries the password. */
function describeDatabase(url: string): string {
  if (!url.startsWith("postgres")) return url;
  try {
    const parsed = new URL(url);
    return `postgres ${parsed.host}${parsed.pathname}`;
  } catch {
    return "postgres";
  }
}
