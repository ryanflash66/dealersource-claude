import type { ListingRow, SiteRow } from "../core/types.js";
import { centroid as polyCentroid } from "../core/geo.js";
import { StageCounter, currentEvidence, errMsg, touchSite, writeEvidence, type RunContext } from "./context.js";

/**
 * Stage 3: enrich. For every resolved site: drive time (search-area test),
 * zoning layer + use table, flood, traffic, competitors, imagery, and the
 * facts stated on the listing itself (rent, office, capacity). Each fact is
 * fetched only when no fresh evidence exists, so re-runs are cheap.
 */
export async function enrich(ctx: RunContext): Promise<StageCounter> {
  const c = new StageCounter(ctx, "enrich");
  const sites = await ctx.store.list("sites");
  const listings = await ctx.store.list("listings");
  for (let site of sites) {
    const hints = { parcel_id: site.parcel_id, county: site.county, address: site.canonical_address };
    const point = { lat: site.lat, lon: site.lon };
    try {
      // --- drive time / search area ---------------------------------------
      let drive = await currentEvidence(ctx, site.id, "drive_minutes");
      if (!drive) {
        try {
          const r = await ctx.providers.drivetime.driveMinutes(ctx.homeBase ?? point, point, hints);
          drive = await writeEvidence(ctx, {
            site_id: site.id,
            fact: "drive_minutes",
            value: { minutes: r.minutes, from: ctx.config.business.search.home_base, provider: ctx.providers.drivetime.name },
            source_url: r.source_url,
            method: "api",
          });
          c.inc("drivetime_fetched");
        } catch (e) {
          // Unknown is not "outside": keep gating, flag it, and leave ranking until the distance is known.
          c.inc("drivetime_unavailable");
          const msg = `drive time unavailable for ${site.id} (${site.canonical_address}): ${errMsg(e)}; gated but not ranked`;
          if (!ctx.run.warnings.includes(msg)) ctx.run.warnings.push(msg);
          ctx.logger.warn("drive time unavailable", { site: site.id, error: errMsg(e) });
        }
      }
      if (drive) {
        const minutes = (drive.value as { minutes: number }).minutes;
        const inArea = minutes <= ctx.config.business.search.max_drive_minutes;
        site = await touchSite(ctx, site, { drive_minutes: minutes, in_search_area: inArea, stage: inArea ? "enriched" : "out_of_area" });
        if (!inArea) {
          c.inc("sites_out_of_area");
          continue;
        }
      } else {
        site = await touchSite(ctx, site, { drive_minutes: null, in_search_area: null, stage: "enriched" });
      }

      // --- listing-stated facts (written statements, source = listing URL) ---
      const mine = listings.filter((l) => site.listing_ids.includes(l.id));
      await listingFacts(ctx, c, site, mine);

      // --- zoning ----------------------------------------------------------
      if (!(await currentEvidence(ctx, site.id, "zoning_district"))) {
        const z = await ctx.providers.zoning.lookup(point, site.jurisdiction, hints);
        if (z) {
          await writeEvidence(ctx, {
            site_id: site.id,
            fact: "zoning_district",
            value: { district: z.district, jurisdiction: z.jurisdiction, dealer_use: z.dealer_use ?? "unknown" },
            source_url: z.source_url,
            method: "layer",
          });
          const planning = z.planning_email ?? planningEmailFor(ctx, z.jurisdiction);
          site = await touchSite(ctx, site, { jurisdiction: z.jurisdiction, planning_email: planning });
          if ((z.dealer_use === "permitted" && z.citation) || z.dealer_use === "prohibited") {
            await writeEvidence(ctx, {
              site_id: site.id,
              fact: "zoning_permitted",
              value: { status: z.dealer_use, district: z.district, citation: z.citation, jurisdiction: z.jurisdiction },
              source_url: z.use_table_url ?? z.source_url,
              method: "layer+use_table",
            });
            c.inc(z.dealer_use === "permitted" ? "zoning_permitted_by_table" : "zoning_prohibited_by_table");
          } else {
            c.inc("zoning_needs_planning_case");
          }
        } else {
          const planning = planningEmailFor(ctx, site.jurisdiction);
          if (planning && !site.planning_email) site = await touchSite(ctx, site, { planning_email: planning });
          c.inc("zoning_no_layer");
        }
      }

      // --- flood ----------------------------------------------------------
      if (!(await currentEvidence(ctx, site.id, "flood_zone"))) {
        const parcel = await ctx.store.get("parcels", site.parcel_id);
        const cen = parcel?.geometry ? polyCentroid(parcel.geometry) : point;
        const f = await ctx.providers.flood.zonesFor(parcel?.geometry ?? null, cen, ctx.config.business.flood.high_risk_zones, hints);
        await writeEvidence(ctx, {
          site_id: site.id,
          fact: "flood_zone",
          value: { zone: f.zone, pct_area_high_risk: f.pct_area_high_risk, zone_shares: f.zone_shares },
          source_url: f.source_url,
          method: "layer",
        });
        c.inc("flood_fetched");
      }

      // --- traffic --------------------------------------------------------
      if (!(await currentEvidence(ctx, site.id, "traffic_aadt"))) {
        const t = await ctx.providers.traffic.aadtNear(point, hints);
        if (t) {
          await writeEvidence(ctx, {
            site_id: site.id,
            fact: "traffic_aadt",
            value: { aadt: t.aadt, road: t.road, year: t.year },
            source_url: t.source_url,
            method: "layer",
          });
          c.inc("traffic_fetched");
        } else c.inc("traffic_missing");
      }

      // --- competitors ----------------------------------------------------
      if (!(await currentEvidence(ctx, site.id, "competitor_count"))) {
        const p = await ctx.providers.poi.dealersWithin(point, ctx.config.business.competitors.radius_m, hints);
        await writeEvidence(ctx, {
          site_id: site.id,
          fact: "competitor_count",
          value: { count: p.count, radius_m: p.radius_m },
          source_url: p.source_url,
          method: "api",
        });
        c.inc("competitors_fetched");
      }

      // --- imagery ----------------------------------------------------------
      if (!(await currentEvidence(ctx, site.id, "imagery"))) {
        const im = await ctx.providers.imagery.nearby(point, hints);
        await writeEvidence(ctx, {
          site_id: site.id,
          fact: "imagery",
          value: { images: im.images, provider: ctx.providers.imagery.name },
          source_url: im.source_url,
          method: "api",
        });
        c.inc("imagery_fetched");
      }
      c.inc("sites_enriched");
    } catch (e) {
      c.error(`site ${site.id}: ${errMsg(e)}`, { site: site.id });
    }
  }
  return c;
}

