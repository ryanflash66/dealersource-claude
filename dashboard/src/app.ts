/**
 * dealersource dashboard: the four views (Shortlist, Pipeline, Exceptions,
 * Config) plus the shared shell, rendered from report.json / messages.json /
 * run.json. Markup and class names follow the shared design template
 * (prompts/dashboard-design): tokens.css + dashboard.css are loaded unmodified
 * except --accent. Data comes from Supabase (latest `reports` row) when
 * config.js provides a URL and anon key, otherwise from ./data/*.json.
 */

// ------------------------------------------------------------------ types
type GateStatus = "pass" | "fail" | "pending";
interface Gate { status: GateStatus; evidence_ids: string[]; detail?: string; warning?: string | null }
interface Factor { factor: string; raw: number | null; normalized: number; weight: number; weighted: number; detail: string }
interface OpenCase {
  case_type: "rent" | "zoning" | "space";
  status: string;
  recipient: string;
  opened_at?: string;
  last_contacted_at?: string | null;
  followups_sent?: number;
  next_action?: string;
  next_action_at?: string | null;
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
  metrics: { aadt: number | null; visibility: number | null; drive_minutes: number | null; rent_monthly: number | null; competitors: number | null };
  open_cases: OpenCase[];
  stage?: string;
  jurisdiction?: string | null;
  flags?: string[];
  factors?: Factor[];
  requirements?: Array<{ name: string; outcome: string; detail: string }>;
  lat?: number;
  lon?: number;
  images?: Array<{ url: string; kind: string }>;
}
interface Evidence { evidence_id: string; site_id: string; fact: string; value: unknown; source_url: string; fetched_at: string; expires_at: string; method: string; expired?: boolean }
interface SourceRow { id: string; kind: string; enabled: boolean; terms_status: string; robots_txt: string; last_status: string | null; last_error: string | null; notes: string | null }
interface Report {
  schema_version: string;
  run_id: string;
  run_date: string;
  offline: boolean;
  providers: Record<string, string | boolean>;
  sites: Site[];
  evidence: Evidence[];
  external_calls: string[];
  business?: {
    home_base: string; max_drive_minutes: number; rent_min: number; rent_max: number; shared_lot: string; office_required: boolean;
    min_vehicle_display?: number; flood_high_risk_zones?: string[]; followup_days?: number; max_followups?: number; weights: Record<string, number>;
  };
  exceptions?: string[];
  sending_paused?: boolean;
  pause_reason?: string | null;
  sources?: SourceRow[];
  fixture_layers?: string[];
}
interface Message { message_id: string; site_id: string; listing_id: string; case_type: string; to: string; subject: string; body: string; sent_at: string; template_id: string }
interface Run { run_id: string; run_date: string; started_at: string; finished_at: string; counts: Record<string, number>; errors: string[]; warnings?: string[]; mode?: string }
interface Data { report: Report; messages: Message[]; run: Run | null; source: string }

declare global {
  interface Window { DS_CONFIG?: { supabaseUrl?: string; supabaseAnonKey?: string; pmtilesUrl?: string }; maplibregl?: any; pmtiles?: any; protomaps_themes_base?: any }
}

// ------------------------------------------------------------------ DOM helpers
type Child = Node | string | null | undefined | false;
function h<K extends keyof HTMLElementTagNameMap>(tag: K, attrs: Record<string, string | boolean | null | undefined> = {}, ...children: Child[]): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === null || v === undefined || v === false) continue;
    if (k === "class") el.className = String(v);
    else if (k === "text") el.textContent = String(v);
    else el.setAttribute(k, v === true ? "" : String(v));
  }
  for (const c of children) if (c !== null && c !== undefined && c !== false) el.append(typeof c === "string" ? document.createTextNode(c) : c);
  return el;
}
function icon(name: string, cls = "i"): SVGSVGElement {
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("class", cls);
  svg.setAttribute("aria-hidden", "true");
  const use = document.createElementNS("http://www.w3.org/2000/svg", "use");
  use.setAttribute("href", `#${name}`);
  svg.append(use);
  return svg;
}
const mono = (text: string) => h("span", { class: "mono", text });
const fmtInt = (n: number | null | undefined) => (n === null || n === undefined ? "–" : Math.round(n).toLocaleString("en-US"));
const fmtMoney = (n: number | null | undefined) => (n === null || n === undefined ? "–" : `$${Math.round(n).toLocaleString("en-US")}`);
const fmtDate = (iso: string | null | undefined) => (iso ? iso.slice(0, 10) : "–");
const fmtStamp = (iso: string | null | undefined) => (iso ? `${iso.slice(0, 10)} ${iso.slice(11, 16)}Z` : "–");
const dayDiff = (a: string, b: string) => Math.round((new Date(a).getTime() - new Date(b).getTime()) / 86_400_000);
function splitAddress(addr: string): { street: string; city: string } {
  const i = addr.indexOf(",");
  return i < 0 ? { street: addr, city: "" } : { street: addr.slice(0, i).trim(), city: addr.slice(i + 1).trim() };
}
function hostOf(url: string): string {
  try { return new URL(url).hostname.replace(/^www\./, ""); } catch { return url; }
}
const isHttp = (u: string) => /^https?:\/\//i.test(u);
const domainOfEmail = (e: string) => (e.includes("@") ? e.split("@")[1]! : e);

