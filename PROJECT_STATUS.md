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

## Admin Control Plane A0 — Authority & Audit Foundation + First Consequential Integration (2026-08-22)

| Phase | What it delivered | Status |
|---|---|---|
| Admin Control Plane A0 | Three non-hierarchical platform authority classes (`OPERATIONAL`, `CONSEQUENTIAL_FINALIZER`, `PRODUCT_GOVERNANCE`), `authority_grants` persistence with multi-class support and history-preserving revocation, a guarded one-time Governance bootstrap, Governance-only grant/revoke, and a thin append-only `admin_audit_events` ledger. First consequential integration: Result finalization/correction now enforce Finalizer authority at the RPC layer, persist the acting Gaming Member (closing the actor-provenance gap ADR-037 named), and each write exactly one audit event; correction requires a non-empty reason | **DEPLOYED. SCHEMA/RPC/HTTP DIRECTLY VALIDATED LIVE. PLATFORM GOVERNANCE NOT YET ACTIVATED. GAMING XP NOT ACTIVATED.** See `ADMIN_CONTROL_PLANE_A0_IMPLEMENTATION_RECORD.md`'s "Production Deployment" section for full evidence. |

Production migration ceiling: **0121** (was 0113 before this deployment). Commit `1cb0f21` fast-forward pushed to `origin/main` (`da36912..1cb0f21`) and live at `https://urbano-gaming-playtest.vercel.app`, confirmed via GitHub's own Vercel deployment-status check for this exact commit SHA (`state: success`, "Deployment has completed").

Migrations-first ordering was used, matching every prior deployment's own precedent. The `OLD_SOURCE_NEW_SCHEMA` window was verified live, not assumed: with schema already at `0121`, an old-shaped 2-argument call to `correct_match_result_atomically` returned a clean `PGRST202` function-resolution failure (zero mutation), while the identical old-shaped call to `finalize_match_result_atomically` resolved correctly via its backward-compatible default parameter — exactly the asymmetric compatibility this Slice's own readiness analysis predicted, now confirmed with direct evidence.

Zero automatic authority activation, confirmed both immediately post-migration and again after the full regression sweep: `authority_grants` and `admin_audit_events` remained at zero rows throughout; `gaming_members`, `gaming_admins`, `match_results`, and every Gaming XP table remained at their pre-deployment zero. **PLATFORM GOVERNANCE NOT YET ACTIVATED** — no bootstrap was performed in this gate. Safe infrastructure proving (bootstrap/grant/revoke RPC reachability against nonexistent actors, all correctly rejected without creating any row) confirmed the guard chains live without fabricating any business evidence; real actor-provenance proving against a genuine Result remains pending, since none was fabricated to obtain it.

Full live regression, each run end-to-end directly against production post-deployment: Guest Open Response (create→declare capability→join→lock→start→submit→close→reveal→complete) — full cycle succeeded; Voting and Quiz capability declaration and route liveness confirmed; the Quiz/Trivia shared prepared-question pool proven live via an ad-hoc Trivia start reaching `PROMPT_ACTIVE`; Guest Poker (create→join×2→deal) — full cycle succeeded; Soccer Predictions public Match list and the Global Leaderboard both confirmed live and honestly empty — **PRODUCTION REGRESSION PASSED**, no regression.

`gaming_admins` remains unchanged at zero rows, all 14 existing Predictions admin routes remain on their legacy binary gate — Predictions A1 has not begun. `gaming_xp_rules`, `gaming_category_participation_policy`, and `gaming_xp_events` all remain at **zero rows** — this deployment does not activate Gaming XP. `GET /api/gaming/config` remains its identical, unchanged, pre-existing `500` — no Auth/SMTP dependency was introduced.

**Fail-closed operational consequence, intentional, not a defect:** because `authority_grants` remains empty, no one can currently exercise the new Consequential Finalizer check inside finalize/correct — every real attempt fails closed until a later, separately-authorized bootstrap+grant gate. This interrupts no legitimate workflow today, given zero real Gaming Members/Admins/Results exist and Auth/SMTP remains unconfigured.

**Still pending, classified explicitly:** Platform Governance bootstrap, the first real authority grant, and real Result actor-provenance proving against genuine business evidence all remain a separate, later, explicitly-authorized gate — deliberately not performed here, per this gate's own boundary distinguishing deployment capability from authority activation.

