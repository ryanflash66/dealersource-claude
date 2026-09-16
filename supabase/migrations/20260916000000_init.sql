-- dealersource :: initial schema
--
-- Column names and types mirror src/core/types.ts 1:1 (snake_case, same
-- spelling). The pipeline talks to these tables through PostgREST:
--   GET    /<table>?col=eq.v&select=*
--   POST   /<table>?on_conflict=id      Prefer: resolution=merge-duplicates
--   DELETE /<table>?id=in.(...)
-- so every table has `id text primary key`, nested objects/arrays are jsonb,
-- ISO timestamps are timestamptz, and TypeScript unions are text + CHECK.
--
-- Extra columns that the TypeScript rows do NOT carry are limited to the two
-- trigger-maintained PostGIS columns (sites.geom, parcels.geom). PostgREST
-- returns them on select=*, which the TS side tolerates as extra keys.
--
-- Works on: hosted Supabase (SQL editor / `supabase db push`), the Supabase
-- CLI local stack, and the Docker postgis+postgrest stack (docker-compose.yml),
-- where this file runs as the postgres superuser from /docker-entrypoint-initdb.d.

-- Hosted Supabase installs PostGIS into the `extensions` schema and puts that
-- schema on the search_path, so an unqualified `create extension` is a no-op
-- there. In the Docker image this installs into `public`. Either way the
-- geometry type and ST_* functions below resolve unqualified.
create extension if not exists postgis;

-- ---------------------------------------------------------------------------
-- sources
-- ---------------------------------------------------------------------------
create table if not exists public.sources (
  id            text primary key,
  kind          text        not null,
  url           text        not null,
  robots_txt    text        not null,
  terms_status  text        not null,
  enabled       boolean     not null default true,
  cadence       text        not null,
  fixture_only  boolean     not null default false,
  notes         text,
  last_run_at   timestamptz,
  last_status   text,
  last_error    text,
  constraint sources_kind_check         check (kind in ('crawl', 'reddit', 'rss', 'manual')),
  constraint sources_robots_txt_check   check (robots_txt in ('allowed', 'disallowed', 'unknown')),
  constraint sources_terms_status_check check (terms_status in ('allowed', 'prohibited', 'unclear')),
  constraint sources_last_status_check  check (last_status is null or last_status in ('ok', 'refused', 'error', 'skipped'))
);

-- ---------------------------------------------------------------------------
-- raw_documents  (raw fetched pages; never exposed to anon)
-- ---------------------------------------------------------------------------
create table if not exists public.raw_documents (
  id            text primary key,          -- sha256(source_id + url + body)
  source_id     text        not null,
  url           text        not null,
  fetched_at    timestamptz not null,
  content_type  text        not null,
  body          text        not null,
  sha256        text        not null,
  run_id        text        not null
);

create index if not exists raw_documents_source_id_idx on public.raw_documents (source_id);
create index if not exists raw_documents_run_id_idx    on public.raw_documents (run_id);

-- ---------------------------------------------------------------------------
-- listings  (extraction may contain contact emails; never exposed to anon)
-- ---------------------------------------------------------------------------
create table if not exists public.listings (
  id               text primary key,
  source_id        text        not null,
  raw_document_id  text        not null,
  url              text        not null,
  title            text,
  address_text     text,
  address_key      text,
  fetched_at       timestamptz not null,
  extraction       jsonb       not null,   -- ListingExtraction
  site_id          text,
  status           text        not null,
  status_detail    text,
  first_seen_at    timestamptz not null,
  last_seen_at     timestamptz not null,
  run_id           text        not null,
  constraint listings_status_check check (status in ('new', 'resolved', 'refused', 'unresolved'))
);

create index if not exists listings_site_id_idx         on public.listings (site_id);
create index if not exists listings_source_id_idx       on public.listings (source_id);
create index if not exists listings_raw_document_id_idx on public.listings (raw_document_id);
create index if not exists listings_address_key_idx     on public.listings (address_key);

