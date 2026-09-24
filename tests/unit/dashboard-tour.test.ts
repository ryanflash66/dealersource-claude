import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { ROOT } from "../helpers.js";
import { MARGIN, holePath, placeCard, placeTip, sheetDock, visiblePart } from "../../dashboard/src/place.js";
import { STEPS, TOUR_VERSION, allowedViews, autoStart, textOf, type TourFacts, type View } from "../../dashboard/src/tour-steps.js";

const VP = { width: 1440, height: 900 };
const CARD = { width: 340, height: 220 };
const inside = (p: { top: number; left: number }, size: { width: number; height: number }, vp = VP) =>
  p.top >= MARGIN && p.left >= MARGIN && p.top + size.height <= vp.height - MARGIN && p.left + size.width <= vp.width - MARGIN;

describe("tour and tooltip positioning", () => {
  it("puts the card beside the target, on the right when there is room", () => {
    const p = placeCard({ top: 300, left: 300, width: 400, height: 120 }, CARD, VP);
    expect(p.side).toBe("right");
    expect(p.left).toBeGreaterThanOrEqual(700);
    expect(inside(p, CARD)).toBe(true);
    expect(p.arrow).toBeGreaterThanOrEqual(16);
    expect(p.arrow).toBeLessThanOrEqual(CARD.height - 16);
  });

  it("goes below a target at the right edge, and left of a tall one, staying in the viewport", () => {
    const low = placeCard({ top: 5, left: 1200, width: 230, height: 60 }, CARD, VP);
    expect(low.side).toBe("bottom");
    expect(inside(low, CARD)).toBe(true);
    const tall = placeCard({ top: 300, left: 1200, width: 230, height: 500 }, CARD, VP);
    expect(tall.side).toBe("left");
    expect(inside(tall, CARD)).toBe(true);
  });

  it("centres the card with no target, and floats it inside a target that fills the screen", () => {
    expect(placeCard(null, CARD, VP)).toMatchObject({ side: "center", arrow: null });
    const big = placeCard({ top: 0, left: 0, width: 1440, height: 900 }, CARD, VP);
    expect(big.side).toBe("inside");
    expect(inside(big, CARD)).toBe(true);
  });

  it("puts tooltips above, below when there is no room, never off screen", () => {
    const tip = { width: 200, height: 40 };
    expect(placeTip({ top: 400, left: 700, width: 40, height: 20 }, tip, VP).side).toBe("top");
    expect(placeTip({ top: 10, left: 700, width: 40, height: 20 }, tip, VP).side).toBe("bottom");
    const edge = placeTip({ top: 400, left: 1430, width: 10, height: 20 }, tip, VP);
    expect(edge.left + tip.width).toBeLessThanOrEqual(VP.width - MARGIN);
    expect(edge.arrow).toBeLessThanOrEqual(tip.width - 10);
  });

  it("clips to the viewport, cuts one hole in the scrim, and docks the phone sheet away from the target", () => {
    expect(visiblePart({ top: -500, left: 0, width: 100, height: 100 }, VP)).toBeNull();
    expect(visiblePart({ top: -50, left: 0, width: 100, height: 100 }, VP)).toEqual({ top: 0, left: 0, width: 100, height: 50 });
    expect(holePath(VP, null).match(/Z/g)).toHaveLength(1);
    expect(holePath(VP, { top: 10, left: 10, width: 100, height: 50 }).match(/Z/g)).toHaveLength(2);
    const phone = { width: 390, height: 844 };
    expect(sheetDock({ top: 600, left: 16, width: 358, height: 200 }, 260, phone)).toBe("top");
    expect(sheetDock({ top: 80, left: 16, width: 358, height: 200 }, 260, phone)).toBe("bottom");
  });
});

