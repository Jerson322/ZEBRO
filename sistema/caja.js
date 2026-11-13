// Apertura de caja y contador de efectivo con los billetes y monedas de Colombia.
// Cada toque a un billete suma uno (dos toques al de $2.000 = $4.000); «−» quita uno.
import * as api from "./api.js";
import { esc, pesos, mostrar, cerrarDialogo, aviso, tabla, tarjeta, formulario, opciones, hoy } from "./util.js";
import { calcularCierre, abrirCierre } from "./cierre.js";
import { imprimir } from "./impresion.js";

export const BILLETES = [100000, 50000, 20000, 10000, 5000, 2000];
export const MONEDAS = [1000, 500, 200, 100, 50];

export const totalConteo = (conteo) => Object.entries(conteo).reduce((s, [d, n]) => s + Number(d) * n, 0);

// Detalle legible: "2 × $50.000, 3 × $2.000…" (de mayor a menor).
export const detalleConteo = (conteo) => Object.entries(conteo ?? {})
  .filter(([, n]) => n > 0).sort((a, b) => Number(b[0]) - Number(a[0]))
  .map(([d, n]) => ({ denominacion: Number(d), cantidad: n, valor: Number(d) * n }));

// Pinta el contador dentro de $contenedor. alCambiar(total, conteo) se llama en cada toque.
export function contadorEfectivo($contenedor, alCambiar = () => {}) {
  const conteo = {};
  const ficha = (d, moneda) => {
    const n = conteo[d] ?? 0;
    return `<div class="denom${n ? " con-cantidad" : ""}">
      <button type="button" class="denom-cara ${moneda ? "moneda" : `billete b${d}`}" data-sumar="${d}" aria-label="Sumar ${pesos(d)}">
        ${pesos(d)}${n ? `<span class="denom-n">×${n}</span>` : ""}</button>
      <div class="denom-pie"><small>${n ? pesos(d * n) : "&nbsp;"}</small>
        ${n ? `<button type="button" class="chico denom-menos" data-restar="${d}" aria-label="Quitar ${pesos(d)}">−</button>` : ""}</div>
    </div>`;
  };
  const pintar = () => {
    const total = totalConteo(conteo);
    $contenedor.innerHTML = `
      <div class="denom-grupo"><strong>Billetes</strong><div class="denoms">${BILLETES.map((d) => ficha(d, false)).join("")}</div></div>
      <div class="denom-grupo"><strong>Monedas</strong><div class="denoms">${MONEDAS.map((d) => ficha(d, true)).join("")}</div></div>
      <div class="total" style="margin:0"><span>Total contado</span><span>${pesos(total)}</span></div>
      ${total ? `<button type="button" class="chico" data-limpiar style="align-self:flex-start">Volver a contar</button>` : ""}`;
    alCambiar(total, { ...conteo });
  };
  $contenedor.addEventListener("click", (e) => {
    const $b = e.target.closest("button");
    if (!$b) return;
    if ($b.dataset.sumar) conteo[$b.dataset.sumar] = (conteo[$b.dataset.sumar] ?? 0) + 1;
    else if ($b.dataset.restar) conteo[$b.dataset.restar] = Math.max(0, (conteo[$b.dataset.restar] ?? 0) - 1);
    else if ($b.dataset.limpiar !== undefined) Object.keys(conteo).forEach((k) => delete conteo[k]);
    else return;
    pintar();
  });
  pintar();
  return { total: () => totalConteo(conteo), conteo: () => ({ ...conteo }) };
}

// Campo del código de caja (solo si la persona tiene uno asignado en Ajustes).
const campoCodigo = (ctx) => (ctx.tengoCodigoCaja
  ? `<label>Tu código de caja<input id="codigo-caja" type="password" inputmode="numeric" maxlength="8" autocomplete="off"
      placeholder="••••" style="font-size:22px;letter-spacing:6px;text-align:center"></label>` : "");

