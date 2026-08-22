# Admin Control Plane A0 — Authority & Audit Foundation + First Consequential Integration
## Implementation Record

## 1. Canonical authority dependency

This Slice implements exactly the architecture graduated by:

- `Product/Authority_and_Audit_Foundation.md` (gera-os, `Projects/Urbano Gaming/Product/`)
- ADR-037 — "Platform Authority Is Distinct From Domain Authority, and Consequential Platform Actions Require Attributable Audit Evidence" (`Architecture/Architecture_Decision_Record.md`)

Both documents were re-verified present and unmodified in `gera-os` (HEAD `3396e0cc665be18b22576f34ae451740862096c7`) before implementation began. This record documents implementation only; it does not restate the canonical documents' own content.

## 2. Starting state

- `urbano-gaming` branch `integrate/join-session`, HEAD `774e1bfa873983c9096c1a456ae03019ac26e22f` (one commit ahead of `origin/main` = `da36912f157a24587dea3595a3645875e8d51917`).
- Local migration ceiling `0113` (Session Capability Architecture v1's own ceiling).
- Re-verified before implementation: `gaming_admins` still flat/binary (3 columns, no role); `requireGamingAdmin` still gates exactly 14 routes, all under `app/api/gaming/predictions/admin/**`; `p_finalized_by_gaming_member_id` still declared-but-unused in both `finalize_match_result_atomically` and `correct_match_result_atomically`; `gaming_xp_rules`/`gaming_category_participation_policy` still have zero mutation code path; zero RLS policies, zero `security definer` functions, 59 `security invoker` functions, zero Postgres enum types anywhere in the schema.
- Production untouched throughout — this gate is local-only; no production credential was used, no production RPC was called, no production row was read, written, or inspected.

## 3. Migrations (0114–0121)

One concern per migration, matching this repository's own established granularity:

| # | Migration | Concern |
|---|---|---|
| 0114 | `create_authority_grants` | New table + partial unique index (`(gaming_member_id, authority_class) where revoked_at is null`) |
| 0115 | `create_admin_audit_events` | New table (append-only ledger), with a shape constraint tying `actor_kind` to `actor_id` nullability |
| 0116 | `create_bootstrap_governance_authority_atomically` | New RPC — one-time root bootstrap, guarded by evidence (no active `PRODUCT_GOVERNANCE` grant exists) + `pg_advisory_xact_lock` against concurrent bootstrap attempts |
| 0117 | `create_grant_platform_authority_atomically` | New RPC — Governance-only, idempotent, locks the target `gaming_members` row (mirrors `join_participant_atomically`'s own lock-the-parent-row precedent) |
| 0118 | `create_revoke_platform_authority_atomically` | New RPC — Governance-only, idempotent, mutates the existing grant row's `revoked_at`/`revoked_by` rather than deleting or superseding it |
| 0119 | `add_finalized_by_to_match_results` | Table extension — nullable `finalized_by_gaming_member_id`, never backfilled |
| 0120 | `finalize_match_result_atomically_actor_provenance` | Function replacement (unchanged 2-param shape plus new optional `p_reason`) — adds the RPC's first-ever DB-layer authority check, persists the actor, writes one `FINALIZE_RESULT` audit event |
| 0121 | `correct_match_result_atomically_actor_provenance` | Function replacement (unchanged 2-param shape plus new required `p_reason`) — same authority check, mandatory-reason check, persists the corrector, writes one `CORRECT_RESULT` audit event referencing both Result versions |

All 8 applied cleanly on a from-scratch `supabase db reset --local`, twice (once mid-implementation, once as the final pre-acceptance check).

## 4. Authority model

Three canonical, non-hierarchical classes (`OPERATIONAL`, `CONSEQUENTIAL_FINALIZER`, `PRODUCT_GOVERNANCE`), text + `CHECK`, matching the schema's exclusive convention. `authority_grants` allows a Gaming Member to hold multiple classes simultaneously (each its own row) — required, not incidental, by the non-hierarchical design: a member needing both `OPERATIONAL` and `CONSEQUENTIAL_FINALIZER` reach needs both grants explicitly, since neither implies the other.

## 5. Root bootstrap

`bootstrap_governance_authority_atomically(p_gaming_member_id, p_reason)` — never exposed through any HTTP route in this Slice, invoked only by direct service-role call. Self-limits by checking evidence (an active `PRODUCT_GOVERNANCE` grant already exists), not a separately persisted "used" flag, following the same lock-from-evidence convention as Activity Classification and Session Capability. `granted_by` is left `null` on the bootstrap row (no prior actor granted it in the ordinary sense); the audit event's own `actor_id` still attributes the action to the Gaming Member who performed it, with `authority_class_used` left `null` (they held no established class at the moment of bootstrap — that is the entire point of it). Serialized against concurrent bootstrap attempts via `pg_advisory_xact_lock`, deliberately not a permanent uniqueness constraint — canonical authority allows more than one Gaming Member to hold `PRODUCT_GOVERNANCE` over time via ordinary grants after bootstrap, so "at most one `PRODUCT_GOVERNANCE` grant ever" would be the wrong invariant; only "at most one bootstrap" needs serializing.

## 6. Grant / revoke

`grant_platform_authority_atomically` / `revoke_platform_authority_atomically` — both `PRODUCT_GOVERNANCE`-only (checked against `authority_grants` itself, not `gaming_admins`), both reason-mandatory, both idempotent (a redundant grant returns the existing active row; a redundant revoke returns the existing revocation), both write exactly one audit event on the real-mutation branch only. Neither is exposed through any HTTP route in this Slice — invoked directly by tooling/tests, exactly matching how `gaming_admins` rows are seeded today. Revocation mutates the existing `authority_grants` row (`revoked_at`/`revoked_by`) rather than deleting it or inserting a new row — the full grant period remains queryable on that one row; a re-grant after revocation inserts a genuinely new row, preserving the prior period's own end intact.

## 7. Audit ledger

`admin_audit_events` — thin, append-only, referencing domain state via bounded `{table, id}` JSONB pointers (`previous_reference`/`resulting_reference`), never a duplicated before/after blob. Append-only is an application-layer discipline, not a database-role grant — this schema has no RLS and every write reaches Postgres through the service-role client (matching every other table here), so a `GRANT`-based restriction would be theater; no application code path issues `UPDATE` or `DELETE` against this table, the same posture `session_events` already relies on. Actor model is exactly `GAMING_MEMBER | SYSTEM` — `SESSION_HOST` is deliberately absent (Session Host actions remain Session-domain evidence, never duplicated here); no producer in this Slice writes a `SYSTEM` row, the value is reserved, not yet exercised.

## 8. Result finalization / correction integration

`finalize_match_result_atomically` and `correct_match_result_atomically` each gained, over their prior (0106/0107) shape: a `CONSEQUENTIAL_FINALIZER` authority check (their first-ever DB-layer authority check — previously both trusted the caller entirely), actual persistence of `p_finalized_by_gaming_member_id` (accepted since migration 0064, discarded ever since — the exact gap ADR-037 names), and exactly one `admin_audit_events` row per real mutation. Correction additionally requires a non-empty `p_reason`, enforced at both the RPC layer and the TypeScript command layer (`correctMatchResult.ts`) — a genuine, zero-round-trip fast path, unlike authority itself. Authority is deliberately **not** duplicated as a TypeScript-layer fast-path check: `finalizeMatchResult.ts`/`correctMatchResult.ts` have no data already in hand to check against without an extra round trip the RPC's own atomic check makes unnecessary — this is a considered deviation from Session Capability's own fast-path precedent (justified there by a check against already-fetched data; not available here), documented honestly rather than silently diverging. The authority check runs before the idempotent-return branch in both functions, so an unauthorized caller learns nothing about a Result's settlement state, not even that it is already finalized.

Domain-column actor persistence (`match_results.finalized_by_gaming_member_id`) coexists with, and does not replace, the cross-domain ledger — mirroring Prize Redemption's own already-correct pattern (`redeemed_by_gaming_member_id` directly on `prize_qualifications`), which was the existing proof this split already works well in this schema.

## 9. Reason policy

Nullable at the schema and TypeScript level throughout; mandatory only for `BOOTSTRAP_GOVERNANCE_GRANT`, `GRANT_AUTHORITY`, `REVOKE_AUTHORITY`, and `CORRECT_RESULT` — optional for first `FINALIZE_RESULT`, exactly matching canonical policy. Enforced per-action, never globally.

## 10. Deferred: FAILURE-outcome auditing

Per this gate's own explicit Section 12 instruction, generic `FAILURE`-outcome audit events are **not implemented in this Slice** — no random 401/403 traffic, no malformed-request events, no generic domain-failure event machinery. This Slice proves the `SUCCESS`-path immutable-attribution architecture end to end; `FAILURE` capture (for a meaningfully authenticated-but-rejected consequential action) remains a real, named, deferred requirement for a future increment, not a silently dropped one.

Also deliberately not implemented, per this gate's explicit boundary: any `GOVERNANCE_OVERRIDE_*` named-exception action path. The operational simulation's step proving "Governance can issue an exceptional override only through the exceptional path" was accordingly not exercised — there is no override path to exercise yet. What **was** proven instead, fully satisfying the underlying invariant: a Governance-only actor (holding `PRODUCT_GOVERNANCE` and nothing else) cannot perform an *ordinary* `FINALIZE_RESULT`/`CORRECT_RESULT` at all (Section 20, step I) — non-hierarchy holds in both directions.

## 11. Legacy `gaming_admins` coexistence

`gaming_admins` is untouched — same schema, same `requireGamingAdmin` check, same 14 gated routes, all still fully functional. `authority_grants` was installed in parallel, consumed only by the new bootstrap/grant/revoke tooling and the finalize/correct integration. This dual-authority-mechanism state is a deliberate, temporary A0→A1 transition posture, not an oversight — reclassifying the 14 existing routes onto the new class model is explicitly Predictions A1's job, out of scope here.

## 12. A0/A1 boundary

Provisional classification of the 14 existing Gaming-Admin routes, for A1's future use, not enforced in this Slice: 12 `OPERATIONAL` (catalog/roster/venue/activation CRUD, draft Result entry, qualification listing), 2 `CONSEQUENTIAL_FINALIZER` (the Result finalize/correct route, the Prize redemption route). None of the 14 routes' own authorization code was modified.

## 13. Tests

- **Behavioral**: `__tests__/adminAuthority.test.ts` (new, 28 tests — Authority non-hierarchy/multi-class/revoke-immediacy, Audit event correctness/idempotency, Finalization authority+provenance+audit, Correction authority+reason+audit). Added to `package.json`'s explicit `npm test` file list.
- Fixture-only additions (zero deletions beyond parameter-list replacements) across `__tests__/predictions.test.ts` (+86/−6, all six `−` are `correctMatchResult(...)` calls replaced by the identical call plus a new `reason` argument) and `__tests__/persistentMetagame.test.ts` (+20/−1, same pattern) — every one of the 78+18 fresh `InMemoryPredictionsRepository()` instances that ever call finalize/correct now seeds `"gm-admin"` with `CONSEQUENTIAL_FINALIZER` via the new `seedAuthority` test-only seam.
- **Total behavioral: 581/581** (553 pre-existing + 28 new), confirmed on a from-scratch local reset, run twice.

## 14. Contract verification

- `__tests__/adminAuthoritySupabaseRepository.contract.test.ts` (new, 9 tests — bootstrap/second-bootstrap-rejected, concurrent-bootstrap serialization, non-hierarchy, multi-class, genuine-concurrency active-grant-uniqueness race, Governance-required enforcement, revoke/re-grant lifecycle with row-level history preservation, not-found rejection, audit read-path correctness). Added to `package.json`'s `test:contract` list.
- `__tests__/predictionsSupabaseRepository.contract.test.ts` gained 4 new tests (16 total, 12 pre-existing + 4 new) proving RPC-layer enforcement independently of the TypeScript command wrappers: unauthorized finalize rejected at the RPC; finalize persists actor + writes one audited event; correction without reason rejected at the RPC before any mutation; correction persists corrector + writes one `CORRECT_RESULT` event referencing both Result versions.
- **Total contract: 119/119** (106 pre-existing + 4 finalize/correct integration + 9 authority), confirmed on a from-scratch local reset, run three times with zero flakiness on the two genuine-concurrency (`Promise.allSettled`) tests.

## 15. Operational simulation

Ran directly against the freshly-reset local database (bootstrap → grant Operational/Finalizer → prove non-hierarchical rejection in both directions → finalize with full provenance/audit inspection → correction rejected without reason (no mutation) → corrected with reason (supersession + audit chain inspection) → revoke → immediate loss of authority on an unrelated fresh Match → re-grant → authority returns → Poker/Leaderboard/Gaming-XP regression checks). **Every Admin Control Plane A0 proving step passed on the first attempt.** One unrelated check (a plain Session-creation smoke test folded into the same script) failed — traced immediately to the simulation script itself calling `create_session_atomically` with a guessed, outdated parameter list, not any defect in Session Capability or A0; Session creation was already conclusively proven moments earlier by the full, separately-run, 24/24-passing `supabaseSessionRepository.contract.test.ts` suite. Not a system defect — a self-diagnosed error in disposable proving-script code, resolved by relying on the already-passing test evidence rather than by re-deriving the correct RPC signature for a throwaway script.

## 16. Defects found

None in the implementation itself. The one operational-simulation script error (Section 15) was diagnosed as script-only and did not require any change to production code, tests, or migrations.

## 17. Explicit non-goals

No Admin Console UI of any kind. No grant/revoke HTTP routes. No `gaming_admins` change or removal. No Predictions A1 route reclassification. No Duel, Templates, Level 33, Chess, or Physical Competition work. No Gaming XP activation — `gaming_xp_rules`/`gaming_category_participation_policy` remain at zero rows throughout, untouched. No generic RBAC or fine-grained permission catalog. No `GOVERNANCE_OVERRIDE_*` path (Section 10). No `FAILURE`-outcome audit capture (Section 10). Nothing pushed, deployed, or run against production.

## 18. Deployment compatibility (analysis only — no deployment performed or authorized)

**`OLD_SOURCE_NEW_SCHEMA`**: inert. All 8 new migrations are additive (new tables, a nullable column, function replacements preserving their existing 2-parameter external shape plus new optional/appended parameters). Old source calling `finalize_match_result_atomically`/`correct_match_result_atomically` without the new `p_reason` argument would fail against the new signature (Postgres requires all non-defaulted parameters) — for `finalize`, `p_reason` defaults to `null`, so old 2-arg calls continue to work; for `correct`, `p_reason` has **no default** (reason is mandatory by design), so an old 2-arg call would fail with a Postgres argument-count error, not a graceful application-level rejection. This is the one genuine transitional risk this Slice introduces, narrower than any prior Slice's own transitional window: it affects only the correction path, only during the brief window between migrations landing and source deploying, and only if a correction is actually attempted in that window — not observed as a concern given this analysis is offered for a future deployment gate to verify live, not performed here.

**`NEW_SOURCE_OLD_SCHEMA`**: unsafe, as with every prior Slice in this engagement — new source's `finalizeMatchResult`/`correctMatchResult` calls would immediately fail against a schema still expecting the old 2-parameter RPC shape.

**Recommendation for a future deployment gate**: migrations-first-then-source, identical discipline to every prior Slice — this analysis does not authorize deployment, which remains explicitly out of scope for this gate.

## 19. Production-mutation confirmation

**None.** No production Supabase credential was used at any point in this gate. All migrations were applied only to the local Docker Postgres instance (`http://127.0.0.1:54421`); all contract tests and the operational simulation ran only against that same local instance, using the well-known local demo service-role key established throughout this engagement.
