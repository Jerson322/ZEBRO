// Pantallas del sistema. Toda la lógica de negocio está en datos.js.
import * as d from "./datos.js";
import * as nube from "./nube.js";

const SECCIONES = {
  inicio: "Inicio",
  ventas: "Ventas",
  cartera: "Por cobrar",
  gastos: "Gastos",
  productos: "Productos",
  clientes: "Clientes",
  reportes: "Reportes",
  respaldo: "Respaldo",
};
const DIAS_PARA_RECORDAR_RESPALDO = 7;

function abrirAlmacen() {
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

const almacen = abrirAlmacen();
let datos = nube.nubeActiva ? d.datosVacios() : d.cargar(almacen);
let estadoNube = "guardado";
const periodo = { desde: d.hoy().slice(0, 8) + "01", hasta: d.hoy() };

const $vista = document.getElementById("vista");
const $menu = document.getElementById("menu");
const $dialogo = document.getElementById("dialogo");

const pesos = (n) => (n < 0 ? "-$" : "$") + Math.abs(n).toLocaleString("es-CO");
const fechaCorta = (f) => f.split("-").reverse().join("/");
const esc = (t) =>
  String(t ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const opciones = (lista, elegido = "") =>
  lista.map((o) => `<option${o === elegido ? " selected" : ""}>${esc(o)}</option>`).join("");

function persistir() {
  if (nube.nubeActiva) {
    nube.guardar(datos);
    return;
  }
  if (!d.guardar(almacen, datos)) {
    alert("No se pudo guardar en este navegador. Descarga un respaldo para no perder tus datos.");
  }
}

function tabla(columnas, filas, vacio) {
  if (!filas.length) return `<p class="vacio">${vacio}</p>`;
  const cabecera = columnas.map((c) => `<th class="${c.startsWith("#") ? "num" : ""}">${c.replace("#", "")}</th>`).join("");
  return `<table><thead><tr>${cabecera}</tr></thead><tbody>${filas.join("")}</tbody></table>`;
}

function tarjeta(titulo, valor, clase = "") {
  return `<div class="tarjeta"><small>${titulo}</small><strong class="${clase}">${valor}</strong></div>`;
}

const signo = (n) => (n < 0 ? "negativo" : "positivo");

// Vistas

const vistas = {
  inicio() {
    const r = d.resumen(datos, d.hoy().slice(0, 8) + "01", d.hoy());
    const cartera = d.porCobrar(datos).reduce((s, v) => s + d.saldoVenta(v), 0);
    const bajos = d.stockBajo(datos);
    const ultimas = [...datos.ventas].reverse().slice(0, 5);
    return `
      <div class="encabezado"><h1>Inicio</h1><button class="principal" data-accion="nueva-venta">Nueva venta</button></div>
      ${avisoRespaldo()}
      <div class="tarjetas">
        ${tarjeta("Ventas del mes", pesos(r.totalVentas))}
        ${tarjeta("Gastos del mes", pesos(r.totalGastos))}
        ${tarjeta("Utilidad del mes", pesos(r.utilidadNeta), signo(r.utilidadNeta))}
        ${tarjeta("Por cobrar", pesos(cartera))}
        ${tarjeta("Valor del inventario", pesos(d.valorInventario(datos)))}
      </div>
      <div class="columnas">
        <div class="panel"><h2>Últimas ventas</h2>
          ${tabla(["N.°", "Cliente", "#Total"], ultimas.map((v) => `
            <tr class="${v.estado === "anulada" ? "anulada" : ""}"><td>${v.numero}</td><td class="ancho">${esc(v.cliente)}</td>
            <td class="num">${pesos(d.totalVenta(v))}</td></tr>`), "Todavía no hay ventas.")}
        </div>
        <div class="panel"><h2>Productos por agotarse</h2>
          ${tabla(["Producto", "#Quedan"], bajos.map((p) => `
            <tr><td class="ancho">${esc(p.nombre)}</td><td class="num negativo">${p.stock}</td></tr>`), "Todo tiene existencias.")}
        </div>
      </div>`;
  },

  ventas() {
    const filas = [...datos.ventas].reverse().map((v) => {
      const saldo = d.saldoVenta(v);
      const estado = v.estado === "anulada" ? "Anulada" : saldo > 0 ? `Debe ${pesos(saldo)}` : "Pagada";
      return `<tr class="${v.estado === "anulada" ? "anulada" : ""}">
        <td>${v.numero}</td><td>${fechaCorta(v.fecha)}</td><td class="ancho">${esc(v.cliente)}</td><td>${esc(v.metodo)}</td>
        <td class="num">${pesos(d.totalVenta(v))}</td><td><span class="etiqueta">${estado}</span></td>
        <td class="acciones"><button class="chico" data-accion="ver-venta" data-id="${v.id}">Ver</button></td></tr>`;
    });
    return `
      <div class="encabezado"><h1>Ventas</h1><button class="principal" data-accion="nueva-venta">Nueva venta</button></div>
      <div class="panel">${tabla(["N.°", "Fecha", "Cliente", "Pago", "#Total", "Estado", ""], filas, "Todavía no hay ventas.")}</div>`;
  },

  cartera() {
    const pendientes = d.porCobrar(datos);
    const total = pendientes.reduce((s, v) => s + d.saldoVenta(v), 0);
    const filas = pendientes.map((v) => `<tr>
      <td>${v.numero}</td><td>${fechaCorta(v.fecha)}</td><td class="ancho">${esc(v.cliente)}</td>
      <td class="num">${pesos(d.totalVenta(v))}</td><td class="num negativo">${pesos(d.saldoVenta(v))}</td>
      <td class="acciones"><button class="chico" data-accion="abonar" data-id="${v.id}">Registrar abono</button></td></tr>`);
    return `
      <div class="encabezado"><h1>Por cobrar</h1></div>
      <div class="tarjetas">${tarjeta("Total por cobrar", pesos(total))}</div>
      <div class="panel">${tabla(["N.°", "Fecha", "Cliente", "#Total", "#Saldo", ""], filas, "Nadie te debe. 🎉")}</div>`;
  },

  gastos() {
    const filas = [...datos.gastos].sort((a, b) => b.fecha.localeCompare(a.fecha)).map((g) => `<tr>
      <td>${fechaCorta(g.fecha)}</td><td>${esc(g.categoria)}</td><td class="ancho">${esc(g.descripcion)}</td>
      <td>${esc(g.metodo)}</td><td class="num">${pesos(g.valor)}</td>
      <td class="acciones"><button class="chico peligro" data-accion="eliminar-gasto" data-id="${g.id}">Eliminar</button></td></tr>`);
    return `
      <div class="encabezado"><h1>Gastos</h1><button class="principal" data-accion="nuevo-gasto">Nuevo gasto</button></div>
      <div class="panel">${tabla(["Fecha", "Categoría", "Descripción", "Pago", "#Valor", ""], filas, "Todavía no hay gastos.")}</div>`;
  },

  productos() {
    const filas = [...datos.productos].sort((a, b) => a.nombre.localeCompare(b.nombre, "es")).map((p) => `<tr>
      <td class="ancho">${esc(p.nombre)}<br><small class="suave">${esc(p.referencia)}</small></td>
      <td class="num">${pesos(p.costo)}</td><td class="num">${pesos(p.precio)}</td>
      <td class="num ${p.stock <= p.stockMinimo ? "negativo" : ""}">${p.stock}</td>
      <td class="acciones">
        <button class="chico" data-accion="ajustar-stock" data-id="${p.id}">Entrada / salida</button>
        <button class="chico" data-accion="editar-producto" data-id="${p.id}">Editar</button>
        <button class="chico peligro" data-accion="eliminar-producto" data-id="${p.id}">Eliminar</button>
      </td></tr>`);
    const movimientos = [...datos.movimientos].reverse().slice(0, 15).map((m) => `<tr>
      <td>${fechaCorta(m.fecha)}</td><td class="ancho">${esc(m.producto)}</td><td class="ancho">${esc(m.motivo)}</td>
      <td class="num ${m.cantidad < 0 ? "negativo" : "positivo"}">${m.cantidad > 0 ? "+" : ""}${m.cantidad}</td>
      <td class="num">${m.saldo}</td></tr>`);
    return `
      <div class="encabezado"><h1>Productos</h1><button class="principal" data-accion="nuevo-producto">Nuevo producto</button></div>
      <div class="panel">${tabla(["Producto", "#Costo", "#Precio", "#Stock", ""], filas, "Agrega tu primer producto.")}</div>
      <div class="panel"><h2>Últimos movimientos de inventario</h2>
        ${tabla(["Fecha", "Producto", "Motivo", "#Cantidad", "#Saldo"], movimientos, "Sin movimientos.")}</div>`;
  },

  clientes() {
    const filas = [...datos.clientes].sort((a, b) => a.nombre.localeCompare(b.nombre, "es")).map((c) => {
      const saldo = d.porCobrar(datos).filter((v) => v.clienteId === c.id).reduce((s, v) => s + d.saldoVenta(v), 0);
      return `<tr><td class="ancho">${esc(c.nombre)}</td><td>${esc(c.documento)}</td><td>${esc(c.telefono)}</td>
        <td class="num ${saldo > 0 ? "negativo" : ""}">${pesos(saldo)}</td>
        <td class="acciones">
          <button class="chico" data-accion="editar-cliente" data-id="${c.id}">Editar</button>
          <button class="chico peligro" data-accion="eliminar-cliente" data-id="${c.id}">Eliminar</button>
        </td></tr>`;
    });
    return `
      <div class="encabezado"><h1>Clientes</h1><button class="principal" data-accion="nuevo-cliente">Nuevo cliente</button></div>
      <div class="panel">${tabla(["Nombre", "Documento", "Teléfono", "#Debe", ""], filas, "Agrega tu primer cliente.")}</div>`;
  },

  reportes() {
    const r = d.resumen(datos, periodo.desde, periodo.hasta);
    return `
      <div class="encabezado"><h1>Reportes</h1></div>
      <div class="filtros">
        <label>Desde<input type="date" data-periodo="desde" value="${periodo.desde}"></label>
        <label>Hasta<input type="date" data-periodo="hasta" value="${periodo.hasta}"></label>
      </div>
      <div class="tarjetas">
        ${tarjeta(`Ventas (${r.cantidadVentas})`, pesos(r.totalVentas))}
        ${tarjeta("Costo de lo vendido", pesos(r.costo))}
        ${tarjeta("Utilidad bruta", pesos(r.utilidadBruta), signo(r.utilidadBruta))}
        ${tarjeta("Gastos", pesos(r.totalGastos))}
        ${tarjeta("Utilidad neta", pesos(r.utilidadNeta), signo(r.utilidadNeta))}
        ${tarjeta("Dinero cobrado", pesos(r.cobrado))}
      </div>
      <div class="columnas">
        <div class="panel"><h2>Productos más vendidos</h2>
          ${tabla(["Producto", "#Unidades", "#Ventas", "#Utilidad"], r.productos.map((p) => `<tr>
            <td class="ancho">${esc(p.nombre)}</td><td class="num">${p.cantidad}</td>
            <td class="num">${pesos(p.total)}</td><td class="num">${pesos(p.utilidad)}</td></tr>`), "Sin ventas en este periodo.")}
        </div>
        <div class="panel"><h2>Gastos por categoría</h2>
          ${tabla(["Categoría", "#Valor"], r.gastosPorCategoria.map((g) => `<tr>
            <td>${esc(g.categoria)}</td><td class="num">${pesos(g.valor)}</td></tr>`), "Sin gastos en este periodo.")}
        </div>
      </div>`;
  },

  respaldo() {
    return `
      <div class="encabezado"><h1>Respaldo</h1></div>
      ${nube.nubeActiva
        ? `<div class="alerta">Tus datos se guardan en tu cuenta. Un respaldo es una copia extra en un archivo, por si acaso.</div>`
        : `<div class="alerta">Tus datos se guardan <strong>solo en este navegador</strong>, en este dispositivo.
            Si borras los datos del navegador o cambias de equipo, se pierden. Descarga un respaldo con frecuencia.</div>`}
      <div class="panel">
        <p>Último respaldo: <strong>${datos.ultimoRespaldo ? fechaCorta(datos.ultimoRespaldo) : "nunca"}</strong></p>
        <div class="botones" style="justify-content:flex-start">
          <button class="principal" data-accion="descargar-respaldo">Descargar respaldo</button>
          <button data-accion="elegir-respaldo">Restaurar un respaldo</button>
          <input type="file" id="archivo-respaldo" accept="application/json,.json" hidden>
        </div>
      </div>`;
  },
};

function avisoRespaldo() {
  if (nube.nubeActiva) return "";
  if (!datos.ventas.length && !datos.productos.length) return "";
  const dias = datos.ultimoRespaldo ? (new Date(d.hoy()) - new Date(datos.ultimoRespaldo)) / 86400000 : Infinity;
  if (dias < DIAS_PARA_RECORDAR_RESPALDO) return "";
  return `<div class="alerta">Hace rato no descargas un respaldo. <a href="#respaldo">Hazlo ahora</a> para no perder tus datos.</div>`;
}

function seccionActual() {
  const seccion = location.hash.slice(1);
  return SECCIONES[seccion] ? seccion : "inicio";
}

function pieDelMenu() {
  if (!nube.nubeActiva) return "";
  return `<div class="pie"><small id="estado-nube"></small><button class="chico" data-accion="salir">Salir</button></div>`;
}

function pintar() {
  const actual = seccionActual();
  $menu.hidden = false;
  $menu.innerHTML =
    `<div class="marca">ZEBRO</div>` +
    Object.entries(SECCIONES)
      .map(([id, nombre]) => `<a href="#${id}" class="${id === actual ? "activo" : ""}">${nombre}</a>`)
      .join("") +
    pieDelMenu();
  $vista.innerHTML = vistas[actual]();
  pintarEstadoNube();
}

function pintarEstadoNube() {
  const textos = { guardando: "Guardando…", guardado: "Guardado", error: "Sin guardar: revisa tu conexión" };
  const $estado = document.getElementById("estado-nube");
  if (!$estado) return;
  $estado.textContent = textos[estadoNube] ?? "";
  $estado.classList.toggle("negativo-claro", estadoNube === "error");
}

// Sesión y nube

function pantallaLogin() {
  $menu.hidden = true;
  $vista.innerHTML = `<form class="panel acceso" id="acceso">
    <h1>ZEBRO</h1>
    <label>Correo<input name="correo" type="email" autocomplete="username" required></label>
    <label>Clave<input name="clave" type="password" autocomplete="current-password" required></label>
    <p class="error" hidden></p>
    <button type="submit" class="principal">Entrar</button>
  </form>`;
  const $form = document.getElementById("acceso");
  $form.addEventListener("submit", async (evento) => {
    evento.preventDefault();
    const { correo, clave } = Object.fromEntries(new FormData($form));
    const $boton = $form.querySelector("button");
    $boton.disabled = true;
    try {
      await nube.iniciarSesion(correo, clave);
      await entrar();
    } catch (error) {
      const $error = $form.querySelector(".error");
      $error.textContent = error.message;
      $error.hidden = false;
      $boton.disabled = false;
    }
  });
}

// Sin datos cargados no se muestra el sistema, para no guardar encima un sistema vacío.
function pantallaError(mensaje) {
  $menu.hidden = true;
  $vista.innerHTML = `<div class="panel acceso">
    <h1>ZEBRO</h1>
    <p>${esc(mensaje)}</p>
    <button class="principal" data-accion="reintentar">Reintentar</button>
  </div>`;
}

async function entrar() {
  try {
    let guardados = await nube.leer();
    if (guardados === null) {
      // Primera vez: lo que haya en este navegador pasa a la cuenta.
      const locales = d.cargar(almacen);
      if (await nube.crear(locales)) guardados = locales;
      else guardados = await nube.leer();
    }
    datos = { ...d.datosVacios(), ...guardados };
    pintar();
  } catch {
    pantallaError("No pudimos cargar tus datos. Revisa tu conexión e inténtalo de nuevo.");
  }
}

async function iniciar() {
  if (!nube.nubeActiva) {
    pintar();
    return;
  }
  if (!nube.libreriaCargada()) {
    pantallaError("No se pudo cargar el sistema. Revisa tu conexión e inténtalo de nuevo.");
    return;
  }
  try {
    if (await nube.haySesion()) await entrar();
    else pantallaLogin();
  } catch {
    pantallaError("No pudimos revisar tu sesión. Revisa tu conexión e inténtalo de nuevo.");
  }
}

async function traerCambiosDeOtroDispositivo() {
  if (!nube.nubeActiva || $menu.hidden || $dialogo.open) return;
  try {
    const nuevos = await nube.leerSiCambio();
    if (nuevos && !$dialogo.open) {
      datos = { ...d.datosVacios(), ...nuevos };
      pintar();
    }
  } catch {
    // Sin conexión: se vuelve a intentar la próxima vez que abras la página.
  }
}

nube.alCambiarEstado(async (estado) => {
  if (estado === "conflicto") {
    alert("Tus datos cambiaron en otro dispositivo. Tu último cambio no se guardó: revísalo y hazlo otra vez.");
    if ($dialogo.open) $dialogo.close();
    estadoNube = "guardado";
    await entrar();
    return;
  }
  estadoNube = estado;
  pintarEstadoNube();
});

// Diálogos

// Abre un formulario. Si guardar() lanza un error, se muestra y el formulario sigue abierto.
function formulario(titulo, campos, guardar, textoBoton = "Guardar") {
  $dialogo.innerHTML = `<form method="dialog" novalidate>
    <h2>${titulo}</h2>
    ${campos}
    <p class="error" hidden></p>
    <div class="botones">
      <button type="button" data-accion="cerrar">Cancelar</button>
      <button type="submit" class="principal">${textoBoton}</button>
    </div>
  </form>`;
  const $form = $dialogo.querySelector("form");
  $form.addEventListener("submit", (evento) => {
    evento.preventDefault();
    try {
      guardar(Object.fromEntries(new FormData($form)), $form);
      persistir();
      $dialogo.close();
      pintar();
    } catch (error) {
      const $error = $form.querySelector(".error");
      $error.textContent = error.message;
      $error.hidden = false;
    }
  });
  $dialogo.showModal();
  return $form;
}

function formularioProducto(p = {}) {
  const nuevo = !p.id;
  formulario(nuevo ? "Nuevo producto" : "Editar producto", `
    <label>Nombre<input name="nombre" value="${esc(p.nombre)}"></label>
    <label>Referencia (opcional)<input name="referencia" value="${esc(p.referencia)}"></label>
    <div class="fila">
      <label>Costo<input name="costo" type="number" min="0" step="1" value="${p.costo ?? 0}"></label>
      <label>Precio de venta<input name="precio" type="number" min="0" step="1" value="${p.precio ?? 0}"></label>
    </div>
    <div class="fila">
      ${nuevo ? `<label>Stock inicial<input name="stock" type="number" min="0" step="1" value="0"></label>` : ""}
      <label>Avisar cuando queden<input name="stockMinimo" type="number" min="0" step="1" value="${p.stockMinimo ?? 0}"></label>
    </div>`, (c) => d.guardarProducto(datos, { ...c, id: p.id }));
}

function formularioCliente(c = {}) {
  formulario(c.id ? "Editar cliente" : "Nuevo cliente", `
    <label>Nombre<input name="nombre" value="${esc(c.nombre)}"></label>
    <div class="fila">
      <label>Documento<input name="documento" value="${esc(c.documento)}"></label>
      <label>Teléfono<input name="telefono" type="tel" value="${esc(c.telefono)}"></label>
    </div>
    <label>Dirección<input name="direccion" value="${esc(c.direccion)}"></label>`,
    (campos) => d.guardarCliente(datos, { ...campos, id: c.id }));
}

function formularioStock(p) {
  formulario(`Entrada o salida: ${esc(p.nombre)}`, `
    <p class="suave" style="margin:0">Stock actual: ${p.stock}</p>
    <div class="fila">
      <label>Tipo<select name="tipo"><option value="entrada">Entrada (compra)</option><option value="salida">Salida (daño, pérdida…)</option></select></label>
      <label>Cantidad<input name="cantidad" type="number" min="1" step="1" value="1"></label>
    </div>
    <div class="fila">
      <label>Costo por unidad (solo entradas, opcional)<input name="costo" type="number" min="0" step="1"></label>
      <label>Fecha<input name="fecha" type="date" value="${d.hoy()}"></label>
    </div>
    <label>Motivo (opcional)<input name="motivo"></label>`,
    (c) => d.ajustarStock(datos, { ...c, productoId: p.id }));
}

function formularioGasto() {
  formulario("Nuevo gasto", `
    <div class="fila">
      <label>Fecha<input name="fecha" type="date" value="${d.hoy()}"></label>
      <label>Categoría<select name="categoria">${opciones(d.CATEGORIAS_GASTO)}</select></label>
    </div>
    <label>Descripción<input name="descripcion"></label>
    <div class="fila">
      <label>Valor<input name="valor" type="number" min="1" step="1"></label>
      <label>Pagado con<select name="metodo">${opciones(d.METODOS_PAGO.filter((m) => m !== "Crédito"))}</select></label>
    </div>`, (c) => d.registrarGasto(datos, c));
}

function lineaVenta() {
  const productos = datos.productos
    .filter((p) => p.stock > 0)
    .sort((a, b) => a.nombre.localeCompare(b.nombre, "es"))
    .map((p) => `<option value="${p.id}">${esc(p.nombre)} (${p.stock})</option>`)
    .join("");
  return `<div class="linea">
    <select data-linea="producto"><option value="">Producto…</option>${productos}</select>
    <input data-linea="cantidad" type="number" min="1" step="1" value="1" aria-label="Cantidad">
    <input data-linea="precio" type="number" min="0" step="1" value="0" aria-label="Precio">
    <button type="button" class="chico" data-accion="quitar-linea" aria-label="Quitar">✕</button>
  </div>`;
}

function leerLineas($form) {
  return [...$form.querySelectorAll(".linea")]
    .map(($l) => ({
      productoId: $l.querySelector('[data-linea="producto"]').value,
      cantidad: $l.querySelector('[data-linea="cantidad"]').value,
      precio: $l.querySelector('[data-linea="precio"]').value,
    }))
    .filter((l) => l.productoId);
}

function formularioVenta() {
  if (!datos.productos.some((p) => p.stock > 0)) {
    alert("Primero agrega productos con existencias.");
    location.hash = "productos";
    return;
  }
  const clientes = [...datos.clientes]
    .sort((a, b) => a.nombre.localeCompare(b.nombre, "es"))
    .map((c) => `<option value="${c.id}">${esc(c.nombre)}</option>`)
    .join("");
  const $form = formulario("Nueva venta", `
    <div class="fila">
      <label>Fecha<input name="fecha" type="date" value="${d.hoy()}"></label>
      <label>Cliente<select name="clienteId"><option value="">Cliente general</option>${clientes}</select></label>
    </div>
    <div id="lineas">${lineaVenta()}</div>
    <button type="button" data-accion="agregar-linea">Agregar otro producto</button>
    <div class="fila">
      <label>Método de pago<select name="metodo">${opciones(d.METODOS_PAGO)}</select></label>
      <label id="abono" hidden>Abono inicial<input name="abonoInicial" type="number" min="0" step="1" value="0"></label>
    </div>
    <div class="total"><span>Total</span><span id="total-venta">$0</span></div>`,
    (c, form) => d.registrarVenta(datos, { ...c, lineas: leerLineas(form) }), "Registrar venta");

  $form.addEventListener("change", (evento) => {
    const $campo = evento.target;
    if ($campo.dataset.linea === "producto") {
      const producto = datos.productos.find((p) => p.id === $campo.value);
      $campo.closest(".linea").querySelector('[data-linea="precio"]').value = producto?.precio ?? 0;
    }
    if ($campo.name === "metodo") $form.querySelector("#abono").hidden = $campo.value !== "Crédito";
    totalFormularioVenta($form);
  });
  $form.addEventListener("input", () => totalFormularioVenta($form));
}

function totalFormularioVenta($form) {
  const total = leerLineas($form).reduce((s, l) => s + Number(l.precio) * Number(l.cantidad), 0);
  $form.querySelector("#total-venta").textContent = pesos(total);
}

function verVenta(v) {
  const lineas = v.lineas.map((l) => `<tr><td class="ancho">${esc(l.nombre)}</td><td class="num">${l.cantidad}</td>
    <td class="num">${pesos(l.precio)}</td><td class="num">${pesos(l.precio * l.cantidad)}</td></tr>`).join("");
  const abonos = v.abonos.map((a) => `<tr><td>${fechaCorta(a.fecha)}</td><td class="num">${pesos(a.valor)}</td></tr>`).join("");
  $dialogo.innerHTML = `<div class="comprobante">
    <h2>Venta #${v.numero}${v.estado === "anulada" ? " (anulada)" : ""}</h2>
    <p class="suave" style="margin:0">Comprobante interno, no es una factura.<br>
      ${fechaCorta(v.fecha)} · ${esc(v.cliente)} · ${esc(v.metodo)}</p>
    <table><thead><tr><th>Producto</th><th class="num">Cant.</th><th class="num">Precio</th><th class="num">Total</th></tr></thead>
      <tbody>${lineas}</tbody></table>
    <div class="total"><span>Total</span><span>${pesos(d.totalVenta(v))}</span></div>
    ${abonos ? `<table><thead><tr><th>Pagos</th><th class="num">Valor</th></tr></thead><tbody>${abonos}</tbody></table>` : ""}
    ${d.saldoVenta(v) > 0 ? `<p class="negativo" style="margin:0">Saldo pendiente: ${pesos(d.saldoVenta(v))}</p>` : ""}
    <div class="botones">
      ${v.estado === "activa" ? `<button class="peligro" data-accion="anular-venta" data-id="${v.id}">Anular venta</button>` : ""}
      <button data-accion="imprimir">Imprimir</button>
      <button data-accion="cerrar">Cerrar</button>
    </div>
  </div>`;
  $dialogo.showModal();
}

function formularioAbono(v) {
  formulario(`Abono a la venta #${v.numero}`, `
    <p class="suave" style="margin:0">${esc(v.cliente)} · Saldo: ${pesos(d.saldoVenta(v))}</p>
    <div class="fila">
      <label>Valor<input name="valor" type="number" min="1" step="1" value="${d.saldoVenta(v)}"></label>
      <label>Fecha<input name="fecha" type="date" value="${d.hoy()}"></label>
    </div>`, (c) => d.registrarAbono(datos, v.id, c));
}

// Respaldo

function descargarRespaldo() {
  datos.ultimoRespaldo = d.hoy();
  persistir();
  const archivo = new Blob([JSON.stringify(datos, null, 2)], { type: "application/json" });
  const enlace = document.createElement("a");
  enlace.href = URL.createObjectURL(archivo);
  enlace.download = `zebro-respaldo-${d.hoy()}.json`;
  enlace.click();
  URL.revokeObjectURL(enlace.href);
  pintar();
}

async function restaurarRespaldo(archivo) {
  try {
    const contenido = d.validarRespaldo(JSON.parse(await archivo.text()));
    const resumen = `${contenido.ventas.length} ventas y ${contenido.productos.length} productos`;
    if (!confirm(`Esto reemplaza todo lo que hay ahora por el respaldo (${resumen}). ¿Continuar?`)) return;
    datos = contenido;
    persistir();
    pintar();
  } catch (error) {
    alert(error instanceof SyntaxError ? "Ese archivo no es un respaldo válido del sistema" : error.message);
  }
}

// Acciones

function confirmarYGuardar(mensaje, accion) {
  if (!confirm(mensaje)) return;
  accion();
  persistir();
  pintar();
}

const porId = (lista, id) => lista.find((x) => x.id === id);

const acciones = {
  "nueva-venta": formularioVenta,
  "ver-venta": (id) => verVenta(porId(datos.ventas, id)),
  "anular-venta": (id) => {
    const venta = porId(datos.ventas, id);
    confirmarYGuardar(`¿Anular la venta #${venta.numero}? El inventario se devuelve.`, () => {
      d.anularVenta(datos, id, d.hoy());
      $dialogo.close();
    });
  },
  abonar: (id) => formularioAbono(porId(datos.ventas, id)),
  "nuevo-gasto": formularioGasto,
  "eliminar-gasto": (id) => confirmarYGuardar("¿Eliminar este gasto?", () => d.eliminarGasto(datos, id)),
  "nuevo-producto": () => formularioProducto(),
  "editar-producto": (id) => formularioProducto(porId(datos.productos, id)),
  "ajustar-stock": (id) => formularioStock(porId(datos.productos, id)),
  "eliminar-producto": (id) => {
    const producto = porId(datos.productos, id);
    confirmarYGuardar(`¿Eliminar ${producto.nombre}? Las ventas ya hechas no cambian.`, () => d.eliminarProducto(datos, id));
  },
  "nuevo-cliente": () => formularioCliente(),
  "editar-cliente": (id) => formularioCliente(porId(datos.clientes, id)),
  "eliminar-cliente": (id) => {
    const cliente = porId(datos.clientes, id);
    confirmarYGuardar(`¿Eliminar a ${cliente.nombre}? Sus ventas no cambian.`, () => d.eliminarCliente(datos, id));
  },
  "agregar-linea": () => document.getElementById("lineas").insertAdjacentHTML("beforeend", lineaVenta()),
  cerrar: () => $dialogo.close(),
  reintentar: iniciar,
  salir: async () => {
    if (nube.hayCambiosPorGuardar() && !confirm("Hay cambios sin guardar y se perderán. ¿Salir de todas formas?")) return;
    await nube.cerrarSesion();
    datos = d.datosVacios();
    pantallaLogin();
  },
  imprimir: () => window.print(),
  "descargar-respaldo": descargarRespaldo,
  "elegir-respaldo": () => document.getElementById("archivo-respaldo").click(),
};

document.addEventListener("click", (evento) => {
  const $boton = evento.target.closest("[data-accion]");
  if (!$boton) return;
  if ($boton.dataset.accion === "quitar-linea") {
    const $form = $boton.closest("form");
    if ($form.querySelectorAll(".linea").length > 1) $boton.closest(".linea").remove();
    totalFormularioVenta($form);
    return;
  }
  acciones[$boton.dataset.accion]($boton.dataset.id);
});

document.addEventListener("change", (evento) => {
  const $campo = evento.target;
  if ($campo.dataset.periodo && $campo.value) {
    periodo[$campo.dataset.periodo] = $campo.value;
    pintar();
  }
  if ($campo.id === "archivo-respaldo" && $campo.files[0]) restaurarRespaldo($campo.files[0]);
});

window.addEventListener("hashchange", () => {
  if (!$menu.hidden) pintar();
});
window.addEventListener("online", () => nube.nubeActiva && nube.enviarPendiente());
window.addEventListener("focus", traerCambiosDeOtroDispositivo);
document.addEventListener("visibilitychange", () => {
  if (!document.hidden) traerCambiosDeOtroDispositivo();
});
window.addEventListener("beforeunload", (evento) => {
  if (nube.nubeActiva && nube.hayCambiosPorGuardar()) evento.preventDefault();
});
if (!nube.nubeActiva) navigator.storage?.persist?.();
iniciar();
