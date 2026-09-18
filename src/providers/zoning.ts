import type { LatLon, Polygon } from "../core/types.js";
import { pointInPolygon, samplePoints } from "../core/geo.js";
import { isNcStatePlane, ringsFrom2264 } from "../core/proj.js";
import { arcgisGet, arcgisPost, pointQueryUrl, polygonQueryBody, str, type ArcgisFeature, type ArcgisQueryResponse } from "./arcgis.js";
import { optRecord } from "./options.js";
import type { AdapterContext, LookupHints, ZoningProvider, ZoningResult } from "./types.js";

interface LayerCfg {
  url: string;
  district_field: string;
}

/**
 * Official municipal/county zoning layers (ArcGIS REST) combined with the
 * cited use table in config/use-tables.yaml. There is deliberately no paid
 * alternative: zoning is always taken from the authority's own sources.
 *
 * Verified 2026-09-18: Greenville publishes Greenville_Zoning as OpenData
 * MapServer layer 21 (field ZONE); Pitt County publishes County Zoning as
 * PittOpenData/ZoningPitt layer 0 (field ZONE), empty inside town limits.
 * Zoning polygons exclude the street right-of-way where Census geocodes land,
 * so the layer is queried with the parcel polygon (district with the largest
 * overlap wins) or at the parcel centroid, never at the geocode when a parcel
 * is known. A jurisdiction without a layer returns null: pending gate plus a
 * planning case, never an HTTP error.
 */
export class ArcgisZoning implements ZoningProvider {
  readonly name = "arcgis";
  private readonly layers: Record<string, LayerCfg> = {};

  constructor(private readonly ctx: AdapterContext) {
    for (const [j, v] of Object.entries(optRecord(ctx.options, "layers"))) {
      const o = v as Record<string, unknown>;
      if (typeof o.url === "string" && typeof o.district_field === "string") {
        this.layers[j] = { url: o.url.replace(/\/+$/, ""), district_field: o.district_field };
      }
    }
  }

  /** Layer keys to try: the municipality first, then the county layer for unincorporated land. */
  private candidates(jurisdiction: string | null, county: string | null): string[] {
    const out: string[] = [];
    const match = (name: string | null) => {
      if (!name) return null;
      const n = name.toLowerCase();
      return Object.keys(this.layers).find((k) => n.includes(k.toLowerCase()) || k.toLowerCase().includes(n)) ?? null;
    };
    const j = match(jurisdiction);
    if (j) out.push(j);
    const c = match(county ? `${county} County` : null);
    if (c && !out.includes(c)) out.push(c);
    return out;
  }

  async lookup(point: LatLon, jurisdiction: string | null, hints: LookupHints = {}): Promise<ZoningResult | null> {
    for (const key of this.candidates(jurisdiction, hints.county ?? null)) {
      const layer = this.layers[key]!;
      const hit = hints.geometry ? await this.byPolygon(layer, hints.geometry, point) : await this.byPoint(layer, point);
      if (!hit) continue;
      const table = this.ctx.config.useTables.jurisdictions[key];
      const entry = table?.districts[hit.district];
      const jur = this.ctx.config.business.jurisdictions[key];
      return {
        district: hit.district,
        jurisdiction: key,
        dealer_use: entry ? entry.status : "unknown",
        citation: entry ? `${table!.ordinance}: ${entry.section}` : null,
        use_table_url: table?.use_table_url ?? null,
        planning_email: jur?.planning_email ?? null,
        source_url: hit.source_url,
      };
    }
    return null;
  }

  private async byPoint(layer: LayerCfg, point: LatLon): Promise<{ district: string; source_url: string } | null> {
    const url = pointQueryUrl(layer.url, point, { returnGeometry: "false" });
    const json = await arcgisGet<Record<string, unknown>>(this.ctx.http, url);
    const district = str(json.features?.[0]?.attributes[layer.district_field]);
    return district ? { district, source_url: url } : null;
  }

  /** Every district polygon intersecting the parcel; the one covering most of the parcel wins. */
  private async byPolygon(layer: LayerCfg, parcel: Polygon, centroid: LatLon): Promise<{ district: string; source_url: string } | null> {
    const url = `${layer.url}/query`;
    const json = await arcgisPost<Record<string, unknown>>(this.ctx.http, url, polygonQueryBody(parcel, { outFields: layer.district_field, outSR: "4326" }));
    const features = (json.features ?? []).filter((f) => str(f.attributes[layer.district_field]));
    if (!features.length) return null;
    const source_url = `${url}?geometryType=esriGeometryPolygon&outFields=${layer.district_field}&f=json (POST; parcel geometry in body)`;
    if (features.length === 1 || !features.some((f) => f.geometry?.rings)) {
      return { district: str(features[0]!.attributes[layer.district_field])!, source_url };
    }
    const polys = features.map((f) => ({ district: str(f.attributes[layer.district_field])!, poly: geometryOf(f, json.spatialReference) }));
    const tally = new Map<string, number>();
    for (const s of samplePoints(parcel, 7)) {
      const hit = polys.find((p) => p.poly && pointInPolygon(s, p.poly));
      if (hit) tally.set(hit.district, (tally.get(hit.district) ?? 0) + 1);
    }
    if (!tally.size) {
      const c = polys.find((p) => p.poly && pointInPolygon(centroid, p.poly)) ?? polys[0]!;
      return { district: c.district, source_url };
    }
    const [district] = [...tally.entries()].sort((a, b) => b[1] - a[1])[0]!;
    return { district, source_url };
  }
}

function geometryOf(f: ArcgisFeature<Record<string, unknown>>, sr: ArcgisQueryResponse["spatialReference"]): Polygon | null {
  const rings = f.geometry?.rings;
  if (!rings?.length) return null;
  const fsr = (f.geometry as { spatialReference?: ArcgisQueryResponse["spatialReference"] }).spatialReference ?? sr;
  return isNcStatePlane(fsr) ? ringsFrom2264(rings) : { type: "Polygon", coordinates: rings };
}
