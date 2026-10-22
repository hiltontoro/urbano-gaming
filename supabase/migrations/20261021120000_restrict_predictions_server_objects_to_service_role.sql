-- Migration: 20261021120000_restrict_predictions_server_objects_to_service_role
--
-- Closes the Predictions-owned direct-client bypasses.
--
-- Every Soccer Predictions database object is reached only through the
-- server-side repository, which connects as service_role. Until now three
-- functions and six tables created by earlier Predictions migrations were
-- also reachable by the browser roles (anon / authenticated) through the
-- public PostgREST endpoint:
--
--   * set_match_activity_classification_atomically (0083)
--       lets any client reclassify a match (e.g. TRAINING <-> OFFICIAL);
--   * set_match_xp_eligibility_atomically (0102)
--       lets any client flip a match's XP eligibility;
--   * upsert_prediction_atomically (0084 and later)
--       lets any client submit a prediction with a SELF-REPORTED
--       "inside the venue" flag, bypassing the server's geolocation check;
--   * matches, predictions, players, teams, venues, venue_activations
--       directly readable/writable by any client: a member could read
--       other members' predictions before settlement or rewrite the
--       match, venue and radius a prediction is judged against.
--
-- A repository-wide search found no legitimate client-side consumer: the
-- web pages call the application's own /api/gaming/predictions/* routes,
-- which authenticate the member, run the geolocation and authority checks
-- and then call the database with the service-role key. Removing browser
-- access therefore changes nothing for a real user.
--
-- Scope: ONLY objects created for Predictions. Shared authority, identity,
-- audit and Metagame tables (gaming_members, authority_grants,
-- authority_audit, experience_summaries, ...) belong to other lanes and are
-- deliberately not touched here; see the release notes for the dependency.
--
-- This migration is append-only and idempotent: re-running it changes
-- nothing. It does NOT drop or replace any function, so it cannot break an
-- application version that calls the same signatures as service_role.

-- ---------------------------------------------------------------------
-- Functions: every overload of the three names, whatever its signature
-- ---------------------------------------------------------------------

do $$
declare
  r record;
begin
  for r in
    select p.oid::regprocedure as signature
    from pg_proc p
    where p.pronamespace = 'public'::regnamespace
      and p.proname in (
        'set_match_activity_classification_atomically',
        'set_match_xp_eligibility_atomically',
        'upsert_prediction_atomically'
      )
  loop
    execute format('revoke execute on function %s from public, anon, authenticated', r.signature);
    execute format('grant execute on function %s to service_role', r.signature);
  end loop;

  if not exists (
    select 1 from pg_proc p
    where p.pronamespace = 'public'::regnamespace
      and p.proname = 'upsert_prediction_atomically'
  ) then
    raise exception 'EXPECTED_FUNCTION_MISSING: upsert_prediction_atomically not found; refusing to continue';
  end if;
end
$$;

-- ---------------------------------------------------------------------
-- Tables: RLS on, no direct client privileges
-- ---------------------------------------------------------------------

alter table matches enable row level security;
alter table predictions enable row level security;
alter table players enable row level security;
alter table teams enable row level security;
alter table venues enable row level security;
alter table venue_activations enable row level security;

revoke all on table matches from public, anon, authenticated;
revoke all on table predictions from public, anon, authenticated;
revoke all on table players from public, anon, authenticated;
revoke all on table teams from public, anon, authenticated;
revoke all on table venues from public, anon, authenticated;
revoke all on table venue_activations from public, anon, authenticated;

-- ---------------------------------------------------------------------
-- Post-condition: fail the migration rather than leave a gap
-- ---------------------------------------------------------------------

do $$
declare
  v_leak text;
begin
  select string_agg(format('%s -> %s', x.object, x.role_name), ', ')
    into v_leak
  from (
    select p.oid::regprocedure::text as object, rn.role_name
    from pg_proc p
    cross join (values ('anon'), ('authenticated')) as rn(role_name)
    where p.pronamespace = 'public'::regnamespace
      and p.proname in (
        'set_match_activity_classification_atomically',
        'set_match_xp_eligibility_atomically',
        'upsert_prediction_atomically'
      )
      and has_function_privilege(rn.role_name, p.oid, 'execute')
    union all
    select t.table_name, rn.role_name
    from (values ('matches'), ('predictions'), ('players'), ('teams'), ('venues'), ('venue_activations')) as t(table_name)
    cross join (values ('anon'), ('authenticated')) as rn(role_name)
    where has_any_column_privilege(rn.role_name, format('public.%I', t.table_name)::regclass, 'select,insert,update,references')
       or has_table_privilege(rn.role_name, format('public.%I', t.table_name)::regclass, 'select,insert,update,delete,truncate,references,trigger')
  ) x;

  if v_leak is not null then
    raise exception 'CLIENT_ACCESS_REMAINS: %', v_leak;
  end if;
end
$$;
