import type { FactorScore, SiteMetrics } from "../core/types.js";
import type { BusinessConfig } from "../config/schema.js";

export interface ScoreInputs {
  aadt: number | null;
  frontage_ft: number | null;
  corner_lot: boolean | null;
  drive_minutes: number | null;
  rent_monthly: number | null;
  competitors: number | null;
}

const clamp01 = (x: number) => Math.max(0, Math.min(1, x));

/** Visibility 0..1: frontage share plus a corner-lot bonus. */
export function visibilityScore(b: BusinessConfig, frontageFt: number | null, corner: boolean | null): number | null {
  if (frontageFt === null && corner === null) return null;
  const bonus = b.score.bounds.corner_lot_bonus;
  const frontage = frontageFt === null ? 0.5 : clamp01(frontageFt / b.score.bounds.frontage_ft_max);
  return clamp01(frontage * (1 - bonus) + (corner ? bonus : 0));
}

/**
 * Weighted score (spec section 3). Every factor is normalised to 0..1 with the
 * config bounds; unknown factors score 0 so missing data never helps a site.
 */
export function scoreSite(b: BusinessConfig, inp: ScoreInputs): { factors: FactorScore[]; total: number; metrics: SiteMetrics } {
  const w = b.score.weights;
  const sum = w.traffic + w.visibility + w.distance + w.rent + w.competitors || 1;
  const norm = (x: number) => x / sum;
  const vis = visibilityScore(b, inp.frontage_ft, inp.corner_lot);
  const rentSpan = Math.max(1, b.rent.max_monthly - b.rent.min_monthly);

  const factors: FactorScore[] = [
    f("traffic", inp.aadt, inp.aadt === null ? 0 : clamp01(inp.aadt / b.score.bounds.traffic_aadt_max), norm(w.traffic), `AADT ${inp.aadt ?? "unknown"}`),
    f("visibility", vis, vis ?? 0, norm(w.visibility), `frontage ${inp.frontage_ft ?? "?"} ft${inp.corner_lot ? ", corner" : ""}`),
    f(
      "distance",
      inp.drive_minutes,
      inp.drive_minutes === null ? 0 : clamp01(1 - inp.drive_minutes / b.search.max_drive_minutes),
      norm(w.distance),
      `${inp.drive_minutes ?? "?"} min drive`,
    ),
    f(
      "rent",
      inp.rent_monthly,
      inp.rent_monthly === null ? 0 : clamp01((b.rent.max_monthly - inp.rent_monthly) / rentSpan),
      norm(w.rent),
      `$${inp.rent_monthly ?? "?"}/mo (lower is better)`,
    ),
    f(
      "competitors",
      inp.competitors,
      inp.competitors === null ? 0 : clamp01(1 - inp.competitors / b.score.bounds.competitors_max),
      norm(w.competitors),
      `${inp.competitors ?? "?"} dealers nearby`,
    ),
  ];
  const total = round(factors.reduce((a, x) => a + x.weighted, 0));
  return {
    factors,
    total,
    metrics: { aadt: inp.aadt, visibility: vis === null ? null : round(vis), drive_minutes: inp.drive_minutes, rent_monthly: inp.rent_monthly, competitors: inp.competitors },
  };
}

function f(factor: FactorScore["factor"], raw: number | null, normalized: number, weight: number, detail: string): FactorScore {
  return { factor, raw, normalized: round(normalized), weight: round(weight), weighted: round(normalized * weight), detail };
}

const round = (x: number) => Math.round(x * 10000) / 10000;

/**
 * Ranks viable sites: standalone first (by total desc), then shared-lot sites
 * (by total desc). Returns site_id -> 1-based rank.
 */
export function rankViable(items: Array<{ site_id: string; total: number; shared_lot: boolean }>): Map<string, number> {
  const sorted = [...items].sort((a, b) => {
    if (a.shared_lot !== b.shared_lot) return a.shared_lot ? 1 : -1;
    if (b.total !== a.total) return b.total - a.total;
    return a.site_id.localeCompare(b.site_id);
  });
  return new Map(sorted.map((s, i) => [s.site_id, i + 1]));
}
