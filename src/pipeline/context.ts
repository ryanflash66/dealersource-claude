import type { Clock } from "../core/clock.js";
import { addDays } from "../core/clock.js";
import type { Logger } from "../core/logger.js";
import type { AppConfig } from "../config/load.js";
import type { EvidenceMethod, EvidenceRow, Fact, ISODate, LatLon, RunRow, SiteRow, Stage, StageSummary } from "../core/types.js";
import type { Store } from "../store/store.js";
import type { ProviderMap } from "../providers/types.js";
import type { FixtureSet } from "../providers/fixture.js";
import type { CostLedger } from "../http/cost-ledger.js";
import { stableId } from "../core/ids.js";

export interface RunContext {
  config: AppConfig;
  store: Store;
  providers: ProviderMap;
  clock: Clock;
  logger: Logger;
  run: RunRow;
  offline: boolean;
  fixtures: FixtureSet | null;
  outDir: string;
  ledger: CostLedger;
  hosts: Set<string>;
  /** Logical today, YYYY-MM-DD. */
  runDate: string;
  /** End of the logical day; inbound mail after this is not visible yet. */
  cutoffIso: ISODate;
  homeBase: LatLon | null;
  /** Outbound messages sent in THIS run (for messages.json). */
  sentThisRun: string[];
  /** Mail that would have gone out this run had sending not been paused (outbox-preview.*). */
  outboxPreview?: OutboxPreviewItem[];
}

export interface OutboxPreviewItem {
  to: string;
  subject: string;
  body: string;
  site_id: string;
  address: string;
  case_types: string[];
  follow_up: boolean;
  template_id: string;
}

export function ttlDays(ctx: RunContext, fact: Fact): number {
  return ctx.config.business.evidence.ttl_days[fact] ?? 90;
}

export function isFresh(ev: EvidenceRow | undefined, nowIso: ISODate): ev is EvidenceRow {
  return !!ev && ev.status === "verified" && new Date(ev.expires_at).getTime() > new Date(nowIso).getTime();
}

/** Latest verified, unexpired evidence for a fact on a site (null if none). */
export async function currentEvidence(ctx: RunContext, siteId: string, fact: Fact): Promise<EvidenceRow | null> {
  const rows = await ctx.store.list("evidence", { site_id: siteId, fact });
  const fresh = rows.filter((r) => isFresh(r, ctx.clock.iso())).sort((a, b) => b.fetched_at.localeCompare(a.fetched_at));
  return fresh[0] ?? null;
}

/** Any evidence rows for a fact (including expired), newest first. */
export async function allEvidence(ctx: RunContext, siteId: string, fact: Fact): Promise<EvidenceRow[]> {
  const rows = await ctx.store.list("evidence", { site_id: siteId, fact });
  return rows.sort((a, b) => b.fetched_at.localeCompare(a.fetched_at));
}

export interface EvidenceInput {
  site_id: string;
  fact: Fact;
  value: unknown;
  source_url: string;
  method: EvidenceMethod;
  fetched_at?: ISODate;
  message_id?: string | null;
  notes?: string | null;
  status?: EvidenceRow["status"];
}

/** Idempotent evidence write: same site/fact/method/source => same row id. */
export async function writeEvidence(ctx: RunContext, input: EvidenceInput): Promise<EvidenceRow> {
  const fetchedAt = input.fetched_at ?? ctx.clock.iso();
  const row: EvidenceRow = {
    id: stableId("ev", input.site_id, input.fact, input.method, input.source_url, input.message_id ?? ""),
    site_id: input.site_id,
    fact: input.fact,
    value: input.value,
    source_url: input.source_url,
    fetched_at: fetchedAt,
    expires_at: addDays(fetchedAt, ttlDays(ctx, input.fact)),
    method: input.method,
    status: input.status ?? "verified",
    message_id: input.message_id ?? null,
    notes: input.notes ?? null,
    run_id: ctx.run.id,
  };
  await ctx.store.upsert("evidence", [row]);
  return row;
}

export async function touchSite(ctx: RunContext, site: SiteRow, patch: Partial<SiteRow>): Promise<SiteRow> {
  const next: SiteRow = { ...site, ...patch, updated_at: ctx.clock.iso() };
  await ctx.store.upsert("sites", [next]);
  return next;
}

export class StageCounter {
  readonly counts: Record<string, number> = {};
  readonly errors: string[] = [];
  readonly started: ISODate;
  constructor(private readonly ctx: RunContext, readonly stage: Stage) {
    this.started = ctx.clock.iso();
  }
  inc(key: string, by = 1): void {
    this.counts[key] = (this.counts[key] ?? 0) + by;
  }
  /** Stage-level failure: the run exits non-zero. Use for a stage that failed entirely. */
  error(msg: string, data: Record<string, unknown> = {}): void {
    this.errors.push(`${this.stage}: ${msg}`);
    this.ctx.logger.error(msg, { stage: this.stage, ...data });
  }
  /** Per-item degradation (one site, one source, one layer): recorded, surfaced, never aborts the run. */
  warn(msg: string, data: Record<string, unknown> = {}): void {
    const line = `${this.stage}: ${msg}`;
    if (!this.ctx.run.warnings.includes(line)) this.ctx.run.warnings.push(line);
    this.inc("warnings");
    this.ctx.logger.warn(msg, { stage: this.stage, ...data });
  }
  summary(): StageSummary {
    return { started_at: this.started, finished_at: this.ctx.clock.iso(), counts: this.counts, errors: this.errors };
  }
}

export function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
