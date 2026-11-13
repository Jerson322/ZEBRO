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

-- Clave de autorización (opcional): la pone el administrador para sí mismo y, si quiere, para
-- alguien de confianza. Mientras nadie tenga clave, nada la pide. Se guarda cifrada (bcrypt).
create extension if not exists pgcrypto with schema extensions;
alter table public.miembros add column if not exists clave_hash text;

-- Personas y turnos ----------------------------------------------------------------
-- El dispositivo entra una vez al día con el correo y la clave del administrador (miembros).
-- Después, cada persona del equipo entra con su código (personas): eso abre un «turno» y el
-- sistema muestra su vista. Todo lo que se hace queda a nombre de la persona del turno, y la
-- base de datos revisa su rol. Los turnos vencen a las 3:00 a. m.
create extension if not exists pgcrypto with schema extensions;

create table if not exists public.personas (
  id uuid primary key default gen_random_uuid(),
  nombre text not null,
  rol text not null check (rol in ('admin', 'cajero', 'mesero', 'cocina', 'domiciliario')),
  clave_hash text not null,
  activo boolean not null default true,
  creado timestamptz not null default now()
);

create table if not exists public.turnos (
  token uuid primary key default gen_random_uuid(),
  persona_id uuid not null references public.personas (id) on delete cascade,
  dispositivo uuid not null default auth.uid(),
  inicio timestamptz not null default now(),
  vence timestamptz not null
);

-- Solo se tocan con las funciones de abajo.
alter table public.personas enable row level security;
alter table public.turnos enable row level security;
revoke all on public.personas from anon, authenticated;
revoke all on public.turnos from anon, authenticated;
grant all on public.personas to service_role;
grant all on public.turnos to service_role;

-- Rol del dispositivo (la cuenta con correo con la que se entró).
create or replace function public.rol_dispositivo() returns text
language sql stable security definer set search_path = public as $$
  select rol from miembros where user_id = auth.uid() and activo
$$;

-- El turno viene en la cabecera «x-turno» de cada pedido a la base de datos.
create or replace function public.turno_token() returns uuid
language plpgsql stable set search_path = public as $$
declare
  v_cabeceras text := current_setting('request.headers', true);
begin
  if v_cabeceras is null or v_cabeceras = '' then
    return null;
  end if;
  return nullif(v_cabeceras::json ->> 'x-turno', '')::uuid;
exception when others then
  return null;
end $$;

-- La persona del turno (o null si no hay turno válido en este dispositivo).
create or replace function public.persona_actual() returns uuid
language sql stable security definer set search_path = public as $$
  select t.persona_id from turnos t join personas p on p.id = t.persona_id
  where t.token = turno_token() and t.dispositivo = auth.uid() and t.vence > now() and p.activo
$$;

-- Rol con el que se trabaja: el de la persona del turno. Sin cabeceras HTTP (avisos en vivo,
-- tareas internas de la base de datos) vale el rol del dispositivo.
create or replace function public.rol_actual() returns text
language plpgsql stable security definer set search_path = public as $$
declare
  v_cabeceras text := current_setting('request.headers', true);
begin
  if rol_dispositivo() is null then
    return null;
  end if;
  if v_cabeceras is null or v_cabeceras = '' then
    return rol_dispositivo();
  end if;
  return (select p.rol from personas p where p.id = persona_actual());
end $$;

create or replace function public.exigir_rol(variadic permitidos text[]) returns void
language plpgsql stable security definer set search_path = public as $$
begin
  if coalesce(rol_actual(), '') <> all (permitidos) then
    raise exception 'No tienes permiso para esta acción' using errcode = '42501';
  end if;
end $$;

-- ¿Hay al menos una clave de autorización? (si no, no se pide nunca)
create or replace function public.hay_claves() returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from personas where activo and rol = 'admin')
$$;

-- Nombre de quien autoriza con esa clave (null si no es válida). Uso interno.
create or replace function public.quien_autoriza(p_clave text) returns text
language sql stable security definer set search_path = public, extensions as $$
  select nombre from personas
  where activo and rol = 'admin' and coalesce(p_clave, '') <> ''
    and clave_hash = extensions.crypt(p_clave, clave_hash)
  limit 1
$$;

-- Exige una clave válida si hay claves; devuelve quién autorizó (o null si no se usan claves). Uso interno.
create or replace function public.exigir_clave(p_clave text) returns text
language plpgsql security definer set search_path = public as $$
declare
  v_quien text;
begin
  if not hay_claves() then
    return null;
  end if;
  v_quien := quien_autoriza(p_clave);
  if v_quien is null then
    perform pg_sleep(0.5); -- frena a quien pruebe claves al azar
    raise exception 'Clave de autorización incorrecta' using errcode = '42501';
  end if;
  return v_quien;
