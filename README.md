# dealersource (Claude Code solution)

A scheduled system that **finds, verifies and ranks leaseable sites for a licensed
used-car dealership in Eastern North Carolina** and reports a verified shortlist
to a dashboard. Discovery, verification outreach (email) and reporting run with
no human in the loop; humans act only on the shortlist.

This repository is one of several independent implementations of the same task.
The task spec and shared system prompt live in the parent repo:

- System prompt: https://github.com/ryanflash66/dealersource/blob/main/prompts/system-prompt.md
- Task spec (sections 13/14 are the acceptance contract): https://github.com/ryanflash66/dealersource/blob/main/prompts/task-spec.md
- Output JSON Schemas: https://github.com/ryanflash66/dealersource/tree/main/evals/contract

Built with Node.js 20+ and TypeScript. **npm** is the package manager (pnpm is
not assumed to be installed). Everything below runs offline with no `.env`.

---

## 1. Offline first run (under five minutes)

```bash
git clone https://github.com/ryanflash66/dealersource-claude.git
cd dealersource-claude
npm install                # the only step that touches the network
npm test                   # 80+ tests under a global "no network" guard

# Full pipeline on the bundled golden fixture set (section 14.2 CLI):
npm run pipeline -- --offline --fixtures fixtures/golden-v1 --out out/golden --run-date 2026-09-16
#   -> out/golden/report.json, messages.json (3 emails queued), run.json, digest.md
#      state persisted under out/golden/state/

# Run it again: same day, nothing is sent twice
npm run pipeline -- --offline --fixtures fixtures/golden-v1 --out out/golden --run-date 2026-09-16
#   -> messages.json == []

npm run dashboard:dev      # builds from fixture data, serves http://localhost:4173
```

`npm run pipeline:golden` is a shortcut for the first pipeline command.
The CLI prints one JSON line (`sites`, `viable`, `messages_sent`, `errors`) and
exits non-zero on any stage error; an attempted network call in `--offline`
mode is a hard error (exit code 3).

What the golden run shows (matches `fixtures/golden-v1/expected.json`):

| Parcel | Outcome |
|---|---|
| PITT-0001 | three listings from three sources merged into one site; all gates pass from the listing + official use table; **rank 1** |
| PITT-0002 | rent and zoning unknown -> two inquiries sent -> same-day replies verify both; **rank 2** |
| PITT-0006 | viable but a shared lot -> **rank 3**, always after standalone sites |
| PITT-0003 / BEAU-0004 / PITT-0005 | rent 1400 / zoning prohibited / FEMA zone AE -> gate fails, no outreach |
| WAYN-0007 | 78-minute drive -> outside the search area, not scored |
| PITT-0008 | zoning unknown, no reply -> inquiry sent, gate `pending`, not viable |

## 2. How it works

```
sources.yaml ──discover──> raw_documents + listings
                              │ resolve (geocode -> parcel; same parcel_id = one site)
                              ▼
                         sites + parcels ──enrich──> evidence (zoning, flood, traffic, drive, POI, imagery, listing facts)
                              │ verify: open cases -> send approved emails -> ingest replies -> evidence
                              ▼
                         score: gates -> viable -> weighted rank (shared lots last)
                              │ report: report.json / messages.json / run.json / digest.md / reports table
```

- **Gates** (all three must `pass` on verified, unexpired, cited evidence):
  zoning permitted (official layer + use table with section, or written planning reply),
  written base rent within `rent.min_monthly..max_monthly`, parcel outside high-risk FEMA zones.
  Missing or expired evidence is `pending`, never `pass`. No response is not approval.
- **Ranking** weights (traffic, visibility, distance, rent, competitors) live in `business.yaml`.
- **Outreach** uses only the approved text in `config/mail-templates.yaml`; the model fills
  slots. Never the same address about the same site twice within `mail.followup_days`;
  at most `mail.max_followups`, then the case is escalated to the dashboard. Bounce-rate
  or quota problems pause sending automatically and surface on the dashboard.
- **Idempotency**: every row id is derived from its inputs, so re-running a day is a no-op.
- **Evidence** rows carry `source_url`, `fetched_at`, `expires_at` and `method`; TTLs per fact
  are in `business.yaml`.

### Repository layout

