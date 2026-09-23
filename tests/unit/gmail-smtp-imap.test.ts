import { describe, expect, it } from "vitest";
import { resolve } from "node:path";
import { Readable } from "node:stream";
import nodemailer from "nodemailer";
import { makeClock } from "../../src/core/clock.js";
import type { Logger } from "../../src/core/logger.js";
import { StageCounter, type RunContext } from "../../src/pipeline/context.js";
import { mailPreflight } from "../../src/pipeline/verify.js";
import { GmailMail, GmailQuotaError, cleanAppPassword, type ImapClient, type ImapMessage, type ImapSearch, type SmtpClient } from "../../src/providers/mail.js";
import type { KnownThread, MailProvider } from "../../src/providers/types.js";
import { ROOT, adapterCtx, readJson } from "../helpers.js";

const SENDER = "dealer@example.test";
const APP_PASSWORD = "abcd efgh ijkl mnop"; // Google's display format; the adapter strips the spaces
const ENV = { GMAIL_SENDER_ADDRESS: SENDER, GMAIL_APP_PASSWORD: APP_PASSWORD };
const THREADS: KnownThread[] = [
  { token: "2D276E", listing_ids: ["L04"], case_types: ["rent"], contact_email: "owner@tenth-street-props.test", address: "3100 E 10th St" },
  { token: "BBBBBB", listing_ids: ["L09"], case_types: ["rent"], contact_email: "leasing@gone-broker.test", address: "2 Silent St" },
];

interface RecordedMessage extends ImapMessage {
  parts: Record<string, string>;
  source?: string;
}

/** Serves fixtures/mail/gmail-imap.json through the ImapClient surface imapflow provides. */
class FakeImap implements ImapClient {
  readonly calls: string[] = [];
  private readonly fx = readJson(resolve(ROOT, "fixtures", "mail", "gmail-imap.json")) as { mailboxes: Array<{ path: string; specialUse?: string }>; messages: RecordedMessage[] };
  constructor(private readonly failLogin: string | null = null) {}
  async connect() {
    this.calls.push("connect");
    if (this.failLogin) throw new Error(this.failLogin);
  }
  async logout() {
    this.calls.push("logout");
  }
  async list() {
    return this.fx.mailboxes;
  }
  async getMailboxLock(path: string) {
    this.calls.push(`lock ${path}`);
    return { release: () => void this.calls.push(`release ${path}`) };
  }
  async search(q: ImapSearch) {
    // IMAP SINCE compares dates only; SUBJECT/FROM are case-insensitive substrings.
    const sinceDay = q.since ? q.since.toISOString().slice(0, 10) : "0000";
    const hit = (m: RecordedMessage, s: ImapSearch): boolean =>
      (!s.subject || (m.envelope?.subject ?? "").toLowerCase().includes(s.subject.toLowerCase())) &&
      (!s.from || (m.envelope?.from ?? []).some((a) => `${a.name} ${a.address}`.toLowerCase().includes(s.from!.toLowerCase())));
    return this.fx.messages
      .filter((m) => String(m.internalDate).slice(0, 10) >= sinceDay && (!q.or || q.or.some((o) => hit(m, o))))
      .map((m) => m.uid);
  }
  async fetchAll(range: number[]) {
    return this.fx.messages.filter((m) => range.includes(m.uid));
  }
  async download(uid: string, part: string | undefined) {
    const m = this.fx.messages.find((x) => String(x.uid) === uid)!;
    const text = part === undefined ? (m.source ?? Object.values(m.parts).join("\n")) : (m.parts[part] ?? "");
    return { meta: { charset: "utf-8" }, content: Readable.from([Buffer.from(text, "utf8")]) };
  }
}

function recordingSmtp(opts: { failVerify?: string; failSend?: Error } = {}) {
  const stream = nodemailer.createTransport({ streamTransport: true, buffer: true, newline: "windows" });
  const sent: string[] = [];
  const client: SmtpClient = {
    verify: async () => {
      if (opts.failVerify) throw new Error(opts.failVerify);
      return true;
    },
    sendMail: async (m) => {
      if (opts.failSend) throw opts.failSend;
      const info = (await stream.sendMail(m)) as unknown as { messageId: string; message: Buffer };
      sent.push(info.message.toString("utf8"));
      return info;
    },
  };
  return { client, sent };
}

