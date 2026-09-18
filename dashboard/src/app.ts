/**
 * dealersource operations dashboard, v2 template ("Calm Confidence").
 * Four views (Shortlist, Pipeline, Exceptions, Configuration) plus the shared
 * shell, rendered from report.json / messages.json / run.json. Component
 * markup follows prompts/dashboard-design/components.html and pages/*.html;
 * the inline styles of the design live in styles.css as classes.
 * Data: Supabase `reports` row when config.js has a URL and anon key, else
 * ./data/*.json. No editing, no forms, no login.
 */

// ------------------------------------------------------------------ types
type GateStatus = "pass" | "fail" | "pending";
interface Gate { status: GateStatus; evidence_ids: string[]; detail?: string; warning?: string | null }
interface Factor { factor: string; raw: number | null; normalized: number; weight: number; weighted: number; detail: string }
interface OpenCase { case_type: "rent" | "zoning" | "space"; status: string; recipient: string; opened_at?: string; last_contacted_at?: string | null; followups_sent?: number; next_action?: string; next_action_at?: string | null }
interface ListingRef { listing_id: string; source_id: string; url: string; rent_monthly: number | null; fetched_at: string }
interface Site {
  site_id: string; parcel_id: string; listing_ids: string[]; address: string; in_search_area: boolean | null; drive_minutes: number | null; shared_lot: boolean;
  gates: { zoning: Gate; rent: Gate; flood: Gate }; viable: boolean; score: number | null; rank: number | null;
  metrics: { aadt: number | null; visibility: number | null; drive_minutes: number | null; rent_monthly: number | null; competitors: number | null };
  open_cases: OpenCase[]; stage?: string; jurisdiction?: string | null; flags?: string[]; factors?: Factor[];
  requirements?: Array<{ name: string; outcome: string; detail: string }>; lat?: number; lon?: number; images?: Array<{ url: string; kind: string }>; listings?: ListingRef[];
}
interface Evidence { evidence_id: string; site_id: string; fact: string; value: unknown; source_url: string; fetched_at: string; expires_at: string; method: string; expired?: boolean }
interface SourceRow { id: string; kind: string; enabled: boolean; terms_status: string; robots_txt: string; last_status: string | null; last_error: string | null; notes: string | null }
interface Report {
  schema_version: string; run_id: string; run_date: string; offline: boolean; providers: Record<string, string | boolean>; sites: Site[]; evidence: Evidence[]; external_calls: string[];
  business?: { home_base: string; max_drive_minutes: number; rent_min: number; rent_max: number; shared_lot: string; office_required: boolean; min_vehicle_display?: number; flood_high_risk_zones?: string[]; followup_days?: number; max_followups?: number; weights: Record<string, number> };
  exceptions?: string[]; sending_paused?: boolean; pause_reason?: string | null; sources?: SourceRow[]; fixture_layers?: string[];
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
const SVG = "http://www.w3.org/2000/svg";
function svgIcon(paths: string[], size = 11, stroke = 2.5): SVGSVGElement {
  const s = document.createElementNS(SVG, "svg");
  s.setAttribute("width", String(size)); s.setAttribute("height", String(size)); s.setAttribute("viewBox", "0 0 24 24");
  s.setAttribute("fill", "none"); s.setAttribute("stroke", "currentColor"); s.setAttribute("stroke-width", String(stroke));
  s.setAttribute("stroke-linecap", "round"); s.setAttribute("stroke-linejoin", "round"); s.setAttribute("aria-hidden", "true");
  for (const d of paths) {
    if (d.startsWith("circle:")) { const c = document.createElementNS(SVG, "circle"); const [cx, cy, r] = d.slice(7).split(","); c.setAttribute("cx", cx!); c.setAttribute("cy", cy!); c.setAttribute("r", r!); s.append(c); }
    else if (d.startsWith("poly:")) { const p = document.createElementNS(SVG, "polyline"); p.setAttribute("points", d.slice(5)); s.append(p); }
    else if (d.startsWith("rect:")) { const r = document.createElementNS(SVG, "rect"); const [x, y, w, hh, rx] = d.slice(5).split(","); r.setAttribute("x", x!); r.setAttribute("y", y!); r.setAttribute("width", w!); r.setAttribute("height", hh!); r.setAttribute("rx", rx!); s.append(r); }
    else { const p = document.createElementNS(SVG, "path"); p.setAttribute("d", d); s.append(p); }
  }
  return s;
}
const ICON = {
  check: ["M20 6 9 17l-5-5"],
  x: ["M18 6 6 18", "m6 6 12 12"],
  clock: ["circle:12,12,10", "poly:12 6 12 12 16 14"],
  stale: ["M12 8v4", "M12 16h.01", "circle:12,12,10"],
  ok: ["circle:12,12,10", "m9 12 2 2 4-4"],
  pause: ["rect:6,4,4,16,1", "rect:14,4,4,16,1"],
  failed: ["circle:12,12,10", "m15 9-6 6", "m9 9 6 6"],
  ext: ["M15 3h6v6", "M10 14 21 3", "M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"],
  plus: ["M5 12h14", "M12 5v14"],
  minus: ["M5 12h14"],
};
const mono = (t: string) => h("span", { class: "mono", text: t });
const fmtInt = (n: number | null | undefined) => (n === null || n === undefined ? "–" : Math.round(n).toLocaleString("en-US"));
const fmtMoney = (n: number | null | undefined) => (n === null || n === undefined ? "–" : `$${Math.round(n).toLocaleString("en-US")}`);
const ET = "America/New_York";
const fmtDay = (iso: string | null | undefined) => (iso ? new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", timeZone: "UTC" }).format(new Date(iso)) : "–");
const fmtTimeET = (iso: string | null | undefined) => (iso ? new Intl.DateTimeFormat("en-US", { hour: "2-digit", minute: "2-digit", hour12: false, timeZone: ET }).format(new Date(iso)) : "–");
const fmtStampET = (iso: string | null | undefined) => (iso ? `${new Intl.DateTimeFormat("en-CA", { year: "numeric", month: "2-digit", day: "2-digit", timeZone: ET }).format(new Date(iso))} ${new Intl.DateTimeFormat("en-US", { hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false, timeZone: ET }).format(new Date(iso))} ET` : "–");
const dayDiff = (a: string, b: string) => Math.round((new Date(a).getTime() - new Date(b).getTime()) / 86_400_000);
const score100 = (s: Site) => (s.score === null ? "–" : String(Math.round(s.score * 100)));
function splitAddress(addr: string): { street: string; city: string; town: string } {
  const parts = addr.split(",").map((p) => p.trim());
  return { street: parts[0] ?? addr, city: parts.slice(1).join(", "), town: parts[1] ?? "" };
}
const isHttp = (u: string) => /^https?:\/\//i.test(u);
const hostOf = (u: string) => { try { return new URL(u).hostname.replace(/^www\./, ""); } catch { return u; } };
const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? "" : "s"}`;
const failed = (s: Site) => Object.values(s.gates).some((g) => g.status === "fail");
const pendingGates = (s: Site) => (["zoning", "rent", "flood"] as const).filter((g) => s.gates[g].status === "pending");
const distanceUnknown = (s: Site) => s.in_search_area === null;
const isOneAway = (s: Site) => s.in_search_area !== false && !s.viable && !failed(s) && pendingGates(s).length >= 1;
// Gates passed but drive time unknown: shown with the waiting sites, never ranked.
const isUnrankedViable = (s: Site) => distanceUnknown(s) && s.viable && s.rank === null;

// ------------------------------------------------------------------ components
function gateEl(gate: "zoning" | "rent" | "flood", g: Gate, size = 11): HTMLElement {
  const stale = g.status === "pending" && g.warning === "expired";
  const st = stale ? "stale" : g.status;
  const ico = st === "pass" ? ICON.check : st === "fail" ? ICON.x : st === "stale" ? ICON.stale : ICON.clock;
  const label = gate[0]!.toUpperCase() + gate.slice(1);
  return h("span", { class: `gate ${st}`, title: g.detail ?? "" }, svgIcon(ico, size), h("span", { text: label }), " ", h("span", { class: "w", text: st }));
}
function gatePill(gate: "zoning" | "rent" | "flood", g: Gate, small = false): HTMLElement {
  const stale = g.status === "pending" && g.warning === "expired";
  const st = stale ? "stale" : g.status === "pass" ? "ok" : g.status === "fail" ? "fail" : "wait";
  return h("span", { class: `pill ${st}${small ? " sm" : ""}` }, h("span", { text: gate[0]!.toUpperCase() + gate.slice(1) }), " ", h("span", { text: stale ? "stale" : g.status }));
}
const FACTORS = ["traffic", "visibility", "distance", "rent", "competitors"];
function factorOf(s: Site, key: string): Factor | undefined { return s.factors?.find((f) => f.factor === key); }
function bars(s: Site, tall = false): HTMLElement {
  const wrap = h("div", { class: tall ? "factors" : "bars" });
  FACTORS.forEach((k, i) => {
    const f = factorOf(s, k);
    const pct = Math.round((f?.normalized ?? 0) * 100);
    const bar = h("div", { class: "bar", title: `${labelFor(k)}: ${pct}%` }, h("span", { class: `f${i + 1}`, style: `height:${pct}%` }));
    if (!tall) wrap.append(bar);
    else wrap.append(h("div", {}, bar, h("div", { class: "fl", text: labelFor(k) }), h("div", { class: "fv", text: rawFor(s, k) })));
  });
  return wrap;
}
function labelFor(k: string): string { return k === "distance" ? "Drive" : k[0]!.toUpperCase() + k.slice(1); }
function rawFor(s: Site, k: string): string {
  switch (k) {
    case "traffic": return s.metrics.aadt === null ? "no count" : `${fmtInt(s.metrics.aadt)} /day`;
    case "visibility": return s.metrics.visibility === null ? "unknown" : `${Math.round(s.metrics.visibility * 100)} of 100`;
    case "distance": return s.drive_minutes === null ? "–" : `${s.drive_minutes} min`;
    case "rent": return s.metrics.rent_monthly === null ? "no quote" : `${fmtMoney(s.metrics.rent_monthly)}/mo`;
    default: return s.metrics.competitors === null ? "unknown" : `${s.metrics.competitors} nearby`;
  }
}
function photoSlot(s: Site, kind: "street" | "aerial", label: string): HTMLElement {
  const img = (s.images ?? []).find((i) => i.kind === kind && isHttp(i.url));
  const el = h("div", { class: `photo${img ? " has-img" : ""}`, role: "img", "aria-label": `${label} of ${splitAddress(s.address).street}${img ? "" : " (placeholder)"}` });
  if (img) el.append(h("img", { src: img.url, alt: "" })); else el.textContent = label;
  return el;
}
function statusPill(c: OpenCase, paused: boolean): HTMLElement {
  if (c.status === "resolved") return h("span", { class: "pill ok", text: "Answered" });
  if (paused && (c.status === "open" || c.status === "awaiting_reply")) return h("span", { class: "pill fail", text: "Held, sending paused" });
  if (c.status === "escalated") return h("span", { class: "pill fail", text: c.recipient === "none" ? "Needs a contact" : "Escalated to human" });
  if (c.status === "open") return h("span", { class: "pill wait", text: "Queued to send" });
  return h("span", { class: "pill wait", text: "Awaiting reply" });
}
const caseTypeLabel = (t: string) => (t === "rent" ? "rent quote" : t);

// ------------------------------------------------------------------ state
let DATA: Data | null = null;
let SELECTED: string | null = null;
let MAP: any = null;
const isPhone = () => matchMedia("(max-width: 720px)").matches;

function currentView(): "shortlist" | "pipeline" | "exceptions" | "config" {
  const v = location.hash.replace(/^#/, "").split("/")[0];
  return v === "pipeline" || v === "exceptions" || v === "config" || v === "configuration" ? (v === "configuration" ? "config" : v) : "shortlist";
}

// ------------------------------------------------------------------ shell
function runState(d: Data): { cls: "ok" | "bad" | "wait"; word: string; short: string; icon: string[] } {
  const r = d.report;
  if (r.sending_paused) return { cls: "bad", word: "Sending paused", short: "Paused", icon: ICON.pause };
  if (d.run && d.run.errors.length) return { cls: "bad", word: "Run failed", short: "Failed", icon: ICON.failed };
  return { cls: "ok", word: "Running", short: "Running", icon: ICON.ok };
}
function header(d: Data): HTMLElement {
  const view = currentView();
  const st = runState(d);
  const exCount = d.report.sites.reduce((a, s) => a + s.open_cases.filter((c) => c.status === "escalated").length, 0) + (d.run?.errors.length ?? 0) + (d.report.sending_paused ? 1 : 0);
  const link = (id: string, long: string, short: string, badge?: number) =>
    h("a", { href: `#${id}`, "aria-current": view === id ? "page" : null },
      h("span", { class: "long", text: long }), h("span", { class: "short", text: short }),
      badge ? h("span", { class: "badge", text: String(badge) }) : null,
      h("span", { class: "lamp" }));
  const mark = h("span", { class: "mark", "aria-hidden": "true" }, ...Array.from({ length: 9 }, () => h("span")));
  return h("header", { class: "hdr" },
    h("div", { class: "hdr-left" }, mark, h("span", { class: "wordmark", text: "dealersource" }), h("span", { class: "report-pill", text: `Report ${d.report.run_date}` })),
    h("nav", { class: "nav", "aria-label": "Views" }, link("shortlist", "Shortlist", "Shortlist"), link("pipeline", "Pipeline", "Pipeline"), link("exceptions", "Exceptions", "Exceptions", exCount || undefined), link("config", "Configuration", "Config")),
    h("div", { class: "hdr-right" },
      h("span", { class: `status ${st.cls}` }, svgIcon(st.icon, 14, 1.75), h("span", { class: "full", text: st.word }), h("span", { class: "short", text: `${st.short} · ${fmtTimeET(d.run?.finished_at)}` })),
      h("span", { class: "lastrun", text: `Last run ${fmtTimeET(d.run?.finished_at)} ET` })));
}
function healthBanner(d: Data): HTMLElement {
  const r = d.report, run = d.run;
  const dur = run ? Math.max(0, Math.round((new Date(run.finished_at).getTime() - new Date(run.started_at).getTime()) / 1000)) : null;
  const durTxt = dur === null ? "–" : dur >= 60 ? `${Math.floor(dur / 60)}m ${dur % 60}s` : `${dur}s`;
  const listings = r.sites.reduce((a, s) => a + s.listing_ids.length, 0);
  const replies = run?.counts?.["verify.inbound_ingested"] ?? 0;
  const errors = run?.errors.length ?? 0;
  const ageH = run ? Math.round((Date.now() - new Date(run.finished_at).getTime()) / 3_600_000) : 0;
  const cls = r.sending_paused ? "paused" : errors ? "paused" : ageH > 26 ? "wait" : "";
  const lead = r.sending_paused
    ? h("span", { class: "lead desk-only" }, svgIcon(ICON.pause, 14, 1.75), `Email sending paused since ${fmtTimeET(run?.finished_at)} ET.`)
    : errors ? h("span", { class: "lead desk-only" }, svgIcon(ICON.failed, 14, 1.75), `Run reported ${plural(errors, "error")}.`)
    : ageH > 26 ? h("span", { class: "lead desk-only" }, svgIcon(ICON.clock, 14, 1.75), `Report is ${ageH >= 48 ? `${Math.floor(ageH / 24)} days` : `${ageH} hours`} old.`)
    : h("span", { class: "lead desk-only" }, svgIcon(ICON.ok, 14, 1.75), "Automation running");
  const banner = h("div", { class: `health ${cls}`, role: "status" }, lead);
  if (r.sending_paused) banner.append(h("span", { class: "desk-only", text: `${r.pause_reason ?? "Paused."} Runs continue; no follow-ups go out.` }));
  else banner.append(
    h("span", { class: "m desk-only" }, `Last run ${d.report.run_date} ${fmtTimeET(run?.finished_at)} ET, `, h("b", { text: durTxt })),
    h("span", { class: "m desk-only" }, h("b", { text: String(listings) }), " listings merged into ", h("b", { text: String(r.sites.length) }), " sites"),
    h("span", { class: "m desk-only" }, h("b", { text: String(d.messages.length) }), " emails sent · ", h("b", { text: String(replies) }), " replies"),
    h("span", { class: "m desk-only" }, h("b", { text: String(errors) }), " errors"),
    h("span", { class: "right desk-only", text: `${r.providers.paid_enabled ? "Paid providers enabled" : "Free sources only"} · ${r.offline ? "offline fixture run" : "next run 06:00 ET tomorrow"}` }));
  banner.append(h("span", { class: "phone-only", text: `Report ${r.run_date} · ${plural(d.messages.length, "email")} sent · ${plural(replies, "reply").replace("replys", "replies")} · ${plural(errors, "error")}` }));
  return banner;
}

