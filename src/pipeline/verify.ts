import { addDays, daysBetween } from "../core/clock.js";
import { dsToken, sha256, stableId } from "../core/ids.js";
import type { CaseRow, CaseType, ContactRole, ContactRow, EvidenceRow, MessageRow, SiteRow } from "../core/types.js";
import type { InboundMail, KnownThread } from "../providers/types.js";
import { GmailQuotaError } from "../providers/mail.js";
import { evaluateGates, requirements } from "./gates.js";
import { renderEmail } from "./templates.js";
import { StageCounter, allEvidence, currentEvidence, errMsg, writeEvidence, type RunContext } from "./context.js";

/**
 * Stage 4: verify. Every unknown gating fact becomes a case with an owner and
 * a next action; the system sends the approved emails itself, then ingests
 * replies visible on the run date and turns them into evidence.
 *
 * Order (spec 14.3): open/advance cases -> queue outbound -> ingest replies.
 * Idempotency: one email per (recipient, site) per followup window, resolved
 * cases never re-open, inbound messages are keyed by provider id.
 */
export async function verify(ctx: RunContext): Promise<StageCounter> {
  const c = new StageCounter(ctx, "verify");
  // Sites confirmed outside the area get no outreach; unknown distance (null) is still verified.
  const sites = (await ctx.store.list("sites")).filter((s) => s.in_search_area !== false);
  for (const site of sites) {
    try {
      await openCases(ctx, c, site);
    } catch (e) {
      c.warn(`cases for ${site.id}: ${errMsg(e)}`, { site: site.id });
    }
  }
  await closeCasesForExcludedSites(ctx, c);
  await mailPreflight(ctx, c);
  await checkPause(ctx, c);
  await sendOutbound(ctx, c);
  await ingestReplies(ctx, c);
  return c;
}

// ---------------------------------------------------------------- cases
const caseId = (siteId: string, type: CaseType) => `${siteId}:${type}`;

async function openCases(ctx: RunContext, c: StageCounter, site: SiteRow): Promise<void> {
  const now = ctx.clock.iso();
  const gates = evaluateGates(ctx.config.business, {
    now,
    zoning: await allEvidence(ctx, site.id, "zoning_permitted"),
    rent: await allEvidence(ctx, site.id, "rent_monthly"),
    flood: await allEvidence(ctx, site.id, "flood_zone"),
  });
  const gateFail = Object.values(gates).some((g) => g.status === "fail");
  // Known failure of a statutory place-of-business check: the site can never be licensed, so no outreach.
  const statutoryFail = requirements(ctx.config.business, site).some((r) => r.statutory && r.outcome === "not_met");
  const anyFail = gateFail || statutoryFail;
  const existing = new Map((await ctx.store.list("cases", { site_id: site.id })).map((k) => [k.type, k]));
  const primaryListing = site.listing_ids[0] ?? "";

  const want: Array<{ type: CaseType; role: ContactRole; email: string | null; derivedFrom: string }> = [];
  if (!anyFail) {
    if (gates.rent.status === "pending") want.push({ type: "rent", role: "leasing", email: site.contact_email, derivedFrom: listingUrl(ctx, site) });
    if (gates.zoning.status === "pending") want.push({ type: "zoning", role: "planning", email: site.planning_email, derivedFrom: planningSource(ctx, site) });
    const office = await currentEvidence(ctx, site.id, "office");
    const cap = await currentEvidence(ctx, site.id, "vehicle_display");
    const b = ctx.config.business;
    const needOffice = (b.site.office_required || b.dealer.place_of_business_checks.enclosed_office) && !office;
    if (needOffice || !cap) want.push({ type: "space", role: "leasing", email: site.contact_email, derivedFrom: listingUrl(ctx, site) });
  }

  for (const w of want) {
    const prev = existing.get(w.type);
    let contact: ContactRow | null = null;
    if (w.email) contact = await upsertContact(ctx, w.email, w.role, w.derivedFrom);
    if (prev && prev.status !== "closed") {
      // Escalated once for a missing contact: reopen only when a contact has since been published.
      if (prev.status === "escalated" && !prev.contact_id && contact) {
        await ctx.store.upsert("cases", [{ ...prev, status: "open", owner: "system", contact_id: contact.id, next_action: `email ${w.role} contact`, next_action_at: now, updated_at: now }]);
        c.inc("cases_reopened_with_contact");
      } else if (prev.status === "open" && contact && prev.contact_id !== contact.id && prev.followups_sent === 0 && !prev.last_contacted_at) {
        // The verified address changed (e.g. business.yaml corrected) before anything was sent: point the case at it.
        await ctx.store.upsert("cases", [{ ...prev, contact_id: contact.id, updated_at: now }]);
        c.inc("cases_contact_replaced");
      }
      continue;
    }
    const row: CaseRow = {
      id: caseId(site.id, w.type),
      site_id: site.id,
      listing_id: primaryListing,
      type: w.type,
      status: contact ? "open" : "escalated",
      owner: contact ? "system" : "human",
      contact_id: contact?.id ?? null,
      contact_role: w.role,
      next_action: contact ? `email ${w.role} contact` : missingContactNote(site, w.role),
      next_action_at: now,
      followups_sent: 0,
      last_contacted_at: null,
      opened_at: now,
      updated_at: now,
      resolved_at: null,
      resolution: null,
      evidence_id: null,
    };
    await ctx.store.upsert("cases", [row]);
    c.inc(contact ? "cases_opened" : "cases_escalated_no_contact");
  }

  // Cases whose fact is now verified (e.g. by a listing on a later run) or whose site failed a gate.
  for (const k of existing.values()) {
    if (k.status === "resolved" || k.status === "closed") continue;
    const stillNeeded = want.some((w) => w.type === k.type);
    if (anyFail || !stillNeeded) {
      await ctx.store.upsert("cases", [{ ...k, status: "closed", next_action: gateFail ? "site failed a gate; no outreach" : statutoryFail ? "site fails an NC established-salesroom requirement; no outreach" : "fact verified elsewhere", updated_at: now }]);
      c.inc("cases_closed");
    }
  }
}

