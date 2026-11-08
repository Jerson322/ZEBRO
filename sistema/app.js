// Armazón del sistema: sesión, menú según el rol, navegación y actualizaciones en vivo.
import * as api from "./api.js";
import { esc, dialogoAbierto, aviso } from "./util.js";
import * as servicio from "./vistas/servicio.js";
import * as cocina from "./vistas/cocina.js";
import * as menu from "./vistas/menu.js";
import * as inventario from "./vistas/inventario.js";
import * as finanzas from "./vistas/finanzas.js";
import * as equipo from "./vistas/equipo.js";

const SECCIONES = [
  { id: "mesas", nombre: "Mesas", vista: servicio.mesas, roles: ["admin", "cajero", "mesero"], enVivo: true },
  { id: "domicilios", nombre: "Domicilios", vista: servicio.domicilios, roles: ["admin", "cajero"], enVivo: true },
  { id: "cocina", nombre: "Cocina", vista: cocina.pintar, roles: ["admin", "cajero", "mesero", "cocina"], enVivo: true },
  { id: "menu", nombre: "Menú y recetas", vista: menu.pintar, roles: ["admin"] },
  { id: "inventario", nombre: "Inventario", vista: inventario.pintar, roles: ["admin"] },
  { id: "finanzas", nombre: "Ventas y gastos", vista: finanzas.pintar, roles: ["admin", "cajero"] },
  { id: "equipo", nombre: "Empleados", vista: equipo.pintar, roles: ["admin"] },
];
// Pantalla de una cuenta (mesa o domicilio): no aparece en el menú.
const CUENTA = { id: "pedido", vista: servicio.cuenta, roles: ["admin", "cajero", "mesero"], enVivo: true };

const $vista = document.getElementById("vista");
const $menu = document.getElementById("menu");

const ctx = {
  perfil: null,
  menu: null,
  async recargarMenu() {
    ctx.menu = await api.cargarMenu();
  },
  ir(destino) {
    if (location.hash === `#${destino}`) pintar();
    else location.hash = destino;
  },
  refrescar: () => pintar(),
};

let dejarDeEscuchar = null;
let refrescoPendiente = false;
let temporizadorEnVivo = null;

function seccionesPermitidas() {
  return SECCIONES.filter((s) => s.roles.includes(ctx.perfil.rol));
}

function rutaActual() {
  const [id, param] = location.hash.slice(1).split("/");
  const permitidas = seccionesPermitidas();
  if (id === CUENTA.id && CUENTA.roles.includes(ctx.perfil.rol) && param) return { seccion: CUENTA, param };
  return { seccion: permitidas.find((s) => s.id === id) ?? permitidas[0], param };
}

let pintando = Promise.resolve();

function pintar() {
  // Una a la vez: si llegan varios cambios en vivo seguidos, no se pisan entre sí.
  pintando = pintando.then(pintarAhora, pintarAhora);
  return pintando;
}

async function pintarAhora() {
  const { seccion, param } = rutaActual();
  $menu.hidden = false;
  $menu.innerHTML =
    `<div class="marca">ZEBRO</div>` +
    seccionesPermitidas()
      .map((s) => `<a href="#${s.id}" class="${s.id === seccion.id || (seccion === CUENTA && s.id === "mesas") ? "activo" : ""}">${s.nombre}</a>`)
      .join("") +
    `<div class="pie"><small>${esc(ctx.perfil.nombre)} · ${esc(ctx.perfil.rol)}</small>
      <button class="chico" id="salir">Salir</button></div>`;
  document.getElementById("salir").addEventListener("click", salir);
  try {
    await seccion.vista($vista, ctx, param);
  } catch (error) {
    $vista.innerHTML = `<div class="panel"><p class="error">${esc(error.message)}</p>
      <button class="principal" id="reintentar">Reintentar</button></div>`;
    document.getElementById("reintentar").addEventListener("click", pintar);
  }
}

// Llega un cambio de otro dispositivo: se vuelve a pintar la pantalla si muestra pedidos.
// Si hay un formulario abierto se espera a que lo cierres, para no borrar lo que escribes.
function alCambiarEnVivo() {
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
  $vista.innerHTML = `<div class="panel acceso"><h1>ZEBRO</h1>${html}</div>`;
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
      await entrar();
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

async function entrar() {
  try {
    const usuario = await api.usuarioActual();
    if (!usuario) return pantallaLogin();
    ctx.perfil = await api.miPerfil(usuario.id);
    if (!ctx.perfil || !ctx.perfil.activo) return pantallaSinRol();
    await ctx.recargarMenu();
    dejarDeEscuchar?.();
    dejarDeEscuchar = api.escucharPedidos(alCambiarEnVivo);
    await pintar();
  } catch (error) {
    pantallaError(error.message || "No pudimos cargar el sistema. Revisa tu conexión.");
  }
}

async function salir() {
  dejarDeEscuchar?.();
  dejarDeEscuchar = null;
  await api.cerrarSesion();
  ctx.perfil = null;
  // El siguiente usuario empieza en su pantalla principal, no en la del anterior.
  history.replaceState(null, "", location.pathname);
  pantallaLogin();
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

window.addEventListener("hashchange", () => {
  if (ctx.perfil) pintar();
});
// Al volver a la pestaña (por ejemplo, el celular estuvo bloqueado) se trae lo último.
document.addEventListener("visibilitychange", () => {
  if (!document.hidden && ctx.perfil && rutaActual().seccion.enVivo && !dialogoAbierto()) pintar();
});
window.addEventListener("unhandledrejection", (evento) => aviso(evento.reason?.message || "Algo salió mal"));

iniciar();
