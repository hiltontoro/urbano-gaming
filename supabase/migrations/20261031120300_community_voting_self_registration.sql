-- Migration: 20261031120300_community_voting_self_registration
-- Halloween Community Voting — SELF-REGISTRATION, the PUBLIC CODE and the MANUAL WhatsApp delivery (addendum to UG-IV-GATE-018). Additive over 20261031120000..0200.
--
-- ---------------------------------------------------------------------------------------
-- What the addendum approves, and what this migration does about each part
-- ---------------------------------------------------------------------------------------
--   * A person registers THEMSELVES from their own account (a verified email and a complete Gaming Member — the binding trigger refuses anything
--     else): a public name, their category, the requirements and their consents, and a WhatsApp number WITH the country code that they confirm.
--     In the group category the representative registers the group; the members stay attributed privately at the station, one claim and one
--     consent each, exactly as 20261031120000 built it.
--   * Every candidacy has ONE PUBLIC CODE, unique and stable (HAL-XXXXX). It LOCATES a candidacy: the operator searches it, the gallery filters by it
--     and a link carries it. It claims no identity, edits nothing and authorizes nothing: it is not the private claim credential (which is a different,
--     secret value that this migration neither reads, converts nor exposes), and nothing that takes the code as input changes a record.
--   * The candidacy is public ONLY once the operator has verified the person at the station (name and category), the photograph is approved and
--     consented, and the association is confirmed — the same permission to SHOW a photograph the pilot always required, now also for a group.
--   * The WhatsApp number is PRIVATE and the delivery is MANUAL. The number lives in its own table that only the server's service_role reaches;
--     the only operation that returns it is the operator's own read, which is audited without the number and returns it to nobody else. It is
--     never a unique key, never an identity and never a reason to refuse or merge a vote, an account or a candidacy; a pending delivery blocks
--     nothing. Delivery is DELIVERED only by the operator's explicit act — opening WhatsApp records nothing.
--   * The delivery authorization is its own consent: a separate version and digest, neither the photograph's consent nor a marketing one.
--
-- RETENTION: this migration decides NO period and has no function that erases or ages a number. The retention policy and the wording of the texts
-- are pending the Founder's and counsel's decision; until they exist these tables only grow, and capturing a REAL number waits for them.
--
-- RLS: enabled with no policies, every privilege revoked from anon / authenticated (the competition_* precedent).

-- ---------------------------------------------------------------------------------------
-- The public face of a candidacy: its code and its public name
-- ---------------------------------------------------------------------------------------

create table community_voting_candidacies (
  entry_id     uuid primary key,
  instance_id  uuid not null,
  contest_id   uuid not null references community_voting_contests (contest_id) on delete restrict,
  public_code  text not null,
  -- The name the person chose to be shown with their photograph; null for a candidacy the operator created by hand until it is given one.
  public_name  text null,
  created_at   timestamptz not null default now(),

  constraint community_voting_candidacies_entry_fkey foreign key (entry_id, instance_id) references community_voting_entries (entry_id, instance_id) on delete restrict,
  constraint community_voting_candidacies_code_unique unique (public_code),
  constraint community_voting_candidacies_code_shape check (public_code ~ '^HAL-[2-9A-HJKMNP-TV-Z]{5}$'),
  constraint community_voting_candidacies_name_shape check (
    public_name is null or (public_name = btrim(public_name) and char_length(public_name) between 2 and 40 and public_name !~ '[[:cntrl:]]')
  )
);

create index community_voting_candidacies_contest_idx on community_voting_candidacies (contest_id);

-- ---------------------------------------------------------------------------------------
-- The private facet of a self-registration: who, what they accepted, and the number for the manual delivery
-- ---------------------------------------------------------------------------------------

create table community_voting_registrations (
  entry_id                    uuid primary key,
  instance_id                 uuid not null,
  contest_id                  uuid not null references community_voting_contests (contest_id) on delete restrict,
  registrant_gaming_member_id uuid not null references gaming_members (gaming_member_id) on delete restrict,
  registrant_binding_id       uuid not null,

  adult_confirmed             boolean not null,
  requirements_version        text not null,
  requirements_sha256         text not null,
  requirements_accepted_at    timestamptz not null default now(),

  -- PRIVATE. E.164 with the country code. Never a key, never an identity, never read by any public operation.
  whatsapp_e164               text not null,
  whatsapp_confirmed_at       timestamptz not null,
  delivery_version            text not null,
  delivery_sha256             text not null,
  delivery_authorized_at      timestamptz not null,

  delivery_status             text not null default 'PENDING',
  delivered_at                timestamptz null,
  delivered_by_member_id      uuid null references gaming_members (gaming_member_id) on delete restrict,
  created_at                  timestamptz not null default now(),

  constraint community_voting_registrations_entry_fkey foreign key (entry_id, instance_id) references community_voting_entries (entry_id, instance_id) on delete restrict,
  constraint community_voting_registrations_binding_fkey foreign key (registrant_binding_id, instance_id) references community_voting_voter_bindings (binding_id, instance_id) on delete restrict,
  constraint community_voting_registrations_person_unique unique (contest_id, registrant_gaming_member_id),
  constraint community_voting_registrations_adult check (adult_confirmed),
  constraint community_voting_registrations_digest_shape check (requirements_sha256 ~ '^[0-9a-f]{64}$' and delivery_sha256 ~ '^[0-9a-f]{64}$'),
  constraint community_voting_registrations_version_shape check (requirements_version ~ '^[A-Za-z0-9._-]{1,64}$' and delivery_version ~ '^[A-Za-z0-9._-]{1,64}$'),
  constraint community_voting_registrations_whatsapp_shape check (whatsapp_e164 ~ '^\+[1-9][0-9]{7,14}$'),
  constraint community_voting_registrations_delivery_values check (delivery_status in ('PENDING', 'DELIVERED')),
  constraint community_voting_registrations_delivered_together check (
    (delivery_status = 'DELIVERED') = (delivered_at is not null and delivered_by_member_id is not null)
  )
);

