-- Founder: seven days after contest close, ALL contestant photos (including winners)
-- and registration WhatsApps. Only four-category contests; ordinary Sessions/Voting untouched.
-- pg_cron runs inside Postgres: no HTTP, provider credentials or public cleanup endpoint.
begin;
create extension if not exists pg_cron;

create function community_voting_retention_due(p_contest_id uuid)
returns timestamptz language sql stable security invoker set search_path=public as $$
  select case when count(*)=4 and count(s.voting_closes_at)=4
    then max(s.voting_closes_at)+interval '7 days' end
  from community_voting_category_rounds r
  left join community_voting_schedules s on s.instance_id=r.instance_id
  where r.contest_id=p_contest_id
$$;
revoke all on function community_voting_retention_due(uuid) from public,anon,authenticated;
grant execute on function community_voting_retention_due(uuid) to service_role;

create function community_voting_reject_expired_media()
returns trigger language plpgsql security invoker set search_path=public as $$
begin
  if exists(select 1 from community_voting_category_rounds r where r.instance_id=new.instance_id
    and community_voting_retention_due(r.contest_id)<=clock_timestamp()) then
    raise exception 'CV_PREPARATION_CLOSED: the contest media retention period has ended' using errcode='P0001';
  end if;
  return new;
end;
$$;
revoke all on function community_voting_reject_expired_media() from public,anon,authenticated;
create trigger community_voting_photos_retention_guard before insert on community_voting_entry_photos
  for each row execute function community_voting_reject_expired_media();

alter table community_voting_entry_photos drop constraint community_voting_entry_photos_reason_values;
alter table community_voting_entry_photos add constraint community_voting_entry_photos_reason_values
  check(bytes_deleted_reason is null or bytes_deleted_reason in ('REJECTED','SUPERSEDED','PRIVACY_REQUEST','RETENTION_EXPIRED'));
alter table community_voting_registrations alter column whatsapp_e164 drop not null;
alter table community_voting_registrations add column contact_deleted_at timestamptz;
alter table community_voting_registrations add constraint community_voting_contact_erasure_together
  check ((whatsapp_e164 is null)=(contact_deleted_at is not null));

-- Preserve every pre-existing registration guard, adding exactly one irreversible erasure transition.
create or replace function community_voting_guard_registrations()
returns trigger language plpgsql security invoker set search_path=public as $$
begin
  if tg_op='INSERT' then
    if current_setting('urbano.community_voting_registration',true) is distinct from new.entry_id::text then
      raise exception 'COMMUNITY_VOTING_ROUND_PATH_REQUIRED: a registration is made only through its operation' using errcode='P0001';
    end if;
    if new.whatsapp_e164 is null or new.contact_deleted_at is not null then
      raise exception 'COMMUNITY_VOTING_HISTORY_IMMUTABLE: a new registration requires its contact' using errcode='P0001';
    end if;
    return new;
  end if;
  if tg_op='DELETE' then
    if current_setting('urbano.community_voting_round_op',true) is distinct from old.instance_id::text then
      raise exception 'COMMUNITY_VOTING_ROUND_PATH_REQUIRED: a registration leaves only with its entry' using errcode='P0001';
    end if;
    return old;
  end if;
  if old.whatsapp_e164 is not null and new.whatsapp_e164 is null
    and old.contact_deleted_at is null and new.contact_deleted_at is not null
    and (to_jsonb(new)-array['whatsapp_e164','contact_deleted_at'])=(to_jsonb(old)-array['whatsapp_e164','contact_deleted_at'])
    and community_voting_retention_due(old.contest_id)<=clock_timestamp() then
    return new;
  end if;
  if (to_jsonb(new)-array['delivery_status','delivered_at','delivered_by_member_id']) is distinct from
     (to_jsonb(old)-array['delivery_status','delivered_at','delivered_by_member_id']) then
    raise exception 'COMMUNITY_VOTING_HISTORY_IMMUTABLE: registration identity and contact cannot change' using errcode='P0001';
  end if;
  if old.delivery_status<>'PENDING' or new.delivery_status<>'DELIVERED'
    or current_setting('urbano.community_voting_delivery',true) is distinct from old.entry_id::text then
    raise exception 'COMMUNITY_VOTING_ROUND_PATH_REQUIRED: delivery requires the explicit operator act' using errcode='P0001';
  end if;
  return new;
end;
$$;

