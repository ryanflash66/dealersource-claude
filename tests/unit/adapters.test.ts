import { describe, expect, it } from "vitest";
import { CensusGeocoder, GoogleGeocoder, NominatimGeocoder } from "../../src/providers/geocoding.js";
import { NcOneMapParcels } from "../../src/providers/parcels.js";
import { ArcgisZoning } from "../../src/providers/zoning.js";
import { OpenRouteServiceDriveTime, ValhallaDriveTime } from "../../src/providers/drivetime.js";
import { NcdotAadt } from "../../src/providers/traffic.js";
import { FemaNfhlFlood } from "../../src/providers/flood.js";
import { MapillaryImagery } from "../../src/providers/imagery.js";
import { OverpassPoi } from "../../src/providers/competitors.js";
import { AnyCrawlSelfHosted } from "../../src/providers/crawl.js";
import { RedditSocial } from "../../src/providers/social.js";
import { GmailMail } from "../../src/providers/mail.js";
import { FixtureMissError } from "../../src/http/fixture-client.js";
import { CostLedger, MeteredHttpClient } from "../../src/http/cost-ledger.js";
import { adapterCtx } from "../helpers.js";

const POINT = { lat: 35.577, lon: -77.4 };
const ADDR = "2400 S Memorial Dr, Greenville, NC 27834";

