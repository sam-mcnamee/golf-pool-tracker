begin;

create table if not exists public.golfer_headshots (
  normalized_name text primary key,
  display_name text not null,
  headshot_url text not null,
  source text not null check (source in ('pgatour', 'livgolf', 'espn', 'placeholder')),
  pga_tour_player_id text null,
  espn_athlete_id text null,
  updated_at timestamptz not null default now()
);

create index if not exists golfer_headshots_espn_athlete_id_idx
  on public.golfer_headshots (espn_athlete_id)
  where espn_athlete_id is not null;

alter table public.golfer_headshots enable row level security;

drop policy if exists golfer_headshots_select_all on public.golfer_headshots;
create policy golfer_headshots_select_all
on public.golfer_headshots
for select
to public
using (true);

commit;
