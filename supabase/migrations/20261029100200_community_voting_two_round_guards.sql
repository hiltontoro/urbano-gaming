-- Migration: 20261029100200_community_voting_two_round_guards
-- Halloween Community Voting pilot — the invariants of the two-round journey, enforced at the TABLES.
-- Self-contained on top of the GATE-003 foundation and 20261029100000 / 20261029100100.
--
-- The functions in 20261029100100 are the intended way to change anything, but a function is only a convention for whoever writes
-- to the tables directly (service_role through PostgREST, the table owner in a console, a future function). The triggers below make
-- the pilot's invariants true for EVERY writer, in the same way the candidate's guards (20261020190300) do, and they are inert for
-- any Instance that is not a FAVORITE_ROUND, so GATE-003 (SINGLE_CHOICE) Instances and ordinary Sessions behave exactly as before.
--
-- GATE-003 functions replaced here (CREATE OR REPLACE, same signature, behavior preserved and extended for the pilot):
-- community_voting_guard_entries and community_voting_guard_binding_update.
--
-- The transaction-local markers authorize ONE transaction's writes for ONE named object and are cleared before the function returns:
--   urbano.community_voting_round_op       = <instance id>  the round's operations may write that Instance's entries
--   urbano.community_voting_start          = <session id>   the sanctioned opening (GATE-003's marker)
--   urbano.community_voting_round_vote     = <session id>   the sanctioned write of a vote
--   urbano.community_voting_round_close    = <session id>   the sanctioned close
--   urbano.community_voting_round_publish  = <session id>   the sanctioned reveal and the snapshot of what is announced
--   urbano.community_voting_round_withdraw = 'on'           the sanctioned withdrawal
--   urbano.community_voting_finalists      = <instance id>  the sanctioned finalist selection

-- ---------------------------------------------------------------------------------------
-- Identity and scope lookups
-- ---------------------------------------------------------------------------------------

-- Does Supabase Auth hold a CONFIRMED EMAIL for this user? auth.users is not readable by the roles that call the pilot's functions, so
-- the lookup is SECURITY DEFINER and answers one boolean — never an address. A phone-only user (no email) is simply "no".
create function community_voting_email_confirmed(p_auth_user_id uuid)
returns boolean
language plpgsql
stable
security definer
set search_path = public
as $$
begin
  -- plpgsql on purpose: the body is resolved when it first runs, after Supabase Auth has created its own schema.
  return exists (
    select 1 from auth.users u
    where u.id = p_auth_user_id
      and u.email is not null
      and btrim(u.email) <> ''
      and u.email_confirmed_at is not null
  );
end;
$$;

-- The Session of a two-round event-bound interaction, or null. SECURITY DEFINER for the reason GATE-003's lookup is: the interaction
-- and votes guards fire for whoever calls the ordinary Session functions (anon and authenticated included, by inherited default), and
-- those roles can see none of the Community Voting tables. It answers only a Session id.
create function community_voting_scope_of_interaction(p_interaction_instance_id uuid)
returns uuid
language sql
stable
security definer
set search_path = public
as $$
  select ii.session_id
  from public.interaction_instances ii
  join public.community_voting_instances i on i.session_id = ii.session_id and i.ballot_mode = 'FAVORITE_ROUND'
  where ii.interaction_instance_id = p_interaction_instance_id;
$$;

-- ---------------------------------------------------------------------------------------
-- Generic: records that are never edited
-- ---------------------------------------------------------------------------------------

create function community_voting_reject_update()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  raise exception 'COMMUNITY_VOTING_HISTORY_IMMUTABLE: this Community Voting record cannot be changed'
    using errcode = 'P0001';
end;
$$;

-- ---------------------------------------------------------------------------------------
-- Bindings: the pilot identity policy, for every writer
-- ---------------------------------------------------------------------------------------
--
-- A binding to a FAVORITE_ROUND Instance exists only for a Supabase Auth user whose email is confirmed AND who has a Gaming Member
-- (the profile step has been completed). The binding records that Gaming Member. GATE-003's bind function is NOT edited: this
-- trigger decides for a round, and a GATE-003 binding carries no Gaming Member.

create function community_voting_guard_binding_insert()
returns trigger
language plpgsql
set search_path = public
as $$
declare
  v_mode text;
begin
  select i.ballot_mode into v_mode from community_voting_instances i where i.instance_id = new.instance_id;

  if v_mode = 'FAVORITE_ROUND' then
    if not community_voting_email_confirmed(new.auth_user_id) then
      raise exception 'CV_VERIFIED_EMAIL_REQUIRED: a verified email address is required to take part'
        using errcode = 'P0001';
    end if;

    select m.gaming_member_id into new.gaming_member_id
    from gaming_members m
    where m.auth_user_id = new.auth_user_id;

    if new.gaming_member_id is null then
      raise exception 'CV_PROFILE_INCOMPLETE: complete your URBANO Gaming profile to take part'
        using errcode = 'P0001';
    end if;
  elsif new.gaming_member_id is not null then
    raise exception 'COMMUNITY_VOTING_HISTORY_IMMUTABLE: only a two-round binding names a Gaming Member'
      using errcode = 'P0001';
  end if;

  return new;
end;
$$;

create trigger community_voting_voter_bindings_guard_insert
  before insert on community_voting_voter_bindings
  for each row execute function community_voting_guard_binding_insert();

create or replace function community_voting_guard_binding_update()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if old.binding_id is distinct from new.binding_id
     or old.instance_id is distinct from new.instance_id
     or old.auth_user_id is distinct from new.auth_user_id
     or old.participant_id is distinct from new.participant_id
     or old.gaming_member_id is distinct from new.gaming_member_id
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

-- ---------------------------------------------------------------------------------------
-- Entries: a round's entries change only through its operations; a final's entries descend from the preliminary
-- ---------------------------------------------------------------------------------------

create or replace function community_voting_guard_entries()
returns trigger
language plpgsql
set search_path = public
as $$
declare
  v_session_id uuid;
  v_mode text;
  v_role text;
  v_source_instance uuid;
  v_instance_id uuid := coalesce(new.instance_id, old.instance_id);
begin
  select i.session_id, i.ballot_mode, i.round_role, i.source_instance_id into v_session_id, v_mode, v_role, v_source_instance
  from community_voting_instances i
  where i.instance_id = v_instance_id;

  if v_mode = 'FAVORITE_ROUND'
     and current_setting('urbano.community_voting_round_op', true) is distinct from v_instance_id::text then
    raise exception 'COMMUNITY_VOTING_ROUND_PATH_REQUIRED: a round''s entries change only through its operations'
      using errcode = 'P0001';
  end if;

  if exists (select 1 from interaction_instances ii where ii.session_id = v_session_id)
     and current_setting('urbano.community_voting_start', true) is distinct from v_session_id::text then
    raise exception 'COMMUNITY_VOTING_PREPARATION_FROZEN: Voting has opened; the preparation can no longer change'
      using errcode = 'P0001';
  end if;

  if tg_op = 'INSERT' then
    if v_mode = 'FAVORITE_ROUND' and v_role = 'FINAL' then
      if new.source_entry_id is null
         or (select e.instance_id from community_voting_entries e where e.entry_id = new.source_entry_id) is distinct from v_source_instance then
        raise exception 'COMMUNITY_VOTING_FINAL_ENTRY_SOURCE: a final''s entry descends from an entry of its preliminary'
          using errcode = 'P0001';
      end if;
    elsif new.source_entry_id is not null then
      raise exception 'COMMUNITY_VOTING_FINAL_ENTRY_SOURCE: only a final''s entry descends from another entry'
        using errcode = 'P0001';
    end if;
  end if;

  if tg_op = 'UPDATE' then
    if new.entry_id is distinct from old.entry_id
       or new.instance_id is distinct from old.instance_id
       or new.ordinal is distinct from old.ordinal
       or new.label is distinct from old.label
       or new.source_entry_id is distinct from old.source_entry_id
       or new.created_at is distinct from old.created_at then
      raise exception 'COMMUNITY_VOTING_HISTORY_IMMUTABLE: an entry''s identity cannot change'
        using errcode = 'P0001';
    end if;
  end if;

  -- A contestant holds at most one entry, pending OR confirmed. The unique constraints cover pending-on-two and confirmed-on-two;
  -- this closes the one gap they cannot express: pending on one entry and confirmed on another.
  if tg_op in ('INSERT', 'UPDATE')
     and (new.pending_binding_id is not null or new.confirmed_binding_id is not null)
     and exists (
       select 1 from community_voting_entries e
       where e.instance_id = new.instance_id
         and e.entry_id <> new.entry_id
         and (
           (new.pending_binding_id is not null
              and (e.pending_binding_id = new.pending_binding_id or e.confirmed_binding_id = new.pending_binding_id))
           or
           (new.confirmed_binding_id is not null
              and (e.pending_binding_id = new.confirmed_binding_id or e.confirmed_binding_id = new.confirmed_binding_id))
         )
     ) then
    raise exception 'COMMUNITY_VOTING_ENTRY_CONFLICT: a contestant holds at most one entry in a ballot'
      using errcode = 'P0001';
  end if;

  return coalesce(new, old);
end;
$$;

-- ---------------------------------------------------------------------------------------
-- votes: a round's votes are written only by its own cast
-- ---------------------------------------------------------------------------------------
--
-- INSERT, UPDATE and DELETE are all guarded for a round's interaction, because the Voting store's own writer is an upsert (whose
-- conflict branch is an UPDATE) and because nothing may remove a vote either: a withdrawal, a hidden photograph, a closed round —
-- none of them deletes vote evidence. The sanctioned writer sets the vote marker for the Session around its delegation to the
-- unchanged cast_vote_atomically and clears it straight after.

create function community_voting_guard_votes()
returns trigger
language plpgsql
set search_path = public
as $$
declare
  v_session uuid;
begin
  v_session := community_voting_scope_of_interaction(
    case when tg_op = 'DELETE' then old.interaction_instance_id else new.interaction_instance_id end
  );

  if v_session is not null
     and (tg_op = 'DELETE' or current_setting('urbano.community_voting_round_vote', true) is distinct from v_session::text) then
    raise exception 'COMMUNITY_VOTING_ROUND_PATH_REQUIRED: a round''s votes are written only by its own vote operation, and are never removed'
      using errcode = 'P0001';
  end if;

  return case when tg_op = 'DELETE' then old else new end;
end;
$$;

create trigger community_voting_guard_votes_insert
  before insert on votes
  for each row execute function community_voting_guard_votes();
create trigger community_voting_guard_votes_update
  before update on votes
  for each row execute function community_voting_guard_votes();
create trigger community_voting_guard_votes_delete
  before delete on votes
  for each row execute function community_voting_guard_votes();

-- ---------------------------------------------------------------------------------------
-- interaction_instances: a round changes state only through its own close and its own publication
-- ---------------------------------------------------------------------------------------

create function community_voting_guard_interaction_update()
returns trigger
language plpgsql
set search_path = public
as $$
declare
  v_session uuid;
begin
  if new.state is not distinct from old.state then
    return new;
  end if;

  v_session := community_voting_scope_of_interaction(old.interaction_instance_id);
  if v_session is null then
    return new;
  end if;

  if current_setting('urbano.community_voting_round_close', true) is not distinct from v_session::text
     and old.state = 'PROMPT_ACTIVE' and new.state = 'SUBMISSIONS_CLOSED' then
    return new;
  end if;
  if current_setting('urbano.community_voting_round_publish', true) is not distinct from v_session::text
     and old.state = 'SUBMISSIONS_CLOSED' and new.state = 'RESULT_REVEAL' then
    return new;
  end if;

  raise exception 'COMMUNITY_VOTING_ROUND_PATH_REQUIRED: a round changes state only through its own close and its own publication'
    using errcode = 'P0001';
end;
$$;

create trigger community_voting_guard_interaction_update
  before update on interaction_instances
  for each row execute function community_voting_guard_interaction_update();

-- ---------------------------------------------------------------------------------------
-- Schedule: configuration until the round opens, frozen from then on
-- ---------------------------------------------------------------------------------------
--
-- Once the Session has an interaction the schedule is a fact that decided what was accepted, so it can no longer change — not by
-- the function and not by a direct write: an opened round's deadline is never edited, extended or shortened silently.

create function community_voting_guard_schedule_update()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if new.instance_id is distinct from old.instance_id then
    raise exception 'COMMUNITY_VOTING_HISTORY_IMMUTABLE: a schedule cannot be re-assigned'
      using errcode = 'P0001';
  end if;
  if exists (
    select 1 from interaction_instances ii
    join community_voting_instances i on i.session_id = ii.session_id
    where i.instance_id = old.instance_id
  ) then
    raise exception 'COMMUNITY_VOTING_PREPARATION_FROZEN: Voting has opened; the schedule can no longer change'
      using errcode = 'P0001';
  end if;
  return new;
end;
$$;

create trigger community_voting_schedules_guard_update
  before update on community_voting_schedules
  for each row execute function community_voting_guard_schedule_update();
create trigger community_voting_schedules_no_delete
  before delete on community_voting_schedules
  for each row execute function community_voting_reject_history_loss();
create trigger community_voting_schedules_no_truncate
  before truncate on community_voting_schedules
  for each statement execute function community_voting_reject_history_loss();

-- ---------------------------------------------------------------------------------------
-- Photographs: added only before opening, and never to a final's entry; afterwards the ONLY change is erasing the bytes, once
-- ---------------------------------------------------------------------------------------

create function community_voting_guard_photos()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if tg_op = 'INSERT' then
    if exists (
      select 1 from interaction_instances ii
      join community_voting_instances i on i.session_id = ii.session_id
      where i.instance_id = new.instance_id
    ) then
      raise exception 'COMMUNITY_VOTING_PREPARATION_FROZEN: Voting has opened; photographs can no longer be added'
        using errcode = 'P0001';
    end if;
    if exists (select 1 from community_voting_entries e where e.entry_id = new.entry_id and e.source_entry_id is not null) then
      raise exception 'COMMUNITY_VOTING_FINAL_ENTRY_SOURCE: a final''s entry shows the photograph of the entry it descends from'
        using errcode = 'P0001';
    end if;
    return new;
  end if;

  -- UPDATE: erasure of the bytes, stamped once, nothing else
  if old.bytes_deleted_at is not null then
    raise exception 'COMMUNITY_VOTING_HISTORY_IMMUTABLE: an erased photograph cannot be changed'
      using errcode = 'P0001';
  end if;
  if new.full_bytes is not null or new.thumb_bytes is not null or new.bytes_deleted_at is null or new.bytes_deleted_reason is null
     or new.photo_id is distinct from old.photo_id or new.instance_id is distinct from old.instance_id
     or new.entry_id is distinct from old.entry_id or new.full_sha256 is distinct from old.full_sha256
     or new.thumb_sha256 is distinct from old.thumb_sha256 or new.full_size is distinct from old.full_size
     or new.thumb_size is distinct from old.thumb_size or new.width is distinct from old.width
     or new.height is distinct from old.height or new.created_at is distinct from old.created_at
     or new.uploaded_by_member_id is distinct from old.uploaded_by_member_id then
    raise exception 'COMMUNITY_VOTING_HISTORY_IMMUTABLE: a photograph can only be erased, never altered'
      using errcode = 'P0001';
  end if;
  return new;
end;
$$;

create trigger community_voting_entry_photos_guard
  before insert or update on community_voting_entry_photos
  for each row execute function community_voting_guard_photos();
create trigger community_voting_entry_photos_no_delete
  before delete on community_voting_entry_photos
  for each row execute function community_voting_reject_history_loss();
create trigger community_voting_entry_photos_no_truncate
  before truncate on community_voting_entry_photos
  for each statement execute function community_voting_reject_history_loss();

-- ---------------------------------------------------------------------------------------
-- Consent and decisions: recorded only before opening, never edited, and an approval needs a consent
-- ---------------------------------------------------------------------------------------

create function community_voting_guard_media_decision()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if exists (
    select 1 from interaction_instances ii
    join community_voting_instances i on i.session_id = ii.session_id
    where i.instance_id = new.instance_id
  ) then
    raise exception 'COMMUNITY_VOTING_PREPARATION_FROZEN: Voting has opened; consent and photograph decisions can no longer be recorded'
      using errcode = 'P0001';
  end if;

  -- Nested on purpose: this function serves two tables, and PL/pgSQL resolves `new.decision` at execution even when an earlier
  -- operand of an AND is false, so the field must only be referenced on the table that has it.
  if tg_table_name = 'community_voting_photo_decisions' then
    if new.decision = 'APPROVED'
       and not exists (select 1 from community_voting_entry_consents c where c.photo_id = new.photo_id) then
      raise exception 'COMMUNITY_VOTING_CONSENT_REQUIRED: a photograph cannot be approved without the contestant''s recorded consent'
        using errcode = 'P0001';
    end if;
  end if;

  return new;
end;
$$;

create trigger community_voting_entry_consents_guard
  before insert on community_voting_entry_consents
  for each row execute function community_voting_guard_media_decision();
create trigger community_voting_photo_decisions_guard
  before insert on community_voting_photo_decisions
  for each row execute function community_voting_guard_media_decision();

-- ---------------------------------------------------------------------------------------
-- Withdrawals: the candidate must be the entry's own; a withdrawal goes through the cascading operation
-- ---------------------------------------------------------------------------------------

create function community_voting_guard_withdrawals()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if new.candidate_id is distinct from (select e.candidate_id from community_voting_entries e where e.entry_id = new.entry_id) then
    raise exception 'COMMUNITY_VOTING_HISTORY_IMMUTABLE: a withdrawal must name the entry''s own candidate'
      using errcode = 'P0001';
  end if;

  if (select i.ballot_mode from community_voting_instances i where i.instance_id = new.instance_id) = 'FAVORITE_ROUND'
     and current_setting('urbano.community_voting_round_withdraw', true) is distinct from 'on' then
    raise exception 'COMMUNITY_VOTING_ROUND_PATH_REQUIRED: a withdrawal goes through the operation that honors it in both rounds'
      using errcode = 'P0001';
  end if;
  return new;
end;
$$;

create trigger community_voting_withdrawals_guard
  before insert on community_voting_withdrawals
  for each row execute function community_voting_guard_withdrawals();

-- ---------------------------------------------------------------------------------------
-- The closure record: only once the interaction has closed, and a round's only by its own close
-- ---------------------------------------------------------------------------------------

create function community_voting_guard_closures()
returns trigger
language plpgsql
set search_path = public
as $$
declare
  v_session uuid;
  v_mode text;
begin
  if (select ii.state from interaction_instances ii where ii.interaction_instance_id = new.interaction_instance_id)
       not in ('SUBMISSIONS_CLOSED', 'RESULT_REVEAL') then
    raise exception 'COMMUNITY_VOTING_VOTING_NOT_OPEN: a closure is recorded only for an interaction that has closed'
      using errcode = 'P0001';
  end if;

  select i.session_id, i.ballot_mode into v_session, v_mode from community_voting_instances i where i.instance_id = new.instance_id;
  if v_mode = 'FAVORITE_ROUND'
     and current_setting('urbano.community_voting_round_close', true) is distinct from v_session::text then
    raise exception 'COMMUNITY_VOTING_ROUND_PATH_REQUIRED: a round is closed only through its own close'
      using errcode = 'P0001';
  end if;
  return new;
end;
$$;

create trigger community_voting_closures_guard
  before insert on community_voting_closures
  for each row execute function community_voting_guard_closures();

-- ---------------------------------------------------------------------------------------
-- The finalist selection, the review, the policy approvals and the publication
-- ---------------------------------------------------------------------------------------

create function community_voting_guard_finalist_selection()
returns trigger
language plpgsql
set search_path = public
as $$
declare
  v_requirement text;
begin
  if current_setting('urbano.community_voting_finalists', true) is distinct from new.preliminary_instance_id::text then
    raise exception 'COMMUNITY_VOTING_ROUND_PATH_REQUIRED: finalists are written only by the finalist selection'
      using errcode = 'P0001';
  end if;

  if tg_table_name = 'community_voting_finalist_selections' then
    if not exists (
      select 1 from community_voting_instances i
      where i.instance_id = new.preliminary_instance_id and i.ballot_mode = 'FAVORITE_ROUND' and i.round_role = 'PRELIMINARY'
    ) or not exists (select 1 from community_voting_closures c where c.instance_id = new.preliminary_instance_id) then
      raise exception 'COMMUNITY_VOTING_VOTING_NOT_OPEN: finalists are selected from a closed preliminary only'
        using errcode = 'P0001';
    end if;

    -- Fail closed for every writer: a cut that depends on a Product decision is written only once that decision is recorded.
    v_requirement := community_voting_cut_policy_requirement(new.preliminary_instance_id);
    if v_requirement is not null and not community_voting_policy_approved(new.preliminary_instance_id, v_requirement) then
      raise exception 'COMMUNITY_VOTING_POLICY_REQUIRED: % has no approved Product decision', v_requirement
        using errcode = 'P0001';
    end if;
  else
    if not exists (
      select 1 from community_voting_entries e
      where e.entry_id = new.entry_id and e.instance_id = new.preliminary_instance_id and e.candidate_id = new.candidate_id
    ) then
      raise exception 'COMMUNITY_VOTING_CANDIDATE_NOT_AVAILABLE: a finalist must be a contestant of its preliminary'
        using errcode = 'P0001';
    end if;
  end if;
  return new;
end;
$$;

create trigger community_voting_finalist_selections_guard
  before insert on community_voting_finalist_selections
  for each row execute function community_voting_guard_finalist_selection();
create trigger community_voting_finalists_guard
  before insert on community_voting_finalists
  for each row execute function community_voting_guard_finalist_selection();

create function community_voting_guard_round_review()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if not exists (
    select 1 from community_voting_instances i
    join community_voting_closures c on c.instance_id = i.instance_id
    where i.instance_id = new.instance_id and i.ballot_mode = 'FAVORITE_ROUND'
  ) then
    raise exception 'COMMUNITY_VOTING_VOTING_NOT_OPEN: only a closed round can be reviewed'
      using errcode = 'P0001';
  end if;
  return new;
end;
$$;

create trigger community_voting_round_reviews_guard
  before insert on community_voting_round_reviews
  for each row execute function community_voting_guard_round_review();

-- A policy approval belongs to a round, is recorded once for the pair of rounds, and (for every writer) names a supported value.
create function community_voting_guard_policy_approval()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if not exists (
    select 1 from community_voting_instances i where i.instance_id = new.instance_id and i.ballot_mode = 'FAVORITE_ROUND'
  ) then
    raise exception 'COMMUNITY_VOTING_NOT_A_ROUND: a policy approval belongs to a two-round Instance'
      using errcode = 'P0001';
  end if;
  if community_voting_policy_approved(new.instance_id, new.policy_key) then
    raise exception 'COMMUNITY_VOTING_HISTORY_IMMUTABLE: this policy has already been approved for these rounds'
      using errcode = 'P0001';
  end if;
  return new;
end;
$$;

create trigger community_voting_policy_approvals_guard
  before insert on community_voting_policy_approvals
  for each row execute function community_voting_guard_policy_approval();

create function community_voting_guard_publication()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  -- First, for every writer: a final with no valid vote has no result, whatever review exists.
  if community_voting_has_no_valid_result(new.instance_id) then
    raise exception 'COMMUNITY_VOTING_NO_VALID_RESULT: a final with no valid votes has no result to publish'
      using errcode = 'P0001';
  end if;

  if not exists (
    select 1 from community_voting_round_reviews r
    where r.review_id = new.review_id and r.instance_id = new.instance_id and r.results_digest = new.results_digest
  ) or community_voting_compute_review_digest(new.instance_id) is distinct from new.results_digest then
    raise exception 'COMMUNITY_VOTING_REVIEW_REQUIRED: a publication commits to a review of the current result'
      using errcode = 'P0001';
  end if;

  if exists (select 1 from community_voting_pending_policies(new.instance_id)) then
    raise exception 'COMMUNITY_VOTING_POLICY_REQUIRED: a Product decision is still pending; the result cannot be published'
      using errcode = 'P0001';
  end if;

  if (select ii.state
      from interaction_instances ii
      join community_voting_instances i on i.session_id = ii.session_id
      where i.instance_id = new.instance_id
      order by ii.created_at desc limit 1) is distinct from 'RESULT_REVEAL' then
    raise exception 'COMMUNITY_VOTING_ROUND_PATH_REQUIRED: a publication is recorded with the Session''s own reveal'
      using errcode = 'P0001';
  end if;
  return new;
end;
$$;

create trigger community_voting_publications_guard
  before insert on community_voting_publications
  for each row execute function community_voting_guard_publication();

-- What was announced is written once, with the publication, for entries of that round. Never a count, never edited.
create function community_voting_guard_published_results()
returns trigger
language plpgsql
set search_path = public
as $$
declare
  v_session uuid;
begin
  select i.session_id into v_session from community_voting_instances i where i.instance_id = new.instance_id;

  if current_setting('urbano.community_voting_round_publish', true) is distinct from v_session::text then
    raise exception 'COMMUNITY_VOTING_ROUND_PATH_REQUIRED: the announced result is written only by the publication'
      using errcode = 'P0001';
  end if;

  if not exists (
    select 1 from community_voting_entries e where e.entry_id = new.entry_id and e.instance_id = new.instance_id
  ) then
    raise exception 'COMMUNITY_VOTING_CANDIDATE_NOT_AVAILABLE: an announced contestant belongs to the published round'
      using errcode = 'P0001';
  end if;

  -- A winner has the highest count AND at least one valid vote: a second, independent layer behind the publication function and the
  -- publication guard, so that shared winners can never be written for a count of zero.
  if new.kind = 'WINNERS' and not exists (
    select 1
    from community_voting_compute_round_results(new.instance_id) r
    where r.r_entry_id = new.entry_id and not r.r_withdrawn and r.r_rank = 1 and r.r_votes > 0
  ) then
    raise exception 'COMMUNITY_VOTING_NO_VALID_RESULT: a winner has the highest count and at least one valid vote'
      using errcode = 'P0001';
  end if;
  return new;
end;
$$;

create trigger community_voting_published_results_guard
  before insert on community_voting_published_results
  for each row execute function community_voting_guard_published_results();

-- A promotional decision is the PERSON's, so it sits on the entry that owns the photograph (never on a final's entry), in a round.
create function community_voting_guard_promo_consent()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if not exists (
    select 1 from community_voting_entries e
    join community_voting_instances i on i.instance_id = e.instance_id and i.ballot_mode = 'FAVORITE_ROUND'
    where e.entry_id = new.entry_id and e.source_entry_id is null
  ) then
    raise exception 'COMMUNITY_VOTING_FINAL_ENTRY_SOURCE: a promotional decision is recorded on the entry that owns the photograph'
      using errcode = 'P0001';
  end if;
  return new;
