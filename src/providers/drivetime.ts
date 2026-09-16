import type { LatLon, Polygon } from "../core/types.js";
import { optString } from "./options.js";
import type { AdapterContext, DriveTimeProvider, DriveTimeResult, IsochroneResult } from "./types.js";

/** OpenRouteService (free tier, key required; fixture when ORS_API_KEY unset). */
export class OpenRouteServiceDriveTime implements DriveTimeProvider {
  readonly name = "ors";
  constructor(private readonly ctx: AdapterContext) {}

  private base(): string {
    return optString(this.ctx.options, "base_url", "https://api.openrouteservice.org").replace(/\/+$/, "");
  }
  private profile(): string {
    return optString(this.ctx.options, "profile", "driving-car");
  }
  private headers(): Record<string, string> {
    return { Authorization: this.ctx.env.ORS_API_KEY ?? "", "Content-Type": "application/json" };
  }

  async driveMinutes(from: LatLon, to: LatLon): Promise<DriveTimeResult> {
    const url = `${this.base()}/v2/directions/${this.profile()}`;
    const body = JSON.stringify({ coordinates: [[from.lon, from.lat], [to.lon, to.lat]] });
    const res = await this.ctx.http.request({ method: "POST", url, headers: this.headers(), body });
    if (!res.ok) throw new Error(`ORS directions ${res.status}`);
    const summary = res.json<{ routes?: Array<{ summary: { duration: number; distance: number } }> }>().routes?.[0]?.summary;
    if (!summary) throw new Error("ORS directions: no route");
    return { minutes: Math.round(summary.duration / 60), distance_m: summary.distance, source_url: url };
  }

  async isochrone(from: LatLon, minutes: number): Promise<IsochroneResult | null> {
    const url = `${this.base()}/v2/isochrones/${this.profile()}`;
    const body = JSON.stringify({ locations: [[from.lon, from.lat]], range: [minutes * 60] });
    const res = await this.ctx.http.request({ method: "POST", url, headers: this.headers(), body });
    if (!res.ok) throw new Error(`ORS isochrones ${res.status}`);
    const feat = res.json<{ features?: Array<{ geometry: Polygon }> }>().features?.[0];
    return feat ? { polygon: feat.geometry, minutes, source_url: url } : null;
  }
}

/** Self-hosted Valhalla on an NC extract. */
export class ValhallaDriveTime implements DriveTimeProvider {
  readonly name = "valhalla";
  constructor(private readonly ctx: AdapterContext) {}

  private base(): string {
    const envName = optString(this.ctx.options, "base_url_env", "VALHALLA_URL");
    return (this.ctx.env[envName]?.trim() || optString(this.ctx.options, "default_base_url", "http://localhost:8002")).replace(/\/+$/, "");
  }

  async driveMinutes(from: LatLon, to: LatLon): Promise<DriveTimeResult> {
    const url = `${this.base()}/route`;
    const body = JSON.stringify({ locations: [from, to], costing: "auto", units: "kilometers" });
    const res = await this.ctx.http.request({ method: "POST", url, headers: { "Content-Type": "application/json" }, body });
    if (!res.ok) throw new Error(`Valhalla route ${res.status}`);
    const s = res.json<{ trip?: { summary: { time: number; length: number } } }>().trip?.summary;
    if (!s) throw new Error("Valhalla: no trip");
    return { minutes: Math.round(s.time / 60), distance_m: Math.round(s.length * 1000), source_url: url };
  }

  async isochrone(from: LatLon, minutes: number): Promise<IsochroneResult | null> {
    const url = `${this.base()}/isochrone`;
    const body = JSON.stringify({ locations: [from], costing: "auto", contours: [{ time: minutes }], polygons: true });
    const res = await this.ctx.http.request({ method: "POST", url, headers: { "Content-Type": "application/json" }, body });
    if (!res.ok) throw new Error(`Valhalla isochrone ${res.status}`);
    const feat = res.json<{ features?: Array<{ geometry: Polygon }> }>().features?.[0];
    return feat ? { polygon: feat.geometry, minutes, source_url: url } : null;
  }
}

/** PAID. Google Distance Matrix (no isochrones). */
export class GoogleDistanceMatrix implements DriveTimeProvider {
  readonly name = "google";
  constructor(private readonly ctx: AdapterContext) {}

  async driveMinutes(from: LatLon, to: LatLon): Promise<DriveTimeResult> {
    const base = optString(this.ctx.options, "base_url", "https://maps.googleapis.com/maps/api");
    const key = this.ctx.env.GOOGLE_MAPS_API_KEY ?? "";
    const url = `${base}/distancematrix/json?${new URLSearchParams({
      origins: `${from.lat},${from.lon}`,
      destinations: `${to.lat},${to.lon}`,
      key,
    })}`;
    const res = await this.ctx.http.request({ url });
    const el = res.json<{ rows?: Array<{ elements: Array<{ duration?: { value: number }; distance?: { value: number } }> }> }>().rows?.[0]?.elements[0];
    if (!el?.duration) throw new Error("Distance Matrix: no result");
    return { minutes: Math.round(el.duration.value / 60), distance_m: el.distance?.value ?? null, source_url: url.replace(key, "REDACTED") };
  }

  async isochrone(): Promise<IsochroneResult | null> {
    return null; // Google offers no isochrone product; the pipeline falls back to per-site drive minutes.
  }
}
