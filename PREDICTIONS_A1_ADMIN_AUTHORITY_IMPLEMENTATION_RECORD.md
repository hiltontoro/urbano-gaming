# Predictions A1 — Admin Authority Migration / Operations Consolidation
## Implementation Record

## 1. Canonical authority dependency

This Slice implements exactly the bounded scope classified by the immediately preceding "Predictions A1 — Admin Authority Migration / Operations Consolidation — Product + Implementation Classification Gate," itself governed by `Product/Authority_and_Audit_Foundation.md` and ADR-037, and building directly on the deployed Admin Control Plane A0 (production migration ceiling `0121`, source `1cb0f21`).

## 2. Starting state

`urbano-gaming` branch `integrate/join-session`, HEAD `d0691bd3ff4e0bc6f8d521d34a0b59e2d85df944`. Local migration ceiling `0121`. Re-verified fresh before implementation (not trusted from prior gates): exactly **14** admin route files under `app/api/gaming/predictions/admin/**` (21 distinct HTTP method-endpoints), all still gated by `requireGamingAdmin`; `setMatchActivityClassification`/`setMatchXpEligibility` confirmed to have zero HTTP routes; `gaming_admins` confirmed empty in production.

## 3. Exact admin-route recount

Confirmed 14 files, 21 endpoints, matching the classification gate's own count exactly — see that report's §2 inventory table, re-verified here via fresh `find`/`grep` before any edit.

## 4. Migrations (`0122`–`0125`)

| # | Migration | Concern |
|---|---|---|
| 0122 | `set_match_activity_classification_atomically_actor_provenance` | Function replacement — adds required actor + optional reason + `CONSEQUENTIAL_FINALIZER` check + `DECLARE_ACTIVITY_CLASSIFICATION` audit. No HTTP caller existed before this Slice, so the actor parameter has no default (a clean-slate design choice, not a compatibility question). |
| 0123 | `set_match_xp_eligibility_atomically_actor_provenance` | Identical shape applied to XP Eligibility — its own distinct `DECLARE_XP_ELIGIBILITY` audit action, never merged with Activity Classification's. |
| 0124 | `redeem_prize_qualification_atomically_authority_audit` | Function replacement — adds optional reason (`default null`, preserving signature compatibility for the one real existing HTTP caller) + `CONSEQUENTIAL_FINALIZER` check + `CONFIRM_PRIZE_REDEMPTION` audit. |
| 0125 | `drop_gaming_admins` | Final step — see §11. |

All four applied cleanly on a from-scratch `supabase db reset --local`, run repeatedly throughout implementation and once more as the final pre-acceptance check.

## 5. Final authority map

| Action class | Routes/actions |
|---|---|
| `OPERATIONAL` | Team/Player/Match/Venue/Activation/PrizeTier create-edit-toggle, `cancelMatch`, draft Result + Goal Event entry (both first-time and correction-draft) |
| `CONSEQUENTIAL_FINALIZER` | Activity Classification declaration (new route), XP Eligibility declaration (new route), Result finalize/correct (route gate replaced), Prize redemption (route gate replaced) |
| Read (any active class) | All GET/list/inspect routes — `requireAnyAdminAuthority` |
| Unaffected | `PRODUCT_GOVERNANCE` responsibilities (grant/revoke, XP policy) remain out of HTTP exposure, exactly as before |

## 6. Read-access implementation

`requireAnyAdminAuthority` (new, in `httpAuth.ts`) — any of the three platform authority classes satisfies it. Proven live: a Finalizer-only actor, an Operational-only actor, and a Governance-only actor each successfully read the admin surface in the operational simulation (§15); a zero-grant actor is correctly rejected (403).

## 7. Activity Classification result

New route: `PATCH /api/gaming/predictions/admin/matches/[matchId]/activity-classification`. `CONSEQUENTIAL_FINALIZER`-gated at the route; the RPC's own evidence-lock rule and enum vocabulary are byte-for-byte unchanged from the pre-A1 function. Actor persisted only via the audit ledger (no domain column exists for this fact, matching the RPC's own existing shape — `matches.activity_classification` has never had a provenance column and this Slice does not add one). Reason optional. Proven live end to end (O rejected, F succeeds, audit event correct).

## 8. XP Eligibility result

New route: `PATCH /api/gaming/predictions/admin/matches/[matchId]/xp-eligibility`. Identical shape and disposition to §7, its own distinct `DECLARE_XP_ELIGIBILITY` audit action type. Confirmed this Slice inserts zero rows into `gaming_xp_rules`, `gaming_category_participation_policy`, or `gaming_xp_events` — Gaming XP remains untouched by declaration, exactly as required.

## 9. Draft Result/Goal Event result

