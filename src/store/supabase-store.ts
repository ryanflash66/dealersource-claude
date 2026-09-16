import type { Table, TableRowMap } from "../core/types.js";
import type { Filter, Store } from "./store.js";

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

/**
 * Supabase store via PostgREST. Works against hosted Supabase
 * (`https://<ref>.supabase.co`), the Supabase CLI stack, or the Docker
 * postgis+postgrest stack (`http://localhost:3000`, no apikey header needed
 * when the key is blank). Uses the SERVICE ROLE key: server side only.
 */
export class SupabaseStore implements Store {
  readonly kind = "supabase" as const;
  private readonly rest: string;

  constructor(
    private readonly url: string,
    private readonly serviceKey: string,
    private readonly fetchImpl: FetchLike = (i, init) => fetch(i, init),
    private readonly schema = "public",
  ) {
    const base = url.replace(/\/+$/, "");
    // Hosted Supabase exposes PostgREST under /rest/v1; a bare PostgREST
    // (Docker stack) serves tables at its root.
    const hosted = /\.supabase\.(co|in)$/.test(new URL(base).hostname);
    this.rest = hosted && !base.endsWith("/rest/v1") ? `${base}/rest/v1` : base;
  }

  async init(): Promise<void> {
    // Cheap connectivity check; surfaces bad URL/key before the run starts.
    const res = await this.fetchImpl(`${this.rest}/runs?select=id&limit=1`, { headers: this.headers() });
    if (!res.ok) throw new Error(`Supabase store not reachable: ${res.status} ${await res.text()}`);
  }

  async get<T extends Table>(table: T, id: string): Promise<TableRowMap[T] | undefined> {
    const rows = await this.list(table, { id });
    return rows[0];
  }

  async list<T extends Table>(table: T, filter?: Filter): Promise<TableRowMap[T][]> {
    const params = new URLSearchParams({ select: "*" });
    for (const [k, v] of Object.entries(filter ?? {})) {
      params.set(k, v === null ? "is.null" : `eq.${String(v)}`);
    }
    const res = await this.fetchImpl(`${this.rest}/${table}?${params.toString()}`, { headers: this.headers() });
    if (!res.ok) throw new Error(`Supabase list ${table} failed: ${res.status} ${await res.text()}`);
    return (await res.json()) as TableRowMap[T][];
  }

  async upsert<T extends Table>(table: T, rows: TableRowMap[T][]): Promise<void> {
    if (!rows.length) return;
    const res = await this.fetchImpl(`${this.rest}/${table}?on_conflict=id`, {
      method: "POST",
      headers: { ...this.headers(), "Content-Type": "application/json", Prefer: "resolution=merge-duplicates,return=minimal" },
      body: JSON.stringify(rows),
    });
    if (!res.ok) throw new Error(`Supabase upsert ${table} failed: ${res.status} ${await res.text()}`);
  }

  async remove<T extends Table>(table: T, ids: string[]): Promise<void> {
    if (!ids.length) return;
    const res = await this.fetchImpl(`${this.rest}/${table}?id=in.(${ids.map(encodeURIComponent).join(",")})`, {
      method: "DELETE",
      headers: this.headers(),
    });
    if (!res.ok) throw new Error(`Supabase delete ${table} failed: ${res.status} ${await res.text()}`);
  }

  async flush(): Promise<void> {
    /* writes are immediate */
  }

  private headers(): Record<string, string> {
    const h: Record<string, string> = { Accept: "application/json", "Accept-Profile": this.schema, "Content-Profile": this.schema };
    if (this.serviceKey) {
      h.apikey = this.serviceKey;
      h.Authorization = `Bearer ${this.serviceKey}`;
    }
    return h;
  }
}
