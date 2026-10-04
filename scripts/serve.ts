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
import { openMigratedDb } from "../src/db.ts";
import { seedPlans } from "../src/auth.ts";
import { seedDemoPharmacy } from "../src/demo.ts";
import { startServer } from "../src/server.ts";

const config = loadConfig();

if (config.databasePath !== ":memory:") {
  mkdirSync(dirname(config.databasePath), { recursive: true });
}

const db = openMigratedDb(config.databasePath);
seedPlans(db);

const tenants = (db.prepare("SELECT COUNT(*) AS n FROM tenants").get() as { n: number }).n;
const demo = config.seedDemo && tenants === 0 ? seedDemoPharmacy(db) : null;

const server = await startServer(db, config.port, undefined, config.host);

console.log(`[rxpos] listening on http://${config.host}:${config.port}`);
console.log(`[rxpos] database  ${config.databasePath}`);
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
    server.close(() => {
      db.close();
      process.exit(0);
    });
    // Do not let a hung connection block a redeploy.
    setTimeout(() => process.exit(0), 5000).unref();
  });
}
