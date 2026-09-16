/*
 * DealerSource dashboard.
 *
 * Single ES module, no runtime dependencies. Renders four hash-routed views
 * (Shortlist, Pipeline, Exceptions, Config) from the pipeline's report.json,
 * messages.json and run.json - fetched either from Supabase (when
 * window.DS_CONFIG has a URL + anon key) or from ./data/*.json.
 *
 * Everything is built with DOM APIs (textContent, never innerHTML with data),
 * so report content can never inject markup.
 */

export {};

// ---------------------------------------------------------------------------
// Types (mirror out/golden/report.json)
// ---------------------------------------------------------------------------

type GateStatus = "pass" | "fail" | "pending";

interface Gate {
  status: GateStatus;
  evidence_ids: string[];
  detail: string | null;
  warning: string | null;
}

interface Factor {
  factor: string;
  raw: number | null;
  normalized: number | null;
  weight: number;
  weighted: number | null;
  detail: string | null;
}

interface Requirement {
  name: string;
  outcome: string;
  detail: string | null;
}

interface OpenCase {
  case_type: string;
  status: string;
  recipient: string | null;
}

interface SiteImage {
  url: string;
  kind: string | null;
}

interface Site {
  site_id: string;
  parcel_id: string;
  listing_ids: string[];
  address: string;
  in_search_area: boolean;
  drive_minutes: number | null;
  shared_lot: boolean;
  gates: { zoning: Gate; rent: Gate; flood: Gate };
  viable: boolean;
  score: number | null;
  rank: number | null;
  metrics: {
    aadt: number | null;
    visibility: number | null;
    drive_minutes: number | null;
    rent_monthly: number | null;
    competitors: number | null;
  };
  open_cases: OpenCase[];
  stage: string;
  jurisdiction: string | null;
  flags: string[];
  factors: Factor[];
  requirements: Requirement[];
  lat: number | null;
  lon: number | null;
  images: SiteImage[];
}

interface Evidence {
  evidence_id: string;
  site_id: string;
  fact: string;
  value: unknown;
  source_url: string | null;
  fetched_at: string | null;
  expires_at: string | null;
  method: string | null;
  expired: boolean;
}

interface SourceRow {
  id: string;
  kind: string;
  enabled: boolean;
  terms_status: string | null;
  robots_txt: string | null;
  last_status: string | null;
  last_error: string | null;
  notes: string | null;
}

interface Business {
  home_base: string;
  max_drive_minutes: number;
  rent_min: number;
  rent_max: number;
  shared_lot: string;
  office_required: boolean;
  weights: Record<string, number>;
}

interface Report {
  schema_version: string;
  run_id: string;
  run_date: string;
  offline: boolean;
  providers: Record<string, string | boolean | number | null>;
  sites: Site[];
  evidence: Evidence[];
  external_calls: unknown[];
  business: Business;
  exceptions: string[];
  sending_paused: boolean;
  pause_reason: string | null;
  sources: SourceRow[];
  fixture_layers: string[];
}

interface Message {
  message_id: string;
  site_id: string;
  listing_id: string | null;
  case_type: string;
  to: string;
  subject: string;
  body: string;
  sent_at: string;
  template_id: string | null;
}

interface RunInfo {
  run_id: string;
  run_date: string;
  started_at: string | null;
  finished_at: string | null;
  counts: Record<string, number>;
  errors: unknown[];
  warnings: unknown[];
  stages: Record<string, unknown>;
  providers: Record<string, unknown>;
  paid_calls: unknown[];
  external_calls: unknown[];
  sending_paused: boolean;
  pause_reason: string | null;
  mode: string | null;
}

interface DsConfig {
  supabaseUrl?: string;
  supabaseAnonKey?: string;
  pmtilesUrl?: string;
}

declare global {
  interface Window {
    DS_CONFIG?: DsConfig;
    // Provided by the lazily loaded CDN scripts; typed loosely on purpose
    // because the dashboard has no npm runtime dependencies.
    maplibregl?: any;
    pmtiles?: any;
  }
}

interface AppState {
  report: Report;
  messages: Message[];
  run: RunInfo | null;
  sourceLabel: string;
  sourceWarning: string | null;
  evidenceById: Map<string, Evidence>;
}

// ---------------------------------------------------------------------------
// Tiny DOM helpers
// ---------------------------------------------------------------------------

type Child = Node | string | number | boolean | null | undefined | Child[];
type Attrs = Record<string, string | number | boolean | null | undefined> | null;

function append(parent: Node, children: Child[]): void {
  for (const c of children) {
    if (c === null || c === undefined || c === false || c === true) continue;
    if (Array.isArray(c)) append(parent, c);
    else if (c instanceof Node) parent.appendChild(c);
    else parent.appendChild(document.createTextNode(String(c)));
  }
}

function h<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  attrs: Attrs = null,
  ...children: Child[]
): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  if (attrs) {
    for (const [k, v] of Object.entries(attrs)) {
      if (v === null || v === undefined || v === false) continue;
      if (k === "class") el.className = String(v);
      else if (v === true) el.setAttribute(k, "");
      else el.setAttribute(k, String(v));
    }
  }
  append(el, children);
  return el;
}

const SVG_NS = "http://www.w3.org/2000/svg";

function svg(tag: string, attrs: Record<string, string | number> = {}, ...children: Child[]): SVGElement {
  const el = document.createElementNS(SVG_NS, tag);
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, String(v));
  append(el, children);
  return el;
}

function tr(cells: Child[], attrs: Attrs = null): HTMLTableRowElement {
  const row = h("tr", attrs);
  for (const c of cells) row.appendChild(h("td", null, c));
  return row;
}

function table(headers: string[], rows: HTMLTableRowElement[], opts: { wide?: boolean; compact?: boolean; empty?: string } = {}): HTMLElement {
  if (rows.length === 0) return h("p", { class: "muted small" }, opts.empty ?? "Nothing to show.");
  const classes = ["table-wrap", opts.wide ? "table-wide" : "", opts.compact ? "table-compact" : ""].filter(Boolean).join(" ");
  const thead = h("thead", null, h("tr", null, ...headers.map((t) => h("th", { scope: "col" }, t))));
  const tbody = h("tbody", null, ...rows);
  return h("div", { class: classes }, h("table", null, thead, tbody));
}

