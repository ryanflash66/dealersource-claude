import type { CaseType } from "../core/types.js";
import { optString } from "./options.js";
import type { AdapterContext, InboundMail, KnownThread, MailProvider, OutboundMail, SendResult, MailPreflight } from "./types.js";

export const TOKEN_RE = /\[DS-([A-Z0-9]{6})\]/;

interface GmailMessage {
  id: string;
  threadId: string;
  internalDate?: string;
  payload?: {
    headers?: Array<{ name: string; value: string }>;
    mimeType?: string;
    body?: { data?: string };
    parts?: Array<{ mimeType: string; body?: { data?: string }; parts?: GmailMessage["payload"] extends infer P ? (P extends { parts?: infer Q } ? Q : never) : never }>;
  };
}

/**
 * Gmail API via OAuth refresh token. The mailbox is the one selected by
 * business.yaml mail.sender (owner or operator); Reply-To is the same mailbox.
 * Refuses to send to planning addresses whose jurisdiction entry is not
 * `verified: true` (spec section 6: official-page-derived addresses only).
 */
export class GmailMail implements MailProvider {
  readonly name = "gmail";
  readonly sender_address: string;
  private accessToken: string | null = null;

  constructor(private readonly ctx: AdapterContext) {
    this.sender_address = ctx.env.GMAIL_SENDER_ADDRESS ?? "";
  }

  private base(): string {
    return optString(this.ctx.options, "base_url", "https://gmail.googleapis.com/gmail/v1").replace(/\/+$/, "");
  }

  private async token(): Promise<string> {
    if (this.accessToken) return this.accessToken;
    const res = await this.ctx.http.request({
      method: "POST",
      url: optString(this.ctx.options, "token_url", "https://oauth2.googleapis.com/token"),
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: this.ctx.env.GMAIL_CLIENT_ID ?? "",
        client_secret: this.ctx.env.GMAIL_CLIENT_SECRET ?? "",
        refresh_token: this.ctx.env.GMAIL_REFRESH_TOKEN ?? "",
        grant_type: "refresh_token",
      }).toString(),
    });
    if (!res.ok) throw new Error(`Gmail token refresh failed: ${res.status}`);
    this.accessToken = res.json<{ access_token: string }>().access_token;
    return this.accessToken;
  }

  async preflight(): Promise<MailPreflight> {
    const tok = await this.token(); // throws on a bad client/secret/refresh token; the token itself is never logged
    const res = await this.ctx.http.request({ method: "GET", url: `${this.base()}/users/me/profile`, headers: { Authorization: `Bearer ${tok}` } });
    if (!res.ok) return { access_token_obtained: true, mailbox: null, note: `profile not readable (HTTP ${res.status}); the reply poller needs a gmail read scope` };
    return { access_token_obtained: true, mailbox: res.json<{ emailAddress?: string }>().emailAddress ?? null };
  }

  private assertRecipientAllowed(to: string): void {
    const j = Object.values(this.ctx.config.business.jurisdictions).find(
      (x) => x.planning_email.toLowerCase() === to.toLowerCase(),
    );
    if (j && !j.verified) {
      throw new Error(`Refusing to email ${to}: jurisdiction entry not verified against ${j.source_url}`);
    }
  }

  async send(mail: OutboundMail): Promise<SendResult> {
    this.assertRecipientAllowed(mail.to);
    const raw = [
      `From: ${this.sender_address}`,
      `To: ${mail.to}`,
      `Reply-To: ${mail.replyTo ?? this.sender_address}`,
      `Subject: ${mail.subject}`,
      "MIME-Version: 1.0",
      'Content-Type: text/plain; charset="UTF-8"',
      "",
      mail.body,
    ].join("\r\n");
    const res = await this.ctx.http.request({
      method: "POST",
      url: `${this.base()}/users/me/messages/send`,
      headers: { Authorization: `Bearer ${await this.token()}`, "Content-Type": "application/json" },
      body: JSON.stringify({ raw: Buffer.from(raw, "utf8").toString("base64url") }),
    });
    if (res.status === 429 || res.status === 403) throw new GmailQuotaError(`Gmail quota/permission error ${res.status}`);
    if (!res.ok) throw new Error(`Gmail send failed: ${res.status} ${res.body.slice(0, 200)}`);
    const j = res.json<{ id: string; threadId: string }>();
    return { provider_message_id: j.id, thread_id: j.threadId };
  }

  async fetchInbound(opts: { since: string; until: string; threads: KnownThread[] }): Promise<InboundMail[]> {
    const tok = await this.token();
    const afterEpoch = Math.floor(new Date(opts.since).getTime() / 1000);
    const q = `subject:"[DS-" after:${afterEpoch} -from:me`;
    const list = await this.ctx.http.request({
      url: `${this.base()}/users/me/messages?${new URLSearchParams({ q, maxResults: "100" })}`,
      headers: { Authorization: `Bearer ${tok}` },
    });
    if (!list.ok) throw new Error(`Gmail list failed: ${list.status}`);
    const ids = list.json<{ messages?: Array<{ id: string }> }>().messages ?? [];
    const until = new Date(opts.until).getTime();
    const out: InboundMail[] = [];
    for (const { id } of ids) {
      const res = await this.ctx.http.request({
        url: `${this.base()}/users/me/messages/${id}?format=full`,
        headers: { Authorization: `Bearer ${tok}` },
      });
      if (!res.ok) continue;
      const m = res.json<GmailMessage>();
      const header = (n: string) => m.payload?.headers?.find((h) => h.name.toLowerCase() === n.toLowerCase())?.value ?? "";
      const receivedAt = m.internalDate ? new Date(Number(m.internalDate)).toISOString() : new Date(header("Date")).toISOString();
      if (new Date(receivedAt).getTime() > until) continue;
      const subject = header("Subject");
      const token = TOKEN_RE.exec(subject)?.[1] ?? null;
      const thread = token ? opts.threads.find((t) => t.token === token) : undefined;
      const from = header("From");
      out.push({
        provider_message_id: m.id,
        from: /<([^>]+)>/.exec(from)?.[1] ?? from,
        subject,
        body: extractPlainText(m),
        received_at: receivedAt,
        token,
        listing_id: thread?.listing_ids[0] ?? null,
        case_type: null,
        is_bounce: /mailer-daemon|postmaster/i.test(from) || /undeliverable|delivery status notification/i.test(subject),
      });
    }
    return out;
  }
}

export class GmailQuotaError extends Error {}

function extractPlainText(m: GmailMessage): string {
  const decode = (d?: string) => (d ? Buffer.from(d, "base64url").toString("utf8") : "");
  const p = m.payload;
  if (!p) return "";
  if (p.body?.data) return decode(p.body.data);
  const walk = (parts: any[] | undefined): string => {
    for (const part of parts ?? []) {
      if (part.mimeType === "text/plain" && part.body?.data) return decode(part.body.data);
      const nested = walk(part.parts);
      if (nested) return nested;
    }
    return "";
  };
  return walk(p.parts as any[]);
}

export type { CaseType };
