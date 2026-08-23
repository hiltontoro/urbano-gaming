-- Migration: 0124_redeem_prize_qualification_atomically_authority_audit
-- Predictions A1 — Admin Authority Migration.
--
-- Drop-then-recreate. Three behavioral changes over 0066, everything
-- else byte-for-byte unchanged:
--
--   1. A new optional p_reason parameter (nullable, default null — this
--      one DOES have an existing HTTP caller, unlike Activity
--      Classification/XP Eligibility, so the default preserves
--      signature compatibility for any caller that omits it, matching
--      finalize_match_result_atomically's own precedent from 0120).
--   2. A CONSEQUENTIAL_FINALIZER authority check against
--      p_redeemed_by_gaming_member_id (already an existing parameter,
--      previously accepted and persisted but never authority-checked),
--      placed immediately after the existence lock and before the
--      already-redeemed/superseded branches — so an unauthorized
--      caller learns nothing about this qualification's state.
--   3. Exactly one CONFIRM_PRIZE_REDEMPTION admin_audit_events row on
--      the real-redemption branch only — never on the idempotent
--      already-redeemed return, so a replay never duplicates audit
--      history.
--
-- redeemed_at/redeemed_by_gaming_member_id on prize_qualifications
-- remain the domain-authoritative provenance, unchanged; the audit
-- event complements rather than replaces them, mirroring the same
-- domain-column-plus-ledger split already proven by Result
-- finalization/correction.

drop function if exists redeem_prize_qualification_atomically(uuid, uuid);

create function redeem_prize_qualification_atomically(
  p_prize_qualification_id uuid,
  p_redeemed_by_gaming_member_id uuid,
  p_reason text default null
)
returns table (
  prize_qualification_id uuid,
  redeemed_at timestamptz,
  already_redeemed boolean
)
language plpgsql
security invoker
set search_path = public
as $$
#variable_conflict use_column
declare
  v_existing_redeemed_at timestamptz;
  v_existing_superseded_at timestamptz;
  v_new_redeemed_at timestamptz;
  v_has_authority boolean;
begin
  select prize_qualifications.redeemed_at, prize_qualifications.superseded_at
    into v_existing_redeemed_at, v_existing_superseded_at
  from prize_qualifications
  where prize_qualifications.prize_qualification_id = p_prize_qualification_id
  for update;

  if not found then
    raise exception 'PRIZE_QUALIFICATION_NOT_FOUND: no qualification exists for this id'
      using errcode = 'P0001';
  end if;

  select exists(
    select 1 from authority_grants
    where authority_grants.gaming_member_id = p_redeemed_by_gaming_member_id
      and authority_grants.authority_class = 'CONSEQUENTIAL_FINALIZER'
      and authority_grants.revoked_at is null
  ) into v_has_authority;

  if not v_has_authority then
    raise exception 'CONSEQUENTIAL_FINALIZER_AUTHORITY_REQUIRED: this action requires Consequential Finalizer authority'
      using errcode = 'P0001';
  end if;

  if v_existing_redeemed_at is not null then
    return query select p_prize_qualification_id, v_existing_redeemed_at, true;
    return;
  end if;

  if v_existing_superseded_at is not null then
    raise exception 'QUALIFICATION_SUPERSEDED: this qualification is no longer supported by the current result'
      using errcode = 'P0001';
  end if;

  v_new_redeemed_at := now();

  update prize_qualifications
     set redeemed_at = v_new_redeemed_at,
         redeemed_by_gaming_member_id = p_redeemed_by_gaming_member_id
   where prize_qualifications.prize_qualification_id = p_prize_qualification_id;

  insert into admin_audit_events (
    action_type, actor_kind, actor_id, authority_class_used,
    target_type, target_id, resulting_reference, outcome, reason
  )
  values (
    'CONFIRM_PRIZE_REDEMPTION', 'GAMING_MEMBER', p_redeemed_by_gaming_member_id, 'CONSEQUENTIAL_FINALIZER',
    'prize_qualifications', p_prize_qualification_id,
    jsonb_build_object('table', 'prize_qualifications', 'id', p_prize_qualification_id),
    'SUCCESS', p_reason
  );

  return query select p_prize_qualification_id, v_new_redeemed_at, false;
end;
$$;
