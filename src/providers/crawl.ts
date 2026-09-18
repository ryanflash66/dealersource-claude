import { htmlToText } from "./llm.js";
import { optString } from "./options.js";
import type { AdapterContext, CrawlProvider, CrawlResult, RobotsResult } from "./types.js";

/** Minimal robots.txt evaluation for a user agent (longest-match, Allow wins ties). */
export function robotsAllows(robotsTxt: string, path: string, userAgent: string): boolean {
  const groups: Array<{ agents: string[]; rules: Array<{ allow: boolean; path: string }> }> = [];
  let current: (typeof groups)[number] | null = null;
  for (const rawLine of robotsTxt.split(/\r?\n/)) {
    const line = rawLine.replace(/#.*$/, "").trim();
    if (!line) continue;
    const idx = line.indexOf(":");
    if (idx < 0) continue;
    const key = line.slice(0, idx).trim().toLowerCase();
    const value = line.slice(idx + 1).trim();
    if (key === "user-agent") {
      if (!current || current.rules.length) {
        current = { agents: [], rules: [] };
        groups.push(current);
      }
      current.agents.push(value.toLowerCase());
    } else if ((key === "allow" || key === "disallow") && current) {
      current.rules.push({ allow: key === "allow", path: value });
    }
  }
  const ua = userAgent.toLowerCase();
  const group =
    groups.find((g) => g.agents.some((a) => a !== "*" && ua.includes(a))) ?? groups.find((g) => g.agents.includes("*"));
  if (!group) return true;
  let best: { allow: boolean; len: number } | null = null;
  for (const r of group.rules) {
    if (!r.path) continue; // "Disallow:" (empty) allows everything
    const pattern = r.path.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*").replace(/\\\$$/, "$");
    if (new RegExp(`^${pattern}`).test(path)) {
      if (!best || r.path.length > best.len || (r.path.length === best.len && r.allow)) {
        best = { allow: r.allow, len: r.path.length };
      }
    }
  }
  return best ? best.allow : true;
}

export class RobotsDisallowedError extends Error {
  constructor(url: string, robotsUrl: string) {
    super(`robots.txt disallows ${url} (${robotsUrl}); refused`);
  }
}

/** Absolute http(s) links found in an HTML document, resolved against the page URL, deduplicated. */
export function extractLinks(html: string, baseUrl: string): string[] {
  const out = new Set<string>();
  const re = /<a\b[^>]*?\bhref\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html))) {
    const raw = (m[1] ?? m[2] ?? m[3] ?? "").trim().replace(/&amp;/g, "&");
    if (!raw || raw.startsWith("#") || /^(mailto|tel|javascript):/i.test(raw)) continue;
    try {
      const u = new URL(raw, baseUrl);
      if (u.protocol === "http:" || u.protocol === "https:") {
        u.hash = "";
        out.add(u.href);
      }
    } catch {
      /* unparsable href */
    }
  }
  return [...out];
}

/** The document shape every crawler adapter returns: raw HTML plus readable text and links. */
export function toDocument(url: string, status: number, contentType: string, html: string, fetchedAt: string): CrawlResult {
  return { url, status, content_type: contentType, body: html, text: htmlToText(html), links: extractLinks(html, url), fetched_at: fetchedAt };
}

async function fetchRobots(ctx: AdapterContext, url: string, userAgent: string): Promise<RobotsResult> {
  const u = new URL(url);
  const robotsUrl = `${u.origin}/robots.txt`;
  try {
    const res = await ctx.http.request({ url: robotsUrl, headers: { "User-Agent": userAgent }, timeoutMs: 15_000 });
    if (res.status >= 400 && res.status < 500) return { allowed: true, checked: true, source_url: robotsUrl }; // no robots => allowed
    if (!res.ok) return { allowed: false, checked: false, source_url: robotsUrl };
    return { allowed: robotsAllows(res.body, u.pathname + u.search, userAgent), checked: true, source_url: robotsUrl };
  } catch {
    return { allowed: false, checked: false, source_url: robotsUrl };
  }
}

/**
 * Plain Node fetch (zero cost, nothing to host): follows redirects, 15 s
 * timeout, polite User-Agent naming the project, no JavaScript execution.
 * robots.txt is checked for every page before it is fetched (cached per
 * origin for the run); a disallowed path is refused, never fetched.
 */