/** Facts stated in writing on a listing page. Rent here is written rent evidence (spec 14.3). */
async function listingFacts(ctx: RunContext, c: StageCounter, site: SiteRow, listings: ListingRow[]): Promise<void> {
  const byTime = [...listings].sort((a, b) => b.fetched_at.localeCompare(a.fetched_at));
  const rentSrc = byTime.find((l) => l.extraction.rent_monthly !== null);
  if (rentSrc && !(await currentEvidence(ctx, site.id, "rent_monthly"))) {
    await writeEvidence(ctx, {
      site_id: site.id,
      fact: "rent_monthly",
      value: { rent_monthly: rentSrc.extraction.rent_monthly, listing_id: rentSrc.id },
      source_url: rentSrc.url,
      method: "listing",
      fetched_at: rentSrc.fetched_at,
    });
    c.inc("rent_from_listing");
  }
  const officeSrc = byTime.find((l) => l.extraction.has_office !== null);
  if (officeSrc && !(await currentEvidence(ctx, site.id, "office"))) {
    await writeEvidence(ctx, {
      site_id: site.id,
      fact: "office",
      value: { has_office: officeSrc.extraction.has_office, listing_id: officeSrc.id },
      source_url: officeSrc.url,
      method: "listing",
      fetched_at: officeSrc.fetched_at,
    });
  }
  const capSrc = byTime.find((l) => l.extraction.vehicle_capacity !== null);
  if (capSrc && !(await currentEvidence(ctx, site.id, "vehicle_display"))) {
    await writeEvidence(ctx, {
      site_id: site.id,
      fact: "vehicle_display",
      value: { vehicle_capacity: capSrc.extraction.vehicle_capacity, listing_id: capSrc.id },
      source_url: capSrc.url,
      method: "listing",
      fetched_at: capSrc.fetched_at,
    });
  }
}

/** Planning email from business.yaml, matched loosely on the jurisdiction name ("City of Greenville" -> Greenville). */
export function planningEmailFor(ctx: RunContext, jurisdiction: string | null): string | null {
  if (!jurisdiction) return null;
  const j = jurisdiction.toLowerCase();
  const hit = Object.entries(ctx.config.business.jurisdictions).find(([name]) => j.includes(name.toLowerCase()));
  return hit?.[1].planning_email ?? null;
}
