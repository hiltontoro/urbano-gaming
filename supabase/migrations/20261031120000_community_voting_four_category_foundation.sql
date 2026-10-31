-- Migration: 20261031120000_community_voting_four_category_foundation
-- Halloween Community Voting — the FOUR-CATEGORY, SINGLE-ROUND contest (UG-IV-GATE-018). It replaces the two-round journey as the published format.
--
-- ADDITIVE over the eight Voting migrations (20261020190000 .. 20261030100000), which it does not edit, and COMPATIBLE with them: every object
-- below is new, or a new column / constraint on a Community Voting table that has never existed in Production.
--
-- ---------------------------------------------------------------------------------------
-- The approved contract (UG-IV-GATE-018 section 1)
-- ---------------------------------------------------------------------------------------
--   * One public round, FOUR categories (MOST_ELABORATE, SEXIEST, BEST_GROUP, FUNNIEST). No preliminary, no finalist cut, no second round and no
--     geofence: remote voters are allowed and no location is ever requested.
--   * One candidacy per PERSON, in ONE category. A group candidacy has one photograph, one representative and privately attributed participants.
--   * One current vote per account and per category, revisable until the close; no self-vote, including any member of a group.
--   * The category with the most valid votes wins; ties are shared; a category without a valid vote has no winner. Totals stay hidden until the
--     operator has closed, reviewed and explicitly published.
--
-- ---------------------------------------------------------------------------------------
-- Composition (nothing of Session or Voting is reinterpreted)
-- ---------------------------------------------------------------------------------------
--   Session keeps the lifecycle, Voting keeps candidates, votes and tally. A Session's interactions are strictly sequential and never concurrent
--   (0015), so FOUR simultaneous categories are FOUR Instances of FOUR Sessions, each with its own VOTING interaction, grouped by a CONTEST.
--   A category round is a round of the pilot (ballot_mode FAVORITE_ROUND, round_role PRELIMINARY: no venue, closes at its configured deadline)
--   that is ALSO registered here as a category round. Everything the pilot proved for such a round — photographs, consent, the operator's decision,
--   the private association, the atomic open, the cast, the close, the review, the immutable publication — is reused as it is. What the pilot
--   could not express is added by this migration and the two that follow it:
--     - community_voting_contests / community_voting_category_rounds   the grouping, and the category of each round;
--     - community_voting_entries.entry_kind / group_entry_id           an entry is INDIVIDUAL, a GROUP (the ballot candidate: one photograph, its
--                                                                      representative) or a GROUP_MEMBER (an attributed participant: never a
--                                                                      candidate, never on the ballot, but associated with a canonical identity
--                                                                      by the very same claim -> confirm act as a contestant);
--     - community_voting_contest_identities                            one row per PERSON of the contest, whatever their role: this is what makes
--                                                                      "one candidacy per person" a fact of the database and not of a form;
--     - community_voting_member_consents                               the consent of each photographed member to the group's CURRENT photograph.
--
-- Nothing here stores a name declared by someone: a member is a canonical Gaming Member reached through a verified binding, or does not exist.
--
-- RLS: enabled with no policies and every privilege revoked from anon / authenticated, following the competition_* precedent. Only the server's
-- service_role client reaches these tables.

-- ---------------------------------------------------------------------------------------
-- The contest and the category of each round
-- ---------------------------------------------------------------------------------------

create table community_voting_contests (
  contest_id                uuid primary key default gen_random_uuid(),
  operator_gaming_member_id uuid not null references gaming_members (gaming_member_id) on delete restrict,
  created_at                timestamptz not null default now(),
  -- The operator's explicit act of showing the contest on Home. Null = not listed: Home says only what is true (no link, no invented event).
  listed_at                 timestamptz null,
  listed_by_member_id       uuid null references gaming_members (gaming_member_id) on delete restrict,

  constraint community_voting_contests_listing_together check ((listed_at is null) = (listed_by_member_id is null))
);

