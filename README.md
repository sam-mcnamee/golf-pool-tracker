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

### Admin in the web app (`/admin`)
- After you sign in, an **Admin** link appears in the header only if your user has `profiles.is_admin = true` in Supabase.
- Grant yourself access once (Supabase SQL editor), using the email you use with Google sign-in:

```sql
update public.profiles
set is_admin = true
where user_id = (select id from auth.users where email = 'you@example.com' limit 1);
```

- Then open **`/admin`** (or use the header link). Odds, tier rules, overrides, and freeze live there.
- Optional legacy JSON flow: **`/admin/<ADMIN_SECRET>`** if `ADMIN_SECRET` is set in env (separate from `is_admin`).
