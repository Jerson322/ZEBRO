-- ZEBRO Restaurante: base de datos en Supabase.
-- Ejecutar una vez: SQL Editor → New query → pegar todo → Run. Se puede volver a ejecutar sin perder datos.
--
-- Las tablas se leen directamente, pero las operaciones del servicio (abrir mesa, agregar platos,
-- cobrar, mover inventario) pasan por funciones que revisan el rol de quien las llama.
-- Así el precio, el total y el descuento de inventario siempre los calcula la base de datos.

-- Equipo y roles ------------------------------------------------------------

create table if not exists public.miembros (
  user_id uuid primary key references auth.users (id) on delete cascade,
  nombre text not null,
  rol text not null check (rol in ('admin', 'cajero', 'mesero', 'cocina')),
  activo boolean not null default true
);

create or replace function public.rol_actual() returns text
language sql stable security definer set search_path = public as $$
  select rol from miembros where user_id = auth.uid() and activo
$$;

create or replace function public.exigir_rol(variadic permitidos text[]) returns void
language plpgsql stable security definer set search_path = public as $$
begin
  if coalesce(rol_actual(), '') <> all (permitidos) then
    raise exception 'No tienes permiso para esta acción' using errcode = '42501';
  end if;
end $$;

-- El primer usuario que entra queda como administrador. Los usuarios solo existen si los creas
-- en el panel de Supabase (los registros públicos deben estar apagados).
create or replace function public.reclamar_admin(p_nombre text) returns void
language plpgsql security definer set search_path = public as $$
begin
  if auth.uid() is null then
    raise exception 'Inicia sesión primero';
  end if;
  if exists (select 1 from miembros where rol = 'admin') then
    raise exception 'El sistema ya tiene administrador. Pídele que te dé acceso.';
  end if;
  insert into miembros (user_id, nombre, rol) values (auth.uid(), coalesce(nullif(trim(p_nombre), ''), 'Administrador'), 'admin');
end $$;

-- Menú, recetas e inventario --------------------------------------------------

create table if not exists public.categorias (
  id uuid primary key default gen_random_uuid(),
  nombre text not null,
  orden integer not null default 0
);

create table if not exists public.platos (
  id uuid primary key default gen_random_uuid(),
  categoria_id uuid references public.categorias (id) on delete set null,
  nombre text not null,
  descripcion text not null default '',
  precio integer not null check (precio >= 0),
  activo boolean not null default true
);

create table if not exists public.insumos (
  id uuid primary key default gen_random_uuid(),
  nombre text not null,
  unidad text not null default 'und',
  stock numeric not null default 0,
  costo numeric not null default 0 check (costo >= 0), -- costo por unidad
  minimo numeric not null default 0
);

create table if not exists public.recetas (
  plato_id uuid not null references public.platos (id) on delete cascade,
  insumo_id uuid not null references public.insumos (id) on delete restrict,
  cantidad numeric not null check (cantidad > 0),
  primary key (plato_id, insumo_id)
);

-- Modificadores: grupos como "Término" (elegir uno) o "Adiciones" (varios), con opciones
-- que pueden sumar precio y gastar un insumo.
create table if not exists public.grupos_mod (
  id uuid primary key default gen_random_uuid(),
  nombre text not null,
  obligatorio boolean not null default false,
  maximo integer not null default 1 check (maximo >= 1)
);

create table if not exists public.opciones_mod (
  id uuid primary key default gen_random_uuid(),
  grupo_id uuid not null references public.grupos_mod (id) on delete cascade,
  nombre text not null,
  precio integer not null default 0 check (precio >= 0),
  insumo_id uuid references public.insumos (id) on delete set null,
  cantidad numeric check (cantidad is null or cantidad > 0)
);

create table if not exists public.plato_grupos (
  plato_id uuid not null references public.platos (id) on delete cascade,
  grupo_id uuid not null references public.grupos_mod (id) on delete cascade,
  primary key (plato_id, grupo_id)
);

create table if not exists public.movimientos (
  id uuid primary key default gen_random_uuid(),
  insumo_id uuid references public.insumos (id) on delete set null,
  insumo text not null,
  cantidad numeric not null,
  saldo numeric not null,
  motivo text not null,
  fecha timestamptz not null default now(),
  usuario uuid default auth.uid()
);

-- Mesas, pedidos y domicilios ---------------------------------------------------

create table if not exists public.mesas (
  id uuid primary key default gen_random_uuid(),
  nombre text not null,
  orden integer not null default 0
);

