// Ayudas de pantalla compartidas por todas las vistas.

export const esc = (t) =>
  String(t ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

export const pesos = (n) => {
  const valor = Math.round(Number(n) || 0);
  return (valor < 0 ? "-$" : "$") + Math.abs(valor).toLocaleString("es-CO");
};

export const numero = (n, decimales = 2) =>
  Number(n || 0).toLocaleString("es-CO", { maximumFractionDigits: decimales });

export function hoy(fecha = new Date()) {
  const mes = String(fecha.getMonth() + 1).padStart(2, "0");
  const dia = String(fecha.getDate()).padStart(2, "0");
  return `${fecha.getFullYear()}-${mes}-${dia}`;
}

export const fechaCorta = (f) => (f ? String(f).slice(0, 10).split("-").reverse().join("/") : "");

export const hora = (iso) =>
  iso ? new Date(iso).toLocaleTimeString("es-CO", { hour: "2-digit", minute: "2-digit" }) : "";

export const minutosDesde = (iso) => Math.max(0, Math.round((Date.now() - new Date(iso)) / 60000));

export const opciones = (lista, elegido = "") =>
  lista
    .map((o) => {
      const [valor, texto] = Array.isArray(o) ? o : [o, o];
      return `<option value="${esc(valor)}"${String(valor) === String(elegido) ? " selected" : ""}>${esc(texto)}</option>`;
    })
    .join("");

export function tabla(columnas, filas, vacio) {
  if (!filas.length) return `<p class="vacio">${vacio}</p>`;
  const cabecera = columnas
    .map((c) => `<th class="${c.startsWith("#") ? "num" : ""}">${c.replace("#", "")}</th>`)
    .join("");
  return `<div class="tabla"><table><thead><tr>${cabecera}</tr></thead><tbody>${filas.join("")}</tbody></table></div>`;
}

export const tarjeta = (titulo, valor, clase = "") =>
  `<div class="tarjeta"><small>${titulo}</small><strong class="${clase}">${valor}</strong></div>`;

const $dialogo = () => document.getElementById("dialogo");

export const dialogoAbierto = () => $dialogo().open;

export function cerrarDialogo() {
  if ($dialogo().open) $dialogo().close();
}

// Abre un formulario. guardar() recibe los campos y el <form>; si lanza un error, se muestra
// y el formulario sigue abierto. Si termina bien, se cierra y se llama a alTerminar().
export function formulario(titulo, campos, guardar, { boton = "Guardar", alTerminar } = {}) {
  const $d = $dialogo();
  $d.innerHTML = `<form novalidate>
    <h2>${titulo}</h2>
    ${campos}
    <p class="error" hidden></p>
    <div class="botones">
      <button type="button" data-cerrar>Cancelar</button>
      <button type="submit" class="principal">${boton}</button>
    </div>
  </form>`;
  const $form = $d.querySelector("form");
  $form.querySelector("[data-cerrar]").addEventListener("click", () => $d.close());
  $form.addEventListener("submit", async (evento) => {
    evento.preventDefault();
    const $enviar = $form.querySelector('[type="submit"]');
    $enviar.disabled = true;
    try {
      await guardar(Object.fromEntries(new FormData($form)), $form);
      $d.close();
      await alTerminar?.();
    } catch (error) {
      const $error = $form.querySelector(".error");
      $error.textContent = error.message;
      $error.hidden = false;
    } finally {
      $enviar.disabled = false;
    }
  });
  if (!$d.open) $d.showModal();
  return $form;
}

// Muestra contenido libre en el diálogo (por ejemplo, un detalle con botones propios).
export function mostrar(html) {
  const $d = $dialogo();
  $d.innerHTML = `<div class="contenido">${html}</div>`;
  // Si ya está abierta (por ejemplo, se vuelve a pintar), solo se cambia el contenido.
  if (!$d.open) $d.showModal();
  return $d.firstElementChild;
}

export function aviso(mensaje) {
  const $aviso = document.getElementById("aviso");
  $aviso.textContent = mensaje;
  $aviso.hidden = false;
  clearTimeout(aviso.temporizador);
  aviso.temporizador = setTimeout(() => ($aviso.hidden = true), 4000);
}
