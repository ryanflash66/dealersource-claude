import { describe, expect, it } from "vitest";
import { resolve } from "node:path";
import { NcOneMapParcels, pickFeature, attr } from "../../src/providers/parcels.js";
import { nc2264ToLonLat, ringsFrom2264, isNcStatePlane } from "../../src/core/proj.js";
import { pointInPolygon, distanceToPolygonMeters } from "../../src/core/geo.js";
import { FixtureHttpClient, type FixtureEntry } from "../../src/http/fixture-client.js";
import { ROOT, adapterCtx, readJson } from "../helpers.js";

// 2100 Dickinson Ave, Greenville NC: inside parcel 4677776335 (WARD HOLDINGS LLC), among 4 neighbours.
const P = { lat: 35.600682, lon: -77.392251 };
const LAYER1 = "https://services.nconemap.gov/secure/rest/services/NC1Map_Parcels/FeatureServer/1";

describe("NC OneMap parcels (recorded live responses, 2026-09-18)", () => {
  it("the default layer is the polygon layer 1; the point layer 0 is never queried, even if configured", async () => {
    const fx = readJson(resolve(ROOT, "fixtures", "http", "nc_onemap", "parcels.json"));
    const meta = (id: number) => fx.fixtures.find((e: any) => e.match.url_pattern.includes(`FeatureServer/${id}\\?f=json`)).response.json;
    expect(meta(0).name).toBe("Parcels (pts)");
    expect(meta(0).geometryType).toBe("esriGeometryPoint");
    expect(meta(1).name).toBe("Parcels (polys)");
    expect(meta(1).geometryType).toBe("esriGeometryPolygon");
    expect(meta(1).fields.map((f: any) => f.name)).toEqual(expect.arrayContaining(["parno", "ownname", "siteadd", "cntyname", "gisacres"]));

    const ctx = adapterCtx("nc_onemap");
    const p = new NcOneMapParcels(ctx);
    expect(p.layerUrl()).toBe(LAYER1);
    await p.lookup(P);
    expect(ctx.http.requests.every((r) => r.url.startsWith(`${LAYER1}/query?`))).toBe(true);

    const legacy = adapterCtx("nc_onemap");
    legacy.options = { ...legacy.options, parcels_url: LAYER1.replace("/1", "/0") };
    expect(new NcOneMapParcels(legacy).layerUrl()).toBe(LAYER1);
  });

  it("queries an envelope around the point with outSR=4326 and picks the parcel for the listing among the neighbours", async () => {
    const ctx = adapterCtx("nc_onemap");
    const r = await new NcOneMapParcels(ctx).lookup(P, { address: "2100 Dickinson Ave, Greenville, NC 27834" });
    expect(ctx.http.requests).toHaveLength(1);
    const u = new URL(ctx.http.requests[0]!.url);
    expect(u.searchParams.get("geometryType")).toBe("esriGeometryEnvelope");
    expect(u.searchParams.get("geometry")).toBe("-77.392501,35.600432,-77.392001,35.600932");
    expect(u.searchParams.get("outSR")).toBe("4326");
    expect(u.searchParams.get("returnGeometry")).toBe("true");
    expect(u.searchParams.get("outFields")).not.toMatch(/munic/);
    expect(r).toMatchObject({ parcel_id: "4677776335", owner: "WARD HOLDINGS LLC", county: "Pitt", acreage: 0.65, site_address: "2100 DICKINSON AV" });
    expect(r!.geometry?.type).toBe("Polygon");
    // The geocode sits in the street right-of-way: no parcel contains it, so the exact house number + street
    // match on siteadd decides. Recorded edge distances: 2100 Dickinson is one of the two nearest polygons.
    expect(pointInPolygon(P, r!.geometry!)).toBe(false);
    expect(distanceToPolygonMeters(P, r!.geometry!)).toBeLessThan(60);
    expect(r!.parcel_id).not.toBe("4677779591"); // the city-owned 2099 strip, nearest by centroid, is not the listing
  });

  it("attribute lookup is case-insensitive", () => {
    expect(attr({ parno: "1", OWNNAME: "X" }, "PARNO")).toBe("1");
    expect(attr({ parno: "1", OWNNAME: "X" }, "ownname")).toBe("X");
    expect(attr({ parno: "" }, "parno", "altparno")).toBeUndefined();
  });

  it("falls back to native-SR geometry (EPSG:2264, reprojected) when the outSR request fails", async () => {
    const fx = readJson(resolve(ROOT, "fixtures", "http", "nc_onemap", "parcels.json"));
    const native = fx.fixtures.find((e: any) => e.match.url_pattern.includes("(?!.*outSR=)"));
    expect(native.response.json.spatialReference).toEqual({ wkid: 102719, latestWkid: 2264 });
    const entries: FixtureEntry[] = [
      { match: { url_pattern: "outSR=4326" }, response: { status: 400, json: { error: { code: 400, message: "Unable to complete operation." } } } },
      native,
    ];
    const ctx = adapterCtx("nc_onemap");
    ctx.http = new FixtureHttpClient("nc_onemap", resolve(ROOT, "fixtures"), entries);
    const r = await new NcOneMapParcels(ctx).lookup(P, { address: "2100 DICKINSON AVE, GREENVILLE, NC, 27834" });
    expect(ctx.http.requests).toHaveLength(2);
    expect(r?.parcel_id).toBe("4677776335");
    expect(distanceToPolygonMeters(P, r!.geometry!)).toBeLessThan(60);
    const [lon, lat] = r!.geometry!.coordinates[0]![0]!;
    expect(Math.abs(lon! - -77.3932997438656)).toBeLessThan(1e-5); // same vertex the service returns in 4326
    expect(Math.abs(lat! - 35.60092468050493)).toBeLessThan(1e-5);
  });

  it("with attributes only, picks the parcel whose site address matches the listing and leaves geometry null", async () => {
    const fx = readJson(resolve(ROOT, "fixtures", "http", "nc_onemap", "parcels.json"));
    const env4326 = fx.fixtures.find((e: any) => e.match.url_pattern.includes("outSR=4326")).response.json;
    const noGeom = { ...env4326, features: env4326.features.map((f: any) => ({ attributes: f.attributes })) };
    const entries: FixtureEntry[] = [
      { match: { url_pattern: "returnGeometry=true" }, response: { status: 500, body: "upstream error" } },
      { match: { url_pattern: "returnGeometry=false" }, response: { json: noGeom } },
    ];
    const ctx = adapterCtx("nc_onemap");
    ctx.http = new FixtureHttpClient("nc_onemap", resolve(ROOT, "fixtures"), entries);
    const r = await new NcOneMapParcels(ctx).lookup(P, { address: "2107 Dickinson Ave, Greenville, NC" });
    expect(ctx.http.requests).toHaveLength(3);
    expect(r?.parcel_id).toBe("4677777153");
    expect(r?.site_address).toBe("2107 DICKINSON AV");
    expect(r?.geometry).toBeNull();
    // no address hint, no geometry and several candidates: no guess
    const ctx2 = adapterCtx("nc_onemap");
    ctx2.http = new FixtureHttpClient("nc_onemap", resolve(ROOT, "fixtures"), entries);
    expect(await new NcOneMapParcels(ctx2).lookup(P)).toBeNull();
  });

  it("the JSON point form is off by default because the live service returns no features for it", async () => {
    const ctx = adapterCtx("nc_onemap");
    ctx.options = { ...ctx.options, point_query_first: true };
    const r = await new NcOneMapParcels(ctx).lookup(P, { address: "2100 Dickinson Ave, Greenville, NC" });
    expect(ctx.http.requests[0]!.url).toContain("geometryType=esriGeometryPoint");
    expect(ctx.http.requests[1]!.url).toContain("geometryType=esriGeometryEnvelope");
    expect(r?.parcel_id).toBe("4677776335");
  });

  it("returns null when nothing intersects", async () => {
    expect(await new NcOneMapParcels(adapterCtx("nc_onemap")).lookup({ lat: 36.9, lon: -76.1 })).toBeNull();
  });

  it("pickFeature order: exact house number + street, then containment, then nearest edge within 60 m", () => {
    const sq = (x0: number, y0: number, id: string) => ({ attributes: { parno: id, siteadd: `${id} MAIN ST` }, geometry: { rings: [[[x0, y0], [x0 + 0.001, y0], [x0 + 0.001, y0 + 0.001], [x0, y0 + 0.001], [x0, y0]]] } });
    const feats = [sq(0, 0, "1"), sq(0.001, 0, "2"), sq(0, 0.001, "3")];
    const inside2 = { lon: 0.0015, lat: 0.0005 };
    // geocoders sit in the street: the listing's own address beats the polygon under the point
    expect(pickFeature(feats as any, inside2, { wkid: 4326 }, "1 Main St, Town, NC")!.feature.attributes.parno).toBe("1");
    // no hint: containment
    expect(pickFeature(feats as any, inside2, { wkid: 4326 }, null)!.feature.attributes.parno).toBe("2");
    // hint that matches nothing exactly and a point in the gap: nearest edge
    expect(pickFeature(feats as any, { lon: 0.0005, lat: -0.0001 }, { wkid: 4326 }, "99 ELM ST")!.feature.attributes.parno).toBe("1");
    // far from everything and no useful hint: nothing
    expect(pickFeature(feats as any, { lon: 0.5, lat: 0.5 }, { wkid: 4326 }, "99 ELM ST")).toBeNull();
  });
});

