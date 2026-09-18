import { describe, expect, it } from "vitest";
import { join, resolve } from "node:path";
import { rmSync } from "node:fs";
import Ajv2020Module from "ajv/dist/2020.js";
import addFormatsModule from "ajv-formats";
import { ROOT, readJson, runOffline, tmp, writeFixtureSet } from "../helpers.js";

const Ajv2020 = ((Ajv2020Module as any).default ?? Ajv2020Module) as new (o: object) => import("ajv/dist/2020.js").default;
const addFormats = ((addFormatsModule as any).default ?? addFormatsModule) as (a: unknown) => void;

describe("unknown drive time is not 'outside the search area'", () => {
  it("gates and verifies the site, records a warning, and leaves it unranked", async () => {
    const dir = tmp();
    const fx = writeFixtureSet(join(dir, "fx"), [
      { listing_id: "L1", address: "10 Test St, Greenville, NC 27834", parcel_id: "P1" }, // rent 800, permitted, zone X
      { listing_id: "L2", address: "20 Ask St, Greenville, NC 27834", parcel_id: "P2", rent_monthly: null, contact_email: "owner@ask.test" },
    ]);
    rmSync(join(fx, "drivetime.json")); // no drive-time provider answer for any site
    const out = join(dir, "out");
    const r = await runOffline({ fixturesDir: fx, outDir: out, runDate: "2026-09-16" });

    expect(r.run.errors).toEqual([]);
    expect(r.run.warnings.filter((w) => /drive time unavailable/.test(w))).toHaveLength(2);
    expect(r.run.counts["enrich.drivetime_unavailable"]).toBe(2);
    expect(r.run.counts["enrich.sites_out_of_area"] ?? 0).toBe(0);

    const p1 = r.report!.sites.find((s) => s.parcel_id === "P1")!;
    expect(p1.in_search_area).toBeNull();
    expect(p1.drive_minutes).toBeNull();
    // enrichment still happened
    expect(p1.gates.zoning.status).toBe("pass");
    expect(p1.gates.rent.status).toBe("pass");
    expect(p1.gates.flood.status).toBe("pass");
    const facts = new Set(r.report!.evidence.filter((e) => e.site_id === p1.site_id).map((e) => e.fact));
    expect([...facts]).toEqual(expect.arrayContaining(["zoning_permitted", "flood_zone", "traffic_aadt", "competitor_count"]));
    expect(facts.has("drive_minutes")).toBe(false);
    // gated but not ranked
    expect(p1.viable).toBe(true);
    expect(p1.rank).toBeNull();
    expect(p1.stage).toBe("verifying");
    expect(p1.flags.some((f) => /drive time unknown/.test(f))).toBe(true);
    expect(p1.metrics.aadt).toBe(15000);

    // verification still runs: the rent inquiry for P2 goes out
    expect(r.messages.map((m) => [m.case_type, m.to])).toEqual([["rent", "owner@ask.test"]]);
    const p2 = r.report!.sites.find((s) => s.parcel_id === "P2")!;
    expect(p2.in_search_area).toBeNull();
    expect(p2.open_cases[0]).toMatchObject({ case_type: "rent", status: "awaiting_reply" });

    // report.json still validates against the (locally widened) contract schema
    const ajv = new Ajv2020({ allErrors: true, strict: false });
    addFormats(ajv);
    const validate = ajv.compile(readJson(resolve(ROOT, "tests", "contract", "report.schema.json")));
    expect(validate(readJson(join(out, "report.json"))), JSON.stringify(validate.errors)).toBe(true);
  });

  it("once the drive time becomes known, the same site is ranked", async () => {
    const dir = tmp();
    const fx = writeFixtureSet(join(dir, "fx"), [{ listing_id: "L1", address: "10 Test St, Greenville, NC 27834", parcel_id: "P1" }]);
    rmSync(join(fx, "drivetime.json"));
    const out = join(dir, "out");
    const first = await runOffline({ fixturesDir: fx, outDir: out, runDate: "2026-09-16" });
    expect(first.report!.sites[0]!.rank).toBeNull();
    // provider comes back the next day
    writeFixtureSet(join(dir, "fx"), [{ listing_id: "L1", address: "10 Test St, Greenville, NC 27834", parcel_id: "P1", minutes: 12 }]);
    const second = await runOffline({ fixturesDir: fx, outDir: out, runDate: "2026-09-17" });
    const s = second.report!.sites[0]!;
    expect(s.in_search_area).toBe(true);
    expect(s.drive_minutes).toBe(12);
    expect(s.rank).toBe(1);
    expect(second.run.warnings.some((w) => /drive time unavailable/.test(w))).toBe(false);
  });

  it("a confirmed long drive still excludes the site before any gate runs", async () => {
    const dir = tmp();
    const fx = writeFixtureSet(join(dir, "fx"), [{ listing_id: "L1", address: "10 Far St, Goldsboro, NC 27534", parcel_id: "F1", minutes: 78 }]);
    const r = await runOffline({ fixturesDir: fx, outDir: join(dir, "out"), runDate: "2026-09-16" });
    const s = r.report!.sites[0]!;
    expect(s.in_search_area).toBe(false);
    expect(s.gates.zoning.status).toBe("pending");
    expect(r.report!.evidence.some((e) => e.site_id === s.site_id && e.fact === "flood_zone")).toBe(false);
    expect(r.messages).toEqual([]);
  });
});
