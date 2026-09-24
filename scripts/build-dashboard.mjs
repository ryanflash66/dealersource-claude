#!/usr/bin/env node
/**
 * Build the static dashboard into dashboard/public.
 *
 *   node scripts/build-dashboard.mjs
 *
 * Steps:
 *   1. Pick the data directory: $DASHBOARD_DATA_DIR if set, otherwise run the
 *      offline golden pipeline into out/dashboard.
 *   2. Compile dashboard/src/app.ts -> dashboard/public/app.js with tsc.
 *   3. Copy report.json, messages.json, run.json into dashboard/public/data/.
 *   4. Copy the map libraries (MapLibre GL, PMTiles reader, Protomaps style)
 *      from node_modules into dashboard/public/vendor/.
 *   5. Write dashboard/public/config.js from SUPABASE_URL, SUPABASE_ANON_KEY,
 *      PMTILES_URL (all optional; empty Supabase values mean "fixture data";
 *      PMTILES_URL defaults to the bundled tiles/eastern-nc.pmtiles).
 *
 * Plain Node ESM, no dependencies. Exits non-zero on any failure.
 */

import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const publicDir = path.join(root, "dashboard", "public");
const dataOut = path.join(publicDir, "data");
const TAG = "[dashboard:build]";

function run(cmd, args, label) {
  const line = [cmd, ...args].join(" ");
  console.log(`${TAG} ${label}: ${line}`);
  // One command string with shell: true (equivalent to spawnSync(cmd, args, {shell: true})
  // but avoids Node 24's DEP0190 warning about unescaped args). No arg contains spaces.
  const res = spawnSync(line, { stdio: "inherit", shell: true, cwd: root });
  if (res.error) {
    console.error(`${TAG} ${label} could not start: ${res.error.message}`);
    process.exit(1);
  }
  if (res.status !== 0) {
    console.error(`${TAG} ${label} failed (exit ${res.status ?? "signal"})`);
    process.exit(res.status ?? 1);
  }
}

// 1. Data directory ---------------------------------------------------------
let dataDir;
let dataLabel;
if (process.env.DASHBOARD_DATA_DIR) {
  dataDir = path.resolve(root, process.env.DASHBOARD_DATA_DIR);
  dataLabel = `DASHBOARD_DATA_DIR=${dataDir}`;
  if (!existsSync(path.join(dataDir, "report.json"))) {
    console.error(`${TAG} ${dataDir} does not contain report.json`);
    process.exit(1);
  }
} else {
  // Start from a clean output dir: the pipeline persists state under out/dashboard/state,
  // and a re-run against old state treats messages as already sent (empty messages.json).
  rmSync(path.join(root, "out", "dashboard"), { recursive: true, force: true });
  run(
    "npx",
    ["tsx", "src/cli.ts", "run", "--offline", "--fixtures", "fixtures/golden-v1", "--out", "out/dashboard", "--run-date", "2026-09-16"],
    "offline pipeline",
  );
  dataDir = path.join(root, "out", "dashboard");
  dataLabel = "offline golden pipeline -> out/dashboard";
}

// 2. Compile the TypeScript app --------------------------------------------
run("npx", ["tsc", "-p", "dashboard/tsconfig.json"], "tsc");
if (!existsSync(path.join(publicDir, "app.js"))) {
  console.error(`${TAG} tsc finished but dashboard/public/app.js is missing`);
  process.exit(1);
}

// 3. Copy data files --------------------------------------------------------
mkdirSync(dataOut, { recursive: true });
const copied = [];
for (const name of ["report.json", "messages.json", "run.json"]) {
  const src = path.join(dataDir, name);
  if (!existsSync(src)) {
    if (name === "report.json") {
      console.error(`${TAG} required file missing: ${src}`);
      process.exit(1);
    }
    console.warn(`${TAG} optional file missing, skipped: ${src}`);
    continue;
  }
  copyFileSync(src, path.join(dataOut, name));
  copied.push(name);
}

// 4. Map libraries ------------------------------------------------------------
// MapLibre ships ESM that loads its shared chunk and worker relative to itself,
// so its three .mjs files stay together. pmtiles and basemaps are IIFE globals.
const vendorDir = path.join(publicDir, "vendor");
const VENDOR = [
  ["maplibre-gl/dist/maplibre-gl.mjs", "maplibre-gl.mjs"],
  ["maplibre-gl/dist/maplibre-gl-shared.mjs", "maplibre-gl-shared.mjs"],
  ["maplibre-gl/dist/maplibre-gl-worker.mjs", "maplibre-gl-worker.mjs"],
  ["maplibre-gl/dist/maplibre-gl.css", "maplibre-gl.css"],
  ["pmtiles/dist/pmtiles.js", "pmtiles.js"],
  ["@protomaps/basemaps/dist/basemaps.js", "basemaps.js"],
];
mkdirSync(vendorDir, { recursive: true });
const vendorMissing = VENDOR.filter(([src]) => !existsSync(path.join(root, "node_modules", src)));
if (vendorMissing.length) {
  console.warn(`${TAG} map libraries missing (run npm install), the map falls back to the site plot: ${vendorMissing.map(([s]) => s).join(", ")}`);
} else {
  for (const [src, dst] of VENDOR) copyFileSync(path.join(root, "node_modules", src), path.join(vendorDir, dst));
}

// 5. Runtime config ---------------------------------------------------------
const bundledTiles = existsSync(path.join(publicDir, "tiles", "eastern-nc.pmtiles")) ? "./tiles/eastern-nc.pmtiles" : "";
const cfg = {
  supabaseUrl: process.env.SUPABASE_URL ?? "",
  supabaseAnonKey: process.env.SUPABASE_ANON_KEY ?? "",
  pmtilesUrl: vendorMissing.length ? "" : process.env.PMTILES_URL || bundledTiles,
};
const configJs =
  `window.DS_CONFIG = {supabaseUrl: ${JSON.stringify(cfg.supabaseUrl)}, ` +
  `supabaseAnonKey: ${JSON.stringify(cfg.supabaseAnonKey)}, ` +
  `pmtilesUrl: ${JSON.stringify(cfg.pmtilesUrl)}};\n`;
writeFileSync(path.join(publicDir, "config.js"), configJs, "utf8");

const source = cfg.supabaseUrl && cfg.supabaseAnonKey ? `supabase (${cfg.supabaseUrl})` : "fixture data";
const basemap = cfg.pmtilesUrl ? `pmtiles basemap ${cfg.pmtilesUrl}` : "no basemap (site plot fallback)";
console.log(`${TAG} ok: data=${dataLabel}; copied ${copied.join(", ")}; app.js compiled; config -> ${source}, ${basemap}; output ${publicDir}`);
