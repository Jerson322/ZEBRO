// Cocina: lo que se está preparando. Un solo botón marca entregado todo el pedido. Se actualiza en vivo.
import * as api from "../api.js";
import { esc, minutosDesde, aviso } from "../util.js";
import { imprimir, ticketComanda } from "../impresion.js";

const MINUTOS_DEMORA = 20;
// "listo" ya no se usa, pero los platos que quedaron así de antes también se muestran aquí.
const PREPARANDO = ["cocina", "listo"];

function comanda(p, nombre, items) {
  const desde = items.reduce((min, i) => (i.creado < min ? i.creado : min), items[0].creado);
  const minutos = minutosDesde(desde);
  return `<div class="comanda ${minutos >= MINUTOS_DEMORA ? "demorada" : ""}">
    <div class="comanda-cabeza"><strong>${esc(nombre)}</strong><span>${minutos} min</span></div>
    <ul>${items.map((i) => {
      const detalle = [...i.opciones.map((o) => o.nombre), i.nota].filter(Boolean).join(" · ");
      return `<li><strong>${i.cantidad}× ${esc(i.nombre)}</strong>${detalle ? `<br><small>${esc(detalle)}</small>` : ""}</li>`;
    }).join("")}</ul>
    <div class="botones-comanda">
      <button class="principal" data-entregar="${p.id}">Entregado</button>
      <button data-reimprimir="${p.id}">Reimprimir</button>
    </div>
  </div>`;
}

export async function pintar($vista, ctx) {
  const [pedidos, mesas] = await Promise.all([api.pedidosEnCocina(), api.mesas()]);
  const nombre = (p) =>
    p.tipo === "mesa" ? mesas.find((m) => m.id === p.mesa_id)?.nombre ?? "Mesa" : `Domicilio #${p.numero_domicilio ?? p.numero} · ${p.cliente}`;
  const preparando = pedidos
    .map((p) => ({ p, items: p.pedido_items.filter((i) => PREPARANDO.includes(i.estado)) }))
    .filter((x) => x.items.length);

  $vista.innerHTML = `
    <div class="encabezado"><h1>Cocina</h1><small class="suave">Se actualiza solo</small></div>
    <h2>Preparando (${preparando.length})</h2>
    ${preparando.length ? `<div class="comandas">${preparando.map(({ p, items }) => comanda(p, nombre(p), items)).join("")}</div>`
      : `<p class="vacio">No hay nada preparándose.</p>`}`;

  $vista.querySelectorAll("[data-reimprimir]").forEach(($b) =>
    $b.addEventListener("click", () => {
      const { p, items } = preparando.find((x) => x.p.id === $b.dataset.reimprimir);
      imprimir(ticketComanda({
        tipo: p.tipo, numero: p.numero, numero_domicilio: p.numero_domicilio, cliente: p.cliente, mesa: mesas.find((m) => m.id === p.mesa_id)?.nombre,
        enviado: items[0].creado, items,
      }));
    })
  );
  $vista.querySelectorAll("[data-entregar]").forEach(($b) =>
    $b.addEventListener("click", async () => {
      $b.disabled = true;
      try {
        await api.entregarPedido($b.dataset.entregar);
        aviso("Pedido entregado");
        ctx.refrescar();
      } catch (error) {
        aviso(error.message);
        $b.disabled = false;
      }
    })
  );
}
