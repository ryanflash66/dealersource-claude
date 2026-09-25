import { describe, expect, it } from "vitest";
import { Readable } from "node:stream";
import { deflateSync } from "node:zlib";
import { makeClock } from "../../src/core/clock.js";
import { silentLogger } from "../../src/core/logger.js";
import type { ListingExtraction, RunRow } from "../../src/core/types.js";
import { CostLedger } from "../../src/http/cost-ledger.js";
import { alertExtraction, canonicalListingUrl, parseAlert, yearlyTotalPerMonth } from "../../src/pipeline/alerts.js";
import type { RunContext } from "../../src/pipeline/context.js";
import { discover, refusalReason } from "../../src/pipeline/discover.js";
import { GmailMail, type ImapClient, type ImapMessage, type ImapSearch } from "../../src/providers/mail.js";
import { RulesLlm } from "../../src/providers/llm.js";
import type { AlertMail, MailProvider, ProviderMap } from "../../src/providers/types.js";
import { JsonFileStore } from "../../src/store/json-store.js";
import { adapterCtx, config } from "../helpers.js";

const LOOPNET = /loopnet\.com\/Listing\//i;
const CREXI = /crexi\.com\/(?:lease\/)?properties\/\d+/i;

/** Table-per-card layout, the shape bulk mailers use; the three links are direct, tracked-with-target, and opaque. */
const CARD_HTML = `<!DOCTYPE html><html><head><title>3 new listings</title><style>td{font:12px Arial}</style></head><body>
<!--[if mso]><table><tr><td>200 Outlook Only St, Greenville, NC 27858</td></tr></table><![endif]-->
<table width="100%"><tr><td>Your saved search <b>Greenville lots</b> has 3 new listings</td></tr>
<tr><td>
  <table class="card"><tr><td><a href="https://www.loopnet.com/Listing/2100-Dickinson-Ave-Greenville-NC/31234567/?utm_source=alert&amp;utm_medium=email"><img src="x.jpg"></a></td></tr>
    <tr><td><a href="https://www.loopnet.com/Listing/2100-Dickinson-Ave-Greenville-NC/31234567/?utm_source=alert">Retail lot with office</a></td></tr>
    <tr><td>2100 Dickinson Ave</td></tr><tr><td>Greenville, NC 27834</td></tr>
    <tr><td>$900/mo &middot; 0.4 AC &middot; 1 office</td></tr></table>
</td></tr>
<tr><td>
  <table class="card"><tr><td><a href="https://click.e.loopnet.com/?qs=abc&amp;url=https%3A%2F%2Fwww.loopnet.com%2FListing%2F3100-E-10th-St-Greenville-NC%2F39876543%2F%3Fs%3D1">Car lot</a></td></tr>
    <tr><td>3100 E 10th St, Greenville, NC 27858</td></tr><tr><td>$10,800/YR</td></tr></table>
</td></tr>
<tr><td>
  <table class="card"><tr><td><a href="https://click.e.loopnet.com/?qs=4f1c9e0b77">Flex space</a></td></tr>
    <tr><td>505 W Arlington Blvd, Greenville, NC 27834</td></tr><tr><td>$12.00 SF/YR</td></tr></table>
</td></tr>
<tr><td>You are receiving this because you saved a search. <a href="https://www.loopnet.com/unsubscribe?id=9">Unsubscribe</a>.
  LoopNet, 1331 L Street NW, Washington, DC 20005. noreply@loopnet.com</td></tr></table></body></html>`;

const TEXT_ALERT = `Your saved search "Greenville" has 2 new listings

Lot for lease
4506 Memorial Dr, Greenville, NC 27834
$750/mo
https://www.crexi.com/lease/properties/1122334/north-carolina-4506-memorial-dr

------------------------------

Office + yard
210 W Main St, Washington, NC 27889
$1,500/mo | contact leasing@eastnc-realty.test
https://links.crexi.com/ls/click?upn=opaque123

Manage your saved searches: https://www.crexi.com/account/saved-searches
Unsubscribe | Privacy Policy | $0/mo premium trial`;

