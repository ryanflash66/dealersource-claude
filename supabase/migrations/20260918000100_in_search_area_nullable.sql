-- Unknown drive time is stored as in_search_area = null: the site is gated and verified but not
-- ranked until the distance is known (docs/decisions.md 5b). The live score stage failed with
-- "null value in column in_search_area of relation scores violates not-null constraint";
-- these two statements were applied by hand to the live database on 2026-09-18 and are kept
-- here so fresh deployments match.
alter table public.scores alter column in_search_area drop not null;
alter table public.sites  alter column in_search_area drop not null;
