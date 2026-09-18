import { describe, expect, it } from "vitest";
import { join } from "node:path";
import { resolveClockInput, runPipeline } from "../../src/pipeline/run.js";
import { silentLogger } from "../../src/core/logger.js";
import { FixtureHttpClient } from "../../src/http/fixture-client.js";
import { GOLDEN, GOLDEN_RUN_DATE, ROOT, cleanEnv, readJson, runOffline, tmp } from "../helpers.js";

describe("run clock: frozen offline or with DEALERSOURCE_NOW, real wall clock online", () => {
  it("resolves the clock input by mode", () => {
    expect(resolveClockInput({ offline: true, runDate: "2026-09-18" })).toBe("2026-09-18T10:00:00.000Z");
    expect(resolveClockInput({ offline: false, runDate: "2026-09-18" })).toBeNull(); // real clock
    expect(resolveClockInput({ offline: false, runDate: "2026-09-18", envNow: "2026-09-18T14:05:00Z" })).toBe("2026-09-18T14:05:00Z");
    expect(resolveClockInput({ offline: false, runDate: "2026-09-18", now: "2026-09-01T00:00:00Z", envNow: "2026-09-18T14:05:00Z" })).toBe("2026-09-01T00:00:00Z");
    expect(resolveClockInput({ offline: true, runDate: "2026-09-18", envNow: "  " })).toBe("2026-09-18T10:00:00.000Z");
  });

  it("offline runs stamp every timestamp at 10:00Z on the run date", async () => {
    const out = join(tmp(), "out");
    const r = await runOffline({ fixturesDir: GOLDEN, outDir: out, runDate: GOLDEN_RUN_DATE });
    expect(r.run.started_at).toBe("2026-09-16T10:00:00.000Z");
    expect(r.run.finished_at).toBe("2026-09-16T10:00:00.000Z");
    expect(r.messages.every((m) => m.sent_at === "2026-09-16T10:00:00.000Z")).toBe(true);
    const state = readJson(join(out, "state", "state.json"));
    expect(state.reports[0].created_at).toBe("2026-09-16T10:00:00.000Z");
  });

  it("online runs use the real wall clock while the run date stays the logical day", async () => {
    const before = Date.now();
    const out = join(tmp(), "out");
    // Online, no credentials: keyed layers fall back to fixtures; keyless adapters get an HTTP client with no
    // recordings, so their calls fail loudly instead of reaching the network. The run still finishes and
    // writes run.json with wall-clock stamps.
    const r = await runPipeline({
      offline: false,
      fixturesDir: GOLDEN,
      outDir: out,
      runDate: "2026-09-16",
      env: cleanEnv(),
      logger: silentLogger,
      httpFactory: (spec) => new FixtureHttpClient(`none-${spec.id}`, ROOT, []),
    });
    const started = Date.parse(r.run.started_at);
    expect(Math.abs(started - before)).toBeLessThan(60_000);
    expect(Date.parse(r.run.finished_at)).toBeGreaterThanOrEqual(started);
    expect(r.run.run_date).toBe("2026-09-16");
    expect(r.run.started_at.startsWith("2026-09-16T10:00:00")).toBe(false);
    expect(r.ctx.run.mode).toBe("online");
  });

  it("DEALERSOURCE_NOW freezes an online run", async () => {
    const out = join(tmp(), "out");
    const r = await runPipeline({
      offline: false,
      fixturesDir: GOLDEN,
      outDir: out,
      runDate: "2026-09-16",
      env: { ...cleanEnv(), DEALERSOURCE_NOW: "2026-09-16T13:37:00.000Z" },
      logger: silentLogger,
      httpFactory: (spec) => new FixtureHttpClient(`none-${spec.id}`, ROOT, []),
    });
    expect(r.run.started_at).toBe("2026-09-16T13:37:00.000Z");
    expect(r.run.finished_at).toBe("2026-09-16T13:37:00.000Z");
  });
});

describe("reports table: only completed report stages write a row, ordering is deterministic", () => {
  it("a run that stops before the report stage leaves no reports row and does not touch an earlier good report", async () => {
    const out = join(tmp(), "out");
    const good = await runOffline({ fixturesDir: GOLDEN, outDir: out, runDate: GOLDEN_RUN_DATE });
    let state = readJson(join(out, "state", "state.json"));
    expect(state.reports.map((r: any) => r.id)).toEqual([good.run.run_id]);

    // Same day, same store, but the run is cut short before `report` (as a stage failure would do).
    const partial = await runOffline({ fixturesDir: GOLDEN, outDir: out, runDate: GOLDEN_RUN_DATE, stages: ["discover", "resolve", "enrich", "verify", "score"] });
    state = readJson(join(out, "state", "state.json"));
    expect(state.reports.map((r: any) => r.id)).toEqual([good.run.run_id]);
    expect(partial.report).toBeNull();
    expect(readJson(join(out, "report.json")).run_id).toBe(good.run.run_id); // the good report.json is untouched
    expect(state.reports[0].payload.sites.length).toBe(8);
  });

  it("a stage error breaks the run before report and records the error", async () => {
    const dir = tmp();
    const fx = join(dir, "fx");
    const { mkdirSync, writeFileSync } = await import("node:fs");
    mkdirSync(fx, { recursive: true });
    writeFileSync(join(fx, "listings.json"), "[{\"listing_id\": 1}]"); // invalid shape -> discover throws
    const r = await runOffline({ fixturesDir: fx, outDir: join(dir, "out"), runDate: GOLDEN_RUN_DATE });
    expect(r.report).toBeNull();
    expect(r.run.errors.some((e) => e.startsWith("discover:"))).toBe(true);
    expect(readJson(join(dir, "out", "state", "state.json")).reports).toEqual([]);
  });

  it("the dashboard asks Supabase for the latest report with a total order", async () => {
    const { readFileSync } = await import("node:fs");
    const app = readFileSync(join(ROOT, "dashboard", "src", "app.ts"), "utf8");
    expect(app).toContain("/reports?select=payload,messages,created_at&order=created_at.desc,id.desc&limit=1");
    expect(app).toContain("/runs?select=*&order=started_at.desc,id.desc&limit=1");
  });
});
