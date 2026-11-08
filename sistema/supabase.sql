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
  rol text not null check (rol in ('admin', 'cajero', 'mesero', 'cocina', 'domiciliario')),
  activo boolean not null default true
);

-- Rol domiciliario: solo ve los domicilios por entregar y los marca como entregados.
alter table public.miembros drop constraint if exists miembros_rol_check;
alter table public.miembros add constraint miembros_rol_check
  check (rol in ('admin', 'cajero', 'mesero', 'cocina', 'domiciliario'));

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

-- Estado de un domicilio: vacío mientras se toma el pedido, "preparando" al facturarlo,
-- luego "en camino" y "entregado" (se puede pasar directo de preparando a entregado).
-- Ajuste de una sola vez (antes de existir la columna "novedades"): si los domicilios todavía
-- tienen los estados viejos, los ya cobrados se dan por entregados.
do $$
begin
  if not exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'pedidos' and column_name = 'novedades'
  ) then
    if exists (
      select 1 from pg_constraint
      where conname = 'pedidos_entrega_check' and pg_get_constraintdef(oid) like '%en_camino%'
    ) then
      update public.pedidos set entrega = null where tipo = 'domicilio' and estado = 'abierto';
      update public.pedidos set entrega = 'entregado'
      where tipo = 'domicilio' and estado <> 'abierto' and entrega is distinct from 'entregado';
    end if;
    alter table public.pedidos drop constraint if exists pedidos_entrega_check;
    alter table public.pedidos add constraint pedidos_entrega_check
      check (entrega in ('preparando', 'en_camino', 'entregado'));
  end if;
end $$;

-- Lo que registra el domiciliario: novedades del camino, lo que le pagó el cliente
-- (contra entrega) y a qué hora entregó.
alter table public.pedidos add column if not exists novedades text not null default '';
alter table public.pedidos add column if not exists recibido integer check (recibido is null or recibido >= 0);
alter table public.pedidos add column if not exists entregado_en timestamptz;

-- Los domicilios tienen su propia numeración, aparte del número de la venta,
-- y vuelve a empezar en #1 cada día (hora de Colombia).
alter table public.pedidos add column if not exists numero_domicilio bigint;
drop sequence if exists public.numero_domicilio_seq;
with por_dia as (
  select id, row_number() over (
    partition by (creado at time zone 'America/Bogota')::date order by creado, numero
  ) as n
  from public.pedidos where tipo = 'domicilio'
)
update public.pedidos p set numero_domicilio = d.n
from por_dia d where p.id = d.id and p.numero_domicilio is distinct from d.n;

-- Cada domicilio nuevo recibe su número del día al guardarse, venga de donde venga.
create or replace function public.asignar_numero_domicilio() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if new.tipo = 'domicilio' then
    -- Uno a la vez, para que dos cajas no tomen el mismo número.
    perform pg_advisory_xact_lock(hashtext('numero_domicilio'));
    select coalesce(max(numero_domicilio), 0) + 1 into new.numero_domicilio
    from pedidos
    where tipo = 'domicilio'
      and (creado at time zone 'America/Bogota')::date = (new.creado at time zone 'America/Bogota')::date;
  end if;
  return new;
end $$;

drop trigger if exists numero_domicilio on public.pedidos;
create trigger numero_domicilio before insert on public.pedidos
  for each row execute function public.asignar_numero_domicilio();

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

-- Mesa para comer aquí o para llevar (el cliente espera en el local).
alter table public.pedidos add column if not exists para_llevar boolean not null default false;

-- Pagos de una cuenta. Una cuenta se puede pagar por partes: cada persona paga sus platos
-- con su propio método. La cuenta se cierra cuando ya no queda nada sin pagar.
create table if not exists public.pagos (
  id uuid primary key default gen_random_uuid(),
  pedido_id uuid not null references public.pedidos (id) on delete cascade,
  metodo text not null,
  valor integer not null check (valor >= 0),
  fecha timestamptz not null default now(),
  usuario uuid default auth.uid()
);
create index if not exists pagos_por_pedido on public.pagos (pedido_id);
-- Con qué pago se pagó cada plato (null = falta por pagar).
alter table public.pedido_items add column if not exists pago_id uuid references public.pagos (id) on delete set null;

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
-- Logo del restaurante (imagen pequeña guardada como texto). Sale en el panel y en la bienvenida.
alter table public.negocio add column if not exists logo text not null default '';
alter table public.negocio drop constraint if exists negocio_logo_tamano;
alter table public.negocio add constraint negocio_logo_tamano check (length(logo) <= 500000);

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
    'plato_grupos', 'movimientos', 'mesas', 'empleados', 'pedidos', 'pedido_items', 'pagos', 'gastos'] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('revoke all on public.%I from anon', t);
    execute format('grant select on public.%I to authenticated', t);
    -- La clave secreta (usada por api/equipo.js para crear usuarios) necesita acceso completo.
    execute format('grant all on public.%I to service_role', t);
  end loop;
