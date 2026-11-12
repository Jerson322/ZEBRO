// Tickets para la comandera (80 mm) y preferencias de impresión de este equipo.
// Para imprimir sin la ventana de "Imprimir", Chrome se abre con --kiosk-printing y la comandera
// como impresora predeterminada de Windows. Desde un celular, el ticket se envía a la comandera.
import * as api from "./api.js";
import { esc, pesos, aviso } from "./util.js";

const PREFERENCIAS = {
  comandas: "zebro-imprimir-comandas",
  cuenta: "zebro-imprimir-cuenta",
};

// Cada equipo decide si imprime: se guarda en este navegador, no en la cuenta.
export function preferencia(nombre) {
  try {
    return localStorage.getItem(PREFERENCIAS[nombre]) === "si";
  } catch {
    return false;
  }
}

export function guardarPreferencia(nombre, activa) {
  try {
    localStorage.setItem(PREFERENCIAS[nombre], activa ? "si" : "no");
  } catch {
    // Sin almacenamiento (modo incógnito): la opción dura hasta cerrar la página.
  }
}

let cola = Promise.resolve();

// Imprime un ticket donde corresponde: si este equipo tiene «Comandera aquí», sale aquí mismo;
// si no (por ejemplo, un celular), se envía a la cola y lo imprime el computador de la comandera.
export async function imprimir(html) {
  if (preferencia("comandas")) return imprimirAqui(html);
  try {
    await api.enviarAImpresora(html);
    aviso("Enviado a la comandera");
  } catch (error) {
    aviso(`No se pudo enviar a la comandera: ${error.message}`);
  }
}

// Imprime un ticket en este equipo. Los tickets se imprimen uno detrás de otro, nunca a la vez.
export function imprimirAqui(html) {
  cola = cola.then(async () => {
    const $zona = document.getElementById("impresion");
    $zona.innerHTML = html;
    document.body.classList.add("imprimiendo");
    // Espera a que carguen las imágenes (el logo) para que no salga en blanco.
    await Promise.all([...$zona.querySelectorAll("img")].map((img) => img.decode().catch(() => {})));
    // Espera a que el ticket se pinte. Con la pestaña oculta (otra pestaña o ventana encima) Chrome
    // no pinta y requestAnimationFrame no llega nunca: por eso se espera como máximo un momento.
    await Promise.race([
      new Promise((listo) => requestAnimationFrame(() => requestAnimationFrame(listo))),
      new Promise((listo) => setTimeout(listo, 250)),
    ]);
    window.print();
    document.body.classList.remove("imprimiendo");
    $zona.innerHTML = "";
  }).catch(() => {});
  return cola;
}

const fechaHora = (fecha = new Date()) =>
  new Date(fecha).toLocaleString("es-CO", { dateStyle: "short", timeStyle: "short" });

const detalleItem = (i) =>
  [...(i.opciones ?? []).map((o) => o.nombre), i.nota].filter(Boolean).map((t) => `<div class="t-detalle">· ${esc(t)}</div>`).join("");

// Comanda para cocina: letra grande, sin precios.
export function ticketComanda(c) {
  const destino = c.tipo === "mesa" ? (c.mesa ?? "Mesa") : `DOMICILIO #${c.numero_domicilio ?? c.numero}`;
  return `<div class="ticket comanda-ticket">
    <div class="t-grande">${esc(destino)}</div>
    ${c.para_llevar ? `<div class="t-grande">** PARA LLEVAR **</div>` : ""}
    ${c.tipo === "domicilio" && c.cliente ? `<div>${esc(c.cliente)}</div>` : ""}
    <div>Pedido #${c.numero} · ${fechaHora(c.enviado)}</div>
    ${c.atiende ? `<div>Atiende: ${esc(c.atiende)}</div>` : ""}
    <hr>
    ${c.items.map((i) => `<div class="t-plato">${i.cantidad} × ${esc(i.nombre)}</div>${detalleItem(i)}`).join("")}
    <hr>
  </div>`;
}

// Cuenta para el cliente. Si la cuenta sigue abierta, sale como "pre-cuenta".
// parte: cuando la cuenta se divide por valor, { valor, metodo, falta, numero } de lo que paga esta persona.
export function ticketCuenta(p, negocio, { mesa, recibido, parte } = {}) {
  const subtotal = p.pedido_items.reduce((s, i) => s + i.precio * i.cantidad, 0);
  const total = subtotal + (p.envio || 0);
  const pagada = p.estado === "pagado" && !parte;
  const cambio = recibido ? recibido - (parte ? parte.valor : total + (p.propina || 0)) : 0;
  const fila = (izq, der, clase = "") => `<div class="t-fila ${clase}"><span>${izq}</span><span>${der}</span></div>`;
  return `<div class="ticket">
    ${negocio?.logo ? `<div class="t-centro"><img class="t-logo" src="${esc(negocio.logo)}" alt=""></div>` : ""}
    <div class="t-centro t-negocio">${esc(negocio?.nombre ?? "")}</div>
    ${negocio?.nit ? `<div class="t-centro">NIT ${esc(negocio.nit)}</div>` : ""}
    ${negocio?.direccion ? `<div class="t-centro">${esc(negocio.direccion)}</div>` : ""}
    ${negocio?.telefono ? `<div class="t-centro">Tel. ${esc(negocio.telefono)}</div>` : ""}
    <hr>
    <div>${pagada ? "Cuenta" : parte ? "PAGO DIVIDIDO" : "PRE-CUENTA"} #${p.numero} · ${fechaHora(p.cerrado ?? new Date())}</div>
    <div>${p.tipo === "mesa" ? esc(mesa ?? "Mesa") + (p.para_llevar ? " · Para llevar" : "") : `Domicilio #${p.numero_domicilio ?? p.numero}: ${esc(p.cliente)}`}</div>
    ${p.tipo === "domicilio" && p.direccion ? `<div>${esc(p.direccion)}</div>` : ""}
    ${p.tipo === "domicilio" && p.telefono ? `<div>Tel. ${esc(p.telefono)}</div>` : ""}
    <hr>
    ${p.pedido_items.map((i) => fila(`${i.cantidad} × ${esc(i.nombre)}`, pesos(i.precio * i.cantidad)) + detalleItem(i)).join("")}
    <hr>
    ${p.envio ? fila("Subtotal", pesos(subtotal)) + fila("Envío", pesos(p.envio)) : ""}
    ${fila("TOTAL", pesos(total), "t-total")}
    ${pagada && p.propina ? fila("Propina", pesos(p.propina)) + fila("Total pagado", pesos(total + p.propina)) : ""}
    ${pagada ? fila("Pago", esc(p.metodo_pago)) : ""}
    ${pagada && cambio > 0 ? fila("Recibido", pesos(recibido)) + fila("Cambio", pesos(cambio)) : ""}
    ${parte ? `<hr>${fila(`PAGA${parte.numero ? ` (parte ${parte.numero})` : ""}`, pesos(parte.valor), "t-total")}
      ${fila("Pago", esc(parte.metodo))}
      ${cambio > 0 ? fila("Recibido", pesos(recibido)) + fila("Cambio", pesos(cambio)) : ""}
      ${fila(parte.falta ? "Queda por cobrar" : "Cuenta pagada", parte.falta ? pesos(parte.falta) : "✓")}` : ""}
    <hr>
    ${negocio?.pie ? `<div class="t-centro">${esc(negocio.pie)}</div>` : ""}
    <div class="t-centro t-chico">Documento no válido como factura</div>
  </div>`;
}
