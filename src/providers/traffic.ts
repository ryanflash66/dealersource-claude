import type { LatLon } from "../core/types.js";
import { haversineMeters } from "../core/geo.js";
import { arcgisGet, pointQueryUrl, str, type ArcgisFeature } from "./arcgis.js";
import { optNumber, optString } from "./options.js";
import type { AdapterContext, LookupHints, TrafficProvider, TrafficResult } from "./types.js";

/**
 * NCDOT AADT stations, published on ArcGIS Online by TrafficSurvey.NCDOT.GOV (verified live 2026-09-18).
 * Both layers are point layers sharing LocationID; every AADT_YYYY column is a STRING with " " for years
 * without a count. The 2024 release carries AADT_2023/AADT_2024 and the road text in `Location`
 * ("SR 1620 (Dickinson Av) east of WEST ST"); the older service stops at AADT_2022 and splits the text
 * into ROUTE ("SR 1598 (DICKINSON AVE)") and LOCATION ("EAST OF WEST ST").
 */
export const NCDOT_AADT_2024 =
  "https://services.arcgis.com/NuWFvHYDMVmmxMeM/arcgis/rest/services/NCDOT__2024_AADT_Stations_published_September_2025/FeatureServer/0";
export const NCDOT_AADT_STATIONS = "https://services.arcgis.com/NuWFvHYDMVmmxMeM/arcgis/rest/services/NCDOT_AADT_Stations/FeatureServer/0";

type Attrs = Record<string, unknown>;

/** Latest non-blank AADT_YYYY column parsed as a number, with that column's year. */
export function latestAadt(attrs: Attrs): { aadt: number; year: number } | null {
  let best: { aadt: number; year: number } | null = null;
  for (const [key, raw] of Object.entries(attrs)) {
    const m = /^AADT_(\d{4})$/i.exec(key);
    if (!m) continue;
    const text = str(raw);
    if (!text) continue; // " " = no count that year
    const aadt = Number(text.replace(/,/g, ""));
    if (!Number.isFinite(aadt) || aadt <= 0) continue;
    const year = Number(m[1]);
    if (!best || year > best.year) best = { aadt, year };
  }
  return best;
}

/** The road a station sits on: ROUTE (2022 service) or the `Location` text before "north/south/east/west of". */
export function roadLabel(attrs: Attrs): string | null {
  const route = str(attrs.ROUTE);
  if (route) return route;
  const loc = str(attrs.Location) ?? str(attrs.LOCATION);
  if (!loc) return null;
  const cut = /\s+(?:north|south|east|west)\s+of\s+/i.exec(loc);
  return (cut ? loc.slice(0, cut.index) : loc).trim() || null;
}

const SUFFIX: Record<string, string> = {
  AVENUE: "AVE", AV: "AVE", AVE: "AVE",
  STREET: "ST", ST: "ST",
  ROAD: "RD", RD: "RD",
  DRIVE: "DR", DR: "DR",
  BOULEVARD: "BLVD", BV: "BLVD", BLV: "BLVD", BLVD: "BLVD",
  HIGHWAY: "HWY", HWY: "HWY",
  LANE: "LN", LN: "LN",
  PARKWAY: "PKWY", PKWY: "PKWY",
  COURT: "CT", CT: "CT",
  PLACE: "PL", PL: "PL",
  CIRCLE: "CIR", CIR: "CIR",
};

/** "SR 1598 (DICKINSON AVE)" / "SR 1620 (Dickinson Av)" / "Dickinson Avenue" -> "DICKINSON AVE". */
export function normalizeRoad(label: string | null | undefined): string {
  if (!label) return "";
  let s = label.toUpperCase().replace(/[().,]/g, " ");
  // Route designations: "SR 1598", "US 13/NC 11-43-903", "NC 11", "I-95", "US 264 ALT".
  const desig = "(?:SR|US|NC|I)[- ]?\\d+(?:-\\d+)*[A-Z]?";
  s = s.replace(new RegExp(`\\b${desig}(?:\\/${desig})*(?:\\s+(?:ALT|BUS|BYP))?\\b`, "g"), " ");
  const words = s.split(/\s+/).filter(Boolean).map((w) => SUFFIX[w] ?? w);
  return words.join(" ").trim();
}

/** The street part of "2100 Dickinson Ave, Greenville, NC 27834" -> "Dickinson Ave". */
export function streetFromAddress(address: string | null | undefined): string | null {
  if (!address) return null;
  const first = address.split(",")[0] ?? "";
  const street = first.replace(/^\s*\d+[a-z]?(?:[-/]\d+[a-z]?)?\s+/i, "").replace(/\s+(?:suite|ste|unit|#)\s*\S+$/i, "").trim();
  return street || null;
}

interface Station {
  aadt: number;
  year: number;
  road: string | null;
  distance_m: number;
  onStreet: boolean;
}

export class NcdotAadt implements TrafficProvider {
  readonly name = "ncdot";
  constructor(private readonly ctx: AdapterContext) {}

  private layers(): string[] {
    const primary = optString(this.ctx.options, "url", NCDOT_AADT_2024);
    const fallback = optString(this.ctx.options, "fallback_url", NCDOT_AADT_STATIONS);
    return [...new Set([primary, fallback])];
  }

  async aadtNear(point: LatLon, hints: LookupHints = {}): Promise<TrafficResult | null> {
    const radius = optNumber(this.ctx.options, "search_radius_m", 600);
    const targets = [hints.fronting_road, streetFromAddress(hints.address)].map(normalizeRoad).filter((t) => t.length >= 4);
    let lastError: unknown = null;
    let answered = false;
    for (const layer of this.layers()) {
      const url = pointQueryUrl(layer, point, { distance: String(radius), units: "esriSRUnit_Meter" });
      let features: ArcgisFeature[];
      try {
        features = (await arcgisGet<Attrs>(this.ctx.http, url)).features ?? [];
      } catch (e) {
        lastError = e; // try the older service before giving up
        continue;
      }
      answered = true;
      const best = pickStation(point, features, targets);
      if (best) return { aadt: best.aadt, road: best.road, year: best.year, station_distance_m: Math.round(best.distance_m), source_url: url };
    }
    if (!answered && lastError) throw lastError;
    return null;
  }
}

/** Station on the site's street (nearest of those) if any, otherwise the nearest station with a count. */
export function pickStation(point: LatLon, features: ArcgisFeature[], targets: string[]): Station | null {
  const stations: Station[] = [];
  for (const f of features) {
    const latest = latestAadt(f.attributes);
    if (!latest || f.geometry?.x === undefined || f.geometry?.y === undefined) continue;
    const road = roadLabel(f.attributes);
    const norm = normalizeRoad(road);
    const onStreet = norm.length >= 4 && targets.some((t) => norm.includes(t) || t.includes(norm));
    stations.push({ ...latest, road, distance_m: haversineMeters(point, { lat: f.geometry.y, lon: f.geometry.x }), onStreet });
  }
  stations.sort((a, b) => a.distance_m - b.distance_m);
  return stations.find((s) => s.onStreet) ?? stations[0] ?? null;
}
