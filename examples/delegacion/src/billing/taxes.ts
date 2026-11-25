/**
 * IVA de la tienda.
 *
 * Todos los precios del catálogo van sin IVA. Se añade al facturar, con el tipo general de España. Los clientes de
 * empresa de otro país de la UE con NIF-IVA válido no pagan IVA (inversión del sujeto pasivo): lo decide la capa de
 * facturación antes de llamar aquí, pasando `exempt`.
 */
export const VAT_RATE = 0.21;

/** IVA de una base en céntimos, redondeado al céntimo. */
export function vatCents(netCents: number, exempt = false): number {
  return exempt ? 0 : Math.round(netCents * VAT_RATE);
}

/** Precio con IVA, para mostrarlo en la web. */
export function grossCents(netCents: number, exempt = false): number {
  return netCents + vatCents(netCents, exempt);
}

/** Desglose para la factura: base, cuota y total. */
export function breakdown(netCents: number, exempt = false): { net: number; vat: number; total: number } {
  const vat = vatCents(netCents, exempt);
  return { net: netCents, vat, total: netCents + vat };
}

/** Formato de importe para facturas y correos: 1.234,56 €. */
export function formatEuros(cents: number): string {
  return new Intl.NumberFormat("es-ES", { style: "currency", currency: "EUR" }).format(cents / 100);
}
