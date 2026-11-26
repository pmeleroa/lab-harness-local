import { CARD_RETRY_ATTEMPTS, PAYMENT_GRACE_DAYS, PAYMENT_TERMS_DAYS } from "../config/limits.js";
import { type Plan, planOf } from "../plans/catalog.js";
import { vatCents } from "./taxes.js";

/**
 * Facturas de las suscripciones.
 *
 * Cada mes (o cada año, con pago anual) se emite una factura por el precio del plan. Las de particulares se cobran
 * con tarjeta al momento; las de empresa se pagan por transferencia dentro del plazo de pago. Una factura que vence
 * sin pagarse da unos días de gracia antes de suspender la suscripción.
 */
export type InvoiceStatus = "draft" | "issued" | "paid" | "overdue" | "void";

export interface Invoice {
  number: string;
  customerId: string;
  plan: Plan["id"];
  period: "monthly" | "yearly";
  issuedAt: Date;
  /** Base sin IVA, en céntimos. */
  netCents: number;
  vatCents: number;
  totalCents: number;
  status: InvoiceStatus;
  /** Solo empresas: fecha límite de pago. */
  dueAt?: Date;
  /** Intentos de cobro con tarjeta hechos hasta ahora. */
  cardAttempts: number;
}

/** Numeración correlativa por año: 2026-000123. */
export function invoiceNumber(year: number, sequence: number): string {
  return `${year}-${String(sequence).padStart(6, "0")}`;
}

export function issueInvoice(customerId: string, planId: Plan["id"], period: Invoice["period"], business: boolean, seq: number, now = new Date()): Invoice {
  const plan = planOf(planId);
  const netCents = period === "yearly" ? plan.yearlyPriceCents : plan.monthlyPriceCents;
  const vat = vatCents(netCents);
  const invoice: Invoice = {
    number: invoiceNumber(now.getUTCFullYear(), seq),
    customerId,
    plan: planId,
    period,
    issuedAt: now,
    netCents,
    vatCents: vat,
    totalCents: netCents + vat,
    status: "issued",
    cardAttempts: 0,
  };
  if (business) invoice.dueAt = addDays(now, PAYMENT_TERMS_DAYS);
  return invoice;
}

/** Si la suscripción de esta factura se debe suspender a fecha `now`. */
export function shouldSuspend(invoice: Invoice, now = new Date()): boolean {
  if (invoice.status === "paid" || invoice.status === "void") return false;
  if (invoice.dueAt) return now.getTime() > addDays(invoice.dueAt, PAYMENT_GRACE_DAYS).getTime();
  return invoice.cardAttempts >= CARD_RETRY_ATTEMPTS;
}

function addDays(d: Date, days: number): Date {
  const out = new Date(d);
  out.setUTCDate(out.getUTCDate() + days);
  return out;
}