end $$;
grant usage on schema public to service_role;

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

-- Ficha de empleado de quien tiene la sesión (para saber cuáles domicilios son suyos).
create or replace function public.mi_empleado() returns uuid
language sql stable security definer set search_path = public as $$
  select id from empleados where user_id = auth.uid() and activo limit 1
$$;

-- El domiciliario no ve ventas: solo las mesas abiertas (para tomar pedidos) y sus domicilios
-- ya enviados a cocina (cobrados o no), más los que nadie tiene asignados.
drop policy if exists "equipo lee" on public.pedidos;
create policy "equipo lee" on public.pedidos for select to authenticated using (
  case rol_actual()
    when 'domiciliario' then
      (tipo = 'mesa' and estado = 'abierto')
      or (tipo = 'domicilio' and estado <> 'anulado' and entrega is not null
          and (domiciliario_id is null or domiciliario_id = mi_empleado()))
    else rol_actual() is not null
  end
);
drop policy if exists "equipo lee" on public.pedido_items;
create policy "equipo lee" on public.pedido_items for select to authenticated using (
  rol_actual() is not null and exists (select 1 from pedidos p where p.id = pedido_id)
);
drop policy if exists "equipo lee" on public.pagos;
create policy "equipo lee" on public.pagos for select to authenticated using (
  rol_actual() is not null and exists (select 1 from pedidos p where p.id = pedido_id)
);

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
  perform exigir_rol('admin', 'cajero', 'mesero', 'domiciliario');
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
  -- Solo el nombre es obligatorio; teléfono, dirección y lo demás se pueden dejar en blanco.
  if coalesce(trim(p_cliente), '') = '' then
    raise exception 'Escribe el nombre del cliente';
  end if;
  if coalesce(p_envio, 0) not in (0, 1000, 2000) then
    raise exception 'El envío solo puede ser 0, 1.000 o 2.000';
  end if;
  -- El número del día lo pone la regla "numero_domicilio" de la tabla.
  -- Queda sin estado de entrega: pasa a "preparando" cuando se envía a cocina.
  insert into pedidos (tipo, cliente, telefono, direccion, envio, domiciliario_id, notas)
  values ('domicilio', trim(p_cliente), coalesce(trim(p_telefono), ''), coalesce(trim(p_direccion), ''),
          coalesce(p_envio, 0), p_domiciliario, coalesce(trim(p_notas), ''))
  returning id into v_id;
  return v_id;
end $$;

drop function if exists public.actualizar_domicilio(uuid, text, uuid);

create or replace function public.asignar_domiciliario(p_pedido uuid, p_domiciliario uuid) returns void
language plpgsql security definer set search_path = public as $$
begin
  perform exigir_rol('admin', 'cajero');
  update pedidos set domiciliario_id = p_domiciliario
  where id = p_pedido and tipo = 'domicilio' and estado <> 'anulado';
  if not found then
    raise exception 'Ese domicilio no existe o está anulado';
  end if;
end $$;

drop function if exists public.marcar_entregado(uuid);

-- Revisa que quien llama pueda tocar este domicilio (ya enviado a cocina y no anulado).
-- Un domiciliario solo toca los suyos; si no tenía a nadie asignado, queda a su nombre.
-- Uso interno: solo la llaman las funciones de abajo.
create or replace function public.domicilio_para_mi(p_pedido uuid) returns void
language plpgsql security definer set search_path = public as $$
declare
  v_pedido pedidos;
  v_yo uuid;