end $$;

-- Para la pantalla: revisa una clave antes de borrar algo.
create or replace function public.verificar_clave(p_clave text) returns boolean
language plpgsql security definer set search_path = public as $$
begin
  perform exigir_rol('admin', 'cajero', 'mesero', 'cocina', 'domiciliario');
  perform exigir_clave(p_clave);
  return true;
end $$;

-- Pone, cambia o quita (clave vacía) la clave de un usuario. El administrador la de cualquiera;
-- cada uno la suya. Solo números, de 4 a 8.
create or replace function public.poner_clave(p_usuario uuid, p_clave text) returns void
language plpgsql security definer set search_path = public, extensions as $$
begin
  if p_usuario is distinct from auth.uid() then
    perform exigir_rol('admin');
  end if;
  if coalesce(trim(p_clave), '') = '' then
    update miembros set clave_hash = null where user_id = p_usuario;
    return;
  end if;
  if trim(p_clave) !~ '^[0-9]{4,8}$' then
    raise exception 'La clave debe tener de 4 a 8 números';
  end if;
  update miembros set clave_hash = extensions.crypt(trim(p_clave), extensions.gen_salt('bf')) where user_id = p_usuario;
  if not found then
    raise exception 'Ese usuario no tiene acceso al sistema';
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

-- ¿Ya hay personas creadas? (si no, el administrador crea la suya al entrar por primera vez)
create or replace function public.hay_personas() returns boolean
language plpgsql security definer set search_path = public as $$
begin
  if rol_dispositivo() is null then
    raise exception 'Este dispositivo no tiene acceso' using errcode = '42501';
  end if;
  return exists (select 1 from personas where activo);
end $$;

-- Revisa una clave (4 a 8 números) y que ninguna otra persona activa tenga la misma. Uso interno.
create or replace function public.validar_clave_persona(p_clave text, p_excepto uuid) returns void
language plpgsql security definer set search_path = public, extensions as $$
begin
  if coalesce(trim(p_clave), '') !~ '^[0-9]{4,8}$' then
    raise exception 'La clave debe tener de 4 a 8 números';
  end if;
  if exists (select 1 from personas where activo and id is distinct from p_excepto
             and clave_hash = extensions.crypt(trim(p_clave), clave_hash)) then
    raise exception 'Esa clave ya la tiene otra persona: elige otra';
  end if;
end $$;

-- Primera vez: el administrador del dispositivo crea su persona (nombre y clave).
create or replace function public.crear_primera_persona(p_nombre text, p_clave text) returns void
language plpgsql security definer set search_path = public, extensions as $$
begin
  if rol_dispositivo() <> 'admin' or rol_dispositivo() is null then
    raise exception 'Solo el administrador puede hacer esto' using errcode = '42501';
  end if;
  if exists (select 1 from personas where activo) then
    raise exception 'Ya hay personas creadas: entra con tu clave';
  end if;
  perform validar_clave_persona(p_clave, null);
  insert into personas (nombre, rol, clave_hash)
  values (coalesce(nullif(trim(p_nombre), ''), 'Administrador'), 'admin', extensions.crypt(trim(p_clave), extensions.gen_salt('bf')));
end $$;

-- Entrar con la clave: abre un turno hasta las 3:00 a. m. y devuelve la persona y su token.
create or replace function public.iniciar_turno(p_clave text) returns jsonb
language plpgsql security definer set search_path = public, extensions as $$
declare
  v_persona personas;
  v_token uuid;
begin
  if rol_dispositivo() is null then
    raise exception 'Este dispositivo no tiene acceso' using errcode = '42501';
  end if;
  delete from turnos where vence < now();
  select * into v_persona from personas
  where activo and coalesce(p_clave, '') <> '' and clave_hash = extensions.crypt(trim(p_clave), clave_hash)
  limit 1;
  if not found then
    perform pg_sleep(0.5); -- frena a quien pruebe claves al azar
    raise exception 'Clave incorrecta' using errcode = '42501';
  end if;
  insert into turnos (persona_id, vence) values (v_persona.id, corte_del_dia() + interval '1 day')
  returning token into v_token;
  return jsonb_build_object('token', v_token, 'id', v_persona.id, 'nombre', v_persona.nombre, 'rol', v_persona.rol);
end $$;

-- La persona del turno actual (o null si venció o no hay).
create or replace function public.turno_actual() returns jsonb
language sql stable security definer set search_path = public as $$
  select jsonb_build_object('id', p.id, 'nombre', p.nombre, 'rol', p.rol)
  from personas p where p.id = persona_actual()
