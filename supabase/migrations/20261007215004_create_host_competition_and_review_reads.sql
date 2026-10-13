-- Become a Host (UG-CR-GATE-088) — create the authorized pilot, and the two read functions.
--
-- CREATE consumes the host's single AVAILABLE capability and creates the
-- competition in ONE transaction. Any failure rolls both back, so a failed
-- creation never consumes the capability; the capability row is locked
-- (host_scope advisory lock, then FOR UPDATE), so concurrent attempts serialize
-- and the loser sees CONSUMED. The unique constraints on
-- competition_host_capabilities (one capability per application, one per
-- competition) are a second, structural barrier to a second competition.
--
-- The competition is organized by the host: competitions.organizer_gaming_member_id
-- is the host, so every existing organizer function's ownership check applies to
-- it unchanged, and applies to no other competition.

create function create_host_competition_atomically(
  p_host_gaming_member_id uuid,
  p_name text,
  p_activity_key text,
  p_public_code text
)
returns table (competition_id uuid, state text, created_at timestamptz)
language plpgsql
set search_path = public
as $$
declare
  v_name text := btrim(coalesce(p_name, ''));
  v_capability_id uuid;
  v_capability_state text;
  v_competition_id uuid;
  v_created_at timestamptz;
  v_now timestamptz;
begin
  if length(v_name) not between 3 and 80 then
    raise exception 'INVALID_HOST_COMPETITION: name' using errcode = 'P0001';
  end if;

  if p_activity_key is distinct from 'SOCCER_5V5' then
    raise exception 'UNSUPPORTED_ACTIVITY_KEY: only SOCCER_5V5 is supported in Slice 001' using errcode = 'P0001';
  end if;

  if p_public_code is null or length(btrim(p_public_code)) = 0 then
    raise exception 'PUBLIC_CODE_REQUIRED: an opaque public code is required' using errcode = 'P0001';
  end if;

  perform pg_advisory_xact_lock(hashtext('host_scope:' || p_host_gaming_member_id::text));

  select c.host_capability_id, c.state into v_capability_id, v_capability_state
    from competition_host_capabilities c
   where c.gaming_member_id = p_host_gaming_member_id
   order by c.granted_at desc
   limit 1
   for update;

  if v_capability_id is null then
    raise exception 'HOST_CAPABILITY_REQUIRED: an approved host application is required to create a pilot competition'
      using errcode = 'P0001';
  end if;
  if v_capability_state = 'REVOKED' then
    raise exception 'HOST_CAPABILITY_REVOKED: your hosting access has been revoked' using errcode = 'P0001';
  end if;
  if v_capability_state = 'CONSUMED' then
    raise exception 'HOST_CAPABILITY_ALREADY_CONSUMED: your approved pilot competition has already been created' using errcode = 'P0001';
  end if;

  v_now := now();

  insert into competitions (organizer_gaming_member_id, name, activity_key, state, public_code)
  values (p_host_gaming_member_id, v_name, p_activity_key, 'DRAFT', p_public_code)
  returning competitions.competition_id, competitions.created_at
  into v_competition_id, v_created_at;

  update competition_host_capabilities c
     set state = 'CONSUMED', competition_id = v_competition_id, consumed_at = v_now
   where c.host_capability_id = v_capability_id;

  insert into admin_audit_events (
    action_type, actor_kind, actor_id, authority_class_used,
    target_type, target_id, occurred_at, previous_reference, resulting_reference, outcome, reason
  )
  values (
    'HOST_CAPABILITY_CONSUMED', 'GAMING_MEMBER', p_host_gaming_member_id, null,
    'competition_host_capabilities', v_capability_id, v_now,
    jsonb_build_object('table', 'competition_host_capabilities', 'id', v_capability_id, 'state', 'AVAILABLE'),
    jsonb_build_object('table', 'competitions', 'id', v_competition_id, 'state', 'DRAFT'),
    'SUCCESS', null
  );

  return query select v_competition_id, 'DRAFT'::text, v_created_at;
end;
$$;

-- ---------------------------------------------------------------------------
-- The applicant's own status: their live application if there is one, otherwise
-- their most recent. The internal decision reason is never returned here, and no
-- member id is returned at all.
-- ---------------------------------------------------------------------------
create function get_host_status(p_gaming_member_id uuid)
returns table (
  public_code text,
  state text,
  venue_name text,
  city_area text,
  playing_fields integer,
  venue_description text,
  expected_window text,
  expected_team_count integer,
  submitted_at timestamptz,
  decided_at timestamptz,
  withdrawn_at timestamptz,
  capability_state text,
  competition_name text,
  competition_public_code text,
  competition_state text
)
language sql
stable
set search_path = public
as $$
  select a.public_code, a.state, a.venue_name, a.city_area, a.playing_fields, a.venue_description,
         a.expected_window, a.expected_team_count, a.submitted_at, a.decided_at, a.withdrawn_at,
         cap.state, comp.name, comp.public_code, comp.state
    from competition_host_applications a
    left join competition_host_capabilities cap on cap.host_application_id = a.host_application_id
    left join competitions comp on comp.competition_id = cap.competition_id
   where a.gaming_member_id = p_gaming_member_id
   order by (a.state in ('PENDING', 'APPROVED')) desc, a.submitted_at desc
   limit 1;
