// Precio de venta de cada producto, en pesos colombianos (COP), con el envío ya incluido.
// La clave es el ID del producto en Mastershop.
// Si un producto no aparece aquí, se usa el precio sugerido de Mastershop.
//
// Ejemplo:
//   "2001": 99900,
const PRECIOS = {
};

export function precioDeVenta(producto) {
  return PRECIOS[String(producto.idProduct)] ?? producto.suggestedPrice;
}