// ------------------------------------------------------------------ shortlist
function siteCard(d: Data, s: Site): HTMLElement {
  const a = splitAddress(s.address);
  const selected = s.site_id === SELECTED;
  const card = h("div", { class: `card${selected ? " selected" : ""}`, role: "button", tabindex: "0", "aria-pressed": selected ? "true" : "false", "data-site-id": s.site_id },
    photoSlot(s, "street", "Street photo"),
    h("span", { class: `rank${s.shared_lot ? " muted" : ""}`, text: String(s.rank ?? "–") }),
    h("span", { class: "score", text: score100(s) }),
    h("div", { class: "title" }, h("span", { class: "addr", text: a.street }), s.shared_lot ? h("span", { class: "badge-shared", text: "Shared lot, ranks last" }) : null),
    h("div", { class: "meta" }, mono(s.parcel_id), ` · ${s.drive_minutes ?? "–"} min · ${plural(s.listing_ids.length, "listing")} · ${fmtMoney(s.metrics.rent_monthly)}/mo${isPhone() && s.shared_lot ? " · shared lot, ranks last" : ""}`),
    h("div", { class: "gaterow" }, h("div", { class: "gates" }, gateEl("zoning", s.gates.zoning), gateEl("rent", s.gates.rent), gateEl("flood", s.gates.flood)), bars(s)));
  const select = () => { SELECTED = s.site_id; render(); };
  card.addEventListener("click", select);
  card.addEventListener("keydown", (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); select(); } });
  return card;
}
function pendingCard(d: Data, s: Site): HTMLElement {
  const a = splitAddress(s.address);
  const c = s.open_cases.find((k) => k.status === "awaiting_reply" || k.status === "open") ?? s.open_cases[0];
  const age = c?.opened_at ? dayDiff(`${d.report.run_date}T23:59:59Z`, c.opened_at) : null;
  const fu = d.report.business?.followup_days ?? 5, max = d.report.business?.max_followups ?? 2;
  let caseTxt = "no contact published; needs a human";
  if (c && c.recipient !== "none") {
    const nextDate = c.next_action_at ? fmtDay(c.next_action_at) : c.last_contacted_at ? fmtDay(new Date(new Date(c.last_contacted_at).getTime() + fu * 86_400_000).toISOString()) : "–";
    const n = (c.followups_sent ?? 0) + 1;
    caseTxt = c.status === "escalated" ? `escalated after ${plural(c.followups_sent ?? 0, "follow-up")}` : c.status === "open" ? `queued to email ${c.recipient}` : `emailed ${c.recipient}, ${age ?? 0} d old · ${n > max ? "last follow-up sent" : `follow-up ${nextDate} (${n} of ${max})`}`;
  }
  return h("div", { class: "card pend", "data-site-id": s.site_id },
    photoSlot(s, "street", "Street photo"),
    h("div", { class: "title" }, h("span", { class: "addr", text: `${a.street}${a.town ? ", " + a.town : ""}` })),
    h("div", { class: "meta" }, mono(s.parcel_id), ` · ${s.drive_minutes ?? "–"} min · ${caseTxt}`),
    h("div", { class: "gaterow nobars" }, h("div", { class: "gates" }, gateEl("zoning", s.gates.zoning), gateEl("rent", s.gates.rent), gateEl("flood", s.gates.flood)), h("div", { class: "noscore", text: "No score until viable" })));
}
function viewShortlist(d: Data): HTMLElement[] {
  const sites = d.report.sites;
  const viable = sites.filter((s) => s.viable && s.rank !== null).sort((a, b) => a.rank! - b.rank!);
  const oneAway = sites.filter((s) => isOneAway(s) || isUnrankedViable(s));
  const excluded = sites.filter((s) => s.in_search_area === false || failed(s));
  if (!SELECTED || !sites.some((s) => s.site_id === SELECTED)) SELECTED = viable[0]?.site_id ?? null;
  const count = (k: string, n: number) => h("div", { class: "count" }, h("div", { class: "k", text: k }), h("div", { class: "n", text: String(n) }));
  const col = h("aside", { class: "col", "aria-label": "Ranked sites" },
    h("div", { class: "counts" }, count("Viable", viable.length), count("One away", oneAway.filter((s) => pendingGates(s).length === 1).length), count("Verifying", oneAway.length), count("Excluded", excluded.length)),
    h("div", { class: "sec" }, h("div", { class: "t", text: "Ranked sites" }), h("div", { class: "s", text: "Bars: traffic, visibility, drive, rent, competitors" })),
    ...(viable.length ? viable.map((s) => siteCard(d, s)) : [h("div", { class: "empty-center" }, h("div", { class: "h", text: "No viable sites yet." }), h("div", { class: "s", text: `${plural(oneAway.length, "site")} ${oneAway.length === 1 ? "is" : "are"} waiting on an answer.` }))]),
    h("div", { class: "sec" }, h("div", { class: "t", text: "One answer away" }), h("div", { class: "s", text: "Waiting on email. Silence is not approval." })),
    ...(oneAway.length ? oneAway.map((s) => pendingCard(d, s)) : [h("div", { class: "dashed", text: "Nothing is waiting on a reply." })]));
  return [healthBanner(d), h("div", { class: "sl" }, col, mapPane(d))];
}

