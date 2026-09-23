# Costs: zero spend by default, and exactly where money starts

## The default configuration spends nothing

`providers.yaml` selects a free adapter for every layer and `paid_enabled: false`.
The test `tests/unit/config.test.ts` asserts that no selected adapter is paid, and the
golden integration test asserts `run.json.paid_calls == []` and `report.json.external_calls == []`.

| Layer | Default | Cost | Limits to know |
|---|---|---|---|
| geocoder | `census` | free, no key | polite use; batch endpoint exists for bulk |
| parcels | `nc_onemap` | free, no key | NC OneMap polygon layer (FeatureServer/1); ArcGIS REST rate limits |
| zoning | `arcgis` | free, official layers | per-municipality endpoints |
| drivetime | `ors` | free tier key | 2,000 directions + 500 isochrones/day on the free plan |
| traffic | `ncdot` | free (ArcGIS Online, NCDOT) | 2024 release, 2022 service as fallback |
| flood | `fema` | free | - |
| imagery | `mapillary` | free token | fair-use |
| poi | `overpass` | free public instances | 1 request / 2 s enforced by the adapter; main instance then kumi, 60 s timeout, one retry each; self-host with `OVERPASS_URL` for scheduled loads |
| crawler | `fetch` | free, plain Node fetch | nothing to host; polite per-host interval, robots.txt honoured. `anycrawl` (self-hosted) is the free alternative |
| crawler (render: js sources) | `playwright` | free, local headless Chromium (Apache-2.0) | nothing hosted, no Docker; ~100 MB one-time browser download; only sources marked `render: js` |
| social | `reddit` | free tier, OAuth app | 100 QPM; Developer Terms apply |
| mail | `gmail` | free | Gmail SMTP + IMAP with an app password; personal-account sending limits far exceed this pipeline's volume; a limit reply auto-pauses outreach |
| llm | `rules` | free | deterministic |
| tiles | `protomaps` | self-hosted PMTiles | your own storage/bandwidth |
| storage | Supabase | free tier | 500 MB Postgres on the free plan |
| dashboard | Vercel | Hobby plan free | - |
| scheduler | Claude Code routine | included in your Claude plan | model steps happen inside the routine |

## What would start costing money, and the switch

Every paid adapter exists in code but is unreachable until BOTH are true:

1. `providers.yaml` -> `paid_enabled: true`  (the master switch), and
2. that layer selects the paid adapter id AND its key is set in the environment.

| Paid adapter | Layer key | Env var | Replaces |
|---|---|---|---|
| `google` (Geocoding / Address Validation) | `geocoder: google` | `GOOGLE_MAPS_API_KEY` | census / nominatim |
| `regrid` | `parcels: regrid` | `REGRID_API_KEY` | nc_onemap / county |
| `google` (Distance Matrix) | `drivetime: google` | `GOOGLE_MAPS_API_KEY` | ors / valhalla |
| `streetview` | `imagery: streetview` | `GOOGLE_MAPS_API_KEY` | mapillary |
| `places` | `poi: places` | `GOOGLE_MAPS_API_KEY` | overpass |
| `anycrawl_cloud` | `crawler: anycrawl_cloud` | `ANYCRAWL_API_KEY` | fetch / anycrawl (self-hosted) |
| `claude_api` | `llm: claude_api` | `ANTHROPIC_API_KEY` | rules / claude_agent |
| `mapbox` | `tiles: mapbox` | `MAPBOX_TOKEN` | protomaps |

Selecting a paid id while `paid_enabled` is false is a startup error
(`PaidProviderDisabledError`), so a mis-edit cannot create spend. When enabled, every
paid request is recorded with its cost class in `run.json.paid_calls` and the runs table.

## Free adapters that can still hit a paywall

- OpenRouteService free tier is quota-limited per day; exceeding it returns errors (no
  charge). Switch to `drivetime: valhalla` with a self-hosted instance for unlimited use.
- The public Overpass instance is shared infrastructure; the adapter enforces a polite
  interval. Scheduled runs at scale should self-host (`OVERPASS_URL`).
- Public OSM tile servers and the public Nominatim server are never used (the Nominatim
  adapter refuses `nominatim.openstreetmap.org`).
