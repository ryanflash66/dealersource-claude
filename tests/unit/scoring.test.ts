import { describe, expect, it } from "vitest";
import { rankViable, scoreSite, visibilityScore } from "../../src/pipeline/scoring.js";
import { config } from "../helpers.js";

const b = config().business;

describe("scoring", () => {
  it("weights are normalised and factors sum to the total", () => {
    const s = scoreSite(b, { aadt: 30000, frontage_ft: 300, corner_lot: true, drive_minutes: 0, rent_monthly: 600, competitors: 0 });
    expect(s.total).toBeCloseTo(1, 3);
    expect(s.factors.reduce((a, f) => a + f.weight, 0)).toBeCloseTo(1, 6);
    expect(s.factors.map((f) => f.factor)).toEqual(["traffic", "visibility", "distance", "rent", "competitors"]);
  });

  it("unknown factors score zero rather than helping a site", () => {
    const s = scoreSite(b, { aadt: null, frontage_ft: null, corner_lot: null, drive_minutes: null, rent_monthly: null, competitors: null });
    expect(s.total).toBe(0);
    expect(s.metrics.aadt).toBeNull();
  });

  it("traffic carries the highest weight, then visibility, distance, rent, competitors", () => {
    const w = scoreSite(b, { aadt: 1, frontage_ft: 1, corner_lot: false, drive_minutes: 1, rent_monthly: 999, competitors: 1 }).factors.map((f) => f.weight);
    for (let i = 1; i < w.length; i++) expect(w[i - 1]!).toBeGreaterThanOrEqual(w[i]!);
  });

  it("golden PITT-0001 beats PITT-0002 on every metric and in total", () => {
    const a = scoreSite(b, { aadt: 32000, frontage_ft: 220, corner_lot: true, drive_minutes: 8, rent_monthly: 800, competitors: 1 });
    const c = scoreSite(b, { aadt: 21000, frontage_ft: 150, corner_lot: false, drive_minutes: 11, rent_monthly: 850, competitors: 2 });
    expect(a.total).toBeGreaterThan(c.total);
    for (let i = 0; i < a.factors.length; i++) expect(a.factors[i]!.normalized).toBeGreaterThanOrEqual(c.factors[i]!.normalized);
  });

  it("lower rent scores higher within the range", () => {
    const lo = scoreSite(b, { aadt: 0, frontage_ft: 0, corner_lot: false, drive_minutes: 60, rent_monthly: 600, competitors: 10 }).total;
    const hi = scoreSite(b, { aadt: 0, frontage_ft: 0, corner_lot: false, drive_minutes: 60, rent_monthly: 1000, competitors: 10 }).total;
    expect(lo).toBeGreaterThan(hi);
  });

  it("visibility rewards frontage and corner lots", () => {
    expect(visibilityScore(b, 300, true)).toBeCloseTo(1, 6);
    expect(visibilityScore(b, 150, false)!).toBeLessThan(visibilityScore(b, 150, true)!);
    expect(visibilityScore(b, null, null)).toBeNull();
  });

  it("shared-lot sites rank after every standalone site regardless of score", () => {
    const ranks = rankViable([
      { site_id: "shared-high", total: 0.99, shared_lot: true },
      { site_id: "solo-low", total: 0.2, shared_lot: false },
      { site_id: "solo-high", total: 0.8, shared_lot: false },
      { site_id: "shared-low", total: 0.1, shared_lot: true },
    ]);
    expect(ranks.get("solo-high")).toBe(1);
    expect(ranks.get("solo-low")).toBe(2);
    expect(ranks.get("shared-high")).toBe(3);
    expect(ranks.get("shared-low")).toBe(4);
  });
});
