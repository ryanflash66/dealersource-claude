import { inflateSync } from "node:zlib";
import { normalizeAddressKey } from "../core/address.js";
import type { ListingExtraction } from "../core/types.js";
import { ADDRESS_RE, htmlToText, moneyPerMonthAll } from "../providers/llm.js";

/**
 * Saved-search alert emails (LoopNet, Crexi, ...): cut one email into one card per listing.
 *
 * Only the email is read. A card's listing URL is kept when the email links to the listing
 * directly or carries it inside a click-tracking link; opaque tracking links are dropped and
 * never followed, because following one is a request to the listing site.
 *
 * The alert layouts are not published, so cutting is structural rather than per-sender:
 * in HTML, a card is the largest element holding exactly one street address (and at most
 * one listing link); in plain text, cards are cut at the blank or rule lines between
 * addresses.
 */
export interface AlertCard {
  /** The listing page on the alert's site, without query or fragment; null when the card has no readable listing link. */
  url: string | null;
  /** The card's markup (HTML alert) or text (plain-text alert), handed to the listing extractor. */
  block: string;
  /** The card as plain text. */
  text: string;
}

export function parseAlert(mail: { html: string | null; text: string | null }, listingUrl: RegExp | null): AlertCard[] {
  const cards = mail.html ? htmlCards(unpipe(mail.html), listingUrl) : [];
  return cards.length ? cards : mail.text ? textCards(unpipe(mail.text), listingUrl) : [];
}

