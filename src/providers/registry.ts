import type { Clock } from "../core/clock.js";
import type { Logger } from "../core/logger.js";
import type { AppConfig } from "../config/load.js";
import { LAYERS, type Layer } from "../config/schema.js";
import { FetchHttpClient, type HttpClient, type HttpRequest, type HttpResponse } from "../http/client.js";
import { CostLedger, MeteredHttpClient, PaidProviderDisabledError } from "../http/cost-ledger.js";
import { optString } from "./options.js";
import type { AdapterContext, ProviderMap } from "./types.js";
import { CensusGeocoder, GoogleGeocoder, NominatimGeocoder } from "./geocoding.js";
import { CountyGisParcels, NcOneMapParcels, RegridParcels } from "./parcels.js";
import { ArcgisZoning } from "./zoning.js";
import { GoogleDistanceMatrix, OpenRouteServiceDriveTime, ValhallaDriveTime } from "./drivetime.js";
import { NcdotAadt } from "./traffic.js";
import { FemaNfhlFlood } from "./flood.js";
import { GoogleStreetViewImagery, MapillaryImagery } from "./imagery.js";
import { GooglePlacesPoi, OverpassPoi } from "./competitors.js";
import { AnyCrawlCloud, AnyCrawlSelfHosted, FetchCrawl } from "./crawl.js";
import { RedditSocial } from "./social.js";
import { GmailMail } from "./mail.js";
import { ClaudeAgentLlm, ClaudeApiLlm, RulesLlm } from "./llm.js";
import {
  FixtureCrawl,
  FixtureDriveTime,
  FixtureFlood,
  FixtureGeocoder,
  FixtureImagery,
  FixtureMail,
  FixtureParcels,
  FixturePoi,
  FixtureSet,
  FixtureSocial,
  FixtureTraffic,
  FixtureZoning,
} from "./fixture.js";

export interface AdapterSpec {
  id: string;
  layer: Layer;
  paid: boolean;
  /** Env vars required to run for real. Any missing => fixture fallback (or unavailable). */
  envVars: string[];
  create(ctx: AdapterContext, deps: { onPaidCall: (url: string) => void }): ProviderMap[Layer];
}

const paidNote = (ctx: AdapterContext, id: string) => {
  ctx.logger.warn("paid adapter selected", { adapter: id, cost_class: "paid" });
};

