import pg from "pg";
import type { Database, Engine, Row } from "./database.ts";
import { toPgPlaceholders } from "./database.ts";

/**
 * PostgreSQL counts in 64-bit and node-postgres hands those back as strings.
 * Left alone, every COUNT(*) in the codebase compares as a string, so a plan
 * limit check like `used >= limit` would quietly always be false and the limits
 * would stop working without anything failing.
 */
pg.types.setTypeParser(20, (value: string) => Number(value));

export class PostgresDatabase implements Database {
  readonly engine: Engine = "postgres";

  private readonly pool: pg.Pool;
  /** Set when this handle is bound to a checked-out client inside a transaction. */
  private readonly client: pg.PoolClient | null;
  private savepoints = 0;

  constructor(pool: pg.Pool, client: pg.PoolClient | null = null) {
    this.pool = pool;
    this.client = client;
  }

  private runner(): pg.Pool | pg.PoolClient {
    return this.client ?? this.pool;
  }

  async all<T = Row>(sql: string, params: unknown[] = []): Promise<T[]> {
    const result = await this.runner().query(toPgPlaceholders(sql), params);
    return result.rows as T[];
  }

  async get<T = Row>(sql: string, params: unknown[] = []): Promise<T | undefined> {
    const rows = await this.all<T>(sql, params);
    return rows[0];
  }

  async run(sql: string, params: unknown[] = []): Promise<number> {
    const result = await this.runner().query(toPgPlaceholders(sql), params);
    return result.rowCount ?? 0;
  }

  async exec(sql: string): Promise<void> {
    await this.runner().query(sql);
  }

  async transaction<T>(fn: (tx: Database) => Promise<T>): Promise<T> {
    const client = this.client;

    // Already inside a transaction: nest with a savepoint rather than a second BEGIN.
    if (client) {
      this.savepoints += 1;
      const name = `rxpos_sp_${this.savepoints}`;
      await client.query(`SAVEPOINT ${name}`);
      try {
        const out = await fn(this);
        await client.query(`RELEASE SAVEPOINT ${name}`);
        return out;
      } catch (err) {
        await client.query(`ROLLBACK TO SAVEPOINT ${name}`);
        throw err;
      }
    }

    const checkedOut = await this.pool.connect();
    try {
      await checkedOut.query("BEGIN");
      const out = await fn(new PostgresDatabase(this.pool, checkedOut));
      await checkedOut.query("COMMIT");
      return out;
    } catch (err) {
      await checkedOut.query("ROLLBACK");
      throw err;
    } finally {
      checkedOut.release();
    }
  }

  async close(): Promise<void> {
    if (!this.client) await this.pool.end();
  }
}

export function createPostgresDatabase(connectionString: string): PostgresDatabase {
  const pool = new pg.Pool({
    connectionString,
    max: 10,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 10_000,
  });
  return new PostgresDatabase(pool);
}
