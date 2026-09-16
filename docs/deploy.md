# Deploy guide (long form)

The README's **Deploy** section is the checklist; this file is the detail.

## 1. Database (Supabase Postgres + PostGIS)

Hosted:

```bash
npm i -g supabase
supabase login
supabase link --project-ref <ref>
supabase db push            # applies supabase/migrations/*.sql
```

Or paste the two SQL files into the SQL editor in order. RLS is enabled on every table;
the anon role can only read reports, sources, sites, parcels, evidence, cases, scores, runs.

Local (Docker):

```bash
npm run db:local            # postgis on :54322, PostgREST on :3000; migrations auto-applied
export SUPABASE_URL=http://localhost:3000
export SUPABASE_SERVICE_ROLE_KEY=<JWT for role service_role, see docker-compose.yml header>
```

The pipeline chooses Supabase only when `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` are set
and the run is online; otherwise it uses the JSON store under `<out>/state/`.

## 2. Gmail (verification outreach)

1. Google Cloud console -> enable Gmail API -> OAuth client (Desktop or Web).
2. Authorise the mailbox chosen by `business.yaml mail.sender` (`owner` = the dealer's mailbox,
   `operator` = a fallback mailbox) with scope `https://www.googleapis.com/auth/gmail.modify`
   and keep the refresh token.
3. Set `GMAIL_CLIENT_ID`, `GMAIL_CLIENT_SECRET`, `GMAIL_REFRESH_TOKEN`, `GMAIL_SENDER_ADDRESS`.
4. For every jurisdiction you expect to email, open the `source_url` in `business.yaml`,
   confirm the planning department's published address, and set `verified: true`. The Gmail
   adapter refuses unverified planning addresses (spec section 6: addresses must derive from
   an official government page). Leasing contacts come only from listings.
5. Replies are polled from the same mailbox (`Reply-To` = sender). Subjects carry a
   `[DS-XXXXXX]` token that routes a reply to its case group.

## 3. Providers

Edit `providers.yaml`; each key is one line. Free defaults need these variables when used
for real: `ORS_API_KEY` (drivetime), `MAPILLARY_ACCESS_TOKEN` (imagery), `ANYCRAWL_URL`
(self-hosted crawler), `REDDIT_CLIENT_ID/SECRET/USER_AGENT`. Optional self-hosted URLs:
`NOMINATIM_URL`, `VALHALLA_URL`, `OVERPASS_URL`. Paid adapters: see `docs/costs.md`.

`config/use-tables.yaml` and the `arcgis` layer list in `providers.yaml` must be extended
for each municipality you want to auto-verify from the zoning layer; anything else opens a
planning case instead.

## 4. Sources

Run `npm run sources:check` to see what will be fetched. Discover brokers with
`npm run sources:discover -- --out out` (Overpass POI query near home base) and research each
candidate before moving it into `config/sources.yaml` as `allowed`. Prohibited sources stay in
the file so the exclusion and its reason are visible on the dashboard.

## 5. Dashboard (Vercel)

```bash
npm i -g vercel
SUPABASE_URL=... SUPABASE_ANON_KEY=... PMTILES_URL=... npm run dashboard:build
npm run dashboard:deploy
```

Set the same variables in the Vercel project (Environment Variables) so `vercel.json`'s
`buildCommand` embeds them. Without them the dashboard serves the latest fixture run baked at
build time. Basemap tiles are self-hosted Protomaps (`PMTILES_URL`); with none set the
dashboard shows a dependency-free site plot instead of loading public OSM tiles.

## 6. Scheduling

See `docs/scheduling.md`.

## 7. Operating

- Pause outreach: `DEALERSOURCE_PAUSE_SENDING=1` or `business.yaml mail.paused: true`.
- Change the search area / rent range / weights: `business.yaml`; the next run re-scores.
- Expired evidence shows under Exceptions and re-fetches automatically on the next run.
- Escalated cases (max follow-ups reached, bounce, no published contact, stop request) are
  the human work queue on the Pipeline view.