// Ventana de apertura: se cuenta la base y se abre la caja propia.
export function abrirCaja(ctx, { alTerminar } = {}) {
  let total = 0;
  const $c = mostrar(`
    <h2>Abrir mi caja</h2>
    <p class="suave" style="margin:0">Cuenta el efectivo con el que empiezas (la base). Tus cobros y tus gastos quedan en tu caja.</p>
    <div id="contador-apertura" class="contador-efectivo"></div>
    ${campoCodigo(ctx)}
    <div class="botones">
      <button type="button" id="apertura-luego">Ahora no</button>
      <button type="button" class="principal" id="apertura-abrir">Abrir caja con $0</button>
    </div>`);
  document.getElementById("dialogo").classList.add("ancho");
  document.getElementById("dialogo").addEventListener("close", () => document.getElementById("dialogo").classList.remove("ancho"), { once: true });
  const $abrir = $c.querySelector("#apertura-abrir");
  const contador = contadorEfectivo($c.querySelector("#contador-apertura"), (t) => {
    total = t;
    $abrir.textContent = `Abrir caja con ${pesos(t)}`;
  });
  $c.querySelector("#apertura-luego").addEventListener("click", cerrarDialogo);
  $abrir.addEventListener("click", async () => {
    $abrir.disabled = true;
    try {
      const conteo = contador.conteo();
      await api.abrirCaja(total, conteo, $c.querySelector("#codigo-caja")?.value ?? "");
      ctx.caja = await api.miCaja();
      cerrarDialogo();
      aviso(`Tu caja quedó abierta con ${pesos(total)}`);
      // Ticket de apertura en la comandera (desde un celular se envía a la comandera).
      imprimir(ticketApertura(ctx.caja, ctx.negocio, ctx.perfil.nombre, conteo));
      alTerminar?.();
    } catch (error) {
      aviso(error.message);
      $abrir.disabled = false;
    }
  });
}

// Ticket de apertura: con cuánto se abre la caja y cuántos billetes y monedas de cada uno.
export function ticketApertura(caja, negocio, usuario, conteo) {
  const fila = (izq, der, clase = "") => `<div class="t-fila ${clase}"><span>${izq}</span><span>${der}</span></div>`;
  const detalle = detalleConteo(conteo);
  return `<div class="ticket">
    <div class="t-centro t-negocio">${esc(negocio?.nombre ?? "")}</div>
    <div class="t-centro t-negocio">APERTURA DE CAJA</div>
    ${usuario ? `<div class="t-centro"><strong>Caja de ${esc(usuario)}</strong></div>` : ""}
    <div class="t-centro">${new Date(caja?.abierta_en ?? Date.now()).toLocaleString("es-CO", { dateStyle: "full", timeStyle: "short" })}</div>
    <hr>
    ${detalle.length ? detalle.map((x) => fila(`${x.cantidad} × ${pesos(x.denominacion)}`, pesos(x.valor))).join("") : "<div>Sin efectivo</div>"}
    <hr>
    ${fila("BASE", pesos(caja?.base ?? totalConteo(conteo)), "t-total")}
    <hr>
    <div class="t-centro t-chico">Firma: ______________________</div>
  </div>`;
}

// Al entrar (administrador o cajero): si no tiene su caja abierta, se le ofrece abrirla.
// Se pregunta una sola vez por sesión; «Ahora no» deja seguir y se abre luego en Caja del día.
let yaSePregunto = false;
export async function revisarApertura(ctx) {
  if (!["admin", "cajero"].includes(ctx.perfil?.rol)) return;
  try {
    [ctx.caja, ctx.tengoCodigoCaja] = await Promise.all([api.miCaja(), api.tengoCodigoCaja()]);
  } catch {
    return;
  }
  if (ctx.caja || yaSePregunto) return;
  yaSePregunto = true;
  abrirCaja(ctx, { alTerminar: () => ctx.refrescar() });
}

// ¿Puede trabajar en Mesas y Domicilios? Quien cobra necesita su caja abierta; el resto, que haya
// al menos una caja abierta en el local.
export async function puedeTrabajar(ctx) {
  if (["admin", "cajero"].includes(ctx.perfil.rol)) {
    ctx.caja = await api.miCaja();
    return Boolean(ctx.caja);
  }
  return api.hayCajaAbierta();
}