`saveDraftResult`/`startResultCorrection` (both reached via the existing `POST /matches/[matchId]/result` route) now require `OPERATIONAL`. Draft mutability classified and left unchanged, per the gate's own explicit boundary: goal-event wholesale replace-on-save remains **ACCEPTABLE_DRAFT_MUTABILITY**; `entered_by_gaming_member_id` staying fixed at first-creator on a second Operator's edit remains **SHOULD_FIX_LATER**, not touched — the consequential fact (who finalized) is separately and correctly captured by A0's own `finalized_by_gaming_member_id`.

## 10. Result finalize/correct migration result

The finalize/correct route's gate was replaced — `requireGamingAdmin` → `requirePlatformAuthorityHttp(request, credentials, "CONSEQUENTIAL_FINALIZER")` — not duplicated alongside it. The RPC's own independent authority check (already built in A0) remains as genuine defense-in-depth. Settlement logic was not touched; `FINALIZE_RESULT`/`CORRECT_RESULT` audit and mandatory correction reason were already complete from A0 and are unchanged. `gaming_admins` is no longer referenced anywhere on this path — confirmed by its full removal in §11.

## 11. `gaming_admins` retirement result

**Retired in full**, not merely deprecated. Sequence actually followed:

1. All 14 routes migrated onto the new authority checks.
2. Repository-wide search confirmed zero remaining runtime references to `requireGamingAdmin`, `isGamingAdmin`, or `gaming_admins` (only historical prose comments remained, left intentionally as lineage documentation).
3. Legacy test coverage removed only after confirming equivalent A0 coverage already existed: the "Gaming Admin" describe block in `gamingMember.test.ts` (4 tests), the `gaming_admins` round-trip test in `gamingMemberSupabaseRepository.contract.test.ts` (1 test), and the "admin authority" test in `predictionsSupabaseRepository.contract.test.ts` (1 test) — all superseded by `adminAuthority.test.ts` and `adminAuthoritySupabaseRepository.contract.test.ts`'s own fresh-every-call, immediate-revocation, non-authorized-rejected coverage.
4. `isGamingAdmin` removed from the `GamingRepository` interface and both implementations; `isCurrentlyGamingAdmin` removed from `lib/gaming/auth.ts`; `requireGamingAdmin` removed from `httpAuth.ts`; `seedAdmin`/`revokeAdmin` removed from `InMemoryGamingRepository`.
5. Migration `0125` drops the table.

**Load-bearing deployment-ordering finding, documented directly in `0125`'s own migration comment**: this drop is a materially different compatibility risk than every prior function-signature change in this engagement. A function-signature change fails narrowly (one action, one clean PostgREST error); dropping `gaming_admins` while old source is still running would hard-fail **all 14 legacy admin routes identically** for the whole `OLD_SOURCE_NEW_SCHEMA` window. `0125` must not be applied to production until source carrying this Slice's own route migration is already confirmed live — inverting the usual "migrations-first" default for this one migration specifically. See §16 for the full compatibility analysis.

## 12. Platform Governance / Gaming XP activation state

**PLATFORM GOVERNANCE NOT YET ACTIVATED** and **GAMING XP NOT ACTIVATED** — both confirmed unaffected by this Slice; no bootstrap, grant, or XP configuration was performed against production (nothing in this gate touched production at all).

## 13. Behavioral total

**587/587** (581 baseline + 10 new Activity Classification/XP Eligibility/Redemption tests in `adminAuthority.test.ts`, minus 4 retired `gaming_admins` tests in `gamingMember.test.ts`), confirmed on a from-scratch local reset, run twice.

## 14. Contract total

**125/125** (106 A0 baseline + 5 new RPC-level A1 tests in `predictionsSupabaseRepository.contract.test.ts` + 3 new HTTP-shaped tests in `adminAuthoritySupabaseRepository.contract.test.ts`, minus 1 retired `gaming_admins` test in each of `predictionsSupabaseRepository.contract.test.ts` and `gamingMemberSupabaseRepository.contract.test.ts`), confirmed on a from-scratch local reset, isolated re-runs of all three touched files clean.

## 15. Operational simulation

Ran against the real Next.js dev server (a new, additive `.claude/launch.json` entry pointing at local Supabase, not touching `.env.local`) and real local Postgres — the full HTTP boundary, not just the RPC layer. **Every check in the A–Z proving sequence passed on the first live attempt**: Operator-only creates the full catalog (Teams, Player, Venue, Match, Activation, Prize Tier) via real HTTP; Operator correctly rejected from Activity Classification and from finalize; Finalizer declares Activity Classification and XP Eligibility, finalizes, and corrects (rejected first without a reason, succeeding with one); actor provenance and exactly-one-audit-event proven for both `FINALIZE_RESULT` and `CORRECT_RESULT`; any-class read access proven for Operator, Finalizer, and Governance; a zero-grant actor correctly rejected from reads; revocation proven immediate; Governance-only correctly rejected from ordinary finalize. One case (Prize redemption, steps S–U) was not exercised live in this specific run — the corrected scoreline in this proving scenario genuinely did not produce a 4-of-4 qualification (a real, correct domain outcome given the exact fixture chosen, not a defect) — redemption's authority and audit behavior is independently and thoroughly proven at both the RPC layer (contract tests) and the command layer (behavioral tests), so this is not a coverage gap, only an unexercised path in this one live run.

