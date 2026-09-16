import type { LatLon } from "../core/types.js";
import { optString } from "./options.js";
import type { AdapterContext, Poi, PoiProvider, PoiResult } from "./types.js";

interface OverpassElement {
  type: string;
  id: number;
  lat?: number;
  lon?: number;
  center?: { lat: number; lon: number };
  tags?: Record<string, string>;
}

/** Overpass API (OSM). Public instance with polite limits, or OVERPASS_URL self-hosted. */
export class OverpassPoi implements PoiProvider {
  readonly name = "overpass";
  constructor(private readonly ctx: AdapterContext) {}

  private base(): string {
    const envName = optString(this.ctx.options, "base_url_env", "OVERPASS_URL");
    return this.ctx.env[envName]?.trim() || optString(this.ctx.options, "default_base_url", "https://overpass-api.de/api/interpreter");
  }

  private async query(filter: string, point: LatLon, radiusM: number): Promise<PoiResult> {
    const around = `(around:${Math.round(radiusM)},${point.lat},${point.lon})`;
    const ql = `[out:json][timeout:25];(node${filter}${around};way${filter}${around};);out center tags;`;
    const url = this.base();
    const res = await this.ctx.http.request({
      method: "POST",
      url,
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: `data=${encodeURIComponent(ql)}`,
    });
    if (!res.ok) throw new Error(`Overpass ${res.status}`);
    const els = res.json<{ elements?: OverpassElement[] }>().elements ?? [];
    const items: Poi[] = [];
    for (const e of els) {
      const lat = e.lat ?? e.center?.lat;
      const lon = e.lon ?? e.center?.lon;
      if (lat === undefined || lon === undefined) continue;
      items.push({ name: e.tags?.name ?? null, lat, lon, tags: e.tags ?? {} });
    }
    return { count: items.length, radius_m: radiusM, items, source_url: `${url}?data=${encodeURIComponent(ql)}` };
  }

  dealersWithin(point: LatLon, radiusM: number): Promise<PoiResult> {
    return this.query(`["shop"="car"]`, point, radiusM);
  }

  estateAgentsWithin(point: LatLon, radiusM: number): Promise<PoiResult> {
    return this.query(`["office"="estate_agent"]`, point, radiusM);
  }
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
