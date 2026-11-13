// Armazón del sistema: sesión, menú según el rol, navegación y actualizaciones en vivo.
import * as api from "./api.js";
import { esc, dialogoAbierto, aviso, mostrar, cerrarDialogo } from "./util.js";
import * as servicio from "./vistas/servicio.js";
import * as cocina from "./vistas/cocina.js";
import * as menu from "./vistas/menu.js";
import * as inventario from "./vistas/inventario.js";
import * as finanzas from "./vistas/finanzas.js";
import * as ajustes from "./vistas/ajustes.js";
import { preferencia, guardarPreferencia, imprimirAqui, ticketComanda } from "./impresion.js";
import { iconos } from "./iconos.js";
import { abrirCierre } from "./cierre.js";
import { revisarApertura } from "./caja.js";
import * as caja from "./caja.js";

const SECCIONES = [
  { id: "mesas", nombre: "Mesas", vista: servicio.mesas, roles: ["admin", "cajero", "mesero"], enVivo: true },
  { id: "domicilios", nombre: "Domicilios", vista: servicio.domicilios, roles: ["admin", "cajero", "domiciliario"], enVivo: true },
  { id: "cocina", nombre: "Cocina", vista: cocina.pintar, roles: ["admin", "cajero", "mesero", "cocina", "domiciliario"], enVivo: true },
  { id: "menu", nombre: "Menú y recetas", corto: "Menú", vista: menu.pintar, roles: ["admin"] },
  { id: "inventario", nombre: "Inventario", vista: inventario.pintar, roles: ["admin"] },
  { id: "caja", nombre: "Caja del día", corto: "Caja", vista: caja.pintar, roles: ["admin", "cajero"], enVivo: true },
  { id: "finanzas", nombre: "Ventas y gastos", corto: "Ventas", vista: finanzas.pintar, roles: ["admin"] },
  { id: "ajustes", nombre: "Ajustes", vista: ajustes.pintar, roles: ["admin"] },
];
const ROLES = { admin: "Administrador", cajero: "Cajero", mesero: "Mesero", cocina: "Cocina", domiciliario: "Domiciliario" };
const REVISAR_COMANDAS_CADA_MS = 15000;
// Pantalla de una cuenta (mesa o domicilio): no aparece en el menú.
const CUENTA = { id: "pedido", vista: servicio.cuenta, roles: ["admin", "cajero", "mesero", "domiciliario"], enVivo: true };
// Pantalla con la que arranca cada rol (si no, la primera del menú).
const INICIO = { domiciliario: "domicilios" };

const $vista = document.getElementById("vista");
const $menu = document.getElementById("menu");

const ctx = {
  perfil: null,
  menu: null,
  negocio: null,
  async recargarMenu() {
    ctx.menu = await api.cargarMenu();
  },
  ir(destino) {
    if (location.hash === `#${destino}`) pintar();
    else location.hash = destino;
  },
  refrescar: () => pintar(),
  imprimirPendientes: () => imprimirComandasPendientes(),
};

let dejarDeEscuchar = null;
let refrescoPendiente = false;
let temporizadorEnVivo = null;
let revisarComandas = null;
let revisarDia = null;
let buscandoComandas = false;

// Si este equipo tiene la comandera, imprime lo que se envió a cocina y aún no se ha impreso.
async function imprimirComandasPendientes() {
  if (!ctx.perfil || !preferencia("comandas") || buscandoComandas) return;
  buscandoComandas = true;
  try {
    for (const comanda of await api.comandasPorImprimir()) await imprimirAqui(ticketComanda(comanda));
    // Cuentas, tickets de pago y cierres enviados desde los celulares.
    for (const html of (await api.impresionesPorImprimir()) ?? []) if (typeof html === "string") await imprimirAqui(html);
  } catch {
    // Sin conexión: se vuelve a intentar en la próxima revisión.
  } finally {
    buscandoComandas = false;
  }
}

function seccionesPermitidas() {
  return SECCIONES.filter((s) => s.roles.includes(ctx.perfil.rol));
}