describe("tour steps", () => {
  const facts = (o: Partial<TourFacts> = {}): TourFacts => ({ view: "shortlist", sites: 8, ranked: 3, waiting: 1, mapPoints: 8, paused: false, wide: true, navOpen: false, phone: false, ...o });
  const variants: TourFacts[] = [
    facts(),
    facts({ ranked: 0, waiting: 4, paused: true }),
    facts({ wide: false }),
    facts({ wide: false, navOpen: true }),
    facts({ wide: false, phone: true }),
    facts({ sites: 0, ranked: 0, waiting: 0, mapPoints: 0 }),
  ];

  it("starts with the welcome card and ends with the finish card; ids are unique", () => {
    expect(STEPS[0]!.id).toBe("welcome");
    expect(STEPS[0]!.target).toBeNull();
    expect(STEPS.at(-1)!.id).toBe("finish");
    expect(new Set(STEPS.map((s) => s.id)).size).toBe(STEPS.length);
  });

  it("covers all four views and every view action leads to the next step's view", () => {
    expect(new Set(STEPS.map((s) => s.view).filter(Boolean))).toEqual(new Set(["shortlist", "pipeline", "exceptions", "config"]));
    STEPS.forEach((s, i) => {
      if (s.action?.kind !== "view") return;
      expect(STEPS[i + 1]!.view).toBe(s.action.view);
      expect(allowedViews(s, false)).toEqual([s.view]);
      expect(allowedViews(s, true)).toEqual([s.view, s.action.view]);
    });
  });

  it("has text for every step in every situation", () => {
    for (const f of variants) for (const s of STEPS) {
      expect(textOf(s.body, f).length).toBeGreaterThan(20);
      if (s.action) expect(textOf(s.action.hint, f).length).toBeGreaterThan(5);
    }
  });

  it("skips the site steps when there is nothing to click", () => {
    const none = facts({ sites: 3, ranked: 0, waiting: 0, mapPoints: 0 });
    const shown = STEPS.filter((s) => !s.skip?.(none)).map((s) => s.id);
    expect(shown).not.toContain("pick");
    expect(shown).not.toContain("detail");
    expect(shown).not.toContain("map");
    expect(shown).toContain("to-pipeline");
  });

  it("points only at data-tour keys that app.ts renders", () => {
    const app = readFileSync(join(ROOT, "dashboard", "src", "app.ts"), "utf8");
    const keys = new Set([...app.matchAll(/"data-tour": "([a-z-]+)"/g), ...app.matchAll(/\btour: "([a-z-]+)"/g)].map((m) => m[1]!));
    if (app.includes('"data-tour": `nav-${id}`')) for (const v of ["shortlist", "pipeline", "exceptions", "config"] satisfies View[]) keys.add(`nav-${v}`);
    for (const f of variants) for (const s of STEPS) for (const k of s.target?.(f) ?? []) expect(keys, `step ${s.id} targets ${k}`).toContain(k);
  });

  it("offers itself once per browser, never without storage, and obeys ?tour=", () => {
    expect(autoStart("", null)).toBe("auto");
    expect(autoStart("", `done:${TOUR_VERSION}`)).toBe("off");
    expect(autoStart("", `skipped:${TOUR_VERSION}`)).toBe("off");
    expect(autoStart("", `done:${TOUR_VERSION - 1}`)).toBe("auto");
    expect(autoStart("", undefined)).toBe("off");
    expect(autoStart("?tour=1", `done:${TOUR_VERSION}`)).toBe("force");
    expect(autoStart("?tour=0", null)).toBe("off");
  });
});

describe("dashboard help wiring", () => {
  const src = join(ROOT, "dashboard", "src");
  const app = readFileSync(join(src, "app.ts"), "utf8");

  it("uses data-tip instead of native title tooltips", () => {
    expect(app).not.toMatch(/[{,]\s*title:\s*[`"a-zA-Z]/);
    expect((app.match(/"data-tip":/g) ?? []).length).toBeGreaterThan(25);
  });

  it("reports renders, selections and view changes to the tour", () => {
    expect(app).toContain("new CustomEvent(EV_RENDER");
    expect(app).toContain("new CustomEvent(EV_SELECT");
    expect(app).toContain("new CustomEvent(EV_VIEW");
  });

  it("keeps the dashboard free of package imports", () => {
    for (const f of readdirSync(src).filter((x) => x.endsWith(".ts"))) {
      for (const m of readFileSync(join(src, f), "utf8").matchAll(/from "([^"]+)"/g)) expect(m[1], `${f} imports ${m[1]}`).toMatch(/^\.\//);
    }
  });
});
