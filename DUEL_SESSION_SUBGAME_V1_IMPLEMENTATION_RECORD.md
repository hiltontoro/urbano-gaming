# Duel / SESSION_SUBGAME v1
## Implementation Record

## 1. Canonical dependency

This gate implements `Product/Duel_Architecture.md` (gera-os, `Projects/Urbano Gaming/Product/`), graduated in a prior gate this same session, and factually corrected in that same prior gate to remove an inaccurate Timer claim (no Timer Modifier exists anywhere in this codebase; the corrected document specifies Host-triggered closure only, matching `closeSubmissions.ts`'s own established MVP discipline). This record documents implementation only; it does not restate the canonical document's own content.

## 2. Starting state

- `urbano-gaming` branch `integrate/join-session`, HEAD `bcd56ed813819520d8bd6c25b80b40e9077e0919`, three commits ahead of `origin/main` (`aece367e9bde88cc81478559a9837e70c4ae7cc6`): the Predictions A1 production-deployment record, the root-authority-RPC `service_role` restriction, and its own engineering-pattern documentation.
- Local migration ceiling `0126` at start; this gate adds `0127`–`0135`.
- Pre-existing, unrelated working-tree drift present before this gate began and preserved exactly throughout: modifications to `PROJECT_STATUS.md`, `QUIZ_EXPERIENCE_IMPLEMENTATION_RECORD.md`, `TRIVIA_GAME_COMPOSITION_IMPLEMENTATION_RECORD.md`; untracked `supabase/.gitignore`, `supabase/config.toml`, `supabase/templates/`. None of these were touched by this gate.
- Directly inspected before implementation began: `interaction_instances` has no participant-subset concept (it assumes the full Session roster) — confirming the readiness gate's own recommendation that Duel must be a structurally separate entity, not a two-participant Interaction Instance.
- Production untouched throughout — this gate is local-only; no production credential was used, no production RPC was called, no production row was read, written, or inspected.

## 3. Implementation model

Option A, Duel-specific vertical Slice, per the readiness gate's own recommendation and confirmed necessary by direct inspection (§2). Duel owns its own two tables (`duels`, `duel_responses`), its own four RPCs, its own command layer, and its own read-model fields on `GET_SESSION` — it never creates an `interaction_instances` row and is never mistaken for one. No generic `session_subgames` substrate, no generic minigame framework — this is the one concrete subgame this codebase has, built for exactly what it needs.

## 4. Migrations (0127–0135)

| # | Migration | Concern |
|---|---|---|
| 0127 | `add_duel_capability` | `set_session_capabilities_atomically` replacement — adds `'DUEL'` to the valid-key list, otherwise byte-for-byte identical to `0109` |
| 0128 | `create_duels` | New tables `duels` + `duel_responses`; unique partial index `duels_one_active_per_session` on `(session_id) where lifecycle_state = 'ACTIVE'`; check constraints preventing identical competitors and impossible terminal-state combinations, including that `WON_LOST` and `FORFEIT` both require a non-null winner (§13.C) |
| 0129 | `create_start_duel_atomically` | New RPC — START_DUEL, full precondition chain (host token, `LOBBY_LOCKED`, `DUEL` declared, distinct in-session competitors, current Interaction Instance `RESULT_REVEAL` or absent, no existing `ACTIVE` Duel), creates the Duel already `ACTIVE` |
| 0130 | `create_submit_duel_response_atomically` | New RPC — SUBMIT_DUEL_RESPONSE, participant-token authority only, upsert (last write wins) |
| 0131 | `create_resolve_duel_atomically` | New RPC — RESOLVE_DUEL, the deterministic mechanic-derived winner truth table (§6) |
| 0132 | `create_resolve_duel_exceptionally_atomically` | New RPC — RESOLVE_DUEL_EXCEPTIONALLY, Host authority tier (CANCELLED/VOID/FORFEIT_A/FORFEIT_B) |
| 0133 | `start_session_atomically_excludes_active_duel` | `start_session_atomically` replacement — adds an `ACTIVE_DUEL_EXISTS` guard, otherwise identical to `0111` |
| 0134 | `start_quiz_atomically_excludes_active_duel` | `start_quiz_atomically` replacement — same guard, otherwise identical to `0112` |
| 0135 | `complete_session_atomically_voids_active_duel` | `complete_session_atomically` replacement — voids an `ACTIVE` Duel inside the same transaction as Session completion, otherwise identical to `0013` |

All 9 applied cleanly on a from-scratch `supabase db reset --local`, twice (once mid-implementation, once as the final pre-acceptance check). Every `CREATE OR REPLACE` reproduces its predecessor's real, re-read source verbatim plus exactly the one intended change — following this engagement's own established discipline (§13 documents one early violation of this discipline, caught and corrected before it reached a migration file).

## 5. Mutual exclusion, enforced symmetrically

At most one `ACTIVE` Duel per Session: the schema-level partial unique index, backed by a `for update` existence check inside `start_duel_atomically` itself. No ordinary Interaction may start while a Duel is `ACTIVE` (`0133`/`0134`). No Duel may start while an ordinary Interaction exists and is not yet `RESULT_REVEAL` (`0129`) — mirroring `start_session_atomically`'s own pre-existing `PREVIOUS_INTERACTION_NOT_REVEALED` row-locking discipline exactly, applied symmetrically to the new relationship.

## 6. Proving mechanic — no Timer

`RESOLVE_DUEL` is Host-triggered only. No timer, no background job, no persisted deadline — the literal implementation of the canonical correction (§1). Deterministic winner truth table, precise about every named combination:

- both responded, exactly one correct → that competitor wins
- both responded, both correct → earlier `answered_at` wins; an exact tie is `DRAW`
- both responded, both wrong → `DRAW`
- exactly one responded, correct → that competitor wins (uncontested correct beats no answer)
- exactly one responded, wrong → `VOID`
- neither responded → `VOID`

Never fabricates a winner. `correct_option_index` is never returned by any public RPC or read-model field.

## 7. Exceptional resolution

One general command, `RESOLVE_DUEL_EXCEPTIONALLY` (`resolution ∈ {CANCELLED, VOID, FORFEIT_A, FORFEIT_B}`), per the readiness gate's own recommendation over three narrow commands. Reason mandatory only for a forfeit. Never callable against an already-`COMPLETED` Duel — a mechanic-derived or prior exceptional result is never silently overwritten. Correction/supersession of an already-terminal Duel is explicitly out of scope for v1.

## 8. Session-completion interaction

`COMPLETE_SESSION` is never blocked by an active Duel and voids it atomically inside the same transaction (`terminal_resolution = 'VOID'`, `winner_participant_id = null`, partial response history preserved unchanged). Host-controlled completion remains fully authoritative.

## 9. Read-model privacy

`DuelSummary` (distinct from the internal `DuelRecord`, never carries `correctOptionIndex`) exposes `myResponseOptionIndex` (always visible to the calling competitor, `null` otherwise) and `competitorAOptionIndex`/`competitorBOptionIndex` (`null` while `ACTIVE`, revealed to everyone once `COMPLETED`). Proven both at the repository-contract level and end-to-end over real HTTP in the operational simulation (§12, steps N/O/Q).

## 10. Scoring boundary

A Duel resolves with zero automatic Session-points effect. No points path was wired in v1 — Duel_Architecture.md authorizes optional, never-automatic Session-scoring integration, and none was implemented, matching this gate's own explicit non-goals.

## 11. Tests

- **Behavioral**: `__tests__/duel.test.ts` (new, 48 tests) — capability declaration, START_DUEL authorization/validation, mutual exclusion in both directions against every ordinary capability and against a second Duel, SUBMIT_DUEL_RESPONSE authorization/privacy/idempotency, every normal-resolution branch, every exceptional-resolution branch, re-resolution rejection, Session-completion voiding with partial-response preservation, the scoring boundary, and historical/successor-Session evidence. Added to `package.json`'s explicit `npm test` file list.
- One pre-existing test corrected, not newly broken: `sessionCapability.test.ts`'s negative test used `["DUEL"]` as a not-yet-existing-key placeholder; once `DUEL` became genuinely valid this assertion correctly began failing, and was fixed by switching the placeholder to a genuinely nonexistent key, preserving the test's original intent.
- **Total behavioral: 635/635**, confirmed on a from-scratch local reset, and again after the lock-ordering fix (§13).

## 12. Contract verification and operational simulation

- `__tests__/duelSupabaseRepository.contract.test.ts` (new, 15 tests) — schema reachability, FK/check-constraint enforcement, the `duels_one_active_per_session` unique index under genuine concurrency (two simultaneous START_DUELs), START_DUEL racing an ordinary START_SESSION, START_DUEL racing COMPLETE_SESSION, two simultaneous competitor submissions, deterministic resolution, and the resolve-vs-complete race (§13). Added to `package.json`'s `test:contract` list.
- **Total contract: 140/140** across all 11 files, confirmed on a from-scratch local reset, run five consecutive times on the Duel file specifically with zero flakiness after the lock-ordering fix in the implementation gate, then **10 further consecutive clean runs (15/15 each)** in the independent Final Local Acceptance gate, plus **15 standalone deadlock-repro-script runs with 0 deadlocks** (versus ~5 of 8 before the fix) — see §13.A.
- A 28-step operational simulation ran in the implementation gate, then was independently re-run and extended to **37 steps** in the Final Local Acceptance gate against a real local Next.js dev server (explicitly env-overridden to the local Supabase instance, independently confirmed via direct Postgres inspection that it was never touching production) and real local Postgres, over genuine HTTP: session creation, capability declaration (`[DUEL, OPEN_RESPONSE, VOTING]`), participant joins, lobby lock, an ordinary Interaction started and blocked from Duel start until `RESULT_REVEAL`, Duel started and blocking both an ordinary Interaction and a second Duel, both competitors submitting, a non-competitor rejected, pre-resolution privacy confirmed for both the Host and a competitor, normal resolution, post-resolution Session-wide reveal with no `correctOptionIndex` leak, the ordinary Interaction permitted again, a Voting Interaction started and completed cleanly after Duel resolution (proving the mutual-exclusion/parent-return boundary generalizes beyond `OPEN_RESPONSE`), a second Duel resolved exceptionally (`FORFEIT_A`), a third Duel left `ACTIVE` with a genuine partial response recorded, voided by `COMPLETE_SESSION` with that partial response preserved as historical evidence, full three-Duel history readable, the zero-automatic-points scoring boundary, a successor Session confirmed to inherit no Duel runtime or history, and Poker/Predictions regression checks confirming Duel introduced no unrelated breakage. **All 37 steps passed** on the independent re-run, after three genuine defects were found and fixed across both gates (§13).

## 13. Defects found and fixed

Three genuine defects were found through real concurrency testing, real end-to-end testing, and independent mechanical re-audit across two gates (the implementation gate, and the Final Local Acceptance gate that followed and independently re-verified it) — none was a pre-existing test assumption error; all three required an actual code change:

**A. Lock-order deadlock (Postgres `40P01`) between `resolve_duel_atomically`/`resolve_duel_exceptionally_atomically` and `complete_session_atomically`.** Found in the implementation gate. First surfaced as an intermittent contract-test failure (~2 of 3 concurrent runs), then confirmed with a standalone repro script outside the test framework. Root cause: `complete_session_atomically` locks `sessions` then `duels` (`for update`, in that order); the two resolve functions locked `duels` first and only plain-`SELECT`ed `sessions` — correct in isolation, but each function's own `insert into session_events` implicitly takes a `FOR KEY SHARE` lock on the parent `sessions` row (the FK from `session_events` to `sessions`), which — while already holding the `duels` lock — creates a lock-order inversion against `complete_session_atomically`'s own `sessions`-then-`duels` order. Classic deadlock cycle, not a race that merely picks a winner. Fixed by editing `0131` and `0132` directly (neither had been deployed anywhere, so the append-only-after-deployment rule does not apply) to lock `sessions` `for update` before `duels` `for update`, via a lightweight non-locking pre-read of `session_id` from `duels` (safe, since `duel_id`/`session_id` are immutable for a Duel row's lifetime) — establishing the same `sessions`-then-`duels` order used by every other Duel-touching function. Verified via 8 repro-script runs post-fix in the implementation gate (0 deadlocks, versus ~5 of 8 before) and 5 consecutive full contract-file runs (15/15 each); independently re-verified in the Final Local Acceptance gate with 10 further consecutive contract-file runs and 15 further standalone repro-script runs, all clean. The resulting behavior — a clean `DuelAlreadyResolvedError` for whichever side loses the row-lock race — is exactly what `0135`'s own migration comment always promised; the fix makes the promise true rather than changing it. The Final Local Acceptance gate also traced lock ordering across every remaining Duel-touching function (`start_duel_atomically`, `submit_duel_response_atomically`, `start_session_atomically`, `start_quiz_atomically`) to confirm no other lock-order inversion exists among them — `submit_duel_response_atomically` never touches `sessions` at all (no `session_events` insert), and every other function already locks `sessions` before `duels`, so no further risk was found.

**B. Missing HTTP error mapping for `ActiveDuelExistsError`.** Found in the implementation gate, during its own operational simulation: starting an ordinary Interaction while a Duel is `ACTIVE` correctly threw `ActiveDuelExistsError` at the repository layer, but neither `app/api/sessions/[identifier]/start/route.ts` nor `.../start-quiz/route.ts` had a branch for it, so it fell through to the generic 500 handler instead of the intended 409 — an internal error message leaking to the client instead of a clean domain rejection. Fixed by adding the import and a `409` branch to both routes, matching `duel/start/route.ts`'s own already-correct convention. Confirmed via `tsc --noEmit` and a full simulation re-run (28/28 passing); independently re-confirmed present and correct on disk in the Final Local Acceptance gate.

**C. Missing schema constraint on `FORFEIT` requiring a winner.** Found in the Final Local Acceptance gate's own independent schema audit, not carried over from the implementation gate's own report. `0128`'s check constraints enforced that `terminal_resolution = 'WON_LOST'` always requires a non-null `winner_participant_id`, but never applied the identical, equally-necessary constraint to `terminal_resolution = 'FORFEIT'` — even though `Duel_Architecture.md`'s own Lifecycle section defines forfeit as "a `COMPLETED` Duel resolved with a winner determined by absence rather than performance," i.e. a winner is just as mandatory for `FORFEIT` as for `WON_LOST`. In practice `resolve_duel_exceptionally_atomically` always computes a winner for `FORFEIT_A`/`FORFEIT_B`, so no bad row was ever actually produced — but the schema-level defense-in-depth this repository's own migration comments explicitly call out as the preferred discipline ("constraint-backed invariants over app-only checks wherever the invariant is cheap to express this way," `0128`'s own comment, about the sibling competitor-distinctness constraint) was silently absent for this one case. Fixed by editing `0128` directly (still fully uncommitted, so no append-only concern) to change `check (terminal_resolution <> 'WON_LOST' or winner_participant_id is not null)` to `check (terminal_resolution not in ('WON_LOST', 'FORFEIT') or winner_participant_id is not null)`. Verified live against the local database both before (constraint absent) and after (constraint present, `duels_check4` in `\d duels`) the fix, then confirmed the full local validation gate (behavioral, contract, isolated reruns, `tsc`, `build`) still passes unchanged after adding it.

No other defects found. All three fixes were verified with the full local validation gate re-run afterward (§14), not merely the specific failing case.

## 14. Full local validation gate

Run in full, in order, on a from-scratch local reset, twice: once in the implementation gate after fixes A and B, once more in the Final Local Acceptance gate after fix C (§13):

- `supabase db reset --local` — migrations `0127`–`0135` applied cleanly both times.
- Full behavioral suite: **635/635**, both times.
- Full contract suite: **140/140** across 11 files, both times.
- Isolated reruns (no cross-file leakage): `duel.test.ts` 48/48; `duelSupabaseRepository.contract.test.ts` 15/15; `sessionCapability.test.ts` 46/46; `poker.test.ts` + `pokerGameplay.test.ts` 56/56; `predictions.test.ts` + `persistentMetagame.test.ts` 130/130.
- `tsc --noEmit`: clean, both times.
- `npm run build`: clean, both times — all four Duel routes registered (`duel/start`, `duel/respond`, `duel/resolve`, `duel/resolve-exceptionally`).
- `git diff --check`: clean, both times.
- Credential/secret scan across every new and modified file: clean, both times. No hardcoded local demo key leaked into any tracked source file.
- `PROJECT_STATUS.md`'s pre-existing modified status independently re-confirmed twice as unrelated, pre-dating this gate's own work (a pure 24-line addition, timestamped before Duel implementation began) — preserved untouched throughout.

## 14a. Independent re-verification (Final Local Acceptance gate)

This gate did not trust the implementation gate's own report on its word. Independently re-performed, fresh:

- Re-read `Product/Duel_Architecture.md`, `Product/Session_Capability_Architecture.md`, and ADR-036 in full at the exact canonical commit named (`b407d6470358242261deeeb9d0ebf043b99907d3`), confirmed as `gera-os`'s actual current HEAD, not merely cited from memory.
- Mechanically `diff`ed every `CREATE OR REPLACE` migration (`0127`, `0133`, `0134`, `0135`) against its true immediately-prior source (`0109`, `0111`, `0112`, and the real last-prior definition of `complete_session_atomically`, confirmed to be `0013` by checking every migration file that mentions the function name for an intervening redefinition) — each diff showed exactly the claimed single change and nothing else.
- Re-read `0128`, `0129`, `0130`, `0131`, `0132` fresh in full (not from memory), which is how fix C (§13.C) was found.
- Re-read the `GET_SESSION` privacy-enforcement code and the mutual-exclusion guard placements in `InMemorySessionRepository` directly, confirming both the guard ordering and the `callingParticipant` resolution (host token never matches a `participantToken`, so `myResponseOptionIndex` is correctly `null` for the Host) at the source level, not only via passing tests.
- Confirmed the two HTTP-mapping fixes from §13.B are genuinely present on disk in both routes.
- Re-ran the full validation gate (§14) and the operational simulation from scratch, independently, after fix C — not merely re-stating the implementation gate's own prior totals.

## 15. API surface

Four routes, all thin (transport concerns only, logic lives in the command layer):

- `POST /api/sessions/[identifier]/duel/start` — host-authenticated via body `hostToken`.
- `POST /api/sessions/[identifier]/duel/respond` — participant-authenticated via `Authorization: Bearer`; `duelId` in the body (the URL `identifier` is unused, kept for route-family consistency).
- `POST /api/sessions/[identifier]/duel/resolve` — host-authenticated via body `hostToken` + body `duelId`.
- `POST /api/sessions/[identifier]/duel/resolve-exceptionally` — host-authenticated, body `hostToken`/`duelId`/`resolution`/optional `reason`.

`GET_SESSION` gained `activeDuel: DuelSummary | null` and `duelHistory: DuelSummary[]`, privacy-enforced per §9.

## 16. In-memory / Supabase parity

`InMemorySessionRepository` and `SupabaseSessionRepository` implement all 8 new interface methods (`startDuel`, `submitDuelResponse`, `resolveDuel`, `resolveDuelExceptionally`, `getDuelById`, `getActiveDuelForSession`, `getDuelsForSession`, `getDuelResponses`) with matching validation order and error semantics, proven by the same 48-test behavioral suite running unmodified against the in-memory implementation and the same invariants re-proven independently against live Postgres in the 15-test contract suite.

## 17. Explicit non-goals

Per this gate's own explicit boundary: no generic minigame framework, no Templates, no Level 33, no multiple concurrent subgames, no Team Duel, no tournament brackets, no Physical Competition, no Poker changes, no full Chess, no Gaming XP, no persistent Duel rating, no achievements, no prizes, no Admin Control Plane integration, no Platform Governance work, no Auth restoration, no Resend/DNS work. Migration `0125` was not applied to production and remains untouched by this gate (it is pre-existing local-only state from an earlier gate this session — see `ADMIN_CONTROL_PLANE_A0_IMPLEMENTATION_RECORD.md`/prior Predictions A1 production-deployment record). No UI of any kind — backend-first proving throughout, per this gate's own explicit deferral.

## 18. Deployment compatibility (analysis only — no deployment performed or authorized)

**`OLD_SOURCE_NEW_SCHEMA`**: inert for every function old source still calls unchanged (`set_session_capabilities_atomically`, `start_session_atomically`, `start_quiz_atomically`, `complete_session_atomically` all keep their exact pre-existing external signatures — every new behavior is either a new guard against a state old source cannot produce without also calling the new Duel RPCs, or a new internal side effect old source never observes). The four new RPCs (`start_duel_atomically`, `submit_duel_response_atomically`, `resolve_duel_atomically`, `resolve_duel_exceptionally_atomically`) and the two new tables are simply unreachable by old source, which has no code path that calls them.

**`NEW_SOURCE_OLD_SCHEMA`**: unsafe, as with every prior Slice in this engagement — new source's Duel command layer would fail immediately against a schema missing `duels`/`duel_responses` and the four new RPCs.

**Recommendation for a future deployment gate**: migrations-first-then-source, identical discipline to every prior Slice — this analysis does not authorize deployment, which remains explicitly out of scope for this gate.

## 19. Production-mutation confirmation

**None.** No production Supabase credential was used at any point in this gate. All migrations were applied only to the local Docker Postgres instance (`http://127.0.0.1:54421`); all contract tests, the deadlock repro script, and the operational simulation ran only against that same local instance, using the well-known local demo service-role key established throughout this engagement. The local Next.js dev server used for the operational simulation was started with `SUPABASE_URL`/`SUPABASE_SERVICE_ROLE_KEY` explicitly overridden to the local instance (shell-exported values take priority over `.env.local` in Next.js) — independently confirmed by querying local Postgres directly for a session created through the running server before proceeding with the rest of the simulation.

## 20. Git boundary

Per this gate's own explicit instruction: local implementation only. Nothing staged, committed, pushed, or deployed. All pre-existing unrelated working-tree drift (§2) preserved exactly. The full new/modified file set remains in the working tree, unstaged, for a separate future Final Local Acceptance + Commit gate.
