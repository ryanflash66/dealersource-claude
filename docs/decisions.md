# Decisions where the spec was silent

Each entry: the gap, the choice, why. Section numbers refer to the task spec.

1. **Package manager: npm.** pnpm was not on PATH; the spec allows either. Scripts are
   `npm test`, `npm run pipeline`, `npm run dashboard:build`, `npm run dashboard:dev`.

2. **Offline storage is a JSON-file store that mirrors the SQL schema.** The Supabase fake
   (s.10a) persists to `<out>/state/state.json` (s.14.2). Column names in
   `supabase/migrations` equal the TypeScript row properties one-for-one so both stores hold
   identical rows. PostgREST timestamps (`+00:00`) are normalised to `Z` on read.

3. **Two kinds of fixtures.** The section-14.3 files drive the offline *pipeline* through
   fixture-backed providers (one per layer). Recorded HTTP responses under `fixtures/http/`
   drive *adapter unit tests* so each real adapter's parsing is tested (s.10) without
   inventing API-shaped fixtures for the evaluator's data.

4. **Fixture fallback online.** In online runs, a layer whose environment variables are unset
   is served from `--fixtures` when a fixtures directory is given (recorded in
   `report.fixture_layers` and run warnings); without one its calls fail loudly naming the
   missing variables. Adapters that need no key (Census, NC OneMap, ArcGIS, NCDOT, FEMA,
   public Overpass) run for real.

5. **Run-date clock.** `--offline` freezes the clock at `<date>T10:00:00Z` (about 06:00
   Eastern, matching the default cron) so fixture runs are reproducible; `DEALERSOURCE_NOW` /
   `--now` freeze it anywhere. Online runs use the real wall clock for `created_at`,
   `started_at`, `finished_at`, `fetched_at` and `sent_at` (live-run fix, 2026-09-18: every
   Supabase row had carried 10:00Z). The run date stays the logical day for idempotency keys,
   expiry maths and reply visibility: inbound replies are visible up to `<date>T23:59:59.999Z`.
   The `reports` row is written only by a completed report stage, so a run that fails earlier
   never replaces the day's good report; the dashboard orders by `created_at desc, id desc`.

5b. **Unknown drive time is not "outside".** When the drive-time provider is unavailable (for
   example `ORS_API_KEY` unset), the site keeps `in_search_area: null`, stays in stage
   `enriched`/`verifying`, is still enriched (zoning, flood, traffic, competitors), gated and
   verified, a run warning is recorded, and it is excluded from ranking only (rank null, flag
   "drive time unknown") until a later run learns the distance. `report.json` therefore emits
   `in_search_area: null`; the local contract copy allows `["boolean", "null"]` and the parent
   schema needs the same change. The dashboard shows "Distance unknown" and lists such sites
   with the waiting ones. Fixture sets always carry `drivetime.json`, so golden behaviour is
   unchanged.

6. **Gate statuses are `pass | fail | pending` (s.14.4).** Expired evidence is `pending` with a
   warning, never `pass`. Rent stated on a listing page counts as *written* rent evidence
   (s.14.3); a written reply or form answer supersedes it when both are fresh.

7. **A site that has failed any gate gets no outreach**, and its open cases are closed with
   the reason. Asking a landlord about rent on a parcel where dealer use is prohibited would
   be wasted contact. Matches golden-v1's `no_outreach_parcels`.

8. **Case types are `rent | zoning | space` (s.14.3).** `space` covers the enclosed-office and
   display-capacity questions and opens only when the merged site does not already state
   them. Sublease consent for shared lots is surfaced as a visible flag on the dashboard
   rather than an automatic email (shared lots are `last_resort`; golden-v1 sends nothing
   for PITT-0006).

9. **One email per recipient per site per cycle.** Section 6 forbids contacting the same
   address about the same site twice within `followup_days`; `messages.json` carries one
   `case_type` per message. When a landlord owns both a `rent` and a `space` case, ONE email is
   sent with both approved sections and is recorded under the primary type (`rent` before
   `space`); both cases move to `awaiting_reply` on it. Posted to the board (issue 6).

10. **Viable vs shortlisted.** `viable` = three gates pass (and the shared-lot policy is not
    `exclude`). `shortlisted` additionally requires the NC established-place-of-business
    checks (`office_required`, `min_vehicle_display`) not to be *known to fail*; unknowns are
    flagged, not excluded. `rank` is over viable sites only, shared lots last (s.14.4).

11. **Score normalisation uses fixed bounds** (`score.bounds`: AADT 30k = 1.0, 300 ft
    frontage = 1.0, 10 competitors = 0.0, drive time relative to `max_drive_minutes`, rent
    linearly within the range) rather than min/max across the current candidate set, so a
    site's score does not move when other sites appear. Unknown factors score 0.

12. **Visibility** = frontage share plus a corner-lot bonus (`corner_lot_bonus`), from parcel
    attributes; signage line-of-sight from imagery is recorded as evidence but not scored
    (no reliable free signal).

