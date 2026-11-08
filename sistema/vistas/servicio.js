// Servicio: mapa de mesas, domicilios y la cuenta de cada uno (tomar pedido, cocina, cobro).
import * as api from "../api.js";
import { esc, pesos, opciones, formulario, mostrar, cerrarDialogo, hora, minutosDesde, aviso, tarjeta as tarjetaResumen } from "../util.js";
import { preferencia, guardarPreferencia, imprimir, ticketCuenta } from "../impresion.js";

const METODOS = ["Efectivo", "Tarjeta", "Transferencia", "Nequi", "Daviplata"];
// Un domicilio solo tiene estos valores de envío.
const ENVIOS = [[0, "Sin envío"], [1000, "$ 1.000"], [2000, "$ 2.000"]];
// Sin estado = se está tomando el pedido; al facturarlo pasa a preparación.
const ENTREGA = { preparando: "En preparación", en_camino: "En camino", entregado: "Entregado" };
const textoEntrega = (p) => (p.entrega ? ENTREGA[p.entrega] : "Tomando pedido");
// Quién cambia el estado, las novedades y lo recibido de un domicilio ya enviado a cocina.
const puedeEntregar = (rol, p) =>
  p.estado !== "anulado" && Boolean(p.entrega) && ["admin", "cajero", "domiciliario"].includes(rol);
// Botones de estado: se puede pasar a cualquiera, incluso de "preparando" directo a "entregado".
const botonesEntrega = (p) => Object.entries(ENTREGA).map(([valor, texto]) => p.entrega === valor
  ? `<button class="chico principal" disabled>${texto}</button>`
  : `<button class="chico" data-pedido="${p.id}" data-entrega="${valor}">${texto}</button>`).join("");

// Cambia el estado desde cualquier botón con data-entrega.
function activarBotonesEntrega($raiz, ctx) {
  $raiz.querySelectorAll("[data-entrega]").forEach(($b) =>
    $b.addEventListener("click", async () => {
      $b.disabled = true;
      try {
        await api.cambiarEntrega($b.dataset.pedido, $b.dataset.entrega);
        aviso(`Domicilio: ${ENTREGA[$b.dataset.entrega].toLowerCase()}`);
        ctx.refrescar();
      } catch (error) {
        aviso(error.message);
        $b.disabled = false;
      }
    })
  );
}
const ESTADO_ITEM = { nuevo: "Sin enviar", cocina: "Preparando", listo: "Preparando", entregado: "Entregado" };

const subtotal = (p) => p.pedido_items.reduce((s, i) => s + i.precio * i.cantidad, 0);
const totalCuenta = (p) => subtotal(p) + (p.envio || 0);
const totalMostrado = (p) => (p.estado === "abierto" ? totalCuenta(p) : p.total);
const platosEnCuenta = (items) => {
  const n = items.reduce((s, i) => s + i.cantidad, 0);
  return `${n} ${n === 1 ? "plato" : "platos"}`;
};
const puedeCobrar = (rol) => rol === "admin" || rol === "cajero";

// Mesas