function listingUrl(ctx: RunContext, site: SiteRow): string {
  return `listing:${site.listing_ids[0] ?? site.id}`;
}
function planningSource(ctx: RunContext, site: SiteRow): string {
  const j = Object.entries(ctx.config.business.jurisdictions).find(([n]) => site.jurisdiction?.toLowerCase().includes(n.toLowerCase()));
  return j?.[1].source_url ?? `zoning-layer:${site.jurisdiction ?? "unknown"}`;
}

async function upsertContact(ctx: RunContext, email: string, role: ContactRole, derivedFrom: string): Promise<ContactRow> {
  const id = `ct_${sha256(email.trim().toLowerCase()).slice(0, 16)}`;
  const prev = await ctx.store.get("contacts", id);
  if (prev) return prev;
  const row: ContactRow = {
    id,
    email: email.trim(),
    name: null,
    org: null,
    role,
    derived_from_url: derivedFrom,
    do_not_contact: false,
    bounced: false,
    created_at: ctx.clock.iso(),
  };
  await ctx.store.upsert("contacts", [row]);
  return row;
}

async function closeCasesForExcludedSites(ctx: RunContext, c: StageCounter): Promise<void> {
  const out = (await ctx.store.list("sites")).filter((s) => s.in_search_area === false).map((s) => s.id);
  if (!out.length) return;
  for (const k of await ctx.store.list("cases")) {
    if (out.includes(k.site_id) && k.status !== "closed" && k.status !== "resolved") {
      await ctx.store.upsert("cases", [{ ...k, status: "closed", next_action: "site outside search area", updated_at: ctx.clock.iso() }]);
      c.inc("cases_closed_out_of_area");
    }
  }
}

// ------------------------------------------------------------- sending
/** Online only: prove the mail credentials work (token + mailbox) without sending anything. */
async function mailPreflight(ctx: RunContext, c: StageCounter): Promise<void> {
  const mail = ctx.providers.mail;
  if (ctx.offline || typeof mail.preflight !== "function") return;
  try {
    const p = await mail.preflight();
    const expected = mail.sender_address.trim().toLowerCase();
    const matches = p.mailbox ? p.mailbox.toLowerCase() === expected : null;
    c.inc("mail_preflight_ok");
    ctx.logger.info("mail preflight ok", { provider: mail.name, access_token: "obtained", mailbox: p.mailbox, sender_address: mail.sender_address, mailbox_matches_sender: matches, note: p.note ?? null });
    if (matches === false) {
      // The token belongs to a different mailbox than GMAIL_SENDER_ADDRESS: mail would go out from the wrong account.
      ctx.run.sending_paused = true;
      ctx.run.pause_reason = `mail token belongs to ${p.mailbox}, not GMAIL_SENDER_ADDRESS ${mail.sender_address}`;
      c.warn(ctx.run.pause_reason);
    } else if (p.note) c.warn(`mail preflight: ${p.note}`);
  } catch (e) {
    const msg = errMsg(e);
    if (/unavailable, set /.test(msg)) {
      c.inc("mail_preflight_skipped_no_credentials");
      return; // already reported as a provider note at startup
    }
    c.inc("mail_preflight_failed");
    c.warn(`mail preflight failed: ${msg}`);
  }
}

