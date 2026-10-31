-- Migration: 20261029100000_community_voting_two_round_foundation
-- Halloween Community Voting pilot — the two-round journey (UG-IV-GATE-004A, corrected by UG-IV-GATE-005 / 005A).
--
-- ADDITIVE over the GATE-003 foundation (20261020190000..190300), which it does not edit, and SELF-CONTAINED: it is the ONLY migration of
-- the pilot's data model. It carries the contestant preparation (photographs, consent, the operator's decision, withdrawals, the
-- schedule), the finalist cut, the review and the publication — and nothing of the superseded five-option ballot or of the telephone-
-- possession steps, which are not part of the pilot and are not installed.
--
-- ---------------------------------------------------------------------------------------
-- The approved journey (UG-IV-GATE-004A / 005A)
-- ---------------------------------------------------------------------------------------
--   Two rounds, both voted INSIDE URBANO Gaming (Instagram promotes and links; no vote is ever read from it):
--     PRELIMINARY - anywhere, no geofence, one favorite per identity, revisable until the round closes;
--     FINAL       - only people at the venue (the geofence is evaluated for EVERY vote and EVERY revision), only the finalists,
--                   starts from zero, lasts 300 seconds from its explicit, authoritative opening.
--   Two Instances of two Sessions: their votes are separate rows in the unchanged Voting store, the same identity can vote in both,
--   and nothing accumulates. The finalists are the ten best contestants plus every contestant tied with the tenth — subject to the
--   Product policies that are still pending (see community_voting_policy_approvals). Ties for the final win are shared.
--   To vote a person needs a Supabase Auth session whose EMAIL is confirmed AND a Gaming Member profile. No telephone, WhatsApp or SMS.
--
-- ---------------------------------------------------------------------------------------
-- Six separate things (UG-IV-GATE-005 section 6) — each has its own record and none rewrites another
-- ---------------------------------------------------------------------------------------
--   1. photograph VISIBILITY  - community_voting_photo_privacy_actions (+ the photograph's own state). Hiding a photograph never
--                               decides the competition.
--   2. candidature WITHDRAWAL - community_voting_withdrawals. Excludes a contestant from every ranking; never deletes a vote.
--   3. vote EVIDENCE          - `votes` (the unchanged Voting store). No function in this migration deletes or edits a vote.
--   4. finalist SELECTION     - community_voting_finalist_selections / community_voting_finalists, append-only. A withdrawal after
--                               it neither edits it nor fills the place: the consequence is a pending Product policy that blocks.
--   5. reviewed RESULT        - community_voting_round_reviews: a digest of the closed result AND of who is eligible AND of the
--                               approved policies; anything that changes one of them makes the review stale.
--   6. PUBLISHED result       - community_voting_publications + community_voting_published_results: a snapshot, immutable.
--
-- ---------------------------------------------------------------------------------------
-- Retention: NOTHING in this change decides a period
-- ---------------------------------------------------------------------------------------
-- The "approximately 72 hours" in the hand-off is an aim the hand-off itself says to return as "an explicit blocker for legal/product
-- approval rather than guessing". It is not an approved policy, so it has NO operational effect here: no closure carries a removal
-- instant, public display is never cut by time, and nothing erases a photograph because time has passed. A photograph's bytes are
-- erased only by an explicit act: a rejection, a replacement, or a privacy action. Erasing bytes is NOT claimed to be legal erasure
-- or retention compliance: the metadata, the consents, the decisions and the audit trail are kept.

-- ---------------------------------------------------------------------------------------
-- The Instance: a round, with its operator and (for the final) its venue
-- ---------------------------------------------------------------------------------------

alter table community_voting_instances
  add column ballot_mode                text not null default 'SINGLE_CHOICE',
  add column operator_gaming_member_id  uuid null references gaming_members (gaming_member_id) on delete restrict,
  add column round_role                 text null,
  add column source_instance_id         uuid null references community_voting_instances (instance_id) on delete restrict,
  add column window_seconds             integer null,
  add column finalist_cutoff            integer null;

alter table community_voting_instances alter column venue_latitude drop not null;
alter table community_voting_instances alter column venue_longitude drop not null;
alter table community_voting_instances alter column venue_radius_meters drop not null;
alter table community_voting_instances alter column max_accuracy_meters drop not null;
alter table community_voting_instances alter column inside_margin_factor drop not null;
alter table community_voting_instances alter column outside_margin_factor drop not null;

alter table community_voting_instances
  add constraint community_voting_instances_ballot_mode_values check (ballot_mode in ('SINGLE_CHOICE', 'FAVORITE_ROUND')),
  add constraint community_voting_instances_geofence_by_mode check (
    (
      -- the GATE-003 foundation: a mandatory geofence
      ballot_mode = 'SINGLE_CHOICE'
      and venue_latitude is not null and venue_longitude is not null and venue_radius_meters is not null
      and max_accuracy_meters is not null and inside_margin_factor is not null and outside_margin_factor is not null
    )
    or
    (
      -- the pilot's preliminary: NO geofence at all
      ballot_mode = 'FAVORITE_ROUND' and round_role = 'PRELIMINARY'
      and venue_latitude is null and venue_longitude is null and venue_radius_meters is null
      and max_accuracy_meters is null and inside_margin_factor is null and outside_margin_factor is null
    )
    or
    (
      -- the pilot's final: the whole geofence
      ballot_mode = 'FAVORITE_ROUND' and round_role = 'FINAL'
      and venue_latitude is not null and venue_longitude is not null and venue_radius_meters is not null
      and max_accuracy_meters is not null and inside_margin_factor is not null and outside_margin_factor is not null
    )
  ),
  -- A round names the ONE Gaming Member who may operate it; a GATE-003 Instance names none.
  add constraint community_voting_instances_operator_by_mode check (
    (ballot_mode = 'FAVORITE_ROUND') = (operator_gaming_member_id is not null)
  ),
  -- Round facts exist only on a round, and each role carries exactly its own:
  --   PRELIMINARY: the finalist cutoff (ten, recorded so the rule is evidence), no source, no window;
  --   FINAL:       the Instance it descends from and its voting window, no cutoff.
  add constraint community_voting_instances_round_facts check (
    (ballot_mode <> 'FAVORITE_ROUND'
       and round_role is null and source_instance_id is null and window_seconds is null and finalist_cutoff is null)
    or
    (ballot_mode = 'FAVORITE_ROUND' and round_role = 'PRELIMINARY'
       and source_instance_id is null and window_seconds is null and finalist_cutoff between 1 and 1000)
    or
    (ballot_mode = 'FAVORITE_ROUND' and round_role = 'FINAL'
       and source_instance_id is not null and window_seconds between 10 and 3600 and finalist_cutoff is null)
  );

create index community_voting_instances_operator_idx
  on community_voting_instances (operator_gaming_member_id) where operator_gaming_member_id is not null;

-- One final per preliminary.
create unique index community_voting_instances_source_unique
  on community_voting_instances (source_instance_id) where source_instance_id is not null;

-- A final descends from a PRELIMINARY round of the same operator. A CHECK cannot see another row, so the guard is a trigger.
create function community_voting_guard_instance_insert()
returns trigger
language plpgsql
set search_path = public
as $$
declare
  v_source community_voting_instances%rowtype;
begin
  if new.ballot_mode is distinct from 'FAVORITE_ROUND' or new.round_role is distinct from 'FINAL' then
    return new;
  end if;

  select * into v_source from community_voting_instances i where i.instance_id = new.source_instance_id;
  if not found
     or v_source.ballot_mode is distinct from 'FAVORITE_ROUND'
     or v_source.round_role is distinct from 'PRELIMINARY'
     or v_source.operator_gaming_member_id is distinct from new.operator_gaming_member_id then
    raise exception 'CV_INVALID_REQUEST: a final must descend from a preliminary round of the same operator'
      using errcode = 'P0001';
  end if;
  return new;
end;
$$;

create trigger community_voting_instances_guard_insert
  before insert on community_voting_instances
  for each row execute function community_voting_guard_instance_insert();

-- ---------------------------------------------------------------------------------------
-- The binding: the canonical identity behind it
-- ---------------------------------------------------------------------------------------
--
-- A pilot binding is per ROUND and always points at the one canonical identity: the Supabase Auth user and the Gaming Member that
-- belongs to it (gaming_members.auth_user_id is unique, so there is exactly one). It is set by a trigger from the database's own
-- records, never from a caller. No second identity and no second profile are ever created. claim_failures counts a contestant's wrong
-- claim codes so that a 60-bit code cannot be walked.

alter table community_voting_voter_bindings
  add column gaming_member_id uuid null references gaming_members (gaming_member_id) on delete restrict,
  add column claim_failures integer not null default 0;

alter table community_voting_voter_bindings
  add constraint community_voting_voter_bindings_claim_failures_range check (claim_failures between 0 and 1000);

create unique index community_voting_voter_bindings_member_unique
  on community_voting_voter_bindings (instance_id, gaming_member_id) where gaming_member_id is not null;

-- A preliminary vote carries no location, so the derived location evidence is present on both columns or on neither (an applied intent
-- still needs its digest and its time). The GATE-003 function keeps writing both, because it requires a reading.
alter table community_voting_voter_bindings drop constraint community_voting_voter_bindings_applied_evidence_together;
alter table community_voting_voter_bindings
  add constraint community_voting_voter_bindings_applied_evidence_together check (
    (applied_intent_no = 0 and applied_payload_digest is null and applied_at is null
       and applied_distance_meters is null and applied_accuracy_meters is null)
    or
    (applied_intent_no > 0 and applied_payload_digest is not null and applied_at is not null
       and ((applied_distance_meters is not null) = (applied_accuracy_meters is not null)))
  );

-- ---------------------------------------------------------------------------------------
-- Entries: a final's entry REFERENCES the preliminary entry it descends from
-- ---------------------------------------------------------------------------------------
--
-- The photograph, the contestant's consent and the operator's decision belong to the person, not to a round, so a final entry does not
-- copy them: it points at the preliminary entry (source_entry_id) and the media state is resolved through it. A photograph that is
-- hidden for privacy is therefore hidden in both rounds, and no photograph is stored twice.

alter table community_voting_entries
  add constraint community_voting_entries_entry_instance_unique unique (entry_id, instance_id);

alter table community_voting_entries
  add column source_entry_id uuid null references community_voting_entries (entry_id) on delete restrict;

create unique index community_voting_entries_source_unique
  on community_voting_entries (source_entry_id) where source_entry_id is not null;

-- ---------------------------------------------------------------------------------------
-- The schedule: configuration, binding once the round opens
-- ---------------------------------------------------------------------------------------
--
-- Times are instants (timestamptz); the event's zone (America/Tegucigalpa) is a presentation fact of the pages, never of the database.
-- Editable only BEFORE the round opens, and then frozen (a guard): an opened round's deadline is never edited, extended or shortened
-- silently. What binds:
--   contestant_cutoff_at - a new contestant or a new photograph is refused at or after it;
--   voting_closes_at     - the PRELIMINARY's deadline: no vote is accepted at or after it, whether or not the operator has closed the
--                          round, and a preliminary cannot be opened without one. (A late opening shortens the window; it never moves
--                          the deadline.) The final has no configured deadline: its deadline is its opening plus its window.
-- registration_opens_at and voting_opens_at are information shown to the public: opening is ALWAYS the operator's explicit act.

create table community_voting_schedules (
  instance_id            uuid primary key references community_voting_instances (instance_id) on delete restrict,
  registration_opens_at  timestamptz null,
  contestant_cutoff_at   timestamptz null,
  voting_opens_at        timestamptz null,
  voting_closes_at       timestamptz null,
  status                 text not null default 'TENTATIVE',
  updated_at             timestamptz not null default now(),
  updated_by_member_id   uuid not null references gaming_members (gaming_member_id) on delete restrict,

  constraint community_voting_schedules_status_values check (status in ('TENTATIVE', 'CONFIRMED')),
  constraint community_voting_schedules_order check (
    (registration_opens_at is null or contestant_cutoff_at is null or registration_opens_at <= contestant_cutoff_at)
    and (contestant_cutoff_at is null or voting_opens_at is null or contestant_cutoff_at <= voting_opens_at)
    and (voting_opens_at is null or voting_closes_at is null or voting_opens_at < voting_closes_at)
    and (contestant_cutoff_at is null or voting_closes_at is null or contestant_cutoff_at < voting_closes_at)
  )
);

-- ---------------------------------------------------------------------------------------
-- Contestant photographs (bytes live here; nothing else holds them)
-- ---------------------------------------------------------------------------------------
--
-- Two renditions per upload: a full picture and a thumbnail, both JPEG with all metadata stripped by the server before they reach this
-- table. One row per upload, never edited except to ERASE the bytes. The "current" photograph of an entry is its newest row. Approval,
-- consent, privacy actions and withdrawal are separate append-only records that point at it. The bytes are erased ONLY by an explicit
-- act: REJECTED (the operator's decision), SUPERSEDED (a newer photograph replaced it) or PRIVACY_REQUEST (the person's request).

create table community_voting_entry_photos (
  photo_id              uuid primary key default gen_random_uuid(),
  instance_id           uuid not null,
  entry_id              uuid not null,
  content_type          text not null default 'image/jpeg',
  width                 integer not null,
  height                integer not null,
  full_bytes            bytea null,
  thumb_bytes           bytea null,
  full_sha256           text not null,
  thumb_sha256          text not null,
  full_size             integer not null,
  thumb_size            integer not null,
  uploaded_by_member_id uuid not null references gaming_members (gaming_member_id) on delete restrict,
  created_at            timestamptz not null default now(),
  bytes_deleted_at      timestamptz null,
  bytes_deleted_reason  text null,

  constraint community_voting_entry_photos_entry_fkey
    foreign key (entry_id, instance_id) references community_voting_entries (entry_id, instance_id) on delete restrict,
  constraint community_voting_entry_photos_content_type check (content_type = 'image/jpeg'),
  constraint community_voting_entry_photos_dimensions check (width between 1 and 4000 and height between 1 and 4000),
  constraint community_voting_entry_photos_digest_shape check (full_sha256 ~ '^[0-9a-f]{64}$' and thumb_sha256 ~ '^[0-9a-f]{64}$'),
  constraint community_voting_entry_photos_size_range check (full_size between 1 and 1500000 and thumb_size between 1 and 150000),
  constraint community_voting_entry_photos_bytes_together check (
    (full_bytes is null) = (thumb_bytes is null) and (full_bytes is null) = (bytes_deleted_at is not null)
  ),
  constraint community_voting_entry_photos_reason_values check (
    bytes_deleted_reason is null or bytes_deleted_reason in ('REJECTED', 'SUPERSEDED', 'PRIVACY_REQUEST')
  ),
  constraint community_voting_entry_photos_reason_with_deletion check ((bytes_deleted_reason is null) = (bytes_deleted_at is null))
);

create index community_voting_entry_photos_entry_idx on community_voting_entry_photos (entry_id, created_at desc);

-- ---------------------------------------------------------------------------------------
-- Consent (gallery and contest) and the operator's decision, each pointing at ONE photograph
-- ---------------------------------------------------------------------------------------
--
-- The consent statement names "esta fotografía", so a consent belongs to a specific photograph and is void for any other: replacing the
-- picture means asking again. It is the GALLERY-AND-CONTEST consent — what a contestant needs to compete. The promotional decision is a
-- separate, optional record below. statement_sha256 pins the exact text accepted; consent_version names it.

create table community_voting_entry_consents (
  consent_id            uuid primary key default gen_random_uuid(),
  instance_id           uuid not null,
  entry_id              uuid not null,
  photo_id              uuid not null unique references community_voting_entry_photos (photo_id) on delete restrict,
  consent_version       text not null,
  statement_sha256      text not null,
  acceptance_method     text not null default 'OPERATOR_TABLET_CHECKBOX',
  age_confirmed         boolean not null,
  accepted_at           timestamptz not null default now(),
  recorded_by_member_id uuid not null references gaming_members (gaming_member_id) on delete restrict,

  constraint community_voting_entry_consents_entry_fkey
    foreign key (entry_id, instance_id) references community_voting_entries (entry_id, instance_id) on delete restrict,
  constraint community_voting_entry_consents_version_shape check (consent_version ~ '^[A-Za-z0-9._-]{1,64}$'),
  constraint community_voting_entry_consents_statement_shape check (statement_sha256 ~ '^[0-9a-f]{64}$'),
  constraint community_voting_entry_consents_method_values check (acceptance_method in ('OPERATOR_TABLET_CHECKBOX')),
  constraint community_voting_entry_consents_age_confirmed check (age_confirmed)
);

create table community_voting_photo_decisions (
  decision_id          uuid primary key default gen_random_uuid(),
  instance_id          uuid not null,
  entry_id             uuid not null,
  photo_id             uuid not null unique references community_voting_entry_photos (photo_id) on delete restrict,
  decision             text not null,
  reason               text null,
  decided_by_member_id uuid not null references gaming_members (gaming_member_id) on delete restrict,
  decided_at           timestamptz not null default now(),

  constraint community_voting_photo_decisions_entry_fkey
    foreign key (entry_id, instance_id) references community_voting_entries (entry_id, instance_id) on delete restrict,
  constraint community_voting_photo_decisions_values check (decision in ('APPROVED', 'REJECTED')),
  constraint community_voting_photo_decisions_reason_length check (reason is null or char_length(reason) between 1 and 300)
);

-- ---------------------------------------------------------------------------------------
-- (1) Photograph visibility: the privacy action
-- ---------------------------------------------------------------------------------------
--
-- A person's request that their photograph stop being shown. It takes effect at once (the photograph is no longer served and its bytes
-- are erased) and it decides NOTHING about the competition: the candidature, the votes, the selection and the results are untouched.
-- Recorded once per person (on the entry that owns the photograph), append-only. Erasing bytes is not claimed to be legal erasure.

