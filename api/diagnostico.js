// TEMPORAL: prueba el filtro de ubicación del marketplace. Borrar después de revisar.
import { mastershop } from "../lib/mastershop.js";

export default async function handler(req, res) {
  const buscar = String(req.query.q ?? "").slice(0, 60);
  const ubicaciones = String(req.query.u ?? "").split(",").filter(Boolean).slice(0, 8);
  const resultados = {};
  for (const location of ubicaciones) {
    const r = await mastershop("/api/products/market?page=0&limit=50", {
      method: "POST",
      body: { valueToSearch: buscar, location },
    });
    const lista = Array.isArray(r.data) ? r.data : r.data?.data ?? r.data;
    resultados[location] = {
      status: r.status,
      ids: Array.isArray(lista) ? lista.map((p) => `${p.idProduct}:${p.productName ?? p.nameProduct}`).slice(0, 10) : lista,
      campos: Array.isArray(lista) && lista[0] ? Object.keys(lista[0]) : null,
    };
  }
  return res.status(200).json(resultados);
}