describe("EPSG:2264 -> WGS84 reprojection", () => {
  it("matches the coordinates the service itself returns with outSR=4326 to within 1e-5 degrees: the constant 0.2 m E / 0.8 m N offset is the NAD83 to WGS84 datum shift ArcGIS applies for outSR=4326", () => {
    // Same vertex recorded twice from the live service: native SR (US ft) and outSR=4326.
    const pairs: Array<[[number, number], [number, number]]> = [
      [[2477849.875094801, 677324.6248736382], [-77.39244225755203, 35.60043522299196]],
      [[2477592.124954134, 677498.6248537302], [-77.3932997438656, 35.60092468050493]],
      [[2477752.624961227, 677254.0413533896], [-77.39277320891998, 35.600245649959376]],
      [[2477946.77286689, 677487.350598067], [-77.39210746946506, 35.60087793356721]],
    ];
    for (const [[x, y], [lon, lat]] of pairs) {
      const [l, p] = nc2264ToLonLat(x, y);
      expect(Math.abs(l - lon)).toBeLessThan(1e-5);
      expect(Math.abs(p - lat)).toBeLessThan(1e-5);
    }
    expect(isNcStatePlane({ wkid: 102719, latestWkid: 2264 })).toBe(true);
    expect(isNcStatePlane({ wkid: 4326 })).toBe(false);
    const poly = ringsFrom2264([[[2477849.875094801, 677324.6248736382], [2477592.124954134, 677498.6248537302], [2477946.77286689, 677487.350598067], [2477849.875094801, 677324.6248736382]]]);
    expect(poly.coordinates[0]).toHaveLength(4);
  });
});

describe("NC OneMap selection without an address hint", () => {
  it("falls back to the nearest polygon edge when no parcel contains the geocode", async () => {
    const r = await new NcOneMapParcels(adapterCtx("nc_onemap")).lookup(P);
    expect(r).not.toBeNull();
    const fx = readJson(resolve(ROOT, "fixtures", "http", "nc_onemap", "parcels.json"));
    const env4326 = fx.fixtures.find((e: any) => e.match.url_pattern.includes("outSR=4326")).response.json;
    const dists = env4326.features.map((f: any) => ({ id: f.attributes.parno, d: distanceToPolygonMeters(P, { type: "Polygon", coordinates: f.geometry.rings }) }));
    const nearest = dists.sort((a: any, b: any) => a.d - b.d)[0];
    expect(r!.parcel_id).toBe(nearest.id);
    expect(nearest.d).toBeLessThan(60);
  });
});
