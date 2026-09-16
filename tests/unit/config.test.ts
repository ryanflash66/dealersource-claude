import { describe, expect, it } from "vitest";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { LAYERS, contractProviders } from "../../src/config/schema.js";
import { ADAPTERS, buildProviders, adapterIds } from "../../src/providers/registry.js";
import { PaidProviderDisabledError, CostLedger } from "../../src/http/cost-ledger.js";
import { makeClock } from "../../src/core/clock.js";
import { silentLogger } from "../../src/core/logger.js";
import { ROOT, GOLDEN, cleanEnv, config } from "../helpers.js";

describe("configuration", () => {
  it("root providers.yaml and business.yaml exist with the section 14.1 keys and defaults", () => {
    expect(existsSync(resolve(ROOT, "providers.yaml"))).toBe(true);
    expect(existsSync(resolve(ROOT, "business.yaml"))).toBe(true);
    expect(existsSync(resolve(ROOT, ".env.example"))).toBe(true);
    const p = contractProviders(config().providers);
    expect(p).toMatchObject({ paid_enabled: false, geocoder: "census", parcels: "nc_onemap", drivetime: "ors", imagery: "mapillary", poi: "overpass", crawler: "anycrawl", tiles: "protomaps" });
  });

  it("business.yaml carries every section 2 key plus score.weights", () => {
    const b = config().business;
    expect(b.search.home_base).toBe("Greenville, NC 27858");
    expect(b.search.max_drive_minutes).toBe(60);
    expect(b.rent).toEqual({ min_monthly: 600, max_monthly: 1000 });
    expect(b.site).toEqual({ min_vehicle_display: 2, office_required: true, shared_lot: "last_resort" });
    expect(b.flood.high_risk_zones).toEqual(["A", "AE", "AH", "AO", "AR", "A99", "V", "VE"]);
    expect(b.dealer.license_status).toBe("held");
    expect(Object.keys(b.score.weights).sort()).toEqual(["competitors", "distance", "rent", "traffic", "visibility"]);
  });

  it("DEALERSOURCE_HOME_BASE overrides the dev placeholder at deploy time", () => {
    const cfg = config({ env: { ...cleanEnv(), DEALERSOURCE_HOME_BASE: "1 Real Dealer Way, Kinston, NC 28501" } });
    expect(cfg.business.search.home_base).toBe("1 Real Dealer Way, Kinston, NC 28501");
  });

  it("every layer's selected adapter exists and every adapter id is unique per layer", () => {
    const cfg = config();
    for (const layer of LAYERS) expect(adapterIds(layer)).toContain(cfg.providers[layer]);
    const seen = new Set<string>();
    for (const a of ADAPTERS) {
      const key = `${a.layer}:${a.id}`;
      expect(seen.has(key)).toBe(false);
      seen.add(key);
    }
  });

  it("rejects an unknown provider id at load time", () => {
    const cfg = config();
    expect(() => config({ overrides: { providers: { ...rawProviders(cfg), geocoder: "mapquest" } } })).toThrow();
  });

  it("switching geocoder census -> nominatim is a config change only", () => {
    const cfg = config();
    const switched = config({ overrides: { providers: { ...rawProviders(cfg), geocoder: "nominatim" } } });
    expect(switched.providers.geocoder).toBe("nominatim");
    const built = buildProviders({ config: switched, env: cleanEnv(), clock: makeClock(null), logger: silentLogger, offline: true, fixturesDir: GOLDEN, outDir: null, ledger: new CostLedger(), hosts: new Set() });
    expect(built.providers.geocoder.name).toBe("nominatim");
  });

  it("selecting a paid adapter while paid_enabled is false is a startup error, so no paid call can happen", () => {
    const cfg = config();
    for (const [layer, id] of [["geocoder", "google"], ["parcels", "regrid"], ["drivetime", "google"], ["imagery", "streetview"], ["poi", "places"], ["crawler", "anycrawl_cloud"], ["llm", "claude_api"], ["tiles", "mapbox"]] as const) {
      const c = config({ overrides: { providers: { ...rawProviders(cfg), [layer]: id } } });
      expect(() =>
        buildProviders({ config: c, env: cleanEnv(), clock: makeClock(null), logger: silentLogger, offline: true, fixturesDir: GOLDEN, outDir: null, ledger: new CostLedger(), hosts: new Set() }),
      ).toThrow(PaidProviderDisabledError);
    }
  });

  it("with paid_enabled true the same paid selection builds (and is fixture-served offline)", () => {
    const cfg = config();
    const c = config({ overrides: { providers: { ...rawProviders(cfg), paid_enabled: true, geocoder: "google" } } });
    const built = buildProviders({ config: c, env: cleanEnv(), clock: makeClock(null), logger: silentLogger, offline: true, fixturesDir: GOLDEN, outDir: null, ledger: new CostLedger(), hosts: new Set() });
    expect(built.providers.geocoder.name).toBe("google");
    expect(built.fixtureLayers).toContain("geocoder");
  });

  it("default configuration selects no paid adapter anywhere", () => {
    const cfg = config();
    for (const layer of LAYERS) {
      const spec = ADAPTERS.find((a) => a.layer === layer && a.id === cfg.providers[layer]);
      expect(spec?.paid).toBe(false);
    }
  });
});

function rawProviders(cfg: ReturnType<typeof config>) {
  return structuredClone(cfg.providers);
}
