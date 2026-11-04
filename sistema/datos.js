// Lógica del sistema: datos, ventas, inventario, gastos y reportes. No toca la pantalla.
// Los valores son pesos colombianos enteros. Las fechas son textos "AAAA-MM-DD".
const CLAVE = "zebro-sistema-v1";

export const METODOS_PAGO = ["Efectivo", "Transferencia", "Nequi", "Daviplata", "Tarjeta", "Crédito"];
export const CATEGORIAS_GASTO = [
  "Arriendo", "Servicios", "Transporte", "Publicidad", "Compras", "Nómina", "Impuestos", "Otros",
];

export function datosVacios() {
  return {
    productos: [],
    clientes: [],
    ventas: [],
    gastos: [],
    movimientos: [],
    consecutivo: 1,
    ultimoRespaldo: null,
  };
}

export function cargar(almacen) {
  try {
    const guardado = almacen?.getItem(CLAVE);
    return guardado ? { ...datosVacios(), ...JSON.parse(guardado) } : datosVacios();
  } catch {
    return datosVacios();
  }
}

export function guardar(almacen, datos) {
  try {
    almacen.setItem(CLAVE, JSON.stringify(datos));
    return true;
  } catch {
    return false;
  }
}

export function validarRespaldo(contenido) {
  const claves = ["productos", "clientes", "ventas", "gastos", "movimientos"];
  if (!contenido || !claves.every((c) => Array.isArray(contenido[c]))) {
    throw new Error("Ese archivo no es un respaldo válido del sistema");
  }
  return { ...datosVacios(), ...contenido };
}

export function hoy(fecha = new Date()) {
  const mes = String(fecha.getMonth() + 1).padStart(2, "0");
  const dia = String(fecha.getDate()).padStart(2, "0");
  return `${fecha.getFullYear()}-${mes}-${dia}`;
}

function nuevoId() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

function entero(valor, campo, minimo = 0) {
  const numero = Number(valor);
  if (!Number.isInteger(numero) || numero < minimo) {
    throw new Error(`${campo} debe ser un número entero de ${minimo} o más`);
  }
  return numero;
}

function texto(valor) {
  return String(valor ?? "").trim();
}

function buscarProducto(datos, id) {
  const producto = datos.productos.find((p) => p.id === id);
  if (!producto) throw new Error("Ese producto ya no existe");
  return producto;
}

function registrarMovimiento(datos, producto, cantidad, motivo, fecha) {
  datos.movimientos.push({
    id: nuevoId(),
    fecha,
    productoId: producto.id,
    producto: producto.nombre,
    cantidad,
    motivo,
    saldo: producto.stock,
  });
}

// Productos

export function guardarProducto(datos, campos) {
  const nombre = texto(campos.nombre);
  if (!nombre) throw new Error("Escribe el nombre del producto");
  const valores = {
    nombre,
    referencia: texto(campos.referencia),
    costo: entero(campos.costo, "El costo"),
    precio: entero(campos.precio, "El precio"),
    stockMinimo: entero(campos.stockMinimo, "El stock mínimo"),
  };
  if (campos.id) {
    Object.assign(buscarProducto(datos, campos.id), valores);
    return;
  }
  const producto = { id: nuevoId(), ...valores, stock: entero(campos.stock, "El stock inicial") };
  datos.productos.push(producto);
  if (producto.stock > 0) {
    registrarMovimiento(datos, producto, producto.stock, "Stock inicial", hoy());
  }
}

export function eliminarProducto(datos, id) {
  datos.productos = datos.productos.filter((p) => p.id !== id);
}

