import { MAX_PARCEL_GRAMS, PREPARATION_BUSINESS_DAYS } from "../config/limits.js";
import { type Zone, zoneOf } from "./zones.js";

/**
 * Tarifas y plazos de envío.
 *
 * Cada plan tiene un nivel de envío (campo `shippingTier` de plans/catalog.ts). El nivel decide el precio por
 * paquete y los días hábiles de entrega según la zona del destino. Los pedidos que pesan más que un paquete se
 * parten y se cobra cada paquete. Los envíos gratis del plan se descuentan antes de llegar aquí.
 */
export type ShippingTier = "standard" | "express" | "priority";

interface TierRate {
  /** Precio por paquete en céntimos, sin IVA, por zona. */
  priceCents: Record<Zone, number>;
  /** Días hábiles de transporte por zona (sin contar la preparación). */
  transitDays: Record<Zone, number>;
}

const RATES: Record<ShippingTier, TierRate> = {
  standard: {
    priceCents: { peninsula: 495, islands: 995, international: 1_995 },
    transitDays: { peninsula: 4, islands: 6, international: 9 },
  },
  express: {
    priceCents: { peninsula: 795, islands: 1_495, international: 2_995 },
    transitDays: { peninsula: 2, islands: 3, international: 5 },
  },
  priority: {
    priceCents: { peninsula: 995, islands: 1_795, international: 3_495 },
    transitDays: { peninsula: 1, islands: 2, international: 3 },
  },
};

/** Cuántos paquetes hacen falta para `grams`. */
export function parcelsFor(grams: number): number {
  return Math.max(1, Math.ceil(grams / MAX_PARCEL_GRAMS));
}

/** Coste del envío de un pedido, en céntimos, sin IVA. */
export function shippingCostCents(tier: ShippingTier, postalCode: string, grams: number): number {
  const zone = zoneOf(postalCode);
  return RATES[tier].priceCents[zone] * parcelsFor(grams);
}

/** Días hábiles hasta la entrega: preparación más transporte. */
export function deliveryBusinessDays(tier: ShippingTier, postalCode: string): number {
  return PREPARATION_BUSINESS_DAYS + RATES[tier].transitDays[zoneOf(postalCode)];
}

/** Texto para la página del pedido: «Llega en 2-3 días hábiles». */
export function deliveryEstimate(tier: ShippingTier, postalCode: string): string {
  const days = deliveryBusinessDays(tier, postalCode);
  return days <= 1 ? "Llega mañana" : `Llega en ${days - 1}-${days} días hábiles`;
}
