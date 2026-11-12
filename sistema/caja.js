// Apertura de caja y contador de efectivo con los billetes y monedas de Colombia.
// Cada toque a un billete suma uno (dos toques al de $2.000 = $4.000); «−» quita uno.
import * as api from "./api.js";
import { esc, pesos, mostrar, cerrarDialogo, aviso } from "./util.js";
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
