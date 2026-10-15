// Costo de envío que paga el cliente (COP), según la ciudad de donde sale el producto
// y el departamento de destino. Mastershop no permite cotizar por API: son valores
// aproximados, ajústalos cuando veas los fletes reales en el panel.
import { detectarOrigen } from "./origen.js";

const LOCAL = 10000;    // mismo departamento de la bodega
const CERCANO = 15000;  // departamentos vecinos o bien conectados
const NACIONAL = 20000; // resto del país, o cuando no se sabe de dónde sale

export const DEPARTAMENTOS = [
  "Amazonas", "Antioquia", "Arauca", "Atlántico", "Bolívar", "Boyacá", "Caldas", "Caquetá",
  "Casanare", "Cauca", "Cesar", "Chocó", "Córdoba", "Cundinamarca", "Guainía", "Guaviare",
  "Huila", "La Guajira", "Magdalena", "Meta", "Nariño", "Norte de Santander", "Putumayo",
  "Quindío", "Risaralda", "San Andrés y Providencia", "Santander", "Sucre", "Tolima",
  "Valle del Cauca", "Vaupés", "Vichada",
];

// Ciudades desde donde despachan los proveedores (deben coincidir con lib/origen.js).
const ORIGENES = {
  "Bogotá": {
    local: ["Cundinamarca"],
    cercanos: [
      "Antioquia", "Boyacá", "Caldas", "Huila", "Meta", "Norte de Santander", "Quindío",
      "Risaralda", "Santander", "Tolima", "Valle del Cauca",
    ],
  },
  "Medellín": {
    local: ["Antioquia"],
    cercanos: ["Caldas", "Risaralda", "Quindío", "Córdoba", "Chocó", "Cundinamarca", "Valle del Cauca"],
  },
  "Cali": {
    local: ["Valle del Cauca"],
    cercanos: ["Cauca", "Risaralda", "Quindío", "Caldas", "Nariño", "Antioquia", "Cundinamarca"],
  },
  "Cúcuta": {
    local: ["Norte de Santander"],
    cercanos: ["Santander", "Cesar", "Arauca", "Boyacá"],
  },
  "Barranquilla": {
    local: ["Atlántico"],
    cercanos: ["Bolívar", "Magdalena", "Sucre", "Córdoba", "Cesar", "La Guajira"],
  },
  "Bucaramanga": {
    local: ["Santander"],
    cercanos: ["Norte de Santander", "Boyacá", "Cesar", "Cundinamarca", "Antioquia"],
  },
  "Pereira": {
    local: ["Risaralda"],
    cercanos: ["Caldas", "Quindío", "Valle del Cauca", "Antioquia", "Tolima", "Cundinamarca"],
  },
  // Si no se pudo detectar el origen, se cobra la tarifa nacional para no perder plata.
  "Desconocido": { local: [], cercanos: [] },
};

// Origen fijo opcional por producto (ID de Mastershop), si la detección automática falla.
// Ejemplo:
//   "241686": "Cúcuta",
const ORIGEN_POR_PRODUCTO = {
};

export async function origenDe(producto) {
  const fijo = ORIGEN_POR_PRODUCTO[String(producto.idProduct)];
  if (fijo) return fijo;
  const detectado = await detectarOrigen(producto);
  return detectado && ORIGENES[detectado] ? detectado : "Desconocido";
}

export function costoDeEnvio(origen, departamento) {
  if (!DEPARTAMENTOS.includes(departamento)) return null;
  const { local, cercanos } = ORIGENES[origen] ?? ORIGENES["Desconocido"];
  if (local.includes(departamento)) return LOCAL;
  if (cercanos.includes(departamento)) return CERCANO;
  return NACIONAL;
}

// Tabla completa por origen, para mostrar el envío en la tienda antes de pedir.
export function tablaDeEnvios() {
  return Object.fromEntries(
    Object.keys(ORIGENES).map((origen) => [
      origen,
      Object.fromEntries(DEPARTAMENTOS.map((d) => [d, costoDeEnvio(origen, d)])),
    ])
  );
}
