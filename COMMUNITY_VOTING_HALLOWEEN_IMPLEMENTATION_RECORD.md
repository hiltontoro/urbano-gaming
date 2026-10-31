# Community Voting — Halloween Costume Contest (Ranked Ballot) — Implementation Record

> **HISTORICAL RECORD — SUPERSEDED (UG-IV-GATE-005 / 005A).** The five-option ranked-ballot candidate this record describes is **not part of the active candidate**: its runtime (three migrations `20261028120000/100/200`, `lib/gaming/communityVoting/ranked/`, the `ranked` routes, the telephone steps, the three pages and their tests) was **removed** after being preserved and verified byte for byte (see `COMMUNITY_VOTING_TWO_ROUND_IMPLEMENTATION_RECORD.md` §3 for the location and the hashes of the preserved snapshots). Its reusable parts (contestant numbers and claim credentials, photographs, consent, the operator's decision, the contestant's association, the atomic open, operator authority and audit) were carried into the two-round pilot's own migrations, library and tests. Read this file as **event-time evidence only**; it governs nothing.

**Status: LOCAL CANDIDATE. Uncommitted. Not pushed, not deployed, no provider configured, nothing run against Preview or Production.**
**Date:** 2026-10-28 · **Venue/event:** The Pub — La Última Noche (Beer Box partner case) · **Authority:** Claude Implementation Prompt — Halloween Community Voting.

This record describes what exists in the working tree, how it was checked, and what it does **not** prove. It is evidence for a reviewer; it grants nothing.

## 1. Scope and architecture

The canonical Community Voting architecture is reused, not replaced:

`Event Template → Experience Instance → Session (VOTING) → Voting Interaction`

The GATE-003 single-choice path (geofenced, Auth-phone identity, `votes` table) is **unchanged in behavior**. A new, per-Instance `ballot_mode` selects the path:

| `ballot_mode`   | Geofence | Ballot                      | Identity                              | Close                          |
|-----------------|----------|-----------------------------|---------------------------------------|--------------------------------|
| `SINGLE_CHOICE` | yes      | one vote (GATE-003)         | Auth phone                            | Session close (GATE-003)       |
| `RANKED_TOP_5`  | **no**   | five ranked picks, 10/8/6/4/2 | confirmed email + WhatsApp possession | operator-only, writes a closure |

No second voting runtime was created. Ranked ballots live in new Instance-owned tables; the Session lifecycle (`start_session_atomically`, `close_submissions_atomically`) is still the authority for open/closed, called from inside the ranked functions.

### Lifecycle

```
preparation ──► operator review + consent ──► (association confirmed, photos approved)
     │                                                        │
     │                                   explicit OPERATOR-ONLY open (atomic: candidates created + voting opens)
     ▼                                                        ▼
 schedule (tentative)                         active ── ballots (fail closed outside the window)
                                                        │
                          explicit OPERATOR-ONLY close  OR  configured close time (hard stop for ballots)
                                                        ▼
                               immutable closure record (ballots, results digest, removal date = close + 72 h)
```

Nothing opens automatically. After open, no attribution can change. The configured close time refuses ballots even before the operator presses close.

## 2. What was added

### Database (additive; GATE-003 migrations untouched)

| Migration | Purpose |
|---|---|
| `20261028120000_community_voting_ranked_ballot_foundation.sql` | `ballot_mode`; nullable venue columns for ranked; phone columns on voter bindings (digest only); tables: schedules, entry photos, consents, photo decisions, withdrawals, ballots, ballot picks, ballot attempts, closures, operator actions |
| `20261028120100_community_voting_ranked_ballot_functions.sql` | ~30 SQL functions: operator authority, registration, schedule, entries, photo/consent/decision, claim/confirm, withdrawal, atomic open, atomic close, results/evidence/overview, public reads, WhatsApp accounting, ballot submission, voter status, media purge |
| `20261028120200_community_voting_ranked_ballot_guards.sql` | Append-only/immutability triggers, table-level guards that re-check the rules the functions enforce, deferred "exactly five picks" constraint trigger, blocks on the ordinary `votes`/close/reveal paths for ranked Instances |

Properties worth knowing:

