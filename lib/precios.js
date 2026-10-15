// Precio de venta = costo del proveedor + ganancia, redondeado hacia arriba a un precio cerrado.
// Ejemplo: gafas a $11.500 + $15.000 = $26.500 → $27.000.
const GANANCIA = 15000;
const REDONDEO = 1000;

// Precios fijos opcionales (COP) que reemplazan el cálculo. La clave es el ID del producto en Mastershop.
// Ejemplo:
//   "248085": 29900,
const PRECIOS_FIJOS = {
};

export function precioDeVenta(producto, variante = null) {
  const fijo = PRECIOS_FIJOS[String(producto.idProduct)];
  if (fijo) return fijo;
  const costo = variante?.costo ?? producto.basePrice;
  return Math.ceil((costo + GANANCIA) / REDONDEO) * REDONDEO;
}
