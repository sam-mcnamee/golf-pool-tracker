-- Supabase schema for 7-Tier Golf Pool Tracker
-- Apply in Supabase SQL editor (or via migrations) before deploying the app.

begin;

-- Extensions
create extension if not exists "pgcrypto";

-- Enums
do $$
begin
  if not exists (select 1 from pg_type where typname = 'tournament_status') then
    create type public.tournament_status as enum ('Upcoming', 'Open', 'Locked', 'Live', 'Complete');
  end if;
end $$;

-- Tables
create table if not exists public.tournaments (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  espn_event_id text not null,
  status public.tournament_status not null default 'Upcoming',
  open_at timestamptz not null,
  lock_at timestamptz not null,
  first_tee_at timestamptz null,
  cut_complete boolean not null default false,
  starts_at timestamptz null,
  ends_at timestamptz null,
  created_at timestamptz not null default now()
);

alter table public.tournaments add column if not exists actual_winning_score_rel_par integer null;

create unique index if not exists tournaments_espn_event_id_uidx
  on public.tournaments (espn_event_id);

create table if not exists public.golfers (
  id uuid primary key default gen_random_uuid(),
  tournament_id uuid not null references public.tournaments(id) on delete cascade,
  espn_athlete_id text not null,
  name text not null,
  country text null,
  total_score integer null,
  thru text null,
  status text null,
  is_cut boolean null,
  updated_at timestamptz not null default now()
);

create unique index if not exists golfers_tournament_athlete_uidx
  on public.golfers (tournament_id, espn_athlete_id);

create index if not exists golfers_tournament_id_idx
  on public.golfers (tournament_id);

-- Latest odds per tournament (scrapers upsert; merged row uses source = merged)
create table if not exists public.tournament_odds_latest (
  id uuid primary key default gen_random_uuid(),
  tournament_id uuid not null references public.tournaments(id) on delete cascade,
  golfer_id uuid null references public.golfers(id) on delete set null,
  golfer_name text not null,
  odds_american integer not null,
  source text not null,
  source_url text null,
  fetched_at timestamptz not null default now()
);

create unique index if not exists tournament_odds_latest_tid_gname_uidx
  on public.tournament_odds_latest (tournament_id, golfer_name);

create index if not exists tournament_odds_latest_tid_idx
  on public.tournament_odds_latest (tournament_id);

-- Admin-configured odds brackets (tier 1 = favorites)
create table if not exists public.tier_rules (
  tournament_id uuid not null references public.tournaments(id) on delete cascade,
  tier integer not null check (tier between 1 and 7),
  min_odds_american integer null,
  max_odds_american integer null,
  primary key (tournament_id, tier)
);

create index if not exists tier_rules_tournament_id_idx
  on public.tier_rules (tournament_id);

-- Admin manual tier bumps before freeze
create table if not exists public.tier_overrides (
  tournament_id uuid not null references public.tournaments(id) on delete cascade,
  golfer_id uuid not null references public.golfers(id) on delete cascade,
  tier integer not null check (tier between 1 and 7),
  primary key (tournament_id, golfer_id)
);

create index if not exists tier_overrides_tournament_id_idx
  on public.tier_overrides (tournament_id);

create table if not exists public.odds_snapshots (
  id uuid primary key default gen_random_uuid(),
  tournament_id uuid not null references public.tournaments(id) on delete cascade,
  source_url text null,
  raw_json jsonb not null,
  captured_at timestamptz not null default now()
);

create unique index if not exists odds_snapshots_tournament_uidx
  on public.odds_snapshots (tournament_id);

create table if not exists public.golfer_tiers (
  id uuid primary key default gen_random_uuid(),
  tournament_id uuid not null references public.tournaments(id) on delete cascade,
  snapshot_id uuid not null references public.odds_snapshots(id) on delete cascade,
  golfer_id uuid not null references public.golfers(id) on delete cascade,
  tier integer not null check (tier between 1 and 7),
  odds_text text null
);

create unique index if not exists golfer_tiers_tournament_golfer_uidx
  on public.golfer_tiers (tournament_id, golfer_id);