* **Session-first lock order** in every writing function (`sessions … for update`), so submit/close/withdraw serialize and there is no deadlock cycle.
* Refusals that need audit evidence return a normal row (`outcome`/`reason_code`) instead of raising, so the evidence row commits.
* Forging a transition from PostgREST is not possible: privileged transitions require transaction-local markers that only the SQL functions set.
* Exactly three bare `SECURITY DEFINER` lookups exist (`community_voting_session_is_event_bound`, `community_voting_event_session_of_interaction`, `community_voting_ranked_session_of_interaction`); every other function is `SECURITY INVOKER`. A contract test pins this closed inventory.
* Ballot: one per (instance, binding); submission key + payload digest give safe replay; weights are a `CHECK` (rank ↔ points); picks, ballots, closures, consents, decisions, withdrawals, attempts and operator actions are append-only.
* Closure digest: `sha256('cvres1|<valid ballots>|' + ordinal:points:ballots:r1..r5 per non-withdrawn contestant by ordinal)` — computed identically in SQL and in `ranked/results.ts`, and a test pins that they agree.

### Server (TypeScript)

`lib/gaming/communityVoting/ranked/` — `constants.ts` (required Spanish texts, quoted verbatim), `ballotRules.ts`, `ordering.ts` (per-voter seeded Fisher–Yates over a canonical base; not vote-dependent), `results.ts` (standings, exact ties, digest, CSV), `jpeg.ts` (structure check, strips APP1–APP15/COM so EXIF/GPS never reach storage), `phoneNumber.ts` (E.164, keyed digest), `phoneProvider.ts` (Twilio Verify WhatsApp REST boundary; fails closed), `operatorAuth.ts`, `identity.ts`, `operatorRequest.ts`, `phase.ts`, `operations.ts`, `voterOperations.ts`, `http.ts`, `types.ts`, `repository.ts`, `supabaseRankedRepository.ts`.

24 route files under `app/api/gaming/community-voting/ranked/` (registration; public info/gallery/slideshow/photo; voter binding/phone/claims/status/ballot; operator overview/entries/photo/consent/decision/association/withdrawal/open/close/results/media-purge).

Modified GATE-003 candidate files (4): `lib/gaming/communityVoting/types.ts` (new error codes), `httpSupport.ts` (their HTTP statuses), `db/supabaseCommunityVotingRepository.ts` (`client/translate/rows` made `protected` for the subclass), `__tests__/communityVotingSupabase.contract.test.ts` (three closed-inventory assertions updated to the new exact inventory — tables 13, definers 3, updaters 2 — not loosened).

### Pages (no new npm dependency; `package.json` unchanged; `public/urbanoAuth.js` unchanged)

* `public/community-voting.html` + `communityVotingVoter.js` — email code sign-in via the existing `UrbanoAuth`, WhatsApp step, swipeable deck, virtualized ~3-column grid, full-photo view, personal shortlist, five-slot ranked ballot with reorder, final-confirmation dialog, receipt.
* `public/community-voting-operator.html` + `communityVotingOperator.js` — tablet-oriented: schedule, create contestant (claim code shown once), photo capture/resize, consent (explicit checkbox, text quoted verbatim), approve/reject, association confirmation, withdrawal, open/close, results/evidence/CSV, media purge. Host token kept in `sessionStorage` only.
* `public/community-voting-display.html` + `communityVotingSlideshow.js` — venue screen: fair rotation (each contestant once per pass, fresh shuffle), neutral prompt, **receives no count/rank/total from the server**.

Text is rendered with `textContent`; photo `src` is restricted to the ranked API prefix.

## 3. Requirements → implementation (short form)

| Requirement | Where it is enforced |
|---|---|
| Only the designated operator approves/rejects, associates, opens, closes, withdraws, reads tally | host token **and** `operator_gaming_member_id` compared **in the database**, every operator function; registration allowlist `COMMUNITY_VOTING_OPERATOR_MEMBER_IDS` fails closed |
| No phone/email/user id/storage path in UI, URLs, logs, public APIs | public contestant identity is an opaque `#NNNN` alias; photos served only by alias; phone stored as keyed digest, number never stored |
| Contestant consent, per photo | `consents` row references the photo, statement SHA-256, version, operator, age confirmation; approval requires it |
| Open requires complete association + approved/consented photo | `start_ranked_community_voting_atomically` (also re-checked by table guards) |
| Withdrawal after open | append-only record; bytes erased immediately; excluded from gallery, new picks, standings and digest; ballots and remaining picks/points preserved |
| Verified voters | confirmed email (server `auth.getUser` each request) **and** WhatsApp possession recorded in DB; caps on start (5), check (10), claim failures (10); one number → one identity per Instance |
| Exactly five distinct ranked picks, 10/8/6/4/2, final | shape check in function + `CHECK` + deferred five-picks trigger + immutability triggers |
| One final ballot per verified identity | unique (instance, binding); replay by submission key + digest |
| Inside/outside venue | no geofence in ranked mode |
| Fail closed outside window | function + guard re-check; scheduled close is a hard stop |
| Hidden tally during voting | public info/status/slideshow carry no counts; ordinary reveal and `votes` blocked for ranked |
| Results after close | operator-only; weighted totals, ballots-containing, per-rank counts, exact ties, withdrawals, attempt evidence, timestamps, CSV |
| Ties never resolved | `tieGroups` reported; no winner field exists |
| No URBANO Points/XP/redemption/wagering/paid voting | none introduced |

