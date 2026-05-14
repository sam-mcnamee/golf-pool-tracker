begin;

alter table public.golfers add column if not exists r1_tee_at timestamptz null;
alter table public.golfers add column if not exists r2_tee_at timestamptz null;
alter table public.golfers add column if not exists r3_tee_at timestamptz null;
alter table public.golfers add column if not exists r4_tee_at timestamptz null;

commit;
