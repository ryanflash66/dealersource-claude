import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { loadConfig, repoRoot, type AppConfig } from "../src/config/load.js";
import { makeClock } from "../src/core/clock.js";
import { silentLogger } from "../src/core/logger.js";
import { FixtureHttpClient } from "../src/http/fixture-client.js";
import { runPipeline, type RunOptions, type RunResult } from "../src/pipeline/run.js";
import type { AdapterContext } from "../src/providers/types.js";

export const ROOT = repoRoot();
export const GOLDEN = resolve(ROOT, "fixtures", "golden-v1");
export const GOLDEN_RUN_DATE = "2026-09-16";

export function tmp(prefix = "ds-"): string {
  const base = join(tmpdir(), "dealersource-tests");
  mkdirSync(base, { recursive: true });
  return mkdtempSync(join(base, prefix));
}

export function readJson<T = any>(path: string): T {
  return JSON.parse(readFileSync(path, "utf8")) as T;
}

export async function runOffline(opts: Partial<RunOptions> & { fixturesDir: string; outDir: string; runDate: string }): Promise<RunResult> {
  return runPipeline({ offline: true, logger: silentLogger, env: { ...cleanEnv(), ...(opts.env ?? {}) }, ...opts });
}

/** Env without any real credentials, so fixture fallbacks are deterministic. */
export function cleanEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (/^(SUPABASE|GMAIL|REDDIT|ORS|MAPILLARY|NOMINATIM|VALHALLA|OVERPASS|ANYCRAWL|GOOGLE|REGRID|ANTHROPIC|MAPBOX|PMTILES|DEALERSOURCE|DATABASE_URL|VERCEL)/.test(k)) continue;
    env[k] = v;
  }
  return env;
}

export function config(overrides?: Parameters<typeof loadConfig>[0]): AppConfig {
  return loadConfig({ env: cleanEnv(), ...(overrides ?? {}) });
}

/** AdapterContext wired to the recorded HTTP fixtures under fixtures/http/<adapter>. */
export function adapterCtx(adapterId: string, env: NodeJS.ProcessEnv = {}, cfg = config()): AdapterContext & { http: FixtureHttpClient } {
  const http = new FixtureHttpClient(adapterId, resolve(ROOT, "fixtures"));
  return {
    http,
    options: cfg.providers.options[adapterId] ?? {},
    env: { ...cleanEnv(), ...env },
    config: cfg,
    clock: makeClock("2026-09-16T10:00:00.000Z"),
    logger: silentLogger,
    offline: true,
    fixturesDir: null,
    outDir: null,
  };
}

// ---------------------------------------------------------------- fixture sets
export interface MiniListing {
  listing_id: string;
  source_id?: string;
  url?: string;
  fetched_at?: string;
  title?: string;
  address: string;
  rent_monthly?: number | null;
  description?: string;
  contact_email?: string | null;
  shared_lot?: boolean | null;
  has_office?: boolean | null;
  vehicle_capacity?: number | null;
  parcel_id: string;
  lat?: number;
  lon?: number;
  dealer_use?: "permitted" | "conditional" | "prohibited" | "unknown";
  citation?: string | null;
  planning_email?: string | null; // null: the layer publishes no contact
  flood_zone?: string;
  aadt?: number;
  minutes?: number;
  competitors?: number;
}

export interface MiniReply {
  listing_id: string;
  case_type: "rent" | "zoning" | "space";
  from: string;
  received_at: string;
  subject?: string;
  body: string;
}

