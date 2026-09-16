import { resolve } from "node:path";
import { JsonFileStore } from "./json-store.js";
import { SupabaseStore } from "./supabase-store.js";
import type { Store } from "./store.js";

export interface StoreOptions {
  env: NodeJS.ProcessEnv;
  offline: boolean;
  rootDir: string;
  /** Explicit JSON path (tests); null keeps state in memory only. */
  statePath?: string | null;
}

/**
 * Supabase is used only when SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY are set
 * and the run is online. Otherwise the JSON store is the fixture-backed fake.
 */
export function makeStore(opts: StoreOptions): { store: Store; description: string } {
  const { env } = opts;
  if (!opts.offline && env.SUPABASE_URL?.trim() && env.SUPABASE_SERVICE_ROLE_KEY?.trim()) {
    return {
      store: new SupabaseStore(env.SUPABASE_URL.trim(), env.SUPABASE_SERVICE_ROLE_KEY.trim()),
      description: `supabase (${new URL(env.SUPABASE_URL).hostname})`,
    };
  }
  if (opts.statePath === null) return { store: new JsonFileStore(null), description: "json (memory)" };
  const dir = env.DEALERSOURCE_STATE_DIR?.trim() || resolve(opts.rootDir, ".dealersource");
  const path = opts.statePath ?? resolve(dir, "state.json");
  return { store: new JsonFileStore(path), description: `json (${path})` };
}

export type { Store } from "./store.js";
export { JsonFileStore } from "./json-store.js";
export { SupabaseStore } from "./supabase-store.js";
