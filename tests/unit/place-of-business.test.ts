import { describe, expect, it } from "vitest";
import { join } from "node:path";
import { readFileSync } from "node:fs";
import { requirements } from "../../src/pipeline/gates.js";
import { GmailMail } from "../../src/providers/mail.js";
import { adapterCtx, cleanEnv, config, runOffline, tmp, writeFixtureSet } from "../helpers.js";

// NC established-salesroom minimums verified 2026-09-22 (docs/decisions.md 23).
describe("NC place-of-business checks", () => {
  const b = config().business;

  it("business.yaml carries the statutory minimums: 96 sq ft enclosed office, 3-inch sign, no legal display count", () => {
    const pob = b.dealer.place_of_business_checks;
    expect(pob).toMatchObject({ enclosed_office: true, office_min_sq_ft: 96, non_residential: true, display_area_min_vehicles: null, sign_required: true, sign_min_letter_inches: 3 });
    expect(b.site.min_vehicle_display).toBe(2); // operator preference, unchanged
  });

  it("the office check is statutory; the operator display floor is not; no statutory display check exists", () => {
    const r = requirements(b, { shared_lot: false, has_office: false, vehicle_capacity: 1 });
    expect(r.find((x) => x.name === "enclosed_office")).toMatchObject({ outcome: "not_met", statutory: true });
    expect(r.find((x) => x.name === "enclosed_office")!.detail).toMatch(/96 sq ft.*G\.S\. 20-286\(6\)a/);
    expect(r.find((x) => x.name === "vehicle_display")).toMatchObject({ outcome: "not_met", statutory: false });
    expect(r.some((x) => x.name === "vehicle_display_statutory")).toBe(false);
    const unknown = requirements(b, { shared_lot: false, has_office: null, vehicle_capacity: null });
    expect(unknown.find((x) => x.name === "enclosed_office")).toMatchObject({ outcome: "unknown", statutory: true });
  });

  it("a legal display minimum above zero becomes its own statutory check, separate from the operator floor", () => {
    const withLaw = { ...b, dealer: { ...b.dealer, place_of_business_checks: { ...b.dealer.place_of_business_checks, display_area_min_vehicles: 5 } } };
    const r = requirements(withLaw, { shared_lot: false, has_office: true, vehicle_capacity: 3 });
    expect(r.find((x) => x.name === "vehicle_display_statutory")).toMatchObject({ outcome: "not_met", statutory: true });
    expect(r.find((x) => x.name === "vehicle_display")).toMatchObject({ outcome: "met", statutory: false });
  });

  it("shared lots are flagged with the rule that each dealer's display stays separate", () => {
    const r = requirements(b, { shared_lot: true, has_office: true, vehicle_capacity: 4 });
    expect(r.find((x) => x.name === "shared_lot_policy")!.detail).toMatch(/19A NCAC 03D \.0216/);
  });

  it("known no-office excludes the site and sends nothing; unknown stays viable and asks the 96 sq ft question", async () => {
    const dir = tmp();
    const fx = writeFixtureSet(join(dir, "fx"), [
      { listing_id: "L1", address: "1 NoOffice St, Greenville, NC 27834", parcel_id: "N1", rent_monthly: 800, has_office: false, vehicle_capacity: 6 },
      { listing_id: "L2", address: "2 Ask St, Greenville, NC 27834", parcel_id: "A1", rent_monthly: 800, has_office: null, vehicle_capacity: 6 },
    ]);
    const r = await runOffline({ fixturesDir: fx, outDir: join(dir, "out"), runDate: "2026-09-16" });
    expect(r.run.errors).toEqual([]);
    const none = r.report!.sites.find((s) => s.parcel_id === "N1")!;
    expect(none.gates).toMatchObject({ zoning: { status: "pass" }, rent: { status: "pass" }, flood: { status: "pass" } });
    expect(none.viable).toBe(false);
    expect(none.rank).toBeNull();
    expect(none.open_cases).toEqual([]);
    const ask = r.report!.sites.find((s) => s.parcel_id === "A1")!;
    expect(ask.viable).toBe(true);
    expect(r.messages.map((m) => [m.site_id, m.case_type])).toEqual([[ask.site_id, "space"]]);
    expect(r.messages[0]!.body).toMatch(/at least 96 sq ft/);
  });
});

describe("outbox preview while paused", () => {
  it("writes exactly the mail an unpaused run would send, and sends nothing", async () => {
    const dir = tmp();
    const fx = writeFixtureSet(join(dir, "fx"), [
      { listing_id: "L1", address: "10 Test St, Greenville, NC 27834", parcel_id: "P1", rent_monthly: null },
      { listing_id: "L2", address: "20 Test St, Greenville, NC 27834", parcel_id: "P2", rent_monthly: null, dealer_use: "unknown" },
    ]);
    const paused = await runOffline({ fixturesDir: fx, outDir: join(dir, "paused"), runDate: "2026-09-16", env: { ...cleanEnv(), DEALERSOURCE_PAUSE_SENDING: "1" } });
    expect(paused.messages).toEqual([]);
    expect(paused.run.counts.messages_sent).toBe(0);
    const preview = JSON.parse(readFileSync(join(dir, "paused", "outbox-preview.json"), "utf8"));
    const md = readFileSync(join(dir, "paused", "outbox-preview.md"), "utf8");
    expect(md).toMatch(/Nothing below was sent/);

    const live = await runOffline({ fixturesDir: fx, outDir: join(dir, "live"), runDate: "2026-09-16" });
    const key = (m: { to: string; subject: string; body: string }) => `${m.to}|${m.subject}|${m.body}`;
    expect(preview.messages.map(key).sort()).toEqual(live.messages.map(key).sort());
    expect(preview.count).toBe(live.messages.length);
    const per: Record<string, number> = {};
    for (const m of live.messages) per[m.to] = (per[m.to] ?? 0) + 1;
    expect(preview.per_recipient).toEqual(per);
  });
});

describe("gmail preflight", () => {
  it("obtains an access token and reads the mailbox without sending", async () => {
    const ctx = adapterCtx("gmail", { GMAIL_CLIENT_ID: "a", GMAIL_CLIENT_SECRET: "b", GMAIL_REFRESH_TOKEN: "c", GMAIL_SENDER_ADDRESS: "dealer@example.test" });
    const p = await new GmailMail(ctx).preflight();
    expect(p).toEqual({ access_token_obtained: true, mailbox: "dealer@example.test" });
    expect(ctx.http.requests.map((r) => `${r.method} ${new URL(r.url).pathname}`)).toEqual(["POST /token", "GET /gmail/v1/users/me/profile"]);
    expect(ctx.http.requests.some((r) => r.url.endsWith("/send"))).toBe(false);
  });
});