async function checkPause(ctx: RunContext, c: StageCounter): Promise<void> {
  if (ctx.config.business.mail.paused) {
    ctx.run.sending_paused = true;
    ctx.run.pause_reason = "manual pause (business.yaml mail.paused or DEALERSOURCE_PAUSE_SENDING=1)";
    c.inc("sending_paused");
    return;
  }
  const since = addDays(ctx.clock.iso(), -1);
  const sinceMs = new Date(since).getTime();
  const recent = (await ctx.store.list("messages")).filter((m) => m.direction === "outbound" && new Date(m.sent_at).getTime() >= sinceMs && m.status !== "refused");
  const bounced = recent.filter((m) => m.status === "bounced").length;
  const pct = recent.length ? (100 * bounced) / recent.length : 0;
  if (recent.length >= 5 && pct > ctx.config.business.mail.bounce_pause_pct) {
    ctx.run.sending_paused = true;
    ctx.run.pause_reason = `bounce rate ${pct.toFixed(1)}% over 24h exceeds ${ctx.config.business.mail.bounce_pause_pct}%`;
    c.inc("sending_paused");
  }
}

interface Group {
  contact: ContactRow;
  site: SiteRow;
  cases: CaseRow[];
}

async function sendOutbound(ctx: RunContext, c: StageCounter): Promise<void> {
  const now = ctx.clock.iso();
  const b = ctx.config.business;
  const cases = (await ctx.store.list("cases")).filter((k) => (k.status === "open" || k.status === "awaiting_reply") && k.contact_id);
  const groups = new Map<string, Group>();
  for (const k of cases) {
    const key = `${k.contact_id}|${k.site_id}`;
    let g = groups.get(key);
    if (!g) {
      const contact = await ctx.store.get("contacts", k.contact_id!);
      const site = await ctx.store.get("sites", k.site_id);
      if (!contact || !site) continue;
      g = { contact, site, cases: [] };
      groups.set(key, g);
    }
    g.cases.push(k);
  }

  for (const g of groups.values()) {
    if (g.contact.do_not_contact || g.contact.bounced) {
      c.inc("groups_skipped_contact_blocked");
      continue;
    }
    const lastContact = g.cases.map((k) => k.last_contacted_at).filter((x): x is string => !!x).sort((a, b) => new Date(a).getTime() - new Date(b).getTime()).at(-1) ?? null;
    if (lastContact && daysBetween(lastContact, now) < b.mail.followup_days) {
      c.inc("groups_within_followup_window");
      continue;
    }
    const followups = Math.max(...g.cases.map((k) => k.followups_sent));
    const isFollowup = lastContact !== null;
    if (isFollowup && followups >= b.mail.max_followups) {
      for (const k of g.cases) {
        await ctx.store.upsert("cases", [{ ...k, status: "escalated", owner: "human", next_action: `no reply after ${followups} follow-ups; human to call or visit`, updated_at: now }]);
      }
      c.inc("groups_escalated_max_followups");
      continue;
    }
    const types = [...new Set(g.cases.map((k) => k.type))].sort(byPriority);
    const primary = types[0]!;
    const token = dsToken(g.site.id, g.contact.id);
    const zoningDistrict = ((await currentEvidence(ctx, g.site.id, "zoning_district"))?.value as { district?: string } | undefined)?.district ?? "unknown";
    const listing = (await ctx.store.get("listings", g.cases[0]!.listing_id))?.url ?? "";
    const rendered = renderEmail(ctx.config.mailTemplates, g.contact.role, types, {
      address: g.site.canonical_address,
      token,
      contact_name: g.contact.name ?? (g.contact.role === "planning" ? "Planning staff" : "there"),
      area: g.site.jurisdiction ?? "Eastern North Carolina",
      listing_url: listing,
      parcel_id: g.site.parcel_id,
      district: zoningDistrict,
      previous_date: lastContact ? lastContact.slice(0, 10) : "",
      sender_name: b.mail.sender_name,
      sender_org: b.mail.sender_org,
      sender_email: ctx.providers.mail.sender_address,
    }, isFollowup);

    if (ctx.run.sending_paused) {
      c.inc("groups_paused");
      ctx.outboxPreview?.push({ to: g.contact.email, subject: rendered.subject, body: rendered.body, site_id: g.site.id, address: g.site.canonical_address, case_types: types, follow_up: isFollowup, template_id: rendered.template_id });
      continue;
    }

    const attempt = isFollowup ? followups + 1 : 0;
    const msgId = stableId("msg", g.site.id, g.contact.id, String(attempt), ctx.runDate);
    if (await ctx.store.get("messages", msgId)) {
      c.inc("messages_already_sent_today");
      continue;
    }
    const row: MessageRow = {
      id: msgId,
      case_ids: g.cases.map((k) => k.id),
      case_type: primary,
      site_id: g.site.id,
      listing_id: g.cases[0]!.listing_id,
      contact_id: g.contact.id,
      to: g.contact.email,
      direction: "outbound",
      subject: rendered.subject,
      body: rendered.body,
      sent_at: now,
      thread_token: token,
      provider_message_id: null,
      template_id: rendered.template_id,
      attempt,
      classification: null,
      status: "sent",
      run_id: ctx.run.id,
    };
    try {
      const res = await ctx.providers.mail.send({ to: g.contact.email, subject: rendered.subject, body: rendered.body, token, replyTo: ctx.providers.mail.sender_address || null });
      row.provider_message_id = res.provider_message_id;
    } catch (e) {
      if (e instanceof GmailQuotaError) {
        ctx.run.sending_paused = true;
        ctx.run.pause_reason = `mail provider quota error: ${e.message}`;
        c.inc("sending_paused");
        continue;
      }
      row.status = "refused";
      await ctx.store.upsert("messages", [row]);
      c.warn(`send to ${g.contact.email} failed: ${errMsg(e)}`, { site: g.site.id });
      continue;
    }
    await ctx.store.upsert("messages", [row]);
    ctx.sentThisRun.push(row.id);
    for (const k of g.cases) {
      await ctx.store.upsert("cases", [{
        ...k,
        status: "awaiting_reply",
        followups_sent: isFollowup ? k.followups_sent + 1 : k.followups_sent,
        last_contacted_at: now,
        next_action: `await reply; follow up after ${b.mail.followup_days} days`,
        next_action_at: addDays(now, b.mail.followup_days),
        updated_at: now,
      }]);
    }
    c.inc("messages_sent");
  }
}