begin
  perform exigir_rol('admin', 'cajero', 'domiciliario');
  select * into v_pedido from pedidos where id = p_pedido and tipo = 'domicilio' for update;
  if not found or v_pedido.estado = 'anulado' or v_pedido.entrega is null then
    raise exception 'Ese domicilio no existe, no se ha enviado a cocina o está anulado';
  end if;
  if rol_actual() = 'domiciliario' then
    v_yo := mi_empleado();
    if v_yo is null then
      raise exception 'Tu usuario no está ligado a una ficha de empleado. Pídele al administrador que lo revise.';
    end if;
    if v_pedido.domiciliario_id is null then
      update pedidos set domiciliario_id = v_yo where id = p_pedido;
    elsif v_pedido.domiciliario_id <> v_yo then
      raise exception 'Ese domicilio está asignado a otro domiciliario';
    end if;
  end if;
end $$;

-- Preparando → En camino → Entregado. Se puede saltar directo a Entregado.
create or replace function public.cambiar_entrega(p_pedido uuid, p_entrega text) returns void
language plpgsql security definer set search_path = public as $$
begin
  if p_entrega not in ('preparando', 'en_camino', 'entregado') then
    raise exception 'Estado no válido';
  end if;
  perform domicilio_para_mi(p_pedido);
  update pedidos set
    entrega = p_entrega,
    entregado_en = case when p_entrega = 'entregado' then coalesce(entregado_en, now()) end
  where id = p_pedido;
  if p_entrega = 'entregado' then
    update pedido_items set estado = 'entregado' where pedido_id = p_pedido;
  end if;
end $$;

-- Novedades del camino (dirección errada, cliente no contesta…). Se van sumando con hora y nombre.
create or replace function public.registrar_novedad(p_pedido uuid, p_texto text) returns void
language plpgsql security definer set search_path = public as $$
begin
  if coalesce(trim(p_texto), '') = '' then
    raise exception 'Escribe la novedad';
  end if;
  perform domicilio_para_mi(p_pedido);
  update pedidos set novedades = concat_ws(E'\n', nullif(novedades, ''),
    to_char(now() at time zone 'America/Bogota', 'HH12:MI am') || ' · '
      || coalesce((select nombre from miembros where user_id = auth.uid()), '') || ': ' || trim(p_texto))
  where id = p_pedido;
end $$;

-- Lo que el cliente le pagó al domiciliario (pago contra entrega). Null = no aplica.
create or replace function public.registrar_recibido(p_pedido uuid, p_valor integer) returns void
language plpgsql security definer set search_path = public as $$
begin
  if p_valor is not null and p_valor < 0 then
    raise exception 'El valor no puede ser negativo';
  end if;
  perform domicilio_para_mi(p_pedido);
  update pedidos set recibido = p_valor where id = p_pedido;
end $$;

-- El domiciliario toma pedidos en las mesas, pero no cambia platos ni cantidades de un domicilio.
create or replace function public.solo_mesas_si_domiciliario(p_pedido uuid) returns void
language plpgsql stable security definer set search_path = public as $$
begin
  if rol_actual() = 'domiciliario' and not exists (select 1 from pedidos where id = p_pedido and tipo = 'mesa') then
    raise exception 'No puedes cambiar los platos de un domicilio' using errcode = '42501';
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
  perform exigir_rol('admin', 'cajero', 'mesero', 'domiciliario');
  if not exists (select 1 from pedidos where id = p_pedido and estado = 'abierto') then
    raise exception 'Esta cuenta ya está cerrada';
  end if;
  perform solo_mesas_si_domiciliario(p_pedido);
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
  perform exigir_rol('admin', 'cajero', 'mesero', 'domiciliario');
  select i.estado into v_estado from pedido_items i join pedidos p on p.id = i.pedido_id
  where i.id = p_item and p.estado = 'abierto' and i.pago_id is null;
  if not found then
    raise exception 'Ese plato ya no se puede quitar';
  end if;
  perform solo_mesas_si_domiciliario((select pedido_id from pedido_items where id = p_item));
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
  perform exigir_rol('admin', 'cajero', 'mesero', 'domiciliario');
  perform solo_mesas_si_domiciliario(p_pedido);
  update pedido_items i set estado = 'cocina'
  from pedidos p
  where i.pedido_id = p.id and p.id = p_pedido and p.estado = 'abierto' and i.estado = 'nuevo';
  get diagnostics v_total = row_count;
  -- Un domicilio enviado a cocina queda "en preparación" (se cobra después, al entregarlo).
  if v_total > 0 then
    update pedidos set entrega = coalesce(entrega, 'preparando') where id = p_pedido and tipo = 'domicilio';
  end if;
  return v_total;
end $$;

