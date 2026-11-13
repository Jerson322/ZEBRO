// Ajustes (solo administrador): nombre, logo y datos del negocio para el panel y los tickets.
import * as api from "../api.js";
import { esc, aviso } from "../util.js";
import { imprimir, ticketCuenta } from "../impresion.js";
import { autorizar } from "../clave.js";

export async function pintar($vista, ctx) {
  const n = ctx.negocio ?? {};
  $vista.innerHTML = `
    <div class="encabezado"><h1>Ajustes</h1></div>
    <form class="panel formulario-plano" id="datos-negocio">
      <h2>Tu restaurante</h2>
      <p class="suave" style="margin:0">El nombre y el logo salen en el panel, en la bienvenida al entrar y en la cuenta impresa (el nombre).</p>
      <div class="logo-ajustes">
        <span class="logo logo-grande" id="vista-logo">${n.logo ? `<img src="${esc(n.logo)}" alt="">` : esc((n.nombre || "Z").trim().charAt(0).toUpperCase())}</span>
        <div class="botones-domicilio" style="justify-content:flex-start;margin:0">
          <label class="boton chico">Subir logo<input type="file" id="archivo-logo" accept="image/*" hidden></label>
          <button type="button" class="chico" id="quitar-logo"${n.logo ? "" : " hidden"}>Quitar logo</button>
        </div>
        <input type="hidden" name="logo" value="${esc(n.logo ?? "")}">
      </div>
      <div class="fila">
        <label>Nombre del negocio<input name="nombre" value="${esc(n.nombre)}"></label>
        <label>NIT (opcional)<input name="nit" value="${esc(n.nit)}"></label>
      </div>
      <div class="fila">
        <label>Dirección<input name="direccion" value="${esc(n.direccion)}"></label>
        <label>Teléfono<input name="telefono" value="${esc(n.telefono)}"></label>
      </div>
      <label>Mensaje al final<input name="pie" value="${esc(n.pie)}"></label>
      <div class="botones">
        <button type="button" id="prueba-ticket">Imprimir ticket de prueba</button>
        <button type="submit" class="principal">Guardar</button>
      </div>
    </form>
    <div class="panel" id="codigos-caja">
      <h2>Códigos de caja</h2>
      <p class="suave" style="margin:0 0 10px">Cada persona que cobra (administrador o cajero) tiene su propia caja. Con su código abre y cierra
        su caja; sus cobros y sus gastos quedan en ella. Es obligatorio: sin código, esa persona no puede abrir su caja (tampoco tú: asígnate el tuyo).</p>
      <div id="lista-codigos"><p class="suave">Cargando…</p></div>
    </div>
    <form class="panel formulario-plano" id="mi-clave">
      <h2>Clave de autorización</h2>
      <p class="suave" style="margin:0">Opcional. Si la pones, el sistema la pide para anular cuentas, quitar platos que ya se
        enviaron a cocina y borrar productos, categorías, modificadores, insumos, mesas o gastos. Así nadie hace esos cambios
        sin ti, aunque use tu sesión. También puedes darle una clave a alguien de confianza en «Empleados → Acceso».</p>
      <p style="margin:0">${ctx.perfil.clave_hash ? "✓ Ya tienes una clave." : "Todavía no tienes clave."}</p>
      <div class="fila">
        <label>${ctx.perfil.clave_hash ? "Nueva clave" : "Clave"} (de 4 a 8 números)<input name="clave" type="password" inputmode="numeric" maxlength="8" autocomplete="new-password"></label>
        <label>Repítela<input name="repetir" type="password" inputmode="numeric" maxlength="8" autocomplete="new-password"></label>
      </div>
      <div class="botones">
        ${ctx.perfil.clave_hash ? `<button type="button" class="peligro" id="quitar-mi-clave">Quitar mi clave</button>` : ""}
        <button type="submit" class="principal">${ctx.perfil.clave_hash ? "Cambiar clave" : "Guardar clave"}</button>
      </div>
    </form>`;

  // Códigos de caja: una fila por cada administrador o cajero con acceso.
  const pintarCodigos = async () => {
    const $lista = $vista.querySelector("#lista-codigos");
    try {
      const miembros = (await api.miembros()).filter((m) => m.activo && ["admin", "cajero"].includes(m.rol));
      $lista.innerHTML = miembros.length ? miembros.map((m) => `<div class="fila-lista" style="flex-wrap:wrap;align-items:center">
          <span style="flex:1;min-width:160px"><strong>${esc(m.nombre)}</strong> <small class="suave">${m.rol === "admin" ? "Administrador" : "Cajero"}</small><br>
            <small>${m.codigo_caja_hash ? "✓ Tiene código" : "Sin código"}</small></span>
          <input data-codigo="${m.user_id}" type="text" inputmode="numeric" maxlength="8" placeholder="Nuevo código" style="width:130px" autocomplete="off">
          <button type="button" class="chico" data-generar="${m.user_id}">Generar</button>
          <button type="button" class="chico principal" data-guardar-codigo="${m.user_id}">Guardar</button>
          ${m.codigo_caja_hash ? `<button type="button" class="chico peligro" data-quitar-codigo="${m.user_id}">Quitar</button>` : ""}
        </div>`).join("") : `<p class="suave">No hay administradores ni cajeros con acceso. Créalos en «Empleados».</p>`;
    } catch (error) {
      $lista.innerHTML = `<p class="error">${esc(error.message)}</p>`;
    }
  };
  pintarCodigos();
  $vista.querySelector("#codigos-caja").addEventListener("click", async (e) => {
    const $b = e.target.closest("button");
    if (!$b) return;
    const usuario = $b.dataset.generar ?? $b.dataset.guardarCodigo ?? $b.dataset.quitarCodigo;
    if (!usuario) return;
    const $campo = $vista.querySelector(`[data-codigo="${usuario}"]`);
    if ($b.dataset.generar) {
      $campo.value = String(Math.floor(1000 + Math.random() * 9000));
      return;
    }
    const codigo = $b.dataset.quitarCodigo ? "" : $campo.value.trim();
    if ($b.dataset.guardarCodigo && !/^\d{4,8}$/.test(codigo)) return aviso("El código debe tener de 4 a 8 números");
    if ($b.dataset.quitarCodigo && !confirm("¿Quitar el código de caja?")) return;
    if ((await autorizar(ctx, "Cambiar un código de caja")) === null) return;
    try {
      await api.ponerCodigoCaja(usuario, codigo);
      aviso(codigo ? `Código guardado: ${codigo}. Díselo a la persona.` : "Código quitado");
      pintarCodigos();
    } catch (error) {
      aviso(error.message);
    }
  });

  const $miClave = $vista.querySelector("#mi-clave");
  const guardarMiClave = async (clave) => {
    // Cambiar o quitar una clave que ya existe pide la clave actual (o la de otro autorizado).
    if (ctx.perfil.clave_hash && (await autorizar(ctx, "Escribe tu clave actual")) === null) return;
    try {
      await api.ponerClave(ctx.perfil.user_id, clave);
      ctx.perfil.clave_hash = clave ? "si" : null;
      ctx.conClave = await api.hayClaves();
      aviso(clave ? "Clave guardada" : "Clave quitada");
      ctx.refrescar();
    } catch (error) {
      aviso(error.message);
    }
  };
  $miClave.addEventListener("submit", (evento) => {
    evento.preventDefault();
    const { clave, repetir } = Object.fromEntries(new FormData($miClave));
    if (!/^\d{4,8}$/.test(clave)) return aviso("La clave debe tener de 4 a 8 números");
    if (clave !== repetir) return aviso("Las dos claves no coinciden");
    guardarMiClave(clave);
  });
  $vista.querySelector("#quitar-mi-clave")?.addEventListener("click", () => {
    if (confirm("¿Quitar tu clave de autorización?")) guardarMiClave("");
  });

  const $form = $vista.querySelector("#datos-negocio");
  $form.addEventListener("submit", async (evento) => {
    evento.preventDefault();
    const c = Object.fromEntries(new FormData($form));
    if (!c.nombre.trim()) return aviso("Escribe el nombre del negocio");
    try {
      const datos = Object.fromEntries(Object.entries(c).map(([k, v]) => [k, v.trim()]));
      await api.guardarNegocio(datos);
      ctx.negocio = { ...ctx.negocio, ...datos };
      aviso("Datos guardados");
      ctx.refrescar(); // el panel muestra el nombre y el logo nuevos
    } catch (error) {
      aviso(error.message);
    }
  });
  $vista.querySelector("#prueba-ticket").addEventListener("click", () =>
    imprimir(ticketCuenta({
      numero: 0, tipo: "mesa", estado: "abierto", envio: 0,
      pedido_items: [{ cantidad: 1, nombre: "Plato de prueba", precio: 10000, opciones: [{ nombre: "Opción de prueba" }], nota: "" }],
    }, { ...ctx.negocio, ...Object.fromEntries(new FormData($form)) }, { mesa: "Mesa de prueba" }))
  );
  // Logo: se achica en el navegador (máximo 256 px) para que pese poco y cargue rápido.
  const $logo = $form.querySelector('[name="logo"]');
  const $vistaLogo = $vista.querySelector("#vista-logo");
  const $quitar = $vista.querySelector("#quitar-logo");
  const mostrarLogo = () => {
    $vistaLogo.innerHTML = $logo.value
      ? `<img src="${esc($logo.value)}" alt="">`
      : esc(($form.nombre.value || "Z").trim().charAt(0).toUpperCase());
    $quitar.hidden = !$logo.value;
  };
  $vista.querySelector("#archivo-logo").addEventListener("change", async (evento) => {
    const archivo = evento.target.files[0];
    if (!archivo) return;
    try {
      $logo.value = await achicarImagen(archivo, 256);
      mostrarLogo();
      aviso("Logo listo: dale «Guardar»");
    } catch {
      aviso("No se pudo leer esa imagen. Prueba con un PNG o JPG.");
    }
  });
  $quitar.addEventListener("click", () => {
    $logo.value = "";
    mostrarLogo();
  });
}

// Convierte una imagen en un PNG cuadrado de máximo `lado` px (conserva la transparencia).
function achicarImagen(archivo, lado) {
  return new Promise((listo, fallo) => {
    const url = URL.createObjectURL(archivo);
    const img = new Image();
    img.onload = () => {
      const escala = Math.min(1, lado / Math.max(img.width, img.height));
      const ancho = Math.round(img.width * escala);
      const alto = Math.round(img.height * escala);
      const $lienzo = document.createElement("canvas");
      $lienzo.width = ancho;
      $lienzo.height = alto;
      $lienzo.getContext("2d").drawImage(img, 0, 0, ancho, alto);
      URL.revokeObjectURL(url);
      listo($lienzo.toDataURL("image/png"));
    };
    img.onerror = () => {
      URL.revokeObjectURL(url);
      fallo(new Error("Imagen no válida"));
    };
    img.src = url;
  });
}
