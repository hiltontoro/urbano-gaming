-- Migration: 0122_set_match_activity_classification_atomically_actor_provenance
-- Predictions A1 — Admin Authority Migration.
--
-- Drop-then-recreate, same precedent as every prior replacement. This
-- function has never had an actor parameter or any DB-layer authority
-- check before now (0083 accepted only p_match_id/p_activity_
-- classification) — it was reachable only as a test/fixture seam, with
-- no HTTP route. Three behavioral changes over 0083, everything else
-- byte-for-byte unchanged:
--
--   1. A new required p_actor_gaming_member_id parameter (no default —
--      this is not a compatibility question, since no HTTP caller has
--      ever existed for this function; actor identity is fundamental
--      information, not optional) and a new optional p_reason
--      (nullable, default null, per canonical reason policy — only
--      corrections/overrides/grants/revokes/bootstrap require one).
--   2. A CONSEQUENTIAL_FINALIZER authority check against authority_grants
--      (0114), placed immediately after the existence lock and before
--      the locked-state branch — so an unauthorized caller learns
--      nothing about the Match's classification-lock state.
--   3. Exactly one DECLARE_ACTIVITY_CLASSIFICATION admin_audit_events
--      row on every real mutation branch (first declaration and legal
--      pre-lock re-declaration) — never on the idempotent
--      already-locked-same-value return, so a replay never duplicates
--      audit history.
--
-- No change to the classification vocabulary, the evidence-lock rule,
-- or the ACTIVITY_CLASSIFICATION_LOCKED refusal — a locked mutation
-- attempt still fails exactly as before; FAILURE-outcome auditing for
-- that case remains explicitly deferred, per this Slice's own scope.

drop function if exists set_match_activity_classification_atomically(uuid, text);

create function set_match_activity_classification_atomically(
  p_match_id uuid,
  p_activity_classification text,
  p_actor_gaming_member_id uuid,
  p_reason text default null
)
returns table (
  match_id uuid,
  activity_classification text,
  locked boolean
)
language plpgsql
security invoker
set search_path = public
as $$
#variable_conflict use_column
declare
  v_current text;
  v_has_predictions boolean;
  v_has_results boolean;
  v_has_authority boolean;
begin
  if p_activity_classification not in ('TRAINING', 'CASUAL', 'RANKED', 'OFFICIAL') then
    raise exception 'INVALID_ACTIVITY_CLASSIFICATION: must be one of TRAINING, CASUAL, RANKED, OFFICIAL'
      using errcode = 'P0001';
  end if;

  select matches.activity_classification into v_current
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
    if v_current is distinct from p_activity_classification then
      raise exception 'ACTIVITY_CLASSIFICATION_LOCKED: this match already has Prediction or Result evidence and its classification cannot change'
        using errcode = 'P0001';
    end if;

    return query select p_match_id, v_current, true;
    return;
  end if;

  update matches
     set activity_classification = p_activity_classification
   where matches.match_id = p_match_id;

  insert into admin_audit_events (
    action_type, actor_kind, actor_id, authority_class_used,
    target_type, target_id, resulting_reference, outcome, reason
  )
  values (
    'DECLARE_ACTIVITY_CLASSIFICATION', 'GAMING_MEMBER', p_actor_gaming_member_id, 'CONSEQUENTIAL_FINALIZER',
    'matches', p_match_id,
    jsonb_build_object('table', 'matches', 'id', p_match_id),
    'SUCCESS', p_reason
  );

  return query select p_match_id, p_activity_classification, false;
end;
$$;
