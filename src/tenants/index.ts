import { TenantConfig } from "../types";
import { smartonDevTenant, smartonTenant } from "./smarton";

/** Реєстр апок. Щоб підключити нову — додайте її конфіг сюди. */
const tenants: Record<string, TenantConfig> = {
  [smartonTenant.id]: smartonTenant,
  [smartonDevTenant.id]: smartonDevTenant,
};

export function resolveTenant(id: string): TenantConfig | undefined {
  return Object.prototype.hasOwnProperty.call(tenants, id) ? tenants[id] : undefined;
}
