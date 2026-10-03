import type { Actor } from "./actor.ts";
import { assertCan } from "./permissions.ts";
import { daysUntil, todayIso } from "./util.ts";

export type AssetValues = {
  totalPesewas: number;
  safePesewas: number;
  atRiskPesewas: number;
  lostPesewas: number;
  nonPerishablePesewas: number;
};

type Row = {
  quantity: number;
  expiry_date: string | null;
  perishable: number;
  selling_price_pesewas: number;
};

/**
 * Owner-only. Total, safe, at-risk and lost asset values are computed from
 * batches, because that is the number a pharmacy owner actually acts on.
 */
export function assetValues(actor: Actor, branchId: string): AssetValues {
  assertCan(actor.role, "assets");
  const rows = actor.scope.all<Row>(
    `SELECT b.quantity, b.expiry_date, p.perishable, b.selling_price_pesewas
       FROM batches b JOIN products p ON p.product_id = b.product_id
      WHERE b.tenant_id = {{tenant}} AND b.branch_id = ? AND b.quantity > 0`,
    branchId,
  );

  const out: AssetValues = { totalPesewas: 0, safePesewas: 0, atRiskPesewas: 0, lostPesewas: 0, nonPerishablePesewas: 0 };
  for (const row of rows) {
    const value = row.quantity * row.selling_price_pesewas;
    out.totalPesewas += value;
    if (row.perishable === 0 || row.expiry_date === null) {
      out.safePesewas += value;
      if (row.perishable === 0) out.nonPerishablePesewas += value;
      continue;
    }
    const days = daysUntil(row.expiry_date) ?? 0;
    if (days < 0) out.lostPesewas += value;
    else if (days <= 365) out.atRiskPesewas += value;
    else out.safePesewas += value;
  }
  return out;
}

export function salesSummary(actor: Actor, branchId: string, days = 7) {
  assertCan(actor.role, "reports");
  const from = new Date(Date.now() - (days - 1) * 86_400_000).toISOString().slice(0, 10);
  const row = actor.scope.get<{ revenue: number; cost: number; transactions: number }>(
    `SELECT COALESCE(SUM(si.line_total_pesewas), 0) AS revenue,
            COALESCE(SUM(si.quantity * b.cost_price_pesewas), 0) AS cost,
            COUNT(DISTINCT s.sale_id) AS transactions
       FROM sale_items si
       JOIN sales s ON s.sale_id = si.sale_id
       JOIN batches b ON b.batch_id = si.batch_id
      WHERE si.tenant_id = {{tenant}} AND s.branch_id = ? AND s.sale_date >= ?`,
    branchId,
    `${from}T00:00:00.000Z`,
  );
  const revenue = row?.revenue ?? 0;
  const cost = row?.cost ?? 0;
  return {
    from,
    revenuePesewas: revenue,
    grossProfitPesewas: revenue - cost,
    transactions: row?.transactions ?? 0,
    averageBasketPesewas: row?.transactions ? Math.round(revenue / row.transactions) : 0,
  };
}

export function topProducts(actor: Actor, branchId: string, days = 7, limit = 5) {
  assertCan(actor.role, "reports");
  const from = new Date(Date.now() - (days - 1) * 86_400_000).toISOString().slice(0, 10);
  return actor.scope.all(
    `SELECT p.name, SUM(si.quantity) AS units, SUM(si.line_total_pesewas) AS revenue_pesewas
       FROM sale_items si
       JOIN sales s ON s.sale_id = si.sale_id
       JOIN products p ON p.product_id = si.product_id
      WHERE si.tenant_id = {{tenant}} AND s.branch_id = ? AND s.sale_date >= ?
      GROUP BY p.product_id, p.name
      ORDER BY units DESC
      LIMIT ${Number(limit)}`,
    branchId,
    `${from}T00:00:00.000Z`,
  );
}

export function todayTotals(actor: Actor, branchId: string) {
  assertCan(actor.role, "reports");
  const row = actor.scope.get<{ revenue: number; transactions: number }>(
    `SELECT COALESCE(SUM(total_pesewas), 0) AS revenue, COUNT(*) AS transactions
       FROM sales
      WHERE tenant_id = {{tenant}} AND branch_id = ? AND sale_date >= ?`,
    branchId,
    `${todayIso()}T00:00:00.000Z`,
  );
  return { revenuePesewas: row?.revenue ?? 0, transactions: row?.transactions ?? 0 };
}
