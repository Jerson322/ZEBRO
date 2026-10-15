// TEMPORAL: muestra la respuesta cruda de Mastershop para un producto. Borrar después de revisar.
import { mastershop } from "../lib/mastershop.js";

export default async function handler(req, res) {
  const id = Number(req.query.id);
  if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ error: "id inválido" });
  const [mio, mercado] = await Promise.all([
    mastershop(`/api/products/${id}?includeAllVariations=false`),
    mastershop(`/api/products/market/${id}`),
  ]);
  return res.status(200).json({ mio: mio.data, mercado: mercado.data });
}
