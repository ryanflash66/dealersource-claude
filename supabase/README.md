# Database layer

Supabase Postgres with PostGIS, delivered as plain SQL migrations in
`migrations/` so the same schema runs on a hosted project, the Supabase CLI
local stack, or a bare Docker Postgres. The pipeline never talks SQL; it goes
through PostgREST (`src/store/supabase-store.ts`) with the service role key.

Column names and types mirror `src/core/types.ts` 1:1 (same snake_case
spelling; nested objects and arrays are `jsonb`, ISO timestamps are
`timestamptz`, TypeScript unions are `text` + `CHECK`). Every table has
`id text primary key` because writes are `POST /<table>?on_conflict=id`
upserts. If a row type changes, add a new migration; do not edit an applied one.

The only columns the TS rows do not carry are the trigger-maintained PostGIS
columns `sites.geom` (Point from `lat`/`lon`) and `parcels.geom` (Polygon from
the GeoJSON in `parcels.geometry`, nulled on bad input so an upsert never fails).

## Three ways to run it

**Hosted Supabase.** From the repo root: `supabase link --project-ref <ref>`
then `supabase db push` applies `supabase/migrations` in order. Or paste the
two SQL files into the SQL editor, `..._init.sql` first. PostGIS is already
available on hosted projects (the `create extension if not exists` is a no-op).
Set `SUPABASE_URL=https://<ref>.supabase.co` and `SUPABASE_SERVICE_ROLE_KEY`
for the pipeline; the dashboard gets `SUPABASE_ANON_KEY`.

**Supabase CLI, local.** `supabase init` (once) then `supabase start` brings up
the full local stack and applies everything in `supabase/migrations`. New files
land with `supabase migration up`. PostgREST is at the URL the CLI prints.

**Docker (Postgres/PostGIS + PostgREST only).** `docker compose up -d` at the
repo root. On first start the migrations auto-apply in filename order; PostgREST
listens on `http://localhost:3000`, Postgres on `localhost:54322`. The header
comment in `docker-compose.yml` shows how to mint a `service_role` JWT for
`SUPABASE_SERVICE_ROLE_KEY` with a one-line node command. To re-apply after a
change without wiping the volume:
`DATABASE_URL=postgres://postgres:dealersource@localhost:54322/dealersource node scripts/apply-migrations.mjs`
(needs `psql` on PATH; the script prints help and exits 2 if either is missing).

## What RLS allows

Row Level Security is enabled on all 12 tables.

| Role | Access |
| --- | --- |
| `anon`, `authenticated` (dashboard) | `SELECT` on `reports`, `sources`, `sites`, `parcels`, `evidence`, `cases`, `scores`, `runs`, and on the views `v_shortlist`, `v_open_cases` |
| `anon`, `authenticated` | nothing on `listings`, `raw_documents`, `messages`, `contacts` (email addresses, message bodies, raw pages): no grant and no policy |
| `service_role` (pipeline) | everything; `BYPASSRLS` |

The views leave out `contact_email`, `planning_email` and `contact_id`. On
hosted Supabase the service role key already bypasses RLS; the Docker stack
creates an equivalent `service_role` with `BYPASSRLS`. Role creation is
idempotent so the same file runs in both places.
