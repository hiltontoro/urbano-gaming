-- Branded Team Registration and Invitation Journey — corrected lifecycle
-- (UG-CR-RPT-041, Founder decision 1). The accepted Soccer Slice 001
-- lifecycle (DRAFT -> PUBLISHED) assumed all four teams exist before any
-- member-facing action is possible. The new Founder direction requires a
-- member to register and propose a team before the four-team bracket is
-- finalized, which the existing two states cannot express. This
-- migration inserts exactly two new intermediate states between the
-- existing DRAFT and PUBLISHED, and touches nothing else:
--
--   DRAFT (unchanged) -> TEAM_REGISTRATION_OPEN (new) ->
--   READY_TO_PUBLISH (new) -> PUBLISHED (unchanged) -> COMPLETE /
--   CANCELLED_WITHOUT_CHAMPION (unchanged)
--
-- The existing constraint was declared inline with no explicit name, so
-- Postgres assigned it the default `competitions_state_check` name — but
-- this migration looks it up dynamically rather than assuming that name,
-- so it is correct even if some earlier, unrelated migration ever
-- renamed it.
do $$
declare
  v_constraint_name text;
begin
  select conname into v_constraint_name
    from pg_constraint
   where conrelid = 'competitions'::regclass
     and contype = 'c'
     and pg_get_constraintdef(oid) ilike '%state%';
  if v_constraint_name is not null then
    execute format('alter table competitions drop constraint %I', v_constraint_name);
  end if;
end $$;

alter table competitions add constraint competitions_state_check
  check (state in ('DRAFT', 'TEAM_REGISTRATION_OPEN', 'READY_TO_PUBLISH', 'PUBLISHED', 'COMPLETE', 'CANCELLED_WITHOUT_CHAMPION'));
