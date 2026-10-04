import type { TenantScope } from "./tenant.ts";

export type PlanKind = "products" | "shops" | "staff" | "suppliers";

export type PlanSeed = {
  plan_id: string;
  name: string;
  price_pesewas: number;
  max_products: number | null;
  max_shops: number;
  max_staff: number;
  max_suppliers: number;
};

/** Mirrors the published market tiers: Free / Starter / Standard / Pro. */
export const PLAN_SEED: PlanSeed[] = [
  { plan_id: "free", name: "Free", price_pesewas: 0, max_products: 20, max_shops: 1, max_staff: 0, max_suppliers: 2 },
  { plan_id: "starter", name: "Starter", price_pesewas: 6000, max_products: 200, max_shops: 2, max_staff: 2, max_suppliers: 4 },
  { plan_id: "standard", name: "Standard", price_pesewas: 10000, max_products: null, max_shops: 3, max_staff: 4, max_suppliers: 6 },
  { plan_id: "pro", name: "Pro", price_pesewas: 15000, max_products: null, max_shops: 4, max_staff: 8, max_suppliers: 8 },
];

export class PlanLimitError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PlanLimitError";
  }
}

export async function planFor(scope: TenantScope): Promise<PlanSeed> {
  const tenant = await scope.tenant<{ plan_id: string }>();
  const row = await scope.db.get<PlanSeed>("SELECT * FROM plans WHERE plan_id = ?", [tenant.plan_id]);
  if (!row) throw new Error(`Unknown plan ${tenant.plan_id}`);
  return row;
}

export async function usageFor(scope: TenantScope, kind: PlanKind): Promise<number> {
  const count = async (sql: string): Promise<number> => {
    const row = await scope.db.get<{ n: number }>(sql, [scope.tenantId]);
    return row?.n ?? 0;
  };
  switch (kind) {
    case "products":
      return count("SELECT COUNT(*) AS n FROM products WHERE tenant_id = ? AND status = 'active'");
    case "shops":
      return count("SELECT COUNT(*) AS n FROM branches WHERE tenant_id = ?");
    case "staff":
      return count("SELECT COUNT(*) AS n FROM users WHERE tenant_id = ? AND role <> 'owner'");
    case "suppliers":
      return count("SELECT COUNT(*) AS n FROM suppliers WHERE tenant_id = ?");
  }
}

/** Call before creating a product, branch, staff account or supplier. */
export async function assertWithinPlan(scope: TenantScope, kind: PlanKind): Promise<void> {
  const plan = await planFor(scope);
  const used = await usageFor(scope, kind);
  const limit = kind === "products" ? plan.max_products
    : kind === "shops" ? plan.max_shops
    : kind === "staff" ? plan.max_staff
    : plan.max_suppliers;
  if (limit === null) return;
  if (used >= limit) {
    throw new PlanLimitError(
      `${plan.name} allows ${limit} ${kind}. Current usage is ${used}. Upgrade the plan to add more.`,
    );
  }
}
