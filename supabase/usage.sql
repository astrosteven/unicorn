-- Lightweight per-user activity tracking for the admin dashboard.
-- Run once in the Supabase SQL editor (Dashboard → SQL Editor → paste → Run).

-- 1) usage_events: one row per tracked action (search, download, …). user_id defaults to the
--    caller so the client just inserts {event, meta}; RLS lets a user write only their own rows,
--    and the table is NOT client-readable (admins read via the SECURITY DEFINER RPC below).
create table if not exists public.usage_events (
  id         bigint generated always as identity primary key,
  user_id    uuid not null default auth.uid() references auth.users(id) on delete cascade,
  event      text not null,
  meta       jsonb,
  created_at timestamptz not null default now()
);
create index if not exists usage_events_user_idx    on public.usage_events (user_id);
create index if not exists usage_events_created_idx on public.usage_events (created_at);

alter table public.usage_events enable row level security;
drop policy if exists usage_insert_self on public.usage_events;
create policy usage_insert_self on public.usage_events
  for insert with check (user_id = auth.uid());
-- (no select policy: clients can't read the table; the admin RPC serves aggregates)

-- 2) admin_user_activity: per-user rollup for /data/admin. SECURITY DEFINER to read auth.users +
--    all events; returns nothing unless the caller is an admin (soft guard via the WHERE clause).
create or replace function public.admin_user_activity()
returns table (
  user_id uuid, email text, role text, justification text,
  created_at timestamptz, last_sign_in_at timestamptz,
  n_events bigint, last_event_at timestamptz, n_inspections bigint
)
language sql
security definer
set search_path = public, auth
as $$
  select p.user_id, p.email, p.role, p.justification,
         p.created_at, u.last_sign_in_at,
         coalesce(e.n, 0), e.last_at, coalesce(i.n, 0)
  from public.profiles p
  left join auth.users u on u.id = p.user_id
  left join (
    select user_id, count(*) n, max(created_at) last_at
    from public.usage_events group by user_id
  ) e on e.user_id = p.user_id
  left join (
    select inspector, count(*) n
    from public.inspections group by inspector
  ) i on i.inspector = p.email
  where (select role from public.profiles where user_id = auth.uid()) = 'admin';
$$;
revoke all on function public.admin_user_activity() from public, anon;
grant execute on function public.admin_user_activity() to authenticated;

-- 3) admin_daily_activity: per-DAY rollup for the admin dashboard — site visits, searches,
--    downloads, and distinct active users over the last `days` days. Admin-guarded like above.
--    (Run this block once too; it's additive to the two objects above.)
create or replace function public.admin_daily_activity(days int default 30)
returns table (
  day date, n_visits bigint, n_searches bigint, n_downloads bigint, n_active_users bigint
)
language sql
security definer
set search_path = public, auth
as $$
  select date_trunc('day', created_at)::date as day,
         count(*) filter (where event = 'visit')    as n_visits,
         count(*) filter (where event = 'search')   as n_searches,
         count(*) filter (where event = 'download') as n_downloads,
         count(distinct user_id)                    as n_active_users
  from public.usage_events
  where created_at >= (now() - make_interval(days => days))
    and (select role from public.profiles where user_id = auth.uid()) = 'admin'
  group by 1
  order by 1 desc;
$$;
revoke all on function public.admin_daily_activity(int) from public, anon;
grant execute on function public.admin_daily_activity(int) to authenticated;