/** Every adapter in the codebase. Paid ones are here but unreachable while paid_enabled is false. */
export const ADAPTERS: AdapterSpec[] = [
  { id: "census", layer: "geocoder", paid: false, envVars: [], create: (c) => new CensusGeocoder(c) },
  { id: "nominatim", layer: "geocoder", paid: false, envVars: ["NOMINATIM_URL"], create: (c) => new NominatimGeocoder(c) },
  { id: "google", layer: "geocoder", paid: true, envVars: ["GOOGLE_MAPS_API_KEY"], create: (c) => (paidNote(c, "google"), new GoogleGeocoder(c)) },
  { id: "nc_onemap", layer: "parcels", paid: false, envVars: [], create: (c) => new NcOneMapParcels(c) },
  { id: "county", layer: "parcels", paid: false, envVars: [], create: (c) => new CountyGisParcels(c) },
  { id: "regrid", layer: "parcels", paid: true, envVars: ["REGRID_API_KEY"], create: (c) => new RegridParcels(c) },
  { id: "arcgis", layer: "zoning", paid: false, envVars: [], create: (c) => new ArcgisZoning(c) },
  { id: "ors", layer: "drivetime", paid: false, envVars: ["ORS_API_KEY"], create: (c) => new OpenRouteServiceDriveTime(c) },
  { id: "valhalla", layer: "drivetime", paid: false, envVars: ["VALHALLA_URL"], create: (c) => new ValhallaDriveTime(c) },
  { id: "google", layer: "drivetime", paid: true, envVars: ["GOOGLE_MAPS_API_KEY"], create: (c) => new GoogleDistanceMatrix(c) },
  { id: "ncdot", layer: "traffic", paid: false, envVars: [], create: (c) => new NcdotAadt(c) },
  { id: "fema", layer: "flood", paid: false, envVars: [], create: (c) => new FemaNfhlFlood(c) },
  { id: "mapillary", layer: "imagery", paid: false, envVars: ["MAPILLARY_ACCESS_TOKEN"], create: (c) => new MapillaryImagery(c) },
  { id: "streetview", layer: "imagery", paid: true, envVars: ["GOOGLE_MAPS_API_KEY"], create: (c) => new GoogleStreetViewImagery(c) },
  { id: "overpass", layer: "poi", paid: false, envVars: [], create: (c) => new OverpassPoi(c) },
  { id: "places", layer: "poi", paid: true, envVars: ["GOOGLE_MAPS_API_KEY"], create: (c) => new GooglePlacesPoi(c) },
  { id: "fetch", layer: "crawler", paid: false, envVars: [], create: (c) => new FetchCrawl(c) },
  { id: "anycrawl", layer: "crawler", paid: false, envVars: ["ANYCRAWL_URL"], create: (c) => new AnyCrawlSelfHosted(c) },
  { id: "anycrawl_cloud", layer: "crawler", paid: true, envVars: ["ANYCRAWL_API_KEY"], create: (c) => new AnyCrawlCloud(c) },
  { id: "reddit", layer: "social", paid: false, envVars: ["REDDIT_CLIENT_ID", "REDDIT_CLIENT_SECRET"], create: (c) => new RedditSocial(c) },
  {
    id: "gmail",
    layer: "mail",
    paid: false,
    envVars: ["GMAIL_SENDER_ADDRESS", "GMAIL_APP_PASSWORD"],
    create: (c) => new GmailMail(c),
  },
  { id: "rules", layer: "llm", paid: false, envVars: [], create: (c) => new RulesLlm(c) },
  { id: "claude_agent", layer: "llm", paid: false, envVars: [], create: (c) => new ClaudeAgentLlm(c) },
  { id: "claude_api", layer: "llm", paid: true, envVars: ["ANTHROPIC_API_KEY"], create: (c, d) => new ClaudeApiLlm(c, d.onPaidCall) },
  { id: "protomaps", layer: "tiles", paid: false, envVars: [], create: (c) => tiles("protomaps", c) },
  { id: "mapbox", layer: "tiles", paid: true, envVars: ["MAPBOX_TOKEN"], create: (c) => tiles("mapbox", c) },
];

function tiles(name: string, ctx: AdapterContext): ProviderMap["tiles"] {
  const urlEnv = optString(ctx.options, "pmtiles_url_env", name === "protomaps" ? "PMTILES_URL" : "");
  return {
    name,
    describe: () => ({
      name,
      url: urlEnv ? ctx.env[urlEnv]?.trim() ?? null : null,
      url_env: urlEnv || null,
      style: optString(ctx.options, "style", "") || null,
    }),
  };
}

export function findAdapter(layer: Layer, id: string): AdapterSpec | undefined {
  return ADAPTERS.find((a) => a.layer === layer && a.id === id);
}

export function adapterIds(layer: Layer): string[] {
  return ADAPTERS.filter((a) => a.layer === layer).map((a) => a.id);
}

/** Records every host contacted, for report.json.external_calls. */
export class HostTrackingHttpClient implements HttpClient {
  constructor(private readonly inner: HttpClient, private readonly hosts: Set<string>) {}
  get kind() {
    return this.inner.kind;
  }
  request(req: HttpRequest): Promise<HttpResponse> {
    this.hosts.add(new URL(req.url).host);
    return this.inner.request(req);
  }
}

export interface BuildOptions {
  config: AppConfig;
  env: NodeJS.ProcessEnv;
  clock: Clock;
  logger: Logger;
  offline: boolean;
  fixturesDir: string | null;
  outDir: string | null;
  ledger: CostLedger;
  hosts: Set<string>;
  /** Test hook: replace the HTTP client used by real adapters. */
  httpFactory?: (spec: AdapterSpec) => HttpClient;
}

export interface BuiltProviders {
  providers: ProviderMap;
  /** Layers served from fixtures (offline, or env unset online). */
  fixtureLayers: Layer[];
  notes: string[];
  fixtures: FixtureSet | null;
}

