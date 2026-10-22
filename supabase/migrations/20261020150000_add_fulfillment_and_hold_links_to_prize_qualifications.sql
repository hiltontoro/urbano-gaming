-- Migration: 20261020150000_add_fulfillment_and_hold_links_to_prize_qualifications
-- Score Predictions — Result Integrity and Prize Correction.
--
-- Additive, plus backfills that only ever ADD evidence and never infer it.
-- Gives a Prize Qualification the explicit facts a correction needs so a
-- physically delivered prize is never delivered a second time by accident,
-- and so a changed or unprovable entitlement is held for a reasoned
-- Founder decision instead of silently becoming redeemable.
--
-- LINEAGE. The order of an entitlement within one member's chain for one
-- activation is lineage_ordinal: the number of ancestors of its result in
-- the explicit supersession chain of match_results
-- (supersedes_match_result_id, unique per target). It is derived from that
-- chain only — never from created_at, redeemed_at, superseded_at or an id.
-- Timestamps are transaction-START times: two transactions can begin in
-- one order and take their locks in another, and one transaction can
-- write several rows with one timestamp, so no timestamp can order a
-- chain. (gaming_member_id, venue_activation_id, lineage_ordinal) is
-- unique, so the database itself refuses two entitlements at one position.
-- A row whose position cannot be established (legacy anomalies) keeps
-- lineage_ordinal NULL, and a chain that contains such a redeemed row is
-- never treated as ordered: the correction function holds the new
-- entitlement for reconciliation instead of guessing.
--
-- DELIVERY EVIDENCE. Three different facts about a past redemption are
-- kept apart and never confused:
--   SNAPSHOT_AT_REDEMPTION  redeemed_prize_label is the label read at the
--                           moment this system recorded the delivery;
--   OBSERVED_AT_MIGRATION   a redemption recorded BEFORE labels were
--                           snapshotted: legacy_observed_prize_label is the
--                           prize definition seen at migration time. That
--                           is today's definition, not evidence of what
--                           was handed over, and it is NEVER used to
--                           decide that a corrected entitlement is the
--                           same prize;
--   UNKNOWN                 nothing is known.
-- Only SNAPSHOT_AT_REDEMPTION can make a corrected entitlement
-- "fulfilled" by an earlier delivery. Anything else is held for
-- reconciliation under the accepted hold policy.
--
-- Columns added to prize_qualifications:
--   replaces_prize_qualification_id        history link to the row replaced
--   fulfilled_by_prize_qualification_id    the ORIGINAL redeemed row whose
--                                          delivery satisfies this row; a
--                                          satisfied row has no redemption
--                                          of its own and is never
--                                          redeemable
--   hold_prior_prize_qualification_id,     a replacement that must not be
--   held_at, hold_basis, hold_reason       delivered until a Consequential
--                                          Finalizer releases it
--   released_at, released_by_..., release_reason
--   redeemed_prize_label,                  see DELIVERY EVIDENCE
--   redeemed_prize_label_basis,
--   legacy_observed_prize_label
--   lineage_ordinal                        see LINEAGE
--
-- hold_basis says WHY a row is held:
--   DELIVERED_PRIZE_CHANGED       delivery evidence is a snapshot and the
--                                 corrected prize differs from it
--   DELIVERY_EQUIVALENCE_UNKNOWN  the earlier delivery has no snapshot, so
--                                 whether it is the same prize is unknown
--   DELIVERY_ORDER_UNKNOWN        the deliveries of this chain cannot be
--                                 put in order
--   LEGACY_PENDING_TWIN           backfilled: an unredeemed replacement
--                                 issued by the old correction beside an
--                                 earlier delivery
--
-- Transitional enforcement: while the OLD redeem and correct functions are
-- still installed (until the next migration), two triggers keep them from
-- redeeming a held or satisfied entitlement and from creating an
-- entitlement beside a delivery without holding it. See the end of this
-- file; the next migration drops them when it installs its own guard.
--
-- Backfills (all run before the guard triggers of the next migration
-- exist, and none touches a delivery fact that already existed):
--   1. lineage_ordinal from the result chain; where two rows of one chain
--      claim the same position (a legacy fork) NEITHER is ordered;
--   2. delivery-evidence basis for every existing redemption:
--      OBSERVED_AT_MIGRATION with today's definition, or UNKNOWN;
--   3. legacy pending twins are placed on hold (LEGACY_PENDING_TWIN with
--      the latest earlier delivery, or DELIVERY_ORDER_UNKNOWN when the
--      order is not established).

