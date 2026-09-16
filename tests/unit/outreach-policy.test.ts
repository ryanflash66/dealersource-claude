import { describe, expect, it } from "vitest";
import { join } from "node:path";
import { readJson, runOffline, tmp, writeFixtureSet, type MiniListing } from "../helpers.js";

const L: MiniListing = { listing_id: "L1", address: "10 Test St, Greenville, NC 27834", parcel_id: "P1", rent_monthly: null, contact_email: "owner@landlord.test" };

async function day(fx: string, out: string, runDate: string) {
  const r = await runOffline({ fixturesDir: fx, outDir: out, runDate });
  return { messages: r.messages, report: r.report!, run: r.run };
}

describe("outreach policy (spec section 6)", () => {
  it("first contact, follow-up window, max follow-ups, then escalation to the dashboard", async () => {
    const dir = tmp();
    const fx = writeFixtureSet(join(dir, "fx"), [L]);
    const out = join(dir, "out");

    const d1 = await day(fx, out, "2026-09-16");
    expect(d1.messages).toHaveLength(1);
    expect(d1.messages[0]).toMatchObject({ case_type: "rent", to: "owner@landlord.test", listing_id: "L1", template_id: "leasing-initial-rent" });
    expect(d1.report.sites[0]!.gates.rent.status).toBe("pending");
    expect(d1.report.sites[0]!.open_cases).toHaveLength(1);
    expect(d1.report.sites[0]!.open_cases[0]).toMatchObject({ case_type: "rent", status: "awaiting_reply", recipient: "owner@landlord.test" });

    // Same address, same site, inside followup_days (5): nothing.
    expect((await day(fx, out, "2026-09-17")).messages).toHaveLength(0);
    expect((await day(fx, out, "2026-09-20")).messages).toHaveLength(0);

    // Day 5: follow-up 1.
    const d6 = await day(fx, out, "2026-09-21");
    expect(d6.messages).toHaveLength(1);
    expect(d6.messages[0]!.template_id).toBe("leasing-followup-rent");
    expect(d6.messages[0]!.body).toContain("Following up on my note from 2026-09-16");

    // Day 10: follow-up 2 (max_followups = 2).
    expect((await day(fx, out, "2026-09-26")).messages).toHaveLength(1);

    // Day 15: no more sends; case escalated to a human.
    const d16 = await day(fx, out, "2026-10-01");
    expect(d16.messages).toHaveLength(0);
    expect(d16.report.sites[0]!.open_cases[0]).toMatchObject({ case_type: "rent", status: "escalated" });
    expect(d16.report.exceptions.some((e) => /escalated/.test(e))).toBe(true);

    const state = readJson(join(out, "state", "state.json"));
    expect(state.messages.filter((m: any) => m.direction === "outbound")).toHaveLength(3);
  });

  it("a reply that asks to stop marks the contact do-not-contact and ends outreach", async () => {
    const dir = tmp();
    const fx = writeFixtureSet(join(dir, "fx"), [L], [{ listing_id: "L1", case_type: "rent", from: "owner@landlord.test", received_at: "2026-09-16T12:00:00Z", body: "Please stop emailing me." }]);
    const out = join(dir, "out");
    const d1 = await day(fx, out, "2026-09-16");
    expect(d1.messages).toHaveLength(1);
    const state = readJson(join(out, "state", "state.json"));
    expect(state.contacts[0].do_not_contact).toBe(true);
    const d6 = await day(fx, out, "2026-09-21");
    expect(d6.messages).toHaveLength(0);
    expect(d6.report.sites[0]!.open_cases[0]).toMatchObject({ status: "escalated" });
  });

  it("a written rent reply resolves the case and passes the gate; later runs send nothing", async () => {
    const dir = tmp();
    const fx = writeFixtureSet(join(dir, "fx"), [L], [{ listing_id: "L1", case_type: "rent", from: "owner@landlord.test", received_at: "2026-09-16T14:00:00Z", body: "Base rent is $850 per month." }]);
    const out = join(dir, "out");
    const d1 = await day(fx, out, "2026-09-16");
    expect(d1.messages).toHaveLength(1);
    const site = d1.report.sites[0]!;
    expect(site.gates.rent.status).toBe("pass");
    expect(site.viable).toBe(true);
    expect(site.open_cases).toEqual([]);
    const ev = d1.report.evidence.find((e) => e.evidence_id === site.gates.rent.evidence_ids[0])!;
    expect(ev.method).toBe("email");
    expect(ev.source_url).toMatch(/^message:/);
    expect((await day(fx, out, "2026-09-21")).messages).toHaveLength(0);
  });

  it("a reply dated after the run date is not visible yet", async () => {
    const dir = tmp();
    const fx = writeFixtureSet(join(dir, "fx"), [L], [{ listing_id: "L1", case_type: "rent", from: "owner@landlord.test", received_at: "2026-09-18T09:00:00Z", body: "Base rent is $850 per month." }]);
    const out = join(dir, "out");
    const d1 = await day(fx, out, "2026-09-16");
    expect(d1.report.sites[0]!.gates.rent.status).toBe("pending");
    const d3 = await day(fx, out, "2026-09-18");
    expect(d3.report.sites[0]!.gates.rent.status).toBe("pass");
    expect(d3.messages).toHaveLength(0);
  });

  it("a bounce marks the contact bounced and escalates; the bounce rate can pause sending", async () => {
    const dir = tmp();
    const many: MiniListing[] = Array.from({ length: 6 }, (_, i) => ({
      listing_id: `L${i + 1}`,
      address: `${i + 1} Bounce St, Greenville, NC 27834`,
      parcel_id: `P${i + 1}`,
      rent_monthly: null,
      contact_email: `owner${i + 1}@landlord.test`,
    }));
    const fx = writeFixtureSet(join(dir, "fx"), many, [
      { listing_id: "L1", case_type: "rent", from: "mailer-daemon@googlemail.com", received_at: "2026-09-16T10:30:00Z", subject: "Delivery Status Notification (Failure)", body: "Address not found" },
    ]);
    const out = join(dir, "out");
    const d1 = await day(fx, out, "2026-09-16");
    expect(d1.messages).toHaveLength(6);
    const state = readJson(join(out, "state", "state.json"));
    expect(state.contacts.find((c: any) => c.email === "owner1@landlord.test").bounced).toBe(true);
    expect(state.cases.find((c: any) => c.site_id === "site_P1").status).toBe("escalated");
    // Next morning: 1 of 6 bounced in 24h = 16.7% > 5% -> sending paused and surfaced.
    const d2 = await day(fx, out, "2026-09-17");
    expect(d2.report.sending_paused).toBe(true);
    expect(d2.report.exceptions.some((e) => /Sending paused/.test(e))).toBe(true);
    expect(d2.messages).toHaveLength(0);
  });

  it("sites that already failed a gate get no outreach, and unknown zoning goes to the planning email", async () => {
    const dir = tmp();
    const fx = writeFixtureSet(join(dir, "fx"), [
      { listing_id: "L1", address: "1 Fail St, Greenville, NC 27834", parcel_id: "F1", rent_monthly: 1400, dealer_use: "unknown" },
      { listing_id: "L2", address: "2 Flood St, Greenville, NC 27834", parcel_id: "F2", rent_monthly: null, flood_zone: "AE" },
      { listing_id: "L3", address: "3 Ask St, Ayden, NC 28513", parcel_id: "A1", dealer_use: "unknown", planning_email: "planning@aydennc.gov" },
      { listing_id: "L4", address: "4 Cond St, Greenville, NC 27834", parcel_id: "C1", dealer_use: "conditional" },
      { listing_id: "L5", address: "5 NoContact St, Greenville, NC 27834", parcel_id: "N1", rent_monthly: null, contact_email: null },
    ]);
    const d1 = await day(fx, join(dir, "out"), "2026-09-16");
    expect(d1.messages.map((m) => [m.case_type, m.to])).toEqual([
      ["zoning", "planning@aydennc.gov"],
      ["zoning", "planning@greenvillenc.gov"],
    ]);
    const n1 = d1.report.sites.find((s) => s.parcel_id === "N1")!;
    expect(n1.open_cases[0]).toMatchObject({ case_type: "rent", status: "escalated", recipient: "none" });
  });

  it("space questions ride along in the landlord email when office or capacity is unknown", async () => {
    const dir = tmp();
    const fx = writeFixtureSet(join(dir, "fx"), [{ ...L, has_office: null, vehicle_capacity: null }]);
    const d1 = await day(fx, join(dir, "out"), "2026-09-16");
    expect(d1.messages).toHaveLength(1);
    expect(d1.messages[0]!.case_type).toBe("rent");
    expect(d1.messages[0]!.body).toContain("Office:");
    expect(d1.messages[0]!.body).toContain("Display area");
    expect(d1.report.sites[0]!.open_cases.map((c) => c.case_type).sort()).toEqual(["rent", "space"]);
  });
});
