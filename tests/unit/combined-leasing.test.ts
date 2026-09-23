import { describe, expect, it } from "vitest";
import { join } from "node:path";
import { splitReplyByProperty, stripQuotedReply } from "../../src/pipeline/replies.js";
import { FixtureMail } from "../../src/providers/fixture.js";
import { RulesLlm } from "../../src/providers/llm.js";
import { adapterCtx, config, readJson, runOffline, tmp, writeFixtureSet, type MiniListing } from "../helpers.js";

const BROKER = "info@broker.test";
const QUOTE = [
  "",
  "On Tue, Sep 16, 2026 at 6:00 AM Ryan Balungeli <",
  "ry@example.test> wrote:",
  "> For each property:",
  "> - Office: is there a permanent, enclosed, lockable office of at least 96 sq ft",
  '> Reply "stop" if you would prefer not to hear from me again.',
].join("\n");

const listings = (extra: Partial<MiniListing> = {}): MiniListing[] => [
  { listing_id: "L1", address: "124 Beacon Dr, Winterville, NC 28590", parcel_id: "B1", rent_monthly: null, contact_email: BROKER, has_office: true, vehicle_capacity: 6, ...extra },
  { listing_id: "L2", address: "1990 Allen Rd, Greenville, NC 27834", parcel_id: "A1", rent_monthly: null, contact_email: BROKER, has_office: true, vehicle_capacity: 6, ...extra },
];

describe("reply text helpers", () => {
  it("drops the quoted original, so our own 'Reply \"stop\"' line is never read as a stop request", async () => {
    const body = `Thanks for reaching out. Base rent is $850 per month.${QUOTE}`;
    expect(stripQuotedReply(body)).toBe("Thanks for reaching out. Base rent is $850 per month.");
    const cls = await new RulesLlm(adapterCtx("rules")).classifyReply(stripQuotedReply(body), "rent");
    expect(cls.intent).not.toBe("stop");
    expect(cls.rent_monthly).toBe(850);
    expect(stripQuotedReply("-----Original Message-----\nonly quote")).toBe("-----Original Message-----\nonly quote"); // never empties a reply
  });

  const props = [
    { key: "s1", n: 1, address: "124 BEACON DR, WINTERVILLE, NC, 28590" },
    { key: "s2", n: 2, address: "1990 ALLEN RD, GREENVILLE, NC, 27834" },
    { key: "s3", n: 3, address: "1717 W 5TH ST, GREENVILLE, NC, 27834" },
  ];

  it("splits a reply by the numbers we used, on separate lines or inline", () => {
    const multi = splitReplyByProperty("Hi Ryan,\n1: $850 a month, office yes\n2) leased already\n#3 - $1,200/mo\nThanks", props);
    expect(Object.fromEntries(multi)).toEqual({ s1: "1: $850 a month, office yes", s2: "2) leased already", s3: "#3 - $1,200/mo\nThanks" });
    const inline = splitReplyByProperty("1: $850 a month; 2: $950 per month; 3: no longer available", props);
    expect(inline.get("s1")).toMatch(/\$850/);
    expect(inline.get("s2")).toMatch(/\$950/);
    expect(inline.get("s3")).toMatch(/no longer available/);
  });

  it("splits by street name, and refuses to guess when a line names several properties or none", () => {
    const byStreet = splitReplyByProperty("The Beacon lot is $900/mo.\nAllen Rd has no office.", props);
    expect(Object.fromEntries(byStreet)).toEqual({ s1: "The Beacon lot is $900/mo.", s2: "Allen Rd has no office." });
    expect(splitReplyByProperty("Beacon and Allen are both $900/mo", props).size).toBe(0);
    expect(splitReplyByProperty("All of them are $900 a month.", props).size).toBe(0);
    expect(splitReplyByProperty("Ready at 5:30 pm, rent $900/mo", props).size).toBe(0); // "5:30" is not property 5
  });
});