alter table community_voting_candidacies enable row level security;
alter table community_voting_registrations enable row level security;
revoke all on community_voting_candidacies from anon, authenticated;
revoke all on community_voting_registrations from anon, authenticated;
revoke update, delete, truncate on community_voting_candidacies from service_role;
grant update (public_name) on community_voting_candidacies to service_role;
revoke update, delete, truncate on community_voting_registrations from service_role;
grant update (delivery_status, delivered_at, delivered_by_member_id) on community_voting_registrations to service_role;
-- the rows leave only with their entry, before voting opens: the guards below allow that and nothing else
grant delete on community_voting_candidacies to service_role;
grant delete on community_voting_registrations to service_role;

-- ---------------------------------------------------------------------------------------
-- The public code: drawn once, when the entry is made, and never changed
-- ---------------------------------------------------------------------------------------

create function community_voting_new_public_code()
returns text
language plpgsql
volatile
security invoker
set search_path = public
as $$
declare
  v_alphabet constant text := '23456789ABCDEFGHJKMNPQRSTVWXYZ';   -- 30 symbols: no 0, 1, I, L, O or U, so a code survives being read aloud
  v_hex text := replace(gen_random_uuid()::text, '-', '');
  v_code text := 'HAL-';
  i integer;
begin
  for i in 0..4 loop
    v_code := v_code || substr(v_alphabet, 1 + (('x' || substr(v_hex, 1 + 2 * i, 2))::bit(8)::integer % 30), 1);
  end loop;
  return v_code;
end;
$$;

