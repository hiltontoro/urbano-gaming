# Identity Foundation — Implementation Record

Status: **Designed. Implemented. Integrated. Locally Validated. Desktop Validated. Mobile Validated. Deployed. Production SMTP Restored. Real Production OTP Sign-In Proven. Auth Initialization Flash — Production-Proven Fixed.**

**Current status (2026-08-24), superseding the paragraph below:** Production SMTP is restored (`gaming.urbanohn.com`, Supabase custom SMTP via Resend); a real Confirm-signup OTP sign-in has been proven live in production, including Gaming Member creation and Auth-user↔Gaming-Member mapping. A residual Auth-initialization-flash defect — first assumed fixed by a JS-only correction, then found still present by direct Founder production testing (both normal and hard refresh) — was root-caused to static HTML painting before the shared Auth script could run, corrected by hiding the sign-in control in the static markup itself across all 7 affected pages, deployed, and re-tested live by the Founder: **no flash on either normal or hard refresh.** See "Auth Restoration — SMTP/OTP Production Proving" and "Auth Initialization Flash — Residual Defect + Static First-Paint Correction," near the end of this record, for full evidence. Migration `0125` remains deliberately unapplied; Platform Governance and Gaming XP remain not activated — neither is affected by Auth restoration.

**Original status paragraph, preserved as historical record of this gate's own state at authoring time:** Production SMTP Pending. Production Migration Pending. Production Deployment Pending. Production Operational Validation Pending. Not pushed, not deployed, no production Supabase Auth setting or migration touched. Identity is **not closed** — production remains fully unvalidated. The exact commit SHA is reported in this gate's own deliverable, not embedded here (avoiding a self-referential commit).

## Objective (as accepted)

Implement the accepted Identity Foundation architecture — Gaming Member (persistent, Supabase-Auth-backed identity) distinct from Session Participant (per-Session presence gameplay commands operate on) — locally only, with local Postgres migrations, a real browser Auth adapter validated against local Supabase Auth + Mailpit, and a full local test/operational validation pass. Soccer Predictions and all its schema remain untouched. No production Supabase Auth setting, migration, or email configuration was touched.

## Canonical architecture (unchanged from the accepted design/readiness/seam-resolution gates)

- **Gaming Member** = persistent URBANO Gaming identity, one row per `auth.users` row, created exactly once via profile completion.
- **Session Participant** = participation identity within one Session — unchanged in its own right; gains an optional link to a Gaming Member.
- **Guest** = no Gaming Member linkage, room-code join, manually entered display name — byte-identical to every pre-Identity-Foundation join.
- **Authenticated** = verified Supabase Auth user with a completed Gaming Member profile; Participant optionally linked; identical Session/gameplay architecture and commands as a Guest.
- Gaming Member never replaces Participant inside gameplay. Every existing gameplay command (submit response, cast vote, submit quiz response, award points) still operates on `participant_id` / `participant_token`, unchanged.

## Files changed

**New migrations** (`supabase/migrations/`):
- `0045_create_gaming_members.sql`
- `0046_add_gaming_member_id_to_participants.sql`
- `0047_create_gaming_member_atomically.sql`
- `0048_create_gaming_admins.sql`
- `0049_join_participant_atomically_accepts_gaming_member.sql` — **not on the founder's original proposed list; see "Deviation from the proposed migration set" below.**

**New domain module** (`lib/gaming/`, parallel to `lib/session/`):
- `types.ts` — `GamingMemberRecord`, `EmptyGamingDisplayNameError`, `GamingDisplayNameTooLongError`.
- `db/gamingRepository.ts` — repository interface.
- `db/inMemoryGamingRepository.ts` — behavioral-test implementation, with `seedAdmin`/`revokeAdmin` test seams.
- `db/supabaseGamingRepository.ts` — Postgres-backed implementation.
- `resolveGamingMember.ts` — pure lookup, never creates.
- `createGamingMember.ts` — validated, idempotent creation.
- `auth.ts` — `resolveGamingAuth`, `SupabaseAuthUserVerifier`, `isCurrentlyGamingAdmin`.

**Modified existing files**:
- `lib/session/types.ts` — `JoinSessionResult.gamingMemberId` (additive); `GamingMemberAlreadyInSessionError`.
- `lib/session/db/sessionRepository.ts` — `ParticipantRecord.gamingMemberId`.
- `lib/session/db/inMemorySessionRepository.ts` — one-Gaming-Member-per-Session collision check in `joinParticipant`.
- `lib/session/db/supabaseSessionRepository.ts` — passes `p_gaming_member_id`; translates the new unique-violation; maps `gaming_member_id` on read.
- `lib/session/joinSession.ts` — additive optional 4th parameter `gamingMemberId`, default `null`.
- `app/api/sessions/[identifier]/join/route.ts` — additive `Authorization` header handling (see "Join Session evolution" below).
- `public/urbanoAuth.js` — rewritten from an inert stub into the real browser Auth adapter.
- `public/participant.html` — loads `urbanoAuth.js`; prefills display name and attaches the bearer token on join when authenticated (see "Participant-page wiring" below — **not originally itemized, discovered necessary during the operational simulation**).
- `.env.local` / `.env.example` — new `SUPABASE_ANON_KEY` entry.
- `package.json` — `gamingMember.test.ts` added to `test`; `gamingMemberSupabaseRepository.contract.test.ts` added to `test:contract`.
- Four existing contract-test files (`supabaseSessionRepository`, `votingSupabaseRepository`, `segmentSupabaseRepository`, `quizSupabaseRepository`) and `joinSession.test.ts` — their local `buildParticipantRecord`/inline `ParticipantRecord` literals updated with `gamingMemberId: null` for the new required field.