create function erase_expired_community_voting_media()
returns table (photos_erased integer,contacts_erased integer)
language plpgsql security invoker set search_path=public as $$
declare c record; n integer;
begin
  photos_erased:=0; contacts_erased:=0;
  -- Serialize cleanup with contest configuration. No caller-supplied clock or deadline.
  for c in select contest_id from community_voting_contests
    where community_voting_retention_due(contest_id)<=clock_timestamp()
    order by contest_id for update loop
    -- Hold each schedule while deciding eligibility; a concurrent schedule edit cannot race erasure.
    perform 1 from community_voting_schedules s join community_voting_category_rounds r using(instance_id)
      where r.contest_id=c.contest_id order by s.instance_id for update of s;
    if community_voting_retention_due(c.contest_id)<=clock_timestamp() then
      update community_voting_entry_photos p
      set full_bytes=null,thumb_bytes=null,bytes_deleted_at=clock_timestamp(),bytes_deleted_reason='RETENTION_EXPIRED'
      where p.bytes_deleted_at is null and exists
        (select 1 from community_voting_category_rounds r where r.instance_id=p.instance_id and r.contest_id=c.contest_id);
      get diagnostics n=row_count; photos_erased:=photos_erased+n;
      update community_voting_registrations set whatsapp_e164=null,contact_deleted_at=clock_timestamp()
        where contest_id=c.contest_id and contact_deleted_at is null;
      get diagnostics n=row_count; contacts_erased:=contacts_erased+n;
    end if;
  end loop;
  return next;
end;
$$;
revoke all on function erase_expired_community_voting_media() from public,anon,authenticated,service_role;

-- The UI never constructs a WhatsApp link from a deleted contact. Explicit refusal, not null-as-a-number.
create or replace function read_community_voting_registration_contact(p_instance_id uuid,p_host_token text,p_operator_member_id uuid,p_entry_id uuid)
returns table (whatsapp_e164 text,delivery_status text)
language plpgsql security invoker set search_path=public as $$
#variable_conflict use_column
begin
  perform 1 from community_voting_authorize_operator(p_instance_id,p_host_token,p_operator_member_id,false);
  perform community_voting_require_category_round(p_instance_id);
  if not exists(select 1 from community_voting_registrations r where r.entry_id=p_entry_id and r.instance_id=p_instance_id
    and r.whatsapp_e164 is not null and (community_voting_retention_due(r.contest_id) is null or community_voting_retention_due(r.contest_id)>clock_timestamp())) then
    raise exception 'CV_WRONG_ENTRY_KIND: no retained delivery contact is available' using errcode='P0001';
  end if;
  perform community_voting_log_operator_action(p_instance_id,p_operator_member_id,'READ_CONTACT',p_entry_id,'{}'::jsonb);
  return query select r.whatsapp_e164,r.delivery_status from community_voting_registrations r where r.entry_id=p_entry_id;
end;
$$;

-- Stop serving a retained image at its deadline even if the cleanup worker is briefly delayed.
-- Preserve the ordinary/two-round path: only a linked four-category contest can expire here.
create or replace function read_community_voting_round_photo(p_instance_id uuid,p_alias text,p_variant text)
returns table(content_type text,bytes_b64 text,sha256 text)
language sql stable security invoker set search_path=public as $$
  select p.content_type,encode(case when p_variant='thumb' then p.thumb_bytes else p.full_bytes end,'base64'),
    case when p_variant='thumb' then p.thumb_sha256 else p.full_sha256 end
  from community_voting_entries e
  join community_voting_instances i on i.instance_id=e.instance_id and i.ballot_mode='FAVORITE_ROUND'
  cross join lateral community_voting_entry_media(e.entry_id) m
  join community_voting_entry_photos p on p.photo_id=m.m_photo_id
  where e.instance_id=p_instance_id and e.label='#'||p_alias and p_variant in ('thumb','full')
    and e.confirmed_binding_id is not null
    and not exists(select 1 from community_voting_withdrawals w where w.entry_id=e.entry_id)
    and m.m_state='APPROVED' and not m.m_hidden and p.full_bytes is not null
    and not exists(select 1 from community_voting_category_rounds r where r.instance_id=e.instance_id
      and community_voting_retention_due(r.contest_id)<=clock_timestamp());
$$;

select cron.schedule('community-voting-seven-day-retention','* * * * *','select * from public.erase_expired_community_voting_media()');
commit;
