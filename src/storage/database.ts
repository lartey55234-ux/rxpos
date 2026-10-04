/**
 * One storage interface, two engines.
 *
 * Development and the fast test loop run on SQLite; production runs on
 * PostgreSQL. Everything above this line is written once, against this
 * interface, and the drivers absorb the differences.
 */

export type Engine = "sqlite" | "postgres";

export type Row = Record<string, unknown>;

export interface Database {
  readonly engine: Engine;
  /** SELECT many. */
  all<T = Row>(sql: string, params?: unknown[]): Promise<T[]>;
  /** SELECT one. */
  get<T = Row>(sql: string, params?: unknown[]): Promise<T | undefined>;
  /** INSERT, UPDATE or DELETE. Resolves to the number of rows affected. */
  run(sql: string, params?: unknown[]): Promise<number>;
  /** DDL, or several statements at once. */
  exec(sql: string): Promise<void>;
  /** Run fn inside a transaction. Rolls back if fn throws. */
  transaction<T>(fn: (tx: Database) => Promise<T>): Promise<T>;
  close(): Promise<void>;
}

/**
 * SQLite and PostgreSQL both accept `?` for the driver we hand them, but
 * PostgreSQL wants `$1, $2, ...`. Translating here keeps every query in the
 * codebase engine-neutral and readable. Placeholders inside string literals are
 * left alone.
 */
export function toPgPlaceholders(sql: string): string {
  let out = "";
  let index = 0;
  let inString = false;
  for (const char of sql) {
    if (char === "'") {
      inString = !inString;
      out += char;
      continue;
    }
    if (char === "?" && !inString) {
      index += 1;
      out += `$${index}`;
      continue;
    }
    out += char;
  }
  return out;
}
