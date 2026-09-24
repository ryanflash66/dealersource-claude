/**
 * Tour content and rules. Pure (no DOM) so the unit tests can import it under
 * the node type-check; tour.ts does the drawing. Targets are data-tour keys
 * that app.ts puts on elements; the first key whose element is on screen wins.
 */

export type View = "shortlist" | "pipeline" | "exceptions" | "config";
export const EV_RENDER = "ds:render";
export const EV_SELECT = "ds:select";
export const EV_VIEW = "ds:view";
export const TOUR_KEY = "ds.tour";
export const TOUR_VERSION = 1;

/** What the tour needs to know about the page; app.ts answers from its state. */
export interface TourFacts {
  view: View;
  sites: number;
  ranked: number;
  /** Sites in the "One answer away" list. */
  waiting: number;
  mapPoints: number;
  paused: boolean;
  /** Sidebar is permanently visible (the drawer is used below 1200px). */
  wide: boolean;
  navOpen: boolean;
  phone: boolean;
}
export type Text = string | ((f: TourFacts) => string);
export type TourAction =
  | { kind: "select-site"; from?: "card" | "marker"; hint: Text }
  | { kind: "view"; view: View; hint: Text };
export interface TourStep {
  id: string;
  /** View the step lives on; null for the centred welcome and finish cards. */
  view: View | null;
  /** data-tour keys, first visible wins; null centres the card. */
  target: ((f: TourFacts) => string[]) | null;
  title: string;
  body: Text;
  action?: TourAction;
  skip?: (f: TourFacts) => boolean;
  next?: string;
  dismiss?: string;
}

export const textOf = (t: Text, f: TourFacts): string => (typeof t === "function" ? t(f) : t);

// Sidebar item when the sidebar is on screen, otherwise the control that gets there.
const nav = (view: View, shortcut?: string) => (f: TourFacts) => (f.wide || f.navOpen ? [`nav-${view}`] : [shortcut ?? "menu"]);
const navHint = (label: string, shortcut?: string) => (f: TourFacts) => {
  const verb = f.phone ? "Tap" : "Click";
  return f.wide ? `Click ${label} in the sidebar.` : f.navOpen ? `${verb} ${label}.` : shortcut ? `${verb} ${shortcut}.` : "Open the menu.";
};

export const STEPS: TourStep[] = [
  {
    id: "welcome", view: null, target: null,
    title: "Welcome to dealersource",
    body: "This dashboard shows which lots around Greenville could work for the dealership, and what the automation is still checking. The tour takes about two minutes and asks you to click a few things.",
    next: "Start tour",
    dismiss: "Not now",
  },
  {
    id: "health", view: "shortlist", target: () => ["health"],
    title: "Is the automation healthy?",
    body: (f) => f.paused
      ? "Sending is paused, so this strip is red and says why. Runs keep going and records still update; no email goes out until the cause is cleared."
      : "This strip sums up the last run: listings found, emails sent, replies read and errors. It turns amber when the report is old and red when sending is paused or a run failed.",
  },
  {
    id: "stats", view: "shortlist", target: () => ["stats"],
    title: "Where the search stands",
    body: (f) => `Viable sites passed the zoning, rent and flood checks. One away and Verifying are waiting on an email reply. Excluded sites failed a check or are too far. ${f.phone ? "Tap" : "Hover"} a card for more.`,
  },
  {
    id: "pick", view: "shortlist", target: (f) => [f.ranked ? "ranked" : "waiting"],
    title: "Open a site",
    body: (f) => f.ranked
      ? "Ranked sites are sorted by score. The five bars show traffic, visibility, drive time, rent and competitors."
      : "Nothing has passed every check yet, so these sites are still waiting on an answer.",
    action: { kind: "select-site", hint: (f) => `${f.phone ? "Tap" : "Click"} any site card.` },
    skip: (f) => f.ranked + f.waiting === 0,
  },
  {
    id: "detail", view: "shortlist", target: () => ["detail"],
    title: "Why a site passes or waits",
    body: "Each gate lists its evidence: where it came from, when it was fetched and when it expires. Open goes to the source. A gate never passes on silence; it needs a written answer or an official record.",
    skip: (f) => f.ranked + f.waiting === 0,
  },
  {
    id: "map", view: "shortlist", target: () => ["map"],
    title: "Find it on the map",
    body: "Numbered pins are ranked sites, clock pins are waiting on an answer and grey dots were excluded.",
    action: { kind: "select-site", from: "marker", hint: (f) => `${f.phone ? "Tap" : "Click"} a pin on the map.` },
    skip: (f) => f.mapPoints === 0,
  },
  {
    id: "to-pipeline", view: "shortlist", target: nav("pipeline"),
    title: "See the whole pipeline",
    body: "Every site moves through the same stages, from a listing someone posted to a scored site.",
    action: { kind: "view", view: "pipeline", hint: navHint("Pipeline") },
  },
  {
    id: "pipeline", view: "pipeline", target: () => ["stages"],
    title: "Where every site sits",
    body: "How many sites reached each stage this run. The table under it lists every site, its three gates and why it ended where it did.",
  },
  {
    id: "to-exceptions", view: "pipeline", target: nav("exceptions", "bell"),
    title: "Check what needs you",
    body: "Exceptions collects anything a person should look at: paused sending, failed runs, blocked sources and evidence about to expire. The bell shows a dot when there is something.",
    action: { kind: "view", view: "exceptions", hint: navHint("Exceptions", "the bell") },
  },
  {
    id: "exceptions", view: "exceptions", target: () => ["sending"],
    title: "Email sending",
    body: (f) => f.paused
      ? "Sending is paused and this card says why. Runs keep going; follow-ups are held until the cause is cleared and the pipeline re-runs."
      : "Green means outreach is on. If bounces or a mail quota error pause sending, this card turns red and says why; runs keep going but no email goes out.",
  },
  {
    id: "to-config", view: "exceptions", target: nav("config"),
    title: "What the search looks for",
    body: "The last view holds the search settings and the data providers.",
    action: { kind: "view", view: "config", hint: navHint("Configuration") },
  },
  {
    id: "config", view: "config", target: () => ["settings"],
    title: "Settings are read-only here",
    body: "Home base, drive time, rent range and score weights come from business.yaml and providers.yaml. Change them there and the next run picks them up.",
  },
  {
    id: "finish", view: null, target: () => ["help"],
    title: "You're all set",
    body: (f) => `${f.phone ? "Tap" : "Hover or focus"} any number, chip or gate for an explanation. Replay this tour any time with this ? button.`,
    next: "Finish",
  },
];

/** Views a step may be shown on: its own, plus the destination once a view action is done. */
export function allowedViews(s: TourStep, done: boolean): View[] | null {
  if (!s.view) return null;
  return s.action?.kind === "view" && done ? [s.view, s.action.view] : [s.view];
}

/**
 * Whether to offer the tour on load. `stored` is undefined when storage is
 * unavailable: then it is never offered by itself (it would reappear every load).
 */
export function autoStart(query: string, stored: string | null | undefined): "force" | "auto" | "off" {
  const q = new URLSearchParams(query).get("tour");
  if (q === "1") return "force";
  if (q === "0" || stored === undefined) return "off";
  if (stored && stored.endsWith(`:${TOUR_VERSION}`)) return "off";
  return "auto";
}