end;
$$;

create trigger community_voting_promo_consents_guard
  before insert on community_voting_promo_consents
  for each row execute function community_voting_guard_promo_consent();

-- A privacy action is recorded on the entry that owns the photograph (never on a final's entry), in a round.
create function community_voting_guard_photo_privacy_action()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if not exists (
    select 1 from community_voting_entries e
    join community_voting_instances i on i.instance_id = e.instance_id and i.ballot_mode = 'FAVORITE_ROUND'
    where e.entry_id = new.entry_id and e.source_entry_id is null
  ) then
    raise exception 'COMMUNITY_VOTING_FINAL_ENTRY_SOURCE: a privacy action is recorded on the entry that owns the photograph'
      using errcode = 'P0001';
  end if;
  return new;
end;
$$;

create trigger community_voting_photo_privacy_actions_guard
  before insert on community_voting_photo_privacy_actions
  for each row execute function community_voting_guard_photo_privacy_action();

-- A follow-up task is only ever closed: PENDING -> DONE, with who and why. Its subject never changes.
create function community_voting_guard_followup_task()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if old.status <> 'PENDING'
     or new.status <> 'DONE'
     or new.task_id is distinct from old.task_id
     or new.instance_id is distinct from old.instance_id
     or new.entry_id is distinct from old.entry_id
     or new.kind is distinct from old.kind
     or new.description is distinct from old.description
     or new.created_at is distinct from old.created_at
     or new.created_by_member_id is distinct from old.created_by_member_id then
    raise exception 'COMMUNITY_VOTING_HISTORY_IMMUTABLE: a follow-up task can only be closed, once'
      using errcode = 'P0001';
  end if;
  return new;
end;
$$;

create trigger community_voting_followup_tasks_guard_update
  before update on community_voting_followup_tasks
  for each row execute function community_voting_guard_followup_task();
create trigger community_voting_followup_tasks_no_delete
  before delete on community_voting_followup_tasks
  for each row execute function community_voting_reject_history_loss();
create trigger community_voting_followup_tasks_no_truncate
  before truncate on community_voting_followup_tasks
  for each statement execute function community_voting_reject_history_loss();

-- ---------------------------------------------------------------------------------------
-- Append-only: no update, delete or truncate
-- ---------------------------------------------------------------------------------------

create trigger community_voting_entry_consents_no_update before update on community_voting_entry_consents for each row execute function community_voting_reject_update();
create trigger community_voting_entry_consents_no_delete before delete on community_voting_entry_consents for each row execute function community_voting_reject_history_loss();
create trigger community_voting_entry_consents_no_truncate before truncate on community_voting_entry_consents for each statement execute function community_voting_reject_history_loss();

create trigger community_voting_photo_decisions_no_update before update on community_voting_photo_decisions for each row execute function community_voting_reject_update();
create trigger community_voting_photo_decisions_no_delete before delete on community_voting_photo_decisions for each row execute function community_voting_reject_history_loss();
create trigger community_voting_photo_decisions_no_truncate before truncate on community_voting_photo_decisions for each statement execute function community_voting_reject_history_loss();

create trigger community_voting_photo_privacy_actions_no_update before update on community_voting_photo_privacy_actions for each row execute function community_voting_reject_update();
create trigger community_voting_photo_privacy_actions_no_delete before delete on community_voting_photo_privacy_actions for each row execute function community_voting_reject_history_loss();
create trigger community_voting_photo_privacy_actions_no_truncate before truncate on community_voting_photo_privacy_actions for each statement execute function community_voting_reject_history_loss();

create trigger community_voting_withdrawals_no_update before update on community_voting_withdrawals for each row execute function community_voting_reject_update();
create trigger community_voting_withdrawals_no_delete before delete on community_voting_withdrawals for each row execute function community_voting_reject_history_loss();
create trigger community_voting_withdrawals_no_truncate before truncate on community_voting_withdrawals for each statement execute function community_voting_reject_history_loss();

create trigger community_voting_closures_no_update before update on community_voting_closures for each row execute function community_voting_reject_update();
create trigger community_voting_closures_no_delete before delete on community_voting_closures for each row execute function community_voting_reject_history_loss();
create trigger community_voting_closures_no_truncate before truncate on community_voting_closures for each statement execute function community_voting_reject_history_loss();

create trigger community_voting_finalist_selections_no_update before update on community_voting_finalist_selections for each row execute function community_voting_reject_update();
create trigger community_voting_finalist_selections_no_delete before delete on community_voting_finalist_selections for each row execute function community_voting_reject_history_loss();
create trigger community_voting_finalist_selections_no_truncate before truncate on community_voting_finalist_selections for each statement execute function community_voting_reject_history_loss();

create trigger community_voting_finalists_no_update before update on community_voting_finalists for each row execute function community_voting_reject_update();
create trigger community_voting_finalists_no_delete before delete on community_voting_finalists for each row execute function community_voting_reject_history_loss();
create trigger community_voting_finalists_no_truncate before truncate on community_voting_finalists for each statement execute function community_voting_reject_history_loss();

create trigger community_voting_policy_approvals_no_update before update on community_voting_policy_approvals for each row execute function community_voting_reject_update();
create trigger community_voting_policy_approvals_no_delete before delete on community_voting_policy_approvals for each row execute function community_voting_reject_history_loss();
create trigger community_voting_policy_approvals_no_truncate before truncate on community_voting_policy_approvals for each statement execute function community_voting_reject_history_loss();

create trigger community_voting_round_reviews_no_update before update on community_voting_round_reviews for each row execute function community_voting_reject_update();
create trigger community_voting_round_reviews_no_delete before delete on community_voting_round_reviews for each row execute function community_voting_reject_history_loss();
create trigger community_voting_round_reviews_no_truncate before truncate on community_voting_round_reviews for each statement execute function community_voting_reject_history_loss();

create trigger community_voting_publications_no_update before update on community_voting_publications for each row execute function community_voting_reject_update();
create trigger community_voting_publications_no_delete before delete on community_voting_publications for each row execute function community_voting_reject_history_loss();
create trigger community_voting_publications_no_truncate before truncate on community_voting_publications for each statement execute function community_voting_reject_history_loss();

create trigger community_voting_published_results_no_update before update on community_voting_published_results for each row execute function community_voting_reject_update();
create trigger community_voting_published_results_no_delete before delete on community_voting_published_results for each row execute function community_voting_reject_history_loss();
create trigger community_voting_published_results_no_truncate before truncate on community_voting_published_results for each statement execute function community_voting_reject_history_loss();

create trigger community_voting_promo_consents_no_update before update on community_voting_promo_consents for each row execute function community_voting_reject_update();
create trigger community_voting_promo_consents_no_delete before delete on community_voting_promo_consents for each row execute function community_voting_reject_history_loss();
create trigger community_voting_promo_consents_no_truncate before truncate on community_voting_promo_consents for each statement execute function community_voting_reject_history_loss();

create trigger community_voting_operator_actions_no_update before update on community_voting_operator_actions for each row execute function community_voting_reject_update();
create trigger community_voting_operator_actions_no_delete before delete on community_voting_operator_actions for each row execute function community_voting_reject_history_loss();
create trigger community_voting_operator_actions_no_truncate before truncate on community_voting_operator_actions for each statement execute function community_voting_reject_history_loss();

-- Trigger functions are never callable directly, and nothing here should be executable by a browser role either — except the bare
-- scope lookup, which every caller of the ordinary Session functions must be able to run (see the head of this file).
revoke execute on function community_voting_email_confirmed(uuid) from public, anon, authenticated;
revoke execute on function community_voting_reject_update() from public, anon, authenticated;
revoke execute on function community_voting_guard_binding_insert() from public, anon, authenticated;
revoke execute on function community_voting_guard_votes() from public, anon, authenticated;
revoke execute on function community_voting_guard_interaction_update() from public, anon, authenticated;
revoke execute on function community_voting_guard_schedule_update() from public, anon, authenticated;
revoke execute on function community_voting_guard_photos() from public, anon, authenticated;
revoke execute on function community_voting_guard_media_decision() from public, anon, authenticated;
revoke execute on function community_voting_guard_withdrawals() from public, anon, authenticated;
revoke execute on function community_voting_guard_closures() from public, anon, authenticated;
revoke execute on function community_voting_guard_finalist_selection() from public, anon, authenticated;
revoke execute on function community_voting_guard_round_review() from public, anon, authenticated;
revoke execute on function community_voting_guard_policy_approval() from public, anon, authenticated;
revoke execute on function community_voting_guard_publication() from public, anon, authenticated;
revoke execute on function community_voting_guard_published_results() from public, anon, authenticated;
revoke execute on function community_voting_guard_promo_consent() from public, anon, authenticated;
revoke execute on function community_voting_guard_photo_privacy_action() from public, anon, authenticated;
revoke execute on function community_voting_guard_followup_task() from public, anon, authenticated;
