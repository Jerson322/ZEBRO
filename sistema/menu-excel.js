// Menú en Excel: descargar el menú (o la plantilla) y subirlo desde un archivo.
// Hoja «Menú»: un producto por fila, con los grupos de modificadores que usa.
// Hoja «Modificadores»: los grupos (Sabores, Borde, Adiciones…) y sus opciones con precio extra.
// Al subir: crea lo nuevo y actualiza lo que ya existe (por nombre). Nunca borra productos ni
// opciones. Antes de guardar muestra un resumen para confirmar.
import * as api from "./api.js";
import { esc, pesos, mostrar, cerrarDialogo, aviso } from "./util.js";
import { cargarExcelJS } from "./excel.js";

const COLUMNAS_MENU = [
  { clave: "categoria", titulo: "Categoría", ancho: 20 },
  { clave: "producto", titulo: "Producto", ancho: 32 },
  { clave: "descripcion", titulo: "Descripción", ancho: 50 },
  { clave: "precio", titulo: "Precio", ancho: 12 },
  { clave: "disponible", titulo: "Disponible", ancho: 11 },
  { clave: "modificadores", titulo: "Modificadores", ancho: 60 },
];
const COLUMNAS_MOD = [
  { clave: "grupo", titulo: "Grupo", ancho: 26 },
  { clave: "obligatorio", titulo: "Obligatorio", ancho: 12 },
  { clave: "maximo", titulo: "Máximo a elegir", ancho: 15 },
  { clave: "opcion", titulo: "Opción", ancho: 28 },
  { clave: "precio", titulo: "Precio extra", ancho: 13 },
];
// Para reconocer las columnas aunque cambien mayúsculas o tildes.
const normal = (t) => String(t ?? "").normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/\s+/g, " ").trim().toLowerCase();
const ALIAS_MENU = {
  categoria: ["categoria", "categorias", "grupo de la carta"],
  producto: ["producto", "plato", "nombre", "productos"],
  descripcion: ["descripcion", "detalle"],
  precio: ["precio", "valor", "precio de venta"],
  disponible: ["disponible", "activo", "visible"],
  modificadores: ["modificadores", "opciones", "grupos"],
};
const ALIAS_MOD = {
  grupo: ["grupo", "modificador"],
  obligatorio: ["obligatorio"],
  maximo: ["maximo a elegir", "maximo", "max"],
  opcion: ["opcion", "opciones"],
  precio: ["precio extra", "precio", "valor"],
};
const SI = (t) => ["si", "s", "1", "true", "verdadero", "x"].includes(normal(t));
const NO = (t) => ["no", "n", "0", "false", "falso", "oculto"].includes(normal(t));
// "Sabores (hasta 2); Borde, Extra queso" → lista de nombres.
const listaGrupos = (t) => String(t ?? "").split(/[;\n]|,(?![^(]*\))/).map((x) => x.trim()).filter(Boolean);

