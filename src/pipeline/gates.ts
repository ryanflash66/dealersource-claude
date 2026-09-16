import type { EvidenceRow, GateName, GateResult, RequirementResult } from "../core/types.js";
import type { BusinessConfig } from "../config/schema.js";

export interface GateInputs {
  now: string;
  zoning: EvidenceRow[]; // zoning_permitted rows, newest first
  rent: EvidenceRow[]; // rent_monthly rows, newest first
  flood: EvidenceRow[]; // flood_zone rows, newest first
}

const fresh = (e: EvidenceRow, now: string) => e.status === "verified" && new Date(e.expires_at).getTime() > new Date(now).getTime();

/**
 * Gate evaluation (spec section 3). Pure function so it is trivially unit
 * tested. Rules:
 *  - a gate passes only on verified, unexpired evidence with a cited source;
 *  - expired or missing evidence is `pending`, never `pass`;
 *  - rent must be a WRITTEN figure (listing page, email or form); advertised is written.
 */
export function evaluateGates(b: BusinessConfig, inp: GateInputs): Record<GateName, GateResult> {
  return {
    zoning: zoningGate(inp.zoning, inp.now),
    rent: rentGate(b, inp.rent, inp.now),
    flood: floodGate(b, inp.flood, inp.now),
  };
}

function zoningGate(rows: EvidenceRow[], now: string): GateResult {
  const ev = rows.find((r) => fresh(r, now));
  if (!ev) {
    const stale = rows[0];
    return {
      gate: "zoning",
      status: "pending",
      evidence_ids: [],
      detail: stale ? `zoning evidence expired ${stale.expires_at}` : "permitted use not yet verified",
      warning: stale ? "expired" : null,
    };
  }
  const v = ev.value as { status: string; citation?: string | null; district?: string };
  if (v.status === "permitted" || v.status === "conditional") {
    return {
      gate: "zoning",
      status: "pass",
      evidence_ids: [ev.id],
      detail: `${v.status} in ${v.district ?? "district"}${v.citation ? ` (${v.citation})` : ""}`,
      warning: v.status === "conditional" ? "conditional use: permit required" : null,
    };
  }
  return { gate: "zoning", status: "fail", evidence_ids: [ev.id], detail: `use ${v.status} in ${v.district ?? "district"}`, warning: null };
}

function rentGate(b: BusinessConfig, rows: EvidenceRow[], now: string): GateResult {
  // Prefer a reply/form over the listing page when both are fresh.
  const written = rows.filter((r) => fresh(r, now) && ["email", "form", "listing", "manual"].includes(r.method));
  const ev = written.find((r) => r.method === "email" || r.method === "form") ?? written[0];
  if (!ev) {
    return { gate: "rent", status: "pending", evidence_ids: [], detail: "no written rent figure yet", warning: rows[0] ? "expired" : null };
  }
  const rent = (ev.value as { rent_monthly: number }).rent_monthly;
  const ok = rent >= b.rent.min_monthly && rent <= b.rent.max_monthly;
  return {
    gate: "rent",
    status: ok ? "pass" : "fail",
    evidence_ids: [ev.id],
    detail: `$${rent}/mo ${ok ? "within" : "outside"} $${b.rent.min_monthly}-$${b.rent.max_monthly} (${ev.method})`,
    warning: null,
  };
}

function floodGate(b: BusinessConfig, rows: EvidenceRow[], now: string): GateResult {
  const ev = rows.find((r) => fresh(r, now));
  if (!ev) return { gate: "flood", status: "pending", evidence_ids: [], detail: "flood zone not yet verified", warning: rows[0] ? "expired" : null };
  const v = ev.value as { zone: string; pct_area_high_risk?: number; zone_shares?: Array<{ subtype: string | null }> };
  const high = new Set(b.flood.high_risk_zones.map((z) => z.toUpperCase()));
  const zone = v.zone.toUpperCase();
  const pct = v.pct_area_high_risk ?? 0;
  const fail = high.has(zone) || pct > b.flood.majority_fail_pct;
  const shaded = v.zone_shares?.some((s) => s.subtype && b.flood.warn_subtypes.some((w) => s.subtype!.toUpperCase().includes(w.toUpperCase())));
  return {
    gate: "flood",
    status: fail ? "fail" : "pass",
    evidence_ids: [ev.id],
    detail: `zone ${v.zone}, ${pct}% of parcel in high-risk zones`,
    warning: !fail && shaded ? "shaded X (0.2% annual chance) present" : null,
  };
}

export function requirements(
  b: BusinessConfig,
  site: { shared_lot: boolean; has_office: boolean | null; vehicle_capacity: number | null },
): RequirementResult[] {
  const out: RequirementResult[] = [];
  out.push({
    name: "enclosed_office",
    outcome: site.has_office === null ? "unknown" : site.has_office ? "met" : b.site.office_required ? "not_met" : "met",
    detail: site.has_office === null ? "office not confirmed" : site.has_office ? "enclosed office on site" : "no office",
  });
  out.push({
    name: "vehicle_display",
    outcome: site.vehicle_capacity === null ? "unknown" : site.vehicle_capacity >= b.site.min_vehicle_display ? "met" : "not_met",
    detail: site.vehicle_capacity === null ? "display capacity unknown" : `${site.vehicle_capacity} vehicles (min ${b.site.min_vehicle_display})`,
  });
  out.push({
    name: "shared_lot_policy",
    outcome: !site.shared_lot ? "met" : b.site.shared_lot === "exclude" ? "not_met" : "met",
    detail: !site.shared_lot ? "standalone lot" : `shared lot (policy: ${b.site.shared_lot})`,
  });
  return out;
}