-- Every candidacy (not a group's attributed member) of a category round gets its code at the moment its entry exists. A code is a LOCATOR: it is
-- drawn at random, it is not derived from anything about a person, and a collision simply draws again.
create function community_voting_candidacy_create()
returns trigger
language plpgsql
set search_path = public
as $$
declare
  v_contest uuid;
  v_attempt integer := 0;
begin
  if new.entry_kind = 'GROUP_MEMBER' then
    return new;
  end if;
  select cr.contest_id into v_contest from community_voting_category_rounds cr where cr.instance_id = new.instance_id;
  if v_contest is null then
    return new;
  end if;
  loop
    v_attempt := v_attempt + 1;
    if v_attempt > 40 then
      raise exception 'CV_ALIAS_EXHAUSTED: no free public code could be drawn'
        using errcode = 'P0001';
    end if;
    begin
      insert into community_voting_candidacies (entry_id, instance_id, contest_id, public_code)
      values (new.entry_id, new.instance_id, v_contest, community_voting_new_public_code());
      exit;
    exception when unique_violation then
      null; -- the code was taken: draw another
    end;
  end loop;
  return new;
end;
$$;

create trigger community_voting_entries_candidacy_create
  after insert on community_voting_entries
  for each row execute function community_voting_candidacy_create();

-- ---------------------------------------------------------------------------------------
-- Guards: the code is immutable, the name changes only through its operation, the number only ever gains a "delivered", and rows leave with their entry
-- ---------------------------------------------------------------------------------------

create function community_voting_guard_candidacies()
returns trigger
language plpgsql
set search_path = public
as $$
declare
  v_session uuid;
begin
  if tg_op = 'INSERT' then
    if current_setting('urbano.community_voting_round_op', true) is distinct from new.instance_id::text then
      raise exception 'COMMUNITY_VOTING_ROUND_PATH_REQUIRED: a candidacy exists only with its entry'
        using errcode = 'P0001';
    end if;
    return new;
  end if;

  if tg_op = 'DELETE' then
    if current_setting('urbano.community_voting_round_op', true) is distinct from old.instance_id::text then
      raise exception 'COMMUNITY_VOTING_ROUND_PATH_REQUIRED: a candidacy leaves only with its entry'
        using errcode = 'P0001';
    end if;
    return old;
  end if;

  -- UPDATE: the public name, through its operation, before voting opens. Nothing else of a candidacy ever changes (its code never does).
  if new.entry_id is distinct from old.entry_id or new.instance_id is distinct from old.instance_id or new.contest_id is distinct from old.contest_id
     or new.public_code is distinct from old.public_code or new.created_at is distinct from old.created_at then
    raise exception 'COMMUNITY_VOTING_HISTORY_IMMUTABLE: the public code of a candidacy never changes'
      using errcode = 'P0001';
  end if;
  if current_setting('urbano.community_voting_candidacy_name', true) is distinct from old.entry_id::text then
    raise exception 'COMMUNITY_VOTING_ROUND_PATH_REQUIRED: the public name changes only through its operation'
      using errcode = 'P0001';
  end if;
  select i.session_id into v_session from community_voting_instances i where i.instance_id = old.instance_id;
  if exists (select 1 from interaction_instances ii where ii.session_id = v_session) then
    raise exception 'COMMUNITY_VOTING_PREPARATION_FROZEN: Voting has opened; the public name can no longer change'
      using errcode = 'P0001';
  end if;
  return new;
end;
$$;

create trigger community_voting_candidacies_guard before insert or update or delete on community_voting_candidacies
  for each row execute function community_voting_guard_candidacies();
create trigger community_voting_candidacies_no_truncate before truncate on community_voting_candidacies
  for each statement execute function community_voting_reject_history_loss();

create function community_voting_guard_registrations()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if tg_op = 'INSERT' then
    if current_setting('urbano.community_voting_registration', true) is distinct from new.entry_id::text then
      raise exception 'COMMUNITY_VOTING_ROUND_PATH_REQUIRED: a registration is made only through its operation'
        using errcode = 'P0001';
    end if;
    return new;
  end if;

  if tg_op = 'DELETE' then
    if current_setting('urbano.community_voting_round_op', true) is distinct from old.instance_id::text then
      raise exception 'COMMUNITY_VOTING_ROUND_PATH_REQUIRED: a registration leaves only with its entry'
        using errcode = 'P0001';
    end if;
    return old;
  end if;

  -- UPDATE: only PENDING -> DELIVERED, through the operator's explicit act, and nothing else of the row (the number least of all).
  if (to_jsonb(new) - array['delivery_status', 'delivered_at', 'delivered_by_member_id']) is distinct from (to_jsonb(old) - array['delivery_status', 'delivered_at', 'delivered_by_member_id']) then
    raise exception 'COMMUNITY_VOTING_HISTORY_IMMUTABLE: a registration never changes, and its number least of all'
      using errcode = 'P0001';
  end if;
  if old.delivery_status <> 'PENDING' or new.delivery_status <> 'DELIVERED'
     or current_setting('urbano.community_voting_delivery', true) is distinct from old.entry_id::text then
    raise exception 'COMMUNITY_VOTING_ROUND_PATH_REQUIRED: a delivery is recorded only by the operator''s explicit act'
      using errcode = 'P0001';
  end if;
  return new;
end;
$$;

create trigger community_voting_registrations_guard before insert or update or delete on community_voting_registrations
  for each row execute function community_voting_guard_registrations();
create trigger community_voting_registrations_no_truncate before truncate on community_voting_registrations
  for each statement execute function community_voting_reject_history_loss();

-- The rows of a candidacy go with its entry (only before voting opens, and only through the operations that may remove an entry).
create function community_voting_registration_release()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  delete from community_voting_registrations where entry_id = old.entry_id;
  delete from community_voting_candidacies where entry_id = old.entry_id;
  return old;
end;
$$;

create trigger community_voting_entries_registration_release
  before delete on community_voting_entries
  for each row execute function community_voting_registration_release();

-- ---------------------------------------------------------------------------------------
-- The registration itself (the person, from their own account)
-- ---------------------------------------------------------------------------------------
--
-- Order of the refusals: the category, the Session lock, the binding (a verified email and a complete Gaming Member, re-checked here), whether voting has
-- opened, the registration window by the DATABASE clock (it must be configured, must have begun and must not have ended: a contest with no schedule
-- takes no public candidacy), then the shape of everything the person gave, and last the rule of one candidacy per person. All in one transaction: a
-- refusal leaves nothing behind. The function takes the person's account id from the server's own identity check, never from a request body.

create function register_community_voting_candidacy_atomically(
  p_instance_id uuid,
  p_auth_user_id uuid,
  p_public_name text,
  p_adult_confirmed boolean,
  p_requirements_version text,
  p_requirements_sha256 text,
  p_whatsapp text,
  p_whatsapp_confirmed boolean,
  p_delivery_version text,
  p_delivery_sha256 text,
  p_delivery_authorized boolean
)
returns table (entry_id uuid, category_key text, public_code text, public_name text, entry_kind text)
language plpgsql
security invoker
set search_path = public
as $$
#variable_conflict use_column
declare
  v_category text;
  v_session_id uuid;
  v_contest uuid;
  v_binding community_voting_voter_bindings%rowtype;
  v_opens timestamptz;
  v_cutoff timestamptz;
  v_name text;
  v_kind text;
  v_row record;
  v_code text;
begin
  v_category := community_voting_require_category_round(p_instance_id);
  select i.session_id into v_session_id from community_voting_instances i where i.instance_id = p_instance_id;
  select cr.contest_id into v_contest from community_voting_category_rounds cr where cr.instance_id = p_instance_id;

  perform 1 from sessions where sessions.session_id = v_session_id for update;

  select * into v_binding from community_voting_voter_bindings b where b.instance_id = p_instance_id and b.auth_user_id = p_auth_user_id for update;
  if not found then
    raise exception 'CV_NOT_BOUND: this identity is not bound to the Instance'
      using errcode = 'P0001';
  end if;
  if not community_voting_email_confirmed(p_auth_user_id) then
    raise exception 'CV_VERIFIED_EMAIL_REQUIRED: a verified email address is required to take part'
      using errcode = 'P0001';
  end if;
  if v_binding.gaming_member_id is null or not exists (
    select 1 from gaming_members m where m.gaming_member_id = v_binding.gaming_member_id and m.auth_user_id = p_auth_user_id
  ) then
    raise exception 'CV_PROFILE_INCOMPLETE: complete your URBANO Gaming profile to take part'
      using errcode = 'P0001';
  end if;

  if exists (select 1 from interaction_instances ii where ii.session_id = v_session_id) then
    raise exception 'CV_PREPARATION_CLOSED: Voting has opened; no new candidacy can be registered'
      using errcode = 'P0001';
  end if;

  select sc.registration_opens_at, sc.contestant_cutoff_at into v_opens, v_cutoff from community_voting_schedules sc where sc.instance_id = p_instance_id;
  if v_opens is null or v_cutoff is null then
    raise exception 'CV_SCHEDULE_REQUIRED: registration needs its configured opening and closing times'
      using errcode = 'P0001';
  end if;
  if clock_timestamp() < v_opens then
    raise exception 'CV_REGISTRATION_NOT_OPEN: registration has not opened yet'
      using errcode = 'P0001';
  end if;
  if not community_voting_deadline_open(v_cutoff, clock_timestamp()) then
    raise exception 'CV_CUTOFF_PASSED: registration has ended'
      using errcode = 'P0001';
  end if;

  v_name := btrim(coalesce(p_public_name, ''));
  if char_length(v_name) < 2 or char_length(v_name) > 40 or v_name ~ '[[:cntrl:]]' then
    raise exception 'CV_INVALID_REQUEST: the public name must be 2 to 40 characters'
      using errcode = 'P0001';
  end if;
  if p_adult_confirmed is distinct from true then
    raise exception 'CV_CONSENT_REQUIRED: the person must confirm being of legal age and accept the requirements'
      using errcode = 'P0001';
  end if;
  if p_requirements_version is null or p_requirements_version !~ '^[A-Za-z0-9._-]{1,64}$' or p_requirements_sha256 is null or p_requirements_sha256 !~ '^[0-9a-f]{64}$'
     or p_delivery_version is null or p_delivery_version !~ '^[A-Za-z0-9._-]{1,64}$' or p_delivery_sha256 is null or p_delivery_sha256 !~ '^[0-9a-f]{64}$' then
    raise exception 'CV_INVALID_REQUEST: a consent version or statement digest is malformed'
      using errcode = 'P0001';
  end if;
  if p_whatsapp is null or p_whatsapp !~ '^\+[1-9][0-9]{7,14}$' then
    raise exception 'CV_INVALID_REQUEST: the WhatsApp number must have its country code'
      using errcode = 'P0001';
  end if;
  if p_whatsapp_confirmed is distinct from true then
    raise exception 'CV_CONSENT_REQUIRED: the person must confirm that the WhatsApp number is theirs'
      using errcode = 'P0001';
  end if;
  if p_delivery_authorized is distinct from true then
    raise exception 'CV_CONSENT_REQUIRED: the person must authorize the delivery by WhatsApp'
      using errcode = 'P0001';
  end if;

  v_kind := case when v_category = 'BEST_GROUP' then 'GROUP' else 'INDIVIDUAL' end;

  -- the entry (the number of its ballot position and its public code are drawn by the pilot's own helper and the candidacy trigger); a
  -- self-registered entry has no claim credential: the one the helper draws is erased at once
  select * into v_row from community_voting_create_entry_row(p_instance_id, v_kind, null, 1);
  perform set_config('urbano.community_voting_round_op', p_instance_id::text, true);
  update community_voting_entries set claim_code_hash = null where community_voting_entries.entry_id = v_row.entry_id;

  -- ONE candidacy per person, by the database: the identity row is written NOW (not only at the station), so the same person cannot register
  -- twice, nor in two categories, nor as a member and as a contestant
  begin
    insert into community_voting_contest_identities (contest_id, gaming_member_id, instance_id, entry_id, role)
    values (v_contest, v_binding.gaming_member_id, p_instance_id, v_row.entry_id, case v_kind when 'GROUP' then 'REPRESENTATIVE' else 'INDIVIDUAL' end);
  exception when unique_violation then
    raise exception 'CV_ALREADY_CANDIDATE: this person already belongs to a candidacy of the contest; a person takes part once, in one category'
      using errcode = 'P0001';
  end;

  perform set_config('urbano.community_voting_candidacy_name', v_row.entry_id::text, true);
  update community_voting_candidacies set public_name = v_name where community_voting_candidacies.entry_id = v_row.entry_id returning community_voting_candidacies.public_code into v_code;
  perform set_config('urbano.community_voting_candidacy_name', '', true);

  perform set_config('urbano.community_voting_registration', v_row.entry_id::text, true);
  insert into community_voting_registrations (
    entry_id, instance_id, contest_id, registrant_gaming_member_id, registrant_binding_id,
    adult_confirmed, requirements_version, requirements_sha256,
    whatsapp_e164, whatsapp_confirmed_at, delivery_version, delivery_sha256, delivery_authorized_at
  )
  values (
    v_row.entry_id, p_instance_id, v_contest, v_binding.gaming_member_id, v_binding.binding_id,
    true, p_requirements_version, p_requirements_sha256,
    p_whatsapp, now(), p_delivery_version, p_delivery_sha256, now()
  );
  perform set_config('urbano.community_voting_registration', '', true);
  perform set_config('urbano.community_voting_round_op', '', true);

  return query select v_row.entry_id, v_category, v_code, v_name, v_kind;
end;
$$;

-- What a person may see of their OWN candidacy (as a contestant, a group's representative or a member of a group). Never the number.
create function read_community_voting_my_candidacy(p_contest_id uuid, p_auth_user_id uuid)
returns table (category_key text, instance_id uuid, role text, entry_kind text, public_code text, public_name text, state text, delivery_status text)
language sql
stable
security invoker
set search_path = public
as $$
  select cr.category_key,
         c.instance_id,
         ci.role,
         e.entry_kind,
         c.public_code,
         c.public_name,
         case
           when exists (select 1 from community_voting_withdrawals w where w.entry_id = e.entry_id) then 'WITHDRAWN'
           when e.confirmed_binding_id is not null and (select m.m_state from community_voting_entry_media(e.entry_id) m) = 'APPROVED'
                and not coalesce((select m.m_hidden from community_voting_entry_media(e.entry_id) m), false) then 'PUBLIC'
           else 'REGISTERED'
         end,
         case when ci.role in ('INDIVIDUAL', 'REPRESENTATIVE') then r.delivery_status else null end
  from community_voting_contest_identities ci
  join gaming_members gm on gm.gaming_member_id = ci.gaming_member_id and gm.auth_user_id = p_auth_user_id
  join community_voting_entries own on own.entry_id = ci.entry_id
  join community_voting_entries e on e.entry_id = coalesce(own.group_entry_id, own.entry_id)
  join community_voting_candidacies c on c.entry_id = e.entry_id
  join community_voting_category_rounds cr on cr.instance_id = c.instance_id
  left join community_voting_registrations r on r.entry_id = e.entry_id
  where ci.contest_id = p_contest_id;
$$;

-- ---------------------------------------------------------------------------------------
-- The public reads: the gallery with its codes and names, and a candidacy by its code
-- ---------------------------------------------------------------------------------------
--
-- Both show a candidacy under the SAME permission as the pilot's gallery: confirmed association, an approved and consented photograph (every person's,
-- for a group), not hidden at the person's request, not withdrawn. Nothing about who anyone is, no number, no count.

create function read_community_voting_category_gallery(p_instance_id uuid)
returns table (alias text, candidate_id uuid, ordinal integer, public_code text, public_name text)
language sql
stable
security invoker
set search_path = public
as $$
  select e.label, e.candidate_id, e.ordinal, c.public_code, c.public_name
  from community_voting_entries e
  join community_voting_candidacies c on c.entry_id = e.entry_id
  cross join lateral community_voting_entry_media(e.entry_id) m
  where e.instance_id = p_instance_id
    and e.entry_kind <> 'GROUP_MEMBER'
    and e.confirmed_binding_id is not null
    and not exists (select 1 from community_voting_withdrawals w where w.entry_id = e.entry_id)
    and m.m_state = 'APPROVED'
    and not m.m_hidden
  order by e.ordinal;
$$;

-- The code is normalized the way a person types it: case and a missing hyphen do not matter.
create function community_voting_normalize_public_code(p_code text)
returns text
language sql
immutable
security invoker
set search_path = public
as $$
  select case
           when upper(regexp_replace(coalesce(p_code, ''), '[^0-9A-Za-z]', '', 'g')) ~ '^HAL[2-9A-HJKMNP-TV-Z]{5}$'
             then 'HAL-' || substr(upper(regexp_replace(p_code, '[^0-9A-Za-z]', '', 'g')), 4)
           else null
         end;
$$;

create function read_community_voting_candidacy_by_code(p_contest_id uuid, p_code text)
returns table (category_key text, instance_id uuid, alias text, candidate_id uuid, ordinal integer, public_code text, public_name text)
language sql
stable
security invoker
set search_path = public
as $$
  select cr.category_key, e.instance_id, e.label, e.candidate_id, e.ordinal, c.public_code, c.public_name
  from community_voting_candidacies c
  join community_voting_entries e on e.entry_id = c.entry_id
  join community_voting_category_rounds cr on cr.instance_id = c.instance_id
  cross join lateral community_voting_entry_media(e.entry_id) m
  where c.contest_id = p_contest_id
    and c.public_code = community_voting_normalize_public_code(p_code)
    and e.confirmed_binding_id is not null
    and not exists (select 1 from community_voting_withdrawals w where w.entry_id = e.entry_id)
    and m.m_state = 'APPROVED'
    and not m.m_hidden;
$$;

-- ---------------------------------------------------------------------------------------
-- The operator's station: find a candidacy by its code, confirm the person, read the number for the manual delivery, record the delivery
-- ---------------------------------------------------------------------------------------

create function find_community_voting_candidacy_by_code(
  p_instance_id uuid,
  p_host_token text,
  p_operator_member_id uuid,
  p_code text
)
returns table (
  entry_id uuid,
  instance_id uuid,
  category_key text,
  entry_kind text,
  public_code text,
  public_name text,
  self_registered boolean,
  has_whatsapp boolean,
  delivery_status text,
  withdrawn boolean,
  created_at timestamptz
)
language plpgsql
stable
security invoker
set search_path = public
as $$
#variable_conflict use_column
declare
  v_contest uuid;
  v_code text;
begin
  perform 1 from community_voting_authorize_operator(p_instance_id, p_host_token, p_operator_member_id, false);
  perform community_voting_require_category_round(p_instance_id);
  select cr.contest_id into v_contest from community_voting_category_rounds cr where cr.instance_id = p_instance_id;
  v_code := community_voting_normalize_public_code(p_code);
  if v_code is null then
    return;
  end if;
  return query
    select c.entry_id, c.instance_id, cr.category_key, e.entry_kind, c.public_code, c.public_name,
           (r.entry_id is not null), (r.entry_id is not null), r.delivery_status,
           exists (select 1 from community_voting_withdrawals w where w.entry_id = e.entry_id), c.created_at
    from community_voting_candidacies c
    join community_voting_entries e on e.entry_id = c.entry_id
    join community_voting_category_rounds cr on cr.instance_id = c.instance_id
    left join community_voting_registrations r on r.entry_id = c.entry_id
    where c.contest_id = v_contest and c.public_code = v_code;
end;
$$;

-- The structure of a category for the operator: kinds, groups, consents, completeness, the code and the name of each candidacy, whether it was
-- self-registered, whether a delivery number is on file and how the delivery stands. NEVER the number, never an identity.
create function read_community_voting_category_structure(
  p_instance_id uuid,
  p_host_token text,
  p_operator_member_id uuid
)
returns table (
  entry_id uuid,
  entry_kind text,
  group_entry_id uuid,
  member_consent boolean,
  group_complete boolean,
  entry_consent boolean,
  photo_decision text,
  public_code text,
  public_name text,
  self_registered boolean,
  has_whatsapp boolean,
  delivery_status text
)
language plpgsql
stable
security invoker
set search_path = public
as $$
#variable_conflict use_column
begin
  perform 1 from community_voting_authorize_operator(p_instance_id, p_host_token, p_operator_member_id, false);
  perform community_voting_require_category_round(p_instance_id);

  return query
    select e.entry_id,
           e.entry_kind,
           e.group_entry_id,
           case when e.entry_kind = 'GROUP_MEMBER' then
             exists (
               select 1
               from community_voting_member_consents mc
               where mc.member_entry_id = e.entry_id
                 and mc.photo_id = (select m.m_photo_id from community_voting_entry_media(e.group_entry_id) m))
           else null end,
           case when e.entry_kind = 'GROUP' then
             coalesce((select community_voting_group_complete(e.entry_id, m.m_photo_id) from community_voting_entry_media(e.entry_id) m), false)
           else null end,
           -- the entry's OWN consent to its current photograph (the contestant's, or a group's representative's), and the operator's decision on it
           case when e.entry_kind <> 'GROUP_MEMBER' then
             exists (select 1 from community_voting_entry_consents c where c.photo_id = (select m.m_photo_id from community_voting_entry_media(e.entry_id) m))
           else null end,
           case when e.entry_kind <> 'GROUP_MEMBER' then
             (select d.decision from community_voting_photo_decisions d where d.photo_id = (select m.m_photo_id from community_voting_entry_media(e.entry_id) m))
           else null end,
           cd.public_code,
           cd.public_name,
           (r.entry_id is not null),
           (r.entry_id is not null),
           r.delivery_status
    from community_voting_entries e
    left join community_voting_candidacies cd on cd.entry_id = e.entry_id
    left join community_voting_registrations r on r.entry_id = e.entry_id
    where e.instance_id = p_instance_id
    order by e.ordinal;
end;
$$;

-- The operator, who has verified at the station that the person in front of them is the one who registered (name and category), confirms the association:
-- the account that registered becomes the one associated with the entry. No code is typed: the registration already tied the entry to its account.
create function confirm_community_voting_registration_atomically(
  p_instance_id uuid,
  p_host_token text,
  p_operator_member_id uuid,
  p_entry_id uuid
)
returns table (entry_id uuid, confirmed boolean)
language plpgsql
security invoker
set search_path = public
as $$
#variable_conflict use_column
declare
  v_session_id uuid;
  v_reg community_voting_registrations%rowtype;
  v_confirmed uuid;
begin
  select o.o_session_id into v_session_id
  from community_voting_authorize_operator(p_instance_id, p_host_token, p_operator_member_id, true) o;
  perform community_voting_require_category_round(p_instance_id);

  if exists (select 1 from interaction_instances ii where ii.session_id = v_session_id) then
    raise exception 'CV_PREPARATION_CLOSED: Voting has opened; the ballot can no longer change'
      using errcode = 'P0001';
  end if;

  select * into v_reg from community_voting_registrations r where r.entry_id = p_entry_id and r.instance_id = p_instance_id;
  if not found then
    raise exception 'CV_WRONG_ENTRY_KIND: only a self-registered candidacy is confirmed this way'
      using errcode = 'P0001';
  end if;
  if exists (select 1 from community_voting_withdrawals w where w.entry_id = p_entry_id) then
    raise exception 'CV_ENTRY_ALREADY_WITHDRAWN: this entry has been withdrawn'
      using errcode = 'P0001';
  end if;

  select e.confirmed_binding_id into v_confirmed from community_voting_entries e where e.entry_id = p_entry_id for update;
  if v_confirmed is not null then
    return query select p_entry_id, true;   -- already confirmed: nothing to do, and nothing is said twice
    return;
  end if;

  perform set_config('urbano.community_voting_round_op', p_instance_id::text, true);
  update community_voting_entries
  set confirmed_binding_id = v_reg.registrant_binding_id, confirmed_at = now()
  where community_voting_entries.entry_id = p_entry_id;
  perform set_config('urbano.community_voting_round_op', '', true);

  perform community_voting_log_operator_action(p_instance_id, p_operator_member_id, 'CONFIRM_REGISTRATION', p_entry_id, '{}'::jsonb);
  return query select p_entry_id, true;
end;
$$;

-- The ONLY operation that returns a number, and it returns it to the designated operator alone, for the manual delivery. The act is audited
-- (the entry, never the number).
create function read_community_voting_registration_contact(
  p_instance_id uuid,
  p_host_token text,
  p_operator_member_id uuid,
  p_entry_id uuid
)
returns table (whatsapp_e164 text, delivery_status text)
language plpgsql
security invoker
set search_path = public
as $$
#variable_conflict use_column
begin
  perform 1 from community_voting_authorize_operator(p_instance_id, p_host_token, p_operator_member_id, false);
  perform community_voting_require_category_round(p_instance_id);
  if not exists (select 1 from community_voting_registrations r where r.entry_id = p_entry_id and r.instance_id = p_instance_id) then
    raise exception 'CV_WRONG_ENTRY_KIND: only a self-registered candidacy has a delivery contact'
      using errcode = 'P0001';
  end if;
  perform community_voting_log_operator_action(p_instance_id, p_operator_member_id, 'READ_CONTACT', p_entry_id, '{}'::jsonb);
  return query select r.whatsapp_e164, r.delivery_status from community_voting_registrations r where r.entry_id = p_entry_id;
end;
$$;

-- "Delivered" exists only because the operator said so. Opening WhatsApp records nothing; a pending delivery blocks neither a candidacy nor a vote.
create function mark_community_voting_registration_delivered_atomically(
  p_instance_id uuid,
  p_host_token text,
  p_operator_member_id uuid,
  p_entry_id uuid
)
returns table (entry_id uuid, delivery_status text, delivered_at timestamptz)
language plpgsql
security invoker
set search_path = public
as $$
#variable_conflict use_column
begin
  perform 1 from community_voting_authorize_operator(p_instance_id, p_host_token, p_operator_member_id, true);
  perform community_voting_require_category_round(p_instance_id);
  if not exists (select 1 from community_voting_registrations r where r.entry_id = p_entry_id and r.instance_id = p_instance_id) then
    raise exception 'CV_WRONG_ENTRY_KIND: only a self-registered candidacy has a delivery to confirm'
      using errcode = 'P0001';
  end if;
  if exists (select 1 from community_voting_registrations r where r.entry_id = p_entry_id and r.delivery_status = 'PENDING') then
    perform set_config('urbano.community_voting_delivery', p_entry_id::text, true);
    update community_voting_registrations
    set delivery_status = 'DELIVERED', delivered_at = now(), delivered_by_member_id = p_operator_member_id
    where community_voting_registrations.entry_id = p_entry_id;
    perform set_config('urbano.community_voting_delivery', '', true);
    perform community_voting_log_operator_action(p_instance_id, p_operator_member_id, 'MARK_DELIVERED', p_entry_id, '{}'::jsonb);
  end if;
  return query select r.entry_id, r.delivery_status, r.delivered_at from community_voting_registrations r where r.entry_id = p_entry_id;
end;
$$;

-- At the station the operator verifies the name with the person and may correct it (before voting opens).
create function correct_community_voting_candidacy_name_atomically(
  p_instance_id uuid,
  p_host_token text,
  p_operator_member_id uuid,
  p_entry_id uuid,
  p_public_name text
)
returns table (entry_id uuid, public_name text)
language plpgsql
security invoker
set search_path = public
as $$
#variable_conflict use_column
declare
  v_session_id uuid;
  v_name text;
begin
  select o.o_session_id into v_session_id
  from community_voting_authorize_operator(p_instance_id, p_host_token, p_operator_member_id, true) o;
  perform community_voting_require_category_round(p_instance_id);
  if exists (select 1 from interaction_instances ii where ii.session_id = v_session_id) then
    raise exception 'CV_PREPARATION_CLOSED: Voting has opened; the ballot can no longer change'
      using errcode = 'P0001';
  end if;
  if not exists (select 1 from community_voting_candidacies c where c.entry_id = p_entry_id and c.instance_id = p_instance_id) then
    raise exception 'CV_ENTRY_NOT_FOUND: this ballot has no such candidacy'
      using errcode = 'P0001';
  end if;
  v_name := btrim(coalesce(p_public_name, ''));
  if char_length(v_name) < 2 or char_length(v_name) > 40 or v_name ~ '[[:cntrl:]]' then
    raise exception 'CV_INVALID_REQUEST: the public name must be 2 to 40 characters'
      using errcode = 'P0001';
  end if;
  perform set_config('urbano.community_voting_candidacy_name', p_entry_id::text, true);
  update community_voting_candidacies set public_name = v_name where community_voting_candidacies.entry_id = p_entry_id;
  perform set_config('urbano.community_voting_candidacy_name', '', true);
  perform community_voting_log_operator_action(p_instance_id, p_operator_member_id, 'CORRECT_NAME', p_entry_id, '{}'::jsonb);
  return query select p_entry_id, v_name;
end;
$$;

-- ---------------------------------------------------------------------------------------
-- Privileges: created under the project's standing default-privilege rule, so each is revoked here.
-- ---------------------------------------------------------------------------------------

revoke execute on function community_voting_new_public_code() from public, anon, authenticated;
revoke execute on function community_voting_candidacy_create() from public, anon, authenticated;
revoke execute on function community_voting_guard_candidacies() from public, anon, authenticated;
revoke execute on function community_voting_guard_registrations() from public, anon, authenticated;
revoke execute on function community_voting_registration_release() from public, anon, authenticated;
revoke execute on function community_voting_normalize_public_code(text) from public, anon, authenticated;
revoke execute on function register_community_voting_candidacy_atomically(uuid, uuid, text, boolean, text, text, text, boolean, text, text, boolean) from public, anon, authenticated;
revoke execute on function read_community_voting_my_candidacy(uuid, uuid) from public, anon, authenticated;
revoke execute on function read_community_voting_category_gallery(uuid) from public, anon, authenticated;
revoke execute on function read_community_voting_candidacy_by_code(uuid, text) from public, anon, authenticated;
revoke execute on function find_community_voting_candidacy_by_code(uuid, text, uuid, text) from public, anon, authenticated;
revoke execute on function read_community_voting_category_structure(uuid, text, uuid) from public, anon, authenticated;
revoke execute on function confirm_community_voting_registration_atomically(uuid, text, uuid, uuid) from public, anon, authenticated;
revoke execute on function read_community_voting_registration_contact(uuid, text, uuid, uuid) from public, anon, authenticated;
revoke execute on function mark_community_voting_registration_delivered_atomically(uuid, text, uuid, uuid) from public, anon, authenticated;
revoke execute on function correct_community_voting_candidacy_name_atomically(uuid, text, uuid, uuid, text) from public, anon, authenticated;
