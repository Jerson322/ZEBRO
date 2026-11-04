// Guarda los datos en Supabase: una fila por usuario, con un número de versión para
// detectar si otro dispositivo cambió los datos mientras tanto.
import { SUPABASE_URL, SUPABASE_CLAVE } from "./config.js";

const TABLA = "sistema_datos";
const YA_EXISTE = "23505";

export const nubeActiva = Boolean(SUPABASE_URL && SUPABASE_CLAVE);
const cliente = nubeActiva ? window.supabase?.createClient(SUPABASE_URL, SUPABASE_CLAVE) : null;

let usuarioId = null;
let version = 0;
let pendiente = null;
let enviando = false;
let avisar = () => {};

export function libreriaCargada() {
  return Boolean(cliente);
}

export async function haySesion() {
  const { data, error } = await cliente.auth.getSession();
  if (error) throw error;
  usuarioId = data.session?.user.id ?? null;
  return Boolean(usuarioId);
}

export async function iniciarSesion(correo, clave) {
  const { data, error } = await cliente.auth.signInWithPassword({ email: correo, password: clave });
  if (error) throw new Error("Correo o clave incorrectos");
  usuarioId = data.user.id;
}

export async function cerrarSesion() {
  await cliente.auth.signOut();
  usuarioId = null;
  version = 0;
  pendiente = null;
}

async function consultar() {
  const { data, error } = await cliente.from(TABLA).select("datos, version").eq("user_id", usuarioId).maybeSingle();
  if (error) throw error;
  return data;
}

// Devuelve los datos guardados, o null si este usuario todavía no tiene. Si falla, lanza
// un error: quien llama nunca debe confundir un fallo con "no hay datos".
export async function leer() {
  const fila = await consultar();
  if (!fila) return null;
  version = fila.version;
  return fila.datos;
}

// Devuelve los datos solo si otro dispositivo los cambió y aquí no hay nada por guardar.
export async function leerSiCambio() {
  if (hayCambiosPorGuardar()) return null;
  const fila = await consultar();
  if (!fila || fila.version === version || hayCambiosPorGuardar()) return null;
  version = fila.version;
  return fila.datos;
}

// Devuelve false si otro dispositivo creó la fila primero.
export async function crear(datos) {
  const { error } = await cliente.from(TABLA).insert({ user_id: usuarioId, datos, version: 1 });
  if (error?.code === YA_EXISTE) return false;
  if (error) throw error;
  version = 1;
  return true;
}

export function hayCambiosPorGuardar() {
  return enviando || pendiente !== null;
}

export function alCambiarEstado(funcion) {
  avisar = funcion;
}

export function guardar(datos) {
  pendiente = JSON.parse(JSON.stringify(datos));
  enviarPendiente();
}

// Envía el último estado. Si llegan cambios mientras tanto, solo se manda el más reciente.
export async function enviarPendiente() {
  if (enviando || pendiente === null) return;
  enviando = true;
  avisar("guardando");
  while (pendiente !== null) {
    const envio = pendiente;
    pendiente = null;
    try {
      const { data, error } = await cliente
        .from(TABLA)
        .update({ datos: envio, version: version + 1, actualizado: new Date().toISOString() })
        .eq("user_id", usuarioId)
        .eq("version", version)
        .select("version");
      if (error) throw error;
      if (!data.length) {
        pendiente = null;
        enviando = false;
        avisar("conflicto");
        return;
      }
      version = data[0].version;
    } catch {
      pendiente ??= envio;
      enviando = false;
      avisar("error");
      return;
    }
  }
  enviando = false;
  avisar("guardado");
}