export async function mesas($vista, ctx) {
  const [lista, abiertos] = await Promise.all([api.mesas(), api.pedidosAbiertos()]);
  const porMesa = new Map(abiertos.filter((p) => p.mesa_id).map((p) => [p.mesa_id, p]));
  const tarjetas = lista.map((m) => {
    const p = porMesa.get(m.id);
    if (!p) {
      return `<button class="mesa libre" data-mesa="${m.id}"><strong>${esc(m.nombre)}</strong><span class="estado-mesa">Libre</span></button>`;
    }
    const listos = p.pedido_items.some((i) => i.estado === "listo");
    const sinEnviar = p.pedido_items.some((i) => i.estado === "nuevo");
    return `<button class="mesa ocupada ${listos ? "listo" : ""}" data-mesa="${m.id}">
      <strong>${esc(m.nombre)}</strong>
      <span class="total-mesa">${pesos(totalCuenta(p))}</span>
      <small>${minutosDesde(p.creado)} min${p.para_llevar ? " · Para llevar" : ""}${listos ? " · ¡Platos listos!" : sinEnviar ? " · Sin enviar" : ""}</small>
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
  const rol = ctx.perfil.rol;
  const domiciliario = rol === "domiciliario";
  const yo = domiciliario ? await api.miEmpleado() : null;
  const [pendientes, equipo, historial] = await Promise.all([
    api.domiciliosPendientes(), api.equipo(), yo ? api.historialEntregas(yo) : [],
  ]);
  const nombreDe = (id) => equipo.find((e) => e.id === id)?.nombre;
  // En marcha: ya se enviaron a cocina. Se cobran cuando el cliente paga, antes o después de entregar.
  const porEntregar = pendientes.filter((p) => p.entrega === "preparando" || p.entrega === "en_camino");
  const porCobrar = pendientes.filter((p) => p.estado === "abierto" && p.entrega === "entregado");
  const tomando = pendientes.filter((p) => p.estado === "abierto" && !p.entrega);

  const tarjeta = (p) => `<div class="domicilio">
      <span><strong>#${p.numero_domicilio ?? p.numero} ${esc(p.cliente)}</strong>
        ${p.direccion ? `<br><small class="suave">${esc(p.direccion)}</small>` : ""}
        ${p.telefono ? `<br><small><a href="tel:${esc(p.telefono)}">${esc(p.telefono)}</a></small>` : ""}
        ${p.notas ? `<br><small class="suave">Ref.: ${esc(p.notas)}</small>` : ""}
        ${p.novedades ? `<br><small class="error">Tiene novedades</small>` : ""}</span>
      <span class="num"><strong>${pesos(totalMostrado(p))}</strong><br>
        <small class="etiqueta">${textoEntrega(p)}</small>
        ${p.estado === "abierto" && p.entrega ? `<small class="etiqueta">Sin cobrar</small>` : ""}
        ${!domiciliario && nombreDe(p.domiciliario_id) ? `<small class="suave">${esc(nombreDe(p.domiciliario_id))}</small>` : ""}
        ${p.entrega === "entregado" ? `<br><small class="suave">${hora(p.entregado_en)}${p.recibido != null ? ` · recibió ${pesos(p.recibido)}` : ""}</small>` : ""}
        <span class="botones-domicilio">
          ${puedeEntregar(rol, p) && p.entrega !== "entregado"
            ? `${p.entrega === "preparando" ? `<button class="chico" data-pedido="${p.id}" data-entrega="en_camino">En camino</button>` : ""}
               <button class="chico principal" data-pedido="${p.id}" data-entrega="entregado">Entregado</button>` : ""}
          <a class="boton chico" href="#pedido/${p.id}">${p.estado === "abierto" && !domiciliario ? "Abrir / agregar" : "Ver"}</a>
        </span></span>
    </div>`;
  const lista = (pedidos, vacio) => pedidos.length
    ? `<div class="lista-domicilios">${pedidos.map(tarjeta).join("")}</div>`
    : `<p class="vacio">${vacio}</p>`;
  const suma = (pedidos) => pedidos.reduce((s, p) => s + (totalMostrado(p) ?? 0), 0);

  if (domiciliario) {
    const mios = porEntregar.filter((p) => p.domiciliario_id === yo);
    const libres = porEntregar.filter((p) => !p.domiciliario_id);
    const hoy = new Date().toDateString();
    const deHoy = historial.filter((p) => new Date(p.entregado_en).toDateString() === hoy);
    $vista.innerHTML = `
      <div class="encabezado"><h1>Mis domicilios</h1><small class="suave">Se actualiza solo</small></div>
      ${yo ? "" : `<div class="panel"><p class="error" style="margin:0">Tu usuario no está ligado a una ficha de empleado:
        no puedes tomar domicilios. Pídele al administrador que te dé el acceso desde «Empleados».</p></div>`}
      <div class="tarjetas">
        ${tarjetaResumen(`Por entregar (${mios.length})`, pesos(suma(mios)))}
        ${tarjetaResumen(`Entregados hoy (${deHoy.length})`, pesos(suma(deHoy)))}
      </div>
      <h2>Asignados a mí (${mios.length})</h2>
      ${lista(mios, "No tienes domicilios asignados.")}
      <h2>Sin asignar (${libres.length})</h2>
      <p class="suave" style="margin-top:-6px">Si cambias el estado de uno de estos, queda a tu nombre.</p>
      ${lista(libres, "No hay domicilios sin asignar.")}
      <h2>Mi historial de entregas</h2>
      ${lista(historial, "Todavía no has entregado domicilios.")}`;
    activarBotonesEntrega($vista, ctx);
    return;
  }

  $vista.innerHTML = `
    <div class="encabezado"><h1>Domicilios</h1><button class="principal" id="nuevo-domicilio">Nuevo domicilio</button></div>
    <h2>Tomando pedido (${tomando.length})</h2>
    <p class="suave" style="margin-top:-6px">Agrega los platos y dale «Enviar a cocina» para que salga la comanda.</p>
    ${lista(tomando, "No hay domicilios tomándose.")}
    <h2>Por entregar (${porEntregar.length})</h2>
    ${lista(porEntregar, "No hay domicilios por entregar.")}
    <h2>Entregados sin cobrar (${porCobrar.length})</h2>
    ${lista(porCobrar, "No hay domicilios pendientes por cobrar.")}`;
  activarBotonesEntrega($vista, ctx);
  document.getElementById("nuevo-domicilio")?.addEventListener("click", () => {
    let creado = null;
    formulario("Nuevo domicilio", `
      <div class="fila">
        <label>Cliente<input name="cliente" autocomplete="off"></label>
        <label>Teléfono (opcional)<input name="telefono" type="tel"></label>
      </div>
      <label>Dirección (opcional)<input name="direccion"></label>
      <div class="fila">
        <label>Envío<select name="envio">${opciones(ENVIOS, 0)}</select></label>
        <label>Domiciliario<select name="domiciliario"><option value="">Sin asignar</option>${opciones(equipo.map((e) => [e.id, e.nombre]))}</select></label>
      </div>
      <label>Referencias<input name="notas" placeholder="Ej. casa azul, timbre dañado, paga con billete de 50"></label>`,
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
    : `Domicilio #${p.numero_domicilio ?? p.numero}`;
  const abierta = p.estado === "abierto";
  const items = [...p.pedido_items].sort((a, b) => a.creado.localeCompare(b.creado));
  const hay = (estado) => items.some((i) => i.estado === estado);

  // El domiciliario ve los domicilios pero no les cambia platos ni los cobra.
  const soloLectura = rol === "domiciliario" && p.tipo === "domicilio";
  const pagos = [...(p.pagos ?? [])].sort((a, b) => a.fecha.localeCompare(b.fecha));
  const pagado = pagos.reduce((s, x) => s + x.valor, 0);
  const metodoDe = (pagoId) => pagos.find((x) => x.id === pagoId)?.metodo ?? "";
  const filasItems = items.map((i) => {
    const puedeQuitar = abierta && !soloLectura && !i.pago_id && (i.estado === "nuevo" || puedeCobrar(rol));
    const detalle = [...i.opciones.map((o) => o.nombre), i.nota].filter(Boolean).join(" · ");
    return `<div class="item">
      <div><strong>${i.cantidad}× ${esc(i.nombre)}</strong>${detalle ? `<br><small class="suave">${esc(detalle)}</small>` : ""}
        <br><small class="etiqueta estado-${i.estado}">${ESTADO_ITEM[i.estado]}</small>
        ${abierta && i.pago_id ? `<small class="etiqueta estado-listo">Pagado · ${esc(metodoDe(i.pago_id))}</small>` : ""}</div>
      <div class="num">${pesos(i.precio * i.cantidad)}
        ${puedeQuitar ? `<br><button class="chico peligro" data-quitar="${i.id}" aria-label="Quitar">Quitar</button>` : ""}</div>
    </div>`;
  }).join("");

  const esDomicilio = p.tipo === "domicilio";
  const entrega = esDomicilio && puedeEntregar(rol, p);
  const cambio = p.recibido != null ? p.recibido - totalMostrado(p) : 0;
  const domicilio = esDomicilio ? `<div class="panel">
      <p style="margin:0 0 8px"><strong>${esc(p.cliente)}</strong>
        ${p.telefono ? ` · <a href="tel:${esc(p.telefono)}">${esc(p.telefono)}</a>` : ""}
        ${p.direccion ? `<br>${esc(p.direccion)}` : ""}
        ${p.notas ? `<br><small class="suave">Ref.: ${esc(p.notas)}</small>` : ""}</p>
      ${p.estado !== "anulado" ? `<p style="margin:0 0 8px"><small class="etiqueta">${textoEntrega(p)}</small>
        ${p.entregado_en ? `<small class="suave">a las ${hora(p.entregado_en)}</small>` : ""}</p>` : ""}
      ${entrega ? `<div class="botones-domicilio" style="justify-content:flex-start;margin:0 0 12px">${botonesEntrega(p)}</div>` : ""}
      ${puedeCobrar(rol) && p.entrega !== "entregado" && p.estado !== "anulado" ? `<div class="fila">
        <label>Domiciliario<select id="domiciliario"><option value="">Sin asignar</option>${opciones(equipo.map((e) => [e.id, e.nombre]), p.domiciliario_id ?? "")}</select></label>
      </div>` : ""}
      ${entrega ? `<div class="fila">
        <label>Valor recibido del cliente (contra entrega)<input id="recibido" type="number" min="0" step="100" value="${p.recibido ?? ""}"></label>
        <button id="guardar-recibido" style="align-self:end">Guardar</button>
      </div>` : p.recibido != null ? `<p style="margin:0 0 8px">Recibido del cliente: <strong>${pesos(p.recibido)}</strong></p>` : ""}
      ${p.recibido != null && cambio > 0 ? `<p class="suave" style="margin:0 0 8px">Cambio entregado: ${pesos(cambio)}</p>` : ""}
      ${p.recibido != null && cambio < 0 ? `<p class="error" style="margin:0 0 8px">Faltan ${pesos(-cambio)} para el total</p>` : ""}
      ${p.novedades ? `<p style="margin:0 0 8px;white-space:pre-line"><strong>Novedades</strong><br><small>${esc(p.novedades)}</small></p>` : ""}
      ${entrega ? `<div class="fila">
        <label>Registrar novedad<input id="novedad" placeholder="Ej. el cliente no contesta, dirección errada"></label>
        <button id="agregar-novedad" style="align-self:end">Agregar</button>
      </div>` : ""}
    </div>` : "";

  const paraLlevar = p.tipo !== "mesa" ? ""
    : abierta && !soloLectura ? `<div class="panel"><div class="botones-domicilio" style="justify-content:flex-start;margin:0">
        <button class="chico ${p.para_llevar ? "" : "principal"}" data-llevar="no">Comer aquí</button>
        <button class="chico ${p.para_llevar ? "principal" : ""}" data-llevar="si">Para llevar</button></div></div>`
    : p.para_llevar ? `<p style="margin:0"><span class="etiqueta">Para llevar</span></p>` : "";
  // Pagos hechos (cuando la cuenta se dividió) y lo que falta.
  const resumenPagos = pagos.length && (abierta || pagos.length > 1) ? `
          ${pagos.map((x) => `<div class="item"><span class="suave">Pago ${hora(x.fecha)} · ${esc(x.metodo)}</span><span class="num">${pesos(x.valor)}</span></div>`).join("")}
          ${abierta ? `<div class="item"><strong>Falta por cobrar</strong><strong class="num">${pesos(totalCuenta(p) - pagado)}</strong></div>` : ""}` : "";

  const estadoCerrada = p.estado === "pagado"
    ? `Pagada con ${esc(p.metodo_pago)} a las ${hora(p.cerrado)}${p.propina ? ` · propina ${pesos(p.propina)}` : ""}`
    : `Anulada${p.motivo_anulacion ? `: ${esc(p.motivo_anulacion)}` : ""}`;

  $vista.innerHTML = `
    <div class="encabezado">
      <h1><a href="#${p.tipo === "mesa" ? "mesas" : "domicilios"}" class="volver" aria-label="Volver">←</a> ${esc(titulo)}</h1>
      ${abierta ? "" : `<span class="etiqueta">${estadoCerrada}</span>`}
    </div>
    <div class="cuenta">
      ${abierta && !soloLectura ? `<div class="carta">${carta(ctx.menu)}</div>` : ""}
      <div class="resumen">
        ${domicilio}
        ${paraLlevar}
        <div class="panel">
          ${items.length ? filasItems : `<p class="vacio">Toca un plato para agregarlo.</p>`}
          ${p.envio ? `<div class="item"><span>Envío</span><span class="num">${pesos(p.envio)}</span></div>` : ""}
          <div class="total"><span>Total</span><span>${pesos(totalMostrado(p))}</span></div>
          ${resumenPagos}
        </div>
        ${abierta && !soloLectura && items.length ? `<button class="ver-cuenta" id="ver-cuenta">${platosEnCuenta(items)} · Ver cuenta <strong>${pesos(totalMostrado(p))}</strong></button>` : ""}
        ${abierta && !soloLectura ? `<div class="acciones-cuenta">
          ${items.length ? `<button id="agregar-productos">+ Agregar productos</button>` : ""}
          ${hay("nuevo") ? `<button class="principal" id="enviar">Enviar a cocina</button>` : ""}
          ${(hay("cocina") || hay("listo")) && !esDomicilio ? `<button id="entregar">Marcar entregado</button>` : ""}
          ${items.length ? `<button id="precuenta">Imprimir cuenta</button>` : ""}
          ${puedeCobrar(rol) && items.length && !hay("nuevo") ? `<button class="principal" id="cobrar">${pagado ? "Cobrar lo que falta" : "Cobrar"}</button>` : ""}
          ${rol === "admin" ? `<button class="peligro" id="anular">Anular cuenta</button>` : ""}
        </div>` : abierta ? "" : `<div class="acciones-cuenta">
          ${rol !== "domiciliario" ? `<button id="imprimir">Imprimir</button>` : ""}
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
  document.getElementById("enviar")?.addEventListener("click", () =>
    // Si la comandera está en este mismo equipo, imprime de una sin esperar el aviso en vivo.
    hecho(api.enviarCocina(p.id).then(() => ctx.imprimirPendientes()), "Enviado a cocina"));
  document.getElementById("entregar")?.addEventListener("click", () => hecho(api.entregarPedido(p.id), "Pedido entregado"));
  $vista.querySelectorAll("[data-llevar]").forEach(($b) =>
    $b.addEventListener("click", () => hecho(api.cambiarParaLlevar(p.id, $b.dataset.llevar === "si"))));
  const ticket = () => ticketCuenta(p, ctx.negocio, { mesa: titulo });
  document.getElementById("cobrar")?.addEventListener("click", () => formularioCobro(ctx, p, titulo));
  document.getElementById("precuenta")?.addEventListener("click", () => imprimir(ticket()));
  document.getElementById("imprimir")?.addEventListener("click", () => imprimir(ticket()));
  // En el celular la cuenta queda debajo de la carta: este botón lleva hasta ella.
  document.getElementById("ver-cuenta")?.addEventListener("click", () =>
    $vista.querySelector(".resumen").scrollIntoView({ behavior: "smooth", block: "start" }));
  // El cliente pide más: lleva a la carta. Lo nuevo queda "Sin enviar" hasta darle «Enviar a cocina».
  document.getElementById("agregar-productos")?.addEventListener("click", () => {
    $vista.querySelector(".carta").scrollIntoView({ behavior: "smooth", block: "start" });
    aviso("Toca los platos que pidió. Luego dale «Enviar a cocina».");
  });
  document.getElementById("anular")?.addEventListener("click", () => {
    const motivo = prompt("¿Por qué se anula? (Si ya estaba pagada, el inventario se devuelve)");
    if (motivo === null) return;
    hecho(api.anular(p.id, motivo), "Cuenta anulada");
  });
  const $domiciliario = document.getElementById("domiciliario");
  $domiciliario?.addEventListener("change", () => hecho(api.asignarDomiciliario(p.id, $domiciliario.value)));
  activarBotonesEntrega($vista, ctx);
  document.getElementById("guardar-recibido")?.addEventListener("click", () =>
    hecho(api.registrarRecibido(p.id, document.getElementById("recibido").value), "Valor recibido guardado"));
  document.getElementById("agregar-novedad")?.addEventListener("click", () =>
    hecho(api.registrarNovedad(p.id, document.getElementById("novedad").value), "Novedad registrada"));
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

// Se cobra al final (después de comer o al entregar el domicilio). Por defecto se cobra todo lo
// que falta; si pagan por separado, se deja solo lo que paga esta persona y el resto queda
// pendiente para el siguiente pago (cada uno con su método). El envío va en el último pago.
function formularioCobro(ctx, p, titulo) {
  const pendientes = p.pedido_items.filter((i) => !i.pago_id).sort((a, b) => a.creado.localeCompare(b.creado));
  const unidades = pendientes.reduce((s, i) => s + i.cantidad, 0);
  const filas = pendientes.map((i) => {
    const detalle = [...i.opciones.map((o) => o.nombre), i.nota].filter(Boolean).join(" · ");
    const cantidades = Array.from({ length: i.cantidad + 1 }, (_, n) => [n, `${n} de ${i.cantidad}`]);
    return `<div class="item">
      <div><strong>${esc(i.nombre)}</strong> <small class="suave">${pesos(i.precio)} c/u</small>
        ${detalle ? `<br><small class="suave">${esc(detalle)}</small>` : ""}</div>
      <select data-paga="${i.id}" data-precio="${i.precio}" aria-label="Cuántos paga" style="width:auto">${opciones(cantidades, i.cantidad)}</select>
    </div>`;
  }).join("");
  let resultado = null;
  let cobro = null;
  const $form = formulario(`Cobrar · ${esc(titulo)}`, `
    <p class="suave" style="margin:0">¿Pagan por separado? Deja aquí solo lo que paga esta persona; lo demás queda para el siguiente pago.</p>
    <div>${filas}</div>
    <label>Método de pago<select name="metodo">${opciones(METODOS)}</select></label>
    <label>Recibido (efectivo)<input name="recibido" type="number" min="0" step="100" value="${p.recibido ?? ""}"></label>
    <div class="total"><span>Total de este pago</span><span id="a-cobrar"></span></div>
    <p class="suave" id="cambio" style="margin:0"></p>
    <label class="opcion"><input type="checkbox" name="imprimir"${preferencia("cuenta") ? " checked" : ""}> Imprimir la cuenta</label>`,
    async (c, $f) => {
      const items = [...$f.querySelectorAll("[data-paga]")]
        .map(($s) => ({ id: $s.dataset.paga, cantidad: Number($s.value) }))
        .filter((x) => x.cantidad > 0);
      if (!items.length) throw new Error("Elige qué platos se van a pagar");
      resultado = await api.cobrarParte(p.id, items, c.metodo);
      cobro = c;
    },
    {
      boton: "Confirmar pago",
      alTerminar: async () => {
        guardarPreferencia("cuenta", Boolean(cobro.imprimir));
        if (p.tipo === "domicilio") ctx.imprimirPendientes();
        if (cobro.imprimir) {
          // Ticket de este pago: solo los platos que se pagaron, con su método.
          const actual = await api.pedido(p.id);
          await imprimir(ticketCuenta({
            ...actual,
            pedido_items: actual.pedido_items.filter((i) => i.pago_id === resultado.pago_id),
            envio: resultado.cerrada ? actual.envio : 0,
            estado: "pagado",
            metodo_pago: cobro.metodo,
            cerrado: actual.cerrado ?? new Date().toISOString(),
          }, ctx.negocio, { mesa: titulo, recibido: Number(cobro.recibido) || 0 }));
        }
        if (resultado.cerrada) {
          aviso("Cuenta cobrada");
          ctx.ir(p.tipo === "mesa" ? "mesas" : "domicilios");
        } else {
          aviso(`Pago de ${pesos(resultado.valor)} registrado. Falta cobrar el resto.`);
          ctx.refrescar();
        }
      },
    });
  const actualizar = () => {
    let total = 0;
    let elegidas = 0;
    $form.querySelectorAll("[data-paga]").forEach(($s) => {
      total += Number($s.value) * Number($s.dataset.precio);
      elegidas += Number($s.value);
    });
    // Si este pago se lleva todo lo que falta, incluye el envío.
    if (elegidas === unidades) total += p.envio || 0;
    $form.querySelector("#a-cobrar").textContent = pesos(total);
    const recibido = Number($form.recibido.value) || 0;
    $form.querySelector("#cambio").textContent = recibido ? `Cambio: ${pesos(recibido - total)}` : "";
  };
  $form.addEventListener("input", actualizar);
  $form.addEventListener("change", actualizar);
  actualizar();
}
