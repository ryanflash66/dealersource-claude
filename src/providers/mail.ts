import type { SendMailOptions } from "nodemailer";
import type { CaseType } from "../core/types.js";
import { optNumber, optString } from "./options.js";
import type { AdapterContext, AlertMail, InboundMail, KnownThread, MailPreflight, MailProvider, OutboundMail, SendResult } from "./types.js";

export const TOKEN_RE = /\[DS-([A-Z0-9]{6})\]/;

/** The part of a nodemailer Transporter this adapter uses. */
export interface SmtpClient {
  verify(): Promise<unknown>;
  sendMail(mail: SendMailOptions): Promise<{ messageId?: string }>;
  close?(): void;
}

export interface ImapAddress {
  name?: string;
  address?: string;
}
export interface ImapStructure {
  part?: string;
  type: string;
  parameters?: Record<string, string>;
  disposition?: string;
  childNodes?: ImapStructure[];
}
export interface ImapMessage {
  uid: number;
  internalDate?: Date | string;
  envelope?: { subject?: string; messageId?: string; date?: Date | string; from?: ImapAddress[] };
  bodyStructure?: ImapStructure;
}
export interface ImapSearch {
  since?: Date;
  subject?: string;
  from?: string;
  or?: ImapSearch[];
}

/** The part of imapflow's ImapFlow this adapter uses (structural, so tests can supply a recorded mailbox). */
export interface ImapClient {
  connect(): Promise<void>;
  logout(): Promise<void>;
  list(): Promise<Array<{ path: string; specialUse?: string }>>;
  getMailboxLock(path: string): Promise<{ release(): void }>;
  search(query: ImapSearch, options: { uid: true }): Promise<number[] | false | undefined>;
  fetchAll(range: number[], query: { uid: true; envelope: true; internalDate: true; bodyStructure: true }, options: { uid: true }): Promise<ImapMessage[]>;
  download(uid: string, part: string | undefined, options: { uid: true }): Promise<{ meta?: { charset?: string }; content?: AsyncIterable<Buffer | string> }>;
}

/** Injected in tests; production builds real nodemailer / imapflow clients. */
export interface GmailTransports {
  smtp?: () => Promise<SmtpClient>;
  imap?: () => Promise<ImapClient>;
}

