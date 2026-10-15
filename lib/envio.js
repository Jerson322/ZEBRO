// Costo de envío que paga el cliente, por departamento de destino (COP).
// Los productos salen de Bogotá, así que el envío sube con la distancia.
// Mastershop no permite cotizar por API: son valores aproximados, ajústalos cuando veas los fletes reales.
const ZONA_LOCAL = 10000;
const ZONA_NACIONAL = 15000;
const ZONA_LEJANA = 20000;

export const ENVIO_POR_DEPARTAMENTO = {
  "Cundinamarca": ZONA_LOCAL,

  "Antioquia": ZONA_NACIONAL,
  "Boyacá": ZONA_NACIONAL,
  "Caldas": ZONA_NACIONAL,
  "Huila": ZONA_NACIONAL,
  "Meta": ZONA_NACIONAL,
  "Norte de Santander": ZONA_NACIONAL,
  "Quindío": ZONA_NACIONAL,
  "Risaralda": ZONA_NACIONAL,
  "Santander": ZONA_NACIONAL,
  "Tolima": ZONA_NACIONAL,
  "Valle del Cauca": ZONA_NACIONAL,

  "Amazonas": ZONA_LEJANA,
  "Arauca": ZONA_LEJANA,
  "Atlántico": ZONA_LEJANA,
  "Bolívar": ZONA_LEJANA,
  "Caquetá": ZONA_LEJANA,
  "Casanare": ZONA_LEJANA,
  "Cauca": ZONA_LEJANA,
  "Cesar": ZONA_LEJANA,
  "Chocó": ZONA_LEJANA,
  "Córdoba": ZONA_LEJANA,
  "Guainía": ZONA_LEJANA,
  "Guaviare": ZONA_LEJANA,
  "La Guajira": ZONA_LEJANA,
  "Magdalena": ZONA_LEJANA,
  "Nariño": ZONA_LEJANA,
  "Putumayo": ZONA_LEJANA,
  "San Andrés y Providencia": ZONA_LEJANA,
  "Sucre": ZONA_LEJANA,
  "Vaupés": ZONA_LEJANA,
  "Vichada": ZONA_LEJANA,
};

export function costoDeEnvio(departamento) {
  return ENVIO_POR_DEPARTAMENTO[departamento] ?? null;
}
