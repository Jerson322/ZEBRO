// Acceso a Supabase: sesión, lecturas, operaciones del servicio y actualizaciones en vivo.
import { SUPABASE_URL, SUPABASE_CLAVE } from "./config.js";

export const configurado = Boolean(SUPABASE_URL && SUPABASE_CLAVE);
const sb = configurado ? window.supabase?.createClient(SUPABASE_URL, SUPABASE_CLAVE) : null;

export const libreriaCargada = () => Boolean(sb);

// Convierte los errores de Supabase en mensajes entendibles.
function problema(error) {
  if (!error) return null;
  if (error.code === "42501" || /row-level security|permission denied/i.test(error.message)) {
    return new Error(error.message?.startsWith("No tienes permiso") ? error.message : "No tienes permiso para esta acción");
  }
  if (/Failed to fetch|NetworkError|network/i.test(error.message)) {
    return new Error("Sin conexión. Revisa tu internet e inténtalo de nuevo.");
  }
  if (error.code === "23503") return new Error("No se puede borrar: se está usando en otra parte");
  return new Error(error.message || "Algo salió mal");
}

async function resultado(promesa) {
  const { data, error } = await promesa;
  if (error) throw problema(error);
  return data;
}

// Sesión

export async function usuarioActual() {
  const { data, error } = await sb.auth.getSession();
  if (error) throw problema(error);
  return data.session?.user ?? null;
}

export async function iniciarSesion(correo, clave) {
  const { error } = await sb.auth.signInWithPassword({ email: correo, password: clave });
  if (error) throw new Error(/invalid/i.test(error.message) ? "Correo o clave incorrectos" : problema(error).message);
}

export const cerrarSesion = () => sb.auth.signOut();

export async function token() {
  const { data } = await sb.auth.getSession();
  return data.session?.access_token ?? null;
}

export async function miPerfil(usuarioId) {
  return resultado(sb.from("miembros").select("*").eq("user_id", usuarioId).maybeSingle());
}

export const reclamarAdmin = (nombre) => resultado(sb.rpc("reclamar_admin", { p_nombre: nombre }));

// Lecturas

const todos = (tabla, orden = "nombre") => resultado(sb.from(tabla).select("*").order(orden));

export async function cargarMenu() {
  const [categorias, platos, grupos, opciones, platoGrupos, recetas] = await Promise.all([
    todos("categorias", "orden"),
    todos("platos"),
    todos("grupos_mod"),
    todos("opciones_mod"),
    resultado(sb.from("plato_grupos").select("*")),
    resultado(sb.from("recetas").select("*")),
  ]);
  return { categorias, platos, grupos, opciones, platoGrupos, recetas };
}

export const insumos = () => todos("insumos");
export const mesas = () => todos("mesas", "orden");
export const equipo = () => resultado(sb.rpc("lista_equipo"));
export const empleados = () => todos("empleados");
export const miembros = () => todos("miembros");

export const movimientos = (limite = 30) =>
  resultado(sb.from("movimientos").select("*").order("fecha", { ascending: false }).limit(limite));

export const pedidosAbiertos = () =>
  resultado(sb.from("pedidos").select("*, pedido_items(*)").eq("estado", "abierto").order("creado"));

export const pedido = (id) => resultado(sb.from("pedidos").select("*, pedido_items(*)").eq("id", id).maybeSingle());

// Cuentas cerradas (pagadas o anuladas) entre dos fechas, ambas incluidas.
export function pedidosCerrados(desde, hasta) {
  const inicio = new Date(`${desde}T00:00:00`).toISOString();
  const fin = new Date(new Date(`${hasta}T00:00:00`).getTime() + 86400000).toISOString();
  return resultado(
    sb.from("pedidos").select("*, pedido_items(*)").neq("estado", "abierto")
      .gte("cerrado", inicio).lt("cerrado", fin).order("cerrado", { ascending: false })
  );
}

export const gastos = (desde, hasta) =>
  resultado(sb.from("gastos").select("*").gte("fecha", desde).lte("fecha", hasta).order("fecha", { ascending: false }));

