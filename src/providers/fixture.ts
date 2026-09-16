/**
 * Fixture-backed providers (task-spec section 14.3). Used for every layer in
 * --offline runs, and online for any layer whose environment variables are
 * unset when a --fixtures directory is available. They read the nine JSON
 * files by their contract keys and never touch the network.
 */
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { z } from "zod";
import type { CaseType, LatLon, Polygon } from "../core/types.js";
import { haversineMeters } from "../core/geo.js";
import { normalizeAddressKey } from "../core/address.js";
import { fixtureListingSchema, fixtureReplySchema, type FixtureListing, type FixtureReply } from "../config/schema.js";
import type {
  CrawlProvider,
  CrawlResult,
  DriveTimeProvider,
  DriveTimeResult,
  FloodProvider,
  FloodResult,
  GeocodeResult,
  GeocodingProvider,
  ImageryProvider,
  ImageryResult,
  InboundMail,
  IsochroneResult,
  KnownThread,
  LookupHints,
  MailProvider,
  OutboundMail,
  ParcelProvider,
  ParcelResult,
  PoiProvider,
  PoiResult,
  RobotsResult,
  SendResult,
  SocialPost,
  SocialProvider,
  TrafficProvider,
  TrafficResult,
  ZoningProvider,
  ZoningResult,
} from "./types.js";

const geocodeSchema = z.record(
  z.string(),
  z.object({ lat: z.number(), lon: z.number(), formatted_address: z.string(), parcel_id: z.string() }),
);
const parcelsSchema = z.record(
  z.string(),
  z.object({
    parcel_id: z.string(),
    owner: z.string().nullable().default(null),
    acres: z.number().nullable().default(null),
    centroid: z.object({ lat: z.number(), lon: z.number() }),
    geometry: z.object({ type: z.literal("Polygon"), coordinates: z.array(z.array(z.array(z.number()))) }).nullable().default(null),
    frontage_ft: z.number().nullable().default(null),
    corner_lot: z.boolean().nullable().default(null),
    fronting_road: z.string().nullable().default(null),
  }),
);
const zoningSchema = z.record(
  z.string(),
  z.object({
    district: z.string(),
    jurisdiction: z.string(),
    planning_email: z.string().nullable().default(null),
    use_table_url: z.string().nullable().default(null),
    dealer_use: z.enum(["permitted", "conditional", "prohibited", "unknown"]),
    citation: z.string().nullable().default(null),
  }),
);
const floodSchema = z.record(
  z.string(),
  z.object({ zone: z.string(), pct_area_high_risk: z.number().default(0), source_url: z.string() }),
);
const trafficSchema = z.record(
  z.string(),
  z.object({ aadt: z.number(), road: z.string().nullable().default(null), year: z.number().nullable().default(null), source_url: z.string() }),
);
const drivetimeSchema = z.record(z.string(), z.object({ minutes: z.number() }));
const competitorsSchema = z.record(z.string(), z.object({ count_within_radius: z.number(), radius_m: z.number() }));

export class FixtureFileError extends Error {}

/** Lazily loads and validates the fixture files in a directory. */
export class FixtureSet {
  private cache = new Map<string, unknown>();
  constructor(readonly dir: string) {}

  has(file: string): boolean {
    return existsSync(resolve(this.dir, file));
  }

  private load<S extends z.ZodTypeAny>(file: string, schema: S, fallback: z.output<S>): z.output<S> {
    if (this.cache.has(file)) return this.cache.get(file) as z.output<S>;
    const path = resolve(this.dir, file);
    let value: z.output<S>;
    if (!existsSync(path)) value = fallback;
    else {
      const parsed = schema.safeParse(JSON.parse(readFileSync(path, "utf8")));
      if (!parsed.success) throw new FixtureFileError(`Invalid fixture ${file}: ${parsed.error.issues[0]?.path.join(".")} ${parsed.error.issues[0]?.message}`);
      value = parsed.data;
    }
    this.cache.set(file, value);
    return value;
  }