$$;

-- Cambiar de cuenta: se cierra el turno de este dispositivo.
create or replace function public.terminar_turno() returns void
language sql security definer set search_path = public as $$
  delete from turnos where token = turno_token() and dispositivo = auth.uid()
$$;

-- Personas del equipo (para elegir domiciliario, ver nombres en las cajas, etc.).
create or replace function public.lista_personas() returns table (id uuid, nombre text, rol text, activo boolean)
language sql stable security definer set search_path = public as $$
  select p.id, p.nombre, p.rol, p.activo from personas p
  where rol_actual() is not null
  order by p.activo desc, p.nombre
$$;

-- El administrador crea o edita una persona: rol, nombre y clave (la clave se puede dejar igual
-- al editar). No se puede dejar el sistema sin ningún administrador activo.
create or replace function public.guardar_persona(p_id uuid, p_nombre text, p_rol text, p_clave text, p_activo boolean)
returns uuid
language plpgsql security definer set search_path = public, extensions as $$
declare
  v_id uuid := p_id;
begin
  perform exigir_rol('admin');
  if coalesce(trim(p_nombre), '') = '' then
    raise exception 'Escribe el nombre';
  end if;
  if p_rol not in ('admin', 'cajero', 'mesero', 'cocina', 'domiciliario') then
    raise exception 'Elige el rol';
  end if;
  if v_id is null and coalesce(trim(p_clave), '') = '' then
    raise exception 'Escribe la clave';
  end if;
  if coalesce(trim(p_clave), '') <> '' then
    perform validar_clave_persona(p_clave, v_id);
  end if;
  if v_id is null then
    insert into personas (nombre, rol, clave_hash, activo)
    values (trim(p_nombre), p_rol, extensions.crypt(trim(p_clave), extensions.gen_salt('bf')), coalesce(p_activo, true))
    returning id into v_id;
  else
    update personas set nombre = trim(p_nombre), rol = p_rol, activo = coalesce(p_activo, activo),
      clave_hash = case when coalesce(trim(p_clave), '') <> '' then extensions.crypt(trim(p_clave), extensions.gen_salt('bf')) else clave_hash end
    where id = v_id;
    if not found then
      raise exception 'Esa persona no existe';
    end if;
  end if;
  if not exists (select 1 from personas where activo and rol = 'admin') then
    raise exception 'Debe quedar al menos un administrador activo';
  end if;
  -- Si se desactiva o cambia de clave, sus turnos abiertos se cierran.
  if not coalesce(p_activo, true) or coalesce(trim(p_clave), '') <> '' then
    delete from turnos where persona_id = v_id and token is distinct from turno_token();
  end if;
  return v_id;
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

-- Los domicilios tienen su propia numeración, aparte del número de la venta, y vuelve a empezar
-- en #1 cada día: a las 3:00 a. m. o con el cierre del día del administrador.
alter table public.pedidos add column if not exists numero_domicilio bigint;
drop sequence if exists public.numero_domicilio_seq;
-- Solo la primera vez (domicilios viejos sin número): se numeran por día.
with por_dia as (
  select id, row_number() over (
    partition by (creado at time zone 'America/Bogota')::date order by creado, numero
  ) as n
  from public.pedidos where tipo = 'domicilio'
)
update public.pedidos p set numero_domicilio = d.n
from por_dia d where p.id = d.id and p.numero_domicilio is null;

-- Cada domicilio nuevo recibe su número del día al guardarse, venga de donde venga.
create or replace function public.asignar_numero_domicilio() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if new.tipo = 'domicilio' then
    -- Uno a la vez, para que dos cajas no tomen el mismo número.
    perform pg_advisory_xact_lock(hashtext('numero_domicilio'));
    select coalesce(max(numero_domicilio), 0) + 1 into new.numero_domicilio
    from pedidos
    where tipo = 'domicilio' and creado >= inicio_periodo();
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

-- Mesas creadas al momento con «Crear mesa»: se borran solas al cobrar (o anular) su cuenta.
alter table public.mesas add column if not exists temporal boolean not null default false;
-- Nombre de la mesa guardado en la cuenta al cerrarla (la mesa puede borrarse o cambiar de nombre).
alter table public.pedidos add column if not exists mesa_nombre text;
update public.pedidos p set mesa_nombre = m.nombre
from public.mesas m where p.mesa_id = m.id and p.mesa_nombre is null and p.estado <> 'abierto';

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
  select persona_actual()
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
  with check (rol_actual() in ('admin', 'cajero') and usuario = persona_actual());
drop policy if exists "admin borra" on public.gastos;
create policy "admin borra" on public.gastos for delete to authenticated using (rol_actual() = 'admin');

