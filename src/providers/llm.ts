import { mkdirSync, writeFileSync, existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { CaseType, ListingExtraction, ReplyClassification } from "../core/types.js";
import { optString } from "./options.js";
import type { AdapterContext, DigestInput, ExtractionInput, LlmProvider } from "./types.js";

// ---------------------------------------------------------------- helpers
export function htmlToText(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|li|h[1-6]|tr|article|section)>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/[ \t]+/g, " ")
    .replace(/\n\s*\n+/g, "\n")
    .trim();
}

export function parseMoneyPerMonth(text: string): number | null {
  const re = /\$\s?(\d{1,3}(?:,\d{3})*|\d+)(?:\.\d{2})?\s*(?:\/|per|a|each)?\s*(?:mo\b|month)/gi;
  let m: RegExpExecArray | null;
  const found: number[] = [];
  while ((m = re.exec(text))) found.push(Number(m[1]!.replace(/,/g, "")));
  if (!found.length) {
    const bare = /(?:base rent|rent)(?: is| of|:)?\s*\$\s?(\d{1,3}(?:,\d{3})*|\d+)/i.exec(text);
    if (bare) return Number(bare[1]!.replace(/,/g, ""));
    return null;
  }
  return found[0]!;
}

const ADDRESS_RE =
  /\b(\d{1,6}[A-Za-z]?\s+(?:[NSEW]\.?\s+|North\s+|South\s+|East\s+|West\s+)?[A-Za-z0-9.'\- ]{2,40}?\s(?:St|Street|Ave|Avenue|Rd|Road|Dr|Drive|Blvd|Boulevard|Hwy|Highway|Ln|Lane|Pkwy|Parkway|Ct|Court|Cir|Circle|Pl|Place|Way)\.?(?:\s+[NSEW]\.?)?)\s*,?\s*([A-Za-z .'-]{2,30}?)\s*,?\s*(?:NC|North Carolina)\s*,?\s*(2[78]\d{3})?\b/;

/** Deterministic, dependency-free extraction and classification. Free default. */
export class RulesLlm implements LlmProvider {
  readonly name: string = "rules";
  constructor(protected readonly ctx: AdapterContext) {}

  async extractListing(input: ExtractionInput): Promise<ListingExtraction> {
    const text = htmlToText(input.block ?? input.html);
    const addr = ADDRESS_RE.exec(text);
    const address_text = addr ? `${addr[1]!.trim()}, ${addr[2]!.trim()}, NC${addr[3] ? " " + addr[3] : ""}` : null;
    const rent = parseMoneyPerMonth(text);
    const sqft = /(\d{3,5})\s*(?:sq\.?\s*ft|square feet|sf)\b/i.exec(text);
    const email = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/.exec(input.block ?? input.html)?.[0] ?? null;
    const phone = /\(?\b\d{3}\)?[-. ]\d{3}[-. ]\d{4}\b/.exec(text)?.[0] ?? null;
    const officeNo = /\bno office\b|\bwithout (?:an )?office\b|\bland only\b/i.test(text);
    const officeYes = /\boffice\b/i.test(text);
    const cap =
      /(?:room for|space for|display|park(?:ing)? for|up to)\s+(\d{1,3})\s*(?:display\s+)?(?:vehicles|cars|spaces)/i.exec(text) ??
      /(\d{1,3})\s*(?:display\s+)?(?:vehicles|cars|spaces)\b/i.exec(text);
    const shared = /\bshar(?:ed|ing)\b|\bsublease\b|\bsublet\b|\bportion of\b|\bpart of (?:my|our|the) lot\b/i.test(text);
    const title = /^\s*(.{5,120}?)\s*$/m.exec(text)?.[1] ?? null;
    let confidence = 0.2;
    if (address_text) confidence += 0.35;
    if (rent !== null) confidence += 0.2;
    if (email) confidence += 0.15;
    if (officeYes || officeNo) confidence += 0.1;
    return {
      title,
      address_text,
      rent_monthly: rent,
      sqft: sqft ? Number(sqft[1]) : null,
      has_office: officeNo ? false : officeYes ? true : null,
      vehicle_capacity: cap ? Number(cap[1]) : null,
      shared_lot: shared ? true : officeYes || address_text ? false : null,
      contact_email: email,
      contact_name: null,
      contact_phone: phone,
      description: text.slice(0, 600),
      confidence: Math.min(1, confidence),
      method: "rules",
    };
  }

