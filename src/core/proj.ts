/**
 * Coordinate reprojection for the one projected CRS the free NC layers return
 * geometry in: EPSG:2264 (NAD83 / North Carolina, US survey feet; ESRI 102719).
 * Lambert Conformal Conic 2SP on GRS80, inverse formulas from Snyder (1987).
 * NAD83 and WGS84 differ by well under a metre here, so 4326 is used directly.
 */
import type { Polygon } from "./types.js";

const US_FT = 0.3048006096012192; // metres per US survey foot
const A = 6378137; // GRS80 semi-major axis (m)
const F = 1 / 298.257222101;
const E = Math.sqrt(2 * F - F * F);
const D2R = Math.PI / 180;

interface Lcc {
  n: number;
  Fc: number;
  rho0: number;
  lon0: number;
  fe: number;
  fn: number;
}

function lccSetup(lat1d: number, lat2d: number, lat0d: number, lon0d: number, feM: number, fnM: number): Lcc {
  const m = (phi: number) => Math.cos(phi) / Math.sqrt(1 - E * E * Math.sin(phi) ** 2);
  const t = (phi: number) => Math.tan(Math.PI / 4 - phi / 2) / ((1 - E * Math.sin(phi)) / (1 + E * Math.sin(phi))) ** (E / 2);
  const p1 = lat1d * D2R, p2 = lat2d * D2R, p0 = lat0d * D2R;
  const n = (Math.log(m(p1)) - Math.log(m(p2))) / (Math.log(t(p1)) - Math.log(t(p2)));
  const Fc = m(p1) / (n * t(p1) ** n);
  const rho0 = A * Fc * t(p0) ** n;
  return { n, Fc, rho0, lon0: lon0d * D2R, fe: feM, fn: fnM };
}

/** EPSG:2264: lat1 34°20', lat2 36°10', lat0 33°45', lon0 -79°, FE 2,000,000 US ft, FN 0. */
const NC2264: Lcc = lccSetup(34 + 20 / 60, 36 + 10 / 60, 33.75, -79, 609601.22, 0);

/** Inverse LCC: projected (x, y) in US survey feet -> [lon, lat] degrees. */
export function nc2264ToLonLat(xFt: number, yFt: number, p: Lcc = NC2264): [number, number] {
  const x = xFt * US_FT - p.fe;
  const y = yFt * US_FT - p.fn;
  const sign = p.n < 0 ? -1 : 1;
  const rho = sign * Math.sqrt(x * x + (p.rho0 - y) ** 2);
  const theta = Math.atan2(sign * x, sign * (p.rho0 - y));
  const t = (rho / (A * p.Fc)) ** (1 / p.n);
  let phi = Math.PI / 2 - 2 * Math.atan(t);
  for (let i = 0; i < 8; i++) {
    const es = E * Math.sin(phi);
    const next = Math.PI / 2 - 2 * Math.atan(t * ((1 - es) / (1 + es)) ** (E / 2));
    if (Math.abs(next - phi) < 1e-12) { phi = next; break; }
    phi = next;
  }
  const lon = theta / p.n + p.lon0;
  return [lon / D2R, phi / D2R];
}

/** Reprojects ArcGIS rings from EPSG:2264/102719 to a GeoJSON polygon in EPSG:4326. */
export function ringsFrom2264(rings: number[][][]): Polygon {
  return { type: "Polygon", coordinates: rings.map((ring) => ring.map(([x, y]) => nc2264ToLonLat(x!, y!))) };
}

/** True when an ArcGIS spatialReference identifies NC State Plane feet. */
export function isNcStatePlane(sr: { wkid?: number; latestWkid?: number } | undefined): boolean {
  return sr?.latestWkid === 2264 || sr?.wkid === 2264 || sr?.wkid === 102719;
}
