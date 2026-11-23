import { TenantConfig } from "../types";
import { prontoTenant } from "./pronto";
import { smartonDevTenant, smartonTenant } from "./smarton";

/** Реєстр апок. Щоб підключити нову — додайте її конфіг сюди. */
const tenants: Record<string, TenantConfig> = {
  [smartonTenant.id]: smartonTenant,
  [smartonDevTenant.id]: smartonDevTenant,
  [prontoTenant.id]: prontoTenant,
};

export function resolveTenant(id: string): TenantConfig | undefined {
  return Object.prototype.hasOwnProperty.call(tenants, id) ? tenants[id] : undefined;
}