// Entrada (compra) o salida manual. Una entrada con costo promedia el costo del producto.
export function ajustarStock(datos, { productoId, tipo, cantidad, costo, motivo, fecha }) {
  const producto = buscarProducto(datos, productoId);
  const unidades = entero(cantidad, "La cantidad", 1);
  if (tipo === "salida") {
    if (unidades > producto.stock) throw new Error(`Solo hay ${producto.stock} unidades de ${producto.nombre}`);
    producto.stock -= unidades;
    registrarMovimiento(datos, producto, -unidades, texto(motivo) || "Salida manual", fecha);
    return;
  }
  if (costo !== "" && costo != null) {
    const costoEntrada = entero(costo, "El costo");
    const valorActual = producto.stock * producto.costo;
    producto.costo = Math.round((valorActual + unidades * costoEntrada) / (producto.stock + unidades));
  }
  producto.stock += unidades;
  registrarMovimiento(datos, producto, unidades, texto(motivo) || "Entrada", fecha);
}

export function stockBajo(datos) {
  return datos.productos.filter((p) => p.stock <= p.stockMinimo);
}

// Clientes

export function guardarCliente(datos, campos) {
  const nombre = texto(campos.nombre);
  if (!nombre) throw new Error("Escribe el nombre del cliente");
  const valores = {
    nombre,
    documento: texto(campos.documento),
    telefono: texto(campos.telefono),
    direccion: texto(campos.direccion),
  };
  const existente = datos.clientes.find((c) => c.id === campos.id);
  if (existente) Object.assign(existente, valores);
  else datos.clientes.push({ id: nuevoId(), ...valores });
}

export function eliminarCliente(datos, id) {
  datos.clientes = datos.clientes.filter((c) => c.id !== id);
}

// Ventas

export function totalVenta(venta) {
  return venta.lineas.reduce((suma, l) => suma + l.precio * l.cantidad, 0);
}

export function costoVenta(venta) {
  return venta.lineas.reduce((suma, l) => suma + l.costo * l.cantidad, 0);
}

export function saldoVenta(venta) {
  if (venta.estado === "anulada") return 0;
  return totalVenta(venta) - venta.abonos.reduce((suma, a) => suma + a.valor, 0);
}

export function registrarVenta(datos, { fecha, clienteId, metodo, lineas, abonoInicial }) {
  if (!METODOS_PAGO.includes(metodo)) throw new Error("Elige el método de pago");
  if (!lineas?.length) throw new Error("Agrega al menos un producto");

  // Primero se valida todo, para no descontar inventario de una venta que no se va a guardar.
  const pedidas = new Map();
  const detalle = lineas.map((l) => {
    const producto = buscarProducto(datos, l.productoId);
    const cantidad = entero(l.cantidad, "La cantidad", 1);
    pedidas.set(producto.id, (pedidas.get(producto.id) ?? 0) + cantidad);
    if (pedidas.get(producto.id) > producto.stock) {
      throw new Error(`Solo hay ${producto.stock} unidades de ${producto.nombre}`);
    }
    return { producto, cantidad, precio: entero(l.precio, "El precio") };
  });

  const cliente = datos.clientes.find((c) => c.id === clienteId);
  const venta = {
    id: nuevoId(),
    numero: datos.consecutivo,
    fecha,
    clienteId: cliente?.id ?? null,
    cliente: cliente?.nombre ?? "Cliente general",
    metodo,
    estado: "activa",
    abonos: [],
    lineas: detalle.map(({ producto, cantidad, precio }) => ({
      productoId: producto.id,
      nombre: producto.nombre,
      cantidad,
      precio,
      costo: producto.costo,
    })),
  };

  const total = totalVenta(venta);
  const pagado = metodo === "Crédito" ? entero(abonoInicial || 0, "El abono") : total;
  if (pagado > total) throw new Error("El abono no puede ser mayor que el total");
  if (metodo === "Crédito" && !cliente) throw new Error("Una venta a crédito necesita un cliente");
  if (pagado > 0) venta.abonos.push({ fecha, valor: pagado });

  for (const { producto, cantidad } of detalle) {
    producto.stock -= cantidad;
    registrarMovimiento(datos, producto, -cantidad, `Venta #${venta.numero}`, fecha);
  }
  datos.ventas.push(venta);
  datos.consecutivo += 1;
  return venta;
}

