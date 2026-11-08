// Tickets para la comandera (80 mm) y preferencias de impresión de este equipo.
// Para imprimir sin la ventana de "Imprimir", Chrome se abre con --kiosk-printing y la comandera
// como impresora predeterminada de Windows (ver la sección Ajustes).
import { esc, pesos } from "./util.js";

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

// Imprime un ticket. Los tickets se imprimen uno detrás de otro, nunca a la vez.
export function imprimir(html) {
  cola = cola.then(async () => {
    const $zona = document.getElementById("impresion");
    $zona.innerHTML = html;
    document.body.classList.add("imprimiendo");
    await new Promise((listo) => requestAnimationFrame(() => requestAnimationFrame(listo)));
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
  const destino = c.tipo === "mesa" ? (c.mesa ?? "Mesa") : `DOMICILIO #${c.numero}`;
  return `<div class="ticket comanda-ticket">
    <div class="t-grande">${esc(destino)}</div>
    ${c.tipo === "domicilio" && c.cliente ? `<div>${esc(c.cliente)}</div>` : ""}
    <div>Pedido #${c.numero} · ${fechaHora(c.enviado)}</div>
    ${c.atiende ? `<div>Atiende: ${esc(c.atiende)}</div>` : ""}
    <hr>
    ${c.items.map((i) => `<div class="t-plato">${i.cantidad} × ${esc(i.nombre)}</div>${detalleItem(i)}`).join("")}
    <hr>
  </div>`;
}

// Cuenta para el cliente. Si la cuenta sigue abierta, sale como "pre-cuenta".
export function ticketCuenta(p, negocio, { mesa, recibido } = {}) {
  const subtotal = p.pedido_items.reduce((s, i) => s + i.precio * i.cantidad, 0);
  const total = subtotal + (p.envio || 0);
  const pagada = p.estado === "pagado";
  const cambio = recibido ? recibido - total - (p.propina || 0) : 0;
  const fila = (izq, der, clase = "") => `<div class="t-fila ${clase}"><span>${izq}</span><span>${der}</span></div>`;
  return `<div class="ticket">
    <div class="t-centro t-negocio">${esc(negocio?.nombre ?? "")}</div>
    ${negocio?.nit ? `<div class="t-centro">NIT ${esc(negocio.nit)}</div>` : ""}
    ${negocio?.direccion ? `<div class="t-centro">${esc(negocio.direccion)}</div>` : ""}
    ${negocio?.telefono ? `<div class="t-centro">Tel. ${esc(negocio.telefono)}</div>` : ""}
    <hr>
    <div>${pagada ? "Cuenta" : "PRE-CUENTA"} #${p.numero} · ${fechaHora(p.cerrado ?? new Date())}</div>
    <div>${p.tipo === "mesa" ? esc(mesa ?? "Mesa") : `Domicilio: ${esc(p.cliente)}`}</div>
    ${p.tipo === "domicilio" ? `<div>${esc(p.direccion)}</div><div>Tel. ${esc(p.telefono)}</div>` : ""}
    <hr>
    ${p.pedido_items.map((i) => fila(`${i.cantidad} × ${esc(i.nombre)}`, pesos(i.precio * i.cantidad)) + detalleItem(i)).join("")}
    <hr>
    ${p.envio ? fila("Subtotal", pesos(subtotal)) + fila("Envío", pesos(p.envio)) : ""}
    ${fila("TOTAL", pesos(total), "t-total")}
    ${pagada && p.propina ? fila("Propina", pesos(p.propina)) + fila("Total pagado", pesos(total + p.propina)) : ""}
    ${!pagada ? `<div class="t-centro">Propina sugerida (10%): ${pesos(Math.round(subtotal * 0.1 / 100) * 100)}</div>` : ""}
    ${pagada ? fila("Pago", esc(p.metodo_pago)) : ""}
    ${pagada && cambio > 0 ? fila("Recibido", pesos(recibido)) + fila("Cambio", pesos(cambio)) : ""}
    <hr>
    ${negocio?.pie ? `<div class="t-centro">${esc(negocio.pie)}</div>` : ""}
    <div class="t-centro t-chico">Documento no válido como factura</div>
  </div>`;
}
