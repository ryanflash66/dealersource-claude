# Scheduling

The pipeline runs as a **cloud scheduled agent (Claude Code routine)** by default
(`business.yaml schedule.scheduler: claude-routine`, cron `30 5 * * *` America/New_York).
The routine checks out this repo, runs the CLI, and performs the model steps that the
`claude_agent` LLM adapter leaves for it. Alternatives are documented below.

## Option A (default): Claude Code routine

Files: `agent/routine.yaml` (definition), `agent/routine.md` (the prompt the routine runs).

Setup, once:

1. In Claude Code, run `/schedule` (or the Routines UI) and create a routine from
   `agent/routine.yaml`: repository `ryanflash66/dealersource-claude`, branch `main`,
   cron `30 5 * * *`, timezone `America/New_York`.
2. Add the environment variables from `.env.example` that you intend to use as routine
   secrets (at minimum `DEALERSOURCE_HOME_BASE`, `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`,
   the `GMAIL_*` set, `ORS_API_KEY`, `MAPILLARY_ACCESS_TOKEN`, `REDDIT_*`). Nothing is stored
   in the repo.
3. Set `providers.yaml llm: claude_agent` so low-confidence extractions and reply
   classifications are written to `out/<date>/review-queue.json` for the routine to review.
4. Paste `agent/routine.md` as the routine prompt. It instructs the agent to:
   `npm ci` -> `npm run pipeline -- --out out/$RUN_DATE` -> read `run.json`, `digest.md`
   and `review-queue.json` -> correct any mis-extracted rows through the CLI/store ->
   re-run `--stage score` and `--stage report` if it changed anything -> post the digest.

Safety properties the routine relies on:

- Re-running the same day sends nothing twice (idempotent message ids per contact/site/day).
- `DEALERSOURCE_PAUSE_SENDING=1` stops outbound mail without a code or config change.
- Any stage error is in `run.json.errors` and the CLI exits non-zero, so the routine's
  failure notification fires.

## Option B: GitHub Actions

`.github/workflows/pipeline.yml` runs the same commands on `workflow_dispatch`; uncomment the
`schedule:` block to run on cron. Put the same variables in repository secrets. Model steps
are not available here, so keep `llm: rules` (or `claude_api` if paid is enabled).
`.github/workflows/ci.yml` runs `npm test` offline on every push.

## Option C: pg_cron (Supabase)

Supabase supports `pg_cron`. Because the pipeline is a Node process, pg_cron cannot run it
directly; the pattern is:

1. Deploy the CLI as a container or a Supabase Edge Function wrapper that runs
   `npm run pipeline -- --out /tmp/run`.
2. `select cron.schedule('dealersource-daily', '30 9 * * *', $$select net.http_post(url := '<function url>', headers := '{"Authorization":"Bearer <service key>"}'::jsonb)$$);`
   (09:30 UTC = 05:30 Eastern in DST; adjust for standard time or schedule twice.)

This option is documented, not implemented (task spec section 7).

## Option D (in use for this deployment): Windows Task Scheduler

`scripts/run-daily.ps1` runs the pipeline on a Windows PC that stays on or asleep (not shut down)
with the operator logged in. Task `dealersource daily`, every day at 05:30 local time, runs as the
logged-on user, wakes the machine, starts when available if a run was missed, one-hour limit.

- Action: `powershell.exe -NoProfile -ExecutionPolicy Bypass -File <checkout>\scripts\run-daily.ps1`
  (in the parent superproject: `agents\claude-solution\scripts\run-daily.ps1`), "Start in" set to
  the repo root.
- The script pulls `main` (fast-forward only), runs `npm ci` only when the commit changed or
  `node_modules` is missing, installs Playwright's Chromium headless shell once if it is missing
  (`scripts/ensure-browser.mjs`), loads the git-ignored `.env` into the process (values never
  logged), runs `node_modules\.bin\tsx.cmd src/cli.ts run --out out/<date> --run-date <date>`, and
  appends to `out/logs/<date>.log`, ending with one summary line (exit, sites, viable, emails sent,
  errors, paused).
- It calls `tsx.cmd` directly because `npm run pipeline -- <flags>` from PowerShell loses the
  flags (the `npm.ps1` shim swallows `--`; see the README's PowerShell note), and it uses
  `$ErrorActionPreference = 'Continue'` with explicit `$LASTEXITCODE` checks because Windows
  PowerShell 5.1 turns redirected git/npm stderr progress into terminating errors under `Stop`.
- `business.yaml schedule.scheduler` stays one of `claude-routine | github-actions | pg_cron`
  (the config schema accepts only those); the Task Scheduler setup lives outside the config.

## Run-date and time zone

`--run-date` defaults to today's date in `schedule.timezone`. The routine passes it
explicitly so a delayed start still uses the intended logical day.
