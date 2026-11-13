// Cierre de caja: lo vendido, el dinero por método, los gastos y el efectivo que debe haber en
// caja (base de la apertura + ventas en efectivo − gastos en efectivo). El efectivo se cuenta con
// los billetes y monedas, se guarda el cierre y se imprime el ticket.
import * as api from "./api.js";
import { esc, pesos, mostrar, cerrarDialogo, hoy, aviso } from "./util.js";
import { imprimir } from "./impresion.js";
import { contadorEfectivo, detalleConteo } from "./caja.js";

const suma = (lista, f) => lista.reduce((s, x) => s + Number(f(x) || 0), 0);
const METODOS = ["Efectivo", "Tarjeta", "Transferencia", "Nequi", "Daviplata"];
// «Te sobró / te faltó / la caja cuadra» según lo contado contra lo que debe haber.
export const resultadoCaja = (diferencia) =>
  diferencia === 0 ? "LA CAJA CUADRA" : diferencia > 0 ? `TE SOBRÓ ${pesos(diferencia)}` : `TE FALTÓ ${pesos(-diferencia)}`;
const fechaHora = (iso) => new Date(iso).toLocaleString("es-CO", { dateStyle: "medium", timeStyle: "short" });

// Lo de una caja: los pagos que se cobraron en ella y los gastos que se registraron en ella.
export async function calcularCierre(caja) {
  const [pagos, gastos, abiertos] = await Promise.all([
    caja ? api.pagosDeCaja(caja.id) : [], caja ? api.gastosDeCaja(caja.id) : [], api.pedidosAbiertos(),
  ]);
  // Todos los métodos de pago, aunque no tengan pagos (así se ve cada uno, incluso en $0).
  const metodos = [...new Set([...METODOS, ...pagos.map((x) => x.metodo)])]
    .map((m) => ({ metodo: m, pagos: pagos.filter((x) => x.metodo === m).length, valor: suma(pagos.filter((x) => x.metodo === m), (x) => x.valor) }));
  // Cuentas con algún pago en esta caja (una cuenta dividida entre dos cajas cuenta en las dos).
  const cuentas = new Map();
  for (const x of pagos) {
    if (!x.pedidos) continue;
    const c = cuentas.get(x.pedido_id) ?? { ...x.pedidos, cobrado: 0 };
    c.cobrado += x.valor;
    cuentas.set(x.pedido_id, c);
  }
  const lista = [...cuentas.values()];
  const tipo = (p) => (p.tipo === "domicilio" ? "Domicilio" : p.para_llevar ? "Para llevar" : "Mesa");
  const tipos = ["Mesa", "Para llevar", "Domicilio"].map((t) => {
    const deTipo = lista.filter((p) => tipo(p) === t);
    return { tipo: t, cuentas: deTipo.length, valor: suma(deTipo, (p) => p.cobrado) };
  }).filter((t) => t.cuentas);
  // Productos pagados con los pagos de esta caja.
  const idsPagos = new Set(pagos.map((x) => x.id));
  const productos = new Map();
  for (const i of lista.flatMap((p) => p.pedido_items ?? []).filter((i) => idsPagos.has(i.pago_id))) {
    const f = productos.get(i.nombre) ?? { nombre: i.nombre, cantidad: 0, valor: 0 };
    f.cantidad += i.cantidad;
    f.valor += i.precio * i.cantidad;
    productos.set(i.nombre, f);
  }
  const base = caja?.base ?? 0;
  const gastosEfectivo = suma(gastos.filter((g) => g.metodo === "Efectivo"), (g) => g.valor);
  const ventasEfectivo = metodos.find((m) => m.metodo === "Efectivo")?.valor ?? 0;
  return {
    desde: caja?.abierta_en ?? new Date().toISOString(),
    caja,
    base,
    ventas: suma(pagos, (x) => x.valor),
    cuentas: lista.length,
    envios: 0,
    anuladas: 0,
    metodos,
    tipos,
    productos: [...productos.values()].sort((a, b) => b.cantidad - a.cantidad),
    gastos: suma(gastos, (g) => g.valor),
    gastosLista: gastos,
    gastosEfectivo,
    ventasEfectivo,
    efectivoEsperado: base + ventasEfectivo - gastosEfectivo,
    abiertas: abiertos.length,
  };
}

