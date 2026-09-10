-- Named-object labels (the "＋ Add name" control + By-Name search / ★ badges).
-- Run in Supabase → SQL Editor. SAFE TO RE-RUN (idempotent).
--
-- Fixes: any logged-in user could READ labels but INSERT failed, because the table was
-- missing the base-table INSERT grant + a matching RLS insert policy for `authenticated`
-- (same class of bug as profiles: a GRANT is required BEFORE RLS even runs — without it
-- every write is "42501 permission denied for table" regardless of policies).

-- Table (no-op if it already exists — only the grants/policies below actually matter).
create table if not exists public.object_labels (
  id           bigserial primary key,
  field        text not null,
  obj_id       bigint not null,
  ra           double precision,
  dec          double precision,
  name         text not null,
  reference    text,
  submitted_by text,
  created_at   timestamptz not null default now()
);
alter table public.object_labels enable row level security;

-- READ: labels are public catalog metadata — anyone (anon + logged-in) may read/search them.
drop policy if exists object_labels_read on public.object_labels;
create policy object_labels_read on public.object_labels for select using (true);

-- INSERT: any authenticated (logged-in, approved) user may attach a name. The frontend
-- shows the control to every signed-in user; role tiers are enforced by route access, not here.
drop policy if exists object_labels_insert on public.object_labels;
create policy object_labels_insert on public.object_labels
  for insert to authenticated with check (true);

-- Base-table privileges. WITHOUT these, every read/insert is denied ("42501 permission
-- denied for table object_labels") BEFORE RLS runs. RLS (above) still governs which rows.
grant select on public.object_labels to anon, authenticated;
grant insert on public.object_labels to authenticated;
-- Grant the id sequence only if it exists (no-op for identity/uuid PKs) so this can't abort.
do $$
begin
  if exists (select 1 from pg_class where relkind = 'S' and relname = 'object_labels_id_seq') then
    grant usage, select on sequence public.object_labels_id_seq to authenticated;
  end if;
end $$;