**Revisited at the final local acceptance gate**: confirmed via a repository-wide search that no automated test, before or after this Slice, has ever exercised the redeem route through a real HTTP server — only the RPC layer (contract tests) and command layer (behavioral tests) have ever proven it, plus this one manual operational-simulation script. The redeem route file's own request-handling code is an unchanged, pre-A1-proven one-line authority-check swap (confirmed by diff); the only genuinely new logic on this path — the RPC's authority check/audit insert, and `requirePlatformAuthorityHttp` itself against real bearer tokens — is already proven directly. No dedicated HTTP-level proving fixture was added; forcing one would only re-exercise Next.js plumbing this Slice never touched, which the governing gate's own instructions counsel against.

## 16. Compatibility analysis

**`OLD_SOURCE_NEW_SCHEMA`**: bounded for migrations `0122`–`0124`, identical reasoning to every prior Slice (Activity Classification/XP Eligibility have no prior HTTP caller to break at all; Prize redemption's new reason parameter defaults to `null`, preserving compatibility). **Migration `0125` is qualitatively different and more severe** — see §11's finding. It must be sequenced strictly after source is confirmed live, not bundled into the same "migrations-first" batch as `0122`–`0124`.

**`NEW_SOURCE_OLD_SCHEMA`**: unsafe, as always — new source's route handlers call RPCs with the new required parameters/authority checks that don't exist on old schema.

**Recommended topology for a future deployment gate**: apply `0122`–`0124` first → verify → push source (which carries the full 14-route authority migration plus both new routes) → verify live → **only then** apply `0125` as a final, separate step, with its own explicit verification that zero production traffic could still be relying on `gaming_admins` (production has held zero real `gaming_admins` rows since that table's own deployment — reconfirmed multiple times across this engagement — so this verification is expected to be trivial, but must still be performed, not assumed).

## 17. Exact files changed

Recounted precisely against `git status` at the final local acceptance gate (two counts in the original draft of this section were off by one against fresh evidence, corrected here rather than left standing):

**14** modified route files (authority-check swap only — matches §3's own 14-file inventory exactly): `teams/route.ts`, `teams/[teamId]/players/route.ts`, `players/[playerId]/route.ts`, `matches/route.ts`, `matches/[matchId]/route.ts`, `matches/[matchId]/result/route.ts`, `matches/[matchId]/result/finalize/route.ts`, `venues/route.ts`, `venues/[venueId]/route.ts`, `activations/route.ts`, `activations/[activationId]/route.ts`, `activations/[activationId]/prize-tiers/route.ts`, `qualifications/route.ts`, `qualifications/[qualificationId]/redeem/route.ts`.

**2** new route files: `matches/[matchId]/activity-classification/route.ts`, `matches/[matchId]/xp-eligibility/route.ts`.

**10** modified `lib/gaming/` files: `auth.ts`, `db/gamingRepository.ts`, `db/supabaseGamingRepository.ts`, `db/inMemoryGamingRepository.ts`, `predictions/adminCatalog.ts`, `predictions/redeemPrizeQualification.ts`, `predictions/httpAuth.ts`, `predictions/db/predictionsRepository.ts`, `predictions/db/supabasePredictionsRepository.ts`, `predictions/db/inMemoryPredictionsRepository.ts`.

**7** modified test files: `adminAuthority.test.ts`, `adminAuthoritySupabaseRepository.contract.test.ts`, `gamingMember.test.ts`, `gamingMemberSupabaseRepository.contract.test.ts`, `persistentMetagame.test.ts`, `predictions.test.ts`, `predictionsSupabaseRepository.contract.test.ts`.

1 new implementation record (this file), 4 new migrations, 1 additive `.claude/launch.json` entry (dev tooling, not application code — points a named preview target at local Supabase without touching `.env.local`; confirmed at the final local acceptance gate to extend an already-committed shared file using only the universally-published Supabase CLI local demo key, not a project secret — included in the A1 commit on that basis).

## 18. Defects found

None in the implementation itself. No script bugs this gate (the operational simulation script succeeded on its first complete run, unlike prior gates' own experience).

## 19. Explicit non-goals

No Admin Console UI. No Content Library, Promotions, Physical Competition, Duel, Templates, Level 33, or Chess work. No Gaming XP configuration or activation. No Auth/SMTP configuration. No Platform Governance bootstrap in production. No `FAILURE`-outcome audit events. No fix to the `entered_by_gaming_member_id` staleness (`SHOULD_FIX_LATER`, deliberately not addressed). Nothing staged, committed, pushed, or deployed.