// ---------------------------------------------------------------------------
// Formatting
// ---------------------------------------------------------------------------

const DASH = "–";

function fmtNum(n: number | null | undefined, digits = 0): string {
  if (n === null || n === undefined || Number.isNaN(n)) return DASH;
  return n.toLocaleString(undefined, { maximumFractionDigits: digits, minimumFractionDigits: digits });
}

function fmtScore(n: number | null | undefined): string {
  return n === null || n === undefined ? DASH : n.toFixed(3);
}

function fmtMoney(n: number | null | undefined): string {
  return n === null || n === undefined ? DASH : `$${fmtNum(n)}`;
}

function fmtPct(n: number | null | undefined): string {
  return n === null || n === undefined ? DASH : `${Math.round(n * 100)}%`;
}

function fmtDate(iso: string | null | undefined): string {
  if (!iso) return DASH;
  const ms = Date.parse(iso);
  if (Number.isNaN(ms)) return iso;
  return new Date(ms).toISOString().slice(0, 10);
}

function fmtDateTime(iso: string | null | undefined): string {
  if (!iso) return DASH;
  const ms = Date.parse(iso);
  if (Number.isNaN(ms)) return iso;
  return new Date(ms).toISOString().replace("T", " ").slice(0, 16) + "Z";
}

function isHttp(url: string | null | undefined): url is string {
  return typeof url === "string" && /^https?:\/\//i.test(url);
}

