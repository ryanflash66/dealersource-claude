import { sha256, stableId } from "../core/ids.js";
import { normalizeAddressKey } from "../core/address.js";
import type { ListingExtraction, ListingRow, RawDocumentRow, SourceRow } from "../core/types.js";
import type { SourceConfig } from "../config/schema.js";
import { htmlToText } from "../providers/llm.js";
import type { CrawlProvider } from "../providers/types.js";
import { StageCounter, errMsg, type RunContext } from "./context.js";

/**
 * Stage 1: discover. Seeds the sources table from sources.yaml, refuses any
 * source whose terms or robots forbid crawling, and turns fetched pages (or
 * the section-14.3 listings.json offline) into raw_documents + listings.
 * Idempotent: listing ids are stable, re-runs only bump last_seen_at.
 */
export async function discover(ctx: RunContext): Promise<StageCounter> {
  const c = new StageCounter(ctx, "discover");
  await seedSources(ctx);

  if (ctx.offline || ctx.fixtures?.has("listings.json")) {
    await discoverFromFixtures(ctx, c);
  } else {
    await discoverOnline(ctx, c);
  }
  return c;
}

export function refusalReason(s: Pick<SourceRow, "terms_status" | "robots_txt" | "enabled">): string | null {
  if (s.terms_status === "prohibited") return "terms_status=prohibited";
  if (s.robots_txt === "disallowed") return "robots_txt=disallowed";
  if (s.terms_status === "unclear") return "terms_status=unclear (PM must flip to allowed)";
  if (!s.enabled) return "disabled";
  return null;
}

async function seedSources(ctx: RunContext): Promise<void> {
  const existing = new Map((await ctx.store.list("sources")).map((s) => [s.id, s]));
  const rows: SourceRow[] = ctx.config.sources.map((s: SourceConfig) => ({
    id: s.id,
    kind: s.kind,
    url: s.url,
    robots_txt: s.robots_txt,
    terms_status: s.terms_status,
    enabled: s.enabled,
    cadence: s.cadence,
    fixture_only: s.fixture_only,
    contact_email: s.contact_email,
    notes: s.notes,
    last_run_at: existing.get(s.id)?.last_run_at ?? null,
    last_status: existing.get(s.id)?.last_status ?? null,
    last_error: existing.get(s.id)?.last_error ?? null,
  }));
  await ctx.store.upsert("sources", rows);
}

// ------------------------------------------------------------- fixtures
async function discoverFromFixtures(ctx: RunContext, c: StageCounter): Promise<void> {
  const listings = ctx.fixtures!.listings();
  const now = ctx.clock.iso();
  const sources = new Map((await ctx.store.list("sources")).map((s) => [s.id, s]));

  for (const l of listings) {
    let source = sources.get(l.source_id);
    if (!source) {
      // Listings already fetched by the operator's crawler: register the source so
      // the allowlist has a row to govern it from now on.
      source = {
        id: l.source_id,
        kind: /reddit/i.test(l.source_id) || /reddit\.com/i.test(l.url) ? "reddit" : "crawl",
        url: safeOrigin(l.url),
        robots_txt: "unknown",
        terms_status: "allowed",
        enabled: true,
        cadence: "daily",
        fixture_only: false,
        contact_email: null,
        notes: "auto-registered from listings.json (already-fetched listing); review terms",
        last_run_at: now,
        last_status: "ok",
        last_error: null,
      };
      sources.set(source.id, source);
      c.inc("sources_registered");
    }
    const refusal = source.terms_status === "prohibited" ? "terms_status=prohibited" : source.robots_txt === "disallowed" ? "robots_txt=disallowed" : null;
    source.last_run_at = now;
    source.last_status = refusal ? "refused" : "ok";
    await ctx.store.upsert("sources", [source]);

    const body = JSON.stringify(l);
    const doc: RawDocumentRow = {
      id: stableId("doc", l.source_id, l.url, sha256(body)),
      source_id: l.source_id,
      url: l.url,
      fetched_at: l.fetched_at,
      content_type: "application/json",
      body,
      sha256: sha256(body),
      run_id: ctx.run.id,
    };
    await ctx.store.upsert("raw_documents", [doc]);

    const extraction: ListingExtraction = {
      title: l.title,
      address_text: l.address,
      rent_monthly: l.rent_monthly,
      sqft: null,
      has_office: l.has_office,
      vehicle_capacity: l.vehicle_capacity,
      shared_lot: l.shared_lot,
      contact_email: l.contact_email,
      contact_name: null,
      contact_phone: null,
      description: l.description,
      confidence: 1,
      method: "fixture",
    };
    const prev = await ctx.store.get("listings", l.listing_id);
    const row: ListingRow = {
      id: l.listing_id,
      source_id: l.source_id,
      raw_document_id: doc.id,
      url: l.url,
      title: l.title,
      address_text: l.address,
      address_key: normalizeAddressKey(l.address),
      fetched_at: l.fetched_at,
      extraction,
      site_id: prev?.site_id ?? null,
      status: refusal ? "refused" : prev?.status === "resolved" ? "resolved" : "new",
      status_detail: refusal ? `source refused: ${refusal}` : prev?.status_detail ?? null,
      first_seen_at: prev?.first_seen_at ?? now,
      last_seen_at: now,
      run_id: ctx.run.id,
    };
    await ctx.store.upsert("listings", [row]);
    c.inc(refusal ? "listings_refused" : prev ? "listings_seen" : "listings_new");
  }
}

