-- Live-run fixes (docs/decisions.md 14c-14e):
--   * sources.contact_email: source-level leasing contact from config/sources.yaml, used when a
--     listing publishes no email (blank = PM still has to fill it in).
--   * sites.enrich_warnings: per-site enrichment failures (one layer unavailable) recorded as
--     warnings instead of aborting the run; surfaced as report flags.
alter table sources add column if not exists contact_email text;

alter table sites add column if not exists enrich_warnings jsonb not null default '[]'::jsonb;
alter table sites drop constraint if exists sites_enrich_warnings_is_array;
alter table sites add constraint sites_enrich_warnings_is_array check (jsonb_typeof(enrich_warnings) = 'array');
