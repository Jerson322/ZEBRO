// Clave de autorización: si el administrador puso una, las acciones delicadas (anular, quitar lo
// que ya fue a cocina, borrar productos, insumos, mesas o gastos) la piden. Si nadie tiene clave,
// no se pide nada.
import * as api from "./api.js";
import { esc, mostrar, cerrarDialogo, aviso } from "./util.js";

// Muestra la ventana para escribir la clave. Devuelve la clave, o null si se cancela.
function ventanaClave(motivo) {
  return new Promise((listo) => {
    let respondido = false;
    const responder = (valor) => {
      if (respondido) return;
      respondido = true;
      cerrarDialogo();
      listo(valor);
    };
    const $c = mostrar(`
      <h2>Clave de autorización</h2>
      <p class="suave" style="margin:0">${esc(motivo)}</p>
      <form id="form-clave" style="display:flex;flex-direction:column;gap:14px;padding:0">
        <input id="clave" type="password" inputmode="numeric" autocomplete="off" maxlength="8"
          placeholder="••••" style="font-size:24px;letter-spacing:8px;text-align:center">
        <div class="botones">
          <button type="button" id="cancelar-clave">Cancelar</button>
          <button type="submit" class="principal">Autorizar</button>
        </div>
      </form>`);
    const $clave = $c.querySelector("#clave");
    setTimeout(() => $clave.focus(), 50);
    $c.querySelector("#cancelar-clave").addEventListener("click", () => responder(null));
    $c.querySelector("#form-clave").addEventListener("submit", (e) => {
      e.preventDefault();
      responder($clave.value.trim());
    });
    document.getElementById("dialogo").addEventListener("close", () => responder(null), { once: true });
  });
}

// Pide la clave si el sistema usa claves.
// - Devuelve "" si no se usan claves (sigue sin pedir nada).
// - Devuelve la clave si es correcta (verificar = true la revisa antes; si no, la revisa la base de datos).
// - Devuelve null si se cancela o es incorrecta (y avisa).
export async function autorizar(ctx, motivo, { verificar = true } = {}) {
  if (!ctx.conClave) return "";
  const clave = await ventanaClave(motivo);
  if (!clave) return null;
  if (!verificar) return clave;
  try {
    await api.verificarClave(clave);
    return clave;
  } catch (error) {
    aviso(error.message);
    return null;
  }
}