| Path | What |
|---|---|
| `providers.yaml` | provider per layer + the `paid_enabled` spend switch (section 14.1) |
| `business.yaml` | every business parameter (section 2) + `score.weights` |
| `config/sources.yaml` | the source allowlist with researched `terms_status` / `robots_txt` |
| `config/use-tables.yaml` | zoning use tables with the cited ordinance section per district |
| `config/mail-templates.yaml` | approved outreach text |
| `src/providers/` | one interface per data layer, free + paid adapters (crawler: `fetch` default, `playwright` = local headless Chromium for sources marked `render: js`, `anycrawl`, `anycrawl_cloud`; parcels: `nc_onemap` default = NC OneMap polygon layer `FeatureServer/1`, `county` = Pitt `PittOpenData/CadastralPitt` layer 0, `regrid`; zoning: `arcgis` = Greenville `OpenData/MapServer/21` and Pitt County `ZoningPitt` layer 0, queried at the parcel, other towns go to a planning case; traffic: `ncdot` = NCDOT 2024 AADT release on ArcGIS Online, 2022 service as fallback, latest non-blank year, station on the site's street preferred; poi: `overpass` = ordered instance list, 60 s, one retry per instance), fixture-backed fakes |
| `src/pipeline/` | the six idempotent stages, gates, scoring, templates |
| `src/store/` | JSON-file store (offline default) and Supabase/PostgREST store |
| `fixtures/golden-v1/` | the sample fixture set (copied from the parent repo) |
| `fixtures/http/` | recorded API responses used by the adapter unit tests |
| `supabase/migrations/` | Postgres + PostGIS schema and RLS policies |
| `docker-compose.yml` | local PostGIS + PostgREST stack |
| `dashboard/` | static dashboard on the Modernize admin layout (TypeScript + CSS, no framework), deployable to Vercel |
| `agent/` | scheduled Claude Code routine definition and prompt |
| `docs/` | decisions, deploy, scheduling, costs |

## 3. Commands

| Command | Purpose |
|---|---|
| `npm test` | full offline test suite |
| `npm run typecheck` | `tsc` for pipeline and dashboard |
| `npm run pipeline -- [flags]` | the CLI (`--offline --fixtures <dir> --out <dir> --run-date YYYY-MM-DD [--config providers.yaml] [--stage <name>]`) |
| `npm run sources:check` | print the allowlist decision for every source |
| `npm run sources:discover -- --out out` | online: find broker/property-manager POIs near home base -> `sources.candidates.yaml` |
| `npm run dashboard:build` | build the dashboard from fixture data (exit 0 offline) |
| `npm run dashboard:dev` | build + serve on http://localhost:4173 |
| `npm run dashboard:deploy` | `vercel deploy --prod` (after `npm run dashboard:build`) |
| `npm run db:local` | `docker compose up -d` (PostGIS + PostgREST) |
| `npm run db:migrate` | apply `supabase/migrations/*.sql` with `psql` to `DATABASE_URL` |

## 4. Deploy

Nothing in this repo needs credentials to build or test. Real values are supplied
once, at deploy time, through environment variables. `.env.example` lists every
variable with its purpose; any variable left unset makes that adapter fall back
to its fixture-backed fake and the run records it under `fixture_layers`.

### 4.1 Variables to set

| Purpose | Variables |
|---|---|
| Home base: the address drive times are measured from, where the owner commutes from (never committed) | `DEALERSOURCE_HOME_BASE="<street address>, <city>, NC <zip>"` |
| Storage (Supabase) | `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY` (pipeline), `SUPABASE_ANON_KEY` (dashboard) |
| Email (Gmail SMTP + IMAP, app password) | `GMAIL_SENDER_ADDRESS`, `GMAIL_APP_PASSWORD`; pick the mailbox with `business.yaml mail.sender: owner|operator` |
| Reddit official API | `REDDIT_CLIENT_ID`, `REDDIT_CLIENT_SECRET`, `REDDIT_USER_AGENT` |
| Free providers needing a key/URL | `ORS_API_KEY`, `MAPILLARY_ACCESS_TOKEN`, `NOMINATIM_URL`, `VALHALLA_URL`, `OVERPASS_URL` (one URL or a comma-separated list tried in order), `PMTILES_URL`; `ANYCRAWL_URL` only if you switch `crawler` from the default `fetch` to self-hosted `anycrawl` |
| Paid providers (off by default) | `GOOGLE_MAPS_API_KEY`, `REGRID_API_KEY`, `ANTHROPIC_API_KEY`, `ANYCRAWL_API_KEY`, `MAPBOX_TOKEN` |

Steps:

1. **Database**: create a Supabase project and apply `supabase/migrations/*.sql`
   (`supabase db push`, the SQL editor, or `DATABASE_URL=... npm run db:migrate`).
   For a local stack instead: `npm run db:local` and point `SUPABASE_URL=http://localhost:3000`
   (see the header of `docker-compose.yml` for the service-role JWT). Details: `supabase/README.md`.
   Existing projects: apply the newest migration too (`20260918000000` adds `sources.contact_email`
   and `sites.enrich_warnings`).
2. **Mail**: on the owner's (or operator's) Google account, turn on 2-Step Verification and create
   an app password (myaccount.google.com/apppasswords); set `GMAIL_SENDER_ADDRESS` and
   `GMAIL_APP_PASSWORD`. Mail goes out over SMTP (smtp.gmail.com:465) and replies are read over
   IMAP (imap.gmail.com:993); no Google Cloud project or OAuth client is involved. Then set
   `verified: true` on each `business.yaml` jurisdiction after re-checking its `source_url`:
   the Gmail adapter refuses planning addresses that are not verified.