function titleCase(s: string): string {
  return s.replace(/[_-]+/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}

/** Compact, human readable rendering of an evidence value (object or primitive). */
function summarizeValue(v: unknown): string {
  if (v === null || v === undefined) return DASH;
  if (typeof v !== "object") return String(v);
  if (Array.isArray(v)) return v.length ? JSON.stringify(v).slice(0, 140) : "[]";
  const parts: string[] = [];
  for (const [k, x] of Object.entries(v as Record<string, unknown>)) {
    if (x === null || x === undefined) continue;
    if (typeof x === "object") continue;
    parts.push(`${k}: ${String(x)}`);
  }
  if (parts.length) return parts.join(", ");
  const json = JSON.stringify(v);
  return json.length > 140 ? json.slice(0, 137) + "..." : json;
}

function stringifyUnknown(v: unknown): string {
  if (typeof v === "string") return v;
  try {
    return JSON.stringify(v);
  } catch {
    return String(v);
  }
}

// ---------------------------------------------------------------------------
// Data loading
// ---------------------------------------------------------------------------

async function fetchJson<T>(url: string): Promise<T | null> {
  try {
    const res = await fetch(url, { cache: "no-store" });
    if (!res.ok) return null;
    return (await res.json()) as T;
  } catch {
    return null;
  }
}

interface Loaded {
  report: Report;
  messages: Message[];
  run: RunInfo | null;
  sourceLabel: string;
  sourceWarning: string | null;
}

async function loadFromSupabase(url: string, key: string): Promise<Loaded> {
  const headers = { apikey: key, Authorization: `Bearer ${key}`, Accept: "application/json" };
  const res = await fetch(`${url}/rest/v1/reports?select=payload,messages,created_at&order=created_at.desc&limit=1`, { headers });
  if (!res.ok) throw new Error(`reports query returned HTTP ${res.status}`);
  const rows = (await res.json()) as Array<{ payload: Report; messages: Message[] | null; created_at: string }>;
  const row = rows[0];
  if (!row || !row.payload || !Array.isArray(row.payload.sites)) throw new Error("reports table returned no usable row");

  let run: RunInfo | null = null;
  try {
    const r2 = await fetch(`${url}/rest/v1/runs?select=*&order=started_at.desc&limit=1`, { headers });
    if (r2.ok) {
      const runs = (await r2.json()) as RunInfo[];
      run = runs[0] ?? null;
    }
  } catch {
    run = null; // runs table is optional
  }

  return {
    report: row.payload,
    messages: Array.isArray(row.messages) ? row.messages : [],
    run,
    sourceLabel: new URL(url).host,
    sourceWarning: null,
  };
}

async function loadFromFixtures(warning: string | null): Promise<Loaded> {
  const report = await fetchJson<Report>("./data/report.json");
  if (!report || !Array.isArray(report.sites)) {
    throw new Error("Could not load ./data/report.json. Run `node scripts/build-dashboard.mjs` to generate dashboard/public/data/.");
  }
  const messages = (await fetchJson<Message[]>("./data/messages.json")) ?? [];
  const run = await fetchJson<RunInfo>("./data/run.json");
  return { report, messages: Array.isArray(messages) ? messages : [], run, sourceLabel: "fixture data", sourceWarning: warning };
}

async function loadData(): Promise<Loaded> {
  const cfg: DsConfig = window.DS_CONFIG ?? {};
  const url = (cfg.supabaseUrl ?? "").trim().replace(/\/+$/, "");
  const key = (cfg.supabaseAnonKey ?? "").trim();
  if (url && key) {
    try {
      return await loadFromSupabase(url, key);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return loadFromFixtures(`Supabase load failed (${msg}); showing bundled fixture data instead.`);
    }
  }
  return loadFromFixtures(null);
}

// ---------------------------------------------------------------------------
// Shared render pieces
// ---------------------------------------------------------------------------

const GATE_KEYS = ["zoning", "rent", "flood"] as const;
type GateKey = (typeof GATE_KEYS)[number];

function gateChip(key: GateKey, gate: Gate, withDetail = false): HTMLElement {
  const status: GateStatus = gate.status === "pass" || gate.status === "fail" ? gate.status : "pending";
  const chip = h("span", { class: `gate gate-${status}`, title: gate.detail ?? "" }, `${key}: ${status}`);
  if (!withDetail) return chip;
  return h("span", null, chip, gate.detail ? h("span", { class: "gate-detail" }, " ", gate.detail) : null, gate.warning ? h("span", { class: "gate-detail" }, " (warning: ", gate.warning, ")") : null);
}

function gateStrip(site: Site, withDetail = false): HTMLElement {
  return h("ul", { class: "gates", "aria-label": "Gate status" }, ...GATE_KEYS.map((k) => h("li", null, gateChip(k, site.gates[k], withDetail))));
}

function gateCell(gate: Gate | undefined): HTMLElement {
  if (!gate) return h("span", { class: "muted" }, DASH);
  const status: GateStatus = gate.status === "pass" || gate.status === "fail" ? gate.status : "pending";
  return h("span", { class: `gate gate-${status}`, title: gate.detail ?? "" }, status);
}

function statusBadge(status: string): HTMLElement {
  const norm = status.toLowerCase().replace(/[^a-z_]/g, "_");
  return h("span", { class: `badge status-${norm}` }, status.replace(/_/g, " "));
}

function yesNo(v: boolean | null | undefined): string {
  return v === null || v === undefined ? DASH : v ? "yes" : "no";
}

function viewHeader(title: string, ...extra: Child[]): HTMLElement {
  return h("div", { class: "view-header" }, h("h1", null, title), ...extra);
}

// ---------------------------------------------------------------------------
// Shortlist view
// ---------------------------------------------------------------------------

function siteEvidence(site: Site, state: AppState): HTMLElement {
  const ids: string[] = [];
  for (const k of GATE_KEYS) {
    for (const id of site.gates[k]?.evidence_ids ?? []) if (!ids.includes(id)) ids.push(id);
  }
  if (ids.length === 0) return h("p", { class: "muted small" }, "No gate evidence recorded.");

  const items = ids.map((id) => {
    const ev = state.evidenceById.get(id);
    if (!ev) return h("li", null, h("span", { class: "mono" }, id), " ", h("span", { class: "muted" }, "(evidence not found in report)"));
    const source: Child = isHttp(ev.source_url)
      ? h("a", { href: ev.source_url, target: "_blank", rel: "noopener noreferrer" }, ev.source_url)
      : h("span", { class: "mono" }, ev.source_url ?? DASH);
    return h(
      "li",
      { class: ev.expired ? "stale-text" : null },
      h("div", null, h("span", { class: "fact" }, titleCase(ev.fact)), " ", h("span", null, summarizeValue(ev.value)), ev.expired ? h("span", { class: "expired" }, " EXPIRED") : null),
      h("div", { class: "meta" }, "Source: ", source),
      h("div", { class: "meta" }, `Method: ${ev.method ?? DASH} · fetched ${fmtDate(ev.fetched_at)} · expires ${fmtDate(ev.expires_at)} · `, h("span", { class: "mono" }, ev.evidence_id)),
    );
  });
  return h("ul", { class: "evidence" }, ...items);
}

function scoreBreakdown(site: Site): HTMLElement {
  const rows = site.factors.map((f) =>
    tr([
      titleCase(f.factor),
      h("span", { class: "muted small" }, f.detail ?? DASH),
      h("span", { class: "num" }, f.raw === null ? DASH : fmtNum(f.raw, Number.isInteger(f.raw) ? 0 : 3)),
      fmtScore(f.normalized),
      fmtScore(f.weight),
      fmtScore(f.weighted),
    ]),
  );
  const total = site.factors.reduce((acc, f) => acc + (f.weighted ?? 0), 0);
  const wrap = table(["Factor", "Detail", "Raw", "Normalized", "Weight", "Weighted"], rows, { compact: true, empty: "No score factors." });
  const tbl = wrap.querySelector("table");
  if (tbl && rows.length) {
    tbl.appendChild(h("tfoot", null, h("tr", null, h("td", { colspan: 5 }, "Total"), h("td", null, fmtScore(total)))));
  }
  return wrap;
}

function requirementsList(site: Site): HTMLElement {
  if (!site.requirements.length) return h("p", { class: "muted small" }, "No requirement checks recorded.");
  return h(
    "ul",
    { class: "plain small" },
    ...site.requirements.map((r) => {
      const cls = r.outcome === "met" ? "gate gate-pass" : r.outcome === "unmet" || r.outcome === "failed" ? "gate gate-fail" : "gate gate-pending";
      return h("li", null, h("span", { class: cls }, r.outcome), " ", titleCase(r.name), r.detail ? h("span", { class: "muted" }, ` - ${r.detail}`) : null);
    }),
  );
}

function siteImages(site: Site): HTMLElement {
  const imgs = (site.images ?? []).filter((i) => isHttp(i.url));
  if (!imgs.length) return h("p", { class: "muted small" }, "No imagery available for this site.");
  return h(
    "div",
    { class: "images" },
    ...imgs.map((i) =>
      h("figure", null, h("img", { src: i.url, alt: `${i.kind ?? "site"} image of ${site.address}`, loading: "lazy" }), h("figcaption", null, i.kind ?? "image")),
    ),
  );
}

function metricsBlock(site: Site): HTMLElement {
  const m = site.metrics ?? {};
  const cell = (label: string, value: string) => h("div", null, h("dt", null, label), h("dd", null, value));
  return h(
    "dl",
    { class: "metrics" },
    cell("AADT", fmtNum(m.aadt)),
    cell("Visibility", fmtPct(m.visibility)),
    cell("Drive", m.drive_minutes === null || m.drive_minutes === undefined ? DASH : `${fmtNum(m.drive_minutes)} min`),
    cell("Rent", m.rent_monthly === null || m.rent_monthly === undefined ? DASH : `${fmtMoney(m.rent_monthly)}/mo`),
    cell("Competitors", fmtNum(m.competitors)),
  );
}

function siteCard(site: Site, state: AppState): HTMLElement {
  const flags = h(
    "div",
    { class: "flags" },
    site.shared_lot ? h("span", { class: "badge flag-shared", title: "Lot is shared with another tenant" }, "SHARED LOT") : null,
    ...(site.flags ?? []).map((f) => h("span", { class: "badge flag" }, f)),
    site.jurisdiction ? h("span", { class: "badge badge-outline" }, site.jurisdiction) : null,
    h("span", { class: "badge badge-outline mono" }, site.parcel_id),
  );

  return h(
    "article",
    { class: "card", id: `site-${site.site_id}` },
    h(
      "div",
      { class: "card-head" },
      h("span", { class: "rank", "aria-label": `Rank ${site.rank ?? "unranked"}` }, site.rank === null ? DASH : `#${site.rank}`),
      h("h3", null, site.address),
      h("div", null, h("div", { class: "score-label" }, "Score"), h("div", { class: "score" }, fmtScore(site.score))),
    ),
    gateStrip(site, true),
    flags,
    metricsBlock(site),
    h(
      "div",
      { class: "card-grid" },
      h("section", null, h("h4", null, "Score breakdown"), scoreBreakdown(site), h("h4", null, "Requirements"), requirementsList(site)),
      h("section", null, h("h4", null, "Evidence"), siteEvidence(site, state)),
    ),
    h("section", null, h("h4", null, "Imagery"), siteImages(site)),
  );
}

function whyNotViable(site: Site): string {
  const reasons: string[] = [];
  for (const k of GATE_KEYS) {
    const g = site.gates[k];
    if (!g) continue;
    if (g.status === "fail") reasons.push(`${k} failed${g.detail ? `: ${g.detail}` : ""}`);
    else if (g.status === "pending") reasons.push(`${k} pending${g.detail ? `: ${g.detail}` : ""}`);
  }
  for (const r of site.requirements ?? []) {
    if (r.outcome !== "met") reasons.push(`${titleCase(r.name)} ${r.outcome}${r.detail ? `: ${r.detail}` : ""}`);
  }
  for (const c of site.open_cases ?? []) reasons.push(`open ${c.case_type} case (${c.status.replace(/_/g, " ")})`);
  for (const f of site.flags ?? []) if (!reasons.some((r) => r.includes(f))) reasons.push(f);
  return reasons.length ? reasons.join("; ") : "not viable (no reason recorded)";
}

function notViableTable(sites: Site[]): HTMLElement {
  const rows = sites.map((s) =>
    tr([
      h("span", { class: "mono" }, s.parcel_id),
      s.address,
      gateCell(s.gates.zoning),
      gateCell(s.gates.rent),
      gateCell(s.gates.flood),
      h("span", { class: "num" }, fmtScore(s.score)),
      h("span", { class: "small" }, whyNotViable(s)),
    ]),
  );
  return table(["Parcel", "Address", "Zoning", "Rent", "Flood", "Score", "Why"], rows, { wide: true, compact: true, empty: "Every in-area site is viable." });
}

function renderShortlist(state: AppState): HTMLElement {
  const { report } = state;
  const viable = report.sites.filter((s) => s.viable).sort((a, b) => (a.rank ?? 1e9) - (b.rank ?? 1e9));
  const notViable = report.sites.filter((s) => !s.viable && s.in_search_area);
  const outOfArea = report.sites.filter((s) => !s.in_search_area).length;

  const mapBox = h("div", { class: "map", id: "map", role: "img", "aria-label": "Map of candidate sites" });
  const mapNote = h("p", { class: "map-note" });
  const legend = h(
    "div",
    { class: "map-legend" },
    h("span", null, h("span", { class: "dot", style: "background: var(--accent)" }), "viable (labelled by rank)"),
    h("span", null, h("span", { class: "dot", style: "background: var(--stale)" }), "not viable / pending (labelled by parcel)"),
  );

  const root = h(
    "div",
    null,
    viewHeader("Shortlist", h("span", { class: "muted" }, `${viable.length} viable of ${report.sites.length} sites`)),
    h("section", { class: "map-section" }, mapBox, legend, mapNote),
    h("h2", null, "Viable sites"),
    viable.length ? h("div", { class: "cards" }, ...viable.map((s) => siteCard(s, state))) : h("p", { class: "muted" }, "No viable sites in this run."),
    h("h2", null, "Not viable / pending"),
    h("p", { class: "muted small" }, `${notViable.length} in-area site(s) did not pass every gate.`, outOfArea ? ` ${outOfArea} out-of-area site(s) are listed under Pipeline.` : ""),
    notViableTable(notViable),
  );

  // The map needs a connected container; mount it once this view is in the DOM.
  requestAnimationFrame(() => {
    if (mapBox.isConnected) void mountMap(mapBox, mapNote, report.sites);
  });
  return root;
}

// ---------------------------------------------------------------------------
// Map: MapLibre + self-hosted PMTiles when configured, SVG scatter otherwise.
// ---------------------------------------------------------------------------

function loadScript(src: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const s = document.createElement("script");
    s.src = src;
    s.async = true;
    s.onload = () => resolve();
    s.onerror = () => reject(new Error(`failed to load ${src}`));
    document.head.appendChild(s);
  });
}