describe("gmail over SMTP + IMAP (app password)", () => {
  it("sends plain-text RFC822 mail from the sender with Reply-To = sender and the [DS-] token in the subject", async () => {
    const smtp = recordingSmtp();
    const g = new GmailMail(adapterCtx("gmail", ENV), { smtp: async () => smtp.client });
    const res = await g.send({ to: "owner@tenth-street-props.test", subject: "Inquiry about 3100 E 10th St [DS-2D276E]", body: "hello", token: "2D276E", replyTo: null });
    expect(res.thread_id).toBe("2D276E");
    expect(res.provider_message_id).toMatch(/^<.+@.+>$/);
    const raw = smtp.sent[0]!;
    expect(raw).toMatch(/^From: dealer@example\.test\r$/m);
    expect(raw).toMatch(/^To: owner@tenth-street-props\.test\r$/m);
    expect(raw).toMatch(/^Reply-To: dealer@example\.test\r$/m);
    expect(raw).toMatch(/^Subject: Inquiry about 3100 E 10th St \[DS-2D276E\]\r$/m);
    expect(raw).toMatch(/^Content-Type: text\/plain/m);
  });

  it("refuses planning addresses whose jurisdiction entry is not verified, before any SMTP connection", async () => {
    const ctx = adapterCtx("gmail", ENV);
    const gv = ctx.config.business.jurisdictions.Greenville!;
    ctx.config.business.jurisdictions.Greenville = { ...gv, verified: false };
    let connected = false;
    const g = new GmailMail(ctx, { smtp: async () => ((connected = true), recordingSmtp().client) });
    await expect(g.send({ to: gv.planning_email, subject: "x", body: "y", token: "T", replyTo: null })).rejects.toThrow(/not verified/);
    expect(connected).toBe(false);
  });

  it("maps Gmail's daily-limit reply to GmailQuotaError (the pipeline pauses on it)", async () => {
    const err = Object.assign(new Error("Message failed: 550-5.4.5 Daily user sending limit exceeded."), { responseCode: 550, response: "550-5.4.5 Daily user sending limit exceeded." });
    const g = new GmailMail(adapterCtx("gmail", ENV), { smtp: async () => recordingSmtp({ failSend: err }).client });
    await expect(g.send({ to: "a@b.test", subject: "s [DS-AAAAAA]", body: "b", token: "AAAAAA", replyTo: null })).rejects.toBeInstanceOf(GmailQuotaError);
  });

  it("reads replies and bounces from All Mail over IMAP, routed by the [DS-] token", async () => {
    const imap = new FakeImap();
    const g = new GmailMail(adapterCtx("gmail", ENV), { imap: async () => imap });
    const inbound = await g.fetchInbound({ since: "2026-09-01T00:00:00Z", until: "2026-09-16T23:59:59Z", threads: THREADS });
    expect(imap.calls).toEqual(["connect", "lock [Gmail]/All Mail", "release [Gmail]/All Mail", "logout"]);
    // reply + subject-token bounce + real-shape bounce; not our own sent copy, not after the cutoff, not before the window, not unrelated mail
    expect(inbound.map((m) => [m.token, m.is_bounce])).toEqual([["2D276E", false], ["AAAAAA", true], ["BBBBBB", true]]);
    const reply = inbound[0]!;
    expect(reply).toMatchObject({ from: "owner@tenth-street-props.test", listing_id: "L04", provider_message_id: "<CAH-reply-1@mail.tenth-street-props.test>", received_at: "2026-09-16T18:02:00.000Z" });
    expect(reply.body).toContain("$850 per month");
    expect(reply.body).not.toContain("<p>");
    expect(inbound[2]).toMatchObject({ from: "mailer-daemon@googlemail.com", listing_id: "L09" }); // token found in the returned headers
  });

  it("preflight logs in to SMTP and IMAP and sends nothing", async () => {
    const smtp = recordingSmtp();
    const imap = new FakeImap();
    const g = new GmailMail(adapterCtx("gmail", ENV), { smtp: async () => smtp.client, imap: async () => imap });
    expect(await g.preflight()).toEqual({ smtp_login: true, imap_login: true, mailbox: SENDER, notes: [] });
    expect(smtp.sent).toEqual([]);
    expect(imap.calls).toEqual(["connect", "logout"]);
  });

  it("preflight failures never carry the app password", async () => {
    const leaky = "Invalid login: 535-5.7.8 Username and Password not accepted for abcdefghijklmnop";
    const g = new GmailMail(adapterCtx("gmail", ENV), { smtp: async () => recordingSmtp({ failVerify: leaky }).client, imap: async () => new FakeImap("AUTHENTICATIONFAILED abcdefghijklmnop") });
    const p = await g.preflight();
    expect(p).toMatchObject({ smtp_login: false, imap_login: false });
    expect(p.notes).toHaveLength(2);
    expect(p.notes.join(" ")).not.toContain("abcdefghijklmnop");
    expect(p.notes[0]).toMatch(/^SMTP smtp\.gmail\.com:465 login failed: .*\[redacted\]/);
    expect(p.notes[1]).toMatch(/^IMAP imap\.gmail\.com:993 login failed:/);
  });

  it("without GMAIL_APP_PASSWORD it reports itself unavailable; offline it never opens a socket", async () => {
    const noPass = new GmailMail(adapterCtx("gmail", { GMAIL_SENDER_ADDRESS: SENDER }));
    await expect(noPass.preflight()).rejects.toThrow(/mail:gmail unavailable, set GMAIL_APP_PASSWORD/);
    await expect(noPass.send({ to: "a@b.test", subject: "s", body: "b", token: "T", replyTo: null })).rejects.toThrow(/unavailable/);
    const offline = new GmailMail(adapterCtx("gmail", ENV)); // adapterCtx is offline, no transports injected
    await expect(offline.fetchInbound({ since: "2026-09-01T00:00:00Z", until: "2026-09-16T23:59:59Z", threads: [] })).rejects.toThrow(/offline: network refused \(imap\.gmail\.com\)/);
  });

  it("app password format: spaces and wrapping quotes are stripped", () => {
    expect(cleanAppPassword("abcd efgh ijkl mnop")).toBe("abcdefghijklmnop");
    expect(cleanAppPassword(' "abcd efgh ijkl mnop" ')).toBe("abcdefghijklmnop");
    expect(cleanAppPassword(undefined)).toBe("");
  });
});

