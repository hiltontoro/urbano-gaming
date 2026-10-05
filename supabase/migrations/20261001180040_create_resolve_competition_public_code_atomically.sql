-- RESOLVE_COMPETITION_PUBLIC_CODE / RESOLVE_COMPETITION_TEAM_PUBLIC_CODE
-- (UG-CR-GATE-081 Phase 3A). The two read-only lookups the opaque
-- public-code navigation scheme needs: an unauthenticated visitor's
-- browser holds only a public_code (never the real competition_id/
-- competition_team_id), and the thin API layer uses these to resolve it
-- to the real id before making the SAME already-existing, already-
-- authorized call it always made (GET competition view, or the
-- existing invitation-preview route) — authorization for every
-- subsequent action remains exactly what it always was, entirely
-- independent of whether the public_code itself stays secret. Each
-- function returns the bare id(s) only, nothing else, and raises a
-- generic not-found on any mismatch — identical in shape to the
-- existing invitation-preview route's own "fabricated/mismatched pair"
-- handling.
--
-- security definer because both tables have row level security enabled
-- with zero policies and anon/authenticated already revoked — exactly
-- the same boundary every other Competitions RPC crosses; EXECUTE is
-- revoked from public/anon/authenticated below and granted only to
-- service_role, so these remain reachable only through this project's
-- own server-side route handlers, never directly from a browser.

create function resolve_competition_public_code_atomically(
  p_public_code text
)
returns table (competition_id uuid)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_competition_id uuid;
begin
  select competitions.competition_id into v_competition_id
    from competitions
   where competitions.public_code = p_public_code;

  if v_competition_id is null then
    raise exception 'COMPETITION_NOT_FOUND: no such competition exists' using errcode = 'P0001';
  end if;

  return query select v_competition_id;
end;
$$;

revoke all on function resolve_competition_public_code_atomically(text) from public, anon, authenticated;
grant execute on function resolve_competition_public_code_atomically(text) to service_role;

create function resolve_competition_team_public_code_atomically(
  p_competition_public_code text,
  p_team_public_code text
)
returns table (competition_id uuid, competition_team_id uuid)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_competition_id uuid;
  v_team_id uuid;
begin
  select competitions.competition_id into v_competition_id
    from competitions
   where competitions.public_code = p_competition_public_code;

  if v_competition_id is null then
    raise exception 'COMPETITION_NOT_FOUND: no such competition exists' using errcode = 'P0001';
  end if;

  select competition_teams.competition_team_id into v_team_id
    from competition_teams
   where competition_teams.public_code = p_team_public_code
     and competition_teams.competition_id = v_competition_id;

  if v_team_id is null then
    raise exception 'COMPETITION_TEAM_NOT_FOUND: no such team exists in this competition' using errcode = 'P0001';
  end if;

  return query select v_competition_id, v_team_id;
end;
$$;

revoke all on function resolve_competition_team_public_code_atomically(text, text) from public, anon, authenticated;
grant execute on function resolve_competition_team_public_code_atomically(text, text) to service_role;
