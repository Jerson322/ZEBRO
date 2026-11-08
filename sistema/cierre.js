// Cierre de caja del día: resumen de lo vendido, el dinero por método, los gastos y el efectivo
// que debe haber en caja. Se ve en pantalla, se anota el efectivo contado y se imprime el ticket.
import * as api from "./api.js";
import { esc, pesos, mostrar, cerrarDialogo, hoy, aviso } from "./util.js";
import { imprimir } from "./impresion.js";

const suma = (lista, f) => lista.reduce((s, x) => s + Number(f(x) || 0), 0);

export async function calcularCierre(dia = hoy()) {
  const [cerrados, gastos, abiertos] = await Promise.all([api.pedidosCerrados(dia, dia), api.gastos(dia, dia), api.pedidosAbiertos()]);
  const pagados = cerrados.filter((p) => p.estado === "pagado");
  const anulados = cerrados.filter((p) => p.estado === "anulado");
  const pagos = pagados.flatMap((p) => (p.pagos?.length ? p.pagos : [{ metodo: p.metodo_pago, valor: p.total + (p.propina || 0) }]));
  const metodos = [...new Set(pagos.map((x) => x.metodo))]
    .map((m) => ({ metodo: m, pagos: pagos.filter((x) => x.metodo === m).length, valor: suma(pagos.filter((x) => x.metodo === m), (x) => x.valor) }))
    .sort((a, b) => b.valor - a.valor);
  const tipos = ["Mesa", "Para llevar", "Domicilio"].map((t) => {
    const lista = pagados.filter((p) => (p.tipo === "domicilio" ? "Domicilio" : p.para_llevar ? "Para llevar" : "Mesa") === t);
    return { tipo: t, cuentas: lista.length, valor: suma(lista, (p) => p.total) };
  }).filter((t) => t.cuentas);
  const productos = new Map();
  for (const i of pagados.flatMap((p) => p.pedido_items)) {
    const f = productos.get(i.nombre) ?? { nombre: i.nombre, cantidad: 0, valor: 0 };
    f.cantidad += i.cantidad;
    f.valor += i.precio * i.cantidad;
    productos.set(i.nombre, f);
  }
  const gastosEfectivo = suma(gastos.filter((g) => g.metodo === "Efectivo"), (g) => g.valor);
  const ventasEfectivo = metodos.find((m) => m.metodo === "Efectivo")?.valor ?? 0;
  return {
    dia,
    ventas: suma(pagados, (p) => p.total),
    cuentas: pagados.length,
    envios: suma(pagados, (p) => p.envio),
    anuladas: anulados.length,
    metodos,
    tipos,
    productos: [...productos.values()].sort((a, b) => b.cantidad - a.cantidad),
    gastos: suma(gastos, (g) => g.valor),
    gastosLista: gastos,
    gastosEfectivo,
    ventasEfectivo,
    efectivoEsperado: ventasEfectivo - gastosEfectivo,
    abiertas: abiertos.length,
  };
}

// Ticket del cierre para la comandera.
export function ticketCierre(c, negocio, { usuario, contado } = {}) {
  const fila = (izq, der, clase = "") => `<div class="t-fila ${clase}"><span>${izq}</span><span>${der}</span></div>`;
  const diferencia = contado != null ? contado - c.efectivoEsperado : null;
  const fecha = new Date(`${c.dia}T12:00:00`).toLocaleDateString("es-CO", { weekday: "long", day: "numeric", month: "long", year: "numeric" });
  return `<div class="ticket">
    <div class="t-centro t-negocio">${esc(negocio?.nombre ?? "")}</div>
    <div class="t-centro t-negocio">CIERRE DE CAJA</div>
    <div class="t-centro">${esc(fecha)}</div>
    <div class="t-centro t-chico">Impreso ${new Date().toLocaleString("es-CO", { dateStyle: "short", timeStyle: "short" })}${usuario ? ` · ${esc(usuario)}` : ""}</div>
    <hr>
    ${fila("Cuentas cobradas", c.cuentas)}
    ${c.tipos.map((t) => fila(`  ${t.tipo} (${t.cuentas})`, pesos(t.valor))).join("")}
    ${c.envios ? fila("  Envíos incluidos", pesos(c.envios)) : ""}
    ${c.anuladas ? fila("Cuentas anuladas", c.anuladas) : ""}
    ${fila("TOTAL VENTAS", pesos(c.ventas), "t-total")}
    <hr>
    <div><strong>DINERO POR MÉTODO</strong></div>
    ${c.metodos.length ? c.metodos.map((m) => fila(`${esc(m.metodo)} (${m.pagos})`, pesos(m.valor))).join("") : "<div>Sin pagos</div>"}
    <hr>
    <div><strong>GASTOS DEL DÍA</strong></div>
    ${c.gastosLista.length ? c.gastosLista.map((g) => fila(esc(`${g.categoria}${g.descripcion ? ` · ${g.descripcion}` : ""}`).slice(0, 34), pesos(g.valor))).join("") : "<div>Sin gastos</div>"}
    ${fila("Total gastos", pesos(c.gastos), "t-total")}
    <hr>
    <div><strong>EFECTIVO EN CAJA</strong></div>
    ${fila("Ventas en efectivo", pesos(c.ventasEfectivo))}
    ${fila("− Gastos en efectivo", pesos(c.gastosEfectivo))}
    ${fila("Debe haber", pesos(c.efectivoEsperado), "t-total")}
    ${contado != null ? fila("Contado", pesos(contado)) + fila(diferencia === 0 ? "Cuadra" : diferencia > 0 ? "Sobra" : "Falta", pesos(Math.abs(diferencia)), "t-total") : ""}
    <hr>
    <div><strong>PRODUCTOS VENDIDOS</strong></div>
    ${c.productos.length ? c.productos.map((p) => fila(`${p.cantidad} × ${esc(p.nombre)}`, pesos(p.valor))).join("") : "<div>Ninguno</div>"}
    ${c.abiertas ? `<hr><div class="t-centro"><strong>OJO: ${c.abiertas} cuenta(s) siguen abiertas sin cobrar</strong></div>` : ""}
    <hr>
    <div class="t-centro t-chico">Firma: ______________________</div>
  </div>`;
}