-- Marca la cuenta de una mesa como "para llevar" o "para comer aquí".
create or replace function public.cambiar_para_llevar(p_pedido uuid, p_para_llevar boolean) returns void
language plpgsql security definer set search_path = public as $$
begin
  perform exigir_rol('admin', 'cajero', 'mesero', 'domiciliario');
  update pedidos set para_llevar = coalesce(p_para_llevar, false)
  where id = p_pedido and tipo = 'mesa' and estado = 'abierto';
  if not found then
    raise exception 'Esa cuenta ya está cerrada';
  end if;
end $$;

-- Cocina tiene un solo paso: todo lo que está preparándose de un pedido se marca entregado de una vez.
create or replace function public.entregar_pedido(p_pedido uuid) returns void
language plpgsql security definer set search_path = public as $$
begin
  perform exigir_rol('admin', 'cajero', 'mesero', 'cocina', 'domiciliario');
  update pedido_items set estado = 'entregado' where pedido_id = p_pedido and estado in ('cocina', 'listo');
end $$;

-- (Anterior) Cocina marca un pedido como listo; el mesero lo marca entregado.
create or replace function public.marcar_items(p_pedido uuid, p_de text, p_a text) returns void
language plpgsql security definer set search_path = public as $$
begin
  if p_de = 'cocina' and p_a = 'listo' then
    perform exigir_rol('admin', 'cajero', 'cocina');
  elsif p_de = 'listo' and p_a = 'entregado' then
    perform exigir_rol('admin', 'cajero', 'mesero', 'domiciliario');
  else
    raise exception 'Cambio de estado no permitido';
  end if;
  update pedido_items set estado = p_a where pedido_id = p_pedido and estado = p_de;
end $$;

-- Cierra una cuenta ya pagada del todo: fija el total y descuenta del inventario la receta de
-- cada plato y los insumos de sus modificadores. El stock puede quedar negativo: es mejor vender
-- y corregir el inventario que frenar el servicio. Uso interno: la llama cobrar_parte.
create or replace function public.cerrar_cuenta(p_pedido uuid) returns integer
language plpgsql security definer set search_path = public as $$
declare
  v_pedido pedidos;
  v_total integer;
  v_consumo record;
begin
  select * into v_pedido from pedidos where id = p_pedido for update;

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
    propina = 0,
    costo = (select coalesce(sum(costo * cantidad), 0) from pedido_items where pedido_id = p_pedido),
    -- Si se pagó con un solo método queda ese; si se dividió entre varios métodos, "Varios".
    metodo_pago = (select case when count(distinct metodo) = 1 then min(metodo) else 'Varios' end
                   from pagos where pedido_id = p_pedido),
    cerrado = now(),
    -- Si un domicilio se cobra antes de enviarlo a cocina, pasa a preparación y se manda a cocina.
    entrega = case when tipo = 'domicilio' then coalesce(entrega, 'preparando') else entrega end
  where id = p_pedido;
  if v_pedido.tipo = 'domicilio' then
    update pedido_items set estado = 'cocina' where pedido_id = p_pedido and estado = 'nuevo';
  end if;
  return v_total;
end $$;

-- Cobra una parte de la cuenta: los platos (y cuántos de cada uno) que paga una persona, con su
-- método de pago. p_items = [{"id": plato de la cuenta, "cantidad": n}]. Si de un plato se paga
-- solo una parte (1 de 2 gourmet), se separa en dos líneas. El envío va en el pago que cierra la
-- cuenta. Cuando ya no queda nada por pagar, la cuenta se cierra sola.
create or replace function public.cobrar_parte(p_pedido uuid, p_items jsonb, p_metodo text) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_pedido pedidos;
  v_sel record;
  v_item pedido_items;
  v_ids uuid[] := '{}';
  v_nuevo uuid;
  v_valor integer := 0;
  v_pago uuid;
  v_cierra boolean;
  v_resta integer;
