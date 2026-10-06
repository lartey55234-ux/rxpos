/**
 * Where a fault goes, so it does not only arrive as a phone call.
 *
 * Both sides report here: the server when a request ends in a 500, and the browser
 * when something throws. Rows are grouped by a fingerprint — one row per distinct
 * fault with a count — so a loop that fails a thousand times is one line to read
 * rather than a thousand.
 *
 * Deliberately no request bodies and no headers. A sign-in body holds a password,
 * and an error report is not worth leaking one for. There is a test for that.
 */

import { createHash } from "node:crypto";
import type { Database } from "./storage/index.ts";
import { newId, nowIso } from "./util.ts";

export type ErrorSource = "server" | "client";

export type ErrorReport = {
  source: ErrorSource;
  message: string;
  stack?: string | null;
  path?: string | null;
  tenantId?: string | null;
  userId?: string | null;
  context?: Record<string, unknown> | null;
};

export type StoredError = {
  report_id: string;
  fingerprint: string;
  source: ErrorSource;
  tenant_id: string | null;
  path: string | null;
  message: string;
  stack: string | null;
  context_json: string | null;
  count: number;
  first_seen_at: string;
  last_seen_at: string;
};

const MAX_MESSAGE = 1000;
const MAX_STACK = 6000;
const KEEP_DAYS = 90;

const trim = (value: string | null | undefined, limit: number): string | null => {
  if (!value) return null;
  const text = String(value);
  return text.length > limit ? `${text.slice(0, limit)}…` : text;
};

/** The first frame of a stack, which is what actually distinguishes two faults. */
function firstFrame(stack: string | null | undefined): string {
  if (!stack) return "";
  const line = stack
    .split("\n")
    .map((part) => part.trim())
    .find((part) => part.startsWith("at "));
  return line ?? "";
}

/**
 * Anything carrying a digit is an identifier, whatever its shape. Stripping only
 * the digits is not enough: a UUID's letters differ too, so `bat_9f3e2c1a` and
 * `bat_2c1f9e8d` would stay two different faults for ever.
 *
 * This groups a little eagerly — "Paracetamol 500mg" becomes "Paracetamol ID" —
 * which is the right way to be wrong: the row keeps the message verbatim, so
 * nothing is lost by grouping two occurrences together.
 */
function normaliseIds(text: string): string {
  return text.replace(/\b\w*\d\w*\b/g, "ID");
}

/** Two faults are the same fault if they came from the same place with the same message. */
export function fingerprintOf(report: ErrorReport): string {
  const normalised = [
    report.source,
    normaliseIds(report.message ?? ""),
    firstFrame(report.stack),
    normaliseIds(report.path ?? ""),
  ].join("|");
  return createHash("sha256").update(normalised).digest("hex").slice(0, 32);
}

/**
 * Record a fault. Never throws: a failure while reporting a failure must not
 * become the thing that takes the request down.
 */
export async function recordError(db: Database, report: ErrorReport): Promise<void> {
  try {
    const message = trim(report.message || "Unknown error", MAX_MESSAGE) ?? "Unknown error";
    const stack = trim(report.stack, MAX_STACK);
    const now = nowIso();

    await db.run(
      `INSERT INTO error_reports
         (report_id, fingerprint, source, tenant_id, user_id, path, message, stack, context_json, count, first_seen_at, last_seen_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)
       ON CONFLICT(fingerprint) DO UPDATE SET
         count        = error_reports.count + 1,
         last_seen_at = excluded.last_seen_at,
         -- The row shows the most recent occurrence throughout, rather than a mix
         -- of the first message and the latest stack.
         message      = excluded.message,
         stack        = COALESCE(excluded.stack, error_reports.stack),
         path         = COALESCE(excluded.path, error_reports.path)`,
      [
        newId("err"),
        fingerprintOf(report),
        report.source,
        report.tenantId ?? null,
        report.userId ?? null,
        trim(report.path, 300),
        message,
        stack,
        report.context ? JSON.stringify(report.context).slice(0, 2000) : null,
        now,
        now,
      ],
    );

    // Keep the list to what is worth reading. Cheap, and only on the way in.
    const cutoff = new Date(Date.now() - KEEP_DAYS * 86_400_000).toISOString();
    await db.run("DELETE FROM error_reports WHERE last_seen_at < ?", [cutoff]);
  } catch (err) {
    console.error("[rxpos] could not record an error report:", err);
  }
}

/** Newest first, because the thing that just broke is the thing worth reading. */
export async function listErrors(db: Database, limit = 100): Promise<StoredError[]> {
  return db.all<StoredError>(
    "SELECT * FROM error_reports ORDER BY last_seen_at DESC LIMIT ?",
    [Math.min(Math.max(Number(limit) || 100, 1), 500)],
  );
}

/** How many distinct faults, and how many times in total, in the last day. */
export async function errorSummary(db: Database): Promise<{ faults: number; occurrences: number }> {
  const since = new Date(Date.now() - 86_400_000).toISOString();
  const row = await db.get<{ faults: number; occurrences: number | null }>(
    "SELECT COUNT(*) AS faults, SUM(count) AS occurrences FROM error_reports WHERE last_seen_at >= ?",
    [since],
  );
  return { faults: row?.faults ?? 0, occurrences: row?.occurrences ?? 0 };
}

export async function clearErrors(db: Database): Promise<number> {
  const before = await db.get<{ n: number }>("SELECT COUNT(*) AS n FROM error_reports");
  await db.run("DELETE FROM error_reports");
  return before?.n ?? 0;
}
