// Servicio: mapa de mesas, domicilios y la cuenta de cada uno (tomar pedido, cocina, cobro).
import * as api from "../api.js";
import { esc, pesos, opciones, formulario, mostrar, cerrarDialogo, hora, minutosDesde, aviso } from "../util.js";
import { preferencia, guardarPreferencia, imprimir, ticketCuenta } from "../impresion.js";

const METODOS = ["Efectivo", "Tarjeta", "Transferencia", "Nequi", "Daviplata"];
const PROPINA_SUGERIDA = 0.1;
const ENTREGAS = [["preparando", "Preparando"], ["en_camino", "En camino"], ["entregado", "Entregado"]];
const ESTADO_ITEM = { nuevo: "Sin enviar", cocina: "En cocina", listo: "¡Listo!", entregado: "Entregado" };

const subtotal = (p) => p.pedido_items.reduce((s, i) => s + i.precio * i.cantidad, 0);
const totalCuenta = (p) => subtotal(p) + (p.envio || 0);
const totalMostrado = (p) => (p.estado === "abierto" ? totalCuenta(p) : p.total);
const puedeCobrar = (rol) => rol === "admin" || rol === "cajero";

// Mesas

export async function mesas($vista, ctx) {
  const [lista, abiertos] = await Promise.all([api.mesas(), api.pedidosAbiertos()]);
  const porMesa = new Map(abiertos.filter((p) => p.mesa_id).map((p) => [p.mesa_id, p]));
  const tarjetas = lista.map((m) => {
    const p = porMesa.get(m.id);
    if (!p) {
      return `<button class="mesa libre" data-mesa="${m.id}"><strong>${esc(m.nombre)}</strong><span>Libre</span></button>`;
    }
    const listos = p.pedido_items.some((i) => i.estado === "listo");
    const sinEnviar = p.pedido_items.some((i) => i.estado === "nuevo");
    return `<button class="mesa ocupada ${listos ? "listo" : ""}" data-mesa="${m.id}">
      <strong>${esc(m.nombre)}</strong>
      <span>${pesos(totalCuenta(p))}</span>
      <small>${minutosDesde(p.creado)} min${listos ? " · ¡Platos listos!" : sinEnviar ? " · Sin enviar" : ""}</small>
    </button>`;
  });
  $vista.innerHTML = `
    <div class="encabezado"><h1>Mesas</h1>
      ${ctx.perfil.rol === "admin" ? `<button id="editar-mesas">Editar mesas</button>` : ""}</div>
    ${lista.length ? `<div class="mesas">${tarjetas.join("")}</div>`
      : `<p class="vacio">${ctx.perfil.rol === "admin" ? "Crea tus mesas con «Editar mesas»." : "El administrador todavía no ha creado mesas."}</p>`}`;

  $vista.querySelectorAll("[data-mesa]").forEach(($b) =>
    $b.addEventListener("click", async () => {
      $b.disabled = true;
      try {
        ctx.ir(`pedido/${await api.abrirMesa($b.dataset.mesa)}`);
      } catch (error) {
        aviso(error.message);
        $b.disabled = false;
      }
    })
  );
  document.getElementById("editar-mesas")?.addEventListener("click", () => editarMesas(lista, ctx));
}