export class FetchCrawl implements CrawlProvider {
  readonly name = "fetch";
  private readonly robotsCache = new Map<string, string | null>(); // origin -> robots.txt body (null = none)
  constructor(private readonly ctx: AdapterContext) {}

  userAgent(): string {
    return optString(this.ctx.options, "user_agent", "dealersource/0.1 (+https://github.com/ryanflash66/dealersource)");
  }

  async fetchPage(url: string): Promise<CrawlResult> {
    const ua = this.userAgent();
    const robots = await this.checkRobots(url, ua);
    if (!robots.allowed) throw new RobotsDisallowedError(url, robots.source_url);
    const res = await this.ctx.http.request({
      url,
      headers: { "User-Agent": ua, Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,application/rss+xml;q=0.8,*/*;q=0.5" },
      timeoutMs: this.timeoutMs(),
    });
    const ct = res.headers["content-type"] ?? "text/html";
    return toDocument(res.url || url, res.status, ct, res.body, this.ctx.clock.iso());
  }

  async checkRobots(url: string, userAgent: string): Promise<RobotsResult> {
    const u = new URL(url);
    const robotsUrl = `${u.origin}/robots.txt`;
    if (!this.robotsCache.has(u.origin)) {
      try {
        const res = await this.ctx.http.request({ url: robotsUrl, headers: { "User-Agent": userAgent }, timeoutMs: this.timeoutMs() });
        if (res.status >= 400 && res.status < 500) this.robotsCache.set(u.origin, null); // no robots.txt => everything allowed
        else if (!res.ok) return { allowed: false, checked: false, source_url: robotsUrl }; // transient: do not cache, do not fetch
        else this.robotsCache.set(u.origin, res.body);
      } catch {
        return { allowed: false, checked: false, source_url: robotsUrl };
      }
    }
    const body = this.robotsCache.get(u.origin) ?? null;
    return { allowed: body === null ? true : robotsAllows(body, u.pathname + u.search, userAgent), checked: true, source_url: robotsUrl };
  }

  private timeoutMs(): number {
    const v = this.ctx.options.timeout_ms;
    return typeof v === "number" && v > 0 ? v : 15_000;
  }
}

interface AnyCrawlResponse {
  success?: boolean;
  data?: { html?: string; markdown?: string; status_code?: number; metadata?: { statusCode?: number } };
  error?: string;
}

/** Self-hosted AnyCrawl (ANYCRAWL_URL). Robots.txt is checked before every source fetch. */
export class AnyCrawlSelfHosted implements CrawlProvider {
  readonly name: string = "anycrawl";
  constructor(protected readonly ctx: AdapterContext) {}

  protected base(): string {
    const envName = optString(this.ctx.options, "base_url_env", "ANYCRAWL_URL");
    return (this.ctx.env[envName]?.trim() || optString(this.ctx.options, "default_base_url", "http://localhost:8080")).replace(/\/+$/, "");
  }
  protected authHeaders(): Record<string, string> {
    return {};
  }

  async fetchPage(url: string): Promise<CrawlResult> {
    const endpoint = `${this.base()}/v1/scrape`;
    const res = await this.ctx.http.request({
      method: "POST",
      url: endpoint,
      headers: { "Content-Type": "application/json", ...this.authHeaders() },
      body: JSON.stringify({ url, engine: "cheerio", formats: ["html"] }),
    });
    const j = res.json<AnyCrawlResponse>();
    if (!res.ok || !j.success || !j.data?.html) throw new Error(`AnyCrawl failed for ${url}: ${j.error ?? res.status}`);
    return toDocument(url, j.data.status_code ?? j.data.metadata?.statusCode ?? 200, "text/html", j.data.html, this.ctx.clock.iso());
  }

  async checkRobots(url: string, userAgent: string): Promise<RobotsResult> {
    return fetchRobots(this.ctx, url, userAgent);
  }
}

/** PAID. AnyCrawl cloud (ANYCRAWL_API_KEY). */
export class AnyCrawlCloud extends AnyCrawlSelfHosted {
  override readonly name = "anycrawl_cloud";
  protected override base(): string {
    return optString(this.ctx.options, "base_url", "https://api.anycrawl.dev").replace(/\/+$/, "");
  }
  protected override authHeaders(): Record<string, string> {
    return { Authorization: `Bearer ${this.ctx.env.ANYCRAWL_API_KEY ?? ""}` };
  }
}
