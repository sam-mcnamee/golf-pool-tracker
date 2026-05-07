begin;

create table if not exists public.sync_health (
  tournament_id uuid primary key references public.tournaments(id) on delete cascade,
  espn_event_id text null,
  last_run_at timestamptz null,
  last_success_at timestamptz null,
  last_error text null,
  golfers_updated_count integer not null default 0,
  total_from_detail_count integer not null default 0,
  total_from_fallback_count integer not null default 0,
  anomalies jsonb not null default '[]'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists sync_health_last_success_at_idx
  on public.sync_health (last_success_at desc);

drop trigger if exists sync_health_set_updated_at on public.sync_health;
create trigger sync_health_set_updated_at
before update on public.sync_health
for each row execute function public.set_updated_at();

alter table public.sync_health enable row level security;

drop policy if exists sync_health_select_all on public.sync_health;
create policy sync_health_select_all
on public.sync_health
for select
to public
using (true);

commit;

