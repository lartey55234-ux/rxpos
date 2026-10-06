/**
 * Take everything out of a database and write it to a file.
 *
 *   node scripts/backup.ts --out backups/rxpos.json
 *   node scripts/backup.ts --from postgresql://... --out /tmp/prod.json
 *
 * Reads DATABASE_URL when --from is not given.
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { parseArgs } from "node:util";
import { openDatabase } from "../src/storage/index.ts";
import { exportAll } from "../src/backup.ts";

const { values } = parseArgs({
  options: {
    from: { type: "string" },
    out: { type: "string", default: "rxpos-backup.json" },
  },
});

const source = values.from ?? process.env.DATABASE_URL ?? process.env.DATABASE_PATH ?? ":memory:";
const db = openDatabase(source);

try {
  const backup = await exportAll(db);
  const rows = Object.values(backup.tables).reduce((sum, table) => sum + table.length, 0);

  mkdirSync(dirname(values.out), { recursive: true });
  writeFileSync(values.out, JSON.stringify(backup));

  // Never print the connection string: it carries the password.
  console.log(`[backup] ${rows} rows from ${Object.keys(backup.tables).length} tables -> ${values.out}`);
  for (const [table, table_rows] of Object.entries(backup.tables)) {
    if (table_rows.length) console.log(`[backup]   ${table.padEnd(20)} ${table_rows.length}`);
  }
} finally {
  await db.close();
}
