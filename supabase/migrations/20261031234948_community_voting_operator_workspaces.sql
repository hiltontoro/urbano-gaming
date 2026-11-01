-- Founder-authorized operator workspaces: logical rehearsal/live separation and explicit registration opening.
-- This does not create an independent Voting lifecycle: Session still owns Voting open/close/reveal.
-- Rehearsals share infrastructure, never appear on Home, and must contain synthetic/authorized material only.
alter table community_voting_contests add column purpose text not null default 'LIVE'
  check (purpose in ('LIVE', 'REHEARSAL'));

create function community_voting_contest_purpose_at_birth() returns trigger
language plpgsql security invoker set search_path=public as $$
begin
  new.purpose := coalesce(nullif(current_setting('urbano.contest_purpose',true),''),'LIVE');
  return new;
end; $$;
create trigger community_voting_contest_purpose_at_birth before insert on community_voting_contests
for each row execute function community_voting_contest_purpose_at_birth();
-- The existing immutable-contest guard already rejects any later change to purpose.
create function community_voting_rehearsal_not_listed() returns trigger
language plpgsql security invoker set search_path=public as $$
begin
  if new.purpose='REHEARSAL' and new.listed_at is not null then
    raise exception 'CV_INVALID_REQUEST: a rehearsal cannot appear on Home' using errcode='P0001';
  end if;
  return new;
end; $$;
create trigger community_voting_rehearsal_not_listed before insert or update on community_voting_contests
for each row execute function community_voting_rehearsal_not_listed();

create function register_community_voting_workspace_category(
  p_session_id uuid,p_host_token text,p_operator_member_id uuid,p_rule_version integer,
  p_contest_id uuid,p_category_key text,p_purpose text
) returns table(instance_id uuid,session_id uuid,contest_id uuid,category_key text,rule_version integer,created_at timestamptz)
language plpgsql security invoker set search_path=public as $$
begin
  if p_purpose is null or p_purpose not in ('LIVE','REHEARSAL') then
    raise exception 'CV_INVALID_REQUEST: unknown contest purpose' using errcode='P0001';
  end if;
  if p_contest_id is not null and exists(select 1 from community_voting_contests c where c.contest_id=p_contest_id and c.purpose<>p_purpose) then
    raise exception 'CV_INVALID_REQUEST: cannot mix rehearsal and live categories' using errcode='P0001';
  end if;
  perform set_config('urbano.contest_purpose',p_purpose,true);
  return query select * from register_community_voting_category_round_atomically(p_session_id,p_host_token,p_operator_member_id,p_rule_version,p_contest_id,p_category_key);
  perform set_config('urbano.contest_purpose','',true);
end; $$;

create table community_voting_registration_openings (
  contest_id uuid primary key references community_voting_contests(contest_id) on delete restrict,
  operator_gaming_member_id uuid not null references gaming_members(gaming_member_id) on delete restrict,
  opened_at timestamptz not null default clock_timestamp()
);
alter table community_voting_registration_openings enable row level security;
revoke all on community_voting_registration_openings from public,anon,authenticated;
grant select,insert on community_voting_registration_openings to service_role;

create function community_voting_guard_registration_opening() returns trigger
language plpgsql security invoker set search_path=public as $$
begin
  if current_setting('urbano.registration_open',true) is distinct from new.contest_id::text then
    raise exception 'COMMUNITY_VOTING_ROUND_PATH_REQUIRED: use the explicit opening operation' using errcode='P0001';
  end if;
  return new;
end; $$;
create trigger community_voting_registration_opening_path before insert on community_voting_registration_openings
for each row execute function community_voting_guard_registration_opening();
create trigger community_voting_registration_opening_immutable before update or delete on community_voting_registration_openings
for each row execute function community_voting_reject_history_loss();
create trigger community_voting_registration_opening_no_truncate before truncate on community_voting_registration_openings
for each statement execute function community_voting_reject_history_loss();