function loadStylesheet(href: string): void {
  if (document.querySelector(`link[href="${href}"]`)) return;
  const l = document.createElement("link");
  l.rel = "stylesheet";
  l.href = href;
  document.head.appendChild(l);
}

function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
    p.then(
      (v) => {
        clearTimeout(t);
        resolve(v);
      },
      (e) => {
        clearTimeout(t);
        reject(e);
      },
    );
  });
}

const MAPLIBRE_JS = "https://unpkg.com/maplibre-gl@4/dist/maplibre-gl.js";
const MAPLIBRE_CSS = "https://unpkg.com/maplibre-gl@4/dist/maplibre-gl.css";
const PMTILES_JS = "https://unpkg.com/pmtiles@3/dist/pmtiles.js";

async function mountMap(container: HTMLElement, note: HTMLElement, sites: Site[]): Promise<void> {
  const located = sites.filter((s) => typeof s.lat === "number" && typeof s.lon === "number" && !Number.isNaN(s.lat) && !Number.isNaN(s.lon));
  const pmtilesUrl = (window.DS_CONFIG?.pmtilesUrl ?? "").trim();

  if (!pmtilesUrl) {
    renderSvgMap(container, located);
    note.textContent = "Schematic plot of site coordinates (no basemap). Set PMTILES_URL to a self-hosted Protomaps archive for a basemap.";
    return;
  }

  // Show the dependency-free plot straight away; upgrade to MapLibre only if the
  // CDN scripts actually arrive. A hanging or blocked CDN never leaves an empty box.
  renderSvgMap(container, located);
  note.textContent = "Loading basemap… (schematic plot shown meanwhile)";
  try {
    loadStylesheet(MAPLIBRE_CSS);
    if (!window.maplibregl) await withTimeout(loadScript(MAPLIBRE_JS), 10000, "MapLibre");
    if (!window.pmtiles) await withTimeout(loadScript(PMTILES_JS), 10000, "pmtiles");
    if (!window.maplibregl || !window.pmtiles) throw new Error("map libraries did not initialise");
    if (!container.isConnected) return; // user navigated away while loading
    renderMapLibre(container, located, pmtilesUrl, note);
    note.textContent = `Basemap: self-hosted PMTiles (${safeHost(pmtilesUrl)}).`;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (!container.isConnected) return;
    if (!container.querySelector("svg")) renderSvgMap(container, located);
    note.textContent = `Basemap unavailable (${msg}); showing schematic plot. Set PMTILES_URL for a basemap.`;
  }
}

