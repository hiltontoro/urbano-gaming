# Community Voting — Two-Round Pilot (UG-IV-GATE-004A, corrected by UG-IV-GATE-005 / 005A / 006 / 007) — Implementation Record

**Product:** URBANO Gaming · **Activation:** Halloween Community Voting, The Pub — La Última Noche
**Branch / HEAD:** `claude/audit-lane-isolation-3f3511` @ `a816e40` · **Nothing here is staged, committed, pushed, deployed or promoted.**
**Status:** local candidate for review (post-correction; **GATE-006** added the zero-vote final guard, §14; **GATE-007** made the pending policies read as unapproved options and registered the pilot's tests, §15). This record **replaces** the earlier version of itself and **supersedes** `COMMUNITY_VOTING_HALLOWEEN_IMPLEMENTATION_RECORD.md` for the pilot; that record stays as historical evidence of the candidate it describes (it carries a banner saying so).

---

## 1. Authority in force — UG-IV-GATE-005, UG-IV-GATE-005A and UG-IV-GATE-006

**UG-IV-GATE-006** authorizes one bounded local correction: *a final with zero valid votes must never publish all finalists as shared winners* (§14). It adds no cancellation, reopening, extension or manual winner selection, and approves no policy value.

Per 005A the requirement to locate or read UG-IV-GATE-004 is **eliminated**; this record does not reconstruct it and does not use the earlier inactive proposal as authority. Where 005 / 005A differ from anything earlier, they prevail. The consolidated pilot contract (005A §3) is what the code implements:

* two rounds, both voted **inside URBANO Gaming**; Instagram promotes and links, it adds no vote and **no Instagram integration exists**;
* a voter needs a **verified email and a complete Gaming Member**; no telephone, WhatsApp or SMS anywhere;
* the **preliminary** is voted by remote and in-person users alike, with **no location**; the **final** only by people at the venue, with the geofence evaluated for **every vote and every revision**;
* one favorite per round, revisable until the round closes; the same identity may vote in both rounds and nothing accumulates;
* ten finalists **plus those tied at the cut** (subject to the Product decisions that are still pending, §6); the final starts from zero and lasts **300 seconds from its explicit, authoritative opening**; ties for the final are **shared**;
* no self-vote; **per-contestant totals are hidden while voting**; closing, reviewing and publishing are three separate acts; no rewards, XP, redemption or mandatory marketing;
* Session keeps the lifecycle; Voting keeps candidates, votes and tally; no other runtime.

## 2. Disposition of the nine defaults (005A §5)

| # | Default | Disposition in this candidate |
|---|---|---|
| 1 | Consent texts | **Drafts for local tests only**; their review (Founder + counsel) **blocks the launch**. The 72-hour sentence is gone from both texts; gallery-consent version is now `halloween-2026-v3-gallery` (new wording = new version, digest stored). |
| 2 | Zero votes / zero-vote tie | **Pending Product policy; fails closed.** The cut cannot be confirmed while a would-be finalist has no votes, or nobody voted, until the policy is recorded (§6). Nobody is advanced by default. |
| 3 | Withdrawal after the cut | The finalist selection is **never edited or refilled**. A finalist who withdraws afterwards **blocks** preparing and opening the final and publishing either round until `FINALIST_WITHDRAWAL_AFTER_SELECTION` is recorded (§6). |
| 4 | Finalist bindings | Authorized server-side implementation: the unchanged GATE-003 bind is called for each finalist's **canonical** identity; the identity trigger accepts it only for a confirmed email and an existing Gaming Member. No identity or profile is created, linked or merged. |
| 5 | Publication | Preliminary: the confirmed finalists, **no counts**. Final: the shared winners **after review**, no counts. What is announced is frozen in an **immutable snapshot** (§5). |
| 6 | Photographs before opening | Not assumed to wait for opening. **Permission to show a photograph** (approved + consented + association confirmed + not hidden + not withdrawn) is separate from **ability to vote** (round open, before the deadline). |
| 7 | External promo withdrawal | The system **records the request and opens one pending operational task** (kind `EXTERNAL_PROMO_REMOVAL`) whose text states plainly that it deletes nothing outside the system (for example on Instagram); a person resolves it with a note. |
| 8 | 72 hours | **Not approved policy; no automatic effect and no substitute duration.** No removal instant, no purge function or route, no expiry of the gallery, no retention constant, no "72"/"horas" in any text. Bytes are erased only by an explicit act (reject, replace, privacy action). |
| 9 | Single operator | Unchanged: the one designated operator (the registration allow-list `COMMUNITY_VOTING_OPERATOR_MEMBER_IDS` fails closed) and the existing host-token + member enforcement. |

## 3. Preserved, removed, retained, added

**Preserved before anything was removed** (durable, outside the repository, checksum-verified before the first removal):
`/Users/hiltontoro/Development/gera-os/Projects/Urbano Gaming/Code Review/Reports/Returned/Identity and Voting/2026-10-29/UG-IV-GATE-005_evidence_20261029-133214/`

| Part | Content | Verification |
|---|---|---|
| `01_original-snapshot-88/` | the first candidate (88 files): `candidate-v1.tar.gz` (sha256 `9e645b65e801cd55d20854809d6f689b37ea276cb4c9ec944fa475f812e262b0`), `MANIFEST.txt`, `SHA256SUMS.txt` (inventory hash `95e42a085c371da2f6dd3fa9c2f1271b5b86ebef59c03c19abffdc01f4a61eb4`) | extracted and compared file by file: 88/88 |
| `02_candidate-at-GATE-004A-141/` | the candidate as delivered at 004A (141 files, full tree + manifest; inventory hash `17b8237266079b45d2a1d508a000d7ab8704657158be692156c467caeb0b67e2`) | compared file by file: 141/141 |
| `03_records-and-evidence/` | the earlier records, plans, load log, mutation logs, the red-run results of this gate | new files only; nothing overwritten |
| `04_final-candidate/` | the **final** active inventory with hashes, the obsolete-route proof, the full test results | written at the end of this gate |

**Removed from the active candidate** (all preserved above): the three ranked migrations (`20261028120000/100/200`); `lib/gaming/communityVoting/ranked/` (17 modules: ballot rules, weighted results, phone number/provider, repository and routes support); `app/api/gaming/community-voting/ranked/` (24 routes); the media-purge route of the pilot; the three earlier pages (`community-voting.html`, `community-voting-operator.html`, `community-voting-display.html`) and their scripts (`communityVotingVoter.js`, `communityVotingOperator.js`); the five ranked test files (their reusable assertions were **migrated**, §9).

**Retained, untouched and hash-pinned by a test:** the four GATE-003 migrations (`20261020190000…190300`) and `lib/gaming/communityVoting/verifiedIdentity.ts`; every GATE-003 module and route. Ordinary Sessions behave exactly as before (the full `npm test` and the contract suites of the other products pass).

**Preserved files that differ from the GATE-003 baseline, additively (three):** `lib/gaming/communityVoting/types.ts` and `httpSupport.ts` (the pilot's typed error codes — the codes of the superseded ballot and telephone steps were **removed**), and `__tests__/communityVotingSupabase.contract.test.ts` (three closed-inventory assertions brought to the final inventory: 16 pilot tables, 4 security-definer lookups, 2 starters).

**Carried over (reusable) into the pilot's own files:** the photograph sanitizer, per-voter ordering, operator allow-list and credential resolver (`rounds/jpeg.ts`, `ordering.ts`, `operatorAuth.ts`, `operatorRequest.ts`), the email identity verifier (`rounds/identity.ts`), the contestant-number / claim-credential / photograph / consent / decision / association / atomic-open functions (rewritten as `*_community_voting_round_*` in the pilot's migration), and the shared page helpers (virtual grid window, deck navigation, swipe, photo resize, claim-code format) now in the pilot's two scripts.

## 4. Composition

`Event Template → Experience Instance → Session (VOTING) → Voting Interaction`. Two Instances / Sessions — **preliminary (P)** and **final (F)** — each with one VOTING interaction. The Instance mode `FAVORITE_ROUND` carries the pilot; `SINGLE_CHOICE` (GATE-003) is untouched.

* **Session** keeps the lifecycle: open = `start_session_atomically` (same transaction-local marker mechanism), close = `close_submissions_atomically`, publication = `reveal_results_atomically`; a trigger on `interaction_instances` refuses any other transition for a round.
* **Voting** is the only store of candidates and votes (`voting_candidates`, `votes`, written by the **unchanged** `cast_vote_atomically`). Tallies are derived from `votes`.
* A final's entries **reference** the preliminary entry they descend from (`source_entry_id`): photograph, consent, privacy action and withdrawal belong to the *person* and are not copied.

## 5. The six separate things (005 §6)

| Thing | Record | Rule |
|---|---|---|
| **Photograph visibility** | `community_voting_photo_privacy_actions` (+ the photograph's own state) | `hide_community_voting_round_photo_atomically` hides it **in both rounds** at any time and erases the bytes (`PRIVACY_REQUEST`). It does **not** withdraw the candidature, touch a vote, alter a selection or change a result; a contestant whose photograph is hidden still takes part. Erasing bytes is **not** claimed to be legal erasure: metadata, consents, decisions and the audit trail stay. |
| **Candidature withdrawal** | `community_voting_withdrawals` | Cascades across both rounds in one transaction; excludes the contestant from every ranking, total and gallery; refuses new votes for them; **never deletes or edits a vote**; erases the photograph **only if the operator asks** (`p_hide_photo`), and then through the privacy action. Possible at any time. |
| **Vote evidence** | `votes` (the unchanged Voting store) | No function deletes or edits a vote; insert/update/delete on a round's votes are refused for everyone but the round's own cast. |
| **Finalist selection** | `community_voting_finalist_selections`, `community_voting_finalists` | Append-only. A withdrawal after the cut neither edits it nor fills the place. |
| **Reviewed result** | `community_voting_round_reviews` | A digest (`cvrev2`) of the closed result, the cut, **who has withdrawn** and **the approved Product decisions**: any change to who is eligible, or to a decision, makes the review **stale** (`REVIEW_STALE`) and a publication is refused until it is made again. |
| **Published result** | `community_voting_publications`, `community_voting_published_results` | The finalists' (or winners') public numbers and their order, frozen at publication, **never a count**, immutable. A contestant who withdraws afterwards is not removed from what was announced; the operator's overview flags it (`publishedAffected`). |

Order of the publication's own refusals: already published → not closed → not reviewed → review stale → Product decision pending.

## 6. Pending Product policies — they fail closed

`community_voting_policy_approvals` (append-only, once per pair of rounds, operator-only, requires a reference to the decision). Only the value the system can execute is accepted; nothing is approved by default and nothing is inferred.

| Key | Supported value | Blocks while undecided |
|---|---|---|
| `ZERO_VALID_VOTES_PRELIMINARY` | `ALL_ENTRIES_ADVANCE` | the finalist cut, when nobody voted for an eligible contestant (a vote for a contestant who withdrew is no valid vote) |
| `ZERO_VOTE_ENTRIES_AT_CUTOFF` | `TIED_ZERO_VOTE_ENTRIES_ADVANCE` | the finalist cut, when a would-be finalist has no votes (a small field, or a tie of zeros at the cutoff) — read conservatively |
| `FINALIST_WITHDRAWAL_AFTER_SELECTION` | `EXCLUDE_WITHOUT_REFILL` | preparing the final, opening the final, and publishing either round, once a selected finalist has withdrawn |

The refusal is `CV_POLICY_REQUIRED` (TypeScript `POLICY_REQUIRED`, HTTP 409) and **names the key**; nothing is written and nobody advances. Approving one key does not unblock another. Recording a decision changes the review digest, so a review taken earlier must be made again. Approving a different value would need a code change, not a click.

## 7. The schedule — Honduras time, binding where it matters

Times are instants in the database; the event's zone is `America/Tegucigalpa` (UTC−6, no daylight saving time) and is applied by the pages, never by the tablet's zone. **31 October 2026:** registration and photographs 19:00–20:30 (`2026-11-01T01:00Z–02:30Z`), preliminary 20:30–21:30 (`02:30Z–03:30Z`), then a final of 300 seconds from its own opening.

| Field | Effect |
|---|---|
| `registration_opens_at`, `voting_opens_at` | information shown to the public ("programada", never "abierta"); opening is **always** the operator's explicit act |
| `contestant_cutoff_at` | **binding**: a new contestant or photograph is refused at or after it (`CUTOFF_PASSED`, `>=`) |
| `voting_closes_at` (preliminary) | **binding deadline**: required and in the future to open (`SCHEDULE_REQUIRED`); a vote is refused at or after it whether or not the operator has closed; **a late opening does not extend it** |
| final | no configured closing: its deadline is its **opening plus 300 s**, from the interaction's authoritative creation time |

The deadline is evaluated by one pure function (`community_voting_deadline_open(deadline, now)`: strictly before; no deadline fails closed) with `clock_timestamp()` **after** the Session and binding locks are held, so a request that waited for the lock across the deadline is refused and stores nothing. A replay of an already-applied intent is still answered. The schedule is editable any number of times **until the round opens**, then frozen by the function and by a table trigger (an opened round's deadline cannot be edited, extended or shortened). Ordering is enforced (registration ≤ cutoff ≤ opening < closing, cutoff < closing; `SCHEDULE_INVALID`).

**Pages.** The server answers with `deadlineAt`, `serverNow`, `deadlineRemainingMs`; the phase and the countdown come from the server's clock (a phone with a wrong clock cannot open or close a round on screen). The operator form takes date and time **in the event's zone**; a button **only fills in** the 31-October template — it saves nothing, creates no event and opens nothing (page load makes no creating or opening request).

## 8. Identity, the cut, results

* **Identity:** verified email + Gaming Member, checked on the server on every request and by a database trigger for every writer; the binding records the canonical `gaming_member_id`; the cast re-checks both on every vote and every replay. GATE-003's phone policy is untouched.
* **Finalist cut:** standard competition rank among contestants who have not withdrawn; finalists are rank ≤ 10 (ties at the tenth all advance; ten or fewer all advance — subject to §6); no list from the caller; idempotent. A final is prepared from the cut only, one entry per finalist who has not withdrawn.
* **Totals** exist only after the round has closed and only for the operator; voters and the public never receive a count, rank or tally.
* **Winners of the final:** rank 1 among contestants who have not withdrawn **and a highest valid count greater than zero**. A final that closes with no valid vote has **no result at all**: nothing is published, no winner snapshot is written, and the operator is told it needs an explicit resolution (§14). A *valid* vote is a vote for a contestant who has not withdrawn — the same definition as the finalist cut; a vote for a contestant who withdrew stays in the table as evidence but counts for nothing.
* **TypeScript twins** of the rules (`rounds/finalists.ts`: ranks, cut, `cutPolicyRequirement`, the three digests) agree with the database on the same vectors.

## 9. Tests: migrated, replaced, removed

The five ranked test files were deleted **after** their reusable assertions were carried over unchanged (or adapted to the pilot's names) into the pilot's suites:

| Ranked assertions | Now in |
|---|---|
| per-voter ordering (algorithm id, permutation, determinism, balance over 1,200 voters), photograph sanitizing (EXIF/GPS removal, idempotence, limits, hostile input), operator allow-list (fail closed) | `communityVotingRoundsCore.test.ts` |
| virtual grid window, deck navigation, swipe, photo resize, claim-code format, public display rotation | `communityVotingRoundsUiLogic.test.ts` |
| grants and RLS, REST/42501 refusals, geofence-by-mode, operator authority for every operation, registration, audit trail; contestant numbers and credentials, JPEG pair, invalid photographs, supersede, consent, decision, removal; association (claim, look-alikes, failure counting, one entry, confirm/void); the atomic open (one step, readiness chain, ≥ 2, concurrency, rollback, freeze); evidence, counters, public-data privacy, 130-contestant gallery | **`communityVotingRoundsPreparation.contract.test.ts` (new, 33 tests, real Postgres)** |
| what described the five-option ballot, telephone possession, weighted results or a retention clock | **not carried over** — it no longer exists (proved by `communityVotingRoundsCorrection*.test.ts`) |

**Updated:** `communityVotingRoundsCore/UiLogic/Pages/Routes/Supabase` to the corrected API (deadline, no retention, review digest v2, schedule, policies, hide/withdraw, tasks), and `communityVotingSupabase.contract.test.ts` (closed inventories). **New for the corrections:** `communityVotingRoundsCorrection.test.ts` (39) and `communityVotingRoundsCorrection.contract.test.ts` (37) — **written first and run red against the uncorrected candidate** (39 node tests → 36 red; 37 DB tests → 37 red on the missing API, 34 red on behavior with a temporary name shim; the 3 that passed were guards already correct). The shim was removed. Earlier tests were **not** relabeled red-first.

---

## 10. Evidence

All of it local, on an isolated loopback stack (Postgres 17 + PostgREST + GoTrue; containers `ughw-*` on ports 55432–55435, credentials in a mode-600 file deleted at teardown), synthetic identities. **No provider, no real OTP, no Preview/Production.** The Founder's server on port 3410 and every other session's processes were not touched.

### 10.1 Migrations and clean rebuild

The pilot is **three** migrations, **self-contained** on top of the four GATE-003 ones (which are untouched and hash-pinned). Nothing of the superseded ranked runtime is installed to reuse its media tables.

| Migration | What it holds |
|---|---|
| `20261029100000_community_voting_two_round_foundation.sql` | mode `FAVORITE_ROUND`, round columns and constraints, `gaming_member_id`, `claim_failures`, `source_entry_id`; schedules, photographs, consents, decisions, privacy actions, withdrawals, closures, finalist selection and finalists, **policy approvals**, reviews, publications, **published results**, promotional consents, **follow-up tasks**, the audit trail; RLS and privileges |
| `20261029100100_community_voting_two_round_functions.sql` | every operation (register, schedule, entries, photographs, consent, decision, claim, confirm, privacy action, candidature withdrawal, policy approval, task resolution, open, **cast**, close, cut, final preparation, review, publication) and every read |
| `20261029100200_community_voting_two_round_guards.sql` | table guards for every writer; replaces two GATE-003 guard functions (`community_voting_guard_entries`, `community_voting_guard_binding_update`) with extended, behavior-preserving versions |

Final Community Voting migration inventory: **7 files** (the four GATE-003 + these three). **Clean rebuild:** the stack was torn down and rebuilt from scratch with the final set **three times** during this gate; each time all **292** migration files applied with no error (GATE-003 + pilot, plus the rest of the platform). Database check after the rebuild: no function matching ranked/phone/ballot/purge exists; the only Community Voting functions callable by `anon`/`authenticated` are the three bare lookups the Session guards need.

### 10.2 Test results (final run on the clean stack)

| Suite | Result |
|---|---|
| `npx tsc --noEmit` | clean (0 errors) |
| `npm run build` | succeeds; the built route manifest has **41** Community Voting routes in exactly two families, `instances` and `rounds`; none contains `ranked` or `media-purge` |
| `npm test` (the repository's registered behavioral suite) | **41 files, 1,627 tests pass** at GATE-005A (**47 files, 2,069 after GATE-007 registered the pilot's six behavioral files**, §15) |
| Pilot node tests (run by path at that time; **registered in GATE-007**, §15): `communityVoting`, `…RoundsCore`, `…RoundsCorrection`, `…RoundsPages`, `…RoundsUiLogic` | **391 pass** (180 + 68 + 39 + 43 + 61) |
| All contract suites, **serially, one run**: the 24 registered by `test:contract` + the 5 Community Voting ones | **29 files, 995 tests, 0 failed, 0 suite failures** (a clean run; no hook timeout). An earlier identical run, before the five guard tests of §10.5 were added, gave 29 / 990 / 0. Raw results: `all-contract-serial.json` |

The Community Voting contract files in that run: `communityVotingSupabase` (GATE-003, 122), `…RoundsSupabase` (54), `…RoundsPreparation` (33, new), `…RoundsCorrection` (42, new), `…RoundsRoutes` (18, HTTP edge with a real local Auth service). `package.json` was **not** touched in GATE-005A/006 (**registered in GATE-007, §15**): the pilot's test files were **not registered** in `npm test` / `test:contract` (a one-line follow-up for the commit gate, listed in §11).

### 10.3 Red-first, honestly

The corrections were written as tests **first** and run against the uncorrected candidate: the 39 node tests gave 36 red; the 37 database tests gave 37 red on the missing API and, with a temporary name shim to separate naming from behavior, 34 red on behavior (the 3 that passed were guards that were already correct). The shim was removed. Evidence: `03_records-and-evidence/gate005-red-*.{json,txt}` in the durable folder. Earlier tests were **not** relabeled red-first. Five guard tests were added **after** the mutation checks showed those guards were only covered indirectly (§10.5).

### 10.4 Obsolete routes are unreachable (not merely unused)

After `npm run build`, the candidate's **own** `next start` on a free loopback port (**not** 3410) answered **404** — the framework's not-found page, not a route's JSON — for: the three earlier pages and their two scripts; `POST /api/gaming/community-voting/ranked` and its `info`, `ballot`, `phone/start`, `phone/check`, `binding`, `operator/open`, `operator/results` and `operator/media-purge` routes; and `…/rounds/<id>/operator/media-purge`. In the same run the pilot's own pages and routes answered (200 / its own typed 401 / its own typed 404 `INSTANCE_NOT_FOUND`), and GATE-003's routes still answered. Full transcript: `obsolete-route-proof.txt`. The database no longer has the ranked functions, tables, `RANKED_TOP_5` mode or phone columns either (asserted by `communityVotingRoundsCorrection.contract.test.ts`). The server was stopped afterwards by its own PID.

### 10.5 Sensitivity (mutation checks on the corrections)

32 mutations, each applied to ONE function (or dropping ONE trigger) of the live validation database, run against the correction suite, then restored from the migration file (definitions verified identical to the baseline afterwards, both runs). **31 were killed.** The first pass killed 25 and showed six that survived because those guards were only covered indirectly (a policy approval written around the function, the announced-result guard, a hidden photograph whose bytes were still present, a new photograph after a privacy action, a vote deletion) plus one mutation that did not apply (a wrong pattern, fixed). Tests were added for each; the second pass killed them. **One mutation survives and is equivalent:** `C20` removes the *withdrawn contestants* from the review digest, but the round digest already omits a withdrawn contestant's row, so any withdrawal changes the digest anyway; the explicit field is kept as defense in depth. Logs: `mutation-corrections-run1.log`, `mutation-corrections-run2.log`, the runner `mutate-corrections.cjs`. (The earlier 004A candidate's mutation logs are preserved untouched in `03_records-and-evidence/`; they describe functions that no longer exist.)

### 10.6 Load rehearsal (indicative only: one machine runs the database, PostgREST and the driver)

Re-run **once**, because the cast gained a deadline read and the migrations were rebuilt: 100 contestants, **1,000 voters** in each round with ~20% revisions. Preliminary: all 1,000 first votes accepted in **5.1 s** (196 voters/s including bind, status, intent and revisions); final (a location with every vote): 1,000 accepted in **4.9 s** against a 300 s window. Vote latency p50 ≈ 35 ms, p95 ≈ 100 ms, p99 ≈ 150 ms; **no errors**; vote rows equal the sum of the per-contestant totals and the closure's count; the stored digests equal the TypeScript rules' (`true` in both rounds and for the cut); one vote row per identity per round, none with more than two overall. Log: `load-rounds-005.log`. It is not a venue test.

### 10.7 A real browser (the part jsdom cannot show)

The candidate's own server, a phone-sized viewport, two seeded rounds (synthetic data, one generated metadata-free JPEG): the **scheduled** round reads *"La votación está programada para las 20:30 (hora de Honduras), pero aún no está abierta: la abre el equipo del evento"* with *"registro desde las 19:00 hasta las 20:30"* (the browser's own `Intl` formatted the event's zone correctly); the **open** round reads *"La votación está abierta … Cierra a las 17:02 (hora de Honduras)"* with the server-derived countdown `1:59:06`; the venue display shows the photograph (a real image served by the real route, `naturalWidth 64`) and *"Votación abierta · quedan 1:59:10"*; the operator page, signed out, asks for the operator's sign-in. **Not covered in a real browser:** the signed-in voter flow and the operator tablet (they need a mailed one-time code; they are covered by the jsdom page tests and the HTTP-edge contract suite with a real local Auth service) and any phone camera or location sensor.

### 10.8 Pinned files

The four GATE-003 migrations and `verifiedIdentity.ts` are compared by SHA-256 in `communityVotingRoundsSupabase.contract.test.ts` (`preserved base`); the ranked entries were removed from that list with the files themselves.

### 10.9 Reproduce

```bash
# an isolated stack and every migration (secrets are generated into a mode-600 file and deleted at teardown; loopback only)
bash stack-up.sh "<repo>"                       # Postgres 17 + PostgREST + GoTrue on 127.0.0.1:55432-55435; applies all 292 migrations to a FRESH database
zsh run-contract.sh "<repo>" __tests__/communityVotingRoundsCorrection.contract.test.ts   # and the other contract files, by path
npx tsc --noEmit && npm test && npm run build
bash stack-down.sh                              # destroys containers, network and secrets
```

---

## 11. What is open, what is NOT proven, and what the commit gate must do

**Product decisions still open (they block the launch or an operation, and nothing here decides them):**

1. **Consent texts** (gallery-and-contest, promotional): drafts for local tests; Founder + counsel review **blocks the launch**.
2. **The three policies of §6** (GATE-007: the screen now shows each as *Pendiente de aprobación del Founder* with its exact key and value, and a recorded one as *the operator's note*, not as an approval — §15) — what happens with a cut that has no valid votes, a would-be finalist with none, and a finalist who withdraws after the cut. The system fails closed until each is recorded; it can execute only the one value listed for each. A different decision is a code change.
3. **Photograph retention / erasure period.** None is approved; the hand-off's "approximately 72 hours" has no effect here (it asks to be returned as a blocker for legal/product approval). Until then bytes are erased only by an explicit act, and metadata, consents and the audit trail are kept; this is **not** a claim of legal erasure.
4. **External promotional use withdrawn:** who performs the manual removal and in what time; the system only records the request and the pending task.
5. **A final with no valid votes — RESOLVED AS A GUARD, NOT AS A POLICY (GATE-006):** the system now refuses to publish it (`CV_NO_VALID_RESULT`, HTTP 409), writes no winner snapshot and claims no award; votes and round evidence stay. What the event does *instead* (a re-vote, a cancellation, a manual choice) is **not decided and not implemented**: it needs an explicit resolution by whoever owns the event, and the system offers none of those paths. That is a new open decision for Product, not a key the system records.
6. **Real values:** the final's venue geofence (coordinates, radius, accuracy, margins — a **launch blocker**; the Honduras times of §7 were approved earlier and need no further confirmation unless they change), and what to communicate when a contestant announced as a finalist withdraws afterwards (`publishedAffected`).

**Not proven:** anything on a real device, camera or location sensor; the signed-in flows in a real browser; behavior against Preview or Production or any provider; the final's load at the venue's network; the laws and policies above. All database behavior was proven on a local loopback stack, not on the hosted database.

**Two launch blockers remain open and are NOT touched by GATE-006:** the **photograph retention duration** (none approved; item 3) and the **final venue thresholds** (coordinates, radius, accuracy, margins; item 6). The **previously approved schedule** (§7) needs **no further Founder confirmation unless it changes**.

**Test registration is a separate implementation step**, done before a content-frozen commit gate: the commit gate itself must perform **no functional cleanup and no test-registration edit**. `package.json` and every package registry were not modified in GATE-006. **Done in GATE-007 (§15), as that separate step.**

**For the commit gate (no cleanup or functional change should be needed):** *(the registration below was done in GATE-007, §15; the rest stands)* register the pilot's test files in `test` / `test:contract` (one line each; `package.json` was deliberately not touched here — as a separate implementation step before the freeze, per the paragraph above); decide whether to keep `COMMUNITY_VOTING_HALLOWEEN_IMPLEMENTATION_RECORD.md` (it carries a *superseded* banner); apply the three migrations in order after the four GATE-003 ones. Three preserved files differ from the GATE-003 baseline additively (§3).

## 12. Final active inventory

**99 untracked files (97 before GATE-006 + 2 new test files), nothing staged, no tracked file modified.** By group: 7 Community Voting migrations (4 GATE-003 + 3 pilot) · 13 + 3 GATE-003 modules (`lib/gaming/communityVoting/` and `db/`) · 14 modules in `rounds/` · 10 GATE-003 routes + 31 routes in `rounds/` · 6 files in `public/` (3 pages, 2 scripts, the neutral slideshow rotation) · 12 test files + 1 fixture helper · 2 records. The full list with SHA-256 per file and the **inventory hash** (SHA-256 of `SHA256SUMS.txt`, computed after this record's last edit, so it covers this file) is in the durable folder, `04_final-candidate/{FILES.txt, SHA256SUMS.txt, INVENTORY_HASH.txt}` (the GATE-005A state, 97 files) and, for the GATE-006 state, `05_zero-vote-correction/final/{FILES.txt, SHA256SUMS.txt, INVENTORY_HASH.txt}` (99 files) with a verified copy of every file under `tree/`. The 141-file candidate of 004A and the 88-file original are in `01_` and `02_`.

**GATE-007 state:** still **99 untracked files** (no file was added or removed), but **two tracked files are now modified** — `package.json` (the two registry lines) and `__tests__/requireLocalSupabase.test.ts` (the contract-entry pin, 24 → 30) — so the manifest in `06_policy-clarity-and-test-registry/final/` has **101 entries** (99 + those two) and a `tracked-changes.diff`. The index is still empty and nothing is staged.

## 13. Prohibitions respected

No staging, commit, push, deploy, provider access, Preview or Production; no real OTP or message; no memory written; no agents; `package.json` untouched in GATE-006 (GATE-007 changed it, §15) and the parent repository untouched; no real event created or activated (page load makes no creating or opening request, and the schedule template only fills a form); the Founder's server on port 3410 and other sessions' processes untouched (only my own `ughw-*` containers and my own short-lived servers were started and stopped, by their own PIDs); no existing evidence overwritten (new files only in the durable folder).

---

## 14. UG-IV-GATE-006 — Zero-vote final guard and review evidence

**Authority:** UG-IV-GATE-006 only: one bounded local correction. It invents **no** cancellation, reopening, extension or manual winner selection, approves **no** policy value, and touches no package registry.

### 14.1 The defect, as found

A final that closes with no valid vote ranks every finalist 1st (standard competition rank: nobody has strictly more votes). Publication wrote "FINAL and rank 1" into the announced-result snapshot, so **every finalist would have been announced as a shared winner**, and the operator's results listed every contestant as a winner. Shared winners are only meaningful when the highest valid count is greater than zero.

### 14.2 The rule

* A **valid vote** is a vote for a contestant who has **not** withdrawn — the same definition the finalist cut already used. A vote for a contestant who withdrew stays in the table as evidence and counts for nothing.
* **Winners of the final:** rank 1 among contestants who have not withdrawn **and a highest valid count greater than zero**.
* A **final that has closed with no valid vote has no result.** Publication is refused with the stable code `CV_NO_VALID_RESULT` (TypeScript `NO_VALID_RESULT`, HTTP **409**). No publication row, no winner snapshot, no announced contestant, no reveal event; the interaction stays `SUBMISSIONS_CLOSED`; every vote and every round record is kept.
* The refusal comes **before** the review, stale-review and Product-policy checks. No review and no policy approval can create a result, and a stale review cannot bypass it: the operator is told "there is no result", not "a review is missing".
* It applies **only to the final**. A preliminary with no valid votes is a different case, governed by the existing Product policy `ZERO_VALID_VOTES_PRELIMINARY` (§6).
* An **open** final is never reported as having no result: the flag exists only after the round has closed.

### 14.3 Four independent layers (so no supported route bypasses it)

| Layer | Where | Refusal |
|---|---|---|
| Definition | `community_voting_valid_vote_count(uuid)`, `community_voting_has_no_valid_result(uuid)` (functions migration; `security invoker`, EXECUTE revoked from public/anon/authenticated) | — |
| 1. The only supported writer | `publish_community_voting_round_atomically`, right after the not-closed check | `CV_NO_VALID_RESULT` |
| 2. Publication table | `community_voting_guard_publication` (guards migration): refuses for **every** writer, including one holding the publication marker | `COMMUNITY_VOTING_NO_VALID_RESULT` |
| 3. Announced-result table | `community_voting_guard_published_results`: a `WINNERS` row needs rank 1 **and** a positive count | `COMMUNITY_VOTING_NO_VALID_RESULT` |
| Snapshot rule, operator view, TypeScript twin | snapshot insert (`r_votes > 0` for the final's winners); `read_community_voting_round_results` (`winner` needs `r_votes > 0`); `selectWinners` (`votes > 0`) and `validVoteCount` in `rounds/finalists.ts` | — |

The Session's own reveal remains refused outside the round's publication (`ROUND_PATH_REQUIRED`), asserted again for a zero-vote final. The operator overview now carries `noValidResult`.

### 14.4 What the operator sees

A card (`#noValidResult`) on the closed final: *the final closed with no valid vote, so there is no result to publish and no winner; votes and evidence are kept; the system does **not** offer to cancel, reopen, extend or choose a winner by hand — it needs an explicit resolution by whoever decides on the event.* The **Review** and **Publish** steps are disabled with that reason; the error text for `NO_VALID_RESULT` says the same. No control for cancelling, reopening, extending or choosing exists (asserted on the rendered page). Recording a review through the API is still accepted for such a final (it is evidence, and changes nothing); the screen simply does not offer it.

### 14.5 Red, then green

Tests were written **first** and run against the candidate as reviewed (before any change):

| File | Red | Of | Notes |
|---|---|---|---|
| `communityVotingRoundsZeroVote.contract.test.ts` (database) | **12** | 17 | the 5 that passed were guards already correct: a valid vote for one contestant is enough while another contestant's votes were withdrawn, a single vote is a result, the preliminary is unaffected, a not-closed final keeps its own refusal, and the Session's own reveal is refused outside the round path. The positive-tie test was red too, but only because it also asserts the new `noValidResult` flag is `false` for a final that has a result (the field did not exist: `expected undefined to be false`); publishing shared winners at a positive tie already worked and is preserved |
| `communityVotingRoundsZeroVote.test.ts` + `communityVotingRoundsPages.test.ts` (node) | **7** | 56 | `validVoteCount`/`selectWinners`, the 409 mapping, the operator text and checklist, the card |
| `communityVotingRoundsRoutes.contract.test.ts` (HTTP, real local Auth) | **1** | 19 | publish over HTTP: 409 `NO_VALID_RESULT`, nobody announced |

**20 red in all, for the intended reasons** (publication succeeded and announced every finalist; every contestant flagged as a winner at zero votes; the helpers, code and notice did not exist). Raw results: `05_zero-vote-correction/red/`. Earlier tests were not relabeled red-first. The 18th database test (an open final is never reported as having no result) was added **after** a mutation check (§14.6), not red-first.

**Green**, after a clean rebuild of the stack (all **292** migrations applied with no error):

| Run | Result |
|---|---|
| New database file (focused) | **18 / 18** |
| Affected suites: Routes (HTTP), Correction, Preparation, rounds Supabase, GATE-003 Supabase, ZeroVote | all pass (Routes 19, Correction 42, Preparation 33, rounds Supabase 54, GATE-003 122, ZeroVote 18) |
| **All contract suites, serially, one run** (the 24 registered + 6 Community Voting) | **30 files, 1,014 tests, 0 failed, 0 suite failures** (995 of GATE-005A + 18 new database + 1 new HTTP) |
| Pilot node tests (`communityVoting`, `…RoundsCore`, `…RoundsCorrection`, `…RoundsPages`, `…RoundsUiLogic`, `…RoundsZeroVote`) | **404 / 404** (180 + 68 + 39 + 45 + 61 + 11) |
| `npx tsc --noEmit` | clean |
| `npm run build` | succeeds; still **41** Community Voting routes in two families; no ranked or purge route |
| `npm test` (registered behavioral suite) | **41 files, 1,627 tests pass** when the files are run one at a time (`npm test -- --no-file-parallelism`). With the default parallel workers, on a machine loaded by **another session's** test workers (load average ≈ 8.6), one timing-sensitive page test of an **unrelated** area, `hostDirectPageReadiness.test.ts` (Become a Host, closed state), failed in three consecutive runs (1, 1 and 2 tests) while it passes alone (27 / 27, three of three). It is not touched by this gate; this is reported, not hidden |

**Not repeated, by instruction:** the load rehearsal (this correction does not change voting, only publication). Raw results: `05_zero-vote-correction/green/`.

**Two existing tests had to change**, and they are called out because both encoded the situation the gate corrects:

1. `communityVotingRoundsCore.test.ts` asserted that a tie of **zeros** shares the win (`[1, 2, 3]`). That assertion *was* the defect; it now asserts a tie at a positive count (`[2, 2, 2]` → all three) and that a tie of zeros has **no** winners.
2. `communityVotingRoundsCorrection.contract.test.ts` — "BLOCKS the publication of the final when a finalist withdrew…" — cast all its votes for the contestant who then withdrew, which now builds a final with no valid result and is refused earlier (`NO_VALID_RESULT`). It now also casts valid votes for a second contestant, so the Product decision is what refuses. Its intent is unchanged; the zero-valid variant of the same situation is in the new file.

### 14.6 Sensitivity (mutation checks on the new guard)

14 mutations on the live validation database (`mutate-zerovote.cjs`), each restored afterwards (function and trigger signature identical to baseline): one change to one layer (Z01–Z10) and four composites that remove two or more layers at once (Z11–Z14). **13 killed; 1 survives and is equivalent.** `Z05` (the snapshot's own `r_votes > 0`) cannot be reached while layer 1 holds; the composites `Z11`/`Z12` that remove it together with other layers are killed by the remaining ones, and `Z14` (everything removed — the original behavior) is killed by 9 tests. The first pass left **two** alive: `Z05` (above) and `Z09` (the "no valid result" flag applied before the round had closed), which exposed a genuine gap; a test was added and `Z09` is now killed (`mutation-zerovote-Z09-rerun.log`).

### 14.7 Policies — what the system accepts, does, and requires

Nothing is approved by default, and **this gate approved none**. Only one value per key is executable; a different decision is a code change.

| Key | Supported value | Operational effect once recorded | While not recorded |
|---|---|---|---|
| `ZERO_VALID_VOTES_PRELIMINARY` | `ALL_ENTRIES_ADVANCE` | the finalist cut proceeds when nobody voted for an eligible contestant, and every contestant who has not withdrawn advances | the cut is refused (`POLICY_REQUIRED` naming the key) |
| `ZERO_VOTE_ENTRIES_AT_CUTOFF` | `TIED_ZERO_VOTE_ENTRIES_ADVANCE` | the cut proceeds when a would-be finalist has no votes (a field smaller than the cutoff, or a tie of zeros at it), and those entries advance | the cut is refused |
| `FINALIST_WITHDRAWAL_AFTER_SELECTION` | `EXCLUDE_WITHOUT_REFILL` | once a selected finalist has withdrawn, the final is prepared/opened/published without that person, nobody takes the place, the cut is unchanged | preparing and opening the final, and publishing either round, are refused |

**Who can record one:** only the instance's **designated operator** (`OPERATOR_REQUIRED` otherwise), signed in with a verified email and a complete Gaming Member, **and** holding the event's host token (`HOST_TOKEN_MISMATCH` otherwise), supplying a free-text **approval reference of 3–200 characters**. Once per pair of rounds, append-only, never changed. **The system cannot verify that the reference is a Founder decision** — the reference is a string, and the record shows who recorded it, not who decided it. Recording a policy changes the review digest, so an earlier review must be repeated.

**Does the screen distinguish a technical option from a Founder-approved choice? No, not clearly.** The "Decisiones de Producto" card says to record *the decision Product made, citing where it is recorded*, and it requires the reference. But it does **not** show the stored value or say that the system supports only that one; the question is worded as a yes/no ("¿Pasan todas…?") with a single "Registrar esta decisión" button, so the only action available *is* the "yes"; and nothing in the card marks the option as "technical, awaiting Founder approval" before it is recorded or "Founder-approved" after. This was **not changed** in this gate (not asked for). Recommended for the next implementation step: show the exact value and the label *"Opción técnica soportada — requiere la aprobación del Fundador"*, and say so in the confirmation.

**Superseded by GATE-007 (§15.2–15.3):** the screen no longer words the choice as a yes/no, shows the exact key, the one supported value, what recording does and what happens until then, marks every unrecorded policy *Pendiente de aprobación del Founder*, and shows a recorded one as an operator-recorded note. It still cannot verify that the Founder approved anything.

### 14.8 Limitations of this correction

* **A final with no valid votes now has no path to a result.** That is deliberate, and it is a **launch risk until Product decides** what happens in that case (the system offers none of: re-vote, cancellation, extension, manual choice). The decision must be made and implemented before the event if it is wanted.
* Recording a review for such a final through the API is still possible (evidence only); the guard does not depend on it.
* Everything was proven on a local loopback stack, not on the hosted database. No load, device, camera, location or provider test was run.
* `hostDirectPageReadiness.test.ts` is timing-sensitive under load (above); it is unrelated and unchanged.
* The pilot's test files, including the two new ones, were **not registered** in `package.json` at GATE-006; **registered in GATE-007** (§15).

---

## 15. UG-IV-GATE-007 — Policy clarity and test registration

**Authority:** GATE-006's zero-vote publication guard was accepted for the next local review stage; that does not accept the full candidate or authorize release. This gate did two bounded things — made the three pending policies unmistakably *unapproved options*, and registered the pilot's tests — with no staging, commit, push, provider, Preview, Production or agent. Backend behavior is unchanged (no migration, no SQL, no route, no repository file was touched), so database contracts, mutations and load were **not** re-run, by instruction.

### 15.1 Starting state (verified before any edit)

HEAD `a816e40`, index empty, stash empty, 99 untracked files, 0 tracked modifications, every file's SHA-256 identical to the GATE-006 manifest (0 drift), inventory `8ed2dc636a3efaa6b6b2c362c6682ca1c9b212f72e45c1cf149c4c05b4355743`. No differences to report.

### 15.2 The policy interface

For **every** policy the card now shows, from `communityVotingRoundOperator.js` (`POLICY_INFO`, all statements — none is a question):

| Key | The one value the system can execute | When it applies | If recorded | Until recorded |
|---|---|---|---|---|
| `ZERO_VALID_VOTES_PRELIMINARY` | `ALL_ENTRIES_ADVANCE` | only if the preliminary closes with no valid vote (a vote for a withdrawn entry does not count) | the cut can be confirmed; every entry that has not withdrawn goes to the final | if that happens, the finalist cut is refused |
| `ZERO_VOTE_ENTRIES_AT_CUTOFF` | `TIED_ZERO_VOTE_ENTRIES_ADVANCE` | only if there are valid votes but an entry with none would fall inside the cut (small field or a tie at zero) | the cut can be confirmed; those entries advance | if that happens, the finalist cut is refused |
| `FINALIST_WITHDRAWAL_AFTER_SELECTION` | `EXCLUDE_WITHOUT_REFILL` | only if an already-chosen finalist withdraws after the cut | the final goes on without that person; nobody takes the place; the cut is unchanged | if that happens, the final is not prepared or opened and neither round is published |

Each unrecorded card also shows: the exact key and value in monospace, the status **`Pendiente de aprobación del Founder`** (a separate chip says **Bloquea ahora** when it is holding an operation right now — that is an effect, not an approval status), and the notice *«Tu autoridad como operador no aprueba esta política: la aprueba el Founder, fuera de esta pantalla. Registrarla aquí solo deja constancia, a tu nombre, de esa aprobación; la aplicación no puede verificar que exista.»*

The ambiguous yes/no control is replaced by one action, **`Registrar decisión aprobada`**, which needs (1) a decision reference of at least 3 characters (where the Founder's approval is recorded) **and** (2) an unticked-by-default acknowledgement checkbox — *«Confirmo que el Founder ya aprobó esta política con este valor exacto, y entiendo que solo registro una constancia que la aplicación no verifica.»* — and then (3) a last confirmation dialog that repeats the key, the exact value, the reference as typed, and *«la aplicación no verifica que el Founder haya aprobado este valor. Se registra una sola vez y no se puede cambiar.»* Cancelling records nothing. A missing acknowledgement or a short reference is refused with a message naming which one, before any request.

**After recording**, the card shows the status **`Registrada por el operador`**, *Valor registrado* (the value the **server** holds, verbatim), *Referencia citada por el operador*, and *«Constancia registrada por el operador. La aplicación no verificó que el Founder haya aprobado este valor.»*, plus the effect in force — but only when the stored value is the one this page knows; for any other value it shows the value verbatim and claims no effect. It never says *Decidida*, *Aprobada* or *verificada*, and offers no way to record or change it again.

**Nothing is preselected, filled in, ticked or recorded by the page.** The single call that records a policy sits behind the confirmation dialog (pinned by a test), and loading the page, pressing a held step, cancelling the dialog or a refused request all send nothing or leave the card pending. **Server authorization and audit are unchanged:** same route, same body (`policyKey`, `policyValue`, `approvalReference`), same operator / host-token / verified-email / complete-member checks, same once-per-pair append-only table. The overview carries the stored value and reference but **not** who recorded it or when, so the page does not show them (the audit row has both).

**One vocabulary on the screen.** The checklist reason, the refusal messages and the card now name the same authority: *«Pendiente de aprobación del Founder: …»* (was *«Falta la decisión de Producto: …»*), *«Falta registrar una decisión aprobada por el Founder…»*, *«Esa política ya está registrada y no se puede cambiar.»*; the card heading is *«Políticas que requieren aprobación del Founder»*. Otherwise the page would have named Product on one line and the Founder on the next.

### 15.3 Does the screen now distinguish a technical option from a Founder-approved choice?

**Yes, within a hard limit.** Before recording, every policy is labelled as pending the Founder's approval and as the system's only executable value; the operator is told in the card and the dialog that their authority does not approve it. After recording, the card says it is the operator's note and that the application did not verify the approval. **The limit:** the system still cannot know that the Founder approved anything — the reference is a string. A person with the operator role who ticks the box and types any text creates the record. The wording makes that plain; it does not prevent it. Preventing it would need an identity-bound Founder approval step, which was not asked for and is not built.

### 15.4 Test registration

**The twelve active Community Voting test files** (everything under `__tests__/` named `communityVoting*`; `hostAvailability.test.ts` only *mentions* Community Voting and was already registered): registered **exactly once**, appended after the existing entries in alphabetical order, existing entries and their order untouched (the old list is an exact prefix of the new one).

* `npm test` (6, database-free): `communityVoting`, `…RoundsCore`, `…RoundsCorrection`, `…RoundsPages`, `…RoundsUiLogic`, `…RoundsZeroVote`.
* `npm run test:contract` (6, need a loopback database): `…RoundsCorrection.contract`, `…RoundsPreparation.contract`, `…RoundsRoutes.contract`, `…RoundsSupabase.contract`, `…RoundsZeroVote.contract`, `communityVotingSupabase.contract`.

Registry on the candidate's base: `test` 41 → **47**, `test:contract` 24 → **30**; 77 test files on disk = 47 + 30, none unregistered, no duplicate, none in both. `package-lock.json` untouched; `package.json` differs from the base only in those two lines. A checker (`06_…/registry/check-registry.cjs`, R1–R7) fails before the edit exactly on the twelve files and passes after.

**Registering contract files carries two obligations that the gate text did not name**, found by running the suite on a lane that already had them:

1. `__tests__/requireLocalSupabase.test.ts` has a *static inventory* that **pins the number of `test:contract` entries** (24 here, 34 on `origin/main`) and, for **every** registered contract file, requires a literal `import { requireLocalSupabase } …` and exactly one `requireLocalSupabase(supabaseUrl)` call **before** any client, `beforeAll` or `afterAll`. Every lane that registered contract files bumped that pin in the same commit; its history on `origin/main` is 19 → 22 → 24 → 27 → 28 → 30 → 31 → 33 → 34 (the first commit created it). Here: **24 → 30** (title and two numbers).
2. Four of the six Community Voting contract files (`…RoundsCorrection`, `…RoundsPreparation`, `…RoundsSupabase`, `…RoundsZeroVote`) were already safe — they import `helpers/roundsFixtures.ts`, which calls the same guard when it loads — but not in the literal form the inventory requires. Each now imports the shared guard, takes `supabaseUrl` from the fixtures and calls it once before anything else (a handful of lines per file — the import, the call and a two-line comment; no test logic touched). Without this, registering them would have failed `npm test`.

Both are edits to **tracked/existing test files** (`package.json`, `requireLocalSupabase.test.ts`) and to four contract files; they are listed in `06_…/changes/`.

### 15.5 Registry reconciliation across the lanes (nothing merged; read-only previews in scratch)

| Lane (ref) | `test` | `test:contract` | Relation to the candidate's base registry (`a816e40`: 41 / 24) |
|---|---|---|---|
| candidate base `a816e40` (= local `main`) | 41 | 24 | — |
| `integrate/join-session` `be3911c` | 43 | 25 | the base is an exact **prefix**; adds `competitionAdministration`, `competitionAdminPage` and `competitionAdministrationSupabase.contract` |
| `origin/main` `4fe7aa0` | 83 | 34 | the base is an ordered **subsequence** (42 / 10 entries added; 2 of the 42 and 4 of the 10 sit mid-list rather than at the end); 14 commits ahead of `a816e40` |

`be3911c` is **not** an ancestor of `origin/main`: the two accepted lanes have themselves diverged (main lacks those three competition-administration entries). Neither lane has a duplicate or an unregistered file. `package.json` differs from the base only in the two scripts on every lane. **No candidate path exists in either lane (0 collisions).**

**What integration will hit, mechanically:** (1) the `test` and `test:contract` lines of `package.json` (each is one line, so any two lanes that add an entry conflict textually); (2) the pin in `requireLocalSupabase.test.ts`. Both resolve by taking the target lane's own list/count and appending the twelve entries / adding 6 (**34 → 40** on `origin/main`, **25 → 31** on `be3911c`). That resolution was **built and run** in scratch copies (`git archive` of the lane + the 99 candidate files, never a merge): `origin/main` + candidate → **89 files, 3,744 tests, 0 failed, `tsc` clean**; `be3911c` + candidate → **49 files, 2,226 tests, 0 failed, `tsc` clean**; the registry checker passes on both. (The first attempt, before the guard edits and the pin, failed 13 tests in `requireLocalSupabase.test.ts` — that is how obligation 1 and 2 were found.)

**One cross-lane fact outside the registry, reported and not acted on:** `origin/main` carries migrations dated `20261021120000` … `20261028121000`, which sort **after** the candidate's first four (`20261020190000` … `190300`). None of the seven candidate migrations has been applied to any hosted database by this work. Whether they go in with an include-all push or are renamed is an integration decision; migrations are append-only only *after* deployment.

### 15.6 Red, then green

* **Red first (13 of 120 failed; tests as first written, against the unmodified candidate):** nine page tests and four logic tests, failing for the intended reasons — the old *«Cita la decisión de Producto…»*, the chip *«Decidida»*, no acknowledgement checkbox, no key/value fields, the old *«Registrar esta decisión»*. One new test (the POST body is unchanged) passed already, as it should. Raw: `06_…/red/red-policy.json`.
* **Replay of the final test text against the original operator files (identified by SHA-256) in a scratch copy: 16 red** — the 13 plus the 3 existing tests I then updated. Raw: `red/red-final-text-vs-original-ui.json`. (While finishing the tests I tightened one regex that would have matched the recorded notice's own *«no verificó que el Founder haya aprobado…»*; the replay shows that test is still red on the old page.)
* **Green:** the two affected files **120 / 120** (`…RoundsPages` 54, `…RoundsUiLogic` 66). First green run **117 / 120** — the three that failed are the three below, kept as evidence (`green/green-policy-first.json`).

**Three existing tests had to change**, because each pinned wording or a flow that this gate replaces: (1) the Pages test that records a policy now also ticks the acknowledgement and expects the missing-acknowledgement message first; (2) the Pages test of an already recorded policy now expects *«Referencia citada por el operador: ACTA-1»* instead of *«Registrada: ACTA-1»*; (3) the UiLogic test of the `POLICY_REQUIRED` message now expects *«decisión aprobada por el Founder»* instead of *«decisión de Producto»*. Plus `requireLocalSupabase.test.ts` (the pin, §15.4).

### 15.7 What was run (and what was not)

| Check | Result |
|---|---|
| Affected policy/page tests (`…RoundsUiLogic`, `…RoundsPages`), serial | 120 / 120 |
| Contract-registry static inventory (`requireLocalSupabase.test.ts`) | 152 / 152 (includes 24 per-file guard assertions for the six Community Voting contract files) |
| Registry completeness / duplicates (`check-registry.cjs`) | before the edit: R1–R5 pass, **R6 and R7 fail on exactly the twelve files**; after: R1–R7 all pass (77 on disk = 47 + 30) |
| Registered database-free suite, **serial**, sanitized environment (no Supabase variable), no database listening | **47 files, 2,069 tests, 0 failed** (the six pilot behavioral files: 418 tests; no contract file in the run) |
| `npx tsc --noEmit` | clean (exit 0, no output) |
| `npm run build` | succeeds; **41** Community Voting routes (the 10 GATE-003 `instances` routes unchanged); no ranked or purge route |
| Default **parallel** `npm test`, three runs each | pristine `a816e40` 41 files / 1,627: **3 / 3 pass**; candidate 47 files / 2,069: **3 / 3 pass** (load average 2–5) |
| Edited contract files, **no database**: (a) non-loopback target → the guard refuses at import, 0 tests run; (b) loopback target with nothing listening → the file loads and fails only with `ECONNREFUSED`, 0 syntax/import errors | all four files, both checks |
| Lane previews with the reconciled registry (§15.5) | `origin/main`: 3,744 / 0 failed; `be3911c`: 2,226 / 0 failed |
| Rendered operator page (pending, missing acknowledgement, last confirmation, recorded, portrait tablet) | `06_…/rendered/` (PNG + text); a harness serves the **real** page and scripts over loopback with a stubbed identity and a scripted fake API, and the Google Fonts tags removed — the logo icon is broken and the sign-in button inert **because of the harness**, not the page |

**Not run, by instruction (backend unchanged):** the database contract suites, mutation checks and the load rehearsal. **A consequence to state plainly:** the four contract files that got the explicit guard call were **loaded but not executed against a database** in this gate; their logic was not touched. Re-running them on a loopback stack (and the full serial contract run) is the reviewer's call.

### 15.8 The earlier parallel-suite failures, stated accurately

In GATE-006 `npm test` in default parallel mode failed three times in a row in `hostDirectPageReadiness.test.ts` (1, 1 and 2 of 27 tests). What the logs show is **not a timeout**: it is `expected undefined to be 'Host applications are not open yet'` — the closed-state heading was not on the page yet when the test looked. The test waits a **fixed 80 ms** (`settle(ms = 80)`) for a chain that includes the first dynamic `import()` of the availability route, instead of polling with the file's own `until()`. The file is **byte-identical on `a816e40` and `origin/main`**, so the race is not specific to this candidate and exists on the production lane.

What was **demonstrated** now, on a pristine export of `a816e40` with no candidate file at all: the file alone passes with no extra load (5 / 5; and 3 / 3 with two low-priority busy loops); with **10** busy loops (= the machine's 10 cores) it fails **3 / 3** and with **20** it fails **3 / 3**, every time on the same test with the same assertion text. Default parallel runs of the pristine tree and of the candidate passed 3 / 3 each at load 2–5. So: it is a timing race in an unrelated, pre-existing test, triggered by CPU oversubscription, and independent of this candidate.

What is **not** proven: that the three GATE-006 failures were caused by exactly that — they carry the same signature and ran while another session's workers were active, but nothing was instrumented at that moment, and the machine's *load average* is a lagging figure (it was 6–7 for the passing baseline here because it was still decaying from my own loops), so "load ≈ 8.6" was never evidence by itself. Which step of the chain is slow was not measured. I did not change that test; the likely fix (poll with `until()`) belongs to whoever owns that lane. Busy loops were my own, started at `nice 10`, recorded by PID and self-terminating; none remains. One of my own scripts counted down (`seq 1 0`), so the first "no contention" baseline actually had two loops — it is kept, relabelled `…WITH2LOOPS`, and a true zero-loop baseline was run instead.

### 15.9 Remaining launch blockers and open items (none of them decided here)

1. **Photograph retention / erasure duration** — none approved (§11 item 3). **Launch blocker.**
2. **Final venue thresholds** — coordinates, radius, accuracy, margins (§11 item 6). **Launch blocker.** The previously approved Honduras schedule (§7) needs no further Founder confirmation unless it changes.
3. **The three policies of §6** — each still **pending the Founder's approval**; none was recorded or approved by this gate. Until recorded, the dependent operation is refused.
4. **A final with no valid votes** has no path to a result (§11 item 5, GATE-006); Product must decide what the event does.
5. **Consent texts** (§11 item 1) and **manual removal of withdrawn external promotional use** (§11 item 4).
6. **Integration:** the candidate's base is 14 commits behind `origin/main` and `be3911c` diverged from it; the registry/pin resolution of §15.5 is mechanical and was demonstrated, but must be redone on whichever lane is the target; the migration ordering of §15.5 needs a decision.
7. **`hostDirectPageReadiness.test.ts`** is timing-sensitive under CPU contention (§15.8) — unrelated, unchanged, present on `origin/main`.

### 15.10 Prohibitions respected

No staging, commit, push, deploy, provider access, Preview or Production; no agents; no memory written; no migration, SQL, route or repository file changed; `package-lock.json` untouched. The Founder's server on port 3410 and other sessions' processes were not touched; the only processes started were my own (a loopback render server on port 3641, headless Chrome with a throwaway profile, `perl` busy loops at `nice 10`, vitest runs), each ended by its own PID or exit. No existing evidence was overwritten: everything new is in `06_policy-clarity-and-test-registry/`.

## 16. UG-IV-GATE-008A / UG-IV-GATE-009 — integration onto `4fe7aa0`, and the two defects a real browser found

*Nothing above this line was edited: the earlier sections stay as the evidence of the gate that wrote them. In particular §10.7 ("not covered in a real browser") was true when written; §16.4 says what was covered since.*

### 16.1 Where the candidate lives now
Branch `claude/identity-voting-integration-001`, created at `4fe7aa0c8238ee6c95a7a81f98b55c3c6d527ca7` (the base the Founder authorized for local integration; **this record does not assert it is the live or Production source**). The 99 candidate files are byte-identical to GATE-007's. Two tracked files were resolved by union: `package.json` (`test` 83 → 90 files, `test:contract` 34 → 41) and `__tests__/requireLocalSupabase.test.ts` (the pinned count 34 → 41). Migrations: the 301-file clean install and the 294-file destination followed by the seven Community Voting files produce the same normalized schema (1,481 object blocks, same grants and default privileges); the seven change one existing function (`join_participant_atomically`: the event-bound guard) and add six guard triggers on `voting_candidates`, `interaction_instances` and `votes`. How the four early files (`20261020190x`) are ordered against seven destination migrations that sort after them is a **release decision**, not made here.

### 16.2 F2 — public reads frozen by Next's Data Cache (corrected)
**Cause.** The platform's repositories build their Supabase client with `global: { fetch: (input, init) => fetch(input, { ...init, cache: "no-store" } as RequestInit) }`. Community Voting's three clients did not (`db/supabaseCommunityVotingRepository.ts`, which `SupabaseRoundsRepository` extends; `verifiedIdentity.ts`; `rounds/identity.ts`). In Next 14 the POST `rpc` call made inside a public GET route handler is stored in the Data Cache for a year, so `/info`, `/results` and `/slideshow` kept answering with the first thing they ever saw: a round that never "opened", a publication nobody could see, a withdrawn contestant still on the display, a countdown restarting from a frozen time.
**Correction.** Exactly the three clients got the platform's override; no route setting was added (a route-level `dynamic` would hide the problem for that route and leave the underlying entry), and no shared repository (`lib/gaming/auth.ts`, `db/supabaseGamingRepository.ts`, `session/db/supabaseSessionRepository.ts`, none of which has the override) was changed: the Community Voting routes that use them left no entry in the Data Cache in the runtime test or in the rehearsal (why a route that reads the request's headers first avoids it was not independently verified here; the measured result is what is claimed). `verifiedIdentity.ts` is a hash-pinned GATE-003 file: its pin is now "GATE-003's bytes plus ONLY the two override lines" (taking them away must give back the original hash).
**Proof.** `__tests__/communityVotingNextRuntime.contract.test.ts` builds the app if `.next/BUILD_ID` is older than `lib/` and `app/`, starts `next start` once on a free loopback port and drives the public reads while the round changes underneath: phase NOT_OPEN → OPEN → CLOSED, the countdown counting down, the publication visible at once, a hidden or withdrawn photograph gone from gallery, display and photograph (a conditional request is answered 404, never 304), one voter's status never answered to another, and **no new entry in `.next/cache/fetch-cache`**. Red against the uncorrected build (4 of 6 failed: the phase stayed NOT_OPEN, the publication stayed invisible, the display still listed the hidden photograph, six year-long entries were stored); green after (6 of 6, 0 entries).
**What is NOT promised.** The photograph is the one response that stays cacheable on purpose: `Cache-Control: public, max-age=60, s-maxage=60` (`PUBLIC_PHOTO_CACHE_SECONDS`). A copy a browser already holds can be shown for up to 60 seconds after a hiding, and an edge cache for the same time. It was measured in a real browser (an ordinary request 17 s after the copy was cached was served from the browser's cache); a revalidating or bypassing request was answered 404. Gallery, display and every later request stop listing and serving it at once. Hosted cache or CDN configuration was not inspected or changed.

### 16.3 F1 — the operator page and the destination's identity contract (corrected)
The destination's `public/urbanoAuth.js` announces a first-time member finishing the profile only to `onIdentityChange` listeners, and a change of person or a sign-out to `onIdentityReset` listeners, synchronously and before anything is looked up; `onAuthStateChange` keeps its original meaning (raw Auth events). The operator page listened only to `onAuthStateChange`, so after the profile step it kept saying "Completa tu perfil…". It now registers one `onIdentityReset` and one `onIdentityChange`, never reads storage for a round until the person is known, stores the round together with its owner (`ownerUserId`; a round without the signed-in owner is discarded), ties every request to an epoch (an answer that arrives after the person changed is dropped and shows nothing), clears the round, the host token and every form on a change of person, and clears an obsolete error or notice when the operation it was about succeeds. `urbanoAuth.js` was not modified. Proof: `__tests__/communityVotingOperatorIdentity.test.ts` runs the page with the REAL `urbanoAuth.js` against a fake Supabase client (red against the previous page: 8 of 9; green: 9 of 9), and the existing 54 page tests pass with their stub extended by the two identity methods.

### 16.4 Evidence of a real browser
One running production instance, never restarted and with no cache cleared between transitions, through preliminary opening, voting, revision, closing, cut, publication, the final (controlled coordinates: outside / denied / inside), the deadline, the closing and the publication of shared winners, a photograph hidden while the round was open, and the operator profile step without reload; mobile 375 and 390 and operator tablet 1024×768 and 768×1024, none with horizontal overflow. The coordinates are controlled by the harness and the geofence is made up: this proves what the page sends and how the server answers, **not** that the venue geofence works. No pending policy was exercised or recorded. Details: the durable evidence folder `08_gate-008a-local-integration/` and its sibling for GATE-009.

### 16.5 Remaining, unchanged
Photograph retention duration; the final venue thresholds; the three policies awaiting the Founder; the consent texts; manual removal of withdrawn promotional use; the migration order at the hosted destination; fresh remote and deployed-source verification before any release; observations in the evidence (a published finalist whose photograph was hidden renders as a broken image; the page offers a lobby lock only through the existing host step).

## 17. UG-IV-GATE-010 — The operator's geofence setup and the test event

*Nothing above this line was edited. §10.7 ("not covered in a real browser") and §16.4 stay as the evidence of the gates that wrote them; §17.6 says what a real browser covered since.*

### 17.1 What the Founder can do now, without a code change
On the operator page of a **final** (`public/community-voting-round-operator.html`) there is a **«Geocerca del lugar (la final)»** card:

- the six numbers of the venue geofence as editable fields (centre latitude and longitude, radius in meters, maximum accepted accuracy, inside margin, outside margin), each with a plain-Spanish explanation, and the saved values with when they were last saved;
- **«Usar mi ubicación»** reads this device's position **once** and only *fills a proposal* for the centre (with the accuracy the device reported). It saves nothing, tests nothing, opens nothing; it says the proposal is not saved. A reading less precise than the accuracy the venue asks of its voters proposes nothing and says why;
- a **local schematic** (an inline SVG computed from the numbers: centre, radius to scale, a scale bar, north up, and — after a test — the tested position with its accuracy circle). There is no map provider, no tiles, no API key and no external geocoding; the page says it is not a map;
- **«Probar mi ubicación»** reads the position and asks the server to evaluate it with the vote's own evaluator (§17.3);
- **«Guardar geocerca»**, an explicit button that is enabled only when the form differs from what is saved. The page validates before sending (finite numbers in range, field by field) and the server validates again.

Denied permission, unavailable location, timeout, a device without the sensor and insufficient accuracy each have their own message. The page says, next to the controls and next to every result, that browser location is an eligibility signal and not proof against a spoofed position.

The preliminary has no such card and never touches the sensor.

### 17.2 Server authority, locking, audit and freeze
`PUT …/operator/geofence` (route `app/api/gaming/community-voting/rounds/[instanceId]/operator/geofence/route.ts`) → `configure_community_voting_final_geofence_atomically` (migration `20261030100000_community_voting_geofence_setup_and_test_events.sql`).

- **Who and where.** Bearer of a verified Gaming Member **and** the Session's host token; the Instance is the one in the URL (nothing in the body — an id, a flag, a role — is read except the six numbers); the database proves the host token and that the caller is the Instance's *designated* operator, that it is a round, that it is a **final**, and that its Session has never opened voting.
- **Session-first locking.** The function takes the Session row lock before anything else (`community_voting_authorize_operator(…, true)`) — the same first step as `start_community_voting_round_atomically` and the cast — so a save and the opening **serialize**: a save that arrives while the opening holds the lock waits and is then refused (`GEOFENCE_FROZEN`, 409); an opening that arrives while a save holds the lock waits and opens with the saved geofence. Concurrent saves serialize too (their audit rows chain: each *old* is the previous *new*). Neither `start_…` nor `cast_…` was touched (md5 of their source is pinned by the contract test).
- **Freeze.** "Opened" means the Session has an interaction instance, which never goes away: editing never reopens after the close or the publication.
- **Validation.** `NaN`, `±Infinity`, missing values and every out-of-range value are refused by the database itself (`CV_INVALID_GEOFENCE_CONFIG`), not only by the TypeScript layer.
- **The immutability guard.** `community_voting_guard_instance_update()` still refuses everything. Its single exception needs all of: the transaction-local marker `urbano.community_voting_geofence` equal to *this* Instance's id (set by the operation, cleared before it returns), a FINAL, no interaction yet for its Session, and **no difference from the old row outside the six geofence columns** (compared as `to_jsonb(new) − cols = to_jsonb(old) − cols`, so any column — including one added later — stays immutable). Identity, Session linkage, round role, source, window, cutoff, creation time and the test flag cannot change. `service_role` has UPDATE on exactly those six columns (column privilege); the table-level UPDATE stays revoked, so `PATCH` of any other column is refused by privilege (42501) and of a geofence column by the guard.
- **Audit.** `community_voting_operator_actions` gains the action `CONFIGURE_GEOFENCE`; each save writes one row with the actor (`operator_member_id`), the time (`occurred_at`) and `detail = { old: {six numbers}, new: {six numbers} }`. The table is append-only as before.

### 17.3 The eligibility test
`POST …/operator/geofence/test` with `{ location: { latitude, longitude, accuracyMeters } }` → `test_community_voting_round_geofence`. The reading is validated as a vote's reading is (`validateLocationClaim`) and evaluated by **the same `community_voting_assess_location`** the cast calls, against the Instance's own stored geofence: `INSIDE`, `OUTSIDE`, `AMBIGUOUS` or `ACCURACY_EXCESSIVE` with the distance and accuracy the server saw (rounded as a vote's evidence is) and the thresholds it used; an invalid reading is `INVALID_LOCATION_READING` (400), exactly as a vote refuses it. The function is **STABLE** (the database refuses any write from it), takes no lock, creates no vote, intent, binding or audit row, and the reading is a parameter of the call only: not stored (the contract test searches every Community Voting table for the digits of a distinctive reading), not logged (the HTTP test spies on `console`), not echoed. It works before and after the final opens.

### 17.4 Test events
A round is a **test (rehearsal) round** only if it was registered as one (`testMode: true`, boolean only; the operator page has an explicit checkbox that says it cannot be changed). `community_voting_instances.is_test` is written by the registration function alone (the contract test lists every function whose source names it), cannot be changed afterwards (the update guard), exists only on a round (a CHECK), and a final must agree with the preliminary it descends from (`CV_TEST_MODE_MISMATCH`). It reaches the pages through the public info (`isTest`) and the operator overview. Every page shows **EVENTO DE PRUEBA** for as long as it shows a test round: the operator page (sticky banner + title `[PRUEBA] …`), the voter page (banner in every state + the published result block), and the venue display. A real round carries none of it. A test round has its own Session and Instance (an Instance is one-to-one with a Session, so a test and a real round never share an id); nothing opens or publishes a test round by itself; no function converts a real round into a test one or the reverse. This is a **label and a data separation, not infrastructure isolation**: a test round lives in the same database as the real event.

### 17.5 Small presentation corrections
- A published finalist whose photograph was hidden afterwards (the snapshot of the result is frozen, the picture is not) shows a deliberate **«Imagen no disponible»** placeholder instead of a broken image; the published number is untouched.
- The Session's lobby lock is an existing host step. The operator page now says so: while the Session is not `LOBBY_LOCKED` the *open* step is disabled with the reason, a notice explains what the lock is and that the host does it from the session's own panel, and a button re-reads the round. Nothing in the page locks the lobby or bypasses the requirement; an overview that does not say the Session's state blocks nothing (the server stays the authority).

### 17.6 Evidence
**Red first.** The three new files were written and run against GATE-009's candidate before any implementation: the database contract file 40 of 46 red (the six that passed pin what must NOT change), the behavioral file 30 of 31 red, the page file 25 of 27 red — every failure for the intended reason (a missing repository method, route, column, function or element). A defect the real browser found afterwards (a failed re-read left the previous test result on screen as if it were current) got its test after the fix and was shown red without it. Reports: `red/` in the evidence folder.

**Green.**
- New files: database contract 47 tests (clean install 47/47 and upgrade path 47/47) · behavioral 31/31 · pages 28/28.
- `npm test` (complete in-memory behavioral suite, parallel, scrubbed environment): 92 files, 3,820 tests, 0 failed (GATE-009: 90 files, 3,757; the difference is the 31 + 28 new tests and the 4 per-file checks the registry test makes of the new contract file).
- Full serial contract suite (42 files), on BOTH a clean 302-file install and the upgrade path (the 301 files of GATE-009, then this migration): clean install 42 files, 1,325 tests, 1,324 passed; upgrade path 42 files, 1,325 tests, 1,324 passed. The one failure on each stack is the destination's mail-dependent file, which needs a mail catcher and Auth with SMTP those stacks did not have; its re-run on mail-capable Auth: 7/7 on both.
- Fresh-install and upgrade schemas (pg_dump --schema-only, public + auth + storage, ACLs included) are byte-identical (sha256 `f7dc8d1ead91acdc8e0e16c823a496ad4e13c927a70c7cc4c55d8cc732f0c6ac`).
- The untouched functions are pinned by the md5 of their source: `cast_community_voting_round_vote_atomically`, `start_community_voting_round_atomically`, `community_voting_assess_location`, `community_voting_authorize_operator`, `community_voting_log_operator_action`.
- The previous gates' regressions stay green: the real-Next runtime test (zero Data Cache entries, per-user state, no-store) and the operator-identity tests.
- `tsc --noEmit` exit 0; `npm run build` exit 0 (43 Community Voting routes: the earlier 41 plus the two new ones); registry R1-R7 pass (134 test files on disk = 92 + 42).
- No load test: no vote path and no lock the vote takes changed (the vote's and the opening's sources are byte-identical); the new writer takes the Session lock the opening already takes, and its serialization is proved by observing the wait in `pg_stat_activity`.

**Mutation check of the new database guarantees** (each mutation changes ONE thing in ONE function on a scratch database, runs the geofence contract file, then restores):

| # | what is removed or weakened | tests that turned red |
|---|---|---|
| M1 | the save no longer refuses an opened final (the freeze check inside the operation is removed; the table guard is the only remaining line) | 4 of 47 |
| M2 | the table guard no longer checks that the Session never opened (the structural freeze is removed; the operation's own check stays) | 1 of 47 |
| M3 | the save no longer takes the Session lock first (authorize without the lock) | 3 of 47 |
| M4 | the table guard compares nothing outside the six columns (any column may change under the marker) | 2 of 47 |
| M5 | the table guard accepts the marker of ANY Instance (the marker is not bound to the row) | 1 of 47 |
| M6 | the eligibility test is no longer read-only: it writes an audit row (and is volatile) | 3 of 47 |
| M7 | the eligibility test ignores the margins (its own decision instead of the vote's evaluator) | 3 of 47 |
| M8 | the save no longer checks the designated operator (any Gaming Member holding the host token may save) | 4 of 47 |
| M9 | the save does not refuse the preliminary | 2 of 47 |
| M10 | the registration ignores the test flag (every round becomes a real round) | 7 of 47 |
| M11 | the pairing of a final with its preliminary's kind is not enforced | 3 of 47 |
| M12 | the save records no audit row | 5 of 47 |

Every mutation turned at least one test red, and the scratch database was restored after each (its function fingerprints equal the clean install's).

**Real browser** (`browser/EVIDENCE_TEXT.txt`, 24 screenshots): one `next start` process for the whole rehearsal, never restarted, Data Cache empty before, during and after. Tablet 1024x768 and 768x1024, phone 390 and 375 (no horizontal overflow at any of them); controlled readings inside / outside / ambiguous / insufficient accuracy, sensor failures (the page receives the browser API's error codes), proposal refused for a rough reading, an unsaved edit and a test result dropped by a sign-out, the lobby notice and re-check, the pairing refusal, the freeze and the 409 after opening, the vote with controlled positions, the banner on the operator, voter and display pages and none on a real round, the hidden-photograph placeholder. **The coordinates are controlled by the harness and the geofence is made up: this is not a venue test and says nothing about a real phone's GPS or a real permission prompt.**

### 17.7 What is NOT proven, and what this change does not decide
- **The venue.** Nobody has stood at the venue with real devices. The real centre, radius, accuracy limit and margins are the Founder's to set with the tool and to rehearse on site; thresholds remain configuration, not policy.
- **Browser location is an eligibility signal, not proof of presence.** A person can simulate a position; nothing here claims otherwise (the page says so).
- **A test round is a label and a data separation, not infrastructure isolation.** It lives in the same database as the real event; if it is created on Production it is rows in Production's database (the Preview deployment shares that database in this project).
- **Operational facts outside the code:** the hosted ledger and ordering of `20261030100000` (it sorts after the seven Community Voting migrations; the destination's own newer migrations were not compared); the operator allow-list in the hosted environment; HTTPS and the browser's location permission on the venue's phones (iOS "precise location"); the hosted CDN's treatment of `GET /info` and of the photograph's 60-second cache window (unchanged: a hidden photograph can still be shown from a cache for up to 60 s).
- **The test endpoint's reading** travels in the body of one POST to the application and is passed to the database as arguments; no application code stores or logs it. Infrastructure logs of the hosting platform and of the database (statement logging, if ever enabled) were not inspected.
- Everything in §16.5 and §11 that was open stays open: photograph retention, the three Founder policies, the consent texts, manual removal of withdrawn promotional use.
