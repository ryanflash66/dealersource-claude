/**
 * Tooltips for any element with a data-tip attribute. One delegated listener
 * set on the document and one reusable bubble on <body>, so tips keep working
 * after render() rebuilds the page. Mouse: hover (short delay). Keyboard: focus.
 * Touch: tapping a tip that is not inside a control shows it for a few seconds.
 * data-trunc elements show their own text, only while it is cut off by an ellipsis.
 */
import { placeTip } from "./place.js";

const TIP_ID = "ds-tip";
const SHOW_DELAY = 350;
const TOUCH_MS = 3500;
let bubble: HTMLDivElement | null = null;
let text: HTMLSpanElement | null = null;
let arrow: HTMLElement | null = null;
let current: HTMLElement | null = null;
let showTimer = 0, touchTimer = 0;

const tipOf = (n: EventTarget | null): HTMLElement | null => (n instanceof Element ? n.closest<HTMLElement>("[data-tip], [data-trunc]") : null);
const tipText = (el: HTMLElement): string | null =>
  el.dataset.tip ?? (el.scrollWidth > el.clientWidth + 1 ? el.textContent : null);
const inControl = (el: HTMLElement) => !!el.closest("a, button, [role='button'], input, select, textarea");

function show(el: HTMLElement): void {
  if (!bubble || !text || !arrow) return;
  const tip = tipText(el);
  if (!tip) return;
  if (current && current !== el) current.removeAttribute("aria-describedby");
  current = el;
  text.textContent = tip;
  bubble.hidden = false;
  const r = el.getBoundingClientRect();
  const b = bubble.getBoundingClientRect();
  const p = placeTip({ top: r.top, left: r.left, width: r.width, height: r.height }, { width: b.width, height: b.height }, { width: innerWidth, height: innerHeight });
  bubble.style.top = `${Math.round(p.top)}px`;
  bubble.style.left = `${Math.round(p.left)}px`;
  bubble.dataset.side = p.side;
  arrow.style.left = `${Math.round(p.arrow ?? 0)}px`;
  el.setAttribute("aria-describedby", TIP_ID);
}

export function hideTip(): void {
  clearTimeout(showTimer);
  clearTimeout(touchTimer);
  if (current?.getAttribute("aria-describedby") === TIP_ID) current.removeAttribute("aria-describedby");
  current = null;
  if (bubble) bubble.hidden = true;
}

export function initTooltips(): void {
  if (bubble) return;
  bubble = document.createElement("div");
  bubble.className = "ds-tip";
  bubble.id = TIP_ID;
  bubble.setAttribute("role", "tooltip");
  bubble.hidden = true;
  text = document.createElement("span");
  arrow = document.createElement("i");
  arrow.className = "ds-tip-arrow";
  bubble.append(text, arrow);
  document.body.append(bubble);

  document.addEventListener("pointerover", (e) => {
    if (e.pointerType === "touch") return;
    const el = tipOf(e.target);
    if (!el || el === current) return;
    clearTimeout(showTimer);
    showTimer = window.setTimeout(() => show(el), current ? 0 : SHOW_DELAY);
  });
  document.addEventListener("pointerout", (e) => {
    if (e.pointerType === "touch") return;
    const from = tipOf(e.target), to = tipOf(e.relatedTarget);
    if (from && from !== to) hideTip();
  });
  document.addEventListener("focusin", (e) => {
    const el = tipOf(e.target);
    if (el && el === e.target && el.matches(":focus-visible")) show(el);
  });
  document.addEventListener("focusout", (e) => { if (tipOf(e.target) === current) hideTip(); });
  document.addEventListener("pointerup", (e) => {
    if (e.pointerType !== "touch") return;
    const el = tipOf(e.target);
    if (!el || inControl(el)) { hideTip(); return; }
    show(el);
    clearTimeout(touchTimer);
    touchTimer = window.setTimeout(hideTip, TOUCH_MS);
  });
  document.addEventListener("keydown", (e) => { if (e.key === "Escape" && current) hideTip(); });
  window.addEventListener("scroll", hideTip, { passive: true, capture: true });
  window.addEventListener("resize", hideTip);
  window.addEventListener("ds:render", () => { if (current && !current.isConnected) hideTip(); });
}
