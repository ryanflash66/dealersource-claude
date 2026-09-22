import { describe, expect, it } from "vitest";
import { join, resolve } from "node:path";
import { rmSync, readFileSync, writeFileSync } from "node:fs";
import { ArcgisZoning } from "../../src/providers/zoning.js";
import { CountyGisParcels } from "../../src/providers/parcels.js";
import { ROOT, adapterCtx, cleanEnv, config, readJson, runOffline, tmp, writeFixtureSet } from "../helpers.js";

// 2100 Dickinson Ave, Greenville. Census geocode (street right-of-way) vs NC OneMap parcel centroid.
const GEOCODE = { lat: 35.600682, lon: -77.392251 };
const CENTROID = { lat: 35.600786, lon: -77.39281 };
const GV21 = "https://gisonline.greenvillenc.gov/arcgis/rest/services/OpenData/MapServer/21";
const PITT0 = "https://gis.pittcountync.gov/gis/rest/services/PittOpenData/ZoningPitt/MapServer/0";
const parcelPolygon = () => {
  const fx = readJson(resolve(ROOT, "fixtures", "http", "nc_onemap", "parcels.json"));
  const env = fx.fixtures.find((e: any) => e.match.url_pattern.includes("outSR=4326")).response.json;
  const f = env.features.find((x: any) => x.attributes.parno === "4677776335");
  return { type: "Polygon" as const, coordinates: f.geometry.rings as number[][][] };
};

describe("official zoning layers (recorded 2026-09-18)", () => {
  it("providers.yaml points only at verified layers with the ZONE field", () => {
    const layers = config().providers.options.arcgis!.layers as Record<string, { url: string; district_field: string }>;
    expect(Object.keys(layers).sort()).toEqual(["Greenville", "Pitt County"]);
    expect(layers.Greenville).toEqual({ url: GV21, district_field: "ZONE" });
    expect(layers["Pitt County"]).toEqual({ url: PITT0, district_field: "ZONE" });
    const meta = readJson(resolve(ROOT, "fixtures", "http", "arcgis", "zoning.json")).fixtures;
    const gv = meta.find((e: any) => e.match.url_pattern.includes("MapServer/21\\?f=json")).response.json;
    expect(gv).toMatchObject({ name: "Greenville_Zoning", geometryType: "esriGeometryPolygon" });
    expect(gv.fields.map((f: any) => f.name)).toContain("ZONE");
    const pitt = meta.find((e: any) => e.match.url_pattern.includes("ZoningPitt/MapServer/0\\?f=json")).response.json;
    expect(pitt).toMatchObject({ name: "County Zoning", geometryType: "esriGeometryPolygon" });
    expect(pitt.fields.map((f: any) => f.name)).toEqual(expect.arrayContaining(["ZONE", "USE_"]));
  });

  it("the geocode sits in the right-of-way and matches nothing; the parcel centroid returns ZONE CH", async () => {
    const ctx = adapterCtx("arcgis");
    const z = new ArcgisZoning(ctx);
    expect(await z.lookup(GEOCODE, "GREENVILLE")).toBeNull();
    const hit = await z.lookup(CENTROID, "GREENVILLE");
    expect(hit).toMatchObject({ district: "CH", jurisdiction: "Greenville", dealer_use: "permitted", planning_email: null });
    expect(hit!.citation).toMatch(/9-4-78/);
    expect(ctx.http.requests.every((r) => r.url.startsWith(`${GV21}/query?`))).toBe(true);
    expect(ctx.http.requests[1]!.url).toContain("geometry=-77.39281%2C35.600786");
  });

  it("with the parcel polygon it queries by intersection and picks the district covering most of the parcel", async () => {
    const ctx = adapterCtx("arcgis");
    const hit = await new ArcgisZoning(ctx).lookup(CENTROID, "City of Greenville", { geometry: parcelPolygon() });
    expect(hit?.district).toBe("CH");
    expect(ctx.http.requests).toHaveLength(1);
    expect(ctx.http.requests[0]!.method).toBe("POST");
    expect(ctx.http.requests[0]!.body).toContain("geometryType=esriGeometryPolygon");
    expect(ctx.http.requests[0]!.body).toContain("outFields=ZONE");
    expect(hit!.source_url).toContain("parcel geometry in body");
  });

  it("falls back to the county layer for unincorporated land and reads [] inside town limits", async () => {
    const ctx = adapterCtx("arcgis");
    // Unknown municipality, county known: the Pitt County layer is tried and (inside Greenville) answers [].
    expect(await new ArcgisZoning(ctx).lookup(CENTROID, null, { county: "Pitt" })).toBeNull();
    expect(ctx.http.requests.map((r) => r.url.split("/query")[0])).toEqual([PITT0]);
  });

  it("a jurisdiction without a layer returns null without any HTTP request (no guessed URLs)", async () => {
    for (const j of ["Ayden", "Winterville", "City of Washington", "Farmville", "Kinston"]) {
      const ctx = adapterCtx("arcgis");
      expect(await new ArcgisZoning(ctx).lookup(CENTROID, j)).toBeNull();
      expect(ctx.http.requests).toHaveLength(0);
    }
  });

  it("county parcels fallback reads Pitt CadastralPitt (NCPIN = OneMap parno, Municipality, Acres)", async () => {
    const r = await new CountyGisParcels(adapterCtx("county")).lookup(CENTROID, { county: "Pitt" });
    expect(r).toMatchObject({ parcel_id: "4677776335", owner: "WARD HOLDINGS LLC", jurisdiction: "GREENVILLE", county: "Pitt" });
    expect(r!.acreage).toBeGreaterThan(0.5);
    expect(r!.site_address).toMatch(/2100.*DICKINSON/);
    expect(r!.geometry?.type).toBe("Polygon");
  });
});

