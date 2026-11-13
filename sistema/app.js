// Armazón del sistema: sesión, menú según el rol, navegación y actualizaciones en vivo.
import * as api from "./api.js";
import { esc, dialogoAbierto, aviso, mostrar, cerrarDialogo } from "./util.js";
import * as servicio from "./vistas/servicio.js";
import * as cocina from "./vistas/cocina.js";
import * as menu from "./vistas/menu.js";
import * as inventario from "./vistas/inventario.js";
import * as finanzas from "./vistas/finanzas.js";
import * as equipo from "./vistas/equipo.js";
import * as ajustes from "./vistas/ajustes.js";
import { preferencia, guardarPreferencia, imprimirAqui, ticketComanda } from "./impresion.js";
import { iconos } from "./iconos.js";
import { abrirCierre } from "./cierre.js";
import { revisarApertura } from "./caja.js";
import * as caja from "./caja.js";

const SECCIONES = [
  { id: "mesas", nombre: "Mesas", vista: servicio.mesas, roles: ["admin", "cajero", "mesero", "domiciliario"], enVivo: true },
  { id: "domicilios", nombre: "Domicilios", vista: servicio.domicilios, roles: ["admin", "cajero", "domiciliario"], enVivo: true },
  { id: "cocina", nombre: "Cocina", vista: cocina.pintar, roles: ["admin", "cajero", "mesero", "cocina", "domiciliario"], enVivo: true },
  { id: "menu", nombre: "Menú y recetas", corto: "Menú", vista: menu.pintar, roles: ["admin"] },
  { id: "inventario", nombre: "Inventario", vista: inventario.pintar, roles: ["admin"] },
  { id: "caja", nombre: "Caja del día", corto: "Caja", vista: caja.pintar, roles: ["admin", "cajero"], enVivo: true },
  { id: "finanzas", nombre: "Ventas y gastos", corto: "Ventas", vista: finanzas.pintar, roles: ["admin"] },
  { id: "equipo", nombre: "Empleados", corto: "Equipo", vista: equipo.pintar, roles: ["admin"] },
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
        <button class="icono-boton" id="salir" title="Salir" aria-label="Salir">${iconos.salir}</button></div>
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

function pantallaLogin() {
  pantalla(`<form id="acceso">
    <label>Correo<input name="correo" type="email" autocomplete="username" required></label>
    <label>Clave<input name="clave" type="password" autocomplete="current-password" required></label>
    <p class="error" hidden></p>
    <button type="submit" class="principal">Entrar</button>
  </form>`);
  const $form = document.getElementById("acceso");
  $form.addEventListener("submit", async (evento) => {
    evento.preventDefault();
    const { correo, clave } = Object.fromEntries(new FormData($form));
    const $boton = $form.querySelector("button");
    $boton.disabled = true;
    try {
      await api.iniciarSesion(correo, clave);
      await entrar({ bienvenida: true });
    } catch (error) {
      const $error = $form.querySelector(".error");
      $error.textContent = error.message;
      $error.hidden = false;
      $boton.disabled = false;
    }
  });
}

// Usuario con sesión pero sin rol: o es el primero (se vuelve administrador) o falta que le den acceso.
function pantallaSinRol() {
  pantalla(`<p>Tu usuario todavía no tiene acceso al sistema.</p>
    <p class="suave">Si eres el dueño y es la primera vez, escribe tu nombre para quedar como administrador.</p>
    <form id="reclamar">
      <label>Tu nombre<input name="nombre" required></label>
      <p class="error" hidden></p>
      <button type="submit" class="principal">Soy el administrador</button>
    </form>
    <button id="salir-sin-rol">Salir</button>`);
  document.getElementById("salir-sin-rol").addEventListener("click", salir);
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

async function entrar({ bienvenida = false } = {}) {
  try {
    const usuario = await api.usuarioActual();
    if (!usuario) return pantallaLogin();
    ctx.perfil = await api.miPerfil(usuario.id);
    if (!ctx.perfil || !ctx.perfil.activo) return pantallaSinRol();
    await ctx.recargarMenu();
    ctx.negocio = await api.negocio();
    // ¿Se usan claves de autorización? (si nadie tiene clave, nada la pide)
    ctx.conClave = await api.hayClaves().catch(() => false);
    document.title = nombreNegocio();
    if (bienvenida) mostrarBienvenida();
    dejarDeEscuchar?.();
    dejarDeEscuchar = api.escucharPedidos(alCambiarEnVivo);
    // Respaldo por si se pierde algún aviso en vivo (por ejemplo, tras un corte de internet).
    clearInterval(revisarComandas);
    revisarComandas = setInterval(imprimirComandasPendientes, REVISAR_COMANDAS_CADA_MS);
    imprimirComandasPendientes();
    await pintar();
    // Si no hay caja abierta, la caja (admin o cajero) la abre contando la base. Después de la
    // bienvenida, para no taparla.
    setTimeout(() => revisarApertura(ctx), bienvenida ? 3200 : 300);
  } catch (error) {
    pantallaError(error.message || "No pudimos cargar el sistema. Revisa tu conexión.");
  }
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

// Al salir, la caja (administrador y cajero) puede cerrar el día: imprime el cierre de caja y
// luego cierra la sesión. Los demás roles salen directo.
function elegirSalida() {
  if (!["admin", "cajero"].includes(ctx.perfil?.rol)) return salir();
  const $c = mostrar(`<h2>¿Cómo quieres salir?</h2>
    <button type="button" class="principal" id="salida-cierre">Cerrar caja del día</button>
    <p class="suave" style="margin:-6px 0 0">Cuentas el efectivo con los billetes y monedas, se guarda el cierre y se imprime el resumen: lo vendido, el dinero por método, los gastos y si la caja cuadra.</p>
    <button type="button" id="salida-sesion">Solo cerrar sesión</button>
    <button type="button" id="salida-cancelar">Cancelar</button>`);
  $c.querySelector("#salida-cierre").addEventListener("click", () => abrirCierre(ctx, { conSalida: true, salir }));
  $c.querySelector("#salida-sesion").addEventListener("click", () => {
    cerrarDialogo();
    salir();
  });
  $c.querySelector("#salida-cancelar").addEventListener("click", cerrarDialogo);
}

async function salir() {
  dejarDeEscuchar?.();
  dejarDeEscuchar = null;
  clearInterval(revisarComandas);
  clearTimeout(temporizadorEnVivo);
  await api.cerrarSesion();
  ctx.perfil = null;
  // El siguiente usuario empieza en su pantalla principal, no en la del anterior, y con la
  // versión más reciente del sistema: se recarga la página.
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
