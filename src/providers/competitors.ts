import type { LatLon } from "../core/types.js";
import type { HttpResponse } from "../http/client.js";
import { FixtureMissError } from "../http/fixture-client.js";
import { optNumber, optString } from "./options.js";
import type { AdapterContext, Poi, PoiProvider, PoiResult } from "./types.js";

interface OverpassElement {
  type: string;
  id: number;
  lat?: number;
  lon?: number;
  center?: { lat: number; lon: number };
  tags?: Record<string, string>;
}

/** Public instances tried in order when OVERPASS_URL is unset. */
export const DEFAULT_OVERPASS_URLS = ["https://overpass-api.de/api/interpreter", "https://overpass.kumi.systems/api/interpreter"];
/** Gateway/overload answers worth one retry before moving to the next instance. */
const RETRY_STATUSES = new Set([429, 502, 503, 504]);

/**
 * Overpass API (OSM). `OVERPASS_URL` may be one URL or a comma-separated list tried in order
 * (default: the main instance, then kumi). Each instance gets one retry on 504/overload/abort;
 * the QL `[timeout:N]` and the HTTP timeout move together (`timeout_s`, default 60 s).
 * When every instance is unavailable the adapter throws and enrich records a warning for the site.
 */
export class OverpassPoi implements PoiProvider {
  readonly name = "overpass";
  constructor(private readonly ctx: AdapterContext) {}

  bases(): string[] {
    const envName = optString(this.ctx.options, "base_url_env", "OVERPASS_URL");
    const raw = this.ctx.env[envName]?.trim() || optString(this.ctx.options, "default_base_url", DEFAULT_OVERPASS_URLS.join(","));
    return [...new Set(raw.split(",").map((s) => s.trim()).filter(Boolean))];
  }

  private timeoutS(): number {
    return Math.max(25, Math.round(optNumber(this.ctx.options, "timeout_s", 60)));
  }

  private async query(filter: string, point: LatLon, radiusM: number): Promise<PoiResult> {
    const around = `(around:${Math.round(radiusM)},${point.lat},${point.lon})`;
    const timeoutS = this.timeoutS();
    const ql = `[out:json][timeout:${timeoutS}];(node${filter}${around};way${filter}${around};);out center tags;`;
    const body = `data=${encodeURIComponent(ql)}`;
    const failures: string[] = [];
    for (const url of this.bases()) {
      for (let attempt = 1; attempt <= 2; attempt++) {
        let res: HttpResponse;
        try {
          res = await this.ctx.http.request({
            method: "POST",
            url,
            headers: { "Content-Type": "application/x-www-form-urlencoded" },
            body,
            timeoutMs: (timeoutS + 30) * 1000, // the server needs its own timeout plus transfer time
          });
        } catch (e) {
          if (!isTransient(e)) throw e;
          failures.push(`${url}: ${e instanceof Error ? e.message : String(e)}`);
          continue;
        }
        if (RETRY_STATUSES.has(res.status)) {
          failures.push(`${url}: HTTP ${res.status}`);
          continue;
        }
        if (!res.ok) throw new Error(`Overpass ${res.status} from ${url}`);
        const json = res.json<{ elements?: OverpassElement[]; remark?: string }>();
        if (json.remark && /timed out|out of memory|error/i.test(json.remark)) {
          failures.push(`${url}: ${json.remark}`);
          continue;
        }
        return toResult(json.elements ?? [], radiusM, `${url}?data=${encodeURIComponent(ql)}`);
      }
    }
    throw new Error(`Overpass unavailable: ${failures.join("; ")}`);
  }

  dealersWithin(point: LatLon, radiusM: number): Promise<PoiResult> {
    return this.query(`["shop"="car"]`, point, radiusM);
  }

  estateAgentsWithin(point: LatLon, radiusM: number): Promise<PoiResult> {
    return this.query(`["office"="estate_agent"]`, point, radiusM);
  }
}

/** Aborts (our timeout), timeouts and connection failures; never a missing fixture or a programming error. */
function isTransient(e: unknown): boolean {
  if (!(e instanceof Error) || e instanceof FixtureMissError) return false;
  if (e.name === "AbortError" || e.name === "TimeoutError") return true;
  return /\baborted\b|\btimed out\b|fetch failed|ECONNRESET|ECONNREFUSED|ENOTFOUND|EAI_AGAIN|socket hang up/i.test(e.message);
}

function toResult(els: OverpassElement[], radiusM: number, sourceUrl: string): PoiResult {
  const items: Poi[] = [];
  for (const e of els) {
    const lat = e.lat ?? e.center?.lat;
    const lon = e.lon ?? e.center?.lon;
    if (lat === undefined || lon === undefined) continue;
    items.push({ name: e.tags?.name ?? null, lat, lon, tags: e.tags ?? {} });
  }
  return { count: items.length, radius_m: radiusM, items, source_url: sourceUrl };
}

/** PAID. Google Places Nearby Search. */
export class GooglePlacesPoi implements PoiProvider {
  readonly name = "places";
  constructor(private readonly ctx: AdapterContext) {}

  private async nearby(type: string, point: LatLon, radiusM: number): Promise<PoiResult> {
    const base = optString(this.ctx.options, "base_url", "https://maps.googleapis.com/maps/api");
    const key = this.ctx.env.GOOGLE_MAPS_API_KEY ?? "";
    const url = `${base}/place/nearbysearch/json?${new URLSearchParams({
      location: `${point.lat},${point.lon}`,
      radius: String(Math.round(radiusM)),
      type,
      key,
    })}`;
    const res = await this.ctx.http.request({ url });
    const results = res.json<{ results?: Array<{ name: string; geometry: { location: { lat: number; lng: number } }; website?: string }> }>().results ?? [];
    const items: Poi[] = results.map((r) => ({
      name: r.name,
      lat: r.geometry.location.lat,
      lon: r.geometry.location.lng,
      tags: (r.website ? { website: r.website } : {}) as Record<string, string>,
    }));
    return { count: items.length, radius_m: radiusM, items, source_url: url.replace(key, "REDACTED") };
  }
  dealersWithin(point: LatLon, radiusM: number): Promise<PoiResult> {
    return this.nearby("car_dealer", point, radiusM);
  }
  estateAgentsWithin(point: LatLon, radiusM: number): Promise<PoiResult> {
    return this.nearby("real_estate_agency", point, radiusM);
  }
}