// ------------------------------------------------------------------ components
function chip(gate: "zoning" | "rent" | "flood", g: Gate, large = false): HTMLElement {
  const stale = g.status === "pending" && g.warning === "expired";
  const status = stale ? "stale" : g.status;
  const ico = status === "pass" ? "i-check" : status === "fail" ? "i-x" : status === "stale" ? "i-stale" : "i-clock";
  const label = status === "pass" ? "Pass" : status === "fail" ? "Fail" : status === "stale" ? "Expired" : "Pending";
  return h("span", { class: `chip chip-${status}${large ? " chip-lg" : ""}`, "data-gate": gate, "data-status": status, title: g.detail ?? "" },
    icon(ico), h("span", { class: "gate", text: gate }), h("span", { class: "label", text: label }));
}
function gatesRow(s: Site): HTMLElement {
  return h("div", { class: "gates", role: "list", "aria-label": "Gates" },
    ...(["zoning", "rent", "flood"] as const).map((g) => h("span", { role: "listitem" }, chip(g, s.gates[g]))));
}
function rankMarker(s: Site, extra = ""): HTMLElement {
  const label = s.rank === null ? "Unranked" : `Rank ${s.rank}${s.shared_lot ? ", shared lot" : ""}`;
  return h("span", { class: `rank${s.shared_lot ? " is-shared" : ""}${s.rank === null ? " rank-null" : ""}${extra}`, "aria-label": label, title: label, text: s.rank === null ? "–" : String(s.rank) });
}
function sharedFlag(): HTMLElement {
  return h("span", { class: "flag-shared" }, icon("i-shared"), "Shared lot");
}
const FACTOR_META: Array<{ key: string; label: string; raw: (s: Site, f: Factor) => string }> = [
  { key: "traffic", label: "Traffic", raw: (s) => fmtInt(s.metrics.aadt) },
  { key: "visibility", label: "Visibility", raw: (s) => (s.metrics.visibility === null ? "–" : s.metrics.visibility.toFixed(2)) },
  { key: "distance", label: "Drive", raw: (s) => (s.metrics.drive_minutes === null ? "–" : `${s.metrics.drive_minutes} min`) },
  { key: "rent", label: "Rent", raw: (s) => fmtMoney(s.metrics.rent_monthly) },
  { key: "competitors", label: "Competitors", raw: (s) => (s.metrics.competitors === null ? "–" : `${s.metrics.competitors} nearby`) },
];
function scoreBlock(s: Site): HTMLElement {
  const factors = s.factors ?? [];
  const total = s.score ?? 0;
  const track = h("div", { class: "score-track", role: "img", "aria-label": `Score ${total.toFixed(2)} of 1.00` });
  const dl = h("dl", { class: "breakdown" });
  FACTOR_META.forEach((m, i) => {
    const f = factors.find((x) => x.factor === m.key);
    const weighted = f?.weighted ?? 0;
    track.append(h("span", { class: `seg seg-${i + 1}`, style: `width:${(weighted * 100).toFixed(1)}%`, title: `${m.label}: ${weighted.toFixed(2)}` }));
    dl.append(h("div", {},
      h("dt", {}, h("span", { class: `sw seg-${i + 1}` }), m.label, h("span", { class: "w", title: "weight", text: `${Math.round((f?.weight ?? 0) * 100)}%` })),
      h("dd", {}, h("b", { text: weighted.toFixed(2) }), h("span", { class: "raw", text: f ? m.raw(s, f) : "–" }))));
  });
  return h("div", { class: "score" }, h("div", { class: "score-row" }, h("span", { class: "caps", text: "Score" }), track, h("span", { class: "score-value", text: total.toFixed(2) })), dl);
}