function safeOrigin(url: string): string {
  try {
    return new URL(url).origin;
  } catch {
    return url;
  }
}

// --------------------------------------------------------------- online
async function discoverOnline(ctx: RunContext, c: StageCounter): Promise<void> {
  const now = ctx.clock.iso();
  const ua = String(ctx.config.providers.options[ctx.config.providers.crawler]?.user_agent ?? "dealersource/0.1");
  try {
    await discoverSources(ctx, c, ua, now);
  } finally {
    // A render: js source may have started a browser; never leave it running past discovery.
    await ctx.providers.jsCrawler?.close?.();
    await ctx.providers.crawler.close?.();
  }
  // Discovery failed entirely only when every eligible source failed and nothing was fetched.
  if ((c.counts.sources_fetched ?? 0) === 0 && (c.counts.warnings ?? 0) > 0) c.error("every enabled source failed to fetch; nothing discovered");
}

/** Sources marked `render: js` in sources.yaml use the headless-browser crawler; all others the default crawler. */
export function crawlerFor(ctx: Pick<RunContext, "config" | "providers">, sourceId: string): CrawlProvider {
  return ctx.config.sources.find((s) => s.id === sourceId)?.render === "js" ? ctx.providers.jsCrawler : ctx.providers.crawler;
}

async function discoverSources(ctx: RunContext, c: StageCounter, ua: string, now: string): Promise<void> {
  for (const source of await ctx.store.list("sources")) {
    const reason = refusalReason(source);
    if (reason || source.fixture_only) {
      source.last_status = reason?.startsWith("terms_status=prohibited") || reason?.startsWith("robots") ? "refused" : "skipped";
      source.last_error = reason ?? "fixture_only";
      await ctx.store.upsert("sources", [source]);
      c.inc(source.last_status === "refused" ? "sources_refused" : "sources_skipped");
      continue;
    }
    try {
      if (source.kind === "manual") await ingestManual(ctx, c, source);
      else if (source.kind === "reddit") await ingestReddit(ctx, c, source);
      else {
        const crawler = crawlerFor(ctx, source.id);
        if (crawler !== ctx.providers.crawler) c.inc("sources_rendered_js");
        await ingestPage(ctx, c, source, ua, crawler);
      }
      source.last_status = "ok";
      source.last_error = null;
      c.inc("sources_fetched");
    } catch (e) {
      source.last_status = "error";
      source.last_error = errMsg(e);
      c.warn(`source ${source.id} failed: ${errMsg(e)}`, { source: source.id });
    }
    source.last_run_at = now;
    await ctx.store.upsert("sources", [source]);
  }
}

async function ingestPage(ctx: RunContext, c: StageCounter, source: SourceRow, ua: string, crawler: CrawlProvider): Promise<void> {
  if (source.robots_txt === "unknown") {
    const robots = await crawler.checkRobots(source.url, ua);
    if (robots.checked) source.robots_txt = robots.allowed ? "allowed" : "disallowed";
    if (!robots.allowed) throw new Error(`robots.txt disallows ${source.url} (${robots.source_url})`);
  }
  const page = await crawler.fetchPage(source.url);
  if (page.status >= 400) throw new Error(`HTTP ${page.status}`);
  const doc: RawDocumentRow = {
    id: stableId("doc", source.id, page.url, sha256(page.body)),
    source_id: source.id,
    url: page.url,
    fetched_at: page.fetched_at,
    content_type: page.content_type,
    body: page.body,
    sha256: sha256(page.body),
    run_id: ctx.run.id,
  };
  await ctx.store.upsert("raw_documents", [doc]);
  const blocks = source.kind === "rss" ? splitRss(page.body) : splitListingBlocks(page.body);
  for (const block of blocks) {
    const extraction = await ctx.providers.llm.extractListing({ url: page.url, source_id: source.id, html: page.body, block });
    if (!extraction.address_text) {
      c.inc("blocks_without_address");
      continue;
    }
    await upsertListing(ctx, c, source, doc, extraction, block);
  }
}