create table if not exists public.empleados (
  id uuid primary key default gen_random_uuid(),
  nombre text not null,
  documento text not null default '',
  telefono text not null default '',
  cargo text not null default '',
  salario integer not null default 0 check (salario >= 0),
  ingreso date,
  notas text not null default '',
  activo boolean not null default true,
  user_id uuid unique references auth.users (id) on delete set null
);

create table if not exists public.pedidos (
  id uuid primary key default gen_random_uuid(),
  numero bigint generated always as identity,
  tipo text not null check (tipo in ('mesa', 'domicilio')),
  mesa_id uuid references public.mesas (id) on delete set null,
  estado text not null default 'abierto' check (estado in ('abierto', 'pagado', 'anulado')),
  entrega text check (entrega in ('preparando', 'en_camino', 'entregado')),
  cliente text not null default '',
  telefono text not null default '',
  direccion text not null default '',
  domiciliario_id uuid references public.empleados (id) on delete set null,
  envio integer not null default 0 check (envio >= 0),
  propina integer not null default 0 check (propina >= 0),
  total integer,
  costo numeric,
  metodo_pago text,
  notas text not null default '',
  abierto_por uuid default auth.uid(),
  creado timestamptz not null default now(),
  cerrado timestamptz,
  motivo_anulacion text
);

create unique index if not exists una_cuenta_abierta_por_mesa
  on public.pedidos (mesa_id) where estado = 'abierto' and mesa_id is not null;
create index if not exists pedidos_por_cierre on public.pedidos (cerrado);

create table if not exists public.pedido_items (
  id uuid primary key default gen_random_uuid(),
  pedido_id uuid not null references public.pedidos (id) on delete cascade,
  plato_id uuid references public.platos (id) on delete set null,
  nombre text not null,
  precio integer not null, -- precio unitario con modificadores
  cantidad integer not null check (cantidad > 0),
  opciones jsonb not null default '[]',
  nota text not null default '',
  estado text not null default 'nuevo' check (estado in ('nuevo', 'cocina', 'listo', 'entregado')),
  costo numeric, -- costo unitario al cobrar
  creado timestamptz not null default now()
);

create index if not exists items_por_pedido on public.pedido_items (pedido_id);

-- Cuándo se imprimió la comanda de cada plato (null = falta imprimir).
alter table public.pedido_items add column if not exists impreso timestamptz;

-- Datos del negocio para los tickets. Siempre una sola fila.
create table if not exists public.negocio (
  id integer primary key default 1 check (id = 1),
  nombre text not null default 'Mi restaurante',
  nit text not null default '',
  direccion text not null default '',
  telefono text not null default '',
  pie text not null default '¡Gracias por tu visita!'
);
insert into public.negocio (id) values (1) on conflict (id) do nothing;

create table if not exists public.gastos (
  id uuid primary key default gen_random_uuid(),
  fecha date not null default current_date,
  categoria text not null,
  descripcion text not null default '',
  valor integer not null check (valor > 0),
  metodo text not null default '',
  usuario uuid default auth.uid()
);

-- Permisos de lectura y escritura ----------------------------------------------

do $$
declare
  t text;
begin
  foreach t in array array['miembros', 'negocio', 'categorias', 'platos', 'insumos', 'recetas', 'grupos_mod', 'opciones_mod',
    'plato_grupos', 'movimientos', 'mesas', 'empleados', 'pedidos', 'pedido_items', 'gastos'] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('revoke all on public.%I from anon', t);
    execute format('grant select on public.%I to authenticated', t);
  end loop;
end $$;

-- Todo el equipo lee el menú, las mesas y los pedidos.
do $$
declare
  t text;
begin
  foreach t in array array['categorias', 'platos', 'insumos', 'recetas', 'grupos_mod', 'opciones_mod',
    'plato_grupos', 'mesas', 'pedidos', 'pedido_items'] loop
    execute format('drop policy if exists "equipo lee" on public.%I', t);
    execute format('create policy "equipo lee" on public.%I for select to authenticated using (rol_actual() is not null)', t);
  end loop;
end $$;

-- Solo el administrador cambia el menú, las recetas, las mesas y los empleados.
do $$
declare
  t text;
begin
  foreach t in array array['categorias', 'platos', 'recetas', 'grupos_mod', 'opciones_mod', 'plato_grupos', 'mesas', 'empleados'] loop
    execute format('grant insert, update, delete on public.%I to authenticated', t);
    execute format('drop policy if exists "admin cambia" on public.%I', t);
    execute format('create policy "admin cambia" on public.%I for all to authenticated using (rol_actual() = ''admin'') with check (rol_actual() = ''admin'')', t);
  end loop;