create table community_voting_photo_privacy_actions (
  action_id             uuid primary key default gen_random_uuid(),
  instance_id           uuid not null,
  entry_id              uuid not null unique,
  reason                text not null,
  performed_at          timestamptz not null default now(),
  performed_by_member_id uuid not null references gaming_members (gaming_member_id) on delete restrict,

  constraint community_voting_photo_privacy_actions_entry_fkey
    foreign key (entry_id, instance_id) references community_voting_entries (entry_id, instance_id) on delete restrict,
  constraint community_voting_photo_privacy_actions_reason_length check (char_length(reason) between 1 and 300)
);

-- ---------------------------------------------------------------------------------------
-- (2) Candidature withdrawal
-- ---------------------------------------------------------------------------------------
--
-- Append-only and independent of the entries table, because the entries are frozen the moment Voting opens and a withdrawal MUST remain
-- possible afterwards. It excludes the contestant from every ranking and from public discovery and prevents any new vote for them. It
-- NEVER deletes or edits a vote, never edits a finalist selection, and never rewrites a published result.

create table community_voting_withdrawals (
  withdrawal_id         uuid primary key default gen_random_uuid(),
  instance_id           uuid not null,
  entry_id              uuid not null unique,
  candidate_id          uuid null references voting_candidates (candidate_id) on delete restrict,
  reason                text not null,
  withdrawn_at          timestamptz not null default now(),
  recorded_by_member_id uuid not null references gaming_members (gaming_member_id) on delete restrict,

  constraint community_voting_withdrawals_entry_fkey
    foreign key (entry_id, instance_id) references community_voting_entries (entry_id, instance_id) on delete restrict,
  constraint community_voting_withdrawals_reason_length check (char_length(reason) between 1 and 300)
);