begin
  perform exigir_rol('admin', 'cajero');
  if p_metodo not in ('Efectivo', 'Tarjeta', 'Transferencia', 'Nequi', 'Daviplata') then
    raise exception 'Elige el método de pago';
  end if;
  select * into v_pedido from pedidos where id = p_pedido for update;
  if not found or v_pedido.estado <> 'abierto' then
    raise exception 'Esta cuenta ya está cerrada';
  end if;

  for v_sel in
    select (e ->> 'id')::uuid as id, sum((e ->> 'cantidad')::integer) as cantidad
    from jsonb_array_elements(coalesce(p_items, '[]')) as e
    group by 1
  loop
    continue when coalesce(v_sel.cantidad, 0) < 1;
    select * into v_item from pedido_items
    where id = v_sel.id and pedido_id = p_pedido and pago_id is null for update;
    if not found then
      raise exception 'Uno de los platos ya se pagó o no es de esta cuenta';
    end if;
    if v_sel.cantidad > v_item.cantidad then
      raise exception 'De % solo hay %', v_item.nombre, v_item.cantidad;
    end if;
    if v_sel.cantidad < v_item.cantidad then
      update pedido_items set cantidad = cantidad - v_sel.cantidad where id = v_item.id;
      insert into pedido_items (pedido_id, plato_id, nombre, precio, cantidad, opciones, nota, estado, creado, impreso)
      values (v_item.pedido_id, v_item.plato_id, v_item.nombre, v_item.precio, v_sel.cantidad,
              v_item.opciones, v_item.nota, v_item.estado, v_item.creado, v_item.impreso)
      returning id into v_nuevo;
      v_ids := v_ids || v_nuevo;
    else
      v_ids := v_ids || v_item.id;
    end if;
    v_valor := v_valor + v_sel.cantidad * v_item.precio;
  end loop;

  if cardinality(v_ids) = 0 then
    raise exception 'Elige qué platos se van a pagar';
  end if;
  v_cierra := not exists (
    select 1 from pedido_items where pedido_id = p_pedido and pago_id is null and id <> all (v_ids)
  );
  -- Lo que falta por cobrar (la cuenta puede tener abonos por valor, ver «abonar»).
  v_resta := (select coalesce(sum(precio * cantidad), 0) from pedido_items where pedido_id = p_pedido) + v_pedido.envio
    - (select coalesce(sum(valor), 0) from pagos where pedido_id = p_pedido);
  -- El último pago se lleva lo que falte (incluye el envío); ninguno cobra más de lo que falta.
  v_valor := case when v_cierra then v_resta else least(v_valor, v_resta) end;
  v_cierra := v_cierra or v_valor >= v_resta;

  insert into pagos (pedido_id, metodo, valor) values (p_pedido, p_metodo, v_valor) returning id into v_pago;
  update pedido_items set pago_id = v_pago where id = any (v_ids);
  if v_cierra then
    update pedido_items set pago_id = v_pago where pedido_id = p_pedido and pago_id is null;
    perform cerrar_cuenta(p_pedido);
  end if;
  return jsonb_build_object('pago_id', v_pago, 'valor', v_valor, 'cerrada', v_cierra);
end $$;

-- Cobra un valor de la cuenta (dividir el total en partes: «entre 2», o lo que paga cada uno).
-- Cuando lo abonado completa el total, la cuenta se cierra sola.
create or replace function public.abonar(p_pedido uuid, p_valor integer, p_metodo text) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_pedido pedidos;
  v_resta integer;
  v_pago uuid;
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
  v_resta := (select coalesce(sum(precio * cantidad), 0) from pedido_items where pedido_id = p_pedido) + v_pedido.envio
    - (select coalesce(sum(valor), 0) from pagos where pedido_id = p_pedido);
  if p_valor is null or p_valor < 1 then
    raise exception 'Escribe el valor que se va a pagar';
  end if;
  if p_valor > v_resta then
    raise exception 'Solo falta por cobrar $%', to_char(v_resta, 'FM999G999G999');
  end if;
  insert into pagos (pedido_id, metodo, valor) values (p_pedido, p_metodo, p_valor) returning id into v_pago;
  if p_valor = v_resta then
    update pedido_items set pago_id = v_pago where pedido_id = p_pedido and pago_id is null;
    perform cerrar_cuenta(p_pedido);
  end if;
  return jsonb_build_object('pago_id', v_pago, 'valor', p_valor, 'cerrada', p_valor = v_resta, 'falta', v_resta - p_valor);
end $$;

-- Cobra todo lo que falta de la cuenta con un solo método. (La propina ya no se usa.)
create or replace function public.cobrar(p_pedido uuid, p_metodo text, p_propina integer) returns integer
language plpgsql security definer set search_path = public as $$
declare
  v_items jsonb;
begin
  perform exigir_rol('admin', 'cajero');
  select coalesce(jsonb_agg(jsonb_build_object('id', id, 'cantidad', cantidad)), '[]') into v_items
  from pedido_items where pedido_id = p_pedido and pago_id is null;
  if v_items = '[]'::jsonb then
    raise exception 'La cuenta no tiene platos por cobrar';
  end if;
  perform cobrar_parte(p_pedido, v_items, p_metodo);
  return (select total from pedidos where id = p_pedido);
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

