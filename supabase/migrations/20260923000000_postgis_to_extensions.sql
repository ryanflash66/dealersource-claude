-- Move PostGIS out of the API-exposed `public` schema (Supabase security advisor
-- lints 0013 rls_disabled_in_public on spatial_ref_sys, 0014 extension_in_public,
-- 0028/0029 st_estimatedextent callable by anon).
--
-- Why: installed in `public`, PostGIS's spatial_ref_sys was readable AND writable
-- by `anon` and `authenticated` through PostgREST (grants made by supabase_admin,
-- which the project's postgres role cannot revoke; RLS cannot be enabled because
-- the table is not ours). Anyone holding the public anon key could delete or
-- rewrite coordinate-system rows and break every geometry/geography operation.
--
-- How: PostGIS is not relocatable, so drop and re-create it in `extensions`
-- (not exposed by PostgREST, already on Supabase's search_path). The only
-- dependents are the trigger-derived columns sites.geom and parcels.geom and
-- their GiST indexes; they are re-added and recomputed from lat/lon and the
-- stored GeoJSON by the existing triggers, whose search_path already includes
-- `extensions`. No app code reads geom.
--
-- Guarded: runs only when PostGIS sits in `public` and an `extensions` schema
-- exists (hosted Supabase). A fresh local Docker stack is left unchanged.
do $$
begin
  if exists (
       select 1 from pg_extension e join pg_namespace n on n.oid = e.extnamespace
        where e.extname = 'postgis' and n.nspname = 'public')
     and exists (select 1 from pg_namespace where nspname = 'extensions') then

    drop extension postgis cascade;           -- drops sites.geom, parcels.geom and their indexes
    create extension postgis with schema extensions;

    alter table public.sites   add column if not exists geom extensions.geometry(Point, 4326);
    alter table public.parcels add column if not exists geom extensions.geometry(Polygon, 4326);
    create index if not exists sites_geom_gix   on public.sites   using gist (geom);
    create index if not exists parcels_geom_gix on public.parcels using gist (geom);

    -- Recompute through the BEFORE UPDATE triggers.
    update public.sites   set lat = lat;
    update public.parcels set geometry = geometry;
  end if;
end
$$;