Final local validation, re-run after all production work: **581/581** behavioral, **119/119** contract, clean typecheck and build — identical to the pre-deployment baseline.

## Predictions A1 — Admin Authority Migration (schema `0124` + source, `gaming_admins` retirement deferred) (2026-08-23)

| Phase | What it delivered | Status |
|---|---|---|
| Predictions A1 | Migrates all 14 pre-existing Predictions admin routes from the legacy binary `requireGamingAdmin` gate onto Admin Control Plane A0's platform authority classes (`OPERATIONAL` / `CONSEQUENTIAL_FINALIZER`, pooled `requireAnyAdminAuthority` for reads); gives Activity Classification and XP Eligibility their own first-class, audited HTTP routes and actor-provenance RPCs, alongside Prize Redemption's; adds `DECLARE_ACTIVITY_CLASSIFICATION`, `DECLARE_XP_ELIGIBILITY`, `CONFIRM_PRIZE_REDEMPTION` to the audit vocabulary | **DEPLOYED THROUGH SCHEMA `0124` + SOURCE. `gaming_admins` RETIREMENT (MIGRATION `0125`) DEFERRED TO A SEPARATE, LATER CLEANUP GATE. PLATFORM GOVERNANCE NOT ACTIVATED. GAMING XP NOT ACTIVATED.** See `PREDICTIONS_A1_ADMIN_AUTHORITY_IMPLEMENTATION_RECORD.md` for full evidence. |

**Read this before touching migration `0125`.** Predictions A1 is fully deployed and complete at schema `0124` — the pending local migration file is not a sign of unfinished work. `gaming_admins` is dead legacy storage, read/written by nothing in the deployed source, retained physically only for rollback safety. `0125` is a separate, later, independently-authorized cleanup action, not a next step to simply push — see the cleanup-gate cross-reference below.

Production migration ceiling: **`0124`** (was `0121` before this deployment). Migration `0125_drop_gaming_admins.sql` was **deliberately withheld from this push** — the Supabase CLI was proven, empirically (a live `--dry-run` against production before this deployment), to have no bounded/target-version flag on either `db push` or `migration up`; it applies every pending migration file it finds. `0125` was temporarily relocated out of `supabase/migrations/` for the `db push --linked` step (dry-run confirmed exactly `0122`–`0124` pending, not `0125`), then restored to its original committed location immediately afterward — no edit, no renumbering, no manual migration-history bookkeeping. The commit itself was not restructured; only the deployment procedure was.

Commit `aece367` fast-forward pushed to `origin/main` (`1cb0f21..aece367`) and live at `https://urbano-gaming-playtest.vercel.app`, confirmed via GitHub's own Vercel deployment-status check for this exact commit SHA (`state: success`, "Deployment has completed"), corroborated live by both brand-new A1 routes (`activity-classification`, `xp-eligibility`) resolving with a 401 auth-required response rather than a 404 — decisive proof of new source, since neither route existed in old source at all.

`gaming_admins` **still physically exists in production** and remains **unapplied for its own drop** (`0125` not pushed). It is confirmed to carry **zero live runtime dependency**: a repository-wide search found zero references anywhere in active `app/`/`lib/` source, zero live test calls, and zero function/trigger/RLS body anywhere in migration history reads or writes it outside its own creation (`0048`) and drop (`0125`) — the deployed source (`aece367`) uses `authority_grants` exclusively for platform authority. Deferring the drop is **cleanup, not Product-critical**: A1's full admin-authority behavior is already delivered end-to-end by `0122`–`0124` plus source. The deferral is deliberate, for rollback safety — see below.

**Rollback posture, explicitly recorded:** with `gaming_admins` still present, rollback to `aece367` or any later deployment is safe (zero dependency); rollback to any pre-A1 deployment (`d0691bd` or earlier) also remains safe, precisely because the table it depends on has not yet been dropped. Applying `0125` later will narrow this rollback boundary — a genuine, not merely aesthetic, reason it is deferred to its own separate, later, explicitly-authorized cleanup gate rather than bundled into this one.