end $$;

-- Insumos: el administrador los crea y edita; el stock solo cambia con mover_insumo y cobrar.
grant insert, update, delete on public.insumos to authenticated;
drop policy if exists "admin cambia" on public.insumos;
create policy "admin cambia" on public.insumos for all to authenticated
  using (rol_actual() = 'admin') with check (rol_actual() = 'admin');

drop policy if exists "admin lee" on public.empleados;
create policy "admin lee" on public.empleados for select to authenticated using (rol_actual() = 'admin');

drop policy if exists "ver miembros" on public.miembros;
create policy "ver miembros" on public.miembros for select to authenticated
  using (user_id = auth.uid() or rol_actual() = 'admin');

drop policy if exists "admin lee" on public.movimientos;
create policy "admin lee" on public.movimientos for select to authenticated using (rol_actual() = 'admin');

grant insert, delete on public.gastos to authenticated;
drop policy if exists "caja lee" on public.gastos;
create policy "caja lee" on public.gastos for select to authenticated using (rol_actual() in ('admin', 'cajero'));
drop policy if exists "caja registra" on public.gastos;
create policy "caja registra" on public.gastos for insert to authenticated
  with check (rol_actual() in ('admin', 'cajero') and usuario = auth.uid());
drop policy if exists "admin borra" on public.gastos;
create policy "admin borra" on public.gastos for delete to authenticated using (rol_actual() = 'admin');

-- Nombres del equipo, para elegir domiciliario sin ver salarios ni documentos.
create or replace function public.lista_equipo() returns table (id uuid, nombre text, cargo text)
language sql stable security definer set search_path = public as $$
  select e.id, e.nombre, e.cargo from empleados e
  where e.activo and rol_actual() is not null
  order by e.nombre
$$;

-- Operación del servicio ---------------------------------------------------------

create or replace function public.abrir_mesa(p_mesa uuid) returns uuid
language plpgsql security definer set search_path = public as $$
declare
  v_id uuid;
begin
  perform exigir_rol('admin', 'cajero', 'mesero');
  select id into v_id from pedidos where mesa_id = p_mesa and estado = 'abierto';
  if v_id is not null then
    return v_id;
  end if;
  if not exists (select 1 from mesas where id = p_mesa) then
    raise exception 'Esa mesa no existe';
  end if;
  insert into pedidos (tipo, mesa_id) values ('mesa', p_mesa) returning id into v_id;
  return v_id;
exception when unique_violation then
  -- Otro mesero la abrió al mismo tiempo: se usa esa cuenta.
  select id into v_id from pedidos where mesa_id = p_mesa and estado = 'abierto';
  return v_id;
end $$;

create or replace function public.crear_domicilio(
  p_cliente text, p_telefono text, p_direccion text, p_envio integer, p_domiciliario uuid, p_notas text
) returns uuid
language plpgsql security definer set search_path = public as $$
declare
  v_id uuid;
begin
  perform exigir_rol('admin', 'cajero');
  if coalesce(trim(p_cliente), '') = '' or coalesce(trim(p_direccion), '') = '' then
    raise exception 'Escribe el cliente y la dirección';
  end if;
  insert into pedidos (tipo, entrega, cliente, telefono, direccion, envio, domiciliario_id, notas)
  values ('domicilio', 'preparando', trim(p_cliente), coalesce(trim(p_telefono), ''), trim(p_direccion),
          greatest(coalesce(p_envio, 0), 0), p_domiciliario, coalesce(trim(p_notas), ''))
  returning id into v_id;
  return v_id;
end $$;

create or replace function public.actualizar_domicilio(p_pedido uuid, p_entrega text, p_domiciliario uuid) returns void
language plpgsql security definer set search_path = public as $$
begin
  perform exigir_rol('admin', 'cajero');
  update pedidos set entrega = coalesce(p_entrega, entrega), domiciliario_id = p_domiciliario
  where id = p_pedido and tipo = 'domicilio' and estado <> 'anulado';
  if not found then
    raise exception 'Ese domicilio no existe o está anulado';
  end if;
end $$;

-- Agrega un plato con sus modificadores. El precio sale del menú, nunca del navegador.
create or replace function public.agregar_item(
  p_pedido uuid, p_plato uuid, p_cantidad integer, p_opciones uuid[], p_nota text
) returns void
language plpgsql security definer set search_path = public as $$
declare
  v_plato platos;
  v_grupo record;
  v_opciones jsonb;
  v_extra integer;
  v_elegidas uuid[] := coalesce(p_opciones, '{}');