create index community_voting_withdrawals_candidate_idx on community_voting_withdrawals (candidate_id) where candidate_id is not null;

-- ---------------------------------------------------------------------------------------
-- The closure record: the immutable commitment to the closed result
-- ---------------------------------------------------------------------------------------

create table community_voting_closures (
  instance_id             uuid primary key references community_voting_instances (instance_id) on delete restrict,
  interaction_instance_id uuid not null references interaction_instances (interaction_instance_id) on delete restrict,
  closed_at               timestamptz not null default now(),
  closed_by_member_id     uuid not null references gaming_members (gaming_member_id) on delete restrict,
  valid_vote_count        integer not null,
  results_digest          text not null,

  constraint community_voting_closures_count_nonneg check (valid_vote_count >= 0),
  constraint community_voting_closures_digest_shape check (results_digest ~ '^[0-9a-f]{64}$')
);

-- ---------------------------------------------------------------------------------------
-- (4) Finalist selection: the deterministic cut, recorded once
-- ---------------------------------------------------------------------------------------
--
-- The header commits to the rule, the numbers and a digest of the cut; the rows are the contestants who advance. Both are written by
-- select_community_voting_finalists_atomically from the Voting store's own votes, take no list from the caller, and are append-only.
-- A contestant who later withdraws stays in this evidence: nothing here is edited, and nobody is added in their place.