Zero automatic authority activation, confirmed both immediately post-migration and again after full regression: `authority_grants` and `admin_audit_events` remained at zero rows throughout; `gaming_members`, `matches`, `prize_qualifications`, and every Gaming XP table remained at their pre-deployment zero. **PLATFORM GOVERNANCE NOT ACTIVATED** — no bootstrap was performed. **GAMING XP NOT ACTIVATED** — no `gaming_xp_rules`, `gaming_category_participation_policy`, or `gaming_xp_events` row exists; the Global Leaderboard implementation was untouched by this Slice's diff.

Live proving performed without fabricating business evidence: all three modified/new RPCs (Activity Classification, XP Eligibility, Prize Redemption) confirmed to accept their new signatures against a nonexistent target, returning the application-level `MATCH_NOT_FOUND`/`PRIZE_QUALIFICATION_NOT_FOUND` exception rather than a PostgREST signature-mismatch error. Every admin route — new and migrated — correctly fails closed (401 without a bearer token; 403 for an authenticated caller without a matching grant, proven locally via real-bearer-token contract tests since production holds zero real Gaming Members). Real authenticated end-to-end proving (an actual Consequential Finalizer declaring Activity Classification, finalizing a Result, or redeeming a Qualification) remains genuinely pending Platform Governance activation and Auth/SMTP readiness — stated plainly, not treated as a defect.

Full live regression, each run end-to-end directly against production post-deployment: homepage, host/participant pages, `predictions-admin.html`, and `poker-host.html`/`poker-table.html` all healthy; public Predictions match list and Global Leaderboard both live and honestly empty; a nonexistent-session lookup returned a coherent auth-required response, not a crash — **PRODUCTION REGRESSION PASSED**, no regression. `GET /api/gaming/config` remains its identical, unchanged, pre-existing `500` — no Auth/SMTP dependency was introduced or touched.

Final local validation, re-run after all production work: **587/587** behavioral, **125/125** contract, clean typecheck and build.

**Cleanup-gate cross-reference, not designed or executed here.** A future, separately-authorized `gaming_admins` cleanup gate must independently re-verify, fresh, before applying `0125`: A1 source remains healthy in production; no runtime `gaming_admins` reference has reappeared anywhere in `app/`/`lib/`; pre-A1 Vercel rollback is no longer the desired emergency-recovery path (a deliberate operational decision, not an automatic consequence of time passing); and production remains free of any legacy `gaming_admins` population that would need migrating first. Only once all four hold may `0125` be considered for production. See `PREDICTIONS_A1_ADMIN_AUTHORITY_IMPLEMENTATION_RECORD.md`'s §20 for full evidence.

## Platform Governance — Root Authority RPC Privilege Hardening (2026-08-23)

| Phase | What it delivered | Status |
|---|---|---|
| Root Authority Hardening | Revokes `PUBLIC`/`anon`/`authenticated` EXECUTE on `bootstrap_governance_authority_atomically`, `grant_platform_authority_atomically`, `revoke_platform_authority_atomically` — inherited from this project's standing default-privilege rule, previously the same broad grant every function in the schema receives. `bootstrap` has no independent authority check by necessity (it establishes the first Governance actor when none exists), so its only prior protection was an emergent RLS posture this repository never declared or depended on | **DEPLOYED. `service_role` EXECUTION UNCHANGED. PLATFORM GOVERNANCE NOT ACTIVATED. GAMING XP NOT ACTIVATED.** Migration `0126`; no implementation record — see its own migration comment for full reasoning. |

Production migration ceiling: **`0126`** applied; **`0125` remains deliberately unapplied** (temporarily withheld from `supabase/migrations/` for this one push, MD5-verified byte-identical on restore — the same technique already proven for the A1 deployment). No source push, no Vercel deployment — the committed source (`aece367`, already live) has zero direct reference to any of these three RPCs anywhere in `app/` or `public/`; the only callers are `lib/gaming/authority/{bootstrap,grant,revoke}PlatformAuthority.ts`, always via the service-role-backed `SupabaseAuthorityRepository`.

Pre-hardening state confirmed via a fresh production schema dump before mutation: `anon`/`authenticated`/`service_role` all carried `GRANT ALL` on all three RPCs; `gaming_members`/`authority_grants`/`admin_audit_events` all `ENABLE ROW LEVEL SECURITY` with zero `CREATE POLICY` statements anywhere in the schema. Post-hardening state confirmed via a second fresh dump: all three functions now show `REVOKE ALL ... FROM PUBLIC` with `GRANT ALL ... TO service_role` only — no `anon`/`authenticated` grant line remains.

