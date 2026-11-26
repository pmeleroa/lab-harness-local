/**
 * Zonas de envío a partir del código postal.
 *
 * Solo se envía a España y a la UE. Los códigos postales españoles tienen cinco cifras y las dos primeras son la
 * provincia: Baleares es 07, Las Palmas 35 y Santa Cruz de Tenerife 38; Ceuta (51) y Melilla (52) van como islas
 * porque el transporte sale igual de caro. Un código con letras o con otro formato se trata como internacional.
 */
export type Zone = "peninsula" | "islands" | "international";

const ISLAND_PROVINCES = new Set(["07", "35", "38", "51", "52"]);

export function zoneOf(postalCode: string): Zone {
  const code = postalCode.trim();
  if (!/^\d{5}$/.test(code)) return "international";
  return ISLAND_PROVINCES.has(code.slice(0, 2)) ? "islands" : "peninsula";
}

/** Si una zona necesita documentación de aduanas además de la etiqueta. */
export function needsCustomsForm(zone: Zone, postalCode: string): boolean {
  // Canarias, Ceuta y Melilla están fuera del territorio aduanero del IVA aunque sean España.
  if (zone === "islands") return !postalCode.startsWith("07");
  return false;
}

/** Nombre de la zona para el correo de confirmación. */
export function zoneLabel(zone: Zone): string {
  switch (zone) {
    case "peninsula":
      return "Península";
    case "islands":
      return "Baleares, Canarias, Ceuta y Melilla";
    case "international":
      return "Unión Europea";
  }
}