create table community_voting_finalist_selections (
  preliminary_instance_id uuid primary key references community_voting_instances (instance_id) on delete restrict,
  interaction_instance_id uuid not null references interaction_instances (interaction_instance_id) on delete restrict,
  rule                    text not null,
  cutoff_size             integer not null,
  eligible_count          integer not null,
  finalist_count          integer not null,
  selection_digest        text not null,
  selected_at             timestamptz not null default now(),
  selected_by_member_id   uuid not null references gaming_members (gaming_member_id) on delete restrict,

  constraint community_voting_finalist_selections_rule_values check (rule = 'TOP_N_WITH_CUTOFF_TIES_V1'),
  constraint community_voting_finalist_selections_counts check (
    cutoff_size >= 1 and eligible_count >= 1 and finalist_count between 1 and eligible_count
  ),
  constraint community_voting_finalist_selections_digest_shape check (selection_digest ~ '^[0-9a-f]{64}$')
);

create table community_voting_finalists (
  preliminary_instance_id uuid not null references community_voting_finalist_selections (preliminary_instance_id) on delete restrict,
  entry_id                uuid not null references community_voting_entries (entry_id) on delete restrict,
  candidate_id            uuid not null references voting_candidates (candidate_id) on delete restrict,
  competition_rank        integer not null,
  votes_at_selection      bigint not null,

  primary key (preliminary_instance_id, entry_id),
  constraint community_voting_finalists_candidate_unique unique (candidate_id),
  constraint community_voting_finalists_rank_positive check (competition_rank >= 1),
  constraint community_voting_finalists_votes_nonneg check (votes_at_selection >= 0)
);

