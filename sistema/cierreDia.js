// Cierre del día (solo administrador): junta todas las cajas del día (de 3:00 a. m. a 3:00 a. m.),
// el total por método, los gastos, el neto y los productos. Se confirma con la clave de un
// administrador; se puede imprimir y descargar en Excel. Si quedan cajas abiertas, se pueden cerrar.
import * as api from "./api.js";
import { esc, pesos, mostrar, cerrarDialogo, aviso } from "./util.js";
import { imprimir } from "./impresion.js";
import { calcularCierre } from "./cierre.js";
import { exportarVentasYGastos } from "./excel.js";

const suma = (lista, f) => lista.reduce((s, x) => s + Number(f(x) || 0), 0);
const hora = (iso) => (iso ? new Date(iso).toLocaleTimeString("es-CO", { hour: "numeric", minute: "2-digit" }) : "");
const textoDia = (dia) => new Date(`${dia}T12:00:00`).toLocaleDateString("es-CO", { weekday: "long", day: "numeric", month: "long", year: "numeric" });

// desde: si ya hubo un cierre del día hoy, solo lo de después.
async function resumenDia(dia, desde = null) {
  const inicioDia = new Date(`${dia}T03:00:00`);
  const inicio = desde ? new Date(desde) : inicioDia;
  const fin = new Date(inicioDia.getTime() + 86400000);
  const [cajas, personas, gastosDia] = await Promise.all([
    api.cajasEntre(inicio.toISOString(), fin.toISOString()), api.listaPersonas(), api.gastos(dia, dia),
  ]);
  const nombre = (id) => personas.find((p) => p.id === id)?.nombre ?? "—";
  const detalles = await Promise.all(cajas.map(async (c) => ({ c, r: await calcularCierre(c) })));
  const filas = detalles.map(({ c, r }) => {
    const esperado = c.esperado ?? r.efectivoEsperado;
    const diferencia = c.contado != null ? c.contado - esperado : null;
    return {
      persona: nombre(c.abierta_por), abierta_en: c.abierta_en, cerrada_en: c.cerrada_en, abierta: !c.cerrada_en,
      base: c.base, metodos: r.metodos, cobrado: r.ventas, gastos: r.gastos, esperado, contado: c.contado, diferencia,
      resultado: diferencia == null ? (c.cerrada_en ? "No se contó" : "Abierta")
        : diferencia === 0 ? "Cuadró" : diferencia > 0 ? `Sobró ${pesos(diferencia)}` : `Faltó ${pesos(-diferencia)}`,
      productos: r.productos,
    };
  });
  // Totales del día: todos los métodos, sumando las cajas.
  const metodos = [];
  for (const f of filas) {
    for (const m of f.metodos) {
      const t = metodos.find((x) => x.metodo === m.metodo) ?? metodos[metodos.push({ metodo: m.metodo, pagos: 0, valor: 0 }) - 1];
      t.pagos += m.pagos;
      t.valor += m.valor;
    }
  }
  // Gastos: los de las cajas y los registrados sin caja (desde Ventas y gastos).
  const gastosSinCaja = gastosDia.filter((g) => !g.caja_id);
  const gastos = suma(filas, (f) => f.gastos) + suma(gastosSinCaja, (g) => g.valor);
  const productos = new Map();
  for (const p of filas.flatMap((f) => f.productos)) {
    const t = productos.get(p.nombre) ?? { nombre: p.nombre, cantidad: 0, valor: 0 };
    t.cantidad += p.cantidad;
    t.valor += p.valor;
    productos.set(p.nombre, t);
  }
  const abiertas = (detalles[0]?.r ?? await calcularCierre(null)).abiertasLista;
  const cobrado = suma(filas, (f) => f.cobrado);
  return {
    dia, filas, metodos, cobrado, gastos, gastosSinCaja, neto: cobrado - gastos,
    productos: [...productos.values()].sort((a, b) => b.cantidad - a.cantidad),
    abiertas, cajasAbiertas: filas.filter((f) => f.abierta).length,
    sobrantes: suma(filas.filter((f) => f.diferencia > 0), (f) => f.diferencia),
    faltantes: suma(filas.filter((f) => f.diferencia < 0), (f) => -f.diferencia),
  };
}

