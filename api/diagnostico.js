// TEMPORAL: prueba de búsqueda en el marketplace. Borrar después de revisar.
import { mastershop } from "../lib/mastershop.js";

export default async function handler(req, res) {
  const pruebas = JSON.parse(String(req.query.p ?? "[]")).slice(0, 12);
  const out = [];
  for (const [valueToSearch, location] of pruebas) {
    const body = { valueToSearch };
    if (location) body.location = location;
    const r = await mastershop("/api/products/market?page=0&limit=50", { method: "POST", body });
    const lista = Array.isArray(r.data) ? r.data : r.data?.data;
    out.push({ valueToSearch, location, status: r.status, encontrados: Array.isArray(lista) ? lista.map((p) => p.idProduct).filter((id) => id === 247320).length : r.data, total: Array.isArray(lista) ? lista.length : null });
  }
  return res.status(200).json(out);
}