-- ---------------------------------------------------------------------------------------
-- Pending Product policies: the approvals that unblock a consequential operation
-- ---------------------------------------------------------------------------------------
--
-- Three questions are Product's to answer and have NOT been answered, so the operations that depend on them FAIL CLOSED (they raise
-- CV_POLICY_REQUIRED naming the key) until an approval is recorded here, with the reference of the decision. Nothing is approved by
-- default and nothing infers an approval. Only the value the system can actually execute is accepted for each key — approving
-- something else would need a code change, not a click.
--   ZERO_VALID_VOTES_PRELIMINARY        ALL_ENTRIES_ADVANCE              nobody voted for an eligible contestant: may everyone advance?
--   ZERO_VOTE_ENTRIES_AT_CUTOFF         TIED_ZERO_VOTE_ENTRIES_ADVANCE   may a contestant with no votes advance because of the cut?
--   FINALIST_WITHDRAWAL_AFTER_SELECTION EXCLUDE_WITHOUT_REFILL           a finalist withdrew after the cut: the final goes on without them,
--                                                                        nobody takes their place and the selection is not edited.
-- An approval on a preliminary also applies to its final; one is recorded once and never changed (append-only). It is the designated
-- operator who records it, citing the decision; the reference is evidence for the reviewer, not something the system can verify.

