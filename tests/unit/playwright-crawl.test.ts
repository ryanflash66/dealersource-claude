import { describe, expect, it } from "vitest";
import { join } from "node:path";
import { makeClock } from "../../src/core/clock.js";
import { silentLogger } from "../../src/core/logger.js";
import { CostLedger } from "../../src/http/cost-ledger.js";
import { crawlerFor, refusalReason } from "../../src/pipeline/discover.js";
import { DEFAULT_USER_AGENT, PlaywrightCrawl, RobotsDisallowedError, type PwBrowser, type PwContext, type PwPage, type PwRoute } from "../../src/providers/crawl.js";
import { FixtureCrawl } from "../../src/providers/fixture.js";
import { buildProviders } from "../../src/providers/registry.js";
import { adapterCtx, cleanEnv, config, runOffline, tmp, writeFixtureSet } from "../helpers.js";

const PAGE = "https://js-listings.test/nc/greenville";
const RENDERED = `<html><body><main>
  <article><h3>Lot with office for lease</h3><p>1200 Memorial Dr, Greenville, NC 27834</p><p>$900/mo</p></article>
</main></body></html>`;

/** Plays a scripted set of requests through the route handler the crawler installs, like a real page load. */
class FakePage implements PwPage {
  private handler: ((r: PwRoute) => Promise<void>) | null = null;
  private current = "";
  readonly aborted: string[] = [];
  readonly continued: string[] = [];
  constructor(private readonly subrequests: Array<[string, string]>) {}
  async route(_pattern: string, handler: (r: PwRoute) => Promise<void>) {
    this.handler = handler;
  }
  async goto(url: string) {
    this.current = url;
    for (const [u, type] of [[url, "document"], ...this.subrequests] as Array<[string, string]>) {
      await this.handler!({
        request: () => ({ url: () => u, resourceType: () => type }),
        abort: async () => void this.aborted.push(u),
        continue: async () => void this.continued.push(u),
      });
    }
    return { status: () => 200, headers: () => ({ "content-type": "text/html; charset=utf-8" }) };
  }
  async waitForLoadState() {}
  async waitForTimeout() {}
  async content() {
    return RENDERED;
  }
  url() {
    return this.current;
  }
}

class FakeBrowser implements PwBrowser {
  readonly userAgents: string[] = [];
  readonly pages: FakePage[] = [];
  contextsClosed = 0;
  closed = false;
  constructor(private readonly subrequests: Array<[string, string]> = []) {}
  async newContext(o: { userAgent: string }): Promise<PwContext> {
    this.userAgents.push(o.userAgent);
    return {
      newPage: async () => {
        const p = new FakePage(this.subrequests);
        this.pages.push(p);
        return p;
      },
      close: async () => void this.contextsClosed++,
    };
  }
  async close() {
    this.closed = true;
  }
}

const ctxWith = (options: Record<string, unknown> = {}) => {
  const ctx = adapterCtx("playwright");
  return { ...ctx, options: { ...ctx.options, render_wait_ms: 0, ...options } };
};