create function match_result_lineage_ordinal(p_match_result_id uuid)
returns integer
language sql
security invoker
set search_path = public
as $$
  with recursive up(match_result_id, parent_id, depth) as (
    select r.match_result_id, r.supersedes_match_result_id, 0
      from match_results r
     where r.match_result_id = p_match_result_id
    union all
    select r.match_result_id, r.supersedes_match_result_id, up.depth + 1
      from match_results r
      join up on r.match_result_id = up.parent_id
     where up.depth < 10000
  )
  -- A chain that reaches the cap is a cycle, not an order.
  select case when max(depth) >= 10000 then null else max(depth) end from up;
$$;

revoke execute on function match_result_lineage_ordinal(uuid) from public, anon, authenticated;
grant execute on function match_result_lineage_ordinal(uuid) to service_role;

alter table prize_qualifications
  add column replaces_prize_qualification_id uuid
    references prize_qualifications (prize_qualification_id),
  add column fulfilled_by_prize_qualification_id uuid
    references prize_qualifications (prize_qualification_id),
  add column hold_prior_prize_qualification_id uuid
    references prize_qualifications (prize_qualification_id),
  add column held_at timestamptz,
  add column hold_basis text,
  add column hold_reason text,
  add column released_at timestamptz,
  add column released_by_gaming_member_id uuid
    references gaming_members (gaming_member_id),
  add column release_reason text,
  add column redeemed_prize_label text,
  add column redeemed_prize_label_basis text,
  add column legacy_observed_prize_label text,
  add column lineage_ordinal integer;

-- Backfill 1: lineage from the explicit result chain.
update prize_qualifications
   set lineage_ordinal = match_result_lineage_ordinal(evaluations.match_result_id)
  from evaluations
 where evaluations.evaluation_id = prize_qualifications.evaluation_id;

-- A legacy fork (two roots, or two rows at one position) is not an order.
update prize_qualifications
   set lineage_ordinal = null
 where lineage_ordinal is not null
   and exists (
     select 1
       from prize_qualifications other
      where other.gaming_member_id = prize_qualifications.gaming_member_id
        and other.venue_activation_id = prize_qualifications.venue_activation_id
        and other.lineage_ordinal = prize_qualifications.lineage_ordinal
        and other.prize_qualification_id <> prize_qualifications.prize_qualification_id
   );

-- Backfill 2: what is known about each existing delivery. The current
-- definition is recorded as an OBSERVATION; it is not delivery evidence.
update prize_qualifications
   set redeemed_prize_label_basis = case
         when (select prize_tiers.prize_label from prize_tiers
                where prize_tiers.prize_tier_id = prize_qualifications.prize_tier_id) is not null
           then 'OBSERVED_AT_MIGRATION'
         else 'UNKNOWN'
       end,
       legacy_observed_prize_label = (
         select prize_tiers.prize_label from prize_tiers
          where prize_tiers.prize_tier_id = prize_qualifications.prize_tier_id
       )
 where prize_qualifications.redeemed_at is not null;

create unique index prize_qualifications_lineage_position_key
  on prize_qualifications (gaming_member_id, venue_activation_id, lineage_ordinal)
  where lineage_ordinal is not null;

create index prize_qualifications_member_activation_idx
  on prize_qualifications (gaming_member_id, venue_activation_id);

-- The hold decision for an unredeemed entitlement that coexists with a
-- delivery, in one place: the backfill below and the transitional insert
-- trigger further down both use it, so they cannot disagree. Returns no row
-- when the member has no delivery for the activation. The earlier delivery
-- is named only when every delivery of the chain has a lineage position and
-- the latest one precedes this entitlement; otherwise nothing is guessed
-- (DELIVERY_ORDER_UNKNOWN, no prior).
create function prize_qualification_twin_hold(
  p_gaming_member_id uuid,
  p_venue_activation_id uuid,
  p_lineage_ordinal integer
)
returns table (hold_basis text, hold_prior_prize_qualification_id uuid, hold_reason text)
language sql
stable
security invoker
set search_path = public
as $$
  with d as (
    select count(*) as redeemed_count,
           count(*) filter (where r.lineage_ordinal is null) as unordered_count,
           max(r.lineage_ordinal) as latest_ordinal
      from prize_qualifications r
     where r.gaming_member_id = p_gaming_member_id
       and r.venue_activation_id = p_venue_activation_id
       and r.redeemed_at is not null
  ),
  latest as (
    select r.prize_qualification_id
      from prize_qualifications r
     where r.gaming_member_id = p_gaming_member_id
       and r.venue_activation_id = p_venue_activation_id
       and r.redeemed_at is not null
       and r.lineage_ordinal is not null
     order by r.lineage_ordinal desc
     limit 1
  ),
  decided as (
    select d.redeemed_count,
           coalesce(p_lineage_ordinal is not null
                    and d.unordered_count = 0
                    and d.latest_ordinal < p_lineage_ordinal, false) as ordered
      from d
  )
  select case when decided.ordered then 'LEGACY_PENDING_TWIN' else 'DELIVERY_ORDER_UNKNOWN' end,
         case when decided.ordered then (select latest.prize_qualification_id from latest) else null end,
         case when decided.ordered
           then 'Held automatically: this entitlement was issued by a correction after an earlier prize for the same match had already been delivered. A Consequential Finalizer must decide, with a reason, whether any further delivery is intended.'
           else 'Held automatically: a prize for this member and match was already delivered, and the order of the deliveries and replacements could not be established from the records. A Consequential Finalizer must reconcile this with the venue, with a reason, before any further delivery.'
         end
    from decided
   where decided.redeemed_count > 0;