function editarMesas(lista, ctx) {
  const $c = mostrar(`<h2>Mesas</h2>
    <div class="lista">${lista.map((m) => `<div class="fila-lista">
      <input value="${esc(m.nombre)}" data-renombrar="${m.id}" aria-label="Nombre">
      <button class="chico peligro" data-borrar="${m.id}">Borrar</button></div>`).join("")}</div>
    <div class="fila-lista"><input id="nueva-mesa" placeholder="Nueva mesa, ej. Mesa 5"><button class="principal" id="agregar-mesa">Agregar</button></div>
    <p class="error" hidden></p>
    <div class="botones"><button id="listo-mesas">Listo</button></div>`);
  const fallo = (e) => {
    const $e = $c.querySelector(".error");
    $e.textContent = e.message;
    $e.hidden = false;
  };
  const recargar = async () => editarMesas(await api.mesas(), ctx);
  $c.querySelector("#agregar-mesa").addEventListener("click", async () => {
    const nombre = $c.querySelector("#nueva-mesa").value.trim();
    if (!nombre) return;
    try {
      await api.guardar("mesas", { nombre, orden: lista.length + 1 });
      await recargar();
    } catch (e) { fallo(e); }
  });
  $c.querySelectorAll("[data-renombrar]").forEach(($i) =>
    $i.addEventListener("change", () =>
      api.guardar("mesas", { id: $i.dataset.renombrar, nombre: $i.value.trim() || "Mesa" }).catch(fallo)
    )
  );
  $c.querySelectorAll("[data-borrar]").forEach(($b) =>
    $b.addEventListener("click", async () => {
      if (!confirm("¿Borrar esta mesa?")) return;
      try {
        await api.borrar("mesas", $b.dataset.borrar);
        await recargar();
      } catch (e) { fallo(e); }
    })
  );
  $c.querySelector("#listo-mesas").addEventListener("click", () => {
    cerrarDialogo();
    ctx.refrescar();
  });
}

// Domicilios

export async function domicilios($vista, ctx) {
  const abiertos = (await api.pedidosAbiertos()).filter((p) => p.tipo === "domicilio");
  const equipo = await api.equipo();
  const nombreDe = (id) => equipo.find((e) => e.id === id)?.nombre ?? "Sin asignar";
  const textoEntrega = Object.fromEntries(ENTREGAS);
  const filas = abiertos.map((p) => `<button class="domicilio" data-pedido="${p.id}">
      <span><strong>#${p.numero} ${esc(p.cliente)}</strong><br><small class="suave">${esc(p.direccion)}</small></span>
      <span class="num"><strong>${pesos(totalCuenta(p))}</strong><br>
        <small class="etiqueta">${textoEntrega[p.entrega] ?? ""}</small> <small class="suave">${esc(nombreDe(p.domiciliario_id))}</small></span>
    </button>`);
  $vista.innerHTML = `
    <div class="encabezado"><h1>Domicilios</h1><button class="principal" id="nuevo-domicilio">Nuevo domicilio</button></div>
    ${filas.length ? `<div class="lista-domicilios">${filas.join("")}</div>` : `<p class="vacio">No hay domicilios pendientes.</p>`}`;
  $vista.querySelectorAll("[data-pedido]").forEach(($b) =>
    $b.addEventListener("click", () => ctx.ir(`pedido/${$b.dataset.pedido}`))
  );
  document.getElementById("nuevo-domicilio").addEventListener("click", () => {
    let creado = null;
    formulario("Nuevo domicilio", `
      <div class="fila">
        <label>Cliente<input name="cliente" autocomplete="off"></label>
        <label>Teléfono<input name="telefono" type="tel"></label>
      </div>
      <label>Dirección<input name="direccion"></label>
      <div class="fila">
        <label>Valor del envío<input name="envio" type="number" min="0" step="100" value="0"></label>
        <label>Domiciliario<select name="domiciliario"><option value="">Sin asignar</option>${opciones(equipo.map((e) => [e.id, e.nombre]))}</select></label>
      </div>
      <label>Notas<input name="notas" placeholder="Ej. timbre dañado, pagar con billete de 50"></label>`,
      async (c) => { creado = await api.crearDomicilio(c); },
      { boton: "Crear y tomar pedido", alTerminar: () => ctx.ir(`pedido/${creado}`) });
  });
}

// Cuenta de una mesa o un domicilio

