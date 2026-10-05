-- CREATE_COMPETITION — adds p_public_code as an ADDITIVE overload
-- (UG-CR-GATE-081 Phase 3A; corrected by UG-CR-GATE-082 per
-- UG-CR-REV-053 #2 — expand/contract, not a hard cutover).
--
-- Postgres treats (schema, name, argument-types) as a function's
-- identity, so a trailing parameter is a genuinely new, distinct
-- overload — it does not require dropping the original 3-arg
-- create_competition_atomically(uuid, text, text) first, and this
-- migration no longer does so. The original 3-arg overload
-- (20260906044806_create_create_competition_atomically.sql) is left
-- completely untouched and still callable: its INSERT never mentions
-- public_code, so it now receives the column DEFAULT added in
-- 20261001180000_add_competition_public_codes.sql and continues to
-- satisfy the NOT NULL constraint with no code change of its own. This
-- is the additive ("expand") half of this gate's rollout design —
-- whichever of the currently-deployed app or this migrated schema
-- lands first, the 3-arg overload keeps working throughout. Removing
-- the legacy 3-arg overload ("contract") is deliberately deferred to a
-- later cleanup gate, once the new application is confirmed live;
-- __tests__/competitionsAuthorizationMatrix.contract.test.ts already
-- exercises the 3-arg shape directly and continues to pass unmodified
-- under this additive design.
--
-- Every other line in the new 4-arg overload below (authority check,
-- activity-key check) is unchanged from
-- 20260906044806_create_create_competition_atomically.sql.

create function create_competition_atomically(
  p_organizer_gaming_member_id uuid,
  p_name text,
  p_activity_key text,
  p_public_code text
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

  if p_public_code is null or length(trim(p_public_code)) = 0 then
    raise exception 'PUBLIC_CODE_REQUIRED: an opaque public code is required' using errcode = 'P0001';
  end if;

  insert into competitions (organizer_gaming_member_id, name, activity_key, state, public_code)
  values (p_organizer_gaming_member_id, p_name, p_activity_key, 'DRAFT', p_public_code)
  returning competitions.competition_id, competitions.created_at
  into v_competition_id, v_created_at;

  return query select v_competition_id, 'DRAFT'::text, v_created_at;
end;
$$;

revoke all on function create_competition_atomically(uuid, text, text, text) from public, anon, authenticated;
grant execute on function create_competition_atomically(uuid, text, text, text) to service_role;