// LoopNet writes a card on one line, "Name | 301 S Evans St | Greenville, NC 27858 | For Lease",
// with &nbsp; around the bars: read a spaced bar as a comma so the street and city join up.
const PIPE_RE = /(?:[ \t]|&nbsp;|&#160;|&#xa0;| )+\|(?=(?:[ \t]|&nbsp;|&#160;|&#xa0;| )+)/gi;
function unpipe(s: string): string {
  return s.replace(PIPE_RE, " ,");
}

const ADDRESS_G = new RegExp(ADDRESS_RE.source, "g");

/** Distinct NC street addresses in the text, as address keys. */
export function addressKeys(text: string): string[] {
  const keys = new Set<string>();
  for (const m of text.matchAll(ADDRESS_G)) keys.add(normalizeAddressKey(`${m[1]}, ${m[2]}, NC`));
  return [...keys];
}

/**
 * The listing page a link points to, if it can be read without following it: the link
 * itself, or a target embedded in a tracking link's query or path (plain, percent-encoded
 * or base64). Query and fragment are dropped (tracking parameters).
 */
export function canonicalListingUrl(href: string, pattern: RegExp | null): string | null {
  if (!pattern) return null;
  const queue = [decodeEntities(href.trim())];
  const seen = new Set<string>();
  while (queue.length && seen.size < 12) {
    const h = queue.shift()!;
    if (seen.has(h)) continue;
    seen.add(h);
    let u: URL;
    try {
      u = new URL(h);
    } catch {
      continue;
    }
    if (u.protocol !== "https:" && u.protocol !== "http:") continue;
    const bare = `https://${u.host.toLowerCase()}${u.pathname}`;
    if (pattern.test(bare)) return bare;
    for (const v of u.searchParams.values()) queue.push(...embeddedUrls(v));
    for (const seg of u.pathname.split("/")) queue.push(...embeddedUrls(seg));
  }
  return null;
}

function embeddedUrls(v: string): string[] {
  const out: string[] = [];
  const d = safeDecode(v);
  if (/^https?:\/\//i.test(d)) out.push(d);
  if (/^aHR0c[A-Za-z0-9+/_=-]+$/.test(v)) {
    const b = Buffer.from(v.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8");
    if (/^https?:\/\/\S+$/i.test(b)) out.push(b);
  }
  // zlib-compressed, base64url payload ("eJ..."), as Crexi's mailer uses: /c/<token> inflates
  // to a query string whose `l` is the target. Decoded locally; the link is never requested.
  if (/^e[AFJN][A-Za-z0-9_-]{16,}$/.test(v)) {
    try {
      const s = inflateSync(Buffer.from(v, "base64url"), { maxOutputLength: 64 * 1024 }).toString("utf8");
      out.push(...[...new URLSearchParams(s).values()].filter((x) => /^https?:\/\//i.test(x)));
      for (const m of s.matchAll(/https?:\/\/[^\s"'<>\\]+/gi)) out.push(m[0]);
    } catch {
      // not a deflate payload
    }
  }
  return out;
}

function safeDecode(v: string): string {
  try {
    return decodeURIComponent(v);
  } catch {
    return v;
  }
}

function decodeEntities(s: string): string {
  return s
    .replace(/&#(\d+);/g, (_, n: string) => String.fromCharCode(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n: string) => String.fromCharCode(parseInt(n, 16)))
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&amp;/g, "&");
}

// ------------------------------------------------------------------ html
interface El {
  tag: string;
  start: number;
  end: number;
  children: El[];
}

const VOID = new Set(["area", "base", "br", "col", "embed", "hr", "img", "input", "link", "meta", "source", "track", "wbr"]);
const TAG_RE = /<\/([a-zA-Z][\w:-]*)\s*>|<([a-zA-Z][\w:-]*)((?:[^>"']|"[^"]*"|'[^']*')*)>/g;
const HREF_RE = /<a\b[^>]*?\shref\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))[^>]*>/gi;

/** Element tree with source offsets. Tolerant: a stray close tag is ignored, an unclosed element ends with its parent. */
function parseTree(html: string): El {
  const root: El = { tag: "#root", start: 0, end: html.length, children: [] };
  const stack: El[] = [root];
  for (const m of html.matchAll(TAG_RE)) {
    const at = m.index!;
    const after = at + m[0].length;
    if (m[1]) {
      const tag = m[1].toLowerCase();
      let i = stack.length - 1;
      while (i > 0 && stack[i]!.tag !== tag) i--;
      if (i === 0) continue;
      for (let j = stack.length - 1; j > i; j--) stack[j]!.end = at;
      stack[i]!.end = after;
      stack.length = i;
    } else {
      const tag = m[2]!.toLowerCase();
      const el: El = { tag, start: at, end: after, children: [] };
      stack[stack.length - 1]!.children.push(el);
      if (!VOID.has(tag) && !m[3]!.trim().endsWith("/")) stack.push(el);
    }
  }
  for (const el of stack.slice(1)) el.end = html.length;
  return root;
}

function hrefs(html: string): string[] {
  return [...html.matchAll(HREF_RE)].map((m) => decodeEntities(m[1] ?? m[2] ?? m[3] ?? ""));
}

function htmlCards(raw: string, listingUrl: RegExp | null): AlertCard[] {
  // Comments (Outlook conditionals hold whole tables), scripts, styles and <head> are blanked.
  // A listing link inside a comment is kept as an empty <a>: LoopNet's only readable listing
  // link is the Outlook-only <v:roundrect href> button; its other links are encrypted redirects.
  const html = raw.replace(/<!--[\s\S]*?-->|<(script|style|head)\b[\s\S]*?<\/\1\s*>/gi, (s) => {
    const kept = s.startsWith("<!--") ? [...s.matchAll(/\shref\s*=\s*"([^"]*)"/gi)].filter((m) => canonicalListingUrl(m[1]!, listingUrl)) : [];
    return kept.length ? ` ${kept.map((m) => `<a href="${m[1]}"></a>`).join(" ")} ` : " ";
  });
  const root = parseTree(html);
  const slice = (el: El) => html.slice(el.start, el.end);
  const memo = new Map<El, string[]>();
  const keys = (el: El): string[] => {
    let k = memo.get(el);
    if (!k) memo.set(el, (k = addressKeys(htmlToText(slice(el)))));
    return k;
  };
  const links = (el: El) => new Set(hrefs(slice(el)).map((h) => canonicalListingUrl(h, listingUrl)).filter((u): u is string => u !== null));

  const cards: AlertCard[] = [];
  const walk = (el: El): void => {
    const n = keys(el).length;
    if (n === 0) return;
    const inChildren = el.children.reduce((a, c) => a + keys(c).length, 0);
    if (n === 1 && (links(el).size <= 1 || inChildren === 0)) {
      const own = [...links(el)];
      cards.push({ url: own.length === 1 ? own[0]! : null, block: slice(el), text: htmlToText(slice(el)) });
      return;
    }
    if (inChildren < n) {
      // Addresses run across this element's own lines (one flat block): cut its text instead.
      cards.push(...textCards(markLinks(slice(el)), listingUrl));
      return;
    }
    for (const c of el.children) walk(c);
  };
  walk(root);
  return cards;
}

const MARK_OPEN = "⟦";
const MARK_CLOSE = "⟧";
const MARK_RE = /⟦([^⟧]*)⟧/g;

/** HTML to text, keeping each link's href as an inline marker so text cards can still find their listing URL. */
function markLinks(html: string): string {
  return htmlToText(html.replace(HREF_RE, (all, a?: string, b?: string, c?: string) => `${all} ${MARK_OPEN}${a ?? b ?? c ?? ""}${MARK_CLOSE} `));
}

// ------------------------------------------------------------------ text
const FOOTER_RE = /unsubscribe|manage (?:your )?(?:alerts|searches|saved searches|preferences|notifications)|email preferences|privacy (?:policy|notice)|©|copyright/i;
const RULE_LINE_RE = /^[\s\-=_*~#.•·]*$/;

function textCards(raw: string, listingUrl: RegExp | null): AlertCard[] {
  const t = raw.replace(/\r\n?/g, "\n");
  const first = new Map<string, RegExpMatchArray>();
  for (const m of t.matchAll(ADDRESS_G)) {
    const k = normalizeAddressKey(`${m[1]}, ${m[2]}, NC`);
    if (!first.has(k)) first.set(k, m);
  }
  const hits = [...first.values()].sort((a, b) => a.index! - b.index!);
  if (!hits.length) return [];

  // Line starts, and which lines are breaks (blank, or a rule made of -, =, _, * ...).
  const lines: Array<{ start: number; end: number; brk: boolean; footer: boolean }> = [];
  let pos = 0;
  for (const line of t.split("\n")) {
    lines.push({ start: pos, end: pos + line.length, brk: RULE_LINE_RE.test(line.replace(MARK_RE, "")), footer: FOOTER_RE.test(line) });
    pos += line.length + 1;
  }
  const lineAt = (p: number) => {
    let i = 0;
    while (i + 1 < lines.length && lines[i + 1]!.start <= p) i++;
    return i;
  };

  const starts = hits.map((m, i) => {
    const line = lineAt(m.index!);
    const floor = i === 0 ? 0 : lineAt(hits[i - 1]!.index! + hits[i - 1]![0].length) + 1;
    for (let j = line - 1; j >= floor; j--) if (lines[j]!.brk) return lines[j + 1]!.start;
    return i === 0 ? 0 : lines[line]!.start;
  });
  return hits.map((m, i) => {
    let end = i + 1 < hits.length ? starts[i + 1]! : t.length;
    if (i + 1 === hits.length) {
      // The last card runs to the end of the email; stop it at the footer.
      for (let j = lineAt(m.index! + m[0].length) + 1; j < lines.length; j++) {
        if (lines[j]!.footer) {
          end = lines[j]!.start;
          break;
        }
      }
    }
    const seg = t.slice(starts[i]!, end);
    const urls = [...[...seg.matchAll(MARK_RE)].map((x) => x[1]!), ...(seg.replace(MARK_RE, " ").match(/https?:\/\/[^\s<>"')\]]+/g) ?? [])];
    const url = urls.map((u) => canonicalListingUrl(u, listingUrl)).find((u): u is string => u !== null) ?? null;
    const text = seg.replace(MARK_RE, " ").replace(/[ \t]+/g, " ").trim();
    return { url, block: text, text };
  });
}

// ------------------------------------------------------------ extraction
/**
 * What a card states reliably. A card with two different monthly prices keeps no rent
 * (which is this listing's would be a guess). With the rules extractor, rent is only an
 * explicit "$X/mo", or an explicit yearly total divided by 12; "$12/SF/YR" rates stay
 * unknown and go to the leasing question instead. Emails of the alert service itself, of
 * the mailbox owner, and no-reply addresses are never treated as a leasing contact.
 */
export function alertExtraction(ex: ListingExtraction, cardText: string, isBlockedEmail: (email: string) => boolean): ListingExtraction {
  const monthly = [...new Set(moneyPerMonthAll(cardText))];
  let rent: number | null;
  if (monthly.length > 1) rent = null;
  else if (ex.method === "rules") rent = monthly.length === 1 ? monthly[0]! : yearlyTotalPerMonth(cardText);
  else rent = ex.rent_monthly;
  const email = ex.contact_email && !isBlockedEmail(ex.contact_email) ? ex.contact_email : null;
  return { ...ex, rent_monthly: rent, contact_email: email };
}

/** "$10,800/yr" -> 900. Only whole-dollar yearly totals of $1,200 or more (never a per-square-foot rate). */
export function yearlyTotalPerMonth(text: string): number | null {
  const re = /\$\s?(\d{1,3}(?:,\d{3})+|\d{4,})(?:\.\d{2})?\s*(?:\/|per|a)?\s*(?:yr|year|annually)\b/gi;
  const found = [...new Set([...text.matchAll(re)].map((m) => Number(m[1]!.replace(/,/g, ""))))];
  return found.length === 1 && found[0]! >= 1200 ? Math.round(found[0]! / 12) : null;
}
