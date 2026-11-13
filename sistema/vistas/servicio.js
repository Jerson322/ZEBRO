// Servicio: mapa de mesas, domicilios y la cuenta de cada uno (tomar pedido, cocina, cobro).
import * as api from "../api.js";
import { esc, pesos, opciones, formulario, mostrar, cerrarDialogo, hora, minutosDesde, aviso, tarjeta as tarjetaResumen } from "../util.js";
import { preferencia, guardarPreferencia, imprimir, ticketCuenta } from "../impresion.js";
import { autorizar } from "../clave.js";
import { pantallaCajaCerrada, puedeTrabajar } from "../caja.js";

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
  // Sin caja abierta no se toman pedidos.
  if (!(await puedeTrabajar(ctx))) return pantallaCajaCerrada($vista, ctx);
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
      <div class="botones-domicilio" style="margin:0">
        ${ctx.perfil.rol === "admin" ? `<button id="editar-mesas">Editar mesas</button>` : ""}
        <button class="principal" id="crear-mesa">+ Crear mesa</button></div></div>
    ${lista.length ? `<div class="mesas">${tarjetas.join("")}</div>`
      : `<p class="vacio">No hay mesas abiertas. Toca «+ Crear mesa» para tomar un pedido${ctx.perfil.rol === "admin" ? ", o crea las mesas fijas del local con «Editar mesas»" : ""}.</p>`}`;

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
  // Mesa al momento: se crea, se abre su cuenta de una y se borra sola al cobrarla.
  document.getElementById("crear-mesa").addEventListener("click", () => {
    const usados = new Set(lista.map((m) => m.nombre.trim().toLowerCase()));
    let n = lista.length + 1;
    while (usados.has(`mesa ${n}`)) n += 1;
    let creada = null;
    formulario("Crear mesa", `
      <label>Nombre<input name="nombre" placeholder="Ej. Mesa ${n} o el nombre del cliente" autocomplete="off"></label>
      <p class="suave" style="margin:0">Si lo dejas vacío se llama «Mesa ${n}». Se borra sola cuando se cobre su cuenta.</p>`,
      // Si se deja vacío, se llama con el siguiente número libre.
      async (c) => { creada = await api.crearMesa(c.nombre.trim() || `Mesa ${n}`); },
      { boton: "Crear y tomar pedido", alTerminar: () => ctx.ir(`pedido/${creada}`) });
  });
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
      if ((await autorizar(ctx, "Borrar una mesa")) === null) return;
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
  // Sin caja abierta no se toman domicilios (el domiciliario sí ve los que tiene por entregar).
  if (rol !== "domiciliario" && !(await puedeTrabajar(ctx))) return pantallaCajaCerrada($vista, ctx);
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
        <label>Domiciliario<select name="domiciliario"><option value="">Sin asignar</option>${opciones(equipo.filter((e) => e.cargo === "domiciliario").map((e) => [e.id, e.nombre]))}</select></label>
      </div>
      <label>Referencias<input name="notas" placeholder="Ej. casa azul, timbre dañado, paga con billete de 50"></label>`,
      async (c) => { creado = await api.crearDomicilio(c); },
      { boton: "Crear y tomar pedido", alTerminar: () => ctx.ir(`pedido/${creado}`) });
  });
}

// Cuenta de una mesa o un domicilio

// La carta recuerda la categoría elegida y dónde estaba la pantalla mientras se trabaja en la
// misma cuenta: al agregar un plato no se devuelve a «Todo» ni salta arriba.
const vistaCarta = { pedido: null, categoria: "*", busqueda: "" };
// Para buscar sin importar mayúsculas ni tildes ("mazorcada" encuentra "Mazorcada especial").
const normalizar = (t) => String(t ?? "").normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().trim();
// Toques seguidos a un mismo plato: se juntan y se agregan de una vez (5 toques = 5×).
const toques = new Map(); // id del plato → { n, temporizador }
const ESPERA_TOQUES_MS = 700;

