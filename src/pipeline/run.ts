import { resolve as resolvePath, isAbsolute } from "node:path";
import { loadConfig, type AppConfig, type LoadOptions } from "../config/load.js";
import { contractProviders } from "../config/schema.js";
import { makeClock } from "../core/clock.js";
import { stableId } from "../core/ids.js";
import { Logger, levelFromEnv } from "../core/logger.js";
import type { RunRow, Stage } from "../core/types.js";
import { CostLedger } from "../http/cost-ledger.js";
import { installNetworkGuard } from "../http/network-guard.js";
import { buildProviders, type BuildOptions } from "../providers/registry.js";
import { makeStore } from "../store/index.js";
import type { Store } from "../store/store.js";
import { type RunContext, errMsg } from "./context.js";
import { discover } from "./discover.js";
import { resolve } from "./resolve.js";
import { enrich } from "./enrich.js";
import { verify } from "./verify.js";
import { score } from "./score.js";
import { report, writeRunJson, type ContractMessage, type ContractReport, type ContractRun } from "./report.js";

export const STAGES: Stage[] = ["discover", "resolve", "enrich", "verify", "score", "report"];

export interface RunOptions {
  offline: boolean;
  fixturesDir: string | null;
  outDir: string;
  /** Logical today, YYYY-MM-DD. Default: today's date in the configured timezone. */
  runDate?: string;
  /** Freeze the clock at an exact instant (tests). Default: run-date at 10:00Z. */
  now?: string;
  providersPath?: string;
  businessPath?: string;
  configDir?: string;
  /** Run only these stages (default all, in order). */
  stages?: Stage[];
  env?: NodeJS.ProcessEnv;
  logger?: Logger;
  configOverrides?: LoadOptions["overrides"];
  /** Test hooks. */
  store?: Store;
  httpFactory?: BuildOptions["httpFactory"];
}

export interface RunResult {
  run: ContractRun;
  report: ContractReport | null;
  messages: ContractMessage[];
  config: AppConfig;
  ctx: RunContext;
}

export class OfflineNetworkViolation extends Error {}

/**
 * Runs the six stages (spec section 7) in order. Each stage is idempotent and
 * resumable: state lives in the store, and re-running the same run-date sends
 * nothing twice. Offline runs install a global network guard so any attempted
 * network access is a hard error.
 */
export async function runPipeline(opts: RunOptions): Promise<RunResult> {
  const env = opts.env ?? process.env;
  const offline = opts.offline || env.DEALERSOURCE_OFFLINE === "1";
  const config = loadConfig({ providersPath: opts.providersPath, businessPath: opts.businessPath, configDir: opts.configDir, env, overrides: opts.configOverrides });
  const outDir = isAbsolute(opts.outDir) ? opts.outDir : resolvePath(process.cwd(), opts.outDir);
  const fixturesDir = opts.fixturesDir ? (isAbsolute(opts.fixturesDir) ? opts.fixturesDir : resolvePath(process.cwd(), opts.fixturesDir)) : null;
  if (offline && !fixturesDir) throw new Error("--offline requires --fixtures <dir> (section 14.2)");

  const runDate = opts.runDate ?? env.DEALERSOURCE_RUN_DATE ?? todayIn(config.business.schedule.timezone);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(runDate)) throw new Error(`--run-date must be YYYY-MM-DD, got ${runDate}`);
  const clock = makeClock(opts.now ?? env.DEALERSOURCE_NOW ?? `${runDate}T10:00:00.000Z`);
  const cutoffIso = `${runDate}T23:59:59.999Z`;
  const runId = stableId("run", runDate, clock.iso(), String(Math.random()));
  const logger = (opts.logger ?? new Logger(levelFromEnv(env))).child({ run_id: runId });

  const releaseGuard = offline ? installNetworkGuard() : () => undefined;
  const ledger = new CostLedger();
  const hosts = new Set<string>();
  try {
    const { store, description } =
      opts.store ? { store: opts.store, description: "injected" } : makeStore({ env, offline, rootDir: config.rootDir, statePath: resolvePath(outDir, "state", "state.json") });
    await store.init();
    logger.info("store ready", { store: description });

    const built = buildProviders({ config, env, clock, logger, offline, fixturesDir, outDir, ledger, hosts, httpFactory: opts.httpFactory });
    for (const n of built.notes) logger.warn(n);

    const run: RunRow = {
      id: runId,
      run_date: runDate,
      started_at: clock.iso(),
      finished_at: null,
      mode: offline ? "offline" : "online",
      stages: {},
      counts: {},
      errors: [],
      warnings: [...built.notes],
      paid_calls: [],
      external_calls: [],
      fixture_layers: built.fixtureLayers,
      sending_paused: false,
      pause_reason: null,
      providers: contractProviders(config.providers),
      status: "running",
    };
    await store.upsert("runs", [run]);

    const ctx: RunContext = {
      config,
      store,
      providers: built.providers,
      clock,
      logger,
      run,
      offline,
      fixtures: built.fixtures,
      outDir,
      ledger,
      hosts,
      runDate,
      cutoffIso,
      homeBase: null,
      sentThisRun: [],
    };
    ctx.homeBase = await geocodeHomeBase(ctx);

    let contractReport: ContractReport | null = null;
    let messages: ContractMessage[] = [];
    const stages = opts.stages ?? STAGES;
    for (const stage of stages) {
      logger.info("stage start", { stage });
      try {
        if (stage === "report") {
          const r = await report(ctx);
          run.stages.report = r.counter.summary();
          run.errors.push(...r.counter.errors);
          contractReport = r.report;
          messages = r.messages;
        } else {
          const fn = { discover, resolve, enrich, verify, score }[stage];
          const counter = await fn(ctx);
          run.stages[stage] = counter.summary();
          run.errors.push(...counter.errors);
        }
        logger.info("stage done", { stage, counts: run.stages[stage]?.counts });
      } catch (e) {
        run.errors.push(`${stage}: ${errMsg(e)}`);
        logger.error("stage failed", { stage, error: errMsg(e) });
        if (isNetworkViolation(e)) throw new OfflineNetworkViolation(errMsg(e));
        break; // later stages depend on this one
      }
      await store.flush();
    }

    run.paid_calls = ledger.calls;
    run.external_calls = [...hosts].sort();
    run.finished_at = clock.iso();
    run.status = run.errors.length ? "error" : "ok";
    for (const [k, v] of Object.entries(run.stages)) for (const [ck, cv] of Object.entries(v!.counts)) run.counts[`${k}.${ck}`] = cv;
    await store.upsert("runs", [run]);
    await store.flush();
    const runJson = writeRunJson(ctx, run.finished_at);
    if (offline && hosts.size) throw new OfflineNetworkViolation(`offline run contacted hosts: ${[...hosts].join(", ")}`);
    return { run: runJson, report: contractReport, messages, config, ctx };
  } finally {
    releaseGuard();
  }
}

async function geocodeHomeBase(ctx: RunContext) {
  try {
    const g = await ctx.providers.geocoder.geocode(ctx.config.business.search.home_base);
    if (!g) ctx.logger.warn("home base could not be geocoded; drive-time adapters that need coordinates will fail", { home_base: ctx.config.business.search.home_base });
    return g ? { lat: g.lat, lon: g.lon } : null;
  } catch (e) {
    ctx.logger.warn("home base geocode failed", { error: errMsg(e) });
    return null;
  }
}

function isNetworkViolation(e: unknown): boolean {
  return e instanceof Error && /Network access is disabled in offline mode/.test(e.message);
}

export function todayIn(timeZone: string): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
}
