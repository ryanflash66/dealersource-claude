import { mkdirSync, readFileSync, writeFileSync, existsSync, renameSync } from "node:fs";
import { dirname } from "node:path";
import { TABLES, type Table, type TableRowMap } from "../core/types.js";
import { matchesFilter, type Filter, type Store } from "./store.js";

type Tables = { [T in Table]: Map<string, TableRowMap[T]> };

/**
 * JSON-file store: the fixture-backed fake for Supabase. Keeps every table in
 * memory and writes the whole state atomically on flush(). Good for offline
 * runs, tests and the local dev loop; not for concurrent writers.
 */
export class JsonFileStore implements Store {
  readonly kind = "json" as const;
  private tables: Tables = emptyTables();
  private dirty = false;

  constructor(private readonly path: string | null) {}

  async init(): Promise<void> {
    this.tables = emptyTables();
    if (this.path && existsSync(this.path)) {
      const raw = JSON.parse(readFileSync(this.path, "utf8")) as Partial<Record<Table, unknown[]>>;
      for (const t of TABLES) {
        for (const row of (raw[t] ?? []) as Array<{ id: string }>) {
          (this.tables[t] as Map<string, unknown>).set(row.id, row);
        }
      }
    }
  }

  async get<T extends Table>(table: T, id: string): Promise<TableRowMap[T] | undefined> {
    const row = this.tables[table].get(id);
    return row ? structuredClone(row) : undefined;
  }

  async list<T extends Table>(table: T, filter?: Filter): Promise<TableRowMap[T][]> {
    const out: TableRowMap[T][] = [];
    for (const row of this.tables[table].values()) {
      if (matchesFilter(row as unknown as Record<string, unknown>, filter)) out.push(structuredClone(row));
    }
    return out;
  }

  async upsert<T extends Table>(table: T, rows: TableRowMap[T][]): Promise<void> {
    for (const row of rows) {
      if (!row.id) throw new Error(`upsert into ${table}: row without id`);
      (this.tables[table] as Map<string, TableRowMap[T]>).set(row.id, structuredClone(row));
    }
    if (rows.length) this.dirty = true;
  }

  async remove<T extends Table>(table: T, ids: string[]): Promise<void> {
    for (const id of ids) this.tables[table].delete(id);
    if (ids.length) this.dirty = true;
  }

  async flush(): Promise<void> {
    if (!this.path || !this.dirty) return;
    mkdirSync(dirname(this.path), { recursive: true });
    const out: Record<string, unknown[]> = {};
    for (const t of TABLES) out[t] = [...this.tables[t].values()];
    const tmp = `${this.path}.tmp`;
    writeFileSync(tmp, JSON.stringify(out, null, 2));
    renameSync(tmp, this.path);
    this.dirty = false;
  }

  /** Test helper: table sizes. */
  sizes(): Record<Table, number> {
    return Object.fromEntries(TABLES.map((t) => [t, this.tables[t].size])) as Record<Table, number>;
  }
}

function emptyTables(): Tables {
  return Object.fromEntries(TABLES.map((t) => [t, new Map()])) as unknown as Tables;
}
