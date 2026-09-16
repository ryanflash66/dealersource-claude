/**
 * Address normalisation used to merge duplicate listings into one site before
 * geocoding. Conservative: expands common USPS abbreviations, drops
 * punctuation and unit designators, and keeps number + street + city + zip.
 */

const STREET_TYPES: Record<string, string> = {
  street: "st",
  st: "st",
  avenue: "ave",
  ave: "ave",
  av: "ave",
  road: "rd",
  rd: "rd",
  drive: "dr",
  dr: "dr",
  boulevard: "blvd",
  blvd: "blvd",
  highway: "hwy",
  hwy: "hwy",
  lane: "ln",
  ln: "ln",
  court: "ct",
  ct: "ct",
  parkway: "pkwy",
  pkwy: "pkwy",
  circle: "cir",
  cir: "cir",
  place: "pl",
  pl: "pl",
  way: "way",
};

const DIRECTIONS: Record<string, string> = {
  north: "n",
  south: "s",
  east: "e",
  west: "w",
  n: "n",
  s: "s",
  e: "e",
  w: "w",
  northeast: "ne",
  northwest: "nw",
  southeast: "se",
  southwest: "sw",
  ne: "ne",
  nw: "nw",
  se: "se",
  sw: "sw",
};

const UNIT_WORDS = new Set(["suite", "ste", "unit", "apt", "#", "bldg", "building"]);

export function normalizeAddressKey(text: string): string {
  const lowered = text
    .toLowerCase()
    .replace(/\bnorth carolina\b/g, "nc")
    .replace(/[.,;()]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  const tokens = lowered.split(" ");
  const out: string[] = [];
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i]!;
    if (UNIT_WORDS.has(t)) {
      i++; // drop the unit designator and its value
      continue;
    }
    if (t.startsWith("#")) continue;
    if (STREET_TYPES[t]) out.push(STREET_TYPES[t]);
    else if (DIRECTIONS[t]) out.push(DIRECTIONS[t]);
    else out.push(t);
  }
  return out.join(" ");
}

export interface ParsedAddress {
  number: string | null;
  city: string | null;
  zip: string | null;
}

/** Cheap parse for "has street number / city / zip" checks. */
export function parseAddress(text: string): ParsedAddress {
  const number = /^\s*(\d+[a-z]?)\b/i.exec(text)?.[1] ?? null;
  const zip = /\b(2[78]\d{3})\b/.exec(text)?.[1] ?? null;
  const cityMatch = /,\s*([a-z .'-]+?)\s*,?\s*(?:nc|north carolina)\b/i.exec(text);
  const city = cityMatch?.[1]?.trim() ?? null;
  return { number, city, zip };
}

export function looksLikeStreetAddress(text: string | null | undefined): boolean {
  if (!text) return false;
  const p = parseAddress(text);
  return p.number !== null && /\b(nc|north carolina)\b/i.test(text);
}
