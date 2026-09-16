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

5. **Run-date clock.** `--run-date` freezes the clock at `<date>T10:00:00Z` (about 06:00
   Eastern, matching the default cron). Inbound replies are visible up to `<date>T23:59:59.999Z`
   ("received_at <= run-date" read as end of day, so same-day replies count, as golden-v1 needs).

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

14. **Crawler default is self-hosted AnyCrawl** (`crawler: anycrawl`, the section-14.1
    default). robots.txt is checked before fetching a source whose `robots_txt` is `unknown`.

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

20. **Dashboard template.** The shared design template (`prompts/dashboard-design`, published
    2026-09-16) is implemented: `dashboard/public/tokens.css` is the template file with only
    `--accent: #D97757` changed (verified by `diff`), `dashboard.css` is byte-identical, and
    the shell plus the four views reproduce `components.html` and `pages/*.html` markup and
    class names, driven by `report.json` / `messages.json` / `run.json`. Small additions live
    in `dashboard/public/styles.css` (footer clearance, marker button reset, plain-text source
    cell). Deviations, all because the report holds a single run:
    - Exceptions "Sites dropped since last run" renders the empty state: there is no previous
      report to diff against. Two extra sections ("Cases needing a human", "Other run notes")
      surface escalated cases and run errors/warnings that section 9 requires on this view.
    - Config "Search area" is expressed as drive-time from home base (no county list exists).
    - The map has no home-base marker offline: the report carries the address only; MapLibre +
      PMTiles mounts when `PMTILES_URL` is set, otherwise the static preview stays.
    - `report.json` gained extra keys the template needs (`open_cases[].opened_at`,
      `followups_sent`, `next_action`; `business.flood_high_risk_zones`, etc.); the contract
      schema allows additional properties and the golden test still validates.
    - Non-http evidence sources (stored email replies, fixture files) render as plain mono text
      instead of an external link, since there is nothing to open.

21. **Manual pause switch.** Section 6 defines automatic pauses only; `mail.paused` /
    `DEALERSOURCE_PAUSE_SENDING=1` adds the operator kill switch the README's
    "how to pause outreach" needs.

22. **Scheduler alternatives** (GitHub Actions, pg_cron) are documented in
    `docs/scheduling.md`; the GitHub Actions workflow is included but `workflow_dispatch`-only
    so nothing runs on push except CI tests.
