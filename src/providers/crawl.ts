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
    return {
      url,
      status: j.data.status_code ?? j.data.metadata?.statusCode ?? 200,
      content_type: "text/html",
      body: j.data.html,
      fetched_at: this.ctx.clock.iso(),
    };
  }

  async checkRobots(url: string, userAgent: string): Promise<RobotsResult> {
    const u = new URL(url);
    const robotsUrl = `${u.origin}/robots.txt`;
    try {
      const res = await this.ctx.http.request({ url: robotsUrl, headers: { "User-Agent": userAgent } });
      if (res.status >= 400 && res.status < 500) return { allowed: true, checked: true, source_url: robotsUrl }; // no robots => allowed
      if (!res.ok) return { allowed: false, checked: false, source_url: robotsUrl };
      return { allowed: robotsAllows(res.body, u.pathname + u.search, userAgent), checked: true, source_url: robotsUrl };
    } catch {
      return { allowed: false, checked: false, source_url: robotsUrl };
    }
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