// Pantalla cuando la caja está cerrada: no se pueden tomar pedidos ni cobrar hasta abrirla.
export function pantallaCajaCerrada($vista, ctx) {
  const puedeAbrir = ["admin", "cajero"].includes(ctx.perfil.rol);
  $vista.innerHTML = `
    <div class="panel" style="max-width:520px;margin:8vh auto 0;text-align:center;display:flex;flex-direction:column;gap:12px;align-items:center">
      <div style="font-size:52px;line-height:1">🔒</div>
      <h2 style="margin:0">${puedeAbrir ? "Tu caja está cerrada" : "La caja está cerrada"}</h2>
      <p class="suave" style="margin:0">${puedeAbrir
        ? "Para tomar pedidos y cobrar, primero abre tu caja contando la base. Tus cobros y gastos quedan en tu caja."
        : "Para tomar pedidos, alguien de la caja tiene que abrir su caja."}
        Las cajas se cierran solas a las 3:00 a. m.</p>
      ${puedeAbrir
        ? `<button class="principal" id="abrir-caja-ya" style="min-width:220px">Abrir mi caja</button>`
        : `<p style="margin:0"><strong>Pídele al cajero o al administrador que abra su caja.</strong></p>
           <button id="revisar-caja">Ya la abrieron</button>`}
    </div>`;
  $vista.querySelector("#abrir-caja-ya")?.addEventListener("click", async () => {
    ctx.tengoCodigoCaja = await api.tengoCodigoCaja().catch(() => false);
    abrirCaja(ctx, { alTerminar: () => ctx.refrescar() });
  });
  $vista.querySelector("#revisar-caja")?.addEventListener("click", () => ctx.refrescar());
}

// Gasto desde la caja: queda en la caja abierta de quien lo registra.
const CATEGORIAS_GASTO = ["Mercado", "Arriendo", "Servicios", "Nómina", "Transporte", "Publicidad", "Mantenimiento", "Impuestos", "Otros"];
const METODOS = ["Efectivo", "Tarjeta", "Transferencia", "Nequi", "Daviplata"];
function registrarGasto(ctx) {
  formulario("Registrar gasto", `
    <p class="suave" style="margin:0">Queda en tu caja. Si se paga en efectivo, se descuenta del efectivo que debe haber.</p>
    <label>Categoría<select name="categoria">${opciones(CATEGORIAS_GASTO)}</select></label>
    <label>Descripción<input name="descripcion" placeholder="Ej. Compra de verduras"></label>
    <div class="fila">
      <label>Valor<input name="valor" type="number" min="1" step="100"></label>
      <label>Pagado con<select name="metodo">${opciones(METODOS)}</select></label>
    </div>`,
    async (c) => {
      const valor = Number(c.valor);
      if (!Number.isInteger(valor) || valor < 1) throw new Error("Escribe el valor del gasto");
      await api.registrarGasto({ fecha: hoy(), categoria: c.categoria, descripcion: c.descripcion.trim(), valor, metodo: c.metodo, usuario: ctx.perfil.user_id });
    },
    { alTerminar: () => { aviso("Gasto registrado"); ctx.refrescar(); } });
}

// Caja del día: mi caja en vivo, las cajas abiertas del equipo (administrador) y todas las cajas
// del día (de 3:00 a. m. a 3:00 a. m.).
const vistaCaja = { dia: null };
const hora = (iso) => (iso ? new Date(iso).toLocaleTimeString("es-CO", { hour: "numeric", minute: "2-digit" }) : "");
const diaLocal = (fecha) =>
  `${fecha.getFullYear()}-${String(fecha.getMonth() + 1).padStart(2, "0")}-${String(fecha.getDate()).padStart(2, "0")}`;

