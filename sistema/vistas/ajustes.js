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
      <h2>Datos que salen en la cuenta</h2>
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
        <li><strong>Activa la impresión en ese equipo:</strong> en «Cocina», prende «Imprimir comandas automáticamente en este equipo».
          Al cobrar, deja marcada «Imprimir la cuenta».</li>
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
  $vista.querySelector("#copiar-acceso").addEventListener("click", async () => {
    try {
      await navigator.clipboard.writeText(ACCESO_DIRECTO);
      aviso("Copiado");
    } catch {
      aviso("No se pudo copiar: selecciona el texto y cópialo a mano");
    }
  });
}