function ticketCierreDia(r, negocio, usuario) {
  const fila = (izq, der, clase = "") => `<div class="t-fila ${clase}"><span>${izq}</span><span>${der}</span></div>`;
  return `<div class="ticket">
    <div class="t-centro t-negocio">${esc(negocio?.nombre ?? "")}</div>
    <div class="t-centro t-negocio">CIERRE DEL DÍA</div>
    <div class="t-centro">${esc(textoDia(r.dia))}</div>
    <div class="t-centro t-chico">Cerró ${esc(usuario)} · ${new Date().toLocaleString("es-CO", { dateStyle: "short", timeStyle: "short" })}</div>
    <hr>
    <div><strong>CAJAS (${r.filas.length})</strong></div>
    ${r.filas.map((f) => `${fila(`${esc(f.persona).slice(0, 18)} ${hora(f.abierta_en)}-${f.cerrada_en ? hora(f.cerrada_en) : "…"}`, pesos(f.cobrado))}
      <div class="t-chico">${fila("  Debía haber / contado", `${pesos(f.esperado)} / ${f.contado != null ? pesos(f.contado) : "—"}`)}${fila("  Resultado", esc(f.resultado))}</div>`).join("") || "<div>Sin cajas</div>"}
    <hr>
    <div><strong>DINERO POR MÉTODO</strong></div>
    ${r.metodos.map((m) => fila(`${esc(m.metodo)} (${m.pagos})`, pesos(m.valor))).join("")}
    ${fila("TOTAL COBRADO", pesos(r.cobrado), "t-total")}
    ${fila("Gastos", `−${pesos(r.gastos)}`)}
    ${fila("NETO DEL DÍA", pesos(r.neto), "t-total")}
    ${r.sobrantes || r.faltantes ? `<hr>${fila("Sobrantes en cajas", pesos(r.sobrantes))}${fila("Faltantes en cajas", `−${pesos(r.faltantes)}`)}` : ""}
    <hr>
    <div><strong>PRODUCTOS VENDIDOS</strong></div>
    ${r.productos.map((p) => fila(`${p.cantidad} × ${esc(p.nombre)}`, pesos(p.valor))).join("") || "<div>Ninguno</div>"}
    ${r.abiertas.length ? `<hr><div class="t-centro"><strong>OJO: ${r.abiertas.length} cuenta(s) sin cobrar</strong></div>
      ${r.abiertas.map((x) => fila(esc(x.nombre).slice(0, 28), pesos(x.total))).join("")}` : ""}
    <hr>
    <div class="t-centro t-chico">Firma: ______________________</div>
  </div>`;
}

