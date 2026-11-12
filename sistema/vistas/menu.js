// Menú y recetas (solo administrador): platos, costo por receta, categorías y modificadores.
import * as api from "../api.js";
import { esc, pesos, numero, opciones, tabla, formulario, aviso } from "../util.js";
import { descargarMenu, subirMenu } from "../menu-excel.js";
import { autorizar } from "../clave.js";

let pestana = "platos";

const costoReceta = (platoId, recetas, insumos) =>
  recetas
    .filter((r) => r.plato_id === platoId)
    .reduce((s, r) => s + Number(r.cantidad) * Number(insumos.find((i) => i.id === r.insumo_id)?.costo ?? 0), 0);

export async function pintar($vista, ctx) {
  const insumos = await api.insumos();
  const { categorias, platos, grupos, opciones: ops, platoGrupos, recetas } = ctx.menu;
  const recargar = async () => {
    await ctx.recargarMenu();
    ctx.refrescar();
  };
  const nombreCategoria = (id) => categorias.find((c) => c.id === id)?.nombre ?? "—";

  const vistas = {
    platos: () => tabla(["Plato", "Categoría", "#Precio", "#Costo", "#Margen", ""],
      [...platos].sort((a, b) => nombreCategoria(a.categoria_id).localeCompare(nombreCategoria(b.categoria_id)) || a.nombre.localeCompare(b.nombre))
        .map((pl) => {
          const costo = costoReceta(pl.id, recetas, insumos);
          const tieneReceta = recetas.some((r) => r.plato_id === pl.id);
          const margen = pl.precio ? Math.round(((pl.precio - costo) / pl.precio) * 100) : 0;
          return `<tr class="${pl.activo ? "" : "inactivo"}">
            <td class="ancho">${esc(pl.nombre)}${pl.activo ? "" : ` <small class="etiqueta">Oculto</small>`}</td>
            <td>${esc(nombreCategoria(pl.categoria_id))}</td>
            <td class="num">${pesos(pl.precio)}</td>
            <td class="num">${tieneReceta ? pesos(costo) : `<small class="suave">Sin receta</small>`}</td>
            <td class="num ${margen < 30 && tieneReceta ? "negativo" : ""}">${tieneReceta ? `${margen}%` : ""}</td>
            <td class="acciones">
              <button class="chico" data-receta="${pl.id}">Receta</button>
              <button class="chico" data-plato="${pl.id}">Editar</button>
              <button class="chico peligro" data-borrar-plato="${pl.id}">Borrar</button>
            </td></tr>`;
        }), "Agrega tu primer plato."),

    categorias: () => `<div class="lista">${categorias.map((c) => `<div class="fila-lista">
        <input value="${esc(c.nombre)}" data-renombrar-categoria="${c.id}" aria-label="Nombre">
        <button class="chico peligro" data-borrar-categoria="${c.id}">Borrar</button></div>`).join("")}</div>
      <div class="fila-lista"><input id="nueva-categoria" placeholder="Nueva categoría, ej. Bebidas"><button class="principal" id="agregar-categoria">Agregar</button></div>`,

    modificadores: () => `<p class="suave">Ej.: «Término de la carne» (obligatorio, elegir 1) o «Adiciones» (opcional, hasta 3).
        Una opción puede sumar precio y gastar un insumo, como «Queso extra: +$3.000, 40 g de queso».</p>
      ${grupos.length ? grupos.map((g) => `<div class="panel">
        <div class="encabezado"><h2>${esc(g.nombre)} <small class="suave">${g.obligatorio ? "Obligatorio" : "Opcional"} · ${g.maximo === 1 ? "elegir 1" : `hasta ${g.maximo}`}</small></h2>
          <span><button class="chico" data-opcion-nueva="${g.id}">Agregar opción</button>
          <button class="chico" data-grupo="${g.id}">Editar</button>
          <button class="chico peligro" data-borrar-grupo="${g.id}">Borrar</button></span></div>
        ${tabla(["Opción", "#Precio extra", "Gasta", ""], ops.filter((o) => o.grupo_id === g.id).map((o) => {
          const insumo = insumos.find((i) => i.id === o.insumo_id);
          return `<tr><td>${esc(o.nombre)}</td><td class="num">${o.precio ? pesos(o.precio) : "—"}</td>
            <td>${insumo ? `${numero(o.cantidad)} ${esc(insumo.unidad)} de ${esc(insumo.nombre)}` : "—"}</td>
            <td class="acciones"><button class="chico" data-opcion="${o.id}">Editar</button>
              <button class="chico peligro" data-borrar-opcion="${o.id}">Borrar</button></td></tr>`;
        }), "Sin opciones todavía.")}
      </div>`).join("") : `<p class="vacio">No hay modificadores.</p>`}`,
  };

  const botonNuevo = { platos: "Nuevo plato", modificadores: "Nuevo grupo" }[pestana];
  $vista.innerHTML = `
    <div class="encabezado"><h1>Menú y recetas</h1>
      <div class="botones-domicilio" style="margin:0">
        <button id="descargar-menu">Descargar menú en Excel</button>
        <button id="subir-menu">Subir menú desde Excel</button>
        ${botonNuevo ? `<button class="principal" id="nuevo">${botonNuevo}</button>` : ""}</div></div>
    <div class="pestanas">
      ${[["platos", "Platos"], ["categorias", "Categorías"], ["modificadores", "Modificadores"]]
        .map(([id, n]) => `<button data-pestana="${id}" class="${id === pestana ? "activo" : ""}">${n}</button>`).join("")}
    </div>
    <div class="panel">${vistas[pestana]()}</div>`;

  $vista.querySelector("#descargar-menu").addEventListener("click", async (evento) => {
    const $b = evento.currentTarget;
    $b.disabled = true;
    try {
      await descargarMenu(ctx.menu, ctx.negocio);
    } catch {
      aviso("No se pudo crear el Excel. Revisa tu conexión.");
    } finally {
      $b.disabled = false;
    }
  });
  $vista.querySelector("#subir-menu").addEventListener("click", () => subirMenu(ctx, recargar));

  const $ = (sel) => $vista.querySelectorAll(sel);
  const accion = (sel, fn) => $(sel).forEach(($el) => $el.addEventListener("click", () => fn($el)));
  const borrarCon = (tabla, mensaje) => async (id) => {
    if (!confirm(mensaje)) return;
    if ((await autorizar(ctx, mensaje)) === null) return;
    try {
      await api.borrar(tabla, id);
      await recargar();
    } catch (e) { aviso(e.message); }
  };

  accion("[data-pestana]", ($b) => { pestana = $b.dataset.pestana; ctx.refrescar(); });
  document.getElementById("nuevo")?.addEventListener("click", () =>
    pestana === "platos" ? formularioPlato({}, ctx, recargar) : formularioGrupo({}, recargar)
  );
  accion("[data-plato]", ($b) => formularioPlato(platos.find((pl) => pl.id === $b.dataset.plato), ctx, recargar));
  accion("[data-receta]", ($b) => formularioReceta(platos.find((pl) => pl.id === $b.dataset.receta), recetas, insumos, recargar));
  accion("[data-borrar-plato]", ($b) => borrarCon("platos", "¿Borrar este plato? Las ventas pasadas no cambian. Si solo quieres que no salga en la carta, edítalo y ocúltalo.")($b.dataset.borrarPlato));
  accion("[data-grupo]", ($b) => formularioGrupo(grupos.find((g) => g.id === $b.dataset.grupo), recargar));
  accion("[data-borrar-grupo]", ($b) => borrarCon("grupos_mod", "¿Borrar este grupo y sus opciones?")($b.dataset.borrarGrupo));
  accion("[data-opcion-nueva]", ($b) => formularioOpcion({ grupo_id: $b.dataset.opcionNueva }, insumos, recargar));
  accion("[data-opcion]", ($b) => formularioOpcion(ops.find((o) => o.id === $b.dataset.opcion), insumos, recargar));
  accion("[data-borrar-opcion]", ($b) => borrarCon("opciones_mod", "¿Borrar esta opción?")($b.dataset.borrarOpcion));
  accion("[data-borrar-categoria]", ($b) => borrarCon("categorias", "¿Borrar esta categoría? Sus platos quedan sin categoría.")($b.dataset.borrarCategoria));
  $("[data-renombrar-categoria]").forEach(($i) =>
    $i.addEventListener("change", () =>
      api.guardar("categorias", { id: $i.dataset.renombrarCategoria, nombre: $i.value.trim() || "Categoría" }).then(recargar, (e) => aviso(e.message))
    )
  );
  document.getElementById("agregar-categoria")?.addEventListener("click", async () => {
    const nombre = document.getElementById("nueva-categoria").value.trim();
    if (!nombre) return;
    try {
      await api.guardar("categorias", { nombre, orden: categorias.length + 1 });
      await recargar();
    } catch (e) { aviso(e.message); }
  });
}

