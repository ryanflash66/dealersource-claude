import type { LatLon, Polygon } from "../core/types.js";
import { distanceToPolygonMeters, pointInPolygon, ringsToPolygon } from "../core/geo.js";
import { isNcStatePlane, ringsFrom2264 } from "../core/proj.js";
import { arcgisGet, num, pointQueryUrl, str, type ArcgisFeature, type ArcgisQueryResponse } from "./arcgis.js";
import { optNumber, optRecord, optString } from "./options.js";
import type { AdapterContext, LookupHints, ParcelProvider, ParcelResult } from "./types.js";

/** Case-insensitive attribute read: NC OneMap publishes lowercase field names, county layers vary. */
export function attr(a: Record<string, unknown>, ...names: string[]): unknown {
  const lower = new Map(Object.keys(a).map((k) => [k.toLowerCase(), k]));
  for (const n of names) {
    const k = lower.get(n.toLowerCase());
    if (k !== undefined && a[k] !== null && a[k] !== undefined && a[k] !== "") return a[k];
  }
  return undefined;
}

/** Fields that exist on NC1Map_Parcels layer 1 (an unknown name makes the service answer HTTP 400). */
export const NC_ONEMAP_FIELDS = "parno,altparno,ownname,siteadd,scity,cntyname,gisacres,parusedesc";
type Sr = { wkid?: number; latestWkid?: number } | undefined;

/**
 * NC OneMap statewide parcels (ArcGIS REST). Free, official.
 *
 * Verified against the live service on 2026-09-18 (responses recorded under
 * fixtures/http/nc_onemap): layer 0 is "Parcels (pts)", a point layer that
 * never intersects a query point, so the polygon layer 1 is used; field names
 * are lowercase; the JSON point form returns no features, so the query is an
 * envelope of about +-0.00025 deg around the point and the polygon that
 * contains the point is picked from the neighbours; `outSR=4326` works when
 * every requested field exists (an unknown field such as `munic` is what
 * produces "Unable to complete operation"). If the 4326 request ever fails,
 * geometry is requested in the native SR (EPSG:2264, NC State Plane feet) and
 * reprojected; if geometry is unavailable altogether, the parcel whose site
 * address best matches the listing is chosen and geometry is left null.
 */
export class NcOneMapParcels implements ParcelProvider {
  readonly name = "nc_onemap";
  constructor(private readonly ctx: AdapterContext) {}

  layerUrl(): string {
    const url = optString(this.ctx.options, "parcels_url", "https://services.nconemap.gov/secure/rest/services/NC1Map_Parcels/FeatureServer/1").replace(/\/+$/, "");
    // Layer 0 is the point layer; a point query against it always returns []. Never use it.
    return url.replace(/\/FeatureServer\/0$/, "/FeatureServer/1");
  }

  async lookup(point: LatLon, hints: LookupHints = {}): Promise<ParcelResult | null> {
    const layer = this.layerUrl();
    const half = optNumber(this.ctx.options, "envelope_half_deg", 0.00025);
    const q = (params: Record<string, string>) =>
      `${layer}/query?${new URLSearchParams({ inSR: "4326", spatialRel: "esriSpatialRelIntersects", outFields: NC_ONEMAP_FIELDS, f: "json", ...params })}`;

    let json: ArcgisQueryResponse<Record<string, unknown>> | null = null;
    let url = "";

    // Optional: JSON point form. Off by default because the live service returns [] for it.
    if (this.ctx.options.point_query_first === true) {
      url = q({ geometry: JSON.stringify({ x: point.lon, y: point.lat, spatialReference: { wkid: 4326 } }), geometryType: "esriGeometryPoint", returnGeometry: "true", outSR: "4326" });
      json = await this.tryQuery(url);
      if (!json?.features?.length) json = null;
    }

    const env = [point.lon - half, point.lat - half, point.lon + half, point.lat + half].map((n) => n.toFixed(6)).join(",");
    const envelope = { geometry: env, geometryType: "esriGeometryEnvelope" };

    // 1. Envelope, geometry in WGS84.
    if (!json) {
      url = q({ ...envelope, returnGeometry: "true", outSR: "4326" });
      json = await this.tryQuery(url);
    }
    // 2. Envelope, geometry in the native SR (reprojected below).
    if (!json) {
      url = q({ ...envelope, returnGeometry: "true" });
      json = await this.tryQuery(url);
    }
    // 3. Attributes only; the address hint picks the parcel and geometry stays null.
    if (!json) {
      url = q({ ...envelope, returnGeometry: "false" });
      json = await arcgisGet<Record<string, unknown>>(this.ctx.http, url);
    }

    const features = json.features ?? [];
    if (!features.length) return null;
    const chosen = pickFeature(features, point, json.spatialReference, hints.address ?? null);
    return chosen ? toResult(chosen.feature, chosen.geometry, url) : null;
  }

