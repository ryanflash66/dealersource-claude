import { describe, expect, it } from "vitest";
import { FetchCrawl, AnyCrawlSelfHosted, RobotsDisallowedError, extractLinks, toDocument } from "../../src/providers/crawl.js";
import { FetchHttpClient } from "../../src/http/client.js";
import { buildProviders } from "../../src/providers/registry.js";
import { CostLedger } from "../../src/http/cost-ledger.js";
import { makeClock } from "../../src/core/clock.js";
import { silentLogger } from "../../src/core/logger.js";
import { adapterCtx, cleanEnv, config } from "../helpers.js";

const GV = "https://www.greenvillenc.gov/business/economic-development/available-properties";

describe("fetch crawler adapter (plain Node fetch, zero cost)", () => {
  it("fetches a static town 'available properties' page and returns html, readable text and links", async () => {
    const ctx = adapterCtx("fetch");
    const c = new FetchCrawl(ctx);
    const doc = await c.fetchPage(GV);
    expect(doc.status).toBe(200);
    expect(doc.url).toBe(GV);
    expect(doc.content_type).toMatch(/text\/html/);
    expect(doc.body).toContain("<li class=\"prop\">"); // raw HTML kept for raw_documents
    expect(doc.text).toContain("2400 S Memorial Dr, Greenville, NC 27834");
    expect(doc.text).toContain("$800/month base rent");
    expect(doc.text).not.toContain("must not run"); // scripts stripped, never executed
    expect(doc.text).not.toContain("<");
    expect(doc.links).toEqual([
      "https://www.greenvillenc.gov/",
      "https://www.greenvillenc.gov/business/economic-development",
      "https://www.greenvillenc.gov/business/economic-development/available-properties/117",
      "https://broker-b.test/available/3100-e-10th",
      "https://www.greenvillenc.gov/privacy",
    ]);
    // robots.txt was consulted first, then the page; identifying User-Agent on both
    expect(ctx.http.requests.map((r) => r.url)).toEqual(["https://www.greenvillenc.gov/robots.txt", GV]);
    expect(doc.fetched_at).toBe("2026-09-16T10:00:00.000Z");
  });

  it("follows a redirect and reports the final URL; a missing robots.txt allows the fetch", async () => {
    const ctx = adapterCtx("fetch");
    const doc = await new FetchCrawl(ctx).fetchPage("https://www.pittcountync.gov/business/available-sites-buildings");
    expect(doc.url).toBe("https://www.pittcountync.gov/197/Available-Sites-Buildings");
    expect(doc.text).toContain("4020 NC Highway 33 E, Grimesland, NC 27837");
    // relative link resolved against the FINAL url
    expect(doc.links).toContain("https://www.pittcountync.gov/197/sites/archive.html");
  });

  it("refuses a robots-disallowed URL without fetching it", async () => {
    const ctx = adapterCtx("fetch");
    const c = new FetchCrawl(ctx);
    await expect(c.fetchPage("https://blocked.example/listings")).rejects.toThrow(RobotsDisallowedError);
    expect(ctx.http.requests.map((r) => r.url)).toEqual(["https://blocked.example/robots.txt"]); // page never requested
    const gv = new FetchCrawl(ctx);
    expect((await gv.checkRobots("https://www.greenvillenc.gov/private/x", "dealersource/0.1")).allowed).toBe(false);
    expect((await gv.checkRobots(GV, "dealersource/0.1")).allowed).toBe(true);
    expect((await gv.checkRobots("https://www.greenvillenc.gov/", "Baiduspider")).allowed).toBe(false);
  });

  it("caches robots.txt per origin for the run", async () => {
    const ctx = adapterCtx("fetch");
    const c = new FetchCrawl(ctx);
    await c.checkRobots(GV, "dealersource/0.1");
    await c.checkRobots("https://www.greenvillenc.gov/admin", "dealersource/0.1");
    expect(ctx.http.requests.filter((r) => r.url.endsWith("/robots.txt"))).toHaveLength(1);
  });

  it("uses the polite User-Agent that names the parent repo, follows redirects and times out at 15 s", async () => {
    const seen: Array<{ url: string; init: RequestInit }> = [];
    const fakeFetch = (async (input: string | URL | Request, init?: RequestInit) => {
      seen.push({ url: String(input), init: init ?? {} });
      const url = String(input);
      const body = url.endsWith("/robots.txt") ? "User-agent: *\nAllow: /\n" : "<html><body><p>ok</p></body></html>";
      const res = new Response(body, { status: 200, headers: { "content-type": url.endsWith(".txt") ? "text/plain" : "text/html" } });
      Object.defineProperty(res, "url", { value: url.replace("/old", "/new") });
      return res;
    }) as typeof fetch;
    const cfg = config();
    const ctx = { ...adapterCtx("fetch", {}, cfg), http: new FetchHttpClient("dealersource/0.1 (+https://github.com/ryanflash66/dealersource)", 0, fakeFetch) };
    const doc = await new FetchCrawl(ctx as any).fetchPage("https://town.test/old");
    expect(doc.url).toBe("https://town.test/new");
    for (const s of seen) {
      expect(s.init.redirect).toBe("follow");
      expect((s.init.headers as Record<string, string>)["User-Agent"]).toBe("dealersource/0.1 (+https://github.com/ryanflash66/dealersource)");
      expect(s.init.signal).toBeInstanceOf(AbortSignal);
    }
    expect(String(cfg.providers.options.fetch?.user_agent)).toContain("https://github.com/ryanflash66/dealersource");
    expect(cfg.providers.options.fetch?.timeout_ms).toBe(15000);
  });

  it("produces the same document shape as the AnyCrawl adapter", async () => {
    const a = await new AnyCrawlSelfHosted(adapterCtx("anycrawl", { ANYCRAWL_URL: "http://anycrawl.internal:8080" })).fetchPage(GV);
    const f = await new FetchCrawl(adapterCtx("fetch")).fetchPage(GV);
    expect(Object.keys(a).sort()).toEqual(Object.keys(f).sort());
    expect(Object.keys(f).sort()).toEqual(["body", "content_type", "fetched_at", "links", "status", "text", "url"]);
    expect(a.text).toContain("2400 S Memorial Dr");
    expect(Array.isArray(a.links)).toBe(true); // the recorded AnyCrawl page has only a mailto: link, which is dropped
    expect(a.links).toEqual([]);
  });

  it("is the default crawler, needs no environment variable, and is never paid", () => {
    const cfg = config();
    expect(cfg.providers.crawler).toBe("fetch");
    const built = buildProviders({ config: cfg, env: cleanEnv(), clock: makeClock(null), logger: silentLogger, offline: false, fixturesDir: null, outDir: null, ledger: new CostLedger(), hosts: new Set() });
    expect(built.providers.crawler.name).toBe("fetch");
    expect(built.notes.some((n) => n.startsWith("crawler:"))).toBe(false); // nothing missing
    for (const id of ["anycrawl", "anycrawl_cloud"]) {
      // the other two adapters are still accepted by the schema
      expect(() => config({ overrides: { providers: { ...structuredClone(cfg.providers), paid_enabled: true, crawler: id } } })).not.toThrow();
    }
  });

  it("link extraction resolves relative hrefs, drops mailto/tel/anchors and dedupes", () => {
    const links = extractLinks(`<a href="/a">a</a><a href='b?x=1&amp;y=2#frag'>b</a><a href=/a>dup</a><a href="mailto:x@y.test">m</a><a href="tel:1">t</a><a href="#top">top</a><a href="javascript:void(0)">js</a>`, "https://site.test/dir/page");
    expect(links).toEqual(["https://site.test/a", "https://site.test/dir/b?x=1&y=2"]);
    const d = toDocument("https://x.test/", 200, "text/html", "<p>Hi <b>there</b></p>", "2026-09-16T00:00:00Z");
    expect(d.text).toBe("Hi there");
    expect(d.links).toEqual([]);
  });
});