$$;

-- ---------------------------------------------------------------------------
-- Review listing — PRODUCT_GOVERNANCE only, enforced here in the database.
-- p_view:
--   'PENDING' — applications under review, oldest first (capped at 200).
--   'ACTIVE'  — approved applications whose hosting access is still live (AVAILABLE or
--               CONSUMED capability), newest first, NOT capped: it is bounded by the
--               one-live-application-per-member rule, and it is the list the reviewer
--               revokes from, so it must never silently omit a live host.
--   'HISTORY' — decisions that are no longer active (rejected, or approved and since
--               revoked), newest first (capped at 200). Withdrawn applications are not
--               part of the review surface, so a member cannot crowd the list by
--               submitting and withdrawing.
-- Names and application text only: no member or application identifiers are returned,
-- only the opaque application code.
create function list_host_applications_for_review(
  p_reviewer_gaming_member_id uuid,
  p_view text
)
returns table (
  public_code text,
  state text,
  applicant_display_name text,
  venue_name text,
  city_area text,
  playing_fields integer,
  venue_description text,
  expected_window text,
  expected_team_count integer,
  submitted_at timestamptz,
  decided_at timestamptz,
  decided_by_display_name text,
  decision_reason text,
  withdrawn_at timestamptz,
  capability_state text,
  capability_granted_at timestamptz,
  capability_consumed_at timestamptz,
  capability_revoked_at timestamptz,
  capability_revoke_reason text,
  competition_name text,
  competition_state text
)
language plpgsql
stable
set search_path = public
as $$
begin
  if p_view is null or p_view not in ('PENDING', 'ACTIVE', 'HISTORY') then
    raise exception 'INVALID_HOST_REVIEW_VIEW: view must be PENDING, ACTIVE or HISTORY' using errcode = 'P0001';
  end if;

  if not exists (
    select 1 from authority_grants g
    where g.gaming_member_id = p_reviewer_gaming_member_id
      and g.authority_class = 'PRODUCT_GOVERNANCE' and g.revoked_at is null
  ) then
    raise exception 'GOVERNANCE_AUTHORITY_REQUIRED: only an active Product Governance reviewer may review host applications'
      using errcode = 'P0001';
  end if;

  return query
  select a.public_code, a.state, applicant.display_name, a.venue_name, a.city_area, a.playing_fields,
         a.venue_description, a.expected_window, a.expected_team_count, a.submitted_at, a.decided_at,
         reviewer.display_name, a.decision_reason, a.withdrawn_at,
         cap.state, cap.granted_at, cap.consumed_at, cap.revoked_at, cap.revoke_reason,
         comp.name, comp.state
    from competition_host_applications a
    join gaming_members applicant on applicant.gaming_member_id = a.gaming_member_id
    left join gaming_members reviewer on reviewer.gaming_member_id = a.decided_by_gaming_member_id
    left join competition_host_capabilities cap on cap.host_application_id = a.host_application_id
    left join competitions comp on comp.competition_id = cap.competition_id
   where (p_view = 'PENDING' and a.state = 'PENDING')
      or (p_view = 'ACTIVE' and a.state = 'APPROVED' and cap.state in ('AVAILABLE', 'CONSUMED'))
      or (p_view = 'HISTORY' and (a.state = 'REJECTED' or (a.state = 'APPROVED' and cap.state = 'REVOKED')))
   order by case when p_view = 'PENDING' then a.submitted_at end asc,
            case when p_view = 'ACTIVE' then cap.granted_at end desc,
            case when p_view = 'HISTORY' then coalesce(cap.revoked_at, a.decided_at) end desc
   limit (case when p_view = 'ACTIVE' then 100000 else 200 end);
end;
$$;

revoke all on function create_host_competition_atomically(uuid, text, text, text) from public, anon, authenticated;
revoke all on function get_host_status(uuid) from public, anon, authenticated;
revoke all on function list_host_applications_for_review(uuid, text) from public, anon, authenticated;

grant execute on function create_host_competition_atomically(uuid, text, text, text) to service_role;
grant execute on function get_host_status(uuid) to service_role;
grant execute on function list_host_applications_for_review(uuid, text) to service_role;