**New API routes**:
- `app/api/gaming/config/route.ts` — `GET`, serves `{supabaseUrl, supabaseAnonKey}`.
- `app/api/gaming/member/route.ts` — `GET` (resolve) / `POST` (create).

**Not touched**: `QUIZ_EXPERIENCE_IMPLEMENTATION_RECORD.md`, `TRIVIA_GAME_COMPOSITION_IMPLEMENTATION_RECORD.md`, `supabase/.gitignore`, `supabase/config.toml`'s pre-existing content (one local-only addition made, see below), any Match/Venue/Prediction/Result/Prize/Progression/Leaderboard schema or code.

## Gaming Member schema (exact, as implemented and verified)

```sql
gaming_members (
  gaming_member_id uuid primary key default gen_random_uuid(),
  auth_user_id     uuid not null unique references auth.users(id) on delete cascade,
  display_name     text not null,
  created_at       timestamptz not null default now()
)
-- check: char_length(btrim(display_name)) between 1 and 40
```

No email duplication, no Lifestyle/avatar/bio/preferences/progression/venue data, no admin boolean. Verified directly via `\d gaming_members` against local Postgres: FK, unique constraint, and check constraint all present exactly as designed.

## Participant linkage (exact, as implemented and verified)

```sql
alter table participants add column gaming_member_id uuid null
  references gaming_members(gaming_member_id) on delete set null;
create index participants_gaming_member_id_idx on participants (gaming_member_id);
create unique index participants_session_gaming_member_unique
  on participants (session_id, gaming_member_id) where gaming_member_id is not null;
```

`participants_session_display_name_unique` (0003) is untouched — an authenticated member's name collision with an existing Guest or member still raises the pre-existing `DisplayNameTakenError`, verified live (browser) and in both behavioral and contract tests.

## Gaming Member creation lifecycle

Two distinct operations, exactly as specified:

- **`resolveGamingMember(repo, authUserId)`** — a plain `select ... where auth_user_id = ...`, never creates. A missing profile returns `null`, not an error.
- **`createGamingMember(repo, authUserId, displayName)`** — validates (non-empty, ≤40 chars after trim), then calls `create_gaming_member_atomically`, which does `insert ... on conflict (auth_user_id) do nothing returning *`, re-selecting the winning row on a lost race. Idempotent under concurrency — verified with two genuinely concurrent `Promise.all` creates against real local Postgres in the contract suite (same `gaming_member_id`, first `display_name` wins).

No placeholder rows are possible by construction: the only writer of `gaming_members` is this one function, and it always requires a real, validated `display_name`.

## Admin authorization

```sql
gaming_admins (
  gaming_member_id uuid primary key references gaming_members(gaming_member_id) on delete cascade,
  granted_at       timestamptz not null default now(),
  granted_by       uuid null references gaming_members(gaming_member_id) on delete set null
)
```

`isCurrentlyGamingAdmin(repo, gamingMemberId)` is a plain, fresh-every-call repository lookup — never a JWT claim, never cached. Verified: absent → `false`; row inserted → `true` on the very next call; row deleted → `false` on the very next call — both in-memory (behavioral) and against real Postgres (contract, via direct `gaming_admins` insert/delete through a separate client, proving no server-side caching layer exists either). No admin UI and no admin-gated feature were built — only the mechanism, per instruction.

## Browser Auth adapter (`public/urbanoAuth.js`)

Rewritten from the fully inert stub (`getState()` always `unauthenticated`, `signIn()` always `not_connected`) into the real adapter: `getState`, `isAuthenticated`, `requestOtp`, `verifyOtp`, `completeProfile`, `signOut`, `getAccessToken`, `onAuthStateChange`, `attachSignInButton`. The Supabase browser client is loaded from a CDN UMD build (`@supabase/supabase-js@2/dist/umd/supabase.js`) at runtime — no bundler import, since these are unbundled static files. Gaming Member profile resolution/creation goes through this app's own API (`/api/gaming/member`), never directly against `gaming_members` from the browser. Only the anon key is ever used client-side.

`attachSignInButton` builds its own minimal inline panel (email → code → verify → display name if first-time → signed in) rather than requiring any HTML change to the five pages that call it (`index.html`, `leaderboards.html`, `soccer-predictions.html`, `trivia-playtest.html`, `rewards.html`) — all five worked unmodified once `urbanoAuth.js` itself was rewritten.

## Client Auth configuration — the runtime-config question, resolved with evidence

Investigated before choosing a mechanism, per instruction: this repository has **no `next.config.js`/`next.config.mjs` at all**, and `public/*.html` files are served as raw, unbundled static assets — Next.js's `NEXT_PUBLIC_*` build-time inlining is a webpack feature that never touches them. Resolution: `GET /api/gaming/config`, a thin server route returning `{supabaseUrl, supabaseAnonKey}` as JSON, fetched once by `urbanoAuth.js` on init — consistent with this repo's 100%-API-route architecture. New env var `SUPABASE_ANON_KEY` (not `NEXT_PUBLIC_*`, since the prefix has no effect here) added to `.env.local` (left empty pending production Auth readiness — see SMTP blocker) and documented in `.env.example`.

## JWT / server authority (`lib/gaming/auth.ts`)

`resolveGamingAuth(repo, verifier, authorizationHeader)` returns one of: `guest` (no header), `invalid_token` (malformed header, or a token that fails verification against Supabase Auth itself via `auth.getUser(accessToken)` — covers forged and genuinely expired tokens identically), `profile_incomplete` (verified identity, no Gaming Member yet), `authenticated` (resolved `GamingMemberRecord`). `gaming_member_id` is **never** trusted from request JSON/body/query — every authenticated code path resolves it from this function's own output, which is itself derived only from a token Supabase Auth verified. Verified live: a forged bearer token → `401`; a legacy request with no `Authorization` header at all → the exact pre-existing Guest behavior.