  private async tryQuery(url: string): Promise<ArcgisQueryResponse<Record<string, unknown>> | null> {
    try {
      return await arcgisGet<Record<string, unknown>>(this.ctx.http, url);
    } catch (e) {
      this.ctx.logger.warn("nc_onemap query failed, trying the next form", { url, error: e instanceof Error ? e.message : String(e) });
      return null;
    }
  }
}

function geometryOf(f: ArcgisFeature<Record<string, unknown>>, sr: Sr): Polygon | null {
  const rings = f.geometry?.rings;
  if (!rings || !rings.length) return null;
  const featureSr = (f.geometry as { spatialReference?: Sr }).spatialReference ?? sr;
  return isNcStatePlane(featureSr) ? ringsFrom2264(rings) : ringsToPolygon(rings);
}

/**
 * Chooses among the parcels intersecting the envelope. Geocoders place points
 * on the street centreline, which no parcel covers, so an exact match of the
 * listing's house number and street on `siteadd` wins first; then the polygon
 * that contains the point; then the nearest polygon edge within 60 m; then a
 * partial address match; a lone candidate is accepted as is.
 */
export function pickFeature(
  features: Array<ArcgisFeature<Record<string, unknown>>>,
  point: LatLon,
  sr: Sr,
  addressHint: string | null,
): { feature: ArcgisFeature<Record<string, unknown>>; geometry: Polygon | null } | null {
  const withGeom = features.map((f) => ({ feature: f, geometry: geometryOf(f, sr) }));
  const scored = addressScores(withGeom, addressHint);
  const exact = scored.filter((s) => s.score >= 3);
  if (exact.length === 1) return exact[0]!.x;
  const containing = withGeom.find((x) => x.geometry && pointInPolygon(point, x.geometry));
  if (containing) return containing;
  let nearest: { d: number; x: (typeof withGeom)[number] } | null = null;
  for (const x of withGeom) {
    if (!x.geometry) continue;
    const d = distanceToPolygonMeters(point, x.geometry);
    if (!nearest || d < nearest.d) nearest = { d, x };
  }
  if (nearest && nearest.d <= 60) return nearest.x;
  if (scored[0] && scored[0].score > 0) return scored[0].x;
  return withGeom.length === 1 ? withGeom[0]! : null;
}

function addressScores<T extends { feature: ArcgisFeature<Record<string, unknown>> }>(cands: T[], addressHint: string | null): Array<{ x: T; score: number }> {
  if (!addressHint) return [];
  const want = addressHint.toUpperCase();
  const number = /^\s*(\d+)/.exec(want)?.[1];
  const streetWord =
    want
      .replace(/^\s*\d+[A-Z]?\s+/, "")
      .split(",")[0]!
      .replace(/\b(N|S|E|W|NORTH|SOUTH|EAST|WEST)\b\.?/g, "")
      .replace(/\s+/g, " ")
      .trim()
      .split(" ")[0] ?? "";
  return cands
    .map((x) => {
      const site = String(attr(x.feature.attributes, "siteadd", "site_address", "address") ?? "").toUpperCase();
      let score = 0;
      if (number && new RegExp(`^\\s*${number}\\b`).test(site)) score += 2;
      if (streetWord && site.includes(streetWord)) score += 1;
      return { x, score };
    })
    .sort((a, b) => b.score - a.score);
}

