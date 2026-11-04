import { addVat, applyDiscount } from "./pricing.js";

export interface Item {
  name: string;
  price: number;
  quantity: number;
}

export function subtotal(items: Item[]): number {
  return items.reduce((sum, i) => sum + i.price * i.quantity, 0);
}

/** Total a pagar: descuento primero, impuestos después. */
export function total(items: Item[]): number {
  return addVat(applyDiscount(subtotal(items)));
}