const PRIORITY: Record<CaseType, number> = { rent: 0, zoning: 1, space: 2 };
const byPriority = (a: CaseType, b: CaseType) => PRIORITY[a] - PRIORITY[b];

// -------------------------------------------------------------- inbound
async function ingestReplies(ctx: RunContext, c: StageCounter): Promise<void> {
  const now = ctx.clock.iso();
  const outbound = (await ctx.store.list("messages")).filter((m) => m.direction === "outbound" && m.status !== "refused");
  if (!outbound.length) return;
  const threads: KnownThread[] = [];
  for (const m of outbound) {
    const site = await ctx.store.get("sites", m.site_id);
    const caseTypes = [...new Set(m.case_ids.map((id) => id.split(":").pop() as CaseType))];
    threads.push({ token: m.thread_token, listing_ids: site?.listing_ids ?? [m.listing_id], case_types: caseTypes, contact_email: m.to, address: site?.canonical_address ?? "" });
  }
  const since = addDays(now, -ctx.config.business.mail.inbound_lookback_days);
  let inbound: InboundMail[];
  try {
    inbound = await ctx.providers.mail.fetchInbound({ since, until: ctx.cutoffIso, threads });
  } catch (e) {
    c.warn(`inbound poll failed: ${errMsg(e)}`);
    return;
  }

  for (const mail of inbound) {
    const msgId = `in_${sha256(mail.provider_message_id).slice(0, 16)}`;
    if (await ctx.store.get("messages", msgId)) {
      c.inc("inbound_already_ingested");
      continue;
    }
    const thread = mail.token ? threads.find((t) => t.token === mail.token) : undefined;
    const parent = thread ? outbound.find((m) => m.thread_token === thread.token) : undefined;
    if (!parent) {
      c.inc("inbound_unmatched");
      ctx.run.warnings.push(`unmatched inbound mail from ${mail.from}: ${mail.subject}`);
      continue;
    }
    const siteCases = (await ctx.store.list("cases", { site_id: parent.site_id })).filter((k) => k.contact_id === parent.contact_id && k.status !== "closed");
    const targetTypes: CaseType[] = mail.case_type ? [mail.case_type] : siteCases.map((k) => k.type);
    const contact = await ctx.store.get("contacts", parent.contact_id);

    let classification = null;
    if (mail.is_bounce) {
      if (contact) await ctx.store.upsert("contacts", [{ ...contact, bounced: true }]);
      await ctx.store.upsert("messages", [{ ...parent, status: "bounced" }]);
      for (const k of siteCases) await ctx.store.upsert("cases", [{ ...k, status: "escalated", owner: "human", next_action: "address bounced; find another contact", updated_at: now }]);
      c.inc("inbound_bounces");
    } else {
      classification = await ctx.providers.llm.classifyReply(mail.body, targetTypes[0] ?? "rent");
      if (classification.intent === "stop") {
        if (contact) await ctx.store.upsert("contacts", [{ ...contact, do_not_contact: true }]);
        for (const k of siteCases) await ctx.store.upsert("cases", [{ ...k, status: "escalated", owner: "human", next_action: "contact asked to stop; do-not-contact set", updated_at: now }]);
        c.inc("inbound_stop_requests");
      } else if (classification.intent === "unavailable") {
        for (const k of siteCases) await ctx.store.upsert("cases", [{ ...k, status: "closed", resolution: "space no longer available", updated_at: now }]);
        c.inc("inbound_unavailable");
      } else {
        for (const k of siteCases) {
          if (!targetTypes.includes(k.type)) continue;
          const ev = await evidenceFromReply(ctx, k, mail, msgId, classification);
          if (ev) {
            await ctx.store.upsert("cases", [{ ...k, status: "resolved", resolved_at: mail.received_at, resolution: classification.summary, evidence_id: ev.id, next_action: "none", updated_at: now }]);
            c.inc("cases_resolved_by_reply");
          } else {
            c.inc("replies_without_answer");
          }
        }
      }
    }

    const row: MessageRow = {
      id: msgId,
      case_ids: siteCases.filter((k) => targetTypes.includes(k.type)).map((k) => k.id),
      case_type: targetTypes[0] ?? parent.case_type,
      site_id: parent.site_id,
      listing_id: parent.listing_id,
      contact_id: parent.contact_id,
      to: ctx.providers.mail.sender_address,
      direction: "inbound",
      subject: mail.subject,
      body: mail.body,
      sent_at: mail.received_at,
      thread_token: parent.thread_token,
      provider_message_id: mail.provider_message_id,
      template_id: null,
      attempt: parent.attempt,
      classification,
      status: mail.is_bounce ? "bounced" : "received",
      run_id: ctx.run.id,
    };
    await ctx.store.upsert("messages", [row]);
    c.inc("inbound_ingested");
  }
}

