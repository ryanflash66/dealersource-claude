import type { HttpClient } from "../http/client.js";
import type { LatLon, Polygon } from "../core/types.js";

/** Shared helpers for ArcGIS REST FeatureServer/MapServer query endpoints. */
export interface ArcgisFeature<A = Record<string, unknown>> {
  attributes: A;
  geometry?: { x?: number; y?: number; rings?: number[][][]; paths?: number[][][] };
}
export interface ArcgisQueryResponse<A = Record<string, unknown>> {
  features?: ArcgisFeature<A>[];
  error?: { code: number; message: string };
}

export function pointQueryUrl(
  layerUrl: string,
  p: LatLon,
  extra: Record<string, string> = {},
): string {
  const params = new URLSearchParams({
    geometry: `${p.lon},${p.lat}`,
    geometryType: "esriGeometryPoint",
    inSR: "4326",
    spatialRel: "esriSpatialRelIntersects",
    outFields: "*",
    returnGeometry: "true",
    outSR: "4326",
    f: "json",
    ...extra,
  });
  return `${layerUrl.replace(/\/+$/, "")}/query?${params.toString()}`;
}

export function polygonQueryBody(poly: Polygon, extra: Record<string, string> = {}): string {
  const params = new URLSearchParams({
    geometry: JSON.stringify({ rings: poly.coordinates, spatialReference: { wkid: 4326 } }),
    geometryType: "esriGeometryPolygon",
    inSR: "4326",
    spatialRel: "esriSpatialRelIntersects",
    outFields: "*",
    returnGeometry: "true",
    outSR: "4326",
    f: "json",
    ...extra,
  });
  return params.toString();
}

export async function arcgisGet<A>(http: HttpClient, url: string): Promise<ArcgisQueryResponse<A>> {
  const res = await http.request({ method: "GET", url });
  if (!res.ok) throw new Error(`ArcGIS query failed ${res.status}: ${url}`);
  const json = res.json<ArcgisQueryResponse<A>>();
  if (json.error) throw new Error(`ArcGIS error ${json.error.code}: ${json.error.message}`);
  return json;
}

export async function arcgisPost<A>(http: HttpClient, url: string, body: string): Promise<ArcgisQueryResponse<A>> {
  const res = await http.request({
    method: "POST",
    url,
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
  });
  if (!res.ok) throw new Error(`ArcGIS query failed ${res.status}: ${url}`);
  const json = res.json<ArcgisQueryResponse<A>>();
  if (json.error) throw new Error(`ArcGIS error ${json.error.code}: ${json.error.message}`);
  return json;
}

export function num(v: unknown): number | null {
  if (v === null || v === undefined || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

export function str(v: unknown): string | null {
  if (v === null || v === undefined) return null;
  const s = String(v).trim();
  return s ? s : null;
}
