import type { Database } from "./storage/index.ts";

const MARKER = "{{tenant}}";

/**
 * Every tenant-owned read and write goes through a TenantScope.
 *
 * Queries mark the tenant filter with {{tenant}} — for example
 *   SELECT * FROM batches WHERE tenant_id = {{tenant}} AND branch_id = ?
 * and the scope substitutes the acting tenant's id at exactly that position.
 *
 * Binding by marker rather than by position matters: a query that filters the
 * tenant inside a JOIN has its placeholders in a different order than one that
 * filters in WHERE, and positional binding silently reads the wrong column.
 * A query with no marker, or with two, is refused before it reaches the database.
 */
export class TenantScope {
  db: Database;
  tenantId: string;

  constructor(db: Database, tenantId: string) {
    this.db = db;
    this.tenantId = tenantId;
  }

  private bind(sql: string, params: unknown[]): { sql: string; params: unknown[] } {
    const first = sql.indexOf(MARKER);
    if (first === -1) {
      throw new Error(
        `TenantScope: query is missing the {{tenant}} marker. Offending SQL: ${sql.slice(0, 90)}`,
      );
    }
    if (sql.indexOf(MARKER, first + MARKER.length) !== -1) {
      throw new Error(`TenantScope: query has more than one {{tenant}} marker. Offending SQL: ${sql.slice(0, 90)}`);
    }
    const position = sql.slice(0, first).split("?").length - 1;
    return {
      sql: sql.replace(MARKER, "?"),
      params: [...params.slice(0, position), this.tenantId, ...params.slice(position)],
    };
  }

  async all<T = Record<string, unknown>>(sql: string, ...params: unknown[]): Promise<T[]> {
    const bound = this.bind(sql, params);
    return this.db.all<T>(bound.sql, bound.params);
  }

  async get<T = Record<string, unknown>>(sql: string, ...params: unknown[]): Promise<T | undefined> {
    const bound = this.bind(sql, params);
    return this.db.get<T>(bound.sql, bound.params);
  }

  async run(sql: string, ...params: unknown[]): Promise<number> {
    const bound = this.bind(sql, params);
    return this.db.run(bound.sql, bound.params);
  }

  /** Insert a row, forcing tenant_id. Throws if the row tries to set its own. */
  async insert(table: string, row: Record<string, unknown>): Promise<void> {
    if ("tenant_id" in row) throw new Error("TenantScope.insert: do not set tenant_id yourself");
    const cols = ["tenant_id", ...Object.keys(row)];
    const placeholders = cols.map(() => "?").join(", ");
    await this.db.run(
      `INSERT INTO ${table} (${cols.join(", ")}) VALUES (${placeholders})`,
      [this.tenantId, ...Object.values(row)],
    );
  }

  /** The tenant row itself. */
  async tenant<T = Record<string, unknown>>(): Promise<T> {
    const row = await this.db.get("SELECT * FROM tenants WHERE tenant_id = ?", [this.tenantId]);
    if (!row) throw new Error(`Unknown tenant ${this.tenantId}`);
    return row as T;
  }
}
