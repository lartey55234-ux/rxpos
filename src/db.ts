import { DatabaseSync } from "node:sqlite";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export type Db = DatabaseSync;

const here = dirname(fileURLToPath(import.meta.url));

/** Open a database. Pass a file path for persistence, or omit for in-memory. */
export function openDb(path = ":memory:"): Db {
  const db = new DatabaseSync(path);
  db.exec("PRAGMA foreign_keys = ON");
  return db;
}

/** Apply db/schema.sql. Idempotent: every statement is CREATE ... IF NOT EXISTS. */
export function migrate(db: Db): void {
  db.exec(readFileSync(join(here, "..", "db", "schema.sql"), "utf8"));
}

/** Run fn inside a transaction. Rolls back on any throw. */
export function tx<T>(db: Db, fn: () => T): T {
  db.exec("BEGIN");
  try {
    const out = fn();
    db.exec("COMMIT");
    return out;
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }
}

export function openMigratedDb(path = ":memory:"): Db {
  const db = openDb(path);
  migrate(db);
  return db;
}