// ---- map
function mapPane(d: Data): HTMLElement {
  const sites = d.report.sites.filter((s) => typeof s.lat === "number" && typeof s.lon === "number");
  const inArea = sites.filter((s) => s.in_search_area !== false);
  const pts = inArea.length ? inArea : sites;
  const lats = pts.map((s) => s.lat!), lons = pts.map((s) => s.lon!);
  const minLat = Math.min(...lats), maxLat = Math.max(...lats), minLon = Math.min(...lons), maxLon = Math.max(...lons);
  const pad = 14;
  const px = (lon: number) => (maxLon === minLon ? 50 : pad + ((lon - minLon) / (maxLon - minLon)) * (100 - 2 * pad));
  const py = (lat: number) => (maxLat === minLat ? 50 : pad + ((maxLat - lat) / (maxLat - minLat)) * (100 - 2 * pad));
  const stat = h("div", { class: "map-static", "aria-hidden": "false" });
  for (const s of sites) {
    const inside = s.lon! >= minLon && s.lon! <= maxLon && s.lat! >= minLat && s.lat! <= maxLat;
    if (!inside) continue;
    const kind = s.viable && s.rank !== null ? (s.shared_lot ? "shared" : "rank") : isOneAway(s) || isUnrankedViable(s) ? "pend" : "excl";
    const street = splitAddress(s.address).street.replace(/^\d+\s+/, "");
    const b = h("button", { type: "button", class: `mk ${kind}${s.site_id === SELECTED ? " selected" : ""}`, style: `left:${px(s.lon!).toFixed(1)}%;top:${py(s.lat!).toFixed(1)}%`, "aria-label": s.viable ? `Rank ${s.rank}, ${s.address}` : isOneAway(s) ? `One answer away, ${s.address}` : `Excluded, ${s.address}` },
      h("span", { class: "disc" }, kind === "pend" ? svgIcon(ICON.clock, 13) : kind === "excl" ? null : String(s.rank)),
      kind === "excl" ? null : h("span", { class: "lbl", text: street }));
    b.addEventListener("click", () => { SELECTED = s.site_id; render(); });
    stat.append(b);
  }
  const online = !!window.DS_CONFIG?.pmtilesUrl;
  const map = h("div", { class: "map", id: "map-pane" }, h("div", { class: "map-canvas", id: "map" }), stat,
    h("div", { class: "map-ctl" }, h("button", { type: "button", class: "btn-outline", id: "fit", text: "Fit to sites" }),
      h("div", { class: "zoom" }, h("button", { type: "button", id: "zin", "aria-label": "Zoom in" }, svgIcon(ICON.plus, 16, 1.75)), h("span", { class: "sep" }), h("button", { type: "button", id: "zout", "aria-label": "Zoom out" }, svgIcon(ICON.minus, 16, 1.75)))),
    h("div", { class: "legend" }, h("span", {}, h("i", { class: "l-rank" }), "Ranked"), h("span", {}, h("i", { class: "l-pend" }), "One answer away"), h("span", {}, h("i", { class: "l-excl" }), "Excluded")),
    h("div", { class: "attrib", text: online ? "© OpenStreetMap contributors · Protomaps" : "No basemap offline · positions relative · set PMTILES_URL" }));
  const drawer = SELECTED ? drawerFor(d, d.report.sites.find((s) => s.site_id === SELECTED)!) : null;
  const wrap = h("div", { class: "mapwrap" }, map, drawer);
  if (online && sites.length) setTimeout(() => mountMapLibre(map, sites), 0);
  else { map.querySelector<HTMLButtonElement>("#fit")!.addEventListener("click", () => { SELECTED = null; render(); }); }
  return wrap;
}
function loadScript(src: string): Promise<void> {
  return new Promise((res, rej) => {
    if (document.querySelector(`script[src="${src}"]`)) return res();
    const s = document.createElement("script"); s.src = src; s.onload = () => res(); s.onerror = () => rej(new Error(`failed ${src}`)); document.head.append(s);
  });
}
async function mountMapLibre(pane: HTMLElement, sites: Site[]): Promise<void> {
  try {
    if (!document.querySelector('link[href*="maplibre-gl.css"]')) { const css = document.createElement("link"); css.rel = "stylesheet"; css.href = "https://unpkg.com/maplibre-gl@4/dist/maplibre-gl.css"; document.head.append(css); }
    await loadScript("https://unpkg.com/maplibre-gl@4/dist/maplibre-gl.js");
    await loadScript("https://unpkg.com/pmtiles@3/dist/pmtiles.js");
    await loadScript("https://unpkg.com/protomaps-themes-base@4/dist/protomaps-themes-base.js");
    const ml = window.maplibregl, pm = window.pmtiles, themes = window.protomaps_themes_base;
    if (!ml || !pm || !themes) throw new Error("map libraries unavailable");
    if (!(ml as any).__pmtiles) { const protocol = new pm.Protocol(); ml.addProtocol("pmtiles", protocol.tile); (ml as any).__pmtiles = true; }
    const dark = document.body.classList.contains("dark");
    const map = new ml.Map({ container: "map", style: { version: 8, glyphs: "https://protomaps.github.io/basemaps-assets/fonts/{fontstack}/{range}.pbf", sources: { protomaps: { type: "vector", url: `pmtiles://${window.DS_CONFIG!.pmtilesUrl}`, attribution: "© OpenStreetMap contributors · Protomaps" } }, layers: themes.default("protomaps", dark ? "dark" : "light") }, attributionControl: false });
    MAP = map;
    const bounds = new ml.LngLatBounds();
    for (const s of sites.filter((x) => x.in_search_area !== false)) {
      bounds.extend([s.lon!, s.lat!]);
      const kind = s.viable && s.rank !== null ? (s.shared_lot ? "shared" : "rank") : isOneAway(s) || isUnrankedViable(s) ? "pend" : "excl";
      const el = h("button", { type: "button", class: `mk ${kind}`, style: "position:relative;transform:none" }, h("span", { class: "disc" }, kind === "pend" ? svgIcon(ICON.clock, 13) : kind === "excl" ? null : String(s.rank)), kind === "excl" ? null : h("span", { class: "lbl", text: splitAddress(s.address).street.replace(/^\d+\s+/, "") }));
      el.addEventListener("click", () => { SELECTED = s.site_id; render(); });
      new ml.Marker({ element: el, anchor: "left" }).setLngLat([s.lon!, s.lat!]).addTo(map);
    }
    const fit = () => map.fitBounds(bounds, { padding: 60, maxZoom: 13, duration: 0 });
    map.on("load", () => { fit(); pane.classList.add("has-tiles"); });
    map.on("zoomend", () => { if (map.getZoom() < 4 && map.setProjection) map.setProjection({ type: "globe" }); });
    pane.querySelector("#fit")?.addEventListener("click", fit);
    pane.querySelector("#zin")?.addEventListener("click", () => map.zoomIn());
    pane.querySelector("#zout")?.addEventListener("click", () => map.zoomOut());
  } catch (e) { console.warn("map fallback:", e); }
}