## Join Session evolution (`app/api/sessions/[identifier]/join/route.ts`)

Additive only. No `Authorization` header → identical to the pre-Identity-Foundation route: parse `displayName` from the body, require it, call `joinSession(repo, roomCode, displayName)` — same function, same default parameter, same validation order. A present header: verify → resolve Gaming Member → `invalid_token` → `401`; `profile_incomplete` → `403` (no half-authenticated Guest fallback); `authenticated` → the Gaming Member's own `display_name` is the default, a non-empty body `displayName` overrides it for this Session only, `gamingMemberId` is passed through to `joinSession`. `JoinSessionResult` gained one additive field (`gamingMemberId: string | null`) — old clients ignore it.

## Participant-page wiring (discovered necessary during the operational simulation, not originally itemized)

`participant.html` (the join/gameplay harness) was not one of the five pages with the shell "Sign in with URBANO" button and had no `urbanoAuth.js` reference at all. The 20-step simulation's own requirement ("name prefilled automatically," "Participant row linked to Gaming Member") is unreachable without it. Added: `<script src="/urbanoAuth.js">`; a small `initGamingAuthPrefill()` called alongside the existing `restoreState()` that resolves `UrbanoAuth.getState()` once on load, prefills `#p-displayName` only if empty (never clobbers a value already typed), and captures the access token into a module-level `gamingAccessToken`; the three join call sites (`joinSession`, `joinNextSession`, `joinAnotherSession`) now pass that token to the existing (already-present, previously-unused-for-this-purpose) `postJson(path, body, bearerToken)` parameter. `gamingAccessToken` stays `null` for a Guest, producing the exact pre-existing flat request.

## Display name rule

Verified live end-to-end: Gaming Member `display_name` prefilled the Session join field automatically; leaving it unedited produced a Session join with that exact value (pure-default path, exercised on the rematch join); typing over it produced the per-Session override, with the persistent Gaming Member row's own `display_name` unchanged afterward (re-queried directly — still `Alex`).

## RLS — local/production divergence (recorded, not repaired)

Production auto-enables RLS on every new `public` table via a live, non-migration-tracked `rls_auto_enable()` event trigger (confirmed directly against the linked production schema in the prior seam-resolution pass). Local does not reproduce this mechanism — confirmed directly this session: `gaming_members` and `gaming_admins` both show `relrowsecurity = false` on local Postgres immediately after migration. **No policy was added to either table**, including no "defense in depth" own-row policy — per the founder's explicit reversal of that earlier recommendation. Both tables are reached only through the server's `service_role` client; no direct browser/PostgREST access path exists or was built. This divergence was not repaired in this task, per instruction. Nothing during implementation forced a genuine need for direct-browser-access policy — the "STOP and report" condition was never triggered.

## Deviation from the proposed migration set (evidence-driven, not a planning error)

The founder's proposed list included a `resolve_gaming_member` SQL function (originally numbered `0047`). Implemented instead as a plain repository `select`, matching this codebase's own existing convention (e.g. `getQuizWindowForSegment`) of reserving dedicated atomic SQL functions for writes with real invariants to protect, not for pure reads. This freed `0047` for `create_gaming_member_atomically`.

A fifth migration, **`0049_join_participant_atomically_accepts_gaming_member.sql`**, was not on the original proposed list at all. It became necessary once implementation reached the join route: `join_participant_atomically` (0004) has no parameter for `gaming_member_id` and cannot persist the linkage without one. Extended via this repository's own established drop-then-create pattern (used identically in 0037/0039 for `start_session_atomically`) — `p_gaming_member_id uuid default null` appended, so every existing caller (including cached old client JS sending only 8 arguments) is unaffected. Verified: function now has exactly 9 parameters; the partial unique index's violation is exactly the mechanism `SupabaseSessionRepository` already translates into `GamingMemberAlreadyInSessionError`, requiring no new exception-raising logic inside the function itself.

## Local-only email template override (discovered necessary, not originally scoped)

The operational simulation surfaced a real gap: the Supabase CLI's default local `magic_link` email template renders only `{{ .ConfirmationURL }}`, never `{{ .Token }}` — so the founder's specified 6-digit-code UX had no code to display in Mailpit at all, only a magic-link URL. Resolved locally: `supabase/templates/magic_link.html` (new, untracked local scaffolding, same standing as `supabase/config.toml`) now renders `{{ .Token }}` alongside the link; `supabase/config.toml` gained one `[auth.email.template.magic_link]` section pointing at it, with a comment stating this is local-only and never touches production Auth settings. The local stack was stopped and restarted (`supabase stop` / `supabase start`) to apply it — data verified intact before and after (26 sessions, 23 participants, 1 auth user, unchanged). This is standard, expected local-dev configuration for exactly this feature, not a workaround of anything else.

## Tests

**Behavioral** (`__tests__/gamingMember.test.ts`, in-memory, 24 tests): Gaming Member creation (valid; idempotent under duplicate/concurrent create; empty name rejected; too-long name rejected; no placeholder row on failure); resolution (existing resolves; missing returns `null`); Gaming Auth (guest; forged/unrecognized token; malformed header; profile-incomplete; authenticated returning member); admin (absent → false; inserted → true; deleted → false; checked with no token/claim involved at all); Participant linkage (Guest null; authenticated join links correctly; second Participant for same member+Session rejected; same member joins a different Session; Guest/member coexistence; name-collision uses existing `DisplayNameTakenError`; legacy 3-arg call byte-identical); one explicit existing-gameplay regression test (an authenticated Participant submits a response using `participantToken`, identically to a Guest).