// Ticket del cierre para la comandera. corte = se imprime sin cerrar la caja.
export function ticketCierre(c, negocio, { usuario, dueno, contado, conteo, corte = false } = {}) {
  const fila = (izq, der, clase = "") => `<div class="t-fila ${clase}"><span>${izq}</span><span>${der}</span></div>`;
  const diferencia = contado != null ? contado - c.efectivoEsperado : null;
  const detalle = detalleConteo(conteo);
  return `<div class="ticket">
    <div class="t-centro t-negocio">${esc(negocio?.nombre ?? "")}</div>
    <div class="t-centro t-negocio">${corte ? "CORTE DE CAJA" : "CIERRE DE CAJA"}</div>
    ${dueno ? `<div class="t-centro"><strong>Caja de ${esc(dueno)}</strong></div>` : ""}
    <div class="t-centro">${c.caja ? `Abierta ${esc(fechaHora(c.desde))}` : `Desde ${esc(fechaHora(c.desde))}`}</div>
    <div class="t-centro t-chico">Impreso ${new Date().toLocaleString("es-CO", { dateStyle: "short", timeStyle: "short" })}${usuario ? ` · ${esc(usuario)}` : ""}</div>
    <hr>
    ${fila("Cuentas cobradas", c.cuentas)}
    ${c.tipos.map((t) => fila(`  ${t.tipo} (${t.cuentas})`, pesos(t.valor))).join("")}
    ${c.envios ? fila("  Envíos incluidos", pesos(c.envios)) : ""}
    ${c.anuladas ? fila("Cuentas anuladas", c.anuladas) : ""}
    ${fila("TOTAL COBRADO", pesos(c.ventas), "t-total")}
    <hr>
    <div><strong>DINERO POR MÉTODO</strong></div>
    ${c.metodos.map((m) => fila(`${esc(m.metodo)} (${m.pagos})`, pesos(m.valor))).join("")}
    ${fila("TOTAL RECIBIDO", pesos(c.metodos.reduce((s, m) => s + m.valor, 0)), "t-total")}
    <hr>
    <div><strong>GASTOS</strong></div>
    ${c.gastosLista.length ? c.gastosLista.map((g) => fila(esc(`${g.categoria}${g.descripcion ? ` · ${g.descripcion}` : ""}`).slice(0, 34), pesos(g.valor))).join("") : "<div>Sin gastos</div>"}
    ${fila("Total gastos", pesos(c.gastos), "t-total")}
    <hr>
    <div><strong>EFECTIVO EN CAJA</strong></div>
    ${fila("Base de apertura", pesos(c.base))}
    ${fila("+ Cobros en efectivo", pesos(c.ventasEfectivo))}
    ${fila("− Gastos en efectivo", pesos(c.gastosEfectivo))}
    ${fila("Debe haber", pesos(c.efectivoEsperado), "t-total")}
    ${contado != null ? fila("Contado en caja", pesos(contado), "t-total") : fila("Contado en caja", "No se contó")}
    ${contado != null ? `<div class="t-centro t-resultado">${resultadoCaja(diferencia)}</div>` : ""}
    ${detalle.length ? `<div class="t-chico">${detalle.map((x) => fila(`${x.cantidad} × ${pesos(x.denominacion)}`, pesos(x.valor))).join("")}</div>` : ""}
    <hr>
    <div><strong>PRODUCTOS VENDIDOS</strong></div>
    ${c.productos.length ? c.productos.map((p) => fila(`${p.cantidad} × ${esc(p.nombre)}`, pesos(p.valor))).join("") : "<div>Ninguno</div>"}
    ${c.abiertas ? `<hr><div class="t-centro"><strong>OJO: ${c.abiertas} cuenta(s) siguen abiertas sin cobrar</strong></div>` : ""}
    <hr>
    <div class="t-centro t-chico">Firma: ______________________</div>
  </div>`;
}