$$;

revoke execute on function prize_qualification_twin_hold(uuid, uuid, integer) from public, anon, authenticated;
grant execute on function prize_qualification_twin_hold(uuid, uuid, integer) to service_role;

-- Backfill 3: hold legacy pending twins. A twin is an unredeemed,
-- non-superseded row that coexists with a delivery for the same member
-- and activation (the old correction issued one beside every delivery).
update prize_qualifications
   set held_at = now(),
       hold_basis = decision.hold_basis,
       hold_prior_prize_qualification_id = decision.hold_prior_prize_qualification_id,
       hold_reason = decision.hold_reason
  from prize_qualifications as t
  cross join lateral prize_qualification_twin_hold(t.gaming_member_id, t.venue_activation_id, t.lineage_ordinal) as decision
 where t.prize_qualification_id = prize_qualifications.prize_qualification_id
   and prize_qualifications.redeemed_at is null
   and prize_qualifications.superseded_at is null
   and prize_qualifications.held_at is null
   and prize_qualifications.fulfilled_by_prize_qualification_id is null;

-- Constraints that describe the final shape, added after the backfills so
-- that pre-existing rows are brought into that shape first.
--
-- PostgreSQL accepts a CHECK whose expression is NULL (UNKNOWN), not only
-- TRUE. Every constraint below is therefore written so that no input,
-- including a missing basis or a missing reason, can make it evaluate to
-- NULL: comparisons that can see a NULL column use IS [NOT] DISTINCT FROM
-- or are guarded by an explicit IS NOT NULL.
alter table prize_qualifications
  add constraint prize_qualifications_hold_shape check (
    (held_at is null
       and hold_prior_prize_qualification_id is null
       and hold_basis is null
       and hold_reason is null)
    or (
      held_at is not null
      and hold_basis is not null
      and hold_basis in (
        'DELIVERED_PRIZE_CHANGED', 'DELIVERY_EQUIVALENCE_UNKNOWN',
        'DELIVERY_ORDER_UNKNOWN', 'LEGACY_PENDING_TWIN'
      )
      and hold_reason is not null
      and char_length(btrim(hold_reason)) >= 1
      and (hold_prior_prize_qualification_id is not null
           or hold_basis is not distinct from 'DELIVERY_ORDER_UNKNOWN')
    )
  ),
  add constraint prize_qualifications_release_shape check (
    (released_at is null and released_by_gaming_member_id is null and release_reason is null)
    or (
      held_at is not null
      and released_at is not null
      and released_by_gaming_member_id is not null
      and release_reason is not null
      and char_length(btrim(release_reason)) >= 1
    )
  ),
  add constraint prize_qualifications_fulfilled_excludes_hold check (
    fulfilled_by_prize_qualification_id is null or held_at is null
  ),
  add constraint prize_qualifications_fulfilled_has_no_own_redemption check (
    fulfilled_by_prize_qualification_id is null
    or (redeemed_at is null and redeemed_by_gaming_member_id is null)
  ),
  add constraint prize_qualifications_no_self_link check (
    fulfilled_by_prize_qualification_id is distinct from prize_qualification_id
    and hold_prior_prize_qualification_id is distinct from prize_qualification_id
    and replaces_prize_qualification_id is distinct from prize_qualification_id
  ),
  add constraint prize_qualifications_delivery_evidence_shape check (
    (redeemed_at is null
       and redeemed_prize_label is null
       and redeemed_prize_label_basis is null
       and legacy_observed_prize_label is null)
    or (
      redeemed_at is not null
      and (
        (redeemed_prize_label_basis is not distinct from 'SNAPSHOT_AT_REDEMPTION'
           and redeemed_prize_label is not null
           and legacy_observed_prize_label is null)
        or (redeemed_prize_label_basis is not distinct from 'OBSERVED_AT_MIGRATION'
           and redeemed_prize_label is null
           and legacy_observed_prize_label is not null)
        or (redeemed_prize_label_basis is not distinct from 'UNKNOWN'
           and redeemed_prize_label is null
           and legacy_observed_prize_label is null)
      )
    )
  ),
  add constraint prize_qualifications_lineage_non_negative check (
    lineage_ordinal is null or lineage_ordinal >= 0
  );