describe("one leasing email per contact (business.yaml mail.combine_leasing)", () => {
  it("sends one email for all of a broker's properties, recorded once per property", async () => {
    const dir = tmp();
    const fx = writeFixtureSet(join(dir, "fx"), listings());
    const r = await runOffline({ fixturesDir: fx, outDir: join(dir, "out"), runDate: "2026-09-16" });
    expect(r.run.errors).toEqual([]);
    const outbox = (r.ctx.providers.mail as FixtureMail).outbox;
    expect(outbox).toHaveLength(1);
    expect(outbox[0]!.to).toBe(BROKER);
    expect(outbox[0]!.subject).toMatch(/^Inquiry about 2 of your listings \[DS-[A-Z0-9]{6}\]$/);
    // different listing pages: each link sits next to its property
    expect(outbox[0]!.body).toMatch(/^1\. 124 Beacon Dr, Winterville, NC 28590 \(https:\/\/broker\.test\/listings\/L1\)$/m);
    expect(outbox[0]!.body).toMatch(/^2\. 1990 Allen Rd, Greenville, NC 27834 \(https:\/\/broker\.test\/listings\/L2\)$/m);
    expect(outbox[0]!.body).toContain("For each property:");
    expect(outbox[0]!.body).toContain("I work with Serenity Auto Gallery");
    // messages.json and the store keep one record per property, all the same email
    expect(r.messages).toHaveLength(2);
    expect(new Set(r.messages.map((m) => `${m.subject}|${m.body}`)).size).toBe(1);
    expect(r.messages.every((m) => m.template_id === "leasing-initial-bundle-rent")).toBe(true);
    expect(r.run.counts["verify.emails_sent"]).toBe(1);
    expect(r.run.counts["verify.combined_emails_sent"]).toBe(1);
    expect(r.run.counts.messages_sent).toBe(2);
  });

  it("a numbered reply resolves each property's rent; the quoted original is ignored", async () => {
    const dir = tmp();
    const fx = writeFixtureSet(join(dir, "fx"), listings(), [
      { listing_id: "L1", case_type: "rent", from: BROKER, received_at: "2026-09-16T20:00:00Z", subject: "Re: Inquiry", body: `Hi Ryan,\n1: $850 a month\n2: $1,200 per month${QUOTE}` },
    ]);
    const r = await runOffline({ fixturesDir: fx, outDir: join(dir, "out"), runDate: "2026-09-16" });
    expect(r.run.errors).toEqual([]);
    const beacon = r.report!.sites.find((s) => s.parcel_id === "B1")!;
    const allen = r.report!.sites.find((s) => s.parcel_id === "A1")!;
    expect(beacon.metrics.rent_monthly).toBe(850);
    expect(beacon.gates.rent.status).toBe("pass");
    expect(allen.gates.rent.status).toBe("fail"); // $1,200 is over the $1,000 ceiling
    const state = readJson(join(dir, "out", "state", "state.json"));
    const contact = state.contacts.find((x: { email: string }) => x.email === BROKER);
    expect(contact.do_not_contact).toBe(false);
  });

  it("a reply that cannot be split by property goes to a person instead of being guessed", async () => {
    const dir = tmp();
    const fx = writeFixtureSet(join(dir, "fx"), listings(), [
      { listing_id: "L1", case_type: "rent", from: BROKER, received_at: "2026-09-16T20:00:00Z", subject: "Re: Inquiry", body: "Both are $900 a month." },
    ]);
    const r = await runOffline({ fixturesDir: fx, outDir: join(dir, "out"), runDate: "2026-09-16" });
    expect(r.run.counts["verify.bundle_replies_unsplit"]).toBe(1);
    for (const pid of ["B1", "A1"]) {
      const s = r.report!.sites.find((x) => x.parcel_id === pid)!;
      expect(s.gates.rent.status).toBe("pending");
      expect(s.open_cases[0]).toMatchObject({ case_type: "rent", status: "escalated" });
      expect(s.open_cases[0]!.next_action).toMatch(/could not be split by property/);
    }
  });

  it("switched off, or for planning questions, it stays one email per property", async () => {
    const dir = tmp();
    const fx = writeFixtureSet(join(dir, "fx"), listings());
    const business = structuredClone(config().business);
    business.mail.combine_leasing = false;
    const off = await runOffline({ fixturesDir: fx, outDir: join(dir, "off"), runDate: "2026-09-16", configOverrides: { business } });
    expect((off.ctx.providers.mail as FixtureMail).outbox).toHaveLength(2);

    const fx2 = writeFixtureSet(join(dir, "fx2"), listings({ rent_monthly: 800, dealer_use: "unknown" }));
    const planning = await runOffline({ fixturesDir: fx2, outDir: join(dir, "planning"), runDate: "2026-09-16" });
    const sent = (planning.ctx.providers.mail as FixtureMail).outbox;
    expect(sent.map((m) => m.to)).toEqual(["planning@greenvillenc.gov", "planning@greenvillenc.gov"]);
    expect(sent.every((m) => m.subject.startsWith("Permitted use inquiry"))).toBe(true);
  });
});
