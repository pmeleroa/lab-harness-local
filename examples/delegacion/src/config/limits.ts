/**
 * Límites y plazos de la tienda en un solo sitio.
 *
 * Todo lo que tenga que revisar legal o atención al cliente (plazos de devolución, de pago o de prueba, topes de
 * pedido) vive aquí, y el resto del código lo importa. Si cambias un valor, revisa también los textos de
 * notifications/templates.ts: algunos lo citan en los correos.
 */

// --- Devoluciones (ver policies/returns.ts) ---

/** Plazo de devolución por defecto, en días naturales desde la entrega. El mínimo legal en la UE. */
export const STANDARD_RETURN_DAYS = 14;
/** Plazo de la política ampliada. */
export const EXTENDED_RETURN_DAYS = 30;
/** Plazo de la política premium. */
export const PREMIUM_RETURN_DAYS = 45;
/** Parte del importe que se descuenta por reponer un artículo en la política estándar. */
export const RESTOCKING_FEE_RATE = 0.1;

// --- Pagos y facturas (ver billing/invoices.ts) ---

/** Días para pagar una factura de empresa antes de marcarla como vencida. */
export const PAYMENT_TERMS_DAYS = 30;
/** Días de gracia tras el vencimiento antes de suspender una suscripción impagada. */
export const PAYMENT_GRACE_DAYS = 7;
/** Reintentos de cobro de una tarjeta rechazada, uno al día. */
export const CARD_RETRY_ATTEMPTS = 3;

// --- Cuentas y suscripciones (ver customers/accounts.ts) ---

/** Días de prueba gratis de un plan de pago para un cliente nuevo. */
export const TRIAL_DAYS = 21;
/** Meses que se puede pausar una suscripción en un año. */
export const MAX_PAUSE_MONTHS_PER_YEAR = 3;
/** Días que se guarda una cuenta cerrada antes de borrar sus datos. */
export const CLOSED_ACCOUNT_RETENTION_DAYS = 90;

// --- Pedidos (ver orders/checkout.ts) ---

/** Artículos distintos como máximo en un pedido. */
export const MAX_LINES_PER_ORDER = 50;
/** Unidades como máximo de un mismo artículo en un pedido. */
export const MAX_UNITS_PER_LINE = 10;
/** Importe mínimo de un pedido, en céntimos, sin IVA. */
export const MIN_ORDER_CENTS = 500;
/** Minutos que se reserva el stock de un carrito antes de liberarlo. */
export const CART_RESERVATION_MINUTES = 20;

// --- Envíos (ver shipping/rates.ts) ---

/** Peso máximo de un paquete, en gramos. Por encima se parte en varios envíos. */
export const MAX_PARCEL_GRAMS = 20_000;
/** Días hábiles que se tarda en preparar un pedido antes de entregarlo al transportista. */
export const PREPARATION_BUSINESS_DAYS = 1;

// --- Atención al cliente ---

/** Horas para responder a un correo de soporte. */
export const SUPPORT_EMAIL_RESPONSE_HOURS = 48;
/** Horas para responder por chat en horario laboral. */
export const SUPPORT_CHAT_RESPONSE_HOURS = 2;
