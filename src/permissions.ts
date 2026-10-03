export type Role = "owner" | "admin" | "salesperson";

export type Permission =
  | "sell"
  | "dispense_controlled"
  | "stock"
  | "products"
  | "suppliers"
  | "users"
  | "assets"
  | "plans"
  | "reports";

/**
 * Asset values are owner-only: administrators manage stock and sales but never
 * see what the pharmacy is worth. Salespeople only sell.
 */
const MATRIX: Record<Permission, Role[]> = {
  sell: ["owner", "admin", "salesperson"],
  dispense_controlled: ["owner", "admin"],
  stock: ["owner", "admin"],
  products: ["owner", "admin"],
  suppliers: ["owner", "admin"],
  users: ["owner", "admin"],
  assets: ["owner"],
  plans: ["owner"],
  reports: ["owner", "admin"],
};

export class PermissionError extends Error {
  role: Role;
  permission: Permission;

  constructor(role: Role, permission: Permission) {
    super(`Role "${role}" is not allowed to ${permission}`);
    this.name = "PermissionError";
    this.role = role;
    this.permission = permission;
  }
}

export function can(role: Role, permission: Permission): boolean {
  return MATRIX[permission].includes(role);
}

export function assertCan(role: Role, permission: Permission): void {
  if (!can(role, permission)) throw new PermissionError(role, permission);
}
