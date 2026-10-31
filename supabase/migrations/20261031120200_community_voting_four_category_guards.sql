-- Migration: 20261031120200_community_voting_four_category_guards
-- Halloween Community Voting — the four-category contest's table guards (UG-IV-GATE-018). See 20261031120000 for the composition.
--
-- ADDITIVE: new triggers on the new tables, and NEW triggers (never edits of existing trigger functions) on Community Voting tables from the pilot.
-- They do three jobs, each for EVERY writer (the table owner included, because a trigger is the backstop, not the first line):
--   1. make the contest's facts immutable or marker-gated, like every other Community Voting record;
--   2. make "one candidacy per person, in one category" and "a group has one photograph" true in the database;
--   3. close, for category rounds, the operations of the two-round journey that this contest retires: the finalist cut, the Product policy
--      approvals that only the cut needed, and a final descending from a category round. Those functions still exist as the pilot committed them
--      (nothing committed is edited or removed), but on a category round every one of them is refused here, and no route reaches them.

-- ---------------------------------------------------------------------------------------
-- Category rounds: written once, by the registration; never edited or removed
-- ---------------------------------------------------------------------------------------

create function community_voting_guard_category_round_insert()
returns trigger
language plpgsql
set search_path = public
as $$
declare
  v_instance community_voting_instances%rowtype;
  v_operator uuid;
begin
  if current_setting('urbano.community_voting_category_register', true) is distinct from new.instance_id::text then
    raise exception 'COMMUNITY_VOTING_ROUND_PATH_REQUIRED: a category round is registered only through its registration operation'
      using errcode = 'P0001';
  end if;

  select * into v_instance from community_voting_instances i where i.instance_id = new.instance_id;
  if not found
     or v_instance.ballot_mode is distinct from 'FAVORITE_ROUND'
     or v_instance.round_role is distinct from 'PRELIMINARY'
     or v_instance.is_test then
    raise exception 'COMMUNITY_VOTING_CATEGORY_INSTANCE: a category round is a real round without venue'
      using errcode = 'P0001';
  end if;

  select c.operator_gaming_member_id into v_operator from community_voting_contests c where c.contest_id = new.contest_id;
  if v_operator is distinct from v_instance.operator_gaming_member_id then
    raise exception 'COMMUNITY_VOTING_CATEGORY_OPERATOR: every round of a contest has the contest''s operator'
      using errcode = 'P0001';
  end if;
  return new;
end;
$$;

create trigger community_voting_category_rounds_guard_insert
  before insert on community_voting_category_rounds
  for each row execute function community_voting_guard_category_round_insert();
create trigger community_voting_category_rounds_no_update before update on community_voting_category_rounds
  for each row execute function community_voting_reject_update();
create trigger community_voting_category_rounds_no_delete before delete on community_voting_category_rounds
  for each row execute function community_voting_reject_history_loss();
create trigger community_voting_category_rounds_no_truncate before truncate on community_voting_category_rounds
  for each statement execute function community_voting_reject_history_loss();

-- ---------------------------------------------------------------------------------------
-- Contests: the listing on Home is the only fact that ever changes
-- ---------------------------------------------------------------------------------------

create function community_voting_guard_contest_update()
returns trigger
language plpgsql
set search_path = public
as $$
declare
  v_listing constant text[] := array['listed_at', 'listed_by_member_id'];
begin
  if (to_jsonb(new) - v_listing) is distinct from (to_jsonb(old) - v_listing) then
    raise exception 'COMMUNITY_VOTING_HISTORY_IMMUTABLE: a contest cannot be changed except by listing it on Home'
      using errcode = 'P0001';
  end if;
  return new;
end;
$$;

create trigger community_voting_contests_guard_update before update on community_voting_contests
  for each row execute function community_voting_guard_contest_update();
create trigger community_voting_contests_no_delete before delete on community_voting_contests
  for each row execute function community_voting_reject_history_loss();