3. **Pipeline**: `npm run pipeline -- --out out/$(date +%F)` (online; `--fixtures` may still be
   passed as a fallback for layers whose variables are unset). Schedule it as a Claude Code routine
   using `agent/routine.md` (setup in `docs/scheduling.md`; GitHub Actions and pg_cron alternatives
   are documented there).
4. **Dashboard**: `SUPABASE_URL=... SUPABASE_ANON_KEY=... PMTILES_URL=... npm run dashboard:build`
   then `npm run dashboard:deploy` (Vercel; `vercel.json` is included). With no Supabase variables
   the build embeds the latest fixture run instead. Set the same three variables in the Vercel
   project so its build reads Supabase directly.

### 4.2 Flip a provider

Edit one line in `providers.yaml`, e.g. `geocoder: nominatim` (and set `NOMINATIM_URL` to your
self-hosted instance; the public Nominatim server is refused). No code changes. `report.json.providers`
reflects the selection even offline.

Crawler: `crawler: fetch  # fetch | playwright | anycrawl | anycrawl_cloud`. The default `fetch` is plain Node
`fetch` with nothing to host: follows redirects, 15 s timeout, polite User-Agent naming this project,
robots.txt checked per page and disallowed paths refused, no JavaScript execution; the fetched HTML is
stored in `raw_documents` and its readable text and links feed the listing extractor. A source marked
`render: js` in `config/sources.yaml` is rendered instead by `playwright`: local headless Chromium
(Apache-2.0, $0, nothing hosted, no Docker) with the same User-Agent, robots.txt checked for the page and
for every document/XHR/fetch request the page makes, images/fonts/media never loaded, and a 5 s minimum
between page loads per origin. The browser starts only when such a source is fetched and closes at the
end of discovery; offline runs use the fixture crawler and never launch it. The daily runner installs
the Chromium headless shell once if it is missing (`scripts/ensure-browser.mjs`). `anycrawl`
(self-hosted, `ANYCRAWL_URL`) and `anycrawl_cloud` (paid) return the same document shape. Paid adapters (`google`, `regrid`, `streetview`, `places`,
`anycrawl_cloud`, `claude_api`, `mapbox`) additionally require `paid_enabled: true` and the matching
key; otherwise startup fails with `PaidProviderDisabledError` and no call can happen.
See `docs/costs.md` for exactly what starts costing money.

### 4.3 Enable a grey source

Sources with `terms_status: unclear` are never fetched. After reading the site's terms and
`robots.txt`, change the row in `config/sources.yaml` to `terms_status: allowed`,
`robots_txt: allowed`, `enabled: true`, and record what you checked in `notes`.
`npm run sources:check` prints the resulting decision per source. Sources marked
`prohibited` or `disallowed` are refused regardless of `enabled` (LoopNet, Crexi, Craigslist and
Facebook Marketplace are recorded that way, with the reason).

LoopNet and Crexi listings come in through saved-search alert emails instead
(`loopnet-alerts`, `crexi-alerts`, kind `email_alert`; decision 28). One-time owner setup:

1. Create a free account on each site with the Gmail address in `GMAIL_SENDER_ADDRESS`.
2. Search for lease around Greenville, NC (retail, land, flex/industrial), cap the price near
   $1,000/mo, save the search, and turn on daily email alerts.
3. In Gmail, make sure those alerts never go to Spam (a filter on `from:loopnet.com` /
   `from:crexi.com` with "Never send it to Spam"); All Mail is read, Spam is not.

The next run reads the alerts over IMAP. Nothing is requested from either site.

### 4.4 Pause outreach

- Manual kill switch: `business.yaml` -> `mail.paused: true`, or set `DEALERSOURCE_PAUSE_SENDING=1`
  on the scheduled job. Cases keep being tracked; nothing is sent; the dashboard shows the pause.
- Automatic: sending pauses when the 24-hour bounce rate exceeds `mail.bounce_pause_pct` or the
  mail provider returns a quota error. A reply that asks to stop marks that contact do-not-contact.

## 5. Tests

`npm test` runs unit tests (adapters against recorded fixtures in `fixtures/http`, gates,
scoring, dedupe, stores, allowlist, outreach policy) and integration tests (the golden fixture
run validated against the contract schemas, the replay test proving a repeated run sends nothing,
the census -> nominatim switch, and the no-paid-call check). `tests/setup.ts` replaces global
`fetch` with one that throws, so no test can reach the network.

## 6. Decisions

Choices made where the spec was silent are recorded in `docs/decisions.md`.
