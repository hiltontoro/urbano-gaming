-- CANCEL_INCOMPLETE_COMPETITION — refuse organizer actions once a host's access has been revoked
-- (UG-CR-GATE-088, Become a Host). Adds exactly one statement,
--   perform assert_competition_not_host_revoked(p_competition_id);
-- directly after this function's existing organizer-ownership check and before
-- any state check or write. Every other line is the definition live after
-- 20261005090210, unchanged. The helper does nothing for a competition that is
-- not bound to a host capability (every internally created competition), so
-- existing OPERATIONAL behavior is unaffected, and it is keyed on the
-- competition id, never on the caller, so it cannot be bypassed by the actor
-- argument. The competition-scope advisory lock is already held at this point,
-- which revoke_host_capability_atomically also takes, so a revocation and an
-- in-flight organizer mutation serialize.
--

CREATE OR REPLACE FUNCTION public.cancel_incomplete_competition_atomically(p_competition_id uuid, p_organizer_gaming_member_id uuid, p_reason text)
 RETURNS TABLE(competition_id uuid, state text, cancelled_reason text, already_cancelled boolean)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_organizer_id uuid;
  v_state text;
  v_cancelled_reason text;
  v_cancelled_at timestamptz;
begin
  if p_reason is null or length(trim(p_reason)) = 0 then
    raise exception 'REASON_REQUIRED: cancelling a competition requires a reason' using errcode = 'P0001';
  end if;

  perform pg_advisory_xact_lock(hashtext('competition_scope:' || p_competition_id::text));

  select competitions.organizer_gaming_member_id, competitions.state, competitions.cancelled_reason
    into v_organizer_id, v_state, v_cancelled_reason
    from competitions
   where competitions.competition_id = p_competition_id
   for update;

  if v_organizer_id is null then
    raise exception 'COMPETITION_NOT_FOUND: no such competition exists' using errcode = 'P0001';
  end if;

  if v_organizer_id <> p_organizer_gaming_member_id then
    raise exception 'COMPETITION_ACCESS_DENIED: only this competition''s own organizer may cancel it'
      using errcode = 'P0001';
  end if;
  perform assert_competition_not_host_revoked(p_competition_id);

  if v_state = 'CANCELLED_WITHOUT_CHAMPION' then
    return query select p_competition_id, v_state, v_cancelled_reason, true;
    return;
  end if;

  if v_state not in ('DRAFT', 'TEAM_REGISTRATION_OPEN', 'READY_TO_PUBLISH') then
    raise exception 'COMPETITION_NOT_CANCELLABLE: only a DRAFT, TEAM_REGISTRATION_OPEN, or READY_TO_PUBLISH competition may be cancelled this way'
      using errcode = 'P0001';
  end if;

  v_cancelled_at := now();

  update competitions
     set state = 'CANCELLED_WITHOUT_CHAMPION',
         cancelled_reason = p_reason,
         cancelled_by_gaming_member_id = p_organizer_gaming_member_id,
         cancelled_at = v_cancelled_at
   where competitions.competition_id = p_competition_id;

  insert into admin_audit_events (
    action_type, actor_kind, actor_id, authority_class_used,
    target_type, target_id, occurred_at, previous_reference, resulting_reference, outcome, reason
  )
  values (
    'CANCEL_INCOMPLETE_COMPETITION', 'GAMING_MEMBER', p_organizer_gaming_member_id, null,
    'competitions', p_competition_id, v_cancelled_at,
    jsonb_build_object('table', 'competitions', 'id', p_competition_id, 'state', v_state),
    jsonb_build_object('table', 'competitions', 'id', p_competition_id, 'state', 'CANCELLED_WITHOUT_CHAMPION'),
    'SUCCESS', p_reason
  );

  return query select p_competition_id, 'CANCELLED_WITHOUT_CHAMPION'::text, p_reason, false;
end;
$function$;

revoke all on function cancel_incomplete_competition_atomically(uuid,uuid,text) from public, anon, authenticated;
grant execute on function cancel_incomplete_competition_atomically(uuid,uuid,text) to service_role;