/** Google shows app passwords as four groups of four; spaces and wrapping quotes are not part of it. */
export function cleanAppPassword(v: string | undefined): string {
  return (v ?? "").trim().replace(/^(["'])(.*)\1$/, "$2").replace(/\s+/g, "");
}

/**
 * Gmail over SMTP (smtp.gmail.com:465, TLS) and IMAP (imap.gmail.com:993, TLS)
 * with an app password on the mailbox selected by business.yaml mail.sender.
 * Reply-To is the same mailbox, and replies are routed by the [DS-XXXXXX] subject
 * token. Refuses to send to planning addresses whose jurisdiction entry is not
 * `verified: true` (spec section 6: official-page-derived addresses only).
 * The app password is only ever handed to the SMTP/IMAP login and is redacted
 * from any error text this adapter returns.
 */
export class GmailMail implements MailProvider {
  readonly name = "gmail";
  readonly sender_address: string;
  private readonly password: string;
  private readonly missing: string[];
  private smtpClient: SmtpClient | null = null;

  constructor(
    private readonly ctx: AdapterContext,
    private readonly transports: GmailTransports = {},
  ) {
    this.sender_address = (ctx.env.GMAIL_SENDER_ADDRESS ?? "").trim();
    this.password = cleanAppPassword(ctx.env.GMAIL_APP_PASSWORD);
    this.missing = [...(this.sender_address ? [] : ["GMAIL_SENDER_ADDRESS"]), ...(this.password ? [] : ["GMAIL_APP_PASSWORD"])];
  }

  private get smtpHost(): string {
    return optString(this.ctx.options, "smtp_host", "smtp.gmail.com");
  }
  private get smtpPort(): number {
    return optNumber(this.ctx.options, "smtp_port", 465);
  }
  private get imapHost(): string {
    return optString(this.ctx.options, "imap_host", "imap.gmail.com");
  }
  private get imapPort(): number {
    return optNumber(this.ctx.options, "imap_port", 993);
  }

  private requireCredentials(host: string): void {
    if (this.missing.length) throw new Error(`mail:gmail unavailable, set ${this.missing.join(", ")} (${host})`);
  }

  /** Error text with the app password removed, whatever the library put in it. */
  private safe(e: unknown): string {
    const msg = e instanceof Error ? e.message : String(e);
    return this.password ? msg.split(this.password).join("[redacted]") : msg;
  }

  private async smtp(): Promise<SmtpClient> {
    this.requireCredentials(this.smtpHost);
    if (this.smtpClient) return this.smtpClient;
    if (this.transports.smtp) {
      this.smtpClient = await this.transports.smtp();
    } else {
      if (this.ctx.offline) throw new Error(`offline: network refused (${this.smtpHost})`);
      const nodemailer = (await import("nodemailer")).default;
      this.smtpClient = nodemailer.createTransport({
        host: this.smtpHost,
        port: this.smtpPort,
        secure: true,
        auth: { user: this.sender_address, pass: this.password },
        logger: false,
        debug: false,
        connectionTimeout: 20_000,
        greetingTimeout: 20_000,
        socketTimeout: 60_000,
      }) as unknown as SmtpClient;
      this.ctx.onExternalHost?.(this.smtpHost);
    }
    return this.smtpClient;
  }

  private async imap(): Promise<ImapClient> {
    this.requireCredentials(this.imapHost);
    if (this.transports.imap) return this.transports.imap();
    if (this.ctx.offline) throw new Error(`offline: network refused (${this.imapHost})`);
    const { ImapFlow } = await import("imapflow");
    this.ctx.onExternalHost?.(this.imapHost);
    return new ImapFlow({
      host: this.imapHost,
      port: this.imapPort,
      secure: true,
      auth: { user: this.sender_address, pass: this.password },
      logger: false,
      connectionTimeout: 30_000,
      greetingTimeout: 20_000,
      socketTimeout: 120_000,
    }) as unknown as ImapClient;
  }

  /** Log in to SMTP and IMAP without sending or reading anything. */
  async preflight(): Promise<MailPreflight> {
    this.requireCredentials(this.smtpHost);
    const out: MailPreflight = { smtp_login: false, imap_login: false, mailbox: this.sender_address, notes: [] };
    try {
      await (await this.smtp()).verify();
      out.smtp_login = true;
    } catch (e) {
      out.notes.push(`SMTP ${this.smtpHost}:${this.smtpPort} login failed: ${this.safe(e)}`);
    }
    let client: ImapClient | null = null;
    try {
      client = await this.imap();
      await client.connect();
      out.imap_login = true;
    } catch (e) {
      out.notes.push(`IMAP ${this.imapHost}:${this.imapPort} login failed: ${this.safe(e)}`);
    } finally {
      if (client && out.imap_login) await client.logout().catch(() => undefined);
    }
    return out;
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
    const smtp = await this.smtp();
    try {
      const info = await smtp.sendMail({
        from: this.sender_address,
        to: mail.to,
        replyTo: mail.replyTo ?? this.sender_address,
        subject: mail.subject,
        text: mail.body,
      });
      return { provider_message_id: info.messageId ?? `smtp-${mail.token}`, thread_id: mail.token };
    } catch (e) {
      if (isSendingLimit(e)) throw new GmailQuotaError(`Gmail sending limit: ${this.safe(e)}`);
      throw new Error(`Gmail SMTP send failed: ${this.safe(e)}`);
    }
  }

  async fetchInbound(opts: { since: string; until: string; threads: KnownThread[] }): Promise<InboundMail[]> {
    return this.withMailbox((client, box) => this.readInbound(client, box, opts));
  }

  /**
   * Saved-search alert emails (LoopNet, Crexi) in the same mailbox, from any of the sender
   * domains. Only the message is read; nothing it links to is requested.
   */
  async fetchAlerts(opts: { since: string; until: string; from: string[] }): Promise<AlertMail[]> {
    const domains = [...new Set(opts.from.map((d) => d.trim().toLowerCase().replace(/^@/, "")).filter(Boolean))];
    if (!domains.length) return [];
    return this.withMailbox((client, box) => this.readAlerts(client, box, { ...opts, domains }));
  }

  private async withMailbox<T>(read: (client: ImapClient, box: string) => Promise<T>): Promise<T> {
    const client = await this.imap();
    try {
      await client.connect();
    } catch (e) {
      throw new Error(`Gmail IMAP login failed: ${this.safe(e)}`);
    }
    try {
      const box = await this.pickMailbox(client);
      const lock = await client.getMailboxLock(box);
      try {
        return await read(client, box);
      } finally {
        lock.release();
      }
    } finally {
      await client.logout().catch(() => undefined);
    }
  }

  private async readAlerts(client: ImapClient, box: string, opts: { since: string; until: string; domains: string[] }): Promise<AlertMail[]> {
    const since = new Date(opts.since);
    const sinceMs = since.getTime();
    const untilMs = new Date(opts.until).getTime();
    // IMAP FROM is a substring match on the header; the exact domain is checked below.
    const query: ImapSearch = opts.domains.length === 1 ? { since, from: opts.domains[0]! } : { since, or: opts.domains.map((d) => ({ from: d })) };
    const uids = (await client.search(query, { uid: true })) || [];
    if (!uids.length) return [];
    const max = optNumber(this.ctx.options, "max_messages", 200);
    const msgs = await client.fetchAll(uids.slice(-max), { uid: true, envelope: true, internalDate: true, bodyStructure: true }, { uid: true });
    const me = this.sender_address.toLowerCase();
    const out: AlertMail[] = [];
    for (const m of msgs) {
      const env = m.envelope ?? {};
      const from = (env.from?.[0]?.address ?? "").toLowerCase();
      if (!from || from === me || !opts.domains.some((d) => fromDomain(from, d))) continue;
      const receivedAt = toIso(m.internalDate ?? env.date);
      if (!receivedAt) continue;
      const t = new Date(receivedAt).getTime();
      if (t < sinceMs || t > untilMs) continue;
      const htmlPart = findPart(m.bodyStructure, "text/html");
      const textPart = findPart(m.bodyStructure, "text/plain");
      const html = htmlPart === null ? "" : await readAll((await client.download(String(m.uid), htmlPart, { uid: true })).content, 1024 * 1024);
      const text = textPart === null ? "" : await readAll((await client.download(String(m.uid), textPart, { uid: true })).content, 256 * 1024);
      out.push({
        provider_message_id: env.messageId ?? `imap:${box}:${m.uid}`,
        from,
        subject: env.subject ?? "",
        received_at: receivedAt,
        html: html || null,
        text: text || null,
      });
    }
    return out.sort((a, b) => a.received_at.localeCompare(b.received_at));
  }

  /** All Mail (so archived replies are still seen), falling back to INBOX. */
  private async pickMailbox(client: ImapClient): Promise<string> {
    const configured = optString(this.ctx.options, "mailbox", "");
    if (configured) return configured;
    const boxes = await client.list();
    return boxes.find((b) => b.specialUse === "\\All")?.path ?? "INBOX";
  }

  private async readInbound(client: ImapClient, box: string, opts: { since: string; until: string; threads: KnownThread[] }): Promise<InboundMail[]> {
    const since = new Date(opts.since);
    const sinceMs = since.getTime();
    const untilMs = new Date(opts.until).getTime();
    // IMAP SINCE is day-granular; exact bounds are applied below.
    const uids = (await client.search({ since, or: [{ subject: "[DS-" }, { from: "mailer-daemon" }, { from: "postmaster" }] }, { uid: true })) || [];
    if (!uids.length) return [];
    const max = optNumber(this.ctx.options, "max_messages", 200);
    const msgs = await client.fetchAll(uids.slice(-max), { uid: true, envelope: true, internalDate: true, bodyStructure: true }, { uid: true });
    const me = this.sender_address.toLowerCase();
    const out: InboundMail[] = [];
    for (const m of msgs) {
      const env = m.envelope ?? {};
      const from = env.from?.[0]?.address ?? "";
      if (from.toLowerCase() === me) continue; // our own sent copies live in All Mail too
      const receivedAt = toIso(m.internalDate ?? env.date);
      if (!receivedAt) continue;
      const t = new Date(receivedAt).getTime();
      if (t < sinceMs || t > untilMs) continue;
      const subject = env.subject ?? "";
      const is_bounce = /mailer-daemon|postmaster/i.test(`${env.from?.[0]?.name ?? ""} ${from}`) || /undeliverable|delivery status notification/i.test(subject);
      const body = await this.plainText(client, m);
      let token = TOKEN_RE.exec(subject)?.[1] ?? null;
      // A real Gmail bounce carries our subject only inside the returned original message.
      if (!token && is_bounce) token = TOKEN_RE.exec(body)?.[1] ?? TOKEN_RE.exec(await this.source(client, m.uid))?.[1] ?? null;
      if (!token && !is_bounce) continue;
      const thread = token ? opts.threads.find((x) => x.token === token) : undefined;
      out.push({
        provider_message_id: env.messageId ?? `imap:${box}:${m.uid}`,
        from,
        subject,
        body,
        received_at: receivedAt,
        token,
        listing_id: thread?.listing_ids[0] ?? null,
        case_type: null,
        is_bounce,
      });
    }
    return out;
  }

  private async plainText(client: ImapClient, m: ImapMessage): Promise<string> {
    const part = findPart(m.bodyStructure, "text/plain");
    if (part === null) return "";
    const d = await client.download(String(m.uid), part, { uid: true });
    return readAll(d.content, 256 * 1024);
  }

  private async source(client: ImapClient, uid: number): Promise<string> {
    const d = await client.download(String(uid), undefined, { uid: true });
    return readAll(d.content, 512 * 1024);
  }
}

export class GmailQuotaError extends Error {}

/** Gmail SMTP throttling / daily-limit replies (421, 452, 454, 5.4.5, "limit exceeded"). */
function isSendingLimit(e: unknown): boolean {
  const x = e as { responseCode?: number; response?: string; message?: string };
  if (x?.responseCode === 421 || x?.responseCode === 452 || x?.responseCode === 454) return true;
  return /5\.4\.5|limit exceeded|too many messages/i.test(`${x?.response ?? ""} ${x?.message ?? ""}`);
}

/** An address at the domain or one of its subdomains (alerts@e.loopnet.com is loopnet.com). */
function fromDomain(address: string, domain: string): boolean {
  const host = address.slice(address.lastIndexOf("@") + 1);
  return host === domain || host.endsWith(`.${domain}`);
}

/** First inline part of the type (text/plain, text/html); "1" for a single-part message. */
function findPart(s: ImapStructure | undefined, type: string): string | null {
  if (!s) return null;
  const walk = (n: ImapStructure): string | null => {
    if (n.type?.toLowerCase() === type && n.disposition?.toLowerCase() !== "attachment") return n.part ?? "1";
    for (const c of n.childNodes ?? []) {
      const hit = walk(c);
      if (hit) return hit;
    }
    return null;
  };
  return walk(s);
}

async function readAll(content: AsyncIterable<Buffer | string> | undefined, cap: number): Promise<string> {
  if (!content) return "";
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const c of content) {
    const b = typeof c === "string" ? Buffer.from(c, "utf8") : c;
    chunks.push(b);
    size += b.length;
    if (size >= cap) break;
  }
  return Buffer.concat(chunks).toString("utf8");
}

function toIso(d: Date | string | undefined): string | null {
  if (!d) return null;
  const t = new Date(d).getTime();
  return Number.isFinite(t) ? new Date(t).toISOString() : null;
}

export type { CaseType };
