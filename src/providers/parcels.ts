import type { LatLon } from "../core/types.js";
import { ringsToPolygon } from "../core/geo.js";
import { arcgisGet, num, pointQueryUrl, str } from "./arcgis.js";
import { optRecord, optString } from "./options.js";
import type { AdapterContext, ParcelProvider, ParcelResult } from "./types.js";

/** NC OneMap statewide parcels (ArcGIS REST). Free, official. */
export class NcOneMapParcels implements ParcelProvider {
  readonly name = "nc_onemap";
  constructor(private readonly ctx: AdapterContext) {}

  async lookup(point: LatLon): Promise<ParcelResult | null> {
    const layer = optString(
      this.ctx.options,
      "parcels_url",
      "https://services.nconemap.gov/secure/rest/services/NC1Map_Parcels/FeatureServer/0",
    );
    const url = pointQueryUrl(layer, point);
    const json = await arcgisGet<Record<string, unknown>>(this.ctx.http, url);
    const f = json.features?.[0];
    if (!f) return null;
    const a = f.attributes;
    const parcelId = str(a.PARNO) ?? str(a.ALTPARNO) ?? str(a.PIN);
    if (!parcelId) return null;
    return {
      parcel_id: parcelId,
      owner: str(a.OWNNAME),
      acreage: num(a.GISACRES) ?? num(a.RECAREANO),
      geometry: ringsToPolygon(f.geometry?.rings),
      centroid: null,
      frontage_ft: null,
      corner_lot: null,
      fronting_road: null,
      jurisdiction: str(a.MUNICIPALITY) ?? str(a.MUNIC),
      county: str(a.CNTYNAME),
      site_address: str(a.SITEADD),
      source_url: url,
    };
  }
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
      const id = str(a.PIN) ?? str(a.PARCEL_ID) ?? str(a.PARNO);
      if (!id) continue;
      return {
        parcel_id: id,
        owner: str(a.OWNER_NAME) ?? str(a.OWNNAME),
        acreage: num(a.ACRES) ?? num(a.GISACRES),
        geometry: ringsToPolygon(f.geometry?.rings),
        centroid: null,
        frontage_ft: null,
        corner_lot: null,
        fronting_road: null,
        jurisdiction: str(a.MUNICIPALITY) ?? str(a.CITY),
        county,
        site_address: str(a.SITE_ADDRESS) ?? str(a.SITEADD),
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