describe("playwright crawler (render: js sources)", () => {
  it("renders the page with the fetch crawler's user agent, holds page requests to robots.txt, skips media", async () => {
    const browser = new FakeBrowser([
      ["https://js-listings.test/app.js", "script"],
      ["https://js-listings.test/api/listings?city=greenville", "fetch"],
      ["https://js-listings.test/private/admin.json", "xhr"],
      ["https://api.tracker.test/collect", "fetch"],
      ["https://js-listings.test/hero.jpg", "image"],
      ["https://js-listings.test/font.woff2", "font"],
    ]);
    const crawl = new PlaywrightCrawl(ctxWith(), async () => browser);
    const doc = await crawl.fetchPage(PAGE);
    expect(doc).toMatchObject({ url: PAGE, status: 200, content_type: "text/html; charset=utf-8" });
    expect(doc.text).toMatch(/1200 Memorial Dr, Greenville, NC 27834.*\$900\/mo/s);
    const fetchUa = config().providers.options.fetch?.user_agent ?? DEFAULT_USER_AGENT;
    expect(browser.userAgents).toEqual([fetchUa]);
    const page = browser.pages[0]!;
    expect(page.continued).toEqual([PAGE, "https://js-listings.test/app.js", "https://js-listings.test/api/listings?city=greenville"]);
    expect(page.aborted).toEqual([
      "https://js-listings.test/private/admin.json", // disallowed by the site's robots.txt
      "https://api.tracker.test/collect", // that origin's robots.txt disallows everything
      "https://js-listings.test/hero.jpg",
      "https://js-listings.test/font.woff2",
    ]);
    expect(browser.contextsClosed).toBe(1);
    expect(crawl.launched).toBe(true);
    await crawl.close();
    expect(browser.closed).toBe(true);
    expect(crawl.launched).toBe(false);
  });

  it("refuses a page robots.txt disallows before any browser starts", async () => {
    let launched = false;
    const crawl = new PlaywrightCrawl(ctxWith(), async () => ((launched = true), new FakeBrowser()));
    await expect(crawl.fetchPage("https://blocked-site.test/listings/nc")).rejects.toBeInstanceOf(RobotsDisallowedError);
    expect(launched).toBe(false);
  });

  it("offline, it refuses to launch a browser and makes no request", async () => {
    const ctx = ctxWith();
    await expect(new PlaywrightCrawl(ctx).fetchPage(PAGE)).rejects.toThrow(/offline: browser launch refused/);
    expect(ctx.http.requests).toEqual([]);
  });

  it("waits the polite minimum interval between page loads on one origin", async () => {
    const crawl = new PlaywrightCrawl(ctxWith({ min_interval_ms: 150 }), async () => new FakeBrowser());
    const t0 = Date.now();
    await crawl.fetchPage(PAGE);
    await crawl.fetchPage(`${PAGE}?page=2`);
    expect(Date.now() - t0).toBeGreaterThanOrEqual(140);
  });
});

describe("crawler routing", () => {
  const build = (offline: boolean, crawler = "fetch") => {
    const cfg = config();
    const c = crawler === "fetch" ? cfg : config({ overrides: { providers: { ...structuredClone(cfg.providers), crawler } } });
    return buildProviders({ config: c, env: cleanEnv(), clock: makeClock(null), logger: silentLogger, offline, fixturesDir: offline ? "fixtures/golden-v1" : null, outDir: null, ledger: new CostLedger(), hosts: new Set() });
  };

  it("fetch stays the default; render: js sources get a lazily started local browser online", () => {
    const { providers } = build(false);
    expect(providers.crawler.name).toBe("fetch");
    expect(providers.jsCrawler).toBeInstanceOf(PlaywrightCrawl);
    expect((providers.jsCrawler as PlaywrightCrawl).launched).toBe(false);
    const ctx = { config: config(), providers };
    expect(crawlerFor(ctx, "rofo-greenville")).toBe(providers.jsCrawler);
    expect(crawlerFor(ctx, "ron-harrell-commercial")).toBe(providers.crawler);
  });

  it("choosing playwright as the default crawler reuses one browser for both", () => {
    const { providers } = build(false, "playwright");
    expect(providers.crawler).toBeInstanceOf(PlaywrightCrawl);
    expect(providers.jsCrawler).toBe(providers.crawler);
  });

  it("offline, both crawlers are fixture crawlers, so no browser can launch", async () => {
    const { providers } = build(true);
    expect(providers.jsCrawler).toBeInstanceOf(FixtureCrawl);
    expect(providers.jsCrawler.name).toBe("playwright");
    const dir = tmp();
    const fx = writeFixtureSet(join(dir, "fx"), [{ listing_id: "L1", address: "10 Test St, Greenville, NC 27834", parcel_id: "P1" }]);
    const r = await runOffline({ fixturesDir: fx, outDir: join(dir, "out"), runDate: "2026-09-16" });
    expect(r.run.errors).toEqual([]);
    expect(r.ctx.providers.jsCrawler).toBeInstanceOf(FixtureCrawl);
    expect(r.report!.providers.crawler).toBe("fetch");
  });

  it("sources.yaml: only Rofo renders with JavaScript; the refused aggregators stay refused", () => {
    const sources = config().sources;
    expect(sources.filter((s) => s.render === "js").map((s) => s.id)).toEqual(["rofo-greenville"]);
    expect(sources.find((s) => s.id === "rofo-greenville")).toMatchObject({ enabled: false, robots_txt: "allowed", terms_status: "allowed", render: "js" }); // off by PM 2026-09-22: no Greenville market
    for (const id of ["zoomprospector-pitt-county", "loopnet", "crexi"]) {
      const s = sources.find((x) => x.id === id)!;
      expect(refusalReason(s), id).not.toBeNull();
    }
    expect(sources.some((s) => /commercialcafe|cityfeet/i.test(s.url) && refusalReason(s) === null)).toBe(false);
  });
});