const FACT_LABEL: Record<string, string> = {
  zoning_permitted: "zoning: permitted use",
  zoning_district: "zoning: district",
  rent_monthly: "rent: written figure",
  flood_zone: "flood: FEMA zone",
  traffic_aadt: "traffic: AADT",
  drive_minutes: "drive: minutes from home",
  competitor_count: "competitors: dealers nearby",
  geocode: "address: geocode",
  parcel: "parcel: identity",
  imagery: "imagery",
  office: "space: enclosed office",
  vehicle_display: "space: display capacity",
};
const FACT_ORDER = Object.keys(FACT_LABEL);
function factValue(e: Evidence): string {
  const v = (e.value ?? {}) as Record<string, any>;
  switch (e.fact) {
    case "zoning_permitted": return `${v.district ?? ""} ${v.status ?? ""}${v.citation ? ` (${v.citation})` : ""}`.trim();
    case "zoning_district": return `${v.district ?? "?"} · ${v.jurisdiction ?? ""} · use ${v.dealer_use ?? "unknown"}`;
    case "rent_monthly": return `${fmtMoney(v.rent_monthly)} / mo${v.includes_nnn === true ? ", plus NNN" : v.includes_nnn === false ? ", no NNN" : ""}`;
    case "flood_zone": return `Zone ${v.zone ?? "?"}, ${v.pct_area_high_risk ?? 0}% of parcel high-risk`;
    case "traffic_aadt": return `${fmtInt(v.aadt)}${v.road ? ` on ${v.road}` : ""}${v.year ? ` (${v.year})` : ""}`;
    case "drive_minutes": return `${v.minutes} min from ${v.from ?? "home base"}`;
    case "competitor_count": return `${v.count} within ${v.radius_m ? Math.round(v.radius_m / 1609 * 10) / 10 + " mi" : "radius"}`;
    case "geocode": return `${v.lat?.toFixed?.(4) ?? v.lat}, ${v.lon?.toFixed?.(4) ?? v.lon} (${v.provider ?? ""})`;
    case "parcel": return `${v.parcel_id ?? ""}${v.owner ? ` · ${v.owner}` : ""}${v.acres ? ` · ${v.acres} ac` : ""}`;
    case "imagery": return `${Array.isArray(v.images) ? v.images.length : 0} image(s) via ${v.provider ?? "provider"}`;
    case "office": return v.has_office === true ? "enclosed office on site" : v.has_office === false ? "no office" : "unknown";
    case "vehicle_display": return `${v.vehicle_capacity ?? "?"} vehicles`;
    default: return typeof e.value === "string" ? e.value : JSON.stringify(e.value);
  }
}
function methodTag(method: string): HTMLElement {
  const official = method === "layer" || method === "layer+use_table";
  const ico = official ? "i-layer" : method === "email" ? "i-mail" : method === "listing" ? "i-listing" : method === "form" ? "i-mail" : "i-layer";
  const label = official ? "Official" : method === "email" ? "Email" : method === "listing" ? "Listing" : method === "form" ? "Form" : method === "manual" ? "Manual" : "API";
  return h("span", { class: `tag${official ? " tag-official" : ""}` }, icon(ico), label);
}
function evidenceTable(rows: Evidence[], runDate: string): HTMLElement {
  const table = h("table", { class: "evidence-table" },
    h("colgroup", {}, ...["c-fact", "c-val", "c-method", "c-fetched", "c-expires", "c-src"].map((c) => h("col", { class: c }))),
    h("thead", {}, h("tr", {}, ...["Fact", "Value", "Method", "Fetched", "Expires", "Source"].map((t) => h("th", { scope: "col", text: t })))));
  const tbody = h("tbody");
  for (const e of rows) {
    const expired = e.expired ?? new Date(e.expires_at).getTime() <= new Date(`${runDate}T23:59:59Z`).getTime();
    const daysLeft = dayDiff(e.expires_at, `${runDate}T00:00:00Z`);
    const expiring = !expired && daysLeft <= 7;
    const expires = h("td", { "data-label": "Expires", class: "mono expires" });
    if (expired) expires.append(icon("i-stale"), `expired ${fmtDate(e.expires_at)}`);
    else if (expiring) expires.append(icon("i-alert"), `${fmtDate(e.expires_at)} (${daysLeft} d)`);
    else expires.textContent = fmtDate(e.expires_at);
    const src = h("td", { "data-label": "Source", class: "src" });
    if (isHttp(e.source_url)) src.append(h("a", { class: "link-ext", href: e.source_url, target: "_blank", rel: "noopener" }, h("span", { text: hostOf(e.source_url) }), icon("i-external-small")));
    else src.append(h("span", { class: "plain", text: e.source_url.startsWith("message:") ? "email reply (stored)" : e.source_url.replace(/^fixture:\/\//, "fixture: ").split("#")[0]! }));
    tbody.append(h("tr", { class: expired ? "is-stale" : expiring ? "is-expiring" : "" },
      h("td", { "data-label": "Fact" }, h("span", { class: "fact", text: FACT_LABEL[e.fact] ?? e.fact }), expired ? h("span", { class: "sr-only", text: " (expired)" }) : null),
      h("td", { "data-label": "Value", class: "val", text: factValue(e) }),
      h("td", { "data-label": "Method" }, methodTag(e.method)),
      h("td", { "data-label": "Fetched", class: "mono", text: fmtStamp(e.fetched_at) }),
      expires, src));
  }
  table.append(tbody);
  return table;
}
function siteEvidence(d: Data, s: Site): Evidence[] {
  return d.report.evidence.filter((e) => e.site_id === s.site_id).sort((a, b) => (FACT_ORDER.indexOf(a.fact) - FACT_ORDER.indexOf(b.fact)) || b.fetched_at.localeCompare(a.fetched_at));
}
function thumbs(s: Site): HTMLElement {
  const imgs = s.images ?? [];
  const slot = (kind: "street" | "aerial") => {
    const img = imgs.find((i) => i.kind === kind && isHttp(i.url));
    const el = h("div", { class: `thumb thumb-${kind}`, role: "img", "aria-label": `${kind === "street" ? "Street-level photo" : "Aerial thumbnail"} of ${splitAddress(s.address).street}${img ? "" : " (placeholder)"}` });
    if (img) el.append(h("img", { src: img.url, alt: "" }));
    else el.append(icon(kind === "street" ? "i-image" : "i-layer", "i i-20"));
    el.append(h("span", { class: "thumb-label", text: kind === "street" ? "Street" : "Aerial" }));
    return el;
  };
  return h("div", { class: "thumbs" }, slot("street"), slot("aerial"));
}
function siteCard(d: Data, s: Site, selected: boolean): HTMLElement {
  const a = splitAddress(s.address);
  const ev = siteEvidence(d, s);
  const details = h("details", { class: "evidence" },
    h("summary", {}, icon("i-chevron", "i i-chev"), "View evidence ", h("span", { class: "muted", text: `(${ev.length})` })),
    evidenceTable(ev, d.report.run_date));
  const card = h("li", { class: `site-card${selected ? " is-selected" : ""}${s.shared_lot ? " is-shared" : ""}`, id: `site-${s.site_id}`, "data-site-id": s.site_id, "data-lat": String(s.lat ?? ""), "data-lon": String(s.lon ?? "") },
    h("div", { class: "card-main" },
      h("div", { class: "card-head" },
        rankMarker(s, selected ? " is-selected" : ""),
        h("div", { class: "card-title" },
          h("div", { class: "addr" }, h("a", { href: `#site-${s.site_id}`, text: a.street })),
          h("div", { class: "city" }, a.city, " · ", mono(s.parcel_id))),
        h("div", { class: "card-flags" }, s.shared_lot ? sharedFlag() : null)),
      h("div", { class: "facts" },
        h("span", { class: "fact" }, icon("i-dollar"), h("span", { class: "v", text: fmtMoney(s.metrics.rent_monthly) }), h("span", { class: "u", text: "/ mo" })),
        h("span", { class: "fact" }, icon("i-car"), h("span", { class: "v", text: s.drive_minutes === null ? "–" : String(s.drive_minutes) }), h("span", { class: "u", text: "min drive" })),
        h("span", { class: "fact" }, icon("i-pin"), h("span", { class: "v", text: fmtInt(s.metrics.aadt) }), h("span", { class: "u", text: "AADT" }))),
      gatesRow(s),
      scoreBlock(s),
      details),
    thumbs(s));
  card.querySelector(".rank")?.addEventListener("click", () => selectSite(s.site_id));
  return card;
}
function caseStatus(c: OpenCase): HTMLElement {
  const none = c.recipient === "none";
  const map: Record<string, { cls: string; ico: string; label: string }> = {
    open: { cls: "case-awaiting", ico: "i-clock", label: "queued to send" },
    awaiting_reply: { cls: "case-awaiting", ico: "i-mail", label: "awaiting reply" },
    escalated: none ? { cls: "case-blocked", ico: "i-refresh", label: "no contact" } : { cls: "case-followup", ico: "i-alert", label: "escalated to human" },
    resolved: { cls: "case-replied", ico: "i-check", label: "replied" },
  };
  const m = map[c.status] ?? { cls: "case-blocked", ico: "i-refresh", label: c.status };
  return h("span", { class: `case-status ${m.cls}` }, icon(m.ico), m.label);
}

// ------------------------------------------------------------------ views
let DATA: Data | null = null;
let SELECTED: string | null = null;

function viewShortlist(d: Data): HTMLElement[] {
  const viable = d.report.sites.filter((s) => s.viable && s.rank !== null).sort((a, b) => a.rank! - b.rank!);
  const almost = d.report.sites.filter((s) => s.in_search_area && !s.viable && Object.values(s.gates).every((g) => g.status !== "fail") && Object.values(s.gates).some((g) => g.status === "pending"));
  if (!SELECTED || !viable.some((s) => s.site_id === SELECTED)) SELECTED = viable[0]?.site_id ?? null;
  const shared = viable.filter((s) => s.shared_lot).length;
  const head = h("div", { class: "page-head" }, h("h1", { text: "Shortlist" }),
    h("span", { class: "sub", text: `${viable.length} viable site${viable.length === 1 ? "" : "s"} · ranked by weighted score · standalone before shared lots${shared ? ` (${shared} shared)` : ""}` }));
  const list = h("ol", { class: "site-list" }, ...viable.map((s) => siteCard(d, s, s.site_id === SELECTED)));
  const layout = h("div", { class: "shortlist-layout" },
    h("section", { "aria-labelledby": "h-list" }, h("h2", { id: "h-list", class: "sr-only", text: "Ranked viable sites" }),
      viable.length ? list : h("div", { class: "empty", text: "No viable sites yet. Every gate must pass on verified, unexpired evidence." })),
    h("aside", { class: "map-col" }, mapFrame(d, viable)));
  const almostSec = h("section", { class: "section section-quiet", "aria-labelledby": "h-almost" },
    h("div", { class: "section-head" }, h("h2", { id: "h-almost", text: "Almost: gates pending" }), h("span", { class: "sub", text: `${almost.length} site${almost.length === 1 ? "" : "s"} · pending is unresolved, not a pass` })),
    almost.length ? h("ul", { class: "almost-list" }, ...almost.map((s) => almostRow(s))) : h("div", { class: "empty", text: "Nothing waiting on a single reply." }));
  return [head, layout, almostSec];
}
function almostRow(s: Site): HTMLElement {
  const a = splitAddress(s.address);
  const pending = (["zoning", "rent", "flood"] as const).filter((g) => s.gates[g].status === "pending");
  const cases = s.open_cases.length ? s.open_cases : [];
  return h("li", { class: "almost-row" },
    h("div", {}, h("div", { class: "addr", text: a.street }), h("div", { class: "city", text: `${a.city} · ${fmtMoney(s.metrics.rent_monthly)}/mo · ${s.drive_minutes ?? "–"} min` })),
    h("div", { class: "gates" }, ...pending.map((g) => chip(g, s.gates[g]))),
    h("div", { class: "case" }, ...(cases.length
      ? cases.flatMap((c) => [caseStatus(c), h("span", {}, `${c.case_type} case → `, mono(c.recipient === "none" ? "no published contact" : domainOfEmail(c.recipient)))])
      : [h("span", { class: "case-status case-blocked" }, icon("i-refresh"), "no case"), h("span", { text: "waiting on enrichment" })])));
}

// ---- map
function mapFrame(d: Data, viable: Site[]): HTMLElement {
  const pts = d.report.sites.filter((s) => s.in_search_area && typeof s.lat === "number" && typeof s.lon === "number");
  const lats = pts.map((s) => s.lat!), lons = pts.map((s) => s.lon!);
  const minLat = Math.min(...lats), maxLat = Math.max(...lats), minLon = Math.min(...lons), maxLon = Math.max(...lons);
  const pad = 0.12;
  const px = (lon: number) => (maxLon === minLon ? 50 : pad * 100 + ((lon - minLon) / (maxLon - minLon)) * (100 - 2 * pad * 100));
  const py = (lat: number) => (maxLat === minLat ? 50 : pad * 100 + ((maxLat - lat) / (maxLat - minLat)) * (100 - 2 * pad * 100));
  const stat = h("div", { class: "map-static map-fallback map-frame", style: "position:absolute;inset:0;border:0;border-radius:0", "aria-hidden": "false" });
  for (const s of viable) {
    const sel = s.site_id === SELECTED;
    const b = h("button", { type: "button", class: `static-marker marker${sel ? " is-selected" : ""} rank${s.shared_lot ? " is-shared" : ""}`, style: `left:${px(s.lon!).toFixed(1)}%;top:${py(s.lat!).toFixed(1)}%`, "data-site-id": s.site_id, "aria-label": `Rank ${s.rank}, ${splitAddress(s.address).street}${s.shared_lot ? ", shared lot" : ""}`, text: String(s.rank) });
    b.addEventListener("click", () => selectSite(s.site_id));
    stat.append(b);
  }
  const sel = viable.find((s) => s.site_id === SELECTED);
  if (sel) {
    const a = splitAddress(sel.address);
    stat.append(h("div", { class: "map-popup is-below", id: "static-popup", style: `left:calc(${px(sel.lon!).toFixed(1)}% - 120px);top:calc(${py(sel.lat!).toFixed(1)}% + 24px)`, role: "dialog", "aria-label": "Selected site" },
      h("div", { class: "pop-head" }, rankMarker(sel), h("span", { class: "addr", text: a.street })),
      h("div", { class: "pop-body" },
        h("div", { class: "pop-facts" }, h("span", {}, h("b", { text: fmtMoney(sel.metrics.rent_monthly) }), "/mo"), h("span", {}, h("b", { text: String(sel.drive_minutes ?? "–") }), " min"), h("span", {}, "score ", h("b", { text: (sel.score ?? 0).toFixed(2) }))),
        gatesRow(sel),
        h("a", { class: "pop-link", href: `#site-${sel.site_id}`, text: "Open in list" }))));
  }
  const online = !!window.DS_CONFIG?.pmtilesUrl;
  stat.append(h("span", { class: "map-caption", text: online ? "Static preview · MapLibre replaces this when tiles load" : "Static preview · set PMTILES_URL for a self-hosted basemap" }));
  const frame = h("div", { class: "map-frame", id: "map-frame", role: "region", "aria-label": "Map of ranked sites (the shortlist is the list equivalent)" }, h("div", { class: "map-canvas", id: "map" }), stat);
  if (online && viable.length) setTimeout(() => mountMapLibre(frame, viable), 0);
  return frame;
}
function loadScript(src: string): Promise<void> {
  return new Promise((res, rej) => {
    if (document.querySelector(`script[src="${src}"]`)) return res();
    const s = document.createElement("script"); s.src = src; s.onload = () => res(); s.onerror = () => rej(new Error(`failed ${src}`));
    document.head.append(s);
  });
}
async function mountMapLibre(frame: HTMLElement, viable: Site[]): Promise<void> {
  try {
    const css = document.createElement("link"); css.rel = "stylesheet"; css.href = "https://unpkg.com/maplibre-gl@4/dist/maplibre-gl.css"; document.head.append(css);
    await loadScript("https://unpkg.com/maplibre-gl@4/dist/maplibre-gl.js");
    await loadScript("https://unpkg.com/pmtiles@3/dist/pmtiles.js");
    await loadScript("https://unpkg.com/protomaps-themes-base@4/dist/protomaps-themes-base.js");
    const ml = window.maplibregl, pm = window.pmtiles, themes = window.protomaps_themes_base;
    if (!ml || !pm || !themes) throw new Error("map libraries unavailable");
    const protocol = new pm.Protocol(); ml.addProtocol("pmtiles", protocol.tile);
    const dark = document.getElementById("root")?.getAttribute("data-theme") === "dark" || (!document.getElementById("root")?.getAttribute("data-theme") && matchMedia("(prefers-color-scheme: dark)").matches);
    const map = new ml.Map({ container: "map", style: { version: 8, glyphs: "https://protomaps.github.io/basemaps-assets/fonts/{fontstack}/{range}.pbf", sources: { protomaps: { type: "vector", url: `pmtiles://${window.DS_CONFIG!.pmtilesUrl}`, attribution: "© OpenStreetMap contributors · Protomaps" } }, layers: themes.default("protomaps", dark ? "dark" : "light") }, attributionControl: true });
    const bounds = new ml.LngLatBounds();
    for (const s of viable) {
      bounds.extend([s.lon!, s.lat!]);
      const el = h("button", { type: "button", class: `marker rank${s.shared_lot ? " is-shared" : ""}`, "aria-label": `Rank ${s.rank}, ${splitAddress(s.address).street}`, text: String(s.rank) });
      el.addEventListener("click", () => selectSite(s.site_id));
      new ml.Marker({ element: el }).setLngLat([s.lon!, s.lat!]).addTo(map);
    }
    map.on("load", () => { map.fitBounds(bounds, { padding: 48, maxZoom: 13, duration: 0 }); frame.classList.add("has-tiles"); });
    map.on("error", () => frame.classList.remove("has-tiles"));
  } catch (e) {
    console.warn("map fallback:", e);
  }
}
function selectSite(id: string): void {
  SELECTED = id;
  render();
  document.getElementById(`site-${id}`)?.scrollIntoView({ block: "nearest", behavior: "smooth" });
}

// ---- pipeline
function viewPipeline(d: Data): HTMLElement[] {
  const sites = d.report.sites;
  const failed = (s: Site) => Object.values(s.gates).some((g) => g.status === "fail");
  const discovered = (d.report.exceptions ?? []).filter((e) => /^Listing .* unresolved/.test(e)).length;
  const resolved = sites.filter((s) => s.stage === "resolved").length;
  const enriched = sites.filter((s) => s.stage === "enriched").length;
  const verifying = sites.filter((s) => s.in_search_area && !s.viable && !failed(s) && s.stage !== "resolved" && s.stage !== "enriched").length;
  const scored = sites.filter((s) => s.viable).length;
  const excluded = sites.filter((s) => !s.in_search_area || failed(s)).length;
  const stage = (n: number, l: string, desc: string, cls = "") => h("li", { class: `stage${cls}` }, h("div", { class: "n", text: String(n) }), h("div", { class: "l", text: l }), h("div", { class: "d", text: desc }));
  const stages = h("ol", { class: "stages", "aria-label": "Sites by stage" },
    stage(discovered, "Discovered", "listing seen, not yet geocoded to a parcel"),
    stage(resolved, "Resolved", "address, parcel and drive time known"),
    stage(enriched, "Enriched", "zoning, flood, traffic, POIs fetched"),
    stage(verifying, "Verifying", "one or more gates pending; cases open"),
    stage(scored, "Scored", "all three gates pass; on the shortlist", " is-active"),
    stage(excluded, "Excluded", "a gate failed or outside search area", " is-excluded"));

  const open = sites.flatMap((s) => s.open_cases.map((c) => ({ s, c })));
  const ageOf = (c: OpenCase) => (c.opened_at ? dayDiff(`${d.report.run_date}T23:59:59Z`, c.opened_at) : null);
  open.sort((a, b) => (ageOf(b.c) ?? -1) - (ageOf(a.c) ?? -1));
  const sentFor = (s: Site, c: OpenCase) => d.messages.find((m) => m.site_id === s.site_id && m.case_type === c.case_type)?.sent_at ?? c.last_contacted_at ?? null;
  const nextText = (c: OpenCase) => c.next_action ?? (c.status === "open" ? "send inquiry" : c.status === "awaiting_reply" ? "await reply / follow up" : "human action required");
  const casesTable = h("table", { class: "table stack", id: "cases" },
    h("thead", {}, h("tr", {},
      h("th", { scope: "col", text: "Site" }), h("th", { scope: "col", text: "Case" }), h("th", { scope: "col", text: "Recipient" }), h("th", { scope: "col", text: "Sent" }),
      h("th", { scope: "col", class: "num", text: "Follow-ups" }),
      h("th", { scope: "col", class: "num", "aria-sort": "descending" }, h("button", { type: "button", class: "sort", "data-sort": "age", "aria-label": "Sort by age" }, "Age ", icon("i-sort-desc", "i i-sort"))),
      h("th", { scope: "col", text: "Status" }), h("th", { scope: "col", text: "Next action" }))),
    h("tbody", {}, ...open.map(({ s, c }) => {
      const a = splitAddress(s.address);
      const age = ageOf(c);
      return h("tr", {},
        h("td", { "data-label": "Site" }, h("span", { class: "addr", text: a.street }), h("span", { class: "sub" }, a.city, " · ", mono(s.parcel_id))),
        h("td", { "data-label": "Case", text: c.case_type }),
        h("td", { "data-label": "Recipient", class: "mono", text: c.recipient === "none" ? "–" : c.recipient }),
        h("td", { "data-label": "Sent", class: "mono", text: fmtDate(sentFor(s, c)) }),
        h("td", { "data-label": "Follow-ups", class: "num", text: String(c.followups_sent ?? 0) }),
        h("td", { "data-label": "Age", class: `num${age !== null && age >= 10 ? " age-old" : ""}`, "data-age": String(age ?? ""), text: age === null ? "–" : `${age} d` }),
        h("td", { "data-label": "Status" }, caseStatus(c)),
        h("td", { "data-label": "Next", class: "next", text: nextText(c) }));
    })));
  const msgs = h("table", { class: "table stack" },
    h("thead", {}, h("tr", {}, ...["Site", "Case", "To", "Subject", "Sent", "Template"].map((t) => h("th", { scope: "col", text: t })))),
    h("tbody", {}, ...d.messages.map((m) => {
      const s = sites.find((x) => x.site_id === m.site_id);
      return h("tr", {},
        h("td", { "data-label": "Site" }, h("span", { class: "addr", text: s ? splitAddress(s.address).street : m.site_id }), h("span", { class: "sub mono", text: s?.parcel_id ?? "" })),
        h("td", { "data-label": "Case", text: m.case_type }),
        h("td", { "data-label": "To", class: "mono", text: m.to }),
        h("td", { "data-label": "Subject", text: m.subject }),
        h("td", { "data-label": "Sent", class: "mono", text: fmtStamp(m.sent_at) }),
        h("td", { "data-label": "Template", class: "mono", text: m.template_id }));
    })));
  return [
    h("div", { class: "page-head" }, h("h1", { text: "Pipeline" }), h("span", { class: "sub", text: `${sites.length} sites in this run · by current stage` })),
    stages,
    h("section", { class: "section", "aria-labelledby": "h-cases" },
      h("div", { class: "section-head" }, h("h2", { id: "h-cases", text: "Open cases" }), h("span", { class: "sub", text: `${open.length} open · sorted by age, oldest first · "no reply" is not approval` })),
      open.length ? h("div", { class: "table-wrap" }, casesTable) : h("div", { class: "empty", text: "No open cases." })),
    h("section", { class: "section section-quiet", "aria-labelledby": "h-msgs" },
      h("div", { class: "section-head" }, h("h2", { id: "h-msgs", text: "Messages sent this run" }), h("span", { class: "sub", text: `${d.messages.length} · from messages.json` })),
      d.messages.length ? h("div", { class: "table-wrap" }, msgs) : h("div", { class: "empty", text: "Nothing sent this run." })),
  ];
}

// ---- exceptions
function xitem(k: Child, sub: Child, r: Child, m: Child, mClass = ""): HTMLElement {
  return h("li", {}, h("span", { class: "k" }, k, sub ? h("span", { class: "sub" }, sub) : null), h("span", { class: "r" }, r), h("span", { class: `m${mClass ? " " + mClass : ""}` }, m));
}
function viewExceptions(d: Data): HTMLElement[] {
  const r = d.report;
  const sources = r.sources ?? [];
  const failedSrc = sources.filter((s) => s.last_status === "error");
  const excludedSrc = sources.filter((s) => s.terms_status === "prohibited" || s.robots_txt === "disallowed" || (s.terms_status === "unclear" && !s.enabled));
  const cutoff = new Date(`${r.run_date}T23:59:59Z`).getTime();
  const expired = r.evidence.filter((e) => new Date(e.expires_at).getTime() <= cutoff);
  const expiring = r.evidence.filter((e) => { const t = new Date(e.expires_at).getTime(); return t > cutoff && t <= cutoff + 7 * 86_400_000; });
  const siteOf = (id: string) => r.sites.find((s) => s.site_id === id);
  const escalated = r.sites.flatMap((s) => s.open_cases.filter((c) => c.status === "escalated").map((c) => ({ s, c })));
  const other = (r.exceptions ?? []).filter((e) => !/^Source .* excluded/.test(e) && !/^Evidence expired/.test(e) && !/^Case .* escalated/.test(e) && !/^Sending paused/.test(e));
  const sec = (id: string, title: string, sub: string, body: HTMLElement, first = false) =>
    h("section", { class: "section", "aria-labelledby": id, style: first ? "margin-top:0" : "" }, h("div", { class: "section-head" }, h("h2", { id, text: title }), h("span", { class: "sub", text: sub })), body);
  const list = (items: HTMLElement[], empty: string) => (items.length ? h("ul", { class: "xlist" }, ...items) : h("div", { class: "empty", text: empty }));
  return [
    h("div", { class: "page-head" }, h("h1", { text: "Exceptions" }), h("span", { class: "sub", text: "what the automation could not do this run" })),
    sec("h-failed", "Sources that failed to fetch", String(failedSrc.length),
      list(failedSrc.map((s) => xitem(s.id, s.kind, s.last_error ?? "error", fmtStamp(d.run?.finished_at ?? null))), "No source failed this run."), true),
    sec("h-tos", "Sources excluded by terms of service", `${excludedSrc.length} · never fetched, by policy`,
      list(excludedSrc.map((s) => xitem(s.id, `${s.kind} · terms ${s.terms_status} · robots ${s.robots_txt}`, s.notes ?? "excluded by allowlist", icon("i-ban", "i i-16"))), "No source is excluded.")),
    sec("h-exp", "Evidence expiring within 7 days", `${expiring.length} expiring · ${expired.length} already expired`,
      list([
        ...expiring.map((e) => xitem(splitAddress(siteOf(e.site_id)?.address ?? e.site_id).street, h("span", {}, FACT_LABEL[e.fact] ?? e.fact, " · ", mono(e.evidence_id)), `${factValue(e)} · ${e.method}`, h("span", {}, icon("i-alert", "i i-16"), ` expires ${fmtDate(e.expires_at)} (${dayDiff(e.expires_at, `${r.run_date}T00:00:00Z`)} d)`), "warn")),
        ...expired.map((e) => xitem(splitAddress(siteOf(e.site_id)?.address ?? e.site_id).street, h("span", {}, FACT_LABEL[e.fact] ?? e.fact, " · ", mono(e.evidence_id), " · gate now pending"), h("span", {}, h("s", { text: factValue(e) }), ` · ${e.method}`), `expired ${fmtDate(e.expires_at)}`, "stale")),
      ], "No evidence expires within 7 days.")),
    sec("h-human", "Cases needing a human", `${escalated.length} escalated · max follow-ups, bounce, stop request or no published contact`,
      list(escalated.map(({ s, c }) => xitem(splitAddress(s.address).street, h("span", {}, `${c.case_type} case · `, mono(s.parcel_id)), c.next_action ?? "human action required", c.recipient === "none" ? "no contact" : domainOfEmail(c.recipient))), "Nothing escalated.")),
    sec("h-drop", "Sites dropped since last run", "needs the previous run's report",
      h("div", { class: "empty", text: "Not available: report.json carries a single run. Compare two reports offline (docs/decisions.md)." })),
    sec("h-other", "Other run notes", String(other.length + (d.run?.errors.length ?? 0) + (d.run?.warnings?.length ?? 0)),
      list([
        ...(d.run?.errors ?? []).map((e) => xitem("run error", null, e, icon("i-x", "i i-16"))),
        ...(d.run?.warnings ?? []).map((w) => xitem("warning", null, w, icon("i-info", "i i-16"))),
        ...other.map((e) => xitem(e.split(":")[0]!, null, e.slice(e.indexOf(":") + 1).trim() || e, "")),
      ], "Nothing else to report.")),
  ];
}
function banners(d: Data): HTMLElement | null {
  const r = d.report;
  const items: HTMLElement[] = [];
  if (r.sending_paused) items.push(h("div", { class: "banner banner-paused", role: "alert" }, icon("i-pause"), h("div", { class: "b-title", text: `Sending paused: ${r.pause_reason ?? "see exceptions"}` }),
    h("div", { class: "b-meta" }, h("span", {}, "Since run ", mono(fmtStamp(d.run?.finished_at ?? `${r.run_date}T00:00:00Z`))), h("span", { text: "Outreach stops until the cause is cleared (bounce rate, quota, or mail.paused) and the pipeline re-runs. The dashboard cannot resume it." }))));
  if (d.run && d.run.errors.length) items.push(h("div", { class: "banner banner-failed", role: "alert" }, icon("i-x"), h("div", { class: "b-title", text: `Last run reported ${d.run.errors.length} error${d.run.errors.length === 1 ? "" : "s"}` }),
    h("div", { class: "b-meta" }, h("span", {}, mono(d.run.run_id)), h("span", { text: d.run.errors[0] ?? "" }))));
  if (r.fixture_layers && r.fixture_layers.length && !r.offline) items.push(h("div", { class: "banner banner-warn", role: "status" }, icon("i-alert"), h("div", { class: "b-title", text: `${r.fixture_layers.length} layer${r.fixture_layers.length === 1 ? "" : "s"} served from fixtures` }),
    h("div", { class: "b-meta" }, h("span", { text: `${r.fixture_layers.join(", ")} · environment variables unset` }), h("span", {}, h("a", { href: "#config", text: "provider config" })))));
  if (r.offline) items.push(h("div", { class: "banner banner-info", role: "status" }, icon("i-info"), h("div", { class: "b-title", text: "Offline run" }),
    h("div", { class: "b-meta" }, h("span", { text: "Every layer was served from the fixture set; no external host was contacted." }), h("span", {}, "external_calls: ", mono(String(r.external_calls.length))))));
  return items.length ? h("div", { class: "banner-stack", style: "max-width:none;margin:0" }, ...items) : null;
}

// ---- config
const PROVIDER_NAMES: Record<string, string> = {
  census: "US Census geocoder", nominatim: "Nominatim (self-hosted)", google: "Google Maps Platform",
  nc_onemap: "NC OneMap parcels (state GIS)", county: "County GIS parcels", regrid: "Regrid",
  ors: "OpenRouteService", valhalla: "Valhalla (self-hosted)",
  mapillary: "Mapillary", streetview: "Google Street View Static",
  overpass: "OpenStreetMap Overpass", places: "Google Places",
  anycrawl: "AnyCrawl (self-hosted), robots.txt honoured", anycrawl_cloud: "AnyCrawl cloud",
  protomaps: "Protomaps PMTiles (self-hosted)", mapbox: "Mapbox",
  arcgis: "Municipal ArcGIS zoning layers + use tables", ncdot: "NCDOT AADT stations", fema: "FEMA NFHL",
  reddit: "Reddit official Data API", gmail: "Gmail API (OAuth)", rules: "Deterministic rules", claude_agent: "Claude via scheduled agent", claude_api: "Claude API",
};
const PAID_IDS = new Set(["google", "regrid", "streetview", "places", "anycrawl_cloud", "mapbox", "claude_api"]);
const PAID_ALT: Record<string, string> = { geocoder: "google", parcels: "regrid", drivetime: "google", imagery: "streetview", poi: "places", crawler: "anycrawl_cloud", tiles: "mapbox", llm: "claude_api" };
const LAYERS = ["geocoder", "parcels", "zoning", "drivetime", "traffic", "flood", "imagery", "poi", "crawler", "social", "mail", "llm", "tiles"];
function viewConfig(d: Data): HTMLElement[] {
  const r = d.report, b = r.business, run = d.run;
  const paidOn = LAYERS.filter((l) => PAID_IDS.has(String(r.providers[l])));
  const kv = (dt: string, dd: string, sub?: string) => h("div", {}, h("dt", { text: dt }), h("dd", {}, dd, sub ? h("span", { class: "sub", text: sub }) : null));
  const placeholder = b?.home_base === "Greenville, NC 27858";
  const cards = h("dl", { class: "kv" },
    kv("Home base", b?.home_base ?? "–", placeholder ? "dev placeholder; DEALERSOURCE_HOME_BASE sets the real address at deploy" : "set at deploy"),
    kv("Max drive time", b ? `${b.max_drive_minutes} min` : "–", `from home base, ${PROVIDER_NAMES[String(r.providers.drivetime)] ?? r.providers.drivetime}`),
    kv("Rent range", b ? `$${b.rent_min} – $${b.rent_max} / mo` : "–", "written figure required (listing, email or form)"),
    kv("Shared-lot policy", b?.shared_lot ?? "–", b?.shared_lot === "last_resort" ? "viable, ranked after all standalone sites" : b?.shared_lot === "exclude" ? "never viable" : "ranked with standalone sites"),
    kv("Flood zones excluded", (b?.flood_high_risk_zones ?? []).join(", ") || "–", "FEMA NFHL high-risk; shaded X only warns"),
    kv("Site requirements", b ? `office ${b.office_required ? "required" : "optional"} · ${b.min_vehicle_display ?? "–"}+ vehicles` : "–", "NC established-place-of-business checks"),
    kv("Score weights", b ? Object.entries(b.weights).map(([k, v]) => `${k} ${Math.round(v * 100)}`).join(" · ") : "–", "relative, normalised at run time"),
    kv("Outreach cadence", b ? `${b.followup_days ?? "–"} d · ${b.max_followups ?? "–"} follow-ups` : "–", "same address, same site: never twice inside the window"));
  const rows = LAYERS.map((l) => {
    const id = String(r.providers[l]);
    const paid = PAID_IDS.has(id);
    const alt = PAID_ALT[l];
    return h("tr", {},
      h("td", { "data-label": "Layer", class: "mono", text: l }),
      h("td", { "data-label": "Selected provider" }, h("span", { class: "addr", text: PROVIDER_NAMES[id] ?? id }), r.fixture_layers?.includes(l) ? h("span", { class: "sub", text: "served from fixtures this run" }) : null),
      h("td", { "data-label": "Cost" }, h("span", { class: `cost ${paid ? "cost-paid" : "cost-free"}`, text: paid ? "paid" : "free" })),
      h("td", { "data-label": "Enabled" }, h("span", { class: "onoff onoff-on" }, h("span", { class: "sw" }), "on")),
      h("td", { "data-label": "Paid alternative" }, alt && !paid ? h("span", {}, h("span", { class: "muted", text: PROVIDER_NAMES[alt] ?? alt }), " ", h("span", { class: "onoff onoff-off" }, h("span", { class: "sw" }), "off")) : h("span", { class: "muted", text: paid ? "selected" : "none (official source)" })));
  });
  const dur = run ? Math.max(0, Math.round((new Date(run.finished_at).getTime() - new Date(run.started_at).getTime()) / 1000)) : null;
  const openCases = r.sites.reduce((a, s) => a + s.open_cases.length, 0);
  const status = r.sending_paused ? ["dot-paused", "paused"] : run && run.errors.length ? ["dot-failed", "errors"] : ["dot-ok", "ok"];
  const cell = (k: string, v: Child) => h("div", {}, h("div", { class: "k", text: k }), h("div", { class: "v" }, v));
  const summary = h("div", { class: "run-summary" },
    cell("Started", fmtStamp(run?.started_at)), cell("Finished", fmtStamp(run?.finished_at)),
    cell("Duration", dur === null ? "–" : dur >= 60 ? `${Math.floor(dur / 60)} min ${dur % 60} s` : `${dur} s`), cell("Offline", r.offline ? "yes" : "no"),
    cell("Sites", String(r.sites.length)), cell("Viable", String(r.sites.filter((s) => s.viable).length)),
    cell("Evidence fetched", String(r.evidence.length)), cell("External calls", String(r.external_calls.length)),
    cell("Cases open", String(openCases)), cell("Messages sent", String(d.messages.length)),
    cell("Errors", String(run?.errors.length ?? 0)),
    cell("Status", h("span", {}, h("span", { class: `dot ${status[0]}`, style: "display:inline-block;vertical-align:-1px;margin-right:6px" }), status[1]!)));
  if (run?.errors.length) summary.append(h("div", { class: "errs" }, h("div", { class: "k", text: "run.errors[]" }), h("ul", {}, ...run.errors.map((e) => h("li", { text: e })))));
  return [
    h("div", { class: "page-head" }, h("h1", { text: "Config" }), h("span", { class: "sub", text: `read-only · from report.json providers and run · edit providers.yaml / business.yaml in the repo, not here · data: ${d.source}` })),
    h("section", { "aria-labelledby": "h-biz" }, h("div", { class: "section-head" }, h("h2", { id: "h-biz", text: "Business parameters" })), cards),
    h("section", { class: "section", "aria-labelledby": "h-prov" },
      h("div", { class: "section-head" }, h("h2", { id: "h-prov", text: "Providers" }),
        paidOn.length
          ? h("span", { class: "paid-indicator paid-on" }, icon("i-alert"), `Paid providers: on (${paidOn.map((l) => PROVIDER_NAMES[String(r.providers[l])] ?? l).join(", ")})`)
          : h("span", { class: "paid-indicator paid-off" }, icon("i-check"), `Paid providers: ${r.providers.paid_enabled ? "enabled but none selected" : "off"}`),
        h("span", { class: "sub", text: r.providers.paid_enabled ? "paid_enabled is true in providers.yaml" : "default configuration uses free data only" })),
      h("div", { class: "table-wrap" }, h("table", { class: "table stack" },
        h("thead", {}, h("tr", {}, ...["Layer", "Selected provider", "Cost", "Enabled", "Paid alternative"].map((t) => h("th", { scope: "col", text: t })))),
        h("tbody", {}, ...rows)))),
    h("section", { class: "section", "aria-labelledby": "h-run" },
      h("div", { class: "section-head" }, h("h2", { id: "h-run", text: "Last run" }), h("span", { class: "sub mono", text: r.run_id })),
      summary),
  ];
}

// ------------------------------------------------------------------ shell
function currentView(): "shortlist" | "pipeline" | "exceptions" | "config" {
  const v = location.hash.replace(/^#/, "").split("/")[0];
  return v === "pipeline" || v === "exceptions" || v === "config" ? v : "shortlist";
}
function renderShell(d: Data): void {
  const r = d.report;
  const status = document.getElementById("run-status")!;
  status.replaceChildren();
  const state = r.sending_paused ? ["dot-paused", "Paused"] : d.run && d.run.errors.length ? ["dot-failed", "Errors"] : ["dot-ok", "OK"];
  status.append(h("span", { class: `dot ${state[0]}`, "aria-hidden": "true" }), h("span", {}, "Last run ", mono(fmtStamp(d.run?.finished_at ?? `${r.run_date}T00:00:00Z`)), ` · ${state[1]}`));
  const exCount = (r.exceptions ?? []).length;
  const badge = document.getElementById("nav-exceptions-count")!;
  badge.hidden = exCount === 0;
  badge.textContent = String(exCount);
  badge.classList.toggle("is-alert", !!r.sending_paused || !!(d.run && d.run.errors.length));
  const view = currentView();
  document.querySelectorAll<HTMLAnchorElement>("#nav a").forEach((a) => { if (a.dataset.view === view) a.setAttribute("aria-current", "page"); else a.removeAttribute("aria-current"); });
  document.title = `dealersource ${view[0]!.toUpperCase()}${view.slice(1)}`;
  const strip = document.getElementById("strip")!;
  strip.replaceChildren();
  if (r.sending_paused) strip.append(h("div", { class: "paused-strip", role: "status" }, icon("i-pause", "i i-16"), h("span", {}, "Sending paused since ", mono(fmtStamp(d.run?.finished_at ?? `${r.run_date}T00:00:00Z`)), `: ${r.pause_reason ?? ""}`), h("a", { href: "#exceptions", text: "See exceptions" })));
  const bn = document.getElementById("banners")!;
  bn.replaceChildren();
  if (view === "exceptions") { const b = banners(d); if (b) bn.append(b); }
  document.getElementById("footer-run")!.textContent = r.run_id;
  document.getElementById("footer-source")!.replaceChildren("report.json · ", h("span", { class: "source-note", text: d.source }));
}
function render(): void {
  if (!DATA) return;
  renderShell(DATA);
  const main = document.getElementById("main")!;
  const view = currentView();
  const nodes = view === "pipeline" ? viewPipeline(DATA) : view === "exceptions" ? viewExceptions(DATA) : view === "config" ? viewConfig(DATA) : viewShortlist(DATA);
  main.replaceChildren(...nodes);
}

// ------------------------------------------------------------------ theme
function initTheme(): void {
  const root = document.getElementById("root")!;
  let saved: string | null = null;
  try { saved = localStorage.getItem("ds-theme"); } catch { /* private mode */ }
  if (saved === "dark" || saved === "light") root.setAttribute("data-theme", saved);
  document.getElementById("theme-toggle")?.addEventListener("click", () => {
    const dark = root.getAttribute("data-theme") === "dark" || (!root.getAttribute("data-theme") && matchMedia("(prefers-color-scheme: dark)").matches);
    const next = dark ? "light" : "dark";
    root.setAttribute("data-theme", next);
    try { localStorage.setItem("ds-theme", next); } catch { /* ignore */ }
  });
}

// ------------------------------------------------------------------ data
async function fetchJson<T>(url: string, init?: RequestInit): Promise<T | null> {
  try { const res = await fetch(url, init); if (!res.ok) return null; return (await res.json()) as T; } catch { return null; }
}
async function loadData(): Promise<Data> {
  const cfg = window.DS_CONFIG ?? {};
  if (cfg.supabaseUrl && cfg.supabaseAnonKey) {
    const base = cfg.supabaseUrl.replace(/\/+$/, "") + (/\.supabase\.(co|in)$/.test(new URL(cfg.supabaseUrl).hostname) ? "/rest/v1" : "");
    const headers = { apikey: cfg.supabaseAnonKey, Authorization: `Bearer ${cfg.supabaseAnonKey}` };
    const rows = await fetchJson<Array<{ payload: Report; messages: Message[]; created_at: string }>>(`${base}/reports?select=payload,messages,created_at&order=created_at.desc&limit=1`, { headers });
    if (rows && rows[0]) {
      const runs = await fetchJson<Run[]>(`${base}/runs?select=*&order=started_at.desc&limit=1`, { headers });
      return { report: rows[0].payload, messages: rows[0].messages ?? [], run: runs?.[0] ?? null, source: `Supabase ${new URL(cfg.supabaseUrl).hostname}` };
    }
    console.warn("Supabase unreachable; falling back to fixture data");
  }
  const report = await fetchJson<Report>("./data/report.json");
  if (!report) throw new Error("report.json not found: run `npm run dashboard:build`");
  return { report, messages: (await fetchJson<Message[]>("./data/messages.json")) ?? [], run: await fetchJson<Run>("./data/run.json"), source: "fixture data" };
}

// ------------------------------------------------------------------ boot
export {};
initTheme();
window.addEventListener("hashchange", () => { if (!location.hash.startsWith("#site-")) render(); });
loadData().then((d) => { DATA = d; render(); }).catch((e) => {
  document.getElementById("main")!.replaceChildren(h("div", { class: "page-head" }, h("h1", { text: "Shortlist" }), h("span", { class: "sub", text: String(e instanceof Error ? e.message : e) })));
});