const descargar = async (libro, nombre) => {
  const datos = await libro.xlsx.writeBuffer();
  const url = URL.createObjectURL(new Blob([datos], { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" }));
  const $a = Object.assign(document.createElement("a"), { href: url, download: nombre });
  document.body.append($a);
  $a.click();
  $a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10000);
};

function hojaConFormato(libro, nombre, columnas, filas, columnaDinero, columnaSiNo) {
  const ws = libro.addWorksheet(nombre, { views: [{ state: "frozen", ySplit: 1 }] });
  ws.columns = columnas.map((c) => ({ header: c.titulo, key: c.clave, width: c.ancho }));
  filas.forEach((f) => ws.addRow(f));
  ws.getRow(1).height = 22;
  ws.getRow(1).eachCell((c) => {
    c.font = { bold: true, color: { argb: "FFFFFFFF" } };
    c.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FF14161F" } };
    c.alignment = { vertical: "middle" };
  });
  for (let r = 2; r <= Math.max(filas.length + 1, 300); r++) {
    ws.getCell(r, columnaDinero).numFmt = '"$"#,##0';
    for (const c of columnaSiNo) ws.getCell(r, c).dataValidation = { type: "list", allowBlank: true, formulae: ['"Sí,No"'] };
  }
  ws.autoFilter = { from: { row: 1, column: 1 }, to: { row: 1, column: columnas.length } };
  return ws;
}

// Descarga el menú actual en Excel (con sus modificadores), listo para editar y volver a subir.
export async function descargarMenu(menu, negocio) {
  const ExcelJS = await cargarExcelJS();
  const libro = new ExcelJS.Workbook();
  const categoria = (id) => menu.categorias.find((c) => c.id === id)?.nombre ?? "";
  const gruposDe = (platoId) => menu.platoGrupos.filter((pg) => pg.plato_id === platoId)
    .map((pg) => menu.grupos.find((g) => g.id === pg.grupo_id)?.nombre).filter(Boolean);
  const platos = [...menu.platos].sort((a, b) => categoria(a.categoria_id).localeCompare(categoria(b.categoria_id)) || a.nombre.localeCompare(b.nombre));
  const filasMenu = platos.length ? platos.map((p) => ({
    categoria: categoria(p.categoria_id), producto: p.nombre, descripcion: p.descripcion ?? "", precio: p.precio,
    disponible: p.activo ? "Sí" : "No", modificadores: gruposDe(p.id).join("; "),
  })) : [
    // Menú vacío: ejemplos para que se entienda cómo llenarlo.
    { categoria: "Pizzas", producto: "Pizza Gourmet", descripcion: "30 cm · 6 porciones", precio: 25000, disponible: "Sí", modificadores: "Sabores (hasta 2); Borde" },
    { categoria: "Bebidas", producto: "Gaseosa personal", descripcion: "", precio: 3800, disponible: "Sí", modificadores: "Gaseosa" },
    { categoria: "Bebidas", producto: "Agua", descripcion: "", precio: 2500, disponible: "Sí", modificadores: "" },
  ];
  hojaConFormato(libro, "Menú", COLUMNAS_MENU, filasMenu, 4, [5]);

  const filasMod = menu.grupos.length ? menu.grupos.flatMap((g) => {
    const ops = menu.opciones.filter((o) => o.grupo_id === g.id);
    return (ops.length ? ops : [{ nombre: "", precio: 0 }]).map((o) => ({
      grupo: g.nombre, obligatorio: g.obligatorio ? "Sí" : "No", maximo: g.maximo, opcion: o.nombre, precio: o.precio,
    }));
  }) : [
    { grupo: "Sabores (hasta 2)", obligatorio: "Sí", maximo: 2, opcion: "Pepperoni", precio: 0 },
    { grupo: "Sabores (hasta 2)", obligatorio: "Sí", maximo: 2, opcion: "Hawaiana", precio: 0 },
    { grupo: "Borde", obligatorio: "No", maximo: 1, opcion: "Queso", precio: 3500 },
    { grupo: "Gaseosa", obligatorio: "Sí", maximo: 1, opcion: "Coca-Cola", precio: 0 },
  ];
  hojaConFormato(libro, "Modificadores", COLUMNAS_MOD, filasMod, 5, [2]);

  const ayuda = libro.addWorksheet("Instrucciones");
  ayuda.getColumn(1).width = 110;
  [
    ["Cómo llenar el menú", true],
    ["HOJA «MENÚ» — un producto por fila. No cambies los títulos de la primera fila.", true],
    ["• Categoría: el grupo de la carta (Pizzas, Bebidas…). Si no existe, se crea."],
    ["• Producto: el nombre. Si ya existe un producto con ese nombre, se actualiza; si no, se crea. No repitas nombres."],
    ["• Precio: solo el número (ej. 25000)."],
    ["• Disponible: «Sí» para venderlo, «No» para ocultarlo. Vacío = Sí."],
    ["• Modificadores: los grupos de la hoja «Modificadores» que se preguntan al vender este producto, separados por punto y coma (;)."],
    ["   Si la dejas vacía, el producto conserva los modificadores que ya tenga en el sistema."],
    ["HOJA «MODIFICADORES» — una opción por fila.", true],
    ["• Grupo: el nombre del grupo (ej. «Sabores (hasta 2)», «Borde»). Repítelo en cada opción del grupo."],
    ["• Obligatorio: «Sí» si hay que elegir al menos una opción. Máximo a elegir: cuántas opciones se pueden marcar (1 = solo una)."],
    ["• Opción y Precio extra: lo que se elige y cuánto suma al precio (0 si no suma)."],
    ["Subir el Excel nunca borra productos ni opciones: lo que no esté en el archivo queda igual."],
    ["Las recetas (insumos que gasta cada producto) se siguen manejando en el sistema."],
  ].forEach(([t, negrita], i) => Object.assign(ayuda.getCell(i + 1, 1), { value: t, font: negrita ? { bold: true, size: 13 } : {} }));

  const nombre = (negocio?.nombre || "Restaurante").replace(/[\\/:*?"<>|]/g, "").trim();
  await descargar(libro, `${nombre} - Menú.xlsx`);
}

// Texto de una celda de ExcelJS (puede venir como número, fórmula, texto enriquecido o enlace).
function texto(v) {
  if (v == null) return "";
  if (typeof v === "object") {
    if ("result" in v) return texto(v.result);
    if (v.richText) return v.richText.map((r) => r.text).join("");
    if ("text" in v) return texto(v.text);
    if (v instanceof Date) return v.toLocaleDateString("es-CO");
  }
  return String(v).trim();
}

// "25.000", "$ 25,000" o 25000 → 25000. Vacío → null.
export function precio(v) {
  if (typeof v === "object" && v && "result" in v) v = v.result;
  if (typeof v === "number") return Math.round(v);
  const solo = texto(v).replace(/[^\d]/g, "");
  return solo ? Number(solo) : null;
}

// Lee una hoja buscando la fila de títulos en las primeras 10 filas.
function leerHoja(ws, alias, requerida) {
  let filaTitulos = 0;
  let columnas = {};
  for (let r = 1; r <= Math.min(10, ws.rowCount) && !filaTitulos; r++) {
    const encontradas = {};
    ws.getRow(r).eachCell((celda, c) => {
      const t = normal(texto(celda.value));
      for (const [clave, nombres] of Object.entries(alias)) if (nombres.includes(t) && !encontradas[clave]) encontradas[clave] = c;
    });
    if (encontradas[requerida]) {
      filaTitulos = r;
      columnas = encontradas;
    }
  }
  if (!filaTitulos) return null;
  const filas = [];
  for (let r = filaTitulos + 1; r <= ws.rowCount; r++) {
    const fila = ws.getRow(r);
    const datos = { fila: r, columnas };
    for (const [clave, c] of Object.entries(columnas)) datos[clave] = fila.getCell(c).value;
    filas.push(datos);
  }
  return { filas, columnas };
}

async function leerArchivo(archivo) {
  const ExcelJS = await cargarExcelJS();
  const libro = new ExcelJS.Workbook();
  await libro.xlsx.load(await archivo.arrayBuffer());
  const hojaMenu = libro.worksheets.find((h) => normal(h.name) === "menu") ?? libro.worksheets[0];
  const hojaMod = libro.worksheets.find((h) => normal(h.name) === "modificadores");
  const menu = hojaMenu && leerHoja(hojaMenu, ALIAS_MENU, "producto");
  if (!menu) throw new Error("No encontré la columna «Producto». Usa la plantilla de «Descargar menú en Excel».");

  const productos = menu.filas.map((d) => ({
    fila: d.fila,
    producto: texto(d.producto),
    categoria: texto(d.categoria),
    descripcion: "descripcion" in d.columnas ? texto(d.descripcion) : null,
    precio: "precio" in d.columnas ? precio(d.precio) : null,
    activo: texto(d.disponible) ? !NO(texto(d.disponible)) : true,
    tieneDisponible: "disponible" in d.columnas,
    // null = no tocar los modificadores del producto.
    grupos: "modificadores" in d.columnas && texto(d.modificadores) ? listaGrupos(texto(d.modificadores)) : null,
  })).filter((f) => f.producto || f.categoria);

  // Modificadores: si una fila deja el grupo vacío, sigue siendo del grupo de arriba.
  const opciones = [];
  const mod = hojaMod && leerHoja(hojaMod, ALIAS_MOD, "grupo");
  if (mod) {
    let anterior = null;
    for (const d of mod.filas) {
      const grupo = texto(d.grupo) || anterior?.grupo;
      const opcion = texto(d.opcion);
      if (!grupo || (!texto(d.grupo) && !opcion)) continue;
      const actual = {
        fila: d.fila, grupo,
        obligatorio: texto(d.obligatorio) ? SI(texto(d.obligatorio)) : anterior?.grupo === grupo ? anterior.obligatorio : false,
        maximo: precio(d.maximo) ?? (anterior?.grupo === grupo ? anterior.maximo : 1),
        opcion, precio: precio(d.precio) ?? 0,
      };
      opciones.push(actual);
      anterior = actual;
    }
  }
  return { productos, opciones };
}

// Compara el archivo con el menú actual y arma el plan: qué se crea, qué cambia y qué está mal.
export function planear({ productos: filas, opciones: filasMod = [] }, menu) {
  const categorias = new Map(menu.categorias.map((c) => [normal(c.nombre), c]));
  const platos = new Map(menu.platos.map((p) => [normal(p.nombre), p]));
  const gruposActuales = new Map(menu.grupos.map((g) => [normal(g.nombre), g]));
  const errores = [];

  // Grupos y opciones de la hoja «Modificadores».
  const grupos = new Map(); // clave → { nombre, obligatorio, maximo, existente, opciones: Map }
  for (const f of filasMod) {
    const clave = normal(f.grupo);
    if (f.maximo < 1) { errores.push(`Modificadores, fila ${f.fila}: «Máximo a elegir» debe ser 1 o más`); continue; }
    if (!grupos.has(clave)) {
      grupos.set(clave, { nombre: f.grupo, obligatorio: f.obligatorio, maximo: f.maximo, existente: gruposActuales.get(clave), opciones: new Map() });
    }
    const g = grupos.get(clave);
    if (!f.opcion) continue;
    const claveOpcion = normal(f.opcion);
    if (g.opciones.has(claveOpcion)) { errores.push(`Modificadores, fila ${f.fila}: «${f.opcion}» está repetida en «${f.grupo}»`); continue; }
    g.opciones.set(claveOpcion, { nombre: f.opcion, precio: f.precio });
  }
  const gruposNuevos = [];
  const gruposCambian = [];
  const opcionesNuevas = [];
  const opcionesCambian = [];
  for (const g of grupos.values()) {
    if (!g.existente) gruposNuevos.push(g);
    else if (g.existente.obligatorio !== g.obligatorio || g.existente.maximo !== g.maximo) gruposCambian.push(g);
    const actuales = g.existente ? menu.opciones.filter((o) => o.grupo_id === g.existente.id) : [];
    for (const o of g.opciones.values()) {
      const igual = actuales.find((a) => normal(a.nombre) === normal(o.nombre));
      if (!igual) opcionesNuevas.push({ grupo: g, ...o });
      else if (igual.precio !== o.precio) opcionesCambian.push({ id: igual.id, grupo: g, ...o, antes: igual.precio });
    }
  }
  const existeGrupo = (nombre) => grupos.has(normal(nombre)) || gruposActuales.has(normal(nombre));

  // Productos de la hoja «Menú».
  const nuevasCategorias = new Map();
  const nuevos = [];
  const cambios = [];
  const vistos = new Set();
  let iguales = 0;
  for (const f of filas) {
    if (!f.producto) { errores.push(`Menú, fila ${f.fila}: falta el nombre del producto`); continue; }
    const clave = normal(f.producto);
    if (vistos.has(clave)) { errores.push(`Menú, fila ${f.fila}: «${f.producto}» está repetido en el archivo`); continue; }
    vistos.add(clave);
    if (f.precio != null && (f.precio < 0 || f.precio > 100000000)) { errores.push(`Menú, fila ${f.fila}: precio no válido`); continue; }
    const faltan = (f.grupos ?? []).filter((n) => !existeGrupo(n));
    if (faltan.length) { errores.push(`Menú, fila ${f.fila}: el modificador «${faltan.join("», «")}» no existe en la hoja «Modificadores»`); continue; }
    if (f.categoria && !categorias.has(normal(f.categoria))) nuevasCategorias.set(normal(f.categoria), f.categoria);
    const existente = platos.get(clave);
    if (!existente) {
      if (f.precio == null) { errores.push(`Menú, fila ${f.fila}: «${f.producto}» es nuevo y no tiene precio`); continue; }
      nuevos.push(f);
      continue;
    }
    const categoriaActual = menu.categorias.find((c) => c.id === existente.categoria_id)?.nombre ?? "";
    const gruposActualesPlato = menu.platoGrupos.filter((pg) => pg.plato_id === existente.id)
      .map((pg) => normal(menu.grupos.find((g) => g.id === pg.grupo_id)?.nombre)).sort().join("|");
    const diferencias = [];
    if (f.precio != null && f.precio !== existente.precio) diferencias.push(`precio ${pesos(existente.precio)} → ${pesos(f.precio)}`);
    if (f.categoria && normal(f.categoria) !== normal(categoriaActual)) diferencias.push(`categoría «${categoriaActual || "sin categoría"}» → «${f.categoria}»`);
    if (f.descripcion != null && f.descripcion !== (existente.descripcion ?? "")) diferencias.push("descripción");
    if (f.tieneDisponible && f.activo !== existente.activo) diferencias.push(f.activo ? "se vuelve a mostrar" : "se oculta");
    if (f.grupos && f.grupos.map(normal).sort().join("|") !== gruposActualesPlato) diferencias.push("modificadores");
    if (diferencias.length) cambios.push({ f, existente, diferencias });
    else iguales += 1;
  }
  return {
    nuevasCategorias: [...nuevasCategorias.values()], nuevos, cambios, errores, iguales,
    gruposNuevos, gruposCambian, opcionesNuevas, opcionesCambian,
  };
}

async function aplicar(plan, menu) {
  // 1. Categorías nuevas.
  const idCategoria = new Map(menu.categorias.map((c) => [normal(c.nombre), c.id]));
  let orden = menu.categorias.length;
  for (const nombre of plan.nuevasCategorias) {
    const creada = await api.guardarDevolviendo("categorias", { nombre, orden: ++orden });
    idCategoria.set(normal(nombre), creada.id);
  }
  const categoriaDe = (f, actual = null) => (f.categoria ? idCategoria.get(normal(f.categoria)) : actual);

  // 2. Grupos de modificadores y sus opciones.
  const idGrupo = new Map(menu.grupos.map((g) => [normal(g.nombre), g.id]));
  for (const g of plan.gruposNuevos) {
    const creado = await api.guardarDevolviendo("grupos_mod", { nombre: g.nombre, obligatorio: g.obligatorio, maximo: g.maximo });
    idGrupo.set(normal(g.nombre), creado.id);
  }
  for (const g of plan.gruposCambian) {
    await api.guardar("grupos_mod", { id: g.existente.id, obligatorio: g.obligatorio, maximo: g.maximo });
  }
  if (plan.opcionesNuevas.length) {
    await api.guardar("opciones_mod", plan.opcionesNuevas.map((o) => ({ grupo_id: idGrupo.get(normal(o.grupo.nombre)), nombre: o.nombre, precio: o.precio })));
  }
  for (const o of plan.opcionesCambian) await api.guardar("opciones_mod", { id: o.id, precio: o.precio });

  // 3. Productos nuevos (todos de una vez) y los que cambian.
  const asignar = async (platoId, nombres) => {
    if (nombres) await api.reemplazarGruposDePlato(platoId, nombres.map((n) => idGrupo.get(normal(n))).filter(Boolean));
  };
  if (plan.nuevos.length) {
    const creados = await api.guardarVarios("platos", plan.nuevos.map((f) => ({
      nombre: f.producto, categoria_id: categoriaDe(f), descripcion: f.descripcion ?? "", precio: f.precio, activo: f.activo,
    })));
    for (const f of plan.nuevos) {
      const creado = creados.find((p) => normal(p.nombre) === normal(f.producto));
      if (creado) await asignar(creado.id, f.grupos);
    }
  }
  for (const { f, existente } of plan.cambios) {
    await api.guardar("platos", {
      id: existente.id,
      categoria_id: categoriaDe(f, existente.categoria_id),
      descripcion: f.descripcion ?? existente.descripcion,
      precio: f.precio ?? existente.precio,
      activo: f.tieneDisponible ? f.activo : existente.activo,
    });
    await asignar(existente.id, f.grupos);
  }
}

// Pide el archivo, muestra el resumen y, si se confirma, guarda.
export function subirMenu(ctx, alTerminar) {
  const $archivo = Object.assign(document.createElement("input"), { type: "file", accept: ".xlsx" });
  $archivo.addEventListener("change", async () => {
    const archivo = $archivo.files[0];
    if (!archivo) return;
    let plan;
    try {
      aviso("Leyendo el archivo…");
      plan = planear(await leerArchivo(archivo), ctx.menu);
    } catch (error) {
      aviso(/zip|central directory|signature/i.test(error.message)
        ? "Ese archivo no es un Excel (.xlsx). Guárdalo como «Libro de Excel» y vuelve a intentar."
        : error.message);
      return;
    }
    const hayAlgo = plan.nuevos.length || plan.cambios.length || plan.gruposNuevos.length || plan.gruposCambian.length
      || plan.opcionesNuevas.length || plan.opcionesCambian.length || plan.nuevasCategorias.length;
    const lista = (titulo, items) => items.length
      ? `<details${items.length <= 8 ? " open" : ""}><summary><strong>${titulo} (${items.length})</strong></summary>
          <ul style="margin:6px 0;padding-left:20px">${items.map((t) => `<li>${t}</li>`).join("")}</ul></details>` : "";
    const $c = mostrar(`
      <h2>Subir menú desde Excel</h2>
      <p class="suave" style="margin:0">${esc(archivo.name)} · Revisa antes de guardar. No se borra nada.</p>
      ${lista("Categorías nuevas", plan.nuevasCategorias.map(esc))}
      ${lista("Productos nuevos", plan.nuevos.map((f) => `${esc(f.producto)} · ${pesos(f.precio)}${f.categoria ? ` <small class="suave">(${esc(f.categoria)})</small>` : ""}${f.grupos?.length ? ` <small class="suave">· ${esc(f.grupos.join(", "))}</small>` : ""}${f.activo ? "" : " <small class=\"suave\">oculto</small>"}`))}
      ${lista("Productos que cambian", plan.cambios.map(({ f, diferencias }) => `${esc(f.producto)}: ${esc(diferencias.join(", "))}`))}
      ${lista("Grupos de modificadores nuevos", plan.gruposNuevos.map((g) => `${esc(g.nombre)} <small class="suave">· ${g.obligatorio ? "obligatorio" : "opcional"} · ${g.maximo === 1 ? "elegir 1" : `hasta ${g.maximo}`} · ${g.opciones.size} opciones</small>`))}
      ${lista("Grupos que cambian", plan.gruposCambian.map((g) => `${esc(g.nombre)}: ${g.obligatorio ? "obligatorio" : "opcional"}, ${g.maximo === 1 ? "elegir 1" : `hasta ${g.maximo}`}`))}
      ${lista("Opciones nuevas en grupos que ya existían", plan.opcionesNuevas.filter((o) => o.grupo.existente).map((o) => `${esc(o.grupo.nombre)} › ${esc(o.nombre)}${o.precio ? ` +${pesos(o.precio)}` : ""}`))}
      ${lista("Opciones que cambian de precio", plan.opcionesCambian.map((o) => `${esc(o.grupo.nombre)} › ${esc(o.nombre)}: ${pesos(o.antes)} → ${pesos(o.precio)}`))}
      ${plan.iguales ? `<p class="suave" style="margin:0">${plan.iguales} producto(s) quedan igual.</p>` : ""}
      ${plan.errores.length ? `<div class="error">${lista("Filas con problemas (no se suben)", plan.errores.map(esc))}</div>` : ""}
      ${hayAlgo ? "" : `<p style="margin:0">No hay nada nuevo para guardar.</p>`}
      <div class="botones">
        <button type="button" id="cancelar-menu">Cancelar</button>
        ${hayAlgo ? `<button type="button" class="principal" id="aplicar-menu">Guardar cambios</button>` : ""}
      </div>`);
    $c.querySelector("#cancelar-menu").addEventListener("click", cerrarDialogo);
    $c.querySelector("#aplicar-menu")?.addEventListener("click", async (evento) => {
      evento.currentTarget.disabled = true;
      evento.currentTarget.textContent = "Guardando…";
      try {
        await aplicar(plan, ctx.menu);
        cerrarDialogo();
        aviso(`Menú actualizado: ${plan.nuevos.length} producto(s) nuevo(s), ${plan.cambios.length} actualizado(s)`);
      } catch (error) {
        cerrarDialogo();
        aviso(`No se pudo guardar todo: ${error.message}. Revisa el menú y vuelve a subir el archivo.`);
      }
      await alTerminar();
    });
  });
  $archivo.click();
}
