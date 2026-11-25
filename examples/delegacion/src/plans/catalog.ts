import type { ReturnPolicyName } from "../policies/returns.js";
import type { ShippingTier } from "../shipping/rates.js";

/**
 * Catálogo de planes de suscripción de la tienda.
 *
 * Cada plan agrupa un precio mensual, lo que incluye el envío, el soporte y la política de devoluciones que se
 * aplica a sus pedidos. Los importes van en céntimos de euro, sin IVA: el IVA lo añade billing/taxes.ts al facturar.
 * Cambiar un plan aquí no cambia los pedidos ya hechos: cada pedido guarda una copia del plan con el que se pagó.
 */
export type PlanId = "basic" | "plus" | "pro";

export interface Plan {
  id: PlanId;
  /** Nombre que ve el cliente en la web y en las facturas. */
  displayName: string;
  /** Precio mensual en céntimos, sin IVA. */
  monthlyPriceCents: number;
  /** Precio anual en céntimos, sin IVA. Lleva descuento frente a doce meses sueltos. */
  yearlyPriceCents: number;
  /** Nivel de envío: decide la tarifa y el plazo de entrega (ver shipping/rates.ts). */
  shippingTier: ShippingTier;
  /** Política de devoluciones de los pedidos del plan (ver policies/returns.ts). */
  returnPolicy: ReturnPolicyName;
  /** Pedidos al mes con envío gratis. A partir de ahí se cobra la tarifa del nivel. */
  freeShipmentsPerMonth: number;
  /** Canal de soporte incluido. */
  support: "email" | "chat" | "phone";
  /** Si el cliente puede pausar la suscripción sin perder el precio. */
  canPause: boolean;
  /** Funciones extra que se muestran en la página de precios. */
  features: string[];
}

export const PLANS: Record<PlanId, Plan> = {
  basic: {
    id: "basic",
    displayName: "Básico",
    monthlyPriceCents: 499,
    yearlyPriceCents: 4_990,
    shippingTier: "standard",
    returnPolicy: "standard",
    freeShipmentsPerMonth: 0,
    support: "email",
    canPause: false,
    features: ["Seguimiento del pedido", "Lista de deseos"],
  },
  plus: {
    id: "plus",
    displayName: "Plus",
    monthlyPriceCents: 999,
    yearlyPriceCents: 9_990,
    shippingTier: "express",
    returnPolicy: "extended",
    freeShipmentsPerMonth: 4,
    support: "chat",
    canPause: true,
    features: ["Seguimiento del pedido", "Lista de deseos", "Ofertas anticipadas", "Envoltorio de regalo"],
  },
  pro: {
    id: "pro",
    displayName: "Pro",
    monthlyPriceCents: 1_999,
    yearlyPriceCents: 19_990,
    shippingTier: "priority",
    returnPolicy: "premium",
    freeShipmentsPerMonth: 20,
    support: "phone",
    canPause: true,
    features: [
      "Seguimiento del pedido",
      "Lista de deseos",
      "Ofertas anticipadas",
      "Envoltorio de regalo",
      "Recogida a domicilio de las devoluciones",
      "Gestor de cuenta",
    ],
  },
};

/** El plan de un cliente; sin suscripción, el básico. */
export function planOf(id: PlanId | null | undefined): Plan {
  return PLANS[id ?? "basic"];
}

/** Ahorro del pago anual frente a doce meses sueltos, en céntimos. */
export function yearlySavingsCents(plan: Plan): number {
  return plan.monthlyPriceCents * 12 - plan.yearlyPriceCents;
}

/** Orden de los planes en la página de precios: del más barato al más caro. */
export function plansForPricingPage(): Plan[] {
  return Object.values(PLANS).sort((a, b) => a.monthlyPriceCents - b.monthlyPriceCents);
}

/** Si cambiar de `from` a `to` es una subida (se cobra la diferencia prorrateada al momento). */
export function isUpgrade(from: PlanId, to: PlanId): boolean {
  return PLANS[to].monthlyPriceCents > PLANS[from].monthlyPriceCents;
}
