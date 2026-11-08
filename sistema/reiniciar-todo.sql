-- ZEBRO: borrar TODO y dejar el sistema como recién instalado.
-- SQL Editor → New query → pegar todo → Run.
--
-- BORRA: cuentas, ventas, domicilios, gastos, menú, categorías, recetas, modificadores, insumos,
--        movimientos de inventario, mesas, empleados y sus usuarios de acceso, y los datos del negocio.
-- SE QUEDA: solo la cuenta del administrador, para que puedas seguir entrando.
-- La numeración de ventas y domicilios vuelve a empezar en 1.
--
-- No se puede deshacer. Si se corta a la mitad, no cambia nada (todo pasa en un solo paso).

do $$
begin
  -- Operación del servicio
  delete from public.pedido_items where true;
  delete from public.pedidos where true;
  delete from public.gastos where true;
  delete from public.movimientos where true;

  -- Menú, recetas e inventario
  delete from public.plato_grupos where true;
  delete from public.recetas where true;
  delete from public.opciones_mod where true;
  delete from public.grupos_mod where true;
  delete from public.platos where true;
  delete from public.categorias where true;
  delete from public.insumos where true;
  delete from public.mesas where true;

  -- Equipo: se borran las fichas y los usuarios de acceso de todos menos el administrador.
  delete from public.empleados where true;
  delete from auth.users
  where id in (select user_id from public.miembros where rol <> 'admin');
  delete from public.miembros where rol <> 'admin';

  -- Datos del negocio vuelven a los de fábrica.
  delete from public.negocio where true;
  insert into public.negocio (id) values (1);

  alter table public.pedidos alter column numero restart with 1;
end $$;