describe("alert email parsing", () => {
  it("cuts an HTML alert into one card per listing, with canonical listing links only when readable", () => {
    const cards = parseAlert({ html: CARD_HTML, text: null }, LOOPNET);
    expect(cards.map((c) => c.url)).toEqual([
      "https://www.loopnet.com/Listing/2100-Dickinson-Ave-Greenville-NC/31234567/",
      "https://www.loopnet.com/Listing/3100-E-10th-St-Greenville-NC/39876543/",
      null, // opaque tracking link: never followed
    ]);
    expect(cards[0]!.text).toMatch(/\$900\/mo/);
    expect(cards[0]!.text).not.toMatch(/10,800|Arlington/);
    expect(cards.some((c) => /Outlook Only/.test(c.text))).toBe(false); // conditional comments are ignored
  });

  it("cuts a plain-text alert at the blank and rule lines, and stops the last card at the footer", () => {
    const cards = parseAlert({ html: null, text: TEXT_ALERT }, CREXI);
    expect(cards).toHaveLength(2);
    expect(cards[0]!.url).toBe("https://www.crexi.com/lease/properties/1122334/north-carolina-4506-memorial-dr");
    expect(cards[0]!.text).toMatch(/^Lot for lease/);
    expect(cards[1]!.url).toBeNull();
    expect(cards[1]!.text).toMatch(/Office \+ yard/);
    expect(cards[1]!.text).not.toMatch(/premium trial|Unsubscribe/);
  });

  it("falls back to cutting text when several listings share one flat element", () => {
    const html = `<table><tr><td>New matches:<br><br><a href="https://www.loopnet.com/Listing/1-A/1/">1 Alpha St</a><br>Greenville, NC 27834<br>$800/mo<br><br>
      <a href="https://www.loopnet.com/Listing/2-B/2/">2 Beta Rd</a><br>Winterville, NC 28590<br>$950/mo</td></tr></table>`;
    const cards = parseAlert({ html, text: null }, LOOPNET);
    expect(cards.map((c) => [c.url, c.text.match(/\$\d+\/mo/)?.[0]])).toEqual([
      ["https://www.loopnet.com/Listing/1-A/1/", "$800/mo"],
      ["https://www.loopnet.com/Listing/2-B/2/", "$950/mo"],
    ]);
  });

  it("reads listing targets out of tracking links without following them", () => {
    const target = "https://www.crexi.com/properties/555/north-carolina-lot";
    expect(canonicalListingUrl(`https://x.awstrack.me/L0/${encodeURIComponent(target)}/1/0100abc`, CREXI)).toBe(target);
    expect(canonicalListingUrl(`https://t.test/c?u=${Buffer.from(target).toString("base64url")}`, CREXI)).toBe(target);
    expect(canonicalListingUrl(`https://t.test/c?r=${encodeURIComponent(`https://mid.test/?to=${encodeURIComponent(target)}`)}`, CREXI)).toBe(target);
    // Crexi's mailer: /c/<base64url(zlib(query))>, the target in `l` (shape seen in a real alert 2026-09-23).
    const payload = `EmailMessageId=1&h=abc&l=${encodeURIComponent("https://www.crexi.com/lease/properties/1258790/north-carolina-6612-fleetwood-drive?utm_source=x")}&v=1`;
    expect(canonicalListingUrl(`https://email.search.crexi.com/c/${deflateSync(payload).toString("base64url")}`, CREXI)).toBe(
      "https://www.crexi.com/lease/properties/1258790/north-carolina-6612-fleetwood-drive",
    );
    expect(canonicalListingUrl("https://email.search.crexi.com/c/eJnotdeflatedatallxxxxxxx", CREXI)).toBeNull();
    expect(canonicalListingUrl("https://links.crexi.com/ls/click?upn=opaque123", CREXI)).toBeNull();
    expect(canonicalListingUrl("https://www.crexi.com/properties/555", null)).toBeNull();
  });

  it("reads LoopNet's bar-separated card line, and its listing link from the Outlook-only button", async () => {
    // Synthetic, in the shape of LoopNet's saved-search alert (first seen 2026-09-24, noreply@loopnet.com):
    // every <a> is an encrypted ls/click redirect; the listing link is only in a <v:roundrect> inside <!--[if mso]>.
    const sp = "&nbsp;&nbsp;|&nbsp;&nbsp;";
    const card = (name: string, street: string, zip: string, id: string) => `<tr><td><table>
      <tr><td><a href="https://link.mail.example.test/ls/click?upn=u001.OPAQUE${id}-2B-3D_x"><span>${name}${sp}${street}${sp}Greenville, NC ${zip}${sp}Retail${sp}For Lease
        <br />1,000 SF${sp}$18.00 - $22.00 /SF/Year</span></a></td></tr>
      <tr><td><!--[if mso]><v:roundrect xmlns:v="urn:schemas-microsoft-com:vml" href="https://www.loopnet.com/listing/${id}?utm_source=savedsearch&amp;utm_medium=email" arcsize="16%"><center>View Listing</center></v:roundrect><![endif]-->
        <!--[if !mso]><!-- --><a href="https://link.mail.example.test/ls/click?upn=u001.OPAQUEBTN${id}_y">View Listing</a><!--<![endif]--></td></tr></table></td></tr>`;
    const html = `<html><body><table>
      <tr><td>2 new properties matched your saved search for Test search.</td></tr>
      ${card("Test Plaza", "100 Sample St", "27858", "11111111")}
      ${card("Demo Center", "200 W Example Blvd", "27834", "22222222")}
      <tr><td><!--[if mso]><v:roundrect href="https://www.loopnet.com/search/for-lease/"><center>See Search Results</center></v:roundrect><![endif]-->
        Please do not reply to this message. If you require assistance, contact help@loopnet.com. &copy; 2026 Example Group, 1 Test Boulevard, Arlington, VA 22209</td></tr>
    </table></body></html>`;
    const cards = parseAlert({ html, text: null }, LOOPNET);
    expect(cards.map((c) => c.url)).toEqual(["https://www.loopnet.com/listing/11111111", "https://www.loopnet.com/listing/22222222"]);
    const rules = new RulesLlm(adapterCtx("rules"));
    const blocked = (e: string) => /loopnet\.com$|^no-?reply/i.test(e);
    const ex = await Promise.all(
      cards.map(async (c) => alertExtraction(await rules.extractListing({ url: c.url!, source_id: "s", html, block: c.block }), c.text, blocked)),
    );
    expect(ex.map((e) => [e.address_text, e.rent_monthly, e.contact_email])).toEqual([
      ["100 Sample St, Greenville, NC 27858", null, null],
      ["200 W Example Blvd, Greenville, NC 27834", null, null],
    ]);
  });
});

describe("alert extraction", () => {
  const rules = new RulesLlm(adapterCtx("rules"));
  const blocked = (e: string) => /loopnet\.com$|^no-?reply/i.test(e);
  const extract = async (text: string): Promise<ListingExtraction> => alertExtraction(await rules.extractListing({ url: "u", source_id: "s", html: text, block: text }), text, blocked);

  it("keeps an explicit monthly rent, converts a yearly total, and leaves per-square-foot rates unknown", async () => {
    expect((await extract("2100 Dickinson Ave, Greenville, NC 27834 $900/mo")).rent_monthly).toBe(900);
    expect((await extract("3100 E 10th St, Greenville, NC 27858 $10,800/YR")).rent_monthly).toBe(900);
    expect((await extract("505 W Arlington Blvd, Greenville, NC 27834 Rent: $12.00 SF/YR")).rent_monthly).toBeNull();
    expect((await extract("505 W Arlington Blvd, Greenville, NC 27834 $1.10/SF/MO")).rent_monthly).toBeNull();
    expect(yearlyTotalPerMonth("$15.50/yr")).toBeNull();
  });

  it("does not pull a number from the line above into the address (Crexi cards put a unit number there)", async () => {
    expect((await extract("22\n1185 North Memorial Drive, Greenville, NC 27834")).address_text).toBe("1185 North Memorial Drive, Greenville, NC 27834");
  });

  it("drops the rent when a card states two different monthly prices", async () => {
    expect((await extract("1 Alpha St, Greenville, NC 27834 $500/mo $900/mo")).rent_monthly).toBeNull();
    expect((await extract("1 Alpha St, Greenville, NC 27834 $900/mo, or $900 per month")).rent_monthly).toBe(900);
  });

  it("never takes the alert service, the owner or a no-reply address as the leasing contact", async () => {
    expect((await extract("1 Alpha St, Greenville, NC 27834 noreply@loopnet.com")).contact_email).toBeNull();
    expect((await extract("1 Alpha St, Greenville, NC 27834 leasing@eastnc-realty.test")).contact_email).toBe("leasing@eastnc-realty.test");
  });
});

// ------------------------------------------------------------------ IMAP
interface Msg extends ImapMessage {
  parts: Record<string, string>;
}
const SENDER = "dealer@example.test";
const multipart = { type: "multipart/alternative", childNodes: [{ part: "1", type: "text/plain" }, { part: "2", type: "text/html" }] };
const MAILBOX: Msg[] = [
  { uid: 1, internalDate: "2026-09-10T09:00:00Z", envelope: { subject: "New listings: Greenville lots", messageId: "<a1@e.loopnet.com>", from: [{ name: "LoopNet", address: "Alerts@E.LoopNet.com" }] }, bodyStructure: multipart, parts: { "1": "text version", "2": CARD_HTML } },
  { uid: 2, internalDate: "2026-09-11T09:00:00Z", envelope: { subject: "Deal", messageId: "<x@notloopnet.com>", from: [{ address: "promo@notloopnet.com" }] }, bodyStructure: multipart, parts: { "1": "t", "2": "<p>h</p>" } },
  { uid: 3, internalDate: "2026-09-12T09:00:00Z", envelope: { subject: "fwd", messageId: "<me@example.test>", from: [{ address: SENDER }] }, bodyStructure: multipart, parts: { "1": "t", "2": "<p>loopnet.com</p>" } },
  { uid: 4, internalDate: "2026-09-20T09:00:00Z", envelope: { subject: "Later", messageId: "<late@loopnet.com>", from: [{ address: "alerts@loopnet.com" }] }, bodyStructure: { type: "text/plain" }, parts: { "1": "after the cutoff" } },
];

class FakeImap implements ImapClient {
  readonly queries: ImapSearch[] = [];
  async connect() {}
  async logout() {}
  async list() {
    return [{ path: "INBOX" }, { path: "[Gmail]/All Mail", specialUse: "\\All" }];
  }
  async getMailboxLock() {
    return { release: () => undefined };
  }
  async search(q: ImapSearch) {
    this.queries.push(q);
    const has = (m: Msg, f?: string) => !f || (m.envelope?.from ?? []).some((a) => `${a.name} ${a.address}`.toLowerCase().includes(f.toLowerCase()));
    return MAILBOX.filter((m) => String(m.internalDate) >= q.since!.toISOString().slice(0, 10) && has(m, q.from) && (!q.or || q.or.some((o) => has(m, o.from)))).map((m) => m.uid);
  }
  async fetchAll(range: number[]) {
    return MAILBOX.filter((m) => range.includes(m.uid));
  }
  async download(uid: string, part: string | undefined) {
    const m = MAILBOX.find((x) => String(x.uid) === uid)!;
    return { content: Readable.from([Buffer.from(m.parts[part ?? "1"] ?? "", "utf8")]) };
  }
}

describe("gmail alert reader", () => {
  it("reads alerts from the sender domain and its subdomains only, inside the window, never our own mail", async () => {
    const imap = new FakeImap();
    const g = new GmailMail(adapterCtx("gmail", { GMAIL_SENDER_ADDRESS: SENDER, GMAIL_APP_PASSWORD: "abcdabcdabcdabcd" }), { imap: async () => imap });
    const got = await g.fetchAlerts({ since: "2026-09-01T00:00:00Z", until: "2026-09-16T23:59:59Z", from: ["LoopNet.com"] });
    expect(imap.queries[0]).toMatchObject({ from: "loopnet.com" });
    expect(got.map((m) => [m.provider_message_id, m.from])).toEqual([["<a1@e.loopnet.com>", "alerts@e.loopnet.com"]]);
    expect(got[0]!.html).toBe(CARD_HTML);
    expect(got[0]!.text).toBe("text version");
  });
});

// -------------------------------------------------------------- discover
function stubMail(alerts: AlertMail[] | null): MailProvider {
  const base: MailProvider = {
    name: alerts ? "gmail" : "fixture",
    sender_address: SENDER,
    send: async () => ({ provider_message_id: "x", thread_id: "x" }),
    fetchInbound: async () => [],
  };
  return alerts ? { ...base, fetchAlerts: async () => alerts } : base;
}

function ctxWith(mail: MailProvider): RunContext {
  const cfg = config();
  cfg.sources = cfg.sources.filter((s) => s.id === "loopnet-alerts" || s.id === "loopnet");
  const clock = makeClock("2026-09-16T10:00:00.000Z");
  const run = { id: "run-t", run_date: "2026-09-16", warnings: [], errors: [], counts: {} } as unknown as RunRow;
  const noCrawl = { name: "none", checkRobots: async () => ({ allowed: false, checked: true, source_url: "" }), fetchPage: async () => { throw new Error("no crawling in this test"); } };
  const providers = { mail, llm: new RulesLlm(adapterCtx("rules")), crawler: noCrawl, jsCrawler: noCrawl } as unknown as ProviderMap;
  return { config: cfg, store: new JsonFileStore(null), providers, clock, logger: silentLogger, run, offline: false, fixtures: null, outDir: "", ledger: new CostLedger(), hosts: new Set(), runDate: "2026-09-16", cutoffIso: "2026-09-16T23:59:59.999Z", homeBase: null, sentThisRun: [] };
}

const alert = (id: string, at: string, html: string): AlertMail => ({ provider_message_id: `<${id}@e.loopnet.com>`, from: "alerts@e.loopnet.com", subject: "New listings", received_at: at, html, text: null });

describe("discover: email_alert sources", () => {
  it("sources.yaml: LoopNet and Crexi alerts are allowed while the crawl entries for both sites stay refused", () => {
    const s = config().sources;
    for (const id of ["loopnet-alerts", "crexi-alerts"]) expect(refusalReason(s.find((x) => x.id === id)!), id).toBeNull();
    for (const id of ["loopnet", "crexi"]) expect(refusalReason(s.find((x) => x.id === id)!), id).toMatch(/prohibited/);
    expect(s.find((x) => x.id === "loopnet-alerts")).toMatchObject({ kind: "email_alert", alert_from: ["loopnet.com"] });
  });

  it("turns each alert card into a listing, one per address across alerts, newest facts winning", async () => {
    const ctx = ctxWith(stubMail([
      alert("a1", "2026-09-10T09:00:00Z", CARD_HTML),
      alert("a2", "2026-09-12T09:00:00Z", `<table><tr><td><a href="https://www.loopnet.com/Listing/2100-Dickinson-Ave-Greenville-NC/31234567/">x</a> 2100 Dickinson Ave, Greenville, NC 27834 Price reduced: $850/mo</td></tr></table>`),
    ]));
    const c = await discover(ctx);
    const listings = (await ctx.store.list("listings")).filter((l) => l.source_id === "loopnet-alerts");
    expect(listings.map((l) => [l.address_text, l.extraction.rent_monthly]).sort()).toEqual([
      ["2100 Dickinson Ave, Greenville, NC 27834", 850],
      ["3100 E 10th St, Greenville, NC 27858", 900],
      ["505 W Arlington Blvd, Greenville, NC 27834", null],
    ]);
    const dickinson = listings.find((l) => /Dickinson/.test(l.address_text!))!;
    expect(dickinson.url).toBe("https://www.loopnet.com/Listing/2100-Dickinson-Ave-Greenville-NC/31234567/");
    const arlington = listings.find((l) => /Arlington/.test(l.address_text!))!;
    expect(arlington.url).toMatch(/^https:\/\/mail\.google\.com\/mail\/u\/0\/#search\/rfc822msgid%3Aa1%40e\.loopnet\.com$/);
    expect(listings.every((l) => l.extraction.contact_email === null)).toBe(true); // noreply@loopnet.com in the footer is not a contact
    expect(c.counts).toMatchObject({ alert_emails: 2, sources_fetched: 1, sources_refused: 1 });
    expect((await ctx.store.list("raw_documents")).filter((d) => d.source_id === "loopnet-alerts")).toHaveLength(2);
    expect((await ctx.store.get("sources", "loopnet-alerts"))!.last_status).toBe("ok");

    // Idempotent: the same alerts again add nothing.
    await discover(ctx);
    expect((await ctx.store.list("listings")).filter((l) => l.source_id === "loopnet-alerts")).toHaveLength(3);
  });

  it("without a readable mailbox the source is skipped, not failed", async () => {
    const ctx = ctxWith(stubMail(null));
    const c = await discover(ctx);
    const src = (await ctx.store.get("sources", "loopnet-alerts"))!;
    expect(src.last_status).toBe("skipped");
    expect(src.last_error).toMatch(/GMAIL_APP_PASSWORD/);
    expect(c.counts.warnings ?? 0).toBe(0);
    expect(ctx.run.warnings).toEqual([]);
  });
});
