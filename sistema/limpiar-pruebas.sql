-- ZEBRO: dejar el sistema en limpio antes de empezar a vender.
-- Correr UNA SOLA VEZ, el día de apertura: SQL Editor → New query → pegar todo → Run.
--
-- BORRA: todas las cuentas de mesas y domicilios (abiertas, pagadas y anuladas), sus platos y
--        pagos, todos los gastos, las cajas (aperturas y cierres) y los movimientos de inventario
--        de las ventas de prueba.
-- DEVUELVE al inventario lo que gastaron las ventas de prueba.
-- NO TOCA: menú, recetas, modificadores, insumos, compras de inventario, mesas, personas del
--          equipo ni datos del negocio.
-- La numeración de ventas vuelve a empezar en 1.
--
-- No se puede deshacer. Si se corta a la mitad, no cambia nada (todo pasa en un solo paso).

do $$
begin
  -- 1. Devolver al inventario lo que descontaron las ventas (y las anulaciones ya devolvieron).
  update public.insumos i set stock = i.stock - v.neto
  from (
    select insumo_id, sum(cantidad) as neto
    from public.movimientos
    where (motivo like 'Venta #%' or motivo like 'Anulación venta #%') and insumo_id is not null
    group by insumo_id
  ) v
  where i.id = v.insumo_id and v.neto <> 0;

  -- 2. Borrar el historial de esas ventas en el inventario (las compras y salidas manuales se quedan).
  delete from public.movimientos where motivo like 'Venta #%' or motivo like 'Anulación venta #%';

  -- 3. Borrar cuentas, platos pedidos, pagos, gastos, cajas y la cola de impresión.
  delete from public.pedido_items where true;
  delete from public.pagos where true;
  delete from public.pedidos where true;
  delete from public.gastos where true;
  delete from public.cajas where true;
  delete from public.impresiones where true;

  -- 4. La próxima venta vuelve a ser la #1.
  alter table public.pedidos alter column numero restart with 1;
end $$;
