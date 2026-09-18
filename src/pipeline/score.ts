import type { ScoreRow } from "../core/types.js";
import { evaluateGates, requirements } from "./gates.js";
import { rankViable, scoreSite } from "./scoring.js";
import { StageCounter, allEvidence, currentEvidence, touchSite, type RunContext } from "./context.js";

/**
 * Stage 5: score. Gates -> viable -> weighted score -> rank (viable sites
 * inside the search area only, shared-lot last). Sites confirmed outside the
 * area get a row with pending gates and no score; sites whose drive time is
 * unknown are gated and scored but not ranked until the distance is known.
 */
export async function score(ctx: RunContext): Promise<StageCounter> {
  const c = new StageCounter(ctx, "score");
  const b = ctx.config.business;
  const now = ctx.clock.iso();
  const rows: ScoreRow[] = [];

  for (const site of await ctx.store.list("sites")) {
    if (site.in_search_area === false) {
      rows.push({
        id: site.id,
        site_id: site.id,
        run_id: ctx.run.id,
        in_search_area: false,
        viable: false,
        shortlisted: false,
        shared_lot: site.shared_lot,
        gates: {
          zoning: { gate: "zoning", status: "pending", evidence_ids: [], detail: "not evaluated: outside search area", warning: null },
          rent: { gate: "rent", status: "pending", evidence_ids: [], detail: "not evaluated: outside search area", warning: null },
          flood: { gate: "flood", status: "pending", evidence_ids: [], detail: "not evaluated: outside search area", warning: null },
        },
        requirements: [],
        factors: [],
        metrics: { aadt: null, visibility: null, drive_minutes: site.drive_minutes, rent_monthly: null, competitors: null },
        total: null,
        rank: null,
        flags: [`outside ${b.search.max_drive_minutes}-minute search area`],
        computed_at: now,
      });
      c.inc("sites_not_scored");
      continue;
    }

    const gates = evaluateGates(b, {
      now,
      zoning: await allEvidence(ctx, site.id, "zoning_permitted"),
      rent: await allEvidence(ctx, site.id, "rent_monthly"),
      flood: await allEvidence(ctx, site.id, "flood_zone"),
    });
    const reqs = requirements(b, site);
    const flags: string[] = [];
    for (const g of Object.values(gates)) if (g.warning) flags.push(`${g.gate}: ${g.warning}`);
    if (site.shared_lot) flags.push(`shared lot (${b.site.shared_lot})`);
    for (const r of reqs) if (r.outcome !== "met") flags.push(`${r.name}: ${r.detail}`);
    for (const w of site.enrich_warnings ?? []) flags.push(w);
    const distanceUnknown = site.in_search_area === null;
    if (distanceUnknown) flags.push("drive time unknown: gated but not ranked until the distance is known");

    const gatesPass = Object.values(gates).every((g) => g.status === "pass");
    const viable = gatesPass && !(site.shared_lot && b.site.shared_lot === "exclude");
    const shortlisted = viable && !distanceUnknown && reqs.every((r) => r.outcome !== "not_met");

    const parcel = await ctx.store.get("parcels", site.parcel_id);
    const traffic = (await currentEvidence(ctx, site.id, "traffic_aadt"))?.value as { aadt: number } | undefined;
    const comp = (await currentEvidence(ctx, site.id, "competitor_count"))?.value as { count: number } | undefined;
    const rentEv = gates.rent.evidence_ids[0] ? await ctx.store.get("evidence", gates.rent.evidence_ids[0]) : undefined;
    const rent = (rentEv?.value as { rent_monthly?: number } | undefined)?.rent_monthly ?? null;
    const s = scoreSite(b, {
      aadt: traffic?.aadt ?? null,
      frontage_ft: parcel?.frontage_ft ?? null,
      corner_lot: parcel?.corner_lot ?? null,
      drive_minutes: site.drive_minutes,
      rent_monthly: rent,
      competitors: comp?.count ?? null,
    });

    rows.push({
      id: site.id,
      site_id: site.id,
      run_id: ctx.run.id,
      in_search_area: site.in_search_area,
      viable,
      shortlisted,
      shared_lot: site.shared_lot,
      gates,
      requirements: reqs,
      factors: s.factors,
      metrics: s.metrics,
      total: s.total,
      rank: null,
      flags,
      computed_at: now,
    });
    await touchSite(ctx, site, { stage: distanceUnknown ? "verifying" : "scored" });
    c.inc(viable ? (distanceUnknown ? "sites_viable_unranked" : "sites_viable") : "sites_not_viable");
  }

  const ranks = rankViable(
    rows.filter((r) => r.viable && r.in_search_area === true).map((r) => ({ site_id: r.site_id, total: r.total ?? 0, shared_lot: r.shared_lot })),
  );
  for (const r of rows) r.rank = ranks.get(r.site_id) ?? null;
  await ctx.store.upsert("scores", rows);
  return c;
}
