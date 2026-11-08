// Cuentas de acceso del equipo del restaurante. Crear usuarios y cambiar claves requiere la
// clave secreta de Supabase, que vive solo aquí en el servidor (variable SUPABASE_SECRET_KEY de Vercel).
// Solo responde a un administrador activo del sistema.
import { SUPABASE_URL } from "../sistema/config.js";

const ROLES = ["admin", "cajero", "mesero", "cocina", "domiciliario"];
const CLAVE_MINIMA = 8;

// Sin espacios, saltos de línea ni comillas que se cuelan al pegarla en Vercel.
const claveSecreta = () => String(process.env.SUPABASE_SECRET_KEY ?? "").trim().replace(/^["']|["']$/g, "");

function cabeceras(extra = {}) {
  const clave = claveSecreta();
  // Las claves nuevas (sb_secret_…) van solo en "apikey"; la antigua service_role es un JWT y va en ambas.
  return {
    apikey: clave,
    ...(clave.startsWith("eyJ") ? { Authorization: `Bearer ${clave}` } : {}),
    "Content-Type": "application/json",
    ...extra,
  };
}

async function supabase(ruta, { method = "GET", body, headers } = {}) {
  const res = await fetch(SUPABASE_URL + ruta, {
    method,
    headers: cabeceras(headers),
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => null);
  return { ok: res.ok, status: res.status, data };
}

// Quién llama, según su sesión (token del navegador).
async function quienLlama(req) {
  const token = String(req.headers.authorization ?? "").replace(/^Bearer /, "");
  if (!token) return null;
  const res = await fetch(`${SUPABASE_URL}/auth/v1/user`, {
    headers: { apikey: claveSecreta(), Authorization: `Bearer ${token}` },
  });
  if (!res.ok) return null;
  return (await res.json())?.id ?? null;
}

// null = es administrador; si no, el motivo exacto para mostrarlo.
async function motivoNoAdmin(userId) {
  const r = await supabase(`/rest/v1/miembros?user_id=eq.${userId}&select=rol,activo`);
  if (!r.ok) {
    // Lo que respondió Supabase (nunca incluye la clave) y cómo empieza la clave, para saber cuál es.
    const detalle = r.data?.message || r.data?.msg || r.data?.error || JSON.stringify(r.data);
    const clave = claveSecreta();
    const tipo = clave.startsWith("sb_secret_") ? "secret" : clave.startsWith("sb_publishable_") ? "publishable"
      : clave.startsWith("eyJ") ? "JWT (anon o service_role)" : "desconocido";
    return `Supabase rechazó la clave de Vercel (${r.status}, tipo ${tipo}): ${detalle}`;
  }
  const miembro = r.data[0];
  if (!miembro) {
    // Con la clave pública el servidor no ve a nadie: casi siempre es eso.
    return "El servidor no ve tu usuario en miembros. Revisa que SUPABASE_SECRET_KEY en Vercel sea la clave secreta (no la publishable/anon)";
  }
  if (!miembro.activo) return "Tu acceso está desactivado";
  if (miembro.rol !== "admin") return "Solo el administrador puede hacer esto";
  return null;
}

async function empleado(id) {
  const r = await supabase(`/rest/v1/empleados?id=eq.${encodeURIComponent(id)}&select=id,nombre,user_id,activo`);
  return r.ok ? r.data[0] ?? null : null;
}

const fallo = (res, status, error) => res.status(status).json({ error });

export default async function handler(req, res) {
  if (req.method !== "POST") return fallo(res, 405, "Método no permitido");
  if (!SUPABASE_URL || !claveSecreta()) {
    return fallo(res, 500, "Falta configurar SUPABASE_SECRET_KEY en Vercel");
  }
  const llamador = await quienLlama(req);
  if (!llamador) return fallo(res, 401, "Tu sesión venció o la clave de Vercel no sirve. Sal del sistema y vuelve a entrar.");
  const motivo = await motivoNoAdmin(llamador);
  if (motivo) return fallo(res, 403, motivo);

  const { accion, empleadoId, correo, clave, rol } = req.body ?? {};
  const e = await empleado(empleadoId);
  if (!e) return fallo(res, 404, "Ese empleado no existe");
  if (rol !== undefined && !ROLES.includes(rol)) return fallo(res, 400, "Rol no válido");
  if (clave !== undefined && String(clave).length < CLAVE_MINIMA) {
    return fallo(res, 400, `La clave debe tener mínimo ${CLAVE_MINIMA} caracteres`);
  }

  if (accion === "crear") {
    if (e.user_id) return fallo(res, 409, "Este empleado ya tiene usuario");
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(correo ?? ""))) return fallo(res, 400, "Escribe un correo válido");
    if (clave === undefined || rol === undefined) return fallo(res, 400, "Falta la clave o el rol");
    const creado = await supabase("/auth/v1/admin/users", {
      method: "POST",
      body: { email: correo, password: clave, email_confirm: true },
    });
    if (!creado.ok) {
      const repetido = /already|registered|exists/i.test(JSON.stringify(creado.data));
      return fallo(res, 400, repetido ? "Ya existe un usuario con ese correo" : "No se pudo crear el usuario");
    }
    const userId = creado.data.id;
    const miembro = await supabase("/rest/v1/miembros", { method: "POST", body: { user_id: userId, nombre: e.nombre, rol } });
    const vinculo = await supabase(`/rest/v1/empleados?id=eq.${e.id}`, { method: "PATCH", body: { user_id: userId } });
    if (!miembro.ok || !vinculo.ok) {
      // No dejar un usuario a medias: se borra y se puede intentar de nuevo.
      await supabase(`/auth/v1/admin/users/${userId}`, { method: "DELETE" });
      return fallo(res, 500, "No se pudo dar el acceso. Intenta de nuevo.");
    }
    return res.status(200).json({ ok: true });
  }

  if (!e.user_id) return fallo(res, 400, "Este empleado todavía no tiene usuario");
  if (e.user_id === llamador && accion !== "clave") {
    return fallo(res, 400, "No puedes cambiar tu propio rol ni quitarte el acceso");
  }

  if (accion === "rol") {
    if (!e.activo) return fallo(res, 400, "Este empleado está marcado como retirado");
    const r = await supabase("/rest/v1/miembros", {
      method: "POST",
      headers: { Prefer: "resolution=merge-duplicates" },
      body: { user_id: e.user_id, nombre: e.nombre, rol, activo: true },
    });
    return r.ok ? res.status(200).json({ ok: true }) : fallo(res, 500, "No se pudo cambiar el rol");
  }

  if (accion === "clave") {
    const r = await supabase(`/auth/v1/admin/users/${e.user_id}`, { method: "PUT", body: { password: clave } });
    return r.ok ? res.status(200).json({ ok: true }) : fallo(res, 500, "No se pudo cambiar la clave");
  }

  if (accion === "quitar") {
    const r = await supabase(`/rest/v1/miembros?user_id=eq.${e.user_id}`, { method: "PATCH", body: { activo: false } });
    return r.ok ? res.status(200).json({ ok: true }) : fallo(res, 500, "No se pudo quitar el acceso");
  }

  return fallo(res, 400, "Acción no válida");
}