function formularioPlato(pl, ctx, recargar) {
  const { categorias, grupos, platoGrupos } = ctx.menu;
  const suyos = new Set(platoGrupos.filter((pg) => pg.plato_id === pl.id).map((pg) => pg.grupo_id));
  formulario(pl.id ? "Editar plato" : "Nuevo plato", `
    <label>Nombre<input name="nombre" value="${esc(pl.nombre)}"></label>
    <div class="fila">
      <label>Categoría<select name="categoria_id"><option value="">Sin categoría</option>${opciones(categorias.map((c) => [c.id, c.nombre]), pl.categoria_id ?? "")}</select></label>
      <label>Precio<input name="precio" type="number" min="0" step="100" value="${pl.precio ?? 0}"></label>
    </div>
    <label>Descripción (opcional)<input name="descripcion" value="${esc(pl.descripcion)}"></label>
    ${grupos.length ? `<fieldset><legend>Modificadores de este plato</legend>${grupos.map((g) => `<label class="opcion">
      <input type="checkbox" name="grupo" value="${g.id}"${suyos.has(g.id) ? " checked" : ""}> ${esc(g.nombre)}</label>`).join("")}</fieldset>` : ""}
    <label class="opcion"><input type="checkbox" name="activo"${pl.activo === false ? "" : " checked"}> Disponible en la carta</label>`,
    async (c, $form) => {
      const nombre = c.nombre.trim();
      const precio = Number(c.precio);
      if (!nombre) throw new Error("Escribe el nombre del plato");
      if (!Number.isInteger(precio) || precio < 0) throw new Error("El precio debe ser un número entero");
      const fila = { nombre, precio, categoria_id: c.categoria_id || null, descripcion: c.descripcion.trim(), activo: Boolean(c.activo) };
      let id = pl.id;
      if (id) await api.guardar("platos", { id, ...fila });
      else id = (await api.guardarDevolviendo("platos", fila)).id;
      await api.reemplazarGruposDePlato(id, [...$form.querySelectorAll('[name="grupo"]:checked')].map(($i) => $i.value));
    },
    { alTerminar: recargar });
}