function rutaActual() {
  const [id, param] = location.hash.slice(1).split("/");
  const permitidas = seccionesPermitidas();
  if (id === CUENTA.id && CUENTA.roles.includes(ctx.perfil.rol) && param) return { seccion: CUENTA, param };
  const inicio = permitidas.find((s) => s.id === INICIO[ctx.perfil.rol]) ?? permitidas[0];
  return { seccion: permitidas.find((s) => s.id === id) ?? inicio, param };
}

let pintando = Promise.resolve();

function pintar() {
  // Una a la vez: si llegan varios cambios en vivo seguidos, no se pisan entre sí.
  pintando = pintando.then(pintarAhora, pintarAhora);
  return pintando;
}

async function pintarAhora() {
  if (!ctx.perfil) return; // quedó pendiente de antes de cerrar sesión
  const { seccion, param } = rutaActual();
  if (!seccion) {
    // Rol que esta versión de la página no conoce (por ejemplo, se publicó una versión nueva).
    pantalla(`<p>Tu usuario no tiene pantallas en esta versión del sistema.</p>
      <p class="suave">Recarga la página para traer la versión más reciente.</p>
      <button class="principal" id="recargar">Recargar</button><button id="salir-rol">Salir</button>`);
    document.getElementById("recargar").addEventListener("click", () => location.reload());
    document.getElementById("salir-rol").addEventListener("click", salir);
    return;
  }
  $menu.hidden = false;
  $menu.innerHTML =
    `<div class="marca">${logoNegocio()}<span>${esc(nombreNegocio())}</span></div>` +
    `<div class="secciones">${seccionesPermitidas()
      .map((s) => `<a href="#${s.id}" class="${s.id === seccion.id || (seccion === CUENTA && s.id === (ctx.volverA?.split("/")[0] ?? "mesas")) ? "activo" : ""}">${iconos[s.id]}<span data-corto="${s.corto ?? s.nombre}">${s.nombre}</span></a>`)
      .join("")}</div>` +
    `<div class="pie">
      <label class="comandera" title="Prende esto solo en el computador conectado a la comandera">
        <input type="checkbox" id="usar-comandera"${preferencia("comandas") ? " checked" : ""}>
        ${iconos.impresora}<span>Comandera aquí</span></label>
      <div class="usuario"><span class="avatar">${esc(ctx.perfil.nombre.trim().charAt(0).toUpperCase())}</span>
        <span class="quien"><strong>${esc(ctx.perfil.nombre)}</strong><small>${ROLES[ctx.perfil.rol]}</small></span>
        <button class="icono-boton" id="salir" title="Cambiar de cuenta" aria-label="Cambiar de cuenta">${iconos.salir}</button></div>
    </div>`;
  document.getElementById("salir").addEventListener("click", elegirSalida);
  document.getElementById("usar-comandera").addEventListener("change", (evento) => {
    guardarPreferencia("comandas", evento.target.checked);
    aviso(evento.target.checked
      ? "Este equipo imprimirá las comandas apenas se envíen a cocina"
      : "Este equipo ya no imprime comandas");
    if (evento.target.checked) imprimirComandasPendientes();
  });
  try {
    await seccion.vista($vista, ctx, param);
    etiquetarTablas($vista);
  } catch (error) {
    $vista.innerHTML = `<div class="panel"><p class="error">${esc(error.message)}</p>
      <button class="principal" id="reintentar">Reintentar</button></div>`;
    document.getElementById("reintentar").addEventListener("click", pintar);
  }
}

// En el celular cada fila de una tabla se muestra como tarjeta: cada celda lleva el nombre de su columna.
function etiquetarTablas(raiz) {
  raiz.querySelectorAll("table").forEach(($tabla) => {
    const columnas = [...$tabla.querySelectorAll("thead th")].map(($th) => $th.textContent.trim());
    $tabla.querySelectorAll("tbody tr").forEach(($fila) =>
      [...$fila.children].forEach(($celda, i) => ($celda.dataset.columna = columnas[i] ?? ""))
    );
  });
}

// Llega un cambio de otro dispositivo: se vuelve a pintar la pantalla si muestra pedidos.
// Si hay un formulario abierto se espera a que lo cierres, para no borrar lo que escribes.
function alCambiarEnVivo() {
  if (!ctx.perfil) return; // llegó justo después de cerrar sesión
  imprimirComandasPendientes();
  if (!rutaActual().seccion.enVivo) return;
  clearTimeout(temporizadorEnVivo);
  temporizadorEnVivo = setTimeout(() => {
    if (dialogoAbierto()) refrescoPendiente = true;
    else pintar();
  }, 300);
}

