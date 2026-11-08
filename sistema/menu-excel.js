// Menú en Excel: descargar el menú (o la plantilla) y subirlo desde un archivo.
// Al subir: crea los productos y categorías nuevos y actualiza los que ya existen (por nombre).
// Nunca borra nada. Antes de guardar muestra un resumen para confirmar.
import * as api from "./api.js";
import { esc, pesos, mostrar, cerrarDialogo, aviso } from "./util.js";
import { cargarExcelJS } from "./excel.js";

const COLUMNAS = [
  { clave: "categoria", titulo: "Categoría", ancho: 20 },
  { clave: "producto", titulo: "Producto", ancho: 30 },
  { clave: "descripcion", titulo: "Descripción", ancho: 45 },
  { clave: "precio", titulo: "Precio", ancho: 14 },
  { clave: "disponible", titulo: "Disponible", ancho: 12 },
];
// Para reconocer las columnas aunque cambien mayúsculas o tildes.
const normal = (t) => String(t ?? "").normalize("NFD").replace(/[̀-ͯ]/g, "").trim().toLowerCase();
const ALIAS = {
  categoria: ["categoria", "categorias", "grupo"],
  producto: ["producto", "plato", "nombre", "productos"],
  descripcion: ["descripcion", "detalle"],
  precio: ["precio", "valor", "precio de venta"],
  disponible: ["disponible", "activo", "visible"],
};

