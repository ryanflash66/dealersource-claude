import { readFileSync, existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
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
  configDir?: string;
  env?: NodeJS.ProcessEnv;
  /** Override individual files (used by tests to switch providers without touching disk). */
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
  const configDir = opts.configDir ?? resolve(rootDir, "config");
  const env = opts.env ?? process.env;
  const o = opts.overrides ?? {};

  const businessRaw = (o.business ?? readYaml(resolve(configDir, "business.yaml"))) as Record<string, any>;
  // Deploy-time override for the real dealership address; never committed.
  if (env.DEALERSOURCE_HOME_BASE?.trim()) {
    businessRaw.search = { ...businessRaw.search, home_base: env.DEALERSOURCE_HOME_BASE.trim() };
  }

  const business = businessSchema.parse(businessRaw);
  const providers = providersSchema.parse(o.providers ?? readYaml(resolve(configDir, "providers.yaml")));
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

  return { rootDir, configDir, business, providers, sources, useTables, mailTemplates, manualLeads };
}

/** Deep-clone helper so tests can mutate a copy of the loaded config. */
export function cloneConfig(cfg: AppConfig): AppConfig {
  return structuredClone(cfg);
}