document.getElementById("dialogo").addEventListener("close", () => {
  if (refrescoPendiente) {
    refrescoPendiente = false;
    pintar();
  }
});

function pantalla(html) {
  $menu.hidden = true;
  $vista.innerHTML = `<div class="acceso">
    <div class="acceso-marca"><span class="logo">Z</span><h1>ZEBRO</h1><p class="suave">Sistema del restaurante</p></div>
    <div class="panel">${html}</div></div>`;
}

function pantallaError(mensaje) {
  pantalla(`<p>${esc(mensaje)}</p><button class="principal" id="reintentar">Reintentar</button>`);
  document.getElementById("reintentar").addEventListener("click", iniciar);
}

// --- Entrada ---------------------------------------------------------------------------------
// 1) El dispositivo entra con el correo y la clave del administrador; vale hasta las 3:00 a. m.
// 2) Cada persona entra con su clave («¿Quién eres?»): abre su turno y ve su vista.
// 3) «Cambiar de cuenta» cierra el turno y vuelve al teclado de claves.
const CLAVE_SESION = "zebro-sesion-hasta";
const CLAVE_TURNO = "zebro-turno";
const guardado = {
  leer: (k) => { try { return JSON.parse(localStorage.getItem(k)); } catch { return null; } },
  poner: (k, v) => { try { v == null ? localStorage.removeItem(k) : localStorage.setItem(k, JSON.stringify(v)); } catch { /* sin almacenamiento */ } },
};
// Próximas 3:00 a. m. (hora de este equipo).
function proximas3am() {
  const d = new Date();
  d.setHours(3, 0, 0, 0);
  if (d <= new Date()) d.setDate(d.getDate() + 1);
  return d.getTime();
}
const sesionVencida = () => {
  const hasta = guardado.leer(CLAVE_SESION);
  return hasta != null && Date.now() >= hasta;
};

function pantallaLogin(mensaje = "") {
  pantalla(`<form id="acceso">
    <p style="margin:0"><strong>Entrada del restaurante</strong></p>
    <p class="suave" style="margin:0">Con el correo y la clave del administrador. Vale hasta las 3:00 a. m.; después de esa hora se vuelve a pedir.</p>
    ${mensaje ? `<p class="error" style="margin:0">${esc(mensaje)}</p>` : ""}
    <label>Correo<input name="correo" type="email" autocomplete="username" required></label>
    <label>Clave<input name="clave" type="password" autocomplete="current-password" required></label>
    <p class="error" hidden></p>
    <button type="submit" class="principal">Entrar</button>
  </form>`);
  const $form = document.getElementById("acceso");
  $form.addEventListener("submit", async (evento) => {
    evento.preventDefault();
    const { correo, clave } = Object.fromEntries(new FormData($form));
    const $boton = $form.querySelector('[type="submit"]');
    $boton.disabled = true;
    try {
      await api.iniciarSesion(correo, clave);
      guardado.poner(CLAVE_SESION, proximas3am());
      await entrar();
    } catch (error) {
      const $error = $form.querySelector(".error[hidden]") ?? $form.querySelector(".error");
      $error.textContent = error.message;
      $error.hidden = false;
      $boton.disabled = false;
    }
  });
}

// Cuenta con correo pero sin acceso: o es el primero (queda como administrador) o no tiene acceso.
function pantallaSinRol() {
  pantalla(`<p>Esta cuenta todavía no tiene acceso al sistema.</p>
    <p class="suave">Si eres el dueño y es la primera vez, escribe tu nombre para quedar como administrador.</p>
    <form id="reclamar">
      <label>Tu nombre<input name="nombre" required></label>
      <p class="error" hidden></p>
      <button type="submit" class="principal">Soy el administrador</button>
    </form>
    <button id="salir-sin-rol">Salir</button>`);
  document.getElementById("salir-sin-rol").addEventListener("click", cerrarSesionDispositivo);
  const $form = document.getElementById("reclamar");
  $form.addEventListener("submit", async (evento) => {
    evento.preventDefault();
    try {
      await api.reclamarAdmin(new FormData($form).get("nombre"));
      await entrar();
    } catch (error) {
      const $error = $form.querySelector(".error");
      $error.textContent = error.message;
      $error.hidden = false;
    }
  });
}