const descargar = async (libro, nombre) => {
  const datos = await libro.xlsx.writeBuffer();
  const url = URL.createObjectURL(new Blob([datos], { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" }));
  const $a = Object.assign(document.createElement("a"), { href: url, download: nombre });
  document.body.append($a);
  $a.click();
  $a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10000);
};

// Descarga el menú actual en Excel, listo para editar y volver a subir.
export async function descargarMenu(menu, negocio) {
  const ExcelJS = await cargarExcelJS();
  const libro = new ExcelJS.Workbook();
  const ws = libro.addWorksheet("Menú", { views: [{ state: "frozen", ySplit: 1 }] });
  ws.columns = COLUMNAS.map((c) => ({ header: c.titulo, key: c.clave, width: c.ancho }));
  const categoria = (id) => menu.categorias.find((c) => c.id === id)?.nombre ?? "";
  const platos = [...menu.platos].sort((a, b) => categoria(a.categoria_id).localeCompare(categoria(b.categoria_id)) || a.nombre.localeCompare(b.nombre));
  const filas = platos.length ? platos.map((p) => ({
    categoria: categoria(p.categoria_id), producto: p.nombre, descripcion: p.descripcion ?? "", precio: p.precio, disponible: p.activo ? "Sí" : "No",
  })) : [
    // Menú vacío: ejemplos para que se entienda cómo llenarlo.
    { categoria: "Hamburguesas", producto: "Hamburguesa sencilla", descripcion: "Carne 150 g, queso, lechuga y tomate", precio: 18000, disponible: "Sí" },
    { categoria: "Hamburguesas", producto: "Gourmet", descripcion: "Doble carne, tocineta y salsa de la casa", precio: 25000, disponible: "Sí" },
    { categoria: "Bebidas", producto: "Gaseosa 400 ml", descripcion: "", precio: 4000, disponible: "Sí" },
  ];
  filas.forEach((f) => ws.addRow(f));
  const encabezado = ws.getRow(1);
  encabezado.height = 22;
  encabezado.eachCell((c) => {
    c.font = { bold: true, color: { argb: "FFFFFFFF" } };
    c.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FF14161F" } };
    c.alignment = { vertical: "middle" };
  });
  const ultima = Math.max(filas.length + 1, 300);
  for (let r = 2; r <= ultima; r++) {
    ws.getCell(r, 4).numFmt = '"$"#,##0';
    ws.getCell(r, 5).dataValidation = { type: "list", allowBlank: true, formulae: ['"Sí,No"'] };
    if (r % 2 === 1 && r <= filas.length + 1) {
      for (let c = 1; c <= COLUMNAS.length; c++) ws.getCell(r, c).fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFF5F6FA" } };
    }
  }
  ws.autoFilter = { from: { row: 1, column: 1 }, to: { row: 1, column: COLUMNAS.length } };

  const ayuda = libro.addWorksheet("Instrucciones");
  ayuda.getColumn(1).width = 100;
  [
    ["Cómo llenar el menú", true],
    ["• Una fila por producto, en la hoja «Menú». No cambies los títulos de la primera fila."],
    ["• Categoría: el grupo del producto (Hamburguesas, Bebidas…). Si no existe, se crea."],
    ["• Producto: el nombre. Si ya existe un producto con ese nombre, se actualiza; si no, se crea."],
    ["• Precio: solo el número, sin puntos ni signo (ej. 25000)."],
    ["• Disponible: «Sí» para venderlo, «No» para ocultarlo. Vacío = Sí."],
    ["• Lo que no esté en el archivo no se toca: subir el Excel nunca borra productos."],
    ["• Las recetas y los modificadores se siguen manejando en el sistema."],
  ].forEach(([t, negrita], i) => Object.assign(ayuda.getCell(i + 1, 1), { value: t, font: negrita ? { bold: true, size: 14 } : {} }));

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
function precio(v) {
  if (typeof v === "object" && v && "result" in v) v = v.result;
  if (typeof v === "number") return Math.round(v);
  const solo = texto(v).replace(/[^\d]/g, "");
  return solo ? Number(solo) : null;
}

async function leerArchivo(archivo) {
  const ExcelJS = await cargarExcelJS();
  const libro = new ExcelJS.Workbook();
  await libro.xlsx.load(await archivo.arrayBuffer());
  const ws = libro.worksheets.find((h) => normal(h.name) === "menu") ?? libro.worksheets[0];
  if (!ws) throw new Error("El archivo no tiene hojas");
  // Busca la fila de títulos en las primeras 10 filas.
  let filaTitulos = 0;
  let columnas = {};
  for (let r = 1; r <= Math.min(10, ws.rowCount) && !filaTitulos; r++) {
    const encontradas = {};
    ws.getRow(r).eachCell((celda, c) => {
      const t = normal(texto(celda.value));
      for (const [clave, alias] of Object.entries(ALIAS)) if (alias.includes(t)) encontradas[clave] = c;
    });
    if (encontradas.producto) {
      filaTitulos = r;
      columnas = encontradas;
    }
  }
  if (!filaTitulos) throw new Error("No encontré la columna «Producto». Usa la plantilla de «Descargar menú en Excel».");
  const filas = [];
  for (let r = filaTitulos + 1; r <= ws.rowCount; r++) {
    const fila = ws.getRow(r);
    const valor = (clave) => (columnas[clave] ? fila.getCell(columnas[clave]).value : null);
    const producto = texto(valor("producto"));
    const categoria = texto(valor("categoria"));
    if (!producto && !categoria) continue;
    const disponible = normal(texto(valor("disponible")));
    filas.push({
      fila: r,
      producto,
      categoria,
      descripcion: columnas.descripcion ? texto(valor("descripcion")) : null,
      precio: columnas.precio ? precio(valor("precio")) : null,
      activo: disponible ? !["no", "n", "0", "false", "falso", "oculto"].includes(disponible) : true,
      tieneDisponible: Boolean(columnas.disponible),
    });
  }
  return filas;
}

// Compara el archivo con el menú actual y arma el plan: qué se crea, qué cambia y qué está mal.
function planear(filas, menu) {
  const categorias = new Map(menu.categorias.map((c) => [normal(c.nombre), c]));
  const platos = new Map(menu.platos.map((p) => [normal(p.nombre), p]));
  const nuevasCategorias = new Map();
  const nuevos = [];
  const cambios = [];
  const errores = [];
  const vistos = new Set();
  let iguales = 0;
  for (const f of filas) {
    if (!f.producto) { errores.push(`Fila ${f.fila}: falta el nombre del producto`); continue; }
    const clave = normal(f.producto);
    if (vistos.has(clave)) { errores.push(`Fila ${f.fila}: «${f.producto}» está repetido en el archivo`); continue; }
    vistos.add(clave);
    if (f.precio != null && (f.precio < 0 || f.precio > 100000000)) { errores.push(`Fila ${f.fila}: precio no válido`); continue; }
    if (f.categoria && !categorias.has(normal(f.categoria))) nuevasCategorias.set(normal(f.categoria), f.categoria);
    const existente = platos.get(clave);
    if (!existente) {
      if (f.precio == null) { errores.push(`Fila ${f.fila}: «${f.producto}» es nuevo y no tiene precio`); continue; }
      nuevos.push(f);
      continue;
    }
    const categoriaActual = menu.categorias.find((c) => c.id === existente.categoria_id)?.nombre ?? "";
    const diferencias = [];
    if (f.precio != null && f.precio !== existente.precio) diferencias.push(`precio ${pesos(existente.precio)} → ${pesos(f.precio)}`);
    if (f.categoria && normal(f.categoria) !== normal(categoriaActual)) diferencias.push(`categoría «${categoriaActual || "sin categoría"}» → «${f.categoria}»`);
    if (f.descripcion != null && f.descripcion !== (existente.descripcion ?? "")) diferencias.push("descripción");
    if (f.tieneDisponible && f.activo !== existente.activo) diferencias.push(f.activo ? "se vuelve a mostrar" : "se oculta");
    if (diferencias.length) cambios.push({ f, existente, diferencias });
    else iguales += 1;
  }
  return { nuevasCategorias: [...nuevasCategorias.values()], nuevos, cambios, errores, iguales };
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
  // 2. Productos nuevos, todos de una vez.
  if (plan.nuevos.length) {
    await api.guardar("platos", plan.nuevos.map((f) => ({
      nombre: f.producto, categoria_id: categoriaDe(f), descripcion: f.descripcion ?? "", precio: f.precio, activo: f.activo,
    })));
  }
  // 3. Productos que cambian.
  for (const { f, existente } of plan.cambios) {
    await api.guardar("platos", {
      id: existente.id,
      categoria_id: categoriaDe(f, existente.categoria_id),
      descripcion: f.descripcion ?? existente.descripcion,
      precio: f.precio ?? existente.precio,
      activo: f.tieneDisponible ? f.activo : existente.activo,
    });
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
    const hayAlgo = plan.nuevos.length || plan.cambios.length;
    const lista = (titulo, items) => items.length
      ? `<details${items.length <= 8 ? " open" : ""}><summary><strong>${titulo} (${items.length})</strong></summary>
          <ul style="margin:6px 0;padding-left:20px">${items.map((t) => `<li>${t}</li>`).join("")}</ul></details>` : "";
    const $c = mostrar(`
      <h2>Subir menú desde Excel</h2>
      <p class="suave" style="margin:0">${esc(archivo.name)} · Revisa antes de guardar. No se borra nada.</p>
      ${lista("Categorías nuevas", plan.nuevasCategorias.map(esc))}
      ${lista("Productos nuevos", plan.nuevos.map((f) => `${esc(f.producto)} · ${pesos(f.precio)}${f.categoria ? ` <small class="suave">(${esc(f.categoria)})</small>` : ""}${f.activo ? "" : " <small class=\"suave\">oculto</small>"}`))}
      ${lista("Productos que cambian", plan.cambios.map(({ f, diferencias }) => `${esc(f.producto)}: ${esc(diferencias.join(", "))}`))}
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
        aviso(`Menú actualizado: ${plan.nuevos.length} nuevo(s), ${plan.cambios.length} actualizado(s)`);
        await alTerminar();
      } catch (error) {
        cerrarDialogo();
        aviso(`No se pudo guardar todo: ${error.message}. Revisa el menú y vuelve a subir el archivo.`);
        await alTerminar();
      }
    });
  });
  $archivo.click();
}