create function open_community_voting_registration_atomically(p_instance_id uuid,p_host_token text,p_operator_member_id uuid)
returns table(contest_id uuid,opened_at timestamptz)
language plpgsql security invoker set search_path=public as $$
declare v_contest uuid; v_now timestamptz;
begin
  perform 1 from community_voting_authorize_operator(p_instance_id,p_host_token,p_operator_member_id,false);
  select cr.contest_id into v_contest from community_voting_category_rounds cr where cr.instance_id=p_instance_id;
  if v_contest is null or (select count(*) from community_voting_category_rounds cr where cr.contest_id=v_contest)<>4 then
    raise exception 'CV_INVALID_REQUEST: all four categories must exist before registration opens' using errcode='P0001';
  end if;
  -- Same Session-first order as registration, with deterministic order across the four categories.
  perform 1 from sessions s where s.session_id in
    (select i.session_id from community_voting_instances i join community_voting_category_rounds cr using(instance_id) where cr.contest_id=v_contest)
    order by s.session_id for update;
  perform 1 from community_voting_authorize_operator(p_instance_id,p_host_token,p_operator_member_id,true);
  perform 1 from community_voting_contests c where c.contest_id=v_contest for update;
  -- An exact retry only reports the already applied opening; it never creates a second opening.
  if exists(select 1 from community_voting_registration_openings o where o.contest_id=v_contest) then
    return query select o.contest_id,o.opened_at from community_voting_registration_openings o where o.contest_id=v_contest;
    return;
  end if;
  v_now:=clock_timestamp();
  if exists(select 1 from community_voting_category_rounds cr left join community_voting_schedules sc using(instance_id)
    where cr.contest_id=v_contest and (sc.registration_opens_at is null or sc.contestant_cutoff_at is null or sc.voting_closes_at is null)) then
    raise exception 'CV_SCHEDULE_REQUIRED: configure all four category schedules' using errcode='P0001';
  end if;
  if exists(select 1 from community_voting_category_rounds cr join community_voting_schedules sc using(instance_id)
    where cr.contest_id=v_contest and (v_now<sc.registration_opens_at or v_now>=sc.contestant_cutoff_at)) then
    raise exception 'CV_REGISTRATION_NOT_OPEN: outside the configured registration window' using errcode='P0001';
  end if;
  if exists(select 1 from community_voting_category_rounds cr join community_voting_instances i using(instance_id)
    join interaction_instances ii on ii.session_id=i.session_id where cr.contest_id=v_contest) then
    raise exception 'CV_PREPARATION_CLOSED: Voting has already started' using errcode='P0001';
  end if;
  perform set_config('urbano.registration_open',v_contest::text,true);
  insert into community_voting_registration_openings(contest_id,operator_gaming_member_id) values(v_contest,p_operator_member_id);
  perform set_config('urbano.registration_open','',true);
  return query select o.contest_id,o.opened_at from community_voting_registration_openings o where o.contest_id=v_contest;
end; $$;

-- Runs within the self-registration transaction. Failure rolls back the entry, identity binding and contact together.
-- Operator-only preparation/intake is unchanged; this is admission to contestant self-registration, not Voting opening.
create function community_voting_require_manual_registration() returns trigger
language plpgsql security invoker set search_path=public as $$
begin
  perform 1 from community_voting_contests c where c.contest_id=new.contest_id for share;
  if not exists(select 1 from community_voting_registration_openings o where o.contest_id=new.contest_id) then
    raise exception 'CV_REGISTRATION_NOT_OPEN: the operator has not explicitly opened registration' using errcode='P0001';
  end if;
  return new;
end; $$;
create trigger community_voting_manual_registration_required before insert on community_voting_registrations
for each row execute function community_voting_require_manual_registration();

create function read_community_voting_workspace(p_contest_id uuid)
returns table(category_key text,instance_id uuid,listed boolean,purpose text,registration_opened boolean)
language sql stable security invoker set search_path=public as $$
  select r.category_key,r.instance_id,c.listed_at is not null,c.purpose,
    exists(select 1 from community_voting_registration_openings o where o.contest_id=c.contest_id)
  from community_voting_category_rounds r join community_voting_contests c using(contest_id)
  where c.contest_id=p_contest_id
  order by array_position(array['MOST_ELABORATE','SEXIEST','BEST_GROUP','FUNNIEST'],r.category_key);
$$;

revoke execute on function community_voting_contest_purpose_at_birth() from public,anon,authenticated;
revoke execute on function community_voting_rehearsal_not_listed() from public,anon,authenticated;
revoke execute on function register_community_voting_workspace_category(uuid,text,uuid,integer,uuid,text,text) from public,anon,authenticated;
revoke execute on function community_voting_guard_registration_opening() from public,anon,authenticated;
revoke execute on function open_community_voting_registration_atomically(uuid,text,uuid) from public,anon,authenticated;
revoke execute on function community_voting_require_manual_registration() from public,anon,authenticated;
revoke execute on function read_community_voting_workspace(uuid) from public,anon,authenticated;
grant execute on function register_community_voting_workspace_category(uuid,text,uuid,integer,uuid,text,text),
 open_community_voting_registration_atomically(uuid,text,uuid),read_community_voting_workspace(uuid) to service_role;