function safeHost(url: string): string {
  try {
    return new URL(url, location.href).host || url;
  } catch {
    return url;
  }
}

function renderMapLibre(container: HTMLElement, sites: Site[], pmtilesUrl: string, note: HTMLElement): void {
  const maplibregl = window.maplibregl;
  const pmtiles = window.pmtiles;
  container.replaceChildren();

  // Register the pmtiles:// protocol once.
  if (!(window as unknown as { __dsPmtilesRegistered?: boolean }).__dsPmtilesRegistered) {
    const protocol = new pmtiles.Protocol();
    maplibregl.addProtocol("pmtiles", protocol.tile);
    (window as unknown as { __dsPmtilesRegistered?: boolean }).__dsPmtilesRegistered = true;
  }

  const dark = window.matchMedia("(prefers-color-scheme: dark)").matches;
  const palette = dark
    ? { bg: "#1b1b1b", earth: "#232323", landuse: "#262a24", water: "#1f3442", roads: "#4a4a4a", buildings: "#2e2e2e", boundary: "#666" }
    : { bg: "#e8e4dc", earth: "#f4f1ea", landuse: "#e6e9dc", water: "#b8d3e6", roads: "#ffffff", buildings: "#d9d4ca", boundary: "#9c9c9c" };

  const style = {
    version: 8,
    sources: {
      protomaps: { type: "vector", url: `pmtiles://${pmtilesUrl}`, attribution: "© OpenStreetMap contributors · Protomaps" },
    },
    layers: [
      { id: "bg", type: "background", paint: { "background-color": palette.bg } },
      { id: "earth", type: "fill", source: "protomaps", "source-layer": "earth", paint: { "fill-color": palette.earth } },
      { id: "landuse", type: "fill", source: "protomaps", "source-layer": "landuse", paint: { "fill-color": palette.landuse, "fill-opacity": 0.6 } },
      { id: "water", type: "fill", source: "protomaps", "source-layer": "water", paint: { "fill-color": palette.water } },
      { id: "roads", type: "line", source: "protomaps", "source-layer": "roads", paint: { "line-color": palette.roads, "line-width": 1 } },
      { id: "buildings", type: "fill", source: "protomaps", "source-layer": "buildings", minzoom: 13, paint: { "fill-color": palette.buildings } },
      { id: "boundaries", type: "line", source: "protomaps", "source-layer": "boundaries", paint: { "line-color": palette.boundary, "line-dasharray": [2, 2] } },
    ],
  };

  const first = sites[0];
  const map = new maplibregl.Map({
    container,
    style,
    center: first ? [first.lon as number, first.lat as number] : [-77.37, 35.6],
    zoom: 9,
    attributionControl: { compact: true },
  });
  map.addControl(new maplibregl.NavigationControl({ showCompass: false }), "top-right");

  // Tile/archive failures (bad PMTILES_URL, offline) are reported once in the note;
  // the site markers stay usable on the blank canvas either way.
  let reported = false;
  map.on("error", (ev: { error?: { message?: string } }) => {
    if (reported) return;
    reported = true;
    const why = ev?.error?.message ? ` (${ev.error.message})` : "";
    note.textContent = `Basemap tiles failed to load from ${safeHost(pmtilesUrl)}${why}. Check PMTILES_URL; site markers are still shown.`;
  });

  if (sites.length) {
    const bounds = new maplibregl.LngLatBounds();
    for (const s of sites) {
      const el = h("div", { class: `site-marker ${s.viable ? "" : "other"}`, title: s.address }, s.viable && s.rank !== null ? `#${s.rank}` : "•");
      const popup = new maplibregl.Popup({ offset: 16 }).setText(`${s.viable && s.rank !== null ? `#${s.rank} ` : ""}${s.address} (${s.parcel_id})${s.score !== null ? ` - score ${fmtScore(s.score)}` : ""}`);
      new maplibregl.Marker({ element: el }).setLngLat([s.lon as number, s.lat as number]).setPopup(popup).addTo(map);
      bounds.extend([s.lon as number, s.lat as number]);
    }
    map.fitBounds(bounds, { padding: 48, maxZoom: 12, duration: 0 });
  }
}

/** Dependency-free fallback: equirectangular scatter of the sites inside an inline SVG. */
function renderSvgMap(container: HTMLElement, sites: Site[]): void {
  container.replaceChildren();
  const W = 800;
  const H = 400;
  const PAD = 40;

  if (!sites.length) {
    container.appendChild(h("p", { class: "muted", style: "padding:1rem" }, "No site coordinates to plot."));
    return;
  }

  const lats = sites.map((s) => s.lat as number);
  const lons = sites.map((s) => s.lon as number);
  const minLat = Math.min(...lats);
  const maxLat = Math.max(...lats);
  const minLon = Math.min(...lons);
  const maxLon = Math.max(...lons);
  const midLat = (minLat + maxLat) / 2;
  const kx = Math.cos((midLat * Math.PI) / 180); // shrink longitude so distances look right

  // Preserve aspect ratio: choose a single scale for both axes.
  const spanX = Math.max((maxLon - minLon) * kx, 1e-6);
  const spanY = Math.max(maxLat - minLat, 1e-6);
  const scale = Math.min((W - 2 * PAD) / spanX, (H - 2 * PAD) / spanY);
  const offX = (W - spanX * scale) / 2;
  const offY = (H - spanY * scale) / 2;
  const px = (lon: number) => offX + (lon - minLon) * kx * scale;
  const py = (lat: number) => offY + (maxLat - lat) * scale;

  const root = svg("svg", { viewBox: `0 0 ${W} ${H}`, role: "img", "aria-label": "Schematic map of candidate sites" });
  root.appendChild(svg("title", {}, "Candidate sites (schematic; no basemap configured)"));

  // Light graticule for orientation.
  const grid = svg("g", { stroke: "currentColor", "stroke-opacity": 0.12, "stroke-width": 1 });
  for (let i = 1; i < 8; i++) {
    grid.appendChild(svg("line", { x1: (W / 8) * i, y1: 0, x2: (W / 8) * i, y2: H }));
  }
  for (let i = 1; i < 4; i++) {
    grid.appendChild(svg("line", { x1: 0, y1: (H / 4) * i, x2: W, y2: (H / 4) * i }));
  }
  root.appendChild(grid);

  // Corner coordinates.
  const corner = (x: number, y: number, text: string, anchor: string) =>
    svg("text", { x, y, "text-anchor": anchor, "font-size": 11, fill: "currentColor", "fill-opacity": 0.55 }, text);
  root.appendChild(corner(6, 14, `${maxLat.toFixed(3)}N ${Math.abs(minLon).toFixed(3)}${minLon < 0 ? "W" : "E"}`, "start"));
  root.appendChild(corner(W - 6, H - 8, `${minLat.toFixed(3)}N ${Math.abs(maxLon).toFixed(3)}${maxLon < 0 ? "W" : "E"}`, "end"));

  // Draw non-viable first so viable markers sit on top.
  const ordered = [...sites].sort((a, b) => Number(a.viable) - Number(b.viable));
  for (const s of ordered) {
    const x = px(s.lon as number);
    const y = py(s.lat as number);
    const color = s.viable ? "var(--accent)" : "var(--stale)";
    const label = s.viable && s.rank !== null ? `#${s.rank}` : s.parcel_id;
    const g = svg("g", { class: s.viable ? "site viable" : "site other" });
    g.appendChild(svg("title", {}, `${label} ${s.address}${s.score !== null ? ` (score ${fmtScore(s.score)})` : ""}`));
    g.appendChild(svg("circle", { cx: x, cy: y, r: s.viable ? 9 : 6, fill: color, stroke: "var(--surface)", "stroke-width": 2 }));
    g.appendChild(
      svg(
        "text",
        { x: x + (s.viable ? 13 : 10), y: y + 4, "font-size": s.viable ? 13 : 11, "font-weight": s.viable ? 700 : 400, fill: "currentColor" },
        label,
      ),
    );
    root.appendChild(g);
  }
  container.appendChild(root);
}

// ---------------------------------------------------------------------------
// Pipeline view
// ---------------------------------------------------------------------------

const STAGE_ORDER = ["discovered", "resolved", "enriched", "verifying", "verified", "scored", "reported", "out_of_area", "excluded", "rejected"];

function stageRank(stage: string): number {
  const i = STAGE_ORDER.indexOf(stage);
  return i === -1 ? STAGE_ORDER.length : i;
}

function caseAgeDays(runDate: string, siteId: string, caseType: string, messages: Message[]): number | null {
  const sent = messages
    .filter((m) => m.site_id === siteId && m.case_type === caseType)
    .map((m) => Date.parse(m.sent_at))
    .filter((n) => !Number.isNaN(n));
  if (!sent.length) return null;
  const runMs = Date.parse(`${runDate}T00:00:00Z`);
  if (Number.isNaN(runMs)) return null;
  const earliest = Math.min(...sent);
  return Math.max(0, Math.floor((runMs - earliest) / 86400000));
}

function nextAction(status: string): string {
  switch (status) {
    case "open":
      return "send inquiry";
    case "awaiting_reply":
      return "await reply / follow up";
    case "escalated":
      return "human action required";
    case "resolved":
    case "closed":
      return "none";
    default:
      return "review";
  }
}

function renderPipeline(state: AppState): HTMLElement {
  const { report, messages } = state;
  const byStage = new Map<string, Site[]>();
  for (const s of report.sites) {
    const list = byStage.get(s.stage) ?? [];
    list.push(s);
    byStage.set(s.stage, list);
  }
  const stages = [...byStage.keys()].sort((a, b) => stageRank(a) - stageRank(b) || a.localeCompare(b));

  const stageSections = stages.map((stage) => {
    const sites = (byStage.get(stage) ?? []).slice().sort((a, b) => (a.rank ?? 1e9) - (b.rank ?? 1e9) || (b.score ?? -1) - (a.score ?? -1));
    const rows = sites.map((s) =>
      tr(
        [
          h("span", { class: "mono" }, s.parcel_id),
          s.address,
          yesNo(s.in_search_area),
          h("span", { class: "num" }, s.drive_minutes === null ? DASH : fmtNum(s.drive_minutes)),
          gateCell(s.gates.zoning),
          gateCell(s.gates.rent),
          gateCell(s.gates.flood),
          s.viable ? h("span", { class: "badge badge-pass" }, `viable #${s.rank ?? "?"}`) : h("span", { class: "muted" }, "no"),
          fmtScore(s.score),
          h("span", { class: "small" }, s.open_cases?.length ? s.open_cases.map((c) => `${c.case_type} (${c.status.replace(/_/g, " ")})`).join(", ") : DASH),
        ],
        { class: s.in_search_area ? null : "row-dim" },
      ),
    );
    return h(
      "section",
      null,
      h("h2", null, `${titleCase(stage)} `, h("span", { class: "muted small" }, `(${sites.length})`)),
      table(["Parcel", "Address", "In area", "Drive (min)", "Zoning", "Rent", "Flood", "Viable", "Score", "Open cases"], rows, { wide: true, compact: true }),
    );
  });

  const caseRows: HTMLTableRowElement[] = [];
  for (const s of report.sites) {
    for (const c of s.open_cases ?? []) {
      const age = caseAgeDays(report.run_date, s.site_id, c.case_type, messages);
      const sent = messages.filter((m) => m.site_id === s.site_id && m.case_type === c.case_type).length;
      caseRows.push(
        tr([
          titleCase(c.case_type),
          statusBadge(c.status),
          c.recipient ? h("span", { class: "mono" }, c.recipient) : DASH,
          h("span", null, s.address, " ", h("span", { class: "muted mono small" }, s.parcel_id)),
          age === null ? DASH : `${age} day${age === 1 ? "" : "s"}`,
          sent ? `${sent}` : DASH,
          nextAction(c.status),
        ]),
      );
    }
  }

  return h(
    "div",
    null,
    viewHeader("Pipeline", h("span", { class: "muted" }, `${report.sites.length} sites across ${stages.length} stage(s)`)),
    ...stageSections,
    h("h2", null, "Open cases ", h("span", { class: "muted small" }, `(${caseRows.length})`)),
    h("p", { class: "muted small" }, "Age is run date minus the first outbound message for that site and case type; – means no message was recorded."),
    table(["Case type", "Status", "Recipient", "Site", "Age", "Messages", "Next action"], caseRows, { wide: true, compact: true, empty: "No open cases." }),
  );
}

// ---------------------------------------------------------------------------
// Exceptions view
// ---------------------------------------------------------------------------

const EXCLUDED_TERMS = new Set(["prohibited", "disallowed", "unclear", "unknown_prohibited"]);

function sourceExcluded(s: SourceRow): boolean {
  const terms = (s.terms_status ?? "").toLowerCase();
  const robots = (s.robots_txt ?? "").toLowerCase();
  return EXCLUDED_TERMS.has(terms) || robots === "disallowed";
}

function sourceFailed(s: SourceRow): boolean {
  const st = (s.last_status ?? "").toLowerCase();
  return Boolean(s.last_error) || (st !== "" && st !== "ok" && st !== "success");
}

function renderUnknownList(items: unknown[]): HTMLElement {
  if (!items.length) return h("p", { class: "muted small" }, "None.");
  return h("ul", { class: "plain" }, ...items.map((x) => h("li", { class: "mono" }, stringifyUnknown(x))));
}

function renderExceptions(state: AppState): HTMLElement {
  const { report, run } = state;
  const paused = report.sending_paused || Boolean(run?.sending_paused);
  const pauseReason = report.pause_reason ?? run?.pause_reason ?? null;

  const banner = paused
    ? h("div", { class: "banner banner-paused", role: "alert" }, h("span", { class: "badge badge-paused" }, "SENDING PAUSED"), " ", pauseReason ?? "No reason recorded.")
    : h("div", { class: "banner banner-ok" }, h("span", { class: "badge badge-pass" }, "sending active"), " Outbound messaging is not paused.");

  const sourceRows = report.sources.map((s) => {
    const excluded = sourceExcluded(s);
    const failed = sourceFailed(s);
    return tr(
      [
        h("span", { class: "mono" }, s.id),
        s.kind,
        yesNo(s.enabled),
        h("span", null, s.terms_status ?? DASH, excluded ? h("span", null, " ", h("span", { class: "badge badge-fail" }, "excluded")) : null),
        s.robots_txt ?? DASH,
        h("span", null, s.last_status ?? DASH, failed ? h("span", null, " ", h("span", { class: "badge badge-pending" }, "failure")) : null),
        s.last_error ?? DASH,
        h("span", { class: "small" }, s.notes ?? DASH),
      ],
      { class: excluded ? "row-excluded" : failed ? "row-failed" : null },
    );
  });

  const expired = report.evidence.filter((e) => e.expired);
  const siteById = new Map(report.sites.map((s) => [s.site_id, s] as const));
  const expiredRows = expired.map((e) =>
    tr([
      h("span", { class: "mono" }, e.evidence_id),
      siteById.get(e.site_id)?.address ?? e.site_id,
      titleCase(e.fact),
      summarizeValue(e.value),
      isHttp(e.source_url) ? h("a", { href: e.source_url, target: "_blank", rel: "noopener noreferrer" }, e.source_url) : h("span", { class: "mono" }, e.source_url ?? DASH),
      fmtDate(e.fetched_at),
      h("span", { class: "expired" }, fmtDate(e.expires_at)),
    ]),
  );

  const excludedCount = report.sources.filter(sourceExcluded).length;
  const failedCount = report.sources.filter(sourceFailed).length;

  return h(
    "div",
    null,
    viewHeader("Exceptions"),
    banner,
    h("h2", null, "Reported exceptions ", h("span", { class: "muted small" }, `(${report.exceptions.length})`)),
    report.exceptions.length ? h("ul", { class: "plain" }, ...report.exceptions.map((x) => h("li", null, x))) : h("p", { class: "muted small" }, "No exceptions reported."),
    h("h2", null, "Sources ", h("span", { class: "muted small" }, `(${report.sources.length}; ${excludedCount} excluded by terms, ${failedCount} with failures)`)),
    table(["Source", "Kind", "Enabled", "Terms", "robots.txt", "Last status", "Last error", "Notes"], sourceRows, { wide: true, compact: true, empty: "No sources registered." }),
    h("h2", null, "Expired evidence ", h("span", { class: "muted small" }, `(${expired.length} of ${report.evidence.length})`)),
    table(["Evidence", "Site", "Fact", "Value", "Source", "Fetched", "Expired"], expiredRows, { wide: true, compact: true, empty: "No expired evidence." }),
    h("h2", null, "Run errors ", h("span", { class: "muted small" }, run ? `(${run.errors?.length ?? 0})` : "")),
    run ? renderUnknownList(run.errors ?? []) : h("p", { class: "muted small" }, "run.json not loaded."),
    h("h2", null, "Run warnings ", h("span", { class: "muted small" }, run ? `(${run.warnings?.length ?? 0})` : "")),
    run ? renderUnknownList(run.warnings ?? []) : h("p", { class: "muted small" }, "run.json not loaded."),
  );
}

// ---------------------------------------------------------------------------
// Config view
// ---------------------------------------------------------------------------

function kvRows(obj: Record<string, unknown>, highlightKey?: string): HTMLTableRowElement[] {
  return Object.entries(obj).map(([k, v]) => {
    let val: Child;
    if (typeof v === "boolean") val = h("span", { class: `badge ${v ? "badge-accent" : "badge-stale"}` }, v ? "true" : "false");
    else if (v === null || v === undefined) val = h("span", { class: "muted" }, DASH);
    else if (typeof v === "object") val = h("span", { class: "mono" }, JSON.stringify(v));
    else val = String(v);
    return tr([h("span", { class: "mono" }, k), val], { class: k === highlightKey ? "row-highlight" : null });
  });
}

function flattenBusiness(b: Business): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(b)) {
    if (k === "weights" && v && typeof v === "object") {
      for (const [wk, wv] of Object.entries(v as Record<string, number>)) out[`weights.${wk}`] = wv;
    } else if (k === "rent_min" || k === "rent_max") {
      out[k] = typeof v === "number" ? `${fmtMoney(v)}/mo` : v;
    } else if (k === "max_drive_minutes") {
      out[k] = typeof v === "number" ? `${v} min` : v;
    } else {
      out[k] = v;
    }
  }
  return out;
}