begin
  perform exigir_rol('admin', 'cajero', 'mesero');
  if not exists (select 1 from pedidos where id = p_pedido and estado = 'abierto') then
    raise exception 'Esta cuenta ya está cerrada';
  end if;
  if p_cantidad is null or p_cantidad < 1 then
    raise exception 'La cantidad debe ser 1 o más';
  end if;
  select * into v_plato from platos where id = p_plato and activo;
  if not found then
    raise exception 'Ese plato no está disponible';
  end if;

  -- Cada opción debe pertenecer a un grupo de este plato.
  if exists (
    select 1 from unnest(v_elegidas) as e(id)
    where not exists (
      select 1 from opciones_mod o join plato_grupos pg on pg.grupo_id = o.grupo_id
      where o.id = e.id and pg.plato_id = p_plato
    )
  ) then
    raise exception 'Una de las opciones no aplica a %', v_plato.nombre;
  end if;

  for v_grupo in
    select g.nombre, g.obligatorio, g.maximo,
      (select count(*) from opciones_mod o where o.grupo_id = g.id and o.id = any (v_elegidas)) as elegidas
    from grupos_mod g join plato_grupos pg on pg.grupo_id = g.id
    where pg.plato_id = p_plato
  loop
    if v_grupo.obligatorio and v_grupo.elegidas = 0 then
      raise exception 'Elige una opción de %', v_grupo.nombre;
    end if;
    if v_grupo.elegidas > v_grupo.maximo then
      raise exception 'En % puedes elegir máximo %', v_grupo.nombre, v_grupo.maximo;
    end if;
  end loop;

  select coalesce(jsonb_agg(jsonb_build_object('id', o.id, 'nombre', o.nombre, 'precio', o.precio) order by o.nombre), '[]'),
         coalesce(sum(o.precio), 0)
  into v_opciones, v_extra
  from opciones_mod o where o.id = any (v_elegidas);

  insert into pedido_items (pedido_id, plato_id, nombre, precio, cantidad, opciones, nota)
  values (p_pedido, p_plato, v_plato.nombre, v_plato.precio + v_extra, p_cantidad, v_opciones, coalesce(trim(p_nota), ''));
end $$;

-- Lo que no se ha enviado a cocina lo quita cualquiera; lo ya enviado, solo caja o administrador.
create or replace function public.quitar_item(p_item uuid) returns void
language plpgsql security definer set search_path = public as $$
declare
  v_estado text;
begin
  perform exigir_rol('admin', 'cajero', 'mesero');
  select i.estado into v_estado from pedido_items i join pedidos p on p.id = i.pedido_id
  where i.id = p_item and p.estado = 'abierto';
  if not found then
    raise exception 'Ese plato ya no se puede quitar';
  end if;
  if v_estado <> 'nuevo' then
    perform exigir_rol('admin', 'cajero');
  end if;
  delete from pedido_items where id = p_item;
end $$;

create or replace function public.enviar_cocina(p_pedido uuid) returns integer
language plpgsql security definer set search_path = public as $$
declare
  v_total integer;
begin
  perform exigir_rol('admin', 'cajero', 'mesero');
  update pedido_items i set estado = 'cocina'
  from pedidos p
  where i.pedido_id = p.id and p.id = p_pedido and p.estado = 'abierto' and i.estado = 'nuevo';
  get diagnostics v_total = row_count;
  return v_total;
end $$;

-- Cocina marca un pedido como listo; el mesero lo marca entregado.
create or replace function public.marcar_items(p_pedido uuid, p_de text, p_a text) returns void
language plpgsql security definer set search_path = public as $$
begin
  if p_de = 'cocina' and p_a = 'listo' then
    perform exigir_rol('admin', 'cajero', 'cocina');
  elsif p_de = 'listo' and p_a = 'entregado' then
    perform exigir_rol('admin', 'cajero', 'mesero');
  else
    raise exception 'Cambio de estado no permitido';
  end if;
  update pedido_items set estado = p_a where pedido_id = p_pedido and estado = p_de;
end $$;

-- Cobra la cuenta: fija el total y descuenta del inventario la receta de cada plato y los
-- insumos de sus modificadores. El stock puede quedar negativo: es mejor vender y corregir
-- el inventario que frenar el servicio.
create or replace function public.cobrar(p_pedido uuid, p_metodo text, p_propina integer) returns integer
language plpgsql security definer set search_path = public as $$
declare
  v_pedido pedidos;
  v_total integer;
  v_consumo record;