create index community_voting_contests_listed_idx on community_voting_contests (listed_at desc) where listed_at is not null;

create table community_voting_category_rounds (
  instance_id  uuid primary key references community_voting_instances (instance_id) on delete restrict,
  contest_id   uuid not null references community_voting_contests (contest_id) on delete restrict,
  category_key text not null,
  created_at   timestamptz not null default now(),

  constraint community_voting_category_rounds_category_values check (category_key in ('MOST_ELABORATE', 'SEXIEST', 'BEST_GROUP', 'FUNNIEST')),
  constraint community_voting_category_rounds_contest_category_unique unique (contest_id, category_key)
);

-- ---------------------------------------------------------------------------------------
-- Entries: individual, group (the ballot candidate) and group member (an attributed participant)
-- ---------------------------------------------------------------------------------------

alter table community_voting_entries
  add column entry_kind     text not null default 'INDIVIDUAL',
  add column group_entry_id uuid null;

alter table community_voting_entries
  add constraint community_voting_entries_kind_values check (entry_kind in ('INDIVIDUAL', 'GROUP', 'GROUP_MEMBER')),
  -- A member names the group it belongs to (and only a member does); the group is an entry of the SAME Instance (composite foreign key).
  add constraint community_voting_entries_member_link check ((entry_kind = 'GROUP_MEMBER') = (group_entry_id is not null)),
  add constraint community_voting_entries_group_fkey
    foreign key (group_entry_id, instance_id) references community_voting_entries (entry_id, instance_id) on delete restrict,
  -- A member is never a ballot candidate and never descends from another entry.
  add constraint community_voting_entries_member_not_candidate check (entry_kind <> 'GROUP_MEMBER' or (candidate_id is null and source_entry_id is null));

create index community_voting_entries_group_idx on community_voting_entries (group_entry_id) where group_entry_id is not null;

-- ---------------------------------------------------------------------------------------
-- One candidacy per PERSON in the whole contest
-- ---------------------------------------------------------------------------------------
--
-- A row exists for every canonical identity whose association has been CONFIRMED on any entry of any category round of the contest, in whatever
-- role: the individual contestant, the representative of a group or an attributed member. (contest_id, gaming_member_id) is the primary key, so a
-- person can belong to at most one candidacy of one category — enforced by the database whatever calls it. Written and removed ONLY by triggers
-- on the entries (the guards migration), under the same transaction-local marker the entries themselves require; never edited.

create table community_voting_contest_identities (
  contest_id       uuid not null references community_voting_contests (contest_id) on delete restrict,
  gaming_member_id uuid not null references gaming_members (gaming_member_id) on delete restrict,
  instance_id      uuid not null,
  entry_id         uuid not null,
  role             text not null,
  recorded_at      timestamptz not null default now(),

  primary key (contest_id, gaming_member_id),
  constraint community_voting_contest_identities_entry_unique unique (entry_id),
  constraint community_voting_contest_identities_entry_fkey
    foreign key (entry_id, instance_id) references community_voting_entries (entry_id, instance_id) on delete restrict,
  constraint community_voting_contest_identities_role_values check (role in ('INDIVIDUAL', 'REPRESENTATIVE', 'MEMBER'))
);

-- ---------------------------------------------------------------------------------------
-- The consent of each photographed person to the group's photograph
-- ---------------------------------------------------------------------------------------
--
-- The gallery-and-contest consent of the pilot belongs to ONE photograph and ONE entry (community_voting_entry_consents.photo_id is unique): it is
-- the representative's. A group photograph shows several people, so EACH attributed member consents too, to the very same photograph; replacing
-- the photograph voids every one of them (they name the photograph, so none applies to another). Append-only, like every consent.

