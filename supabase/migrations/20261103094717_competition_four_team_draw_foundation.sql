-- UG-CR-GATE-SSS-019 — Auditable Four-Team Draw backend foundation.
--
-- WHAT THIS DOES. After registration is frozen (READY_TO_PUBLISH, one freeze of exactly four accepted teams, a consistent snapshot, no fixture) the competition's
-- own ACTIVE organizer may make the ONE permanent draw of the four frozen teams, and only the organizer. The database generates the entropy itself, inside the one
-- atomic operation; nothing a client sends can influence the result. The draw is separate, immutable evidence that reproduces itself: its seed, the algorithm
-- version, the permutation index, the frozen teams in canonical order (the byte order of their identifiers, which is the freeze's own position order), the drawn
-- order, the freeze it belongs to and the freeze's digest, the actor, the database instant, the request identifier and a digest of the whole.
--
--   1. Two server-only, append-only tables: competition_draws (at most one per competition) and competition_draw_entries (exactly the four frozen teams, each at
--      one draw position 1-4 and one input position 1-4). Row-level security is on, there is no policy, no role holds any privilege, and UPDATE, DELETE and
--      TRUNCATE are refused. At commit a deferred check recomputes the permutation index from the seed, the drawn order from the index and the frozen input, and
--      the digest from all of it, and refuses a draw that does not reproduce itself.
--   2. Internal helpers, executable by nobody: the sampling (a SHA-256 word per counter, rejection above the largest multiple of 24 not above 2^32, so each of
--      the 24 orders has probability exactly 1/24), the factorial decoding, the digest, the eligibility test, the evidence builder and the check triggers.
--   3. Two service-role-only operations: the atomic create-or-replay and a bounded read (the active organizer, and once a draw exists the four frozen captains).
--
-- THE ORDER OF DECISIONS in the create operation: the competition lock; the organizer's exact, null-safe ownership and the host-revocation guard; an exact retry
-- of the same request (answered from the record, writing nothing, even after the competition has moved on) or, for a different request, a conflict; then the
-- lifecycle (state, freeze, exactly four accepted teams, a consistent snapshot, no fixture, and no plan change that genuinely awaits the captains - a proposal
-- that was rejected, withdrawn, superseded, activated or has expired no longer does); and only then the entropy and the writes.
--
-- WHAT THIS DELIBERATELY DOES NOT DO. It changes no earlier migration, no registry value, no registration, deadline, freeze, planning or amendment function, no
-- freeze table, no publish or cancel operation and no discovery. It creates no fixture, publishes nothing, adds no Competition state, closes no amendment window
-- (a later plan change may still change the venue, pitches, dates and windows - and can never alter a draw) and makes no format other than five-a-side
-- creatable. The draw is NOT yet binding on publication: the existing manual publication still accepts any pairing. Schedule proposals and a publication that
-- derives its bracket from the draw are later work; this candidate is not release-ready.
--
-- Append-only: no earlier migration is edited.

-- 1/7  The draw's evidence.
create table competition_draws (
  competition_draw_id uuid primary key default gen_random_uuid(),
  competition_id uuid not null,
  registration_freeze_id uuid not null,
  freeze_digest text not null,
  algorithm_version text not null,
  seed text not null,
  permutation_index smallint not null,
  drawn_by_gaming_member_id uuid not null references gaming_members (gaming_member_id),
  intent_id uuid not null,
  drawn_at timestamptz not null,
  draw_digest text not null,
  constraint competition_draws_one_per_competition unique (competition_id),
  constraint competition_draws_intent_key unique (competition_id, intent_id),
  constraint competition_draws_competition_draw_key unique (competition_id, competition_draw_id),
  constraint competition_draws_competition_fkey foreign key (competition_id) references competitions (competition_id),
  constraint competition_draws_freeze_fkey foreign key (competition_id, registration_freeze_id) references competition_registration_freezes (competition_id, registration_freeze_id),
  constraint competition_draws_algorithm check (algorithm_version = 'URBANO-DRAW-PERMUTATION-V1'),
  constraint competition_draws_seed_shape check (seed ~ '^[0-9a-f]{64}$'),
  constraint competition_draws_index_range check (permutation_index between 0 and 23),
  constraint competition_draws_digest_shape check (draw_digest ~ '^[0-9a-f]{64}$' and freeze_digest ~ '^[0-9a-f]{64}$')
);

create table competition_draw_entries (
  competition_draw_id uuid not null,
  competition_id uuid not null,
  registration_freeze_id uuid not null,
  draw_position smallint not null,
  input_position smallint not null,
  competition_team_id uuid not null,
  constraint competition_draw_entries_pkey primary key (competition_draw_id, draw_position),
  constraint competition_draw_entries_team_key unique (competition_draw_id, competition_team_id),
  constraint competition_draw_entries_input_key unique (competition_draw_id, input_position),
  constraint competition_draw_entries_draw_fkey foreign key (competition_id, competition_draw_id) references competition_draws (competition_id, competition_draw_id),
  constraint competition_draw_entries_frozen_team_fkey foreign key (registration_freeze_id, competition_team_id) references competition_registration_freeze_teams (registration_freeze_id, competition_team_id),
  constraint competition_draw_entries_draw_position check (draw_position between 1 and 4),
  constraint competition_draw_entries_input_position check (input_position between 1 and 4)
);

-- 2/7  Server-only: no browser role holds any privilege, and not even the server role can read or write a row directly (the operations below do that).
alter table competition_draws enable row level security;
alter table competition_draw_entries enable row level security;

revoke all on table competition_draws from public, anon, authenticated, service_role;
revoke all on table competition_draw_entries from public, anon, authenticated, service_role;

-- 3/7  Append-only: a recorded draw never changes, whoever asks.
create function competition_draw_reject_change()
 returns trigger
 language plpgsql
 set search_path = public, pg_temp
as $function$
begin
  raise exception 'COMPETITION_DRAW_IMMUTABLE: a recorded draw cannot be changed, replaced or removed' using errcode = 'P0001';
end;
$function$;
revoke all on function competition_draw_reject_change() from public, anon, authenticated;
revoke all on function competition_draw_reject_change() from service_role;

create trigger competition_draws_immutable_rows before update or delete on competition_draws
  for each row execute function competition_draw_reject_change();
create trigger competition_draw_entries_immutable_rows before update or delete on competition_draw_entries
  for each row execute function competition_draw_reject_change();

create trigger competition_draws_immutable_truncate before truncate on competition_draws
  for each statement execute function competition_draw_reject_change();
create trigger competition_draw_entries_immutable_truncate before truncate on competition_draw_entries
  for each statement execute function competition_draw_reject_change();

-- 4/7  The pure helpers. Nobody can call them directly; the operations (which run as the database owner) and the checks do.
--
-- The sampled word for one counter: the first four bytes, big-endian, of SHA-256(the seed's 32 bytes || the counter as four big-endian bytes).
create function competition_draw_word(p_seed text, p_counter integer)
 returns bigint
 language plpgsql
 immutable
 set search_path = public, pg_temp
as $function$
declare
  v_hash bytea;
begin
  if p_seed is null or p_seed !~ '^[0-9a-f]{64}$' then
    raise exception 'COMPETITION_DRAW_INVALID: the seed must be 64 lowercase hexadecimal digits' using errcode = 'P0001';
  end if;
  if p_counter is null or p_counter < 0 or p_counter > 63 then
    raise exception 'COMPETITION_DRAW_INVALID: the counter must be a whole number from 0 to 63' using errcode = 'P0001';
  end if;
  v_hash := sha256(decode(p_seed, 'hex') || decode(lpad(to_hex(p_counter), 8, '0'), 'hex'));
  return get_byte(v_hash, 0)::bigint * 16777216 + get_byte(v_hash, 1)::bigint * 65536 + get_byte(v_hash, 2)::bigint * 256 + get_byte(v_hash, 3)::bigint;
end;
$function$;
revoke all on function competition_draw_word(text, integer) from public, anon, authenticated;
revoke all on function competition_draw_word(text, integer) from service_role;

-- A word below 4294967280 (= 24 x 178956970, the largest multiple of 24 not above 2^32) gives its index (word mod 24); a word at or above it is REJECTED (null).
-- Reducing the whole range would favour the first sixteen indexes; rejecting the last sixteen values makes every index exactly equally likely.
create function competition_draw_accept_word(p_word bigint)
 returns smallint
 language sql
 immutable
 set search_path = public, pg_temp
as $function$
  select case when p_word >= 0 and p_word < 4294967280 then (p_word % 24)::smallint else null end
$function$;
revoke all on function competition_draw_accept_word(bigint) from public, anon, authenticated;
revoke all on function competition_draw_accept_word(bigint) from service_role;

-- The permutation index (0-23) a seed draws: the first accepted word's index, trying counters 0, 1, 2, ... (at most 64).
create function competition_draw_permutation_index(p_seed text)
 returns smallint
 language plpgsql
 immutable
 set search_path = public, pg_temp
as $function$
declare
  v_counter integer := 0;
  v_index smallint;
begin
  loop
    v_index := competition_draw_accept_word(competition_draw_word(p_seed, v_counter));
    if v_index is not null then
      return v_index;
    end if;
    v_counter := v_counter + 1;
    if v_counter > 63 then
      raise exception 'COMPETITION_DRAW_INVALID: no permutation index could be drawn from this seed' using errcode = 'P0001';
    end if;
  end loop;
end;
$function$;
revoke all on function competition_draw_permutation_index(text) from public, anon, authenticated;
revoke all on function competition_draw_permutation_index(text) from service_role;

-- The drawn order of four distinct teams given in canonical order, by factorial decoding of the index: d1 = index / 6 picks the first of the four, d2 = (index % 6) / 2
-- the second of the remaining three, d3 = index % 2 the third of the remaining two, and the last is the fourth. Index i is the i-th permutation in lexicographic order.
create function competition_draw_order(p_input uuid[], p_index integer)
 returns uuid[]
 language plpgsql
 immutable
 set search_path = public, pg_temp
as $function$
declare
  v_rest uuid[] := p_input;
  v_order uuid[] := array[]::uuid[];
  v_weights integer[] := array[6, 2, 1];
  v_remaining integer := p_index;
  v_pick uuid;
  v_i integer;
begin
  if p_input is null or array_length(p_input, 1) is distinct from 4 or array_position(p_input, null) is not null
     or (select count(distinct x) from unnest(p_input) x) <> 4 then
    raise exception 'COMPETITION_DRAW_INVALID: exactly four distinct teams are drawn' using errcode = 'P0001';
  end if;
  if p_index is null or p_index < 0 or p_index > 23 then
    raise exception 'COMPETITION_DRAW_INVALID: the permutation index must be a whole number from 0 to 23' using errcode = 'P0001';
  end if;
  for v_i in 1..3 loop
    v_pick := v_rest[(v_remaining / v_weights[v_i]) + 1];
    v_remaining := v_remaining % v_weights[v_i];
    v_order := v_order || v_pick;
    v_rest := array_remove(v_rest, v_pick);
  end loop;
  return v_order || v_rest[1];
end;
$function$;
revoke all on function competition_draw_order(uuid[], integer) from public, anon, authenticated;
revoke all on function competition_draw_order(uuid[], integer) from service_role;

-- The digest of one draw. Canonical text (version 1), lines joined by a newline with none at the end: the version line, the competition, the freeze's own digest,
-- the algorithm version, the seed, the index, the four frozen teams in canonical order and the four drawn teams in drawn order (comma separated).
create function competition_draw_digest(p_competition_id uuid, p_freeze_digest text, p_seed text, p_index integer, p_input uuid[], p_order uuid[])
 returns text
 language plpgsql
 stable
 set search_path = public, pg_temp
as $function$
declare
  v_text text;
begin
  if p_freeze_digest is null or p_freeze_digest !~ '^[0-9a-f]{64}$' or p_seed is null or p_seed !~ '^[0-9a-f]{64}$'
     or p_index is null or p_index < 0 or p_index > 23
     or p_input is null or array_length(p_input, 1) is distinct from 4 or p_order is null or array_length(p_order, 1) is distinct from 4 then
    raise exception 'COMPETITION_DRAW_INVALID: the draw digest needs a freeze digest, a seed, an index and four teams in and out' using errcode = 'P0001';
  end if;
  v_text := 'URBANO-COMPETITION-DRAW-V1'
    || E'\ncompetition:' || p_competition_id::text
    || E'\nfreeze-digest:' || p_freeze_digest
    || E'\nalgorithm:URBANO-DRAW-PERMUTATION-V1'
    || E'\nseed:' || p_seed
    || E'\nindex:' || p_index::text
    || E'\ninput:' || array_to_string(p_input, ',')
    || E'\norder:' || array_to_string(p_order, ',');
  return encode(sha256(convert_to(v_text, 'UTF8')), 'hex');
end;
$function$;
revoke all on function competition_draw_digest(uuid, text, text, integer, uuid[], uuid[]) from public, anon, authenticated;
revoke all on function competition_draw_digest(uuid, text, text, integer, uuid[], uuid[]) from service_role;

-- 5/7  Eligibility and evidence.
-- Why a draw cannot be made now, or null when it can. Decided under the competition's lock, in this order: the wrong state (anything but READY_TO_PUBLISH and
-- unpublished, or a fixture already present); no freeze; a freeze that is not exactly four teams, or that no longer matches the competition (the live accepted
-- teams, captains and members, and the frozen evidence, in both directions - and the plan still carrying what the freeze recorded); and a plan change that
-- genuinely awaits the captains (a proposal's status is derived: PENDING until a resolution is recorded or its lifetime ends by the database clock).
create function competition_draw_eligibility_problem(p_competition_id uuid)
 returns text
 language plpgsql
 set search_path = public, pg_temp
as $function$
declare
  v_state text;
  v_published_at timestamptz;
  v_freeze competition_registration_freezes%rowtype;
  v_current record;
  v_now timestamptz;
begin
  select c.state, c.published_at into v_state, v_published_at from competitions c where c.competition_id = p_competition_id;
  if not found or v_state is distinct from 'READY_TO_PUBLISH' or v_published_at is not null then
    return 'WRONG_STATE';
  end if;
  select * into v_freeze from competition_registration_freezes f where f.competition_id = p_competition_id;
  if not found then
    return 'FREEZE_REQUIRED';
  end if;
  if exists (select 1 from competition_fixtures x where x.competition_id = p_competition_id) then
    return 'WRONG_STATE';
  end if;
  if v_freeze.team_count is distinct from 4
     or (select count(*) from competition_registration_freeze_teams ft where ft.registration_freeze_id = v_freeze.registration_freeze_id) <> 4
     or (select count(*) from competition_teams t where t.competition_id = p_competition_id and t.status = 'ACCEPTED') <> 4 then
    return 'FREEZE_INCONSISTENT';
  end if;
  select cur.* into v_current from competition_current_registration_plan(p_competition_id) cur;
  if v_current.planning_revision_id is null
     or v_current.format_key is distinct from v_freeze.format_key
     or v_current.roster_minimum is distinct from v_freeze.roster_minimum
     or v_current.roster_maximum is distinct from v_freeze.roster_maximum
     or v_current.registration_deadline_utc is distinct from v_freeze.registration_deadline_utc
     or not competition_registration_freeze_consistent(p_competition_id) then
    return 'FREEZE_INCONSISTENT';
  end if;
  v_now := competition_registration_clock();
  if exists (select 1 from competition_plan_change_proposals a
              where a.competition_id = p_competition_id and competition_plan_amendment_status_of(a.plan_amendment_id, v_now) = 'PENDING') then
    return 'AMENDMENT_PENDING';
  end if;
  return null;
end;
$function$;
revoke all on function competition_draw_eligibility_problem(uuid) from public, anon, authenticated;
revoke all on function competition_draw_eligibility_problem(uuid) from service_role;

-- The bounded evidence of one draw, exactly as both operations return it: the algorithm, the draw's instant (UTC, six fractional digits), the seed, the index, the
-- two digests, the frozen teams in canonical order and the drawn order. No identifier of a member, an intent or a freeze record.
create function competition_draw_evidence(p_competition_draw_id uuid)
 returns jsonb
 language sql
 set search_path = public, pg_temp
as $function$
  select jsonb_build_object(
    'algorithm', d.algorithm_version,
    'drawn_at', to_char(d.drawn_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),
    'seed', d.seed,
    'permutation_index', d.permutation_index,
    'freeze_digest', d.freeze_digest,
    'draw_digest', d.draw_digest,
    'input', (select jsonb_agg(jsonb_build_object('input_position', ft.position, 'team_id', ft.competition_team_id, 'team_name', t.name) order by ft.position)
                from competition_registration_freeze_teams ft
                join competition_teams t on t.competition_team_id = ft.competition_team_id
               where ft.registration_freeze_id = d.registration_freeze_id),
    'order', (select jsonb_agg(jsonb_build_object('draw_position', e.draw_position, 'input_position', e.input_position, 'team_id', e.competition_team_id, 'team_name', t.name) order by e.draw_position)
                from competition_draw_entries e
                join competition_teams t on t.competition_team_id = e.competition_team_id
               where e.competition_draw_id = d.competition_draw_id))
    from competition_draws d
   where d.competition_draw_id = p_competition_draw_id
$function$;
revoke all on function competition_draw_evidence(uuid) from public, anon, authenticated;
revoke all on function competition_draw_evidence(uuid) from service_role;

-- 6/7  The evidence is consistent whatever wrote it. A draw must reproduce itself: exactly four entries that are exactly the frozen teams at their own frozen
-- positions (which are the canonical byte order), the index from the seed, the drawn order from the index and the input, the digest from all of it, the freeze's
-- own digest, and the organizer as the actor. Checked when the transaction commits, so a draw and its entries are judged together.
create function competition_draw_verify(p_competition_draw_id uuid)
 returns void
 language plpgsql
 security definer
 set search_path = public, pg_temp
as $function$
declare
  v_d competition_draws%rowtype;
  v_freeze competition_registration_freezes%rowtype;
  v_entries integer;
  v_positions integer;
  v_inputs integer;
  v_teams integer;
  v_input uuid[];
  v_input_sorted uuid[];
  v_order uuid[];
  v_organizer uuid;
begin
  select * into v_d from competition_draws d where d.competition_draw_id = p_competition_draw_id;
  if not found then
    raise exception 'COMPETITION_DRAW_INVALID: the draw does not exist' using errcode = 'P0001';
  end if;
  select * into v_freeze from competition_registration_freezes f where f.registration_freeze_id = v_d.registration_freeze_id and f.competition_id = v_d.competition_id;
  if not found or v_freeze.snapshot_digest is distinct from v_d.freeze_digest then
    raise exception 'COMPETITION_DRAW_INVALID: a draw must name its own competition''s freeze and that freeze''s digest' using errcode = 'P0001';
  end if;
  select count(*), count(distinct e.draw_position), count(distinct e.input_position), count(distinct e.competition_team_id)
    into v_entries, v_positions, v_inputs, v_teams
    from competition_draw_entries e where e.competition_draw_id = v_d.competition_draw_id;
  if v_entries <> 4 or v_positions <> 4 or v_inputs <> 4 or v_teams <> 4 then
    raise exception 'COMPETITION_DRAW_INVALID: a draw has exactly four entries, at four positions, for four distinct teams' using errcode = 'P0001';
  end if;
  if exists (select 1 from competition_draw_entries e
              where e.competition_draw_id = v_d.competition_draw_id and (e.competition_id <> v_d.competition_id or e.registration_freeze_id <> v_d.registration_freeze_id)) then
    raise exception 'COMPETITION_DRAW_INVALID: every entry belongs to its draw''s own competition and freeze' using errcode = 'P0001';
  end if;
  select array_agg(ft.competition_team_id order by ft.position), array_agg(ft.competition_team_id order by ft.competition_team_id::text collate "C")
    into v_input, v_input_sorted
    from competition_registration_freeze_teams ft where ft.registration_freeze_id = v_d.registration_freeze_id;
  if array_length(v_input, 1) is distinct from 4 or v_input is distinct from v_input_sorted then
    raise exception 'COMPETITION_DRAW_INVALID: the frozen teams are not four, in canonical order' using errcode = 'P0001';
  end if;
  if exists (select 1 from competition_draw_entries e
               join competition_registration_freeze_teams ft on ft.registration_freeze_id = e.registration_freeze_id and ft.competition_team_id = e.competition_team_id
              where e.competition_draw_id = v_d.competition_draw_id and e.input_position is distinct from ft.position) then
    raise exception 'COMPETITION_DRAW_INVALID: every entry names its team''s own frozen position' using errcode = 'P0001';
  end if;
  if competition_draw_permutation_index(v_d.seed) is distinct from v_d.permutation_index then
    raise exception 'COMPETITION_DRAW_INVALID: the permutation index does not follow from the seed' using errcode = 'P0001';
  end if;
  select array_agg(e.competition_team_id order by e.draw_position) into v_order from competition_draw_entries e where e.competition_draw_id = v_d.competition_draw_id;
  if competition_draw_order(v_input, v_d.permutation_index) is distinct from v_order then
    raise exception 'COMPETITION_DRAW_INVALID: the drawn order does not follow from the permutation index' using errcode = 'P0001';
  end if;
  if competition_draw_digest(v_d.competition_id, v_d.freeze_digest, v_d.seed, v_d.permutation_index, v_input, v_order) is distinct from v_d.draw_digest then
    raise exception 'COMPETITION_DRAW_INVALID: the draw digest does not match the evidence' using errcode = 'P0001';
  end if;
  select c.organizer_gaming_member_id into v_organizer from competitions c where c.competition_id = v_d.competition_id;
  if v_d.drawn_by_gaming_member_id is distinct from v_organizer then
    raise exception 'COMPETITION_DRAW_INVALID: a draw is made by the competition''s own organizer' using errcode = 'P0001';
  end if;
end;
$function$;
revoke all on function competition_draw_verify(uuid) from public, anon, authenticated;
revoke all on function competition_draw_verify(uuid) from service_role;

create function competition_draw_verify_row()
 returns trigger
 language plpgsql
 security definer
 set search_path = public, pg_temp
as $function$
begin
  perform competition_draw_verify(new.competition_draw_id);
  return null;
end;
$function$;
revoke all on function competition_draw_verify_row() from public, anon, authenticated;
revoke all on function competition_draw_verify_row() from service_role;

create function competition_draw_entry_verify_row()
 returns trigger
 language plpgsql
 security definer
 set search_path = public, pg_temp
as $function$
begin
  perform competition_draw_verify(new.competition_draw_id);
  return null;
end;
$function$;
revoke all on function competition_draw_entry_verify_row() from public, anon, authenticated;
revoke all on function competition_draw_entry_verify_row() from service_role;

create constraint trigger competition_draws_verify after insert on competition_draws
  deferrable initially deferred
  for each row execute function competition_draw_verify_row();
create constraint trigger competition_draw_entries_verify after insert on competition_draw_entries
  deferrable initially deferred
  for each row execute function competition_draw_entry_verify_row();

-- 7/7  The two operations.
-- CREATE (the competition's own ACTIVE organizer only). One atomic operation: it takes the competition lock, decides who is acting (exact, null-safe ownership and the
-- host-revocation guard), answers an exact retry of the same request from the record and refuses any other request once a draw exists, judges the lifecycle, and only
-- then generates the entropy and writes the draw and its four entries. It takes no seed, team, order, pairing, time or actor beyond the verified caller.
create function create_competition_draw_atomically(p_competition_id uuid, p_organizer_gaming_member_id uuid, p_intent_id uuid)
 returns jsonb
 language plpgsql
 security definer
 set search_path = public, pg_temp
as $function$
declare
  v_organizer_id uuid;
  v_existing competition_draws%rowtype;
  v_problem text;
  v_freeze competition_registration_freezes%rowtype;
  v_input uuid[];
  v_seed text;
  v_index smallint;
  v_order uuid[];
  v_digest text;
  v_now timestamptz;
  v_draw_id uuid;
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
    raise exception 'COMPETITION_ACCESS_DENIED: only this competition''s own organizer may make the draw' using errcode = 'P0001';
  end if;
  perform assert_competition_not_host_revoked(p_competition_id);

  if p_intent_id is null then
    raise exception 'COMPETITION_DRAW_INVALID: REQUIRED: a draw identifier is required' using errcode = 'P0001';
  end if;

  -- An exact retry is answered from the record, after the caller's identity and the host's standing (judged above) and BEFORE the lifecycle: the draw stays
  -- replayable after the competition has moved on, and a replay writes nothing. Any other request, once a draw exists, is a conflict and changes nothing.
  select * into v_existing from competition_draws d where d.competition_id = p_competition_id;
  if found then
    if v_existing.intent_id = p_intent_id then
      return jsonb_build_object('already_drawn', true, 'draw', competition_draw_evidence(v_existing.competition_draw_id));
    end if;
    raise exception 'COMPETITION_DRAW_ALREADY_DRAWN: the draw has already been made and cannot be repeated' using errcode = 'P0001';
  end if;

  v_problem := competition_draw_eligibility_problem(p_competition_id);
  if v_problem = 'WRONG_STATE' then
    raise exception 'COMPETITION_DRAW_WRONG_STATE: the draw can only be made while the competition is ready to publish, before anything is published or played' using errcode = 'P0001';
  elsif v_problem = 'FREEZE_REQUIRED' then
    raise exception 'COMPETITION_DRAW_FREEZE_REQUIRED: registration must be closed and frozen before the draw can be made' using errcode = 'P0001';
  elsif v_problem = 'FREEZE_INCONSISTENT' then
    raise exception 'COMPETITION_DRAW_FREEZE_INCONSISTENT: the frozen registration no longer matches this competition, so the draw cannot be made' using errcode = 'P0001';
  elsif v_problem = 'AMENDMENT_PENDING' then
    raise exception 'COMPETITION_DRAW_AMENDMENT_PENDING: a plan change is still waiting for the captains'' answers' using errcode = 'P0001';
  end if;

  -- The input is the freeze's four teams in the freeze's own position order, which is the canonical byte order of their identifiers.
  select * into v_freeze from competition_registration_freezes f where f.competition_id = p_competition_id;
  select array_agg(ft.competition_team_id order by ft.position) into v_input
    from competition_registration_freeze_teams ft where ft.registration_freeze_id = v_freeze.registration_freeze_id;

  -- The entropy: 244 random bits from the database's own strong generator, hashed to a 256-bit seed. Generated here, after every check, and nowhere else.
  v_seed := encode(sha256(convert_to(gen_random_uuid()::text || gen_random_uuid()::text, 'UTF8')), 'hex');
  v_index := competition_draw_permutation_index(v_seed);
  v_order := competition_draw_order(v_input, v_index);
  v_digest := competition_draw_digest(p_competition_id, v_freeze.snapshot_digest, v_seed, v_index, v_input, v_order);
  v_now := competition_registration_clock();
  v_draw_id := gen_random_uuid();

  insert into competition_draws (
    competition_draw_id, competition_id, registration_freeze_id, freeze_digest, algorithm_version, seed, permutation_index,
    drawn_by_gaming_member_id, intent_id, drawn_at, draw_digest
  ) values (
    v_draw_id, p_competition_id, v_freeze.registration_freeze_id, v_freeze.snapshot_digest, 'URBANO-DRAW-PERMUTATION-V1', v_seed, v_index,
    p_organizer_gaming_member_id, p_intent_id, v_now, v_digest
  );

  insert into competition_draw_entries (competition_draw_id, competition_id, registration_freeze_id, draw_position, input_position, competition_team_id)
  select v_draw_id, p_competition_id, v_freeze.registration_freeze_id, o.ord::smallint, ft.position, o.team_id
    from unnest(v_order) with ordinality as o(team_id, ord)
    join competition_registration_freeze_teams ft on ft.registration_freeze_id = v_freeze.registration_freeze_id and ft.competition_team_id = o.team_id;

  return jsonb_build_object('already_drawn', false, 'draw', competition_draw_evidence(v_draw_id));
end;
$function$;

-- READ (bounded). Only the active, non-revoked organizer (who is told there is no draw yet) and, once a draw exists, a frozen captain who is still the captain of
-- their accepted frozen team get an answer; every other caller - including a missing one - gets SQL NULL, the same as for a competition that does not exist.
create function get_competition_draw(p_competition_id uuid, p_caller_gaming_member_id uuid)
 returns jsonb
 language plpgsql
 security definer
 set search_path = public, pg_temp
as $function$
declare
  v_organizer_id uuid;
  v_revoked boolean;
  v_is_organizer boolean;
  v_draw_id uuid;
begin
  select competitions.organizer_gaming_member_id into v_organizer_id from competitions where competitions.competition_id = p_competition_id;
  if v_organizer_id is null then
    return null;
  end if;
  v_revoked := exists (select 1 from competition_host_capabilities h where h.competition_id = p_competition_id and h.state = 'REVOKED');
  v_is_organizer := p_caller_gaming_member_id is not null and p_caller_gaming_member_id = v_organizer_id and not v_revoked;
  select d.competition_draw_id into v_draw_id from competition_draws d where d.competition_id = p_competition_id;

  if v_is_organizer then
    if v_draw_id is null then
      return jsonb_build_object('draw', null);
    end if;
    return jsonb_build_object('draw', competition_draw_evidence(v_draw_id));
  end if;

  -- A frozen captain, once a draw exists, with current access: the captain of an accepted team that the draw names, as the freeze recorded.
  if v_draw_id is null or p_caller_gaming_member_id is null then
    return null;
  end if;
  if not exists (
    select 1
      from competition_draw_entries e
      join competition_registration_freeze_teams ft on ft.registration_freeze_id = e.registration_freeze_id and ft.competition_team_id = e.competition_team_id
      join competition_teams t on t.competition_team_id = e.competition_team_id and t.competition_id = e.competition_id
     where e.competition_draw_id = v_draw_id
       and ft.captain_gaming_member_id = p_caller_gaming_member_id
       and t.captain_gaming_member_id = p_caller_gaming_member_id
       and t.status = 'ACCEPTED'
  ) then
    return null;
  end if;
  return jsonb_build_object('draw', competition_draw_evidence(v_draw_id));
end;
$function$;

revoke all on function create_competition_draw_atomically(uuid, uuid, uuid) from public, anon, authenticated;
revoke all on function get_competition_draw(uuid, uuid) from public, anon, authenticated;
grant execute on function create_competition_draw_atomically(uuid, uuid, uuid) to service_role;
grant execute on function get_competition_draw(uuid, uuid) to service_role;
