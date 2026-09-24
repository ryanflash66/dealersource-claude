/**
 * First-run guided tour: floating cards that point at parts of the page. Some
 * steps ask the user to do something (open a site, open a view) before Next
 * unlocks. The overlay lives on <body>, outside #app, and re-finds its target
 * after every render; app.ts reports renders, site selections and view changes
 * with window events. A scrim with a hole over the target keeps clicks on the
 * step. Content and rules are in tour-steps.ts.
 */
import { MARGIN, holePath, placeCard, sheetDock, visiblePart, type Rect } from "./place.js";
import { EV_RENDER, EV_SELECT, EV_VIEW, STEPS, TOUR_KEY, TOUR_VERSION, allowedViews, autoStart, textOf, type TourFacts, type TourStep, type View } from "./tour-steps.js";
import { hideTip } from "./tooltip.js";

export interface TourHost { facts(): TourFacts; go(view: View): void }
export interface Tour { maybeAutoStart(): void; start(from?: number, returnFocus?: Element | null): void; active(): boolean }

const SVG_NS = "http://www.w3.org/2000/svg";
const HOLE_PAD = 6;
const reduced = () => matchMedia("(prefers-reduced-motion: reduce)").matches;

export function initTour(host: TourHost): Tour {
  let idx = -1;
  let done = new Set<string>();
  let waived = new Set<string>();       // action steps whose target was not on the page
  let pendingView: View | null = null;  // navigation the tour started, not rendered yet
  let needScroll = false;
  let paintedKey = "";                  // target key and state the card was painted for
  let raf = 0;
  let returnTo: Element | null = null;

  const root = document.createElement("div");
  root.className = "tour";
  root.hidden = true;
  const svg = document.createElementNS(SVG_NS, "svg");
  svg.setAttribute("class", "tour-scrim");
  svg.setAttribute("aria-hidden", "true");
  const path = document.createElementNS(SVG_NS, "path");
  path.setAttribute("fill-rule", "evenodd");
  svg.append(path);
  const ring = document.createElement("div");
  ring.className = "tour-ring";
  ring.setAttribute("aria-hidden", "true");
  const card = document.createElement("div");
  card.className = "tour-card";
  card.setAttribute("role", "dialog");
  card.setAttribute("aria-modal", "false");
  card.setAttribute("aria-labelledby", "tour-title");
  card.setAttribute("aria-describedby", "tour-body");
  card.tabIndex = -1;
  root.append(svg, ring, card);
  document.body.append(root);
  path.addEventListener("click", () => nudge());

  const step = (): TourStep | undefined => STEPS[idx];
  const store = (state: "done" | "skipped") => { try { localStorage.setItem(TOUR_KEY, `${state}:${TOUR_VERSION}`); } catch { /* storage unavailable */ } };

  function start(from = 1, focusBack: Element | null = document.activeElement): void {
    if (idx >= 0) { card.focus({ preventScroll: true }); return; }
    returnTo = focusBack;
    done = new Set();
    waived = new Set();
    root.hidden = false;
    document.documentElement.classList.add("touring");
    goTo(from, 1);
  }

  function end(state: "done" | "skipped"): void {
    store(state);
    idx = -1;
    pendingView = null;
    root.hidden = true;
    document.documentElement.classList.remove("touring");
    if (returnTo instanceof HTMLElement && returnTo.isConnected) returnTo.focus({ preventScroll: true });
  }

  function goTo(i: number, dir: 1 | -1): void {
    const f = host.facts();
    while (i >= 0 && i < STEPS.length && STEPS[i]!.skip?.(f)) i += dir;
    if (i >= STEPS.length) { end("done"); return; }
    idx = Math.max(0, i);
    const s = step()!;
    const allowed = allowedViews(s, done.has(s.id));
    pendingView = null;
    if (allowed && !allowed.includes(f.view)) { pendingView = s.view; host.go(s.view!); }
    needScroll = true;
    paintedKey = "";
    hideTip();
    paint(null);
    schedule();
    card.focus({ preventScroll: true });
  }

  function next(): void {
    const s = step();
    if (!s) return;
    if (s.action && !done.has(s.id)) { nudge(); return; }
    if (s.id === "finish") { end("done"); if (host.facts().view !== "shortlist") host.go("shortlist"); return; }
    goTo(idx + 1, 1);
  }

  function complete(): void {
    const s = step();
    if (!s || done.has(s.id)) return;
    done.add(s.id);
    paintedKey = "";
    schedule();
    requestAnimationFrame(() => card.querySelector<HTMLElement>(".tour-next")?.focus({ preventScroll: true }));
  }

  function nudge(): void {
    card.classList.remove("nudge");
    void card.offsetWidth; // restart the animation
    card.classList.add("nudge");
  }

  // ---- drawing -----------------------------------------------------------
  function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls: string, text?: string): HTMLElementTagNameMap[K] {
    const e = document.createElement(tag);
    e.className = cls;
    if (text !== undefined) e.textContent = text;
    return e;
  }
  function button(cls: string, label: string, onClick: () => void): HTMLButtonElement {
    const b = el("button", cls, label);
    b.type = "button";
    b.addEventListener("click", onClick);
    return b;
  }

  /** Card content for the current step; `detached` when the user left the step's page. */
  function paint(detached: View | null): void {
    const s = step();
    if (!s) return;
    const f = host.facts();
    const shown = STEPS.filter((x) => x.id !== "welcome" && !x.skip?.(f));
    const locked = !!s.action && !done.has(s.id);
    const top = el("div", "tour-top");
    top.append(el("span", "tour-count", s.id === "welcome" ? "Quick tour · 2 min" : `${shown.indexOf(s) + 1} of ${shown.length}`));
    const x = button("tour-x", "×", () => end("skipped"));
    x.setAttribute("aria-label", "Close the tour");
    top.append(x);
    const title = el("h2", "tour-title", detached ? "Tour paused" : s.title);
    title.id = "tour-title";
    const body = el("p", "tour-body", detached ? "You left the page this step is about." : textOf(s.body, f));
    body.id = "tour-body";
    const parts: HTMLElement[] = [top, title, body];
    if (s.action && !detached) {
      const hint = el("div", `tour-hint${locked ? "" : " done"}`, locked ? textOf(s.action.hint, f) : waived.has(s.id) ? "Nothing to click here right now. Click Next." : "Done. Click Next.");
      hint.setAttribute("aria-live", "polite");
      parts.push(hint);
    }
    if (s.id !== "welcome") {
      const bar = el("div", "tour-progress");
      bar.setAttribute("aria-hidden", "true");
      bar.append(el("i", ""));
      (bar.firstChild as HTMLElement).style.width = `${Math.round(((shown.indexOf(s) + 1) / shown.length) * 100)}%`;
      parts.splice(1, 0, bar);
    }
    const foot = el("div", "tour-foot");
    const btns = el("div", "tour-btns");
    if (detached) {
      btns.append(button("tour-skip", "End tour", () => end("skipped")), button("btn tour-next", "Back to the tour", () => { pendingView = s.view; host.go(s.view!); }));
    } else {
      if (s.dismiss) btns.append(button("tour-skip", s.dismiss, () => end("skipped")));
      else if (s.id !== "finish") btns.append(button("tour-skip", "Skip", () => end("skipped")));
      if (s.id !== "welcome" && idx > 1) btns.append(button("btn-outline", "Back", () => goTo(idx - 1, -1)));
      const nx = button("btn tour-next", s.next ?? "Next", next);
      if (locked) { nx.setAttribute("aria-disabled", "true"); nx.title = "Do the step above first"; }
      btns.append(nx);
    }
    foot.append(btns);
    card.replaceChildren(...parts, foot, el("i", "tour-arrow"));
    card.dataset.step = s.id;
    card.classList.toggle("action", locked && !detached);
    ring.classList.toggle("pulse", locked && !detached);
  }

  function schedule(): void {
    if (idx < 0 || raf) return;
    raf = requestAnimationFrame(() => { raf = 0; place(); });
  }

  // First key with an element that has a box (display: contents and hidden ones have none),
  // preferring one that is on screen. Off-screen is fine: the step scrolls to it.
  function resolve(keys: string[], vp: { width: number; height: number }): { key: string; node: HTMLElement } | null {
    let fallback: { key: string; node: HTMLElement } | null = null;
    for (const key of keys) {
      for (const node of document.querySelectorAll<HTMLElement>(`[data-tour="${key}"]`)) {
        const r = node.getBoundingClientRect();
        if (r.width <= 0 || r.height <= 0) continue;
        if (visiblePart(r, vp)) return { key, node };
        fallback ??= { key, node };
      }
    }
    return fallback;
  }

  function place(): void {
    const s = step();
    if (!s) return;
    const f = host.facts();
    const vp = { width: innerWidth, height: innerHeight };
    const allowed = allowedViews(s, done.has(s.id));
    const detached = !pendingView && allowed && !allowed.includes(f.view) ? f.view : null;
    const hit = !detached && !pendingView && s.target ? resolve(s.target(f), vp) : null;

    if (s.target && !hit && !detached && !pendingView) {
      // Target not on the page (e.g. no site selected): skip an info step, waive an action.
      if (!s.action) { goTo(idx + 1, 1); return; }
      if (!done.has(s.id)) { done.add(s.id); waived.add(s.id); paintedKey = ""; }
    }
    const stateKey = `${s.id}|${hit?.key ?? "-"}|${detached ?? ""}|${done.has(s.id)}|${f.navOpen}|${f.phone}`;
    if (stateKey !== paintedKey) { paint(detached); paintedKey = stateKey; }

    if (hit && needScroll) {
      needScroll = false;
      const r = hit.node.getBoundingClientRect();
      if (!visiblePart(r, vp) || r.top < 70 || r.bottom > vp.height - 16) {
        hit.node.scrollIntoView({ block: r.height > vp.height * 0.55 || f.phone ? "start" : "center", behavior: reduced() ? "auto" : "smooth" });
      }
    }
    const raw = hit?.node.getBoundingClientRect();
    const hole: Rect | null = raw ? { top: raw.top - HOLE_PAD, left: raw.left - HOLE_PAD, width: raw.width + HOLE_PAD * 2, height: raw.height + HOLE_PAD * 2 } : null;
    svg.setAttribute("viewBox", `0 0 ${vp.width} ${vp.height}`);
    path.setAttribute("d", holePath(vp, hole, 10));
    ring.hidden = !hole;
    if (hole) Object.assign(ring.style, { top: `${hole.top}px`, left: `${hole.left}px`, width: `${hole.width}px`, height: `${hole.height}px` });

    const box = card.getBoundingClientRect();
    if (f.phone) {
      card.dataset.side = "sheet";
      card.dataset.dock = sheetDock(hole ? visiblePart(hole, vp) : null, box.height, vp);
      card.style.top = card.style.left = "";
      document.documentElement.style.setProperty("--tour-sheet-h", `${Math.round(box.height + MARGIN * 2)}px`);
      return;
    }
    delete card.dataset.dock;
    const p = placeCard(hole ? visiblePart(hole, vp) : null, { width: box.width, height: box.height }, vp);
    card.style.top = `${Math.round(p.top)}px`;
    card.style.left = `${Math.round(p.left)}px`;
    card.dataset.side = p.side;
    card.style.setProperty("--arrow", `${Math.round(p.arrow ?? 0)}px`);
  }

  // ---- events --------------------------------------------------------------
  window.addEventListener(EV_RENDER, () => {
    if (pendingView && host.facts().view === pendingView) pendingView = null;
    schedule();
  });
  window.addEventListener(EV_SELECT, (e) => {
    const s = step();
    const d = (e as CustomEvent<{ id: string; source: "card" | "marker" }>).detail;
    if (s?.action?.kind === "select-site" && (!s.action.from || s.action.from === d.source)) complete();
  });
  window.addEventListener(EV_VIEW, (e) => {
    const s = step();
    const v = (e as CustomEvent<{ view: View }>).detail.view;
    if (s?.action?.kind === "view" && s.action.view === v) complete();
    needScroll = true;
  });
  window.addEventListener("resize", schedule);
  window.addEventListener("scroll", schedule, { passive: true, capture: true });
  document.addEventListener("transitionend", schedule, true);
  window.addEventListener("keydown", (e) => {
    if (idx < 0) return;
    if (e.key === "Escape") {
      if (host.facts().navOpen) return; // the drawer closes first
      e.preventDefault();
      e.stopPropagation();
      end("skipped");
      return;
    }
    if (!card.contains(document.activeElement)) return;
    if (e.key === "ArrowRight") { e.preventDefault(); next(); }
    else if (e.key === "ArrowLeft" && idx > 1) { e.preventDefault(); goTo(idx - 1, -1); }
  }, true);

  return {
    maybeAutoStart(): void {
      let stored: string | null | undefined;
      try { stored = localStorage.getItem(TOUR_KEY); } catch { stored = undefined; }
      if (autoStart(location.search, stored) === "off") return;
      const go = () => requestAnimationFrame(() => start(0, null));
      (document.fonts?.ready ?? Promise.resolve()).then(go, go);
    },
    start,
    active: () => idx >= 0,
  };
}
