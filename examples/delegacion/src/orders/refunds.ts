import { type PlanId, planOf } from "../plans/catalog.js";
import { canStillReturn, policyFor, refundableCents, returnDeadline } from "../policies/returns.js";
import { notify } from "../notifications/templates.js";

/**
 * Solicitudes de devolución.
 *
 * Un cliente pide devolver uno o varios artículos de un pedido entregado. Aquí se decide si se acepta, cuánto se
 * reembolsa y qué correo se le manda. El plazo y las condiciones no se deciden aquí: vienen de la política de
 * devoluciones del plan con el que se pagó el pedido (no del plan que tenga hoy el cliente).
 */
export interface OrderLine {
  sku: string;
  priceCents: number;
  units: number;
  onSale: boolean;
}

export interface DeliveredOrder {
  id: string;
  customerEmail: string;
  /** Plan con el que se pagó el pedido. */
  planAtPurchase: PlanId;
  deliveredAt: Date;
  lines: OrderLine[];
}

export type RefundDecision =
  | { accepted: true; refundCents: number; deadline: Date; pickup: boolean }
  | { accepted: false; reason: "out_of_time" | "nothing_refundable" | "unknown_sku"; deadline: Date };

/**
 * Decide una devolución de las líneas `skus` del pedido. Con `now` se puede probar sin depender del reloj.
 * Si el pedido está fuera de plazo no se mira nada más.
 */
export function requestRefund(order: DeliveredOrder, skus: string[], now = new Date()): RefundDecision {
  const policy = policyFor(planOf(order.planAtPurchase).returnPolicy);
  const deadline = returnDeadline(order.deliveredAt, policy);
  if (!canStillReturn(order.deliveredAt, policy, now)) {
    notify(order.customerEmail, "refund_out_of_time", { orderId: order.id, deadline });
    return { accepted: false, reason: "out_of_time", deadline };
  }

  const lines = skus.map((sku) => order.lines.find((l) => l.sku === sku));
  if (lines.some((l) => !l)) return { accepted: false, reason: "unknown_sku", deadline };

  const refundCents = (lines as OrderLine[]).reduce((sum, l) => sum + refundableCents(l.priceCents, policy, l.onSale) * l.units, 0);
  if (refundCents === 0) {
    notify(order.customerEmail, "refund_nothing_refundable", { orderId: order.id });
    return { accepted: false, reason: "nothing_refundable", deadline };
  }

  notify(order.customerEmail, policy.homePickup ? "refund_accepted_pickup" : "refund_accepted", {
    orderId: order.id,
    amountCents: refundCents,
    days: policy.days,
  });
  return { accepted: true, refundCents, deadline, pickup: policy.homePickup };
}

/** Días que le quedan al cliente para pedir la devolución (0 si ya no puede). */
export function daysLeftToReturn(order: DeliveredOrder, now = new Date()): number {
  const policy = policyFor(planOf(order.planAtPurchase).returnPolicy);
  const ms = returnDeadline(order.deliveredAt, policy).getTime() - now.getTime();
  return Math.max(0, Math.ceil(ms / 86_400_000));
}