-- Nombres del equipo, para elegir domiciliario sin ver salarios ni documentos.
create or replace function public.lista_equipo() returns table (id uuid, nombre text, cargo text)
language sql stable security definer set search_path = public as $$
  select p.id, p.nombre, p.rol from personas p
  where p.activo and rol_actual() is not null
  order by p.nombre
$$;

-- Operación del servicio ---------------------------------------------------------

create or replace function public.abrir_mesa(p_mesa uuid) returns uuid
language plpgsql security definer set search_path = public as $$
declare
  v_id uuid;
begin
  perform exigir_rol('admin', 'cajero', 'mesero', 'domiciliario');
  perform exigir_caja();
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

-- Crea una mesa al momento (temporal) y le abre la cuenta. Devuelve el id de la cuenta.
create or replace function public.crear_mesa(p_nombre text) returns uuid
language plpgsql security definer set search_path = public as $$
declare
  v_mesa uuid;
  v_id uuid;
begin
  perform exigir_rol('admin', 'cajero', 'mesero', 'domiciliario');
  perform exigir_caja();
  if coalesce(trim(p_nombre), '') = '' then
    raise exception 'Escribe el nombre de la mesa';
  end if;
  insert into mesas (nombre, orden, temporal)
  values (trim(p_nombre), coalesce((select max(orden) from mesas), 0) + 1, true)
  returning id into v_mesa;
  insert into pedidos (tipo, mesa_id) values ('mesa', v_mesa) returning id into v_id;
  return v_id;
end $$;

-- Al cerrar o anular una cuenta de mesa se guarda el nombre de la mesa en la cuenta y, si la
-- mesa era temporal, se borra. Uso interno.
create or replace function public.soltar_mesa(p_pedido uuid) returns void
language plpgsql security definer set search_path = public as $$
declare
  v_mesa uuid;
begin
  select mesa_id into v_mesa from pedidos where id = p_pedido;
  if v_mesa is null then
    return;
  end if;
  update pedidos set mesa_nombre = (select nombre from mesas where id = v_mesa) where id = p_pedido;
  delete from mesas where id = v_mesa and temporal
    and not exists (select 1 from pedidos where mesa_id = v_mesa and estado = 'abierto' and id <> p_pedido);
end $$;

create or replace function public.crear_domicilio(
  p_cliente text, p_telefono text, p_direccion text, p_envio integer, p_domiciliario uuid, p_notas text
) returns uuid
language plpgsql security definer set search_path = public as $$
declare
  v_id uuid;
begin
  perform exigir_rol('admin', 'cajero');
  perform exigir_caja();
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
      || coalesce((select nombre from personas where id = persona_actual()), '') || ': ' || trim(p_texto))
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
  perform exigir_caja();
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

  -- Si ya está el mismo plato (mismas opciones y nota) sin enviar a cocina, se suma a esa línea:
  -- 5 toques a «Mazorcada especial» quedan como «5× Mazorcada especial».
  update pedido_items set cantidad = cantidad + p_cantidad
  where pedido_id = p_pedido and plato_id = p_plato and estado = 'nuevo' and pago_id is null
    and precio = v_plato.precio + v_extra and opciones = v_opciones and nota = coalesce(trim(p_nota), '');
  if not found then
    insert into pedido_items (pedido_id, plato_id, nombre, precio, cantidad, opciones, nota)
    values (p_pedido, p_plato, v_plato.nombre, v_plato.precio + v_extra, p_cantidad, v_opciones, coalesce(trim(p_nota), ''));
  end if;
end $$;

-- Lo que no se ha enviado a cocina lo quita cualquiera. Lo ya enviado: con clave de autorización
-- (si hay claves) o, si no se usan claves, solo caja o administrador.
drop function if exists public.quitar_item(uuid);
create or replace function public.quitar_item(p_item uuid, p_clave text default null) returns void
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
    if hay_claves() then
      perform exigir_clave(p_clave);
    else
      perform exigir_rol('admin', 'cajero');
    end if;
  end if;
  delete from pedido_items where id = p_item;
end $$;

-- Cambia la cantidad de un plato que todavía no se ha enviado a cocina (0 = quitarlo).
create or replace function public.cambiar_cantidad(p_item uuid, p_cantidad integer) returns void
language plpgsql security definer set search_path = public as $$
declare
  v_pedido uuid;
