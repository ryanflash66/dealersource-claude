import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { contractProviders } from "../config/schema.js";
import type { CaseType, ScoreRow } from "../core/types.js";
import { StageCounter, type RunContext } from "./context.js";

/** Section 14.4 report.json */
export interface ContractReport {
  schema_version: "1";
  run_id: string;
  run_date: string;
  offline: boolean;
  providers: ReturnType<typeof contractProviders>;
  sites: ContractSite[];
  evidence: ContractEvidence[];
  external_calls: string[];
  // Additions for the dashboard (allowed: schema does not forbid extra keys)
  business: {
    home_base: string;
    max_drive_minutes: number;
    rent_min: number;
    rent_max: number;
    shared_lot: string;
    office_required: boolean;
    weights: Record<string, number>;
  };
  exceptions: string[];
  sending_paused: boolean;
  pause_reason: string | null;
  sources: Array<{ id: string; kind: string; enabled: boolean; terms_status: string; robots_txt: string; last_status: string | null; last_error: string | null; notes: string | null }>;
  fixture_layers: string[];
}

export interface ContractSite {
  site_id: string;
  parcel_id: string;
  listing_ids: string[];
  address: string;
  in_search_area: boolean;
  drive_minutes: number | null;
  shared_lot: boolean;
  gates: Record<"zoning" | "rent" | "flood", { status: "pass" | "fail" | "pending"; evidence_ids: string[]; detail: string; warning: string | null }>;
  viable: boolean;
  score: number | null;
  rank: number | null;
  metrics: ScoreRow["metrics"];
  open_cases: Array<{ case_type: CaseType; status: string; recipient: string }>;
  // dashboard extras
  stage: string;
  jurisdiction: string | null;
  flags: string[];
  factors: ScoreRow["factors"];
  requirements: ScoreRow["requirements"];
  lat: number;
  lon: number;
  images: Array<{ url: string; kind: string }>;
}

export interface ContractEvidence {
  evidence_id: string;
  site_id: string;
  fact: string;
  value: unknown;
  source_url: string;
  fetched_at: string;
  expires_at: string;
  method: string;
  expired: boolean;
}

export interface ContractMessage {
  message_id: string;
  site_id: string;
  listing_id: string;
  case_type: CaseType;
  to: string;
  subject: string;
  body: string;
  sent_at: string;
  template_id: string;
}

export interface ContractRun {
  run_id: string;
  run_date: string;
  started_at: string;
  finished_at: string;
  counts: Record<string, number>;
  errors: string[];
  // extras
  warnings: string[];
  stages: unknown;
  providers: unknown;
  paid_calls: unknown[];
  external_calls: string[];
  sending_paused: boolean;
  pause_reason: string | null;
  mode: string;
}

/**
 * Stage 6: report. Writes report.json, messages.json (sent in THIS run only),
 * run.json and a Markdown digest to --out, and finalises the runs row.
 */