export async function cuenta($vista, ctx, pedidoId) {
  const [p, listaMesas, equipo] = await Promise.all([api.pedido(pedidoId), api.mesas(), api.equipo()]);
  if (!p) {
    $vista.innerHTML = `<p class="vacio">Esa cuenta no existe.</p>`;
    return;
  }
  const rol = ctx.perfil.rol;
  const titulo = p.tipo === "mesa"
    ? listaMesas.find((m) => m.id === p.mesa_id)?.nombre ?? "Mesa"
    : `Domicilio #${p.numero}`;
  const abierta = p.estado === "abierto";
  const items = [...p.pedido_items].sort((a, b) => a.creado.localeCompare(b.creado));
  const hay = (estado) => items.some((i) => i.estado === estado);

  const filasItems = items.map((i) => {
    const puedeQuitar = abierta && (i.estado === "nuevo" || puedeCobrar(rol));
    const detalle = [...i.opciones.map((o) => o.nombre), i.nota].filter(Boolean).join(" · ");
    return `<div class="item">
      <div><strong>${i.cantidad}× ${esc(i.nombre)}</strong>${detalle ? `<br><small class="suave">${esc(detalle)}</small>` : ""}
        <br><small class="etiqueta estado-${i.estado}">${ESTADO_ITEM[i.estado]}</small></div>
      <div class="num">${pesos(i.precio * i.cantidad)}
        ${puedeQuitar ? `<br><button class="chico peligro" data-quitar="${i.id}" aria-label="Quitar">Quitar</button>` : ""}</div>
    </div>`;
  }).join("");

  const domicilio = p.tipo === "domicilio" ? `<div class="panel">
      <p style="margin:0 0 8px"><strong>${esc(p.cliente)}</strong> · ${esc(p.telefono)}<br>${esc(p.direccion)}
        ${p.notas ? `<br><small class="suave">${esc(p.notas)}</small>` : ""}</p>
      ${abierta && puedeCobrar(rol) ? `<div class="fila">
        <label>Estado<select id="entrega">${opciones(ENTREGAS, p.entrega)}</select></label>
        <label>Domiciliario<select id="domiciliario"><option value="">Sin asignar</option>${opciones(equipo.map((e) => [e.id, e.nombre]), p.domiciliario_id ?? "")}</select></label>
      </div>` : ""}
    </div>` : "";

  const estadoCerrada = p.estado === "pagado"
    ? `Pagada con ${esc(p.metodo_pago)} a las ${hora(p.cerrado)}${p.propina ? ` · propina ${pesos(p.propina)}` : ""}`
    : `Anulada${p.motivo_anulacion ? `: ${esc(p.motivo_anulacion)}` : ""}`;

  $vista.innerHTML = `
    <div class="encabezado">
      <h1><a href="#${p.tipo === "mesa" ? "mesas" : "domicilios"}" class="volver" aria-label="Volver">←</a> ${esc(titulo)}</h1>
      ${abierta ? "" : `<span class="etiqueta">${estadoCerrada}</span>`}
    </div>
    <div class="cuenta">
      ${abierta ? `<div class="carta">${carta(ctx.menu)}</div>` : ""}
      <div class="resumen">
        ${domicilio}
        <div class="panel">
          ${items.length ? filasItems : `<p class="vacio">Toca un plato para agregarlo.</p>`}
          ${p.envio ? `<div class="item"><span>Envío</span><span class="num">${pesos(p.envio)}</span></div>` : ""}
          <div class="total"><span>Total</span><span>${pesos(totalMostrado(p))}</span></div>
        </div>
        ${abierta ? `<div class="acciones-cuenta">
          ${hay("nuevo") ? `<button class="principal" id="enviar">Enviar a cocina</button>` : ""}
          ${hay("listo") && rol !== "cocina" ? `<button id="entregar">Marcar entregados</button>` : ""}
          ${items.length ? `<button id="precuenta">Imprimir cuenta</button>` : ""}
          ${puedeCobrar(rol) && items.length ? `<button class="principal" id="cobrar">Cobrar</button>` : ""}
          ${rol === "admin" ? `<button class="peligro" id="anular">Anular cuenta</button>` : ""}
        </div>` : `<div class="acciones-cuenta">
          <button id="imprimir">Imprimir</button>
          ${rol === "admin" && p.estado === "pagado" ? `<button class="peligro" id="anular">Anular venta</button>` : ""}
        </div>`}
      </div>
    </div>`;

  const hecho = (promesa, mensaje) =>
    promesa.then(() => { if (mensaje) aviso(mensaje); ctx.refrescar(); }).catch((e) => aviso(e.message));

  $vista.querySelectorAll("[data-plato]").forEach(($b) =>
    $b.addEventListener("click", () => elegirPlato(ctx, p.id, $b.dataset.plato))
  );
  $vista.querySelectorAll("[data-categoria]").forEach(($b) =>
    $b.addEventListener("click", () => {
      $vista.querySelectorAll("[data-categoria]").forEach(($o) => $o.classList.toggle("activo", $o === $b));
      $vista.querySelectorAll("[data-de]").forEach(($pl) => ($pl.hidden = $b.dataset.categoria !== "*" && $pl.dataset.de !== $b.dataset.categoria));
    })
  );
  $vista.querySelectorAll("[data-quitar]").forEach(($b) =>
    $b.addEventListener("click", () => hecho(api.quitarItem($b.dataset.quitar)))
  );
  document.getElementById("enviar")?.addEventListener("click", () => hecho(api.enviarCocina(p.id), "Enviado a cocina"));
  document.getElementById("entregar")?.addEventListener("click", () => hecho(api.marcarItems(p.id, "listo", "entregado")));
  const ticket = () => ticketCuenta(p, ctx.negocio, { mesa: titulo });
  document.getElementById("cobrar")?.addEventListener("click", () => formularioCobro(ctx, p, titulo));
  document.getElementById("precuenta")?.addEventListener("click", () => imprimir(ticket()));
  document.getElementById("imprimir")?.addEventListener("click", () => imprimir(ticket()));
  document.getElementById("anular")?.addEventListener("click", () => {
    const motivo = prompt("¿Por qué se anula? (Si ya estaba pagada, el inventario se devuelve)");
    if (motivo === null) return;
    hecho(api.anular(p.id, motivo), "Cuenta anulada");
  });
  const $entrega = document.getElementById("entrega");
  const $domiciliario = document.getElementById("domiciliario");
  [$entrega, $domiciliario].forEach(($s) =>
    $s?.addEventListener("change", () => hecho(api.actualizarDomicilio(p.id, $entrega.value, $domiciliario.value)))
  );
}