-- Cola de impresión: lo que se imprime desde un celular (cuentas, tickets de pago, cierre de caja)
-- se guarda aquí y lo imprime el computador que tiene «Comandera aquí».
create table if not exists public.impresiones (
  id uuid primary key default gen_random_uuid(),
  html text not null check (length(html) <= 1000000),
  creado timestamptz not null default now(),
  creado_por uuid default auth.uid(),
  impreso timestamptz
);
alter table public.impresiones enable row level security;
revoke all on public.impresiones from anon;
grant select, insert on public.impresiones to authenticated;
grant all on public.impresiones to service_role;
drop policy if exists "equipo envía" on public.impresiones;
create policy "equipo envía" on public.impresiones for insert to authenticated
  with check (rol_actual() is not null and creado_por = auth.uid());
-- Solo para que la comandera reciba el aviso en vivo; el contenido se toma con la función de abajo.
drop policy if exists "equipo lee" on public.impresiones;
create policy "equipo lee" on public.impresiones for select to authenticated using (rol_actual() is not null);

-- Entrega lo que falta por imprimir y lo marca como impreso en el mismo paso (si dos equipos
-- tienen la comandera, cada ticket le sale a uno solo). Borra lo impreso hace más de 2 días.
drop function if exists public.impresiones_por_imprimir();
create or replace function public.impresiones_por_imprimir() returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_resultado jsonb;
begin
  perform exigir_rol('admin', 'cajero', 'mesero', 'cocina', 'domiciliario');
  delete from impresiones where impreso < now() - interval '2 days';
  with tomadas as (
    update impresiones set impreso = now()
    where id in (select id from impresiones where impreso is null order by creado for update skip locked)
    returning html, creado
  )
  select coalesce(jsonb_agg(html order by creado), '[]') into v_resultado from tomadas;
  return v_resultado;
end $$;

-- Entrega las comandas que faltan por imprimir y las marca como impresas en el mismo paso.
-- Si dos equipos imprimen a la vez, cada plato le sale a uno solo.
create or replace function public.comandas_por_imprimir() returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_resultado jsonb;
begin
  perform exigir_rol('admin', 'cajero', 'mesero', 'cocina', 'domiciliario');
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
      'numero_domicilio', p.numero_domicilio,
      'tipo', p.tipo,
      'mesa', m.nombre,
      'para_llevar', p.para_llevar,
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
    'abrir_mesa(uuid)', 'crear_domicilio(text, text, text, integer, uuid, text)', 'asignar_domiciliario(uuid, uuid)',
    'mi_empleado()', 'cambiar_entrega(uuid, text)', 'registrar_novedad(uuid, text)', 'registrar_recibido(uuid, integer)',
    'agregar_item(uuid, uuid, integer, uuid[], text)', 'quitar_item(uuid)', 'enviar_cocina(uuid)',
    'marcar_items(uuid, text, text)', 'entregar_pedido(uuid)', 'cobrar(uuid, text, integer)', 'anular(uuid, text)',
    'cobrar_parte(uuid, jsonb, text)', 'abonar(uuid, integer, text)', 'cambiar_para_llevar(uuid, boolean)',
    'mover_insumo(uuid, text, numeric, numeric, text)', 'comandas_por_imprimir()', 'impresiones_por_imprimir()',
    'asignar_numero_domicilio()'] loop
    execute format('revoke all on function public.%s from public, anon', f);
    execute format('grant execute on function public.%s to authenticated', f);
  end loop;
end $$;

-- Funciones de uso interno: nadie las llama directo, solo otras funciones.
revoke all on function public.domicilio_para_mi(uuid) from public, anon, authenticated;
revoke all on function public.solo_mesas_si_domiciliario(uuid) from public, anon, authenticated;
revoke all on function public.cerrar_cuenta(uuid) from public, anon, authenticated;

-- Actualizaciones en vivo para mesas, cocina y domicilios.
-- Si una tabla ya estaba activada (por ejemplo, desde el panel de Supabase), se deja como está.
do $$
declare
  t text;
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    foreach t in array array['pedidos', 'pedido_items', 'impresiones'] loop
      begin
        execute format('alter publication supabase_realtime add table public.%I', t);
      exception when duplicate_object then
        null;
      end;
    end loop;
  end if;
end $$;
