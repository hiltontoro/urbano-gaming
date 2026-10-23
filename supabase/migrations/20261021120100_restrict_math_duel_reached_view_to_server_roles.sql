-- Migration: restrict_math_duel_reached_view_to_server_roles
--
-- public.duel_math_challenges_reached is read only by server code (the
-- service role) and by this repository's contract tests. No client role
-- (PUBLIC, anon, authenticated) has any reason to reach it directly, so
-- their table privileges on it are removed.
--
-- Scope, deliberately minimal:
--   * permissions only: no view definition, table, row, function, policy or
--     other grant is changed; service_role and the owner keep their
--     privileges, so the server path is unchanged;
--   * idempotent: revoking a privilege that is not held is a no-op, so this
--     may run on a database where the same revoke was already applied
--     directly, and may run any number of times;
--   * guarded: it does nothing where the view does not exist.
--
-- Append-only: this file never edits 0146, which created the view.

do $$
begin
  if to_regclass('public.duel_math_challenges_reached') is not null then
    revoke all on table public.duel_math_challenges_reached from public, anon, authenticated;
  end if;
end
$$;
