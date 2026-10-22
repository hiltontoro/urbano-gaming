# Score Predictions — Release Compatibility and Release Strategy

Status: **analysis only.** Nothing here changed any deployed environment. The only Production access was a read-only
catalog and configuration inspection (section 3; `SCORE_PREDICTIONS_PRODUCTION_INSPECTION.md`). Production execution needs its
own gate. All other evidence below comes from a disposable local stack (loopback only).

**Shared authority (section 3), updated 2026-10-22:** the escalation below was observed on the LOCAL posture. A read-only
catalog inspection of the Production project (see `SCORE_PREDICTIONS_PRODUCTION_INSPECTION.md`) found Production protected for
the authority, audit and Predictions tables (row-level security on, no policies, no client write path through any function),
so the escalation does **not** reproduce there. What remains is lane-owned: the Production protection comes from a
platform setting rather than from these migrations, and one unrelated view is open to client roles. Section 3 has the detail.
Passing Predictions tests, and migration 3, still do not speak to those tables.

Scope of the candidate this document belongs to:

| Migration | What it does | Backward compatible with the `a816e40` baseline app? |
| --- | --- | --- |
| `20261020150000_add_fulfillment_and_hold_links_to_prize_qualifications` | Adds columns, `match_result_lineage_ordinal()`, backfills (including holding legacy pending twins), constraints written so that an UNKNOWN (NULL) result is refused, and two **transitional triggers** that migration 2 drops | Existing functions are not replaced, but the old redeem and correct functions are now bounded by the triggers: a held or satisfied entitlement cannot be redeemed (the old app gets an opaque HTTP 500), an old-app correction's new entitlement beside a delivery is held on creation, and an ordinary redemption still works and records a snapshot. See "Intermediate migration states". |
| `20261020150100_result_integrity_and_prize_correction_atomic_functions` | Replaces the settlement functions, **drops** the 3-argument `finalize` / `correct` signatures, adds guard triggers, service-role-only grants, RLS on the five settlement tables | **No** for finalize/correct (by design: no unreviewed-content path may stay callable) |
| `20261021120000_restrict_predictions_server_objects_to_service_role` | Revokes client access to three Predictions functions and six Predictions tables | Yes for every server path (service role). No legitimate client-side consumer exists. |

"Old app" = commit `a816e40`, the verified remote-main source baseline, built and run locally for compatibility
testing. **What Production currently runs was not verified**; whether the deployed build is `a816e40` has to be
established by the release gate before this matrix is relied on. "New app" = this candidate.
"Old schema" = migrations through `20261014183938`. "New schema" = all three migrations.

## 1. Compatibility matrix (observed, not inferred)

HTTP results from real routes against a real local Supabase, with real Auth tokens.

### Members (the launch-critical path)

| Operation | old app / old schema | old app / new schema | new app / old schema | new app / new schema |
| --- | --- | --- | --- | --- |
| list matches | 200 | 200 | 200 | 200 |
| submit prediction inside the venue | 201 | 201 | 201 | 201 |
| submit prediction far outside the venue | 400 refused | 400 refused | 400 refused | 400 refused |
| read own prediction / prize status | 200 | 200 | 200 | 200 |

Member flows are unaffected in every combination, in either deployment order.

### Staff (admin portal)

| Operation | old app / old schema | old app / new schema | new app / old schema | new app / new schema |
| --- | --- | --- | --- | --- |
| read result state | 200 | 200 | 200 | 200 |
| save result draft | 201 | **201** (old direct writes; no integrity check; see note 1) | **500** (`save_draft_match_result_atomically` absent) | 201 |
| finalize | 200 | **500** `Failed to finalize result.` — nothing settled | unavailable (no draft can be saved) | 200 |
| correct | baseline (not re-probed) | **500**, nothing settled (the correction draft saves; finalizing it is refused) | unavailable | works |
| list prize qualifications | 200 | 200 | 200 | 200 |
| redeem an ordinary pending entitlement | 200 | 200 | 200 (existing entitlement) | 200 |
| redeem a held entitlement | n/a (the old schema has no hold state) | **500** `Failed to redeem…` (refused, opaque) | n/a (the old schema has no hold state) | **409** "on hold…" |
| redeem an already-satisfied entitlement | n/a (the old schema has no satisfied state) | **500** (refused, opaque) | n/a (the old schema has no satisfied state) | **409** "already satisfies…" |
| release-hold route | absent | **404** (route absent) | n/a (the release function does not exist on the old schema) | 200 |

