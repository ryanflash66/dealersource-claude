/**
 * Domain row types. These mirror the SQL schema in supabase/migrations 1:1 so
 * the JSON store (offline) and the Supabase store (deploy) hold identical
 * shapes. Keep column names snake_case to match Postgres.
 */

export type ISODate = string;

export interface LatLon {
  lat: number;
  lon: number;
}

/** GeoJSON Polygon (lon, lat order). */
export interface Polygon {
  type: "Polygon";
  coordinates: number[][][];
}

export type SourceKind = "crawl" | "reddit" | "rss" | "manual";
export type RobotsStatus = "allowed" | "disallowed" | "unknown";
export type TermsStatus = "allowed" | "prohibited" | "unclear";

export interface SourceRow {
  id: string;
  kind: SourceKind;
  url: string;
  robots_txt: RobotsStatus;
  terms_status: TermsStatus;
  enabled: boolean;
  cadence: string;
  fixture_only: boolean;
  notes: string | null;
  last_run_at: ISODate | null;
  last_status: "ok" | "refused" | "error" | "skipped" | null;
  last_error: string | null;
}

export interface RawDocumentRow {
  id: string; // sha256(source_id + url + body)
  source_id: string;
  url: string;
  fetched_at: ISODate;
  content_type: string;
  body: string;
  sha256: string;
  run_id: string;
}

export interface ListingExtraction {
  title: string | null;
  address_text: string | null;
  rent_monthly_advertised: number | null;
  sqft: number | null;
  lot_sqft: number | null;
  has_office: boolean | null;
  vehicle_display_est: number | null;
  shared_lot: boolean;
  contact_email: string | null;
  contact_name: string | null;
  contact_phone: string | null;
  frontage_ft: number | null;
  corner_lot: boolean | null;
  description: string | null;
  confidence: number; // 0..1
  method: "rules" | "claude-agent" | "claude-api" | "manual" | "reddit";
}

export interface ListingRow {
  id: string;
  source_id: string;
  raw_document_id: string;
  url: string;
  title: string | null;
  address_text: string | null;
  address_key: string | null;
  extraction: ListingExtraction;
  site_id: string | null;
  first_seen_at: ISODate;
  last_seen_at: ISODate;
  run_id: string;
}

export type SiteStage =
  | "discovered"
  | "resolved"
  | "enriched"
  | "verifying"
  | "scored"
  | "excluded";

export interface SiteRow {
  id: string;
  canonical_address: string;
  address_key: string;
  lat: number | null;
  lon: number | null;
  parcel_id: string | null;
  jurisdiction: string | null;
  county: string | null;
  stage: SiteStage;
  shared_lot: boolean;
  listing_ids: string[];
  drive_minutes: number | null;
  excluded_reason: string | null;
  created_at: ISODate;
  updated_at: ISODate;
}

export interface ParcelRow {
  id: string; // parcel number
  site_id: string;
  owner: string | null;
  acreage: number | null;
  geometry: Polygon | null;
  jurisdiction: string | null;
  county: string | null;
  source_url: string;
  fetched_at: ISODate;
}

export type Fact =
  | "geocode"
  | "parcel"
  | "zoning_district"
  | "zoning_permitted"
  | "rent_monthly"
  | "office"
  | "vehicle_display"
  | "sublease_consent"
  | "flood_zone"
  | "traffic_aadt"
  | "drive_minutes"
  | "imagery"
  | "competitor_count";

export type EvidenceMethod =
  | "layer" // official GIS layer / API
  | "layer+use_table" // zoning layer + cited use table
  | "email" // written reply parsed into the case
  | "form" // official inquiry form response
  | "crawl" // extracted from a listing page (advertised, not verified)
  | "api"
  | "manual";

export type EvidenceStatus = "verified" | "unverified" | "conflicting";

export interface EvidenceRow {
  id: string;
  site_id: string;
  fact: Fact;
  value: unknown;
  source_url: string;
  fetched_at: ISODate;
  expires_at: ISODate;
  method: EvidenceMethod;
  status: EvidenceStatus;
  message_id: string | null;
  notes: string | null;
  run_id: string;
}

export type CaseType =
  | "zoning_permitted"
  | "rent_quote"
  | "office"
  | "vehicle_display"
  | "sublease_consent";

export type CaseStatus =
  | "open" // needs first contact
  | "awaiting_reply"
  | "resolved"
  | "escalated" // max follow-ups reached, or no contact derivable; human owns it
  | "closed"; // no longer needed (site excluded, etc.)

export type ContactRole = "leasing" | "planning";

