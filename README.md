## 7-Tier Golf Pool Tracker

### Setup
- **Supabase**
  - Run the SQL in [`supabase/schema.sql`](supabase/schema.sql) in the Supabase SQL editor.
  - Enable Email OTP / Magic Link auth in Supabase Auth settings.

- **Env**
  - Copy `.env.example` to `.env.local` and fill in values.

- **Install + run**
  - This repo includes `package.json`, but your environment must have a JS package manager.
  - With `npm` installed:

```bash
npm install
npm run dev
```

### Scheduled golf odds (GitHub Actions)
- Workflow [`.github/workflows/weekly-odds.yml`](.github/workflows/weekly-odds.yml) runs **three times every Monday** (UTC times chosen for **1:00, 4:00, and 12:00 Pacific during daylight saving**, PDT) and executes `python scraper/run_odds_pipeline.py` (ESPN field sync, then golfodds.com and DK Network scrapers, then a merge pass that keeps the best—lowest—American odds per player). There is no conditional “skip if previous succeeded”; each slot is a full run so a bad 1am run can recover at 4am or noon. See the workflow file comments for PST (winter) offset.
- Configure repository secrets: `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY`.
- Locally: `pip install -r scraper/requirements.txt`, then from the repo root run `python scraper/run_odds_pipeline.py`.

### Admin tier locking
- Visit `/admin/<ADMIN_SECRET>`.\n- Paste a URL that returns JSON, or paste JSON directly.\n\nExpected JSON shape:\n\n```json\n{\n  \"tournament\": {\n    \"name\": \"THE PLAYERS Championship\",\n    \"espn_event_id\": \"401811937\",\n    \"open_at\": \"2026-04-20T12:00:00.000Z\",\n    \"lock_at\": \"2026-04-23T11:00:00.000Z\",\n    \"first_tee_at\": \"2026-04-23T12:00:00.000Z\"\n  },\n  \"golfers\": [\n    { \"name\": \"Scottie Scheffler\", \"espn_athlete_id\": \"39974\", \"odds_text\": \"+550\" }\n  ]\n}\n```\n\nIf you don’t provide explicit `tier` values, tiers are auto-assigned by sorting on `odds_text/odds` and chunking into 7 buckets.\n+
