import { describe, expect, it } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { NCDOT_AADT_2024, NCDOT_AADT_STATIONS, NcdotAadt, latestAadt, normalizeRoad, roadLabel, streetFromAddress } from "../../src/providers/traffic.js";
import { DEFAULT_OVERPASS_URLS, OverpassPoi } from "../../src/providers/competitors.js";
import { makeResponse, type HttpClient, type HttpRequest } from "../../src/http/client.js";
import { ROOT, adapterCtx, config, readJson } from "../helpers.js";

// 2100 Dickinson Ave, Greenville: parcel centroid (NC OneMap parno 4677776335).
const CENTROID = { lat: 35.600786, lon: -77.39281 };

describe("NCDOT AADT stations on ArcGIS Online (recorded 2026-09-18)", () => {
  it("providers.yaml points at the 2024 release with the 2022 service as fallback; both are point layers with string AADT columns", () => {
    const o = config().providers.options.ncdot!;
    expect(o.url).toBe(NCDOT_AADT_2024);
    expect(o.fallback_url).toBe(NCDOT_AADT_STATIONS);
    expect(o.url).not.toContain("gis11.services.ncdot.gov"); // the old host answers "Service not found"
    const fx = readJson(resolve(ROOT, "fixtures", "http", "ncdot", "aadt.json")).fixtures;
    const l24 = fx.find((e: any) => e.match.url_pattern.includes("September_2025/FeatureServer/0\\?f=json")).response.json;
    expect(l24.geometryType).toBe("esriGeometryPoint");
    const f24 = Object.fromEntries(l24.fields.map((f: any) => [f.name, f.type]));
    expect(f24.AADT_2024).toBe("esriFieldTypeString");
    expect(f24.AADT_2023).toBe("esriFieldTypeString");
    expect(f24.Location).toBe("esriFieldTypeString");
    const l22 = fx.find((e: any) => e.match.url_pattern.includes("NCDOT_AADT_Stations/FeatureServer/0\\?f=json")).response.json;
    expect(l22).toMatchObject({ geometryType: "esriGeometryPoint", maxRecordCount: 1000 });
    const f22 = Object.fromEntries(l22.fields.map((f: any) => [f.name, f.type]));
    expect(f22.AADT_2022).toBe("esriFieldTypeString");
    expect(f22.ROUTE).toBe("esriFieldTypeString");
    expect(f22.AADT_2023).toBeUndefined();
  });

  it("takes the latest non-blank AADT_YYYY column and parses it as a number", () => {
    expect(latestAadt({ AADT_2021: " ", AADT_2022: "8800", AADT_2023: " ", AADT_2024: "8700" })).toEqual({ aadt: 8700, year: 2024 });
    expect(latestAadt({ AADT_2019: " ", AADT_2020: "19000", AADT_2021: " ", AADT_2022: " " })).toEqual({ aadt: 19000, year: 2020 });
    expect(latestAadt({ AADT_2022: " ", ROUTE: "LINE AVE" })).toBeNull();
    expect(latestAadt({ AADT_2022: "n/a" })).toBeNull();
  });

  it("normalises road names across both releases and the site address", () => {
    expect(normalizeRoad("SR 1598 (DICKINSON AVE)")).toBe("DICKINSON AVE");
    expect(normalizeRoad("SR 1620 (Dickinson Av)")).toBe("DICKINSON AVE");
    expect(normalizeRoad("US 13 (DICKINSON AVE)")).toBe("DICKINSON AVE");
    expect(normalizeRoad("Dickinson Avenue")).toBe("DICKINSON AVE");
    expect(normalizeRoad("Moye Bv")).toBe("MOYE BLVD");
    expect(normalizeRoad("US 13/NC 11-43-903")).toBe("");
    expect(roadLabel({ Location: "SR 1620 (Dickinson Av) east of WEST ST" })).toBe("SR 1620 (Dickinson Av)");
    expect(roadLabel({ ROUTE: "LINE AVE", LOCATION: "NORTH OF SR 1598" })).toBe("LINE AVE");
    expect(streetFromAddress("2100 Dickinson Ave, Greenville, NC 27834")).toBe("Dickinson Ave");
    expect(streetFromAddress("2400 S Memorial Dr Suite 4, Greenville, NC")).toBe("S Memorial Dr");
  });

  it("prefers the station on the site's street over the nearer side-street station (Line Ave)", async () => {
    const ctx = adapterCtx("ncdot");
    const r = await new NcdotAadt(ctx).aadtNear(CENTROID, { address: "2100 Dickinson Ave, Greenville, NC 27834" });
    expect(r).toMatchObject({ aadt: 8700, year: 2024 });
    expect(r!.road).toMatch(/Dickinson/i);
    expect(r!.station_distance_m).toBeGreaterThan(50);
    expect(r!.station_distance_m).toBeLessThan(120);
    expect(ctx.http.requests).toHaveLength(1);
    expect(ctx.http.requests[0]!.url.startsWith(`${NCDOT_AADT_2024}/query?`)).toBe(true);
    expect(ctx.http.requests[0]!.url).toContain("distance=600&units=esriSRUnit_Meter");
    expect(ctx.http.requests[0]!.url).toContain("outSR=4326");
  });

  it("the parcel's fronting road works as the hint too", async () => {
    const r = await new NcdotAadt(adapterCtx("ncdot")).aadtNear(CENTROID, { fronting_road: "Dickinson Avenue" });
    expect(r).toMatchObject({ aadt: 8700, year: 2024 });
  });

  it("without a road hint the nearest station with a count wins", async () => {
    const r = await new NcdotAadt(adapterCtx("ncdot")).aadtNear(CENTROID);
    expect(r).toMatchObject({ aadt: 10500, year: 2024 });
    expect(r!.road).toMatch(/Moye|Line/i); // the 2024 text for the Line Ave station reads "Moye Bv north of SR 1620 Dickinson Ave"
    expect(r!.station_distance_m).toBeLessThan(50);
  });

  it("falls back to the 2022 service when the 2024 layer errors, reading AADT_2022 and ROUTE", async () => {
    const ctx = adapterCtx("ncdot");
    const r = await new NcdotAadt(ctx).aadtNear({ lat: 35.5, lon: -77.5 }, { address: "2400 S Memorial Dr, Greenville, NC 27834" });
    expect(r).not.toBeNull();
    expect(r!.year).toBe(2022);
    expect(r!.source_url.startsWith(`${NCDOT_AADT_STATIONS}/query?`)).toBe(true);
    expect(ctx.http.requests.map((q) => q.url.split("/query")[0])).toEqual([NCDOT_AADT_2024, NCDOT_AADT_STATIONS]);
  });

  it("returns null when neither layer has a station within range", async () => {
    const ctx = adapterCtx("ncdot");
    expect(await new NcdotAadt(ctx).aadtNear({ lat: 36, lon: -78 })).toBeNull();
    expect(ctx.http.requests).toHaveLength(2);
  });
});

