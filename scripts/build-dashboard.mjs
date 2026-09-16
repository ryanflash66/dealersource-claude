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
 *   4. Write dashboard/public/config.js from SUPABASE_URL, SUPABASE_ANON_KEY,
 *      PMTILES_URL (all optional; empty strings mean "fixture data, no basemap").
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

// 4. Runtime config ---------------------------------------------------------
const cfg = {
  supabaseUrl: process.env.SUPABASE_URL ?? "",
  supabaseAnonKey: process.env.SUPABASE_ANON_KEY ?? "",
  pmtilesUrl: process.env.PMTILES_URL ?? "",
};
const configJs =
  `window.DS_CONFIG = {supabaseUrl: ${JSON.stringify(cfg.supabaseUrl)}, ` +
  `supabaseAnonKey: ${JSON.stringify(cfg.supabaseAnonKey)}, ` +
  `pmtilesUrl: ${JSON.stringify(cfg.pmtilesUrl)}};\n`;
writeFileSync(path.join(publicDir, "config.js"), configJs, "utf8");

const source = cfg.supabaseUrl && cfg.supabaseAnonKey ? `supabase (${cfg.supabaseUrl})` : "fixture data";
const basemap = cfg.pmtilesUrl ? "pmtiles basemap" : "no basemap (SVG fallback)";
console.log(`${TAG} ok: data=${dataLabel}; copied ${copied.join(", ")}; app.js compiled; config -> ${source}, ${basemap}; output ${publicDir}`);
