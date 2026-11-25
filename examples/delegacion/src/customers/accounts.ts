import { CLOSED_ACCOUNT_RETENTION_DAYS, MAX_PAUSE_MONTHS_PER_YEAR, TRIAL_DAYS } from "../config/limits.js";
import { type PlanId, planOf } from "../plans/catalog.js";

/**
 * Cuentas de cliente y estado de su suscripción.
 *
 * Una cuenta nueva puede probar un plan de pago gratis durante el periodo de prueba; al acabar, se cobra la primera
 * factura o vuelve al plan básico si no hay tarjeta. Los planes que lo permiten se pueden pausar unos meses al año
 * sin perder el precio. Al cerrar una cuenta se guardan sus datos un tiempo por si el cliente vuelve.
 */
export type SubscriptionState = "trial" | "active" | "paused" | "suspended" | "closed";

export interface Account {
  id: string;
  email: string;
  plan: PlanId;
  state: SubscriptionState;
  createdAt: Date;
  trialEndsAt?: Date;
  /** Meses pausados en el año en curso. */
  pausedMonthsThisYear: number;
  closedAt?: Date;
}

export function openAccount(id: string, email: string, plan: PlanId, now = new Date()): Account {
  const paid = plan !== "basic";
  return {
    id,
    email,
    plan,
    state: paid ? "trial" : "active",
    createdAt: now,
    ...(paid ? { trialEndsAt: addDays(now, TRIAL_DAYS) } : {}),
    pausedMonthsThisYear: 0,
  };
}

/** Si la cuenta puede pausar `months` meses más este año. */
export function canPause(account: Account, months: number): boolean {
  if (!planOf(account.plan).canPause || account.state !== "active") return false;
  return account.pausedMonthsThisYear + months <= MAX_PAUSE_MONTHS_PER_YEAR;
}

/** Fecha a partir de la cual se pueden borrar los datos de una cuenta cerrada. */
export function deletionDate(account: Account): Date | null {
  return account.closedAt ? addDays(account.closedAt, CLOSED_ACCOUNT_RETENTION_DAYS) : null;
}

/** Cambio de plan: una subida se aplica al momento; una bajada, al acabar el periodo pagado. */
export function changePlan(account: Account, to: PlanId): Account {
  return { ...account, plan: to };
}

function addDays(d: Date, days: number): Date {
  const out = new Date(d);
  out.setUTCDate(out.getUTCDate() + days);
  return out;
}