Held and satisfied entitlements exist from the moment migration 1 is applied, not only after the new app runs:

* Migration 1's backfill places every **legacy pending twin** (an unredeemed, non-superseded row issued by the old
  correction beside an earlier delivery) on hold (`LEGACY_PENDING_TWIN`, or `DELIVERY_ORDER_UNKNOWN` when the order cannot be
  established). From that moment the old app can neither redeem nor release such a row, and it reports the refusal only as an
  opaque HTTP 500 `Failed to redeem prize qualification.`; the new app reports 409 and offers release-hold.
* What makes that true **between migration 1 and migration 2** is migration 1's own transitional trigger, not the new redeem
  function (which does not exist yet). This was observed with the actual old redeem function and through the old app's real
  route; see "Intermediate migration states" below. The old app's opaque 500 was also observed after migration 2, on a held
  entitlement created by the new functions (a seeded run) and on a satisfied one.
* Any entitlement the new functions hold or satisfy after migration 2 is likewise opaque to the old app, including after an
  app rollback.

### Intermediate migration states (observed with the installed functions, not inferred from the final schema)

Method: a disposable local database was reset to the pre-gate schema; synthetic legacy data was created with the **old**
functions (members who were delivered a prize and then received the old correction's pending twin, one whose prize label was
edited before migration, one who was never delivered, one with a chain-position anomaly); the stated migrations were applied;
then the real redeem and correct functions that were installed at that moment were called with a synthetic Consequential
Finalizer. Durable row changes and audit effects were read back from the tables.

| State | Ordinary pending entitlement, old redeem | Legacy pending twin (held by the backfill), old redeem | Old-app (3-argument) correction |
| --- | --- | --- | --- |
| **Baseline** (pre-gate schema; there is no hold state) | Redeemed; 1 `CONFIRM_PRIZE_REDEMPTION` audit row | Redeemed (indistinguishable from an ordinary pending row): a **second physical delivery** is recorded; 1 audit row | Succeeds and creates a new pending twin; the old redeem delivers it |
| **Migration 1 only, first draft** (no transitional triggers; **not the candidate**, recorded because the verification found it) | Redeemed, with no evidence basis recorded (the CHECK accepted it) | **Redeemed although held**: durable `redeemed_at`, a `CONFIRM_PRIZE_REDEMPTION` audit row; the hold was bypassed | Created a new twin that was **not held**; the old redeem delivered it |
| **Migration 1 only** (candidate) | Redeemed; `redeemed_prize_label_basis = SNAPSHOT_AT_REDEMPTION` and the label read at that moment are recorded; 1 audit row | **Refused**: `P0001 PRIZE_QUALIFICATION_HELD`; no row change; **0 audit rows**; deliveries per member unchanged. Through the old app's real route: HTTP 500 `Failed to redeem prize qualification.` | Succeeds; the new entitlement is created **held** (`LEGACY_PENDING_TWIN`) with its lineage position filled in; the old redeem is refused (`PRIZE_QUALIFICATION_HELD`, no change, 0 audit rows) |
| **Migrations 1+2** | Redeemed with a snapshot (new function); 1 audit row | Refused by the new function: `PRIZE_QUALIFICATION_HELD`; no change; 0 audit rows. The transitional triggers are gone; only the evidence guard remains | The 3-argument call is refused: `MATCH_RESULT_DIGEST_REQUIRED` |
| **Full chain (1+2+3)** | As above | As above | As above |

In the migration-1-only state an ordinary old-app redemption through the route returned 200; a held twin returned 500.

