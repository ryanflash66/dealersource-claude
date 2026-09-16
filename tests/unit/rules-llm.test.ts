import { describe, expect, it } from "vitest";
import { RulesLlm, htmlToText, parseMoneyPerMonth } from "../../src/providers/llm.js";
import { robotsAllows } from "../../src/providers/crawl.js";
import { renderEmail } from "../../src/pipeline/templates.js";
import { parseArgs } from "../../src/cli.js";
import { adapterCtx, config } from "../helpers.js";

const llm = () => new RulesLlm(adapterCtx("rules"));

describe("rules extractor / classifier", () => {
  it("parses monthly rent in common phrasings", () => {
    expect(parseMoneyPerMonth("Asking $800/month base rent")).toBe(800);
    expect(parseMoneyPerMonth("Base rent is $1,150 per month, NNN")).toBe(1150);
    expect(parseMoneyPerMonth("$950 a month")).toBe(950);
    expect(parseMoneyPerMonth("Rent: $700")).toBe(700);
    expect(parseMoneyPerMonth("Sold for $120,000")).toBeNull();
  });

  it("extracts address, rent, office, capacity and contact from a listing block", async () => {
    const html = `<li><h3>Former tire shop</h3><p>2400 S Memorial Dr, Greenville, NC 27834</p><p>Paved corner lot with 900 sq ft office. Room for 6 display vehicles. $800/month base rent.</p><p>Contact <a href="mailto:leasing@broker-a.test">leasing</a> (252) 555-0100</p></li>`;
    const x = await llm().extractListing({ url: "https://x.test", source_id: "s", html });
    expect(x.address_text).toBe("2400 S Memorial Dr, Greenville, NC 27834");
    expect(x.rent_monthly).toBe(800);
    expect(x.has_office).toBe(true);
    expect(x.vehicle_capacity).toBe(6);
    expect(x.sqft).toBe(900);
    expect(x.contact_email).toBe("leasing@broker-a.test");
    expect(x.contact_phone).toBe("(252) 555-0100");
    expect(x.shared_lot).toBe(false);
    expect(x.confidence).toBeGreaterThan(0.7);
  });

  it("flags shared lots and missing offices; low confidence without an address", async () => {
    const x = await llm().extractListing({ url: "u", source_id: "s", html: "<p>Sharing part of my lot, no office, $500/mo. 1800 Dickinson Ave, Greenville, NC 27834</p>" });
    expect(x.shared_lot).toBe(true);
    expect(x.has_office).toBe(false);
    const y = await llm().extractListing({ url: "u", source_id: "s", html: "<p>Nice lot somewhere</p>" });
    expect(y.address_text).toBeNull();
    expect(y.confidence).toBeLessThan(0.5);
  });

  it("classifies rent, zoning, stop and unavailable replies", async () => {
    const rent = await llm().classifyReply("Thanks for reaching out. Base rent is $850 per month, tenant pays utilities.", "rent");
    expect(rent).toMatchObject({ intent: "answer", rent_monthly: 850 });
    const zoning = await llm().classifyReply("Used motor vehicle sales is a permitted use in CH per Greenville Code sec. 9-4-78 Table 1.", "zoning");
    expect(zoning).toMatchObject({ intent: "answer", zoning_status: "permitted" });
    expect(zoning.zoning_citation).toBe("Greenville Code sec. 9-4-78 Table 1");
    const cond = await llm().classifyReply("This would require a Special Use Permit under section 9-4-103.", "zoning");
    expect(cond.zoning_status).toBe("conditional");
    const no = await llm().classifyReply("Vehicle sales are not permitted in the OR district.", "zoning");
    expect(no.zoning_status).toBe("prohibited");
    expect((await llm().classifyReply("Please stop emailing me.", "rent")).intent).toBe("stop");
    expect((await llm().classifyReply("Sorry, the space has been leased.", "rent")).intent).toBe("unavailable");
    expect((await llm().classifyReply("Thanks, will get back to you.", "rent")).intent).toBe("unrelated");
    const space = await llm().classifyReply("Yes there is an enclosed office and room for 5 cars.", "space");
    expect(space).toMatchObject({ has_office: true, vehicle_capacity: 5, intent: "answer" });
  });

  it("htmlToText strips scripts and tags", () => {
    expect(htmlToText("<script>x()</script><p>Hello&nbsp;<b>world</b></p>")).toBe("Hello world");
  });
});

describe("robots.txt evaluation", () => {
  const gov = "User-agent: Baiduspider\nDisallow: /\nUser-agent: *\nDisallow: /admin\nDisallow: /Search\n";
  it("applies the wildcard group with longest-match semantics", () => {
    expect(robotsAllows(gov, "/business/available-properties", "dealersource/0.1")).toBe(true);
    expect(robotsAllows(gov, "/admin/login", "dealersource/0.1")).toBe(false);
    expect(robotsAllows(gov, "/", "Baiduspider")).toBe(false);
  });
  it("Disallow: / blocks everything; Allow beats Disallow on equal length; empty file allows", () => {
    expect(robotsAllows("User-agent: *\nDisallow: /\n", "/anything", "x")).toBe(false);
    expect(robotsAllows("User-agent: *\nDisallow: /a\nAllow: /a\n", "/a/b", "x")).toBe(true);
    expect(robotsAllows("", "/x", "x")).toBe(true);
  });
});

describe("approved templates", () => {
  it("fills every slot and only includes approved sections", () => {
    const t = config().mailTemplates;
    const m = renderEmail(t, "leasing", ["rent", "space"], {
      address: "3100 E 10th St", token: "ABC123", contact_name: "there", area: "Greenville", listing_url: "https://l.test", parcel_id: "P", district: "CH", previous_date: "", sender_name: "N", sender_org: "O", sender_email: "e@x.test",
    }, false);
    expect(m.subject).toBe("Inquiry about 3100 E 10th St [DS-ABC123]");
    expect(m.body).toContain("Base rent");
    expect(m.body).toContain("Office:");
    expect(m.body).toContain("Display area");
    expect(m.body).not.toContain("sublease");
    expect(m.body).not.toMatch(/\{\{/);
    expect(m.template_id).toBe("leasing-initial-rent+space");
    const f = renderEmail(t, "planning", ["zoning"], { address: "a", token: "T", contact_name: "", area: "", listing_url: "", parcel_id: "P1", district: "CN", previous_date: "2026-09-16", sender_name: "N", sender_org: "O", sender_email: "e" }, true);
    expect(f.body).toContain("Following up on my inquiry from 2026-09-16");
    expect(f.template_id).toBe("planning-followup-zoning");
  });
});

describe("cli argument parsing", () => {
  it("parses the section 14.2 invocation", () => {
    const a = parseArgs(["run", "--offline", "--fixtures", "fx", "--out", "o", "--run-date", "2026-09-16", "--config", "p.yaml"]);
    expect(a.positional).toEqual(["run"]);
    expect(a.flags).toEqual({ offline: true, fixtures: "fx", out: "o", "run-date": "2026-09-16", config: "p.yaml" });
    expect(parseArgs(["--out=dir"]).flags.out).toBe("dir");
  });
});