-- ---------------------------------------------------------------------------
-- sites
-- ---------------------------------------------------------------------------
create table if not exists public.sites (
  id                 text primary key,     -- site_<parcel_id>
  parcel_id          text        not null,
  canonical_address  text        not null,
  lat                double precision not null,
  lon                double precision not null,
  jurisdiction       text,
  county             text,
  planning_email     text,
  stage              text        not null,
  shared_lot         boolean     not null default false,
  has_office         boolean,
  vehicle_capacity   integer,
  contact_email      text,                 -- published leasing contact (from a listing)
  listing_ids        jsonb       not null default '[]'::jsonb,
  drive_minutes      numeric,
  in_search_area     boolean,
  created_at         timestamptz not null,
  updated_at         timestamptz not null,
  -- PostGIS point derived from lat/lon by trigger; not part of the TS row.
  geom               geometry(Point, 4326),
  constraint sites_stage_check check (stage in ('resolved', 'enriched', 'verifying', 'scored', 'out_of_area')),
  constraint sites_listing_ids_is_array check (jsonb_typeof(listing_ids) = 'array')
);

create index if not exists sites_parcel_id_idx on public.sites (parcel_id);
create index if not exists sites_stage_idx     on public.sites (stage);
create index if not exists sites_geom_gix      on public.sites using gist (geom);

create or replace function public.sites_set_geom()
returns trigger
language plpgsql
as $$
begin
  begin
    if new.lat is null or new.lon is null then
      new.geom := null;
    else
      new.geom := ST_SetSRID(ST_MakePoint(new.lon, new.lat), 4326);
    end if;
  exception when others then
    -- A bad coordinate must never fail an upsert; the row still lands.
    new.geom := null;
  end;
  return new;
end
$$;

drop trigger if exists sites_set_geom on public.sites;
create trigger sites_set_geom
  before insert or update on public.sites
  for each row execute function public.sites_set_geom();

-- The pipeline owns updated_at (it may run against a frozen clock, see
-- DEALERSOURCE_NOW), so this only fills the column when the writer omitted it.
create or replace function public.set_updated_at_if_missing()
returns trigger
language plpgsql
as $$
begin
  if new.updated_at is null then
    new.updated_at := now();
  end if;
  return new;
end
$$;

drop trigger if exists sites_set_updated_at on public.sites;
create trigger sites_set_updated_at
  before insert or update on public.sites
  for each row execute function public.set_updated_at_if_missing();

-- ---------------------------------------------------------------------------
-- parcels
-- ---------------------------------------------------------------------------
create table if not exists public.parcels (
  id             text primary key,         -- parcel number
  site_id        text        not null,
  owner          text,
  acreage        numeric,
  geometry       jsonb,                    -- GeoJSON Polygon (lon, lat order)
  frontage_ft    numeric,
  corner_lot     boolean,
  fronting_road  text,
  jurisdiction   text,
  county         text,
  source_url     text        not null,
  fetched_at     timestamptz not null,
  -- PostGIS polygon derived from `geometry` by trigger; not part of the TS row.
  geom           geometry(Polygon, 4326)
);

create index if not exists parcels_site_id_idx on public.parcels (site_id);
create index if not exists parcels_geom_gix    on public.parcels using gist (geom);

create or replace function public.parcels_set_geom()
returns trigger
language plpgsql
as $$
declare
  g geometry;
begin
  if new.geometry is null or jsonb_typeof(new.geometry) <> 'object' then
    new.geom := null;
    return new;
  end if;
  begin
    g := ST_SetSRID(ST_GeomFromGeoJSON(new.geometry::text), 4326);
    -- The column is typed geometry(Polygon,4326); anything else (MultiPolygon,
    -- Point, empty) would fail the typmod check AFTER this trigger returns,
    -- so it is rejected here instead of letting the upsert fail.
    if g is null or ST_IsEmpty(g) or ST_GeometryType(g) <> 'ST_Polygon' then
      new.geom := null;
    else
      new.geom := g;
    end if;
  exception when others then
    -- Malformed GeoJSON must never fail an upsert; the jsonb is kept as-is.
    new.geom := null;
  end;
  return new;
end
$$;

drop trigger if exists parcels_set_geom on public.parcels;
create trigger parcels_set_geom
  before insert or update on public.parcels
  for each row execute function public.parcels_set_geom();

-- ---------------------------------------------------------------------------
-- evidence  (fact, value, source_url, fetched_at, expires_at, method)
-- ---------------------------------------------------------------------------
create table if not exists public.evidence (
  id          text primary key,
  site_id     text        not null,
  fact        text        not null,
  value       jsonb,                       -- unknown
  source_url  text        not null,
  fetched_at  timestamptz not null,
  expires_at  timestamptz not null,
  method      text        not null,
  status      text        not null,
  message_id  text,
  notes       text,
  run_id      text        not null,
  constraint evidence_fact_check check (fact in (
    'geocode', 'parcel', 'zoning_district', 'zoning_permitted', 'rent_monthly',
    'office', 'vehicle_display', 'flood_zone', 'traffic_aadt', 'drive_minutes',
    'imagery', 'competitor_count'
  )),
  constraint evidence_method_check check (method in (
    'layer', 'layer+use_table', 'email', 'form', 'listing', 'api', 'manual'
  )),
  constraint evidence_status_check check (status in ('verified', 'unverified', 'conflicting'))
);