begin
  perform exigir_rol('admin', 'cajero', 'mesero', 'domiciliario');
  select i.pedido_id into v_pedido from pedido_items i join pedidos p on p.id = i.pedido_id
  where i.id = p_item and p.estado = 'abierto' and i.estado = 'nuevo' and i.pago_id is null;
  if not found then
    raise exception 'Solo se cambia la cantidad de lo que no se ha enviado a cocina';
  end if;
  perform solo_mesas_si_domiciliario(v_pedido);
  if p_cantidad is null or p_cantidad < 0 or p_cantidad > 999 then
    raise exception 'La cantidad debe ser de 0 a 999';
  end if;
  if p_cantidad = 0 then
    delete from pedido_items where id = p_item;
  else
    update pedido_items set cantidad = p_cantidad where id = p_item;
  end if;
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
  perform soltar_mesa(p_pedido);
  return v_total;
end $$;

-- Cobra una parte de la cuenta: los platos (y cuántos de cada uno) que paga una persona, con su
-- método de pago. p_items = [{"id": plato de la cuenta, "cantidad": n}]. Si de un plato se paga
-- solo una parte (1 de 2 gourmet), se separa en dos líneas. El envío va en el pago que cierra la
-- cuenta. Cuando ya no queda nada por pagar, la cuenta se cierra sola.
create or replace function public.cobrar_parte(p_pedido uuid, p_items jsonb, p_metodo text) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_caja uuid;
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
  v_caja := exigir_mi_caja();
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

  insert into pagos (pedido_id, metodo, valor, caja_id) values (p_pedido, p_metodo, v_valor, v_caja) returning id into v_pago;
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
  v_caja uuid;
  v_pedido pedidos;
  v_resta integer;
  v_pago uuid;
begin
  perform exigir_rol('admin', 'cajero');
  v_caja := exigir_mi_caja();
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
  insert into pagos (pedido_id, metodo, valor, caja_id) values (p_pedido, p_metodo, p_valor, v_caja) returning id into v_pago;
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
-- Con claves: la caja o el administrador, con clave de autorización. Sin claves: solo el administrador.
drop function if exists public.anular(uuid, text);
create or replace function public.anular(p_pedido uuid, p_motivo text, p_clave text default null) returns void
language plpgsql security definer set search_path = public as $$
declare
  v_pedido pedidos;
  v_mov record;
  v_quien text;
begin
  if hay_claves() then
    perform exigir_rol('admin', 'cajero');
    v_quien := exigir_clave(p_clave);
  else
    perform exigir_rol('admin');
  end if;
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
    motivo_anulacion = concat_ws(' · ', nullif(trim(coalesce(p_motivo, '')), ''), 'autorizó ' || v_quien)
  where id = p_pedido;
  perform soltar_mesa(p_pedido);
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

-- Apertura y cierre de caja: cada persona que cobra (administrador o cajero) tiene su propia caja,
-- con su base, sus pagos y sus gastos. Puede haber varias abiertas, pero una sola por persona.
-- Se guarda con cuánto se abrió y cuánto se contó al cerrar, con el detalle por billete y moneda.
create table if not exists public.cajas (
  id uuid primary key default gen_random_uuid(),
  abierta_en timestamptz not null default now(),
  abierta_por uuid default auth.uid(),
  base integer not null default 0 check (base >= 0),
  conteo_apertura jsonb not null default '{}',
  cerrada_en timestamptz,
  cerrada_por uuid,
  contado integer check (contado is null or contado >= 0),
  conteo_cierre jsonb,
  esperado integer,
  resumen jsonb
);
drop index if exists public.una_caja_abierta;
create unique index if not exists una_caja_abierta_por_persona on public.cajas (abierta_por) where cerrada_en is null;
alter table public.cajas enable row level security;
revoke all on public.cajas from anon;
grant select on public.cajas to authenticated;
grant all on public.cajas to service_role;
-- El administrador ve todas las cajas; el cajero, solo las suyas.
drop policy if exists "caja lee" on public.cajas;
create policy "caja lee" on public.cajas for select to authenticated
  using (rol_actual() = 'admin' or (rol_actual() = 'cajero' and abierta_por = persona_actual()));

-- Cada pago y cada gasto quedan en la caja de quien los registró.
alter table public.pagos add column if not exists caja_id uuid references public.cajas (id) on delete set null;
alter table public.gastos add column if not exists caja_id uuid references public.cajas (id) on delete set null;
create index if not exists pagos_por_caja on public.pagos (caja_id);
create index if not exists gastos_por_caja on public.gastos (caja_id);

-- Código de caja de cada persona (lo asigna el administrador en Ajustes). Es obligatorio para
-- abrir y cerrar su caja. Se guarda cifrado. Es distinto de la clave de autorización.
alter table public.miembros add column if not exists codigo_caja_hash text;