**Live proving against real production**, without fabricating any business evidence: `service_role` (the real production key) reached genuine domain validation on all three RPCs (`GAMING_MEMBER_NOT_FOUND` for bootstrap, `GOVERNANCE_AUTHORITY_REQUIRED` for grant/revoke) using harmless nonexistent UUIDs — never permission denied, confirming the trusted path is fully intact. `anon`/`authenticated` live HTTP proving against production could **not** be performed the same way: `SUPABASE_ANON_KEY` has never actually been obtained for this project (confirmed empty in `.env.local`, not merely undeployed), so no valid production anon-role credential exists to construct such a call with. Substituted with direct schema-catalog inspection (above), which is authoritative for what the privilege state actually permits; the identical migration was additionally proven with a real anon key and a real locally-issued `authenticated` bearer token against local Supabase, with clean `42501 permission denied` results on all three RPCs.

Zero mutation confirmed after every probe: `authority_grants` = 0, `admin_audit_events` = 0, `gaming_members` = 0, `gaming_admins` still present (unchanged, `0125` still unapplied). **PLATFORM GOVERNANCE NOT ACTIVATED.** **GAMING XP NOT ACTIVATED** — untouched by this migration.

Full live regression against production post-deployment: homepage, host/participant pages, `poker-host.html`/`poker-table.html` all healthy; public Predictions match list and Global Leaderboard both live and honestly empty; a nonexistent-session lookup and the A1 admin-route boundary both returned coherent 401 responses, not crashes — **PRODUCTION REGRESSION PASSED**, no regression. `GET /api/gaming/config` remains its identical, unchanged, pre-existing `500` — Auth restoration was not touched by this gate.

**Auth-restoration boundary, explicit.** Production is now safe to proceed to an Auth Restoration gate from the root-authority RPC privilege perspective — the anon key, once configured, can no longer reach any of these three RPCs at all, closing the exposure window before it opens rather than after.

**Root recovery, reconfirmed unchanged.** `service_role` still reaches bootstrap's real domain validation whenever zero active `PRODUCT_GOVERNANCE` grants exist — this hardening closes only the untrusted `anon`/`authenticated` path, not the trusted recovery path. Carrying forward **`ROOT_RECOVERY_DOCUMENTATION_PENDING`**: canonical documentation still doesn't explicitly name bootstrap-after-total-revocation as intentional emergency recovery. This does not block the hardening already deployed; it must be resolved before the first real Governance bootstrap event.

**Reusable engineering rule.** Any future `CREATE OR REPLACE`/drop-and-recreate of these three functions must reassert `REVOKE EXECUTE ... FROM PUBLIC, anon, authenticated` in the same migration — this project's standing default-privilege rule would otherwise silently restore the broad grant on the newly-created object. Recommended for a future `ENGINEERING_PATTERNS.md` entry; not authored in this gate.

Final local validation, re-run after all production work: **587/587** behavioral, **125/125** contract, clean typecheck and build.

## Duel / SESSION_SUBGAME v1 (2026-08-23)

| Phase | What it delivered | Status |
|---|---|---|
| Duel / SESSION_SUBGAME v1 | First concrete `SESSION_SUBGAME` (`Product/Duel_Architecture.md`, ADR-036) — a bounded two-competitor subgame with its own `duels`/`duel_responses` persistence, Host-triggered Multiple-Choice-style proving mechanic (no Timer), deterministic normal resolution, Host exceptional resolution (`CANCELLED`/`VOID`/`FORFEIT`), Session-completion voiding, symmetric mutual exclusion with ordinary Interactions proven under genuine Postgres concurrency, and a privacy-aware `GET_SESSION` read-model | **DEPLOYED. SCHEMA + SOURCE LIVE. BACKEND/API ONLY — NO DUEL UI. PLATFORM GOVERNANCE NOT ACTIVATED. GAMING XP NOT ACTIVATED.** See `DUEL_SESSION_SUBGAME_V1_IMPLEMENTATION_RECORD.md`'s §21 for full evidence. |