export interface CaseRow {
  id: string; // `${site_id}:${type}`
  site_id: string;
  type: CaseType;
  status: CaseStatus;
  owner: "system" | "human";
  contact_id: string | null;
  contact_role: ContactRole;
  next_action: string;
  next_action_at: ISODate | null;
  followups_sent: number;
  opened_at: ISODate;
  updated_at: ISODate;
  resolved_at: ISODate | null;
  resolution: string | null;
  evidence_id: string | null;
}

export interface ContactRow {
  id: string; // sha256(lower(email))
  email: string;
  name: string | null;
  org: string | null;
  role: ContactRole;
  derived_from_url: string; // listing URL or official government page
  do_not_contact: boolean;
  bounced: boolean;
  created_at: ISODate;
}

export type MessageDirection = "outbound" | "inbound";
export type MessageStatus = "sent" | "bounced" | "received" | "paused" | "refused";

export interface MessageRow {
  id: string;
  case_ids: string[];
  site_id: string;
  contact_id: string;
  direction: MessageDirection;
  subject: string;
  body: string;
  sent_at: ISODate;
  thread_id: string; // DS token shared by outbound + replies
  provider_message_id: string | null;
  template_id: string | null;
  attempt: number; // 0 = first contact, 1.. = follow-ups
  classification: ReplyClassification | null;
  status: MessageStatus;
  run_id: string;
}

export interface ReplyClassification {
  intent: "answer" | "stop" | "bounce" | "unrelated" | "unavailable";
  rent_monthly: number | null;
  rent_includes_nnn: boolean | null;
  has_office: boolean | null;
  vehicle_display: number | null;
  sublease_consent: boolean | null;
  zoning_status: "permitted" | "conditional" | "prohibited" | null;
  zoning_citation: string | null;
  summary: string;
  confidence: number;
}

export type GateName = "zoning" | "rent" | "flood";
export type GateOutcome = "pass" | "fail" | "unverified" | "expired";

export interface GateResult {
  gate: GateName;
  outcome: GateOutcome;
  evidence_id: string | null;
  source_url: string | null;
  fetched_at: ISODate | null;
  expires_at: ISODate | null;
  detail: string;
  warning: string | null;
}

export interface RequirementResult {
  name: "enclosed_office" | "vehicle_display" | "drive_time" | "shared_lot_policy";
  outcome: "met" | "not_met" | "unknown";
  detail: string;
}

export interface FactorScore {
  factor: "traffic" | "visibility" | "distance" | "rent" | "competitors";
  raw: number | null;
  normalized: number; // 0..1
  weight: number; // normalized weight
  weighted: number;
  detail: string;
}

export interface ScoreRow {
  id: string; // `${site_id}:${run_id}` not needed; we keep one row per site
  site_id: string;
  run_id: string;
  viable: boolean;
  shortlisted: boolean;
  shared_lot: boolean;
  gates: GateResult[];
  requirements: RequirementResult[];
  factors: FactorScore[];
  total: number;
  rank: number | null;
  flags: string[];
  computed_at: ISODate;
}

export type Stage = "discover" | "resolve" | "enrich" | "verify" | "score" | "report";

export interface StageSummary {
  started_at: ISODate;
  finished_at: ISODate;
  counts: Record<string, number>;
  errors: string[];
}

export interface PaidCall {
  adapter: string;
  cost_class: "paid" | "metered";
  url: string;
  at: ISODate;
}

export interface RunRow {
  id: string;
  started_at: ISODate;
  finished_at: ISODate | null;
  mode: "offline" | "online";
  stages: Partial<Record<Stage, StageSummary>>;
  counts: Record<string, number>;
  errors: string[];
  warnings: string[];
  paid_calls: PaidCall[];
  fixture_adapters: string[]; // adapters that ran on fixtures because their env was unset
  sending_paused: boolean;
  pause_reason: string | null;
  providers: Record<string, string>;
  status: "running" | "ok" | "error";
}

export const TABLES = [
  "sources",
  "raw_documents",
  "listings",
  "sites",
  "parcels",
  "evidence",
  "cases",
  "messages",
  "contacts",
  "scores",
  "runs",
] as const;
export type Table = (typeof TABLES)[number];

export interface TableRowMap {
  sources: SourceRow;
  raw_documents: RawDocumentRow;
  listings: ListingRow;
  sites: SiteRow;
  parcels: ParcelRow;
  evidence: EvidenceRow;
  cases: CaseRow;
  messages: MessageRow;
  contacts: ContactRow;
  scores: ScoreRow;
  runs: RunRow;
}