export async function pintar($vista, ctx) {
  const admin = ctx.perfil.rol === "admin";
  const corte = new Date(await api.corteDelDia());
  const hoyNegocio = diaLocal(corte);
  const dia = vistaCaja.dia ?? hoyNegocio;
  const inicio = new Date(`${dia}T03:00:00`);
  const fin = new Date(inicio.getTime() + 86400000);
  const [mia, cajas, miembros, tengoCodigo] = await Promise.all([
    api.miCaja(), api.cajasEntre(inicio.toISOString(), fin.toISOString()), api.miembros().catch(() => []), api.tengoCodigoCaja().catch(() => false),
  ]);
  ctx.caja = mia;
  ctx.tengoCodigoCaja = tengoCodigo;
  const nombre = (id) => (id === ctx.perfil.user_id ? ctx.perfil.nombre : miembros.find((m) => m.user_id === id)?.nombre ?? "");
  // Cajas abiertas en vivo: la mía y (para el administrador) las del resto del equipo.
  const abiertas = cajas.filter((c) => !c.cerrada_en);
  const enVivo = new Map(await Promise.all(abiertas.map(async (c) => [c.id, await calcularCierre(c)])));
  const actual = mia ? enVivo.get(mia.id) ?? await calcularCierre(mia) : null;
  const fila = (izq, der, fuerte = false) => `<div class="item"><span>${izq}</span><span class="num">${fuerte ? `<strong>${der}</strong>` : der}</span></div>`;
  const resultado = (c) => {
    if (c.contado == null || c.esperado == null) return "—";
    const d = c.contado - c.esperado;
    return d === 0 ? `<span class="positivo">Cuadró</span>` : d > 0 ? `Sobró ${pesos(d)}` : `<span class="negativo">Faltó ${pesos(-d)}</span>`;
  };
  const ventasDe = (c) => (c.cerrada_en ? c.resumen?.ventas : enVivo.get(c.id)?.ventas);
  const totalDia = cajas.reduce((s, c) => s + (ventasDe(c) ?? 0), 0);
  const otrasAbiertas = abiertas.filter((c) => c.id !== mia?.id);

  $vista.innerHTML = `
    <div class="encabezado"><h1>Caja del día</h1>
      <label style="width:auto">Día<input type="date" id="dia-caja" value="${dia}" max="${hoyNegocio}"></label></div>
    <p class="suave" style="margin:-8px 0 16px">Cada persona que cobra tiene su caja: sus cobros y sus gastos quedan en ella. El día va de 3:00 a. m. a 3:00 a. m.;
      si una caja sigue abierta a esa hora, se cierra sola. Al volver a abrir, es una caja nueva desde cero.</p>
    ${dia === hoyNegocio ? (actual ? `<div class="panel">
      <div class="encabezado" style="margin-bottom:8px"><h2 style="margin:0">🟢 Mi caja</h2>
        <div class="botones-domicilio" style="margin:0">
          <button id="gasto-caja">+ Registrar gasto</button>
          <button class="principal" id="cerrar-caja">Cierre de caja</button></div></div>
      <p class="suave" style="margin:0 0 12px">Abierta desde las ${hora(mia.abierta_en)}</p>
      <div class="tarjetas">
        ${tarjeta("Base", pesos(actual.base))}
        ${tarjeta(`Cobrado (${actual.cuentas})`, pesos(actual.ventas))}
        ${tarjeta("Gastos", pesos(actual.gastos))}
        ${tarjeta("Efectivo que debe haber", pesos(actual.efectivoEsperado))}
      </div>
      <div class="columnas" style="margin-bottom:0">
        <div><strong>Dinero por método</strong>
          ${actual.metodos.map((m) => fila(`${esc(m.metodo)} <small class="suave">(${m.pagos})</small>`, pesos(m.valor))).join("")}
          ${fila("Total recibido", pesos(actual.metodos.reduce((s, m) => s + m.valor, 0)), true)}</div>
        <div><strong>Efectivo en caja</strong>
          ${fila("Base de apertura", pesos(actual.base))}
          ${fila("+ Cobros en efectivo", pesos(actual.ventasEfectivo))}
          ${fila("− Gastos en efectivo", pesos(actual.gastosEfectivo))}
          ${fila("Debe haber", pesos(actual.efectivoEsperado), true)}
          ${actual.gastosLista.length ? `<p style="margin:12px 0 4px"><strong>Mis gastos</strong></p>
            ${actual.gastosLista.map((g) => fila(`${esc(g.categoria)}${g.descripcion ? ` · <small class="suave">${esc(g.descripcion)}</small>` : ""} <small class="suave">(${esc(g.metodo)})</small>`, pesos(g.valor))).join("")}` : ""}</div>
      </div></div>`
      : `<div class="panel" style="display:flex;justify-content:space-between;align-items:center;gap:12px;flex-wrap:wrap">
          <span>🔒 <strong>Tu caja está cerrada.</strong> <span class="suave">Ábrela para tomar pedidos, cobrar y registrar gastos.</span></span>
          <button class="principal" id="abrir-caja-dia">Abrir mi caja</button></div>`) : ""}
    ${admin && dia === hoyNegocio && otrasAbiertas.length ? `<div class="panel"><h2>Cajas abiertas del equipo</h2>
      ${tabla(["Caja de", "Abierta", "#Base", "#Cobrado", "#Efectivo que debe haber", ""], otrasAbiertas.map((c) => {
        const v = enVivo.get(c.id);
        return `<tr><td class="ancho">${esc(nombre(c.abierta_por))}</td><td>${hora(c.abierta_en)}</td><td class="num">${pesos(c.base)}</td>
          <td class="num">${pesos(v?.ventas ?? 0)}</td><td class="num">${pesos(v?.efectivoEsperado ?? c.base)}</td>
          <td class="acciones"><button class="chico" data-cerrar-otra="${c.id}">Cerrar</button></td></tr>`;
      }), "")}</div>` : ""}
    <div class="panel"><h2>Cajas del ${new Date(`${dia}T12:00:00`).toLocaleDateString("es-CO", { weekday: "long", day: "numeric", month: "long" })}</h2>
      ${tabla(["Caja de", "Apertura", "Cierre", "#Base", "#Cobrado", "#Debe haber", "#Contado", "Resultado"], cajas.map((c) => `<tr>
        <td class="ancho">${esc(nombre(c.abierta_por))}${c.cerrada_por && c.cerrada_por !== c.abierta_por ? ` <small class="suave">(cerró ${esc(nombre(c.cerrada_por))})</small>` : ""}</td>
        <td>${hora(c.abierta_en)}</td>
        <td>${c.cerrada_en ? `${hora(c.cerrada_en)}${c.resumen?.automatico ? ` <small class="etiqueta">automático</small>` : ""}` : `<span class="etiqueta estado-listo">Abierta</span>`}</td>
        <td class="num">${pesos(c.base)}</td>
        <td class="num">${ventasDe(c) != null ? pesos(ventasDe(c)) : "—"}</td>
        <td class="num">${c.esperado != null ? pesos(c.esperado) : enVivo.has(c.id) ? pesos(enVivo.get(c.id).efectivoEsperado) : "—"}</td>
        <td class="num">${c.contado != null ? pesos(c.contado) : c.cerrada_en ? "No se contó" : "—"}</td>
        <td>${resultado(c)}</td></tr>`), "No hubo cajas este día.")}
      ${cajas.length ? `<p style="margin:12px 0 0"><strong>Cobrado en el día: ${pesos(totalDia)}</strong> <small class="suave">(${cajas.length} caja${cajas.length > 1 ? "s" : ""})</small></p>` : ""}
    </div>`;

  $vista.querySelector("#dia-caja").addEventListener("change", (e) => {
    vistaCaja.dia = e.target.value || null;
    ctx.refrescar();
  });
  $vista.querySelector("#cerrar-caja")?.addEventListener("click", () => abrirCierre(ctx));
  $vista.querySelector("#gasto-caja")?.addEventListener("click", () => registrarGasto(ctx));
  $vista.querySelector("#abrir-caja-dia")?.addEventListener("click", () => abrirCaja(ctx, { alTerminar: () => ctx.refrescar() }));
  $vista.querySelectorAll("[data-cerrar-otra]").forEach(($b) => $b.addEventListener("click", () => {
    const caja = otrasAbiertas.find((c) => c.id === $b.dataset.cerrarOtra);
    abrirCierre(ctx, { caja, dueno: nombre(caja.abierta_por) });
  }));
}
