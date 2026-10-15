import { mastershop, tieneApiKey } from "../lib/mastershop.js";
import { precioDeVenta } from "../lib/precios.js";
import { variantesDisponibles } from "../lib/variantes.js";
import { ENVIO_POR_DEPARTAMENTO } from "../lib/envio.js";

const POR_PAGINA = 50; // la API recorta cualquier límite mayor a 50
const MAX_PAGINAS = 10;

export default async function handler(req, res) {
  if (req.method !== "GET") {
    return res.status(405).json({ error: "Método no permitido" });
  }
  if (!tieneApiKey()) {
    return res.status(500).json({ error: "Falta configurar MASTERSHOP_API_KEY en Vercel" });
  }

  const todos = [];
  for (let pagina = 1; pagina <= MAX_PAGINAS; pagina++) {
    const { status, data } = await mastershop(`/api/products?page=${pagina}&limit=${POR_PAGINA}`);
    if (status !== 200) {
      console.error("Mastershop /api/products", status, data);
      return res.status(502).json({ error: "No se pudieron cargar los productos" });
    }
    const resultados = data?.results ?? data?.data?.results ?? [];
    todos.push(...resultados);
    if (resultados.length < POR_PAGINA) break;
  }

  const productos = todos
    .filter((p) => p.nameState === "Activo")
    .map((p) => {
      const variantes = variantesDisponibles(p).map((v) => ({
        id: v.id,
        nombre: v.nombre,
        stock: v.stock,
        precio: precioDeVenta(p, v),
      }));
      return {
        id: p.idProduct,
        nombre: p.name.trim(),
        descripcion: p.description,
        imagen: p.urlImageProduct,
        precio: variantes.length ? Math.min(...variantes.map((v) => v.precio)) : precioDeVenta(p),
        stock: p.stockTotal,
        variantes,
      };
    });

  res.setHeader("Cache-Control", "s-maxage=300, stale-while-revalidate=600");
  return res.status(200).json({ productos, envios: ENVIO_POR_DEPARTAMENTO });
}
