import { z } from "zod";

// ---------------------------------------------------------------- business
const jurisdictionSchema = z.object({
  county: z.string(),
  planning_email: z.string().email(),
  source_url: z.string().url(),
  verified: z.boolean().default(false),
});

export const businessSchema = z.object({
  search: z.object({
    home_base: z.string().min(3),
    max_drive_minutes: z.number().int().positive(),
  }),
  rent: z
    .object({ min_monthly: z.number().nonnegative(), max_monthly: z.number().positive() })
    .refine((r) => r.min_monthly <= r.max_monthly, "rent.min_monthly must be <= rent.max_monthly"),
  site: z.object({
    min_vehicle_display: z.number().int().nonnegative(),
    office_required: z.boolean(),
    shared_lot: z.enum(["exclude", "last_resort", "allowed"]),
  }),
  flood: z.object({
    high_risk_zones: z.array(z.string()).nonempty(),
    warn_subtypes: z.array(z.string()).default([]),
  }),
  dealer: z.object({
    license_status: z.enum(["held", "pending", "none"]),
    place_of_business_checks: z.object({
      enclosed_office: z.boolean(),
      display_area_min_vehicles: z.number().int().nonnegative(),
      sign_required: z.boolean(),
    }),
  }),
  ranking: z.object({
    weights: z.object({
      traffic: z.number().nonnegative(),
      visibility: z.number().nonnegative(),
      distance: z.number().nonnegative(),
      rent: z.number().nonnegative(),
      competitors: z.number().nonnegative(),
    }),
    bounds: z.object({
      traffic_aadt_max: z.number().positive(),
      frontage_ft_max: z.number().positive(),
      competitors_max: z.number().positive(),
    }),
  }),
  competitors: z.object({ radius_m: z.number().positive() }),
  evidence: z.object({ ttl_days: z.record(z.string(), z.number().int().positive()) }),
  mail: z.object({
    sender: z.enum(["owner", "operator"]),
    followup_days: z.number().int().positive(),
    max_followups: z.number().int().nonnegative(),
    bounce_pause_pct: z.number().nonnegative(),
    inbound_lookback_days: z.number().int().positive(),
  }),
  jurisdictions: z.record(z.string(), jurisdictionSchema),
  schedule: z.object({
    scheduler: z.enum(["claude-routine", "github-actions", "pg_cron"]),
    cron: z.string(),
    timezone: z.string(),
  }),
  report: z.object({ out_dir: z.string(), dashboard_data_dir: z.string() }),
});
export type BusinessConfig = z.infer<typeof businessSchema>;

// --------------------------------------------------------------- providers
export const LAYERS = [
  "geocoding",
  "parcels",
  "zoning",
  "drivetime",
  "traffic",
  "flood",
  "imagery",
  "competitors",
  "crawl",
  "social",
  "mail",
  "llm",
  "tiles",
] as const;
export type Layer = (typeof LAYERS)[number];

export const providersSchema = z.object({
  paid_enabled: z.boolean().default(false),
  layers: z.object(Object.fromEntries(LAYERS.map((l) => [l, z.string()])) as Record<Layer, z.ZodString>),
  options: z.record(z.string(), z.record(z.string(), z.unknown())).default({}),
});
export type ProvidersConfig = z.infer<typeof providersSchema>;

// ----------------------------------------------------------------- sources
export const sourceSchema = z.object({
  id: z.string().regex(/^[a-z0-9-]+$/),
  kind: z.enum(["crawl", "reddit", "rss", "manual"]),
  url: z.string(),
  robots_txt: z.enum(["allowed", "disallowed", "unknown"]),
  terms_status: z.enum(["allowed", "prohibited", "unclear"]),
  enabled: z.boolean(),
  cadence: z.string().default("daily"),
  fixture_only: z.boolean().default(false),
  notes: z.string().nullable().default(null),
});
export const sourcesSchema = z.object({ sources: z.array(sourceSchema) });
export type SourceConfig = z.infer<typeof sourceSchema>;

// -------------------------------------------------------------- use tables
export const useTablesSchema = z.object({
  jurisdictions: z.record(
    z.string(),
    z.object({
      ordinance: z.string(),
      use_table_url: z.string().url(),
      checked: z.union([z.string(), z.date()]).transform((v) => (v instanceof Date ? v.toISOString().slice(0, 10) : v)),
      districts: z.record(
        z.string(),
        z.object({
          name: z.string(),
          status: z.enum(["permitted", "conditional", "prohibited"]),
          section: z.string(),
        }),
      ),
    }),
  ),
});
export type UseTablesConfig = z.infer<typeof useTablesSchema>;

// ----------------------------------------------------------- mail templates
const templateGroup = z.object({
  subject: z.string(),
  intro: z.string(),
  followup_intro: z.string(),
  sections: z.record(z.string(), z.string()),
  outro: z.string(),
});
export const mailTemplatesSchema = z.object({
  sender_signature: z.string(),
  leasing: templateGroup,
  planning: templateGroup,
});
export type MailTemplates = z.infer<typeof mailTemplatesSchema>;

// ------------------------------------------------------------ manual leads
export const manualLeadsSchema = z.object({
  leads: z
    .array(
      z.object({
        url: z.string(),
        title: z.string(),
        address_text: z.string(),
        rent_monthly_advertised: z.number().nullable().default(null),
        has_office: z.boolean().nullable().default(null),
        shared_lot: z.boolean().default(false),
        contact_email: z.string().nullable().default(null),
        contact_name: z.string().nullable().default(null),
        notes: z.string().nullable().default(null),
      }),
    )
    .default([]),
});
export type ManualLeads = z.infer<typeof manualLeadsSchema>;