// Primera vez: el administrador crea su persona con nombre y clave.
function pantallaPrimeraPersona(dispositivo) {
  pantalla(`<form id="primera">
    <p style="margin:0"><strong>Crea tu clave de administrador</strong></p>
    <p class="suave" style="margin:0">Desde ahora cada persona entra con su clave. Empieza por la tuya; después, en
      <strong>Ajustes → Personas del equipo</strong>, creas las de los demás (rol, nombre y clave).</p>
    <label>Tu nombre<input name="nombre" value="${esc(dispositivo?.nombre ?? "")}" required></label>
    <div class="fila">
      <label>Clave (4 a 8 números)<input name="clave" type="password" inputmode="numeric" maxlength="8" required></label>
      <label>Repítela<input name="repetir" type="password" inputmode="numeric" maxlength="8" required></label>
    </div>
    <p class="error" hidden></p>
    <button type="submit" class="principal">Guardar y entrar</button>
  </form>`);
  const $form = document.getElementById("primera");
  $form.addEventListener("submit", async (evento) => {
    evento.preventDefault();
    const { nombre, clave, repetir } = Object.fromEntries(new FormData($form));
    const $error = $form.querySelector(".error");
    try {
      if (clave !== repetir) throw new Error("Las dos claves no coinciden");
      await api.crearPrimeraPersona(nombre, clave);
      await entrarConClave(clave);
    } catch (error) {
      $error.textContent = error.message;
      $error.hidden = false;
    }
  });
}

// «¿Quién eres?»: teclado para la clave de la persona.
function pantallaClave(mensaje = "") {
  let clave = "";
  pantalla(`<div class="teclado-clave">
    <p style="margin:0;text-align:center"><strong>¿Quién eres?</strong></p>
    <p class="suave" style="margin:0;text-align:center">Escribe tu clave para entrar</p>
    <div class="puntos" id="puntos"></div>
    <p class="error" id="error-clave" style="margin:0;text-align:center"${mensaje ? "" : " hidden"}>${esc(mensaje)}</p>
    <div class="teclas">
      ${[1, 2, 3, 4, 5, 6, 7, 8, 9].map((n) => `<button type="button" data-tecla="${n}">${n}</button>`).join("")}
      <button type="button" data-tecla="borrar" aria-label="Borrar">⌫</button>
      <button type="button" data-tecla="0">0</button>
      <button type="button" class="principal" data-tecla="entrar">Entrar</button>
    </div>
    <button type="button" class="chico" id="cerrar-dispositivo" style="align-self:center">Cerrar la sesión del restaurante en este equipo</button>
  </div>`);
  const $puntos = document.getElementById("puntos");
  const $error = document.getElementById("error-clave");
  const pintarPuntos = () => ($puntos.textContent = "•".repeat(clave.length) || " ");
  const enviar = async () => {
    if (clave.length < 4) return;
    try {
      await entrarConClave(clave);
    } catch (error) {
      clave = "";
      pintarPuntos();
      $error.textContent = error.message;
      $error.hidden = false;
    }
  };
  const tecla = (t) => {
    if (t === "borrar") clave = clave.slice(0, -1);
    else if (t === "entrar") return enviar();
    else if (clave.length < 8) clave += t;
    $error.hidden = true;
    pintarPuntos();
  };
  document.querySelectorAll("[data-tecla]").forEach(($b) => $b.addEventListener("click", () => tecla($b.dataset.tecla)));
  // También con el teclado del computador.
  const alTeclear = (e) => {
    if (!document.getElementById("puntos")) return document.removeEventListener("keydown", alTeclear);
    if (/^[0-9]$/.test(e.key)) tecla(e.key);
    else if (e.key === "Backspace") tecla("borrar");
    else if (e.key === "Enter") tecla("entrar");
  };
  document.addEventListener("keydown", alTeclear);
  document.getElementById("cerrar-dispositivo").addEventListener("click", () => {
    if (confirm("¿Cerrar la sesión del restaurante en este equipo? Para volver a entrar se necesita el correo y la clave del administrador.")) cerrarSesionDispositivo();
  });
  pintarPuntos();
}

