import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Database } from "./database.ts";
import { SqliteDatabase } from "./sqlite.ts";
import { createPostgresDatabase } from "./postgres.ts";

export type { Database, Engine, Row } from "./database.ts";

const here = dirname(fileURLToPath(import.meta.url));

/**
 * The connection string chooses the engine:
 *   postgres://...        PostgreSQL — production
 *   ./data/rxpos.db       SQLite on disk — local
 *   :memory:              SQLite, thrown away on exit — tests
 */
export function openDatabase(url = ":memory:"): Database {
  if (url.startsWith("postgres://") || url.startsWith("postgresql://")) {
    return createPostgresDatabase(url);
  }
  return new SqliteDatabase(url);
}

/** Apply db/schema.sql. Portable DDL: every statement is CREATE ... IF NOT EXISTS. */
export async function migrate(db: Database): Promise<void> {
  await db.exec(readFileSync(join(here, "..", "..", "db", "schema.sql"), "utf8"));
}

export async function openMigratedDatabase(url = ":memory:"): Promise<Database> {
  const db = openDatabase(url);
  await migrate(db);
  return db;
}