export async function cuenta($vista, ctx, pedidoId) {
  // Se vuelve a pintar la misma cuenta que está en pantalla (agregar un plato, aviso en vivo…).
  const repintando = Boolean($vista.querySelector(`[data-cuenta="${pedidoId}"]`));
  const scroll = repintando ? window.scrollY : 0;
  if (vistaCarta.pedido !== pedidoId) Object.assign(vistaCarta, { pedido: pedidoId, categoria: "*", busqueda: "" });
  const [p, listaMesas, equipo] = await Promise.all([api.pedido(pedidoId), api.mesas(), api.equipo()]);
  if (!p) {
    $vista.innerHTML = `<p class="vacio">Esa cuenta no existe.</p>`;
    return;
  }
  const rol = ctx.perfil.rol;
  // Una cuenta abierta no se puede trabajar con la caja cerrada (las cerradas sí se pueden ver).
  if (p.estado === "abierto" && rol !== "domiciliario" && !(await puedeTrabajar(ctx))) return pantallaCajaCerrada($vista, ctx);
  const titulo = p.tipo === "mesa"
    ? listaMesas.find((m) => m.id === p.mesa_id)?.nombre ?? p.mesa_nombre ?? "Mesa"
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
    const puedeQuitar = abierta && !soloLectura && !i.pago_id && (i.estado === "nuevo" || puedeCobrar(rol) || ctx.conClave);
    const detalle = [...i.opciones.map((o) => o.nombre), i.nota].filter(Boolean).join(" · ");
    return `<div class="item">
      <div>${abierta && !soloLectura && i.estado === "nuevo" && !i.pago_id
          ? `<input type="number" min="0" max="999" inputmode="numeric" class="cantidad-linea" data-cantidad-item="${i.id}" value="${i.cantidad}" aria-label="Cantidad de ${esc(i.nombre)}"> <strong>${esc(i.nombre)}</strong>`
          : `<strong>${i.cantidad}× ${esc(i.nombre)}</strong>`}${detalle ? `<br><small class="suave">${esc(detalle)}</small>` : ""}
        <br><small class="etiqueta estado-${i.estado}">${ESTADO_ITEM[i.estado]}</small>
        ${abierta && i.pago_id ? `<small class="etiqueta estado-listo">Pagado · ${esc(metodoDe(i.pago_id))}</small>` : ""}</div>
      <div class="num">${pesos(i.precio * i.cantidad)}
        ${puedeQuitar ? `<br><button class="chico peligro" data-quitar="${i.id}" data-enviado="${i.estado === "nuevo" ? "" : "si"}" aria-label="Quitar">Quitar</button>` : ""}</div>
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
        <label>Domiciliario<select id="domiciliario"><option value="">Sin asignar</option>${opciones(equipo.filter((e) => e.cargo === "domiciliario").map((e) => [e.id, e.nombre]), p.domiciliario_id ?? "")}</select></label>
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
      <h1><a href="#${esc(ctx.volverA ?? (p.tipo === "mesa" ? "mesas" : "domicilios"))}" class="volver" aria-label="Volver">←</a> ${esc(titulo)}</h1>
      ${abierta ? "" : `<span class="etiqueta">${estadoCerrada}</span>`}
    </div>
    <div class="cuenta" data-cuenta="${p.id}">
      ${abierta && !soloLectura ? `<div class="carta">${carta(ctx.menu, vistaCarta.categoria, vistaCarta.busqueda)}</div>` : ""}
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
          ${rol === "admin" || (ctx.conClave && rol === "cajero") ? `<button class="peligro" id="anular">Anular cuenta</button>` : ""}
        </div>` : abierta ? "" : `<div class="acciones-cuenta">
          ${rol !== "domiciliario" ? `<button id="imprimir">Imprimir</button>` : ""}
          ${(rol === "admin" || (ctx.conClave && rol === "cajero")) && p.estado === "pagado" ? `<button class="peligro" id="anular">Anular venta</button>` : ""}
        </div>`}
      </div>
    </div>`;

  const hecho = (promesa, mensaje) =>
    promesa.then(() => { if (mensaje) aviso(mensaje); ctx.refrescar(); }).catch((e) => aviso(e.message));

  if (repintando) window.scrollTo(0, scroll);
  $vista.querySelectorAll("[data-plato]").forEach(($b) =>
    $b.addEventListener("click", () => tocarPlato(ctx, p.id, $b))
  );
  // Qué platos se ven: con búsqueda, los que coinciden (de cualquier categoría); si no, los de la categoría.
  const filtrarCarta = () => {
    const texto = normalizar(vistaCarta.busqueda);
    let visibles = 0;
    $vista.querySelectorAll("[data-de]").forEach(($pl) => {
      $pl.hidden = texto
        ? !texto.split(/\s+/).every((palabra) => $pl.dataset.nombre.includes(palabra))
        : vistaCarta.categoria !== "*" && $pl.dataset.de !== vistaCarta.categoria;
      if (!$pl.hidden) visibles += 1;
    });
    $vista.querySelector(".pestanas")?.classList.toggle("buscando", Boolean(texto));
    const $vacio = $vista.querySelector("#sin-resultados");
    if ($vacio) $vacio.hidden = visibles > 0;
    const $limpiar = $vista.querySelector("#limpiar-busqueda");
    if ($limpiar) $limpiar.hidden = !texto;
  };
  $vista.querySelectorAll("[data-categoria]").forEach(($b) =>
    $b.addEventListener("click", () => {
      vistaCarta.categoria = $b.dataset.categoria;
      vistaCarta.busqueda = "";
      const $buscar = $vista.querySelector("#buscar-plato");
      if ($buscar) $buscar.value = "";
      $vista.querySelectorAll("[data-categoria]").forEach(($o) => $o.classList.toggle("activo", $o === $b));
      filtrarCarta();
    })
  );
  const $buscar = $vista.querySelector("#buscar-plato");
  $buscar?.addEventListener("input", () => {
    vistaCarta.busqueda = $buscar.value;
    filtrarCarta();
  });
  $buscar?.addEventListener("keydown", (e) => {
    if (e.key === "Escape") {
      $buscar.value = vistaCarta.busqueda = "";
      filtrarCarta();
    }
  });
  $vista.querySelector("#limpiar-busqueda")?.addEventListener("click", () => {
    $buscar.value = vistaCarta.busqueda = "";
    filtrarCarta();
    $buscar.focus();
  });
  if (vistaCarta.busqueda) filtrarCarta();
  // Cantidad escrita a mano (40 en vez de 40 toques). 0 la quita.
  $vista.querySelectorAll("[data-cantidad-item]").forEach(($i) => {
    $i.addEventListener("focus", () => $i.select());
    $i.addEventListener("keydown", (e) => { if (e.key === "Enter") $i.blur(); });
    $i.addEventListener("change", () => {
      const n = Math.round(Number($i.value));
      if (!Number.isFinite(n) || n < 0) return ctx.refrescar();
      hecho(api.cambiarCantidad($i.dataset.cantidadItem, n), n ? null : "Quitado");
    });
  });
  $vista.querySelectorAll("[data-quitar]").forEach(($b) =>
    $b.addEventListener("click", async () => {
      // Lo que ya se envió a cocina pide clave de autorización (la revisa la base de datos).
      const clave = $b.dataset.enviado ? await autorizar(ctx, "Quitar un plato que ya se envió a cocina", { verificar: false }) : "";
      if (clave === null) return;
      hecho(api.quitarItem($b.dataset.quitar, clave));
    })
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
    autorizar(ctx, "Anular la cuenta", { verificar: false }).then((clave) => {
      if (clave !== null) hecho(api.anular(p.id, motivo, clave), "Cuenta anulada");
    });
  });
  const $domiciliario = document.getElementById("domiciliario");
  $domiciliario?.addEventListener("change", () => hecho(api.asignarDomiciliario(p.id, $domiciliario.value)));
  activarBotonesEntrega($vista, ctx);
  document.getElementById("guardar-recibido")?.addEventListener("click", () =>
    hecho(api.registrarRecibido(p.id, document.getElementById("recibido").value), "Valor recibido guardado"));
  document.getElementById("agregar-novedad")?.addEventListener("click", () =>
    hecho(api.registrarNovedad(p.id, document.getElementById("novedad").value), "Novedad registrada"));
}

function carta(menu, elegida = "*", busqueda = "") {
  const disponibles = menu.platos.filter((pl) => pl.activo);
  if (!disponibles.length) return `<p class="vacio">El menú está vacío. El administrador lo crea en «Menú y recetas».</p>`;
  const categorias = menu.categorias.filter((c) => disponibles.some((pl) => pl.categoria_id === c.id));
  const sinCategoria = disponibles.some((pl) => !categorias.some((c) => c.id === pl.categoria_id));
  // Si la categoría elegida ya no existe, se vuelve a «Todo».
  const activa = elegida === "*" || categorias.some((c) => c.id === elegida) || (elegida === "" && sinCategoria) ? elegida : "*";
  const pestana = (id, nombre) => `<button class="${id === activa ? "activo" : ""}" data-categoria="${id}">${esc(nombre)}</button>`;
  return `<div class="buscador">
      <span class="buscador-lupa" aria-hidden="true">🔍</span>
      <input type="search" id="buscar-plato" placeholder="Buscar producto…" value="${esc(busqueda)}" autocomplete="off" aria-label="Buscar producto">
      <button type="button" class="icono-boton" id="limpiar-busqueda" aria-label="Borrar búsqueda"${busqueda ? "" : " hidden"}>✕</button>
    </div>
    <div class="pestanas">
      ${pestana("*", "Todo")}
      ${categorias.map((c) => pestana(c.id, c.nombre)).join("")}
      ${sinCategoria ? pestana("", "Otros") : ""}
    </div>
    <div class="platos">${disponibles.map((pl) => {
      const de = categorias.some((c) => c.id === pl.categoria_id) ? pl.categoria_id : "";
      const n = toques.get(pl.id)?.n;
      return `<button class="plato" data-plato="${pl.id}" data-de="${de}" data-nombre="${esc(normalizar(`${pl.nombre} ${pl.descripcion ?? ""}`))}"${activa !== "*" && de !== activa ? " hidden" : ""}>
        ${n ? `<span class="contador">+${n}</span>` : ""}<strong>${esc(pl.nombre)}</strong><span>${pesos(pl.precio)}</span></button>`;
    }).join("")}</div>
    <p class="vacio" id="sin-resultados" hidden>No hay productos con ese nombre.</p>`;
}

// Tocar un plato sin modificadores suma 1 al contador del botón; al dejar de tocar se agregan
// todos de una vez. Si el plato tiene modificadores, se abre la ventana para elegirlos.
function tocarPlato(ctx, pedidoId, $boton) {
  const platoId = $boton.dataset.plato;
  const { platos, platoGrupos } = ctx.menu;
  if (platoGrupos.some((pg) => pg.plato_id === platoId)) return elegirPlato(ctx, pedidoId, platoId);
  const plato = platos.find((pl) => pl.id === platoId);
  const toque = toques.get(platoId) ?? { n: 0 };
  toque.n += 1;
  clearTimeout(toque.temporizador);
  toques.set(platoId, toque);
  // Contador en el botón (se busca de nuevo por si la pantalla se volvió a pintar).
  const $actual = document.querySelector(`[data-plato="${platoId}"]`) ?? $boton;
  let $contador = $actual.querySelector(".contador");
  if (!$contador) {
    $contador = Object.assign(document.createElement("span"), { className: "contador" });
    $actual.prepend($contador);
  }
  $contador.textContent = `+${toque.n}`;
  toque.temporizador = setTimeout(async () => {
    toques.delete(platoId);
    try {
      await api.agregarItem(pedidoId, platoId, toque.n, [], "");
      aviso(`${toque.n} × ${plato.nombre} agregado${toque.n > 1 ? "s" : ""}`);
    } catch (e) {
      aviso(e.message);
    }
    ctx.refrescar();
  }, ESPERA_TOQUES_MS);
}

// Plato con modificadores (sabores, borde, adiciones…): ventana para elegirlos, organizada por
// grupos. Cada grupo tiene su cantidad (se escribe o con + / −) y sus opciones: «40 Hawaiana» es
// un solo grupo; «38 Hawaiana + 2 Criolla con borde» son dos. Cada grupo se agrega como una línea.
function elegirPlato(ctx, pedidoId, platoId) {
  const { platos, grupos, opciones: todas, platoGrupos } = ctx.menu;
  const plato = platos.find((pl) => pl.id === platoId);
  const susGrupos = grupos.filter((g) => platoGrupos.some((pg) => pg.plato_id === platoId && pg.grupo_id === g.id));
  if (!susGrupos.length) return;
  const opcionesDe = (g) => todas.filter((o) => o.grupo_id === g.id);
  const nuevaVariante = () => ({ cantidad: 1, opciones: new Set(), nota: "" });
  const variantes = [nuevaVariante()];
  const abiertos = new Set(); // adiciones desplegadas, para que no se cierren al volver a pintar
  const precioUnidad = (v) => plato.precio + todas.filter((o) => v.opciones.has(o.id)).reduce((s, o) => s + o.precio, 0);
  const cantidad = (v) => Math.max(1, Math.min(999, Math.round(Number(v.cantidad) || 1)));

  const bloque = (v, k) => {
    const grupos = susGrupos.map((g) => {
      const tipo = g.maximo === 1 ? "radio" : "checkbox";
      const regla = `${g.obligatorio ? "Obligatorio" : "Opcional"}${g.maximo > 1 ? ` · hasta ${g.maximo}` : ""}`;
      const ops = opcionesDe(g);
      // En los grupos opcionales de una sola opción (Borde, Extra queso…) se puede elegir «Sin …».
      const ninguna = tipo === "radio" && !g.obligatorio
        ? `<label class="opcion"><input type="radio" name="v${k}-g-${g.id}" value="" data-variante="${k}" data-grupo="${g.id}"${ops.some((o) => v.opciones.has(o.id)) ? "" : " checked"}>
            Sin ${esc(g.nombre.toLowerCase())}</label>` : "";
      const items = ninguna + ops.map((o) => `<label class="opcion">
          <input type="${tipo}" name="v${k}-g-${g.id}" value="${o.id}" data-variante="${k}" data-grupo="${g.id}"${v.opciones.has(o.id) ? " checked" : ""}>
          ${esc(o.nombre)}${o.precio ? ` <span class="suave">+${pesos(o.precio)}</span>` : ""}</label>`).join("");
      // Las adiciones (opcionales, de varias) van plegadas para que cada grupo quede corto.
      if (!g.obligatorio && g.maximo > 1) {
        const n = ops.filter((o) => v.opciones.has(o.id)).length;
        return `<details data-plegable="${k}-${g.id}"${abiertos.has(`${k}-${g.id}`) ? " open" : ""}>
          <summary><strong>${esc(g.nombre)}</strong> <small class="suave">${n ? `${n} elegida${n > 1 ? "s" : ""}` : "opcional · toca para ver"}</small></summary>
          <fieldset style="margin-top:6px">${items}</fieldset></details>`;
      }
      return `<fieldset><legend>${esc(g.nombre)} <small class="suave">${regla}</small></legend>${items}</fieldset>`;
    }).join("");
    return `<div class="${variantes.length > 1 ? "panel" : ""}" style="margin:0;display:flex;flex-direction:column;gap:10px">
      <div class="mc-titulo" style="align-items:center">
        <span class="botones-domicilio" style="justify-content:flex-start;margin:0;align-items:center">
          <button type="button" class="chico" data-menos="${k}" aria-label="Una menos">−</button>
          <input type="number" min="1" max="999" inputmode="numeric" data-cantidad="${k}" value="${cantidad(v)}"
            aria-label="Cantidad" style="width:76px;text-align:center;font-size:18px;font-weight:800;min-height:38px">
          <button type="button" class="chico" data-mas="${k}" aria-label="Una más">+</button>
          <span class="suave">× ${pesos(precioUnidad(v))}</span>
        </span>
        ${variantes.length > 1 ? `<button type="button" class="icono-boton" data-quitar-variante="${k}" aria-label="Quitar este grupo">✕</button>` : ""}
      </div>
      ${grupos}
      <label>Nota<input data-nota="${k}" value="${esc(v.nota)}" placeholder="Ej. sin cebolla"></label>
    </div>`;
  };

  const $form = formulario(esc(plato.nombre), `
    <div id="variantes" style="display:flex;flex-direction:column;gap:12px"></div>
    <button type="button" id="otra-variante">+ Agregar otras con opciones distintas</button>
    <div class="total"><span id="unidades-plato">Total</span><span id="total-plato"></span></div>`,
    async () => {
      // Cada grupo debe cumplir las reglas de sus opciones; se avisa cuál está incompleto.
      variantes.forEach((v, k) => {
        for (const g of susGrupos) {
          const n = opcionesDe(g).filter((o) => v.opciones.has(o.id)).length;
          const cual = variantes.length > 1 ? ` (grupo ${k + 1})` : "";
          if (g.obligatorio && !n) throw new Error(`Elige ${g.nombre}${cual}`);
          if (n > g.maximo) throw new Error(`En ${g.nombre} puedes elegir máximo ${g.maximo}${cual}`);
        }
      });
      // Los grupos iguales se agregan juntos (la base de datos también los suma).
      for (const v of variantes) await api.agregarItem(pedidoId, platoId, cantidad(v), [...v.opciones].sort(), v.nota.trim());
    },
    { boton: "Agregar", alTerminar: () => ctx.refrescar() });

  const $dialogo = document.getElementById("dialogo");
  const $variantes = $form.querySelector("#variantes");
  // Totales sin volver a pintar (para no perder lo que se está escribiendo).
  const totales = () => {
    const n = variantes.reduce((s, v) => s + cantidad(v), 0);
    $form.querySelector("#unidades-plato").textContent = `Total · ${n} ${n === 1 ? "unidad" : "unidades"}`;
    $form.querySelector("#total-plato").textContent = pesos(variantes.reduce((s, v) => s + cantidad(v) * precioUnidad(v), 0));
    $form.querySelector('[type="submit"]').textContent = n > 1 ? `Agregar ${n}` : "Agregar";
  };
  // Vuelve a pintar sin mover la ventana (antes saltaba hacia abajo).
  const pintar = () => {
    const scroll = $dialogo.scrollTop;
    $variantes.innerHTML = variantes.map(bloque).join("");
    $dialogo.scrollTop = scroll;
    totales();
  };
  $variantes.addEventListener("click", (e) => {
    const $b = e.target.closest("button");
    if (!$b) return;
    if ($b.dataset.mas !== undefined) variantes[$b.dataset.mas].cantidad = cantidad(variantes[$b.dataset.mas]) + 1;
    else if ($b.dataset.menos !== undefined) variantes[$b.dataset.menos].cantidad = Math.max(1, cantidad(variantes[$b.dataset.menos]) - 1);
    else if ($b.dataset.quitarVariante !== undefined) variantes.splice(Number($b.dataset.quitarVariante), 1);
    else return;
    pintar();
  });
  $variantes.addEventListener("change", (e) => {
    const $i = e.target;
    if ($i.dataset.cantidad !== undefined) {
      variantes[$i.dataset.cantidad].cantidad = cantidad({ cantidad: $i.value });
      $i.value = variantes[$i.dataset.cantidad].cantidad;
      return totales();
    }
    if ($i.dataset.variante === undefined) return;
    const v = variantes[Number($i.dataset.variante)];
    if ($i.type === "radio") opcionesDe({ id: $i.dataset.grupo }).forEach((o) => v.opciones.delete(o.id));
    if ($i.checked && $i.value) v.opciones.add($i.value);
    else if ($i.value) v.opciones.delete($i.value);
    pintar();
  });
  $variantes.addEventListener("input", (e) => {
    if (e.target.dataset.nota !== undefined) variantes[Number(e.target.dataset.nota)].nota = e.target.value;
    if (e.target.dataset.cantidad !== undefined && e.target.value !== "") {
      variantes[e.target.dataset.cantidad].cantidad = e.target.value;
      totales();
    }
  });
  $variantes.addEventListener("toggle", (e) => {
    const clave = e.target.dataset?.plegable;
    if (clave) e.target.open ? abiertos.add(clave) : abiertos.delete(clave);
  }, true);
  $form.querySelector("#otra-variante").addEventListener("click", () => {
    variantes.push(nuevaVariante());
    pintar();
  });
  pintar();
}

// Cobro normal: todo lo que falta, con un solo método. Si pagan por separado, «Multicuenta».
function formularioCobro(ctx, p, titulo) {
  const pendientes = p.pedido_items.filter((i) => !i.pago_id);
  // Lo que falta: el total menos lo ya pagado (por productos o por partes).
  const total = totalCuenta(p) - (p.pagos ?? []).reduce((s, x) => s + x.valor, 0);
  let resultado = null;
  let cobro = null;
  const $form = formulario(`Cobrar ${pesos(total)}`, `
    <div class="botones-domicilio" style="justify-content:stretch;margin:0">
      <button type="button" id="abrir-dividir" style="flex:1">÷ Dividir el valor<br><small class="suave">entre 2, 3, 4 o lo que pague cada uno</small></button>
      <button type="button" id="abrir-multicuenta" style="flex:1">⇄ Multicuenta<br><small class="suave">cada uno paga sus productos</small></button>
    </div>
    <label>Método de pago<select name="metodo">${opciones(METODOS)}</select></label>
    <label>Recibido (efectivo)<input name="recibido" type="number" min="0" step="100" value="${p.recibido ?? ""}"></label>
    <div class="total"><span>Total a recibir</span><span>${pesos(total)}</span></div>
    <p class="suave" id="cambio" style="margin:0"></p>
    <label class="opcion"><input type="checkbox" name="imprimir"${preferencia("cuenta") ? " checked" : ""}> Imprimir la cuenta</label>`,
    async (c) => {
      resultado = await api.cobrarParte(p.id, pendientes.map((i) => ({ id: i.id, cantidad: i.cantidad })), c.metodo);
      cobro = c;
    },
    {
      boton: "Confirmar pago",
      alTerminar: async () => {
        guardarPreferencia("cuenta", Boolean(cobro.imprimir));
        await despuesDeCobrar(ctx, p, titulo, resultado, cobro.metodo, Number(cobro.recibido) || 0, Boolean(cobro.imprimir));
      },
    });
  const actualizar = () => {
    const recibido = Number($form.recibido.value) || 0;
    $form.querySelector("#cambio").textContent = recibido ? `Cambio: ${pesos(recibido - total)}` : "";
  };
  $form.addEventListener("input", actualizar);
  actualizar();
  $form.querySelector("#abrir-multicuenta").addEventListener("click", () => multicuenta(ctx, p, titulo));
  $form.querySelector("#abrir-dividir").addEventListener("click", () => dividirValor(ctx, p, titulo));
}

// Dividir el valor: lo que falta se reparte en partes iguales (entre 2, 3 o 4) o cada parte se
// escribe a mano. Cada parte se cobra aparte, con su método. La última parte siempre es «lo que
// falta», así la suma cuadra sola. Cuando se cobra la última, la cuenta se cierra.
function dividirValor(ctx, pedidoInicial, titulo) {
  let p = pedidoInicial;
  const falta = () => totalCuenta(p) - (p.pagos ?? []).reduce((s, x) => s + x.valor, 0);
  const pagosAntes = (p.pagos ?? []).length;
  let partes = [];
  let imprimirTickets = preferencia("cuenta");
  let cobrando = false;

  // Partes iguales redondeadas a $100; la última se queda con el resto.
  const repartir = (n) => {
    const resto = falta();
    const base = Math.floor(resto / n / 100) * 100;
    partes = Array.from({ length: n }, (_, k) => ({ valor: k === n - 1 ? resto - base * (n - 1) : base, metodo: METODOS[0], recibido: "" }));
  };
  // La última parte siempre completa lo que falta.
  const cuadrar = () => {
    if (!partes.length) return;
    const otras = partes.slice(0, -1).reduce((s, x) => s + (Number(x.valor) || 0), 0);
    partes[partes.length - 1].valor = Math.max(0, falta() - otras);
  };
  repartir(2);

  function pintar() {
    cuadrar();
    const resto = falta();
    const yaPagadas = (p.pagos ?? []).slice(pagosAntes);
    const $c = mostrar(`
      <div class="mc-cabeza"><h2>Dividir el valor · ${esc(titulo)}</h2>
        <button type="button" class="icono-boton" id="dv-cerrar" aria-label="Cerrar">✕</button></div>
      <div class="total" style="margin:0"><span>Falta por cobrar</span><span>${pesos(resto)}</span></div>
      <div class="botones-domicilio" style="justify-content:flex-start;margin:0">
        ${[2, 3, 4].map((n) => `<button type="button" class="chico${partes.length === n ? " principal" : ""}" data-entre="${n}">Entre ${n}</button>`).join("")}
        <button type="button" class="chico" id="dv-mas">+ Agregar parte</button>
      </div>
      ${yaPagadas.map((x, k) => `<div class="item"><span>✓ Parte ${k + 1} · ${esc(x.metodo)}</span><span class="num">${pesos(x.valor)}</span></div>`).join("")}
      ${partes.map((x, k) => {
        const ultima = k === partes.length - 1;
        const recibido = Number(x.recibido) || 0;
        const numero = yaPagadas.length + k + 1;
        return `<div class="panel" style="margin:0;display:flex;flex-direction:column;gap:8px">
          <div class="mc-titulo"><span>Parte ${numero}${ultima ? ` <small class="suave">(lo que falta)</small>` : ""}</span>
            ${partes.length > 1 ? `<button type="button" class="icono-boton" data-quitar-parte="${k}" aria-label="Quitar parte">✕</button>` : ""}</div>
          <div class="fila">
            <label>Valor<input type="number" min="0" step="100" data-valor="${k}" value="${x.valor}"${ultima ? " readonly" : ""}></label>
            <label>Método<select data-metodo="${k}">${opciones(METODOS, x.metodo)}</select></label>
          </div>
          <input type="number" min="0" step="100" data-recibido="${k}" placeholder="Recibido en efectivo (opcional)" value="${esc(x.recibido)}">
          ${recibido && x.valor ? `<small class="${recibido < x.valor ? "error" : "suave"}">${recibido < x.valor ? `Faltan ${pesos(x.valor - recibido)}` : `Cambio: ${pesos(recibido - x.valor)}`}</small>` : ""}
          <button type="button" class="principal" data-cobrar-parte="${k}"${x.valor > 0 && !cobrando ? "" : " disabled"}>Cobrar ${pesos(x.valor)}</button>
        </div>`;
      }).join("")}
      <label class="opcion"><input type="checkbox" id="dv-imprimir"${imprimirTickets ? " checked" : ""}> Imprimir el ticket de cada parte</label>`);

    $c.querySelector("#dv-cerrar").addEventListener("click", cerrarDialogo);
    $c.querySelector("#dv-imprimir").addEventListener("change", (e) => (imprimirTickets = e.target.checked));
    $c.querySelectorAll("[data-entre]").forEach(($b) => $b.addEventListener("click", () => {
      repartir(Number($b.dataset.entre));
      pintar();
    }));
    $c.querySelector("#dv-mas").addEventListener("click", () => {
      // La nueva parte arranca en 0; se escribe cuánto paga y la última se ajusta sola.
      partes.splice(partes.length - 1, 0, { valor: 0, metodo: METODOS[0], recibido: "" });
      pintar();
    });
    $c.querySelectorAll("[data-quitar-parte]").forEach(($b) => $b.addEventListener("click", () => {
      partes.splice(Number($b.dataset.quitarParte), 1);
      pintar();
    }));
    $c.querySelectorAll("[data-valor]").forEach(($i) => $i.addEventListener("change", () => {
      partes[Number($i.dataset.valor)].valor = Math.max(0, Math.round(Number($i.value) || 0));
      pintar();
    }));
    $c.querySelectorAll("[data-metodo]").forEach(($s) => $s.addEventListener("change", () => (partes[Number($s.dataset.metodo)].metodo = $s.value)));
    $c.querySelectorAll("[data-recibido]").forEach(($i) => $i.addEventListener("change", () => {
      partes[Number($i.dataset.recibido)].recibido = $i.value;
      pintar();
    }));
    $c.querySelectorAll("[data-cobrar-parte]").forEach(($b) => $b.addEventListener("click", () => cobrarParte(Number($b.dataset.cobrarParte))));
  }

  async function cobrarParte(k) {
    const x = partes[k];
    if (cobrando || !(x.valor > 0)) return;
    if (x.valor > falta()) return aviso(`Esa parte es mayor que lo que falta (${pesos(falta())})`);
    cobrando = true;
    const numero = (p.pagos ?? []).length - pagosAntes + 1;
    try {
      const resultado = await api.abonar(p.id, x.valor, x.metodo);
      guardarPreferencia("cuenta", imprimirTickets);
      if (imprimirTickets) {
        const actual = await api.pedido(p.id);
        await imprimir(ticketCuenta(actual, ctx.negocio, {
          mesa: titulo, recibido: Number(x.recibido) || 0,
          parte: { valor: resultado.valor, metodo: x.metodo, falta: resultado.falta, numero },
        }));
      }
      if (resultado.cerrada) {
        cerrarDialogo();
        aviso("Cuenta cobrada");
        ctx.ir(p.tipo === "mesa" ? "mesas" : "domicilios");
        return;
      }
      aviso(`Parte ${numero}: ${pesos(resultado.valor)} con ${x.metodo}. Falta ${pesos(resultado.falta)}`);
      partes.splice(k, 1);
      p = await api.pedido(p.id);
      if (!partes.length) partes = [{ valor: falta(), metodo: METODOS[0], recibido: "" }];
    } catch (error) {
      aviso(error.message);
    } finally {
      cobrando = false;
    }
    if (document.getElementById("dialogo").open) pintar();
  }

  document.getElementById("dialogo").addEventListener("close", () => ctx.refrescar(), { once: true });
  pintar();
}

// Después de cada pago: imprime el ticket de ese pago (solo sus platos) y, si la cuenta quedó
// cerrada, vuelve a las mesas o domicilios.
async function despuesDeCobrar(ctx, p, titulo, resultado, metodo, recibido, imprimirTicket) {
  if (p.tipo === "domicilio") ctx.imprimirPendientes();
  if (imprimirTicket) {
    const actual = await api.pedido(p.id);
    await imprimir(ticketCuenta({
      ...actual,
      pedido_items: actual.pedido_items.filter((i) => i.pago_id === resultado.pago_id),
      envio: resultado.cerrada ? actual.envio : 0,
      estado: "pagado",
      metodo_pago: metodo,
      cerrado: actual.cerrado ?? new Date().toISOString(),
    }, ctx.negocio, { mesa: titulo, recibido }));
  }
  if (resultado.cerrada) {
    cerrarDialogo();
    aviso("Cuenta cobrada");
    ctx.ir(p.tipo === "mesa" ? "mesas" : "domicilios");
  }
}

// Multicuenta: los productos que faltan por pagar se reparten entre varias cuentas (una por
// persona) arrastrándolos, o tocando el producto y luego la cuenta. Un producto también se puede
// dividir entre todas las cuentas (ej. una gourmet entre 2: $12.500 cada una). Cada cuenta se
// cobra aparte, con su propio método. La última cuenta que se cobra se lleva lo que falte
// (incluido el envío), así la suma siempre cuadra.
function multicuenta(ctx, pedidoInicial, titulo) {
  const $dialogo = document.getElementById("dialogo");
  let p = pedidoInicial;
  // Cada cuenta guarda cuántas unidades de cada plato lleva: Map(id del plato → cantidad).
  let siguiente = 1;
  const nuevaCuenta = () => ({ numero: siguiente++, platos: new Map(), metodo: METODOS[0], recibido: "" });
  let cuentas = [nuevaCuenta(), nuevaCuenta()];
  // Productos divididos: una unidad repartida en partes de dinero, una por cuenta.
  // { id, item, nombre, partes: Map(número de cuenta → { valor, pagado }) }
  let divididos = [];
  let siguienteDivision = 1;
  let elegida = null; // { item, desde } cuando se toca un producto para moverlo o dividirlo
  let imprimirTickets = preferencia("cuenta");
  let cobrando = false;

  const pendientes = () => p.pedido_items.filter((i) => !i.pago_id).sort((a, b) => a.creado.localeCompare(b.creado));
  const falta = () => totalCuenta(p) - (p.pagos ?? []).reduce((s, x) => s + x.valor, 0);
  const enCuentas = (id) => cuentas.reduce((s, c) => s + (c.platos.get(id) ?? 0), 0);
  const divididosDe = (id) => divididos.filter((d) => d.item === id).length;
  const sinAsignarDe = (item) => item.cantidad - enCuentas(item.id) - divididosDe(item.id);
  const partesDe = (c) => divididos.flatMap((d) => {
    const parte = d.partes.get(c.numero);
    return parte && !parte.pagado ? [{ d, ...parte }] : [];
  });
  const sumaPlatos = (c) => {
    const items = pendientes();
    return [...c.platos].reduce((s, [id, n]) => s + n * (items.find((i) => i.id === id)?.precio ?? 0), 0);
  };
  const tieneAlgo = (c) => [...c.platos.values()].some((n) => n > 0) || partesDe(c).length > 0;
  // Es la última si, después de ella, ya no queda nada por asignar ni por cobrar en otras cuentas.
  const esUltima = (c) => tieneAlgo(c)
    && pendientes().every((i) => sinAsignarDe(i) <= 0)
    && cuentas.every((o) => o === c || !tieneAlgo(o));
  const totalDe = (c) => (esUltima(c) ? falta() : sumaPlatos(c) + partesDe(c).reduce((s, x) => s + x.valor, 0));

  // Tras un pago los platos cambian (se separan o desaparecen): se ajustan las cuentas.
  const ajustar = () => {
    const items = pendientes();
    divididos = divididos.filter((d) => items.some((i) => i.id === d.item) || [...d.partes.values()].some((x) => x.pagado));
    for (const c of cuentas) {
      for (const [id, n] of [...c.platos]) {
        const item = items.find((i) => i.id === id);
        if (!item) c.platos.delete(id);
        else c.platos.set(id, Math.min(n, item.cantidad));
      }
    }
    for (const item of items) {
      let sobra = -sinAsignarDe(item);
      for (const c of [...cuentas].reverse()) {
        if (sobra <= 0) break;
        const quita = Math.min(sobra, c.platos.get(item.id) ?? 0);
        c.platos.set(item.id, (c.platos.get(item.id) ?? 0) - quita);
        sobra -= quita;
      }
    }
  };

  const ficha = (item, desde) => `<button type="button" class="mc-ficha${elegida && elegida.item === item.id && elegida.desde === desde ? " elegida" : ""}"
      data-item="${item.id}" data-desde="${desde}">${esc(item.nombre)}<small>${pesos(item.precio)}</small></button>`;
  const fichas = (lista) => lista.flatMap(([item, n, desde]) => Array.from({ length: n }, () => ficha(item, desde))).join("");
  const fichaParte = (x, conDeshacer) => `<span class="mc-ficha mc-parte">${esc(x.d.nombre)} <small>1/${x.d.partes.size} · ${pesos(x.valor)}</small>
      ${conDeshacer ? `<button type="button" class="icono-boton" data-deshacer="${x.d.id}" aria-label="Deshacer división" style="padding:0 0 0 4px">✕</button>` : ""}</span>`;

  function pintar() {
    ajustar();
    const items = pendientes();
    const sinAsignar = items.map((i) => [i, sinAsignarDe(i), -1]).filter(([, n]) => n > 0);
    const totalSin = sinAsignar.reduce((s, [i, n]) => s + i.precio * n, 0);
    const itemElegido = elegida && items.find((i) => i.id === elegida.item);
    const $c = mostrar(`
      <div class="mc-cabeza">
        <h2>Multicuenta · ${esc(titulo)}</h2>
        <button type="button" class="icono-boton" id="mc-cerrar" aria-label="Cerrar">✕</button>
      </div>
      <p class="suave" style="margin:0">Arrastra cada producto a la cuenta de quien lo paga. En el celular también puedes tocar el producto y después la cuenta.
        Si un producto lo pagan entre varios, tócalo y usa «Dividir entre las cuentas».</p>
      ${itemElegido ? `<div class="mc-zona" style="border-style:solid;border-color:var(--acento);display:flex;gap:10px;align-items:center;flex-wrap:wrap">
        <span>Elegiste <strong>${esc(itemElegido.nombre)}</strong> (${pesos(itemElegido.precio)})</span>
        <button type="button" class="principal chico" id="mc-dividir">÷ Dividir entre las ${cuentas.length} cuentas (${pesos(Math.floor(itemElegido.precio / cuentas.length / 100) * 100)} c/u)</button>
        <button type="button" class="chico" id="mc-soltar">Cancelar</button></div>` : ""}
      <div class="mc-zona mc-sin" data-zona="-1">
        <div class="mc-titulo"><span>Sin asignar</span><span class="suave">${pesos(totalSin)}</span></div>
        <div class="mc-fichas">${sinAsignar.length ? fichas(sinAsignar) : `<p class="mc-vacia">Todo está repartido ✓</p>`}</div>
      </div>
      <div class="mc-cuentas">
        ${cuentas.map((c, k) => {
          const lista = items.map((i) => [i, c.platos.get(i.id) ?? 0, k]).filter(([, n]) => n > 0);
          const partes = partesDe(c);
          const total = totalDe(c);
          const recibido = Number(c.recibido) || 0;
          return `<div class="mc-zona mc-cuenta" data-zona="${k}">
            <div class="mc-titulo"><span>Cuenta ${c.numero}</span>
              ${cuentas.length > 1 && !partes.length ? `<button type="button" class="icono-boton" data-quitar-cuenta="${k}" aria-label="Quitar cuenta">✕</button>` : ""}</div>
            <div class="mc-fichas">${lista.length || partes.length
              ? fichas(lista) + partes.map((x) => fichaParte(x, ![...x.d.partes.values()].some((y) => y.pagado))).join("")
              : `<p class="mc-vacia">Suelta aquí los productos</p>`}</div>
            <div class="mc-total"><span class="suave">Total${esUltima(c) && (p.envio || falta() !== sumaPlatos(c) + partes.reduce((s, x) => s + x.valor, 0)) ? " (lo que falta)" : ""}</span><strong>${pesos(total)}</strong></div>
            <select data-metodo="${k}" aria-label="Método de pago">${opciones(METODOS, c.metodo)}</select>
            <input data-recibido="${k}" type="number" min="0" step="100" placeholder="Recibido en efectivo (opcional)" value="${esc(c.recibido)}">
            ${recibido && total ? `<small class="${recibido < total ? "error" : "suave"}">${recibido < total ? `Faltan ${pesos(total - recibido)}` : `Cambio: ${pesos(recibido - total)}`}</small>` : ""}
            <button type="button" class="principal" data-cobrar="${k}"${tieneAlgo(c) && total > 0 && !cobrando ? "" : " disabled"}>Cobrar ${pesos(total)}</button>
          </div>`;
        }).join("")}
        <button type="button" class="mc-nueva" id="mc-mas"><span>+</span>Nueva cuenta</button>
      </div>
      ${p.envio ? `<p class="suave" style="margin:0">El envío (${pesos(p.envio)}) se suma a la última cuenta que se cobre.</p>` : ""}
      <label class="opcion"><input type="checkbox" id="mc-imprimir"${imprimirTickets ? " checked" : ""}> Imprimir el ticket de cada cuenta</label>`);
    $dialogo.classList.add("ancho");
    activar($c);
  }

  function mover(itemId, desde, hacia) {
    if (desde === hacia) return;
    const item = pendientes().find((i) => i.id === itemId);
    if (!item) return;
    if (desde >= 0) {
      const c = cuentas[desde];
      if (!c?.platos.get(itemId)) return;
      c.platos.set(itemId, c.platos.get(itemId) - 1);
    } else if (sinAsignarDe(item) <= 0) return;
    if (hacia >= 0) cuentas[hacia].platos.set(itemId, (cuentas[hacia].platos.get(itemId) ?? 0) + 1);
    elegida = null;
    pintar();
  }

  // Divide una unidad del producto elegido en partes iguales (redondeadas a $100) entre todas
  // las cuentas; la última parte se queda con el resto.
  function dividir() {
    const item = pendientes().find((i) => i.id === elegida?.item);
    if (!item) return;
    if (elegida.desde >= 0) {
      const c = cuentas[elegida.desde];
      if (!c?.platos.get(item.id)) return;
      c.platos.set(item.id, c.platos.get(item.id) - 1);
    } else if (sinAsignarDe(item) <= 0) return;
    const n = cuentas.length;
    const base = Math.floor(item.precio / n / 100) * 100;
    divididos.push({
      id: siguienteDivision++, item: item.id, nombre: item.nombre,
      partes: new Map(cuentas.map((c, k) => [c.numero, { valor: k === n - 1 ? item.precio - base * (n - 1) : base, pagado: false }])),
    });
    elegida = null;
    pintar();
  }

  function activar($c) {
    $c.querySelector("#mc-cerrar").addEventListener("click", () => cerrarDialogo());
    $c.querySelector("#mc-mas").addEventListener("click", () => {
      cuentas.push(nuevaCuenta());
      pintar();
    });
    $c.querySelector("#mc-dividir")?.addEventListener("click", dividir);
    $c.querySelector("#mc-soltar")?.addEventListener("click", () => {
      elegida = null;
      pintar();
    });
    $c.querySelectorAll("[data-deshacer]").forEach(($b) =>
      $b.addEventListener("click", (e) => {
        e.stopPropagation();
        divididos = divididos.filter((d) => d.id !== Number($b.dataset.deshacer)); // la unidad vuelve a "Sin asignar"
        pintar();
      }));
    $c.querySelector("#mc-imprimir").addEventListener("change", (e) => (imprimirTickets = e.target.checked));
    $c.querySelectorAll("[data-quitar-cuenta]").forEach(($b) =>
      $b.addEventListener("click", () => {
        cuentas.splice(Number($b.dataset.quitarCuenta), 1); // sus productos vuelven a "Sin asignar"
        pintar();
      }));
    $c.querySelectorAll("[data-metodo]").forEach(($s) =>
      $s.addEventListener("change", () => (cuentas[Number($s.dataset.metodo)].metodo = $s.value)));
    $c.querySelectorAll("[data-recibido]").forEach(($i) =>
      $i.addEventListener("change", () => {
        cuentas[Number($i.dataset.recibido)].recibido = $i.value;
        pintar();
      }));
    $c.querySelectorAll("[data-cobrar]").forEach(($b) =>
      $b.addEventListener("click", () => cobrarCuenta(Number($b.dataset.cobrar))));

    // Tocar una zona con un producto elegido lo mueve ahí.
    $c.querySelectorAll("[data-zona]").forEach(($z) =>
      $z.addEventListener("click", (e) => {
        if (!elegida || e.target.closest(".mc-ficha, select, input, button")) return;
        mover(elegida.item, elegida.desde, Number($z.dataset.zona));
      }));

    // Arrastrar con el dedo o el mouse (eventos de puntero: sirven igual en celular y computador).
    $c.querySelectorAll(".mc-ficha[data-item]").forEach(($f) => {
      $f.addEventListener("pointerdown", (inicio) => {
        if (inicio.button !== 0) return;
        const item = $f.dataset.item;
        const desde = Number($f.dataset.desde);
        let $fantasma = null;
        let $encima = null;
        $f.setPointerCapture(inicio.pointerId);
        const zonaEn = (x, y) => document.elementFromPoint(x, y)?.closest("[data-zona]");
        const alMover = (e) => {
          if (!$fantasma && Math.hypot(e.clientX - inicio.clientX, e.clientY - inicio.clientY) < 6) return;
          if (!$fantasma) {
            $fantasma = $f.cloneNode(true);
            $fantasma.classList.add("mc-fantasma");
            $dialogo.append($fantasma);
            $f.classList.add("arrastrando");
          }
          $fantasma.style.left = `${e.clientX}px`;
          $fantasma.style.top = `${e.clientY}px`;
          const $z = zonaEn(e.clientX, e.clientY);
          if ($z !== $encima) {
            $encima?.classList.remove("encima");
            $z?.classList.add("encima");
            $encima = $z;
          }
        };
        const alSoltar = (e) => {
          $f.removeEventListener("pointermove", alMover);
          $f.removeEventListener("pointerup", alSoltar);
          $f.removeEventListener("pointercancel", alSoltar);
          if ($fantasma) {
            $fantasma.remove();
            $f.classList.remove("arrastrando");
            $encima?.classList.remove("encima");
            const $z = e.type === "pointerup" ? zonaEn(e.clientX, e.clientY) : null;
            if ($z) mover(item, desde, Number($z.dataset.zona));
          } else if (e.type === "pointerup") {
            // Fue un toque: se elige (o se suelta) el producto para moverlo o dividirlo.
            elegida = elegida && elegida.item === item && elegida.desde === desde ? null : { item, desde };
            pintar();
          }
        };
        $f.addEventListener("pointermove", alMover);
        $f.addEventListener("pointerup", alSoltar);
        $f.addEventListener("pointercancel", alSoltar);
      });
    });
  }

  // Cobra una cuenta: sus productos enteros (quedan marcados como pagados) y sus partes de los
  // productos divididos (como abono por valor). Si es la última, cobra todo lo que falta.
  async function cobrarCuenta(k) {
    const c = cuentas[k];
    if (cobrando || !tieneAlgo(c)) return;
    const items = [...c.platos].filter(([, n]) => n > 0).map(([id, cantidad]) => ({ id, cantidad }));
    const partes = partesDe(c);
    const ultima = esUltima(c);
    const lineas = []; // para el ticket
    const todos = pendientes();
    for (const x of items) {
      const item = todos.find((i) => i.id === x.id);
      lineas.push({ ...item, cantidad: x.cantidad });
    }
    for (const x of partes) {
      lineas.push({ cantidad: 1, nombre: `${x.d.nombre} (1/${x.d.partes.size})`, precio: x.valor, opciones: [], nota: "" });
    }
    cobrando = true;
    let cerrada = false;
    let cobrado = 0;
    try {
      if (items.length) {
        const r = await api.cobrarParte(p.id, items, c.metodo);
        cobrado += r.valor;
        cerrada = r.cerrada;
        p = await api.pedido(p.id);
      }
      const abono = cerrada ? 0 : ultima ? falta() : partes.reduce((s, x) => s + x.valor, 0);
      if (abono > 0) {
        const r = await api.abonar(p.id, abono, c.metodo);
        cobrado += r.valor;
        cerrada = r.cerrada;
      }
      partes.forEach((x) => (x.d.partes.get(c.numero).pagado = true));
      guardarPreferencia("cuenta", imprimirTickets);
      aviso(`Cuenta ${c.numero}: ${pesos(cobrado)} con ${c.metodo}`);
      if (p.tipo === "domicilio") ctx.imprimirPendientes();
      if (imprimirTickets) {
        const sumaLineas = lineas.reduce((s, i) => s + i.precio * i.cantidad, 0);
        await imprimir(ticketCuenta({
          ...p, pedido_items: lineas, envio: Math.max(0, cobrado - sumaLineas), estado: "pagado",
          metodo_pago: c.metodo, cerrado: new Date().toISOString(),
        }, ctx.negocio, { mesa: `${titulo} · Cuenta ${c.numero}`, recibido: Number(c.recibido) || 0 }));
      }
      cuentas.splice(k, 1);
      if (cerrada) {
        cerrarDialogo();
        aviso("Cuenta cobrada");
        ctx.ir(p.tipo === "mesa" ? "mesas" : "domicilios");
        return;
      }
      p = await api.pedido(p.id);
      if (!cuentas.length) cuentas.push(nuevaCuenta());
    } catch (error) {
      aviso(error.message);
      p = await api.pedido(p.id).catch(() => p);
    } finally {
      cobrando = false;
    }
    if ($dialogo.open) pintar();
  }

  // Al cerrar la ventana se quita el tamaño ancho y se actualiza la cuenta.
  $dialogo.addEventListener("close", () => {
    $dialogo.classList.remove("ancho");
    ctx.refrescar();
  }, { once: true });
  pintar();
}
