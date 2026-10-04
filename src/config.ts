/**
 * Runtime configuration, read once from the environment.
 *
 * Local development keeps everything in memory. A deployed instance sets
 * DATA_DIR to a mounted disk so the database survives restarts and deploys.
 */

import { join, resolve } from "node:path";

export type Config = {
  port: number;
  host: string;
  dataDir: string;
  databasePath: string;
  seedDemo: boolean;
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
  const databasePath = env.DATABASE_PATH ?? join(dataDir, "rxpos.db");

  const port = Number(env.PORT ?? DEFAULT_PORT);
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    throw new Error(`PORT must be a number between 0 and 65535, got ${env.PORT}`);
  }

  return {
    port,
    host: env.HOST ?? "0.0.0.0",
    dataDir,
    databasePath,
    // A hosted demo wants the sample pharmacy; a real instance must not invent one.
    seedDemo: flag(env.SEED_DEMO, !production),
    production,
  };
}
