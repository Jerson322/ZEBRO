import { mastershop, tieneApiKey } from "../lib/mastershop.js";
import { precioDeVenta } from "../lib/precios.js";
import { variantesDisponibles } from "../lib/variantes.js";

const MAX_CANTIDAD = 5;
// Límite simple contra pedidos repetidos: por IP, dentro de la misma instancia del servidor.
const MAX_PEDIDOS_POR_IP = 3;
const VENTANA_MS = 10 * 60 * 1000;
const pedidosPorIp = new Map();

function limiteSuperado(ip) {
  const ahora = Date.now();
  const recientes = (pedidosPorIp.get(ip) ?? []).filter((t) => ahora - t < VENTANA_MS);
  pedidosPorIp.set(ip, recientes);
  return recientes.length >= MAX_PEDIDOS_POR_IP;
}

function registrarPedido(ip) {
  pedidosPorIp.get(ip).push(Date.now());
}

// Mastershop solo acepta letras y espacios en los nombres.
function soloLetras(texto) {
  return String(texto ?? "")
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^A-Za-z ]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function texto(valor, max = 200) {
  return String(valor ?? "").replace(/\s+/g, " ").trim().slice(0, max);
}

function validar(datos) {
  const nombre = soloLetras(datos.nombre);
  const telefono = String(datos.telefono ?? "").replace(/\D/g, "");
  const departamento = texto(datos.departamento, 60);
  const ciudad = texto(datos.ciudad, 60);
  const direccion = texto(datos.direccion);
  const barrio = texto(datos.barrio, 100);
  const indicaciones = texto(datos.indicaciones);
  const cantidad = Number(datos.cantidad);
  const idProducto = Number(datos.idProducto);
  const idVariante = datos.idVariante == null || datos.idVariante === "" ? null : Number(datos.idVariante);

  if (!Number.isInteger(idProducto) || idProducto <= 0) return { error: "Producto inválido" };
  if (idVariante !== null && !Number.isInteger(idVariante)) return { error: "Variante inválida" };
  if (!Number.isInteger(cantidad) || cantidad < 1 || cantidad > MAX_CANTIDAD) {
    return { error: `La cantidad debe estar entre 1 y ${MAX_CANTIDAD}` };
  }
  if (nombre.split(" ").length < 2) return { error: "Escribe tu nombre y apellido" };
  if (!/^3\d{9}$/.test(telefono)) return { error: "Escribe un celular válido de 10 dígitos" };
  if (departamento.length < 3) return { error: "Elige tu departamento" };
  if (ciudad.length < 2) return { error: "Escribe tu ciudad" };
  if (direccion.length < 5) return { error: "Escribe tu dirección completa" };

  return { nombre, telefono, departamento, ciudad, direccion, barrio, indicaciones, cantidad, idProducto, idVariante };
}

function idPedidoExterno() {
  // Solo letras, números y guiones: el único alfabeto que aceptan todos los endpoints.
  const aleatorio = Math.random().toString(36).slice(2, 6).toUpperCase();
  return `ZB-${Date.now().toString(36).toUpperCase()}-${aleatorio}`;
}

export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Método no permitido" });
  }
  if (!tieneApiKey()) {
    return res.status(500).json({ error: "Falta configurar MASTERSHOP_API_KEY en Vercel" });
  }

  const datos = req.body ?? {};

  // Campo trampa: invisible para personas, los bots lo llenan.
  if (datos.sitio) {
    return res.status(200).json({ ok: true, pedido: "ZB-OK" });
  }

  const ip = String(req.headers["x-forwarded-for"] ?? "").split(",")[0].trim() || "desconocida";
  if (limiteSuperado(ip)) {
    return res.status(429).json({ error: "Ya recibimos tus pedidos. Si necesitas otro, escríbenos por WhatsApp." });
  }

  const v = validar(datos);
  if (v.error) {
    return res.status(400).json({ error: v.error });
  }

  // El precio y el nombre salen siempre de Mastershop y de lib/precios.js, nunca del navegador.
  const consulta = await mastershop(`/api/products/${v.idProducto}?includeAllVariations=true`);
  const producto = (consulta.data?.results ?? consulta.data?.data?.results)?.[0];
  if (consulta.status !== 200 || !producto || producto.nameState !== "Activo") {
    return res.status(404).json({ error: "Este producto ya no está disponible" });
  }

  const variantes = variantesDisponibles(producto);
  const variante = variantes.find((x) => x.id === v.idVariante) ?? null;
  if (variantes.length > 0 && !variante) {
    return res.status(400).json({ error: "Elige una opción disponible del producto" });
  }
  const stock = variante ? variante.stock : producto.stockTotal;
  if (stock < v.cantidad) {
    return res.status(409).json({ error: "No hay suficientes unidades disponibles" });
  }

  const precio = precioDeVenta(producto);
  const [primerNombre, ...apellidos] = v.nombre.split(" ");
  const direccion = {
    zip: null,
    country: "CO",
    city: v.ciudad,
    address1: v.direccion,
    address2: v.indicaciones || null,
    full_name: v.nombre,
    first_name: primerNombre,
    last_name: apellidos.join(" ") || null,
    phone: v.telefono,
    company: null,
    state: v.departamento,
    district: v.barrio || null,
  };

  const pedido = {
    id_order: idPedidoExterno(),
    shipping_address: direccion,
    billing_address: direccion,
    order_transaction: {
      // Pesos enteros: price × quantity cuadra exacto, sin errores de coma flotante.
      total: precio * v.cantidad,
      currency: "COP",
      payment_method: "cod",
      payment_gateway: "contraentrega",
    },
    customer: {
      full_name: v.nombre,
      first_name: primerNombre,
      last_name: apellidos.join(" ") || null,
      phone: v.telefono,
      email: null,
      documentType: null,
      documentNumber: null,
      tags: [],
    },
    order_items: [
      {
        id_product: v.idProducto,
        id_variant: variante?.id ?? null,
        quantity: v.cantidad,
        sku: variante?.sku ?? null,
        name: variante ? `${producto.name.trim()} - ${variante.nombre}` : producto.name.trim(),
        weight: variante?.peso || null,
        price: precio,
      },
    ],
    additional_charge: [],
    notes: v.indicaciones ? [v.indicaciones] : [],
    tags: ["zebro.store"],
  };

  const creado = await mastershop("/api/orders", { method: "POST", body: pedido });
  if (creado.status !== 200) {
    console.error("Mastershop POST /api/orders", creado.status, JSON.stringify(creado.data));
    return res.status(502).json({
      error: "No pudimos registrar tu pedido. Intenta de nuevo o escríbenos por WhatsApp.",
      detalle: creado.data?.error,
      campos: creado.data?.data,
    });
  }

  registrarPedido(ip);
  return res.status(200).json({ ok: true, pedido: pedido.id_order });
}