export async function report(ctx: RunContext): Promise<{ counter: StageCounter; report: ContractReport; messages: ContractMessage[] }> {
  const c = new StageCounter(ctx, "report");
  const now = ctx.clock.iso();
  const sites = await ctx.store.list("sites");
  const scores = new Map((await ctx.store.list("scores")).map((s) => [s.site_id, s]));
  const cases = await ctx.store.list("cases");
  const contacts = new Map((await ctx.store.list("contacts")).map((k) => [k.id, k]));
  const evidence = await ctx.store.list("evidence");
  const listings = await ctx.store.list("listings");
  const sources = await ctx.store.list("sources");
  const messages = await ctx.store.list("messages");

  const contractSites: ContractSite[] = [];
  for (const site of sites) {
    const sc = scores.get(site.id);
    const open = cases
      .filter((k) => k.site_id === site.id && (k.status === "open" || k.status === "awaiting_reply" || k.status === "escalated"))
      .map((k) => ({ case_type: k.type, status: k.status, recipient: (k.contact_id && contacts.get(k.contact_id)?.email) || (k.type === "zoning" ? site.planning_email : site.contact_email) || "none" }));
    const images = (evidence.find((e) => e.site_id === site.id && e.fact === "imagery")?.value as { images?: Array<{ url: string; kind: string }> } | undefined)?.images ?? [];
    contractSites.push({
      site_id: site.id,
      parcel_id: site.parcel_id,
      listing_ids: site.listing_ids,
      address: site.canonical_address,
      in_search_area: site.in_search_area === true,
      drive_minutes: site.drive_minutes,
      shared_lot: site.shared_lot,
      gates: sc
        ? { zoning: strip(sc.gates.zoning), rent: strip(sc.gates.rent), flood: strip(sc.gates.flood) }
        : { zoning: pending(), rent: pending(), flood: pending() },
      viable: sc?.viable ?? false,
      score: sc?.total ?? null,
      rank: sc?.rank ?? null,
      metrics: sc?.metrics ?? { aadt: null, visibility: null, drive_minutes: site.drive_minutes, rent_monthly: null, competitors: null },
      open_cases: open,
      stage: site.stage,
      jurisdiction: site.jurisdiction,
      flags: sc?.flags ?? [],
      factors: sc?.factors ?? [],
      requirements: sc?.requirements ?? [],
      lat: site.lat,
      lon: site.lon,
      images,
    });
  }
  contractSites.sort((a, b) => (a.rank ?? 1e9) - (b.rank ?? 1e9) || (b.score ?? -1) - (a.score ?? -1) || a.site_id.localeCompare(b.site_id));

  const exceptions: string[] = [];
  if (ctx.run.sending_paused) exceptions.push(`Sending paused: ${ctx.run.pause_reason}`);
  for (const s of sources) {
    if (s.last_status === "refused" || (s.terms_status !== "allowed" && !s.enabled)) exceptions.push(`Source ${s.id} excluded: ${s.terms_status === "prohibited" ? "terms prohibit" : s.robots_txt === "disallowed" ? "robots.txt disallows" : `terms ${s.terms_status}`}${s.notes ? ` - ${s.notes}` : ""}`);
    if (s.last_status === "error") exceptions.push(`Source ${s.id} failed: ${s.last_error}`);
  }
  for (const l of listings) if (l.status === "unresolved") exceptions.push(`Listing ${l.id} unresolved: ${l.status_detail} (${l.url})`);
  for (const e of evidence) if (new Date(e.expires_at).getTime() <= new Date(now).getTime()) exceptions.push(`Evidence expired: ${e.fact} for ${e.site_id} (expired ${e.expires_at})`);
  for (const k of cases) if (k.status === "escalated") exceptions.push(`Case ${k.id} escalated: ${k.next_action}`);
  for (const w of ctx.run.warnings) exceptions.push(w);

  const rep: ContractReport = {
    schema_version: "1",
    run_id: ctx.run.id,
    run_date: ctx.runDate,
    offline: ctx.offline,
    providers: contractProviders(ctx.config.providers),
    sites: contractSites,
    evidence: evidence
      .sort((a, b) => a.site_id.localeCompare(b.site_id) || a.fact.localeCompare(b.fact) || b.fetched_at.localeCompare(a.fetched_at))
      .map((e) => ({
        evidence_id: e.id,
        site_id: e.site_id,
        fact: e.fact,
        value: e.value,
        source_url: e.source_url,
        fetched_at: e.fetched_at,
        expires_at: e.expires_at,
        method: e.method,
        expired: new Date(e.expires_at).getTime() <= new Date(now).getTime(),
      })),
    external_calls: [...ctx.hosts].sort(),
    business: {
      home_base: ctx.config.business.search.home_base,
      max_drive_minutes: ctx.config.business.search.max_drive_minutes,
      rent_min: ctx.config.business.rent.min_monthly,
      rent_max: ctx.config.business.rent.max_monthly,
      shared_lot: ctx.config.business.site.shared_lot,
      office_required: ctx.config.business.site.office_required,
      weights: ctx.config.business.score.weights,
    },
    exceptions,
    sending_paused: ctx.run.sending_paused,
    pause_reason: ctx.run.pause_reason,
    sources: sources.map((s) => ({ id: s.id, kind: s.kind, enabled: s.enabled, terms_status: s.terms_status, robots_txt: s.robots_txt, last_status: s.last_status, last_error: s.last_error, notes: s.notes })),
    fixture_layers: ctx.run.fixture_layers,
  };

  const sent: ContractMessage[] = messages
    .filter((m) => ctx.sentThisRun.includes(m.id))
    .sort((a, b) => a.sent_at.localeCompare(b.sent_at) || a.id.localeCompare(b.id))
    .map((m) => ({
      message_id: m.id,
      site_id: m.site_id,
      listing_id: m.listing_id,
      case_type: m.case_type,
      to: m.to,
      subject: m.subject,
      body: m.body,
      sent_at: m.sent_at,
      template_id: m.template_id ?? "unknown",
    }));

  const digest = await ctx.providers.llm.writeDigest({
    run_id: ctx.run.id,
    run_date: ctx.runDate,
    shortlist: contractSites.filter((s) => s.viable && s.rank !== null).map((s) => ({ rank: s.rank!, address: s.address, score: s.score ?? 0, rent: s.metrics.rent_monthly, flags: s.flags })),
    open_cases: cases.filter((k) => k.status === "open" || k.status === "awaiting_reply").length,
    escalated_cases: cases.filter((k) => k.status === "escalated").length,
    sent: sent.length,
    received: messages.filter((m) => m.direction === "inbound" && m.run_id === ctx.run.id).length,
    exceptions,
  });

  await ctx.store.upsert("reports", [{ id: ctx.run.id, run_date: ctx.runDate, created_at: now, payload: rep, messages: sent }]);

  mkdirSync(ctx.outDir, { recursive: true });
  writeFileSync(resolve(ctx.outDir, "report.json"), JSON.stringify(rep, null, 2));
  writeFileSync(resolve(ctx.outDir, "messages.json"), JSON.stringify(sent, null, 2));
  writeFileSync(resolve(ctx.outDir, "digest.md"), digest);
  c.inc("sites_reported", contractSites.length);
  c.inc("messages_reported", sent.length);
  c.inc("evidence_reported", rep.evidence.length);
  return { counter: c, report: rep, messages: sent };
}

