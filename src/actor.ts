import type { TenantScope } from "./tenant.ts";
import type { Role } from "./permissions.ts";

/** An authenticated request: who is acting, for which tenant, with what role. */
export type Actor = {
  scope: TenantScope;
  userId: string;
  role: Role;
};
