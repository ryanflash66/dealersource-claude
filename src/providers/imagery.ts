import type { LatLon } from "../core/types.js";
import { squareAround, bbox } from "../core/geo.js";
import { optNumber, optString } from "./options.js";
import type { AdapterContext, ImageryProvider, ImageryResult } from "./types.js";

/** Mapillary street-level imagery (free token). */
export class MapillaryImagery implements ImageryProvider {
  readonly name = "mapillary";
  constructor(private readonly ctx: AdapterContext) {}

  async nearby(point: LatLon): Promise<ImageryResult> {
    const base = optString(this.ctx.options, "base_url", "https://graph.mapillary.com");
    const b = bbox(squareAround(point, optNumber(this.ctx.options, "bbox_m", 60)));
    const token = this.ctx.env.MAPILLARY_ACCESS_TOKEN ?? "";
    const url = `${base}/images?${new URLSearchParams({
      access_token: token,
      fields: "id,thumb_1024_url,captured_at,compass_angle",
      bbox: [b.minLon, b.minLat, b.maxLon, b.maxLat].map((n) => n.toFixed(6)).join(","),
      limit: "5",
    })}`;
    const res = await this.ctx.http.request({ url });
    if (!res.ok) throw new Error(`Mapillary ${res.status}`);
    const data = res.json<{ data?: Array<{ id: string; thumb_1024_url?: string; captured_at?: number }> }>().data ?? [];
    return {
      images: data.map((d) => ({
        url: d.thumb_1024_url ?? `https://www.mapillary.com/app/?pKey=${d.id}`,
        captured_at: d.captured_at ? new Date(d.captured_at).toISOString() : null,
        kind: "street" as const,
        provider: this.name,
      })),
      source_url: url.replace(token, "REDACTED"),
    };
  }
}

/** PAID. Google Street View Static (metadata call first, then image URL). */
export class GoogleStreetViewImagery implements ImageryProvider {
  readonly name = "streetview";
  constructor(private readonly ctx: AdapterContext) {}

  async nearby(point: LatLon): Promise<ImageryResult> {
    const base = optString(this.ctx.options, "base_url", "https://maps.googleapis.com/maps/api");
    const key = this.ctx.env.GOOGLE_MAPS_API_KEY ?? "";
    const loc = `${point.lat},${point.lon}`;
    const meta = `${base}/streetview/metadata?${new URLSearchParams({ location: loc, key })}`;
    const res = await this.ctx.http.request({ url: meta });
    const j = res.json<{ status: string; date?: string }>();
    if (j.status !== "OK") return { images: [], source_url: meta.replace(key, "REDACTED") };
    return {
      images: [
        {
          url: `${base}/streetview?${new URLSearchParams({ size: "640x400", location: loc, key: "REDACTED" })}`,
          captured_at: j.date ? `${j.date}-01T00:00:00.000Z` : null,
          kind: "street",
          provider: this.name,
        },
      ],
      source_url: meta.replace(key, "REDACTED"),
    };
  }
}
