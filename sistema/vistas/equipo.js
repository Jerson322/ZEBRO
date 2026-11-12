// Empleados (solo administrador): nombre, rol y acceso al sistema.
import * as api from "../api.js";
import { esc, opciones, tabla, formulario, aviso } from "../util.js";
import { autorizar } from "../clave.js";

// El rol del empleado se guarda en "cargo". Los que tienen acceso usan el rol del sistema equivalente.
const ROLES_EMPLEADO = ["Mesero", "Cajero", "Cocina", "Domiciliario", "Administrador"];
const ROL_SISTEMA = { Mesero: "mesero", Cajero: "cajero", Cocina: "cocina", Domiciliario: "domiciliario", Administrador: "admin" };
const NOMBRE_ROL = { mesero: "Mesero", cajero: "Cajero", cocina: "Cocina", domiciliario: "Domiciliario", admin: "Administrador" };
const ROLES_ACCESO = [["mesero", "Mesero: mesas y pedidos"], ["cajero", "Cajero: cobra, domicilios y gastos"], ["cocina", "Cocina: solo ve comandas"],
  ["domiciliario", "Domiciliario: sus domicilios y toma pedidos en mesas"], ["admin", "Administrador: todo"]];

export async function pintar($vista, ctx) {
  const [empleados, miembros] = await Promise.all([api.empleados(), api.miembros()]);
  const acceso = (e) => miembros.find((m) => m.user_id === e.user_id && m.activo);
  const sinFicha = miembros.filter((m) => m.activo && !empleados.some((e) => e.user_id === m.user_id));

  $vista.innerHTML = `
    <div class="encabezado"><h1>Empleados</h1><button class="principal" id="nuevo-empleado">Nuevo empleado</button></div>
    <div class="panel">${tabla(["Nombre", "Rol", "Acceso al sistema", ""], empleados.map((e) => {
      const m = acceso(e);
      return `<tr class="${e.activo ? "" : "inactivo"}"><td class="ancho">${esc(e.nombre)}${e.activo ? "" : ` <small class="etiqueta">Retirado</small>`}</td>
        <td>${esc(e.cargo)}</td>
        <td>${m ? `<span class="etiqueta">Entra como ${NOMBRE_ROL[m.rol]}</span>` : `<small class="suave">Sin acceso</small>`}</td>
        <td class="acciones"><button class="chico" data-acceso="${e.id}">Acceso</button>
          <button class="chico" data-editar="${e.id}">Editar</button></td></tr>`;
    }), "Agrega a tu equipo.")}</div>
    ${sinFicha.length ? `<div class="panel"><h2>Otros accesos</h2>
      ${tabla(["Nombre", "Rol"], sinFicha.map((m) => `<tr><td>${esc(m.nombre)}${m.user_id === ctx.perfil.user_id ? " (tú)" : ""}</td><td>${NOMBRE_ROL[m.rol]}</td></tr>`), "")}</div>` : ""}`;

  const porId = (id) => empleados.find((e) => e.id === id);
  $vista.querySelector("#nuevo-empleado").addEventListener("click", () => formularioEmpleado({}, ctx));
  $vista.querySelectorAll("[data-editar]").forEach(($b) => $b.addEventListener("click", () => formularioEmpleado(porId($b.dataset.editar), ctx)));
  $vista.querySelectorAll("[data-acceso]").forEach(($b) =>
    $b.addEventListener("click", () => {
      const e = porId($b.dataset.acceso);
      formularioAcceso(e, acceso(e), ctx);
    })
  );
}

function formularioEmpleado(e, ctx) {
  formulario(e.id ? "Editar empleado" : "Nuevo empleado", `
    <label>Nombre<input name="nombre" value="${esc(e.nombre)}"></label>
    <label>Rol<select name="cargo">${opciones(ROLES_EMPLEADO, e.cargo || "Mesero")}</select></label>
    ${e.id ? `<label class="opcion"><input type="checkbox" name="activo"${e.activo ? " checked" : ""}> Trabaja actualmente</label>` : ""}`,
    async (c) => {
      if (!c.nombre.trim()) throw new Error("Escribe el nombre");
      const activo = e.id ? Boolean(c.activo) : true;
      await api.guardar("empleados", { id: e.id, nombre: c.nombre.trim(), cargo: c.cargo, activo });
      if (!e.id || !e.user_id) return;
      // Si se retira, pierde el acceso; si cambia de rol y tiene acceso, entra con el rol nuevo.
      if (!activo) await api.cuentaEquipo({ accion: "quitar", empleadoId: e.id });
      else if (c.cargo !== e.cargo && ROL_SISTEMA[c.cargo]) await api.cuentaEquipo({ accion: "rol", empleadoId: e.id, rol: ROL_SISTEMA[c.cargo] });
    },
    { alTerminar: () => ctx.refrescar() });
}

