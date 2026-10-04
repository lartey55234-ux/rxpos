import { DatabaseSync } from "node:sqlite";
import type { Database, Engine, Row } from "./database.ts";

export class SqliteDatabase implements Database {
  readonly engine: Engine = "sqlite";

  private readonly handle: DatabaseSync;
  private depth = 0;
  /**
   * SQLite has a single writer, and `await` yields to the event loop, so two
   * transactions could otherwise interleave their statements on one connection.
   * Serialise them.
   */
  private queue: Promise<unknown> = Promise.resolve();

  constructor(path: string) {
    this.handle = new DatabaseSync(path);
    this.handle.exec("PRAGMA foreign_keys = ON");
    // Write-ahead logging so a redeploy cannot corrupt a database that lives on disk.
    if (path !== ":memory:") this.handle.exec("PRAGMA journal_mode = WAL");
  }

  async all<T = Row>(sql: string, params: unknown[] = []): Promise<T[]> {
    return this.handle.prepare(sql).all(...(params as never[])) as T[];
  }

  async get<T = Row>(sql: string, params: unknown[] = []): Promise<T | undefined> {
    return this.handle.prepare(sql).get(...(params as never[])) as T | undefined;
  }

  async run(sql: string, params: unknown[] = []): Promise<number> {
    const result = this.handle.prepare(sql).run(...(params as never[]));
    return Number(result.changes);
  }

  async exec(sql: string): Promise<void> {
    this.handle.exec(sql);
  }

  async transaction<T>(fn: (tx: Database) => Promise<T>): Promise<T> {
    if (this.depth > 0) return this.nested(fn);
    const result = this.queue.then(() => this.outer(fn));
    this.queue = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  private async outer<T>(fn: (tx: Database) => Promise<T>): Promise<T> {
    this.handle.exec("BEGIN");
    this.depth = 1;
    try {
      const out = await fn(this);
      this.depth = 0;
      this.handle.exec("COMMIT");
      return out;
    } catch (err) {
      this.depth = 0;
      this.handle.exec("ROLLBACK");
      throw err;
    }
  }

  private async nested<T>(fn: (tx: Database) => Promise<T>): Promise<T> {
    const name = `rxpos_sp_${this.depth}`;
    this.handle.exec(`SAVEPOINT ${name}`);
    this.depth += 1;
    try {
      const out = await fn(this);
      this.depth -= 1;
      this.handle.exec(`RELEASE SAVEPOINT ${name}`);
      return out;
    } catch (err) {
      this.depth -= 1;
      this.handle.exec(`ROLLBACK TO SAVEPOINT ${name}`);
      throw err;
    }
  }

  async close(): Promise<void> {
    this.handle.close();
  }
}