create table community_voting_member_consents (
  consent_id            uuid primary key default gen_random_uuid(),
  instance_id           uuid not null,
  group_entry_id        uuid not null,
  member_entry_id       uuid not null,
  photo_id              uuid not null references community_voting_entry_photos (photo_id) on delete restrict,
  consent_version       text not null,
  statement_sha256      text not null,
  acceptance_method     text not null default 'OPERATOR_TABLET_CHECKBOX',
  age_confirmed         boolean not null,
  accepted_at           timestamptz not null default now(),
  recorded_by_member_id uuid not null references gaming_members (gaming_member_id) on delete restrict,

  constraint community_voting_member_consents_member_photo_unique unique (member_entry_id, photo_id),
  constraint community_voting_member_consents_member_fkey
    foreign key (member_entry_id, instance_id) references community_voting_entries (entry_id, instance_id) on delete restrict,
  constraint community_voting_member_consents_group_fkey
    foreign key (group_entry_id, instance_id) references community_voting_entries (entry_id, instance_id) on delete restrict,
  constraint community_voting_member_consents_version_shape check (consent_version ~ '^[A-Za-z0-9._-]{1,64}$'),
  constraint community_voting_member_consents_statement_shape check (statement_sha256 ~ '^[0-9a-f]{64}$'),
  constraint community_voting_member_consents_method_values check (acceptance_method in ('OPERATOR_TABLET_CHECKBOX')),
  constraint community_voting_member_consents_age_confirmed check (age_confirmed)
);

create index community_voting_member_consents_group_photo_idx on community_voting_member_consents (group_entry_id, photo_id);

-- ---------------------------------------------------------------------------------------
-- The operator's audit trail learns the new acts (the list of values only grows)
-- ---------------------------------------------------------------------------------------

alter table community_voting_operator_actions drop constraint community_voting_operator_actions_values;
alter table community_voting_operator_actions add constraint community_voting_operator_actions_values check (action in (
  'REGISTER_INSTANCE', 'SET_SCHEDULE', 'CREATE_ENTRY', 'REMOVE_ENTRY', 'UPLOAD_PHOTO', 'RECORD_CONSENT', 'APPROVE_PHOTO',
  'REJECT_PHOTO', 'CONFIRM_ASSOCIATION', 'OPEN_VOTING', 'CLOSE_VOTING', 'WITHDRAW_CANDIDATURE', 'HIDE_PHOTO',
  'SELECT_FINALISTS', 'PREPARE_FINAL', 'REVIEW_RESULTS', 'PUBLISH_RESULTS', 'RECORD_PROMO_CONSENT',
  'RECORD_POLICY_APPROVAL', 'RESOLVE_FOLLOWUP_TASK', 'CONFIGURE_GEOFENCE',
  'LIST_CONTEST', 'UNLIST_CONTEST',
  'CONFIRM_REGISTRATION', 'READ_CONTACT', 'MARK_DELIVERED', 'CORRECT_NAME'
));

-- ---------------------------------------------------------------------------------------
-- Row-level security and privileges
-- ---------------------------------------------------------------------------------------

alter table community_voting_contests enable row level security;
alter table community_voting_category_rounds enable row level security;
alter table community_voting_contest_identities enable row level security;
alter table community_voting_member_consents enable row level security;

revoke all on community_voting_contests from anon, authenticated;
revoke all on community_voting_category_rounds from anon, authenticated;
revoke all on community_voting_contest_identities from anon, authenticated;
revoke all on community_voting_member_consents from anon, authenticated;

-- service_role keeps what the functions need and loses what would let history be rewritten.
revoke delete, truncate on community_voting_contests from service_role;
revoke update, delete, truncate on community_voting_category_rounds from service_role;
revoke update, truncate on community_voting_contest_identities from service_role;
revoke update, delete, truncate on community_voting_member_consents from service_role;

-- A contest's only mutable fact is its listing on Home; the guard (next migration but one) refuses every other change.
revoke update on community_voting_contests from service_role;
grant update (listed_at, listed_by_member_id) on community_voting_contests to service_role;