create table community_voting_policy_approvals (
  approval_id            uuid primary key default gen_random_uuid(),
  instance_id            uuid not null references community_voting_instances (instance_id) on delete restrict,
  policy_key             text not null,
  policy_value           text not null,
  approval_reference     text not null,
  approved_by_member_id  uuid not null references gaming_members (gaming_member_id) on delete restrict,
  approved_at            timestamptz not null default now(),

  constraint community_voting_policy_approvals_unique unique (instance_id, policy_key),
  constraint community_voting_policy_approvals_key_value check (
    (policy_key = 'ZERO_VALID_VOTES_PRELIMINARY' and policy_value = 'ALL_ENTRIES_ADVANCE')
    or (policy_key = 'ZERO_VOTE_ENTRIES_AT_CUTOFF' and policy_value = 'TIED_ZERO_VOTE_ENTRIES_ADVANCE')
    or (policy_key = 'FINALIST_WITHDRAWAL_AFTER_SELECTION' and policy_value = 'EXCLUDE_WITHOUT_REFILL')
  ),
  constraint community_voting_policy_approvals_reference_length check (char_length(btrim(approval_reference)) between 3 and 200)
);

-- ---------------------------------------------------------------------------------------
-- (5) The reviewed result and (6) the published result
-- ---------------------------------------------------------------------------------------
--
-- A review is the operator's recorded confirmation that they looked at the CLOSED result; it commits to a digest of the result, of the
-- cut, of who has withdrawn and of the approved policies. A publication reveals the round through the Session's own reveal, is refused
-- unless a review of the CURRENT state exists, and freezes what was announced in community_voting_published_results — a snapshot that
-- nothing rewrites afterwards. A later withdrawal is flagged to the operator; it does not change what was announced.

create table community_voting_round_reviews (
  review_id             uuid primary key default gen_random_uuid(),
  instance_id           uuid not null references community_voting_instances (instance_id) on delete restrict,
  results_digest        text not null,
  reviewed_at           timestamptz not null default now(),
  reviewed_by_member_id uuid not null references gaming_members (gaming_member_id) on delete restrict,
  note                  text null,

  constraint community_voting_round_reviews_digest_shape check (results_digest ~ '^[0-9a-f]{64}$'),
  constraint community_voting_round_reviews_note_length check (note is null or char_length(note) between 1 and 300)
);

create index community_voting_round_reviews_instance_idx on community_voting_round_reviews (instance_id, reviewed_at desc);