  async classifyReply(text: string, caseType: CaseType): Promise<ReplyClassification> {
    const t = text.replace(/\s+/g, " ");
    const stop = /\b(stop|unsubscribe|do not contact|don't contact|remove me|no longer interested in hearing)\b/i.test(t);
    const unavailable = /\b(no longer available|already leased|has been leased|off the market|under contract)\b/i.test(t);
    const rent = parseMoneyPerMonth(t);
    const nnn = /\bNNN\b|\btriple[- ]net\b|\bCAM\b/i.test(t) ? !/\bno\s+(?:NNN|CAM)\b|\bnot\s+(?:NNN|triple)/i.test(t) : null;
    const officeNo = /\bno (?:enclosed )?office\b|\bwithout (?:an )?office\b/i.test(t);
    const officeYes = /\boffice\b/i.test(t) && !officeNo;
    const cap = /(\d{1,3})\s*(?:display\s+)?(?:vehicles|cars|spaces)\b/i.exec(t);
    let zoning: ReplyClassification["zoning_status"] = null;
    if (/\bnot (?:a )?permitted\b|\bprohibited\b|\bnot allowed\b|\bnot permitted\b/i.test(t)) zoning = "prohibited";
    else if (/\bspecial use\b|\bconditional\b|\bSUP\b|\bspecial exception\b/i.test(t)) zoning = "conditional";
    else if (/\bpermitted\b|\ballowed by right\b|\bby[- ]right\b|\bis (?:a )?permitted use\b/i.test(t)) zoning = "permitted";
    const citation =
      /\b((?:[A-Z][\w]* Code )?(?:sec(?:tion)?\.?|§|article|art\.|chapter|ch\.)\s*[\dA-Za-z][\w\-]*(?:\.\d+)*(?:\s+(?:table|tbl\.?)\s*[\w\-]+(?:\.\d+)*)?)/i
        .exec(t)?.[1]
        ?.replace(/[.,;:]+$/, "")
        .trim() ?? null;
    const answered =
      (caseType === "rent" && rent !== null) ||
      (caseType === "zoning" && zoning !== null) ||
      (caseType === "space" && (officeYes || officeNo || cap !== null));
    const intent: ReplyClassification["intent"] = stop ? "stop" : unavailable ? "unavailable" : answered ? "answer" : "unrelated";
    return {
      intent,
      rent_monthly: rent,
      rent_includes_nnn: nnn,
      has_office: officeNo ? false : officeYes ? true : null,
      vehicle_capacity: cap ? Number(cap[1]) : null,
      zoning_status: zoning,
      zoning_citation: citation,
      summary: t.slice(0, 240),
      confidence: answered ? 0.8 : 0.4,
    };
  }

  async writeDigest(input: DigestInput): Promise<string> {
    const lines = [
      `# dealersource digest - ${input.run_date}`,
      "",
      `Run ${input.run_id}. Sent ${input.sent} outreach email(s), ingested ${input.received} reply(ies). ` +
        `${input.open_cases} case(s) open, ${input.escalated_cases} escalated to a human.`,
      "",
      "## Shortlist",
      "",
    ];
    if (!input.shortlist.length) lines.push("_No viable sites yet._");
    for (const s of input.shortlist) {
      lines.push(`${s.rank}. ${s.address} - score ${s.score.toFixed(3)}${s.rent !== null ? `, $${s.rent}/mo` : ""}${s.flags.length ? ` [${s.flags.join(", ")}]` : ""}`);
    }
    if (input.exceptions.length) {
      lines.push("", "## Exceptions", "");
      for (const e of input.exceptions) lines.push(`- ${e}`);
    }
    return lines.join("\n") + "\n";
  }
}

/**
 * "Claude via the scheduled agent": the routine itself is the model. This
 * adapter runs the deterministic rules, then appends every low-confidence
 * extraction or classification to a review queue under --out so the agent
 * can look at the raw evidence and correct the stored row in its own step.
 */
export class ClaudeAgentLlm extends RulesLlm {
  override readonly name = "claude_agent";
  private readonly queue: Array<Record<string, unknown>> = [];