function formularioReceta(pl, recetas, insumos, recargar) {
  if (!insumos.length) {
    aviso("Primero crea tus insumos en «Inventario».");
    return;
  }
  const filaReceta = (r = {}) => `<div class="linea">
    <select data-insumo><option value="">Insumo…</option>${opciones(insumos.map((i) => [i.id, `${i.nombre} (${i.unidad})`]), r.insumo_id ?? "")}</select>
    <input data-cantidad type="number" min="0" step="any" value="${r.cantidad ?? ""}" placeholder="Cantidad" aria-label="Cantidad">
    <button type="button" class="chico" data-quitar-fila aria-label="Quitar">✕</button>
  </div>`;
  const actuales = recetas.filter((r) => r.plato_id === pl.id);
  const $form = formulario(`Receta: ${esc(pl.nombre)}`, `
    <p class="suave" style="margin:0">Lo que gasta <strong>una porción</strong>. Se descuenta del inventario al cobrar.</p>
    <div id="filas-receta">${(actuales.length ? actuales : [{}]).map(filaReceta).join("")}</div>
    <button type="button" id="agregar-fila">Agregar insumo</button>
    <div class="total"><span>Costo por porción</span><span id="costo-receta"></span></div>
    <p class="suave" id="margen-receta" style="margin:0"></p>`,
    async (_, $f) => {
      const filas = [...$f.querySelectorAll(".linea")]
        .map(($l) => ({ insumo_id: $l.querySelector("[data-insumo]").value, cantidad: Number($l.querySelector("[data-cantidad]").value) }))
        .filter((f) => f.insumo_id);
      if (filas.some((f) => !(f.cantidad > 0))) throw new Error("Cada insumo necesita una cantidad mayor que 0");
      if (new Set(filas.map((f) => f.insumo_id)).size !== filas.length) throw new Error("Hay un insumo repetido");
      await api.reemplazarReceta(pl.id, filas);
    },
    { boton: "Guardar receta", alTerminar: recargar });
  const calcular = () => {
    const costo = [...$form.querySelectorAll(".linea")].reduce((s, $l) => {
      const insumo = insumos.find((i) => i.id === $l.querySelector("[data-insumo]").value);
      return s + (insumo ? Number(insumo.costo) * (Number($l.querySelector("[data-cantidad]").value) || 0) : 0);
    }, 0);
    $form.querySelector("#costo-receta").textContent = pesos(costo);
    $form.querySelector("#margen-receta").textContent = pl.precio
      ? `Precio ${pesos(pl.precio)} · ganancia ${pesos(pl.precio - costo)} (${Math.round(((pl.precio - costo) / pl.precio) * 100)}%)`
      : "";
  };
  $form.addEventListener("input", calcular);
  $form.addEventListener("change", calcular);
  $form.addEventListener("click", (e) => {
    if (e.target.id === "agregar-fila") $form.querySelector("#filas-receta").insertAdjacentHTML("beforeend", filaReceta());
    if (e.target.matches("[data-quitar-fila]")) {
      e.target.closest(".linea").remove();
      calcular();
    }
  });
  calcular();
}