-- ---------------------------------------------------------------------
-- Transitional database enforcement (replaced by the next migration)
-- ---------------------------------------------------------------------
--
-- The hold-aware redeem function and the evidence guard arrive in the NEXT
-- migration. Until then the OLD redeem and correct functions (which know
-- nothing of holds, lineage or delivery evidence) are still the installed
-- ones, so this migration cannot leave a window in which they undo what it
-- just recorded. Two triggers close it; the next migration drops them in
-- the same transaction that installs its own, stronger guard.
--
--   1. A held entitlement cannot be redeemed, and a satisfied one cannot
--      be either, whatever function or statement tries. An ordinary
--      redemption still works exactly as before; the label is read from
--      the prize at that very moment and stored as a SNAPSHOT_AT_REDEMPTION,
--      which is what the new function records itself.
--   2. An entitlement created beside an existing delivery (the old
--      correction does this) is held on creation, and any entitlement
--      created without a lineage position is given the one its result has.

create function prize_qualifications_transitional_redeem_guard()
returns trigger
language plpgsql
security invoker
set search_path = public
as $$
begin
  if old.redeemed_at is null and new.redeemed_at is not null then
    if old.held_at is not null and old.released_at is null then
      raise exception 'PRIZE_QUALIFICATION_HELD: this entitlement is on hold until a Consequential Finalizer releases it'
        using errcode = 'P0001';
    end if;
    if old.fulfilled_by_prize_qualification_id is not null then
      raise exception 'PRIZE_ALREADY_FULFILLED: an earlier delivery already satisfies this entitlement'
        using errcode = 'P0001';
    end if;
    if new.redeemed_prize_label_basis is null then
      new.redeemed_prize_label_basis := 'SNAPSHOT_AT_REDEMPTION';
      new.legacy_observed_prize_label := null;
      select prize_tiers.prize_label into new.redeemed_prize_label
      from prize_tiers
      where prize_tiers.prize_tier_id = new.prize_tier_id;
    end if;
  end if;
  return new;
end;
$$;

create function prize_qualifications_transitional_insert_guard()
returns trigger
language plpgsql
security invoker
set search_path = public
as $$
declare
  v_position integer;
  v_basis text;
  v_prior uuid;
  v_reason text;
begin
  if new.lineage_ordinal is null then
    select match_result_lineage_ordinal(evaluations.match_result_id) into v_position
    from evaluations
    where evaluations.evaluation_id = new.evaluation_id;
    if v_position is not null and not exists (
      select 1 from prize_qualifications other
      where other.gaming_member_id = new.gaming_member_id
        and other.venue_activation_id = new.venue_activation_id
        and other.lineage_ordinal = v_position
    ) then
      new.lineage_ordinal := v_position;
    end if;
  end if;

  if new.redeemed_at is null
     and new.held_at is null
     and new.fulfilled_by_prize_qualification_id is null then
    select twin.hold_basis, twin.hold_prior_prize_qualification_id, twin.hold_reason
      into v_basis, v_prior, v_reason
    from prize_qualification_twin_hold(new.gaming_member_id, new.venue_activation_id, new.lineage_ordinal) as twin;
    if v_basis is not null then
      new.held_at := now();
      new.hold_basis := v_basis;
      new.hold_prior_prize_qualification_id := v_prior;
      new.hold_reason := v_reason;
    end if;
  end if;
  return new;
end;
$$;

revoke execute on function prize_qualifications_transitional_redeem_guard() from public, anon, authenticated;
revoke execute on function prize_qualifications_transitional_insert_guard() from public, anon, authenticated;

create trigger prize_qualifications_transitional_redeem_guard
  before update on prize_qualifications
  for each row execute function prize_qualifications_transitional_redeem_guard();
create trigger prize_qualifications_transitional_insert_guard
  before insert on prize_qualifications
  for each row execute function prize_qualifications_transitional_insert_guard();