async function entrarConClave(clave) {
  const turno = await api.iniciarTurno(clave);
  guardado.poner(CLAVE_TURNO, turno.token);
  api.usarTurno(turno.token);
  await empezar(turno, { bienvenida: true });
}

async function entrar() {
  try {
    const usuario = await api.usuarioActual();
    if (!usuario) return pantallaLogin();
    if (sesionVencida()) {
      await api.cerrarSesion();
      guardado.poner(CLAVE_SESION, null);
      guardado.poner(CLAVE_TURNO, null);
      return pantallaLogin("El día terminó (3:00 a. m.): vuelve a entrar con el correo y la clave del administrador.");
    }
    if (guardado.leer(CLAVE_SESION) == null) guardado.poner(CLAVE_SESION, proximas3am());
    const dispositivo = await api.miPerfil(usuario.id);
    if (!dispositivo || !dispositivo.activo) return pantallaSinRol();
    if (!(await api.hayPersonas())) return pantallaPrimeraPersona(dispositivo);
    const token = guardado.leer(CLAVE_TURNO);
    let persona = null;
    if (token) {
      api.usarTurno(token);
      persona = await api.turnoActual().catch(() => null);
    }
    if (!persona) {
      api.usarTurno(null);
      guardado.poner(CLAVE_TURNO, null);
      return pantallaClave();
    }
    await empezar(persona);
  } catch (error) {
    pantallaError(error.message || "No pudimos cargar el sistema. Revisa tu conexión.");
  }
}

// Con la persona del turno: su vista, el menú, los avisos en vivo y la comandera.
async function empezar(persona, { bienvenida = false } = {}) {
  ctx.perfil = { user_id: persona.id, nombre: persona.nombre, rol: persona.rol, activo: true };
  await ctx.recargarMenu();
  ctx.negocio = await api.negocio();
  // ¿Se usan claves de autorización? (las de los administradores)
  ctx.conClave = await api.hayClaves().catch(() => false);
  document.title = nombreNegocio();
  if (bienvenida) mostrarBienvenida();
  dejarDeEscuchar?.();
  dejarDeEscuchar = api.escucharPedidos(alCambiarEnVivo);
  // Respaldo por si se pierde algún aviso en vivo (por ejemplo, tras un corte de internet).
  clearInterval(revisarComandas);
  revisarComandas = setInterval(imprimirComandasPendientes, REVISAR_COMANDAS_CADA_MS);
  imprimirComandasPendientes();
  // A las 3:00 a. m. termina el día: se vuelve a pedir la entrada del administrador.
  clearInterval(revisarDia);
  revisarDia = setInterval(() => { if (sesionVencida()) location.replace(location.pathname); }, 60000);
  history.replaceState(null, "", location.pathname);
  await pintar();
  // Si quien cobra no tiene su caja abierta, se le ofrece abrirla (después de la bienvenida).
  setTimeout(() => revisarApertura(ctx), bienvenida ? 3200 : 300);
}

// Nombre y logo del restaurante (Ajustes). Sin logo, la inicial del nombre.
const nombreNegocio = () => ctx.negocio?.nombre?.trim() || "ZEBRO";
function logoNegocio(clase = "logo") {
  return ctx.negocio?.logo
    ? `<span class="${clase} con-imagen"><img src="${esc(ctx.negocio.logo)}" alt=""></span>`
    : `<span class="${clase}">${esc(nombreNegocio().charAt(0).toUpperCase())}</span>`;
}