create table community_voting_publications (
  instance_id            uuid primary key references community_voting_instances (instance_id) on delete restrict,
  review_id              uuid not null references community_voting_round_reviews (review_id) on delete restrict,
  results_digest         text not null,
  published_at           timestamptz not null default now(),
  published_by_member_id uuid not null references gaming_members (gaming_member_id) on delete restrict,

  constraint community_voting_publications_digest_shape check (results_digest ~ '^[0-9a-f]{64}$')
);

-- What was announced: the finalists (preliminary) or the winners (final) — a public number and its order, NEVER a count.
create table community_voting_published_results (
  instance_id uuid not null references community_voting_publications (instance_id) on delete restrict,
  entry_id    uuid not null references community_voting_entries (entry_id) on delete restrict,
  kind        text not null,
  alias       text not null,
  ordinal     integer not null,

  primary key (instance_id, entry_id),
  constraint community_voting_published_results_kind_values check (kind in ('FINALISTS', 'WINNERS'))
);

-- ---------------------------------------------------------------------------------------
-- Promotional consent: a SEPARATE decision from the gallery/contest consent
-- ---------------------------------------------------------------------------------------
--
-- Optional, with its own statement and version; DECLINED never prevents competing. The latest row per entry is the current decision; a
-- later WITHDRAWN row revokes an earlier ACCEPTED one. Append-only. A withdrawal after an acceptance also opens a follow-up task: the
-- system records the request and the pending operational work, and does NOT claim to remove anything published outside it.

create table community_voting_promo_consents (
  promo_consent_id      uuid primary key default gen_random_uuid(),
  instance_id           uuid not null,
  entry_id              uuid not null,
  decision              text not null,
  consent_version       text not null,
  statement_sha256      text not null,
  recorded_at           timestamptz not null default now(),
  recorded_by_member_id uuid not null references gaming_members (gaming_member_id) on delete restrict,

  constraint community_voting_promo_consents_entry_fkey
    foreign key (entry_id, instance_id) references community_voting_entries (entry_id, instance_id) on delete restrict,
  constraint community_voting_promo_consents_decision_values check (decision in ('ACCEPTED', 'DECLINED', 'WITHDRAWN')),
  constraint community_voting_promo_consents_version_shape check (consent_version ~ '^[A-Za-z0-9._-]{1,64}$'),
  constraint community_voting_promo_consents_statement_shape check (statement_sha256 ~ '^[0-9a-f]{64}$')
);

create index community_voting_promo_consents_entry_idx on community_voting_promo_consents (entry_id, recorded_at desc);

create table community_voting_followup_tasks (
  task_id              uuid primary key default gen_random_uuid(),
  instance_id          uuid not null,
  entry_id             uuid not null,
  kind                 text not null,
  status               text not null default 'PENDING',
  description          text not null,
  created_at           timestamptz not null default now(),
  created_by_member_id uuid not null references gaming_members (gaming_member_id) on delete restrict,
  resolved_at          timestamptz null,
  resolved_by_member_id uuid null references gaming_members (gaming_member_id) on delete restrict,
  resolution_note      text null,

  constraint community_voting_followup_tasks_entry_fkey
    foreign key (entry_id, instance_id) references community_voting_entries (entry_id, instance_id) on delete restrict,
  constraint community_voting_followup_tasks_kind_values check (kind in ('EXTERNAL_PROMO_REMOVAL')),
  constraint community_voting_followup_tasks_status_values check (status in ('PENDING', 'DONE')),
  constraint community_voting_followup_tasks_resolution_together check (
    (status = 'PENDING' and resolved_at is null and resolved_by_member_id is null and resolution_note is null)
    or (status = 'DONE' and resolved_at is not null and resolved_by_member_id is not null and resolution_note is not null)
  ),
  constraint community_voting_followup_tasks_note_length check (resolution_note is null or char_length(resolution_note) between 1 and 300)
);

create index community_voting_followup_tasks_instance_idx on community_voting_followup_tasks (instance_id, created_at);

-- ---------------------------------------------------------------------------------------
-- The operator's audit trail
-- ---------------------------------------------------------------------------------------
--
-- One row per consequential operator act. `detail` carries references and bounded facts only (ids, decisions, counts, times) — never an
-- email, a token, a code, a photograph or free text from a person.