create trigger community_voting_contests_no_truncate before truncate on community_voting_contests
  for each statement execute function community_voting_reject_history_loss();

-- ---------------------------------------------------------------------------------------
-- Entries: which kind goes where, and the kind never changes
-- ---------------------------------------------------------------------------------------
--
--   * a round that is NOT a category round (the pilot's, as committed) takes INDIVIDUAL entries only;
--   * the group category (BEST_GROUP) takes GROUP entries and their GROUP_MEMBER entries only — a costume for a group is a group;
--   * every other category takes INDIVIDUAL entries only — a group belongs in the group category;
--   * a member's group is a GROUP entry of the same Instance.

create function community_voting_guard_entry_kind()
returns trigger
language plpgsql
set search_path = public
as $$
declare
  v_category text;
  v_group_kind text;
begin
  select cr.category_key into v_category from community_voting_category_rounds cr where cr.instance_id = new.instance_id;

  if v_category is null then
    if new.entry_kind <> 'INDIVIDUAL' or new.group_entry_id is not null then
      raise exception 'CV_WRONG_ENTRY_KIND: groups exist only in the group category of a contest'
        using errcode = 'P0001';
    end if;
    return new;
  end if;

  if v_category = 'BEST_GROUP' then
    if new.entry_kind = 'INDIVIDUAL' then
      raise exception 'CV_WRONG_CATEGORY: the group category takes group candidacies only'
        using errcode = 'P0001';
    end if;
    if new.entry_kind = 'GROUP_MEMBER' then
      select g.entry_kind into v_group_kind
      from community_voting_entries g
      where g.entry_id = new.group_entry_id and g.instance_id = new.instance_id;
      if v_group_kind is distinct from 'GROUP' then
        raise exception 'CV_WRONG_ENTRY_KIND: a member belongs to a group candidacy of this category'
          using errcode = 'P0001';
      end if;
    end if;
  elsif new.entry_kind <> 'INDIVIDUAL' then
    raise exception 'CV_WRONG_CATEGORY: only the group category takes group candidacies'
      using errcode = 'P0001';
  end if;
  return new;
end;
$$;

create trigger community_voting_entries_guard_kind_insert
  before insert on community_voting_entries
  for each row execute function community_voting_guard_entry_kind();

create function community_voting_guard_entry_kind_update()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if new.entry_kind is distinct from old.entry_kind or new.group_entry_id is distinct from old.group_entry_id then
    raise exception 'COMMUNITY_VOTING_HISTORY_IMMUTABLE: an entry''s kind and group cannot change'
      using errcode = 'P0001';
  end if;
  return new;
end;
$$;

create trigger community_voting_entries_guard_kind_update
  before update on community_voting_entries
  for each row execute function community_voting_guard_entry_kind_update();

-- ---------------------------------------------------------------------------------------
-- One candidacy per PERSON in the whole contest
-- ---------------------------------------------------------------------------------------
--
-- The identity of a candidacy is the canonical Gaming Member behind a CONFIRMED association. Three triggers on the entries keep
-- community_voting_contest_identities exactly in step with them, so that a person can be the individual contestant, the representative of a
-- group or a member of a group ONCE, in ONE category:
--   * at the CLAIM (pending binding set): a person who already belongs to another candidacy is refused before anything changes, and the claim
--     credential stays intact;
--   * at the CONFIRMATION (confirmed binding set): the identity row is written; the primary key is the last word if two confirmations race;
--   * at the REMOVAL of an entry before opening: its identity row goes with it, so the person is free again.
-- A withdrawal keeps the row: leaving the competition does not entitle the person to another candidacy.

create function community_voting_candidacy_claim_guard()
returns trigger
language plpgsql
set search_path = public
as $$
declare
  v_contest uuid;
  v_member uuid;
begin
  if new.pending_binding_id is null or old.pending_binding_id is not distinct from new.pending_binding_id then
    return new;
  end if;
  select cr.contest_id into v_contest from community_voting_category_rounds cr where cr.instance_id = new.instance_id;
  if v_contest is null then
    return new;
  end if;
  select b.gaming_member_id into v_member from community_voting_voter_bindings b where b.binding_id = new.pending_binding_id;
  if v_member is not null and exists (
    select 1 from community_voting_contest_identities ci
    where ci.contest_id = v_contest and ci.gaming_member_id = v_member and ci.entry_id <> new.entry_id
  ) then
    raise exception 'CV_ALREADY_CANDIDATE: this person already belongs to a candidacy of the contest; a person takes part once, in one category'
      using errcode = 'P0001';
  end if;
  return new;
end;
$$;

create trigger community_voting_entries_candidacy_claim
  before update of pending_binding_id on community_voting_entries
  for each row execute function community_voting_candidacy_claim_guard();

create function community_voting_candidacy_record()
returns trigger
language plpgsql
set search_path = public
as $$
declare
  v_contest uuid;
  v_member uuid;
  v_existing uuid;
begin
  if new.confirmed_binding_id is null or old.confirmed_binding_id is not null then
    return new;
  end if;
  select cr.contest_id into v_contest from community_voting_category_rounds cr where cr.instance_id = new.instance_id;
  if v_contest is null then
    return new;
  end if;
  select b.gaming_member_id into v_member from community_voting_voter_bindings b where b.binding_id = new.confirmed_binding_id;
  if v_member is null then
    raise exception 'CV_PROFILE_INCOMPLETE: a candidacy is associated with a complete URBANO Gaming profile'
      using errcode = 'P0001';
  end if;
  -- A self-registration wrote this person's identity when it was made (so a person cannot register twice before the station confirms them):
  -- the confirmation of THAT entry finds it and has nothing to add. Any other entry that finds it is a second candidacy.
  select ci.entry_id into v_existing from community_voting_contest_identities ci where ci.contest_id = v_contest and ci.gaming_member_id = v_member;
  if found then
    if v_existing = new.entry_id then
      return new;
    end if;
    raise exception 'CV_ALREADY_CANDIDATE: this person already belongs to a candidacy of the contest; a person takes part once, in one category'
      using errcode = 'P0001';
  end if;
  begin
    insert into community_voting_contest_identities (contest_id, gaming_member_id, instance_id, entry_id, role)
    values (
      v_contest, v_member, new.instance_id, new.entry_id,
      case new.entry_kind when 'GROUP' then 'REPRESENTATIVE' when 'GROUP_MEMBER' then 'MEMBER' else 'INDIVIDUAL' end
    );
  exception when unique_violation then
    raise exception 'CV_ALREADY_CANDIDATE: this person already belongs to a candidacy of the contest; a person takes part once, in one category'
      using errcode = 'P0001';
  end;
  return new;
end;
$$;

create trigger community_voting_entries_candidacy_record
  after update of confirmed_binding_id on community_voting_entries
  for each row execute function community_voting_candidacy_record();

create function community_voting_candidacy_release()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  delete from community_voting_contest_identities where entry_id = old.entry_id;
  return old;
end;
$$;

create trigger community_voting_entries_candidacy_release
  before delete on community_voting_entries
  for each row execute function community_voting_candidacy_release();

-- The identity rows themselves: written and removed only under the same marker the entries require (set by the operations that change the
-- entries), never edited, never truncated.
create function community_voting_guard_contest_identities()
returns trigger
language plpgsql
set search_path = public
as $$
declare
  v_instance uuid := coalesce(new.instance_id, old.instance_id);
begin
  if current_setting('urbano.community_voting_round_op', true) is distinct from v_instance::text then
    raise exception 'COMMUNITY_VOTING_ROUND_PATH_REQUIRED: a candidacy identity changes only with its entry'
      using errcode = 'P0001';
  end if;
  return coalesce(new, old);
end;
$$;

create trigger community_voting_contest_identities_guard before insert or delete on community_voting_contest_identities
  for each row execute function community_voting_guard_contest_identities();
create trigger community_voting_contest_identities_no_update before update on community_voting_contest_identities
  for each row execute function community_voting_reject_update();
create trigger community_voting_contest_identities_no_truncate before truncate on community_voting_contest_identities
  for each statement execute function community_voting_reject_history_loss();

-- ---------------------------------------------------------------------------------------
-- Member consents: recorded only before opening, never edited
-- ---------------------------------------------------------------------------------------

create trigger community_voting_member_consents_guard before insert on community_voting_member_consents
  for each row execute function community_voting_guard_media_decision();
create trigger community_voting_member_consents_no_update before update on community_voting_member_consents
  for each row execute function community_voting_reject_update();
create trigger community_voting_member_consents_no_delete before delete on community_voting_member_consents
  for each row execute function community_voting_reject_history_loss();
create trigger community_voting_member_consents_no_truncate before truncate on community_voting_member_consents
  for each statement execute function community_voting_reject_history_loss();

-- ---------------------------------------------------------------------------------------
-- What the contest retires, refused for a category round
-- ---------------------------------------------------------------------------------------

create function community_voting_reject_category_obsolete()
returns trigger
language plpgsql
set search_path = public
as $$
declare
  v_instance uuid;
begin
  -- Nested on purpose (the pilot's own note on community_voting_guard_media_decision): this function serves three tables, and PL/pgSQL resolves
  -- a record's field at execution, so each field is referenced only inside the branch of the table that has it.
  if tg_table_name = 'community_voting_policy_approvals' then
    v_instance := new.instance_id;
  else
    v_instance := new.preliminary_instance_id;
  end if;
  if exists (select 1 from community_voting_category_rounds cr where cr.instance_id = v_instance) then
    raise exception 'CV_OBSOLETE_FOR_CATEGORY: a category round has no finalist cut, no final and no Product policy of the cut'
      using errcode = 'P0001';
  end if;
  return new;
end;
$$;

create trigger community_voting_finalist_selections_no_category before insert on community_voting_finalist_selections
  for each row execute function community_voting_reject_category_obsolete();
create trigger community_voting_finalists_no_category before insert on community_voting_finalists
  for each row execute function community_voting_reject_category_obsolete();
create trigger community_voting_policy_approvals_no_category before insert on community_voting_policy_approvals
  for each row execute function community_voting_reject_category_obsolete();

create function community_voting_guard_no_final_after_category()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if new.ballot_mode = 'FAVORITE_ROUND' and new.round_role = 'FINAL'
     and exists (select 1 from community_voting_category_rounds cr where cr.instance_id = new.source_instance_id) then
    raise exception 'CV_OBSOLETE_FOR_CATEGORY: a category round has no final'
      using errcode = 'P0001';
  end if;
  return new;
end;
$$;

create trigger community_voting_instances_no_final_after_category before insert on community_voting_instances
  for each row execute function community_voting_guard_no_final_after_category();

-- ---------------------------------------------------------------------------------------
-- Privileges: every function above is revoked from PUBLIC, anon and authenticated in the migration that creates it.
-- ---------------------------------------------------------------------------------------

revoke execute on function community_voting_guard_category_round_insert() from public, anon, authenticated;
revoke execute on function community_voting_guard_contest_update() from public, anon, authenticated;
revoke execute on function community_voting_guard_entry_kind() from public, anon, authenticated;
revoke execute on function community_voting_guard_entry_kind_update() from public, anon, authenticated;
revoke execute on function community_voting_candidacy_claim_guard() from public, anon, authenticated;
revoke execute on function community_voting_candidacy_record() from public, anon, authenticated;
revoke execute on function community_voting_candidacy_release() from public, anon, authenticated;
revoke execute on function community_voting_guard_contest_identities() from public, anon, authenticated;
revoke execute on function community_voting_reject_category_obsolete() from public, anon, authenticated;
revoke execute on function community_voting_guard_no_final_after_category() from public, anon, authenticated;