Migrations `0127`–`0135` applied via `supabase db push --linked`, with `0125` withheld from `supabase/migrations/` for the push (MD5-verified byte-identical on restore — the same technique already proven for the A1 and root-authority-hardening deployments). Production migration ceiling is now **`0135`**; **`0125` remains deliberately unapplied**. Commit `d4c97a4c7f69d5e2e746f472264b61667eaef532` fast-forward pushed to `origin/main` (`aece367..d4c97a4`) and confirmed live via GitHub's own Vercel deployment-status check for this exact SHA (`state: success`, "Deployment has completed").

**`OLD_SOURCE_NEW_SCHEMA` verified live, not assumed**, with old source (`aece367`) still deployed and schema already at `0135`: a full ordinary-Session lifecycle (create → declare capabilities → join → lock → `GET_SESSION` → Open Response → complete → successor) plus a Poker table creation all succeeded normally — `GET_SESSION` in particular returned a clean `200` with no Duel fields requested, confirming the new mutual-exclusion guards never fire against old source's own actions. `NEW_SOURCE_OLD_SCHEMA` was independently reproduced locally as unsafe beforehand (schema capped at `0126`, current source running: `GET_SESSION` returned a raw `500`, `PGRST205: table 'public.duels' not found`) — this is why migrations were applied strictly before the source push.

