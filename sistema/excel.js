// Exporta a Excel (.xlsx) las ventas y los gastos de un periodo, organizado y con formato:
// títulos, encabezados de color, filas cebra, filtros, totales con fórmula y formato de pesos.
// La librería (ExcelJS) se descarga solo al exportar, para no hacer más lenta la carga del sistema.
const EXCELJS = "https://cdn.jsdelivr.net/npm/exceljs@4.4.0/dist/exceljs.min.js";

const COLOR = { oscuro: "FF14161F", acento: "FFFF5A1F", acentoSuave: "FFFFF1EB", cebra: "FFF5F6FA", borde: "FFE8E9EF", suave: "FF6B7080" };
const FORMATO = { d: '"$"#,##0', n: "#,##0", p: "0.0%", fecha: "dd/mm/yyyy", hora: "h:mm AM/PM", min: '0" min"' };

function cargarExcelJS() {
  if (window.ExcelJS) return Promise.resolve(window.ExcelJS);
  return new Promise((listo, fallo) => {
    const $s = document.createElement("script");
    $s.src = EXCELJS;
    $s.onload = () => listo(window.ExcelJS);
    $s.onerror = () => fallo(new Error("No se pudo cargar ExcelJS"));
    document.head.append($s);
  });
}

// Excel guarda fechas sin zona horaria: se pasa la hora de Colombia tal cual se ve.
const local = (iso) => {
  if (!iso) return null;
  const d = new Date(iso);
  return new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate(), d.getHours(), d.getMinutes()));
};
const diaLocal = (iso) => {
  const d = new Date(iso);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
};
const fechaDeDia = (dia) => new Date(`${dia}T00:00:00Z`);
const textoDia = (dia) => new Date(`${dia}T12:00:00`).toLocaleDateString("es-CO", { day: "2-digit", month: "2-digit", year: "numeric" });

// Título y subtítulo arriba de cada hoja.
function titulo(ws, texto, sub, columnas) {
  const ancho = Math.max(columnas, 4);
  ws.mergeCells(1, 1, 1, ancho);
  ws.mergeCells(2, 1, 2, ancho);
  Object.assign(ws.getCell(1, 1), { value: texto, font: { size: 16, bold: true, color: { argb: COLOR.acento } } });
  Object.assign(ws.getCell(2, 1), { value: sub, font: { italic: true, color: { argb: COLOR.suave } } });
  ws.getRow(1).height = 26;
}

function subtitulo(ws, fila, texto, columnas) {
  ws.mergeCells(fila, 1, fila, Math.max(columnas, 2));
  Object.assign(ws.getCell(fila, 1), { value: texto, font: { size: 13, bold: true, color: { argb: COLOR.oscuro } } });
  ws.getCell(fila, 1).border = { bottom: { style: "medium", color: { argb: COLOR.acento } } };
}