The transitional triggers are the smallest database-enforced fix: one refuses redemption of a held or satisfied entitlement
(and records the snapshot an ordinary redemption would otherwise lack), one holds an entitlement created beside a delivery and
fills in its lineage position. They do not depend on staff activity or on how fast the next migration is applied, they do not
recreate any finalization path, and migration 2 drops them in the same transaction in which it installs its own guard.

Constraint verification: PostgreSQL accepts a CHECK whose expression is NULL, not only TRUE. Four forbidden states were
accepted by the first draft's constraints: a redemption with no evidence basis (with no label, with a snapshot-style label,
and with an observed label) and a hold with no basis. The constraints are now written so no input can evaluate to NULL, and 40
isolated cases (30 forbidden, 10 valid, including valid legacy UNKNOWN and valid snapshot evidence) pass against the migration-1-only,
migrations-1+2 and full-chain schemas, and as a contract test.

Notes:

1. The old app saves drafts with direct table writes, so on the new schema it can store a draft that the new integrity
   rules would have refused. That draft can never be finalized by the old app (its finalize call is refused: the function
   requires a reviewed-content digest and the old app sends none), and the new app's finalize re-runs the full integrity
   check against the digest of exactly what was reviewed. Nothing settles without review.
2. Calling the old 3-argument finalize through the API resolves to the new function with a missing digest and is refused
   with `MATCH_RESULT_DIGEST_REQUIRED`. There is no callable legacy finalization path on the new schema.
3. Migration 3 can be applied live under a running new app: the same staff and member probes were identical before and after.
   With migrations 1–2 applied and migration 3 not yet applied, the new app is fully functional.

### Old browser tabs (page loaded before an app deploy, used after it)

| Old page action sent to the **new app / new schema** | Result |
| --- | --- |
| Save draft (no `saveBase`) | 400 `saveBase is required: send the saveBase returned when you loaded this result.` Nothing saved. |
| Finalize (no `matchResultId` / `contentDigest`) | 400 `matchResultId and contentDigest are required…` Nothing settled. |
| Mark Redeemed on a pending prize | 200 |
| Mark Redeemed on a held prize (the old page lists it as not redeemed, per its code) | 409 `This prize is on hold…` Nothing delivered. |
| Mark Redeemed on an already-satisfied prize | 409 `An earlier delivery already satisfies this prize…` |
| Members' old tab: prize line (from the old page's code; not run in a browser) | Would read "not yet redeemed — see an URBANO host" for a satisfied or held prize. Cosmetic only: staff see the true state in the new portal; reload fixes it. |

An old tab fails closed. The new pages' requests against the **old app** (e.g. after an app rollback) are ignored for
the new fields and behave as the old app does.

## 2. Release strategy

Goal: keep reviewed-content enforcement and keep **no** callable legacy finalization path. Therefore no compatibility
shim: do not recreate the 3-argument `finalize_match_result_atomically` / `correct_match_result_atomically` for the
transition, and do not keep the old signatures "temporarily".

Recommended order — **database first, app immediately after, in one change window:**

0. Gate entry conditions: the shared-authority findings in section 3 have a disposition from the owning lanes, and the
   build Production currently runs has been identified (this matrix was tested against `a816e40`; Production was not verified).
1. Pre-flight (read-only, its own gate): record the settlement state (see "Establishing operational quiescence" below); list
   the legacy "pending twins" the backfill will hold, and the members/prizes they concern, so staff know them before the
   window; confirm the Preview deployment is not being used for settlement.
2. Have the new build ready as a prepared deployment, not yet promoted.
3. Apply migrations 1 → 2 → 3 in order (one `db push`). Each file is its own transaction; migration 3 is idempotent.
4. Promote the new app immediately.
5. Smoke checks (read-only plus one rehearsal-flagged match): member list/predict/read; admin read result state; confirm the
   3-argument call is refused; confirm anon/authenticated are refused on the three functions and six tables.

Why database first: the schema is backward compatible for every **member** path and for redemption of ordinary pending
prizes, so the staff operations that pause between step 3 and step 4 are finalize/correct (fail-closed) and the redemption
of any entitlement the backfill holds. App first is worse: the new app would also lose saving drafts and releasing holds
until the migrations land.

### Controlled interruption (exact scope)