Bounded production Duel smoke test, controlled Guest-mode playtest evidence only (`gamingMemberId: null` throughout, participants named `*SmokeTest*`/`MutexTest*`): non-competitor submission rejected (`403`); pre-resolution privacy confirmed from three independent vantage points (competitor, non-competitor, Host — all saw `null` for the other competitor's answer, `correctOptionIndex` never present); normal resolution correctly picked the only-correct competitor and revealed both answers post-resolution; Voting started and completed cleanly immediately after Duel resolution; a second Duel resolved exceptionally via `FORFEIT_A`, correctly naming the non-forfeiting competitor as winner; a third Duel was left `ACTIVE` with one genuine partial response, then `COMPLETE_SESSION` voided it (`VOID`, no winner, reason recorded) while preserving that partial response as historical evidence; mutual-exclusion rejections (ordinary Interaction vs active Duel, second Duel vs active Duel) both returned clean `409`s, never a raw `500` — directly confirming the earlier `ActiveDuelExistsError` HTTP-mapping fix holds live in production.

Zero automatic consequence, confirmed by direct count before/after: `duels`/`duel_responses` went `0 → 3` (exactly the new test evidence); `gaming_members`, `authority_grants`, `admin_audit_events`, every Gaming XP table, `matches`, and `prize_qualifications` all remained at their pre-deployment zero throughout. **PLATFORM GOVERNANCE NOT ACTIVATED.** **GAMING XP NOT ACTIVATED.**

Full live regression: homepage, Predictions public match list, Global Leaderboard, and Poker table creation all confirmed healthy both before and after the source deployment — **PRODUCTION REGRESSION PASSED**. One incidental, unrelated observation: `GET /api/gaming/config` now returns `200` (previously a consistent, pre-existing `500` across every prior deployment gate) — confirmed not caused by this deployment (the route was not part of this diff) and consistent with `SUPABASE_ANON_KEY` now being set in the Vercel environment through some channel outside this gate's own scope; not investigated further, out of scope for Duel.

**Duel/Poker UI disposition, explicit.** This deployment is backend/API only — no Duel Host/Participant/Spectator UI exists yet, and Duel will not appear as a playable Experience in the main UI. This is expected, not a defect. Poker's own backend remains already production-validated; its absence from the main Experiences discovery surface remains a separate, already-understood UI/discovery integration gap, untouched here.

Final local validation, re-run after all production work: **635/635** behavioral, **140/140** contract, clean typecheck and build.

## Duel Mechanic Boundary — Narrow Backend Correction (2026-08-23)

| Phase | What it delivered | Status |
|---|---|---|
| Duel Mechanic Boundary correction | Founder clarification, graduated in `Product/Duel_Architecture.md` (gera-os `93be2a7`, "Duel Container vs. Mechanic"): Multiple Choice is one Duel mechanic, not the Product definition of Duel — `mechanic_key` now identifies it explicitly, `DuelRecord`/`DuelSummary` separate generic Duel facts from nested Multiple Choice facts | **DEPLOYED. SCHEMA + SOURCE LIVE. ONE MECHANIC (`MULTIPLE_CHOICE`) AUTHORIZED. NO SECOND MECHANIC. NO DUEL UI. PLATFORM GOVERNANCE NOT ACTIVATED. GAMING XP NOT ACTIVATED.** See `DUEL_SESSION_SUBGAME_V1_IMPLEMENTATION_RECORD.md`'s §23 for full evidence. |

Migration `0136` applied via `supabase db push --linked`, with `0125` withheld from `supabase/migrations/` for the push (MD5-verified byte-identical on restore — the same technique already proven for every prior deployment in this engagement). Production migration ceiling is now **`0136`**; **`0125` remains deliberately unapplied**. Commit `69522efe7d271e0a095aa4bffa61708ceb1b3b7f` fast-forward pushed to `origin/main` (`d4c97a4..69522ef`) and confirmed live via GitHub's own Vercel deployment-status check for this exact SHA.

All 4 pre-existing production Duel rows verified backfilled truthfully: every row now carries `mechanic_key = 'MULTIPLE_CHOICE'`, every other historical field (competitors, prompt, options, correct option, lifecycle, resolution, winner, reason, timestamps) byte-identical to before the migration. A live `CONNECT_FOUR` insert attempt was rejected by the `duels_mechanic_key_valid_values` check constraint — the single-mechanic vocabulary restriction is real and enforced, not merely documented.

**`OLD_SOURCE_NEW_SCHEMA` proven live in real production**, not only reproduced locally: with `d4c97a4` (pre-correction) still deployed, a full Duel lifecycle (start → both competitors submit → `GET_SESSION` → resolve → exceptional resolution → `COMPLETE_SESSION` while active) ran directly against production and succeeded at every step, correctly returning the old flat Duel JSON shape. `NEW_SOURCE_NEW_SCHEMA` compatibility-window closure then verified live: the same test Session's history, re-fetched with corrected source deployed, now shows `mechanicKey` and nested `multipleChoice` on every entry.

Bounded production Duel smoke test, controlled Guest-mode playtest evidence only (`gamingMemberId: null` throughout): non-competitor rejected (`403`); pre-resolution privacy confirmed from independent competitor and non-competitor views; normal resolution correct with `mechanicKey` retained through reveal; exceptional `FORFEIT_A` correctly named the non-forfeiting competitor winner; a third Duel's genuine partial response survived `COMPLETE_SESSION`-triggered `VOID`; all 3 history entries carried `mechanicKey: "MULTIPLE_CHOICE"`; standings stayed at `0` throughout.

Zero automatic consequence, confirmed by direct count before/after: `duels` went `4 → 10`, `duel_responses` `3 → 8` — exactly the sum of the old-source checkpoint's own test evidence plus the new smoke test's own evidence, nothing more. `gaming_members`, `authority_grants`, `admin_audit_events`, every Gaming XP table, `matches`, and `prize_qualifications` all remained at their pre-deployment zero throughout. **PLATFORM GOVERNANCE NOT ACTIVATED.** **GAMING XP NOT ACTIVATED.**

Full live regression: homepage, Poker table creation, Predictions public match list, Global Leaderboard, and `GET /api/gaming/config` all confirmed healthy — **PRODUCTION REGRESSION PASSED**.

**Duel UI disposition, unchanged and explicit.** This deployment remains backend/API only. The Experience Discovery / UI Integration track may now begin from a mechanic-aware backend — future UI must consume `mechanicKey` and mechanic-owned projections, never assume `Duel = prompt/options`.

**Context only, not implemented, not authorized by this deployment.** Informal Founder UI direction recorded for that future Experience Discovery / UI Integration track: Trivia → 🧠, Poker → 🃏, Duel → ⚔️, Soccer → ⚽, Puzzle → 🧩, Karaoke/Music → 🎤 / 🎵, Impersonator → 🕵️. That future gate should convert this into a consistent Experience/category iconography system rather than scattered one-off emoji choices — not designed here.

Final local validation, re-run after all production work: **641/641** behavioral, **144/144** contract, Duel contract suite re-run 3× clean, clean typecheck and build.