begin
  perform exigir_rol('admin', 'cajero');
  if p_metodo not in ('Efectivo', 'Tarjeta', 'Transferencia', 'Nequi', 'Daviplata') then
    raise exception 'Elige el método de pago';
  end if;
  select * into v_pedido from pedidos where id = p_pedido for update;
  if not found or v_pedido.estado <> 'abierto' then
    raise exception 'Esta cuenta ya está cerrada';
  end if;
  if not exists (select 1 from pedido_items where pedido_id = p_pedido) then
    raise exception 'La cuenta no tiene platos';
  end if;

  -- Consumo de insumos de toda la cuenta.
  create temporary table if not exists _consumo (item_id uuid, insumo_id uuid, cantidad numeric) on commit drop;
  -- truncate y no delete: Supabase rechaza un DELETE sin WHERE (extensión safeupdate).
  truncate _consumo;
  insert into _consumo
    select i.id, r.insumo_id, r.cantidad * i.cantidad
    from pedido_items i join recetas r on r.plato_id = i.plato_id
    where i.pedido_id = p_pedido
    union all
    select i.id, o.insumo_id, o.cantidad * i.cantidad
    from pedido_items i
    cross join lateral jsonb_array_elements(i.opciones) as e(opcion)
    join opciones_mod o on o.id = (e.opcion ->> 'id')::uuid
    where i.pedido_id = p_pedido and o.insumo_id is not null and o.cantidad is not null;

  -- Costo unitario de cada plato con el costo actual de los insumos.
  update pedido_items i set costo = coalesce((
    select sum(c.cantidad * s.costo) / i.cantidad
    from _consumo c join insumos s on s.id = c.insumo_id
    where c.item_id = i.id
  ), 0)
  where i.pedido_id = p_pedido;

  for v_consumo in
    select c.insumo_id, sum(c.cantidad) as cantidad from _consumo c group by c.insumo_id
  loop
    update insumos set stock = stock - v_consumo.cantidad where id = v_consumo.insumo_id;
    insert into movimientos (insumo_id, insumo, cantidad, saldo, motivo)
    select id, nombre, -v_consumo.cantidad, stock, 'Venta #' || v_pedido.numero
    from insumos where id = v_consumo.insumo_id;
  end loop;

  select sum(precio * cantidad) + v_pedido.envio into v_total from pedido_items where pedido_id = p_pedido;
  update pedidos set
    estado = 'pagado',
    total = v_total,
    propina = greatest(coalesce(p_propina, 0), 0),
    costo = (select coalesce(sum(costo * cantidad), 0) from pedido_items where pedido_id = p_pedido),
    metodo_pago = p_metodo,
    cerrado = now()
  where id = p_pedido;
  return v_total;
end $$;

-- Anula una cuenta. Si ya estaba pagada, devuelve al inventario lo que se descontó.
create or replace function public.anular(p_pedido uuid, p_motivo text) returns void
language plpgsql security definer set search_path = public as $$
declare
  v_pedido pedidos;
  v_mov record;
begin
  perform exigir_rol('admin');
  select * into v_pedido from pedidos where id = p_pedido for update;
  if not found or v_pedido.estado = 'anulado' then
    raise exception 'Esa cuenta no existe o ya está anulada';
  end if;
  if v_pedido.estado = 'pagado' then
    for v_mov in
      select insumo_id, sum(cantidad) as cantidad from movimientos
      where motivo = 'Venta #' || v_pedido.numero and insumo_id is not null
      group by insumo_id
    loop
      update insumos set stock = stock - v_mov.cantidad where id = v_mov.insumo_id;
      insert into movimientos (insumo_id, insumo, cantidad, saldo, motivo)
      select id, nombre, -v_mov.cantidad, stock, 'Anulación venta #' || v_pedido.numero
      from insumos where id = v_mov.insumo_id;
    end loop;
  end if;
  update pedidos set estado = 'anulado', cerrado = coalesce(cerrado, now()),
    motivo_anulacion = coalesce(trim(p_motivo), '')
  where id = p_pedido;
end $$;

-- Entrada (compra) o salida (daño, pérdida) de un insumo. Una entrada con costo promedia el costo.
create or replace function public.mover_insumo(p_insumo uuid, p_tipo text, p_cantidad numeric, p_costo numeric, p_motivo text)
returns void
language plpgsql security definer set search_path = public as $$
declare
  v_insumo insumos;