// ---- drawer
const FACT_TITLE: Record<string, string> = { zoning_permitted: "Zoning", rent_monthly: "Rent", flood_zone: "Flood", traffic_aadt: "Traffic", drive_minutes: "Drive time", competitor_count: "Competitors", zoning_district: "Zoning district", geocode: "Address", parcel: "Parcel", imagery: "Imagery", office: "Office", vehicle_display: "Display capacity" };
function evidenceTitle(e: Evidence): string {
  const v = (e.value ?? {}) as Record<string, any>;
  switch (e.fact) {
    case "zoning_permitted": return `Zoning ${v.district ?? ""}, dealer ${v.status ?? "unknown"}`.replace("  ", " ");
    case "rent_monthly": return `Rent ${fmtMoney(v.rent_monthly)}/mo${e.method === "email" ? ", written quote" : ""}`;
    case "flood_zone": return v.zone && !["A", "AE", "AH", "AO", "AR", "A99", "V", "VE"].includes(String(v.zone).toUpperCase()) ? `Outside flood zone (${v.zone})` : `Flood zone ${v.zone ?? "?"}`;
    case "traffic_aadt": return `Traffic ${fmtInt(v.aadt)} AADT`;
    case "drive_minutes": return `Drive ${v.minutes} min`;
    case "competitor_count": return `${v.count} competitors nearby`;
    case "zoning_district": return `District ${v.district ?? "?"}, ${v.jurisdiction ?? ""}`;
    case "geocode": return `Geocoded ${Number(v.lat).toFixed(4)}, ${Number(v.lon).toFixed(4)}`;
    case "parcel": return `Parcel ${v.parcel_id ?? ""}${v.acres ? `, ${v.acres} ac` : ""}`;
    case "office": return v.has_office ? "Enclosed office on site" : v.has_office === false ? "No office" : "Office unknown";
    case "vehicle_display": return `Room for ${v.vehicle_capacity ?? "?"} vehicles`;
    default: return e.fact;
  }
}
function evidenceSource(e: Evidence): string {
  if (e.source_url.startsWith("message:")) return String((e.value as any)?.from ?? "email reply");
  if (e.source_url.startsWith("fixture://")) return e.source_url.replace("fixture://", "").split("#")[0]! + " fixture";
  if (isHttp(e.source_url)) return hostOf(e.source_url);
  return e.source_url.split(":")[0]!;
}
const methodLabel = (m: string) => (m === "layer" || m === "layer+use_table" ? "official record" : m === "email" ? "email reply" : m === "listing" ? "listing" : m === "form" ? "official form" : m);
function openLink(url: string): HTMLElement {
  return isHttp(url)
    ? h("a", { class: "open", href: url, target: "_blank", rel: "noopener" }, "Open", svgIcon(ICON.ext, 12, 1.75))
    : h("span", { class: "open disabled", title: url, text: "Stored" });
}
function drawerFor(d: Data, s: Site): HTMLElement {
  const a = splitAddress(s.address);
  const ev = d.report.evidence.filter((e) => e.site_id === s.site_id);
  const runEnd = new Date(`${d.report.run_date}T23:59:59Z`).getTime();
  const gateRow = (gate: "zoning" | "rent" | "flood") => {
    const g = s.gates[gate];
    const e = g.evidence_ids.map((id) => ev.find((x) => x.evidence_id === id)).find((x) => x) ?? ev.find((x) => x.fact === (gate === "zoning" ? "zoning_permitted" : gate === "rent" ? "rent_monthly" : "flood_zone"));
    const daysLeft = e ? dayDiff(e.expires_at, `${d.report.run_date}T00:00:00Z`) : null;
    const soon = daysLeft !== null && daysLeft <= 7;
    const detail = g.detail ?? "";
    return h("div", { class: "evrow" },
      h("div", { style: "min-width:0" },
        h("div", { class: `g gate ${g.status === "pending" && g.warning === "expired" ? "stale" : g.status}` }, gateEl(gate, g, 12), detail ? h("span", { class: "d", text: `· ${detail}` }) : null),
        e
          ? h("div", { class: `src${soon ? " wait" : ""}` }, evidenceSource(e), ` · ${methodLabel(e.method)} · fetched ${fmtDay(e.fetched_at)} · ${new Date(e.expires_at).getTime() <= runEnd ? `expired ${fmtDay(e.expires_at)}` : `expires ${fmtDay(e.expires_at)}${soon ? ", re-fetch queued" : ""}`}`)
          : h("div", { class: "src", text: g.status === "pending" ? "no evidence yet; a case is open or queued" : "no evidence recorded" })),
      e ? openLink(e.source_url) : h("span", { class: "open disabled", text: "–" }));
  };
  const verdict = s.viable
    ? h("div", { class: "verdict" }, h("span", { class: "lead" }, svgIcon(ICON.ok, 14, 2), "Viable. All three gates passed."), h("span", { class: "sc", text: `Score ${score100(s)}` }))
    : failed(s)
    ? h("div", { class: "verdict fail" }, h("span", { class: "lead" }, svgIcon(ICON.x, 14, 2), `Excluded. ${(["zoning", "rent", "flood"] as const).filter((g) => s.gates[g].status === "fail").map((g) => g[0]!.toUpperCase() + g.slice(1)).join(" and ")} failed.`))
    : s.in_search_area === false
    ? h("div", { class: "verdict fail" }, h("span", { class: "lead" }, svgIcon(ICON.x, 14, 2), `Outside the ${d.report.business?.max_drive_minutes ?? 60} minute search area.`))
    : distanceUnknown(s) && s.viable
    ? h("div", { class: "verdict wait" }, h("span", { class: "lead" }, svgIcon(ICON.clock, 14, 2), "Gates passed. Distance unknown, so not ranked yet."), h("span", { class: "sc muted", text: "No rank" }))
    : h("div", { class: "verdict wait" }, h("span", { class: "lead" }, svgIcon(ICON.clock, 14, 2), `Not viable yet. ${pendingGates(s).map((g) => g[0]!.toUpperCase() + g.slice(1)).join(" and ")} pending.`), h("span", { class: "sc muted", text: "No score" }));
  const listingsTxt = (s.listings ?? []).map((l) => `${l.listing_id} ${l.source_id}${l.rent_monthly !== null ? `, ${fmtMoney(l.rent_monthly)}/mo` : ""}`).join(" · ") || s.listing_ids.join(" · ");
  const cases = s.open_cases;
  const drawer = h("div", { class: "drawer", role: "dialog", "aria-label": `Site ${s.parcel_id}` },
    h("div", { class: "dr-head" },
      h("div", {},
        h("div", { class: "dr-title" }, h("span", { class: `disc${s.rank === null ? " muted" : ""}`, text: s.rank === null ? "–" : String(s.rank) }), h("span", { class: "t", text: `${a.street}${a.town ? ", " + a.town : ""}` })),
        h("div", { class: "dr-meta" }, mono(s.parcel_id), ` · ${s.drive_minutes === null ? "distance unknown" : `${s.drive_minutes} min from home base`} · ${s.in_search_area === null ? "search area unknown" : s.in_search_area ? "inside" : "outside"} search area · ${s.shared_lot ? "shared lot" : "standalone lot"}`)),
      h("button", { type: "button", class: "dr-close", "aria-label": "Close", id: "dr-close" }, svgIcon(ICON.x, 16, 1.75))),
    h("div", { class: "dr-body" },
      h("div", { class: "dr-photos" }, photoSlot(s, "street", "Street photo"), photoSlot(s, "aerial", "Aerial")),
      verdict,
      h("div", {}, h("div", { class: "eyebrow", style: "margin-bottom:6px", text: "Gates and evidence" }), gateRow("zoning"), gateRow("rent"), gateRow("flood")),
      s.in_search_area !== false ? h("div", {}, h("div", { class: "eyebrow", style: "margin-bottom:8px", text: s.rank === 1 ? "Why it ranks first" : s.viable ? `Why it ranks ${s.rank}` : "Score factors (not scored until viable)" }), bars(s, true)) : null,
      h("div", {}, h("div", { class: "eyebrow", style: "margin-bottom:6px", text: `Merged from ${plural(s.listing_ids.length, "listing")}` }), h("div", { class: "dr-text", text: listingsTxt })),
      h("div", {}, h("div", { class: "eyebrow", style: "margin-bottom:6px", text: "Open cases" }),
        cases.length
          ? h("div", { class: "dr-text" }, ...cases.map((c) => h("div", {}, `${caseTypeLabel(c.case_type)} → ${c.recipient === "none" ? "no contact published" : c.recipient} · ${c.status.replace("_", " ")}${c.next_action ? ` · ${c.next_action}` : ""}`)))
          : h("div", { class: "dr-text", text: "None. Every gate was answered by public records, a listing or a reply." }))));
  drawer.querySelector("#dr-close")!.addEventListener("click", () => { SELECTED = null; render(); });
  return drawer;
}

