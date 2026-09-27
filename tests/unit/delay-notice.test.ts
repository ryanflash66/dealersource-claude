import { describe, expect, it } from "vitest";
import { join } from "node:path";
import { isDelayNotice } from "../../src/pipeline/replies.js";
import { config, readJson, runOffline, tmp, writeFixtureSet } from "../helpers.js";

// Wording recorded from Gmail's notices (2026-09-24..26).
const DELAY_SUBJECT = "Delivery Status Notification (Delay)";
const DELAY_BODY = "** Delivery incomplete **\n\nThere was a temporary problem delivering your message to owner-l1@landlord.test. Gmail will retry for 47 more hours. You'll be notified if the delivery fails permanently.";
const FAIL_SUBJECT = "Delivery Status Notification (Failure)";
const FAIL_BODY = "** Message not delivered **\n\nThere was a problem delivering your message to owner-l1@landlord.test. See the technical details below.";

describe("delivery delay notices", () => {
  it("tells a 'still trying' notice from a real failure", () => {
    expect(isDelayNotice(DELAY_SUBJECT, DELAY_BODY)).toBe(true);
    expect(isDelayNotice("Delivery Status Notification", DELAY_BODY)).toBe(true);
    expect(isDelayNotice(FAIL_SUBJECT, FAIL_BODY)).toBe(false);
    expect(isDelayNotice("Re: Inquiry [DS-ABC123]", "Rent is $900 a month.")).toBe(false);
  });

  it("a delay notice leaves the contact and the case alone; a failure notice still bounces", async () => {
    const listing = [{ listing_id: "L1", address: "10 Test St, Greenville, NC 27834", parcel_id: "P1", rent_monthly: null }];
    const dsn = (subject: string, body: string) => [{ listing_id: "L1", case_type: "rent" as const, from: "mailer-daemon@googlemail.com", received_at: "2026-09-16T12:00:00Z", subject, body }];

    const dir = tmp();
    const delayed = await runOffline({ fixturesDir: writeFixtureSet(join(dir, "fx1"), listing, dsn(DELAY_SUBJECT, DELAY_BODY)), outDir: join(dir, "o1"), runDate: "2026-09-16" });
    expect(delayed.run.counts["verify.inbound_delay_notices_ignored"]).toBe(1);
    expect(delayed.run.counts["verify.inbound_bounces"] ?? 0).toBe(0);
    expect(delayed.report!.sites[0]!.open_cases[0]).toMatchObject({ case_type: "rent", status: "awaiting_reply" });
    const contact1 = readJson(join(dir, "o1", "state", "state.json")).contacts[0];
    expect(contact1.bounced).toBe(false);

    const failed = await runOffline({ fixturesDir: writeFixtureSet(join(dir, "fx2"), listing, dsn(FAIL_SUBJECT, FAIL_BODY)), outDir: join(dir, "o2"), runDate: "2026-09-16" });
    expect(failed.run.counts["verify.inbound_bounces"]).toBe(1);
    expect(readJson(join(dir, "o2", "state", "state.json")).contacts[0].bounced).toBe(true);
  });
});

describe("planning contacts added 2026-09-27", () => {
  it("Tarboro and Rocky Mount are verified; Goldsboro and Simpson publish no address and are not guessed", () => {
    const j = config().business.jurisdictions;
    expect(j.Tarboro).toMatchObject({ planning_email: "catherinegrimm@tarboro-nc.com", verified: true });
    expect(j["Rocky Mount"]).toMatchObject({ planning_email: "devserv@rockymountnc.gov", verified: true });
    expect(j.Goldsboro).toBeUndefined();
    expect(j.Simpson).toBeUndefined();
  });
});
