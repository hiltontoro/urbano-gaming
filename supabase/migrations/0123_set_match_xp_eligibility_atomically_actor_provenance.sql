-- Migration: 0123_set_match_xp_eligibility_atomically_actor_provenance
-- Predictions A1 — Admin Authority Migration.
--
-- Applies the identical change 0122 made to Activity Classification, to
-- Match XP Eligibility, for the same reasons and in the same order.
-- Three behavioral changes over 0102, everything else byte-for-byte
-- unchanged:
--
--   1. A new required p_actor_gaming_member_id parameter (no default —
--      no HTTP caller has ever existed for this function) and a new
--      optional p_reason (nullable, default null).
--   2. A CONSEQUENTIAL_FINALIZER authority check, placed identically to
--      0122's — after the existence lock, before the locked-state
--      branch.
--   3. Exactly one DECLARE_XP_ELIGIBILITY admin_audit_events row on
--      every real mutation branch only.
--
-- No change to the eligibility vocabulary, the evidence-lock rule, or
-- the XP_ELIGIBILITY_LOCKED refusal. This action remains structurally
-- and canonically distinct from Activity Classification — its own
-- audit action type, never merged — and remains distinct from Gaming
-- XP policy/activation, which this migration does not touch: no
-- gaming_xp_rules, gaming_category_participation_policy, or
-- gaming_xp_events row is inserted anywhere in this file.

drop function if exists set_match_xp_eligibility_atomically(uuid, boolean);

create function set_match_xp_eligibility_atomically(
  p_match_id uuid,
  p_xp_eligible boolean,
  p_actor_gaming_member_id uuid,
  p_reason text default null
)
returns table (
  match_id uuid,
  xp_eligible boolean,
  locked boolean
)
language plpgsql
security invoker
set search_path = public
as $$
#variable_conflict use_column
declare
  v_current boolean;
  v_has_predictions boolean;
  v_has_results boolean;
  v_has_authority boolean;
begin
  select matches.xp_eligible into v_current
  from matches
  where matches.match_id = p_match_id
  for update;

  if not found then
    raise exception 'MATCH_NOT_FOUND: no match exists for this match_id'
      using errcode = 'P0001';
  end if;

  select exists(
    select 1 from authority_grants
    where authority_grants.gaming_member_id = p_actor_gaming_member_id
      and authority_grants.authority_class = 'CONSEQUENTIAL_FINALIZER'
      and authority_grants.revoked_at is null
  ) into v_has_authority;

  if not v_has_authority then
    raise exception 'CONSEQUENTIAL_FINALIZER_AUTHORITY_REQUIRED: this action requires Consequential Finalizer authority'
      using errcode = 'P0001';
  end if;

  select exists(select 1 from predictions where predictions.match_id = p_match_id) into v_has_predictions;
  select exists(select 1 from match_results where match_results.match_id = p_match_id) into v_has_results;

  if v_has_predictions or v_has_results then
    if v_current is distinct from p_xp_eligible then
      raise exception 'XP_ELIGIBILITY_LOCKED: this match already has Prediction or Result evidence and its XP eligibility cannot change'
        using errcode = 'P0001';
    end if;

    return query select p_match_id, v_current, true;
    return;
  end if;

  update matches
     set xp_eligible = p_xp_eligible
   where matches.match_id = p_match_id;

  insert into admin_audit_events (
    action_type, actor_kind, actor_id, authority_class_used,
    target_type, target_id, resulting_reference, outcome, reason
  )
  values (
    'DECLARE_XP_ELIGIBILITY', 'GAMING_MEMBER', p_actor_gaming_member_id, 'CONSEQUENTIAL_FINALIZER',
    'matches', p_match_id,
    jsonb_build_object('table', 'matches', 'id', p_match_id),
    'SUCCESS', p_reason
  );

  return query select p_match_id, p_xp_eligible, false;
end;
$$;
