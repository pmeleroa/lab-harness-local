import { formatEuros } from "../billing/taxes.js";

/**
 * Correos al cliente.
 *
 * Cada plantilla recibe los datos del caso y devuelve asunto y cuerpo. Los plazos se pasan como datos: ninguna
 * plantilla escribe un número de días fijo, para que no se desincronicen de config/limits.ts. El envío real lo hace
 * el proveedor de correo; en desarrollo, `notify` solo lo deja en la consola.
 */
export type TemplateId =
  | "order_confirmed"
  | "order_shipped"
  | "refund_accepted"
  | "refund_accepted_pickup"
  | "refund_out_of_time"
  | "refund_nothing_refundable"
  | "trial_ending";

type Data = Record<string, unknown>;

const TEMPLATES: Record<TemplateId, (d: Data) => { subject: string; body: string }> = {
  order_confirmed: (d) => ({ subject: `Pedido ${d.orderId} confirmado`, body: `Hemos recibido tu pedido. ${d.estimate}.` }),
  order_shipped: (d) => ({ subject: `Pedido ${d.orderId} enviado`, body: `Tu pedido va de camino. Seguimiento: ${d.tracking}.` }),
  refund_accepted: (d) => ({
    subject: `Devolución del pedido ${d.orderId} aceptada`,
    body: `Te devolveremos ${formatEuros(Number(d.amountCents))} cuando recibamos el paquete. Tenías ${d.days} días para pedirla.`,
  }),
  refund_accepted_pickup: (d) => ({
    subject: `Devolución del pedido ${d.orderId} aceptada`,
    body: `Pasaremos a recoger el paquete en los próximos días. Te devolveremos ${formatEuros(Number(d.amountCents))}.`,
  }),
  refund_out_of_time: (d) => ({
    subject: `No podemos aceptar la devolución del pedido ${d.orderId}`,
    body: `El plazo terminó el ${(d.deadline as Date).toLocaleDateString("es-ES")}. Si crees que es un error, responde a este correo.`,
  }),
  refund_nothing_refundable: (d) => ({
    subject: `Devolución del pedido ${d.orderId}`,
    body: "Los artículos que has elegido no admiten devolución (por ejemplo, los de rebajas en tu plan).",
  }),
  trial_ending: (d) => ({ subject: "Tu prueba termina pronto", body: `Te quedan ${d.daysLeft} días de prueba de ${d.plan}.` }),
};

export function render(id: TemplateId, data: Data): { subject: string; body: string } {
  return TEMPLATES[id](data);
}

/** Envía (o, en desarrollo, enseña) un correo. */
export function notify(to: string, id: TemplateId, data: Data): void {
  const { subject } = render(id, data);
  if (process.env.NODE_ENV !== "production") console.log(`[correo a ${to}] ${subject}`);
}