begin
  perform exigir_rol('admin');
  if p_cantidad is null or p_cantidad <= 0 then
    raise exception 'La cantidad debe ser mayor que 0';
  end if;
  select * into v_insumo from insumos where id = p_insumo for update;
  if not found then
    raise exception 'Ese insumo no existe';
  end if;
  if p_tipo = 'entrada' then
    if p_costo is not null and p_costo >= 0 then
      update insumos set costo = case
        when v_insumo.stock <= 0 then p_costo
        else (v_insumo.stock * v_insumo.costo + p_cantidad * p_costo) / (v_insumo.stock + p_cantidad)
      end where id = p_insumo;
    end if;
    update insumos set stock = stock + p_cantidad where id = p_insumo;
  elsif p_tipo = 'salida' then
    update insumos set stock = stock - p_cantidad where id = p_insumo;
  else
    raise exception 'Tipo de movimiento no válido';
  end if;
  insert into movimientos (insumo_id, insumo, cantidad, saldo, motivo)
  select id, nombre, case when p_tipo = 'entrada' then p_cantidad else -p_cantidad end, stock,
    coalesce(nullif(trim(p_motivo), ''), case when p_tipo = 'entrada' then 'Compra' else 'Salida' end)
  from insumos where id = p_insumo;
end $$;

-- Datos del negocio: todo el equipo los lee (salen en los tickets); solo el administrador los cambia.
drop policy if exists "equipo lee" on public.negocio;
create policy "equipo lee" on public.negocio for select to authenticated using (rol_actual() is not null);
grant update on public.negocio to authenticated;
drop policy if exists "admin cambia" on public.negocio;
create policy "admin cambia" on public.negocio for update to authenticated
  using (rol_actual() = 'admin') with check (rol_actual() = 'admin');

-- Entrega las comandas que faltan por imprimir y las marca como impresas en el mismo paso.
-- Si dos equipos imprimen a la vez, cada plato le sale a uno solo.
create or replace function public.comandas_por_imprimir() returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_resultado jsonb;
begin
  perform exigir_rol('admin', 'cajero', 'mesero', 'cocina');
  with tomados as (
    update pedido_items set impreso = now()
    where estado = 'cocina' and impreso is null
    returning *
  )
  select coalesce(jsonb_agg(c order by c ->> 'enviado'), '[]') into v_resultado
  from (
    select jsonb_build_object(
      'pedido_id', p.id,
      'numero', p.numero,
      'tipo', p.tipo,
      'mesa', m.nombre,
      'cliente', p.cliente,
      'atiende', mi.nombre,
      'enviado', min(t.creado),
      'items', jsonb_agg(jsonb_build_object(
        'nombre', t.nombre, 'cantidad', t.cantidad, 'opciones', t.opciones, 'nota', t.nota
      ) order by t.creado)
    ) as c
    from tomados t
    join pedidos p on p.id = t.pedido_id
    left join mesas m on m.id = p.mesa_id
    left join miembros mi on mi.user_id = p.abierto_por
    group by p.id, m.nombre, mi.nombre
  ) as comandas;
  return v_resultado;
end $$;

-- Las funciones solo las puede llamar alguien con sesión; cada una revisa además el rol.
do $$
declare
  f text;
begin
  foreach f in array array['rol_actual()', 'exigir_rol(text[])', 'reclamar_admin(text)', 'lista_equipo()',
    'abrir_mesa(uuid)', 'crear_domicilio(text, text, text, integer, uuid, text)', 'actualizar_domicilio(uuid, text, uuid)',
    'agregar_item(uuid, uuid, integer, uuid[], text)', 'quitar_item(uuid)', 'enviar_cocina(uuid)',
    'marcar_items(uuid, text, text)', 'cobrar(uuid, text, integer)', 'anular(uuid, text)',
    'mover_insumo(uuid, text, numeric, numeric, text)', 'comandas_por_imprimir()'] loop
    execute format('revoke all on function public.%s from public, anon', f);
    execute format('grant execute on function public.%s to authenticated', f);
  end loop;
end $$;

-- Actualizaciones en vivo para mesas, cocina y domicilios.
-- Si una tabla ya estaba activada (por ejemplo, desde el panel de Supabase), se deja como está.
do $$
declare
  t text;
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    foreach t in array array['pedidos', 'pedido_items'] loop
      begin
        execute format('alter publication supabase_realtime add table public.%I', t);
      exception when duplicate_object then
        null;
      end;
    end loop;
  end if;
end $$;