function strip(g: ScoreRow["gates"]["zoning"]) {
  return { status: g.status, evidence_ids: g.evidence_ids, detail: g.detail, warning: g.warning };
}
function pending() {
  return { status: "pending" as const, evidence_ids: [], detail: "not evaluated", warning: null };
}

export function writeRunJson(ctx: RunContext, finishedAt: string): ContractRun {
  const counts: Record<string, number> = {};
  for (const [stage, s] of Object.entries(ctx.run.stages)) {
    for (const [k, v] of Object.entries(s!.counts)) counts[`${stage}.${k}`] = v;
  }
  counts.errors = ctx.run.errors.length;
  counts.messages_sent = ctx.sentThisRun.length;
  counts.paid_calls = ctx.run.paid_calls.length;
  const out: ContractRun = {
    run_id: ctx.run.id,
    run_date: ctx.runDate,
    started_at: ctx.run.started_at,
    finished_at: finishedAt,
    counts,
    errors: ctx.run.errors,
    warnings: ctx.run.warnings,
    stages: ctx.run.stages,
    providers: ctx.run.providers,
    paid_calls: ctx.run.paid_calls,
    external_calls: [...ctx.hosts].sort(),
    sending_paused: ctx.run.sending_paused,
    pause_reason: ctx.run.pause_reason,
    mode: ctx.run.mode,
  };
  mkdirSync(ctx.outDir, { recursive: true });
  writeFileSync(resolve(ctx.outDir, "run.json"), JSON.stringify(out, null, 2));
  return out;
}