/** Builds a complete section-14.3 fixture directory from compact listing specs. */
export function writeFixtureSet(dir: string, listings: MiniListing[], replies: MiniReply[] = []): string {
  mkdirSync(dir, { recursive: true });
  const geocode: Record<string, unknown> = {};
  const parcels: Record<string, unknown> = {};
  const zoning: Record<string, unknown> = {};
  const flood: Record<string, unknown> = {};
  const traffic: Record<string, unknown> = {};
  const drivetime: Record<string, unknown> = {};
  const competitors: Record<string, unknown> = {};
  const out = listings.map((l, i) => {
    const lat = l.lat ?? 35.6 + i * 0.01;
    const lon = l.lon ?? -77.4 + i * 0.01;
    geocode[l.address] = { lat, lon, formatted_address: l.address, parcel_id: l.parcel_id };
    parcels[l.parcel_id] = {
      parcel_id: l.parcel_id,
      owner: "Owner LLC",
      acres: 0.5,
      centroid: { lat, lon },
      geometry: { type: "Polygon", coordinates: [[[lon - 0.0005, lat - 0.0004], [lon + 0.0005, lat - 0.0004], [lon + 0.0005, lat + 0.0004], [lon - 0.0005, lat + 0.0004], [lon - 0.0005, lat - 0.0004]]] },
      frontage_ft: 150,
      corner_lot: false,
      fronting_road: "Main St",
    };
    zoning[l.parcel_id] = {
      district: "CG",
      jurisdiction: "City of Greenville",
      planning_email: l.planning_email === undefined ? "planning@greenvillenc.gov" : l.planning_email,
      use_table_url: "https://udo.greenvillenc.test/use-table",
      dealer_use: l.dealer_use ?? "permitted",
      citation: l.citation === undefined ? (l.dealer_use === "unknown" || l.dealer_use === "conditional" ? null : "Greenville Code sec. 9-4-78 Table 1") : l.citation,
    };
    flood[l.parcel_id] = { zone: l.flood_zone ?? "X", pct_area_high_risk: l.flood_zone && l.flood_zone !== "X" ? 80 : 0, source_url: `https://nfhl.fema.test/parcel/${l.parcel_id}` };
    traffic[l.parcel_id] = { aadt: l.aadt ?? 15000, road: "Main St", year: 2024, source_url: `https://aadt.ncdot.test/station/${l.parcel_id}` };
    drivetime[l.parcel_id] = { minutes: l.minutes ?? 12 };
    competitors[l.parcel_id] = { count_within_radius: l.competitors ?? 1, radius_m: 1609 };
    return {
      listing_id: l.listing_id,
      source_id: l.source_id ?? "broker-test",
      url: l.url ?? `https://broker.test/listings/${l.listing_id}`,
      fetched_at: l.fetched_at ?? "2026-09-15T09:00:00Z",
      title: l.title ?? `Lot ${l.listing_id}`,
      address: l.address,
      rent_monthly: l.rent_monthly === undefined ? 800 : l.rent_monthly,
      description: l.description ?? "Paved lot with office.",
      contact_email: l.contact_email === undefined ? `owner-${l.listing_id.toLowerCase()}@landlord.test` : l.contact_email,
      shared_lot: l.shared_lot ?? false,
      has_office: l.has_office === undefined ? true : l.has_office,
      vehicle_capacity: l.vehicle_capacity === undefined ? 4 : l.vehicle_capacity,
    };
  });
  const w = (name: string, v: unknown) => writeFileSync(join(dir, name), JSON.stringify(v, null, 2));
  w("listings.json", out);
  w("geocode.json", geocode);
  w("parcels.json", parcels);
  w("zoning.json", zoning);
  w("flood.json", flood);
  w("traffic.json", traffic);
  w("drivetime.json", drivetime);
  w("competitors.json", competitors);
  w("replies.json", replies.map((r) => ({ subject: `Re: inquiry ${r.listing_id}`, ...r })));
  return dir;
}

export function writeProvidersYaml(dir: string, patch: Record<string, unknown>): string {
  const base = readFileSync(resolve(ROOT, "providers.yaml"), "utf8");
  let text = base;
  for (const [k, v] of Object.entries(patch)) {
    const re = new RegExp(`^${k}:.*$`, "m");
    text = re.test(text) ? text.replace(re, `${k}: ${String(v)}`) : `${k}: ${String(v)}\n${text}`;
  }
  const path = join(dir, "providers.yaml");
  writeFileSync(path, text);
  return path;
}

export function exists(path: string): boolean {
  return existsSync(path);
}
