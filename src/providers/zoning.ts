import type { LatLon } from "../core/types.js";
import { arcgisGet, pointQueryUrl, str } from "./arcgis.js";
import { optRecord } from "./options.js";
import type { AdapterContext, ZoningProvider, ZoningResult } from "./types.js";

interface LayerCfg {
  url: string;
  district_field: string;
}

/**
 * Official municipal/county zoning layers (ArcGIS REST) combined with the
 * cited use table in config/use-tables.yaml. There is deliberately no paid
 * alternative: zoning is always taken from the authority's own sources.
 */
export class ArcgisZoning implements ZoningProvider {
  readonly name = "arcgis";
  private readonly layers: Record<string, LayerCfg> = {};

  constructor(private readonly ctx: AdapterContext) {
    for (const [j, v] of Object.entries(optRecord(ctx.options, "layers"))) {
      const o = v as Record<string, unknown>;
      if (typeof o.url === "string" && typeof o.district_field === "string") {
        this.layers[j] = { url: o.url, district_field: o.district_field };
      }
    }
  }

  async lookup(point: LatLon, jurisdiction: string | null): Promise<ZoningResult | null> {
    if (!jurisdiction) return null;
    const key = Object.keys(this.layers).find((k) => jurisdiction.toLowerCase().includes(k.toLowerCase()));
    const layer = key ? this.layers[key] : undefined;
    if (!key || !layer) return null;
    const url = pointQueryUrl(layer.url, point, { returnGeometry: "false" });
    const json = await arcgisGet<Record<string, unknown>>(this.ctx.http, url);
    const district = str(json.features?.[0]?.attributes[layer.district_field]);
    if (!district) return null;

    const table = this.ctx.config.useTables.jurisdictions[key];
    const entry = table?.districts[district];
    const jur = this.ctx.config.business.jurisdictions[key];
    return {
      district,
      jurisdiction: key,
      dealer_use: entry ? entry.status : "unknown",
      citation: entry ? `${table!.ordinance}: ${entry.section}` : null,
      use_table_url: table?.use_table_url ?? null,
      planning_email: jur?.planning_email ?? null,
      source_url: url,
    };
  }
}
