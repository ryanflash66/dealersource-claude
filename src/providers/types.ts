import type { Clock } from "../core/clock.js";
import type { Logger } from "../core/logger.js";
import type { LatLon, Polygon, ListingExtraction, ReplyClassification, CaseType, ISODate } from "../core/types.js";
import type { HttpClient } from "../http/client.js";
import type { AppConfig } from "../config/load.js";
import type { Layer } from "../config/schema.js";

/** What every adapter factory receives. */
export interface AdapterContext {
  http: HttpClient;
  options: Record<string, unknown>;
  env: NodeJS.ProcessEnv;
  config: AppConfig;
  clock: Clock;
  logger: Logger;
  offline: boolean;
  /** Section 14.3 fixture directory (offline runs, or online fallback). */
  fixturesDir: string | null;
  /** Where run outputs go (review queues, etc.). */
  outDir: string | null;
}

/** Optional hints: fixture adapters key by parcel id; polygon layers prefer the parcel geometry. */
export interface LookupHints {
  parcel_id?: string | null;
  county?: string | null;
  address?: string | null;
  geometry?: Polygon | null;
  /** Road the parcel fronts (parcel layer), used to pick the traffic station on the site's street. */
  fronting_road?: string | null;
}

// ------------------------------------------------------------- geocoding
export interface GeocodeResult {
  lat: number;
  lon: number;
  canonical_address: string;
  city: string | null;
  zip: string | null;
  parcel_id_hint: string | null;
  source_url: string;
}
export interface GeocodingProvider {
  readonly name: string;
  geocode(address: string): Promise<GeocodeResult | null>;
}

// --------------------------------------------------------------- parcels
export interface ParcelResult {
  parcel_id: string;
  owner: string | null;
  acreage: number | null;
  geometry: Polygon | null;
  centroid: LatLon | null;
  frontage_ft: number | null;
  corner_lot: boolean | null;
  fronting_road: string | null;
  jurisdiction: string | null; // municipality, or null for unincorporated
  county: string | null;
  site_address: string | null;
  source_url: string;
}
export interface ParcelProvider {
  readonly name: string;
  lookup(point: LatLon, hints?: LookupHints): Promise<ParcelResult | null>;
}

// ---------------------------------------------------------------- zoning
export type DealerUse = "permitted" | "conditional" | "prohibited" | "unknown";
export interface ZoningResult {
  district: string;
  jurisdiction: string;
  /** Use status from the official use table when the adapter can supply it. */
  dealer_use: DealerUse | null;
  citation: string | null;
  use_table_url: string | null;
  planning_email: string | null;
  source_url: string;
}
export interface ZoningProvider {
  readonly name: string;
  /** Returns null when no official layer covers the jurisdiction. */
  lookup(point: LatLon, jurisdiction: string | null, hints?: LookupHints): Promise<ZoningResult | null>;
}

// ------------------------------------------------------------- drivetime
export interface DriveTimeResult {
  minutes: number;
  distance_m: number | null;
  source_url: string;
}
export interface IsochroneResult {
  polygon: Polygon;
  minutes: number;
  source_url: string;
}
export interface DriveTimeProvider {
  readonly name: string;
  driveMinutes(from: LatLon, to: LatLon, hints?: LookupHints): Promise<DriveTimeResult>;
  isochrone(from: LatLon, minutes: number): Promise<IsochroneResult | null>;
}

// --------------------------------------------------------------- traffic
export interface TrafficResult {
  aadt: number;
  road: string | null;
  year: number | null;
  station_distance_m: number | null;
  source_url: string;
}
export interface TrafficProvider {
  readonly name: string;
  aadtNear(point: LatLon, hints?: LookupHints): Promise<TrafficResult | null>;
}

// ----------------------------------------------------------------- flood
export interface FloodResult {
  zone: string; // zone at the parcel centroid
  pct_area_high_risk: number; // 0..100, share of sampled parcel area in high-risk zones
  zone_shares: Array<{ zone: string; subtype: string | null; share: number }>;
  source_url: string;
}
export interface FloodProvider {
  readonly name: string;
  zonesFor(parcel: Polygon | null, centroid: LatLon, highRiskZones: string[], hints?: LookupHints): Promise<FloodResult>;
}

// --------------------------------------------------------------- imagery
export interface ImageRef {
  url: string;
  captured_at: ISODate | null;
  kind: "street" | "aerial";
  provider: string;
}
export interface ImageryResult {
  images: ImageRef[];
  source_url: string;
}
export interface ImageryProvider {
  readonly name: string;
  nearby(point: LatLon, hints?: LookupHints): Promise<ImageryResult>;
}

