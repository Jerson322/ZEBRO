// Inventario de insumos (solo administrador): existencias, compras, salidas y movimientos.
import * as api from "../api.js";
import { esc, pesos, numero, opciones, tabla, tarjeta, formulario, aviso } from "../util.js";

const UNIDADES = [["g", "gramos (g)"], ["kg", "kilos (kg)"], ["ml", "mililitros (ml)"], ["l", "litros (l)"], ["und", "unidades (und)"]];

export async function pintar($vista, ctx) {
  const [insumos, movimientos] = await Promise.all([api.insumos(), api.movimientos(30)]);
  const valor = insumos.reduce((s, i) => s + Math.max(Number(i.stock), 0) * Number(i.costo), 0);
  const bajos = insumos.filter((i) => Number(i.stock) <= Number(i.minimo));

  $vista.innerHTML = `
    <div class="encabezado"><h1>Inventario</h1><button class="principal" id="nuevo-insumo">Nuevo insumo</button></div>
    <div class="tarjetas">
      ${tarjeta("Valor del inventario", pesos(valor))}
      ${tarjeta("Insumos por agotarse", bajos.length, bajos.length ? "negativo" : "")}
    </div>
    <div class="panel">${tabla(["Insumo", "#Existencias", "#Costo por unidad", "#Valor", ""], insumos.map((i) => {
      const bajo = Number(i.stock) <= Number(i.minimo);
      return `<tr><td class="ancho">${esc(i.nombre)}</td>
        <td class="num ${bajo ? "negativo" : ""}">${numero(i.stock)} ${esc(i.unidad)}</td>
        <td class="num">${pesos(i.costo)}${Number(i.costo) < 10 && Number(i.costo) > 0 ? ` <small class="suave">(${numero(i.costo, 4)})</small>` : ""}</td>
        <td class="num">${pesos(Math.max(Number(i.stock), 0) * Number(i.costo))}</td>
        <td class="acciones"><button class="chico" data-mover="${i.id}">Entrada / salida</button>
          <button class="chico" data-editar="${i.id}">Editar</button>
          <button class="chico peligro" data-borrar="${i.id}">Borrar</button></td></tr>`;
    }), "Agrega tus insumos: pan, carne, gaseosas…")}</div>
    <div class="panel"><h2>Últimos movimientos</h2>
      ${tabla(["Fecha", "Insumo", "Motivo", "#Cantidad", "#Quedan"], movimientos.map((m) => `<tr>
        <td>${new Date(m.fecha).toLocaleString("es-CO", { dateStyle: "short", timeStyle: "short" })}</td>
        <td class="ancho">${esc(m.insumo)}</td><td class="ancho">${esc(m.motivo)}</td>
        <td class="num ${Number(m.cantidad) < 0 ? "negativo" : "positivo"}">${Number(m.cantidad) > 0 ? "+" : ""}${numero(m.cantidad)}</td>
        <td class="num">${numero(m.saldo)}</td></tr>`), "Sin movimientos todavía.")}</div>`;

  const porId = (id) => insumos.find((i) => i.id === id);
  $vista.querySelector("#nuevo-insumo").addEventListener("click", () => formularioInsumo({}, ctx));
  $vista.querySelectorAll("[data-editar]").forEach(($b) => $b.addEventListener("click", () => formularioInsumo(porId($b.dataset.editar), ctx)));
  $vista.querySelectorAll("[data-mover]").forEach(($b) => $b.addEventListener("click", () => formularioMovimiento(porId($b.dataset.mover), ctx)));
  $vista.querySelectorAll("[data-borrar]").forEach(($b) =>
    $b.addEventListener("click", async () => {
      if (!confirm("¿Borrar este insumo?")) return;
      try {
        await api.borrar("insumos", $b.dataset.borrar);
        ctx.refrescar();
      } catch (e) {
        aviso(e.message.includes("usando") ? "No se puede borrar: está en la receta de algún plato" : e.message);
      }
    })
  );
}

function formularioInsumo(i, ctx) {
  const nuevo = !i.id;
  formulario(nuevo ? "Nuevo insumo" : "Editar insumo", `
    <div class="fila">
      <label>Nombre<input name="nombre" value="${esc(i.nombre)}" placeholder="Ej. Carne de res"></label>
      <label>Unidad<select name="unidad">${opciones(UNIDADES, i.unidad ?? "g")}</select></label>
    </div>
    <div class="fila">
      <label>Costo por unidad<input name="costo" type="number" min="0" step="any" value="${i.costo ?? ""}" placeholder="Ej. 20 por gramo"></label>
      <label>Avisar cuando queden<input name="minimo" type="number" min="0" step="any" value="${i.minimo ?? 0}"></label>
    </div>
    ${nuevo ? `<label>Existencias iniciales<input name="stock" type="number" min="0" step="any" value="0"></label>` : ""}
    `,
    async (c) => {
      if (!c.nombre.trim()) throw new Error("Escribe el nombre del insumo");
      const costo = Number(c.costo || 0);
      const minimo = Number(c.minimo || 0);
      if (costo < 0 || minimo < 0) throw new Error("Los valores no pueden ser negativos");
      const fila = { nombre: c.nombre.trim(), unidad: c.unidad, costo, minimo };
      if (!nuevo) return api.guardar("insumos", { id: i.id, ...fila });
      const creado = await api.guardarDevolviendo("insumos", fila);
      // Las existencias iniciales entran como movimiento, para que quede registrado.
      if (Number(c.stock) > 0) await api.moverInsumo(creado.id, "entrada", c.stock, costo, "Existencias iniciales");
    },
    { alTerminar: () => ctx.refrescar() });
}

function formularioMovimiento(i, ctx) {
  formulario(`Entrada o salida: ${esc(i.nombre)}`, `
    <p class="suave" style="margin:0">Hay ${numero(i.stock)} ${esc(i.unidad)}</p>
    <div class="fila">
      <label>Tipo<select name="tipo"><option value="entrada">Entrada (compra)</option><option value="salida">Salida (daño, pérdida, consumo)</option></select></label>
      <label>Cantidad (${esc(i.unidad)})<input name="cantidad" type="number" min="0" step="any"></label>
    </div>
    <div class="fila">
      <label>Costo por unidad (solo compras, opcional)<input name="costo" type="number" min="0" step="any"></label>
      <label>Motivo<input name="motivo" placeholder="Ej. Compra en el mercado"></label>
    </div>`,
    (c) => api.moverInsumo(i.id, c.tipo, c.cantidad, c.tipo === "entrada" ? c.costo : null, c.motivo),
    { alTerminar: () => ctx.refrescar() });
}
