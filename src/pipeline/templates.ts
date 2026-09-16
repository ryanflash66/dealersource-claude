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
