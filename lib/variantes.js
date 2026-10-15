// Variantes que se pueden pedir: activas, con existencias y con opciones reales.
// Mastershop incluye una "Default Variant" sin opciones ni stock; esa se descarta.
export function variantesDisponibles(producto) {
  return (producto.variation ?? [])
    .filter((v) => v.isEnable === 1 && v.stock > 0 && v.options?.length)
    .map((v) => ({ id: v.idVariant, nombre: v.name, stock: v.stock, sku: v.sku, peso: v.weight, costo: v.price }))
    .sort((a, b) => a.nombre.localeCompare(b.nombre, "es", { numeric: true }));
}