**Contract** (`__tests__/gamingMemberSupabaseRepository.contract.test.ts`, real local Postgres, 9 tests): create against a real `auth.users` row; FK rejection for a fabricated `auth_user_id` (`23503`); empty-name check-constraint rejection; concurrent-create idempotency (exactly one row, verified by count); `auth.users` deletion cascades the Gaming Member; `gaming_admins` insert/delete take effect immediately; `join_participant_atomically` links a real Gaming Member; the partial unique index rejects a second Participant for the same member in the same Session; deleting a Gaming Member directly `SET NULL`s the historical Participant row without deleting it.

Four pre-existing contract-test files and `joinSession.test.ts` were updated only to add the new required `gamingMemberId` field to their local participant-record builders/literals — no behavioral change to what they test.

**Security boundary regression** (`__tests__/gamingConfigRoute.test.ts`, 2 tests, added during the Final Local Acceptance gate): imports `GET` from `app/api/gaming/config/route.ts` directly and calls it with `SUPABASE_SERVICE_ROLE_KEY` deliberately set in the same process — proves structurally that the response contains only `supabaseUrl`/`supabaseAnonKey` and never the service_role value, by exact key-set equality and by asserting the service_role sentinel string is absent from the serialized body. Verified to actually catch a regression: temporarily adding `serviceRoleKey` to the route's response was confirmed to fail this test before the route was restored.

## Local database / migrations — application

Migration ceiling confirmed at exactly `0044` before this phase (no drift). `0045`–`0049` applied via `supabase migration up --local` only, verified directly against local Postgres after each apply (`\d`, `pg_proc`, `pg_class.relrowsecurity`). **Re-confirmed during the Final Local Acceptance gate, via `supabase migration list --linked` (a genuine, authoritative, read-only query of the actual linked production project) and a `supabase db dump --linked --schema public` search for `gaming_members`/`gaming_admins`**: production's migration ceiling remains exactly `0044`, and neither new table exists there. (Note: `supabase migration list --local`'s own "remote" column refers to the local database's own migration-history bookkeeping table, not the linked cloud project — confirmed by this cross-check, since it had briefly shown `0045`–`0049` as "applied" under that column while the authoritative `--linked` check showed them empty; no production mutation occurred at any point.) Never applied to, or touched in any way on, production/linked Supabase.

## Operational simulation (real local OTP + Mailpit, all 20 steps)

Run against `next dev` wrapped with local-only env vars via a temporary `.claude/launch.json` entry (`urbano-gaming-dev-local-identity`) — reverted to zero diff immediately after (`git diff -- .claude/launch.json` empty).

