// Ajustes (solo administrador): datos del negocio para los tickets y cómo dejar lista la comandera.
import * as api from "../api.js";
import { esc, aviso } from "../util.js";
import { imprimir, ticketCuenta } from "../impresion.js";

const ACCESO_DIRECTO =
  '"C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe" --kiosk-printing --user-data-dir="C:\\ZEBRO-Chrome" https://zebro.store/sistema';

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
    <div class="panel guia">
      <h2>Cómo dejar lista la comandera (XP-80T por red)</h2>
      <ol>
        <li><strong>Averigua la IP de la impresora:</strong> apágala, deja presionado el botón FEED y préndela.
          Sale una hoja de prueba con su dirección IP (ej. 192.168.1.87).</li>
        <li><strong>Instálala en el computador:</strong> instala el driver de Xprinter (viene en el CD o en la página de Xprinter)
          y agrégala en Windows como impresora de red con esa IP (Configuración → Impresoras → Agregar → «La impresora que quiero no aparece» → por dirección TCP/IP).</li>
        <li><strong>Papel de 80 mm:</strong> en las preferencias de impresión de la XP-80T elige el papel de 80 mm (o «80 x 297 mm»)
          y activa el corte automático si aparece.</li>
        <li><strong>Hazla la predeterminada:</strong> en Configuración → Impresoras, apaga «Permitir que Windows administre mi impresora predeterminada»
          y marca la XP-80T como predeterminada.</li>
        <li><strong>Crea el acceso directo del sistema:</strong> en el escritorio, clic derecho → Nuevo → Acceso directo, y pega esto:
          <pre>${esc(ACCESO_DIRECTO)}</pre>
          <button type="button" id="copiar-acceso">Copiar</button>
          Llámalo «ZEBRO». Abre siempre el sistema desde ahí en ese computador: así imprime directo, sin preguntar.</li>
        <li><strong>Activa la comandera en ese equipo:</strong> en el menú, prende «🖨️ Comandera aquí». Desde ahí, cada vez que
          alguien toque «Enviar a cocina» (desde cualquier celular), ese computador imprime la comanda solo, en cualquier pantalla
          que tenga abierta. Al cobrar, deja marcada «Imprimir la cuenta».</li>
      </ol>
      <p class="suave">Si la IP de la impresora cambia sola (por ejemplo al reiniciar el router), pídele a quien maneje tu internet que le deje una IP fija.</p>
    </div>`;

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
  $vista.querySelector("#copiar-acceso").addEventListener("click", async () => {
    try {
      await navigator.clipboard.writeText(ACCESO_DIRECTO);
      aviso("Copiado");
    } catch {
      aviso("No se pudo copiar: selecciona el texto y cópialo a mano");
    }
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
