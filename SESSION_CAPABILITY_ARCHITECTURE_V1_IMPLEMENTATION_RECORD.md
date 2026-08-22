# Session Capability Architecture v1 — Implementation Record

Local implementation and local acceptance only. No production migration was applied, no production data was mutated, and no Duel/Level 33/Admin Control Plane/Chess/Poker work was begun. This record documents the bounded Session Capability v1 slice authorized by the Session Capability Architecture Implementation + Local Validation Gate, built directly on canonical `Product/Session_Capability_Architecture.md` and ADR-036 (`gera-os` commit `89f8e1c070a7bdd2cef0dbf268241b0b62e402c5`).

## 1. Canonical authority

- `Product/Session_Capability_Architecture.md` — capability snapshot semantics, the evidence-derived lock, the three composability classes, the Quiz/Trivia distinct-capability boundary, ad-hoc vs. orchestrated composition, completion/scoring non-ownership, successor/legacy semantics.
- ADR-036 — the one structural invariant: *a Session may activate only capabilities declared in its immutable capability snapshot.*

Both were re-verified to exist, at that exact commit, on branch `codex/tecnomovi-constitutional-books` in `gera-os`, before this implementation began. That commit was not moved, merged, cherry-picked, pushed, or rewritten by this Slice.

## 2. The empty-capability-at-first-join edge case — resolved before implementation

Pressure-tested per the gate's own instruction, three options:

- **A** — allow first join with `declared_capabilities = '{}'`, permanently producing a locked, zero-capability Session.
- **B** — reject the first real participant join until at least one valid capability has been declared.
- **C** — another interpretation.

**B was selected.** This is the direct analogue of `upsert_prediction_atomically_requires_classification` (0084): a Match must have a declared `activity_classification` before it will accept its first real evidence-creating action (a Prediction); the identical shape applies here — a Session must have declared at least one capability before it will accept its first evidence-creating action (a real participant join). Allowing evidence to attach to an undeclared/empty snapshot would either permanently lock a Session into uselessness (discoverable only much later) or silently treat "not yet configured" as equivalent to "intentionally declared empty" — both wrong. Enforced server-side and atomically inside `join_participant_atomically` itself (0110), not as a client-side or domain-layer-only check.

Applied **uniformly to every Session, including `LEGACY_UNDECLARED` rows** — no special-casing branch. A legacy Session that already has real historical participants is unaffected (the check only runs before a *new* insert); a legacy Session with zero participants so far is treated exactly like any other undeclared Session. This is the smaller, more truthful implementation: one check, one meaning, no exceptions.

## 3. Product capability keys

Exactly the four canonical keys: `OPEN_RESPONSE`, `VOTING`, `TRIVIA`, `QUIZ`. `MULTIPLE_CHOICE` is never exposed as a capability — it is validated as an *invalid* key by `set_session_capabilities_atomically`, proven by a dedicated test (both in-memory and live-Postgres).

## 4. Capability registry

**Option B — one small, code-owned constant** (`SESSION_CAPABILITY_KEYS` in `inMemorySessionRepository.ts`, and the equivalent literal `in ('OPEN_RESPONSE', 'VOTING', 'TRIVIA', 'QUIZ')` check inside `set_session_capabilities_atomically`), not a persisted table. Nothing in this slice needs live, deploy-free toggling. No plugin framework, no speculative participant-topology/privacy/scoring/`availability_status` metadata field was added beyond the bare key validation — those remain deferred exactly as the canonical document specifies, until real `SESSION_SUBGAME` requirements justify them.

## 5. Persisted representation

`sessions.declared_capabilities text[] null` (0108) — directly precedented by `experience_summaries.correct_dimension_keys text[]` (0095), a real, already-shipped small-bounded-string-array fact column.

- `NULL` = `LEGACY_UNDECLARED` (a pre-migration row).
- `'{}'` = a post-migration Session, freshly created, not yet declared (or deliberately locked-in-empty).
- non-empty = the declared, canonically sorted, deduplicated set.