Inside step 3, between migration 1 and migration 2 (seconds; the old finalize/correct functions are still installed):
every old-app operation behaves as before except that a held or satisfied entitlement cannot be redeemed (opaque HTTP 500, no
change, no audit row), an old-app correction's new entitlement beside a delivery is created held, and an ordinary redemption
also records a snapshot. This is enforced by migration 1's transitional triggers and was observed with the installed functions
(see "Intermediate migration states"); it does not depend on nobody using the portal.

Between step 3 and step 4 (minutes):

* **Unavailable:** staff finalize and staff correct (HTTP 500, nothing settled). Redeeming any entitlement that migration 1's
  backfill placed on hold (legacy pending twins): the old app refuses it with an opaque HTTP 500, and the release-hold route
  does not exist until the new app is promoted, so such a hold cannot be released inside the window.
* **Still available:** every member operation; staff reading results; listing prizes; redeeming ordinary pending
  entitlements.
* **Old tabs afterwards:** save/finalize refused with a message until the staff member reloads the page (see section 1).

Prerequisites: step 0 and step 1 complete; operational quiescence established as described below; the new build prepared.

### Establishing operational quiescence (for the future release gate)

An admin portal that is idle when observed is **not** prevention of new writes. Staff holding OPERATIONAL or
CONSEQUENTIAL_FINALIZER authority can save, finalize, correct, redeem and release at any moment; the old app writes drafts
directly; Preview shares the Production database. This candidate adds no write-freeze or maintenance switch for settlement or
redemption, so quiescence for a release window would rest on procedure and evidence, not on enforcement, unless the gate
decides to build or authorize an enforcing mechanism (a separate decision, outside this document). A future release gate
would establish it as follows:

1. **Schedule:** choose a window in which no Production match is awaiting or undergoing settlement (check kickoffs and expected
   final whistles of every enabled activation), and agree it with the Founder and with every staff member who holds
   settlement or redemption authority, with an explicit instruction not to use the portal during it.
2. **Point-in-time evidence before starting:** a read-only snapshot of draft results (unfinalized `match_results`), finalized
   results, prize qualifications (with their redeemed / superseded states), and the settlement-related audit events, plus a
   look-back showing no settlement or redemption activity for an agreed period.
3. **Re-check at the moment of each step:** the same snapshot immediately before applying the migrations and again before
   promotion. Any difference (a new draft, a new settlement, a new redemption or audit event) means someone wrote during the
   window: stop and re-evaluate; do not treat the earlier snapshot as still valid.
4. **Residual risk stated, not assumed away:** between snapshots a write can still occur. The old app's direct draft writes
   (note 1) and a write racing the migration are accepted risks the gate must weigh, or close with an enforcing mechanism.
5. **Preview:** confirm no Preview deployment is in use against the Production database for the window.

### Recovery

* Migrations applied, app promotion fails or is faulty: **roll forward.** Redeploy a fixed build. An app rollback is
  possible for member flows (verified: member paths are identical on old app / new schema) but leaves staff
  finalize/correct unavailable until the new app is back. Do **not** recreate the old 3-argument functions to "fix" this.
* Migration 1 applied, 2 failed: the old app keeps working for members and for ordinary redemptions (which now record a
  snapshot), and old finalize/correct are still installed. Held entitlements cannot be redeemed (opaque HTTP 500 in the old
  app) and an old-app correction's new entitlement beside a delivery is created held, so nothing can be delivered twice in
  this state; the database enforces that, not procedure. The holds cannot be released until migration 2 and the new app are
  in place. Fix and re-run 2; do not promote the new app before 2 is applied.
* Migrations 1–2 applied, 3 failed: nothing in the app depends on 3; re-run it (idempotent). Until then the Predictions
  client-role exposure documented below remains.

### Stop conditions

* Any migration error: stop, do not promote, record `supabase_migrations` state, decide with the Founder.
* Member smoke checks fail after promotion: roll the app back (member paths are schema-independent) and investigate.
* A match is found mid-settlement during pre-flight: wait; do not apply during settlement.
* A write is observed at any re-check during the window (new draft, settlement, redemption or audit event): stop and re-evaluate.
* The shared-authority findings in section 3 have no disposition from the owning lanes, or the build Production runs
  has not been identified: do not start.