## 4. Evidence

All database evidence was produced on an **isolated loopback stack** (Postgres 17.11, PostgREST v14.5, GoTrue v2.193.1 behind a Node shim) built from the repository's migrations (292 files). No hosted service, no provider, no real credential was used.

| Check | Result |
|---|---|
| Ranked core (DB-free) | 63/63 (red-first: 58 failed / 5 passed before implementation) |
| Ranked SQL/repository contract | 76/76 (73 + 3 added after mutation checks; see honesty note below) |
| Ranked routes contract | 23/23 (red 23/23 against 501 stubs) |
| UI logic | 28/28 (red 28/28 against placeholders) |
| Pages (jsdom, real scripts inlined) | 34/34 (written after the pages) |
| GATE-003 behavioral / contract | 180/180 / 122/122 |
| Every contract suite, serial, fresh stack | 27 files, **944/944** (run before the three added tests; afterwards the three Community Voting contract suites were re-run serially on a rebuilt stack: 122 + 76 + 23 = **221/221**) |
| `npm test` (registered suite) | 41 files, 1627/1627 |
| DB-free new + GATE-003 behavioral suites together | 4 files, 305/305 |
| `npx tsc --noEmit` | clean |
| `npm run build` | passes; 24 ranked routes |
| Real-browser inspection (throwaway harness, not shipped) | mobile 375×812, tablet 768×1024, venue 1280×720; fixes made from what was seen |

### Mutation checks on the ranked SQL

Method: on the disposable database, one rule at a time was removed from a function (or one trigger dropped), the ranked SQL and routes contract suites were run serially, and the original definition was restored from the migration file. 38 mutants (29 function edits, 9 trigger drops).