export async function abrirCierreDia(ctx, dia, desde = null) {
  let r;
  try {
    r = await resumenDia(dia, desde);
  } catch (error) {
    aviso(error.message);
    return;
  }
  const fila = (izq, der, fuerte = false) => `<div class="item"><span>${izq}</span><span class="num">${fuerte ? `<strong>${der}</strong>` : der}</span></div>`;
  const $c = mostrar(`
    <h2>Cierre del día · ${esc(textoDia(dia))}</h2>
    <p class="suave" style="margin:0">Junta todas las cajas del día. Solo el administrador lo hace, con su clave. Al cerrar, <strong>todo se reinicia</strong>:
      se cierran todas las cajas y los domicilios vuelven a #1. «Ventas y gastos» no se toca.</p>
    <div class="tarjetas" style="margin:0">
      <div class="tarjeta"><small>Cobrado en el día</small><strong>${pesos(r.cobrado)}</strong></div>
      <div class="tarjeta"><small>Gastos</small><strong class="negativo">−${pesos(r.gastos)}</strong></div>
      <div class="tarjeta"><small>Neto del día</small><strong>${pesos(r.neto)}</strong></div>
      <div class="tarjeta"><small>Cajas</small><strong>${r.filas.length}</strong></div>
    </div>
    <div class="columnas" style="margin:0">
      <div><strong>Dinero por método (todas las cajas)</strong>
        ${r.metodos.map((m) => fila(`${esc(m.metodo)} <small class="suave">(${m.pagos})</small>`, pesos(m.valor))).join("")}
        ${fila("Total cobrado", pesos(r.cobrado), true)}</div>
      <div><strong>Cajas</strong>
        ${r.filas.map((f) => fila(`${esc(f.persona)} <small class="suave">${hora(f.abierta_en)}–${f.cerrada_en ? hora(f.cerrada_en) : "abierta"}</small><br>
          <small class="${f.diferencia < 0 ? "negativo" : "suave"}">${esc(f.resultado)}</small>`, pesos(f.cobrado))).join("") || `<p class="suave">No hubo cajas.</p>`}</div>
    </div>
    ${r.cajasAbiertas ? `<p class="error" style="margin:0">${r.cajasAbiertas} caja(s) siguen abiertas: se cerrarán con el cierre del día (sin conteo). Si quieres contarlas, ciérralas antes una por una.</p>` : ""}
    ${r.abiertas.length ? `<p class="error" style="margin:0">${r.abiertas.length} cuenta(s) siguen sin cobrar: ${r.abiertas.map((x) => esc(x.nombre)).join(", ")}.</p>` : ""}
    <label>Tu clave de administrador<input id="clave-dia" type="password" inputmode="numeric" maxlength="8" autocomplete="off"
      placeholder="••••" style="font-size:22px;letter-spacing:6px;text-align:center"></label>
    <label class="opcion"><input type="checkbox" id="dia-imprimir" checked> Imprimir el cierre del día</label>
    <label class="opcion"><input type="checkbox" id="dia-excel"> Descargar el cierre del día en Excel</label>
    <div class="botones">
      <button type="button" id="cancelar-dia">Cancelar</button>
      <button type="button" class="principal" id="confirmar-dia">Cerrar el día</button>
    </div>`);
  const $dialogo = document.getElementById("dialogo");
  $dialogo.classList.add("ancho");
  $dialogo.addEventListener("close", () => $dialogo.classList.remove("ancho"), { once: true });
  setTimeout(() => $c.querySelector("#clave-dia").focus(), 50);
  $c.querySelector("#cancelar-dia").addEventListener("click", cerrarDialogo);
  $c.querySelector("#confirmar-dia").addEventListener("click", async (evento) => {
    const $b = evento.currentTarget;
    const clave = $c.querySelector("#clave-dia").value.trim();
    if (!clave) return aviso("Escribe tu clave de administrador");
    const imprimirlo = $c.querySelector("#dia-imprimir").checked;
    const excel = $c.querySelector("#dia-excel").checked;
    $b.disabled = true;
    $b.textContent = "Cerrando…";
    try {
      await api.cerrarDia(dia, clave, {
        cobrado: r.cobrado, gastos: r.gastos, neto: r.neto, metodos: r.metodos, cajas: r.filas.length,
        sobrantes: r.sobrantes, faltantes: r.faltantes,
      }, true);
    } catch (error) {
      aviso(error.message);
      $b.disabled = false;
      $b.textContent = "Cerrar el día";
      return;
    }
    cerrarDialogo();
    aviso("Día cerrado: todo quedó en cero para empezar de nuevo");
    if (imprimirlo) await imprimir(ticketCierreDia(r, ctx.negocio, ctx.perfil.nombre));
    if (excel) {
      try {
        const [cerrados, gastos, mesas, equipo, miembros] = await Promise.all([
          api.pedidosCerrados(dia, dia), api.gastos(dia, dia), api.mesas(), api.equipo(), api.miembros(),
        ]);
        const nombreCuenta = (p) => (p.tipo === "mesa" ? p.mesa_nombre ?? mesas.find((m) => m.id === p.mesa_id)?.nombre ?? "Mesa"
          : `Domicilio #${p.numero_domicilio ?? p.numero} · ${p.cliente}`);
        await exportarVentasYGastos({
          desde: dia, hasta: dia, cerrados, gastos, nombreCuenta, negocio: ctx.negocio, admin: true, menu: ctx.menu,
          equipo, miembros, cajasDia: r.filas, nombreArchivo: `Cierre del día ${dia}`,
        });
      } catch {
        aviso("No se pudo crear el Excel. Revisa tu conexión y descárgalo desde Ventas y gastos.");
      }
    }
    ctx.refrescar();
  });
}
