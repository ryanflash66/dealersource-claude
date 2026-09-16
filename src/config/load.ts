import { readFileSync, existsSync } from "node:fs";
import { resolve, dirname, isAbsolute } from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";
import {
  businessSchema,
  providersSchema,
  sourcesSchema,
  useTablesSchema,
  mailTemplatesSchema,
  manualLeadsSchema,
  type BusinessConfig,
  type ProvidersConfig,
  type SourceConfig,
  type UseTablesConfig,
  type MailTemplates,
  type ManualLeads,
} from "./schema.js";

export interface AppConfig {
  rootDir: string;
  configDir: string;
  providersPath: string;
  business: BusinessConfig;
  providers: ProvidersConfig;
  sources: SourceConfig[];
  useTables: UseTablesConfig;
  mailTemplates: MailTemplates;
  manualLeads: ManualLeads;
}

export function repoRoot(): string {
  // src/config/load.ts -> repo root is two levels up.
  return resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
}

function readYaml(path: string): unknown {
  if (!existsSync(path)) throw new Error(`Config file not found: ${path}`);
  return parse(readFileSync(path, "utf8"));
}

export interface LoadOptions {
  /** Path to providers.yaml (CLI --config). Default: <root>/providers.yaml. */
  providersPath?: string;
  /** Path to business.yaml. Default: <root>/business.yaml. */
  businessPath?: string;
  /** Directory holding sources.yaml, use-tables.yaml, mail-templates.yaml. */
  configDir?: string;
  env?: NodeJS.ProcessEnv;
  /** Override individual files (tests switch providers without touching disk). */
  overrides?: Partial<{
    business: unknown;
    providers: unknown;
    sources: unknown;
    useTables: unknown;
    mailTemplates: unknown;
    manualLeads: unknown;
  }>;
}

export function loadConfig(opts: LoadOptions = {}): AppConfig {
  const rootDir = repoRoot();
  const abs = (p: string) => (isAbsolute(p) ? p : resolve(process.cwd(), p));
  const configDir = opts.configDir ? abs(opts.configDir) : resolve(rootDir, "config");
  const providersPath = opts.providersPath ? abs(opts.providersPath) : resolve(rootDir, "providers.yaml");
  const businessPath = opts.businessPath ? abs(opts.businessPath) : resolve(rootDir, "business.yaml");
  const env = opts.env ?? process.env;
  const o = opts.overrides ?? {};

  const businessRaw = (o.business ?? readYaml(businessPath)) as Record<string, any>;
  // Deploy-time override for the real dealership address; never committed.
  if (env.DEALERSOURCE_HOME_BASE?.trim()) {
    businessRaw.search = { ...businessRaw.search, home_base: env.DEALERSOURCE_HOME_BASE.trim() };
  }
  // Operator kill switch for outreach without a config commit.
  if (env.DEALERSOURCE_PAUSE_SENDING === "1") {
    businessRaw.mail = { ...businessRaw.mail, paused: true };
  }

  const business = businessSchema.parse(businessRaw);
  const providers = providersSchema.parse(o.providers ?? readYaml(providersPath));
  const sources = sourcesSchema.parse(o.sources ?? readYaml(resolve(configDir, "sources.yaml"))).sources;
  const useTables = useTablesSchema.parse(o.useTables ?? readYaml(resolve(configDir, "use-tables.yaml")));
  const mailTemplates = mailTemplatesSchema.parse(
    o.mailTemplates ?? readYaml(resolve(configDir, "mail-templates.yaml")),
  );
  const manualPath = resolve(configDir, "manual-leads.yaml");
  const manualLeads = manualLeadsSchema.parse(
    o.manualLeads ?? (existsSync(manualPath) ? readYaml(manualPath) : { leads: [] }),
  );

  const ids = new Set<string>();
  for (const s of sources) {
    if (ids.has(s.id)) throw new Error(`Duplicate source id in sources.yaml: ${s.id}`);
    ids.add(s.id);
  }

  return { rootDir, configDir, providersPath, business, providers, sources, useTables, mailTemplates, manualLeads };
}

/** Deep-clone helper so tests can mutate a copy of the loaded config. */
export function cloneConfig(cfg: AppConfig): AppConfig {
  return structuredClone(cfg);
}
