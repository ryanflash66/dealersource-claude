import { describe, expect, it } from "vitest";
import { evaluateGates, requirements } from "../../src/pipeline/gates.js";
import type { EvidenceRow } from "../../src/core/types.js";
import { config } from "../helpers.js";

const b = config().business;
const NOW = "2026-09-16T10:00:00.000Z";

function ev(partial: Partial<EvidenceRow> & { fact: EvidenceRow["fact"]; value: unknown }): EvidenceRow {
  return {
    id: partial.id ?? `ev_${partial.fact}_${Math.random().toString(36).slice(2, 8)}`,
    site_id: "site_X",
    source_url: "https://source.test/a",
    fetched_at: "2026-09-15T00:00:00.000Z",
    expires_at: "2027-01-01T00:00:00.000Z",
    method: "layer",
    status: "verified",
    message_id: null,
    notes: null,
    run_id: "run",
    ...partial,
  };
}

describe("gates", () => {
  it("all three pass on fresh verified evidence with a cited source", () => {
    const g = evaluateGates(b, {
      now: NOW,
      zoning: [ev({ fact: "zoning_permitted", value: { status: "permitted", citation: "Sec 9-4-78", district: "CG" }, method: "layer+use_table" })],
      rent: [ev({ fact: "rent_monthly", value: { rent_monthly: 800 }, method: "listing" })],
      flood: [ev({ fact: "flood_zone", value: { zone: "X", pct_area_high_risk: 0 } })],
    });
    expect(g.zoning.status).toBe("pass");
    expect(g.rent.status).toBe("pass");
    expect(g.flood.status).toBe("pass");
    expect(g.zoning.evidence_ids).toHaveLength(1);
  });

  it("missing evidence is pending, never pass (no response is not approval)", () => {
    const g = evaluateGates(b, { now: NOW, zoning: [], rent: [], flood: [] });
    expect(g.zoning.status).toBe("pending");
    expect(g.rent.status).toBe("pending");
    expect(g.flood.status).toBe("pending");
  });

  it("expired evidence is pending and flagged", () => {
    const g = evaluateGates(b, {
      now: NOW,
      zoning: [ev({ fact: "zoning_permitted", value: { status: "permitted", citation: "x" }, expires_at: "2026-09-01T00:00:00.000Z" })],
      rent: [],
      flood: [],
    });
    expect(g.zoning.status).toBe("pending");
    expect(g.zoning.warning).toBe("expired");
  });

  it("rent outside the range fails; boundary values pass (inclusive)", () => {
    const rent = (r: number) => evaluateGates(b, { now: NOW, zoning: [], rent: [ev({ fact: "rent_monthly", value: { rent_monthly: r }, method: "listing" })], flood: [] }).rent.status;
    expect(rent(1400)).toBe("fail");
    expect(rent(599)).toBe("fail");
    expect(rent(600)).toBe("pass");
    expect(rent(1000)).toBe("pass");
    expect(rent(1001)).toBe("fail");
  });

  it("a written reply beats the listing figure when both are fresh", () => {
    const g = evaluateGates(b, {
      now: NOW,
      zoning: [],
      rent: [
        ev({ id: "listing", fact: "rent_monthly", value: { rent_monthly: 800 }, method: "listing", fetched_at: "2026-09-15T00:00:00.000Z" }),
        ev({ id: "email", fact: "rent_monthly", value: { rent_monthly: 1100 }, method: "email", fetched_at: "2026-09-14T00:00:00.000Z" }),
      ],
      flood: [],
    });
    expect(g.rent.status).toBe("fail");
    expect(g.rent.evidence_ids).toEqual(["email"]);
  });

  it("unverified rent evidence (status != verified) does not count", () => {
    const g = evaluateGates(b, { now: NOW, zoning: [], rent: [ev({ fact: "rent_monthly", value: { rent_monthly: 800 }, method: "listing", status: "unverified" })], flood: [] });
    expect(g.rent.status).toBe("pending");
  });

  it("zoning prohibited fails; conditional passes with a warning", () => {
    const z = (status: string) => evaluateGates(b, { now: NOW, zoning: [ev({ fact: "zoning_permitted", value: { status, district: "CN" } })], rent: [], flood: [] }).zoning;
    expect(z("prohibited").status).toBe("fail");
    expect(z("conditional").status).toBe("pass");
    expect(z("conditional").warning).toMatch(/conditional/);
  });

  it("flood: high-risk zone at centroid fails, majority-of-area rule fails, shaded X only warns", () => {
    const f = (zone: string, pct: number, subtype: string | null = null) =>
      evaluateGates(b, { now: NOW, zoning: [], rent: [], flood: [ev({ fact: "flood_zone", value: { zone, pct_area_high_risk: pct, zone_shares: [{ zone, subtype, share: 1 }] } })] }).flood;
    expect(f("AE", 85).status).toBe("fail");
    expect(f("X", 60).status).toBe("fail");
    expect(f("X", 0).status).toBe("pass");
    expect(f("VE", 0).status).toBe("fail");
    const shaded = f("X", 0, "0.2 PCT ANNUAL CHANCE FLOOD HAZARD");
    expect(shaded.status).toBe("pass");
    expect(shaded.warning).toMatch(/shaded/i);
  });

  it("requirements: office required, display minimum, shared-lot policy", () => {
    const r = requirements(b, { shared_lot: false, has_office: true, vehicle_capacity: 6 });
    expect(r.every((x) => x.outcome === "met")).toBe(true);
    const noOffice = requirements(b, { shared_lot: false, has_office: false, vehicle_capacity: 1 });
    expect(noOffice.find((x) => x.name === "enclosed_office")?.outcome).toBe("not_met");
    expect(noOffice.find((x) => x.name === "vehicle_display")?.outcome).toBe("not_met");
    const unknown = requirements(b, { shared_lot: true, has_office: null, vehicle_capacity: null });
    expect(unknown.find((x) => x.name === "enclosed_office")?.outcome).toBe("unknown");
    expect(unknown.find((x) => x.name === "shared_lot_policy")?.outcome).toBe("met"); // last_resort allows
    const excl = requirements({ ...b, site: { ...b.site, shared_lot: "exclude" } }, { shared_lot: true, has_office: true, vehicle_capacity: 2 });
    expect(excl.find((x) => x.name === "shared_lot_policy")?.outcome).toBe("not_met");
  });
});