create index if not exists evidence_site_id_fact_idx on public.evidence (site_id, fact);
create index if not exists evidence_expires_at_idx   on public.evidence (expires_at);
create index if not exists evidence_message_id_idx   on public.evidence (message_id);

-- ---------------------------------------------------------------------------
-- cases  (section 14.3)
-- ---------------------------------------------------------------------------
create table if not exists public.cases (
  id                 text primary key,     -- `${site_id}:${type}`
  site_id            text        not null,
  listing_id         text        not null,
  type               text        not null,
  status             text        not null,
  owner              text        not null,
  contact_id         text,
  contact_role       text        not null,
  next_action        text        not null,
  next_action_at     timestamptz,
  followups_sent     integer     not null default 0,
  last_contacted_at  timestamptz,
  opened_at          timestamptz not null,
  updated_at         timestamptz not null,
  resolved_at        timestamptz,
  resolution         text,
  evidence_id        text,
  constraint cases_type_check         check (type in ('rent', 'zoning', 'space')),
  constraint cases_status_check       check (status in ('open', 'awaiting_reply', 'resolved', 'escalated', 'closed')),
  constraint cases_owner_check        check (owner in ('system', 'human')),
  constraint cases_contact_role_check check (contact_role in ('leasing', 'planning'))
);

create index if not exists cases_site_id_status_idx        on public.cases (site_id, status);
create index if not exists cases_status_next_action_at_idx on public.cases (status, next_action_at);
create index if not exists cases_contact_id_idx            on public.cases (contact_id);

drop trigger if exists cases_set_updated_at on public.cases;
create trigger cases_set_updated_at
  before insert or update on public.cases
  for each row execute function public.set_updated_at_if_missing();

-- ---------------------------------------------------------------------------
-- contacts  (holds emails; never exposed to anon)
-- ---------------------------------------------------------------------------
create table if not exists public.contacts (
  id                text primary key,      -- sha256(lower(email))
  email             text        not null,
  name              text,
  org               text,
  role              text        not null,
  derived_from_url  text        not null,
  do_not_contact    boolean     not null default false,
  bounced           boolean     not null default false,
  created_at        timestamptz not null,
  constraint contacts_role_check check (role in ('leasing', 'planning'))
);

create index if not exists contacts_email_idx on public.contacts (email);

-- ---------------------------------------------------------------------------
-- messages  (holds addresses and bodies; never exposed to anon)
-- ---------------------------------------------------------------------------
create table if not exists public.messages (
  id                   text primary key,
  case_ids             jsonb       not null default '[]'::jsonb,
  case_type            text        not null,
  site_id              text        not null,
  listing_id           text        not null,
  contact_id           text        not null,
  "to"                 text        not null,   -- reserved word; PostgREST quotes it
  direction            text        not null,
  subject              text        not null,
  body                 text        not null,
  sent_at              timestamptz not null,
  thread_token         text        not null,   -- DS token shared by outbound + replies
  provider_message_id  text,
  template_id          text,
  attempt              integer     not null default 0,
  classification       jsonb,                  -- ReplyClassification | null
  status               text        not null,
  run_id               text        not null,
  constraint messages_case_type_check   check (case_type in ('rent', 'zoning', 'space')),
  constraint messages_direction_check   check (direction in ('outbound', 'inbound')),
  constraint messages_status_check      check (status in ('sent', 'bounced', 'received', 'paused', 'refused')),
  constraint messages_case_ids_is_array check (jsonb_typeof(case_ids) = 'array')
);

create index if not exists messages_site_id_idx      on public.messages (site_id);
create index if not exists messages_contact_id_idx   on public.messages (contact_id);
create index if not exists messages_thread_token_idx on public.messages (thread_token);
create index if not exists messages_sent_at_idx      on public.messages (sent_at desc);

