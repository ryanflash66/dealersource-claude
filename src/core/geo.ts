import type { LatLon, Polygon } from "./types.js";

const EARTH_R = 6_371_008.8;

export function haversineMeters(a: LatLon, b: LatLon): number {
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLon = toRad(b.lon - a.lon);
  const s =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_R * Math.asin(Math.sqrt(s));
}

/** Ray-casting point-in-ring test. ring = [[lon,lat], ...]. */
export function pointInRing(p: LatLon, ring: number[][]): boolean {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const xi = ring[i]![0]!,
      yi = ring[i]![1]!;
    const xj = ring[j]![0]!,
      yj = ring[j]![1]!;
    const intersect =
      yi > p.lat !== yj > p.lat && p.lon < ((xj - xi) * (p.lat - yi)) / (yj - yi + 0) + xi;
    if (intersect) inside = !inside;
  }
  return inside;
}

export function pointInPolygon(p: LatLon, poly: Polygon): boolean {
  const [outer, ...holes] = poly.coordinates;
  if (!outer || !pointInRing(p, outer)) return false;
  return !holes.some((h) => pointInRing(p, h));
}

export function bbox(poly: Polygon): { minLon: number; minLat: number; maxLon: number; maxLat: number } {
  let minLon = Infinity,
    minLat = Infinity,
    maxLon = -Infinity,
    maxLat = -Infinity;
  for (const ring of poly.coordinates)
    for (const [lon, lat] of ring) {
      minLon = Math.min(minLon, lon!);
      maxLon = Math.max(maxLon, lon!);
      minLat = Math.min(minLat, lat!);
      maxLat = Math.max(maxLat, lat!);
    }
  return { minLon, minLat, maxLon, maxLat };
}

/** Area-weighted centroid of the outer ring (shoelace). */
export function centroid(poly: Polygon): LatLon {
  const ring = poly.coordinates[0]!;
  let a = 0,
    cx = 0,
    cy = 0;
  for (let i = 0; i < ring.length - 1; i++) {
    const [x0, y0] = ring[i]!;
    const [x1, y1] = ring[i + 1]!;
    const f = x0! * y1! - x1! * y0!;
    a += f;
    cx += (x0! + x1!) * f;
    cy += (y0! + y1!) * f;
  }
  if (Math.abs(a) < 1e-12) {
    const b = bbox(poly);
    return { lat: (b.minLat + b.maxLat) / 2, lon: (b.minLon + b.maxLon) / 2 };
  }
  a *= 0.5;
  return { lon: cx / (6 * a), lat: cy / (6 * a) };
}

/** Regular NxN grid of sample points that fall inside the polygon. */
export function samplePoints(poly: Polygon, n: number): LatLon[] {
  const b = bbox(poly);
  const pts: LatLon[] = [];
  for (let i = 0; i < n; i++)
    for (let j = 0; j < n; j++) {
      const p = {
        lon: b.minLon + ((i + 0.5) / n) * (b.maxLon - b.minLon),
        lat: b.minLat + ((j + 0.5) / n) * (b.maxLat - b.minLat),
      };
      if (pointInPolygon(p, poly)) pts.push(p);
    }
  return pts.length ? pts : [centroid(poly)];
}

/** Approximate square buffer polygon around a point (meters). */
export function squareAround(p: LatLon, meters: number): Polygon {
  const dLat = meters / 111_320;
  const dLon = meters / (111_320 * Math.cos((p.lat * Math.PI) / 180));
  return {
    type: "Polygon",
    coordinates: [
      [
        [p.lon - dLon, p.lat - dLat],
        [p.lon + dLon, p.lat - dLat],
        [p.lon + dLon, p.lat + dLat],
        [p.lon - dLon, p.lat + dLat],
        [p.lon - dLon, p.lat - dLat],
      ],
    ],
  };
}

/** ArcGIS JSON rings -> GeoJSON polygon (first ring outer). */
export function ringsToPolygon(rings: number[][][] | undefined): Polygon | null {
  if (!rings || !rings.length) return null;
  return { type: "Polygon", coordinates: rings };
}
