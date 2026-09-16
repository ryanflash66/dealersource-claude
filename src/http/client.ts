export interface HttpRequest {
  method?: "GET" | "POST" | "PUT" | "DELETE";
  url: string;
  headers?: Record<string, string>;
  body?: string;
  timeoutMs?: number;
}

export interface HttpResponse {
  status: number;
  url: string;
  headers: Record<string, string>;
  body: string;
  json<T = unknown>(): T;
  ok: boolean;
}

export interface HttpClient {
  readonly kind: "fetch" | "fixture";
  request(req: HttpRequest): Promise<HttpResponse>;
}

export function makeResponse(status: number, url: string, body: string, headers: Record<string, string> = {}): HttpResponse {
  return {
    status,
    url,
    headers,
    body,
    ok: status >= 200 && status < 300,
    json<T>() {
      return JSON.parse(body) as T;
    },
  };
}

/** Real network client with a per-host politeness interval. */
export class FetchHttpClient implements HttpClient {
  readonly kind = "fetch" as const;
  private readonly lastByHost = new Map<string, number>();

  constructor(
    private readonly userAgent = "dealersource/0.1",
    private readonly minIntervalMs = 0,
    private readonly fetchImpl: typeof fetch = (i, init) => fetch(i, init),
  ) {}

  async request(req: HttpRequest): Promise<HttpResponse> {
    const host = new URL(req.url).host;
    if (this.minIntervalMs > 0) {
      const last = this.lastByHost.get(host) ?? 0;
      const wait = last + this.minIntervalMs - Date.now();
      if (wait > 0) await new Promise((r) => setTimeout(r, wait));
      this.lastByHost.set(host, Date.now());
    }
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), req.timeoutMs ?? 30_000);
    try {
      const res = await this.fetchImpl(req.url, {
        method: req.method ?? "GET",
        headers: { "User-Agent": this.userAgent, ...(req.headers ?? {}) },
        body: req.body,
        signal: ctrl.signal,
        redirect: "follow",
      });
      const headers: Record<string, string> = {};
      res.headers.forEach((v, k) => (headers[k.toLowerCase()] = v));
      return makeResponse(res.status, res.url || req.url, await res.text(), headers);
    } finally {
      clearTimeout(timer);
    }
  }
}
