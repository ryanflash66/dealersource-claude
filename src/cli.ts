#!/usr/bin/env node
/**
 * dealersource CLI (task-spec section 14.2)
 *
 *   npm run pipeline -- --offline --fixtures <dir> --out <dir> --run-date YYYY-MM-DD [--config providers.yaml]
 *   npm run pipeline -- --out <dir>                         # online, real adapters, env from .env
 *   npm run pipeline -- ... --stage enrich                  # run a single stage
 *   tsx src/cli.ts sources check                            # print the allowlist decision per source
 *   tsx src/cli.ts sources discover --out <dir>             # find broker POIs near home base (online)
 */
import { writeFileSync, mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { loadConfig } from "./config/load.js";
import { Logger, levelFromEnv } from "./core/logger.js";
import { OfflineNetworkViolation, runPipeline, STAGES } from "./pipeline/run.js";
import { refusalReason } from "./pipeline/discover.js";
import { buildProviders } from "./providers/registry.js";
import { CostLedger } from "./http/cost-ledger.js";
import { makeClock } from "./core/clock.js";
import type { Stage } from "./core/types.js";

interface Args {
  positional: string[];
  flags: Record<string, string | boolean>;
}

export function parseArgs(argv: string[]): Args {
  const out: Args = { positional: [], flags: {} };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a.startsWith("--")) {
      const key = a.slice(2);
      const eq = key.indexOf("=");
      if (eq >= 0) out.flags[key.slice(0, eq)] = key.slice(eq + 1);
      else if (i + 1 < argv.length && !argv[i + 1]!.startsWith("--")) out.flags[key] = argv[++i]!;
      else out.flags[key] = true;
    } else out.positional.push(a);
  }
  return out;
}

const str = (v: string | boolean | undefined): string | undefined => (typeof v === "string" ? v : undefined);

async function main(argv: string[]): Promise<number> {
  const args = parseArgs(argv);
  const cmd = args.positional[0] ?? "run";
  const logger = new Logger(levelFromEnv(process.env), {}, (l) => process.stderr.write(l + "\n"));

  if (cmd === "run") {
    const offline = args.flags.offline === true || process.env.DEALERSOURCE_OFFLINE === "1";
    const outDir = str(args.flags.out) ?? "out";
    const stage = str(args.flags.stage) as Stage | undefined;
    if (stage && !STAGES.includes(stage)) {
      process.stderr.write(`unknown --stage ${stage}; valid: ${STAGES.join(", ")}\n`);
      return 2;
    }
    try {
      const result = await runPipeline({
        offline,
        fixturesDir: str(args.flags.fixtures) ?? null,
        outDir,
        runDate: str(args.flags["run-date"]),
        now: str(args.flags.now),
        providersPath: str(args.flags.config),
        businessPath: str(args.flags.business),
        stages: stage ? [stage] : undefined,
        logger,
      });
      const viable = result.report?.sites.filter((s) => s.viable).length ?? 0;
      process.stdout.write(
        JSON.stringify({
          run_id: result.run.run_id,
          run_date: result.run.run_date,
          offline,
          out: outDir,
          sites: result.report?.sites.length ?? 0,
          viable,
          messages_sent: result.messages.length,
          errors: result.run.errors,
        }) + "\n",
      );
      return result.run.errors.length ? 1 : 0;
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      process.stderr.write(`pipeline failed: ${msg}\n`);
      return e instanceof OfflineNetworkViolation ? 3 : 1;
    }
  }

  if (cmd === "sources" && args.positional[1] === "check") {
    const cfg = loadConfig({ providersPath: str(args.flags.config) });
    for (const s of cfg.sources) {
      const reason = refusalReason(s);
      process.stdout.write(`${reason ? "REFUSE " : "FETCH  "} ${s.id.padEnd(40)} ${s.kind.padEnd(7)} terms=${s.terms_status.padEnd(10)} robots=${s.robots_txt.padEnd(10)} ${reason ?? ""}\n`);
    }
    return 0;
  }

  if (cmd === "sources" && args.positional[1] === "discover") {
    // Online helper: find estate agents / property managers near home base and
    // write candidate source rows (terms unclear, disabled) for the PM to research.
    const cfg = loadConfig({ providersPath: str(args.flags.config) });
    const outDir = str(args.flags.out) ?? "out";
    const clock = makeClock(null);
    const built = buildProviders({ config: cfg, env: process.env, clock, logger, offline: false, fixturesDir: str(args.flags.fixtures) ?? null, outDir, ledger: new CostLedger(), hosts: new Set() });
    const home = await built.providers.geocoder.geocode(cfg.business.search.home_base);
    if (!home) {
      process.stderr.write("home base could not be geocoded\n");
      return 1;
    }
    const pois = await built.providers.poi.estateAgentsWithin({ lat: home.lat, lon: home.lon }, 25_000);
    const candidates = pois.items
      .filter((p) => p.tags.website || p.tags["contact:website"])
      .map((p) => ({
        id: (p.name ?? "broker").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") + "-listings",
        kind: "crawl",
        url: p.tags.website ?? p.tags["contact:website"],
        robots_txt: "unknown",
        terms_status: "unclear",
        enabled: false,
        cadence: "weekly",
        notes: `Discovered via POI (${built.providers.poi.name}) near home base; research terms then flip to allowed.`,
      }));
    mkdirSync(outDir, { recursive: true });
    const path = resolve(outDir, "sources.candidates.yaml");
    writeFileSync(path, "sources:\n" + candidates.map((c) => Object.entries(c).map(([k, v], i) => `${i === 0 ? "  - " : "    "}${k}: ${JSON.stringify(v)}`).join("\n")).join("\n") + "\n");
    process.stdout.write(`${candidates.length} candidate sources written to ${path}\n`);
    return 0;
  }

  process.stderr.write("usage: cli.ts run [--offline --fixtures <dir>] --out <dir> [--run-date YYYY-MM-DD] [--config providers.yaml] [--stage <stage>]\n       cli.ts sources check | sources discover --out <dir>\n");
  return 2;
}

main(process.argv.slice(2)).then(
  (code) => process.exit(code),
  (e) => {
    process.stderr.write(`fatal: ${e instanceof Error ? e.stack ?? e.message : String(e)}\n`);
    process.exit(1);
  },
);
