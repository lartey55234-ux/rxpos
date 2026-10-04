/**
 * Runtime configuration, read once from the environment.
 *
 * DATABASE_URL decides where the data lives: a postgres:// URL in production,
 * or a file path for SQLite locally. DATA_DIR is the fallback for a SQLite file
 * when no connection string is set.
 */

import { join, resolve } from "node:path";

export type Config = {
  port: number;
  host: string;
  dataDir: string;
  /** postgres:// for PostgreSQL, otherwise a SQLite file path or :memory:. */
  databaseUrl: string;
  seedDemo: boolean;
  /** Absent means card and mobile money are not offered. */
  paystackSecretKey: string | null;
  production: boolean;
};

const DEFAULT_PORT = 4173;

function flag(value: string | undefined, fallback: boolean): boolean {
  if (value === undefined || value === "") return fallback;
  return ["1", "true", "yes", "on"].includes(value.trim().toLowerCase());
}

export function loadConfig(env: Record<string, string | undefined> = process.env): Config {
  const production = env.NODE_ENV === "production";
  const dataDir = resolve(env.DATA_DIR ?? ".data");
  const databaseUrl = env.DATABASE_URL ?? env.DATABASE_PATH ?? join(dataDir, "rxpos.db");

  const port = Number(env.PORT ?? DEFAULT_PORT);
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    throw new Error(`PORT must be a number between 0 and 65535, got ${env.PORT}`);
  }

  return {
    port,
    host: env.HOST ?? "0.0.0.0",
    dataDir,
    databaseUrl,
    // A hosted demo wants the sample pharmacy; a real instance must not invent one.
    seedDemo: flag(env.SEED_DEMO, !production),
    paystackSecretKey: env.PAYSTACK_SECRET_KEY?.trim() || null,
    production,
  };
}