describe("Overpass: timeout, retry and failover", () => {
  it("OVERPASS_URL takes a comma-separated list; a 504 is retried once, then the next instance answers", async () => {
    const ctx = adapterCtx("overpass", { OVERPASS_URL: "https://overpass-api.de/api/interpreter, https://overpass.kumi.systems/api/interpreter" });
    const r = await new OverpassPoi(ctx).dealersWithin(CENTROID, 3210);
    expect(r.count).toBe(1);
    expect(r.items[0]!.name).toBe("Failover Motors");
    expect(ctx.http.requests.map((q) => new URL(q.url).host)).toEqual(["overpass-api.de", "overpass-api.de", "overpass.kumi.systems"]);
    expect(r.source_url).toContain("overpass.kumi.systems");
  });

  it("defaults to the main instance then kumi when OVERPASS_URL is unset", () => {
    expect(DEFAULT_OVERPASS_URLS).toEqual(["https://overpass-api.de/api/interpreter", "https://overpass.kumi.systems/api/interpreter"]);
    expect(new OverpassPoi(adapterCtx("overpass")).bases()).toEqual(DEFAULT_OVERPASS_URLS);
    expect(new OverpassPoi(adapterCtx("overpass", { OVERPASS_URL: "http://overpass.internal/api/interpreter" })).bases()).toEqual(["http://overpass.internal/api/interpreter"]);
  });

  it("throws (so enrich records a warning) only after every instance failed twice", async () => {
    const ctx = adapterCtx("overpass");
    await expect(new OverpassPoi(ctx).dealersWithin(CENTROID, 3211)).rejects.toThrow(/Overpass unavailable: .*HTTP 504/);
    expect(ctx.http.requests).toHaveLength(4);
  });

  it("HTTP timeout is at least 60 s, the QL [timeout] is in step, and an abort is retried", async () => {
    const seen: HttpRequest[] = [];
    const http: HttpClient = {
      kind: "fixture",
      async request(req) {
        seen.push(req);
        if (seen.length === 1) {
          const e = new Error("This operation was aborted");
          e.name = "AbortError";
          throw e;
        }
        return makeResponse(200, req.url, JSON.stringify({ elements: [] }), { "content-type": "application/json" });
      },
    };
    const r = await new OverpassPoi({ ...adapterCtx("overpass"), http }).dealersWithin(CENTROID, 1609);
    expect(r.count).toBe(0);
    expect(seen).toHaveLength(2);
    expect(seen[0]!.timeoutMs).toBeGreaterThanOrEqual(60_000);
    expect(decodeURIComponent(seen[0]!.body!)).toContain("[timeout:60]");
    expect(seen.map((q) => q.url)).toEqual([DEFAULT_OVERPASS_URLS[0], DEFAULT_OVERPASS_URLS[0]]);
  });

  it("a missing fixture is a programming error, not a transient failure", async () => {
    const ctx = adapterCtx("nc_onemap"); // no overpass recordings under this adapter id
    await expect(new OverpassPoi(ctx).dealersWithin(CENTROID, 1609)).rejects.toThrow(/No recorded fixture/);
    expect(ctx.http.requests).toHaveLength(1);
  });
});

describe("schema: in_search_area is nullable (unknown drive time)", () => {
  it("a migration drops the not-null constraints that failed the live score stage", () => {
    const p = resolve(ROOT, "supabase", "migrations", "20260918000100_in_search_area_nullable.sql");
    expect(existsSync(p)).toBe(true);
    const sql = readFileSync(p, "utf8").toLowerCase();
    expect(sql).toMatch(/alter table (public\.)?scores\s+alter column in_search_area drop not null/);
    expect(sql).toMatch(/alter table (public\.)?sites\s+alter column in_search_area drop not null/);
  });

  it("the report contract copy accepts null for in_search_area", () => {
    const schema = JSON.stringify(readJson(resolve(ROOT, "tests", "contract", "report.schema.json")));
    expect(schema).toMatch(/"in_search_area":\{"type":\["boolean","null"\]/);
  });
});