| Result | Count | Detail |
|---|---|---|
| Caught on the first run | 34 | operator identity, host token, duplicate contestant, WhatsApp requirement, open/closed window, scheduled close, second ballot, replay payload check, rank weights, self-vote, ballot-count consent, start/check caps, number-at-start check, readiness to open, re-open, retention window, already-closed, digest ballot count, bytes erased on withdrawal, gallery/photo retention and state, results before open, ballot/pick guards, five-picks trigger, ordinary votes/close guards, ballot and closure immutability, photo guard |
| **Survived the first run → test gap, fixed** | 3 | M03 (ranked operations on a single-choice Instance gave `OPERATOR_REQUIRED`, not `WRONG_BALLOT_MODE`); M22 (closure digest counted a contestant who withdrew **before** close); T08 (table guard that a withdrawal names the entry's own candidate). Three tests were added; each mutant is now caught |
| Survived → equivalent | 1 | M17 (completion-time number check removed): the unique index plus `exception when unique_violation` returns the identical outcome, so it is defense in depth, not a gap. M17b (check removed **and** index dropped) is caught by "one identity per telephone number per event" |

After the three added tests, the ranked SQL contract suite is 76 tests. Operational note: M17b stored duplicate numbers on purpose, so the unique index could not be recreated afterwards; the disposable stack was rebuilt from the migrations instead of repaired by hand, and M22/T08 were re-run on the rebuilt stack. For all other mutants the function/trigger definitions were verified byte-identical to the baseline after restoration.

### Local load rehearsal (indicative only)

100 approved, associated contestants; 1,000 synthetic voters (bind, 3 WhatsApp accounting calls, info, gallery, 18 thumbnails, status, ballot) at 40 concurrent workers, through supabase-js → PostgREST → Postgres, all on one laptop; then close and results.

| Check | Result |
|---|---|
| Ballots accepted | 1,000 / 1,000, errors: none |
| Wall time | 20.5 s (≈ 49 voters/s including identity set-up) |
| Ballot submit (p50 / p95 / p99 / max) | 65 / 183 / 344 / 546 ms |
| Gallery read (p50 / p95 / p99) | 56 / 199 / 314 ms |
| Thumbnail read (p50 / p95 / p99), n = 18,000 | 65 / 223 / 348 ms |
| Closure | 1,000 valid ballots; SQL digest = TypeScript digest; total points 30,000 = 1,000 × 30 |
| Ties | 19 tie groups among 100 contestants (random ballots) — reported, none resolved |

What this does **not** show: network latency, Vercel cold starts or concurrency limits, Supabase hosted pool limits, real photograph sizes (the synthetic thumbnails are ~6 KB), CDN behavior, WhatsApp delivery, or real phones. It shows the database path has no correctness failure and no pathological serialization at this volume. The venue rehearsal remains the real test.

### Honesty notes on the evidence

* The ranked SQL was written **before** its contract tests, so those tests were not red-first. The mutation table above is the substitute proof that they notice a removed rule. The TypeScript domain, repository, route and UI-logic suites were written test-first.
* The page tests were written after the pages.
* `package.json` was not touched, so the new test files are **not** in `npm test`; they are run by path. Registering them is a one-line follow-up for the reviewer.
* WhatsApp provider tests use a fake `fetch` only. They prove request shape and fail-closed behavior; they prove nothing about Twilio, Meta, or delivery to Honduras.
* No visual or touch test was run on a physical phone.

## 5. Configuration the candidate needs (names only — no values exist in the repository)

| Variable | Purpose | If missing |
|---|---|---|
| `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY` | existing | existing behavior |
| `COMMUNITY_VOTING_OPERATOR_MEMBER_IDS` | allowlist of Gaming Member ids that may be registered as operator | registration refused (fails closed) |
| `COMMUNITY_VOTING_PHONE_PEPPER` | key for the phone digest | phone steps refused |
| `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, `TWILIO_VERIFY_SERVICE_SID` | WhatsApp possession check via Twilio Verify | `503 PHONE_PROVIDER_UNAVAILABLE` before any counting; ballots stay impossible; **no SMS or email-only fallback** |

## 6. Provider blockers (nothing here is claimed ready)

Real launch needs separate evidence that does not exist in this work: paid Twilio account; WhatsApp Business Account; approved BYO WhatsApp Sender; Verify Service; approved authentication template; a real delivery and check test to a Honduran number. Local mocks are local evidence only.

## 7. Known limits and operational risks

* **Photo purge is not scheduled.** Public display stops at `removal_due_at` (close + 72 h) automatically — the gallery and photo routes refuse. Storage deletion happens only when the operator runs media purge (or at withdrawal/reject/supersede). No cron was added; adding one needs a separate authorization.
* **Photo cache.** A copy served before a withdrawal can remain in a browser/edge cache for up to `PUBLIC_PHOTO_CACHE_SECONDS` (60 s). The gallery and slideshow stop listing the contestant immediately.
* **Storage.** Photos are `bytea` in Postgres (full ≤ 1.5 MB, thumb ≤ 150 KB per upload). 100 contestants ≈ 165 MB worst case. Thumbnail egress for >1,000 voters depends on edge caching of the 60 s photo responses.
* **Claim code.** Shown once at creation and kept in the operator tab's `sessionStorage`. A lost code before media exists → remove the entry and recreate; after media exists → withdraw and recreate.
* **Serialization.** Submit, close, withdraw and phone accounting take the Session lock; throughput is bounded by short critical sections (see load evidence).
* **Polling.** Voter/operator/display pages poll at 20–35 s jittered intervals to bound load.
* **Hosted RLS posture** of the pre-existing `sessions`/`participants` tables was observed to be anon-readable on a migration-built database; this is pre-existing and was not changed. It needs a hosted-environment check before launch.
* **Retention** of consent records, ballots and aggregates is not defined by any source; no automated deletion of those is claimed.

## 8. Decisions that remain with the Founder / Canon

See the final report (item 8). In short: retention periods for consent/ballot/aggregate data; whether to authorize a scheduled purge; provider provisioning; the operator allowlist value and pepper; confirmation of the self-vote rule and the one-number-per-identity-per-event rule; photo cache TTL; claim-code recovery UX; Schema review of ranked ballots living in Instance-owned tables; hosted RLS check; real-device and at-venue rehearsal.

## 9. Not done, deliberately

No commit, no push, no deploy, no promotion, no Vercel/Supabase/Twilio/WhatsApp/email/DNS change, no provider account, no real OTP, no Production or Preview data access, no change to `package.json`, `public/urbanoAuth.js`, or any committed migration.