export function registrarAbono(datos, ventaId, { valor, fecha }) {
  const venta = datos.ventas.find((v) => v.id === ventaId);
  if (!venta) throw new Error("Esa venta ya no existe");
  const abono = entero(valor, "El abono", 1);
  if (abono > saldoVenta(venta)) throw new Error("El abono no puede ser mayor que el saldo");
  venta.abonos.push({ fecha, valor: abono });
}

export function anularVenta(datos, ventaId, fecha) {
  const venta = datos.ventas.find((v) => v.id === ventaId);
  if (!venta || venta.estado === "anulada") return;
  venta.estado = "anulada";
  for (const linea of venta.lineas) {
    const producto = datos.productos.find((p) => p.id === linea.productoId);
    if (!producto) continue; // el producto se eliminó después de la venta
    producto.stock += linea.cantidad;
    registrarMovimiento(datos, producto, linea.cantidad, `Anulación venta #${venta.numero}`, fecha);
  }
}

export function porCobrar(datos) {
  return datos.ventas.filter((v) => saldoVenta(v) > 0);
}

// Gastos

export function registrarGasto(datos, { fecha, categoria, descripcion, valor, metodo }) {
  if (!CATEGORIAS_GASTO.includes(categoria)) throw new Error("Elige la categoría del gasto");
  datos.gastos.push({
    id: nuevoId(),
    fecha,
    categoria,
    descripcion: texto(descripcion),
    valor: entero(valor, "El valor", 1),
    metodo: texto(metodo),
  });
}

export function eliminarGasto(datos, id) {
  datos.gastos = datos.gastos.filter((g) => g.id !== id);
}

// Reportes

export function resumen(datos, desde, hasta) {
  const enRango = (r) => r.fecha >= desde && r.fecha <= hasta;
  const ventas = datos.ventas.filter((v) => v.estado === "activa" && enRango(v));
  const gastos = datos.gastos.filter(enRango);

  const totalVentas = ventas.reduce((s, v) => s + totalVenta(v), 0);
  const costo = ventas.reduce((s, v) => s + costoVenta(v), 0);
  const totalGastos = gastos.reduce((s, g) => s + g.valor, 0);
  // Lo cobrado cuenta por la fecha del abono, aunque la venta sea de otro periodo.
  const cobrado = datos.ventas
    .filter((v) => v.estado === "activa")
    .flatMap((v) => v.abonos)
    .filter(enRango)
    .reduce((s, a) => s + a.valor, 0);

  const productos = new Map();
  for (const linea of ventas.flatMap((v) => v.lineas)) {
    const fila = productos.get(linea.nombre) ?? { nombre: linea.nombre, cantidad: 0, total: 0, utilidad: 0 };
    fila.cantidad += linea.cantidad;
    fila.total += linea.precio * linea.cantidad;
    fila.utilidad += (linea.precio - linea.costo) * linea.cantidad;
    productos.set(linea.nombre, fila);
  }

  const categorias = new Map();
  for (const gasto of gastos) {
    categorias.set(gasto.categoria, (categorias.get(gasto.categoria) ?? 0) + gasto.valor);
  }

  return {
    cantidadVentas: ventas.length,
    totalVentas,
    costo,
    utilidadBruta: totalVentas - costo,
    totalGastos,
    utilidadNeta: totalVentas - costo - totalGastos,
    cobrado,
    productos: [...productos.values()].sort((a, b) => b.total - a.total),
    gastosPorCategoria: [...categorias.entries()]
      .map(([categoria, valor]) => ({ categoria, valor }))
      .sort((a, b) => b.valor - a.valor),
  };
}

export function valorInventario(datos) {
  return datos.productos.reduce((s, p) => s + p.stock * p.costo, 0);
}
