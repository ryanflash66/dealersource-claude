import type { LatLon } from "../core/types.js";
import { haversineMeters } from "../core/geo.js";
import { arcgisGet, num, pointQueryUrl, str } from "./arcgis.js";
import { optNumber, optString } from "./options.js";
import type { AdapterContext, TrafficProvider, TrafficResult } from "./types.js";

/** NCDOT AADT stations (ArcGIS REST). Nearest station within the search radius. */
export class NcdotAadt implements TrafficProvider {
  readonly name = "ncdot";
  constructor(private readonly ctx: AdapterContext) {}

  async aadtNear(point: LatLon): Promise<TrafficResult | null> {
    const layer = optString(
      this.ctx.options,
      "url",
      "https://gis11.services.ncdot.gov/arcgis/rest/services/NCDOT_AADT_Stations/FeatureServer/0",
    );
    const radius = optNumber(this.ctx.options, "search_radius_m", 400);
    const url = pointQueryUrl(layer, point, { distance: String(radius), units: "esriSRUnit_Meter" });
    const json = await arcgisGet<Record<string, unknown>>(this.ctx.http, url);
    let best: TrafficResult | null = null;
    for (const f of json.features ?? []) {
      const aadt = num(f.attributes.AADT) ?? num(f.attributes.AADT_2023) ?? num(f.attributes.aadt);
      if (aadt === null || f.geometry?.x === undefined || f.geometry?.y === undefined) continue;
      const d = haversineMeters(point, { lat: f.geometry.y, lon: f.geometry.x });
      if (!best || d < (best.station_distance_m ?? Infinity)) {
        best = {
          aadt,
          road: str(f.attributes.ROUTE) ?? str(f.attributes.LOCATION),
          year: num(f.attributes.YEAR) ?? num(f.attributes.AADT_YEAR),
          station_distance_m: Math.round(d),
          source_url: url,
        };
      }
    }
    return best;
  }
}
