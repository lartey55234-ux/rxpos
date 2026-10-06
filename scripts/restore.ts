/**
 * Put a backup back.
 *
 *   node scripts/restore.ts --in backups/rxpos.json --to postgresql://... --replace
 *
 * Refuses to touch a database that already has rows unless --replace is given, and
 * then says exactly how many rows it is about to delete first.
 */

import { readFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { openDatabase, migrate } from "../src/storage/index.ts";
import { countAll, importAll, type Backup } from "../src/backup.ts";

const { values } = parseArgs({
  options: {
    in: { type: "string" },
    to: { type: "string" },
    replace: { type: "boolean", default: false },
  },
});

if (!values.in) {
  console.error("[restore] --in <file> is required. This writes to a database; be explicit.");
  process.exit(2);
}

const target = values.to ?? process.env.DATABASE_URL ?? process.env.DATABASE_PATH;
if (!target) {
  console.error("[restore] --to <url> is required, or set DATABASE_URL. Refusing to guess.");
  process.exit(2);
}

const backup = JSON.parse(readFileSync(values.in, "utf8")) as Backup;
const db = openDatabase(target);

try {
  await migrate(db);

  const existing = await countAll(db);
  const present = Object.entries(existing).filter(([, n]) => n > 0);
  const held = present.reduce((sum, [, n]) => sum + n, 0);

  if (held > 0 && !values.replace) {
    console.error(`[restore] that database already holds ${held} rows. Pass --replace to overwrite it.`);
    for (const [table, n] of present) console.error(`[restore]   ${table.padEnd(20)} ${n}`);
    process.exit(3);
  }

  if (held > 0) console.log(`[restore] replacing ${held} existing rows`);

  const report = await importAll(db, backup, { replace: values.replace });
  console.log(`[restore] ${report.total} rows restored from ${backup.takenAt}`);
  for (const [table, n] of Object.entries(report.tables)) {
    if (n) console.log(`[restore]   ${table.padEnd(20)} ${n}`);
  }

  // Prove it landed rather than assuming it did.
  const after = await countAll(db);
  const expected = backup.tables;
  const wrong = Object.keys(after).filter((table) => after[table] !== (expected[table]?.length ?? 0));
  if (wrong.length) {
    console.error(`[restore] MISMATCH after restore: ${wrong.join(", ")}`);
    process.exit(1);
  }
  console.log("[restore] every table matches the backup");
} finally {
  await db.close();
}
