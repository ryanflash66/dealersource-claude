import { describe, expect, it } from "vitest";
import { join } from "node:path";
import { refusalReason, splitListingBlocks } from "../../src/pipeline/discover.js";
import { config, readJson, runOffline, tmp, writeFixtureSet } from "../helpers.js";

describe("source allowlist", () => {
  it("refuses prohibited terms and disallowed robots regardless of enabled; unclear waits for the PM", () => {
    expect(refusalReason({ terms_status: "prohibited", robots_txt: "allowed", enabled: true })).toMatch(/prohibited/);
    expect(refusalReason({ terms_status: "allowed", robots_txt: "disallowed", enabled: true })).toMatch(/disallowed/);
    expect(refusalReason({ terms_status: "unclear", robots_txt: "allowed", enabled: true })).toMatch(/unclear/);
    expect(refusalReason({ terms_status: "allowed", robots_txt: "unknown", enabled: false })).toBe("disabled");
    expect(refusalReason({ terms_status: "allowed", robots_txt: "allowed", enabled: true })).toBeNull();
  });

  it("sources.yaml records LoopNet, Crexi, Craigslist and Facebook Marketplace as prohibited and refused", () => {
    const cfg = config();
    for (const id of ["loopnet", "crexi", "craigslist-eastern-nc", "facebook-marketplace"]) {
      const s = cfg.sources.find((x) => x.id === id);
      expect(s, id).toBeDefined();
      expect(s!.terms_status).toBe("prohibited");
      expect(s!.enabled).toBe(false);
      expect(refusalReason(s!)).toMatch(/prohibited/);
      expect(s!.notes).toBeTruthy();
    }
    expect(cfg.sources.some((s) => s.kind === "reddit" && refusalReason(s) === null)).toBe(true);
  });

  it("a fixture listing from a prohibited source is refused and never becomes a site", async () => {
    const dir = tmp();
    const fx = writeFixtureSet(join(dir, "fx"), [
      { listing_id: "L1", address: "1 Ok St, Greenville, NC 27834", parcel_id: "P1", source_id: "broker-ok" },
      { listing_id: "L2", address: "2 Bad St, Greenville, NC 27834", parcel_id: "P2", source_id: "loopnet" },
    ]);
    const out = join(dir, "out");
    const r = await runOffline({ fixturesDir: fx, outDir: out, runDate: "2026-09-16" });
    expect(r.report!.sites.map((s) => s.parcel_id)).toEqual(["P1"]);
    expect(r.run.counts["discover.listings_refused"]).toBe(1);
    const state = readJson(join(out, "state", "state.json"));
    const l2 = state.listings.find((l: any) => l.id === "L2");
    expect(l2.status).toBe("refused");
    expect(r.report!.exceptions.some((e) => /loopnet/.test(e))).toBe(true);
  });

  it("splits a listings page into per-listing blocks that mention NC", () => {
    const html = `<ul><li>2400 S Memorial Dr, Greenville, NC</li><li>About us</li><li>210 W Main St, Washington, NC</li></ul>`;
    expect(splitListingBlocks(html)).toHaveLength(2);
    expect(splitListingBlocks("<p>no structure</p>")).toHaveLength(1);
  });
});
