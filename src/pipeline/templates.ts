import type { MailTemplates } from "../config/schema.js";
import type { CaseType, ContactRole } from "../core/types.js";

export interface TemplateSlots {
  address: string;
  token: string;
  contact_name: string;
  area: string;
  listing_url: string;
  parcel_id: string;
  district: string;
  previous_date: string;
  sender_name: string;
  sender_org: string;
  sender_email: string;
}

export interface BundleItem {
  address: string;
  listing_url: string;
  types: CaseType[];
}

const PRIORITY: Record<CaseType, number> = { rent: 0, zoning: 1, space: 2 };

/**
 * One leasing email for several properties from the same contact: the properties numbered
 * "1. <address>", then the approved question sections once ("For each property:"), asking for
 * an answer per number so the reply can be split back to each property.
 */
export function renderLeasingBundle(
  templates: MailTemplates,
  items: BundleItem[],
  slots: TemplateSlots,
  followup: boolean,
): { subject: string; body: string; template_id: string } {
  const group = templates.leasing;
  const bundle = group.bundle;
  if (!bundle) throw new Error("mail-templates.yaml: leasing.bundle is missing (needed when business.yaml mail.combine_leasing is true)");
  const s = { ...(slots as unknown as Record<string, string>), count: String(items.length) };
  const types = [...new Set(items.flatMap((i) => i.types))].sort((a, b) => PRIORITY[a] - PRIORITY[b]);
  const sections = types
    .flatMap((t) => SECTION_FOR[t])
    .map((id) => group.sections[id])
    .filter((x): x is string => typeof x === "string")
    .map((x) => fill(x, s).trimEnd());
  const urls = [...new Set(items.map((i) => i.listing_url).filter(Boolean))];
  // One shared listings page: show it once; different pages: show each next to its property.
  const perProperty = urls.length > 1;
  const body = [
    fill(followup ? bundle.followup_intro : bundle.intro, s).trimEnd(),
    "",
    ...items.map((it, i) => `${i + 1}. ${it.address}${perProperty && it.listing_url ? ` (${it.listing_url})` : ""}`),
    ...(urls.length === 1 ? ["", `Listings: ${urls[0]}`] : []),
    "",
    fill(bundle.questions_heading, s).trimEnd(),
    ...sections,
    "",
    fill(bundle.answer_hint, s).trimEnd(),
    "",
    fill(group.outro, s).trimEnd(),
    "",
    fill(templates.sender_signature, s).trimEnd(),
  ].join("\n");
  return {
    subject: fill(bundle.subject, s),
    body,
    template_id: `leasing-${followup ? "followup" : "initial"}-bundle-${types.slice().sort().join("+")}`,
  };
}

/** Case type -> approved section id in mail-templates.yaml. */
export const SECTION_FOR: Record<CaseType, string[]> = {
  rent: ["rent_quote"],
  zoning: ["zoning_permitted"],
  space: ["office", "vehicle_display"],
};

export function fill(text: string, slots: Record<string, string>): string {
  return text.replace(/\{\{(\w+)\}\}/g, (_, k: string) => slots[k] ?? "");
}

/**
 * Renders one approved email for a recipient. The model never composes new
 * asks: only slots are filled and only approved sections are included.
 */
export function renderEmail(
  templates: MailTemplates,
  role: ContactRole,
  caseTypes: CaseType[],
  slots: TemplateSlots,
  followup: boolean,
): { subject: string; body: string; template_id: string } {
  const group = role === "planning" ? templates.planning : templates.leasing;
  const s = slots as unknown as Record<string, string>;
  const sections = caseTypes
    .flatMap((t) => SECTION_FOR[t])
    .map((id) => group.sections[id])
    .filter((x): x is string => typeof x === "string")
    .map((x) => fill(x, s).trimEnd());
  const body = [
    fill(followup ? group.followup_intro : group.intro, s).trimEnd(),
    "",
    ...sections,
    "",
    fill(group.outro, s).trimEnd(),
    "",
    fill(templates.sender_signature, s).trimEnd(),
  ].join("\n");
  return {
    subject: fill(group.subject, s),
    body,
    template_id: `${role}-${followup ? "followup" : "initial"}-${caseTypes.slice().sort().join("+")}`,
  };
}
