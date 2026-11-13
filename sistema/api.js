// Acceso a Supabase: sesión, lecturas, operaciones del servicio y actualizaciones en vivo.
import { SUPABASE_URL, SUPABASE_CLAVE } from "./config.js";

export const configurado = Boolean(SUPABASE_URL && SUPABASE_CLAVE);
const sb = configurado ? window.supabase?.createClient(SUPABASE_URL, SUPABASE_CLAVE) : null;

export const libreriaCargada = () => Boolean(sb);

// Turno de la persona: viaja en la cabecera «x-turno» de cada pedido a la base de datos, que con él
// sabe quién trabaja y con qué rol.
export function usarTurno(token) {
  const h = sb?.rest?.headers;
  if (!h) return;
  if (typeof h.set === "function") token ? h.set("x-turno", token) : h.delete("x-turno");
  else if (token) h["x-turno"] = token;
  else delete h["x-turno"];
}
export const hayPersonas = () => rpc("hay_personas");
export const crearPrimeraPersona = (nombre, clave) => rpc("crear_primera_persona", { p_nombre: nombre, p_clave: clave });
export const iniciarTurno = (clave) => rpc("iniciar_turno", { p_clave: clave });
export const turnoActual = () => rpc("turno_actual");
export const terminarTurno = () => rpc("terminar_turno");
export const listaPersonas = () => rpc("lista_personas");
export const guardarPersona = (p) =>
  rpc("guardar_persona", { p_id: p.id ?? null, p_nombre: p.nombre, p_rol: p.rol, p_clave: p.clave || null, p_activo: p.activo ?? true });

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

export const negocio = () => resultado(sb.from("negocio").select("*").eq("id", 1).maybeSingle());
export const guardarNegocio = (datos) => resultado(sb.from("negocio").update(datos).eq("id", 1));
export const comandasPorImprimir = () => rpc("comandas_por_imprimir");
// Cola de impresión: un ticket enviado desde un equipo sin impresora, para que lo imprima la comandera.
export const enviarAImpresora = (html) => resultado(sb.from("impresiones").insert({ html }));
export const impresionesPorImprimir = () => rpc("impresiones_por_imprimir");

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
// Las personas del equipo (con «user_id» igual a su id, para las pantallas que buscan nombres).
export const miembros = async () => (await listaPersonas()).map((p) => ({ ...p, user_id: p.id }));

export const movimientos = (limite = 30) =>
  resultado(sb.from("movimientos").select("*").order("fecha", { ascending: false }).limit(limite));

export const pedidosAbiertos = () =>
  resultado(sb.from("pedidos").select("*, pedido_items(*)").eq("estado", "abierto").order("creado"));

// Domicilios sin terminar: los que no se han cobrado y los cobrados que faltan por entregar.
export const domiciliosPendientes = () =>
  resultado(sb.from("pedidos").select("*, pedido_items(*)").eq("tipo", "domicilio")
    .or("estado.eq.abierto,and(estado.eq.pagado,entrega.in.(preparando,en_camino))").order("creado"));

// Últimas entregas hechas por un domiciliario.
export const historialEntregas = (empleadoId, limite = 50) =>
  resultado(sb.from("pedidos").select("*, pedido_items(*)").eq("tipo", "domicilio").eq("entrega", "entregado")
    .eq("domiciliario_id", empleadoId).order("entregado_en", { ascending: false }).limit(limite));

// Ficha de empleado de quien tiene la sesión (null si no tiene).
export const miEmpleado = () => resultado(sb.rpc("mi_empleado"));

// Lo que cocina tiene en curso: cuentas abiertas y domicilios facturados que aún no salen.
export const pedidosEnCocina = () =>
  resultado(sb.from("pedidos").select("*, pedido_items(*)")
    .or("estado.eq.abierto,and(tipo.eq.domicilio,estado.eq.pagado,entrega.eq.preparando)").order("creado"));

export const pedido = (id) => resultado(sb.from("pedidos").select("*, pedido_items(*), pagos(*)").eq("id", id).maybeSingle());