-- El día del restaurante empieza a las 3:00 a. m. (hora de Colombia): devuelve el último corte.
create or replace function public.corte_del_dia() returns timestamptz
language sql stable set search_path = public as $$
  select (date_trunc('day', (now() at time zone 'America/Bogota') - interval '3 hours') + interval '3 hours')
         at time zone 'America/Bogota'
$$;

-- Una caja que sigue abierta a las 3:00 a. m. se cierra sola (sin conteo). Uso interno.
create or replace function public.cerrar_cajas_vencidas() returns void
language plpgsql security definer set search_path = public as $$
begin
  update cajas set cerrada_en = corte_del_dia(), resumen = jsonb_build_object('automatico', true)
  where cerrada_en is null and abierta_en < corte_del_dia();
end $$;

-- Cuentas vacías: al tocar una mesa libre se abre su cuenta aunque no se pida nada. Las que
-- llevan más de 30 minutos abiertas sin ningún plato se borran (y la mesa temporal, si era una).
-- Uso interno.
create or replace function public.limpiar_cuentas_vacias() returns void
language plpgsql security definer set search_path = public as $$
begin
  with borradas as (
    delete from pedidos p
    where p.estado = 'abierto' and p.creado < now() - interval '30 minutes'
      and not exists (select 1 from pedido_items i where i.pedido_id = p.id)
      and not exists (select 1 from pagos x where x.pedido_id = p.id)
    returning p.mesa_id
  )
  delete from mesas m where m.temporal and m.id in (select mesa_id from borradas)
    and not exists (select 1 from pedidos o where o.mesa_id = m.id and o.estado = 'abierto');
end $$;

-- ¿Hay alguna caja abierta? (cualquiera del equipo puede preguntarlo; cierra antes las vencidas)
create or replace function public.hay_caja_abierta() returns boolean
language plpgsql security definer set search_path = public as $$
begin
  perform exigir_rol('admin', 'cajero', 'mesero', 'cocina', 'domiciliario');
  perform cerrar_cajas_vencidas();
  perform limpiar_cuentas_vacias();
  return exists (select 1 from cajas where cerrada_en is null);
end $$;

-- La caja abierta de quien pregunta (o null).
create or replace function public.mi_caja() returns jsonb
language plpgsql security definer set search_path = public as $$
begin
  perform exigir_rol('admin', 'cajero', 'mesero', 'cocina', 'domiciliario');
  perform cerrar_cajas_vencidas();
  perform limpiar_cuentas_vacias();
  return (select to_jsonb(c) from cajas c where abierta_por = persona_actual() and cerrada_en is null);
end $$;

-- ¿Quien pregunta tiene código de caja? (para saber si se le pide)
create or replace function public.tengo_codigo_caja() returns boolean
language sql stable security definer set search_path = public as $$
  -- Ya no se usa: cada persona entra con su clave, que identifica su caja.
  select true
$$;

-- Sin ninguna caja abierta no se toman pedidos. Uso interno.
create or replace function public.exigir_caja() returns void
language plpgsql security definer set search_path = public as $$
begin
  perform cerrar_cajas_vencidas();
  if not exists (select 1 from cajas where cerrada_en is null) then
    raise exception 'La caja está cerrada. Para usar el sistema, el administrador o el cajero debe abrir su caja.';
  end if;
end $$;

-- Para cobrar hay que tener la caja propia abierta: el pago queda en ella. Uso interno.
create or replace function public.exigir_mi_caja() returns uuid
language plpgsql security definer set search_path = public as $$
declare
  v_caja uuid;
begin
  perform cerrar_cajas_vencidas();
  select id into v_caja from cajas where abierta_por = persona_actual() and cerrada_en is null;
  if v_caja is null then
    raise exception 'Abre tu caja para poder cobrar (Caja del día → Abrir mi caja).';
  end if;
  return v_caja;
end $$;

-- Revisa el código de caja de quien llama. Es obligatorio: sin código asignado no se abre ni se
-- cierra la caja propia. Uso interno.
create or replace function public.revisar_codigo_caja(p_codigo text) returns void
language plpgsql security definer set search_path = public as $$
begin
  -- Ya no se pide: la persona entró con su clave y su caja es la de su turno.
  return;
end $$;

-- Gastos: quedan en la caja abierta de quien los registra.
create or replace function public.gasto_en_mi_caja() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if new.caja_id is null then
    new.caja_id := (select id from cajas where abierta_por = persona_actual() and cerrada_en is null);
  end if;
  return new;
end $$;
drop trigger if exists gasto_en_mi_caja on public.gastos;
create trigger gasto_en_mi_caja before insert on public.gastos
  for each row execute function public.gasto_en_mi_caja();