1. Participant A requested an OTP for `participant-a@urbanogaming.test`. ✅
2. Code (`198112`) received in Mailpit, rendered via the local-only template override. ✅
3. A verified the code — routed to profile completion (no existing Gaming Member). ✅
4. A entered display name "Alex". ✅
5. `gaming_members` row created — verified directly in Postgres. ✅
6. Full page reload — still shown as "Hi, Alex" (localStorage persistence). ✅
7. A joined room `2XHY5S` by room code via `participant.html`. ✅
8. Display name field auto-prefilled "Alex" before any interaction. ✅
9. Resulting Participant row's `gaming_member_id` matched Alex's Gaming Member — verified directly. ✅
10. Participant B ("Jordan") joined the same room as a Guest, from an independent (localStorage-cleared) browser context — `gaming_member_id` null. ✅
11. Both visible in the same session simultaneously — verified directly (2 participants, one linked, one not). ✅
12. Both played one real Open Response interaction (host: lock lobby, start, both submitted). ✅
13. Both submissions attributed by `participant_id` exactly as before — Gaming Member linkage had zero effect on the gameplay/submission mechanism. ✅
14. A signed out explicitly via the panel's Sign Out control — reverted to "Sign in with URBANO". ✅
15. B's tab (independent `sessionStorage`) was completely unaffected by A's sign-out — its already-submitted response remained visible, untouched. ✅
16. A re-authenticated with a fresh OTP (`946141`... and an earlier confirming run with `469962`). ✅
17. Both re-authentications resolved straight to the signed-in state — **no display-name step was ever shown to a returning member**; `gaming_members` row count for "Alex" stayed at exactly 1. ✅
18. Session completed (host) and a rematch created via `CREATE_SUCCESSOR_SESSION` (room `EEHT27`, `predecessor_session_id` correctly set). ✅
19. A joined the rematch through the ordinary "Join Next Session" flow, with the display-name field left blank to specifically exercise the pure-default (no override) path. ✅
20. A fresh Participant row in the rematch session carries `display_name = "Alex"` (the Gaming Member's own default, not typed) and the **same** `gaming_member_id` as the original session — persistent identity confirmed across a rematch. ✅

Additional live checks beyond the 20 steps: a legacy flat Guest join (no `Authorization` header at all) returns the byte-identical pre-existing shape plus the additive `gamingMemberId: null` field; a forged bearer token is rejected with `401` without touching the Guest path at all.

## Mobile validation (375×812)

Signed-in header ("Hi, Alex" / "Sign out") rendered cleanly with no overflow. **One real defect found and fixed**: the sign-in panel, opened from the far-right "Sign in with URBANO" button, defaulted to `position: absolute` with no explicit horizontal anchor — at desktop width this was invisible (plenty of clear space), but at 375px it rendered flush against the left edge of the header, overlapping the brand mark rather than appearing near the button that opened it. Fixed by anchoring the panel to `right: 0` of its (now-relatively-positioned) header parent and constraining its width to `min(320px, calc(100vw - 24px))`. Re-verified after the fix: panel renders fully on-screen, anchored correctly, at 375px width.

## Defects found and fixed during this implementation

1. **Local email template gap** — see "Local-only email template override" above. Not a code defect; a local Supabase CLI default that made the founder's specified 6-digit-code UX untestable locally without an explicit template override.
2. **Sign-in panel mobile positioning** — see "Mobile validation" above. Fixed in `public/urbanoAuth.js`.

No other defects were found. All pre-existing gameplay (Open Response submission, verified live; Multiple Choice/Voting/Quiz/Best Joke, verified via the unchanged 295 pre-existing behavioral tests, all still passing) shows zero regression.

## Explicit deferrals (not implemented in this phase, by instruction)

- Soccer Predictions and all its schema (Match/Venue/Prediction/Result/Prize/Progression/Leaderboard) — untouched.
- Admin UI, venue roles — not built; only the fresh-check mechanism.
- Production RLS auto-enable reconciliation between local and production — recorded, not repaired.
- Real SMTP configuration, production Supabase Auth settings — not touched in any way.
- Gaming Member account deletion / self-service profile management beyond display-name creation — out of scope.

## Final Local Acceptance gate — credential and scope audit

Performed after founder acceptance of the local implementation candidate, before any staging/commit.

**Credential audit.** `.env.local` is untracked and git-ignored (`.gitignore:4`) — confirmed via `git ls-files` (not tracked) and `git check-ignore -v` (matched). It holds the production Supabase URL and a production `service_role` key. A full-repository grep for both values, across every tracked and new Identity file, found zero matches — neither value appears in any migration, test, the implementation record, `public/*.html`/`*.js`, or `.env.example` (which carries only an empty `SUPABASE_ANON_KEY=` placeholder plus a comment). `.claude/launch.json`'s temporary local-only wrapper entries (added twice during this engagement for local browser testing, each time reverted) were also checked — zero diff confirmed both times, so no local demo key value ever reached a tracked file either. Classification: production service-role credential present locally: **YES**; tracked: **NO**; exposed in any diff: **NO**.

**Browser config security.** `GET /api/gaming/config` reads only `process.env.SUPABASE_URL` and `process.env.SUPABASE_ANON_KEY` — it never references `SUPABASE_SERVICE_ROLE_KEY` at all, so leaking it would require a future code change, not a latent condition. A new regression test (`gamingConfigRoute.test.ts`, see "Tests" above) now guards this boundary structurally and was verified to actually fail when the leak was deliberately, temporarily introduced. `app/api/gaming/member/route.ts` uses the service-role key only to construct server-side repository/verifier clients — it is never included in any response body (both routes' only response shapes were reviewed line by line).

**Local email template scope — resolved toward exclusion.** The `supabase/config.toml` magic-link template override and `supabase/templates/magic_link.html` remain **untracked local-only scaffolding**, matching this repository's own standing practice for `supabase/config.toml` and `supabase/.gitignore` (both untracked since before Identity Foundation work began). Reasoning: no version of `supabase/config.toml` has ever been part of this repository's committed history; introducing one now would be a standing-convention change beyond this task's scope, not a natural extension of it; and the file's only purpose is making local OTP-code testing possible on a given developer's own machine, which does not block application functionality or any other developer's ability to run the app (the default local template's magic-link URL still works, it just doesn't expose a 6-digit code without this override). This creates a real, explicit reproducibility gap: another developer running `supabase start` fresh will not see a 6-digit code in Mailpit until they add this same override themselves. That is recorded here as a known gap, not silently resolved by committing local Auth configuration.

**Migration and RLS re-audit.** All items independently re-verified against live local Postgres during this gate: `join_participant_atomically` has exactly one overload (9 args, `p_gaming_member_id` defaulting to `null`) — confirmed callable with the exact legacy 8-named-argument shape a pre-Identity-Foundation client would send, with `gaming_member_id` correctly defaulting to `null`; `gaming_members`/`gaming_admins` both show `relrowsecurity = false` and zero policies; a schema-name search across `public` found no table matching `prediction`/`lifestyle`/`progression`/`leaderboard`/`match`/`venue`/`prize`, and the public schema holds exactly 15 tables (13 pre-existing + the 2 new Identity tables).

**Implementation boundary re-audit.** Every `lib/session/*` diff was reviewed line by line: `types.ts` (additive field + one new error class), `db/sessionRepository.ts` (one additive interface field), `db/inMemorySessionRepository.ts` (one join-time collision check), `db/supabaseSessionRepository.ts` (one additive RPC param + one error translation + one read-mapping), `joinSession.ts` (one additive, defaulted parameter). No gameplay command file (`submitResponse.ts`, `castVote.ts`, `submitQuizResponse.ts`, `awardPoints.ts`, `startSession.ts`, `lockLobby.ts`, `revealResults.ts`, `closeSubmissions.ts`, `completeSession.ts`, `createSuccessorSession.ts`, `prepareQuestions.ts`, `startQuiz.ts`, `closeQuiz.ts`) appears anywhere in this phase's diff — confirmed via `git status --porcelain`. `public/participant.html`'s diff touches only the three join call sites plus one init function; no submit/vote/award call site was touched. Every gameplay command still authenticates via `participantToken`, verified live in this gate's focused sanity pass (see below).

**Focused operational sanity pass** (not a repeat of the full 20-step simulation, since no sign-in/join/gameplay logic changed since it ran — only a CSS fix and one new test were added): local OTP requested and delivered to Mailpit with a fresh code; verified via Supabase Auth's own REST endpoint; the existing Gaming Member (`Alex`, same `gaming_member_id` as the original simulation) resolved without re-creation; a Guest join returned the exact pre-existing shape; an authenticated join correctly defaulted to and linked the Gaming Member; an Open Response submission by that authenticated Participant's own `participantToken` succeeded normally. All confirmed live against the local stack, immediately reverted (`.claude/launch.json` zero diff again).

## Production SMTP blocker (explicit, not solved here)

**Production Identity validation is BLOCKED until: SMTP configuration is confirmed; a verified sending identity/domain is confirmed; one real production OTP email is received successfully.** Local acceptance in this record does **not** imply production Auth readiness. No production email delivery was attempted or configured during this phase.

## Final local verification (Final Local Acceptance gate, after all audits and fixes above)

`npx tsc --noEmit` — clean.
`npm test` — **321/321** passing (295 pre-existing + 24 in `gamingMember.test.ts` + 2 in the new `gamingConfigRoute.test.ts`), zero regression.
`npm run test:contract` (local Postgres only — `SUPABASE_URL`/`SUPABASE_SERVICE_ROLE_KEY` passed as explicit shell env vars, `.env.local`'s production value never touched) — **65/65** passing (56 pre-existing + 9 in `gamingMemberSupabaseRepository.contract.test.ts`).
`npm run build` — clean; both new `/api/gaming/*` routes correctly registered as dynamic routes.
`git diff --check` — clean.
`.claude/launch.json` — zero diff (temporary local-Postgres wrapper entry added twice for browser testing during this engagement, fully reverted both times).

## Final git status

Committed locally as one commit on `integrate/join-session` (exact SHA reported in this gate's own deliverable, not embedded here). **Not pushed** — `origin/main` unchanged. Staged/committed scope: exactly the Identity Foundation implementation, test, and documentation files (this record included). Excluded from the commit: `.env.local` (untracked/ignored, never staged); `QUIZ_EXPERIENCE_IMPLEMENTATION_RECORD.md` and `TRIVIA_GAME_COMPOSITION_IMPLEMENTATION_RECORD.md` (pre-existing, unrelated, left dirty exactly as found); `supabase/.gitignore`, `supabase/config.toml`, and `supabase/templates/` (standing/local-only scaffolding, left untracked per standing practice — see the local email template scope decision above).

## Recommendation

**ACCEPT_LOCAL_IMPLEMENTATION — locally committed.** Local Identity Foundation is fully implemented, migrated, tested (behavioral + contract + a new security-boundary regression), and operationally validated end-to-end including real local OTP delivery, persistence, sign-out, returning-member resolution, rematch identity continuity, Guest/member coexistence, and full backward compatibility of the existing Guest join path — with zero regression across all pre-existing gameplay. A full credential and scope audit found no production secret in any tracked file and no production mutation of any kind. Production Identity remains explicitly blocked on SMTP, is not closed, and is not claimed here.

## Production Deployment & Validation (2026-08-20)

Migrations `0045`–`0049` applied to production alongside the rest of the accepted stack (`0045`–`0081`); commit `f030558` (which includes this Identity Foundation commit `783f258`) pushed to `origin/main` and deployed via the normal GitHub → Vercel path. Production migration ledger confirmed via `supabase migration list --linked` at exactly `0081`; schema-only `supabase db dump --linked` confirmed `gaming_members`/`gaming_admins` present with RLS auto-enabled and zero policies, and confirmed `join_participant_atomically` live in production with the new 9-arg signature (`p_gaming_member_id` defaulting to `null`).

**Guest Session compatibility**: proven directly against production post-deployment — full Create → Join → Lock → Start → Submit → Close → Reveal sequence for a disposable Open Response session succeeded end-to-end with no Authorization header, confirming the Guest path is byte-for-byte unaffected by the Identity schema/RPC changes.

**A production incident was investigated and closed as a test-authoring artifact, not a Product or migration defect**: an initial round of production smoke testing (using the pre-`f030558` and then the `f030558` deployment) produced reproducible 500 errors on `GET /api/sessions/[id]`, `/lock`, and `/start`. Direct database/PostgREST checks (raw `lock_lobby_atomically` RPC call, raw `sessions` table read) succeeded throughout, proving the schema and RPCs were healthy. The actual cause: these three routes require the session's UUID as `[identifier]` (unlike `/join`, which uses the room code), and the diagnostic script had passed the room code to all of them. Retesting with the correct identifier succeeded immediately and consistently. No code or migration change was made or needed.

**OTP/SMTP**: not configured this gate, per explicit instruction. `POST /api/gaming/member` and `/api/gaming/predictions/admin/teams` both correctly return `401` for unauthenticated callers in production (honest rejection, not a crash). `GET /api/gaming/config` currently returns `500` ("browser Supabase configuration not set") because the browser-facing Supabase anon key/configuration is not set in the production environment. **This is an environment/configuration gap, not an Identity code defect** — the route itself, and every route beneath it, functions correctly against the given inputs; it affects only the "Sign in with URBANO" button's ability to initialize (a contained, inline error if clicked), and does not affect Guest Session gameplay, Guest Poker gameplay, or any core server-side `service_role` route.

Classification: **DEPLOYED. OTP PRODUCTION VALIDATION PENDING SMTP** (and pending the separate anon-key configuration item noted above). Guest gameplay confirmed unaffected.

*(2026-08-24: both gaps this classification named — SMTP and the browser anon key — are now closed; see "Auth Restoration — SMTP/OTP Production Proving" below. This line is preserved as an accurate record of this gate's own state on 2026-08-20, not rewritten.)*

## Auth Restoration — SMTP/OTP Production Proving (2026-08-24)

**Why this section exists.** The two gaps the 2026-08-20 deployment gate above named as blocking — no production SMTP, no browser-facing `SUPABASE_ANON_KEY` — were closed by Founder-managed external configuration, independent of this repository: a dedicated Gaming email domain (`gaming.urbanohn.com`, DKIM/SPF/Sending-MX verified in Resend), a dedicated Resend credential scoped to `URBANO Gaming - Supabase Auth`, Supabase custom SMTP configured against `smtp.resend.com`, and a corrected Magic Link/OTP email template exposing `{{ .Token }}` (the previous default template exposed only `{{ .ConfirmationURL }}`, which never matched this application's numeric-code UX). None of this required a repository change; `SUPABASE_ANON_KEY` also became populated in the Vercel environment through this same external channel, confirmed by `GET /api/gaming/config` returning a real, populated key. Transactional Auth email is now functionally operational end to end — the email itself remains a plain Supabase/Resend default template (subject and `{{ .Token }}` corrected, nothing more); full URBANO Gaming visual branding for transactional email (logo, styling) remains deliberately deferred and is not implied by anything in this section.

**Real production Confirm-signup OTP proven, end to end.** The Founder signed in live at `https://urbano-gaming-playtest.vercel.app` using a personal email address in a genuinely fresh browser context: requested a code, received it from `URBANO Gaming <noreply@gaming.urbanohn.com>` with subject "Your URBANO Gaming sign-in code," entered it, completed the profile-completion step with display name `ElPrimerInvestigador`, and the application correctly rendered `Hi, ElPrimerInvestigador` + `Sign out`. Verified directly against the database, not just the UI: `auth.users` shows a genuine confirm-then-sign-in event (`email_confirmed_at`/`last_sign_in_at` both `2026-08-24T02:54:52Z`, ~13 minutes after the row was first created by the OTP request); `gaming_members` gained exactly one new row (`auth_user_id` matching that `auth.users.id` byte-for-byte, `display_name: "ElPrimerInvestigador"`), created 32 seconds after sign-in — no duplicate, no unrelated row.

**Production OTP length is 8 digits, not 6.** The application's own UI (see the Auth UX Micro-Correction below) had assumed 6 digits, a stale carryover from this record's own original Founder-specified design (see "Objective" above and the local-only implementation history earlier in this record) — that assumption is preserved above as accurate history, not rewritten; only the now-incorrect live UI copy was corrected.

**Authorization boundary re-verified live with the real production anon key** (not merely re-asserted): direct PostgREST RPC calls to `bootstrap_governance_authority_atomically`, `grant_platform_authority_atomically`, and `revoke_platform_authority_atomically`, using the real production anon key, all returned `42501 permission denied` — the strongest evidence obtained to date for this boundary, since no real anon-role credential existed for this project before today. `service_role` re-confirmed to still reach genuine domain validation on the same RPCs (`GAMING_MEMBER_NOT_FOUND`/`GOVERNANCE_AUTHORITY_REQUIRED`, never permission-denied). Unauthenticated `401` re-confirmed live on `GET /api/gaming/member` and an admin route; the authenticated-but-ungranted `403` path remains structurally proven (code inspection: `requirePlatformAuthorityHttp` throws `InsufficientPlatformAuthorityError` → 403) rather than exercised with a real bearer token, which was deliberately never requested from the Founder.

**Zero automatic consequence**, confirmed by direct count before and after: `authority_grants` = 0, `admin_audit_events` = 0 — **PLATFORM GOVERNANCE NOT ACTIVATED**. `gaming_xp_events`/`gaming_xp_rules`/`gaming_category_participation_policy` = 0 — **GAMING XP NOT ACTIVATED**. `gaming_admins` still present — **migration `0125` remains unapplied**. A real Gaming Member existing does not, by itself, activate anything downstream of it.

**Returning-user (Magic Link) OTP branch — not independently proven.** Today's test exercised the Confirm-signup flow for a brand-new identity; a subsequent OTP request from an already-confirmed identity (which would render the separate Magic Link template) has not been exercised. Recorded here as a known, non-blocking gap, not silently assumed to be covered by today's proving.

## Auth UX Micro-Correction (2026-08-24)

Two presentation-only defects surfaced directly by the real proving above, both isolated to `public/urbanoAuth.js`:

**OTP-length copy.** The sign-in panel's code-step placeholder read `"6-digit code"` — a literal carryover of this record's own original Founder-specified 6-digit design (see "Objective," above, and the "Local email template gap" findings earlier in this record, both correctly preserved as historical intent, not rewritten) — despite nothing in the actual verification path ever depending on a fixed length (`verifyOtp` passes the input straight through to Supabase unvalidated). Corrected to the length-neutral `"Verification code"`; no `maxlength`/`minlength`/`pattern` was ever present or added.

**Auth-initialization flash.** On every page load, the shared sign-in button showed its static HTML default (`"Sign in with URBANO"`) for the two network round-trips `getState()` needs before it can check the — otherwise instant — local session, then flipped to the correct authenticated state once resolved, producing a brief, visible flash of the wrong control for an already-signed-in member. Corrected by hiding the button (`visibility`, not `display`, to preserve header layout) the instant the shared Auth adapter initializes, revealed unconditionally by every resolution path (authenticated, unauthenticated, and the failure/catch path), so no path can leave it permanently hidden.

**Deployed** as commit `d1a1e3408cd3b3c8c19be195ddb13ba74b36207e` (carrying `67563eda962a6b43b025732a7ddcfdc361af1b6e`, the Experience Discovery Slice 1 documentation closure, naturally in ancestry), fast-forward pushed `5dcdabb..d1a1e34`, Vercel deployment confirmed successful and the deployed `urbanoAuth.js` confirmed byte-identical to the local candidate. Live production proving: the unauthenticated-initialization fix confirmed directly in a genuinely fresh browser context (no stored Supabase session) — button correctly resolved to visible, `"Sign in with URBANO"`, no permanent-hidden state, no layout jump; the OTP-copy fix confirmed via the same byte-identical deployed-source match (a live attempt to reach the "code" step used a deliberately synthetic, non-deliverable test address and correctly failed with "Error sending confirmation email" rather than silently succeeding — zero `auth.users`/`gaming_members` rows resulted). The authenticated-refresh visual (an already-signed-in member hard-refreshing and never seeing the flash) remains source-verified rather than independently live-proven by this session — proving it requires the Founder's own already-authenticated browser, which was correctly never requested here.

No backend, schema, migration, Supabase Auth configuration, SMTP, Resend, DNS, or Vercel environment variable was touched by either the restoration or the correction. Final regression after production proving: **641/641** behavioral, **144/144** contract, clean typecheck and build.

## Auth Initialization Flash — Residual Defect + Static First-Paint Correction (2026-08-24)

**Why this section exists.** The JS-only initialization fix above was deployed and its own local/production proving passed — but it left exactly one item explicitly marked `SOURCE_VERIFIED_LOCAL`, not independently live-proven: whether an already-authenticated member would actually stop seeing the flash on a real refresh. The Founder then tested it directly, twice, and falsified the assumption that the fix was sufficient.

**Founder production evidence — defect remained.** Testing the already-authenticated `ElPrimerInvestigador` session against the live deployment: both a normal refresh and a hard refresh (`Cmd+Shift+R`) still briefly showed `"Sign in with URBANO"` before settling on `"Hi, ElPrimerInvestigador"` + `"Sign out"`. Reproducing on a hard refresh — which bypasses most caching — ruled out a caching explanation and confirmed the defect was structural, not incidental.

**Root cause, re-diagnosed from this evidence, not assumption.** Every affected page places its `<button id="btn-signin">Sign in with URBANO</button>` markup well before a plain, non-`defer`/non-`async` `<script src="/urbanoAuth.js">` tag near the end of `<body>`. The browser can paint that static markup — the literal wrong text — before the script is even fetched, let alone executed; `buttonEl.style.visibility = "hidden"` inside the script can only take effect after that point, a window too small to catch on fast local testing but real and visible over an actual production network.

**Correction: move the initial hidden state into the static markup itself.** A static `style="visibility:hidden"` was added directly to the `btn-signin` element in every page using the shared Auth control — the complete inventory, re-verified independently three separate ways (by id, by `attachSignInButton` call site, and by a full repository grep): `index.html`, `leaderboards.html`, `rewards.html`, `soccer-predictions.html`, `trivia-playtest.html`, `quiz-playtest.html`, and `predictions-admin.html` (an internal admin surface not enumerated in any earlier gate's inventory). The raw HTTP response for every one of these pages now contains the hidden state in its first bytes — confirmed directly via `curl`, not inferred from DOM timing. `public/urbanoAuth.js` itself was **not** modified: its existing hide-on-init call remains as a harmless, defensive no-op, and `renderSignedIn`/`renderSignedOut`/the catch path still unconditionally clear the visibility, composing correctly with the new static default.

**Deployed** as commit `6efadcbd3c58c25767e52f2159ac2894cf775015` (parent `d1a1e3408cd3b3c8c19be195ddb13ba74b36207e`), fast-forward pushed `d1a1e34..6efadcb`, Vercel deployment confirmed successful, and the deployed HTML for all 7 pages confirmed via `curl` to already contain `style="visibility:hidden"` on `btn-signin` — the strongest available proof, since it doesn't depend on any DOM-timing race.

**Founder re-tested production and confirmed the flash is gone.** Using the same already-authenticated `ElPrimerInvestigador` session against the newly deployed SHA: both a normal refresh and a hard refresh (`Cmd+Shift+R`) showed **no** `"Sign in with URBANO"` at any point — the Auth area stayed hidden/blank while state resolved, then rendered directly to `"Hi, ElPrimerInvestigador"` + `"Sign out"`. **The residual first-paint flash defect is `PRODUCTION_PROVEN_FIXED`** — the first defect in this entire Auth Restoration arc actually reproduced live by the Founder, then closed and re-verified live by the Founder, rather than only locally or structurally.

**Zero automatic consequence, reconfirmed after this second deployment**: `gaming_members` still exactly 1 row (no duplicate), `authority_grants` = 0, `admin_audit_events` = 0, `gaming_xp_events`/`gaming_xp_rules`/`gaming_category_participation_policy` = 0, `gaming_admins` still present (`0125` unapplied). **PLATFORM GOVERNANCE NOT ACTIVATED. GAMING XP NOT ACTIVATED.**

**Returning-user (Magic Link) OTP branch and the fully-fresh-Incognito test remain open, non-blocking evidence items** — neither exercised by this or the prior gate, neither required to close the first-paint defect.

Full production route regression (14 routes, including all 7 Auth-control surfaces plus `/host.html`, `/participant.html`, `/poker-host.html`, `/poker-table.html`, and the three `/api/gaming/*` endpoints exercised earlier in this arc) confirmed healthy. Final regression after this second production proving: **641/641** behavioral, **144/144** contract, clean typecheck and build.

**The two-step correction history is preserved deliberately, not compressed.** The JS-only fix was a genuine, reasonable first attempt that reduced the defect and fixed the local/failure-path cases it was actually tested against — it was not a wrong idea, just an insufficient one, discovered only by real Founder production evidence rather than by any local test this repository could construct. Both steps, and the evidence that moved between them, are recorded here as the actual engineering history.