// Escrituras directas (las protegen las reglas de la base de datos)

export const guardar = (tabla, fila) =>
  fila.id
    ? resultado(sb.from(tabla).update(fila).eq("id", fila.id))
    : resultado(sb.from(tabla).insert(fila));

export const guardarDevolviendo = (tabla, fila) => resultado(sb.from(tabla).insert(fila).select().single());

export const borrar = (tabla, id) => resultado(sb.from(tabla).delete().eq("id", id));

export async function reemplazarReceta(platoId, filas) {
  await resultado(sb.from("recetas").delete().eq("plato_id", platoId));
  if (filas.length) await resultado(sb.from("recetas").insert(filas.map((f) => ({ plato_id: platoId, ...f }))));
}

export async function reemplazarGruposDePlato(platoId, gruposIds) {
  await resultado(sb.from("plato_grupos").delete().eq("plato_id", platoId));
  if (gruposIds.length) {
    await resultado(sb.from("plato_grupos").insert(gruposIds.map((g) => ({ plato_id: platoId, grupo_id: g }))));
  }
}

export const registrarGasto = (gasto) => resultado(sb.from("gastos").insert(gasto));

// Operaciones del servicio (funciones de la base de datos)

const rpc = (nombre, params) => resultado(sb.rpc(nombre, params));

export const abrirMesa = (mesa) => rpc("abrir_mesa", { p_mesa: mesa });
export const crearDomicilio = (d) =>
  rpc("crear_domicilio", {
    p_cliente: d.cliente, p_telefono: d.telefono, p_direccion: d.direccion,
    p_envio: Number(d.envio) || 0, p_domiciliario: d.domiciliario || null, p_notas: d.notas,
  });
export const actualizarDomicilio = (pedidoId, entrega, domiciliario) =>
  rpc("actualizar_domicilio", { p_pedido: pedidoId, p_entrega: entrega, p_domiciliario: domiciliario || null });
export const agregarItem = (pedidoId, platoId, cantidad, opcionesIds, nota) =>
  rpc("agregar_item", { p_pedido: pedidoId, p_plato: platoId, p_cantidad: cantidad, p_opciones: opcionesIds, p_nota: nota });
export const quitarItem = (itemId) => rpc("quitar_item", { p_item: itemId });
export const enviarCocina = (pedidoId) => rpc("enviar_cocina", { p_pedido: pedidoId });
export const marcarItems = (pedidoId, de, a) => rpc("marcar_items", { p_pedido: pedidoId, p_de: de, p_a: a });
export const cobrar = (pedidoId, metodo, propina) =>
  rpc("cobrar", { p_pedido: pedidoId, p_metodo: metodo, p_propina: Number(propina) || 0 });
export const anular = (pedidoId, motivo) => rpc("anular", { p_pedido: pedidoId, p_motivo: motivo });
export const moverInsumo = (insumoId, tipo, cantidad, costo, motivo) =>
  rpc("mover_insumo", {
    p_insumo: insumoId, p_tipo: tipo, p_cantidad: Number(cantidad),
    p_costo: costo === "" || costo == null ? null : Number(costo), p_motivo: motivo,
  });

// Cuentas de acceso del equipo: las crea el servidor (api/equipo.js) con la clave secreta.
export async function cuentaEquipo(cuerpo) {
  const res = await fetch("/api/equipo", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${await token()}` },
    body: JSON.stringify(cuerpo),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || "No se pudo completar la acción");
  return data;
}

// En vivo: avisa cuando cambia cualquier pedido o plato de un pedido.
export function escucharPedidos(alCambiar) {
  const canal = sb
    .channel("servicio")
    .on("postgres_changes", { event: "*", schema: "public", table: "pedidos" }, alCambiar)
    .on("postgres_changes", { event: "*", schema: "public", table: "pedido_items" }, alCambiar)
    .subscribe();
  return () => sb.removeChannel(canal);
}
