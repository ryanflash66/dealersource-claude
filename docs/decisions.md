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

14f. **Traffic comes from NCDOT's ArcGIS Online AADT layers, matched to the site's street** (live-run
    fix, 2026-09-18). The `gis11.services.ncdot.gov` URL answered "Service not found". The official
    layers (owner TrafficSurvey.NCDOT.GOV) are point layers whose `AADT_YYYY` columns are strings
    with `" "` for uncounted years, so the adapter takes the latest non-blank year per station and
    parses it. Default is the 2024 release (`NCDOT__2024_AADT_Stations_published_September_2025`,
    `AADT_2002..AADT_2024`, road text in `Location`); the older `NCDOT_AADT_Stations` service (through
    `AADT_2022`, `ROUTE` + `LOCATION`) is `fallback_url` and is queried when the primary errors. At the
    2100 Dickinson Ave centroid the nearest station (45 m) is on Line Ave; the adapter prefers a
    station whose road matches the parcel's fronting road or the address street after normalising
    `AVE/AV/AVENUE`, `BV/BLVD` and stripping `SR 1598 (` designations, so Dickinson Ave (85 m,
    8,700 in 2024) is reported; nearest wins only without a road match. Search radius 600 m.

14g. **Overpass: 60 s, one retry, ordered instance list.** Competitor lookups aborted at the 30 s
    HTTP timeout while the QL asked for 25 s, and the public instance returned 504 for a whole
    afternoon. `timeout_s` (default 60) sets the QL `[timeout:N]` and the HTTP timeout is N + 30 s.
    `OVERPASS_URL` is one URL or a comma-separated list tried in order (default: overpass-api.de,
    then overpass.kumi.systems); each instance is retried once on 429/502/503/504, an abort or a
    connection error, and a 200 with a "timed out" remark counts as a failure. Only when every
    instance failed does the adapter throw, which enrich records as a per-site warning (14d).

14h. **`in_search_area` is nullable in SQL.** Decision 5b made unknown distance `null`; the live
    `scores` table still had `not null`. Migration `20260918000100` drops it on `scores` and `sites`
    (already applied by hand to the live database); a unit test asserts the migration text.

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