describe("enrichment degrades per site instead of aborting the run", () => {
  it("a missing flood answer leaves that gate pending, records a warning on the site, and the report is still written", async () => {
    const dir = tmp();
    const fx = writeFixtureSet(join(dir, "fx"), [
      { listing_id: "L1", address: "10 Good St, Greenville, NC 27834", parcel_id: "G1" },
      { listing_id: "L2", address: "20 Broken St, Greenville, NC 27834", parcel_id: "B1" },
    ]);
    const flood = JSON.parse(readFileSync(join(fx, "flood.json"), "utf8"));
    delete flood.B1; // the flood provider throws for this parcel
    writeFileSync(join(fx, "flood.json"), JSON.stringify(flood));
    const out = join(dir, "out");
    const r = await runOffline({ fixturesDir: fx, outDir: out, runDate: "2026-09-16" });
    expect(r.run.errors).toEqual([]); // exit 0: nothing failed entirely
    expect(r.report).not.toBeNull();
    expect(readJson(join(out, "report.json")).sites).toHaveLength(2);
    expect(readJson(join(out, "state", "state.json")).reports).toHaveLength(1);
    const broken = r.report!.sites.find((s) => s.parcel_id === "B1")!;
    expect(broken.gates.flood.status).toBe("pending");
    expect(broken.gates.zoning.status).toBe("pass"); // the other layers still ran
    expect(broken.gates.rent.status).toBe("pass");
    expect(broken.flags.some((f) => /flood layer unavailable/.test(f))).toBe(true);
    expect(r.run.warnings.some((w) => /flood layer unavailable for 20 Broken St/.test(w))).toBe(true);
    expect(r.run.counts["enrich.sites_enriched_with_warnings"]).toBe(1);
    const good = r.report!.sites.find((s) => s.parcel_id === "G1")!;
    expect(good.viable).toBe(true);
    expect(good.rank).toBe(1);
  });

  it("a jurisdiction with no zoning answer gets a pending gate and a planning case, not an error", async () => {
    const dir = tmp();
    const fx = writeFixtureSet(join(dir, "fx"), [{ listing_id: "L1", address: "5 Main St, Ayden, NC 28513", parcel_id: "A1", planning_email: "planning@aydennc.gov" }]);
    const zoning = JSON.parse(readFileSync(join(fx, "zoning.json"), "utf8"));
    delete zoning.A1; // no layer covers this parcel
    writeFileSync(join(fx, "zoning.json"), JSON.stringify(zoning));
    const r = await runOffline({ fixturesDir: fx, outDir: join(dir, "out"), runDate: "2026-09-16" });
    expect(r.run.errors).toEqual([]);
    const s = r.report!.sites[0]!;
    expect(s.gates.zoning.status).toBe("pending");
    expect(s.gates.flood.status).toBe("pass");
    // no planning email is known for this parcel (no layer, no jurisdiction match) -> escalated once, named
    expect(s.open_cases).toHaveLength(1);
    expect(s.open_cases[0]).toMatchObject({ case_type: "zoning", status: "escalated" });
    expect(s.open_cases[0]!.next_action).toMatch(/no planning email/);
    rmSync(join(dir, "out"), { recursive: true, force: true });
  });
});