// Ventana del cierre: resumen, conteo del efectivo con billetes y monedas, y dos opciones:
// «Corte» (imprime sin cerrar la caja) o «Cerrar caja» (guarda el cierre e imprime).
// conSalida: al terminar el cierre se cierra la sesión (cuando se llega desde «Salir»).
// caja: la de otra persona (el administrador cerrando la caja de alguien); si no, la propia.
export async function abrirCierre(ctx, { conSalida = false, salir, caja: otra = null, dueno = null } = {}) {
  let c;
  let pedirCodigo = false;
  try {
    const caja = otra ?? await api.miCaja();
    if (!caja) {
      aviso("No tienes caja abierta");
      if (conSalida) await salir();
      return;
    }
    const propia = caja.abierta_por === ctx.perfil.user_id;
    dueno = dueno ?? (propia ? ctx.perfil.nombre : "");
    pedirCodigo = propia && await api.tengoCodigoCaja().catch(() => false);
    c = await calcularCierre(caja);
  } catch (error) {
    aviso(error.message);
    return;
  }
  let contado = 0;
  let conteo = {};
  const fila = (izq, der, fuerte = false) => `<div class="item"><span>${izq}</span><span class="num">${fuerte ? `<strong>${der}</strong>` : der}</span></div>`;
  const $c = mostrar(`
    <h2>Cierre de caja${dueno ? ` · ${esc(dueno)}` : ""}</h2>
    <p class="suave" style="margin:0">Caja abierta el ${esc(fechaHora(c.desde))} con ${pesos(c.base)}. Solo cuenta lo que se cobró y se gastó en esta caja.</p>
    ${c.abiertas ? `<p class="error" style="margin:0">Hay ${c.abiertas} cuenta(s) abiertas sin cobrar. Puedes cerrar igual, pero no entran en el cierre.</p>` : ""}
    <div class="tarjetas" style="margin:0">
      <div class="tarjeta"><small>Cobrado (${c.cuentas} cuentas)</small><strong>${pesos(c.ventas)}</strong></div>
      <div class="tarjeta"><small>Gastos</small><strong>${pesos(c.gastos)}</strong></div>
    </div>
    <div>
      <strong>Dinero por método</strong>
      ${c.metodos.map((m) => fila(`${esc(m.metodo)} <small class="suave">(${m.pagos} ${m.pagos === 1 ? "pago" : "pagos"})</small>`, pesos(m.valor))).join("")}
      ${fila("Total recibido", pesos(c.metodos.reduce((s, m) => s + m.valor, 0)), true)}
    </div>
    <div>
      <strong>Efectivo en caja</strong>
      ${fila("Base de apertura", pesos(c.base))}
      ${fila("+ Cobros en efectivo", pesos(c.ventasEfectivo))}
      ${fila("− Gastos pagados en efectivo", pesos(c.gastosEfectivo))}
      ${fila("Debe haber", pesos(c.efectivoEsperado), true)}
    </div>
    <div><strong>Cuenta el efectivo de la caja</strong>
      <p class="suave" style="margin:2px 0 8px">Toca cada billete o moneda las veces que lo tengas.</p>
      <div id="contador-cierre" class="contador-efectivo"></div></div>
    <p id="diferencia" style="margin:0;font-weight:700"></p>
    ${pedirCodigo ? `<label>Tu código de caja<input id="codigo-cierre" type="password" inputmode="numeric" maxlength="8" autocomplete="off"
      placeholder="••••" style="font-size:22px;letter-spacing:6px;text-align:center"></label>` : ""}
    <div class="botones">
      <button type="button" id="cancelar-cierre">Cancelar</button>
      <button type="button" id="corte-cierre">Imprimir corte<br><small class="suave">sin cerrar la caja</small></button>
      <button type="button" class="principal" id="imprimir-cierre">${conSalida ? "Cerrar caja y salir" : "Cerrar caja"}</button>
    </div>`);
  const $dialogo = document.getElementById("dialogo");
  $dialogo.classList.add("ancho");
  $dialogo.addEventListener("close", () => $dialogo.classList.remove("ancho"), { once: true });
  const $diferencia = $c.querySelector("#diferencia");
  contadorEfectivo($c.querySelector("#contador-cierre"), (total, nuevo) => {
    contado = total;
    conteo = nuevo;
    if (!total) return ($diferencia.textContent = "");
    const d = total - c.efectivoEsperado;
    $diferencia.className = d === 0 ? "positivo" : d > 0 ? "suave" : "error";
    $diferencia.textContent = d === 0 ? "✓ La caja cuadra" : d > 0 ? `Te sobró ${pesos(d)}` : `Te faltó ${pesos(-d)}`;
  });
  const contadoFinal = () => (contado || Object.keys(conteo).length ? contado : null);
  $c.querySelector("#cancelar-cierre").addEventListener("click", cerrarDialogo);
  $c.querySelector("#corte-cierre").addEventListener("click", async () => {
    cerrarDialogo();
    await imprimir(ticketCierre(c, ctx.negocio, { usuario: ctx.perfil.nombre, dueno, contado: contadoFinal(), conteo, corte: true }));
    aviso("Corte de caja impreso (la caja sigue abierta)");
  });
  $c.querySelector("#imprimir-cierre").addEventListener("click", async (evento) => {
    const final = contadoFinal();
    if (final == null && !confirm("No contaste el efectivo. ¿Cerrar la caja igual?")) return;
    evento.currentTarget.disabled = true;
    try {
      await api.cerrarCaja(c.caja.id, final, conteo, c.efectivoEsperado, {
        ventas: c.ventas, cuentas: c.cuentas, gastos: c.gastos, base: c.base,
        ventas_efectivo: c.ventasEfectivo, gastos_efectivo: c.gastosEfectivo, metodos: c.metodos,
      }, $c.querySelector("#codigo-cierre")?.value ?? "");
    } catch (error) {
      aviso(error.message);
      evento.currentTarget.disabled = false;
      return;
    }
    if (c.caja.abierta_por === ctx.perfil.user_id) ctx.caja = null;
    cerrarDialogo();
    await imprimir(ticketCierre(c, ctx.negocio, { usuario: ctx.perfil.nombre, dueno, contado: final, conteo }));
    aviso("Caja cerrada");
    if (conSalida) await salir();
    else ctx.refrescar();
  });
}
