-- URBANO Score: the record of which version of which text a Gaming Member accepted, and when.
--
-- Three acts, deliberately kept apart:
--   ACCOUNT_TERMS    -> ACCEPTANCE            the account terms
--   EVENT_RULES      -> ACCEPTANCE            the rules of ONE event (scope_match_id is that match) + the member's declaration of being 18 or older
--   PRIVACY_NOTICE   -> READ_ACKNOWLEDGMENT   the member confirms having READ the privacy notice. It is an acknowledgment of information,
--                                             not a consent to any processing, and nothing here presents it as one.
-- No marketing consent exists in this table: no marketing is sent, and a permission for it would be a different record.
--
-- Evidence, not configuration: a row is the text the member was shown (version + SHA-256 of that exact text) and the instant the database
-- took the act. Rows are only ever inserted (an UPDATE is refused by a trigger). Nothing is back-dated or imported: a member who has no
-- row has not accepted anything.
--
-- Uniqueness covers the global documents too. A unique constraint treats NULLs as distinct, so a plain UNIQUE (member, key, version,
-- scope_match_id) would allow any number of duplicates for ACCOUNT_TERMS and PRIVACY_NOTICE, whose scope is NULL. Two partial unique
-- indexes close that, and record_legal_acceptance() is the single writer: a repeat or a concurrent request ends in the same one row.
--
-- Reached only through the server's service_role client, never from the browser (same boundary as the rest of the predictions objects).

create table legal_acceptances (
  legal_acceptance_id uuid primary key default gen_random_uuid(),
  gaming_member_id uuid not null references gaming_members (gaming_member_id),
  document_key text not null,
  document_version text not null,
  content_sha256 text not null,
  act_type text not null,
  scope_match_id uuid null references matches (match_id),
  age_declared_18 boolean null,
  locale text not null,
  source text not null,
  accepted_at timestamptz not null default now()
);

alter table legal_acceptances
  add constraint legal_acceptances_document_key_valid
  check (document_key in ('ACCOUNT_TERMS', 'PRIVACY_NOTICE', 'EVENT_RULES'));

alter table legal_acceptances
  add constraint legal_acceptances_act_type_valid
  check (act_type in ('ACCEPTANCE', 'READ_ACKNOWLEDGMENT'));

-- the privacy notice is acknowledged, never "accepted"; the other two are accepted, never merely acknowledged
alter table legal_acceptances
  add constraint legal_acceptances_act_matches_document
  check ((document_key = 'PRIVACY_NOTICE') = (act_type = 'READ_ACKNOWLEDGMENT'));

-- the rules of an event belong to that event; the global documents belong to none
alter table legal_acceptances
  add constraint legal_acceptances_scope_matches_document
  check ((document_key = 'EVENT_RULES') = (scope_match_id is not null));

-- the declaration of being 18 or older travels with the event rules and only with them
alter table legal_acceptances
  add constraint legal_acceptances_age_declaration_shape
  check (
    (document_key = 'EVENT_RULES' and age_declared_18 is true)
    or (document_key <> 'EVENT_RULES' and age_declared_18 is null)
  );

alter table legal_acceptances
  add constraint legal_acceptances_sha256_shape
  check (content_sha256 ~ '^[0-9a-f]{64}$');

alter table legal_acceptances
  add constraint legal_acceptances_version_shape
  check (document_version = btrim(document_version) and char_length(document_version) between 1 and 64);

alter table legal_acceptances
  add constraint legal_acceptances_locale_valid
  check (locale in ('es', 'en'));

alter table legal_acceptances
  add constraint legal_acceptances_source_valid
  check (source in ('PRE_PARTICIPATION'));

create unique index legal_acceptances_global_unique
  on legal_acceptances (gaming_member_id, document_key, document_version)
  where scope_match_id is null;

create unique index legal_acceptances_scoped_unique
  on legal_acceptances (gaming_member_id, document_key, document_version, scope_match_id)
  where scope_match_id is not null;

create index legal_acceptances_gaming_member_id_idx on legal_acceptances (gaming_member_id);
create index legal_acceptances_scope_match_id_idx on legal_acceptances (scope_match_id) where scope_match_id is not null;

create function legal_acceptances_are_never_updated()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  raise exception 'LEGAL_ACCEPTANCE_IMMUTABLE: a recorded acceptance is never changed; a new version is a new row';
end;
$$;

create trigger legal_acceptances_no_update
  before update on legal_acceptances
  for each row execute function legal_acceptances_are_never_updated();

-- The single writer. Idempotent and safe under concurrency: the same act asked again, or asked at the same moment, ends in one row and the
-- same answer, with already_recorded telling the two apart. A second call that names a different text (another hash) for the same
-- version is refused: a published version is immutable.
create function record_legal_acceptance(
  p_gaming_member_id uuid,
  p_document_key text,
  p_document_version text,
  p_content_sha256 text,
  p_act_type text,
  p_scope_match_id uuid,
  p_age_declared_18 boolean,
  p_locale text,
  p_source text
)
returns table (acceptance jsonb, already_recorded boolean)
language plpgsql
security invoker
set search_path = public
as $$
declare
  v_row legal_acceptances;
  v_existing legal_acceptances;
begin
  if p_scope_match_id is null then
    insert into legal_acceptances (
      gaming_member_id, document_key, document_version, content_sha256, act_type,
      scope_match_id, age_declared_18, locale, source
    ) values (
      p_gaming_member_id, p_document_key, p_document_version, p_content_sha256, p_act_type,
      null, p_age_declared_18, p_locale, p_source
    )
    on conflict (gaming_member_id, document_key, document_version) where scope_match_id is null do nothing
    returning * into v_row;
  else
    insert into legal_acceptances (
      gaming_member_id, document_key, document_version, content_sha256, act_type,
      scope_match_id, age_declared_18, locale, source
    ) values (
      p_gaming_member_id, p_document_key, p_document_version, p_content_sha256, p_act_type,
      p_scope_match_id, p_age_declared_18, p_locale, p_source
    )
    on conflict (gaming_member_id, document_key, document_version, scope_match_id) where scope_match_id is not null do nothing
    returning * into v_row;
  end if;

  if v_row.legal_acceptance_id is not null then
    return query select to_jsonb(v_row), false;
    return;
  end if;

  -- the row was already there (a repeat, or a concurrent request that committed first): read it, never write it again
  select * into v_existing
    from legal_acceptances a
   where a.gaming_member_id = p_gaming_member_id
     and a.document_key = p_document_key
     and a.document_version = p_document_version
     and a.scope_match_id is not distinct from p_scope_match_id;

  if not found then
    raise exception 'LEGAL_ACCEPTANCE_NOT_FOUND_AFTER_CONFLICT: the conflicting row is gone; try again';
  end if;

  if v_existing.content_sha256 <> p_content_sha256 then
    raise exception 'LEGAL_ACCEPTANCE_HASH_CONFLICT: this version was recorded for a different text';
  end if;

  return query select to_jsonb(v_existing), true;
end;
$$;

alter table legal_acceptances enable row level security;

revoke all on table legal_acceptances from public, anon, authenticated;
revoke execute on function record_legal_acceptance(uuid, text, text, text, text, uuid, boolean, text, text) from public, anon, authenticated;
grant execute on function record_legal_acceptance(uuid, text, text, text, text, uuid, boolean, text, text) to service_role;
revoke execute on function legal_acceptances_are_never_updated() from public, anon, authenticated;
