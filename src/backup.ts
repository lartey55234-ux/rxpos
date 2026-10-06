/**
 * Taking everything out, and putting it back.
 *
 * Two jobs, one mechanism. A pharmacy will ask "can I get my data out?", and you
 * need to know you can restore after a mistake — a bad migration, a deleted
 * project, a corrupted row. Both are the same operation: read every table, write
 * it somewhere, and be able to load it back.
 *
 * Deliberately not pg_dump. That ties the restore to a matching client version
 * against a server that is newer than anything installed here, and it only works
 * for PostgreSQL. This reads through the same interface the app uses, so it works
 * on both engines and can be tested.
 *
 * The order matters: tables are written parents-first and cleared children-first,
 * because of the foreign keys.
 */

import type { Database } from "./storage/index.ts";

export type Backup = {
  version: 1;
  takenAt: string;
  engine: string;
  /** Table name to its rows, in dependency order. */
  tables: Record<string, Record<string, unknown>[]>;
};

/**
 * Every table, parents before children. The order is the restore order; the
 * reverse is the order to clear in.
 */
export const TABLES = [
  "plans",
  "tenants",
  "branches",
  "users",
  "sessions",
  "subscriptions",
  "categories",
  "products",
  "suppliers",
  "batches",
  "stock_movements",
  "purchases",
  "purchase_items",
  "customers",
  "prescriptions",
  "sales",
  "sale_items",
  "payments",
  "payment_intents",
  "controlled_register",
  "audit_log",
  "password_resets",
] as const;

export type TableName = (typeof TABLES)[number];

export async function exportAll(db: Database): Promise<Backup> {
  const tables: Record<string, Record<string, unknown>[]> = {};
  for (const table of TABLES) {
    tables[table] = await db.all<Record<string, unknown>>(`SELECT * FROM ${table}`);
  }
  return { version: 1, takenAt: new Date().toISOString(), engine: db.engine, tables };
}

export type RestoreReport = {
  tables: Record<string, number>;
  total: number;
};

/**
 * Load a backup into a database. `replace` empties the tables first, which is what
 * restoring into a database that already has data means; without it the load will
 * collide with rows that are already there.
 */
export async function importAll(
  db: Database,
  backup: Backup,
  options: { replace?: boolean } = {},
): Promise<RestoreReport> {
  if (backup?.version !== 1) throw new Error("That is not a backup this version can read");

  const report: RestoreReport = { tables: {}, total: 0 };

  await db.transaction(async (trx) => {
    if (options.replace) {
      // Children first, or the foreign keys stop us.
      for (const table of [...TABLES].reverse()) {
        await trx.run(`DELETE FROM ${table}`);
      }
    }

    for (const table of TABLES) {
      const rows = backup.tables[table] ?? [];
      if (!rows.length) {
        report.tables[table] = 0;
        continue;
      }

      // Columns come from the rows themselves, so a backup taken before a column
      // was added still loads.
      const columns = Object.keys(rows[0]);
      const placeholders = columns.map(() => "?").join(", ");
      const statement = `INSERT INTO ${table} (${columns.join(", ")}) VALUES (${placeholders})`;

      for (const row of rows) {
        await trx.run(
          statement,
          columns.map((column) => row[column] ?? null),
        );
      }
      report.tables[table] = rows.length;
      report.total += rows.length;
    }
  });

  return report;
}

/** What is in a database now, for comparing a restore against its source. */
export async function countAll(db: Database): Promise<Record<string, number>> {
  const counts: Record<string, number> = {};
  for (const table of TABLES) {
    const row = await db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM ${table}`);
    counts[table] = row?.n ?? 0;
  }
  return counts;
}
