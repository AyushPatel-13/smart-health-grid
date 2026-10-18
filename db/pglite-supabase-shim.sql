-- Supabase compatibility shim for the embedded demo database (PGlite).
-- Supabase already provides everything in this file; it is applied ONLY in
-- demo mode so the same migrations and Row Level Security policies run
-- unchanged against both backends.

create schema if not exists auth;

create table if not exists auth.users (
  id uuid primary key,
  email text unique not null,
  -- scrypt hash used only by the demo sign-in flow (Supabase manages its own)
  encrypted_password text,
  raw_user_meta_data jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

-- Mirrors Supabase's auth.uid(): reads the JWT claims set per transaction.
create or replace function auth.uid() returns uuid
language sql stable as $$
  select nullif(
    coalesce(
      nullif(current_setting('request.jwt.claim.sub', true), ''),
      nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub'
    ), ''
  )::uuid
$$;

do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'authenticated') then
    create role authenticated nologin;
  end if;
  if not exists (select 1 from pg_roles where rolname = 'anon') then
    create role anon nologin;
  end if;
  if not exists (select 1 from pg_roles where rolname = 'service_role') then
    create role service_role nologin bypassrls;
  end if;
end $$;

grant usage on schema auth to authenticated, anon, service_role;
grant usage on schema public to authenticated, anon, service_role;