/**
 * Resolves providers.yaml into concrete adapters. Rules:
 *  - unknown id => startup error listing valid ids;
 *  - paid adapter while paid_enabled=false => PaidProviderDisabledError (no call can happen);
 *  - offline => fixture provider for every layer (llm stays `rules`-class, it has no network);
 *  - online with required env unset => fixture provider if --fixtures given, otherwise an
 *    adapter whose calls fail loudly with the missing variable names.
 */
export function buildProviders(opts: BuildOptions): BuiltProviders {
  const { config, env } = opts;
  const fixtures = opts.fixturesDir ? new FixtureSet(opts.fixturesDir) : null;
  const fixtureLayers: Layer[] = [];
  const notes: string[] = [];
  const providers: Partial<ProviderMap> = {};

  for (const layer of LAYERS) {
    const id = config.providers[layer];
    const spec = findAdapter(layer, id);
    if (!spec) throw new Error(`providers.yaml: unknown ${layer} adapter "${id}". Valid: ${adapterIds(layer).join(", ")}`);
    if (spec.paid && !config.providers.paid_enabled) throw new PaidProviderDisabledError(`${layer}:${id}`);

    const missing = spec.envVars.filter((v) => !env[v]?.trim());
    const useFixture = opts.offline || (missing.length > 0 && fixtures !== null);
    const options = config.providers.options[id] ?? {};

    if (useFixture && layer !== "llm" && layer !== "tiles") {
      if (!fixtures) throw new Error("offline run requires --fixtures <dir>");
      fixtureLayers.push(layer);
      if (!opts.offline) notes.push(`${layer}:${id} served from fixtures (missing ${missing.join(", ")})`);
      (providers as Record<string, unknown>)[layer] = fixtureProvider(layer, id, fixtures);
      continue;
    }

    let http: HttpClient;
    if (opts.offline) {
      // llm/tiles adapters never call the network offline; give them a client that refuses.
      http = { kind: "fixture", request: async (r) => { throw new Error(`offline: network refused (${r.url})`); } };
    } else if (missing.length) {
      http = { kind: "fetch", request: async (r) => { throw new Error(`${layer}:${id} unavailable, set ${missing.join(", ")} (${r.url})`); } };
      notes.push(`${layer}:${id} unavailable (missing ${missing.join(", ")})`);
    } else {
      const base = opts.httpFactory
        ? opts.httpFactory(spec)
        : new FetchHttpClient(optString(options, "user_agent", "dealersource/0.1"), Number(options.min_interval_ms ?? 0));
      http = new HostTrackingHttpClient(base, opts.hosts);
      if (spec.paid) http = new MeteredHttpClient(http, `${layer}:${id}`, "paid", opts.ledger, opts.clock);
    }

    const ctx: AdapterContext = {
      http,
      options,
      env,
      config,
      clock: opts.clock,
      logger: opts.logger.child({ adapter: `${layer}:${id}` }),
      offline: opts.offline,
      fixturesDir: opts.fixturesDir,
      outDir: opts.outDir,
      onExternalHost: opts.offline ? undefined : (host) => opts.hosts.add(host),
    };
    (providers as Record<string, unknown>)[layer] = spec.create(ctx, {
      onPaidCall: (url) => {
        opts.hosts.add(new URL(url).host);
        opts.ledger.record({ adapter: `${layer}:${id}`, cost_class: "paid", url, at: opts.clock.iso() });
      },
    });
  }

  return { providers: providers as ProviderMap, fixtureLayers, notes, fixtures };
}

function fixtureProvider(layer: Layer, id: string, fx: FixtureSet): unknown {
  switch (layer) {
    case "geocoder":
      return new FixtureGeocoder(id, fx);
    case "parcels":
      return new FixtureParcels(id, fx);
    case "zoning":
      return new FixtureZoning(id, fx);
    case "drivetime":
      return new FixtureDriveTime(id, fx);
    case "traffic":
      return new FixtureTraffic(id, fx);
    case "flood":
      return new FixtureFlood(id, fx);
    case "imagery":
      return new FixtureImagery(id);
    case "poi":
      return new FixturePoi(id, fx);
    case "crawler":
      return new FixtureCrawl(id);
    case "social":
      return new FixtureSocial(id);
    case "mail":
      return new FixtureMail(id, fx);
    default:
      throw new Error(`no fixture provider for layer ${layer}`);
  }
}

export { CostLedger, PaidProviderDisabledError };
