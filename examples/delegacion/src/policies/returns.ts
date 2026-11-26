import { EXTENDED_RETURN_DAYS, PREMIUM_RETURN_DAYS, RESTOCKING_FEE_RATE, STANDARD_RETURN_DAYS } from "../config/limits.js";

/**
 * Políticas de devolución.
 *
 * Cada plan de suscripción apunta a una de estas políticas (campo `returnPolicy` de plans/catalog.ts). La política
 * decide cuánto tiempo tiene el cliente para pedir la devolución, si se le cobra la reposición del artículo y quién
 * paga el envío de vuelta. Los plazos no se escriben aquí: salen de config/limits.ts, para que legal pueda revisarlos
 * todos en un solo fichero.
 */
export type ReturnPolicyName = "standard" | "extended" | "premium";

export interface ReturnPolicy {
  name: ReturnPolicyName;
  /** Días naturales desde la entrega para pedir la devolución. */
  days: number;
  /** Parte del importe que se descuenta por reponer el artículo (0 = nada). */
  restockingFeeRate: number;
  /** Quién paga el envío de vuelta. */
  returnShippingPaidBy: "customer" | "store";
  /** Si se admite devolver artículos de la sección de rebajas. */
  acceptsSaleItems: boolean;
  /** Si la tienda pasa a recoger el paquete a domicilio. */
  homePickup: boolean;
}

export const RETURN_POLICIES: Record<ReturnPolicyName, ReturnPolicy> = {
  standard: {
    name: "standard",
    days: STANDARD_RETURN_DAYS,
    restockingFeeRate: RESTOCKING_FEE_RATE,
    returnShippingPaidBy: "customer",
    acceptsSaleItems: false,
    homePickup: false,
  },
  extended: {
    name: "extended",
    days: EXTENDED_RETURN_DAYS,
    restockingFeeRate: 0,
    returnShippingPaidBy: "customer",
    acceptsSaleItems: true,
    homePickup: false,
  },
  premium: {
    name: "premium",
    days: PREMIUM_RETURN_DAYS,
    restockingFeeRate: 0,
    returnShippingPaidBy: "store",
    acceptsSaleItems: true,
    homePickup: true,
  },
};

export function policyFor(name: ReturnPolicyName): ReturnPolicy {
  return RETURN_POLICIES[name];
}

/** Último día (incluido) en que se puede pedir la devolución de un pedido entregado en `deliveredAt`. */
export function returnDeadline(deliveredAt: Date, policy: ReturnPolicy): Date {
  const d = new Date(deliveredAt);
  d.setUTCDate(d.getUTCDate() + policy.days);
  return d;
}

/** Si a fecha `now` todavía se puede pedir la devolución. */
export function canStillReturn(deliveredAt: Date, policy: ReturnPolicy, now = new Date()): boolean {
  return now.getTime() <= returnDeadline(deliveredAt, policy).getTime();
}

/** Lo que se le reembolsa al cliente, en céntimos, por un artículo de `priceCents`. */
export function refundableCents(priceCents: number, policy: ReturnPolicy, onSale: boolean): number {
  if (onSale && !policy.acceptsSaleItems) return 0;
  return Math.round(priceCents * (1 - policy.restockingFeeRate));
}