// ------------------------------------------------------------------ pipeline
function viewPipeline(d: Data): HTMLElement[] {
  const r = d.report, sites = r.sites;
  const listings = sites.reduce((a, s) => a + s.listing_ids.length, 0);
  const unresolved = (r.exceptions ?? []).filter((e) => /^Listing .* unresolved/.test(e)).length;
  const sourcesOk = (r.sources ?? []).filter((s) => s.last_status === "ok").length;
  const inArea = sites.filter((s) => s.in_search_area !== false).length;
  const verifying = sites.filter((s) => isOneAway(s) || isUnrankedViable(s)).length;
  const viable = sites.filter((s) => s.viable && s.rank !== null).length;
  const outside = sites.filter((s) => s.in_search_area === false).length, failedN = sites.filter((s) => s.in_search_area !== false && failed(s)).length;
  const stage = (n: number, l: string, dsc: string, i: number) => h("div", { class: `stage s${i}` }, h("div", { class: "l", text: l }), h("div", { class: "n", text: String(n) }), h("div", { class: "d", text: dsc }));
  const stages = h("div", { class: "stages" },
    stage(listings + unresolved, "Discovered", `listings from ${plural(sourcesOk, "source")}`, 1),
    stage(sites.length, "Resolved", "sites after merging", 2),
    stage(inArea, "Enriched", "in search area", 3),
    stage(verifying, "Verifying", "waiting on email", 4),
    stage(viable, "Scored", "viable, ranked", 5),
    stage(outside + failedN, "Excluded", `${outside} outside area, ${failedN} failed a gate`, 6));
  const stageOf = (s: Site): [string, number] => (s.viable && s.rank !== null ? ["Scored", 5] : s.in_search_area === false || failed(s) ? ["Excluded", 6] : isOneAway(s) || isUnrankedViable(s) ? ["Verifying", 4] : s.stage === "resolved" ? ["Resolved", 2] : ["Enriched", 3]);
  const outcome = (s: Site): [string, string] => {
    if (s.viable && s.rank !== null) return s.shared_lot ? [`Rank ${s.rank}, ranks last`, "muted"] : [`Rank ${s.rank}, score ${score100(s)}`, ""];
    if (distanceUnknown(s)) return ["Distance unknown", "wait"];
    if (s.in_search_area === false) return [`Outside ${r.business?.max_drive_minutes ?? 60} min`, "fail"];
    if (s.gates.rent.status === "fail") return [`Rent ${fmtMoney(s.metrics.rent_monthly)} ${s.metrics.rent_monthly !== null && r.business && s.metrics.rent_monthly > r.business.rent_max ? "over" : "outside"} budget`, "fail"];
    if (s.gates.zoning.status === "fail") return [s.gates.zoning.detail ? s.gates.zoning.detail.replace(/^use prohibited in /, "") + " does not permit dealer" : "Zoning prohibits dealer", "fail"];
    if (s.gates.flood.status === "fail") return [`Flood zone ${String((d.report.evidence.find((e) => e.site_id === s.site_id && e.fact === "flood_zone")?.value as any)?.zone ?? "")}`.trim(), "fail"];
    return [pendingGates(s).length === 1 ? "One answer away" : `${pendingGates(s).length} answers away`, "wait"];
  };
  const order = [...sites].sort((a, b) => stageOf(b)[1] - stageOf(a)[1] === 0 ? (a.rank ?? 99) - (b.rank ?? 99) : (stageOf(a)[1] === 5 ? -1 : stageOf(b)[1] === 5 ? 1 : stageOf(b)[1] - stageOf(a)[1]));
  const rows = order.map((s) => {
    const [stg, si] = stageOf(s);
    const [otxt, ocls] = outcome(s);
    const a = splitAddress(s.address);
    const answered = s.open_cases.length ? "" : (d.report.evidence.some((e) => e.site_id === s.site_id && e.method === "email") ? ` · ${plural(d.report.evidence.filter((e) => e.site_id === s.site_id && e.method === "email").length, "case")} answered` : "");
    const open = s.open_cases.filter((c) => c.status !== "resolved").length;
    return h("div", { class: "trow cols-sites" },
      h("span", { class: "tc-parcel", text: s.parcel_id }),
      h("div", { class: "tc-site" }, h("div", { class: "a", text: `${a.street}${a.town ? ", " + a.town : ""}` }), h("div", { class: "s", text: `${plural(s.listing_ids.length, "listing")} · ${s.drive_minutes ?? "–"} min${open ? ` · ${plural(open, "case")} open` : answered}${s.shared_lot ? " · shared lot" : ""}` })),
      h("span", { class: "stagedot" }, h("i", { class: `st${si}` }), h("span", { text: stg })),
      h("div", { class: "tc-gates" }, ...(s.in_search_area !== false ? (["zoning", "rent", "flood"] as const).map((g) => gatePill(g, s.gates[g], true)) : [h("span", { class: "tc-plain", text: "Not checked" })])),
      h("span", { class: `outcome ${ocls}`, text: otxt }));
  });
  const paused = !!r.sending_paused;
  const allCases = sites.flatMap((s) => s.open_cases.map((c) => ({ s, c })));
  const resolvedFromMsgs = d.messages.length && allCases.length === 0;
  const caseRows = allCases.sort((x, y) => (x.c.opened_at ?? "").localeCompare(y.c.opened_at ?? "")).map(({ s, c }) => {
    const age = c.opened_at ? dayDiff(`${r.run_date}T23:59:59Z`, c.opened_at) : null;
    const sent = d.messages.filter((m) => m.site_id === s.site_id && m.case_type === c.case_type).length + (c.followups_sent ?? 0) + (c.last_contacted_at && !d.messages.some((m) => m.site_id === s.site_id && m.case_type === c.case_type) ? 1 : 0);
    return h("div", { class: "caserow" },
      h("div", { style: "min-width:0" },
        h("div", { class: "t" }, `${splitAddress(s.address).street}${splitAddress(s.address).town ? ", " + splitAddress(s.address).town : ""} · ${caseTypeLabel(c.case_type)}`),
        h("div", { class: "m first" }, `To ${c.recipient === "none" ? "no published contact" : c.recipient}`),
        h("div", { class: "m" }, `Opened ${fmtDay(c.opened_at)} · `, h("span", { class: "age", text: age === null ? "–" : `${age} d` }), ` · ${plural(Math.max(sent, c.status === "open" ? 0 : 1), "email")} sent`),
        h("div", { class: "next" }, "Next: ", c.next_action ?? "–", c.next_action_at ? ` (${fmtDay(c.next_action_at)})` : "")),
      statusPill(c, paused));
  });
  const mails = d.messages.map((m) => {
    const s = sites.find((x) => x.site_id === m.site_id);
    return h("div", { class: "mailrow" }, h("span", { class: "tm", text: fmtTimeET(m.sent_at) }),
      h("div", { style: "min-width:0" }, h("div", { class: "subj", text: m.subject.replace(/\s*\[DS-[A-Z0-9]+\]\s*$/, "") }), h("div", { class: "to" }, `To ${m.to} · ${/followup/.test(m.template_id) ? "follow-up" : "new case"}${s ? ` · ${s.parcel_id}` : ""}`)));
  });
  return [h("div", { class: "page" }, h("div", { class: "pl" },
    h("div", { class: "colgap" },
      h("div", {}, h("div", { class: "h-row" }, h("h1", { class: "pt", text: "Where every site sits" }), h("span", { class: "s", text: `${listings + unresolved} listings merged into ${plural(sites.length, "site")} this run` })), stages),
      h("div", { class: "tbl" }, h("div", { class: "trow-h cols-sites" }, h("span", { text: "Parcel" }), h("span", { text: "Site" }), h("span", { text: "Stage" }), h("span", { text: "Gates" }), h("span", { class: "right", text: "Outcome" })), ...rows)),
    h("div", { class: "colgap tight" },
      h("div", { class: "sect-h" }, h("div", { class: "ht", text: "Open cases" }), h("span", { class: "s", text: "Silence is not approval. Follow-ups are automatic." })),
      caseRows.length ? h("div", { class: "tbl" }, ...caseRows) : h("div", { class: "dashed", text: resolvedFromMsgs ? "None open. Every inquiry sent this run was answered." : "None open." }),
      h("div", { class: "ht", style: "margin-top:8px", text: "Emails sent today" }),
      mails.length ? h("div", { class: "tbl" }, ...mails) : h("div", { class: "dashed", text: "No emails went out this run." }))))];
}

