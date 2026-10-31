-- Migration: 20261020190000_create_community_voting_instances
-- UG-IV-GATE-002 — Community Voting local foundation (Design B1).
--
-- A Community Voting Experience Instance is bound ONE-TO-ONE to ONE Session. It owns
-- exactly: access context, verified-voter binding, eligibility configuration, the
-- PREPARATION of its ballot (entries and their private, host-confirmed contestant
-- associations) and the recovery metadata of a voter's intents. It deliberately owns
-- NOTHING else:
--
--   Session           -> capability declaration, host authority, lifecycle, close, reveal,
--                        completion (unchanged; this migration adds no lifecycle state)
--   Voting Interaction-> candidates, the authoritative votes and the tally (unchanged; every
--                        accepted vote is written by the UNCHANGED cast_vote_atomically)
--   Supabase Auth     -> identity (auth.users is referenced, never copied)
--   Gaming Member     -> an optional profile this module never creates or requires
--
-- So there is no ballot, no vote store, no tally and no close operation here.
--
-- PREPARATION IS READINESS DATA, NOT A BALLOT. community_voting_entries records what the host intends
-- to put on the ballot (a label) and which verified, event-bound contestant has been confirmed for it.
-- Those rows are NOT Voting candidates and are never read by Voting. PROMPT_ACTIVE means Voting is
-- actually open (Canon: IDENTITY_VOTING_LITERAL_PREPARATION_AND_ATOMIC_START_ACCEPTED), so nothing in
-- this module may leave a Voting interaction open while it is still "being prepared": one explicit,
-- host-authorized, atomic start (start_community_voting_atomically) later materializes the authoritative
-- voting_candidates rows — already carrying participant_id — and opens the Session's Voting interaction
-- through the Session's own start. Each entry then REFERENCES its candidate (candidate_id); it does not
-- copy it. The existing voting_candidates.participant_id column is the one and only contestant-ownership
-- store, and the existing self-vote rule in cast_vote_atomically governs it.
--
-- Instances are immutable once registered (a rule version is stamped for the lifetime of
-- the event). Bindings are created once and thereafter only their recovery counters move,
-- forwards, under triggers that refuse anything else.
--
-- ---------------------------------------------------------------------------------------
-- Deletion containment — PROVISIONAL TECHNICAL CONTAINMENT, NOT A RETENTION POLICY.
-- ---------------------------------------------------------------------------------------
-- Every foreign key below is ON DELETE RESTRICT, and bindings/instances are protected by
-- delete/truncate guard triggers (the repository's competition_host_* precedent) plus
-- revoked DELETE/TRUNCATE for service_role. Together these prevent:
--
--   * silently removing counted votes: votes cascade from participants and from sessions,
--     but a bound participant cannot be deleted (binding.participant_id RESTRICT), an
--     event-bound session cannot be deleted (instance.session_id RESTRICT), and neither
--     can the instance itself be removed while bindings exist;
--   * deleting and recreating a binding to obtain a second vote: bindings cannot be deleted
--     at all (trigger, even for the database owner), so a voter can never be "reset";
--   * an Auth-user deletion silently destroying integrity evidence: a bound Auth user cannot
--     be deleted (binding.auth_user_id RESTRICT). Note this deliberately DIFFERS from
--     gaming_members.auth_user_id, which cascades; here the evidence outlives a delete request.
--
-- A deliberate purge, erasure or retention workflow is NOT designed or authorized here. It
-- remains a Founder/Canon decision; until one exists these tables only ever grow.
--
-- RLS: enabled with no policies, and every privilege revoked from anon/authenticated, following
-- the competition_* precedent. Only the server's service_role client reaches these tables.

create table community_voting_instances (
  instance_id          uuid primary key default gen_random_uuid(),
  session_id           uuid not null unique references sessions (session_id) on delete restrict,

  -- Synthetic-or-venue geofence facts. Thresholds are CONFIGURATION, not policy: final venue
  -- thresholds require venue rehearsal and are outside this foundation.
  venue_latitude       double precision not null,
  venue_longitude      double precision not null,
  venue_radius_meters  double precision not null,
  max_accuracy_meters  double precision not null,
  inside_margin_factor  double precision not null,
  outside_margin_factor double precision not null,

  rule_version         integer not null,
  created_at           timestamptz not null default now(),

  -- NaN is greater than every number in Postgres, so every upper bound is explicit: a NaN or
  -- Infinity can never satisfy these.
  constraint community_voting_instances_latitude_range check (venue_latitude between -90 and 90),
  constraint community_voting_instances_longitude_range check (venue_longitude between -180 and 180),
  constraint community_voting_instances_radius_range check (venue_radius_meters > 0 and venue_radius_meters <= 100000),
  constraint community_voting_instances_max_accuracy_range check (max_accuracy_meters > 0 and max_accuracy_meters <= 100000),
  constraint community_voting_instances_inside_margin_range check (inside_margin_factor >= 0 and inside_margin_factor <= 1000),
  constraint community_voting_instances_outside_margin_range check (outside_margin_factor >= 0 and outside_margin_factor <= 1000),
  constraint community_voting_instances_rule_version_positive check (rule_version >= 1)
);

create table community_voting_voter_bindings (
  binding_id        uuid primary key default gen_random_uuid(),
  instance_id       uuid not null references community_voting_instances (instance_id) on delete restrict,

  -- The persistent identity. A reference to Supabase Auth, never a copy of an email or phone.
  auth_user_id      uuid not null references auth.users (id) on delete restrict,

  -- The internal Participant the unchanged Voting store attributes this voter's vote to.
  -- One binding per Participant. The Participant's token is read ONLY inside the transactional
  -- voting function and is never copied here.
  participant_id    uuid not null unique references participants (participant_id) on delete restrict,

  -- Server-controlled ordering. issued_intent_no is the highest intent number handed to this
  -- binding; applied_intent_no is the highest one consumed by an accepted cast. They are
  -- counters, NOT a vote history: the authoritative vote is the votes row, and which candidate
  -- an intent named is never stored here.
  issued_intent_no  integer not null default 0,
  applied_intent_no integer not null default 0,

  -- A bounded commitment (sha256 hex) to the canonical payload of the applied intent —
  -- instance, voting interaction and candidate. It lets a replay be recognised and a re-use
  -- with a different payload be refused, without duplicating the candidate selection.
  applied_payload_digest text null,

  -- The accepted attempt's derived evidence only. RAW COORDINATES ARE NEVER STORED.
  applied_distance_meters numeric(12, 1) null,
  applied_accuracy_meters numeric(10, 1) null,
  applied_at        timestamptz null,

  created_at        timestamptz not null default now(),

  constraint community_voting_voter_bindings_instance_auth_user_unique unique (instance_id, auth_user_id),
  -- Redundant as a uniqueness rule (binding_id is already the primary key) but it is the target of the
  -- composite foreign keys in community_voting_entries, which is how "this contestant belongs to THIS event"
  -- is enforced by the database itself rather than by a function remembering to check it.
  constraint community_voting_voter_bindings_binding_instance_unique unique (binding_id, instance_id),
  constraint community_voting_voter_bindings_issued_nonneg check (issued_intent_no >= 0),
  constraint community_voting_voter_bindings_applied_range check (applied_intent_no >= 0 and applied_intent_no <= issued_intent_no),
  constraint community_voting_voter_bindings_applied_evidence_together check (
    (applied_intent_no = 0 and applied_payload_digest is null and applied_at is null
       and applied_distance_meters is null and applied_accuracy_meters is null)
    or
    (applied_intent_no > 0 and applied_payload_digest is not null and applied_at is not null
       and applied_distance_meters is not null and applied_accuracy_meters is not null)
  ),
  constraint community_voting_voter_bindings_digest_shape check (
    applied_payload_digest is null or applied_payload_digest ~ '^[0-9a-f]{64}$'
  )
);

-- Postgres never indexes the referencing side of a foreign key. This one is needed so the
-- ON DELETE RESTRICT check on auth.users does not scan the whole table.
create index community_voting_voter_bindings_auth_user_id_idx
  on community_voting_voter_bindings (auth_user_id);

-- ---------------------------------------------------------------------------------------
-- Preparation entries: the ballot as the host is assembling it, BEFORE it opens.
-- ---------------------------------------------------------------------------------------
--
-- One row per intended ballot entry. The private association of a contestant with an entry is a
-- two-step, two-party act that never exposes an identity to the host:
--
--   1. the host creates the entry and receives a single-use CLAIM CREDENTIAL (shown once);
--   2. the host hands that credential to the intended contestant, out of band;
--   3. the contestant, signed in with their own verified identity and already bound to the event,
--      presents it. That consumes the credential, marks the entry PENDING for THEIR binding, and
--      returns a short CONFIRMATION CODE to them, once;
--   4. the contestant shows the code on their own screen to the host, who types it against the entry
--      they intend. A match makes the association CONFIRMED.
--
-- The database never stores either secret: only sha256 digests. The host never learns a phone, an Auth
-- id, a binding or a Participant. The mechanism proves a verified, event-bound identity held the
-- credential and the code; it does NOT prove who that person is, or that the person standing in front of
-- the host is the one the entry is for — the host must verify that at the venue (see the functions'
-- commentary for the exact operational duty).
--
-- Invariants the TABLE enforces, whatever calls it:
--   * an entry's pending/confirmed binding belongs to the SAME Instance (composite foreign keys);
--   * a binding is pending or confirmed on at most one entry (unique constraints; the guard trigger
--     closes the pending-on-one / confirmed-on-another gap);
--   * an entry is never both pending and confirmed; it holds a claim credential only while unclaimed;
--   * labels are unique per Instance ignoring case; positions are unique per Instance;
--   * candidate_id may be set only on a confirmed entry (it is set once, at start).
--
-- Rows are mutable only until the ballot opens; the guard triggers (migration 20261020190300) freeze them
-- the moment the Session has any interaction.

create table community_voting_entries (
  entry_id                uuid primary key default gen_random_uuid(),
  instance_id             uuid not null references community_voting_instances (instance_id) on delete restrict,

  ordinal                 integer not null,
  label                   text not null,

  -- sha256 hex of the claim credential; present only while the entry is unclaimed.
  claim_code_hash         text null,
  claim_window_seconds    integer not null,
  claim_expires_at        timestamptz not null,

  pending_binding_id      uuid null,
  confirmation_code_hash  text null,
  confirmation_expires_at timestamptz null,
  confirmation_failures   integer not null default 0,

  confirmed_binding_id    uuid null,
  confirmed_at            timestamptz null,

  -- Set once, at start: a REFERENCE to the authoritative candidate this entry became. Not a copy.
  candidate_id            uuid null references voting_candidates (candidate_id) on delete restrict,

  created_at              timestamptz not null default now(),

  constraint community_voting_entries_instance_ordinal_unique unique (instance_id, ordinal),
  constraint community_voting_entries_pending_binding_fkey
    foreign key (pending_binding_id, instance_id)
    references community_voting_voter_bindings (binding_id, instance_id) on delete restrict,
  constraint community_voting_entries_confirmed_binding_fkey
    foreign key (confirmed_binding_id, instance_id)
    references community_voting_voter_bindings (binding_id, instance_id) on delete restrict,
  constraint community_voting_entries_pending_binding_unique unique (pending_binding_id),
  constraint community_voting_entries_confirmed_binding_unique unique (confirmed_binding_id),
  constraint community_voting_entries_candidate_unique unique (candidate_id),

  constraint community_voting_entries_label_shape check (label = btrim(label) and char_length(label) between 1 and 60),
  constraint community_voting_entries_window_range check (claim_window_seconds between 1 and 86400),
  constraint community_voting_entries_failures_range check (confirmation_failures between 0 and 5),
  constraint community_voting_entries_not_both check (not (pending_binding_id is not null and confirmed_binding_id is not null)),
  constraint community_voting_entries_pending_code_together check (
    (pending_binding_id is null) = (confirmation_code_hash is null)
    and (pending_binding_id is null) = (confirmation_expires_at is null)
  ),
  constraint community_voting_entries_confirmed_together check ((confirmed_binding_id is null) = (confirmed_at is null)),
  constraint community_voting_entries_claim_only_while_unclaimed check (
    claim_code_hash is null or (pending_binding_id is null and confirmed_binding_id is null)
  ),
  constraint community_voting_entries_candidate_needs_confirmation check (candidate_id is null or confirmed_binding_id is not null),
  constraint community_voting_entries_digest_shape check (
    (claim_code_hash is null or claim_code_hash ~ '^[0-9a-f]{64}$')
    and (confirmation_code_hash is null or confirmation_code_hash ~ '^[0-9a-f]{64}$')
  )
);

create unique index community_voting_entries_instance_label_unique
  on community_voting_entries (instance_id, lower(label));

-- Postgres never indexes the referencing side of a foreign key; the claim lookup also reads by digest.
create index community_voting_entries_claim_code_hash_idx
  on community_voting_entries (instance_id, claim_code_hash) where claim_code_hash is not null;

-- ---------------------------------------------------------------------------------------
-- History guards (precedent: competition_host_reject_history_loss and friends).
-- ---------------------------------------------------------------------------------------

create function community_voting_reject_history_loss()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  raise exception 'COMMUNITY_VOTING_HISTORY_IMMUTABLE: Community Voting records cannot be deleted or truncated'
    using errcode = 'P0001';
end;
$$;

create function community_voting_guard_instance_update()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  raise exception 'COMMUNITY_VOTING_HISTORY_IMMUTABLE: a registered Community Voting Instance cannot be changed'
    using errcode = 'P0001';
end;
$$;

create function community_voting_guard_binding_update()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if old.binding_id is distinct from new.binding_id
     or old.instance_id is distinct from new.instance_id
     or old.auth_user_id is distinct from new.auth_user_id
     or old.participant_id is distinct from new.participant_id
     or old.created_at is distinct from new.created_at then
    raise exception 'COMMUNITY_VOTING_HISTORY_IMMUTABLE: a voter binding cannot be re-assigned'
      using errcode = 'P0001';
  end if;

  if new.issued_intent_no < old.issued_intent_no
     or new.applied_intent_no < old.applied_intent_no then
    raise exception 'COMMUNITY_VOTING_HISTORY_IMMUTABLE: intent counters never move backwards'
      using errcode = 'P0001';
  end if;

  return new;
end;
$$;

create trigger community_voting_instances_no_delete
  before delete on community_voting_instances
  for each row execute function community_voting_reject_history_loss();
create trigger community_voting_instances_no_truncate
  before truncate on community_voting_instances
  for each statement execute function community_voting_reject_history_loss();
create trigger community_voting_instances_no_update
  before update on community_voting_instances
  for each row execute function community_voting_guard_instance_update();

create trigger community_voting_voter_bindings_no_delete
  before delete on community_voting_voter_bindings
  for each row execute function community_voting_reject_history_loss();
create trigger community_voting_voter_bindings_no_truncate
  before truncate on community_voting_voter_bindings
  for each statement execute function community_voting_reject_history_loss();
create trigger community_voting_voter_bindings_guard_update
  before update on community_voting_voter_bindings
  for each row execute function community_voting_guard_binding_update();

revoke execute on function community_voting_reject_history_loss() from public, anon, authenticated;
revoke execute on function community_voting_guard_instance_update() from public, anon, authenticated;
revoke execute on function community_voting_guard_binding_update() from public, anon, authenticated;

-- ---------------------------------------------------------------------------------------
-- Row-level security and privileges
-- ---------------------------------------------------------------------------------------

alter table community_voting_instances enable row level security;
alter table community_voting_voter_bindings enable row level security;
alter table community_voting_entries enable row level security;

revoke all on community_voting_instances from anon, authenticated;
revoke all on community_voting_voter_bindings from anon, authenticated;
revoke all on community_voting_entries from anon, authenticated;

-- service_role keeps what it needs and loses what would let history be rewritten. The triggers
-- above are the backstop for the table owner; these revokes are the first line for the API role.
revoke update, delete, truncate on community_voting_instances from service_role;
revoke delete, truncate on community_voting_voter_bindings from service_role;

-- Preparation entries are working data until the ballot opens, so they may be updated and removed by the
-- functions (the guard triggers freeze them from the moment of opening). They are never truncated.
revoke truncate on community_voting_entries from service_role;
