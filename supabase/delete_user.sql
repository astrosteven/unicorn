-- Admin-only "reject / delete an access request".
-- Deletes the auth.users row, which CASCADES to public.profiles (user_id references
-- auth.users(id) on delete cascade), so the request disappears entirely and the person
-- would have to register again. SECURITY DEFINER so it can touch auth.users; it first
-- verifies the CALLER is an admin, so a normal user can't delete anyone.
--
-- Run once in the Supabase SQL editor (Dashboard → SQL Editor → paste → Run).
create or replace function public.delete_user(target uuid)
returns void
language plpgsql
security definer
set search_path = public, auth
as $$
begin
  if (select role from public.profiles where user_id = auth.uid()) is distinct from 'admin' then
    raise exception 'not authorized';
  end if;
  delete from auth.users where id = target;   -- cascades to public.profiles
end;
$$;

revoke all on function public.delete_user(uuid) from public, anon;
grant execute on function public.delete_user(uuid) to authenticated;   -- gate is the admin check inside
