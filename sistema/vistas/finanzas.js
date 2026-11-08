// Ventas y gastos: cuentas cerradas, gastos y reporte por fechas.
// El cajero ve y registra; el reporte con costos y utilidad es solo para el administrador.
import * as api from "../api.js";
import { esc, pesos, opciones, tabla, tarjeta, formulario, hoy, hora, fechaCorta, aviso } from "../util.js";
import { exportarVentasYGastos } from "../excel.js";
import { abrirCierre } from "../cierre.js";

const CATEGORIAS_GASTO = ["Mercado", "Arriendo", "Servicios", "Nómina", "Transporte", "Publicidad", "Mantenimiento", "Impuestos", "Otros"];
const METODOS = ["Efectivo", "Tarjeta", "Transferencia", "Nequi", "Daviplata"];

const periodo = { desde: hoy(), hasta: hoy() };

export async function pintar($vista, ctx) {
  const admin = ctx.perfil.rol === "admin";
  const [cerrados, gastos, mesas] = await Promise.all([
    api.pedidosCerrados(periodo.desde, periodo.hasta),
    api.gastos(periodo.desde, periodo.hasta),
    api.mesas(),
  ]);
  const pagados = cerrados.filter((p) => p.estado === "pagado");
  const suma = (lista, f) => lista.reduce((s, x) => s + Number(f(x) || 0), 0);
  const ventas = suma(pagados, (p) => p.total);
  const costo = suma(pagados, (p) => p.costo);
  const totalGastos = suma(gastos, (g) => g.valor);
  const nombre = (p) => (p.tipo === "mesa" ? mesas.find((m) => m.id === p.mesa_id)?.nombre ?? "Mesa" : `Domicilio #${p.numero_domicilio ?? p.numero} · ${p.cliente}`);

  // Cuentas cobradas por partes: cada pago suma en su método. Las de antes (sin pagos) van completas.
  const pagos = pagados.flatMap((p) => (p.pagos?.length ? p.pagos : [{ metodo: p.metodo_pago, valor: p.total + p.propina }]));
  const porMetodo = METODOS.map((m) => [m, suma(pagos.filter((x) => x.metodo === m), (x) => x.valor)]).filter(([, v]) => v);

  const platos = new Map();
  for (const item of pagados.flatMap((p) => p.pedido_items)) {
    const fila = platos.get(item.nombre) ?? { nombre: item.nombre, cantidad: 0, total: 0, costo: 0 };
    fila.cantidad += item.cantidad;
    fila.total += item.precio * item.cantidad;
    fila.costo += Number(item.costo || 0) * item.cantidad;
    platos.set(item.nombre, fila);
  }

  $vista.innerHTML = `
    <div class="encabezado"><h1>Ventas y gastos</h1>
      <div class="botones-domicilio" style="margin:0"><button id="cierre-caja">Cierre de caja</button>
        <button class="principal" id="nuevo-gasto">Registrar gasto</button></div></div>
    <div class="filtros">
      <label>Desde<input type="date" data-periodo="desde" value="${periodo.desde}"></label>
      <label>Hasta<input type="date" data-periodo="hasta" value="${periodo.hasta}"></label>
      <button id="exportar-excel" style="align-self:end">Exportar a Excel</button>
    </div>
    <div class="tarjetas">
      ${tarjeta(`Ventas (${pagados.length})`, pesos(ventas))}
      ${tarjeta("Gastos", pesos(totalGastos))}
      ${admin ? tarjeta("Costo de lo vendido", pesos(costo)) : ""}
      ${admin ? tarjeta("Utilidad", pesos(ventas - costo - totalGastos), ventas - costo - totalGastos < 0 ? "negativo" : "positivo") : ""}
    </div>
    <div class="columnas">
      <div class="panel"><h2>Dinero recibido por método</h2>
        ${tabla(["Método", "#Total"], porMetodo.map(([m, v]) => `<tr><td>${m}</td><td class="num">${pesos(v)}</td></tr>`), "Sin ventas en este periodo.")}</div>
      <div class="panel"><h2>Platos más vendidos</h2>
        ${tabla(admin ? ["Plato", "#Cant.", "#Ventas", "#Ganancia"] : ["Plato", "#Cant.", "#Ventas"],
          [...platos.values()].sort((a, b) => b.total - a.total).map((f) => `<tr><td class="ancho">${esc(f.nombre)}</td>
            <td class="num">${f.cantidad}</td><td class="num">${pesos(f.total)}</td>
            ${admin ? `<td class="num">${pesos(f.total - f.costo)}</td>` : ""}</tr>`), "Sin ventas en este periodo.")}</div>
    </div>
    <div class="panel"><h2>Cuentas cerradas</h2>
      ${tabla(["N.°", "Fecha", "Hora", "Cuenta", "Pago", "#Total", ""], cerrados.map((p) => `<tr class="${p.estado === "anulado" ? "anulada" : ""}">
        <td>${p.numero}</td><td>${fechaCorta(p.cerrado)}</td><td>${hora(p.cerrado)}</td><td class="ancho">${esc(nombre(p))}</td>
        <td>${p.estado === "anulado" ? "Anulada" : esc(p.metodo_pago)}</td><td class="num">${pesos(p.total ?? 0)}</td>
        <td class="acciones"><a class="boton chico" href="#pedido/${p.id}">Ver</a></td></tr>`), "No hay cuentas cerradas en este periodo.")}</div>
    <div class="panel"><h2>Gastos</h2>
      ${tabla(["Fecha", "Categoría", "Descripción", "Pago", "#Valor", ""], gastos.map((g) => `<tr>
        <td>${fechaCorta(g.fecha)}</td><td>${esc(g.categoria)}</td><td class="ancho">${esc(g.descripcion)}</td><td>${esc(g.metodo)}</td>
        <td class="num">${pesos(g.valor)}</td>
        <td class="acciones">${admin ? `<button class="chico peligro" data-borrar-gasto="${g.id}">Borrar</button>` : ""}</td></tr>`), "Sin gastos en este periodo.")}</div>`;

  $vista.querySelectorAll("[data-periodo]").forEach(($i) =>
    $i.addEventListener("change", () => {
      if (!$i.value) return;
      periodo[$i.dataset.periodo] = $i.value;
      ctx.refrescar();
    })
  );
  $vista.querySelector("#cierre-caja").addEventListener("click", () => abrirCierre(ctx));
  $vista.querySelector("#exportar-excel").addEventListener("click", async (evento) => {
    const $b = evento.currentTarget;
    $b.disabled = true;
    $b.textContent = "Preparando…";
    try {
      // Nombres del equipo: domiciliarios para todos; quién abrió cada cuenta, solo el administrador.
      const [equipo, miembros] = await Promise.all([api.equipo(), admin ? api.miembros() : []]);
      await exportarVentasYGastos({
        desde: periodo.desde, hasta: periodo.hasta, cerrados, gastos, nombreCuenta: nombre, negocio: ctx.negocio, admin,
        menu: ctx.menu, equipo, miembros,
      });
      aviso("Excel descargado");
    } catch {
      aviso("No se pudo crear el Excel. Revisa tu conexión e inténtalo de nuevo.");
    } finally {
      $b.disabled = false;
      $b.textContent = "Exportar a Excel";
    }
  });
  $vista.querySelectorAll("[data-borrar-gasto]").forEach(($b) =>
    $b.addEventListener("click", async () => {
      if (!confirm("¿Borrar este gasto?")) return;
      try {
        await api.borrar("gastos", $b.dataset.borrarGasto);
        ctx.refrescar();
      } catch (e) { aviso(e.message); }
    })
  );
  $vista.querySelector("#nuevo-gasto").addEventListener("click", () =>
    formulario("Registrar gasto", `
      <div class="fila">
        <label>Fecha<input name="fecha" type="date" value="${hoy()}"></label>
        <label>Categoría<select name="categoria">${opciones(CATEGORIAS_GASTO)}</select></label>
      </div>
      <label>Descripción<input name="descripcion" placeholder="Ej. Compra de verduras"></label>
      <div class="fila">
        <label>Valor<input name="valor" type="number" min="1" step="100"></label>
        <label>Pagado con<select name="metodo">${opciones(METODOS)}</select></label>
      </div>
      <p class="suave" style="margin:0">Si compraste insumos, regístralos también como entrada en «Inventario» para que el costo quede al día.</p>`,
      async (c) => {
        const valor = Number(c.valor);
        if (!Number.isInteger(valor) || valor < 1) throw new Error("Escribe el valor del gasto");
        await api.registrarGasto({ fecha: c.fecha, categoria: c.categoria, descripcion: c.descripcion.trim(), valor, metodo: c.metodo, usuario: ctx.perfil.user_id });
      },
      { alTerminar: () => ctx.refrescar() })
  );
}
