import type { Table, TableRowMap } from "../core/types.js";

export type Filter = Record<string, unknown>;

/**
 * Minimal table store. Two implementations:
 *  - JsonFileStore: fixture/offline default, persists to a JSON file.
 *  - SupabaseStore: PostgREST over fetch (hosted Supabase, Supabase CLI, or the
 *    Docker postgis+postgrest stack in docker-compose.yml).
 * Every row has a string `id`; upsert is by id so stages stay idempotent.
 */
export interface Store {
  readonly kind: "json" | "supabase";
  init(): Promise<void>;
  get<T extends Table>(table: T, id: string): Promise<TableRowMap[T] | undefined>;
  list<T extends Table>(table: T, filter?: Filter): Promise<TableRowMap[T][]>;
  upsert<T extends Table>(table: T, rows: TableRowMap[T][]): Promise<void>;
  remove<T extends Table>(table: T, ids: string[]): Promise<void>;
  flush(): Promise<void>;
}

export function matchesFilter(row: Record<string, unknown>, filter?: Filter): boolean {
  if (!filter) return true;
  return Object.entries(filter).every(([k, v]) => row[k] === v);
}
