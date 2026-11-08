// Cocina: comandas por preparar y platos listos para entregar. Se actualiza en vivo.
import * as api from "../api.js";
import { esc, minutosDesde, aviso } from "../util.js";
import { imprimir, ticketComanda } from "../impresion.js";

const MINUTOS_DEMORA = 20;

function comanda(p, nombre, items, boton) {
  const desde = items.reduce((min, i) => (i.creado < min ? i.creado : min), items[0].creado);
  const minutos = minutosDesde(desde);
  return `<div class="comanda ${minutos >= MINUTOS_DEMORA ? "demorada" : ""}">
    <div class="comanda-cabeza"><strong>${esc(nombre)}</strong><span>${minutos} min</span></div>
    <ul>${items.map((i) => {
      const detalle = [...i.opciones.map((o) => o.nombre), i.nota].filter(Boolean).join(" · ");
      return `<li><strong>${i.cantidad}× ${esc(i.nombre)}</strong>${detalle ? `<br><small>${esc(detalle)}</small>` : ""}</li>`;
    }).join("")}</ul>
    <div class="botones-comanda">
      ${boton ? `<button class="principal" data-pedido="${p.id}" data-accion="${boton.accion}">${boton.texto}</button>` : ""}
      ${boton?.accion === "listo" ? `<button data-reimprimir="${p.id}">Reimprimir</button>` : ""}
    </div>
  </div>`;
}

export async function pintar($vista, ctx) {
  const [abiertos, mesas] = await Promise.all([api.pedidosAbiertos(), api.mesas()]);
  const rol = ctx.perfil.rol;
  const nombre = (p) =>
    p.tipo === "mesa" ? mesas.find((m) => m.id === p.mesa_id)?.nombre ?? "Mesa" : `Domicilio #${p.numero} · ${p.cliente}`;
  const con = (estado) =>
    abiertos.map((p) => ({ p, items: p.pedido_items.filter((i) => i.estado === estado) })).filter((x) => x.items.length);

  const porPreparar = con("cocina").map(({ p, items }) =>
    comanda(p, nombre(p), items, rol !== "mesero" && { accion: "listo", texto: "Listo" })
  );
  const listos = con("listo").map(({ p, items }) =>
    comanda(p, nombre(p), items, rol !== "cocina" && { accion: "entregado", texto: "Entregado" })
  );

  $vista.innerHTML = `
    <div class="encabezado"><h1>Cocina</h1><small class="suave">Se actualiza solo</small></div>
    <h2>Por preparar (${porPreparar.length})</h2>
    ${porPreparar.length ? `<div class="comandas">${porPreparar.join("")}</div>` : `<p class="vacio">No hay nada por preparar.</p>`}
    <h2>Listos para entregar (${listos.length})</h2>
    ${listos.length ? `<div class="comandas">${listos.join("")}</div>` : `<p class="vacio">Nada pendiente por entregar.</p>`}`;

  $vista.querySelectorAll("[data-reimprimir]").forEach(($b) =>
    $b.addEventListener("click", () => {
      const { p, items } = con("cocina").find((x) => x.p.id === $b.dataset.reimprimir);
      imprimir(ticketComanda({
        tipo: p.tipo, numero: p.numero, cliente: p.cliente, mesa: mesas.find((m) => m.id === p.mesa_id)?.nombre,
        enviado: items[0].creado, items,
      }));
    })
  );
  $vista.querySelectorAll("[data-accion]").forEach(($b) =>
    $b.addEventListener("click", async () => {
      $b.disabled = true;
      const [de, a] = $b.dataset.accion === "listo" ? ["cocina", "listo"] : ["listo", "entregado"];
      try {
        await api.marcarItems($b.dataset.pedido, de, a);
        ctx.refrescar();
      } catch (error) {
        aviso(error.message);
        $b.disabled = false;
      }
    })
  );
}
