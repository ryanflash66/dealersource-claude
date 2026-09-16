import { describe, expect, it } from "vitest";
import { join } from "node:path";
import { existsSync } from "node:fs";
import { JsonFileStore } from "../../src/store/json-store.js";
import { SupabaseStore } from "../../src/store/supabase-store.js";
import { makeStore } from "../../src/store/index.js";
import { NetworkDisabledError } from "../../src/http/network-guard.js";
import type { SourceRow } from "../../src/core/types.js";
import { cleanEnv, tmp } from "../helpers.js";

const src = (id: string, enabled = true): SourceRow => ({
  id, kind: "crawl", url: `https://${id}.test`, robots_txt: "unknown", terms_status: "allowed", enabled, cadence: "daily", fixture_only: false, notes: null, last_run_at: null, last_status: null, last_error: null,
});

describe("JsonFileStore (Supabase fake)", () => {
  it("upserts by id, filters by equality and persists across instances", async () => {
    const path = join(tmp(), "state", "state.json");
    const a = new JsonFileStore(path);
    await a.init();
    await a.upsert("sources", [src("a"), src("b", false)]);
    await a.upsert("sources", [{ ...src("a"), notes: "updated" }]);
    expect((await a.list("sources")).length).toBe(2);
    expect((await a.get("sources", "a"))?.notes).toBe("updated");
    expect((await a.list("sources", { enabled: false })).map((s) => s.id)).toEqual(["b"]);
    await a.flush();
    expect(existsSync(path)).toBe(true);
    const b = new JsonFileStore(path);
    await b.init();
    expect((await b.get("sources", "a"))?.notes).toBe("updated");
    await b.remove("sources", ["a"]);
    expect(await b.get("sources", "a")).toBeUndefined();
  });

  it("returns copies so callers cannot mutate stored rows by accident", async () => {
    const s = new JsonFileStore(null);
    await s.init();
    await s.upsert("sources", [src("a")]);
    const row = (await s.get("sources", "a"))!;
    row.notes = "mutated";
    expect((await s.get("sources", "a"))?.notes).toBeNull();
  });
});

describe("SupabaseStore (PostgREST over fetch)", () => {
  function fake() {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const fetchImpl = async (url: string, init?: RequestInit) => {
      calls.push({ url, init });
      return new Response(JSON.stringify([{ id: "x" }]), { status: 200, headers: { "content-type": "application/json" } });
    };
    return { calls, fetchImpl };
  }

  it("targets /rest/v1 on hosted Supabase and sends service-role headers", async () => {
    const f = fake();
    const s = new SupabaseStore("https://abc.supabase.co", "service-key", f.fetchImpl);
    await s.init();
    await s.list("sites", { parcel_id: "PITT-0001", stage: null });
    await s.upsert("sources", [src("a")]);
    await s.remove("sources", ["a", "b"]);
    expect(f.calls[0]!.url).toBe("https://abc.supabase.co/rest/v1/runs?select=id&limit=1");
    expect(f.calls[1]!.url).toBe("https://abc.supabase.co/rest/v1/sites?select=*&parcel_id=eq.PITT-0001&stage=is.null");
    const up = f.calls[2]!;
    expect(up.url).toBe("https://abc.supabase.co/rest/v1/sources?on_conflict=id");
    expect(up.init?.method).toBe("POST");
    const h = up.init?.headers as Record<string, string>;
    expect(h.Prefer).toContain("resolution=merge-duplicates");
    expect(h.apikey).toBe("service-key");
    expect(h.Authorization).toBe("Bearer service-key");
    expect(f.calls[3]!.url).toBe("https://abc.supabase.co/rest/v1/sources?id=in.(a,b)");
  });

  it("talks to a bare PostgREST (Docker stack) at its root", async () => {
    const f = fake();
    const s = new SupabaseStore("http://localhost:3000/", "svc", f.fetchImpl);
    await s.get("runs", "r1");
    expect(f.calls[0]!.url).toBe("http://localhost:3000/runs?select=*&id=eq.r1");
  });

  it("is only chosen when SUPABASE_URL and the service key are set and the run is online", () => {
    const root = tmp();
    expect(makeStore({ env: cleanEnv(), offline: false, rootDir: root }).store.kind).toBe("json");
    expect(makeStore({ env: { ...cleanEnv(), SUPABASE_URL: "https://abc.supabase.co", SUPABASE_SERVICE_ROLE_KEY: "k" }, offline: true, rootDir: root }).store.kind).toBe("json");
    expect(makeStore({ env: { ...cleanEnv(), SUPABASE_URL: "https://abc.supabase.co", SUPABASE_SERVICE_ROLE_KEY: "k" }, offline: false, rootDir: root }).store.kind).toBe("supabase");
  });

  it("the test-wide network guard blocks a real Supabase call", async () => {
    const s = new SupabaseStore("https://abc.supabase.co", "k");
    await expect(s.init()).rejects.toThrow(NetworkDisabledError);
  });
});
