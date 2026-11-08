// Exporta a Excel (.xlsx) las ventas y los gastos de un periodo.
// La librería (SheetJS) se descarga solo al exportar, para no hacer más lenta la carga del sistema.
const SHEETJS = "https://cdn.jsdelivr.net/npm/xlsx@0.18.5/xlsx.mjs";

const fecha = (iso) => (iso ? new Date(iso).toLocaleDateString("es-CO") : "");
const hora = (iso) => (iso ? new Date(iso).toLocaleTimeString("es-CO", { hour: "2-digit", minute: "2-digit" }) : "");
const fechaDia = (dia) => (dia ? new Date(`${dia}T00:00:00`).toLocaleDateString("es-CO") : "");

// Hoja a partir de filas (la primera es el encabezado), con el ancho de cada columna ajustado.
function hoja(XLSX, filas, columnasDinero = []) {
  const h = XLSX.utils.aoa_to_sheet(filas);
  h["!cols"] = filas[0].map((_, c) => ({
    wch: Math.min(45, Math.max(10, ...filas.map((f) => String(f[c] ?? "").length + 2))),
  }));
  // Formato de pesos en las columnas de dinero (sin decimales).
  const rango = XLSX.utils.decode_range(h["!ref"]);
  for (const c of columnasDinero) {
    for (let r = 1; r <= rango.e.r; r++) {
      const celda = h[XLSX.utils.encode_cell({ r, c })];
      if (celda && typeof celda.v === "number") celda.z = '"$"#,##0';
    }
  }
  return h;
}

export async function exportarVentasYGastos({ desde, hasta, cerrados, gastos, nombreCuenta, negocio, admin }) {
  const XLSX = await import(SHEETJS);
  const pagados = cerrados.filter((p) => p.estado === "pagado");
  const suma = (lista, f) => lista.reduce((s, x) => s + Number(f(x) || 0), 0);
  const ventas = suma(pagados, (p) => p.total);
  const costo = suma(pagados, (p) => p.costo);
  const totalGastos = suma(gastos, (g) => g.valor);
  const pagos = pagados.flatMap((p) =>
    (p.pagos?.length ? p.pagos : [{ metodo: p.metodo_pago, valor: p.total + (p.propina || 0), fecha: p.cerrado }])
      .map((x) => ({ ...x, pedido: p })));
  const metodos = [...new Set(pagos.map((x) => x.metodo))];
  const libro = XLSX.utils.book_new();

  // Resumen del periodo.
  const resumen = [
    ["Concepto", "Valor"],
    ["Restaurante", negocio?.nombre ?? ""],
    ["Desde", fechaDia(desde)],
    ["Hasta", fechaDia(hasta)],
    ["Cuentas cobradas", pagados.length],
    ["Cuentas anuladas", cerrados.length - pagados.length],
    ["Ventas", ventas],
    ["Gastos", totalGastos],
    ...(admin ? [["Costo de lo vendido", costo], ["Utilidad", ventas - costo - totalGastos]] : []),
    [],
    ["Dinero recibido por método", ""],
    ...metodos.map((m) => [m, suma(pagos.filter((x) => x.metodo === m), (x) => x.valor)]),
  ];
  const $resumen = hoja(XLSX, resumen);
  for (let r = 1; r < resumen.length; r++) {
    const celda = $resumen[XLSX.utils.encode_cell({ r, c: 1 })];
    if (celda && typeof celda.v === "number" && !/Cuentas/.test(resumen[r][0])) celda.z = '"$"#,##0';
  }
  XLSX.utils.book_append_sheet(libro, $resumen, "Resumen");

  // Una fila por cuenta cerrada.
  XLSX.utils.book_append_sheet(libro, hoja(XLSX, [
    ["N.° venta", "Fecha", "Hora", "Cuenta", "Tipo", "Estado", "Método de pago", "Envío", "Total",
      ...(admin ? ["Costo", "Ganancia"] : []), "Motivo de anulación"],
    ...cerrados.map((p) => [
      p.numero, fecha(p.cerrado), hora(p.cerrado), nombreCuenta(p),
      p.tipo === "domicilio" ? "Domicilio" : p.para_llevar ? "Mesa · para llevar" : "Mesa",
      p.estado === "anulado" ? "Anulada" : "Pagada", p.estado === "anulado" ? "" : p.metodo_pago ?? "",
      p.envio || 0, p.total ?? 0,
      ...(admin ? [Math.round(Number(p.costo || 0)), Math.round((p.total ?? 0) - Number(p.costo || 0))] : []),
      p.motivo_anulacion ?? "",
    ]),
  ], admin ? [7, 8, 9, 10] : [7, 8]), "Ventas");

  // Cada plato vendido (de las cuentas pagadas).
  XLSX.utils.book_append_sheet(libro, hoja(XLSX, [
    ["N.° venta", "Fecha", "Cuenta", "Plato", "Opciones y nota", "Cantidad", "Precio unitario", "Total"],
    ...pagados.flatMap((p) => p.pedido_items.map((i) => [
      p.numero, fecha(p.cerrado), nombreCuenta(p), i.nombre,
      [...(i.opciones ?? []).map((o) => o.nombre), i.nota].filter(Boolean).join(" · "),
      i.cantidad, i.precio, i.precio * i.cantidad,
    ])),
  ], [6, 7]), "Platos vendidos");

  // Cada pago (una cuenta dividida tiene varios, cada uno con su método).
  XLSX.utils.book_append_sheet(libro, hoja(XLSX, [
    ["N.° venta", "Fecha", "Hora", "Cuenta", "Método", "Valor"],
    ...pagos.map((x) => [x.pedido.numero, fecha(x.fecha), hora(x.fecha), nombreCuenta(x.pedido), x.metodo, x.valor]),
  ], [5]), "Pagos");

  XLSX.utils.book_append_sheet(libro, hoja(XLSX, [
    ["Fecha", "Categoría", "Descripción", "Pagado con", "Valor"],
    ...gastos.map((g) => [fechaDia(g.fecha), g.categoria, g.descripcion, g.metodo, g.valor]),
  ], [4]), "Gastos");

  const nombre = (negocio?.nombre || "Restaurante").replace(/[\\/:*?"<>|]/g, "").trim();
  XLSX.writeFile(libro, `${nombre} - Ventas y gastos ${desde}${hasta !== desde ? ` a ${hasta}` : ""}.xlsx`);
}
