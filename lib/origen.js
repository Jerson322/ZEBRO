// Detecta desde qué ciudad despacha cada producto.
// La API no trae la ciudad del proveedor, pero la búsqueda del marketplace sí filtra por
// ubicación: se busca el producto por nombre en cada ciudad hasta encontrarlo.
import { mastershop } from "./mastershop.js";

// Ciudad como se envía a la API → nombre usado en lib/envio.js.
const CIUDADES = [
  ["Bogota", "Bogotá"],
  ["Medellin", "Medellín"],
  ["Cali", "Cali"],
  ["Cucuta", "Cúcuta"],
  ["Barranquilla", "Barranquilla"],
  ["Bucaramanga", "Bucaramanga"],
  ["Pereira", "Pereira"],
];

// Se guarda mientras la instancia del servidor siga viva, para no repetir búsquedas.
const cache = new Map();

// La búsqueda solo acepta texto alfanumérico.
function textoDeBusqueda(nombre) {
  return nombre
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^A-Za-z0-9 ]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .split(" ")
    .slice(0, 6)
    .join(" ");
}

async function estaEnCiudad(producto, ciudad) {
  const { status, data } = await mastershop("/api/products/market?page=0&limit=50", {
    method: "POST",
    body: { valueToSearch: textoDeBusqueda(producto.name), location: ciudad },
  });
  const lista = Array.isArray(data) ? data : data?.data;
  return status === 200 && Array.isArray(lista) && lista.some((p) => p.idProduct === producto.idProduct);
}

// Devuelve el nombre de la ciudad de origen, o null si no se encontró.
export async function detectarOrigen(producto) {
  if (cache.has(producto.idProduct)) return cache.get(producto.idProduct);
  let origen = null;
  for (const [consulta, nombre] of CIUDADES) {
    if (await estaEnCiudad(producto, consulta)) {
      origen = nombre;
      break;
    }
  }
  cache.set(producto.idProduct, origen);
  return origen;
}