create table community_voting_operator_actions (
  action_id          uuid primary key default gen_random_uuid(),
  instance_id        uuid not null references community_voting_instances (instance_id) on delete restrict,
  operator_member_id uuid not null references gaming_members (gaming_member_id) on delete restrict,
  action             text not null,
  entry_id           uuid null,
  detail             jsonb not null default '{}'::jsonb,
  occurred_at        timestamptz not null default now(),

  constraint community_voting_operator_actions_values check (action in (
    'REGISTER_INSTANCE', 'SET_SCHEDULE', 'CREATE_ENTRY', 'REMOVE_ENTRY', 'UPLOAD_PHOTO', 'RECORD_CONSENT', 'APPROVE_PHOTO',
    'REJECT_PHOTO', 'CONFIRM_ASSOCIATION', 'OPEN_VOTING', 'CLOSE_VOTING', 'WITHDRAW_CANDIDATURE', 'HIDE_PHOTO',
    'SELECT_FINALISTS', 'PREPARE_FINAL', 'REVIEW_RESULTS', 'PUBLISH_RESULTS', 'RECORD_PROMO_CONSENT',
    'RECORD_POLICY_APPROVAL', 'RESOLVE_FOLLOWUP_TASK'
  )),
  constraint community_voting_operator_actions_detail_is_object check (jsonb_typeof(detail) = 'object')
);

create index community_voting_operator_actions_instance_idx on community_voting_operator_actions (instance_id, occurred_at);

-- ---------------------------------------------------------------------------------------
-- Row-level security and privileges (service_role only; nothing is ever deleted)
-- ---------------------------------------------------------------------------------------

alter table community_voting_schedules enable row level security;
alter table community_voting_entry_photos enable row level security;
alter table community_voting_entry_consents enable row level security;
alter table community_voting_photo_decisions enable row level security;
alter table community_voting_photo_privacy_actions enable row level security;
alter table community_voting_withdrawals enable row level security;
alter table community_voting_closures enable row level security;
alter table community_voting_finalist_selections enable row level security;
alter table community_voting_finalists enable row level security;
alter table community_voting_policy_approvals enable row level security;
alter table community_voting_round_reviews enable row level security;
alter table community_voting_publications enable row level security;
alter table community_voting_published_results enable row level security;
alter table community_voting_promo_consents enable row level security;
alter table community_voting_followup_tasks enable row level security;
alter table community_voting_operator_actions enable row level security;

revoke all on community_voting_schedules from anon, authenticated;
revoke all on community_voting_entry_photos from anon, authenticated;
revoke all on community_voting_entry_consents from anon, authenticated;
revoke all on community_voting_photo_decisions from anon, authenticated;
revoke all on community_voting_photo_privacy_actions from anon, authenticated;
revoke all on community_voting_withdrawals from anon, authenticated;
revoke all on community_voting_closures from anon, authenticated;
revoke all on community_voting_finalist_selections from anon, authenticated;
revoke all on community_voting_finalists from anon, authenticated;
revoke all on community_voting_policy_approvals from anon, authenticated;
revoke all on community_voting_round_reviews from anon, authenticated;
revoke all on community_voting_publications from anon, authenticated;
revoke all on community_voting_published_results from anon, authenticated;
revoke all on community_voting_promo_consents from anon, authenticated;
revoke all on community_voting_followup_tasks from anon, authenticated;
revoke all on community_voting_operator_actions from anon, authenticated;

-- service_role keeps what the functions need and loses everything that would rewrite history.
revoke delete, truncate on community_voting_schedules from service_role;
revoke delete, truncate on community_voting_entry_photos from service_role;
revoke update, delete, truncate on community_voting_entry_consents from service_role;
revoke update, delete, truncate on community_voting_photo_decisions from service_role;
revoke update, delete, truncate on community_voting_photo_privacy_actions from service_role;
revoke update, delete, truncate on community_voting_withdrawals from service_role;
revoke update, delete, truncate on community_voting_closures from service_role;
revoke update, delete, truncate on community_voting_finalist_selections from service_role;
revoke update, delete, truncate on community_voting_finalists from service_role;
revoke update, delete, truncate on community_voting_policy_approvals from service_role;
revoke update, delete, truncate on community_voting_round_reviews from service_role;
revoke update, delete, truncate on community_voting_publications from service_role;
revoke update, delete, truncate on community_voting_published_results from service_role;
revoke update, delete, truncate on community_voting_promo_consents from service_role;
revoke delete, truncate on community_voting_followup_tasks from service_role;
revoke update, delete, truncate on community_voting_operator_actions from service_role;

revoke execute on function community_voting_guard_instance_insert() from public, anon, authenticated;