function toResult(f: ArcgisFeature<Record<string, unknown>>, geometry: Polygon | null, url: string): ParcelResult | null {
  const a = f.attributes;
  const parcelId = str(attr(a, "parno", "altparno", "pin", "parcel_id"));
  if (!parcelId) return null;
  return {
    parcel_id: parcelId,
    owner: str(attr(a, "ownname", "owner_name", "owner")),
    acreage: num(attr(a, "gisacres", "recareano", "acres")),
    geometry,
    centroid: null,
    frontage_ft: null,
    corner_lot: null,
    fronting_road: null,
    jurisdiction: str(attr(a, "scity", "munic", "municipality", "city")),
    county: str(attr(a, "cntyname", "county")),
    site_address: str(attr(a, "siteadd", "site_address")),
    source_url: url,
  };
}

/** County GIS fallback: same ArcGIS shape, different field names per county. */
export class CountyGisParcels implements ParcelProvider {
  readonly name = "county";
  constructor(private readonly ctx: AdapterContext) {}

  async lookup(point: LatLon, hints: { county?: string | null } = {}): Promise<ParcelResult | null> {
    const layers = optRecord(this.ctx.options, "layers");
    const candidates: Array<[string, unknown]> =
      hints.county && layers[hints.county] ? [[hints.county, layers[hints.county]]] : Object.entries(layers);
    for (const [county, layerUrl] of candidates) {
      if (typeof layerUrl !== "string") continue;
      const url = pointQueryUrl(layerUrl, point);
      const json = await arcgisGet<Record<string, unknown>>(this.ctx.http, url);
      const f = json.features?.[0];
      if (!f) continue;
      const a = f.attributes;
      const id = str(attr(a, "PIN", "PARCEL_ID", "PARNO"));
      if (!id) continue;
      return {
        parcel_id: id,
        owner: str(attr(a, "OWNER_NAME", "OWNNAME")),
        acreage: num(attr(a, "ACRES", "GISACRES")),
        geometry: geometryOf(f, json.spatialReference),
        centroid: null,
        frontage_ft: null,
        corner_lot: null,
        fronting_road: null,
        jurisdiction: str(attr(a, "MUNICIPALITY", "CITY")),
        county,
        site_address: str(attr(a, "SITE_ADDRESS", "SITEADD")),
        source_url: url,
      };
    }
    return null;
  }
}

interface RegridResponse {
  parcels?: {
    features?: Array<{
      geometry: { type: string; coordinates: number[][][] };
      properties: { fields: Record<string, unknown> };
    }>;
  };
}

/** PAID. Regrid parcel API. */
export class RegridParcels implements ParcelProvider {
  readonly name = "regrid";
  constructor(private readonly ctx: AdapterContext) {}

  async lookup(point: LatLon): Promise<ParcelResult | null> {
    const base = optString(this.ctx.options, "base_url", "https://app.regrid.com/api/v2");
    const token = this.ctx.env.REGRID_API_KEY ?? "";
    const url = `${base}/parcels/point?${new URLSearchParams({ lat: String(point.lat), lon: String(point.lon), token })}`;
    const res = await this.ctx.http.request({ url });
    const f = res.json<RegridResponse>().parcels?.features?.[0];
    if (!f) return null;
    const p = f.properties.fields;
    return {
      parcel_id: String(p.parcelnumb ?? p.ll_uuid),
      owner: str(p.owner),
      acreage: num(p.gisacre) ?? num(p.ll_gisacre),
      geometry: f.geometry.type === "Polygon" ? { type: "Polygon", coordinates: f.geometry.coordinates } : null,
      centroid: null,
      frontage_ft: null,
      corner_lot: null,
      fronting_road: null,
      jurisdiction: str(p.scity),
      county: str(p.county),
      site_address: str(p.address),
      source_url: url.replace(token, "REDACTED"),
    };
  }
}
