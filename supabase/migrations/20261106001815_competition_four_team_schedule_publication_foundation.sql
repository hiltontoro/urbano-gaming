-- UG-CR-GATE-SSS-025 - Atomic schedule publication (backend foundation).
--
-- WHAT THIS ADDS. One append-only table (competition_schedule_publications: the resolution of a publication), one service-role operation
-- (publish_competition_schedule_atomically) that publishes a frozen, drawn, four-team competition from its permanent draw and ONE exact CURRENT schedule proposal, and the
-- internal helpers that operation and the resolution need. It also replaces ONE existing function - the legacy manual publication - with a guarded copy.
--
-- WHAT A PUBLICATION IS. Inside one transaction, under the competition's own advisory lock: the competition is loaded and locked; the caller must be its own organizer (exact,
-- null-safe) and not a revoked host; the proposal is resolved by competition and exact digest; an exact replay by the still-authorized organizer is answered from the record
-- before any mutable lifecycle check; otherwise the competition must be READY_TO_PUBLISH with no published instant and no fixture, with a consistent four-team freeze, the one
-- permanent draw (whose evidence must reproduce itself) and no plan change awaiting the captains; the proposal must be the LATEST sequence and CURRENT (its plan revision still
-- the current one and its draw digest still the draw's); its own evidence and digest must reproduce; every placement is judged again by the very same evaluator, at the
-- publication instant, which also requires all three kickoffs to be strictly in the future at the accepted database clock. Then exactly three fixtures are created - the
-- semifinals from the teams of draw positions one and two, and three and four, at the proposal's UTC starts, and the final with unresolved slots and the two semifinals as its
-- sources - one resolution is recorded, and the competition becomes PUBLISHED at the very same database instant. Any failure rolls all of it back.
--
-- WHAT A CLIENT CAN SEND is one digest. Everything else - the teams, the pairing, the instants, the pitches, the venue, the zone, the format, the draw, the plan revision, the
-- fixtures and the actor - is derived from the freeze, the draw, the proposal, the plan, the format registry and the verified caller.
--
-- THE RESOLUTION is permanent: update, delete and truncate are refused by triggers; row-level security is on with no policy and every direct privilege is revoked from every
-- role, the server role included; it is verified at COMMIT against the proposal, the draw, the competition and the three fixtures it names, and its digest is the digest of
-- all of it (version 1: URBANO-COMPETITION-SCHEDULE-PUBLICATION-V1). There is no pitch or venue column on any fixture: the proposal and the resolution stay the linkage.
--
-- THE LEGACY PUBLISH. publish_competition_atomically keeps its signature, its privileges and every check it had; the one addition is a guard that refuses, with the stable code
-- SCHEDULE_PROPOSAL_PUBLICATION_REQUIRED, every competition that has a registration freeze, a draw or a schedule proposal. It remains for competitions outside the schedule
-- journey only and is not a way to publish a new competition.

create table competition_schedule_publications (
  schedule_publication_id uuid primary key default gen_random_uuid(),
  competition_id uuid not null,
  schedule_proposal_id uuid not null,
  schedule_proposal_sequence integer not null,
  schedule_proposal_digest text not null,
  planning_revision_id uuid not null,
  competition_draw_id uuid not null,
  draw_digest text not null,
  published_by_gaming_member_id uuid not null,
  published_at timestamptz not null,
  semifinal_1_fixture_id uuid not null,
  semifinal_2_fixture_id uuid not null,
  final_fixture_id uuid not null,
  publication_digest text not null,
  constraint competition_schedule_publications_one_per_competition unique (competition_id),
  constraint competition_schedule_publications_one_per_proposal unique (schedule_proposal_id),
  constraint competition_schedule_publications_semifinal_1_key unique (semifinal_1_fixture_id),
  constraint competition_schedule_publications_semifinal_2_key unique (semifinal_2_fixture_id),
  constraint competition_schedule_publications_final_key unique (final_fixture_id),
  constraint competition_schedule_publications_competition_fkey foreign key (competition_id) references competitions (competition_id),
  constraint competition_schedule_publications_proposal_fkey foreign key (competition_id, schedule_proposal_id) references competition_schedule_proposals (competition_id, schedule_proposal_id),
  constraint competition_schedule_publications_revision_fkey foreign key (planning_revision_id) references competition_planning_revisions (planning_revision_id),
  constraint competition_schedule_publications_draw_fkey foreign key (competition_id, competition_draw_id) references competition_draws (competition_id, competition_draw_id),
  constraint competition_schedule_publications_actor_fkey foreign key (published_by_gaming_member_id) references gaming_members (gaming_member_id),
  constraint competition_schedule_publications_semifinal_1_fkey foreign key (semifinal_1_fixture_id) references competition_fixtures (competition_fixture_id),
  constraint competition_schedule_publications_semifinal_2_fkey foreign key (semifinal_2_fixture_id) references competition_fixtures (competition_fixture_id),
  constraint competition_schedule_publications_final_fkey foreign key (final_fixture_id) references competition_fixtures (competition_fixture_id),
  constraint competition_schedule_publications_distinct_fixtures check (semifinal_1_fixture_id <> semifinal_2_fixture_id and semifinal_1_fixture_id <> final_fixture_id and semifinal_2_fixture_id <> final_fixture_id),
  constraint competition_schedule_publications_sequence check (schedule_proposal_sequence >= 1),
  constraint competition_schedule_publications_digest_shapes check (schedule_proposal_digest ~ '^[0-9a-f]{64}$' and draw_digest ~ '^[0-9a-f]{64}$' and publication_digest ~ '^[0-9a-f]{64}$')
);

alter table competition_schedule_publications enable row level security;
-- No policy, and no privilege for anyone: only the functions below, which run as their owner, ever read or write this table.
revoke all on table competition_schedule_publications from public, anon, authenticated, service_role;

create function competition_schedule_publication_reject_change()
 returns trigger
 language plpgsql
 set search_path = public, pg_temp
as $function$
begin
  raise exception 'SCHEDULE_PUBLICATION_IMMUTABLE: a schedule publication is a permanent record and can never be changed or removed' using errcode = 'P0001';
end;
$function$;
revoke all on function competition_schedule_publication_reject_change() from public, anon, authenticated;
revoke all on function competition_schedule_publication_reject_change() from service_role;

create trigger competition_schedule_publications_immutable_rows before update or delete on competition_schedule_publications
  for each row execute function competition_schedule_publication_reject_change();
create trigger competition_schedule_publications_immutable_truncate before truncate on competition_schedule_publications
  for each statement execute function competition_schedule_publication_reject_change();

-- The digest of a publication: one canonical text, lines joined by a newline with none at the end. Each fixture line carries, after the fixture's identifier and UTC start,
-- the two TEAMS of a semifinal or the two SOURCE fixtures of the final. The fixtures are given in the shape the evidence function returns.
create function competition_schedule_publication_digest(
  p_competition_id uuid, p_sequence integer, p_proposal_digest text, p_planning_revision_id uuid, p_draw_id uuid, p_draw_digest text, p_published_by uuid, p_published_at timestamptz,
  p_fixtures jsonb
)
 returns text
 language sql
 stable
 set search_path = public, pg_temp
as $function$
  select encode(sha256(convert_to(
    'URBANO-COMPETITION-SCHEDULE-PUBLICATION-V1'
    || E'\ncompetition:' || p_competition_id::text
    || E'\nproposal:' || p_sequence::text || ',' || p_proposal_digest
    || E'\nplanning-revision:' || p_planning_revision_id::text
    || E'\ndraw:' || p_draw_id::text || ',' || p_draw_digest
    || E'\npublished-by:' || p_published_by::text
    || E'\npublished-at:' || to_char(p_published_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')
    || coalesce((select string_agg(E'\nfixture:' || (f.value ->> 'fixture_role') || ',' || (f.value ->> 'fixture_id') || ',' || (f.value ->> 'start_utc') || ','
                                   || case when f.value ->> 'fixture_role' = 'FINAL' then coalesce(f.value ->> 'source_fixture_a_id', '') else coalesce(f.value ->> 'team_a_id', '') end || ','
                                   || case when f.value ->> 'fixture_role' = 'FINAL' then coalesce(f.value ->> 'source_fixture_b_id', '') else coalesce(f.value ->> 'team_b_id', '') end,
                                   '' order by array_position(array['SEMIFINAL_1', 'SEMIFINAL_2', 'FINAL'], f.value ->> 'fixture_role'))
                   from jsonb_array_elements(p_fixtures) f), ''), 'UTF8')), 'hex')
$function$;
revoke all on function competition_schedule_publication_digest(uuid, integer, text, uuid, uuid, text, uuid, timestamptz, jsonb) from public, anon, authenticated;
revoke all on function competition_schedule_publication_digest(uuid, integer, text, uuid, uuid, text, uuid, timestamptz, jsonb) from service_role;

-- A publication as the organizer is shown it, derived ONLY from immutable rows: the resolution, the proposal's placements and the draw's entries. It is the same after the
-- semifinals are played - the final's slots, the states and the scorekeepers are the fixtures' own and are not part of the resolution.
create function competition_schedule_publication_evidence(p_schedule_publication_id uuid)
 returns jsonb
 language plpgsql
 stable
 set search_path = public, pg_temp
as $function$
declare
  v_pub competition_schedule_publications%rowtype;
  v_team_1 uuid;
  v_team_2 uuid;
  v_team_3 uuid;
  v_team_4 uuid;
  v_fixtures jsonb;
begin
  select * into v_pub from competition_schedule_publications s where s.schedule_publication_id = p_schedule_publication_id;
  if not found then
    return null;
  end if;
  select e.competition_team_id into v_team_1 from competition_draw_entries e where e.competition_draw_id = v_pub.competition_draw_id and e.draw_position = 1;
  select e.competition_team_id into v_team_2 from competition_draw_entries e where e.competition_draw_id = v_pub.competition_draw_id and e.draw_position = 2;
  select e.competition_team_id into v_team_3 from competition_draw_entries e where e.competition_draw_id = v_pub.competition_draw_id and e.draw_position = 3;
  select e.competition_team_id into v_team_4 from competition_draw_entries e where e.competition_draw_id = v_pub.competition_draw_id and e.draw_position = 4;
  select jsonb_agg(jsonb_build_object(
           'fixture_role', r.role,
           'fixture_id', r.fixture_id,
           'start_utc', to_char(x.starts_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
           'team_a_id', case r.role when 'SEMIFINAL_1' then v_team_1 when 'SEMIFINAL_2' then v_team_3 else null end,
           'team_b_id', case r.role when 'SEMIFINAL_1' then v_team_2 when 'SEMIFINAL_2' then v_team_4 else null end,
           'source_fixture_a_id', case r.role when 'FINAL' then v_pub.semifinal_1_fixture_id else null end,
           'source_fixture_b_id', case r.role when 'FINAL' then v_pub.semifinal_2_fixture_id else null end)
         order by r.ord)
    into v_fixtures
    from (values (1, 'SEMIFINAL_1', v_pub.semifinal_1_fixture_id), (2, 'SEMIFINAL_2', v_pub.semifinal_2_fixture_id), (3, 'FINAL', v_pub.final_fixture_id)) as r(ord, role, fixture_id)
    join competition_schedule_proposal_placements x on x.schedule_proposal_id = v_pub.schedule_proposal_id and x.fixture_role = r.role;
  return jsonb_build_object(
    'schedule_proposal_sequence', v_pub.schedule_proposal_sequence,
    'schedule_proposal_digest', v_pub.schedule_proposal_digest,
    'planning_revision_id', v_pub.planning_revision_id,
    'draw_id', v_pub.competition_draw_id,
    'draw_digest', v_pub.draw_digest,
    'published_by', v_pub.published_by_gaming_member_id,
    'published_at', to_char(v_pub.published_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),
    'publication_digest', v_pub.publication_digest,
    'fixtures', v_fixtures);
end;
$function$;
revoke all on function competition_schedule_publication_evidence(uuid) from public, anon, authenticated;
revoke all on function competition_schedule_publication_evidence(uuid) from service_role;

-- The resolution is verified against everything it names, and its digest is recomputed, whoever wrote it: this runs at COMMIT, for every row inserted.
create function competition_schedule_publication_verify(p_schedule_publication_id uuid)
 returns void
 language plpgsql
 security definer
 set search_path = public, pg_temp
as $function$
declare
  v_pub competition_schedule_publications%rowtype;
  v_c competitions%rowtype;
  v_p competition_schedule_proposals%rowtype;
  v_d competition_draws%rowtype;
  v_team_1 uuid;
  v_team_2 uuid;
  v_team_3 uuid;
  v_team_4 uuid;
  v_start_1 timestamptz;
  v_start_2 timestamptz;
  v_start_3 timestamptz;
  v_evidence jsonb;
  v_digest text;
begin
  select * into v_pub from competition_schedule_publications s where s.schedule_publication_id = p_schedule_publication_id;
  if not found then
    raise exception 'SCHEDULE_PUBLICATION_INVALID: RECORD: the schedule publication does not exist' using errcode = 'P0001';
  end if;
  select * into v_c from competitions c where c.competition_id = v_pub.competition_id;
  if v_c.state is distinct from 'PUBLISHED' or v_c.published_at is distinct from v_pub.published_at then
    raise exception 'SCHEDULE_PUBLICATION_INVALID: COMPETITION: the competition is published at exactly the resolution''s instant' using errcode = 'P0001';
  end if;
  if v_pub.published_by_gaming_member_id is distinct from v_c.organizer_gaming_member_id then
    raise exception 'SCHEDULE_PUBLICATION_INVALID: ACTOR: a competition is published by its own organizer' using errcode = 'P0001';
  end if;
  select * into v_p from competition_schedule_proposals s where s.schedule_proposal_id = v_pub.schedule_proposal_id and s.competition_id = v_pub.competition_id;
  if not found
     or v_p.sequence_number is distinct from v_pub.schedule_proposal_sequence
     or v_p.proposal_digest is distinct from v_pub.schedule_proposal_digest
     or v_p.sequence_number is distinct from (select max(s.sequence_number) from competition_schedule_proposals s where s.competition_id = v_pub.competition_id) then
    raise exception 'SCHEDULE_PUBLICATION_INVALID: PROPOSAL: the resolution names its own competition''s latest proposal, by its sequence and digest' using errcode = 'P0001';
  end if;
  if v_pub.planning_revision_id is distinct from v_p.planning_revision_id
     or v_pub.planning_revision_id is distinct from (select r.planning_revision_id from competition_planning_revisions r where r.competition_id = v_pub.competition_id order by r.revision_number desc limit 1) then
    raise exception 'SCHEDULE_PUBLICATION_INVALID: PLAN: the resolution names the proposal''s plan revision, which is the competition''s current one' using errcode = 'P0001';
  end if;
  select * into v_d from competition_draws d where d.competition_id = v_pub.competition_id;
  if not found
     or v_d.competition_draw_id is distinct from v_pub.competition_draw_id
     or v_p.competition_draw_id is distinct from v_pub.competition_draw_id
     or v_d.draw_digest is distinct from v_pub.draw_digest
     or v_p.draw_digest is distinct from v_pub.draw_digest then
    raise exception 'SCHEDULE_PUBLICATION_INVALID: DRAW: the resolution names the competition''s one permanent draw, by its identifier and digest' using errcode = 'P0001';
  end if;
  perform competition_draw_verify(v_d.competition_draw_id);
  select e.competition_team_id into v_team_1 from competition_draw_entries e where e.competition_draw_id = v_d.competition_draw_id and e.draw_position = 1;
  select e.competition_team_id into v_team_2 from competition_draw_entries e where e.competition_draw_id = v_d.competition_draw_id and e.draw_position = 2;
  select e.competition_team_id into v_team_3 from competition_draw_entries e where e.competition_draw_id = v_d.competition_draw_id and e.draw_position = 3;
  select e.competition_team_id into v_team_4 from competition_draw_entries e where e.competition_draw_id = v_d.competition_draw_id and e.draw_position = 4;
  select x.starts_at into v_start_1 from competition_schedule_proposal_placements x where x.schedule_proposal_id = v_p.schedule_proposal_id and x.fixture_role = 'SEMIFINAL_1';
  select x.starts_at into v_start_2 from competition_schedule_proposal_placements x where x.schedule_proposal_id = v_p.schedule_proposal_id and x.fixture_role = 'SEMIFINAL_2';
  select x.starts_at into v_start_3 from competition_schedule_proposal_placements x where x.schedule_proposal_id = v_p.schedule_proposal_id and x.fixture_role = 'FINAL';
  if (select count(*) from competition_fixtures f where f.competition_id = v_pub.competition_id) <> 3
     or not exists (select 1 from competition_fixtures f
                     where f.competition_fixture_id = v_pub.semifinal_1_fixture_id and f.competition_id = v_pub.competition_id and f.fixture_role = 'SEMIFINAL_1'
                       and f.team_a_competition_team_id is not distinct from v_team_1 and f.team_b_competition_team_id is not distinct from v_team_2
                       and f.team_a_source_fixture_id is null and f.team_b_source_fixture_id is null
                       and f.scheduled_at is not distinct from v_start_1 and f.state = 'SCHEDULED' and f.scorekeeper_gaming_member_id is null)
     or not exists (select 1 from competition_fixtures f
                     where f.competition_fixture_id = v_pub.semifinal_2_fixture_id and f.competition_id = v_pub.competition_id and f.fixture_role = 'SEMIFINAL_2'
                       and f.team_a_competition_team_id is not distinct from v_team_3 and f.team_b_competition_team_id is not distinct from v_team_4
                       and f.team_a_source_fixture_id is null and f.team_b_source_fixture_id is null
                       and f.scheduled_at is not distinct from v_start_2 and f.state = 'SCHEDULED' and f.scorekeeper_gaming_member_id is null)
     or not exists (select 1 from competition_fixtures f
                     where f.competition_fixture_id = v_pub.final_fixture_id and f.competition_id = v_pub.competition_id and f.fixture_role = 'FINAL'
                       and f.team_a_competition_team_id is null and f.team_b_competition_team_id is null
                       and f.team_a_source_fixture_id is not distinct from v_pub.semifinal_1_fixture_id and f.team_b_source_fixture_id is not distinct from v_pub.semifinal_2_fixture_id
                       and f.scheduled_at is not distinct from v_start_3 and f.state = 'SCHEDULED' and f.scorekeeper_gaming_member_id is null) then
    raise exception 'SCHEDULE_PUBLICATION_INVALID: FIXTURES: the competition has exactly the three fixtures the resolution names, from the draw''s pairing at the proposal''s instants' using errcode = 'P0001';
  end if;
  v_evidence := competition_schedule_publication_evidence(p_schedule_publication_id);
  v_digest := competition_schedule_publication_digest(v_pub.competition_id, v_pub.schedule_proposal_sequence, v_pub.schedule_proposal_digest, v_pub.planning_revision_id,
                                                      v_pub.competition_draw_id, v_pub.draw_digest, v_pub.published_by_gaming_member_id, v_pub.published_at, v_evidence -> 'fixtures');
  if v_digest is distinct from v_pub.publication_digest then
    raise exception 'SCHEDULE_PUBLICATION_INVALID: DIGEST: the publication digest does not match the evidence' using errcode = 'P0001';
  end if;
end;
$function$;
revoke all on function competition_schedule_publication_verify(uuid) from public, anon, authenticated;
revoke all on function competition_schedule_publication_verify(uuid) from service_role;

create function competition_schedule_publication_verify_row()
 returns trigger
 language plpgsql
 security definer
 set search_path = public, pg_temp
as $function$
begin
  perform competition_schedule_publication_verify(new.schedule_publication_id);
  return null;
end;
$function$;
revoke all on function competition_schedule_publication_verify_row() from public, anon, authenticated;
revoke all on function competition_schedule_publication_verify_row() from service_role;

create constraint trigger competition_schedule_publications_verify after insert on competition_schedule_publications
  deferrable initially deferred
  for each row execute function competition_schedule_publication_verify_row();


create function publish_competition_schedule_atomically(p_competition_id uuid, p_organizer_gaming_member_id uuid, p_schedule_proposal_digest text)
 returns jsonb
 language plpgsql
 security definer
 set search_path = public, pg_temp
as $function$
declare
  v_organizer_id uuid;
  v_proposal competition_schedule_proposals%rowtype;
  v_publication competition_schedule_publications%rowtype;
  v_draw competition_draws%rowtype;
  v_now timestamptz;
  v_problem text;
  v_latest integer;
  v_status text;
  v_requested jsonb;
  v_derived jsonb;
  v_message text;
  v_team_1 uuid;
  v_team_2 uuid;
  v_team_3 uuid;
  v_team_4 uuid;
  v_start_1 timestamptz;
  v_start_2 timestamptz;
  v_start_3 timestamptz;
  v_sf1 uuid;
  v_sf2 uuid;
  v_final uuid;
  v_publication_id uuid := gen_random_uuid();
  v_fixtures jsonb;
  v_digest text;
begin
  -- Lock the competition (the same scope every organizer operation uses), then read it.
  perform pg_advisory_xact_lock(hashtext('competition_scope:' || p_competition_id::text));

  select competitions.organizer_gaming_member_id
    into v_organizer_id
    from competitions
   where competitions.competition_id = p_competition_id
   for update;

  if v_organizer_id is null then
    raise exception 'COMPETITION_NOT_FOUND: no such competition exists' using errcode = 'P0001';
  end if;

  -- Exact, null-safe ownership: a missing caller is refused, never skipped.
  if p_organizer_gaming_member_id is distinct from v_organizer_id then
    raise exception 'COMPETITION_ACCESS_DENIED: only this competition''s own organizer may publish it' using errcode = 'P0001';
  end if;
  perform assert_competition_not_host_revoked(p_competition_id);

  if p_schedule_proposal_digest is null or p_schedule_proposal_digest !~ '^[0-9a-f]{64}$' then
    raise exception 'SCHEDULE_PUBLICATION_INVALID: DIGEST_INVALID: a schedule proposal digest of 64 lowercase hexadecimal digits is required' using errcode = 'P0001';
  end if;

  -- The proposal is resolved by this competition and the exact digest: another competition's digest, a changed digest and an unknown one are all simply not found.
  select * into v_proposal from competition_schedule_proposals s where s.competition_id = p_competition_id and s.proposal_digest = p_schedule_proposal_digest;
  if not found then
    raise exception 'SCHEDULE_PUBLICATION_PROPOSAL_NOT_FOUND: this competition has no schedule proposal with that digest' using errcode = 'P0001';
  end if;

  -- An exact retry is answered from the record, after the caller's identity and the host's standing (judged above) and BEFORE the lifecycle: the publication stays replayable after
  -- the competition has moved on, and a replay writes nothing. Any other proposal of a published competition is a conflict and changes nothing.
  select * into v_publication from competition_schedule_publications p where p.competition_id = p_competition_id;
  if found then
    if v_publication.schedule_proposal_id = v_proposal.schedule_proposal_id then
      return jsonb_build_object('already_published', true, 'publication', competition_schedule_publication_evidence(v_publication.schedule_publication_id));
    end if;
    raise exception 'SCHEDULE_PUBLICATION_CONFLICT: this competition was published from a different schedule proposal' using errcode = 'P0001';
  end if;

  v_now := competition_registration_clock();
  v_problem := competition_schedule_eligibility_problem(p_competition_id, v_now);
  if v_problem is not null and v_problem <> 'AMENDMENT_PENDING' then
    raise exception 'SCHEDULE_PUBLICATION_%: the competition cannot be published from a schedule proposal now', v_problem using errcode = 'P0001';
  end if;

  -- The one permanent draw must reproduce itself; this comes before a plan change awaiting the captains is reported.
  select d.* into v_draw from competition_draws d where d.competition_id = p_competition_id;
  begin
    perform competition_draw_verify(v_draw.competition_draw_id);
  exception when raise_exception then
    raise exception 'SCHEDULE_PUBLICATION_DRAW_NOT_VERIFIABLE: the permanent draw does not reproduce itself' using errcode = 'P0001';
  end;
  if v_problem = 'AMENDMENT_PENDING' then
    raise exception 'SCHEDULE_PUBLICATION_AMENDMENT_PENDING: a plan change is still waiting for the captains'' answers' using errcode = 'P0001';
  end if;

  select max(s.sequence_number) into v_latest from competition_schedule_proposals s where s.competition_id = p_competition_id;
  if v_proposal.sequence_number <> v_latest then
    raise exception 'SCHEDULE_PUBLICATION_PROPOSAL_SUPERSEDED: a later schedule proposal exists' using errcode = 'P0001';
  end if;
  v_status := competition_schedule_proposal_evidence(v_proposal.schedule_proposal_id) ->> 'status';
  if v_status is distinct from 'CURRENT' then
    raise exception 'SCHEDULE_PUBLICATION_PROPOSAL_STALE: the proposal was made on a plan or a draw that is no longer current' using errcode = 'P0001';
  end if;

  -- The proposal's own evidence and digest must reproduce, exactly as they did when it was recorded.
  begin
    perform competition_schedule_proposal_verify(v_proposal.schedule_proposal_id);
  exception when raise_exception then
    raise exception 'SCHEDULE_PUBLICATION_PROPOSAL_NOT_VERIFIABLE: the schedule proposal does not reproduce itself' using errcode = 'P0001';
  end;

  -- Every placement is judged again, by the very same evaluator, at the publication instant: this is also where a kickoff at or before that instant is refused.
  select jsonb_agg(jsonb_build_object('fixture_role', x.fixture_role, 'planning_pitch_id', x.planning_pitch_id, 'plan_date', to_char(x.plan_date, 'YYYY-MM-DD'), 'start_time', to_char(x.start_time, 'HH24:MI'))
                   order by array_position(array['SEMIFINAL_1', 'SEMIFINAL_2', 'FINAL'], x.fixture_role))
    into v_requested
    from competition_schedule_proposal_placements x
   where x.schedule_proposal_id = v_proposal.schedule_proposal_id;
  begin
    v_derived := competition_schedule_evaluate(p_competition_id, v_proposal.planning_revision_id, v_proposal.format_key, v_requested, v_now);
  exception when raise_exception then
    get stacked diagnostics v_message = message_text;
    raise exception 'SCHEDULE_PUBLICATION_NOT_PUBLISHABLE: %', regexp_replace(v_message, '^SCHEDULE_PROPOSAL_INVALID: ', '') using errcode = 'P0001';
  end;
  if jsonb_array_length(v_derived) <> 3
     or exists (select 1 from jsonb_array_elements(v_derived) d
                  join competition_schedule_proposal_placements x on x.schedule_proposal_id = v_proposal.schedule_proposal_id and x.fixture_role = d.value ->> 'fixture_role'
                 where x.starts_at is distinct from (d.value ->> 'start_utc')::timestamptz
                    or x.occupancy_ends_at is distinct from (d.value ->> 'end_utc')::timestamptz
                    or x.window_starts_at is distinct from (d.value ->> 'window_start_utc')::timestamptz
                    or x.window_ends_at is distinct from (d.value ->> 'window_end_utc')::timestamptz) then
    raise exception 'SCHEDULE_PUBLICATION_NOT_PUBLISHABLE: PLACEMENT_CHANGED: the placements no longer come out as they were recorded' using errcode = 'P0001';
  end if;

  -- The teams of the semifinals are the draw's, by position; the instants are the proposal's.
  select e.competition_team_id into v_team_1 from competition_draw_entries e where e.competition_draw_id = v_draw.competition_draw_id and e.draw_position = 1;
  select e.competition_team_id into v_team_2 from competition_draw_entries e where e.competition_draw_id = v_draw.competition_draw_id and e.draw_position = 2;
  select e.competition_team_id into v_team_3 from competition_draw_entries e where e.competition_draw_id = v_draw.competition_draw_id and e.draw_position = 3;
  select e.competition_team_id into v_team_4 from competition_draw_entries e where e.competition_draw_id = v_draw.competition_draw_id and e.draw_position = 4;
  select x.starts_at into v_start_1 from competition_schedule_proposal_placements x where x.schedule_proposal_id = v_proposal.schedule_proposal_id and x.fixture_role = 'SEMIFINAL_1';
  select x.starts_at into v_start_2 from competition_schedule_proposal_placements x where x.schedule_proposal_id = v_proposal.schedule_proposal_id and x.fixture_role = 'SEMIFINAL_2';
  select x.starts_at into v_start_3 from competition_schedule_proposal_placements x where x.schedule_proposal_id = v_proposal.schedule_proposal_id and x.fixture_role = 'FINAL';

  insert into competition_fixtures (competition_id, fixture_role, scheduled_at, team_a_competition_team_id, team_b_competition_team_id, state)
  values (p_competition_id, 'SEMIFINAL_1', v_start_1, v_team_1, v_team_2, 'SCHEDULED')
  returning competition_fixtures.competition_fixture_id into v_sf1;

  insert into competition_fixtures (competition_id, fixture_role, scheduled_at, team_a_competition_team_id, team_b_competition_team_id, state)
  values (p_competition_id, 'SEMIFINAL_2', v_start_2, v_team_3, v_team_4, 'SCHEDULED')
  returning competition_fixtures.competition_fixture_id into v_sf2;

  insert into competition_fixtures (competition_id, fixture_role, scheduled_at, team_a_source_fixture_id, team_b_source_fixture_id, state)
  values (p_competition_id, 'FINAL', v_start_3, v_sf1, v_sf2, 'SCHEDULED')
  returning competition_fixtures.competition_fixture_id into v_final;

  v_fixtures := jsonb_build_array(
    jsonb_build_object('fixture_role', 'SEMIFINAL_1', 'fixture_id', v_sf1, 'start_utc', to_char(v_start_1 at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
                       'team_a_id', v_team_1, 'team_b_id', v_team_2, 'source_fixture_a_id', null, 'source_fixture_b_id', null),
    jsonb_build_object('fixture_role', 'SEMIFINAL_2', 'fixture_id', v_sf2, 'start_utc', to_char(v_start_2 at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
                       'team_a_id', v_team_3, 'team_b_id', v_team_4, 'source_fixture_a_id', null, 'source_fixture_b_id', null),
    jsonb_build_object('fixture_role', 'FINAL', 'fixture_id', v_final, 'start_utc', to_char(v_start_3 at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
                       'team_a_id', null, 'team_b_id', null, 'source_fixture_a_id', v_sf1, 'source_fixture_b_id', v_sf2));
  v_digest := competition_schedule_publication_digest(p_competition_id, v_proposal.sequence_number, v_proposal.proposal_digest, v_proposal.planning_revision_id, v_draw.competition_draw_id,
                                                      v_draw.draw_digest, p_organizer_gaming_member_id, v_now, v_fixtures);

  insert into competition_schedule_publications (
    schedule_publication_id, competition_id, schedule_proposal_id, schedule_proposal_sequence, schedule_proposal_digest, planning_revision_id, competition_draw_id, draw_digest,
    published_by_gaming_member_id, published_at, semifinal_1_fixture_id, semifinal_2_fixture_id, final_fixture_id, publication_digest
  ) values (
    v_publication_id, p_competition_id, v_proposal.schedule_proposal_id, v_proposal.sequence_number, v_proposal.proposal_digest, v_proposal.planning_revision_id, v_draw.competition_draw_id, v_draw.draw_digest,
    p_organizer_gaming_member_id, v_now, v_sf1, v_sf2, v_final, v_digest
  );

  update competitions
     set state = 'PUBLISHED', published_at = v_now
   where competitions.competition_id = p_competition_id;

  return jsonb_build_object('already_published', false, 'publication', competition_schedule_publication_evidence(v_publication_id));
end;
$function$;

revoke all on function publish_competition_schedule_atomically(uuid, uuid, text) from public, anon, authenticated;
grant execute on function publish_competition_schedule_atomically(uuid, uuid, text) to service_role;

-- THE LEGACY PUBLISH, guarded. This is the latest accepted definition of publish_competition_atomically (20261014183938) carried over unchanged except for the one guard that is
-- marked below. The signature, the return shape, the privileges (create or replace keeps them) and every check, error and write are exactly what they were.
CREATE OR REPLACE FUNCTION public.publish_competition_atomically(p_competition_id uuid, p_organizer_gaming_member_id uuid, p_semifinal_1_team_a_id uuid, p_semifinal_1_team_b_id uuid, p_semifinal_2_team_a_id uuid, p_semifinal_2_team_b_id uuid, p_semifinal_1_scheduled_at timestamp with time zone, p_semifinal_2_scheduled_at timestamp with time zone, p_final_scheduled_at timestamp with time zone)
 RETURNS TABLE(competition_id uuid, state text, published_at timestamp with time zone, semifinal_1_fixture_id uuid, semifinal_2_fixture_id uuid, final_fixture_id uuid)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_organizer_id uuid;
  v_state text;
  v_team_count integer;
  v_distinct_pairing_count integer;
  v_published_at timestamptz;
  v_sf1_id uuid;
  v_sf2_id uuid;
  v_final_id uuid;
begin
  perform pg_advisory_xact_lock(hashtext('competition_scope:' || p_competition_id::text));

  select competitions.organizer_gaming_member_id, competitions.state
    into v_organizer_id, v_state
    from competitions
   where competitions.competition_id = p_competition_id
   for update;

  if v_organizer_id is null then
    raise exception 'COMPETITION_NOT_FOUND: no such competition exists' using errcode = 'P0001';
  end if;

  if p_organizer_gaming_member_id is distinct from v_organizer_id then
    raise exception 'COMPETITION_ACCESS_DENIED: only this competition''s own organizer may publish it'
      using errcode = 'P0001';
  end if;
  perform assert_competition_not_host_revoked(p_competition_id);

  -- UG-CR-GATE-SSS-025: a competition that belongs to the schedule journey - one with a registration freeze, a draw or a schedule proposal - is published from
  -- its exact CURRENT schedule proposal by publish_competition_schedule_atomically and never by chosen teams and times. The check is in the database, after the
  -- ownership and revocation checks above (so a stranger or a former host learns nothing) and before every other check.
  if exists (select 1 from competition_registration_freezes f where f.competition_id = p_competition_id)
     or exists (select 1 from competition_draws d where d.competition_id = p_competition_id)
     or exists (select 1 from competition_schedule_proposals s where s.competition_id = p_competition_id) then
    raise exception 'SCHEDULE_PROPOSAL_PUBLICATION_REQUIRED: this competition is published from its schedule proposal, not from chosen teams and times'
      using errcode = 'P0001';
  end if;

  if v_state <> 'READY_TO_PUBLISH' then
    raise exception 'COMPETITION_NOT_READY_TO_PUBLISH: a competition may only be published from READY_TO_PUBLISH'
      using errcode = 'P0001';
  end if;

  select count(*) into v_team_count
    from competition_teams
   where competition_teams.competition_id = p_competition_id
     and competition_teams.status = 'ACCEPTED';

  if v_team_count <> 4 then
    raise exception 'COMPETITION_TEAM_COUNT_INVALID: exactly four accepted teams are required to publish (found %)', v_team_count
      using errcode = 'P0001';
  end if;

  select count(distinct team_id) into v_distinct_pairing_count
    from unnest(array[p_semifinal_1_team_a_id, p_semifinal_1_team_b_id,
                       p_semifinal_2_team_a_id, p_semifinal_2_team_b_id]) as team_id;

  if v_distinct_pairing_count <> 4 then
    raise exception 'COMPETITION_PAIRING_INVALID: the four semifinal pairing slots must name four distinct teams'
      using errcode = 'P0001';
  end if;

  if exists (
    select 1 from unnest(array[p_semifinal_1_team_a_id, p_semifinal_1_team_b_id,
                                p_semifinal_2_team_a_id, p_semifinal_2_team_b_id]) as team_id
    where not exists (
      select 1 from competition_teams
      where competition_teams.competition_team_id = team_id
        and competition_teams.competition_id = p_competition_id
        and competition_teams.status = 'ACCEPTED'
    )
  ) then
    raise exception 'COMPETITION_PAIRING_INVALID: every paired team must belong to this competition and be accepted'
      using errcode = 'P0001';
  end if;

  v_published_at := now();

  insert into competition_fixtures (competition_id, fixture_role, scheduled_at, team_a_competition_team_id, team_b_competition_team_id, state)
  values (p_competition_id, 'SEMIFINAL_1', p_semifinal_1_scheduled_at, p_semifinal_1_team_a_id, p_semifinal_1_team_b_id, 'SCHEDULED')
  returning competition_fixtures.competition_fixture_id into v_sf1_id;

  insert into competition_fixtures (competition_id, fixture_role, scheduled_at, team_a_competition_team_id, team_b_competition_team_id, state)
  values (p_competition_id, 'SEMIFINAL_2', p_semifinal_2_scheduled_at, p_semifinal_2_team_a_id, p_semifinal_2_team_b_id, 'SCHEDULED')
  returning competition_fixtures.competition_fixture_id into v_sf2_id;

  insert into competition_fixtures (competition_id, fixture_role, scheduled_at, team_a_source_fixture_id, team_b_source_fixture_id, state)
  values (p_competition_id, 'FINAL', p_final_scheduled_at, v_sf1_id, v_sf2_id, 'SCHEDULED')
  returning competition_fixtures.competition_fixture_id into v_final_id;

  update competitions
     set state = 'PUBLISHED', published_at = v_published_at
   where competitions.competition_id = p_competition_id;

  return query select p_competition_id, 'PUBLISHED'::text, v_published_at, v_sf1_id, v_sf2_id, v_final_id;
end;
$function$;