// ------------------------------------------------------------------- poi
export interface Poi {
  name: string | null;
  lat: number;
  lon: number;
  tags: Record<string, string>;
}
export interface PoiResult {
  count: number;
  radius_m: number;
  items: Poi[];
  source_url: string;
}
export interface PoiProvider {
  readonly name: string;
  dealersWithin(point: LatLon, radiusM: number, hints?: LookupHints): Promise<PoiResult>;
  /** Used by `sources discover` to find brokers/property managers. */
  estateAgentsWithin(point: LatLon, radiusM: number): Promise<PoiResult>;
}

// --------------------------------------------------------------- crawler
export interface CrawlResult {
  url: string; // final URL after redirects
  status: number;
  content_type: string;
  body: string; // raw HTML, stored in raw_documents
  text: string; // readable text, scripts and tags removed
  links: string[]; // absolute http(s) links found on the page
  fetched_at: ISODate;
}
export interface RobotsResult {
  allowed: boolean;
  checked: boolean; // false when robots.txt could not be fetched
  source_url: string;
}
export interface CrawlProvider {
  readonly name: string;
  fetchPage(url: string): Promise<CrawlResult>;
  checkRobots(url: string, userAgent: string): Promise<RobotsResult>;
}

// ---------------------------------------------------------------- social
export interface SocialPost {
  id: string;
  title: string;
  body: string;
  url: string; // canonical permalink
  created_at: ISODate;
  subreddit: string;
  author: string | null;
}
export interface SocialProvider {
  readonly name: string;
  search(subreddits: string[], queries: string[], limit: number): Promise<SocialPost[]>;
}

// ------------------------------------------------------------------ mail
export interface OutboundMail {
  to: string;
  subject: string;
  body: string;
  token: string; // DS token, also used as thread key
  replyTo: string | null;
}
export interface SendResult {
  provider_message_id: string;
  thread_id: string;
}
export interface InboundMail {
  provider_message_id: string;
  from: string;
  subject: string;
  body: string;
  received_at: ISODate;
  token: string | null; // parsed from subject, or resolved by the fixture mailbox
  listing_id: string | null;
  case_type: CaseType | null;
  is_bounce: boolean;
}
export interface KnownThread {
  token: string;
  listing_ids: string[];
  case_types: CaseType[];
  contact_email: string;
  address: string;
}
export interface MailProvider {
  readonly name: string;
  readonly sender_address: string;
  send(mail: OutboundMail): Promise<SendResult>;
  /** Inbound mail received in (since, until], matched against known threads. */
  fetchInbound(opts: { since: ISODate; until: ISODate; threads: KnownThread[] }): Promise<InboundMail[]>;
  /**
   * Read-only credential check run every online run, paused or not: obtain an
   * access token and report which mailbox it belongs to. Never sends. Providers
   * without credentials (fixtures) omit it.
   */
  preflight?(): Promise<MailPreflight>;
}

export interface MailPreflight {
  access_token_obtained: boolean;
  /** Mailbox the token belongs to, or null when the granted scopes cannot read the profile. */
  mailbox: string | null;
  note?: string;
}

// ------------------------------------------------------------------- llm
export interface ExtractionInput {
  url: string;
  source_id: string;
  html: string;
  /** Pre-split listing block when the page holds several listings. */
  block?: string;
}
export interface DigestInput {
  run_id: string;
  run_date: string;
  shortlist: Array<{ rank: number; address: string; score: number; rent: number | null; flags: string[] }>;
  open_cases: number;
  escalated_cases: number;
  sent: number;
  received: number;
  exceptions: string[];
}
export interface LlmProvider {
  readonly name: string;
  extractListing(input: ExtractionInput): Promise<ListingExtraction>;
  classifyReply(text: string, caseType: CaseType): Promise<ReplyClassification>;
  writeDigest(input: DigestInput): Promise<string>;
}

// ----------------------------------------------------------------- tiles
export interface TilesProvider {
  readonly name: string;
  describe(): { name: string; url: string | null; url_env: string | null; style: string | null };
}

export interface ProviderMap {
  geocoder: GeocodingProvider;
  parcels: ParcelProvider;
  zoning: ZoningProvider;
  drivetime: DriveTimeProvider;
  traffic: TrafficProvider;
  flood: FloodProvider;
  imagery: ImageryProvider;
  poi: PoiProvider;
  crawler: CrawlProvider;
  social: SocialProvider;
  mail: MailProvider;
  llm: LlmProvider;
  tiles: TilesProvider;
}
export type ProviderFor<L extends Layer> = ProviderMap[L];