create index if not exists golfer_tiers_tournament_tier_idx
  on public.golfer_tiers (tournament_id, tier);

create table if not exists public.picks (
  id uuid primary key default gen_random_uuid(),
  tournament_id uuid not null references public.tournaments(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  tier integer not null check (tier between 1 and 7),
  golfer_tier_id uuid not null references public.golfer_tiers(id) on delete restrict,
  created_at timestamptz not null default now()
);

create unique index if not exists picks_tournament_user_tier_uidx
  on public.picks (tournament_id, user_id, tier);

create index if not exists picks_tournament_id_idx
  on public.picks (tournament_id);

create index if not exists picks_user_id_idx
  on public.picks (user_id);

create table if not exists public.tiebreakers (
  tournament_id uuid not null references public.tournaments(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  predicted_winning_score_rel_par integer not null,
  created_at timestamptz not null default now(),
  primary key (tournament_id, user_id)
);

create index if not exists tiebreakers_tournament_id_idx
  on public.tiebreakers (tournament_id);

create table if not exists public.profiles (
  user_id uuid primary key references auth.users(id) on delete cascade,
  display_name text null,
  is_admin boolean not null default false,
  created_at timestamptz not null default now()
);

alter table public.profiles add column if not exists is_admin boolean not null default false;

-- Updated_at trigger helper
create or replace function public.set_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists golfers_set_updated_at on public.golfers;
create trigger golfers_set_updated_at
before update on public.golfers
for each row execute function public.set_updated_at();

-- RLS
alter table public.tournaments enable row level security;
alter table public.golfers enable row level security;
alter table public.odds_snapshots enable row level security;
alter table public.golfer_tiers enable row level security;
alter table public.picks enable row level security;
alter table public.profiles enable row level security;
alter table public.tournament_odds_latest enable row level security;
alter table public.tier_rules enable row level security;
alter table public.tier_overrides enable row level security;
alter table public.tiebreakers enable row level security;

-- Tournaments: public read; no public writes (service role bypasses RLS automatically)
drop policy if exists tournaments_select_all on public.tournaments;
create policy tournaments_select_all
on public.tournaments
for select
to public
using (true);

-- Golfers / odds / tiers: public read; no public writes
drop policy if exists golfers_select_all on public.golfers;
create policy golfers_select_all
on public.golfers
for select
to public
using (true);

drop policy if exists odds_snapshots_select_all on public.odds_snapshots;
create policy odds_snapshots_select_all
on public.odds_snapshots
for select
to public
using (true);

drop policy if exists golfer_tiers_select_all on public.golfer_tiers;
create policy golfer_tiers_select_all
on public.golfer_tiers
for select
to public
using (true);

drop policy if exists tournament_odds_latest_select_all on public.tournament_odds_latest;
create policy tournament_odds_latest_select_all
on public.tournament_odds_latest
for select
to public
using (true);

drop policy if exists tier_rules_select_all on public.tier_rules;
create policy tier_rules_select_all
on public.tier_rules
for select
to public
using (true);

drop policy if exists tier_rules_insert_admin on public.tier_rules;
create policy tier_rules_insert_admin
on public.tier_rules
for insert
to authenticated
with check (
  exists (
    select 1 from public.profiles p
    where p.user_id = auth.uid() and p.is_admin is true
  )
);

drop policy if exists tier_rules_update_admin on public.tier_rules;
create policy tier_rules_update_admin
on public.tier_rules
for update
to authenticated
using (
  exists (
    select 1 from public.profiles p
    where p.user_id = auth.uid() and p.is_admin is true
  )
)
with check (
  exists (
    select 1 from public.profiles p
    where p.user_id = auth.uid() and p.is_admin is true
  )
);

drop policy if exists tier_rules_delete_admin on public.tier_rules;
create policy tier_rules_delete_admin
on public.tier_rules
for delete
to authenticated
using (
  exists (
    select 1 from public.profiles p
    where p.user_id = auth.uid() and p.is_admin is true
  )
);

drop policy if exists tier_overrides_select_all on public.tier_overrides;
create policy tier_overrides_select_all
on public.tier_overrides
for select
to public
using (true);

drop policy if exists tier_overrides_insert_admin on public.tier_overrides;
create policy tier_overrides_insert_admin
on public.tier_overrides
for insert
to authenticated
with check (
  exists (
    select 1 from public.profiles p
    where p.user_id = auth.uid() and p.is_admin is true
  )
);

drop policy if exists tier_overrides_update_admin on public.tier_overrides;
create policy tier_overrides_update_admin
on public.tier_overrides
for update
to authenticated
using (
  exists (
    select 1 from public.profiles p
    where p.user_id = auth.uid() and p.is_admin is true
  )
)
with check (
  exists (
    select 1 from public.profiles p
    where p.user_id = auth.uid() and p.is_admin is true
  )
);

drop policy if exists tier_overrides_delete_admin on public.tier_overrides;
create policy tier_overrides_delete_admin
on public.tier_overrides
for delete
to authenticated
using (
  exists (
    select 1 from public.profiles p
    where p.user_id = auth.uid() and p.is_admin is true
  )
);

-- Profiles: authenticated can read all profiles; users can upsert their own.
drop policy if exists profiles_select_all on public.profiles;
create policy profiles_select_all
on public.profiles
for select
to authenticated
using (true);

drop policy if exists profiles_insert_own on public.profiles;
create policy profiles_insert_own
on public.profiles
for insert
to authenticated
with check (auth.uid() = user_id);

drop policy if exists profiles_update_own on public.profiles;
create policy profiles_update_own
on public.profiles
for update
to authenticated
using (auth.uid() = user_id)
with check (auth.uid() = user_id);

-- Picks: visibility and submission rules
-- Select: always your own; others only after tournament is Locked/Live/Complete.
drop policy if exists picks_select_visibility on public.picks;
create policy picks_select_visibility
on public.picks
for select
to authenticated
using (
  auth.uid() = user_id
  or exists (
    select 1
    from public.tournaments t
    where t.id = picks.tournament_id
      and t.status in ('Locked', 'Live', 'Complete')
  )
);

-- Insert: only yourself, only when tournament is Open.
drop policy if exists picks_insert_own_when_open on public.picks;
create policy picks_insert_own_when_open
on public.picks
for insert
to authenticated
with check (
  auth.uid() = user_id
  and exists (
    select 1
    from public.tournaments t
    where t.id = picks.tournament_id
      and t.status = 'Open'
  )
);

-- Update: only yourself, only when tournament is Open.
drop policy if exists picks_update_own_when_open on public.picks;
create policy picks_update_own_when_open
on public.picks
for update
to authenticated
using (
  auth.uid() = user_id
  and exists (
    select 1
    from public.tournaments t
    where t.id = picks.tournament_id
      and t.status = 'Open'
  )
)
with check (
  auth.uid() = user_id
  and exists (
    select 1
    from public.tournaments t
    where t.id = picks.tournament_id
      and t.status = 'Open'
  )
);

-- Delete: only yourself, only when tournament is Open.
drop policy if exists picks_delete_own_when_open on public.picks;
create policy picks_delete_own_when_open
on public.picks
for delete
to authenticated
using (
  auth.uid() = user_id
  and exists (
    select 1
    from public.tournaments t
    where t.id = picks.tournament_id
      and t.status = 'Open'
  )
);

-- Tiebreakers: same visibility as picks (own always; others after lock).
drop policy if exists tiebreakers_select_visibility on public.tiebreakers;
create policy tiebreakers_select_visibility
on public.tiebreakers
for select
to authenticated
using (
  auth.uid() = user_id
  or exists (
    select 1
    from public.tournaments t
    where t.id = tiebreakers.tournament_id
      and t.status in ('Locked', 'Live', 'Complete')
  )
);

drop policy if exists tiebreakers_insert_own_when_open on public.tiebreakers;
create policy tiebreakers_insert_own_when_open
on public.tiebreakers
for insert
to authenticated
with check (
  auth.uid() = user_id
  and exists (
    select 1
    from public.tournaments t
    where t.id = tiebreakers.tournament_id
      and t.status = 'Open'
  )
);

drop policy if exists tiebreakers_update_own_when_open on public.tiebreakers;
create policy tiebreakers_update_own_when_open
on public.tiebreakers
for update
to authenticated
using (
  auth.uid() = user_id
  and exists (
    select 1
    from public.tournaments t
    where t.id = tiebreakers.tournament_id
      and t.status = 'Open'
  )
)
with check (
  auth.uid() = user_id
  and exists (
    select 1
    from public.tournaments t
    where t.id = tiebreakers.tournament_id
      and t.status = 'Open'
  )
);

-- RPC: submit 7 picks + tiebreaker transactionally (invoker; respects RLS)
create or replace function public.submit_picks(
  p_tournament_id uuid,
  p_golfer_tier_ids uuid[],
  p_predicted_winning_score_rel_par integer
)
returns void
language plpgsql
security invoker
as $$
declare
  v_uid uuid;
  v_open boolean;
  v_count int;
begin
  v_uid := auth.uid();
  if v_uid is null then
    raise exception 'not authenticated';
  end if;

  select (t.status = 'Open')
    into v_open
  from public.tournaments t
  where t.id = p_tournament_id;

  if v_open is distinct from true then
    raise exception 'tournament not open';
  end if;

  if p_golfer_tier_ids is null or array_length(p_golfer_tier_ids, 1) <> 7 then
    raise exception 'must provide exactly 7 golfer_tier_ids';
  end if;

  if p_predicted_winning_score_rel_par is null then
    raise exception 'predicted winning score (relative to par) is required';
  end if;

  -- Ensure all selected tier rows belong to the tournament and cover 7 distinct tiers.
  select count(distinct gt.tier)
    into v_count
  from public.golfer_tiers gt
  where gt.tournament_id = p_tournament_id
    and gt.id = any(p_golfer_tier_ids);

  if v_count <> 7 then
    raise exception 'must select exactly one golfer per tier';
  end if;

  -- Upsert picks (one row per tier)
  insert into public.picks (tournament_id, user_id, tier, golfer_tier_id)
  select
    p_tournament_id,
    v_uid,
    gt.tier,
    gt.id
  from public.golfer_tiers gt
  where gt.id = any(p_golfer_tier_ids)
  on conflict (tournament_id, user_id, tier)
  do update set golfer_tier_id = excluded.golfer_tier_id, created_at = now();

  insert into public.tiebreakers (tournament_id, user_id, predicted_winning_score_rel_par)
  values (p_tournament_id, v_uid, p_predicted_winning_score_rel_par)
  on conflict (tournament_id, user_id)
  do update set
    predicted_winning_score_rel_par = excluded.predicted_winning_score_rel_par,
    created_at = now();
end;
$$;

-- Leaderboard view (computed from picks + golfer scores). RLS on picks determines visibility.
create or replace view public.leaderboard_v1 as
with picked as (
  select
    p.tournament_id,
    p.user_id,
    p.tier,
    g.total_score,
    g.is_cut
  from public.picks p
  join public.golfer_tiers gt on gt.id = p.golfer_tier_id
  join public.golfers g on g.id = gt.golfer_id
),
agg as (
  select
    tournament_id,
    user_id,
    count(*) filter (where is_cut is true) as made_cut_count,
    array_agg(total_score order by total_score asc nulls last) as scores_sorted
  from picked
  group by tournament_id, user_id
)
select
  a.tournament_id,
  a.user_id,
  a.made_cut_count,
  (
    select sum(u.x)
    from (
      select x
      from unnest(a.scores_sorted) as u(x)
      where x is not null
      order by x asc
      limit 4
    ) u
  ) as best4_score_sum,
  (t.cut_complete and a.made_cut_count < 4) as is_mc,
  t.cut_complete
from agg a
join public.tournaments t on t.id = a.tournament_id;

commit;