function carta(menu) {
  const disponibles = menu.platos.filter((pl) => pl.activo);
  if (!disponibles.length) return `<p class="vacio">El menú está vacío. El administrador lo crea en «Menú y recetas».</p>`;
  const categorias = menu.categorias.filter((c) => disponibles.some((pl) => pl.categoria_id === c.id));
  const sinCategoria = disponibles.some((pl) => !categorias.some((c) => c.id === pl.categoria_id));
  return `<div class="pestanas">
      <button class="activo" data-categoria="*">Todo</button>
      ${categorias.map((c) => `<button data-categoria="${c.id}">${esc(c.nombre)}</button>`).join("")}
      ${sinCategoria ? `<button data-categoria="">Otros</button>` : ""}
    </div>
    <div class="platos">${disponibles.map((pl) => `<button class="plato" data-plato="${pl.id}" data-de="${categorias.some((c) => c.id === pl.categoria_id) ? pl.categoria_id : ""}">
      <strong>${esc(pl.nombre)}</strong><span>${pesos(pl.precio)}</span></button>`).join("")}</div>`;
}

// Al tocar un plato: si no tiene modificadores se agrega de una; si tiene, se eligen primero.
function elegirPlato(ctx, pedidoId, platoId) {
  const { platos, grupos, opciones: todas, platoGrupos } = ctx.menu;
  const plato = platos.find((pl) => pl.id === platoId);
  const susGrupos = grupos.filter((g) => platoGrupos.some((pg) => pg.plato_id === platoId && pg.grupo_id === g.id));
  if (!susGrupos.length) {
    api.agregarItem(pedidoId, platoId, 1, [], "")
      .then(() => { aviso(`${plato.nombre} agregado`); ctx.refrescar(); })
      .catch((e) => aviso(e.message));
    return;
  }
  const bloques = susGrupos.map((g) => {
    const tipo = g.maximo === 1 ? "radio" : "checkbox";
    const regla = `${g.obligatorio ? "Obligatorio" : "Opcional"}${g.maximo > 1 ? ` · hasta ${g.maximo}` : ""}`;
    const items = todas.filter((o) => o.grupo_id === g.id).map((o) => `<label class="opcion">
        <input type="${tipo}" name="g-${g.id}" value="${o.id}"> ${esc(o.nombre)}${o.precio ? ` <span class="suave">+${pesos(o.precio)}</span>` : ""}
      </label>`).join("");
    return `<fieldset><legend>${esc(g.nombre)} <small class="suave">${regla}</small></legend>${items}</fieldset>`;
  }).join("");
  formulario(esc(plato.nombre), `${bloques}
    <div class="fila">
      <label>Cantidad<input name="cantidad" type="number" min="1" step="1" value="1"></label>
      <label>Nota<input name="nota" placeholder="Ej. sin cebolla"></label>
    </div>`,
    (c, $form) => {
      const elegidas = [...$form.querySelectorAll("fieldset input:checked")].map(($i) => $i.value);
      return api.agregarItem(pedidoId, platoId, Number(c.cantidad), elegidas, c.nota);
    },
    { boton: "Agregar", alTerminar: () => ctx.refrescar() });
}