function externalCallsTable(calls: unknown[]): HTMLElement {
  if (!calls.length) return h("p", { class: "muted small" }, "No external calls recorded (offline run).");
  const objects = calls.filter((c): c is Record<string, unknown> => typeof c === "object" && c !== null && !Array.isArray(c));
  if (objects.length !== calls.length) return renderUnknownList(calls);
  const keys: string[] = [];
  for (const o of objects) for (const k of Object.keys(o)) if (!keys.includes(k)) keys.push(k);
  const rows = objects.map((o) => tr(keys.map((k) => (o[k] === undefined || o[k] === null ? DASH : typeof o[k] === "object" ? JSON.stringify(o[k]) : String(o[k])))));
  return table(keys.map(titleCase), rows, { wide: true, compact: true });
}

function renderConfig(state: AppState): HTMLElement {
  const { report, run } = state;
  const paid = report.providers["paid_enabled"] === true;
  return h(
    "div",
    null,
    viewHeader("Config", h("span", { class: "muted" }, "read-only")),
    h(
      "div",
      { class: `banner ${paid ? "banner-warn" : "banner-ok"}` },
      h("span", { class: `badge ${paid ? "badge-pending" : "badge-pass"}` }, paid ? "PAID PROVIDERS ENABLED" : "paid providers disabled"),
      ` Run mode: ${report.offline ? "offline" : "online"}`,
      run?.mode ? ` (${run.mode})` : "",
      run ? ` · paid calls this run: ${run.paid_calls?.length ?? 0}` : "",
    ),
    h("h2", null, "Provider selection"),
    table(["Key", "Value"], kvRows(report.providers, "paid_enabled")),
    h("h2", null, "Business parameters"),
    table(["Parameter", "Value"], kvRows(flattenBusiness(report.business))),
    h("h2", null, "Fixture layers ", h("span", { class: "muted small" }, `(${report.fixture_layers?.length ?? 0})`)),
    report.fixture_layers?.length
      ? h("div", { class: "flags" }, ...report.fixture_layers.map((l) => h("span", { class: "badge badge-outline mono" }, l)))
      : h("p", { class: "muted small" }, "No fixture layers (live providers)."),
    h("h2", null, "External calls ", h("span", { class: "muted small" }, `(${report.external_calls?.length ?? 0})`)),
    externalCallsTable(report.external_calls ?? []),
    h("h2", null, "Report metadata"),
    table(
      ["Key", "Value"],
      kvRows({
        schema_version: report.schema_version,
        run_id: report.run_id,
        run_date: report.run_date,
        offline: report.offline,
        sites: report.sites.length,
        evidence: report.evidence.length,
        started_at: run?.started_at ?? null,
        finished_at: run?.finished_at ?? null,
      }),
    ),
  );
}