async function evidenceFromReply(
  ctx: RunContext,
  k: CaseRow,
  mail: InboundMail,
  msgId: string,
  cls: NonNullable<MessageRow["classification"]>,
): Promise<EvidenceRow | null> {
  const src = `message:${mail.provider_message_id}`;
  const base = { site_id: k.site_id, source_url: src, method: "email" as const, fetched_at: mail.received_at, message_id: msgId, notes: `from ${mail.from}` };
  if (k.type === "rent" && cls.rent_monthly !== null) {
    return writeEvidence(ctx, { ...base, fact: "rent_monthly", value: { rent_monthly: cls.rent_monthly, includes_nnn: cls.rent_includes_nnn, from: mail.from } });
  }
  if (k.type === "zoning" && cls.zoning_status) {
    const district = ((await currentEvidence(ctx, k.site_id, "zoning_district"))?.value as { district?: string } | undefined)?.district ?? null;
    return writeEvidence(ctx, { ...base, fact: "zoning_permitted", value: { status: cls.zoning_status, citation: cls.zoning_citation, district, from: mail.from } });
  }
  if (k.type === "space" && (cls.has_office !== null || cls.vehicle_capacity !== null)) {
    let last: EvidenceRow | null = null;
    if (cls.has_office !== null) last = await writeEvidence(ctx, { ...base, fact: "office", value: { has_office: cls.has_office, from: mail.from } });
    if (cls.vehicle_capacity !== null) last = await writeEvidence(ctx, { ...base, fact: "vehicle_display", value: { vehicle_capacity: cls.vehicle_capacity, from: mail.from } });
    const site = await ctx.store.get("sites", k.site_id);
    if (site) await ctx.store.upsert("sites", [{ ...site, has_office: cls.has_office ?? site.has_office, vehicle_capacity: cls.vehicle_capacity ?? site.vehicle_capacity }]);
    return last;
  }
  return null;
}

/** Says exactly which contact is missing so the digest and dashboard are actionable. */
function missingContactNote(site: SiteRow, role: ContactRole): string {
  if (role === "planning") {
    return `no planning email for ${site.jurisdiction ?? "unknown jurisdiction"}: add it under business.yaml jurisdictions (verified: true) to open outreach`;
  }
  const ids = site.listing_ids.join(", ");
  return `no leasing contact for ${site.canonical_address}: listing${site.listing_ids.length === 1 ? "" : "s"} ${ids} carry no email; set contact_email on the source in config/sources.yaml or add a manual lead`;
}