describe("verify-stage mail preflight", () => {
  const lines: Array<[string, string, Record<string, unknown>]> = [];
  const logger = {
    info: (m: string, d: Record<string, unknown> = {}) => lines.push(["info", m, d]),
    warn: (m: string, d: Record<string, unknown> = {}) => lines.push(["warn", m, d]),
    error: (m: string, d: Record<string, unknown> = {}) => lines.push(["error", m, d]),
    debug: () => undefined,
    child: () => logger,
  } as unknown as Logger;
  const ctxWith = (mail: MailProvider) =>
    ({ offline: false, providers: { mail }, logger, clock: makeClock("2026-09-16T10:00:00.000Z"), run: { warnings: [], sending_paused: false, pause_reason: null } }) as unknown as RunContext;

  it("logs smtp_login ok / imap_login ok and leaves sending alone when both succeed", async () => {
    lines.length = 0;
    const ctx = ctxWith(new GmailMail(adapterCtx("gmail", ENV), { smtp: async () => recordingSmtp().client, imap: async () => new FakeImap() }));
    const c = new StageCounter(ctx, "verify");
    await mailPreflight(ctx, c);
    expect(c.counts.mail_preflight_ok).toBe(1);
    expect(lines).toContainEqual(["info", "mail preflight", expect.objectContaining({ smtp_login: "ok", imap_login: "ok", mailbox: SENDER })]);
    expect(ctx.run.sending_paused).toBe(false);
    expect(JSON.stringify(lines)).not.toContain("abcdefghijklmnop");
  });

  it("an IMAP login failure pauses sending (replies, including stop requests, would go unseen)", async () => {
    lines.length = 0;
    const ctx = ctxWith(new GmailMail(adapterCtx("gmail", ENV), { smtp: async () => recordingSmtp().client, imap: async () => new FakeImap("AUTHENTICATIONFAILED") }));
    const c = new StageCounter(ctx, "verify");
    await mailPreflight(ctx, c);
    expect(c.counts.mail_preflight_failed).toBe(1);
    expect(ctx.run.sending_paused).toBe(true);
    expect(ctx.run.pause_reason).toBe("mail preflight failed (IMAP login)");
    expect(ctx.run.warnings.some((w) => /IMAP imap\.gmail\.com:993 login failed/.test(w))).toBe(true);
  });
});