// ---------------------------------------------------------------------------
// Router & bootstrap
// ---------------------------------------------------------------------------

type ViewKey = "shortlist" | "pipeline" | "exceptions" | "config";

const VIEWS: Record<ViewKey, { title: string; render: (s: AppState) => HTMLElement }> = {
  shortlist: { title: "Shortlist", render: renderShortlist },
  pipeline: { title: "Pipeline", render: renderPipeline },
  exceptions: { title: "Exceptions", render: renderExceptions },
  config: { title: "Config", render: renderConfig },
};

function currentView(): ViewKey {
  const key = location.hash.replace(/^#\/?/, "").split(/[?/]/)[0] ?? "";
  return (Object.keys(VIEWS) as ViewKey[]).includes(key as ViewKey) ? (key as ViewKey) : "shortlist";
}

function setNavCurrent(view: ViewKey): void {
  document.querySelectorAll<HTMLAnchorElement>("#nav a[data-view]").forEach((a) => {
    if (a.dataset["view"] === view) a.setAttribute("aria-current", "page");
    else a.removeAttribute("aria-current");
  });
}

function renderRoute(state: AppState): void {
  const main = document.getElementById("view");
  if (!main) return;
  const view = currentView();
  setNavCurrent(view);
  document.title = `${VIEWS[view].title} · DealerSource`;
  try {
    main.replaceChildren(VIEWS[view].render(state));
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    main.replaceChildren(h("div", { class: "error-box" }, h("strong", null, "Failed to render view. "), msg));
    console.error(err);
  }
  window.scrollTo({ top: 0 });
}

function renderHeader(loaded: Loaded): void {
  const badge = document.getElementById("source-badge");
  const meta = document.getElementById("run-meta");
  if (badge) {
    badge.textContent = loaded.sourceLabel;
    badge.className = `badge ${loaded.sourceLabel === "fixture data" ? "badge-neutral" : "badge-accent"}`;
    badge.title = loaded.sourceWarning ?? (loaded.sourceLabel === "fixture data" ? "Loaded from ./data/*.json bundled at build time" : `Loaded from Supabase at ${loaded.sourceLabel}`);
  }
  if (meta) {
    meta.replaceChildren();
    append(meta, [
      h("span", null, "run ", fmtDate(loaded.report.run_date)),
      " · ",
      h("span", { class: "mono" }, loaded.report.run_id),
      loaded.report.offline ? h("span", null, " · offline") : null,
    ]);
  }
}

async function main(): Promise<void> {
  const mainEl = document.getElementById("view");
  try {
    const loaded = await loadData();
    const state: AppState = {
      ...loaded,
      evidenceById: new Map(loaded.report.evidence.map((e) => [e.evidence_id, e] as const)),
    };
    renderHeader(loaded);
    if (loaded.sourceWarning) console.warn(loaded.sourceWarning);
    renderRoute(state);
    window.addEventListener("hashchange", () => renderRoute(state));
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    const badge = document.getElementById("source-badge");
    if (badge) {
      badge.textContent = "no data";
      badge.className = "badge badge-fail";
    }
    if (mainEl) mainEl.replaceChildren(h("div", { class: "error-box" }, h("strong", null, "Could not load report data. "), msg));
    console.error(err);
  }
}

void main();