13. **Flood majority rule.** FEMA NFHL polygons intersecting the parcel are sampled on a
    7x7 grid inside the parcel to compute the high-risk area share; the gate fails when the
    centroid zone is high-risk or the share exceeds `flood.majority_fail_pct` (50%). The
    fixture supplies `pct_area_high_risk` directly.

14. **Crawler default is `fetch`** (plain Node `fetch`), added on the PM's zero-cost constraint:
    nothing to host, no paid API, no Docker. It follows redirects, times out at 15 s, sends a
    polite User-Agent naming the parent repo, executes no JavaScript, checks robots.txt for
    every page (cached per origin) and refuses disallowed paths, then returns the same
    document shape as the AnyCrawl adapters (raw HTML for `raw_documents`, readable text,
    absolute links). `anycrawl` (self-hosted, free) and `anycrawl_cloud` (paid) remain
    selectable. Section 14.1 lists `crawler: anycrawl` as the default and the parent
    `report.schema.json` enum only knows `anycrawl | anycrawl_cloud`; `report.providers.crawler`
    now echoes `fetch`, so the parent enum needs `fetch` added (the local schema copy under
    `tests/contract/` already has it). robots.txt is also checked at the discover stage for
    any source whose `robots_txt` is `unknown`, as before.

14b. **NC OneMap parcels query the polygon layer 1 with an envelope** (live-run bug fix,
    2026-09-18). Verified against the service: `FeatureServer/0` is "Parcels (pts)", so a
    point-intersects query never returns a feature; fields are lowercase (`parno`, `ownname`,
    `siteadd`, `gisacres`, `cntyname`, `scity`) and attribute reads are now case-insensitive;
    the JSON point form returns `[]`, so the adapter queries an envelope of +-0.00025 deg on
    layer 1; the HTTP 400 "Unable to complete operation" was caused by requesting a field
    that does not exist (`munic`), not by `outSR=4326`, which works and is the default.
    Selection among the returned neighbours: the recorded geocode for 2100 Dickinson Ave sits
    in the street right-of-way, which no parcel covers (a centreline-interpolated geocode
    always will), and the nearest polygon by centroid is the city-owned 2099 strip; so an
    exact house-number-and-street match on `siteadd` wins first, then the polygon that
    contains the point, then the nearest polygon edge within 60 m, then a partial address
    match. Fallbacks for the request itself: native-SR geometry (EPSG:2264 NC State Plane
    feet, reprojected in `src/core/proj.ts`; it matches the service's own 4326 output to a
    constant 0.2 m E / 0.8 m N, the NAD83->WGS84 datum shift ArcGIS applies), then attributes
    only with geometry left null. The point form stays available behind
    `options.nc_onemap.point_query_first: true`. Real responses (layer metadata, the five
    Dickinson Ave parcels in both SRs, the empty point-form and layer-0 answers, the 400 for an
    unknown field) are recorded under `fixtures/http/nc_onemap/`. Site jurisdiction falls
    back to the geocoder's city when the parcel layer leaves `scity` empty, as it does here.

14c. **Zoning layers are the verified official ones, queried at the parcel** (live-run fixes,
    2026-09-18). The earlier layer URLs were guesses. `providers.yaml` now lists only layers
    checked against the live services: Greenville `OpenData/MapServer/21` (Greenville_Zoning,
    field `ZONE`) and Pitt County `PittOpenData/ZoningPitt/MapServer/0` (County Zoning, `ZONE`,
    empty inside town limits, tried after the municipality). Winterville, Ayden, Washington,
    Farmville and Kinston publish no ArcGIS zoning layer: they return null with no request, so
    the gate stays pending and a planning case opens. Because Census geocodes sit in the road
    right-of-way (layer 21 returns `[]` at the 2100 Dickinson Ave geocode and `CH` at the parcel
    centroid), the site point is the parcel centroid and zoning is queried with the parcel
    polygon (district with the largest sampled overlap), the centroid when there is no polygon,
    and the geocode only when there is no parcel; flood already used the parcel, and traffic and
    competitors use the centroid. The county parcels fallback now points at Pitt's verified
    `PittOpenData/CadastralPitt/MapServer/0` (`NCPIN` = OneMap `parno`, `OwnerName`,
    `Municipality`, `Acres`). Responses recorded under `fixtures/http/arcgis` and
    `fixtures/http/county`.

14d. **Per-item failures degrade, they do not abort.** A layer failing for one site records a
    warning on that site (`sites.enrich_warnings`, surfaced as report flags and run warnings)
    and leaves that gate pending; score and report still complete and the `reports` row is
    written. `run.errors` (and a non-zero exit) is reserved for a stage failing entirely:
    every enabled source failing to fetch, no listing resolving to a parcel, a stage throwing,
    or the report not being writable. Per-source, per-listing, per-site and per-send failures
    are warnings.

