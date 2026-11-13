// Apertura de caja y contador de efectivo con los billetes y monedas de Colombia.
// Cada toque a un billete suma uno (dos toques al de $2.000 = $4.000); «−» quita uno.
import * as api from "./api.js";
import { esc, pesos, mostrar, cerrarDialogo, aviso, tabla, tarjeta } from "./util.js";
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

// Ventana de apertura: se cuenta la base y se abre la caja.
export function abrirCaja(ctx, { alTerminar } = {}) {
  let total = 0;
  const $c = mostrar(`
    <h2>Abrir caja</h2>
    <div id="contador-apertura" class="contador-efectivo"></div>
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
      ctx.caja = await api.abrirCaja(total, conteo).then(() => api.cajaAbierta());
      cerrarDialogo();
      aviso(`Caja abierta con ${pesos(total)}`);
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
    <div class="t-centro">${new Date(caja?.abierta_en ?? Date.now()).toLocaleString("es-CO", { dateStyle: "full", timeStyle: "short" })}</div>
    ${usuario ? `<div class="t-centro">Abrió: ${esc(usuario)}</div>` : ""}
    <hr>
    ${detalle.length ? detalle.map((x) => fila(`${x.cantidad} × ${pesos(x.denominacion)}`, pesos(x.valor))).join("") : "<div>Sin efectivo</div>"}
    <hr>
    ${fila("BASE", pesos(caja?.base ?? totalConteo(conteo)), "t-total")}
    <hr>
    <div class="t-centro t-chico">Firma: ______________________</div>
  </div>`;
}

// Al entrar la caja (administrador o cajero): si no hay caja abierta, se ofrece abrirla.
// Se pregunta una sola vez por sesión; «Ahora no» deja seguir y se puede abrir luego desde Ventas.
let yaSePregunto = false;
export async function revisarApertura(ctx) {
  if (!["admin", "cajero"].includes(ctx.perfil?.rol)) return;
  try {
    ctx.caja = await api.cajaAbierta();
  } catch {
    return;
  }
  if (ctx.caja || yaSePregunto) return;
  yaSePregunto = true;
  abrirCaja(ctx, { alTerminar: () => ctx.refrescar() });
}

// Pantalla cuando la caja está cerrada: no se pueden tomar pedidos ni cobrar hasta abrirla.
export function pantallaCajaCerrada($vista, ctx) {
  const puedeAbrir = ["admin", "cajero"].includes(ctx.perfil.rol);
  $vista.innerHTML = `
    <div class="panel" style="max-width:520px;margin:8vh auto 0;text-align:center;display:flex;flex-direction:column;gap:12px;align-items:center">
      <div style="font-size:52px;line-height:1">🔒</div>
      <h2 style="margin:0">La caja está cerrada</h2>
      <p class="suave" style="margin:0">Para tomar pedidos y cobrar, primero hay que abrir la caja contando la base.
        Cada día la caja se cierra sola a las 3:00 a. m.</p>
      ${puedeAbrir
        ? `<button class="principal" id="abrir-caja-ya" style="min-width:220px">Abrir caja</button>`
        : `<p style="margin:0"><strong>Pídele al cajero o al administrador que abra la caja.</strong></p>
           <button id="revisar-caja">Ya la abrieron</button>`}
    </div>`;
  $vista.querySelector("#abrir-caja-ya")?.addEventListener("click", () => abrirCaja(ctx, { alTerminar: () => ctx.refrescar() }));
  $vista.querySelector("#revisar-caja")?.addEventListener("click", () => ctx.refrescar());
}

// Caja del día: la caja abierta en vivo y todas las cajas del día (de 3:00 a. m. a 3:00 a. m.).
const vistaCaja = { dia: null };
const hora = (iso) => (iso ? new Date(iso).toLocaleTimeString("es-CO", { hour: "numeric", minute: "2-digit" }) : "");
const diaLocal = (fecha) =>
  `${fecha.getFullYear()}-${String(fecha.getMonth() + 1).padStart(2, "0")}-${String(fecha.getDate()).padStart(2, "0")}`;

export async function pintar($vista, ctx) {
  const corte = new Date(await api.corteDelDia());
  const hoyNegocio = diaLocal(corte);
  const dia = vistaCaja.dia ?? hoyNegocio;
  const inicio = new Date(`${dia}T03:00:00`);
  const fin = new Date(inicio.getTime() + 86400000);
  const [caja, cajas, miembros] = await Promise.all([
    api.cajaAbierta(), api.cajasEntre(inicio.toISOString(), fin.toISOString()), api.miembros().catch(() => []),
  ]);
  const actual = caja ? await calcularCierre(caja) : null;
  const nombre = (id) => miembros.find((m) => m.user_id === id)?.nombre ?? "";
  const fila = (izq, der, fuerte = false) => `<div class="item"><span>${izq}</span><span class="num">${fuerte ? `<strong>${der}</strong>` : der}</span></div>`;
  const resultado = (c) => {
    if (c.contado == null || c.esperado == null) return "—";
    const d = c.contado - c.esperado;
    return d === 0 ? `<span class="positivo">Cuadró</span>` : d > 0 ? `Sobró ${pesos(d)}` : `<span class="negativo">Faltó ${pesos(-d)}</span>`;
  };
  const ventasDe = (c) => (c.cerrada_en ? c.resumen?.ventas : c.id === caja?.id ? actual?.ventas : null);
  const totalDia = cajas.reduce((s, c) => s + (ventasDe(c) ?? 0), 0);

  $vista.innerHTML = `
    <div class="encabezado"><h1>Caja del día</h1>
      <label style="width:auto">Día<input type="date" id="dia-caja" value="${dia}" max="${hoyNegocio}"></label></div>
    <p class="suave" style="margin:-8px 0 16px">El día del restaurante va de 3:00 a. m. a 3:00 a. m. Si una caja sigue abierta a las 3:00 a. m., se cierra sola.
      Al volver a abrir, es una caja nueva que empieza en cero.</p>
    ${dia === hoyNegocio ? (actual ? `<div class="panel">
      <div class="encabezado" style="margin-bottom:8px"><h2 style="margin:0">🟢 Caja abierta</h2>
        <button class="principal" id="cerrar-caja">Cierre de caja</button></div>
      <p class="suave" style="margin:0 0 12px">Desde las ${hora(caja.abierta_en)}${nombre(caja.abierta_por) ? ` · abrió ${nombre(caja.abierta_por)}` : ""}</p>
      <div class="tarjetas">
        ${tarjeta("Base", pesos(actual.base))}
        ${tarjeta(`Ventas (${actual.cuentas})`, pesos(actual.ventas))}
        ${tarjeta("Gastos", pesos(actual.gastos))}
        ${tarjeta("Efectivo que debe haber", pesos(actual.efectivoEsperado))}
      </div>
      <div class="columnas" style="margin-bottom:0">
        <div><strong>Dinero por método</strong>
          ${actual.metodos.map((m) => fila(`${esc(m.metodo)} <small class="suave">(${m.pagos})</small>`, pesos(m.valor))).join("")}
          ${fila("Total recibido", pesos(actual.metodos.reduce((s, m) => s + m.valor, 0)), true)}</div>
        <div><strong>Efectivo en caja</strong>
          ${fila("Base de apertura", pesos(actual.base))}
          ${fila("+ Ventas en efectivo", pesos(actual.ventasEfectivo))}
          ${fila("− Gastos en efectivo", pesos(actual.gastosEfectivo))}
          ${fila("Debe haber", pesos(actual.efectivoEsperado), true)}
          ${actual.abiertas ? `<p class="error" style="margin:8px 0 0">${actual.abiertas} cuenta(s) abiertas sin cobrar.</p>` : ""}</div>
      </div></div>`
      : `<div class="panel" style="display:flex;justify-content:space-between;align-items:center;gap:12px;flex-wrap:wrap">
          <span>🔒 <strong>La caja está cerrada.</strong> <span class="suave">No se pueden tomar pedidos ni cobrar.</span></span>
          <button class="principal" id="abrir-caja-dia">Abrir caja</button></div>`) : ""}
    <div class="panel"><h2>Cajas del ${new Date(`${dia}T12:00:00`).toLocaleDateString("es-CO", { weekday: "long", day: "numeric", month: "long" })}</h2>
      ${tabla(["Apertura", "Cierre", "Abrió", "Cerró", "#Base", "#Ventas", "#Debe haber", "#Contado", "Resultado"], cajas.map((c) => `<tr>
        <td>${hora(c.abierta_en)}</td>
        <td>${c.cerrada_en ? `${hora(c.cerrada_en)}${c.resumen?.automatico ? ` <small class="etiqueta">automático</small>` : ""}` : `<span class="etiqueta estado-listo">Abierta</span>`}</td>
        <td>${esc(nombre(c.abierta_por))}</td><td>${esc(nombre(c.cerrada_por))}</td>
        <td class="num">${pesos(c.base)}</td>
        <td class="num">${ventasDe(c) != null ? pesos(ventasDe(c)) : "—"}</td>
        <td class="num">${c.esperado != null ? pesos(c.esperado) : c.id === caja?.id ? pesos(actual.efectivoEsperado) : "—"}</td>
        <td class="num">${c.contado != null ? pesos(c.contado) : c.cerrada_en ? "No se contó" : "—"}</td>
        <td>${resultado(c)}</td></tr>`), "No hubo cajas este día.")}
      ${cajas.length ? `<p style="margin:12px 0 0"><strong>Ventas del día: ${pesos(totalDia)}</strong> <small class="suave">(${cajas.length} caja${cajas.length > 1 ? "s" : ""})</small></p>` : ""}
    </div>`;

  $vista.querySelector("#dia-caja").addEventListener("change", (e) => {
    vistaCaja.dia = e.target.value || null;
    ctx.refrescar();
  });
  $vista.querySelector("#cerrar-caja")?.addEventListener("click", () => abrirCierre(ctx));
  $vista.querySelector("#abrir-caja-dia")?.addEventListener("click", () => abrirCaja(ctx, { alTerminar: () => ctx.refrescar() }));
}