**No separate lock-marker column.** Lock state is derived live, every time, from `exists(select 1 from participants where session_id = ...)` — the identical evidence-derivation discipline `set_match_activity_classification_atomically` and `set_match_xp_eligibility_atomically` already established. The read model (`GET_SESSION`'s `capabilitiesLocked`) computes this from the very same `participants` list `getSession.ts` already fetches for every other purpose — one source of truth, not a second one.

## 6. Session creation

`CREATE_SESSION`'s own external contract is **completely unchanged** — still no request body, still zero required params. `create_session_atomically` (0113) was extended (`CREATE OR REPLACE`, no signature change) to explicitly assign `declared_capabilities = array[]::text[]` on every insert, since the column's own default (none) would otherwise leave every new Session indistinguishable from a true legacy row. A host declares real capabilities afterward, before first join, via the new `SET_SESSION_CAPABILITIES` command.

## 7. `SET_SESSION_CAPABILITIES` — the one new command

`app/api/sessions/[identifier]/capabilities/route.ts` → `lib/session/setSessionCapabilities.ts` → `SessionRepository.setSessionCapabilities` → `set_session_capabilities_atomically` (0109), modeled byte-for-byte on `set_match_activity_classification_atomically`'s locking discipline:

1. Validate every supplied key against the catalog (`INVALID_CAPABILITY_KEY` otherwise).
2. Normalize: dedupe + canonically sort (`array(select distinct unnest(...) order by 1)`) — order carries no Product meaning, and this normalization is what makes the locked-value comparison correct regardless of input order.
3. `select ... for update` on the `sessions` row.
4. If real participant evidence exists: same (normalized) value → idempotent success (`locked: true`); changed value → `CAPABILITIES_LOCKED`.
5. Otherwise: write, bump `updated_at`, persist a `SESSION_CAPABILITIES_DECLARED` `session_events` row (mirroring every other Session-mutating atomic function's own event-recording convention — added after noticing the first draft of 0109 omitted it).

Repeated pre-join updates (add, remove, clear to empty, re-add) are all legal — proving the real Product workflow: *"a host realizes before anyone joins they also want Voting."*

## 8. Concurrency — proven against real Postgres, not merely reasoned about

Because `join_participant_atomically` **already** takes `select ... from sessions where session_id = ... for update` before inserting a participant (confirmed by direct inspection of 0049, unchanged by this Slice), and `set_session_capabilities_atomically` takes the identical row lock, the two genuinely serialize against each other with **zero changes required** to the join path's own locking. This was not merely reasoned about — it was proven live: a dedicated contract test fires `joinParticipant` and `setSessionCapabilities` truly concurrently via `Promise.allSettled` against real Postgres, re-run three consecutive times with no flakiness, and asserts the invariant holds under both possible interleavings (join-wins → capability update correctly rejected as locked, capabilities unchanged; update-wins → capability update succeeds, join proceeds against the new, already-locked value). A second contract test proves two concurrent pre-lock capability updates serialize cleanly with no corrupted hybrid result.

## 9. Command-family enforcement — the exact matrix

| Command/route | Product capability required | Enforcement location |
|---|---|---|
| `/start` + `turnConfig.engineType = "OPEN_RESPONSE"` | `OPEN_RESPONSE` | `start_session_atomically` (0111) + domain fast-path (`startSession.ts`) |
| `/start` + `turnConfig.engineType = "VOTING"` | `VOTING` | same |
| `/start` + `turnConfig.engineType = "MULTIPLE_CHOICE"` (ad-hoc/Trivia path) | `TRIVIA` | same |
| `/start-quiz` | `QUIZ` | `start_quiz_atomically` (0112) |
| `/prepared-questions` | `QUIZ` **or** `TRIVIA` | domain fast-path (`prepareQuestions.ts`) + authoritative repository check (both backends) |
| `/submit`, `/cast-vote`, `/close-submissions`, `/reveal`, `/submit-quiz`, `/close-quiz` | none (new) | already gated transitively — these operate only on an Interaction Instance whose *creation* already passed the check above |
| `/lock`, `/complete`, `/join` | none (capability-independent) — except `/join`'s own, separate `SESSION_CAPABILITIES_NOT_DECLARED` precondition (§2) | n/a |

**Full reasoning history on `/prepared-questions`, preserved honestly rather than silently rewritten:**

1. The original implementation-readiness gate's own provisional enforcement matrix expected `/prepared-questions` to require `QUIZ`, alongside the rest of the "Quiz command family" (`prepareQuestions`, `startQuiz`, `submitQuizResponse`, `closeQuiz`).
2. During implementation, this was deliberately narrowed: `prepared_questions` rows were classified as content *authoring* (a draft, unconsumed until an activation command actually runs), drawing an analogy to Predictions' own "creating a Match is unrestricted; submitting a Prediction is gated by classification" boundary — so `/prepared-questions` was left **fully ungated**, and only `start_quiz_atomically` carried a guard.
3. A dedicated read-only deviation review then traced the *actual consumption graph* rather than trusting that analogy, and found it false: `prepared_questions.session_id` is a mandatory, cascade-deleting foreign key (0025) — this table is Session-owned configuration, not an independent, reusable content library the way Predictions' `teams`/`players` genuinely are. Leaving it ungated would let a Session declaring neither `QUIZ` nor `TRIVIA` (e.g. `[VOTING]`-only, even after capability lock) accumulate permanently dead, unreachable Quiz-shaped state via direct API use — undermining the capability snapshot's own claim to be a complete, authoritative statement of what the Session supports.
4. That same review also found the readiness gate's own original guess (`QUIZ` alone) would have been independently wrong: `start_session_atomically`'s ad-hoc `MULTIPLE_CHOICE` (Trivia) branch (0111) reads from the **exact same** `prepared_questions` table via `p_prepared_question_id` — proven directly by an already-passing test (`"TRIVIA-only: host-paced Multiple Choice via /start succeeds"`) that authors a prepared question on a `TRIVIA`-only, `QUIZ`-absent Session. Gating on `QUIZ` alone would have broken that legitimate, already-proven Trivia workflow.
5. The final, correct rule — implemented in this gate — is **`QUIZ` OR `TRIVIA`**: the union of every capability whose activation path can legitimately consume the resulting rows, determined by tracing real consumption rather than assumed from either capability's name.

Enforcement is applied at exactly **two** structurally independent SQL functions (never a shared helper, matching this schema's own established "each atomic function owns its full guard chain" convention) plus one JOIN-time precondition plus one non-atomic (matching this specific command's own pre-existing, documented no-concurrent-invariant design) authoring-time check — never scattered arbitrarily, and never a client-side-only boundary: dedicated tests call `repo.startSession(...)` and `repo.createPreparedQuestions(...)` directly, bypassing the domain layer entirely, and confirm the rejection still fires in both cases.

**Reusable Product principle derived from this correction**: pre-activation, capability-specific Session configuration must be authorized by the union of every declared capability whose activation path can legitimately consume it — never by an arbitrarily chosen single capability, and never left ungated merely because more than one capability might apply. This generalizes beyond Quiz/Trivia to any future capability with shared pre-runtime configuration.

## 10. Quiz and Trivia — proven structurally distinct, not merely by policy

`start_quiz_atomically`'s own Multiple Choice Interaction Instances are created exclusively inside that function — it never calls, and is never called by, `start_session_atomically`. Because the two capabilities are checked at genuinely separate call sites, the authorization layer never needs to inspect a resulting Interaction Instance's own `engine_type` after the fact to guess which capability produced it. Proven directly, both in-memory and against live Postgres: a `[QUIZ]`-only Session can prepare/start a Quiz but its ad-hoc `MULTIPLE_CHOICE` `/start` attempt is rejected; a `[TRIVIA]`-only Session can run ad-hoc `MULTIPLE_CHOICE` via `/start` but its `start-quiz` attempt is rejected. No Quiz-internal code was rewritten.

## 11. Mixed Session behavior

A `[QUIZ, VOTING, OPEN_RESPONSE]` Session runs all three sequentially (Quiz → close → Voting → reveal → Open Response), rejects the undeclared `TRIVIA` capability at any point, and remains `LOBBY_LOCKED` throughout — completion happens only via the pre-existing, unmodified, host-controlled `COMPLETE_SESSION` command. No completion-policy or scoring-policy concept was introduced. Proven both as an in-memory behavioral test and as the live operational simulation's own `L`–`S` sequence.

## 12. Read model

`GetSessionResult` gains `declaredCapabilities: string[]`, `capabilitiesLocked: boolean`, `legacyUndeclared: boolean` — all derived from data `getSession.ts` was already fetching (`session.declaredCapabilities`, the already-fetched `participants` array), adding zero new queries.

## 13. Legacy Sessions

Fresh read-only production count immediately before this implementation began: unchanged from the prior graduation gate's own findings (154 total Sessions, 76 `SESSION_COMPLETE`, zero `gaming_members` ever) — confirming none represents genuine end-user usage. All classified `LEGACY_UNDECLARED` (derived: `declared_capabilities IS NULL`) uniformly, per the canonical document. No historical row was backfilled, mutated, or granted any capability. Nothing here required production access — this Slice's own local implementation touches no production data at all.

## 14. Successor Sessions

`createSuccessorSession.ts`/`createSession.ts` both now construct their `SessionRecord` with `declaredCapabilities: []` explicitly — a successor **never** inherits the predecessor's declared set, matching `createSuccessorSession.ts`'s own pre-existing, unmodified comment ("participants, scores, and prepared questions are never copied"). Proven: a successor of a `[QUIZ, VOTING]` predecessor starts at `[]`; its own first join is rejected until the host declares its own capabilities.

## 15. Completion / scoring / XP — confirmed unaffected

`completeSession.ts` is byte-for-byte unmodified. `awardPoints.ts`, `point_awards`, `ParticipantStanding`, Segment allocation logic — all unmodified. `lib/gaming/metagame/` and `lib/gaming/predictions/` were not touched by any file in this Slice. Proven by a dedicated regression test exercising standings, Segment numbering, and `COMPLETE_SESSION` end-to-end on a capability-declared Session, plus the full 547-test pre-existing suite passing unmodified in fixture shape (declare-all-four is a fixture correction, not a behavior change — see §17).

## 16. Poker / Chess / Duel / Level 33 boundary

Poker's own type system (confirmed by direct inspection, unchanged this Slice) shares zero vocabulary with `SessionRecord` — nothing in this Slice could have touched it, and the operational simulation's own step `T` proves it live: table creation, two joins, and a deal, entirely independent of any capability declaration. No Chess, Duel, `SESSION_SUBGAME`, Template, or Admin Control Plane code was written.

## 17. Migrations (0108–0113)

| Migration | Change | Classification |
|---|---|---|
| `0108_add_declared_capabilities_to_sessions.sql` | `sessions` gains `declared_capabilities text[] null` | Additive column |
| `0109_create_set_session_capabilities_atomically.sql` | New function, mirrors `set_match_activity_classification_atomically`; persists a `SESSION_CAPABILITIES_DECLARED` event on real writes | New function |
| `0110_join_participant_atomically_requires_capabilities.sql` | Drop/recreate: one new precondition, mirrors `upsert_prediction_atomically_requires_classification` | Function replacement, external signature unchanged |
| `0111_start_session_atomically_capability_enforcement.sql` | Drop/recreate: one new early guard mapping `engineType` → required capability | Function replacement, external signature unchanged |
| `0112_start_quiz_atomically_capability_enforcement.sql` | Drop/recreate: one new early guard requiring `QUIZ` | Function replacement, external signature unchanged |
| `0113_create_session_atomically_declares_empty_capabilities.sql` | `CREATE OR REPLACE`: every new Session gets `declared_capabilities = '{}'` explicitly | Function replacement, external signature unchanged |

All six applied cleanly to local Postgres via `supabase db reset --local`, from a completely fresh reset, with zero SQL errors, verified three times during this Slice. No migration ≤`0107` was edited. No migration seeds any row, any Product capability value, or auto-declares any Session.

**The `/prepared-questions` authorization correction (§9) required no new migration** — confirmed directly, not assumed: `supabase db reset --local` was re-run after the correction and the ceiling remains `0113`. `sessions.declared_capabilities` (0108) already carried everything the corrected check needs; the fix is a repository-layer read-then-check-then-insert, consistent with `createPreparedQuestions`'s own pre-existing, documented non-atomic design (it already tolerated a comparable small race window for its own ordinal assignment, and now tolerates an equally small one for this capability read).

## 18. Predictions/Poker-style facts-vs-consequences boundary — not applicable, and confirmed not needed

Unlike XP Eligibility, this Slice introduces no separate "facts producer" vs. "consequence consumer" layers — capability authorization is a single, self-contained boundary owned entirely by the Session domain. No cross-boundary grep verification was required; confirmed by direct inspection that no file under `lib/gaming/` references `declaredCapabilities` or any of the new error classes, and no file under `lib/session/` references `gaming_xp_rules`, `gaming_category_participation_policy`, or any Predictions/Metagame vocabulary.

## 19. Tests

**Behavioral (in-memory), `npm test`: 553/553 passing across 24 files** (up from 507; +46 new tests, all in the new `__tests__/sessionCapability.test.ts`, added to `package.json`'s explicit test file list):

Creation/configuration (11), pre-join mutation (4), capability lock (5), the `JOIN_SESSION` precondition (3), command-family authorization — QUIZ/TRIVIA/VOTING/OPEN_RESPONSE positive and negative cases plus a direct-repository bypass-attempt proof (10), **prepared-question authorization — the `QUIZ`-or-`TRIVIA` union rule (6): rejection for `VOTING`-only and `OPEN_RESPONSE`-only, positive proof for `TRIVIA`-only (including consumption via ad-hoc `/start`), positive proof for `QUIZ`-only, the mixed `[TRIVIA, QUIZ]` shared-pool case (one row consumed ad-hoc, the remainder swept up by `start-quiz`), and a direct-repository bypass-attempt proof**, mixed-Session end-to-end (1), read model (3), successor semantics (2), and one existing-systems regression case (1).

**Fixture correction across 15 pre-existing behavioral test files** (identical philosophy to the XP Eligibility Slice's own documented fixture fix): every shared session-creation site gained `await setSessionCapabilities(repo, session.sessionId, session.hostToken, ["OPEN_RESPONSE", "VOTING", "TRIVIA", "QUIZ"])` — declaring all four capabilities, the truest fixture-equivalent of these tests' own pre-existing "this session can do anything" assumption. Two `createSuccessorSession` call sites that actually join a participant afterward (`segment.test.ts`, `triviaGameComposition.test.ts`) received the same fix; two that only inspect `successorSessionId`/`successorRoomCode` (`getSession.test.ts`) correctly did not, since they never join anyone. This is documented here explicitly, not silently: without it, all 209 initially-affected tests would have failed not from a regression, but because the new evidence-precondition correctly rejected every fixture join that had never previously needed to declare a capability at all.

**Contract (real local Postgres), `npm run test:contract`: 106/106 passing across 9 files** (up from 98; +8 new tests, all in `supabaseSessionRepository.contract.test.ts`), including a fresh full run after a from-scratch `supabase db reset --local`:

- Persistence round-trip (server-assigned empty set at creation, real declared-set write/read-back).
- Invalid-key rejection against a real round-trip.
- Legacy `NULL` distinction (a row force-set to `NULL` directly via `cleanupClient`, simulating the only real way such a row can exist).
- Atomic first-join lock (reject-then-declare-then-succeed-then-lock, end to end).
- **The genuine concurrency race** (§8) — the load-bearing proof this gate specifically required.
- Two concurrent pre-lock updates.
- QUIZ/TRIVIA command-family separation against real Postgres, including a real `startQuiz` success proving the declared capability itself works.
- Prepared-question authoring against real Postgres: rejected for a `VOTING`-only Session (zero rows persisted), allowed for `TRIVIA`-only, allowed for `QUIZ`-only.

**Fixture correction across 5 contract test files** (`gamingMemberSupabaseRepository`, `quizSupabaseRepository`, `segmentSupabaseRepository`, `supabaseSessionRepository`, `votingSupabaseRepository`) — the same declare-all-four pattern applied to each file's session-setup helper(s) or, in `gamingMemberSupabaseRepository.contract.test.ts`'s case (no shared helper), all three inline create+join sites individually.

## 20. Operational simulation (local only, real dev server, real Postgres)

Run against a `next dev` instance with Supabase credentials overridden at process start to the local stack, via direct HTTP calls (no browser — API-level proving, matching this Slice's own nature as a backend authorization layer with no UI change).

1. **Pre-step**: a freshly created, undeclared Session's first join attempt → `409 SESSION_CAPABILITIES_NOT_DECLARED`.
2. **A–G, single-purpose `[QUIZ]` Session**: create → declare → join → attempted capability change correctly `409 CAPABILITIES_LOCKED` → Quiz runs successfully → Voting attempt correctly `403 CapabilityNotAuthorized` (`"has not declared the VOTING capability"`) → `COMPLETE_SESSION` succeeds.
3. **H–K, renewal via successor**: create successor → declare fresh `[VOTING]` → join → Voting succeeds.
4. **L–S, mixed `[QUIZ, VOTING, OPEN_RESPONSE]` Session**: declare → join → Quiz runs and closes → Voting runs and reveals → Open Response runs → undeclared `TRIVIA` attempt correctly `403` → `COMPLETE_SESSION` succeeds.
5. **T, Poker independence**: table creation, two seat joins, and a deal, all succeeding identically to every prior gate's own Poker regression, with zero capability-declaration involvement anywhere in the flow.

**One real defect was caught and fixed live during this simulation, not silently worked around**: the `/join`, `/start`, and `/start-quiz` API routes' own `catch` blocks had no translation for the three new domain error classes (`SessionCapabilitiesNotDeclaredError`, `CapabilityNotAuthorizedError`), so the correctly-thrown domain errors were falling through to a generic `500 "Failed to ... "` response instead of the intended `409`/`403`. Fixed by adding the missing `instanceof` branches to all three routes (`409` for the join precondition, matching `LobbyNotOpenError`'s own precedent; `403` for capability-not-authorized, matching `HostTokenMismatchError`'s own precedent). Re-run after the fix: every step returned its correct, specific status code.

**Re-verified live after the `/prepared-questions` correction (§9)**: a fresh `next dev` instance, same local-stack override. `/prepared-questions` against a `[VOTING]`-only Session correctly returned `403 {"error":"This session has not declared the QUIZ or TRIVIA capability."}`; the identical call against `[TRIVIA]`-only and `[QUIZ]`-only Sessions both correctly returned `200` with the created question. The full A–T simulation sequence above was re-run in its entirety afterward and passed identically, confirming the correction introduced no regression anywhere else in the Slice.

## 21. Compatibility / deployment analysis (design only — no deployment performed or authorized)

**OLD_SOURCE_NEW_SCHEMA**: safe. Old source's `CREATE_SESSION` never references the new column; a session it creates gets `declared_capabilities = '{}'` (server-assigned by 0113) — a legitimate, fail-closed "undeclared" state old source has no way to advance past, since it has no capability-declaration UI. Old source's `JOIN_SESSION` calls would now be rejected server-side with `SESSION_CAPABILITIES_NOT_DECLARED` for every new Session — a real, deliberate behavior change on the new schema, not a silent one, and the correct one per §2's own reasoning.

**NEW_SOURCE_OLD_SCHEMA**: not safe to assume. New source's `SET_SESSION_CAPABILITIES` call fails outright (function not found) before `0109` exists. More importantly, new source's `/join`/`/start`/`/start-quiz` routes carry the new `instanceof` guard branches in application code already, but the underlying SQL guards (`0110`–`0112`) would not yet exist — meaning every Session would behave as if every capability were implicitly authorized (the pre-Slice universal behavior) until schema catches up. Recommend **migrations-first, then source** — the same twice-precedented ordering already used for Predictions v2 and XP Eligibility — which avoids this window entirely.

## 22. Explicit non-goals

Not done, not attempted, not implied by anything above:

- No Templates, no Experience Instance/Template schema.
- No Duel, no `SESSION_SUBGAME` state, spectator machinery, subgame lifecycle, or subgame result envelope.
- No Level 33 orchestration mechanics.
- No Admin Control Plane surface of any kind.
- No Chess implementation.
- No Poker modification — confirmed structurally impossible to have touched it, and confirmed live in the operational simulation.
- No completion-policy or scoring-policy schema change.
- No `host.html` modification — the entire Slice was proven via direct HTTP calls against the API layer; a future, separate UI slice must still add capability-selection, lock-state, and declared-set visibility to the host experience.
- No production migration, deployment, or data mutation of any kind.
- No `gera-os` commit was moved, merged, cherry-picked, pushed, or rewritten.

## 23. Production Deployment (2026-08-22)

A separate, later, explicitly-authorized gate (the "Production Deployment + Validation Gate") deployed this local implementation. This section documents that gate; it does not retroactively claim §22 above described a deployed state — its "no production migration, deployment, or data mutation" statement was accurate as of local acceptance and is preserved unedited as an honest historical record.

**Compatibility classification, sharpened during the readiness gate that preceded this deployment**: `OLD_SOURCE_NEW_SCHEMA` is bounded but not fully inert — beyond new Sessions being unable to onboard participants, any *existing* `declared_capabilities = NULL` Session whose host attempted `/start`/`/start-quiz`/`/prepared-questions` during the window would now fail with `CAPABILITY_NOT_AUTHORIZED`. `NEW_SOURCE_OLD_SCHEMA` is worse — new source's own domain-layer fast-paths reject `JOIN_SESSION`, `/start`, and `/prepared-questions` universally, for every Session, before ever reaching the RPC layer. Migrations-first-then-source was therefore not a formality but a real requirement, proven for this Slice specifically, not merely inherited from precedent.

**A. Locally proven before deployment**: everything in §1–§22 above, re-verified fresh immediately before this deployment — 553 behavioral and 106 contract tests, a from-scratch `supabase db reset --local` through `0113`, clean typecheck/build/diff-check.

**B. Production-deployed and directly validated, live, without manufacturing any Gaming Member:**
- Migrations `0108`–`0113` applied via `supabase db push --linked` (dry-run confirmed the exact 6-file inventory first, no seeds, no roles); production migration ceiling is now **`0113`**. `sessions.declared_capabilities` confirmed present; the three oldest production Sessions confirmed still `null` — no backfill.
- The `OLD_SOURCE_NEW_SCHEMA` checkpoint was verified live, not assumed: with schema already at `0113` and source still `9bd6e8e`, `POST /api/sessions` → `GET /api/sessions/:id` → `POST /complete` all succeeded cleanly against old source; Poker and the public Soccer Predictions/Global Leaderboard surfaces were unaffected.
- Commit `da36912f157a24587dea3595a3645875e8d51917` fast-forward pushed to `origin/main` (`9bd6e8e..da36912`); Vercel deployment confirmed successful via GitHub's own commit-status check for this exact SHA.
- The full Session Capability proving sequence ran live against production: an undeclared Session correctly rejected its first join (`409`); a singleton `[OPEN_RESPONSE]` Session locked on first join, rejected a changed-value redeclaration (`409`) while accepting an idempotent same-value one, and rejected undeclared `VOTING`/`TRIVIA`/`QUIZ` (`403` each); a `[QUIZ]`-only Session accepted prepared questions and a real Quiz run while rejecting ad-hoc Trivia; a `[TRIVIA]`-only Session ran ad-hoc Trivia while rejecting `start-quiz`; a `[TRIVIA, QUIZ]` Session proved the shared prepared-question pool live — one question consumed ad-hoc, the remaining two correctly swept up by `start-quiz`; a `[QUIZ, VOTING, OPEN_RESPONSE]` Session ran all three sequentially, rejected undeclared `TRIVIA`, and required explicit host completion (state-version arithmetic confirmed no child activity auto-completed the Session); a successor Session was confirmed to start with a fresh, empty declaration — its own first join rejected until it declared independently, with zero participants/scores/prepared-questions copied from its predecessor.
- Two pre-existing production Sessions (predating this deployment) were read directly: both confirmed `declared_capabilities: null`, and one's full historical `session_events` log (`SESSION_CREATED`, `PARTICIPANT_JOINED`, `LOBBY_LOCKED`, `INTERACTION_STARTED`, `VOTE_CAST`) was confirmed completely intact and untouched.
- Guest Poker (create→join×2→deal), the Soccer Predictions public surface, and `GET /api/gaming/leaderboard` were all reconfirmed unaffected post-deployment. `gaming_xp_rules`, `gaming_category_participation_policy`, and `gaming_xp_events` all remain at **zero rows** — this deployment does not activate Gaming XP. `GET /api/gaming/config` remains its identical, unchanged, pre-existing `500` — no Auth/SMTP dependency was introduced.

**C. Security/authority, reconfirmed against live production behavior**: capability declaration/mutation is reachable only via a host-token-authenticated call; the `/capabilities` route has no participant-token code path at all; direct repository-level bypass attempts (already proven in the local test suite on this exact deployed commit) and the live HTTP proving above both confirm server-side enforcement holds regardless of caller; `host.html` was never touched, so no UI state is or could be trusted for enforcement; capability declaration touches only `sessions.declared_capabilities`/`updated_at` and one `session_events` row, never historical Interaction/Evaluation/Vote/PointAward evidence — confirmed directly against the two legacy Sessions read above.

**D. Still pending, classified explicitly**: authenticated (Gaming-Member) Session flows remain untested in production, matching this repository's own standing, pre-existing, unrelated Auth/SMTP gap — not caused or worsened by this deployment. `host.html` UI work for capability selection remains a separate, future, un-scoped slice.

**E. Admin Control Plane downstream implication, reaffirmed post-deployment**: a future Admin A0 should be able to read the declared capability set, lock state, `LEGACY_UNDECLARED` classification, and `SESSION_CAPABILITIES_DECLARED` event history for any Session — the latter currently carries no acting-admin identity, a real gap for A0's own audit model to close, not this Slice's. Ordinary host capability selection remains fully independent of any future Admin Control Plane.
