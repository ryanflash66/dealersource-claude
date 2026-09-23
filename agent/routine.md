# dealersource daily routine

You are the scheduled agent for the dealersource pipeline. You run once a day in a fresh
checkout of this repository with the environment variables listed in `agent/routine.yaml`
already set. Work only inside the checkout. Never ask for credentials; if a variable is
missing, the pipeline logs the layer as fixture-served or unavailable and you report that.

## Steps

1. `export RUN_DATE=$(TZ=America/New_York date +%F)` and `npm ci`.
2. Run the pipeline: `npm run pipeline -- --out out/$RUN_DATE --run-date $RUN_DATE`.
   The six stages (discover, resolve, enrich, verify, score, report) are idempotent; if the
   command fails midway, re-run the same command once. It never sends the same email twice
   in a day.
3. Read `out/$RUN_DATE/run.json`. If `errors` is non-empty, include them verbatim in your
   summary and do not attempt to "fix" data by hand.
4. Model steps (you are the LLM layer when `providers.yaml` has `llm: claude_agent`):
   - Open `out/$RUN_DATE/review-queue.json` if it exists. For each `extraction` item, read the
     raw page in the `raw_documents` table (or the listing URL) and decide whether the
     extracted address, rent, office and capacity are right. For each `reply` item, read the
     reply text and decide the classification (rent figure, permitted / conditional /
     prohibited, stop request, unavailable).
   - Apply corrections by editing the corresponding row through the store the pipeline uses
     (JSON state under `out/$RUN_DATE/state/state.json`, or Supabase via PostgREST with the
     service-role key). Never invent facts: if the source does not state it, leave it null.
   - If you changed anything, re-run `npm run pipeline -- --out out/$RUN_DATE --run-date $RUN_DATE --stage score`
     then `--stage report`.
5. Post the digest: paste `out/$RUN_DATE/digest.md`, the count of messages sent
   (`messages.json` length), and any exceptions from `report.json.exceptions`.

## Never

- Compose new outreach text. Only the approved templates in `config/mail-templates.yaml`
  are sent, by the pipeline, not by you.
- Send email, call, negotiate, sign or pay anything yourself.
- Change `providers.yaml paid_enabled` or any secret.
- Open or fetch a listing URL from an `email_alert` source (`loopnet-alerts`, `crexi-alerts`).
  Those sites forbid automated access; review the alert email in `raw_documents` instead.
- Commit generated output (`out/` is ignored).