// Animación de bienvenida al entrar: logo, nombre del restaurante y saludo. Se quita sola
// (o tocándola). Si el equipo pide menos movimiento, solo aparece y desaparece.
function mostrarBienvenida() {
  document.getElementById("bienvenida")?.remove();
  const hora = new Date().getHours();
  const saludo = hora < 12 ? "Buenos días" : hora < 19 ? "Buenas tardes" : "Buenas noches";
  const $b = document.createElement("div");
  $b.id = "bienvenida";
  $b.setAttribute("role", "status");
  $b.innerHTML = `
    <div class="bv-brillo"></div>
    <div class="bv-centro">
      ${logoNegocio("logo bv-logo")}
      <p class="bv-hola">${saludo}, ${esc(ctx.perfil.nombre.split(" ")[0])}</p>
      <h1 class="bv-nombre">${esc(nombreNegocio())}</h1>
      <p class="bv-rol">${ROLES[ctx.perfil.rol] ?? ""} · ¡Bienvenido!</p>
      <div class="bv-carga"><span></span></div>
    </div>`;
  document.body.append($b);
  const quitar = () => {
    $b.classList.add("saliendo");
    setTimeout(() => $b.remove(), 500);
  };
  const temporizador = setTimeout(quitar, 2800);
  $b.addEventListener("click", () => {
    clearTimeout(temporizador);
    quitar();
  });
}

// Cambiar de cuenta: quien cobra (administrador y cajero) puede antes cerrar su caja. Los demás
// cambian directo.
function elegirSalida() {
  if (!["admin", "cajero"].includes(ctx.perfil?.rol)) return salir();
  const $c = mostrar(`<h2>Cambiar de cuenta</h2>
    <button type="button" class="principal" id="salida-cierre">Cerrar mi caja y cambiar de cuenta</button>
    <p class="suave" style="margin:-6px 0 0">Cuentas el efectivo con los billetes y monedas, se guarda el cierre y se imprime el resumen: lo vendido, el dinero por método, los gastos y si la caja cuadra.</p>
    <button type="button" id="salida-sesion">Solo cambiar de cuenta</button>
    <button type="button" id="salida-cancelar">Cancelar</button>`);
  $c.querySelector("#salida-cierre").addEventListener("click", () => abrirCierre(ctx, { conSalida: true, salir }));
  $c.querySelector("#salida-sesion").addEventListener("click", () => {
    cerrarDialogo();
    salir();
  });
  $c.querySelector("#salida-cancelar").addEventListener("click", cerrarDialogo);
}

// Cierra el turno de la persona y vuelve a «¿Quién eres?». Se recarga la página para que la
// siguiente persona empiece en su pantalla y con la versión más reciente del sistema.
async function salir() {
  dejarDeEscuchar?.();
  dejarDeEscuchar = null;
  clearInterval(revisarComandas);
  clearTimeout(temporizadorEnVivo);
  await api.terminarTurno().catch(() => {});
  guardado.poner(CLAVE_TURNO, null);
  api.usarTurno(null);
  ctx.perfil = null;
  location.replace(location.pathname);
}

// Cierra la sesión del restaurante en este equipo (después se necesita el correo del administrador).
async function cerrarSesionDispositivo() {
  await api.terminarTurno().catch(() => {});
  guardado.poner(CLAVE_TURNO, null);
  guardado.poner(CLAVE_SESION, null);
  api.usarTurno(null);
  await api.cerrarSesion();
  location.replace(location.pathname);
}

async function iniciar() {
  if (!api.configurado) {
    pantalla(`<p>Falta conectar el sistema a Supabase (archivo <code>sistema/config.js</code>).</p>`);
    return;
  }
  if (!api.libreriaCargada()) {
    pantallaError("No se pudo cargar el sistema. Revisa tu conexión.");
    return;
  }
  await entrar();
}

window.addEventListener("hashchange", (evento) => {
  // Al abrir una cuenta se recuerda la pantalla de donde se vino, para que «Volver» regrese ahí
  // (por ejemplo, a Ventas y gastos y no a Mesas).
  const antes = new URL(evento.oldURL).hash.slice(1);
  if (location.hash.startsWith(`#${CUENTA.id}/`) && antes && !antes.startsWith(`${CUENTA.id}/`)) ctx.volverA = antes;
  if (ctx.perfil) pintar();
});
// Al volver a la pestaña (por ejemplo, el celular estuvo bloqueado) se trae lo último.
document.addEventListener("visibilitychange", () => {
  // Al volver a la pestaña se imprime de una lo que haya quedado pendiente.
  if (!document.hidden && ctx.perfil) imprimirComandasPendientes();
  if (!document.hidden && ctx.perfil && rutaActual().seccion.enVivo && !dialogoAbierto()) pintar();
});
window.addEventListener("unhandledrejection", (evento) => aviso(evento.reason?.message || "Algo salió mal"));

iniciar();
