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

Transport: Gmail SMTP (`smtp.gmail.com:465`, implicit TLS) to send and Gmail IMAP
(`imap.gmail.com:993`, implicit TLS) to read replies, both logged in with an app password.
No Google Cloud project, OAuth client or refresh token. Free; a personal Gmail account allows
far more per day than this pipeline sends (a handful of contacts a day), and a sending-limit
reply from Gmail pauses outreach automatically.

1. Pick the mailbox with `business.yaml mail.sender` (`owner` = the dealer's mailbox,
   `operator` = a fallback mailbox) and sign in to that Google account.
2. Turn on 2-Step Verification (required for app passwords), then create an app password at
   https://myaccount.google.com/apppasswords. Google shows it as four groups of four letters;
   spaces are ignored. If the IMAP login is refused as disabled, enable IMAP under Gmail
   settings, Forwarding and POP/IMAP.
3. Set `GMAIL_SENDER_ADDRESS` (that mailbox) and `GMAIL_APP_PASSWORD`. Never commit them and
   never paste them into chat; the adapter never logs the password and redacts it from errors.
   Every online run logs in to both servers first and logs `mail preflight` with
   `smtp_login` and `imap_login`; either failing pauses sending for that run.
4. For every jurisdiction you expect to email, open the `source_url` in `business.yaml`,
   confirm the planning department's published address, and set `verified: true`. The Gmail
   adapter refuses unverified planning addresses (spec section 6: addresses must derive from
   an official government page). Leasing contacts come only from listings.
5. Replies are polled from the same mailbox (`Reply-To` = sender). Subjects carry a
   `[DS-XXXXXX]` token that routes a reply to its case group.

## 3. Providers

Edit `providers.yaml`; each key is one line. Free defaults need these variables when used
for real: `ORS_API_KEY` (drivetime), `MAPILLARY_ACCESS_TOKEN` (imagery),
`REDDIT_CLIENT_ID/SECRET/USER_AGENT`. The default crawler `fetch` needs nothing. Sources marked
`render: js` need Playwright's Chromium once per machine (`npx playwright install chromium --only-shell`;
the Windows runner does this itself); `ANYCRAWL_URL`
only if you select `crawler: anycrawl`. Optional self-hosted URLs:
`NOMINATIM_URL`, `VALHALLA_URL`, `OVERPASS_URL`. Paid adapters: see `docs/costs.md`.

`config/use-tables.yaml` and the `arcgis` layer list in `providers.yaml` must be extended
for each municipality you want to auto-verify from the zoning layer; anything else opens a
planning case instead. Only add a layer after checking it live (`<url>?f=json` must name a
polygon layer and its district field): the shipped list is Greenville `OpenData/MapServer/21`
(`ZONE`) and Pitt County `PittOpenData/ZoningPitt/MapServer/0` (`ZONE`, empty inside town
limits). Layers are queried with the parcel polygon, never the geocode, because Census geocodes
land in the road right-of-way. Winterville, Ayden and Washington publish no ArcGIS zoning layer
and always go to a planning case.

## 4. Sources

Broker pages rarely publish a per-listing email. Put the office address in `contact_email` on the
source row in `config/sources.yaml` (Ron Harrell Commercial ships blank); listings without their own
email use it, and a site with neither is escalated once with a digest note naming the listing.

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
build time. The basemap is self-hosted and needs no setup: the repo ships a Protomaps
archive for Greenville ± ~60 miles (`dashboard/public/tiles/eastern-nc.pmtiles`, 46 MB, zoom
0-14) plus MapLibre, glyphs and sprites, all served from the same Vercel deployment (Vercel
answers byte-range requests, which PMTiles needs). `PMTILES_URL` overrides the archive, e.g.
for a larger area on your own storage. Refresh or re-cut the archive with the command in
`dashboard/public/map/NOTICE.md`. If WebGL is unavailable the map pane shows the relative site
plot instead; public OSM tile servers are never used.

## 6. Scheduling

See `docs/scheduling.md`.

## 7. Operating

- Pause outreach: `DEALERSOURCE_PAUSE_SENDING=1` or `business.yaml mail.paused: true`.
- Change the search area / rent range / weights: `business.yaml`; the next run re-scores.
- Expired evidence shows under Exceptions and re-fetches automatically on the next run.
- Escalated cases (max follow-ups reached, bounce, no published contact, stop request) are
  the human work queue on the Pipeline view.
