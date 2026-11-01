-- Founder-approved representative-only account requirement for BEST_GROUP.
-- Data-preserving: no row update/delete, no association/consent manufactured, no ordinary Session change.
begin;
set local lock_timeout='5s';
set local statement_timeout='30s';
create or replace function community_voting_group_complete(p_entry_id uuid,p_photo_id uuid)
returns boolean language sql stable security invoker set search_path=public as $$
  select case when e.entry_kind<>'GROUP' then true
    when exists(select 1 from community_voting_category_rounds r where r.instance_id=e.instance_id and r.category_key='BEST_GROUP')
      then e.confirmed_binding_id is not null and exists(
        select 1 from community_voting_entry_consents c where c.entry_id=e.entry_id and c.photo_id=p_photo_id)
    else exists(select 1 from community_voting_entries m where m.group_entry_id=e.entry_id and m.entry_kind='GROUP_MEMBER')
      and not exists(select 1 from community_voting_entries m where m.group_entry_id=e.entry_id and m.entry_kind='GROUP_MEMBER'
        and (m.confirmed_binding_id is null or not exists(select 1 from community_voting_member_consents mc where mc.member_entry_id=m.entry_id and mc.photo_id=p_photo_id)))
    end from community_voting_entries e where e.entry_id=p_entry_id;
$$;

create or replace function start_community_voting_category_atomically(
  p_instance_id uuid,
  p_host_token text,
  p_operator_member_id uuid,
  p_prompt_text text
)
returns table (
  interaction_instance_id uuid,
  prompt_id uuid,
  state text,
  segment_ordinal integer,
  candidate_count integer,
  opened_at timestamptz,
  deadline_at timestamptz
)
language plpgsql
security invoker
set search_path = public
as $$
#variable_conflict use_column
declare
  v_session_id uuid;
  v_state text;
  v_category text;
  v_capabilities text[];
  v_prompt text;
  v_total integer;
  v_ready integer;
  v_labels jsonb;
  v_start record;
  v_rows integer;
  v_opened timestamptz;