  listings(): FixtureListing[] {
    return this.load("listings.json", z.array(fixtureListingSchema), []);
  }
  replies(): FixtureReply[] {
    return this.load("replies.json", z.array(fixtureReplySchema), []);
  }
  geocode() {
    return this.load("geocode.json", geocodeSchema, {});
  }
  parcels() {
    return this.load("parcels.json", parcelsSchema, {});
  }
  zoning() {
    return this.load("zoning.json", zoningSchema, {});
  }
  flood() {
    return this.load("flood.json", floodSchema, {});
  }
  traffic() {
    return this.load("traffic.json", trafficSchema, {});
  }
  drivetime() {
    return this.load("drivetime.json", drivetimeSchema, {});
  }
  competitors() {
    return this.load("competitors.json", competitorsSchema, {});
  }

  url(file: string, key: string): string {
    return `fixture://${file}#${encodeURIComponent(key)}`;
  }
}

export class FixtureGeocoder implements GeocodingProvider {
  constructor(readonly name: string, private readonly fx: FixtureSet) {}
  async geocode(address: string): Promise<GeocodeResult | null> {
    const table = this.fx.geocode();
    let hit = table[address];
    let key = address;
    if (!hit) {
      // Tolerate whitespace/abbreviation differences in the fixture key.
      const want = normalizeAddressKey(address);
      const found = Object.entries(table).find(([k]) => normalizeAddressKey(k) === want);
      if (found) [key, hit] = found;
    }
    if (!hit) return null;
    return {
      lat: hit.lat,
      lon: hit.lon,
      canonical_address: hit.formatted_address,
      city: null,
      zip: /\b(2[78]\d{3})\b/.exec(hit.formatted_address)?.[1] ?? null,
      parcel_id_hint: hit.parcel_id,
      source_url: this.fx.url("geocode.json", key),
    };
  }
}

export class FixtureParcels implements ParcelProvider {
  constructor(readonly name: string, private readonly fx: FixtureSet) {}
  async lookup(point: LatLon, hints: LookupHints = {}): Promise<ParcelResult | null> {
    const table = this.fx.parcels();
    let p = hints.parcel_id ? table[hints.parcel_id] : undefined;
    if (!p) {
      // Nearest centroid within 150 m.
      let best: { d: number; p: (typeof table)[string] } | null = null;
      for (const cand of Object.values(table)) {
        const d = haversineMeters(point, cand.centroid);
        if (d < 150 && (!best || d < best.d)) best = { d, p: cand };
      }
      p = best?.p;
    }
    if (!p) return null;
    return {
      parcel_id: p.parcel_id,
      owner: p.owner,
      acreage: p.acres,
      geometry: p.geometry as Polygon | null,
      centroid: p.centroid,
      frontage_ft: p.frontage_ft,
      corner_lot: p.corner_lot,
      fronting_road: p.fronting_road,
      jurisdiction: null,
      county: null,
      site_address: null,
      source_url: this.fx.url("parcels.json", p.parcel_id),
    };
  }
}

export class FixtureZoning implements ZoningProvider {
  constructor(readonly name: string, private readonly fx: FixtureSet) {}
  async lookup(_point: LatLon, _jurisdiction: string | null, hints: LookupHints = {}): Promise<ZoningResult | null> {
    const z = hints.parcel_id ? this.fx.zoning()[hints.parcel_id] : undefined;
    if (!z) return null;
    return {
      district: z.district,
      jurisdiction: z.jurisdiction,
      dealer_use: z.dealer_use,
      citation: z.citation,
      use_table_url: z.use_table_url,
      planning_email: z.planning_email,
      source_url: z.use_table_url ?? this.fx.url("zoning.json", hints.parcel_id!),
    };
  }
}

export class FixtureFlood implements FloodProvider {
  constructor(readonly name: string, private readonly fx: FixtureSet) {}
  async zonesFor(_parcel: Polygon | null, _centroid: LatLon, _highRisk: string[], hints: LookupHints = {}): Promise<FloodResult> {
    const f = hints.parcel_id ? this.fx.flood()[hints.parcel_id] : undefined;
    if (!f) throw new FixtureFileError(`flood.json has no entry for parcel ${hints.parcel_id}`);
    return {
      zone: f.zone,
      pct_area_high_risk: f.pct_area_high_risk,
      zone_shares: [{ zone: f.zone, subtype: null, share: 1 }],
      source_url: f.source_url,
    };
  }
}

export class FixtureTraffic implements TrafficProvider {
  constructor(readonly name: string, private readonly fx: FixtureSet) {}
  async aadtNear(_point: LatLon, hints: LookupHints = {}): Promise<TrafficResult | null> {
    const t = hints.parcel_id ? this.fx.traffic()[hints.parcel_id] : undefined;
    if (!t) return null;
    return { aadt: t.aadt, road: t.road, year: t.year, station_distance_m: null, source_url: t.source_url };
  }
}