-- ---------------------------------------------------------------------------
-- scores  (one current score per site; id = site_id)
-- ---------------------------------------------------------------------------
create table if not exists public.scores (
  id              text primary key,
  site_id         text        not null,
  run_id          text        not null,
  in_search_area  boolean     not null,
  viable          boolean     not null,
  shortlisted     boolean     not null,
  shared_lot      boolean     not null,
  gates           jsonb       not null,    -- Record<GateName, GateResult>
  requirements    jsonb       not null,    -- RequirementResult[]
  factors         jsonb       not null,    -- FactorScore[]
  metrics         jsonb       not null,    -- SiteMetrics
  total           numeric,
  rank            integer,
  flags           jsonb       not null default '[]'::jsonb,
  computed_at     timestamptz not null
);

create index if not exists scores_site_id_idx on public.scores (site_id);
create index if not exists scores_rank_idx    on public.scores (viable, rank);

-- ---------------------------------------------------------------------------
-- runs
-- ---------------------------------------------------------------------------
create table if not exists public.runs (
  id              text primary key,
  run_date        date        not null,    -- YYYY-MM-DD logical today
  started_at      timestamptz not null,
  finished_at     timestamptz,
  mode            text        not null,
  stages          jsonb       not null default '{}'::jsonb,  -- Partial<Record<Stage, StageSummary>>
  counts          jsonb       not null default '{}'::jsonb,  -- Record<string, number>
  errors          jsonb       not null default '[]'::jsonb,
  warnings        jsonb       not null default '[]'::jsonb,
  paid_calls      jsonb       not null default '[]'::jsonb,  -- PaidCall[]
  external_calls  jsonb       not null default '[]'::jsonb,  -- hosts contacted; [] offline
  fixture_layers  jsonb       not null default '[]'::jsonb,
  sending_paused  boolean     not null default false,
  pause_reason    text,
  providers       jsonb       not null default '{}'::jsonb,  -- Record<string, string | boolean>
  status          text        not null,
  constraint runs_mode_check   check (mode in ('offline', 'online')),
  constraint runs_status_check check (status in ('running', 'ok', 'error'))
);

create index if not exists runs_started_at_idx on public.runs (started_at desc);
create index if not exists runs_run_date_idx   on public.runs (run_date desc);

-- ---------------------------------------------------------------------------
-- reports  (latest contract report per run; the dashboard reads this directly)
-- ---------------------------------------------------------------------------
create table if not exists public.reports (
  id          text primary key,            -- run id
  run_date    date        not null,
  created_at  timestamptz not null,
  payload     jsonb       not null,        -- ContractReport (section 14.4)
  messages    jsonb       not null default '[]'::jsonb  -- ContractMessage[]
);

create index if not exists reports_created_at_idx on public.reports (created_at desc);

-- ---------------------------------------------------------------------------
-- Views for the dashboard. security_invoker so the caller's grants/RLS apply
-- (both underlying tables are anon-readable; contact emails are left out).
-- ---------------------------------------------------------------------------
create or replace view public.v_shortlist
with (security_invoker = true)
as
select
  s.id                as site_id,
  s.parcel_id,
  s.canonical_address,
  s.lat,
  s.lon,
  s.jurisdiction,
  s.county,
  s.stage,
  s.shared_lot,
  s.has_office,
  s.vehicle_capacity,
  s.drive_minutes,
  s.in_search_area,
  sc.run_id,
  sc.viable,
  sc.shortlisted,
  sc.total,
  sc.rank,
  sc.gates,
  sc.requirements,
  sc.factors,
  sc.metrics,
  sc.flags,
  sc.computed_at
from public.sites s
join public.scores sc on sc.site_id = s.id
where sc.viable
order by sc.rank asc nulls last, sc.total desc nulls last, s.id;

create or replace view public.v_open_cases
with (security_invoker = true)
as
select
  c.id                as case_id,
  c.site_id,
  c.listing_id,
  c.type,
  c.status,
  c.owner,
  c.contact_role,
  c.next_action,
  c.next_action_at,
  c.followups_sent,
  c.last_contacted_at,
  c.opened_at,
  c.updated_at,
  c.evidence_id,
  s.parcel_id,
  s.canonical_address,
  s.jurisdiction,
  s.county,
  s.stage,
  s.lat,
  s.lon
from public.cases c
join public.sites s on s.id = c.site_id
where c.status in ('open', 'awaiting_reply', 'escalated')
order by c.next_action_at asc nulls last, c.opened_at asc;

comment on view public.v_shortlist  is 'Viable sites joined to their current score, ordered by rank. No contact emails.';
comment on view public.v_open_cases is 'Cases needing attention (open/awaiting_reply/escalated) joined to sites. No contact emails or contact ids.';
