// Empleados (solo administrador): nombre, rol y acceso al sistema.
import * as api from "../api.js";
import { esc, opciones, tabla, formulario, aviso } from "../util.js";

// El rol del empleado se guarda en "cargo". Los que tienen acceso usan el rol del sistema equivalente.
const ROLES_EMPLEADO = ["Mesero", "Cajero", "Cocina", "Domiciliario", "Administrador"];
const ROL_SISTEMA = { Mesero: "mesero", Cajero: "cajero", Cocina: "cocina", Administrador: "admin" };
const NOMBRE_ROL = { mesero: "Mesero", cajero: "Cajero", cocina: "Cocina", admin: "Administrador" };
const ROLES_ACCESO = [["mesero", "Mesero: mesas y pedidos"], ["cajero", "Cajero: cobra, domicilios y gastos"], ["cocina", "Cocina: solo ve comandas"], ["admin", "Administrador: todo"]];

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
      ${miembro ? `<label class="opcion"><input type="checkbox" name="quitar"> Quitar el acceso</label>` : ""}` : ""}`,
    async (c) => {
      if (!tieneCuenta) {
        await api.cuentaEquipo({ accion: "crear", empleadoId: e.id, correo: c.correo.trim(), clave: c.clave, rol: c.rol });
        aviso(`Listo: ${e.nombre} entra con ${c.correo.trim()}`);
        return;
      }
      if (c.quitar) {
        await api.cuentaEquipo({ accion: "quitar", empleadoId: e.id });
        return;
      }
      await api.cuentaEquipo({ accion: "rol", empleadoId: e.id, rol: c.rol });
      if (c.clave) await api.cuentaEquipo({ accion: "clave", empleadoId: e.id, clave: c.clave });
    },
    { alTerminar: () => ctx.refrescar() });
}