export class FixtureDriveTime implements DriveTimeProvider {
  constructor(readonly name: string, private readonly fx: FixtureSet) {}
  async driveMinutes(_from: LatLon, _to: LatLon, hints: LookupHints = {}): Promise<DriveTimeResult> {
    const d = hints.parcel_id ? this.fx.drivetime()[hints.parcel_id] : undefined;
    if (!d) throw new FixtureFileError(`drivetime.json has no entry for parcel ${hints.parcel_id}`);
    return { minutes: d.minutes, distance_m: null, source_url: this.fx.url("drivetime.json", hints.parcel_id!) };
  }
  async isochrone(): Promise<IsochroneResult | null> {
    return null;
  }
}

export class FixturePoi implements PoiProvider {
  constructor(readonly name: string, private readonly fx: FixtureSet) {}
  async dealersWithin(_point: LatLon, radiusM: number, hints: LookupHints = {}): Promise<PoiResult> {
    const c = hints.parcel_id ? this.fx.competitors()[hints.parcel_id] : undefined;
    if (!c) return { count: 0, radius_m: radiusM, items: [], source_url: this.fx.url("competitors.json", hints.parcel_id ?? "missing") };
    return { count: c.count_within_radius, radius_m: c.radius_m, items: [], source_url: this.fx.url("competitors.json", hints.parcel_id!) };
  }
  async estateAgentsWithin(): Promise<PoiResult> {
    return { count: 0, radius_m: 0, items: [], source_url: "fixture://competitors.json" };
  }
}

export class FixtureImagery implements ImageryProvider {
  constructor(readonly name: string) {}
  async nearby(): Promise<ImageryResult> {
    return { images: [], source_url: "fixture://imagery (no fixture file in section 14.3)" };
  }
}

/** Discovery offline comes from listings.json; the crawler is never invoked. */
export class FixtureCrawl implements CrawlProvider {
  constructor(readonly name: string) {}
  async fetchPage(url: string): Promise<CrawlResult> {
    throw new Error(`offline: crawler not available (${url}); discovery reads listings.json`);
  }
  async checkRobots(url: string): Promise<RobotsResult> {
    return { allowed: false, checked: false, source_url: `${new URL(url).origin}/robots.txt` };
  }
}

export class FixtureSocial implements SocialProvider {
  constructor(readonly name: string) {}
  async search(): Promise<SocialPost[]> {
    return [];
  }
}

/**
 * Fixture mailbox: records outbound mail, and serves replies.json as inbound
 * mail. A reply is visible when received_at <= until (the run-date cutoff) and
 * it matches a known thread by listing_id + case_type. The thread token is
 * stamped onto the reply so the verify stage treats it like a real reply.
 */
export class FixtureMail implements MailProvider {
  readonly sender_address = "fixture-mailbox@dealersource.local";
  readonly outbox: OutboundMail[] = [];
  constructor(readonly name: string, private readonly fx: FixtureSet) {}

  async send(mail: OutboundMail): Promise<SendResult> {
    this.outbox.push(mail);
    return { provider_message_id: `fixture-${mail.token}-${this.outbox.length}`, thread_id: mail.token };
  }

  async fetchInbound(opts: { since: string; until: string; threads: KnownThread[] }): Promise<InboundMail[]> {
    const out: InboundMail[] = [];
    const until = new Date(opts.until).getTime();
    const since = new Date(opts.since).getTime();
    for (const r of this.fx.replies()) {
      const t = new Date(r.received_at).getTime();
      if (Number.isNaN(t) || t > until || t <= since) continue;
      const thread = opts.threads.find(
        (th) => th.listing_ids.includes(r.listing_id) && th.case_types.includes(r.case_type as CaseType),
      );
      out.push({
        provider_message_id: `fixture-reply-${r.listing_id}-${r.case_type}-${r.received_at}`,
        from: r.from,
        subject: r.subject,
        body: r.body,
        received_at: r.received_at,
        token: thread?.token ?? null,
        listing_id: r.listing_id,
        case_type: r.case_type as CaseType,
        is_bounce: /mailer-daemon|postmaster/i.test(r.from) || /undeliverable|delivery status notification/i.test(r.subject),
      });
    }
    return out;
  }
}