describe("source-level leasing contact", () => {
  it("a listing without an email uses the source's contact_email; without either it escalates once and names the gap", async () => {
    const dir = tmp();
    const fx = writeFixtureSet(join(dir, "fx"), [
      { listing_id: "L1", address: "1 Broker St, Greenville, NC 27834", parcel_id: "S1", rent_monthly: null, contact_email: null, source_id: "broker-with-contact" },
      { listing_id: "L2", address: "2 Silent St, Greenville, NC 27834", parcel_id: "S2", rent_monthly: null, contact_email: null, source_id: "broker-silent" },
    ]);
    const cfg = config();
    const sources = [
      ...cfg.sources,
      { id: "broker-with-contact", kind: "crawl", url: "https://broker-with-contact.test/", robots_txt: "allowed", terms_status: "allowed", enabled: true, cadence: "daily", fixture_only: false, contact_email: "office@broker-with-contact.test", notes: null },
      { id: "broker-silent", kind: "crawl", url: "https://broker-silent.test/", robots_txt: "allowed", terms_status: "allowed", enabled: true, cadence: "daily", fixture_only: false, contact_email: "", notes: null },
    ];
    const out = join(dir, "out");
    const r1 = await runOffline({ fixturesDir: fx, outDir: out, runDate: "2026-09-16", configOverrides: { sources: { sources } } });
    expect(r1.messages.map((m) => [m.case_type, m.to])).toEqual([["rent", "office@broker-with-contact.test"]]);
    const silent = r1.report!.sites.find((s) => s.parcel_id === "S2")!;
    expect(silent.open_cases).toHaveLength(1);
    expect(silent.open_cases[0]).toMatchObject({ case_type: "rent", status: "escalated", recipient: "none" });
    expect(silent.open_cases[0]!.next_action).toMatch(/no leasing contact for 2 Silent St.*listing L2.*contact_email on the source/);
    expect(r1.report!.exceptions.some((e) => /no leasing contact for 2 Silent St/.test(e))).toBe(true);
    expect(r1.run.counts["verify.cases_escalated_no_contact"]).toBe(1);

    // Next day, still no contact: escalated once, not again.
    const r2 = await runOffline({ fixturesDir: fx, outDir: out, runDate: "2026-09-17", configOverrides: { sources: { sources } } });
    expect(r2.run.counts["verify.cases_escalated_no_contact"] ?? 0).toBe(0);
    expect(r2.messages).toEqual([]);

    // The PM fills in the source contact: the escalated case reopens and the inquiry goes out.
    const filled = sources.map((s) => (s.id === "broker-silent" ? { ...s, contact_email: "leasing@broker-silent.test" } : s));
    const r3 = await runOffline({ fixturesDir: fx, outDir: out, runDate: "2026-09-18", configOverrides: { sources: { sources: filled } } });
    expect(r3.run.counts["verify.cases_reopened_with_contact"]).toBe(1);
    expect(r3.messages.map((m) => [m.case_type, m.to])).toEqual([["rent", "leasing@broker-silent.test"]]);
  });

  it("sources.yaml carries the Ron Harrell entry with the contact_email published on the broker's site", () => {
    const s = config().sources.find((x) => x.id === "ron-harrell-commercial");
    expect(s).toBeDefined();
    expect(s!.contact_email).toBe("info@ronharrellandassociates.com");
  });
});

describe("planning contact re-sync from business.yaml", () => {
  it("a corrected planning address replaces the cached one on the site and on the open case before anything is sent", async () => {
    const dir = tmp();
    const fx = writeFixtureSet(join(dir, "fx"), [{ listing_id: "L1", address: "9 Ask St, Greenville, NC 27834", parcel_id: "P1", dealer_use: "unknown", planning_email: null }]); // the layer publishes no contact
    const out = join(dir, "out");
    const withPlanning = (email: string) => {
      const business = JSON.parse(JSON.stringify(config().business));
      business.jurisdictions.Greenville.planning_email = email;
      return { business };
    };
    const paused = { ...cleanEnv(), DEALERSOURCE_PAUSE_SENDING: "1" };

    const r1 = await runOffline({ fixturesDir: fx, outDir: out, runDate: "2026-09-16", env: paused, configOverrides: withPlanning("first@greenvillenc.test") });
    expect(r1.run.errors).toEqual([]);
    expect(r1.report!.sites[0]!.open_cases).toEqual([expect.objectContaining({ case_type: "zoning", status: "open", recipient: "first@greenvillenc.test" })]);

    // The deployer corrects the address: the site and its unsent case follow the config, no new case is opened.
    const r2 = await runOffline({ fixturesDir: fx, outDir: out, runDate: "2026-09-17", env: paused, configOverrides: withPlanning("second@greenvillenc.test") });
    expect(r2.run.errors).toEqual([]);
    expect(r2.run.counts["enrich.planning_email_resynced"]).toBe(1);
    expect(r2.run.counts["verify.cases_contact_replaced"]).toBe(1);
    expect(r2.report!.sites[0]!.open_cases).toEqual([expect.objectContaining({ case_type: "zoning", status: "open", recipient: "second@greenvillenc.test" })]);
    rmSync(out, { recursive: true, force: true });
  });
});
