import { optString } from "./options.js";
import type { AdapterContext, SocialPost, SocialProvider } from "./types.js";

interface RedditListing {
  data?: {
    children?: Array<{
      data: {
        id: string;
        title: string;
        selftext?: string;
        permalink: string;
        url?: string;
        created_utc: number;
        subreddit: string;
        author?: string;
      };
    }>;
  };
}

/**
 * Reddit official Data API (OAuth client-credentials, free tier). Web crawling
 * of reddit.com is disallowed by its robots.txt, so this is the only path.
 */
export class RedditSocial implements SocialProvider {
  readonly name = "reddit";
  private token: string | null = null;
  constructor(private readonly ctx: AdapterContext) {}

  private async accessToken(): Promise<string> {
    if (this.token) return this.token;
    const tokenUrl = optString(this.ctx.options, "token_url", "https://www.reddit.com/api/v1/access_token");
    const id = this.ctx.env.REDDIT_CLIENT_ID ?? "fixture";
    const secret = this.ctx.env.REDDIT_CLIENT_SECRET ?? "fixture";
    const res = await this.ctx.http.request({
      method: "POST",
      url: tokenUrl,
      headers: {
        Authorization: `Basic ${Buffer.from(`${id}:${secret}`).toString("base64")}`,
        "Content-Type": "application/x-www-form-urlencoded",
        "User-Agent": this.ctx.env.REDDIT_USER_AGENT ?? "dealersource/0.1",
      },
      body: "grant_type=client_credentials",
    });
    if (!res.ok) throw new Error(`Reddit token ${res.status}`);
    this.token = res.json<{ access_token: string }>().access_token;
    return this.token;
  }

  async search(subreddits: string[], queries: string[], limit: number): Promise<SocialPost[]> {
    const base = optString(this.ctx.options, "base_url", "https://oauth.reddit.com");
    const token = await this.accessToken();
    const seen = new Map<string, SocialPost>();
    for (const q of queries) {
      const url = `${base}/r/${subreddits.join("+")}/search?${new URLSearchParams({
        q,
        restrict_sr: "1",
        sort: "new",
        t: "month",
        limit: String(limit),
      })}`;
      const res = await this.ctx.http.request({
        url,
        headers: { Authorization: `Bearer ${token}`, "User-Agent": this.ctx.env.REDDIT_USER_AGENT ?? "dealersource/0.1" },
      });
      if (!res.ok) throw new Error(`Reddit search ${res.status}`);
      for (const c of res.json<RedditListing>().data?.children ?? []) {
        const d = c.data;
        if (seen.has(d.id)) continue;
        seen.set(d.id, {
          id: d.id,
          title: d.title,
          body: d.selftext ?? "",
          url: `https://www.reddit.com${d.permalink}`,
          created_at: new Date(d.created_utc * 1000).toISOString(),
          subreddit: d.subreddit,
          author: d.author ?? null,
        });
      }
    }
    return [...seen.values()];
  }
}
