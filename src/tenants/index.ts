import { TenantConfig } from "../types";
import { prontoTenant } from "./pronto";
import { smartonDevTenant, smartonTenant } from "./smarton";
import { smartonAdminDevTenant, smartonAdminTenant } from "./smarton_admin";

/** Реєстр апок. Щоб підключити нову — додайте її конфіг сюди. */
const tenants: Record<string, TenantConfig> = {
  [smartonTenant.id]: smartonTenant,
  [smartonDevTenant.id]: smartonDevTenant,
  [prontoTenant.id]: prontoTenant,
  [smartonAdminTenant.id]: smartonAdminTenant,
  [smartonAdminDevTenant.id]: smartonAdminDevTenant,
};

export function resolveTenant(id: string): TenantConfig | undefined {
  return Object.prototype.hasOwnProperty.call(tenants, id) ? tenants[id] : undefined;
}
