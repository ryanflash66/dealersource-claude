-- dealersource :: row level security and grants
--
-- Runs after 20260916000000_init.sql. Idempotent, and valid both on hosted
-- Supabase (where anon / authenticated / service_role already exist and this
-- runs as the `postgres` role) and on the Docker stack (where this runs as the
-- postgres superuser from /docker-entrypoint-initdb.d and must create them).
--
-- Access model
--   anon, authenticated  SELECT on reports, sources, sites, parcels, evidence,
--                        cases, scores, runs and on v_shortlist / v_open_cases.
--                        NOTHING on listings, raw_documents, messages, contacts
--                        (they hold email addresses and raw fetched pages).
--   service_role         everything; BYPASSRLS. The pipeline uses this role
--                        (SUPABASE_SERVICE_ROLE_KEY), server side only.

-- ---------------------------------------------------------------------------
-- Roles (hosted Supabase already has all three; Docker does not)
-- ---------------------------------------------------------------------------
do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'anon') then
    create role anon nologin noinherit;
  end if;
  if not exists (select 1 from pg_roles where rolname = 'authenticated') then
    create role authenticated nologin noinherit;
  end if;
  if not exists (select 1 from pg_roles where rolname = 'service_role') then
    create role service_role nologin noinherit bypassrls;
  end if;
end
$$;

-- In the Docker stack PostgREST connects as the postgres superuser and does
-- `set local role <anon|service_role>` per request; a superuser may assume any
-- role, so no membership grants are needed. Hosted Supabase wires its own
-- `authenticator` role.

-- ---------------------------------------------------------------------------
-- Enable RLS on every table
-- ---------------------------------------------------------------------------
alter table public.reports        enable row level security;
alter table public.sources        enable row level security;
alter table public.raw_documents  enable row level security;
alter table public.listings       enable row level security;
alter table public.sites          enable row level security;
alter table public.parcels        enable row level security;
alter table public.evidence       enable row level security;
alter table public.cases          enable row level security;
alter table public.messages       enable row level security;
alter table public.contacts       enable row level security;
alter table public.scores         enable row level security;
alter table public.runs           enable row level security;

-- ---------------------------------------------------------------------------
-- Grants
-- ---------------------------------------------------------------------------
grant usage on schema public to anon, authenticated, service_role;

-- Dashboard-readable tables and views.
grant select on
  public.reports,
  public.sources,
  public.sites,
  public.parcels,
  public.evidence,
  public.cases,
  public.scores,
  public.runs
to anon, authenticated;

grant select on public.v_shortlist, public.v_open_cases to anon, authenticated;

-- Make sure nothing leaks to the dashboard roles on the sensitive tables even
-- if a default privilege was set elsewhere.
revoke all on public.listings, public.raw_documents, public.messages, public.contacts
  from anon, authenticated;

-- Pipeline role: full access (RLS is bypassed via BYPASSRLS).
grant all on all tables    in schema public to service_role;
grant all on all sequences in schema public to service_role;
grant all on all routines  in schema public to service_role;
alter default privileges in schema public grant all on tables    to service_role;
alter default privileges in schema public grant all on sequences to service_role;
alter default privileges in schema public grant all on routines  to service_role;

-- ---------------------------------------------------------------------------
-- Policies: read-only for the dashboard roles on the allowed tables.
-- No policy at all on listings / raw_documents / messages / contacts, so with
-- RLS enabled those tables return nothing to anon/authenticated even if a
-- grant were ever added by mistake.
-- ---------------------------------------------------------------------------
drop policy if exists "dashboard read reports" on public.reports;
create policy "dashboard read reports" on public.reports
  for select to anon, authenticated using (true);

drop policy if exists "dashboard read sources" on public.sources;
create policy "dashboard read sources" on public.sources
  for select to anon, authenticated using (true);

drop policy if exists "dashboard read sites" on public.sites;
create policy "dashboard read sites" on public.sites
  for select to anon, authenticated using (true);

drop policy if exists "dashboard read parcels" on public.parcels;
create policy "dashboard read parcels" on public.parcels
  for select to anon, authenticated using (true);

drop policy if exists "dashboard read evidence" on public.evidence;
create policy "dashboard read evidence" on public.evidence
  for select to anon, authenticated using (true);

drop policy if exists "dashboard read cases" on public.cases;
create policy "dashboard read cases" on public.cases
  for select to anon, authenticated using (true);

drop policy if exists "dashboard read scores" on public.scores;
create policy "dashboard read scores" on public.scores
  for select to anon, authenticated using (true);

drop policy if exists "dashboard read runs" on public.runs;
create policy "dashboard read runs" on public.runs
  for select to anon, authenticated using (true);

-- PostgREST caches the schema; on the Docker stack this notify is harmless on
-- first init (no listener yet) and useful when re-applied to a running stack.
notify pgrst, 'reload schema';