// ------------------------------------------------------------------ exceptions
function viewExceptions(d: Data): HTMLElement[] {
  const r = d.report, run = d.run;
  const paused = !!r.sending_paused;
  const held = r.sites.reduce((a, s) => a + s.open_cases.filter((c) => c.status === "open" || c.status === "awaiting_reply").length, 0);
  const waiting = r.sites.filter(isOneAway).length;
  const top = paused
    ? h("div", { class: "paused-card" }, h("span", { class: "disc" }, svgIcon(ICON.pause, 22, 1.75)),
        h("div", {}, h("div", { class: "h", text: `Email sending paused since ${fmtTimeET(run?.finished_at)} ET today.` }), h("div", { class: "p", text: `${r.pause_reason ?? "Paused."} Runs continue and records still update. No outreach or follow-ups go out until the cause is cleared and the pipeline re-runs.` })),
        h("div", { class: "r" }, h("div", { text: plural(waiting, "case") + " waiting" }), h("div", { text: plural(held, "follow-up") + " held" })))
    : h("div", { class: "paused-card ok" }, h("span", { class: "disc" }, svgIcon(ICON.ok, 22, 1.75)),
        h("div", {}, h("div", { class: "h", text: "Email sending is on." }), h("div", { class: "p", text: `${plural(d.messages.length, "email")} went out this run. Follow-ups are automatic; a bounce rate over ${5}% or a mail quota error pauses sending.` })),
        h("div", { class: "r" }, h("div", { text: plural(waiting, "case") + " waiting" }), h("div", { text: plural(held, "follow-up") + " scheduled" })));
  const dur = run ? Math.max(0, Math.round((new Date(run.finished_at).getTime() - new Date(run.started_at).getTime()) / 1000)) : null;
  const failedRuns = run && run.errors.length
    ? h("div", { class: "tbl" }, ...run.errors.map((e) => h("div", { class: "xrow" }, h("div", {}, h("div", { class: "t", text: e.split(":")[0]! }), h("div", { class: "s", text: e })), h("span", { class: "pill fail", text: "Failed" }))))
    : h("div", { class: "dashed", text: `None. This run finished in ${dur === null ? "–" : dur >= 60 ? `${Math.floor(dur / 60)}m ${dur % 60}s` : `${dur}s`}. Only the current report is available here.` });
  const warnings = [...(run?.warnings ?? [])];
  const providerRows = [
    ...warnings.map((w) => h("div", { class: "xrow" }, h("div", {}, h("div", { class: "t", text: w.split("(")[0]!.trim() }), h("div", { class: "s", text: w })), h("span", { class: "pill wait", text: "Fell back" }))),
    ...(r.offline ? [h("div", { class: "xrow" }, h("div", {}, h("div", { class: "t", text: "Offline run: every layer read fixtures" }), h("div", { class: "s", text: `${(r.fixture_layers ?? []).join(", ")}. No external host was contacted.` })), h("span", { class: "pill wait", text: "Fixtures" }))] : []),
  ];
  const providerErrors = providerRows.length ? h("div", { class: "tbl" }, ...providerRows) : h("div", { class: "dashed", text: "None. Every provider answered." });
  const sources = r.sources ?? [];
  const srcRows = sources
    .filter((s) => s.last_status === "error" || s.terms_status === "prohibited" || s.robots_txt === "disallowed" || s.terms_status === "unclear" || s.last_status === "ok")
    .sort((a, b) => rankSrc(a) - rankSrc(b))
    .map((s) => {
      const excluded = s.terms_status === "prohibited" || s.robots_txt === "disallowed";
      const grey = s.terms_status === "unclear";
      const pill = s.last_status === "error" ? h("span", { class: "pill fail", text: "Failed today" }) : excluded ? h("span", { class: "pill off", text: "Excluded by terms" }) : grey ? h("span", { class: "pill off", text: "Not yet allowed" }) : h("span", { class: "pill ok", text: "OK" });
      const txt = s.last_status === "error" ? s.last_error ?? "fetch failed" : excluded ? (s.notes ?? "Terms of service prohibit automated collection. Never fetched.") : grey ? (s.notes ?? "Terms unclear; the PM must flip it to allowed before it is fetched.") : `${s.kind} source · fetched this run`;
      return h("div", { class: "xrow" }, h("div", {}, h("div", { class: "t", text: s.id }), h("div", { class: "s", text: txt })), pill);
    });
  const runEnd = new Date(`${r.run_date}T23:59:59Z`).getTime();
  const evSorted = [...r.evidence].filter((e) => !["geocode", "parcel", "imagery", "drive_minutes", "competitor_count", "zoning_district"].includes(e.fact)).sort((a, b) => a.expires_at.localeCompare(b.expires_at));
  const expired = evSorted.filter((e) => new Date(e.expires_at).getTime() <= runEnd);
  const expiring = evSorted.filter((e) => { const t = new Date(e.expires_at).getTime(); return t > runEnd && t <= runEnd + 7 * 86_400_000; });
  const show = [...expired, ...expiring, ...evSorted.filter((e) => !expired.includes(e) && !expiring.includes(e))].slice(0, Math.max(6, expired.length + expiring.length));
  const evRows = show.map((e) => {
    const t = new Date(e.expires_at).getTime();
    const isExp = t <= runEnd, isSoon = !isExp && t <= runEnd + 7 * 86_400_000;
    const site = r.sites.find((s) => s.site_id === e.site_id);
    const tag = isExp ? h("span", { class: "pill off tag", text: "Expired" }) : isSoon ? h("span", { class: "pill wait tag", text: `Expires in ${dayDiff(e.expires_at, `${r.run_date}T00:00:00Z`)} d` }) : h("span", { class: "pill ok tag", text: "Fresh" });
    return h("div", { class: `evx${isExp ? " stale" : ""}` },
      h("div", { style: "min-width:0" },
        h("div", { class: "t" }, h("span", { class: "n", text: evidenceTitle(e) }), tag),
        h("div", { class: "s", text: `${site ? splitAddress(site.address).street : e.site_id} · ${evidenceSource(e)} · ${methodLabel(e.method)} · fetched ${fmtDay(e.fetched_at)} · expires ${fmtDay(e.expires_at)}` })),
      openLink(e.source_url));
  });
  const sec = (title: string, sub: string, body: HTMLElement) => h("div", {}, h("div", { class: "sect-h" }, h("div", { class: "ht", text: title }), h("span", { class: "s", text: sub })), body);
  return [h("div", { class: "page" }, h("div", { class: "colgap" }, top,
    h("div", { class: "ex" },
      h("div", { class: "colgap" },
        sec("Failed runs", "This report", failedRuns),
        sec("Provider errors", "This run", providerErrors),
        sec("Sources failed or excluded", "Excluded sources are never fetched", srcRows.length ? h("div", { class: "tbl" }, ...srcRows) : h("div", { class: "dashed", text: "No sources configured." }))),
      h("div", { class: "colgap tight" },
        sec("Evidence expiring or expired", "Expired facts are re-fetched next run; until then the gate reads stale", evRows.length ? h("div", { class: "tbl" }, ...evRows) : h("div", { class: "dashed", text: "No evidence recorded." }))))))];
}
function rankSrc(s: SourceRow): number { return s.last_status === "error" ? 0 : s.terms_status === "prohibited" || s.robots_txt === "disallowed" ? 1 : s.terms_status === "unclear" ? 2 : 3; }