describe("adapters against recorded HTTP fixtures", () => {
  it("census geocoder parses a onelineaddress match", async () => {
    const ctx = adapterCtx("census");
    const r = await new CensusGeocoder(ctx).geocode(ADDR);
    expect(r).toMatchObject({ lat: 35.577, lon: -77.4, zip: "27834", city: "GREENVILLE" });
    expect(r!.canonical_address).toMatch(/2400 S MEMORIAL DR/);
    expect(ctx.http.requests[0]!.url).toMatch(/^https:\/\/geocoding\.geo\.census\.gov\/geocoder\/locations\/onelineaddress\?address=2400\+S\+Memorial.*benchmark=Public_AR_Current/);
    expect(await new CensusGeocoder(ctx).geocode("Hwy 11 lot near Bethel, NC")).toBeNull();
  });

  it("nominatim geocoder hits the self-hosted base URL from NOMINATIM_URL and never the public server", async () => {
    const ctx = adapterCtx("nominatim", { NOMINATIM_URL: "http://nominatim.internal:8080/" });
    const r = await new NominatimGeocoder(ctx).geocode(ADDR);
    expect(r).toMatchObject({ zip: "27834", city: "Greenville" });
    expect(r!.lat).toBeCloseTo(35.577, 3);
    expect(ctx.http.requests[0]!.url.startsWith("http://nominatim.internal:8080/search?q=2400+S+Memorial")).toBe(true);
    const pub = adapterCtx("nominatim", { NOMINATIM_URL: "https://nominatim.openstreetmap.org" });
    await expect(new NominatimGeocoder(pub).geocode(ADDR)).rejects.toThrow(/must not be used/);
  });

  it("census and nominatim produce different request URLs for the same address (switch changes behaviour)", async () => {
    const c = adapterCtx("census");
    const n = adapterCtx("nominatim");
    await new CensusGeocoder(c).geocode(ADDR);
    await new NominatimGeocoder(n).geocode(ADDR);
    expect(new URL(c.http.requests[0]!.url).host).toBe("geocoding.geo.census.gov");
    expect(new URL(n.http.requests[0]!.url).host).toBe("localhost:8080");
  });

  it("google geocoder (PAID) is metered: every call lands in the cost ledger", async () => {
    const ctx = adapterCtx("google", { GOOGLE_MAPS_API_KEY: "k" });
    const ledger = new CostLedger();
    ctx.http = new MeteredHttpClient(ctx.http, "geocoder:google", "paid", ledger, ctx.clock) as any;
    const r = await new GoogleGeocoder(ctx).geocode(ADDR);
    expect(r).toMatchObject({ city: "Greenville", zip: "27834" });
    expect(r!.source_url).not.toContain("key=k");
    expect(ledger.calls).toHaveLength(1);
    expect(ledger.calls[0]).toMatchObject({ adapter: "geocoder:google", cost_class: "paid" });
  });

  it("nc_onemap parcels parses PARNO, owner, acreage and rings", async () => {
    const r = await new NcOneMapParcels(adapterCtx("nc_onemap")).lookup(POINT);
    expect(r).toMatchObject({ parcel_id: "4676.01", owner: "MEMORIAL DRIVE HOLDINGS LLC", acreage: 0.62, jurisdiction: "GREENVILLE", county: "PITT" });
    expect(r!.geometry?.coordinates[0]).toHaveLength(5);
    expect(await new NcOneMapParcels(adapterCtx("nc_onemap")).lookup({ lat: 0, lon: 0 })).toBeNull();
  });

  it("arcgis zoning resolves district -> use table status with the cited section", async () => {
    const z = new ArcgisZoning(adapterCtx("arcgis"));
    const ch = await z.lookup(POINT, "City of Greenville");
    expect(ch).toMatchObject({ district: "CH", jurisdiction: "Greenville", dealer_use: "permitted", planning_email: "planning@greenvillenc.gov" });
    expect(ch!.citation).toMatch(/9-4-78/);
    const mo = await z.lookup({ lat: 35.61, lon: -77.38 }, "Greenville");
    expect(mo!.dealer_use).toBe("prohibited");
    const r6 = await z.lookup({ lat: 35.6, lon: -77.39 }, "Greenville");
    expect(r6!.dealer_use).toBe("unknown"); // not in the use table -> planning case
    expect(await z.lookup(POINT, "Bethel")).toBeNull(); // no layer configured
  });

  it("ors drive time returns minutes and an isochrone polygon", async () => {
    const d = new OpenRouteServiceDriveTime(adapterCtx("ors", { ORS_API_KEY: "k" }));
    const r = await d.driveMinutes({ lat: 35.6, lon: -77.37 }, POINT);
    expect(r.minutes).toBe(10);
    expect(r.distance_m).toBeCloseTo(8240.5);
    const iso = await d.isochrone({ lat: 35.6, lon: -77.37 }, 60);
    expect(iso!.polygon.type).toBe("Polygon");
  });

  it("valhalla drive time parses trip summary", async () => {
    const r = await new ValhallaDriveTime(adapterCtx("valhalla", { VALHALLA_URL: "http://valhalla.internal:8002" })).driveMinutes({ lat: 35.6, lon: -77.37 }, POINT);
    expect(r).toMatchObject({ minutes: 9, distance_m: 9100 });
    expect(r.source_url).toBe("http://valhalla.internal:8002/route");
  });

  it("ncdot picks the nearest AADT station", async () => {
    const r = await new NcdotAadt(adapterCtx("ncdot")).aadtNear(POINT);
    expect(r).toMatchObject({ aadt: 32000, road: "S Memorial Dr", year: 2024 });
    expect(r!.station_distance_m).toBeLessThan(50);
  });

  it("fema computes centroid zone and share of parcel area in high-risk zones", async () => {
    const parcel = { type: "Polygon" as const, coordinates: [[[-77.4006, 35.5766], [-77.3994, 35.5766], [-77.3994, 35.5774], [-77.4006, 35.5774], [-77.4006, 35.5766]]] };
    const r = await new FemaNfhlFlood(adapterCtx("fema")).zonesFor(parcel, { lat: 35.577, lon: -77.4 }, ["A", "AE", "VE"]);
    expect(r.zone).toBe("X");
    expect(r.pct_area_high_risk).toBeGreaterThan(20);
    expect(r.pct_area_high_risk).toBeLessThan(40);
    expect(r.zone_shares.map((s) => s.zone).sort()).toEqual(["AE", "X"]);
  });

  it("mapillary lists nearby street-level images with capture dates", async () => {
    const r = await new MapillaryImagery(adapterCtx("mapillary", { MAPILLARY_ACCESS_TOKEN: "MLY|t" })).nearby(POINT);
    expect(r.images).toHaveLength(2);
    expect(r.images[0]).toMatchObject({ kind: "street", provider: "mapillary" });
    expect(r.images[0]!.captured_at).toMatch(/^2024-06/);
    expect(r.source_url).not.toContain("MLY|t");
  });

  it("overpass counts car dealers and finds estate agents with websites", async () => {
    const p = new OverpassPoi(adapterCtx("overpass"));
    const dealers = await p.dealersWithin(POINT, 3000);
    expect(dealers.count).toBe(2);
    expect(dealers.items.map((i) => i.name)).toContain("Memorial Auto Sales");
    const agents = await p.estateAgentsWithin(POINT, 25000);
    expect(agents.items.filter((i) => i.tags.website)).toHaveLength(1);
  });

  it("anycrawl fetches a page and honours robots.txt", async () => {
    const c = new AnyCrawlSelfHosted(adapterCtx("anycrawl", { ANYCRAWL_URL: "http://anycrawl.internal:8080" }));
    const page = await c.fetchPage("https://www.greenvillenc.gov/business/economic-development/available-properties");
    expect(page.status).toBe(200);
    expect(page.body).toContain("2400 S Memorial Dr");
    const robots = await c.checkRobots("https://www.greenvillenc.gov/business/available", "dealersource/0.1");
    expect(robots).toMatchObject({ allowed: true, checked: true });
    expect((await c.checkRobots("https://www.greenvillenc.gov/admin/x", "dealersource/0.1")).allowed).toBe(false);
    await expect(c.fetchPage("https://other.test/")).rejects.toThrow(/AnyCrawl failed/);
  });

  it("reddit uses OAuth client credentials then the search endpoint", async () => {
    const ctx = adapterCtx("reddit", { REDDIT_CLIENT_ID: "id", REDDIT_CLIENT_SECRET: "s" });
    const posts = await new RedditSocial(ctx).search(["greenvillenc", "ECU"], ["for lease", "vacant lot"], 25);
    expect(posts).toHaveLength(1);
    expect(posts[0]).toMatchObject({ id: "abc123", subreddit: "greenvillenc" });
    expect(ctx.http.requests[0]!.url).toContain("access_token");
    expect(ctx.http.requests[1]!.url).toContain("/r/greenvillenc+ECU/search?q=for+lease");
  });

  it("gmail sends RFC822 mail and parses replies, tokens and bounces", async () => {
    const ctx = adapterCtx("gmail", { GMAIL_CLIENT_ID: "a", GMAIL_CLIENT_SECRET: "b", GMAIL_REFRESH_TOKEN: "c", GMAIL_SENDER_ADDRESS: "dealer@example.test" });
    const g = new GmailMail(ctx);
    const sent = await g.send({ to: "owner@tenth-street-props.test", subject: "Inquiry [DS-2D276E]", body: "hello", token: "2D276E", replyTo: null });
    expect(sent.provider_message_id).toBe("18c1f2a3b4c5d6e7");
    const raw = JSON.parse(ctx.http.requests.find((r) => r.url.endsWith("/send"))!.body!).raw as string;
    const decoded = Buffer.from(raw, "base64url").toString("utf8");
    expect(decoded).toContain("To: owner@tenth-street-props.test");
    expect(decoded).toContain("Reply-To: dealer@example.test");
    const inbound = await g.fetchInbound({ since: "2026-09-01T00:00:00Z", until: "2026-09-16T23:59:59Z", threads: [{ token: "2D276E", listing_ids: ["L04"], case_types: ["rent"], contact_email: "owner@tenth-street-props.test", address: "" }] });
    expect(inbound).toHaveLength(2);
    const reply = inbound.find((m) => m.token === "2D276E")!;
    expect(reply.from).toBe("owner@tenth-street-props.test");
    expect(reply.body).toContain("$850 per month");
    expect(reply.listing_id).toBe("L04");
    expect(inbound.find((m) => m.token === "AAAAAA")!.is_bounce).toBe(true);
  });

  it("gmail refuses planning addresses whose jurisdiction entry is not verified", async () => {
    const ctx = adapterCtx("gmail", { GMAIL_CLIENT_ID: "a", GMAIL_CLIENT_SECRET: "b", GMAIL_REFRESH_TOKEN: "c", GMAIL_SENDER_ADDRESS: "dealer@example.test" });
    await expect(new GmailMail(ctx).send({ to: "planning@greenvillenc.gov", subject: "x", body: "y", token: "T", replyTo: null })).rejects.toThrow(/not verified/);
  });

  it("a request with no recorded fixture fails loudly instead of silently succeeding", async () => {
    await expect(new CensusGeocoder({ ...adapterCtx("census"), options: { base_url: "https://elsewhere.test" } }).geocode(ADDR)).rejects.toThrow(FixtureMissError);
  });
});
