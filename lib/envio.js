// Costo de envío que paga el cliente (COP), según la ciudad de donde sale el producto
// y el departamento de destino. Mastershop no permite cotizar por API: son valores
// aproximados, ajústalos cuando veas los fletes reales en el panel.
const LOCAL = 10000;    // mismo departamento de la bodega
const CERCANO = 15000;  // departamentos vecinos o bien conectados
const NACIONAL = 20000; // resto del país

export const DEPARTAMENTOS = [
  "Amazonas", "Antioquia", "Arauca", "Atlántico", "Bolívar", "Boyacá", "Caldas", "Caquetá",
  "Casanare", "Cauca", "Cesar", "Chocó", "Córdoba", "Cundinamarca", "Guainía", "Guaviare",
  "Huila", "La Guajira", "Magdalena", "Meta", "Nariño", "Norte de Santander", "Putumayo",
  "Quindío", "Risaralda", "San Andrés y Providencia", "Santander", "Sucre", "Tolima",
  "Valle del Cauca", "Vaupés", "Vichada",
];

// Ciudades desde donde despachan los proveedores.
const ORIGENES = {
  "Bogotá": {
    local: ["Cundinamarca"],
    cercanos: [
      "Antioquia", "Boyacá", "Caldas", "Huila", "Meta", "Norte de Santander", "Quindío",
      "Risaralda", "Santander", "Tolima", "Valle del Cauca",
    ],
  },
  "Cúcuta": {
    local: ["Norte de Santander"],
    cercanos: ["Santander", "Cesar", "Arauca", "Boyacá"],
  },
};

const ORIGEN_POR_DEFECTO = "Bogotá";

// De dónde sale cada producto (ID de Mastershop). Los que no estén aquí salen de Bogotá.
const ORIGEN_POR_PRODUCTO = {
  "241686": "Cúcuta", // adidas dama magna
};

export function origenDe(idProducto) {
  return ORIGEN_POR_PRODUCTO[String(idProducto)] ?? ORIGEN_POR_DEFECTO;
}

export function costoDeEnvio(origen, departamento) {
  if (!DEPARTAMENTOS.includes(departamento)) return null;
  const { local, cercanos } = ORIGENES[origen] ?? ORIGENES[ORIGEN_POR_DEFECTO];
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