// ------------------------------------------------------------------ configuration
const PROV: Record<string, { kind: string; name: string; sub: string; fallback: string }> = {
  census: { kind: "Geocoding", name: "Census Geocoder", sub: "US Census Bureau, free, no key", fallback: "Nominatim (self-hosted)" },
  nominatim: { kind: "Geocoding", name: "Nominatim (self-hosted)", sub: "OpenStreetMap data on your own server", fallback: "Census Geocoder" },
  google: { kind: "", name: "Google Maps Platform", sub: "paid", fallback: "" },
  nc_onemap: { kind: "Parcels", name: "NC OneMap parcels", sub: "statewide parcel layer, ArcGIS REST", fallback: "County GIS" },
  county: { kind: "Parcels", name: "County GIS parcels", sub: "per-county ArcGIS services", fallback: "NC OneMap" },
  regrid: { kind: "Parcels", name: "Regrid", sub: "paid parcel API", fallback: "" },
  arcgis: { kind: "Zoning", name: "Town GIS layers", sub: "", fallback: "Email to planning office" },
  ors: { kind: "Drive time", name: "OpenRouteService", sub: "free tier key", fallback: "Valhalla (self-hosted)" },
  valhalla: { kind: "Drive time", name: "Valhalla (self-hosted)", sub: "OSM routing on your own server", fallback: "OpenRouteService" },
  ncdot: { kind: "Traffic", name: "NCDOT AADT", sub: "annual average daily traffic stations", fallback: "None" },
  fema: { kind: "Flood", name: "FEMA NFHL", sub: "National Flood Hazard Layer", fallback: "None" },
  mapillary: { kind: "Street photos", name: "Mapillary", sub: "nearest capture within 60 m", fallback: "Google Street View Static (paid)" },
  streetview: { kind: "Street photos", name: "Google Street View Static", sub: "paid", fallback: "Mapillary" },
  overpass: { kind: "Competitors", name: "OpenStreetMap Overpass", sub: "shop=car within the configured radius", fallback: "Google Places (paid)" },
  places: { kind: "Competitors", name: "Google Places", sub: "paid", fallback: "Overpass" },
  fetch: { kind: "Listings", name: "Plain fetch", sub: "Node fetch, robots.txt honoured, nothing to host; allowlist in sources.yaml", fallback: "AnyCrawl (self-hosted)" },
  anycrawl: { kind: "Listings", name: "AnyCrawl (self-hosted)", sub: "robots.txt honoured; allowlist in sources.yaml", fallback: "Plain fetch" },
  anycrawl_cloud: { kind: "Listings", name: "AnyCrawl cloud", sub: "paid", fallback: "AnyCrawl (self-hosted)" },
  reddit: { kind: "Social", name: "Reddit Data API", sub: "official OAuth API, free tier", fallback: "None" },
  gmail: { kind: "Email", name: "Gmail API", sub: "OAuth, owner or operator mailbox", fallback: "None" },
  rules: { kind: "Extraction", name: "Deterministic rules", sub: "regex extraction and reply classification", fallback: "Claude via scheduled agent" },
  claude_agent: { kind: "Extraction", name: "Claude via scheduled agent", sub: "rules plus a review queue for the routine", fallback: "Deterministic rules" },
  claude_api: { kind: "Extraction", name: "Claude API", sub: "paid", fallback: "Deterministic rules" },
  protomaps: { kind: "Map tiles", name: "Protomaps PMTiles", sub: "self-hosted archive", fallback: "Mapbox (paid)" },
  mapbox: { kind: "Map tiles", name: "Mapbox", sub: "paid", fallback: "Protomaps" },
};
const PAID_IDS = new Set(["google", "regrid", "streetview", "places", "anycrawl_cloud", "mapbox", "claude_api"]);
const LAYER_ORDER = ["geocoder", "parcels", "zoning", "flood", "traffic", "drivetime", "poi", "crawler", "social", "mail", "imagery", "llm", "tiles"];
function viewConfig(d: Data): HTMLElement[] {
  const r = d.report, b = r.business, run = d.run;
  const krow = (k: string, v: string, s: string) => h("div", { class: "krow" }, h("span", { class: "k", text: k }), h("div", {}, h("div", { class: "v", text: v }), h("div", { class: "s", text: s })));
  const params = h("div", { class: "tbl" },
    krow("Home base", b?.home_base ?? "–", b?.home_base === "Greenville, NC 27858" ? "Drive times are measured from here. Dev placeholder until DEALERSOURCE_HOME_BASE is set at deploy." : "Drive times are measured from here"),
    krow("Maximum drive", b ? `${b.max_drive_minutes} minutes` : "–", "Sites beyond this are excluded before any gate runs"),
    krow("Rent range", b ? `$${b.rent_min.toLocaleString("en-US")} to $${b.rent_max.toLocaleString("en-US")} a month` : "–", "Written figure required: a listing page, an email reply or an official form"),
    krow("Shared lots", b ? (b.shared_lot === "last_resort" ? "Last resort" : b.shared_lot === "exclude" ? "Excluded" : "Allowed") : "–", b?.shared_lot === "exclude" ? "Space on another business is never viable" : "Space on another business is checked but always ranks below standalone sites"),
    krow("Flood zones", b ? `${(b.flood_high_risk_zones ?? []).join(", ")} excluded` : "–", "Zones X and shaded X pass; majority of parcel area is also checked"),
    krow("Site checks", b ? `Office ${b.office_required ? "required" : "optional"}, ${b.min_vehicle_display ?? "–"}+ display vehicles` : "–", "NC established place of business; unknowns are flagged, not excluded"),
    krow("Follow-ups", b ? `${b.max_followups ?? "–"} per case, ${b.followup_days ?? "–"} days apart` : "–", "Never the same address about the same site twice inside the window; then escalated to a human"),
    krow("Score weights", b ? Object.entries(b.weights).map(([k, v]) => `${labelFor(k).toLowerCase()} ${Math.round(v * 100)}`).join(", ") : "–", "Relative weights, importance order left to right"));
  const dur = run ? Math.max(0, Math.round((new Date(run.finished_at).getTime() - new Date(run.started_at).getTime()) / 1000)) : null;
  const listings = r.sites.reduce((a, s) => a + s.listing_ids.length, 0);
  const rrow = (k: string, v: string) => h("div", { class: "krow run" }, h("span", { class: "k", text: k }), h("span", { class: "mv", text: v }));
  const lastRun = h("div", { class: "tbl" },
    rrow("Started", fmtStampET(run?.started_at)),
    rrow("Duration", dur === null ? "–" : dur >= 60 ? `${Math.floor(dur / 60)}m ${dur % 60}s` : `${dur}s`),
    rrow("Listings fetched", `${listings} from ${plural((r.sources ?? []).filter((s) => s.last_status === "ok").length, "source")}`),
    rrow("Emails sent", `${d.messages.length} · ${run?.counts?.["verify.inbound_ingested"] ?? 0} replies read`),
    rrow("Errors", `${run?.errors.length ?? 0} · ${plural(run?.warnings?.length ?? 0, "provider warning")}`),
    rrow("Mode", r.offline ? "offline, fixture data" : "online"),
    rrow("Report", `report.json · ${r.run_id}`));
  const paidOn = LAYER_ORDER.filter((l) => PAID_IDS.has(String(r.providers[l])));
  const provRows = LAYER_ORDER.map((layer) => {
    const id = String(r.providers[layer]);
    const p = PROV[id] ?? { kind: layer, name: id, sub: "", fallback: "None" };
    const kind = p.kind || (layer === "geocoder" ? "Geocoding" : layer);
    const paid = PAID_IDS.has(id);
    const fixture = (r.fixture_layers ?? []).includes(layer);
    const sub = layer === "zoning" ? "Greenville, Winterville, Ayden, Washington + use tables" : p.sub;
    return h("div", { class: "trow prov cols-prov" },
      h("span", { class: "muted", text: kind }),
      h("div", { style: "min-width:0" }, h("div", { class: "pname", text: p.name }), h("div", { class: "psub", text: sub })),
      h("span", { class: "pfall", text: p.fallback || "None" }),
      h("span", { class: `pill center ${paid ? "wait" : "ok"}`, text: paid ? "Paid" : "Free" }),
      h("span", { class: `pstat ${fixture ? "wait" : "ok"}`, text: fixture ? (r.offline ? "Fixture data" : "Fell back to fixtures") : "OK" }));
  });
  provRows.push(h("div", { class: "trow prov cols-prov" },
    h("span", { class: "muted", text: "Paid providers" }),
    h("div", { style: "min-width:0" }, h("div", { class: "pname", text: paidOn.length ? paidOn.map((l) => PROV[String(r.providers[l])]?.name ?? l).join(", ") : "None enabled" }), h("div", { class: "psub", text: "Google Maps Platform, Regrid, Street View Static, Places, AnyCrawl cloud, Claude API, Mapbox available" })),
    h("span", { class: "pfall", text: "" }),
    h("span", { class: `pill center ${paidOn.length ? "wait" : "off"}`, text: paidOn.length ? "Paid" : "Off" }),
    h("span", { class: `pstat ${paidOn.length ? "wait" : "muted"}`, text: paidOn.length ? "On" : "Off" })));
  return [h("div", { class: "page" }, h("div", { class: "cf" },
    h("div", { class: "colgap" },
      h("div", {}, h("h1", { class: "pt", style: "margin-bottom:4px", text: "What the search is looking for" }), h("div", { class: "s", style: "font-size:12.5px;color:var(--muted-foreground)", text: "Set in business.yaml and providers.yaml. Changes take effect on the next run. Nothing here is editable from the dashboard." })),
      params,
      h("div", {}, h("div", { class: "ht", style: "margin-bottom:8px", text: "Last run" }), lastRun)),
    h("div", { class: "colgap tight" },
      h("div", { class: "sect-h" }, h("div", { class: "ht", text: "Data providers" }),
        h("span", { style: "display:inline-flex;align-items:center;gap:6px;font-size:12.5px;color:var(--muted-foreground)" }, h("span", { class: `pill ${paidOn.length ? "wait" : "ok"}`, text: paidOn.length ? "Paid" : "Free" }), paidOn.length ? `${plural(paidOn.length, "paid provider")} on.` : `All ${LAYER_ORDER.length} kinds run on free sources. No paid provider is on.`)),
      h("div", { class: "tbl" }, h("div", { class: "trow-h cols-prov" }, h("span", { text: "Kind" }), h("span", { text: "In use" }), h("span", { text: "Fallback" }), h("span", { text: "Cost" }), h("span", { class: "right", text: "Status this run" })), ...provRows),
      h("div", { class: "fine", text: 'A paid provider, when switched on in providers.yaml with paid_enabled: true, shows here as "Paid" and every call it makes is logged with its cost class in run.json.' }))))];
}