// Ventana del cierre: resumen en pantalla, efectivo contado y botón para imprimir.
// conSalida: al terminar se cierra la sesión (cuando se llega desde «Salir»).
export async function abrirCierre(ctx, { conSalida = false, salir } = {}) {
  let c;
  try {
    c = await calcularCierre();
  } catch (error) {
    aviso(error.message);
    return;
  }
  const fila = (izq, der, fuerte = false) => `<div class="item"><span>${izq}</span><span class="num">${fuerte ? `<strong>${der}</strong>` : der}</span></div>`;
  const $c = mostrar(`
    <h2>Cierre de caja · hoy</h2>
    ${c.abiertas ? `<p class="error" style="margin:0">Hay ${c.abiertas} cuenta(s) abiertas sin cobrar. Puedes cerrar igual, pero no entran en el cierre.</p>` : ""}
    <div class="tarjetas" style="margin:0">
      <div class="tarjeta"><small>Ventas (${c.cuentas})</small><strong>${pesos(c.ventas)}</strong></div>
      <div class="tarjeta"><small>Gastos</small><strong>${pesos(c.gastos)}</strong></div>
    </div>
    <div>
      <strong>Dinero por método</strong>
      ${c.metodos.length ? c.metodos.map((m) => fila(`${esc(m.metodo)} <small class="suave">(${m.pagos} pagos)</small>`, pesos(m.valor))).join("") : `<p class="suave" style="margin:4px 0">Sin pagos hoy.</p>`}
    </div>
    <div>
      <strong>Efectivo en caja</strong>
      ${fila("Ventas en efectivo", pesos(c.ventasEfectivo))}
      ${fila("− Gastos pagados en efectivo", pesos(c.gastosEfectivo))}
      ${fila("Debe haber", pesos(c.efectivoEsperado), true)}
    </div>
    <label>Efectivo contado en caja (opcional)<input id="contado" type="number" min="0" step="100" placeholder="Cuenta los billetes y escribe el total"></label>
    <p id="diferencia" style="margin:0"></p>
    <div class="botones">
      <button type="button" id="cancelar-cierre">Cancelar</button>
      <button type="button" class="principal" id="imprimir-cierre">${conSalida ? "Imprimir cierre y salir" : "Imprimir cierre"}</button>
    </div>`);
  const $contado = $c.querySelector("#contado");
  const $diferencia = $c.querySelector("#diferencia");
  $contado.addEventListener("input", () => {
    if ($contado.value === "") return ($diferencia.textContent = "");
    const d = Number($contado.value) - c.efectivoEsperado;
    $diferencia.className = d === 0 ? "" : d > 0 ? "suave" : "error";
    $diferencia.textContent = d === 0 ? "✓ La caja cuadra" : d > 0 ? `Sobran ${pesos(d)}` : `Faltan ${pesos(-d)}`;
  });
  $c.querySelector("#cancelar-cierre").addEventListener("click", cerrarDialogo);
  $c.querySelector("#imprimir-cierre").addEventListener("click", async () => {
    const contado = $contado.value === "" ? null : Number($contado.value);
    cerrarDialogo();
    await imprimir(ticketCierre(c, ctx.negocio, { usuario: ctx.perfil.nombre, contado }));
    aviso("Cierre de caja impreso");
    if (conSalida) await salir();
  });
}