// Escribe una tabla con encabezado de color, filas cebra y fila de TOTAL (con fórmula SUBTOTAL,
// que respeta los filtros). columnas: [{ t: título, f: formato, s: sumar }]. Devuelve la próxima fila libre.
function tabla(ws, fila, columnas, filas, { filtro = false, congelar = false, total = true } = {}) {
  const borde = { style: "thin", color: { argb: COLOR.borde } };
  const bordes = { top: borde, bottom: borde, left: borde, right: borde };
  const encabezado = ws.getRow(fila);
  columnas.forEach((c, i) => {
    const celda = encabezado.getCell(i + 1);
    celda.value = c.t;
    celda.font = { bold: true, color: { argb: "FFFFFFFF" } };
    celda.fill = { type: "pattern", pattern: "solid", fgColor: { argb: COLOR.oscuro } };
    celda.alignment = { vertical: "middle", horizontal: c.f && c.f !== "fecha" && c.f !== "hora" ? "right" : "left", wrapText: true };
    celda.border = bordes;
  });
  encabezado.height = 22;
  filas.forEach((valores, k) => {
    const r = ws.getRow(fila + 1 + k);
    valores.forEach((v, i) => {
      const celda = r.getCell(i + 1);
      celda.value = v ?? "";
      if (columnas[i]?.f && FORMATO[columnas[i].f]) celda.numFmt = FORMATO[columnas[i].f];
      celda.alignment = { vertical: "top", wrapText: !columnas[i]?.f };
      celda.border = bordes;
      if (k % 2) celda.fill = { type: "pattern", pattern: "solid", fgColor: { argb: COLOR.cebra } };
    });
  });
  let fin = fila + filas.length;
  if (!filas.length) {
    ws.getCell(fila + 1, 1).value = "Sin datos en este periodo";
    ws.getCell(fila + 1, 1).font = { italic: true, color: { argb: COLOR.suave } };
    return fila + 3;
  }
  if (total && columnas.some((c) => c.s)) {
    fin += 1;
    const r = ws.getRow(fin);
    columnas.forEach((c, i) => {
      const celda = r.getCell(i + 1);
      if (i === 0) celda.value = "TOTAL";
      if (c.s) {
        const letra = ws.getColumn(i + 1).letter;
        celda.value = { formula: `SUBTOTAL(9,${letra}${fila + 1}:${letra}${fila + filas.length})` };
        celda.numFmt = FORMATO[c.f] ?? FORMATO.n;
      }
      celda.font = { bold: true };
      celda.fill = { type: "pattern", pattern: "solid", fgColor: { argb: COLOR.acentoSuave } };
      celda.border = { top: { style: "medium", color: { argb: COLOR.acento } } };
    });
  }
  if (filtro) ws.autoFilter = { from: { row: fila, column: 1 }, to: { row: fila + filas.length, column: columnas.length } };
  if (congelar) ws.views = [{ state: "frozen", ySplit: fila, xSplit: 1 }];
  return fin + 3;
}

function hojaDetalle(libro, nombre, encabezado, sub, columnas, filas) {
  const ws = libro.addWorksheet(nombre, { pageSetup: { orientation: "landscape", fitToPage: true, fitToWidth: 1, fitToHeight: 0 } });
  ws.columns = columnas.map((c) => ({ width: c.w ?? 14 }));
  titulo(ws, encabezado, sub, columnas.length);
  tabla(ws, 4, columnas, filas, { filtro: true, congelar: true });
  return ws;
}