function formularioGrupo(g, recargar) {
  formulario(g.id ? "Editar grupo" : "Nuevo grupo de modificadores", `
    <label>Nombre<input name="nombre" value="${esc(g.nombre)}" placeholder="Ej. Término de la carne"></label>
    <div class="fila">
      <label>¿Cuántas puede elegir?<input name="maximo" type="number" min="1" step="1" value="${g.maximo ?? 1}"></label>
      <label class="opcion"><input type="checkbox" name="obligatorio"${g.obligatorio ? " checked" : ""}> Es obligatorio elegir</label>
    </div>`,
    async (c) => {
      if (!c.nombre.trim()) throw new Error("Escribe el nombre del grupo");
      const maximo = Number(c.maximo);
      if (!Number.isInteger(maximo) || maximo < 1) throw new Error("El máximo debe ser 1 o más");
      await api.guardar("grupos_mod", { id: g.id, nombre: c.nombre.trim(), maximo, obligatorio: Boolean(c.obligatorio) });
    },
    { alTerminar: recargar });
}

function formularioOpcion(o, insumos, recargar) {
  formulario(o.id ? "Editar opción" : "Nueva opción", `
    <div class="fila">
      <label>Nombre<input name="nombre" value="${esc(o.nombre)}" placeholder="Ej. Queso extra"></label>
      <label>Precio extra<input name="precio" type="number" min="0" step="100" value="${o.precio ?? 0}"></label>
    </div>
    <div class="fila">
      <label>Gasta insumo (opcional)<select name="insumo_id"><option value="">Ninguno</option>${opciones(insumos.map((i) => [i.id, `${i.nombre} (${i.unidad})`]), o.insumo_id ?? "")}</select></label>
      <label>Cantidad<input name="cantidad" type="number" min="0" step="any" value="${o.cantidad ?? ""}"></label>
    </div>`,
    async (c) => {
      if (!c.nombre.trim()) throw new Error("Escribe el nombre de la opción");
      const precio = Number(c.precio);
      if (!Number.isInteger(precio) || precio < 0) throw new Error("El precio debe ser un número entero");
      const cantidad = c.insumo_id ? Number(c.cantidad) : null;
      if (c.insumo_id && !(cantidad > 0)) throw new Error("Escribe cuánto gasta del insumo");
      await api.guardar("opciones_mod", { id: o.id, grupo_id: o.grupo_id, nombre: c.nombre.trim(), precio, insumo_id: c.insumo_id || null, cantidad });
    },
    { alTerminar: recargar });
}

export { costoReceta };
