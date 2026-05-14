begin;

update public.profiles p
set display_name = nullif(
  trim(
    coalesce(
      nullif(trim(u.raw_user_meta_data->>'name'), ''),
      nullif(trim(u.raw_user_meta_data->>'full_name'), ''),
      nullif(
        trim(
          concat_ws(
            ' ',
            nullif(trim(u.raw_user_meta_data->>'given_name'), ''),
            nullif(trim(u.raw_user_meta_data->>'family_name'), '')
          )
        ),
        ''
      ),
      nullif(trim(u.raw_user_meta_data->>'preferred_username'), ''),
      nullif(trim(u.raw_user_meta_data->>'user_name'), ''),
      split_part(coalesce(u.email, ''), '@', 1)
    )
  ),
  ''
)
from auth.users u
where u.id = p.user_id
  and (p.display_name is null or trim(p.display_name) = '');

commit;
