export const VAT_RATE = 0.21;

/** Descuento del 10 % para pedidos de 100 EUR o más (antes de impuestos). */
export const DISCOUNT_THRESHOLD = 100;
export const DISCOUNT_RATE = 0.1;

export function applyDiscount(subtotal: number): number {
  return subtotal >= DISCOUNT_THRESHOLD ? subtotal * (1 - DISCOUNT_RATE) : subtotal;
}

export function addVat(net: number): number {
  return net * (1 + VAT_RATE);
}