export async function exportarVentasYGastos({ desde, hasta, cerrados, gastos, nombreCuenta, negocio, admin, menu, equipo = [], miembros = [] }) {
  const ExcelJS = await cargarExcelJS();
  const libro = new ExcelJS.Workbook();
  libro.creator = negocio?.nombre || "ZEBRO";
  libro.created = new Date();

  const restaurante = negocio?.nombre || "Restaurante";
  const periodo = desde === hasta ? `Día ${textoDia(desde)}` : `Del ${textoDia(desde)} al ${textoDia(hasta)}`;
  const generado = `${periodo} · Generado el ${new Date().toLocaleString("es-CO", { dateStyle: "short", timeStyle: "short" })}`;

  // Datos de apoyo.
  const suma = (lista, f) => lista.reduce((s, x) => s + Number(f(x) || 0), 0);
  const pagados = cerrados.filter((p) => p.estado === "pagado");
  const anulados = cerrados.filter((p) => p.estado === "anulado");
  const subtotal = (p) => suma(p.pedido_items, (i) => i.precio * i.cantidad);
  const unidades = (p) => suma(p.pedido_items, (i) => i.cantidad);
  const tipo = (p) => (p.tipo === "domicilio" ? "Domicilio" : p.para_llevar ? "Para llevar" : "Mesa");
  const platoDe = (id) => menu?.platos?.find((pl) => pl.id === id);
  const categoria = (item) => menu?.categorias?.find((c) => c.id === platoDe(item.plato_id)?.categoria_id)?.nombre ?? "Sin categoría";
  const quien = (userId) => miembros.find((m) => m.user_id === userId)?.nombre ?? "";
  const domiciliario = (id) => equipo.find((e) => e.id === id)?.nombre ?? "";
  const pagosDe = (p) => (p.pagos?.length ? p.pagos
    : p.estado === "pagado" ? [{ metodo: p.metodo_pago, valor: p.total + (p.propina || 0), fecha: p.cerrado }] : []);
  const minutos = (p) => (p.creado && p.cerrado ? Math.max(0, Math.round((new Date(p.cerrado) - new Date(p.creado)) / 60000)) : "");
  const metodoItem = (p, i) => pagosDe(p).find((x) => x.id === i.pago_id)?.metodo ?? p.metodo_pago ?? "";
  const detalleItem = (i) => (i.opciones ?? []).map((o) => o.nombre).join(", ");

  const ventas = suma(pagados, (p) => p.total);
  const costo = suma(pagados, (p) => p.costo);
  const totalGastos = suma(gastos, (g) => g.valor);
  const todosLosPagos = pagados.flatMap((p) => pagosDe(p).map((x) => ({ ...x, p })));
  const items = pagados.flatMap((p) => p.pedido_items.map((i) => ({ ...i, p })));

  const agrupar = (lista, clave) => {
    const grupos = new Map();
    for (const x of lista) {
      const k = clave(x);
      if (!grupos.has(k)) grupos.set(k, []);
      grupos.get(k).push(x);
    }
    return grupos;
  };
  const pct = (v, total) => (total ? v / total : 0);

  // ---------- Hoja 1: Resumen ----------
  const ws = libro.addWorksheet("Resumen", { pageSetup: { orientation: "portrait", fitToPage: true, fitToWidth: 1, fitToHeight: 0 } });
  ws.columns = [{ width: 32 }, { width: 16 }, { width: 16 }, { width: 16 }, { width: 16 }, { width: 16 }];
  titulo(ws, `${restaurante} · Reporte de ventas y gastos`, generado, 6);
  if (negocio?.logo?.startsWith("data:image/png;base64,")) {
    const imagen = libro.addImage({ base64: negocio.logo, extension: "png" });
    ws.addImage(imagen, { tl: { col: 6.2, row: 0 }, ext: { width: 64, height: 64 } });
  }

  let fila = 4;
  subtitulo(ws, fila, "Indicadores del periodo", 2);
  const indicadores = [
    ["Ventas (cuentas cobradas)", ventas, "d"],
    ["Cuentas cobradas", pagados.length, "n"],
    ["Ticket promedio por cuenta", pagados.length ? Math.round(ventas / pagados.length) : 0, "d"],
    ["Productos vendidos", suma(pagados, unidades), "n"],
    ["Envíos cobrados (domicilios)", suma(pagados, (p) => p.envio), "d"],
    ["Cuentas anuladas", anulados.length, "n"],
    ["Gastos", totalGastos, "d"],
    ...(admin ? [
      ["Costo de lo vendido", Math.round(costo), "d"],
      ["Utilidad bruta (ventas − costo)", Math.round(ventas - costo), "d"],
      ["Utilidad neta (− gastos)", Math.round(ventas - costo - totalGastos), "d"],
      ["Margen neto", pct(ventas - costo - totalGastos, ventas), "p"],
    ] : [["Ventas − gastos", ventas - totalGastos, "d"]]),
  ];
  fila += 1;
  for (const [nombre, valor, f] of indicadores) {
    const r = ws.getRow(fila++);
    Object.assign(r.getCell(1), { value: nombre, font: { color: { argb: COLOR.oscuro } } });
    Object.assign(r.getCell(2), { value: valor, numFmt: FORMATO[f], font: { bold: true, size: 12 }, alignment: { horizontal: "right" } });
    r.getCell(1).border = r.getCell(2).border = { bottom: { style: "thin", color: { argb: COLOR.borde } } };
    if (/Utilidad neta|Margen/.test(nombre) && valor < 0) r.getCell(2).font = { bold: true, size: 12, color: { argb: "FFDC2626" } };
  }
  fila += 2;

  // Ventas y gastos por día (todos los días del periodo).
  const dias = [];
  for (let d = fechaDeDia(desde); d <= fechaDeDia(hasta) && dias.length < 400; d = new Date(d.getTime() + 86400000)) {
    dias.push(d.toISOString().slice(0, 10));
  }
  const ventasDia = agrupar(pagados, (p) => diaLocal(p.cerrado));
  const gastosDia = agrupar(gastos, (g) => g.fecha);
  subtitulo(ws, fila, "Ventas y gastos por día", admin ? 6 : 4);
  fila = tabla(ws, fila + 1,
    [{ t: "Fecha", f: "fecha" }, { t: "Cuentas", f: "n", s: true }, { t: "Ventas", f: "d", s: true }, { t: "Gastos", f: "d", s: true },
      ...(admin ? [{ t: "Costo", f: "d", s: true }, { t: "Utilidad neta", f: "d", s: true }] : [])],
    dias.map((dia) => {
      const v = ventasDia.get(dia) ?? [];
      const g = suma(gastosDia.get(dia) ?? [], (x) => x.valor);
      const vv = suma(v, (p) => p.total);
      const cc = Math.round(suma(v, (p) => p.costo));
      return [fechaDeDia(dia), v.length, vv, g, ...(admin ? [cc, vv - cc - g] : [])];
    }));

  subtitulo(ws, fila, "Ventas por tipo de pedido", 4);
  fila = tabla(ws, fila + 1,
    [{ t: "Tipo" }, { t: "Cuentas", f: "n", s: true }, { t: "Ventas", f: "d", s: true }, { t: "% de las ventas", f: "p" }],
    [...agrupar(pagados, tipo)].map(([t, lista]) => [t, lista.length, suma(lista, (p) => p.total), pct(suma(lista, (p) => p.total), ventas)]));

  subtitulo(ws, fila, "Dinero recibido por método de pago", 4);
  fila = tabla(ws, fila + 1,
    [{ t: "Método" }, { t: "Pagos", f: "n", s: true }, { t: "Valor", f: "d", s: true }, { t: "% del dinero", f: "p" }],
    [...agrupar(todosLosPagos, (x) => x.metodo)].map(([m, lista]) => {
      const v = suma(lista, (x) => x.valor);
      return [m, lista.length, v, pct(v, suma(todosLosPagos, (x) => x.valor))];
    }).sort((a, b) => b[2] - a[2]));

  subtitulo(ws, fila, "Ventas por categoría de producto", admin ? 5 : 4);
  fila = tabla(ws, fila + 1,
    [{ t: "Categoría" }, { t: "Cantidad", f: "n", s: true }, { t: "Ventas", f: "d", s: true }, { t: "% de las ventas", f: "p" },
      ...(admin ? [{ t: "Ganancia", f: "d", s: true }] : [])],
    [...agrupar(items, categoria)].map(([c, lista]) => {
      const v = suma(lista, (i) => i.precio * i.cantidad);
      return [c, suma(lista, (i) => i.cantidad), v, pct(v, ventas),
        ...(admin ? [Math.round(v - suma(lista, (i) => Number(i.costo || 0) * i.cantidad))] : [])];
    }).sort((a, b) => b[2] - a[2]));

  subtitulo(ws, fila, "Ventas por hora del día", 3);
  fila = tabla(ws, fila + 1,
    [{ t: "Hora" }, { t: "Cuentas", f: "n", s: true }, { t: "Ventas", f: "d", s: true }],
    [...agrupar(pagados, (p) => new Date(p.cerrado).getHours())].sort((a, b) => a[0] - b[0]).map(([h, lista]) => {
      const etiqueta = (x) => `${((x + 11) % 12) + 1}:00 ${x < 12 ? "a. m." : "p. m."}`;
      return [`${etiqueta(h)} – ${etiqueta((h + 1) % 24)}`, lista.length, suma(lista, (p) => p.total)];
    }));

  if (admin && miembros.length) {
    subtitulo(ws, fila, "Ventas por quien abrió la cuenta", 3);
    fila = tabla(ws, fila + 1,
      [{ t: "Empleado" }, { t: "Cuentas", f: "n", s: true }, { t: "Ventas", f: "d", s: true }],
      [...agrupar(pagados, (p) => quien(p.abierto_por) || "Sin dato")].map(([n, lista]) => [n, lista.length, suma(lista, (p) => p.total)])
        .sort((a, b) => b[2] - a[2]));
  }

  subtitulo(ws, fila, "Gastos por categoría", 4);
  tabla(ws, fila + 1,
    [{ t: "Categoría" }, { t: "Registros", f: "n", s: true }, { t: "Valor", f: "d", s: true }, { t: "% de los gastos", f: "p" }],
    [...agrupar(gastos, (g) => g.categoria)].map(([c, lista]) => {
      const v = suma(lista, (g) => g.valor);
      return [c, lista.length, v, pct(v, totalGastos)];
    }).sort((a, b) => b[2] - a[2]));

  // ---------- Hoja 2: Ventas (una fila por cuenta cobrada) ----------
  hojaDetalle(libro, "Ventas", `${restaurante} · Cuentas cobradas`, generado, [
    { t: "N.° venta", w: 10 }, { t: "Fecha", f: "fecha", w: 12 }, { t: "Abierta", f: "hora", w: 11 }, { t: "Cobrada", f: "hora", w: 11 },
    { t: "Duración", f: "min", w: 10 }, { t: "Tipo", w: 12 }, { t: "Mesa / domicilio", w: 22 }, { t: "Cliente", w: 18 },
    { t: "Teléfono", w: 14 }, { t: "Dirección", w: 26 }, { t: "Atendió", w: 16 }, { t: "Domiciliario", w: 16 },
    { t: "Productos", f: "n", s: true, w: 10 }, { t: "Subtotal", f: "d", s: true }, { t: "Envío", f: "d", s: true, w: 11 },
    { t: "Total", f: "d", s: true }, { t: "Método", w: 14 }, { t: "Detalle de pagos", w: 30 },
    ...(admin ? [{ t: "Costo", f: "d", s: true }, { t: "Ganancia", f: "d", s: true }, { t: "Margen", f: "p", w: 10 }] : []),
    { t: "Novedades del domicilio", w: 30 },
  ], pagados.map((p) => [
    p.numero, local(p.cerrado), local(p.creado), local(p.cerrado), minutos(p), tipo(p), nombreCuenta(p),
    p.tipo === "domicilio" ? p.cliente : "", p.telefono || "", p.direccion || "", quien(p.abierto_por), domiciliario(p.domiciliario_id),
    unidades(p), subtotal(p), p.envio || 0, p.total ?? 0, p.metodo_pago ?? "",
    pagosDe(p).map((x) => `${x.metodo} $${Number(x.valor).toLocaleString("es-CO")}`).join(" + "),
    ...(admin ? [Math.round(Number(p.costo || 0)), Math.round((p.total ?? 0) - Number(p.costo || 0)), pct((p.total ?? 0) - Number(p.costo || 0), p.total)] : []),
    p.novedades || "",
  ]));

  // ---------- Hoja 3: Detalle de productos (cada línea de cada cuenta) ----------
  hojaDetalle(libro, "Detalle de productos", `${restaurante} · Productos de cada cuenta`, generado, [
    { t: "N.° venta", w: 10 }, { t: "Fecha", f: "fecha", w: 12 }, { t: "Hora", f: "hora", w: 11 }, { t: "Mesa / domicilio", w: 22 },
    { t: "Tipo", w: 12 }, { t: "Categoría", w: 16 }, { t: "Producto", w: 24 }, { t: "Opciones", w: 24 }, { t: "Nota", w: 20 },
    { t: "Cantidad", f: "n", s: true, w: 10 }, { t: "Precio unitario", f: "d" }, { t: "Total", f: "d", s: true },
    ...(admin ? [{ t: "Costo unitario", f: "d" }, { t: "Costo total", f: "d", s: true }, { t: "Ganancia", f: "d", s: true }] : []),
    { t: "Pagado con", w: 14 },
  ], items.map((i) => [
    i.p.numero, local(i.p.cerrado), local(i.p.cerrado), nombreCuenta(i.p), tipo(i.p), categoria(i), i.nombre, detalleItem(i), i.nota || "",
    i.cantidad, i.precio, i.precio * i.cantidad,
    ...(admin ? [Math.round(Number(i.costo || 0)), Math.round(Number(i.costo || 0) * i.cantidad), Math.round((i.precio - Number(i.costo || 0)) * i.cantidad)] : []),
    metodoItem(i.p, i),
  ]));

  // ---------- Hoja 4: Productos (ranking) ----------
  const porProducto = [...agrupar(items, (i) => i.nombre)].map(([nombre, lista]) => {
    const v = suma(lista, (i) => i.precio * i.cantidad);
    const c = suma(lista, (i) => Number(i.costo || 0) * i.cantidad);
    return [nombre, categoria(lista[0]), suma(lista, (i) => i.cantidad), v, pct(v, ventas),
      ...(admin ? [Math.round(c), Math.round(v - c), pct(v - c, v)] : [])];
  }).sort((a, b) => b[3] - a[3]);
  hojaDetalle(libro, "Productos", `${restaurante} · Productos más vendidos`, generado, [
    { t: "Producto", w: 26 }, { t: "Categoría", w: 18 }, { t: "Cantidad", f: "n", s: true, w: 10 }, { t: "Ventas", f: "d", s: true },
    { t: "% de las ventas", f: "p", w: 14 },
    ...(admin ? [{ t: "Costo", f: "d", s: true }, { t: "Ganancia", f: "d", s: true }, { t: "Margen", f: "p", w: 10 }] : []),
  ], porProducto);

  // ---------- Hoja 5: Pagos (cada pago con su método; las cuentas divididas tienen varios) ----------
  hojaDetalle(libro, "Pagos", `${restaurante} · Pagos recibidos`, generado, [
    { t: "N.° venta", w: 10 }, { t: "Fecha", f: "fecha", w: 12 }, { t: "Hora", f: "hora", w: 11 }, { t: "Mesa / domicilio", w: 24 },
    { t: "Tipo", w: 12 }, { t: "Método", w: 16 }, { t: "Valor", f: "d", s: true }, { t: "Cuenta dividida", w: 14 },
  ], todosLosPagos.map((x) => [
    x.p.numero, local(x.fecha ?? x.p.cerrado), local(x.fecha ?? x.p.cerrado), nombreCuenta(x.p), tipo(x.p), x.metodo, x.valor,
    pagosDe(x.p).length > 1 ? "Sí" : "No",
  ]));

  // ---------- Hoja 6: Gastos ----------
  hojaDetalle(libro, "Gastos", `${restaurante} · Gastos`, generado, [
    { t: "Fecha", f: "fecha", w: 12 }, { t: "Categoría", w: 16 }, { t: "Descripción", w: 36 }, { t: "Pagado con", w: 14 },
    { t: "Valor", f: "d", s: true }, ...(miembros.length ? [{ t: "Registró", w: 18 }] : []),
  ], gastos.map((g) => [fechaDeDia(g.fecha), g.categoria, g.descripcion, g.metodo, g.valor, ...(miembros.length ? [quien(g.usuario)] : [])]));

  // ---------- Hoja 7: Anuladas ----------
  hojaDetalle(libro, "Anuladas", `${restaurante} · Cuentas anuladas`, generado, [
    { t: "N.° venta", w: 10 }, { t: "Fecha", f: "fecha", w: 12 }, { t: "Hora", f: "hora", w: 11 }, { t: "Mesa / domicilio", w: 24 },
    { t: "Tipo", w: 12 }, { t: "Estaba cobrada", w: 14 }, { t: "Valor", f: "d", s: true }, { t: "Motivo", w: 36 },
  ], anulados.map((p) => [
    p.numero, local(p.cerrado), local(p.cerrado), nombreCuenta(p), tipo(p), p.total != null ? "Sí" : "No",
    p.total ?? subtotal(p) + (p.envio || 0), p.motivo_anulacion || "",
  ]));

  // Descarga.
  const datos = await libro.xlsx.writeBuffer();
  const url = URL.createObjectURL(new Blob([datos], { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" }));
  const $a = document.createElement("a");
  $a.href = url;
  $a.download = `${restaurante.replace(/[\\/:*?"<>|]/g, "").trim()} - Ventas y gastos ${desde}${hasta !== desde ? ` a ${hasta}` : ""}.xlsx`;
  document.body.append($a);
  $a.click();
  $a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10000);
}
