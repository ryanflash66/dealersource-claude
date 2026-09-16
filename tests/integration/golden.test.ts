import { beforeAll, describe, expect, it } from "vitest";
import { join, resolve } from "node:path";
import { existsSync } from "node:fs";
import Ajv2020Module from "ajv/dist/2020.js";
import addFormatsModule from "ajv-formats";
import { GOLDEN, GOLDEN_RUN_DATE, ROOT, readJson, runOffline, tmp, writeProvidersYaml } from "../helpers.js";
import type { RunResult } from "../../src/pipeline/run.js";
import { NetworkDisabledError } from "../../src/http/network-guard.js";

// ajv ships CommonJS; under NodeNext the default import may be the module namespace.
const Ajv2020 = ((Ajv2020Module as any).default ?? Ajv2020Module) as new (o: object) => import("ajv/dist/2020.js").default;
const addFormats = ((addFormatsModule as any).default ?? addFormatsModule) as (a: unknown) => void;

const expected = readJson(resolve(GOLDEN, "expected.json"));
const ajv = new Ajv2020({ allErrors: true, strict: false });
addFormats(ajv);
const schema = (name: string) => ajv.compile(readJson(resolve(ROOT, "tests", "contract", `${name}.schema.json`)));

describe("golden-v1 fixture run (spec sections 13 and 14)", () => {
  let out: string;
  let run1: RunResult;
  let run2: RunResult;

  beforeAll(async () => {
    out = join(tmp("golden-"), "out");
    run1 = await runOffline({ fixturesDir: GOLDEN, outDir: out, runDate: GOLDEN_RUN_DATE });
    run2 = await runOffline({ fixturesDir: GOLDEN, outDir: out, runDate: GOLDEN_RUN_DATE });
  });

  it("writes report.json, messages.json and run.json that validate against the contract schemas", () => {
    for (const f of ["report.json", "messages.json", "run.json"]) expect(existsSync(join(out, f)), f).toBe(true);
    expect(existsSync(join(out, "state", "state.json"))).toBe(true);
    const report = readJson(join(out, "report.json"));
    const messages = readJson(join(out, "messages.json"));
    const run = readJson(join(out, "run.json"));
    for (const [name, data] of [["report", report], ["messages", messages], ["run", run]] as const) {
      const v = schema(name);
      const ok = v(data);
      expect(ok, `${name}: ${JSON.stringify(v.errors)}`).toBe(true);
    }
    expect(report.schema_version).toBe("1");
    expect(report.run_date).toBe(GOLDEN_RUN_DATE);
    expect(report.offline).toBe(true);
  });

  it("reproduces expected.json site by site", () => {
    const byParcel = new Map(run1.report!.sites.map((s) => [s.parcel_id, s]));
    expect([...byParcel.keys()].sort()).toEqual(Object.keys(expected.sites).sort());
    for (const [parcel, exp] of Object.entries<any>(expected.sites)) {
      const s = byParcel.get(parcel)!;
      expect(s.listing_ids.slice().sort(), parcel).toEqual(exp.listing_ids.slice().sort());
      expect(s.in_search_area, parcel).toBe(exp.in_search_area);
      expect(s.shared_lot, parcel).toBe(exp.shared_lot);
      expect(s.viable, parcel).toBe(exp.viable);
      if (exp.gates) {
        expect(s.gates.zoning.status, `${parcel} zoning`).toBe(exp.gates.zoning);
        expect(s.gates.rent.status, `${parcel} rent`).toBe(exp.gates.rent);
        expect(s.gates.flood.status, `${parcel} flood`).toBe(exp.gates.flood);
      } else {
        expect(s.rank).toBeNull();
        expect(s.score).toBeNull();
      }
    }
  });

  it("ranks viable sites in the expected order, shared lot last, and only viable sites get a rank", () => {
    const ranked = run1.report!.sites.filter((s) => s.rank !== null).sort((a, b) => a.rank! - b.rank!);
    expect(ranked.map((s) => s.parcel_id)).toEqual(expected.viable_rank_order);
    expect(ranked.map((s) => s.rank)).toEqual([1, 2, 3]);
    expect(ranked.every((s) => s.viable)).toBe(true);
    expect(run1.report!.sites.filter((s) => !s.viable).every((s) => s.rank === null)).toBe(true);
    expect(ranked.at(-1)!.shared_lot).toBe(true);
  });

  it("every viable site shows three passed gates, each backed by evidence with a cited source and an expiry", () => {
    const evidence = new Map(run1.report!.evidence.map((e) => [e.evidence_id, e]));
    for (const s of run1.report!.sites.filter((x) => x.viable)) {
      for (const gate of ["zoning", "rent", "flood"] as const) {
        expect(s.gates[gate].status, `${s.parcel_id} ${gate}`).toBe("pass");
        expect(s.gates[gate].evidence_ids.length).toBeGreaterThan(0);
        for (const id of s.gates[gate].evidence_ids) {
          const e = evidence.get(id)!;
          expect(e, id).toBeDefined();
          expect(e.source_url.length).toBeGreaterThan(0);
          expect(new Date(e.expires_at).getTime()).toBeGreaterThan(new Date(e.fetched_at).getTime());
          expect(e.expired).toBe(false);
        }
      }
    }
    // PITT-0002 passed rent and zoning from written replies, not from the listing.
    const p2 = run1.report!.sites.find((s) => s.parcel_id === "PITT-0002")!;
    expect(evidence.get(p2.gates.rent.evidence_ids[0]!)!.method).toBe("email");
    expect(evidence.get(p2.gates.zoning.evidence_ids[0]!)!.method).toBe("email");
    expect((evidence.get(p2.gates.rent.evidence_ids[0]!)!.value as any).rent_monthly).toBe(850);
    // PITT-0001 passed zoning from the official layer + cited use table.
    const p1 = run1.report!.sites.find((s) => s.parcel_id === "PITT-0001")!;
    expect(evidence.get(p1.gates.zoning.evidence_ids[0]!)!.method).toBe("layer+use_table");
    expect((evidence.get(p1.gates.zoning.evidence_ids[0]!)!.value as any).citation).toMatch(/9-4-78/);
  });

  it("run 1 sends exactly the expected outreach and nothing to failed or out-of-area parcels", () => {
    const sent = run1.messages.map((m) => ({ parcel_id: run1.report!.sites.find((s) => s.site_id === m.site_id)!.parcel_id, case_type: m.case_type, to: m.to }));
    const key = (x: { parcel_id: string; case_type: string; to: string }) => `${x.parcel_id}|${x.case_type}|${x.to}`;
    expect(sent.map(key).sort()).toEqual(expected.outreach_run1.map(key).sort());
    for (const p of expected.no_outreach_parcels) expect(sent.some((m) => m.parcel_id === p), p).toBe(false);
    for (const m of run1.messages) {
      expect(m.subject).toMatch(/\[DS-[A-Z0-9]{6}\]/);
      expect(m.body.length).toBeGreaterThan(50);
      expect(m.body).not.toMatch(/\{\{/);
    }
    // Pending zoning for PITT-0008 shows an open case with the recipient.
    const p8 = run1.report!.sites.find((s) => s.parcel_id === "PITT-0008")!;
    expect(p8.open_cases).toHaveLength(1);
    expect(p8.open_cases[0]).toMatchObject({ case_type: "zoning", status: "awaiting_reply", recipient: "planning@aydennc.gov" });
  });

  it("re-running the same fixture day produces zero outbound messages and the same shortlist", () => {
    expect(run2.messages).toEqual([]);
    expect(readJson(join(out, "messages.json"))).toEqual([]);
    expect(run2.report!.sites.map((s) => [s.parcel_id, s.viable, s.rank])).toEqual(run1.report!.sites.map((s) => [s.parcel_id, s.viable, s.rank]));
    expect(run2.run.counts["verify.messages_sent"] ?? 0).toBe(0);
    expect(expected.outreach_run2_count).toBe(0);
  });

  it("makes no network call and no paid call in the default configuration", async () => {
    expect(run1.report!.external_calls).toEqual([]);
    expect(run2.report!.external_calls).toEqual([]);
    expect(run1.run.paid_calls).toEqual([]);
    expect(run1.report!.providers.paid_enabled).toBe(false);
    expect(run1.run.errors).toEqual([]);
    await expect(fetch("https://example.com/")).rejects.toThrow(NetworkDisabledError);
  });

  it("report.providers reflects the selected providers even offline; switching the geocoder is a config-only change", async () => {
    expect(run1.report!.providers).toMatchObject({ geocoder: "census", parcels: "nc_onemap", drivetime: "ors", imagery: "mapillary", poi: "overpass", crawler: "anycrawl", tiles: "protomaps" });
    const dir = tmp("switch-");
    const providersPath = writeProvidersYaml(dir, { [expected.provider_switch.key]: expected.provider_switch.to });
    const r = await runOffline({ fixturesDir: GOLDEN, outDir: join(dir, "out"), runDate: GOLDEN_RUN_DATE, providersPath });
    expect((r.report!.providers as any)[expected.provider_switch.key]).toBe(expected.provider_switch.to);
    const geo = r.report!.evidence.find((e) => e.fact === "geocode")!;
    expect((geo.value as any).provider).toBe("nominatim");
    expect(r.report!.sites.filter((s) => s.viable).map((s) => s.parcel_id)).toEqual(expected.viable_rank_order);
  });

  it("run.json carries integer counts and the stage summaries", () => {
    const run = readJson(join(out, "run.json"));
    expect(Object.values(run.counts).every((v) => Number.isInteger(v))).toBe(true);
    expect(run.counts["messages_sent"]).toBe(0); // second run
    expect(run1.run.counts["messages_sent"]).toBe(3);
    expect(Object.keys(run1.run.stages as object).sort()).toEqual(["discover", "enrich", "report", "resolve", "score", "verify"]);
  });
});
