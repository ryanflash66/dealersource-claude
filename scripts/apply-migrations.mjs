#!/usr/bin/env node
/**
 * Apply every supabase/migrations/*.sql in sorted (filename) order using the
 * `psql` CLI. Plain Node ESM, no npm dependencies.
 *
 *   DATABASE_URL=postgres://... node scripts/apply-migrations.mjs [--list]
 *
 * Each file runs as:  psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f <file>
 *
 * This script never contacts the network on its own: it only hands the
 * DATABASE_URL you provide to psql. Exit codes: 0 ok, 1 a migration failed,
 * 2 missing DATABASE_URL / psql / migrations folder.
 */
import { readdirSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const here = dirname(fileURLToPath(import.meta.url));
const migrationsDir = resolve(here, "..", "supabase", "migrations");
const listOnly = process.argv.includes("--list");

const HELP = `
DATABASE_URL is not set. Point it at the Postgres you want to migrate:

  1. Docker stack (docker-compose.yml at the repo root; the migrations are also
     auto-applied on FIRST start via /docker-entrypoint-initdb.d):
       DATABASE_URL=postgres://postgres:dealersource@localhost:54322/dealersource

  2. Supabase CLI local stack: you do not need this script. From the repo root
     run \`supabase start\` (picks up supabase/migrations), or to apply new
     files to a running stack \`supabase migration up\`; for a linked hosted
     project \`supabase db push\`.

  3. Hosted Supabase project: use the project's connection string
     (Project Settings -> Database -> Connection string, URI form, e.g.
     postgres://postgres.<ref>:<password>@aws-0-<region>.pooler.supabase.com:5432/postgres)
     or paste the SQL files into the SQL editor in order.

Then:  DATABASE_URL=... node scripts/apply-migrations.mjs
`.trimStart();

function listMigrations() {
  let entries;
  try {
    entries = readdirSync(migrationsDir);
  } catch {
    console.error(`No migrations folder at ${migrationsDir}`);
    process.exit(2);
  }
  return entries
    .filter((f) => f.toLowerCase().endsWith(".sql"))
    .filter((f) => statSync(join(migrationsDir, f)).isFile())
    .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))
    .map((f) => join(migrationsDir, f));
}

const files = listMigrations();

if (listOnly) {
  for (const f of files) console.log(f);
  process.exit(0);
}

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  console.error(HELP);
  process.exit(2);
}

const probe = spawnSync("psql", ["--version"], { encoding: "utf8" });
if (probe.error || probe.status !== 0) {
  console.error(
    "psql (the PostgreSQL command-line client) was not found on PATH.\n" +
      "Install PostgreSQL client tools, or apply the SQL another way:\n" +
      "  - Docker stack: migrations auto-apply on first `docker compose up -d`\n" +
      "  - Supabase CLI: `supabase start` / `supabase migration up` / `supabase db push`\n" +
      "  - Hosted: paste supabase/migrations/*.sql into the SQL editor in order",
  );
  process.exit(2);
}

if (files.length === 0) {
  console.error(`No .sql files found in ${migrationsDir}`);
  process.exit(2);
}

// Never print the URL: it carries the database password.
console.log(`Applying ${files.length} migration(s) from ${migrationsDir} with ${probe.stdout.trim()}`);

for (const file of files) {
  console.log(`-> ${file}`);
  const res = spawnSync("psql", [databaseUrl, "-v", "ON_ERROR_STOP=1", "-f", file], { stdio: "inherit" });
  if (res.error) {
    console.error(`Failed to start psql: ${res.error.message}`);
    process.exit(2);
  }
  if (res.status !== 0) {
    console.error(`Migration failed (psql exit ${res.status}): ${file}`);
    process.exit(1);
  }
}

console.log("All migrations applied.");