drop function if exists public.abrir_caja(integer, jsonb);
create or replace function public.abrir_caja(p_base integer, p_conteo jsonb, p_codigo text default null) returns uuid
language plpgsql security definer set search_path = public as $$
declare
  v_id uuid;
begin
  perform exigir_rol('admin', 'cajero');
  perform cerrar_cajas_vencidas();
  perform revisar_codigo_caja(p_codigo);
  if p_base is null or p_base < 0 then
    raise exception 'La base no puede ser negativa';
  end if;
  if exists (select 1 from cajas where abierta_por = persona_actual() and cerrada_en is null) then
    raise exception 'Ya tienes tu caja abierta';
  end if;
  insert into cajas (abierta_por, base, conteo_apertura) values (persona_actual(), p_base, coalesce(p_conteo, '{}')) returning id into v_id;
  return v_id;
end $$;

-- Cierra una caja guardando lo contado y el resumen. Cada uno cierra la suya (con su código);
-- el administrador puede cerrar la de otro (por ejemplo, si se fue sin cerrarla).
drop function if exists public.cerrar_caja(integer, jsonb, integer, jsonb);
create or replace function public.cerrar_caja(
  p_caja uuid, p_contado integer, p_conteo jsonb, p_esperado integer, p_resumen jsonb, p_codigo text default null
) returns void
language plpgsql security definer set search_path = public as $$
declare
  v_caja cajas;
begin
  perform exigir_rol('admin', 'cajero');
  select * into v_caja from cajas where id = p_caja and cerrada_en is null for update;
  if not found then
    raise exception 'Esa caja ya está cerrada';
  end if;
  if v_caja.abierta_por = persona_actual() then
    perform revisar_codigo_caja(p_codigo);
  else
    perform exigir_rol('admin');
  end if;
  update cajas set cerrada_en = now(), cerrada_por = persona_actual(), contado = p_contado,
    conteo_cierre = p_conteo, esperado = p_esperado, resumen = p_resumen
  where id = p_caja;
end $$;

-- El administrador pone, cambia o quita (vacío) el código de caja de alguien. Solo números, 4 a 8.
create or replace function public.poner_codigo_caja(p_usuario uuid, p_codigo text) returns void
language plpgsql security definer set search_path = public, extensions as $$
begin
  perform exigir_rol('admin');
  if coalesce(trim(p_codigo), '') = '' then
    update miembros set codigo_caja_hash = null where user_id = p_usuario;
    return;
  end if;
  if trim(p_codigo) !~ '^[0-9]{4,8}$' then
    raise exception 'El código debe tener de 4 a 8 números';
  end if;
  update miembros set codigo_caja_hash = extensions.crypt(trim(p_codigo), extensions.gen_salt('bf')) where user_id = p_usuario;
  if not found then
    raise exception 'Ese usuario no tiene acceso al sistema';
  end if;
end $$;

-- Cierre del día: lo hace el administrador al final, con su clave. Resume todas las cajas del día
-- (de 3:00 a. m. a 3:00 a. m.) y, si quiere, cierra las cajas que sigan abiertas.
create table if not exists public.cierres_dia (
  id uuid primary key default gen_random_uuid(),
  dia date not null,
  cerrado_en timestamptz not null default now(),
  cerrado_por uuid,
  resumen jsonb not null default '{}'
);
alter table public.cierres_dia enable row level security;
revoke all on public.cierres_dia from anon;
grant select on public.cierres_dia to authenticated;
grant all on public.cierres_dia to service_role;
drop policy if exists "admin lee" on public.cierres_dia;
create policy "admin lee" on public.cierres_dia for select to authenticated using (rol_actual() = 'admin');

-- Desde cuándo cuenta el día actual: lo último entre las 3:00 a. m. y el último cierre del día.
create or replace function public.inicio_periodo() returns timestamptz
language sql stable security definer set search_path = public as $$
  select greatest(corte_del_dia(), coalesce((select max(cerrado_en) from cierres_dia), '-infinity'::timestamptz))
$$;

create or replace function public.cerrar_dia(p_dia date, p_clave text, p_resumen jsonb, p_cerrar_cajas boolean)
returns uuid
language plpgsql security definer set search_path = public as $$
declare
  v_id uuid;
begin
  perform exigir_rol('admin');
  -- La clave tiene que ser la de un administrador.
  if quien_autoriza(p_clave) is null then
    perform pg_sleep(0.5);
    raise exception 'Clave incorrecta' using errcode = '42501';
  end if;
  -- Con el cierre del día se reinicia todo: se cierran todas las cajas que sigan abiertas y la
  -- numeración de domicilios vuelve a #1. Ventas y gastos (las estadísticas) no se tocan.
  update cajas set cerrada_en = now(), cerrada_por = persona_actual(),
    resumen = coalesce(resumen, '{}') || jsonb_build_object('cierre_dia', true)
  where cerrada_en is null;
  insert into cierres_dia (dia, cerrado_por, resumen) values (p_dia, persona_actual(), coalesce(p_resumen, '{}'))
  returning id into v_id;
  return v_id;
