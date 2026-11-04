-- Ejecutar una vez en Supabase: SQL Editor → New query → pegar → Run.
-- Una fila por usuario con todos sus datos. Cada usuario solo puede ver y cambiar la suya.
create table if not exists public.sistema_datos (
  user_id uuid primary key references auth.users (id) on delete cascade,
  datos jsonb not null,
  version integer not null default 1,
  actualizado timestamptz not null default now()
);

alter table public.sistema_datos enable row level security;

grant select, insert, update on public.sistema_datos to authenticated;

drop policy if exists "leer lo propio" on public.sistema_datos;
create policy "leer lo propio" on public.sistema_datos
  for select to authenticated
  using ((select auth.uid()) = user_id);

drop policy if exists "crear lo propio" on public.sistema_datos;
create policy "crear lo propio" on public.sistema_datos
  for insert to authenticated
  with check ((select auth.uid()) = user_id);

drop policy if exists "cambiar lo propio" on public.sistema_datos;
create policy "cambiar lo propio" on public.sistema_datos
  for update to authenticated
  using ((select auth.uid()) = user_id)
  with check ((select auth.uid()) = user_id);
