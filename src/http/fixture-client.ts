import { readdirSync, readFileSync, existsSync } from "node:fs";
import { resolve, join } from "node:path";
import { makeResponse, type HttpClient, type HttpRequest, type HttpResponse } from "./client.js";

/**
 * Recorded fixture format (fixtures/http/<adapter>/*.json):
 * {
 *   "fixtures": [
 *     { "match": { "method": "GET", "url_pattern": "onelineaddress.*Memorial", "body_pattern": "..." },
 *       "response": { "status": 200, "json": {...} | "body": "...", "content_type": "application/json" } }
 *   ]
 * }
 * `body_file` may point at a file relative to fixtures/ (HTML pages).
 */
export interface FixtureEntry {
  match: { method?: string; url_pattern: string; body_pattern?: string };
  response: { status?: number; json?: unknown; body?: string; body_file?: string; content_type?: string };
}

export class FixtureMissError extends Error {
  constructor(public readonly adapter: string, public readonly req: HttpRequest) {
    super(`No recorded fixture for ${adapter}: ${req.method ?? "GET"} ${req.url}` + (req.body ? ` body=${req.body.slice(0, 120)}` : ""));
  }
}

export interface RecordedRequest {
  adapter: string;
  method: string;
  url: string;
  body?: string;
}

export class FixtureHttpClient implements HttpClient {
  readonly kind = "fixture" as const;
  readonly requests: RecordedRequest[] = [];
  private readonly entries: FixtureEntry[];

  constructor(
    private readonly adapter: string,
    private readonly fixturesRoot: string,
    entries?: FixtureEntry[],
  ) {
    this.entries = entries ?? loadEntries(resolve(fixturesRoot, "http", adapter));
  }

  async request(req: HttpRequest): Promise<HttpResponse> {
    const method = req.method ?? "GET";
    this.requests.push({ adapter: this.adapter, method, url: req.url, body: req.body });
    for (const e of this.entries) {
      if (e.match.method && e.match.method.toUpperCase() !== method) continue;
      if (!new RegExp(e.match.url_pattern, "i").test(req.url)) continue;
      if (e.match.body_pattern && !new RegExp(e.match.body_pattern, "i").test(req.body ?? "")) continue;
      const r = e.response;
      let body: string;
      if (r.body_file) body = readFileSync(resolve(this.fixturesRoot, r.body_file), "utf8");
      else if (r.json !== undefined) body = JSON.stringify(r.json);
      else body = r.body ?? "";
      const ct = r.content_type ?? (r.json !== undefined ? "application/json" : "text/html");
      return makeResponse(r.status ?? 200, req.url, body, { "content-type": ct });
    }
    throw new FixtureMissError(this.adapter, req);
  }
}

function loadEntries(dir: string): FixtureEntry[] {
  if (!existsSync(dir)) return [];
  const out: FixtureEntry[] = [];
  for (const f of readdirSync(dir).filter((f) => f.endsWith(".json")).sort()) {
    const parsed = JSON.parse(readFileSync(join(dir, f), "utf8")) as { fixtures: FixtureEntry[] };
    out.push(...parsed.fixtures);
  }
  return out;
}
