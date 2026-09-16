import type { ListingRow, ParcelRow, SiteRow } from "../core/types.js";
import { StageCounter, errMsg, touchSite, writeEvidence, type RunContext } from "./context.js";

export const siteIdFor = (parcelId: string) => `site_${parcelId.replace(/[^A-Za-z0-9_-]/g, "_")}`;

/**
 * Stage 2: resolve. Geocodes each new listing, finds its parcel and merges
 * every listing that lands on the same parcel_id into ONE site record.
 * Duplicates never raise confidence; they only add listing_ids.
 */
export async function resolve(ctx: RunContext): Promise<StageCounter> {
  const c = new StageCounter(ctx, "resolve");
  const listings = await ctx.store.list("listings");
  for (const l of listings) {
    if (l.status === "refused") continue;
    if (l.status === "resolved" && l.site_id && (await ctx.store.get("sites", l.site_id))) {
      c.inc("listings_already_resolved");
      continue;
    }
    if (!l.address_text) {
      await markUnresolved(ctx, l, "no address extracted");
      c.inc("listings_unresolved");
      continue;
    }
    try {
      const geo = await ctx.providers.geocoder.geocode(l.address_text);
      if (!geo) {
        await markUnresolved(ctx, l, "geocode: no match");
        c.inc("listings_unresolved");
        continue;
      }
      const parcel = await ctx.providers.parcels.lookup({ lat: geo.lat, lon: geo.lon }, { parcel_id: geo.parcel_id_hint, address: geo.canonical_address });
      if (!parcel) {
        await markUnresolved(ctx, l, "parcel: none found at geocoded point");
        c.inc("listings_unresolved");
        continue;
      }
      const siteId = siteIdFor(parcel.parcel_id);
      const existing = await ctx.store.get("sites", siteId);
      const now = ctx.clock.iso();
      const ex = l.extraction;
      const site: SiteRow = existing
        ? await touchSite(ctx, existing, {
            listing_ids: existing.listing_ids.includes(l.id) ? existing.listing_ids : [...existing.listing_ids, l.id],
            shared_lot: existing.shared_lot || ex.shared_lot === true,
            has_office: existing.has_office ?? ex.has_office,
            vehicle_capacity: Math.max(existing.vehicle_capacity ?? -1, ex.vehicle_capacity ?? -1) >= 0 ? Math.max(existing.vehicle_capacity ?? 0, ex.vehicle_capacity ?? 0) : null,
            contact_email: existing.contact_email ?? ex.contact_email,
            jurisdiction: existing.jurisdiction ?? parcel.jurisdiction,
            county: existing.county ?? parcel.county,
          })
        : {
            id: siteId,
            parcel_id: parcel.parcel_id,
            canonical_address: geo.canonical_address,
            lat: parcel.centroid?.lat ?? geo.lat,
            lon: parcel.centroid?.lon ?? geo.lon,
            jurisdiction: parcel.jurisdiction,
            county: parcel.county,
            planning_email: null,
            stage: "resolved",
            shared_lot: ex.shared_lot === true,
            has_office: ex.has_office,
            vehicle_capacity: ex.vehicle_capacity,
            contact_email: ex.contact_email,
            listing_ids: [l.id],
            drive_minutes: null,
            in_search_area: null,
            created_at: now,
            updated_at: now,
          };
      if (!existing) await ctx.store.upsert("sites", [site]);

      const parcelRow: ParcelRow = {
        id: parcel.parcel_id,
        site_id: siteId,
        owner: parcel.owner,
        acreage: parcel.acreage,
        geometry: parcel.geometry,
        frontage_ft: parcel.frontage_ft,
        corner_lot: parcel.corner_lot,
        fronting_road: parcel.fronting_road,
        jurisdiction: parcel.jurisdiction,
        county: parcel.county,
        source_url: parcel.source_url,
        fetched_at: now,
      };
      await ctx.store.upsert("parcels", [parcelRow]);

      await writeEvidence(ctx, {
        site_id: siteId,
        fact: "geocode",
        value: { lat: geo.lat, lon: geo.lon, formatted_address: geo.canonical_address, provider: ctx.providers.geocoder.name, listing_id: l.id },
        source_url: geo.source_url,
        method: "api",
      });
      await writeEvidence(ctx, {
        site_id: siteId,
        fact: "parcel",
        value: { parcel_id: parcel.parcel_id, owner: parcel.owner, acres: parcel.acreage, provider: ctx.providers.parcels.name },
        source_url: parcel.source_url,
        method: "layer",
      });

      await ctx.store.upsert("listings", [{ ...l, site_id: siteId, status: "resolved", status_detail: null }]);
      c.inc(existing ? "listings_merged" : "sites_created");
    } catch (e) {
      await markUnresolved(ctx, l, `error: ${errMsg(e)}`);
      c.error(`listing ${l.id}: ${errMsg(e)}`, { listing: l.id });
    }
  }
  return c;
}

async function markUnresolved(ctx: RunContext, l: ListingRow, detail: string): Promise<void> {
  await ctx.store.upsert("listings", [{ ...l, status: "unresolved", status_detail: detail }]);
}
