import { MAX_LINES_PER_ORDER, MAX_UNITS_PER_LINE, MIN_ORDER_CENTS } from "../config/limits.js";
import { breakdown } from "../billing/taxes.js";
import { type PlanId, planOf } from "../plans/catalog.js";
import { deliveryEstimate, shippingCostCents } from "../shipping/rates.js";

/**
 * Cierre del pedido.
 *
 * Valida el carrito, calcula el envío según el plan del cliente y los envíos gratis que le quedan este mes, y
 * devuelve el resumen que se enseña antes de pagar. No cobra: el cobro lo hace la pasarela con el total de aquí.
 */
export interface CartLine {
  sku: string;
  priceCents: number;
  units: number;
  grams: number;
}

export interface CheckoutSummary {
  subtotalCents: number;
  shippingCents: number;
  vatCents: number;
  totalCents: number;
  estimate: string;
}

export class CheckoutError extends Error {}

export function checkout(lines: CartLine[], plan: PlanId, postalCode: string, freeShipmentsUsed: number): CheckoutSummary {
  if (lines.length === 0) throw new CheckoutError("El carrito está vacío.");
  if (lines.length > MAX_LINES_PER_ORDER) throw new CheckoutError(`Como mucho ${MAX_LINES_PER_ORDER} artículos distintos por pedido.`);
  for (const l of lines)
    if (l.units < 1 || l.units > MAX_UNITS_PER_LINE) throw new CheckoutError(`Entre 1 y ${MAX_UNITS_PER_LINE} unidades de ${l.sku}.`);

  const subtotalCents = lines.reduce((s, l) => s + l.priceCents * l.units, 0);
  if (subtotalCents < MIN_ORDER_CENTS) throw new CheckoutError("El pedido no llega al importe mínimo.");

  const p = planOf(plan);
  const grams = lines.reduce((s, l) => s + l.grams * l.units, 0);
  const free = freeShipmentsUsed < p.freeShipmentsPerMonth;
  const shippingCents = free ? 0 : shippingCostCents(p.shippingTier, postalCode, grams);
  const { vat, total } = breakdown(subtotalCents + shippingCents);
  return { subtotalCents, shippingCents, vatCents: vat, totalCents: total, estimate: deliveryEstimate(p.shippingTier, postalCode) };
}