20. **Dashboard template v2** (superseded by 29 on 2026-09-23) (`prompts/dashboard-design`, published 2026-09-16, replaces v1
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
    - **Map basemap** (superseded by 30). The sample pages load Esri raster tiles; the spec forbids public tile
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

23. **NC place-of-business minimums: the law sets an office, not a car count** (verified
    2026-09-22). G.S. 20-286(6) requires an established salesroom with "at least 96 square
    feet of floor space in a permanent enclosed building" and a sign with block letters at
    least three inches tall naming the business; rule 19A NCAC 03D .0216 adds that the
    building must be separate from any residence, with its own entrance. Neither the
    statute (20-286, 20-288, 20-292), the rules (.0216, .0217) nor the Highway Patrol's
    current checklist (ISU-415, Rev. 02/26) sets a minimum number of display vehicles,
    posted hours, or a retail phone line. So there are two different kinds of number:
    - **Statutory** (`dealer.place_of_business_checks`): the office check is a viability
      condition. A site known to have no office is excluded (`viable: false`, no outreach);
      unknown stays pending and the 96 sq ft question rides in the space email.
      `display_area_min_vehicles` is `null` because no legal minimum exists; if one is ever
      set above zero, `vehicle_display_statutory` becomes a viability check the same way.
    - **Operator preference** (`site.min_vehicle_display: 2`, `site.office_required`): the
      owner's own floor for a useful lot, including shared lots. It affects the shortlist,
      not viability, as before.
    The sign is not evaluable from a listing (any tenant can put one up) and stays a
    checklist item for the owner. Shared lots carry a flag citing .0216 ("vehicles displayed
    are separate and apart from vehicles of any other dealer"). Office size is asked but not
    parsed: a listing or reply confirming an office counts as met, and the Highway Patrol's
    site inspection is the final check.

24. **Mail preflight and outbox preview.** Every online run logs in to the mail servers
    first, sending nothing, so broken credentials show up while sending is still paused
    (since decision 25: SMTP and IMAP logins; either failing pauses sending). While paused, the
    exact messages that would have gone out (same render, same recipients) are written to
    `out/<date>/outbox-preview.md` and `.json`, git-ignored, never part of the contract.

25. **Gmail over SMTP + IMAP with an app password, not the Gmail API** (2026-09-22, PM
    decision). The owner's personal Gmail sends a handful of messages a day, far under
    Gmail's limits, so the Gmail API's Google Cloud project, OAuth consent screen and
    refresh token bought nothing but setup friction. The adapter now sends through
    `smtp.gmail.com:465` with nodemailer and reads replies from `imap.gmail.com:993` with
    imapflow (both implicit TLS, both MIT-licensed), logged in as `GMAIL_SENDER_ADDRESS` with
    `GMAIL_APP_PASSWORD`. `GMAIL_CLIENT_ID`, `GMAIL_CLIENT_SECRET` and `GMAIL_REFRESH_TOKEN` are
    gone. Unchanged: the `MailProvider` interface, `[DS-XXXXXX]` subject routing, Reply-To =
    sender, bounce detection, the pause switch, the refusal to mail unverified planning
    addresses, and the offline fixture mailbox. Details:
    - Replies are read from the `\All` special-use folder (All Mail), so a reply the owner
      archives is still seen; our own sent copies there are skipped. INBOX is the fallback.
    - A real Gmail bounce carries our subject only inside the returned headers, so for
      bounces without a token in the subject the token is taken from the body or source.
    - A 421/452/454 reply or `5.4.5` / "limit exceeded" maps to `GmailQuotaError`, which
      pauses sending, as the API's 429/403 did.
    - The preflight logs in to both servers every online run. SMTP failing means nothing can
      be sent; IMAP failing means replies, including "stop", would go unseen while follow-ups
      continue. Either pauses sending for that run.
    - The app password is only passed to the two logins, both libraries run with logging off,
      and any error text is scrubbed of it before it reaches a log or the report.
    - nodemailer and imapflow are imported lazily, so offline and fixture runs never load them
      and cannot open a socket; offline without injected transports the adapter refuses.

26. **Playwright for JavaScript-rendered sources, per source, not as the default** (2026-09-22,
    PM decision). Some listing sites build their pages in the browser, so the plain fetch
    crawler sees an empty shell. A local headless Chromium through Playwright (Apache-2.0)
    renders them for $0 with nothing hosted and no Docker. It is opt-in per source
    (`render: js` in `config/sources.yaml`); `fetch` stays the default and every other
    source is unchanged. Politeness is the same as fetch: the same User-Agent, robots.txt
    checked (cached per origin) for the page and for every document/XHR/fetch request the
    page makes, a 5 s minimum between page loads on one origin, and images, fonts and media
    never downloaded. The browser starts lazily and is closed at the end of discovery.
    Offline runs are wired to the fixture crawler, so the contract evaluation can never
    launch a browser. `render` lives only in config (read at discovery time), so no
    database migration. First source: Rofo, re-checked the same day (robots.txt allows all;
    no automated-access clause in its terms). Rofo has since pivoted to location briefs:
    Greenville is not in its sitemap and the configured URL served the generic landing
    content that day, so little or nothing is expected from it. The flag stays as the
    switch for the next JavaScript-heavy broker site.

27. **One leasing email per contact, split replies per property** (2026-09-22, PM decision).
    A broker listing several of our candidate properties used to get one email per property
    at the same moment. Now, with `mail.combine_leasing: true`, all of a leasing contact's
    properties go in one email (first contacts and follow-ups separately): the properties
    numbered "1. <address>", the approved questions once ("For each property:"), and a
    request to answer per number. Planning questions stay one email per parcel, because
    planners answer per parcel. Each property still gets its own message record (same
    email, same thread token), so follow-up windows, the dashboard and `messages.json` stay
    per site; `verify.emails_sent` counts physical emails. A reply is split back per property
    by the number used ("1:", "#2", "Property 3") or the street named; a block is classified
    and applied only to its property. A bounce or a stop request covers all of them. A reply
    that cannot be split at all ("both are $900") goes to a person; a property the reply does
    not mention stays open and the next follow-up asks again.
    Fixed at the same time: replies were classified including the quoted original, which
    contains our own questions and the line 'Reply "stop" if you would prefer not to hear from
    me', so an ordinary reply that quoted us could have been read as a stop request. Quoted
    text ("On ... wrote:", "> " lines, Outlook headers) is now removed before classifying.

28. **LoopNet and Crexi through saved-search alert emails, not crawling** (2026-09-22, PM
    direction). Most commercial listings in the area sit on LoopNet and Crexi, and both
    forbid crawling, so the `loopnet` and `crexi` crawl sources stay refused. Instead the
    owner saves a search on each site and turns on email alerts to their Gmail; the new
    source kind `email_alert` (`loopnet-alerts`, `crexi-alerts`) reads those emails over IMAP
    with the same app password as outreach. Nothing is requested from either site. Details:
    - `alert_from` holds the sender domains (subdomains match: `e.loopnet.com` is
      `loopnet.com`); mail from the owner's own address is skipped. The window is
      `mail.inbound_lookback_days`, re-read every run; listings are keyed by source and
      address, so the same property in several alerts is one listing and the newest alert's
      facts win.
    - The alert layouts are not published, so cutting an email into listings is structural,
      not per sender: in HTML, a card is the largest element holding exactly one NC street
      address and at most one listing link; flat blocks and plain-text alerts are cut at the
      blank or rule lines between addresses, and the last card stops at the footer. Each card
      goes through the configured listing extractor, as a crawled page block would.
    - Links: a direct listing link, or a target embedded in a tracking link (query, path,
      percent-encoded or base64), is kept without query or fragment. Opaque tracking links
      are dropped, never followed, since following one is a request to the site. A card
      without a readable link points to the alert in the owner's Gmail instead.
    - Rent from a card is conservative because it feeds a hard gate: an explicit "$X/mo",
      or an explicit yearly total of $1,200 or more divided by 12. "$12/SF/YR" style rates
      stay unknown and go to the leasing question; a card stating two different monthly
      prices keeps none. Addresses at the alert's own domains, at costar.com, the owner's own
      address and no-reply addresses are never taken as a leasing contact. Alerts rarely name
      the broker's email, so most of these listings will show "no leasing contact" until the
      owner adds one as a manual lead for the same address.
    - Every alert is kept as a raw document (never exposed to anon), so the parser can be
      checked against the first real alerts; `discover.alert_emails_without_listings` and
      `discover.alert_cards_without_address` count what did not parse.
    - Without Gmail credentials the sources are recorded as skipped, not as errors.
    - The database's `sources_kind_check` constraint gains `email_alert` (migration
      `20260923000100`).

29. **Dashboard restyled on the Modernize admin template** (2026-09-23, PM direction;
    supersedes the look in 20, keeps its views and data behaviour). The PM supplied the
    Modernize Next.js Free template (AdminMart, MIT; MUI + Next.js). Its layout, palette,
    typography and components are rebuilt in the existing plain TypeScript + CSS dashboard
    rather than porting to Next.js/MUI: a port would add React, MUI, Emotion and Next to a
    pipeline repo, change the Vercel build, and `next/font/google` fetches fonts at build
    time, breaking the offline `dashboard:build` the evaluator and README require.
    - Shell = the template's DashboardLayout: 270px sidebar (logo, Home / Operations /
      Settings subheaders, Tabler icons, Exceptions badge, a run-status card in place of the
      "Upgrade" card) that becomes a drawer below 1200px, a 70px sticky header (menu, bell
      to Exceptions with a dot, view name, report and run-status chips), 1200px container.
    - Every section is a DashboardCard (7px radius, elevation-9 shadow, h5 title and
      subtitle). Shortlist: run-health alert, four stat cards, ranked and waiting lists beside
      a sticky map card and a site-detail card. Pipeline: stages as the template's coloured
      top cards, a sites table, open cases, and emails sent as the RecentTransactions
      timeline.
    - `tokens.css` holds the template palette (`DefaultColors.tsx`: primary `#5D87FF`,
      text `#2A3547` / `#5A6A85`, divider `#e5eaef`) plus a dark set on Modernize's dark
      palette. Status text uses darker steps of the template hues (`#007B66`, `#8A5A00`,
      `#B93A14`) because the template's own success/warning/error colours fail WCAG AA as
      small text; the filled nav item uses `#3F6AE0` for the same reason. The terracotta
      agent accent from 20 is retired.
    - Plus Jakarta Sans (the template's face) is vendored as latin woff2 from
      `@fontsource/plus-jakarta-sans` (OFL, `fonts/OFL.txt`); Hanken Grotesk, IBM Plex Mono
      and `dashboard.css` are removed. Parcel ids use the system monospace stack.
    - The site detail is now a card, not a drawer over the map, and it also shows on phones
      (below the lists; tapping a site scrolls to it). The drawer's close button is gone:
      closing re-selected the first ranked site, so it never closed anything.
    - Fixed while restyling: the detail card's street-photo slot collapsed because `.photo`
      carried a grid-area the photo grid does not define.
    - Light is the default theme, as in the template, whatever the OS setting (PM request);
      the dark set is kept behind `?theme=dark`. This replaces the `prefers-color-scheme`
      behaviour noted in 20.

30. **Real basemap, bundled with the dashboard** (2026-09-23, PM request: the map showed no
    map). Nothing was broken: the map only drew tiles when `PMTILES_URL` pointed at a
    self-hosted archive, none was ever hosted, so every build showed the relative site plot.
    - `dashboard/public/tiles/eastern-nc.pmtiles`: `pmtiles extract` of the Protomaps build
      `20260923` (tiles v4.15.2) for bbox `-78.45,34.74,-76.30,36.48` (Greenville ± ~60 miles,
      the search area) at zoom 0-14, 46 MB. Zoom 15 would be 91 MB, over GitHub's 50 MB
      warning; MapLibre overzooms zoom-14 tiles well enough for street level. Committed to the
      repo and served by Vercel with the dashboard; Vercel returns 206 for byte ranges.
    - MapLibre GL 6, the PMTiles reader and the Protomaps style (`@protomaps/basemaps` 5,
      light flavour, dark with `?theme=dark`) are devDependencies copied to
      `dashboard/public/vendor/` at build time; the Noto Sans Latin glyph ranges and the v4
      sprites are vendored under `dashboard/public/map/` (sources and licences in its
      `NOTICE.md`). The unpkg script loads are gone, so the map needs no outside host and
      also works in an offline build. `PMTILES_URL` still overrides the archive.
    - The MapLibre map is created once and its container re-attached on every render, so
      picking a site no longer rebuilds the WebGL map or resets the view; the map eases to
      the selected site only when it is out of view. Rotation is off; bounds are limited to
      the archive's area.
    - `serve-dashboard.mjs` answers single byte-range requests so `npm run dashboard:dev`
      shows the map too.
    - `tests/unit/dashboard-map.test.ts` fails if the dashboard references a public tile or
      CDN host, or if the archive, glyphs or sprites go missing.

31. **Tooltips and a first-run guided tour** (2026-09-24, PM request). Hand-rolled, no library:
    `render()` rebuilds the whole page on every click, so a tour library anchored to DOM nodes
    would lose its target each time, and the dashboard stays dependency-free and offline.
    - `dashboard/src/tooltip.ts`: one delegated listener set and one bubble on `<body>` show any
      `data-tip` on hover (350 ms), keyboard focus (`:focus-visible`) or a tap on non-controls;
      `data-trunc` shows an ellipsized text in full only when it is cut off. It replaced every
      native `title`. Tips never hold the only copy of a fact: gate details are in the site
      card, and the score bars carry an `aria-label` summary.
    - `dashboard/src/tour.ts` draws the tour outside `#app`: an SVG scrim with an even-odd hole
      over the target (clicks outside the hole are blocked, the page still scrolls), a ring, and a
      card placed by the pure math in `place.ts` (a bottom or top sheet on phones). Steps and
      rules are pure data in `tour-steps.ts`: 12 steps over all four views, 5 of them actions
      (open a site, click a map pin, open Pipeline, Exceptions and Configuration) whose Next
      stays `aria-disabled` until done. Targets are `data-tour` keys re-resolved after every
      render; `app.ts` fires `ds:render`, `ds:select` (card or marker) and `ds:view`.
      Leaving the step's page shows a paused card with "Back to the tour". Missing targets skip
      an info step or waive an action; no sites skips the site steps.
    - Waiting ("One answer away") cards became selectable like ranked ones: the live report had
      no ranked site, so there was nothing to click, and the detail card already covers them.
    - First run: offered once per browser after the first successful render. `localStorage`
      key `ds.tour` = `done:1` or `skipped:1`; bumping `TOUR_VERSION` re-offers it. Never
      auto-offered when storage is unavailable (it would reappear on every load). `?tour=1`
      forces it, `?tour=0` turns it off. Replay from the header `?` or the sidebar link.
      Escape closes the menu drawer first, then ends the tour.
    - `tests/unit/dashboard-tour.test.ts` covers the positioning math, step rules and text,
      the auto-start table, that every step target exists in `app.ts`, no native `title`
      tooltips, the three events, and no package imports in `dashboard/src`.