begin
  select o.o_session_id, o.o_session_state into v_session_id, v_state
  from community_voting_authorize_operator(p_instance_id, p_host_token, p_operator_member_id, true) o;
  v_category := community_voting_require_category_round(p_instance_id);

  select sessions.declared_capabilities into v_capabilities from sessions where sessions.session_id = v_session_id;
  if v_capabilities is distinct from array['VOTING']::text[] then
    raise exception 'CV_CAPABILITY_SET_NOT_EXACTLY_VOTING: the declared capability set must be exactly VOTING'
      using errcode = 'P0001';
  end if;

  if exists (select 1 from interaction_instances ii where ii.session_id = v_session_id) then
    raise exception 'CV_ALREADY_OPENED: Voting has already opened for this category'
      using errcode = 'P0001';
  end if;

  if v_state <> 'LOBBY_LOCKED' then
    raise exception 'CV_SESSION_NOT_STARTABLE: the Session must be locked (LOBBY_LOCKED) before Voting can start'
      using errcode = 'P0001';
  end if;

  v_prompt := btrim(coalesce(p_prompt_text, ''));
  if v_prompt = '' or char_length(v_prompt) > 1000 then
    raise exception 'CV_INVALID_REQUEST: the prompt must be 1 to 1000 characters'
      using errcode = 'P0001';
  end if;

  if not community_voting_deadline_open(community_voting_round_deadline(p_instance_id), clock_timestamp()) then
    raise exception 'CV_SCHEDULE_REQUIRED: the category needs a configured closing time in the future before it can open'
      using errcode = 'P0001';
  end if;

  select count(*)::integer,
         (count(*) filter (
           where e.confirmed_binding_id is not null
             and (select m.m_state from community_voting_entry_media(e.entry_id) m) = 'APPROVED'
         ))::integer
    into v_total, v_ready
  from community_voting_entries e
  where e.instance_id = p_instance_id
    and e.entry_kind <> 'GROUP_MEMBER'
    and not exists (select 1 from community_voting_withdrawals w where w.entry_id = e.entry_id);

  if v_total < 2 or v_ready <> v_total then
    raise exception 'CV_PREPARATION_INCOMPLETE: every candidacy needs a confirmed association and an approved, consented photograph, and there must be at least two'
      using errcode = 'P0001';
  end if;

  -- Additional member accounts are optional; confirmed members still retain their self-vote exclusion.
  select jsonb_agg(to_jsonb(e.label) order by e.ordinal) into v_labels
  from community_voting_entries e
  where e.instance_id = p_instance_id
    and e.entry_kind <> 'GROUP_MEMBER'
    and not exists (select 1 from community_voting_withdrawals w where w.entry_id = e.entry_id);

  perform set_config('urbano.community_voting_start', v_session_id::text, true);
  perform set_config('urbano.community_voting_round_op', p_instance_id::text, true);

  select * into v_start
  from start_session_atomically(
    p_session_id => v_session_id,
    p_host_token => p_host_token,
    p_prompt_text => v_prompt,
    p_voting_source_type => 'HOST_AUTHORED',
    p_voting_candidates => v_labels
  );

  update voting_candidates
  set participant_id = b.participant_id
  from community_voting_entries e
  join community_voting_voter_bindings b on b.binding_id = e.confirmed_binding_id
  where e.instance_id = p_instance_id
    and e.entry_kind <> 'GROUP_MEMBER'
    and not exists (select 1 from community_voting_withdrawals w where w.entry_id = e.entry_id)
    and voting_candidates.interaction_instance_id = v_start.interaction_instance_id
    and voting_candidates.label = e.label;

  get diagnostics v_rows = row_count;
  if v_rows <> v_total then
    raise exception 'CV_STATE_INCONSISTENT: the materialized ballot does not match its preparation'
      using errcode = 'P0001';
  end if;

  update community_voting_entries
  set candidate_id = vc.candidate_id
  from voting_candidates vc
  where community_voting_entries.instance_id = p_instance_id
    and community_voting_entries.entry_kind <> 'GROUP_MEMBER'
    and not exists (select 1 from community_voting_withdrawals w where w.entry_id = community_voting_entries.entry_id)
    and vc.interaction_instance_id = v_start.interaction_instance_id
    and vc.label = community_voting_entries.label;

  get diagnostics v_rows = row_count;
  if v_rows <> v_total
     or exists (
       select 1 from voting_candidates vc
       where vc.interaction_instance_id = v_start.interaction_instance_id and vc.participant_id is null
     ) then
    raise exception 'CV_STATE_INCONSISTENT: the materialized ballot does not match its preparation'
      using errcode = 'P0001';
  end if;

  perform set_config('urbano.community_voting_start', '', true);
  perform set_config('urbano.community_voting_round_op', '', true);

  select ii.created_at into v_opened
  from interaction_instances ii
  where ii.interaction_instance_id = v_start.interaction_instance_id;

  perform community_voting_log_operator_action(
    p_instance_id, p_operator_member_id, 'OPEN_VOTING', null,
    jsonb_build_object('interactionInstanceId', v_start.interaction_instance_id, 'candidateCount', v_total, 'category', v_category)
  );

  return query
    select v_start.interaction_instance_id, v_start.prompt_id, v_start.state, v_start.segment_ordinal, v_total, v_opened,
           community_voting_round_deadline(p_instance_id);
end;
$$;

-- ---------------------------------------------------------------------------------------
-- The vote: the pilot's cast behind one more refusal, and NO location parameter
-- ---------------------------------------------------------------------------------------
--
-- The pilot's cast keeps every rule (Session lock first, verified identity re-checked on every cast, the intent and its replay, the deadline by
-- the database clock, a withdrawn contestant, the unchanged cast_vote_atomically with its own self-vote refusal for the contestant or a
-- representative). This gate adds what it could not know: an attributed MEMBER of a group cannot vote for that group either. The check reads the
-- member's confirmed association, which cannot change once voting has opened (the entries are frozen), so doing it before the delegate's locks is safe.
-- The coordinates the pilot's cast accepts are passed as NULL, always: a category round has no venue and the signature has no way to carry one.

commit;
