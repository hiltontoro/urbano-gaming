# Ordinary Duel Session Scoring Slice 001
## Implementation Record

Local-only. Uncommitted at the time of this writing, per explicit instruction not to stage/commit/push/deploy. This record documents the Duel container's first Session-scoring integration, built on top of the already-deployed, already-Founder-accepted Duel / SESSION_SUBGAME v1 container, Multiple Choice proving mechanic, and Math Duel Slice 001 proving mechanic. It does not modify either mechanic's own competitive-outcome logic.

## 1. Product authority

Implements exactly the Founder-approved scoring policy from the "Founder Decision: Ordinary Duel Session Scoring" gate: WON_LOST → winner +10, loser 0; FORFEIT → non-forfeiting winner +10, forfeiter 0; DRAW → no award; CANCELLED → no award; VOID → no award. This is ordinary Session scoring — not a wager, not persistent-value, not Global XP, not Level 33. Duel's own competitive-outcome logic (Multiple Choice and Math Duel alike) is unmodified; only the Session-scoring *consequence* of an already-computed terminal result is new.

## 2. Schema

Five additive-only migrations (`0147`–`0151`). `duels.winner_points integer not null default 10 check (winner_points > 0)` — the Session-scoring configuration snapshot captured for a Duel instance, never an intrinsic universal property of "winning a Duel" (mirrors `prepared_questions.points_for_correct`'s own per-instance-configuration relationship to correctness). `point_awards.interaction_instance_id` relaxed from `NOT NULL` to nullable, paired with a new `point_awards.duel_id` FK and `check (num_nonnulls(interaction_instance_id, duel_id) = 1)` — a genuine schema gap found only on fresh re-verification during the Implementation Readiness gate: the original `NOT NULL` constraint made a Duel-sourced award structurally impossible to insert at all, since a Duel deliberately does not create an `interaction_instances` row (0128's own migration comment). `duel_id is not null` is now the direct, single-column provenance signal for "this award came from a Duel."

## 3. Host-authority boundary

**No RPC parameter or HTTP field exists for overriding `winner_points`.** `start_duel_atomically` and `start_math_duel_atomically`'s own INSERT column lists never mention `winner_points`, so every Duel gets the column default (10) unconditionally; `/api/sessions/[identifier]/duel/start` parses only named, specific body fields and never spreads the raw JSON body into the domain call, so a Host-supplied `winnerPoints` field would simply be ignored even if sent. This is a stricter design than the Implementation Readiness gate's own prior recommendation (a defaulted-but-present RPC parameter) — reconsidered during implementation as unnecessary speculative generality for a future orchestrator that is not yet authorized or built, consistent with this codebase's own established discipline against building a seam ahead of the evidence that requires it (0128's own migration comment states the identical principle for SESSION_SUBGAME extraction).

## 4. Award-insertion sites

`resolve_duel_atomically` (0149), `resolve_duel_exceptionally_atomically` (0150), and `submit_math_duel_answer_atomically` (0151) each gained exactly one conditional `insert into point_awards` inside the same transaction as their own existing terminal-state `update duels` — never a follow-up call. `resolve_duel_atomically` inserts only on `WON_LOST`; `resolve_duel_exceptionally_atomically` only on `FORFEIT` with a non-null winner; `submit_math_duel_answer_atomically`'s insert is unconditional inside its existing `if v_resolution is not null` branch, since Math Duel's own resolution logic never produces anything other than `WON_LOST` there (a genuine tie always continues into a new sudden-death round instead of resolving `DRAW`). `complete_session_atomically`'s existing VOID-the-active-Duel logic required zero changes — confirmed by direct re-reading, then proven by a dedicated regression test in each of the four test suites.

## 5. Idempotency — reconsidered during this gate

**Revised from the Implementation Readiness gate's own prior recommendation.** That gate proposed separate `duel-win:`/`duel-forfeit:` idempotency-key prefixes; direct pressure-testing during this gate found a single per-Duel namespace — `md5('duel-score:' || duel_id::text)::uuid`, shared by all three insertion sites — strictly stronger. A Duel has at most one authoritative scoring consequence, ever; collapsing the key to `duel_id` alone makes a second award for the same Duel a `unique(session_id, idempotency_key)` constraint violation regardless of which of the three RPCs attempts it, rather than relying only on the calling branches' own mutual exclusivity. Distinguishing a normal win from a forfeit win, if ever needed, remains recoverable via a join back to `duels.terminal_resolution` — the actual source of truth — rather than encoding it redundantly in the key.

## 6. Concurrency

Every insertion site reuses the exact `sessions`-then-`duels` `FOR UPDATE` lock order this codebase already proved deadlock-free (0131's own migration comment). No new locking was introduced — the award insert is additive within an already-serializing transaction. Nine named concurrency scenarios (both-competitors-answer race, normal-resolution-vs-Forfeit, normal-resolution-vs-`COMPLETE_SESSION`, duplicate/retried resolution calls, reconnect/polling reads) were reasoned through and then proven live against real Postgres — see §7 below.

## 7. Standings

`getSession.ts`'s standings computation (`lib/session/getSession.ts:253-264`) sums every `point_awards` row for a Session by participant with no source-specific branching — required zero code changes. Confirmed live: a Duel-sourced award and an Interaction-sourced award (both automatic and Host-manual) sum correctly into the same participant's standing, and a Duel's own winner can differ from the Session's eventual overall leader (proven both in-memory and against live Postgres).

## 8. UI result

One static line — `Winner: +10 points` — added to the Host's Duel setup card, above the Start Duel button, visible for both Multiple Choice and Math Duel mechanic selections. No input, no configuration control. Verified live in the browser at `http://localhost:3001/host.html` against the local Supabase stack.

## 9. Validation

677 pre-existing + 15 new behavioral tests (692/692, `npm test`), 159 pre-existing + 17 new Postgres contract tests (176/176, `npm run test:contract`, against the local Docker Supabase stack — never the linked production project), 5 repeated full runs of the concurrency-sensitive contract files with zero flakiness (250 total test executions), clean `tsc --noEmit`, clean `npm run build`. Live end-to-end proof: a real Math Duel started, forfeited, and resolved through the actual Host UI against local Postgres produced exactly one `point_awards` row (`participant_id` = the non-forfeiting competitor, `points = 10`, `duel_id` set, `interaction_instance_id` null), and the Host UI's own Standings panel updated from `0 / 0` to `10 / 0` — the direct closure of the Founder's original "Duel declares a winner but Session standings stay 0-0" finding.

## 10. Historical compatibility

`OLD_SOURCE_NEW_SCHEMA` holds: existing `point_awards` rows keep their already-non-null `interaction_instance_id` and get `duel_id = null` (the new column's default) automatically, already satisfying the new source-exclusivity constraint with no backfill. Existing completed `duels` rows receive `winner_points = 10` as an inert artifact of the `NOT NULL DEFAULT` backfill — never acted on, since the award-insert logic only ever runs at the moment of a *fresh* `ACTIVE → COMPLETED` transition, which every historical Duel row has already passed.

## 11. Scope boundary

No wagering, no persistent-value settlement, no Global XP, no Category Competitive State, no Level 33, no Governance, no Discovery activation, no Host-shell redesign, no change to either mechanic's own competitive-outcome computation. `0125_drop_gaming_admins.sql` was not touched; the deferred-migration relocate/dry-run/push/restore/MD5-verify procedure remains the applicable production-deployment mechanism whenever this Slice is authorized to deploy — not re-designed or executed in this gate.
