/**
 * Positioning math for the tour card and tooltips. Pure functions with plain
 * types (no DOM) so the unit tests can run them in node.
 */

export interface Rect { top: number; left: number; width: number; height: number }
export interface Size { width: number; height: number }
export type Side = "right" | "bottom" | "left" | "top";
export interface Placement {
  top: number;
  left: number;
  /** Side of the target the box sits on; "center" when there is no target, "inside" when nothing fits. */
  side: Side | "center" | "inside";
  /** Arrow offset along the box edge facing the target, or null for no arrow. */
  arrow: number | null;
}

export const MARGIN = 12; // keep boxes this far from the viewport edge
const CARD_GAP = 14;      // target to card
const TIP_GAP = 8;        // target to tooltip

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(v, Math.max(lo, hi)));

/** Intersection of a rect with the viewport, or null when it is fully off screen. */
export function visiblePart(r: Rect, vp: Size): Rect | null {
  const top = Math.max(0, r.top), left = Math.max(0, r.left);
  const bottom = Math.min(vp.height, r.top + r.height), right = Math.min(vp.width, r.left + r.width);
  return bottom > top && right > left ? { top, left, width: right - left, height: bottom - top } : null;
}

/**
 * Where to put the tour card: beside the target on the first preferred side that
 * fits, centred on the target along that edge and clamped to the viewport.
 */
export function placeCard(target: Rect | null, card: Size, vp: Size, prefer: Side[] = ["right", "bottom", "left", "top"]): Placement {
  const centred = { top: Math.max(MARGIN, (vp.height - card.height) / 2), left: Math.max(MARGIN, (vp.width - card.width) / 2) };
  if (!target) return { ...centred, side: "center", arrow: null };
  const bottom = target.top + target.height, right = target.left + target.width;
  const cy = target.top + target.height / 2, cx = target.left + target.width / 2;
  const fits: Record<Side, boolean> = {
    right: right + CARD_GAP + card.width <= vp.width - MARGIN,
    left: target.left - CARD_GAP - card.width >= MARGIN,
    bottom: bottom + CARD_GAP + card.height <= vp.height - MARGIN,
    top: target.top - CARD_GAP - card.height >= MARGIN,
  };
  for (const side of prefer) {
    if (!fits[side]) continue;
    if (side === "right" || side === "left") {
      const top = clamp(cy - card.height / 2, MARGIN, vp.height - MARGIN - card.height);
      const left = side === "right" ? right + CARD_GAP : target.left - CARD_GAP - card.width;
      return { top, left, side, arrow: clamp(cy - top, 16, card.height - 16) };
    }
    const left = clamp(cx - card.width / 2, MARGIN, vp.width - MARGIN - card.width);
    const top = side === "bottom" ? bottom + CARD_GAP : target.top - CARD_GAP - card.height;
    return { top, left, side, arrow: clamp(cx - left, 16, card.width - 16) };
  }
  // The target fills the viewport: float the card in the bottom-right corner, over it.
  return { top: Math.max(MARGIN, vp.height - MARGIN - card.height), left: Math.max(MARGIN, vp.width - MARGIN - card.width), side: "inside", arrow: null };
}

/**
 * SVG path for the tour scrim: the whole viewport with a rounded hole over the
 * target. Drawn with fill-rule evenodd, so clicks in the hole reach the page and
 * clicks on the dimmed part do not.
 */
export function holePath(vp: Size, hole: Rect | null, radius = 8): string {
  const outer = `M0 0H${vp.width}V${vp.height}H0Z`;
  if (!hole || hole.width <= 0 || hole.height <= 0) return outer;
  const { top: y, left: x, width: w, height: h } = hole;
  const r = Math.max(0, Math.min(radius, w / 2, h / 2));
  const n = (v: number) => Math.round(v * 10) / 10;
  return `${outer}M${n(x + r)} ${n(y)}H${n(x + w - r)}A${r} ${r} 0 0 1 ${n(x + w)} ${n(y + r)}V${n(y + h - r)}A${r} ${r} 0 0 1 ${n(x + w - r)} ${n(y + h)}H${n(x + r)}A${r} ${r} 0 0 1 ${n(x)} ${n(y + h - r)}V${n(y + r)}A${r} ${r} 0 0 1 ${n(x + r)} ${n(y)}Z`;
}

/** Phone sheet: bottom by default, top when the target would sit under a bottom sheet. */
export function sheetDock(target: Rect | null, sheetHeight: number, vp: Size): "bottom" | "top" {
  if (!target) return "bottom";
  const coveredAtBottom = target.top + target.height > vp.height - sheetHeight - MARGIN * 2;
  const fitsAbove = target.top > sheetHeight + MARGIN * 3;
  return coveredAtBottom && fitsAbove ? "top" : "bottom";
}

/** Where to put a tooltip: above the target, below when there is no room, clamped sideways. */
export function placeTip(target: Rect, tip: Size, vp: Size): Placement {
  const cx = target.left + target.width / 2;
  const above = target.top - TIP_GAP - tip.height;
  const below = target.top + target.height + TIP_GAP;
  const side: Side = above >= MARGIN || below + tip.height > vp.height - MARGIN ? "top" : "bottom";
  const top = side === "top" ? Math.max(MARGIN, above) : below;
  const left = clamp(cx - tip.width / 2, MARGIN, vp.width - MARGIN - tip.width);
  return { top, left, side, arrow: clamp(cx - left, 10, tip.width - 10) };
}
