-- CREATE_COMPETITION. Requires the caller to hold active platform
-- OPERATIONAL authority (UG-CR-REV-026 condition 1) — that global
-- authority is used ONLY to gate this one bootstrap action; the
-- resulting competition's own organizer_gaming_member_id (set here to
-- the caller) is what every subsequent Competitions-scoped check reads
-- from, never a fresh authority_grants lookup. This is the one and
-- only place this domain reads authority_grants at all.
create or replace function create_competition_atomically(
  p_organizer_gaming_member_id uuid,
  p_name text,
  p_activity_key text
)
returns table (
  competition_id uuid,
  state text,
  created_at timestamptz
)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_has_authority boolean;
  v_competition_id uuid;
  v_created_at timestamptz;
begin
  select exists(
    select 1 from authority_grants
    where authority_grants.gaming_member_id = p_organizer_gaming_member_id
      and authority_grants.authority_class = 'OPERATIONAL'
      and authority_grants.revoked_at is null
  ) into v_has_authority;

  if not v_has_authority then
    raise exception 'OPERATIONAL_AUTHORITY_REQUIRED: creating a competition requires active platform OPERATIONAL authority'
      using errcode = 'P0001';
  end if;

  if p_activity_key <> 'SOCCER_5V5' then
    raise exception 'UNSUPPORTED_ACTIVITY_KEY: only SOCCER_5V5 is supported in Slice 001'
      using errcode = 'P0001';
  end if;

  insert into competitions (organizer_gaming_member_id, name, activity_key, state)
  values (p_organizer_gaming_member_id, p_name, p_activity_key, 'DRAFT')
  returning competitions.competition_id, competitions.created_at
  into v_competition_id, v_created_at;

  return query select v_competition_id, 'DRAFT'::text, v_created_at;
end;
$$;

revoke all on function create_competition_atomically(uuid, text, text) from public, anon, authenticated;
grant execute on function create_competition_atomically(uuid, text, text) to service_role;
