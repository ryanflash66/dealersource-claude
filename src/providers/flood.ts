import type { LatLon, Polygon } from "../core/types.js";
import { pointInPolygon, samplePoints, squareAround } from "../core/geo.js";
import { arcgisPost, polygonQueryBody, str, type ArcgisFeature } from "./arcgis.js";
import { optNumber, optString } from "./options.js";
import type { AdapterContext, FloodProvider, FloodResult } from "./types.js";

interface NfhlAttrs {
  FLD_ZONE?: string;
  ZONE_SUBTY?: string | null;
  SFHA_TF?: string;
}

/**
 * FEMA National Flood Hazard Layer (S_FLD_HAZ_AR, MapServer layer 28).
 * Queries every hazard polygon intersecting the parcel, then samples an NxN
 * grid inside the parcel to compute the share of area in high-risk zones
 * locally, plus the zone at the centroid. No paid alternative is needed.
 */
export class FemaNfhlFlood implements FloodProvider {
  readonly name = "fema";
  constructor(private readonly ctx: AdapterContext) {}

  async zonesFor(parcel: Polygon | null, centroid: LatLon, highRiskZones: string[]): Promise<FloodResult> {
    const layer = optString(this.ctx.options, "url", "https://hazards.fema.gov/arcgis/rest/services/public/NFHL/MapServer/28");
    const grid = optNumber(this.ctx.options, "sample_grid", 7);
    const poly = parcel ?? squareAround(centroid, 30);
    const url = `${layer.replace(/\/+$/, "")}/query`;
    const body = polygonQueryBody(poly, { outFields: "FLD_ZONE,ZONE_SUBTY,SFHA_TF" });
    const json = await arcgisPost<NfhlAttrs>(this.ctx.http, url, body);
    const features = (json.features ?? []).filter((f) => f.geometry?.rings);

    const zoneAt = (p: LatLon): { zone: string; subtype: string | null } => {
      for (const f of features) {
        const g: Polygon = { type: "Polygon", coordinates: f.geometry!.rings! };
        if (pointInPolygon(p, g)) return { zone: normalizeZone(f), subtype: str(f.attributes.ZONE_SUBTY) };
      }
      return { zone: "UNMAPPED", subtype: null };
    };

    const c = zoneAt(centroid);
    const samples = samplePoints(poly, grid);
    const tally = new Map<string, { zone: string; subtype: string | null; n: number }>();
    for (const s of samples) {
      const z = zoneAt(s);
      const key = `${z.zone}|${z.subtype ?? ""}`;
      const t = tally.get(key) ?? { ...z, n: 0 };
      t.n++;
      tally.set(key, t);
    }
    const shares = [...tally.values()]
      .map((t) => ({ zone: t.zone, subtype: t.subtype, share: t.n / samples.length }))
      .sort((a, b) => b.share - a.share);
    const high = new Set(highRiskZones.map((z) => z.toUpperCase()));
    const pct = Math.round(100 * shares.filter((s) => high.has(s.zone)).reduce((a, s) => a + s.share, 0));
    return {
      zone: c.zone,
      pct_area_high_risk: pct,
      zone_shares: shares,
      source_url: `${url}?geometryType=esriGeometryPolygon&outFields=FLD_ZONE,ZONE_SUBTY&f=json (POST; parcel geometry in body)`,
    };
  }
}

function normalizeZone(f: ArcgisFeature<NfhlAttrs>): string {
  return (f.attributes.FLD_ZONE ?? "UNMAPPED").trim().toUpperCase();
}