async function ingestReddit(ctx: RunContext, c: StageCounter, source: SourceRow): Promise<void> {
  const o = ctx.config.providers.options.reddit ?? {};
  const subs = Array.isArray(o.subreddits) ? (o.subreddits as string[]) : ["greenvillenc"];
  const queries = Array.isArray(o.queries) ? (o.queries as string[]) : ["for lease"];
  const posts = await ctx.providers.social.search(subs, queries, Number(o.limit_per_query ?? 25));
  for (const p of posts) {
    const body = JSON.stringify(p);
    const doc: RawDocumentRow = {
      id: stableId("doc", source.id, p.url, sha256(body)),
      source_id: source.id,
      url: p.url,
      fetched_at: ctx.clock.iso(),
      content_type: "application/json",
      body,
      sha256: sha256(body),
      run_id: ctx.run.id,
    };
    await ctx.store.upsert("raw_documents", [doc]);
    const extraction = await ctx.providers.llm.extractListing({ url: p.url, source_id: source.id, html: `${p.title}\n${p.body}` });
    if (!extraction.address_text) {
      c.inc("posts_without_address");
      continue;
    }
    await upsertListing(ctx, c, source, doc, extraction, p.url);
  }
}

async function ingestManual(ctx: RunContext, c: StageCounter, source: SourceRow): Promise<void> {
  for (const lead of ctx.config.manualLeads.leads) {
    const body = JSON.stringify(lead);
    const doc: RawDocumentRow = {
      id: stableId("doc", source.id, lead.url, sha256(body)),
      source_id: source.id,
      url: lead.url,
      fetched_at: ctx.clock.iso(),
      content_type: "application/json",
      body,
      sha256: sha256(body),
      run_id: ctx.run.id,
    };
    await ctx.store.upsert("raw_documents", [doc]);
    const extraction: ListingExtraction = {
      title: lead.title,
      address_text: lead.address_text,
      rent_monthly: lead.rent_monthly_advertised,
      sqft: null,
      has_office: lead.has_office,
      vehicle_capacity: null,
      shared_lot: lead.shared_lot,
      contact_email: lead.contact_email,
      contact_name: lead.contact_name,
      contact_phone: null,
      description: lead.notes,
      confidence: 1,
      method: "manual",
    };
    await upsertListing(ctx, c, source, doc, extraction, lead.url);
  }
}

async function upsertListing(
  ctx: RunContext,
  c: StageCounter,
  source: SourceRow,
  doc: RawDocumentRow,
  extraction: ListingExtraction,
  blockKey: string,
): Promise<void> {
  const now = ctx.clock.iso();
  const key = normalizeAddressKey(extraction.address_text!);
  const id = stableId("lst", source.id, doc.url, key);
  const prev = await ctx.store.get("listings", id);
  const row: ListingRow = {
    id,
    source_id: source.id,
    raw_document_id: doc.id,
    url: doc.url,
    title: extraction.title,
    address_text: extraction.address_text,
    address_key: key,
    fetched_at: doc.fetched_at,
    extraction,
    site_id: prev?.site_id ?? null,
    status: prev?.status === "resolved" ? "resolved" : "new",
    status_detail: prev?.status_detail ?? null,
    first_seen_at: prev?.first_seen_at ?? now,
    last_seen_at: now,
    run_id: ctx.run.id,
  };
  await ctx.store.upsert("listings", [row]);
  c.inc(prev ? "listings_seen" : "listings_new");
  void blockKey;
}

/** Splits a listings page into per-listing blocks (articles/list items), falling back to the whole page. */
export function splitListingBlocks(html: string): string[] {
  const blocks = html.match(/<(article|li|tr|section)\b[^>]*>[\s\S]*?<\/\1>/gi) ?? [];
  const useful = blocks.filter((b) => /\b(NC|North Carolina)\b/i.test(htmlToText(b)));
  return useful.length ? useful : [html];
}

export function splitRss(xml: string): string[] {
  return xml.match(/<(item|entry)\b[^>]*>[\s\S]*?<\/\1>/gi) ?? [xml];
}