  private queuePath(): string | null {
    if (!this.ctx.outDir) return null;
    return resolve(this.ctx.outDir, optString(this.ctx.options, "review_queue", "review-queue.json"));
  }

  private push(item: Record<string, unknown>): void {
    const path = this.queuePath();
    if (!path) return;
    this.queue.push({ ...item, queued_at: this.ctx.clock.iso() });
    mkdirSync(resolve(path, ".."), { recursive: true });
    const existing = existsSync(path) ? (JSON.parse(readFileSync(path, "utf8")) as unknown[]) : [];
    writeFileSync(path, JSON.stringify([...existing, item], null, 2));
  }

  override async extractListing(input: ExtractionInput): Promise<ListingExtraction> {
    const out = await super.extractListing(input);
    out.method = "claude_agent";
    if (out.confidence < 0.7) this.push({ kind: "extraction", url: input.url, source_id: input.source_id, extraction: out });
    return out;
  }

  override async classifyReply(text: string, caseType: CaseType): Promise<ReplyClassification> {
    const out = await super.classifyReply(text, caseType);
    if (out.confidence < 0.7) this.push({ kind: "reply", case_type: caseType, text, classification: out });
    return out;
  }
}

/**
 * PAID. Claude API through the official SDK. Only constructible when
 * providers.paid_enabled is true and ANTHROPIC_API_KEY is set; every call is
 * recorded in the cost ledger by the registry wrapper. Uses adaptive thinking
 * and plain-JSON answers parsed from the text block.
 */
export class ClaudeApiLlm extends RulesLlm {
  override readonly name = "claude_api";
  private client: import("@anthropic-ai/sdk").default | null = null;

  constructor(ctx: AdapterContext, private readonly onCall: (url: string) => void) {
    super(ctx);
  }

  private async sdk() {
    if (this.client) return this.client;
    const { default: Anthropic } = await import("@anthropic-ai/sdk");
    this.client = new Anthropic({ apiKey: this.ctx.env.ANTHROPIC_API_KEY });
    return this.client;
  }

  private async ask<T>(system: string, user: string, fallback: T): Promise<T> {
    this.onCall("https://api.anthropic.com/v1/messages");
    const client = await this.sdk();
    const response = await client.messages.create({
      model: optString(this.ctx.options, "model", "claude-opus-5"),
      max_tokens: 4096,
      thinking: { type: "adaptive" },
      system,
      messages: [{ role: "user", content: user }],
    });
    if (response.stop_reason === "refusal") return fallback;
    const text = response.content.find((b) => b.type === "text")?.text ?? "";
    const json = /\{[\s\S]*\}/.exec(text)?.[0];
    if (!json) return fallback;
    try {
      return { ...fallback, ...(JSON.parse(json) as Partial<T>) };
    } catch {
      return fallback;
    }
  }

  override async extractListing(input: ExtractionInput): Promise<ListingExtraction> {
    const base = await super.extractListing(input);
    const out = await this.ask<ListingExtraction>(
      "You extract commercial real-estate listing facts. Reply with ONLY a JSON object with keys: title, address_text, rent_monthly (number|null, base monthly rent in USD), sqft, has_office (bool|null), vehicle_capacity (int|null), shared_lot (bool|null), contact_email, contact_name, contact_phone, description, confidence (0..1). Never invent facts; use null when the page does not state them.",
      `Source: ${input.url}\n\n${htmlToText(input.block ?? input.html).slice(0, 12000)}`,
      base,
    );
    out.method = "claude_api";
    return out;
  }

  override async classifyReply(text: string, caseType: CaseType): Promise<ReplyClassification> {
    const base = await super.classifyReply(text, caseType);
    return this.ask<ReplyClassification>(
      `You classify an email reply to a ${caseType} inquiry from a used-car dealer. Reply with ONLY a JSON object with keys: intent (answer|stop|bounce|unrelated|unavailable), rent_monthly (number|null), rent_includes_nnn (bool|null), has_office (bool|null), vehicle_capacity (int|null), zoning_status (permitted|conditional|prohibited|null), zoning_citation (string|null), summary (<=240 chars), confidence (0..1). Only report figures explicitly stated in the reply.`,
      text.slice(0, 12000),
      base,
    );
  }
}