function formularioAcceso(e, miembro, ctx) {
  const tieneCuenta = Boolean(e.user_id);
  const rolSugerido = miembro?.rol ?? ROL_SISTEMA[e.cargo] ?? "mesero";
  formulario(`Acceso de ${esc(e.nombre)}`, `
    ${!tieneCuenta ? `<p class="suave" style="margin:0">Crea un usuario para que ${esc(e.nombre)} entre al sistema desde su celular.</p>
      <div class="fila">
        <label>Correo<input name="correo" type="email" autocomplete="off"></label>
        <label>Clave (mínimo 8)<input name="clave" type="text" autocomplete="off"></label>
      </div>` : `<p class="suave" style="margin:0">${miembro ? "Tiene acceso al sistema." : "Su acceso está desactivado."}</p>`}
    <label>Entra como<select name="rol">${opciones(ROLES_ACCESO, rolSugerido)}</select></label>
    ${tieneCuenta ? `<label>Nueva clave (opcional, mínimo 8)<input name="clave" type="text" autocomplete="off"></label>
      ${miembro ? `<label class="opcion"><input type="checkbox" name="quitar"> Quitar el acceso</label>` : ""}` : ""}
    <fieldset><legend>Clave de autorización <small class="suave">opcional</small></legend>
      <p class="suave" style="margin:0 0 8px">Con ella, ${esc(e.nombre)} puede autorizar anulaciones, quitar platos ya enviados a cocina y borrar cosas.
        ${miembro?.clave_hash ? "<strong>Ya tiene una.</strong>" : "No tiene."}</p>
      <div class="fila" style="align-items:end">
        <label>Clave (de 4 a 8 números)<input name="autoriza" type="text" inputmode="numeric" maxlength="8" autocomplete="off"></label>
        <button type="button" id="generar-clave">Generar</button>
      </div>
      ${miembro?.clave_hash ? `<label class="opcion"><input type="checkbox" name="quitarAutoriza"> Quitarle la clave de autorización</label>` : ""}
    </fieldset>`,
    async (c) => {
      const autoriza = (c.autoriza ?? "").trim();
      if (autoriza && !/^\d{4,8}$/.test(autoriza)) throw new Error("La clave de autorización debe tener de 4 a 8 números");
      // Dar, cambiar o quitar una clave de autorización también pide autorización (si ya se usan claves).
      if ((autoriza || c.quitarAutoriza) && (await autorizar(ctx, `Clave de autorización de ${e.nombre}`)) === null) {
        aviso("No se guardó nada: se canceló la autorización");
        return;
      }
      const ponerAutoriza = async () => {
        if (!autoriza && !c.quitarAutoriza) return;
        const usuario = (await api.empleados()).find((x) => x.id === e.id)?.user_id;
        if (usuario) await api.ponerClave(usuario, c.quitarAutoriza ? "" : autoriza);
        ctx.conClave = await api.hayClaves();
      };
      if (!tieneCuenta) {
        await api.cuentaEquipo({ accion: "crear", empleadoId: e.id, correo: c.correo.trim(), clave: c.clave, rol: c.rol });
        await ponerAutoriza();
        aviso(`Listo: ${e.nombre} entra con ${c.correo.trim()}${autoriza ? ` · clave de autorización ${autoriza}` : ""}`);
        return;
      }
      if (c.quitar) {
        await api.cuentaEquipo({ accion: "quitar", empleadoId: e.id });
        return;
      }
      await api.cuentaEquipo({ accion: "rol", empleadoId: e.id, rol: c.rol });
      if (c.clave) await api.cuentaEquipo({ accion: "clave", empleadoId: e.id, clave: c.clave });
      await ponerAutoriza();
      if (autoriza) aviso(`Clave de autorización de ${e.nombre}: ${autoriza}`);
    },
    { alTerminar: () => ctx.refrescar() });
  // Genera una clave de 4 números para dársela a la persona.
  document.getElementById("generar-clave").addEventListener("click", () => {
    document.querySelector('[name="autoriza"]').value = String(Math.floor(1000 + Math.random() * 9000));
  });
}
