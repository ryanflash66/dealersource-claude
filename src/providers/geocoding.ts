import type { AdapterContext, GeocodeResult, GeocodingProvider } from "./types.js";
import { optString } from "./options.js";

interface CensusResponse {
  result?: {
    addressMatches?: Array<{
      matchedAddress: string;
      coordinates: { x: number; y: number };
      addressComponents?: { city?: string; zip?: string };
    }>;
  };
}

/** US Census Bureau geocoder: free, no key, official. */
export class CensusGeocoder implements GeocodingProvider {
  readonly name = "census";
  constructor(private readonly ctx: AdapterContext) {}

  async geocode(address: string): Promise<GeocodeResult | null> {
    const base = optString(this.ctx.options, "base_url", "https://geocoding.geo.census.gov/geocoder");
    const benchmark = optString(this.ctx.options, "benchmark", "Public_AR_Current");
    const url = `${base}/locations/onelineaddress?${new URLSearchParams({ address, benchmark, format: "json" })}`;
    const res = await this.ctx.http.request({ url });
    if (!res.ok) throw new Error(`Census geocoder ${res.status}`);
    const match = res.json<CensusResponse>().result?.addressMatches?.[0];
    if (!match) return null;
    return {
      lat: match.coordinates.y,
      lon: match.coordinates.x,
      canonical_address: match.matchedAddress,
      city: match.addressComponents?.city ?? null,
      zip: match.addressComponents?.zip ?? null,
      parcel_id_hint: null,
      source_url: url,
    };
  }
}

interface NominatimHit {
  lat: string;
  lon: string;
  display_name: string;
  address?: { city?: string; town?: string; village?: string; postcode?: string; house_number?: string; road?: string; state?: string };
}

/** Self-hosted Nominatim (NC OSM extract). The public server is never used. */
export class NominatimGeocoder implements GeocodingProvider {
  readonly name = "nominatim";
  constructor(private readonly ctx: AdapterContext) {}

  baseUrl(): string {
    const envName = optString(this.ctx.options, "base_url_env", "NOMINATIM_URL");
    const fromEnv = this.ctx.env[envName]?.trim();
    const base = fromEnv || optString(this.ctx.options, "default_base_url", "http://localhost:8080");
    if (/nominatim\.openstreetmap\.org/i.test(base)) {
      throw new Error("Public Nominatim (nominatim.openstreetmap.org) must not be used for scheduled runs; self-host it.");
    }
    return base.replace(/\/+$/, "");
  }

  async geocode(address: string): Promise<GeocodeResult | null> {
    const url = `${this.baseUrl()}/search?${new URLSearchParams({
      q: address,
      format: "jsonv2",
      countrycodes: "us",
      limit: "1",
      addressdetails: "1",
    })}`;
    const res = await this.ctx.http.request({ url, headers: { "User-Agent": "dealersource/0.1" } });
    if (!res.ok) throw new Error(`Nominatim ${res.status}`);
    const hit = res.json<NominatimHit[]>()[0];
    if (!hit) return null;
    const a = hit.address ?? {};
    const canonical =
      a.house_number && a.road
        ? `${a.house_number} ${a.road}, ${a.city ?? a.town ?? a.village ?? ""}, ${a.state ?? "NC"} ${a.postcode ?? ""}`.replace(/\s+/g, " ").trim()
        : hit.display_name;
    return {
      lat: Number(hit.lat),
      lon: Number(hit.lon),
      canonical_address: canonical,
      city: a.city ?? a.town ?? a.village ?? null,
      zip: a.postcode ?? null,
      parcel_id_hint: null,
      source_url: url,
    };
  }
}

interface GoogleGeocodeResponse {
  status: string;
  results?: Array<{
    formatted_address: string;
    geometry: { location: { lat: number; lng: number } };
    address_components?: Array<{ long_name: string; types: string[] }>;
  }>;
}

/** PAID. Google Geocoding API; only reachable when providers.paid_enabled is true. */
export class GoogleGeocoder implements GeocodingProvider {
  readonly name = "google";
  constructor(private readonly ctx: AdapterContext) {}

  async geocode(address: string): Promise<GeocodeResult | null> {
    const base = optString(this.ctx.options, "base_url", "https://maps.googleapis.com/maps/api");
    const key = this.ctx.env.GOOGLE_MAPS_API_KEY ?? "";
    const url = `${base}/geocode/json?${new URLSearchParams({ address, key })}`;
    const res = await this.ctx.http.request({ url });
    const json = res.json<GoogleGeocodeResponse>();
    const r = json.results?.[0];
    if (!r) return null;
    const comp = (t: string) => r.address_components?.find((c) => c.types.includes(t))?.long_name ?? null;
    return {
      lat: r.geometry.location.lat,
      lon: r.geometry.location.lng,
      canonical_address: r.formatted_address,
      city: comp("locality"),
      zip: comp("postal_code"),
      parcel_id_hint: null,
      source_url: url.replace(key, "REDACTED"),
    };
  }
}