// Cuentas cerradas (pagadas o anuladas) entre dos fechas, ambas incluidas.
export function pedidosCerrados(desde, hasta) {
  const inicio = new Date(`${desde}T00:00:00`).toISOString();
  const fin = new Date(new Date(`${hasta}T00:00:00`).getTime() + 86400000).toISOString();
  return resultado(
    sb.from("pedidos").select("*, pedido_items(*), pagos(*)").neq("estado", "abierto")
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
// Inserta varias filas de una vez y devuelve las filas creadas (con su id).
export const guardarVarios = (tabla, filas) => resultado(sb.from(tabla).insert(filas).select());

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
// Crea una mesa al momento (se borra sola al cobrar su cuenta) y devuelve el id de la cuenta.
export const crearMesa = (nombre) => rpc("crear_mesa", { p_nombre: nombre });
export const crearDomicilio = (d) =>
  rpc("crear_domicilio", {
    p_cliente: d.cliente, p_telefono: d.telefono, p_direccion: d.direccion,
    p_envio: Number(d.envio) || 0, p_domiciliario: d.domiciliario || null, p_notas: d.notas,
  });
export const asignarDomiciliario = (pedidoId, domiciliario) =>
  rpc("asignar_domiciliario", { p_pedido: pedidoId, p_domiciliario: domiciliario || null });
export const cambiarEntrega = (pedidoId, entrega) => rpc("cambiar_entrega", { p_pedido: pedidoId, p_entrega: entrega });
export const registrarNovedad = (pedidoId, texto) => rpc("registrar_novedad", { p_pedido: pedidoId, p_texto: texto });
export const registrarRecibido = (pedidoId, valor) =>
  rpc("registrar_recibido", { p_pedido: pedidoId, p_valor: valor === "" || valor == null ? null : Number(valor) });
export const agregarItem = (pedidoId, platoId, cantidad, opcionesIds, nota) =>
  rpc("agregar_item", { p_pedido: pedidoId, p_plato: platoId, p_cantidad: cantidad, p_opciones: opcionesIds, p_nota: nota });
export const cambiarCantidad = (itemId, cantidad) => rpc("cambiar_cantidad", { p_item: itemId, p_cantidad: Number(cantidad) });
export const quitarItem = (itemId, clave) => rpc("quitar_item", { p_item: itemId, p_clave: clave || null });
export const enviarCocina = (pedidoId) => rpc("enviar_cocina", { p_pedido: pedidoId });
export const marcarItems = (pedidoId, de, a) => rpc("marcar_items", { p_pedido: pedidoId, p_de: de, p_a: a });
// Marca entregado todo lo que se está preparando de un pedido.
export const entregarPedido = (pedidoId) => rpc("entregar_pedido", { p_pedido: pedidoId });
// Ya no se cobra propina: siempre va en 0.
export const cobrar = (pedidoId, metodo) => rpc("cobrar", { p_pedido: pedidoId, p_metodo: metodo, p_propina: 0 });
// Cobra una parte de la cuenta: items = [{ id, cantidad }]. Devuelve { pago_id, valor, cerrada }.
// Cobra un valor de la cuenta (cuenta dividida por partes). Devuelve { pago_id, valor, cerrada, falta }.
export const abonar = (pedidoId, valor, metodo) => rpc("abonar", { p_pedido: pedidoId, p_valor: Number(valor), p_metodo: metodo });
export const cobrarParte = (pedidoId, items, metodo) =>
  rpc("cobrar_parte", { p_pedido: pedidoId, p_items: items, p_metodo: metodo });
export const cambiarParaLlevar = (pedidoId, paraLlevar) =>
  rpc("cambiar_para_llevar", { p_pedido: pedidoId, p_para_llevar: paraLlevar });
export const anular = (pedidoId, motivo, clave) => rpc("anular", { p_pedido: pedidoId, p_motivo: motivo, p_clave: clave || null });
// Caja: la que está abierta (o null), abrirla con la base y cerrarla con lo contado.
// La caja abierta (o null). Antes se cierran solas las que quedaron abiertas de antes de las 3:00 a. m.
export const hayCajaAbierta = () => rpc("hay_caja_abierta");
export async function cajaAbierta() {
  await hayCajaAbierta().catch(() => {});
  return resultado(sb.from("cajas").select("*").is("cerrada_en", null).maybeSingle());
}
export const corteDelDia = () => rpc("corte_del_dia");
export const cajasEntre = (desde, hasta) =>
  resultado(sb.from("cajas").select("*").gte("abierta_en", desde).lt("abierta_en", hasta).order("abierta_en"));
// Cada persona que cobra tiene su caja. miCaja: la abierta de quien tiene la sesión (o null).
export const miCaja = () => rpc("mi_caja");
export const tengoCodigoCaja = () => rpc("tengo_codigo_caja");
export const abrirCaja = (base, conteo, codigo) => rpc("abrir_caja", { p_base: base, p_conteo: conteo, p_codigo: codigo || null });
export const cerrarCaja = (cajaId, contado, conteo, esperado, resumen, codigo) =>
  rpc("cerrar_caja", { p_caja: cajaId, p_contado: contado, p_conteo: conteo, p_esperado: esperado, p_resumen: resumen, p_codigo: codigo || null });
export const ponerCodigoCaja = (usuarioId, codigo) => rpc("poner_codigo_caja", { p_usuario: usuarioId, p_codigo: codigo || "" });
// Pagos cobrados en una caja (con su cuenta y sus platos) y gastos registrados en ella.
export const pagosDeCaja = (cajaId) =>
  resultado(sb.from("pagos").select("*, pedidos(*, pedido_items(*))").eq("caja_id", cajaId).order("fecha"));
export const gastosDeCaja = (cajaId) => resultado(sb.from("gastos").select("*").eq("caja_id", cajaId).order("fecha"));
// Clave de autorización.
export const hayClaves = () => rpc("hay_claves");
export const verificarClave = (clave) => rpc("verificar_clave", { p_clave: clave });
export const ponerClave = (usuarioId, clave) => rpc("poner_clave", { p_usuario: usuarioId, p_clave: clave || "" });
export const moverInsumo = (insumoId, tipo, cantidad, costo, motivo) =>
  rpc("mover_insumo", {
    p_insumo: insumoId, p_tipo: tipo, p_cantidad: Number(cantidad),
    p_costo: costo === "" || costo == null ? null : Number(costo), p_motivo: motivo,
  });


// En vivo: avisa cuando cambia cualquier pedido o plato de un pedido.
export function escucharPedidos(alCambiar) {
  const canal = sb
    .channel("servicio")
    .on("postgres_changes", { event: "*", schema: "public", table: "pedidos" }, alCambiar)
    .on("postgres_changes", { event: "*", schema: "public", table: "pedido_items" }, alCambiar)
    .on("postgres_changes", { event: "INSERT", schema: "public", table: "impresiones" }, alCambiar)
    .subscribe();
  return () => sb.removeChannel(canal);
}
