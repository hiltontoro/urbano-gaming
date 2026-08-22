# URBANO Gaming — Project Status

> **Current-state correction — 2026-08-07:** UI Convergence Tier 1, Structural Tier 2, Experience Layer v1, subsequent host hierarchy refinements, and the URBANO Gaming identity migration are committed through `dafafb9`. Statements below that describe Tier 1 as uncommitted or Tier 2 as not started preserve the earlier handoff state and are superseded by this correction, `CLAUDE.md`, and `BOOTSTRAP_PACKAGE_Claude_URBANO_Gaming_Reentry_v1.0.md`.

## Current Stage

Nine vertical slices are implemented, tested, and live-verified against
production. UI Convergence Tier 1, Structural Tier 2, Experience Layer
v1, and subsequent host hierarchy refinements are also committed.

| Slice | What it delivered | Status |
|---|---|---|
| 001 — Session/Interaction separation | A Session runs any number of sequential interactions instead of exactly one | **Constitutionally accepted.** Historical event-time record at `../../../Level 33/History/Slices/Slice_001/`. |
| 002 — Scored Multi-Round Experience | A cross-engine, session-scoped point ledger and standings | **Constitutionally accepted.** Historical event-time record at `../../../Level 33/History/Slices/Slice_002/`. |
| 003 — Second Interaction Engine (Multiple Choice) | A second engine proving the generic-instance-plus-extension pattern | Implemented, tested, live-verified. `SLICE_003_REVIEW_PACKAGE.md` explicitly disclaims constitutional acceptance. No `History/Slices/Slice_003/` yet — deliberately deferred (governance artifact, not implementation artifact; see `HANDOFF.md`). |
| 004 — Passive Session Synchronization | Automatic host/participant sync, replacing manual "Check for updates" as the primary loop | Implemented, tested, live-verified on a real device in production. No formal constitutional acceptance ceremony; no `History/Slices/Slice_004/` yet. |
| 005 — Session Continuity | Rematches (linked successor sessions) and independent re-joining | Implemented, tested, live-verified on a real device in production. No formal constitutional acceptance ceremony; no `History/Slices/Slice_005/` yet. |
| 006 — Authoring Workspace | Create/Import/Review content authoring, engine-agnostic at the workspace level | Implemented, tested, live-verified in production, including a first-time-host UX pass. No formal constitutional acceptance ceremony; no `History/Slices/Slice_006/` yet. |
| 007 — Voting Engine (Proving Case) | A third Interaction Engine — host-authored or Open-Response-derived Candidates → Voting → derived `placement` → reveal, proving Candidate Resolution across an Interaction Instance boundary | **Accepted, closed, and applied to production** (checkpoint `3f17206`; Product architecture checkpoint `433b61e`). Implemented, tested (219 in-memory + 34 contract tests), validated against a local database-backed environment and a full browser operational simulation, then migrated to production (`0030`–`0034`) and verified live via an 18-step production smoke test. Same deliberate deferral as 003–006: no formal constitutional acceptance ceremony, no `History/Slices/Slice_007/`. See `SLICE_007_IMPLEMENTATION_RECORD.md`. |
| 008 — Segment / Turn Grouping | A real `Segment` object grouping one or more Interaction Instances under one stable member-facing Turn identity — proving the Best Joke case (Open Response, then Voting, same Turn) | **Accepted, closed, and applied to production** (checkpoint `e3b885e`). Implemented, tested (230 in-memory + 41 contract tests), validated against a local database-backed environment, an engineered concurrency proof of the underlying row-lock mechanism, and a full browser operational simulation, then migrated to production (`0035`–`0037`) and verified live via a full production Best Joke proving case (Segment/Turn persistence across an Open Response → Voting composition, a Multiple Choice regression, session completion, and rematch isolation). Same deliberate deferral as 003–007: no formal constitutional acceptance ceremony, no `History/Slices/Slice_008/`. See `SLICE_008_IMPLEMENTATION_RECORD.md`. |
| 009 — Engine Selection + PARTICIPANTS Voting | A discriminated `StartTurnConfig` and a unified host "Choose Turn Type" selector replacing accumulated flat parameters; `PARTICIPANTS` as a third Voting Candidate source (the session's own roster); structured, internal-only Candidate→participant attribution; founder-required self-vote prohibition; and a fix to a pre-existing (since Slice 007) manual-Award-control defect | **Accepted, closed, and applied to production** (checkpoint `75ccbe9`). Implemented, tested (242 in-memory + 47 contract tests), validated against a local database-backed environment and a full desktop **and mobile** browser operational simulation, then migrated to production in a founder-directed two-phase sequence (`0038`–`0039`, old-app compatibility verified live, source deployed, then `0040`) and verified live via PARTICIPANTS and SUBMISSION self-vote proving cases, HOST_AUTHORED/Award/Trivia/Segment regressions, session completion, rematch isolation, mobile production verification, and Application Shell regression. Same deliberate deferral as 003–008: no formal constitutional acceptance ceremony, no `History/Slices/Slice_009/`. See `SLICE_009_IMPLEMENTATION_RECORD.md`. |

The user has described everything through Slice 005 as "the current
production baseline" following a real multi-game playtest, and Slice
006 was separately implemented, deployed, and verified — but neither
of those is the same thing as the five-document constitutional
acceptance ceremony Slices 001 and 002 went through. Treat 003–006 as
**validated and running in production, not yet formally accepted.**
Reconstructing their `History/Slices/` folders is explicitly deferred
to a separate, later pass — see `HANDOFF.md`.

Slice 007 is **accepted, closed, and applied to production**, at the
same tier as 003–006. Its five new migrations (0030–0034) were first
verified against a local Postgres instance, then applied to the live
Supabase project and verified there directly (migration state,
`start_session_atomically`'s active signature, and empirically-confirmed
RLS/grant behavior on the two new tables) and via an 18-step production
smoke test covering both Candidate-source paths, vote casting and
revision, participant-specific isolation, tie ranking, session
completion, and rematch continuity. See `SLICE_007_IMPLEMENTATION_RECORD.md`'s
"Production Validation" section for the full evidence.

Slice 008 is **accepted, closed, and applied to production**, at the
same tier as 003–007. Its three new migrations (0035–0037) were first
verified against a local Postgres instance — including a full migration
rehearsal against representative pre-Slice-008 historical data, and an
engineered concurrency proof (two raw, separate Postgres connections)
of the parent Session-row lock that makes atomic Segment-ordinal
allocation safe — then applied to the live Supabase project and
verified there directly (backfill correctness, all constraints,
`start_session_atomically`'s new signature and default, and
empirically-confirmed RLS/grant behavior on the new `segments` table).
Old-application/new-schema compatibility was proven against real
production traffic before the accepted commit was deployed. Automatic
deployment was briefly affected by a one-time, post-ownership-transfer
Vercel production-domain binding gap (not a GitHub↔Vercel integration
defect); once corrected, the canonical URL was independently
re-verified to serve the accepted commit, and a full production Best
Joke proving case passed — Turn persistence across an Open
Response→Voting composition within one Segment, a Multiple Choice
regression, session completion, and rematch isolation. See
`SLICE_008_IMPLEMENTATION_RECORD.md` for the full evidence.

Slice 009 is **accepted, closed, and applied to production**, at the
same tier as 003–008. Its three new migrations (0038–0040) were first
verified against a local Postgres instance — including a full local
desktop and mobile browser operational simulation — then applied to
the live Supabase project in a deliberate two-phase sequence: `0038`
and `0039` first (additive, backward-compatible; verified live against
the still-deployed pre-Slice-009 application before any source push),
then the accepted commit pushed and its Vercel deployment independently
confirmed (byte-for-byte content-hash match plus a live behavioral
proof, since no direct Vercel dashboard access was available from this
session — the same situation as Slice 008), and only then `0040`
(introducing the new authoritative `SELF_VOTE_NOT_ALLOWED` error),
so the database rule and the client code able to translate it went
live together. This staged sequencing was a deployment compatibility
boundary discovered during production preflight, not a defect in
Slice 009's design. Verified live via real production proving cases
for both `PARTICIPANTS` and `SUBMISSION` self-vote rejection, every
other engine/regression path, session completion, rematch isolation,
a focused mobile production pass, and an Application Shell regression.
See `SLICE_009_IMPLEMENTATION_RECORD.md`'s "Production Validation"
section for the full evidence.

## Historical pending state — superseded

The following paragraph records the state before commits `d64ec46`,
`c52506a`, and `1099e51`; it is not the current backlog.

**UI Convergence, Tier 1** — the Constitutional Layer of a broader UI
Convergence effort (see `UI_CONVERGENCE_REVIEW.md` for the full review
and roadmap, `UI_CONVERGENCE_IMPLEMENTATION_RECORD.md` for exactly what
changed). Implemented and verified (`tsc`, full test suite, build, and
a live round-trip through a real game, all clean) but held uncommitted
pending this repository synchronization pass and a final constitutional
consistency check against the Brandbook.

Structural Tier 2 and Experience Layer v1 subsequently landed. Consult
`STRUCTURAL_TIER2_IMPLEMENTATION_RECORD.md` and Git history for current
evidence rather than treating this historical gate as active.

## Recommended next major capability

Following a platform-level review (`PLATFORM_CAPABILITY_REVIEW.md`),
**Experience Composition** — a real, named "Experience" concept
composing multiple Interaction Engines with a shared scoring/sequencing
model — was identified as the highest-leverage next capability, to be
built in the same effort as one genuinely different third Interaction
Engine (not another engine shaped like Open Response or Multiple
Choice). **This is a recommendation, not an authorization** — no
implementation work toward it has begun, and the user explicitly
paused to do UI Convergence first.

## Infrastructure

- Local development folder, git repository, and GitHub repository
  connected and synchronized.
- Production deployment: Vercel project `urbano-gaming-playtest`,
  aliased at `https://urbano-gaming-playtest.vercel.app`. The former Level 33 alias was retired under MIG-005. As of Slice 008,
  deployment is GitHub-integrated: an accepted commit pushed to `origin/main`
  triggers Vercel's automatic production deployment — manual `vercel --prod`
  and manual alias repointing are no longer the normal path, reserved
  only for diagnosing/repairing an actual automatic-deployment failure.
- Supabase project backing all persistence; all migrations through
  `0040` applied.

## Validation summary

- 192 in-memory/behavioral tests plus a separately gated live Supabase
  contract suite. The re-bootstrap corrected `npm test` so it now runs
  all 192 behavioral tests.
- `npx tsc --noEmit` and `npm run build`: clean.
- Every slice through 006 has been verified live against production,
  not only in-memory — including a real multi-game playtest with real
  participants for Slices through 005, and a dedicated first-time-host
  UX walkthrough for Slice 006.
- Slice 007 adds 27 in-memory tests (219 total) and 18 contract tests
  (34 total), and has been verified against a local database-backed
  Postgres environment (migrations 0030–0034 applied and confirmed)
  and a full browser operational simulation, then against production
  itself — migrations 0030–0034 applied to the live Supabase project
  and an 18-step production smoke test passed with no defects found —
  accepted, closed, and now live-verified like Slices 001–006.
- Slice 008 adds 11 in-memory tests (230 total) and 7 contract tests
  (41 total), and has been verified against a local database-backed
  Postgres environment (migrations 0035–0037 applied and confirmed,
  including a full historical-backfill rehearsal and an engineered
  concurrency proof of the row-lock allocation mechanism) and a full
  browser operational simulation, then against production itself —
  migrations 0035–0037 applied to the live Supabase project and a full
  Best Joke production proving case (Turn/Segment persistence across
  an Open Response→Voting composition, Multiple Choice regression,
  session completion, rematch isolation) passed with no defects
  found — accepted, closed, and now live-verified like Slices 001–007.
- Slice 009 adds 12 in-memory tests (242 total) and 6 contract tests
  (47 total), and has been verified against a local database-backed
  Postgres environment (migrations 0038–0040 applied and confirmed)
  and a full desktop **and mobile** browser operational simulation,
  then against production itself — migrations 0038–0040 applied to
  the live Supabase project in the two-phase sequence described above,
  and real production proving cases for PARTICIPANTS and SUBMISSION
  self-vote rejection, every other engine/regression path, session
  completion, rematch isolation, mobile production verification, and
  an Application Shell regression all passed with no defects found —
  accepted, closed, and now live-verified like Slices 001–008.

---

Prepared: ✅
Designed: ✅ (per-slice; Experience Composition designed at the
  capability level, not yet slice-designed)
Implemented: ✅ (Slices 001–009, UI Convergence Tier 1, Structural Tier
  2, Experience Layer v1, and host hierarchy refinements)
Integrated: ✅
Validated: ✅ (see Validation summary above)
Operational Simulation: Complete for every slice through 006, including
  live production playtests. Complete for Slice 007 against a local
  database-backed environment and browser session, and against
  production itself via an 18-step production smoke test. Complete for
  Slice 008 against a local database-backed environment (including a
  migration rehearsal and an engineered concurrency proof) and browser
  session, and against production itself via a full Best Joke
  production proving case. Complete for Slice 009 against a local
  database-backed environment and a full desktop **and mobile** browser
  session, and against production itself via PARTICIPANTS/SUBMISSION
  self-vote proving cases, full regression coverage, mobile production
  verification, and an Application Shell regression.
Architecture Review: Complete for Slice 001 (against
  `State_Architecture.md`); informal for 002–009 (design-review
  conversations, not a formal constitutional Architecture Review pass —
  Slice 008's own design went through three founder-directed review
  rounds, and Slice 009's through two, before implementation was
  authorized)
Constitutionally Accepted: Slices 001–002 only. 003–009 deliberately
  not yet reconstructed as constitutional history — see "Current Stage"
  above. Slices 007, 008, and 009 are founder-accepted and closed at
  the same tier as 003–006, which is a distinct question from
  constitutional acceptance — see their table rows above.

## Post-Slice-009 phases (2026-08-19 – 2026-08-20)

Four additional phases were implemented, locally validated, and — as of 2026-08-20 — deployed to production, beyond Slice 009's own scope:

| Phase | What it delivered | Status |
|---|---|---|
| Gaming Member Identity Foundation | `gaming_members`/`gaming_admins`, Supabase Auth (email OTP) integration, additive `participants.gaming_member_id` linkage, full Guest/member coexistence | **DEPLOYED. OTP PRODUCTION VALIDATION PENDING SMTP.** Guest gameplay confirmed unaffected in production. See `IDENTITY_FOUNDATION_IMPLEMENTATION_RECORD.md`. |
| Soccer Predictions | Roster-based prediction gameplay with geolocation-gated venue activations, four-dimension settlement, prize qualification, Gaming XP ledger | **DEPLOYED. LOCAL VALIDATION COMPLETE. PRODUCTION END-TO-END VALIDATION PENDING SMTP.** See `SOCCER_PREDICTIONS_IMPLEMENTATION_RECORD.md`. |
| Poker Foundation | Private-hand table/seat/hand foundation, authoritative server shuffle, hole-card privacy boundary | **DEPLOYED. PRODUCTION VALIDATED.** See `POKER_FOUNDATION_IMPLEMENTATION_RECORD.md`. |
| Poker Gameplay | Full session-scoped, non-wagering No-Limit Hold'em runtime — blinds, betting streets, all-in/side pots, showdown evaluation, chip-conserving payout, Next Hand | **DEPLOYED. PRODUCTION VALIDATED** via a real Host+3-Guest proving case (normal Hand, all-in/side-pot Hand, early-fold-win Hand, chip conservation, reconnect/idempotency, mobile 375×812). See `POKER_GAMEPLAY_IMPLEMENTATION_RECORD.md`. |

Production migration ceiling: **0081** (was 0044 before this deployment). Commit `f030558` fast-forward pushed to `origin/main` (`0d38b0f..f030558`) and live at `https://urbano-gaming-playtest.vercel.app`.

Existing Session engines (Open Response, Voting, Quiz): **PRODUCTION REGRESSION PASSED** — each run end-to-end directly against production post-deployment, no regression.

No SMTP configured; no Supabase Auth setting changed; no browser anon-key configured; no other card game begun; no Poker Gaming XP/rating begun; no generic Private Table Engine extracted.

## Persistent Metagame Phase 1 (2026-08-21)

| Phase | What it delivered | Status |
|---|---|---|
| Persistent Metagame Phase 1 | `experience_summaries`/`gaming_category_participation_policy`/`gaming_xp_rules`/`gaming_xp_events`, a canonical generalized Gaming XP ledger superseding the deprecated `gaming_progression_events`, Match Activity Classification (TRAINING/CASUAL/RANKED/OFFICIAL) as a Prediction precondition, and a corrected missing-policy boundary so absent XP configuration is a valid no-consequence state rather than a settlement failure | **DEPLOYED. SCHEMA/CODE FULLY VALIDATED. AUTHENTICATED PREDICTIONS SETTLEMENT PENDING SMTP/ANON-KEY.** See `PERSISTENT_METAGAME_PHASE1_IMPLEMENTATION_RECORD.md`'s "Production Deployment" section for full evidence. |

Production migration ceiling: **0092** (was 0081 before this deployment). Commit `2e3cf2f` fast-forward pushed to `origin/main` (`f030558..2e3cf2f`) and live at `https://urbano-gaming-playtest.vercel.app`, confirmed via GitHub's Vercel deployment-status check.

RLS on the four new Metagame tables was empirically proven, not assumed: a live anon-key `INSERT` attempt against `gaming_xp_events` was denied (`42501`), matching the identical denial reproduced against the pre-existing `gaming_members` table as a control.

Existing Session engines (Open Response, Quiz, Voting) and Guest Poker (create→join→deal): **PRODUCTION REGRESSION PASSED** — each run end-to-end directly against production post-deployment, no regression.

The classification gate (`MATCH_NOT_CLASSIFIED`) and the zero-XP-configuration boundary were proven live at the one point reachable without a real Gaming Member. **`SUPABASE_ANON_KEY` is not configured in production** (`GET /api/gaming/config` returns 500), so no real end-user can complete OTP sign-in and production holds zero Gaming Members — per explicit instruction, none was manufactured to work around this. The full authenticated Prediction→Evaluation→Summary→zero-XP settlement path and the correction case therefore remain genuinely unproven in production, classified pending Auth readiness, not assumed safe.

`gaming_category_participation_policy` and `gaming_xp_rules` remain at **zero rows** in production after this deployment: Phase 1 infrastructure is deployed; Gaming XP is not yet activated. No Product XP values, daily cap values, Global Leaderboard, Category Rating, or Achievements work was begun.

## Global Gaming XP Leaderboard (2026-08-21)

| Phase | What it delivered | Status |
|---|---|---|
| Global Gaming XP Leaderboard | `get_global_gaming_xp_leaderboard()` — a read-only SQL function computing competition-ranked, reversal-safe Global Gaming XP entirely server-side (aggregation and ranking never performed application-side, closing a proven PostgREST silent-truncation risk); `GET /api/gaming/leaderboard`, public and unauthenticated; the Global tab of `leaderboards.html` wired to it; the legacy Predictions-specific leaderboard retained unchanged with corrected, non-canonical documentation | **DEPLOYED. FULLY VALIDATED LIVE. GAMING XP NOT ACTIVATED.** See `GLOBAL_LEADERBOARD_IMPLEMENTATION_RECORD.md`'s "Production Deployment" section for full evidence. |

Production migration ceiling: **0093** (was 0092 before this deployment). Commit `bb5f71c` fast-forward pushed to `origin/main` (`2e3cf2f..bb5f71c`) and live at `https://urbano-gaming-playtest.vercel.app`, confirmed via GitHub's Vercel deployment-status check.

Live proving case, all confirmed directly against production: `GET /api/gaming/leaderboard` → `200`, `{"entries":[]}`, no `Authorization` header; `leaderboards.html`'s Global tab renders the honest "No rankings yet" state (screenshot-verified); "By Game" and "My Circles" confirmed still their original static placeholders (screenshot-verified); `/api/gaming/predictions/leaderboard` confirmed still live at its existing URL, unchanged behavior, not called by the new Global UI.

Existing-game regression, each run end-to-end directly against production post-deployment: Guest Session (Open Response), Guest Poker, Voting, and Quiz — **PRODUCTION REGRESSION PASSED**, no regression.

`gaming_xp_events`, `gaming_xp_rules`, `gaming_category_participation_policy`, and `gaming_members` all remain at **zero rows** in production after this deployment — none seeded or manufactured. Gaming XP infrastructure is deployed; the leaderboard is a truthful empty state, not a placeholder awaiting a fix; Gaming XP itself is not yet activated. No authenticated Predictions XP proving was performed. No Category Leaderboard, Achievement, Auth/SMTP, or other Product-value work was begun.

## Soccer Predictions v2 (2026-08-21)

| Phase | What it delivered | Status |
|---|---|---|
| Soccer Predictions v2 | Replaces the flattened `predicted_goal_minute` integer (which collided first-half-stoppage goals with unrelated ordinary minutes) with a structural `(regulation, stoppage)` pair; regulation-time-only settlement scope; own-goal asymmetric treatment; cancelled/abandoned-Match settlement prohibition; a minimal `correct_dimension_count`/`correct_dimension_keys[]` Experience Summary contract extension; a new `official_goal_events` boundary constraint closing a related data-entry defect found during the acceptance audit | **DEPLOYED. SCHEMA/RPC DIRECTLY VALIDATED LIVE. AUTHENTICATED v2 SETTLEMENT PENDING AUTH/SMTP.** See `SOCCER_PREDICTIONS_V2_IMPLEMENTATION_RECORD.md`'s "Production Deployment" section for full evidence. |

Production migration ceiling: **0100** (was 0093 before this deployment). Commit `27ac429` fast-forward pushed to `origin/main` (`bb5f71c..27ac429`) and live at `https://urbano-gaming-playtest.vercel.app`, confirmed via GitHub's Vercel deployment-status check.

This deployment is genuinely, not merely additively, schema/source-coupled: the old `upsert_prediction_atomically` signature and the old `predicted_goal_minute` column were both replaced, not extended. That incompatibility window (migrations-applied, old source still live) was real and is documented, not softened — it was closed by pushing source immediately after confirming the migration state, and was operationally unreachable throughout regardless, since production held zero Gaming Members, zero Predictions, and zero Match/Result/Evaluation/Summary evidence, and `SUPABASE_ANON_KEY` remains unconfigured (`GET /api/gaming/config` → `500`), blocking both Gaming Member and Gaming Admin browser sign-in identically. No compatibility bridge was built; none was warranted.

Live proving, all confirmed directly against production without manufacturing any Gaming Member: the new Prediction column shape (`predicted_goal_minute_regulation`/`predicted_goal_minute_stoppage`) and the new Summary columns (`correct_dimension_count`/`correct_dimension_keys`) are present; the old `predicted_goal_minute` column is gone; the new `upsert_prediction_atomically` signature is live and the old one returns `PGRST202` (function not found); `finalize_match_result_atomically`/`correct_match_result_atomically` retain their unchanged external signatures and reach real domain logic; `record_experience_summary_atomically`'s two new parameters correctly default when omitted by an old-shaped caller. All four schema-level correctness invariants were proven with real (rejected, zero-persisted) write attempts: an out-of-range Prediction regulation minute, a non-boundary Prediction/official stoppage tuple, and a cardinality-inconsistent Summary dimension pair were each rejected by their respective live CHECK constraint by name; a large stoppage offset at a legal boundary was accepted (rejected only by an unrelated FK on the fabricated id), proving no ceiling exists on either side.

Existing-game regression, each run end-to-end directly against production post-deployment: Guest Open Response (create→join→lock→start→submit→close→reveal), Voting (create→join→lock→start→cast valid vote), Quiz (prepare→lock→start-quiz→submit→close), and Guest Poker (create→join×2→deal) — **PRODUCTION REGRESSION PASSED**, no regression.

`gaming_category_participation_policy`, `gaming_xp_rules`, `gaming_xp_events`, and `gaming_members` all remain at **zero rows** after this deployment — none seeded or manufactured; the Global Gaming XP Leaderboard remains honestly empty (`GET /api/gaming/leaderboard` → `{"entries":[]}`). Soccer Predictions v2 does not activate Gaming XP.

**Still pending, classified explicitly, not silently assumed safe:** the full authenticated v2 Prediction→Evaluation→Summary→correction path (ordinary `46` vs `45+1` submission, member recap rendering, `correct_dimension_count`/`correct_dimension_keys` on a real Summary, correction/supersession, zero-XP settlement, Prize Qualification independence) is already proven locally (behavioral + real-Postgres contract tests) but genuinely unproven in production, pending Auth/SMTP readiness — a pre-existing, unrelated operational gap this deployment did not touch and did not attempt to work around.

**Exact Scoreline remains a documented structural limitation, not a claimed guarantee:** `match_results.home_score`/`away_score` still carry no regulation-vs-extra-time provenance; the admin Result UI's score inputs still carry only generic "Home score"/"Away score" placeholders, with no explicit regulation-only instruction. This is an acceptable, pre-existing, unworsened limitation — a minimal clarification label is recommended as a small future follow-up, not implemented here.

## Soccer Predictions — XP Eligibility / Calibration Support (2026-08-22)

| Phase | What it delivered | Status |
|---|---|---|
| XP Eligibility / Calibration Support | `matches.xp_eligible` (nullable Match-level fact, mirroring `activity_classification`'s shape and evidence-locking discipline), `set_match_xp_eligibility_atomically`, a fail-closed `experience_summaries.xp_eligible` propagation, and one early consequence-processor guard producing zero XP for a non-eligible Summary regardless of configured policy/rules | **DEPLOYED. SCHEMA/RPC DIRECTLY VALIDATED LIVE. GAMING XP NOT ACTIVATED.** See `SOCCER_PREDICTIONS_XP_ELIGIBILITY_IMPLEMENTATION_RECORD.md`'s "Production Deployment" section for full evidence. |

Production migration ceiling: **0107** (was 0100 before this deployment). Commit `9bd6e8e` fast-forward pushed to `origin/main` (`27ac429..9bd6e8e`) and live at `https://urbano-gaming-playtest.vercel.app`, confirmed via GitHub's own Vercel deployment-status check for this exact commit SHA (`state: success`, "Deployment has completed").

Migrations-first ordering was used, matching the prior Soccer Predictions v2 deployment's own precedent. The resulting old-source/new-schema window (migrations applied, old source `27ac429` still live) was verified, not assumed: with the schema already at `0107`, the still-old, not-yet-replaced source's public Soccer Predictions surfaces, and all four Guest engines, were confirmed live and error-free before source was pushed; production held zero `matches`/`predictions`/`experience_summaries` rows throughout, so no real Match could have been silently created undeclared-eligible during the window. New-source/old-schema was avoided entirely by this ordering, closing the one concrete (if currently inert) transitional risk identified during readiness review — a caller-side named-parameter mismatch on the direct `record_experience_summary_atomically` RPC path, and a hard failure on `set_match_xp_eligibility_atomically`, had source been pushed first.

Live proving, confirmed directly against production without manufacturing any Gaming Member or Match: `matches.xp_eligible` and `experience_summaries.xp_eligible` both exist and are queryable; `set_match_xp_eligibility_atomically` reaches real domain validation (`MATCH_NOT_FOUND`) against a syntactically valid but nonexistent Match id; `record_experience_summary_atomically`'s new `p_xp_eligible` parameter resolves against the live function (proven by reaching the function's own `INVALID_ACTIVITY_CLASSIFICATION` validation rather than a parameter-resolution error); `finalize_match_result_atomically`/`correct_match_result_atomically` retain their unchanged two-parameter external signatures and reach real domain validation (`MATCH_RESULT_NOT_FOUND`). No XP policy/rule row and no real Match were created to prove any of this.

Existing-game regression, each run end-to-end directly against production post-deployment: Guest Open Response (create→join→lock→start→submit→close→reveal), Voting (create→join→lock→start→cast valid vote), Quiz (prepare→lock→start-quiz→submit→close), and Guest Poker (create→join×2→deal) — **PRODUCTION REGRESSION PASSED**, no regression. (One malformed request in the Voting proving script — a missing `promptText` on the VOTING `turnConfig`, corrected and re-run — was the API correctly rejecting an invalid client request, not a production defect.)

`gaming_xp_rules`, `gaming_category_participation_policy`, `gaming_xp_events`, and `matches` all remain at **zero rows** after this deployment — none seeded, no real Match declared XP-eligible, none manufactured; the Global Gaming XP Leaderboard remains honestly empty (`GET /api/gaming/leaderboard` → `{"entries":[]}`). This deployment installs calibration-support schema/RPC/guard capability only — **Gaming XP remains NOT ACTIVATED.** The activation boundary (a `gaming_xp_rules` PERFORMANCE row alone, or a `gaming_category_participation_policy` row together with a PARTICIPATION row) remains untouched.

**Still pending, classified explicitly, not silently assumed safe:** authenticated Match XP-eligibility administration through the normal admin UI, real authenticated Soccer Prediction submission, real eligible-vs-non-eligible Summary comparison, real XP event issuance, Global Leaderboard population, and correction/reversal against real authenticated evidence all remain genuinely unproven in production, pending Auth/SMTP readiness (`SUPABASE_ANON_KEY` still unconfigured, `GET /api/gaming/config` → `500`) — the same pre-existing, unrelated operational gap already documented for Soccer Predictions v2 and Persistent Metagame Phase 1, not caused or worsened by this deployment.

**Admin Control Plane downstream implication, recorded not implemented:** `matches.xp_eligible` declaration is a consequential-finalizer administrative action (evidence-locked once real gameplay begins, like Activity Classification, though it configures no Product XP value itself). A future Admin Control Plane A0/A1 must eventually preserve, at minimum, acting admin identity, declaration timestamp, the Match, old/new value, success/failure, and lock status/reason if rejected — none of which the current schema captures (deliberately, for this test/fixture-seam-scoped Slice). No audit infrastructure was added in this deployment.

## Session Capability Architecture v1 (2026-08-22)

| Phase | What it delivered | Status |
|---|---|---|
| Session Capability Architecture v1 | A Session now declares an evidence-locked gameplay-capability snapshot (`OPEN_RESPONSE`, `VOTING`, `TRIVIA`, `QUIZ`) up front; `join_participant_atomically` fail-closes on an undeclared Session; `start_session_atomically`/`start_quiz_atomically` each require the specific capability their activation path needs; `/prepared-questions` requires `QUIZ` **or** `TRIVIA`, reflecting the shared, Session-owned prepared-question pool consumed by both activation paths | **DEPLOYED. SCHEMA/RPC/HTTP DIRECTLY VALIDATED LIVE. GAMING XP NOT ACTIVATED.** See `SESSION_CAPABILITY_ARCHITECTURE_V1_IMPLEMENTATION_RECORD.md`'s "Production Deployment" section for full evidence. |

Production migration ceiling: **0113** (was 0107 before this deployment). Commit `da36912` fast-forward pushed to `origin/main` (`9bd6e8e..da36912`) and live at `https://urbano-gaming-playtest.vercel.app`, confirmed via GitHub's own Vercel deployment-status check for this exact commit SHA (`state: success`, "Deployment has completed").

Migrations-first ordering was used, matching every prior deployment's own precedent, and was proven a real requirement rather than a formality: `NEW_SOURCE_OLD_SCHEMA` would have rejected `JOIN_SESSION`, `/start`, and `/prepared-questions` platform-wide, for every Session, before ever reaching the RPC layer, since the new source's own domain-layer fast-paths check `declaredCapabilities` first. The resulting `OLD_SOURCE_NEW_SCHEMA` window (migrations applied, old source `9bd6e8e` still live) was verified live, not assumed: with schema already at `0113`, a full create→get→complete Session cycle succeeded cleanly against old source, and Poker/Predictions/Leaderboard were unaffected throughout.

Live proving, confirmed directly against production without manufacturing any Gaming Member: an undeclared Session correctly rejected its first join; a singleton `[OPEN_RESPONSE]` Session locked on first join, rejected a changed-value capability redeclaration while accepting an idempotent same-value one, and rejected every undeclared command family; a `[QUIZ]`-only Session accepted prepared questions and a real Quiz run while rejecting ad-hoc Trivia; a `[TRIVIA]`-only Session ran ad-hoc Trivia while rejecting `start-quiz`; a `[TRIVIA, QUIZ]` Session proved the shared prepared-question pool live — one question consumed ad-hoc, the remainder correctly swept up by `start-quiz`; a `[QUIZ, VOTING, OPEN_RESPONSE]` Session ran all three sequentially, rejected undeclared `TRIVIA`, and required explicit host completion (no child activity auto-completed the Session); a successor Session started with a fresh, empty declaration, independent of its predecessor. Two pre-existing production Sessions were read directly and confirmed `declared_capabilities: null` with their full historical event log intact and untouched — no legacy row was backfilled.

Existing-game regression, each run end-to-end directly against production post-deployment: Guest Poker (create→join×2→deal), the Soccer Predictions public surface, and `GET /api/gaming/leaderboard` — **PRODUCTION REGRESSION PASSED**, no regression.

`gaming_xp_rules`, `gaming_category_participation_policy`, and `gaming_xp_events` all remain at **zero rows** after this deployment — this Slice does not activate Gaming XP. `GET /api/gaming/config` remains its identical, unchanged, pre-existing `500` — no Auth/SMTP dependency was introduced or touched.

**Still pending, classified explicitly, not silently assumed safe:** authenticated (Gaming-Member) Session flows remain genuinely unproven in production, pending Auth/SMTP readiness — the same pre-existing, unrelated operational gap already documented for every prior deployment in this engagement, not caused or worsened by this Slice. `host.html` UI work for capability selection remains a separate, future, un-scoped slice — no admin/host UI was touched.

**Admin Control Plane downstream implication, recorded not implemented:** a future Admin A0 should be able to read a Session's declared capability set, lock state, `LEGACY_UNDECLARED` classification, and `SESSION_CAPABILITIES_DECLARED` event history — the latter currently carries no acting-admin identity, a real gap for A0's own audit model to close, not this Slice's. No audit infrastructure was added in this deployment.
