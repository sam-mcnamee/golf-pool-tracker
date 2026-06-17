-- Align lock_at with first_tee_at for any Open tournament where ESPN has
-- already published tee times but lock_at is still the provisional 4 AM ET value.
update public.tournaments
set lock_at = first_tee_at
where status = 'Open'
  and first_tee_at is not null
  and lock_at < first_tee_at;
