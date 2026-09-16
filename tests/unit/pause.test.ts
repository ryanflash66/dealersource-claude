import { describe, expect, it } from "vitest";
import { join } from "node:path";
import { cleanEnv, runOffline, tmp, writeFixtureSet } from "../helpers.js";

describe("manual outreach pause", () => {
  it("DEALERSOURCE_PAUSE_SENDING=1 stops all outbound mail and is surfaced on the report", async () => {
    const dir = tmp();
    const fx = writeFixtureSet(join(dir, "fx"), [{ listing_id: "L1", address: "10 Test St, Greenville, NC 27834", parcel_id: "P1", rent_monthly: null }]);
    const paused = await runOffline({ fixturesDir: fx, outDir: join(dir, "out-paused"), runDate: "2026-09-16", env: { ...cleanEnv(), DEALERSOURCE_PAUSE_SENDING: "1" } });
    expect(paused.messages).toEqual([]);
    expect(paused.report!.sending_paused).toBe(true);
    expect(paused.report!.exceptions.some((e) => /manual pause/.test(e))).toBe(true);
    expect(paused.report!.sites[0]!.open_cases[0]).toMatchObject({ case_type: "rent", status: "open" });

    // Unpause: the same state now sends the queued inquiry.
    const resumed = await runOffline({ fixturesDir: fx, outDir: join(dir, "out-paused"), runDate: "2026-09-16" });
    expect(resumed.messages).toHaveLength(1);
  });
});