end $$;

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
  with check (rol_actual() is not null and creado_por = persona_actual());
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
    left join personas mi on mi.id = p.abierto_por
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
    'abrir_mesa(uuid)', 'crear_mesa(text)', 'crear_domicilio(text, text, text, integer, uuid, text)', 'asignar_domiciliario(uuid, uuid)',
    'mi_empleado()', 'cambiar_entrega(uuid, text)', 'registrar_novedad(uuid, text)', 'registrar_recibido(uuid, integer)',
    'agregar_item(uuid, uuid, integer, uuid[], text)', 'quitar_item(uuid, text)', 'cambiar_cantidad(uuid, integer)', 'enviar_cocina(uuid)',
    'marcar_items(uuid, text, text)', 'entregar_pedido(uuid)', 'cobrar(uuid, text, integer)', 'anular(uuid, text, text)',
    'hay_claves()', 'verificar_clave(text)', 'poner_clave(uuid, text)',
    'cobrar_parte(uuid, jsonb, text)', 'abonar(uuid, integer, text)',
    'abrir_caja(integer, jsonb, text)', 'cerrar_caja(uuid, integer, jsonb, integer, jsonb, text)', 'hay_caja_abierta()',
    'corte_del_dia()', 'mi_caja()', 'tengo_codigo_caja()', 'poner_codigo_caja(uuid, text)', 'cambiar_para_llevar(uuid, boolean)',
    'mover_insumo(uuid, text, numeric, numeric, text)', 'comandas_por_imprimir()', 'impresiones_por_imprimir()',
    'asignar_numero_domicilio()'] loop
    execute format('revoke all on function public.%s from public, anon', f);
    execute format('grant execute on function public.%s to authenticated', f);
  end loop;
end $$;

-- Lo que se registra queda a nombre de la persona del turno.
alter table public.pedidos alter column abierto_por set default public.persona_actual();
alter table public.movimientos alter column usuario set default public.persona_actual();
alter table public.gastos alter column usuario set default public.persona_actual();
alter table public.pagos alter column usuario set default public.persona_actual();
alter table public.cajas alter column abierta_por set default public.persona_actual();
alter table public.impresiones alter column creado_por set default public.persona_actual();

-- El domiciliario de un domicilio es una persona del equipo.
alter table public.pedidos drop constraint if exists pedidos_domiciliario_id_fkey;
update public.pedidos set domiciliario_id = null
where domiciliario_id is not null and domiciliario_id not in (select id from public.personas);
alter table public.pedidos add constraint pedidos_domiciliario_id_fkey
  foreign key (domiciliario_id) references public.personas (id) on delete set null;

do $$
declare
  f text;
begin
  foreach f in array array['rol_dispositivo()', 'turno_token()', 'persona_actual()', 'hay_personas()',
    'crear_primera_persona(text, text)', 'iniciar_turno(text)', 'turno_actual()', 'terminar_turno()',
    'lista_personas()', 'guardar_persona(uuid, text, text, text, boolean)', 'cerrar_dia(date, text, jsonb, boolean)', 'inicio_periodo()'] loop
    execute format('revoke all on function public.%s from public, anon', f);
    execute format('grant execute on function public.%s to authenticated', f);
  end loop;
end $$;
revoke all on function public.validar_clave_persona(text, uuid) from public, anon, authenticated;

-- Funciones de uso interno: nadie las llama directo, solo otras funciones.
revoke all on function public.domicilio_para_mi(uuid) from public, anon, authenticated;
revoke all on function public.solo_mesas_si_domiciliario(uuid) from public, anon, authenticated;
revoke all on function public.cerrar_cuenta(uuid) from public, anon, authenticated;
revoke all on function public.cerrar_cajas_vencidas() from public, anon, authenticated;
revoke all on function public.exigir_caja() from public, anon, authenticated;
revoke all on function public.exigir_mi_caja() from public, anon, authenticated;
revoke all on function public.limpiar_cuentas_vacias() from public, anon, authenticated;
revoke all on function public.revisar_codigo_caja(text) from public, anon, authenticated;
revoke all on function public.quien_autoriza(text) from public, anon, authenticated;
revoke all on function public.exigir_clave(text) from public, anon, authenticated;
revoke all on function public.soltar_mesa(uuid) from public, anon, authenticated;

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