function formularioCobro(ctx, p, titulo) {
  const total = totalCuenta(p);
  let cobro = null;
  const $form = formulario(`Cobrar ${pesos(total)}`, `
    <label>Método de pago<select name="metodo">${opciones(METODOS)}</select></label>
    <div class="fila">
      <label>Propina<input name="propina" type="number" min="0" step="100" value="0"></label>
      <label>Recibido (efectivo)<input name="recibido" type="number" min="0" step="100"></label>
    </div>
    <button type="button" id="sugerida">Agregar propina sugerida (${PROPINA_SUGERIDA * 100}%)</button>
    <div class="total"><span>Total a recibir</span><span id="a-recibir">${pesos(total)}</span></div>
    <p class="suave" id="cambio" style="margin:0"></p>
    <label class="opcion"><input type="checkbox" name="imprimir"${preferencia("cuenta") ? " checked" : ""}> Imprimir la cuenta</label>`,
    async (c) => {
      await api.cobrar(p.id, c.metodo, c.propina);
      cobro = c;
    },
    {
      boton: "Confirmar pago",
      alTerminar: async () => {
        guardarPreferencia("cuenta", Boolean(cobro.imprimir));
        aviso("Cuenta cobrada");
        if (cobro.imprimir) {
          // Se imprime la cuenta ya cerrada, tal como quedó guardada (total, propina y método).
          const cerrada = await api.pedido(p.id);
          await imprimir(ticketCuenta(cerrada, ctx.negocio, { mesa: titulo, recibido: Number(cobro.recibido) || 0 }));
        }
        ctx.ir(p.tipo === "mesa" ? "mesas" : "domicilios");
      },
    });
  const actualizar = () => {
    const propina = Number($form.propina.value) || 0;
    const recibido = Number($form.recibido.value) || 0;
    $form.querySelector("#a-recibir").textContent = pesos(total + propina);
    $form.querySelector("#cambio").textContent = recibido ? `Cambio: ${pesos(recibido - total - propina)}` : "";
  };
  $form.addEventListener("input", actualizar);
  $form.querySelector("#sugerida").addEventListener("click", () => {
    $form.propina.value = Math.round((subtotal(p) * PROPINA_SUGERIDA) / 100) * 100;
    actualizar();
  });
}