14e. **Source-level leasing contact.** Broker pages rarely carry a per-listing email, so
    `config/sources.yaml` rows take an optional `contact_email` used when the listing has none
    (Ron Harrell's entry carries a blank value for the PM to fill). A site with neither is
    escalated once per case type with a note that names the listing and the fix; when a contact
    appears later the escalated case reopens and the inquiry goes out.

15. **Sources appearing only in `listings.json` are auto-registered** with
    `terms_status: allowed` and a note, because the operator's crawler already fetched them;
    a listing whose `source_id` matches a `prohibited`/`disallowed` row in `sources.yaml` is
    refused and listed under Exceptions.

16. **Planning contacts.** Online, the planning email comes from the zoning layer config or
    `business.yaml jurisdictions`; each entry has a `source_url` (official page) and
    `verified: false` until the deployer re-checks it. The Gmail adapter refuses to send to an
    unverified planning address; the fixture mailbox does not (offline runs never send).

17. **LLM layer.** `rules` (deterministic regex extraction/classification) is the free default
    and what the offline run uses. `claude_agent` runs the same rules and appends
    low-confidence items to `<out>/review-queue.json` for the scheduled Claude Code routine
    to review (the routine itself is the model). `claude_api` (paid) uses the official
    `@anthropic-ai/sdk` with `claude-opus-5` and adaptive thinking, only when
    `paid_enabled: true` and `ANTHROPIC_API_KEY` is set.

18. **Home base geocoding online.** The Census geocoder needs a street address; the dev
    placeholder ("Greenville, NC 27858") is fixture-only. `DEALERSOURCE_HOME_BASE` must be a
    full street address at deploy time, otherwise drive-time enrichment is skipped with a
    warning and sites stay unscored (not silently in-area).

19. **Dashboard reads Supabase via a `reports` table.** Each run stores its contract
    `report.json` (plus the messages sent) as one row; the dashboard fetches the latest row
    with the anon key. RLS grants anon SELECT on reports, sources, sites, parcels, evidence,
    cases, scores, runs and denies listings, raw_documents, messages, contacts. Note: the
    report payload and `sites` include leasing/planning emails so the owner can act; protect
    the Vercel deployment (password or Supabase auth) if that matters.

20. **Dashboard template v2** (`prompts/dashboard-design`, published 2026-09-16, replaces v1
    entirely; everything built on v1 was discarded). `dashboard/public/tokens.css` is the
    template file with only the brand lines changed: `--primary: oklch(0.672 0.131 38.8)`
    (= `#D97757`), `--primary-hover: oklch(0.592 0.131 38.8)` (= `#BE5E3F`, a darker step of
    the same hue), the `.dark` primary/hover as lighter steps of the hue, `--wash-primary` as
    the primary at 6%/7% (the template defines it as exactly that of the blue), and the five
    `--factor-*` shades as the hue at five lightness steps (`0.582`, `0.672`, `0.742`, `0.822`,
    `0.912`, chroma tapering toward the light end as in the original). `fonts.css`, `fonts/`
    and `dashboard.css` are byte-identical copies; fonts are vendored, so no network is needed.
    The design is inline-styled; its styles were moved into classes in
    `dashboard/public/styles.css` and the four views plus the shell are rendered from
    `report.json` / `messages.json` / `run.json` (`dashboard/src/app.ts`). Deviations:
    - **Map basemap.** The sample pages load Esri raster tiles; the spec forbids public tile
      servers for scheduled use, so offline the map pane is the template's muted canvas with
      the rank/pending/excluded markers placed by relative projection and the legend, and
      MapLibre GL with a self-hosted Protomaps archive mounts when `PMTILES_URL` is set
      (globe projection past zoom 4). No home-base marker: the report carries the address only.
    - **Drawer on phone.** The 375px page has no drawer, so it is hidden below 720px; the cards
      carry the same gate, score and case facts.
    - **Exceptions "Failed runs, last 7 days"** shows only the current run: the report holds one
      run. "Provider errors" lists run warnings and the fixture-served layers.
    - **Sources card** lists excluded and failed sources first, then healthy ones with an OK
      pill, as in the sample. Evidence list shows expired and expiring facts first, padded with
      the soonest-expiring fresh facts so the card is never empty.
    - **Run-health banner** turns red when sending is paused or the run reported errors and
      amber when the report is older than 26 hours (measured against the viewer's clock, as in
      the components sheet); the phone strip shows the compact "Report DATE · N emails sent"
      line from the phone page.
    - `report.json` carries extra keys the views need (`open_cases[].opened_at`,
      `followups_sent`, `next_action`, `sites[].listings`, `business.flood_high_risk_zones`,
      `followup_days`, `max_followups`); the contract schema permits additional properties and
      the golden schema test still passes.
    - Non-http evidence sources (stored email replies, fixture files) show "Stored" instead of
      an Open link, since there is nothing to open.
    - Dark theme follows `prefers-color-scheme` (or `?theme=dark|light`); the template has no
      toggle control and none was added.

21. **Manual pause switch.** Section 6 defines automatic pauses only; `mail.paused` /
    `DEALERSOURCE_PAUSE_SENDING=1` adds the operator kill switch the README's
    "how to pause outreach" needs.

22. **Scheduler alternatives** (GitHub Actions, pg_cron) are documented in
    `docs/scheduling.md`; the GitHub Actions workflow is included but `workflow_dispatch`-only
    so nothing runs on push except CI tests.