// ------------------------------------------------------------------ render
function render(): void {
  if (!DATA) return;
  const app = document.getElementById("app")!;
  const view = currentView();
  app.classList.toggle("has-banner", view === "shortlist");
  document.title = `dealersource ${view === "config" ? "Configuration" : view[0]!.toUpperCase() + view.slice(1)}`;
  const nodes = view === "pipeline" ? viewPipeline(DATA) : view === "exceptions" ? viewExceptions(DATA) : view === "config" ? viewConfig(DATA) : viewShortlist(DATA);
  app.replaceChildren(header(DATA), ...nodes);
}
function initTheme(): void {
  const q = new URLSearchParams(location.search).get("theme");
  const dark = q === "dark" || (q !== "light" && matchMedia("(prefers-color-scheme: dark)").matches);
  document.body.classList.toggle("dark", dark);
  document.getElementById("app")?.classList.toggle("dark", dark);
  if (!q) matchMedia("(prefers-color-scheme: dark)").addEventListener("change", (e) => { document.body.classList.toggle("dark", e.matches); document.getElementById("app")?.classList.toggle("dark", e.matches); });
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
    const rows = await fetchJson<Array<{ payload: Report; messages: Message[]; created_at: string }>>(`${base}/reports?select=payload,messages,created_at&order=created_at.desc,id.desc&limit=1`, { headers });
    if (rows && rows[0]) {
      const runs = await fetchJson<Run[]>(`${base}/runs?select=*&order=started_at.desc,id.desc&limit=1`, { headers });
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
window.addEventListener("hashchange", render);
matchMedia("(max-width: 720px)").addEventListener("change", render);
loadData().then((d) => { DATA = d; render(); }).catch((e) => {
  document.getElementById("app")!.replaceChildren(h("div", { class: "page" }, h("div", { class: "errcard" }, h("span", { class: "ico" }, svgIcon(ICON.failed, 16, 1.75)), h("div", {}, h("div", { class: "h", text: "Report did not load." }), h("div", { class: "s", text: String(e instanceof Error ? e.message : e) })))));
});
