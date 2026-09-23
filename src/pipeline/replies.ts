/**
 * Reply text helpers used before a reply is classified.
 *
 * stripQuotedReply: mail clients quote our original email under the reply. That quote contains
 * our own questions and the line 'Reply "stop" if you would prefer not to hear from me', so a
 * classifier reading the whole body would see words we wrote (including "stop"). Only the
 * sender's own new text is kept.
 *
 * splitReplyByProperty: a reply to a combined inquiry (one email covering several properties,
 * numbered "1. <address>") is split into one block per property, by the number the sender used
 * ("1:", "#2", "Property 3", "(4)") or by the street named ("Beacon is $900"). Text that names
 * several properties, or none, is not guessed at.
 */

const DIRECTIONS = /^(N|S|E|W|NE|NW|SE|SW|NORTH|SOUTH|EAST|WEST)\.?$/i;
const STREET_TYPES = /^(ST|STREET|RD|ROAD|AVE|AVENUE|DR|DRIVE|BLVD|HWY|HIGHWAY|LN|LANE|WAY|CT|PKWY|PL|CIR|TER|TRL)\.?$/i;

export function stripQuotedReply(text: string): string {
  const lines = text.replace(/\r\n?/g, "\n").split("\n");
  const out: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    const next = lines[i + 1] ?? "";
    // Gmail / Apple Mail: "On <date> <name> <addr> wrote:" (sometimes wrapped onto two lines).
    if (/^\s*On\b.{0,240}\bwrote:\s*$/i.test(line)) break;
    if (/^\s*On\b/i.test(line) && /\bwrote:\s*$/i.test(next) && !/^\s*>/.test(next)) break;
    // Outlook and forwards.
    if (/^\s*-{2,}\s*(Original Message|Forwarded message)\s*-{2,}/i.test(line)) break;
    if (/^\s*_{10,}\s*$/.test(line)) break;
    if (/^\s*From:\s.+/i.test(line) && /^\s*(Sent|Date):\s/i.test(next)) break;
    if (/^\s*>/.test(line)) continue;
    out.push(line);
  }
  const kept = out.join("\n").trim();
  return kept || text.trim();
}

export interface PropertyRef {
  /** Stable key (site id). */
  key: string;
  /** The number the property carried in our email ("1. <address>"), if known. */
  n: number | null;
  address: string;
}

interface Ident extends PropertyRef {
  house: string | null;
  street: string | null;
}

function identify(p: PropertyRef): Ident {
  const words = p.address.split(",")[0]!.trim().split(/\s+/);
  const house = /^\d+[A-Z]?$/i.test(words[0] ?? "") ? words[0]! : null;
  const street = words.slice(house ? 1 : 0).find((w) => !DIRECTIONS.test(w) && !STREET_TYPES.test(w) && w.length >= 3) ?? null;
  return { ...p, house, street };
}

export function splitReplyByProperty(body: string, props: PropertyRef[]): Map<string, string> {
  const ids = props.map(identify);
  const numbers = new Set(ids.map((p) => p.n).filter((n): n is number => n !== null));
  // Streets that identify exactly one property.
  const streetCount = new Map<string, number>();
  for (const p of ids) if (p.street) streetCount.set(p.street.toLowerCase(), (streetCount.get(p.street.toLowerCase()) ?? 0) + 1);

  // Put every inline number marker ("1: ...; 2: ...") on its own line.
  const marker = /(^|[\s;,.])(?:#|property\s*#?\s*|prop\.?\s*#?\s*|no\.?\s*)?\(?([1-9]\d?)\s*[:)]\s/gi;
  const text = stripQuotedReply(body).replace(marker, (all, pre: string, n: string) => (numbers.has(Number(n)) ? `${pre}\n${all.slice(pre.length)}` : all));

  const out = new Map<string, string[]>();
  let current: string | null = null;
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (!line) continue;
    const hits = new Set<string>();
    const lead = /^(?:#|property\s*#?\s*|prop\.?\s*#?\s*|no\.?\s*)?\(?([1-9]\d?)\s*(?:[.:)]|\s[-–])/i.exec(line);
    if (lead && numbers.has(Number(lead[1]))) {
      for (const p of ids) if (p.n === Number(lead[1])) hits.add(p.key);
    }
    for (const p of ids) {
      const street = p.street?.toLowerCase();
      if (!street || !new RegExp(`\\b${escapeRe(street)}\\b`, "i").test(line)) continue;
      const unique = streetCount.get(street) === 1;
      const houseHere = p.house !== null && new RegExp(`\\b${escapeRe(p.house)}\\b`).test(line);
      if (unique || houseHere) hits.add(p.key);
    }
    if (hits.size === 1) current = [...hits][0]!;
    else if (hits.size > 1) current = null; // names several properties: do not guess
    if (current) out.set(current, [...(out.get(current) ?? []), line]);
  }
  return new Map([...out].map(([k, v]) => [k, v.join("\n")]));
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
