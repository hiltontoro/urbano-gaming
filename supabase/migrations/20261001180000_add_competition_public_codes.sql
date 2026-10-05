-- ADD_COMPETITION_PUBLIC_CODES (UG-CR-GATE-081 Phase 3A; corrected by
-- UG-CR-GATE-082 per UG-CR-REV-053 #1/#2). Opaque, non-identifying
-- public identifiers for competitions and teams, so user-visible
-- navigation and invitation URLs never carry the real
-- competition_id/competition_team_id primary keys. Authorization
-- remains entirely independent of these codes' secrecy — every
-- consequential write still re-verifies the caller's real identity and
-- authority exactly as before (see every *_atomically function in this
-- domain); a public_code only ever resolves to the real id for a
-- subsequent, independently-authorized read, one layer earlier in the
-- same chain the existing invitation-preview route already established
-- as an accepted precedent (UG-CR-RPT-041/042 §8/§9/§10: "invitations
-- are navigation, not authority").
--
-- REV-053 #1 (corrected here): the original backfill used
-- `md5(gen_random_uuid()::text)`, a 32-character hex digest — a
-- different shape from the 22-character base64url codes
-- lib/gaming/competitions/publicCode.ts generates for every new row
-- (randomBytes(16).toString("base64url"), the same shape
-- lib/session/hostToken.ts already uses for an unrelated opaque
-- token). public/competitionsIntent.js's PUBLIC_CODE_PATTERN accepts
-- only the 22-character shape, so a backfilled row was permanently
-- unresolvable through the real browser navigation/invitation surface.
-- The backfill below now derives the SAME 22-character, no-padding
-- base64url shape from the 16 raw bytes of a gen_random_uuid() — via
-- uuid_send() (core builtin: UUID's binary representation) and
-- encode(..., 'base64') (core builtin) — reusing Postgres core
-- functions only, with no new extension dependency, exactly as the
-- original backfill already intended.
--
-- REV-053 #2 (also addressed here): both columns now also carry a
-- matching DEFAULT using the identical expression, so a 3/4-arg
-- "old"-signature RPC call that never mentions public_code in its
-- INSERT (i.e. every legacy function body, unmodified — see
-- 20261001180010/020/030's own corrected header comments) still
-- satisfies the NOT NULL constraint below without edits of its own.
-- This is the column-level half of this gate's expand/contract design;
-- the RPC-level half lives in 20261001180010/020/030.
--
-- No RLS/GRANT change: both tables already have row level security
-- enabled with zero policies and anon/authenticated already revoked
-- from their own creation migration — adding a column does not alter
-- that boundary, matching every prior ALTER in this domain (e.g.
-- 20260908100336_alter_competition_teams_add_status_and_provenance.sql,
-- which also adds columns with no re-grant/re-revoke of its own).

alter table competitions add column public_code text;
update competitions set public_code = rtrim(translate(encode(uuid_send(gen_random_uuid()), 'base64'), '+/', '-_'), '=') where public_code is null;
alter table competitions alter column public_code set not null;
alter table competitions alter column public_code set default rtrim(translate(encode(uuid_send(gen_random_uuid()), 'base64'), '+/', '-_'), '=');
create unique index competitions_public_code_unique on competitions (public_code);

alter table competition_teams add column public_code text;
update competition_teams set public_code = rtrim(translate(encode(uuid_send(gen_random_uuid()), 'base64'), '+/', '-_'), '=') where public_code is null;
alter table competition_teams alter column public_code set not null;
alter table competition_teams alter column public_code set default rtrim(translate(encode(uuid_send(gen_random_uuid()), 'base64'), '+/', '-_'), '=');
create unique index competition_teams_public_code_unique on competition_teams (public_code);
