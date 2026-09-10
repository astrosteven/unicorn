-- UNICORN accounts + roles. Run in Supabase → SQL Editor. SAFE TO RE-RUN (idempotent).
-- Tiers:  public (no login) → Fields only · pending (registered, awaiting approval)
--         general (approved) → query/explore/downloads · key → everything · admin → + approve users.

create table if not exists public.profiles (
  user_id uuid primary key references auth.users(id) on delete cascade,
  email text,
  role text not null default 'pending',        -- pending | general | key | admin
  justification text,                           -- why they want access (registration form)
  created_at timestamptz not null default now()
);
-- Bring an older/partial profiles table up to spec (no-ops if already correct):
alter table public.profiles add column if not exists justification text;
alter table public.profiles add column if not exists email text;
alter table public.profiles alter column role set default 'pending';
alter table public.profiles enable row level security;

-- A user reads/inserts their OWN profile (the registration form inserts role=pending + justification).
drop policy if exists profiles_read_self   on public.profiles;
create policy profiles_read_self   on public.profiles for select using (user_id = auth.uid());
drop policy if exists profiles_insert_self on public.profiles;
create policy profiles_insert_self on public.profiles for insert to authenticated with check (user_id = auth.uid());

-- is_admin(): SECURITY DEFINER so it bypasses RLS (avoids a recursive policy on profiles).
create or replace function public.is_admin() returns boolean
  language sql security definer stable set search_path = public as $$
  select exists (select 1 from public.profiles where user_id = auth.uid() and role in ('admin'));
$$;

-- Admins can read every profile (for the admin page's pending list).
drop policy if exists profiles_read_admin on public.profiles;
create policy profiles_read_admin on public.profiles for select using (public.is_admin());

-- approve_user(): the admin page calls this to set someone's role. Admin-only, validated.
create or replace function public.approve_user(target uuid, new_role text) returns void
  language plpgsql security definer set search_path = public as $$
begin
  if not public.is_admin() then raise exception 'not authorized'; end if;
  if new_role not in ('pending','general','key','admin') then raise exception 'invalid role %', new_role; end if;
  update public.profiles set role = new_role where user_id = target;
end;
$$;
-- Base table privileges for the authenticated role. WITHOUT this, every authenticated
-- read/insert is denied ("42501 permission denied for table profiles") BEFORE RLS even
-- runs, so the client can't read anyone's role. RLS (above) still restricts which rows.
grant select, insert on public.profiles to authenticated;
grant execute on function public.is_admin() to authenticated;
grant execute on function public.approve_user(uuid, text) to authenticated;

-- Seed yourself as admin from your existing auth account (run AFTER the block above):
--   insert into public.profiles (user_id, email, role)
--   select id, email, 'admin' from auth.users where email = 'slfinkel@gmail.com'
--   on conflict (user_id) do update set role = 'admin';