* Production execution (migrate, deploy, any flag) needs a separate gate. This document authorizes none of it.

### Preview deployments

Preview shares the Production database. A Preview built from an older branch is an "old app / new schema" combination:
finalize/correct fail closed, drafts can be written without integrity checks (note 1). Do not rehearse on Preview; rehearse
on a local stack.

## 3. Cross-lane dependency and release blocker (not changed by this candidate)

Migration 3 closes the **Predictions-owned** objects only. Shared authority, identity, audit and Metagame tables belong to
other lanes and are untouched. On the locally migrated posture the following are readable and writable by the public
`anon` role and by any signed-in member, with RLS off: `authority_grants`, `admin_audit_events`, `gaming_members`,
`experience_summaries`, `gaming_progression_events`, `gaming_xp_events`, `gaming_xp_rules`.

Observed locally: a signed-in member's own token could insert an `OPERATIONAL` row into `authority_grants`, and the very
next admin request from that member was honoured (403 before, 200 after). The Predictions boundary therefore reduces the
direct exposure of matches, predictions, venues and the three functions, but **does not by itself make Predictions admin
actions tamper-proof** on a posture like the local one, where the shared authority table is open to client roles.

### Production posture (read-only catalog inspection, 2026-10-22)

Evidence is in `SCORE_PREDICTIONS_PRODUCTION_INSPECTION.md`. Method: `SELECT`s against the system catalogs of the Production
project (`URBANO Gaming`) only; no application row was read, nothing was written, no account was used. Findings:

- **Direct writes are blocked.** All 75 `public` tables, including `authority_grants`, `admin_audit_events`,
  `gaming_members`, the Metagame tables and every Predictions table, have row-level security **on**. There are **zero
  policies in every schema**, so the client roles (`anon`, `authenticated`) get no rows and can change none. Neither role
  has `BYPASSRLS`, neither can create objects in `public`, and every `public` object is owned by `postgres`. The table-level
  grants those roles hold (the platform default) are inert while RLS is on with no policy.
- **Indirect writes are blocked.** Of the 27 `SECURITY DEFINER` functions, none is executable by a client role except
  `rls_auto_enable()`, which returns `event_trigger` (it is the platform's RLS helper, not an ordinary callable function;
  not exercised). `grant_platform_authority_atomically`, `revoke_platform_authority_atomically`,
  `bootstrap_governance_authority_atomically` and the host-application functions are not executable by either client role.
  The 47 functions client roles can execute (including the old 3-argument `finalize` / `correct`, `redeem`, `upsert_prediction`)
  are `SECURITY INVOKER`: they run as the caller, so the same RLS blocks their writes.
- **One exception, outside Predictions and authority.** The view `public.duel_math_challenges_reached` (Math Duel) is defined
  without `security_invoker`, so it reads and writes as its owner, which bypasses RLS. `anon` and `authenticated` hold
  `SELECT`, `INSERT`, `UPDATE`, `DELETE` on it. It exposes `correct_answer` of activated challenges, and being a simple
  single-table view it is auto-updatable. Supabase's own advisor reports it as `ERROR: security_definer_view`. Reading or
  changing it was **not** attempted (no write probes are authorized); the finding rests on the catalog and the advisor.
- **Why Production differs from local.** Production has the platform's `ensure_rls` event trigger on, which turns RLS on for
  every new table; none of this repository's migrations enable RLS. The protection is therefore a platform setting, not a
  property of the schema: a database rebuilt, branched or restored from these migrations alone would come up open, like the
  local stack. Closing that is an explicit RLS-and-revoke migration for the shared tables, owned by the lane that owns them.

Status: **verified protected for authority, audit and Predictions data in Production; remediation needed for the one view
(Math Duel lane); recommended hardening for the migrations (owning lanes).** The local escalation is a local finding; it is
not a Production finding. Still required before any release: a disposition from the owning lanes on the view and on the
hardening, and the current Production build identified.
