# URBANO Score — Progressive prediction and prize ladder: implementation record

Status: implemented locally and validated on a disposable local stack. **Not staged, committed, pushed or deployed. Not run against
Production. Opening participation is still not authorized.** This record describes a delta that sits on top of the sealed shell
candidate `candidate_shell_es_v3`; it is a separate package with its own manifest.

Identity note: "URBANO Score" is the public name; the route, identifiers, tables and API keep the historical "Soccer Predictions" names.

## 1. What was decided (Founder, final)

- Fixed order, no skipped step: **1 Easy** exact scoreline · **2 Medium** first team to score · **3 Hard** any goalscorer · **4 Legendary**
  any goal minute. A person can send after completing any level the venue offers.
- **Attempted level** (the consecutive prefix of categories completed) is separate from **won level** (the consecutive prefix that was
  right, never above the attempted level). One prize only: the one of the won level. Never cumulative. The goalscorer and the minute do
  not have to be the same goal.
- **Offer by venue and match.** Only levels with a configured prize, in a consecutive prefix starting at Easy, are offered: Easy;
  Easy + Medium; Easy + Medium + Hard; all four. The stepper ends at the highest offered level. An activation with no prizes, or with a
  gap, takes no new participations. This is enforced by the server and by the database, not only by hiding steps. There is no descent
  to another prize: a level with no prize cannot be attempted at all.
- **The accepted offer cannot change silently.** From the first prediction at an activation its levels, their labels and the highest
  level offered are frozen, and a submission must carry the fingerprint of the offer the member saw.
- **No goals.** 0–0 is valid. The explicit answers "no team scores / no player scores / no goals in regular time" are answers, correct
  exactly when there were no regulation goals. Not attempting a category is different and is never turned into 0 or into "no goals".
  No new cross-field prohibition was added (for example 2–1 with "no team scores" is accepted and simply cuts the ladder).
- **Closing.** Kickoff still closes predictions. In addition, no prediction is created or edited once a result is finalized, even if the
  kickoff is moved later.

## 2. Data model

`COMPLETE_COUNT_V1` (historical, the default for everything that exists) and `PROGRESSIVE_LADDER_V1` are versions of a per-match
contract, `matches.prediction_contract`, frozen from the match's first prediction or first result (a trigger; serialized against
in-flight writes by a fixed lock order, matches then venue_activations).

| Table | Added |
|---|---|
| `matches` | `prediction_contract` (default `COMPLETE_COUNT_V1`), freeze trigger `matches_contract_freeze` |
| `predictions` | `prediction_contract`; `first_team_state`, `goalscorer_state`, `goal_minute_state` ∈ `NOT_ATTEMPTED` \| `NONE` \| `PICKED` (null only in the historical contract); `accepted_offer_digest`, `accepted_offer_max_level`; `attempted_level` (stored, generated from the states) |
| `evaluations` | `prediction_contract`, `attempted_level`, `ladder_level` (won); the three optional outcome columns accept null (= not attempted, never "correct") |
| `prize_tiers` | `ladder_level` (1–4); `correct_dimension_count` becomes nullable; exactly one of the two keys is set |

CHECK constraints (hold whatever writes the row, proven with triggers disabled): contract shape; state values; a value exists exactly when
the state is `PICKED`; no gaps between attempted categories; attempted level ≤ the accepted highest level; for an evaluation, the won
level equals the consecutive correct prefix computed from the same row, is at most the attempted level, nulls exactly where categories
were not attempted, and `correct_dimension_count` equals the number of true outcomes.

`correct_dimension_count` keeps its meaning (the number of correct dimensions). It is never used as a ladder level and XP/Metagame are
untouched (`CORRECT_n_OF_4` still means hits).

## 3. Functions, signatures and privileges

New (all `SECURITY INVOKER`, `search_path = public`, revoked from `public`, `anon`, `authenticated`, granted to `service_role` only, with a
check at the end of each migration that fails it if any is reachable by a browser role):

- `upsert_progressive_prediction_atomically(uuid, uuid, uuid, integer, integer, integer, text, text, text, uuid, text, integer, integer, text, timestamptz, numeric, numeric, boolean) returns setof predictions`
- `progressive_offer_max_level(uuid) returns smallint`, `progressive_offer_digest(uuid) returns text`
- `prediction_prize_ladder_level(boolean, boolean, boolean, boolean) returns smallint`
- trigger functions `matches_contract_freeze()`, `predictions_guard()`, `prize_tiers_offer_guard()`

Replaced in place (same signatures and return shapes; the historical branch is the previous body unchanged):
`finalize_match_result_atomically(uuid, uuid, text, text)` and `correct_match_result_atomically(uuid, uuid, text, text)`.

Replaced in place with one added first check, same signature and the same ACL (re-asserted, and covered by the end-of-migration privilege
check): `upsert_prediction_atomically(uuid, uuid, uuid, integer, integer, uuid, integer, integer, text, timestamptz, numeric, numeric, boolean)`,
the historical write path. Its body is migration 0096's; the one change is that a Match that does not use the historical contract is
refused with `CONTRACT_MISMATCH` right after the Match is found, whether the call would create a prediction or edit one. See section 9.

Unchanged: redeem, release hold, the evidence guard, every immutability trigger.

## 4. Migrations (append-only)

1. `20261023180000_add_progressive_prediction_contract.sql` — columns, constraints, guards, helper functions, the new submission function.
2. `20261023180100_progressive_ladder_atomic_evaluation.sql` — the two settlement functions.

## 5. Offer protection

`progressive_offer_digest` is SHA-256 over one line per level, `level|length-of-label-in-characters|label`; the application builds the same
text (`prizeLadder.ts`) and a contract test compares the two for awkward labels. The submission function and the predictions guard refuse a
stale or missing fingerprint, an unavailable offer and a level above the offer. `prize_tiers_offer_guard` refuses to insert, edit or delete
a tier of a progressive activation once any prediction exists for it. Consequence to know: a typo in a prize label cannot be corrected
after the first participation at that venue.

## 6. Compatibility, rollback and release order

Order: **migrations, then application, then a separate data step.** The data step that switches an authorized match to
`PROGRESSIVE_LADDER_V1` is accepted by the database only for a match with no prediction and no result. Existing tiers keyed by count are
inert on a progressive match and are not converted. Nothing in this delta changes Production data.

### Four different things are called "rollback"

| | What it is | Possible when | What it leaves behind |
|---|---|---|---|
| **Application rollback** | The previous release serves pages and API; the new schema stays | Always technically (the schema is additive) | See "old application on the new schema" below. Not safe for members of a progressive match |
| **Contract change** | `setMatchPredictionContract` back to `COMPLETE_COUNT_V1` | Only for a match with no prediction and no result (`CONTRACT_FROZEN` otherwise) | The match's ladder tiers stay, inert. Delete them as a separate step if the match is to look historical |
| **Schema reversion** | A new forward migration that removes what this delta added | Only if no progressive match, prediction, evaluation or ladder tier exists. Migrations are append-only, so it is a new migration, not a down-migration | Not rehearsed for execution; its preconditions were rehearsed in rolled-back transactions (below) |
| **Offers that exist but have no participants** | Progressive matches with ladder tiers, nobody has taken part | A contract change or an edit of the offer is still possible | Application rollback is already unsafe for them (below) |

### What each side stops supporting

**Old application (HEAD `66708ca`) on the new schema.** Measured on a disposable stack with both applications running against the same
new schema (evidence 23):

- A historical match works exactly as before (115/115 existing Predictions contract tests).
- A progressive match **with no participants**: the old public list shows it, its ladder tiers appear with no count, and a prediction
  from the old page is refused by the database and surfaces as HTTP 500 "Failed to submit prediction." The old application has no
  message for these refusals. Members of that match cannot take part at all.
- A progressive match **with participants**: the old application still reads the participation and the evaluation, but cannot tell
  "not attempted" from "no goal", and it shows an unreached category (null outcome) as a miss. Since F-2 (section 9) it can **no longer
  edit** that participation: the historical function refuses a progressive match first, for a creation and for an edit alike, and the
  old application reports it as HTTP 500 "Failed to submit prediction." Before F-2 it could change the scoreline of an existing
  progressive participation (HTTP 201 in the experiment of the previous review, which is how F-2 was found).
- Finalization and correction run in the database, so a result finalized by either application evaluates a progressive participation
  correctly; only the old application's way of showing it is wrong.

**Old schema with the new application** (previous measurement; unchanged by this gate): historical writes, tier listing and the public
list work; every progressive feature fails explicitly because `upsert_progressive_prediction_atomically` and the new columns do not
exist (3 of 115 tests, the ones that assert the new function, fail, as expected).

| App | Schema | Result |
|---|---|---|
| old (HEAD `66708ca`) | old | 115/115 Predictions contract tests |
| old | new | 115/115 (historical data only; progressive data as above) |
| new | old | 112/115; the 3 that fail assert the new function exists |
| new | new | 174/174 (and the full contract suite, 882) |

### What can actually stop NEW progressive participations in a contingency

Each of these is refused by the database, not by an instruction. All were exercised on the disposable stack (evidence 23, section E):

| Lever | Effect | Notes |
|---|---|---|
| Disable the venue activation (`enabled = false`) | New participations **and edits** at that venue are refused (`VENUE_ACTIVATION_DISABLED`) | What members already saved stays, and is still evaluated at finalization |
| Cancel the match | Refused (`MATCH_CANCELLED`) | Also removes the match from the public list |
| Remove the activation's tiers | The offer becomes unavailable (`OFFER_NOT_AVAILABLE`) | **Only while it has no participation**; with a participation the tiers are frozen (`OFFER_FROZEN`) |
| Switch the match back to `COMPLETE_COUNT_V1` | The progressive path no longer applies (`CONTRACT_MISMATCH`) | **Only while the match has no prediction and no result** |

There is **no global switch** for the progressive contract: no environment flag and no setting. "Tell the venues not to take part", or
deploying the previous release, is an operational measure and is not the lever: with the previous release deployed the database now
refuses any progressive creation or edit that comes through the historical function (F-2), so an application rollback cannot change a
progressive participation, but the members of a progressive match simply cannot take part through it (HTTP 500) and nothing tells them
why. Pausing progressive participation everywhere means disabling each activation, or cancelling each match.

### Schema reversion: preconditions, rehearsed and rolled back (evidence 24)

On the disposable database, inside transactions that were rolled back, with progressive data present: restoring `NOT NULL` on the three
evaluation outcomes fails (evaluations with a null outcome exist); restoring `NOT NULL` on `prize_tiers.correct_dimension_count` fails
(ladder-keyed tiers exist); dropping the category states is refused by the dependent generated `attempted_level`. A reversion therefore
needs, in this order: no progressive predictions, no progressive evaluations, no ladder tiers, every match back on the historical
contract, then a new forward migration. After the first progressive participation there is no clean reversion, only roll-forward.
Nothing was executed outside the disposable stack, and no maintenance authorization is implied by this document.

## 7. The unsent draft

An answer that has not been sent survives a reload of the same tab, and only that:

- **Where.** The browser's session storage, one entry per member and match (`urbano.score.draft.<member>.<match>`). Never persistent
  storage, a cookie, a server or any other tab. Closing the tab ends it. The code sits between two marked comments in the page script,
  and `shellPublic.test.ts` pins that session storage is touched only there and that the region names no token, credential, e-mail or
  profile field.
- **What.** Only the person's own answers and what the draft is bound to: member, match, venue activation, contract, the fingerprint of
  the prize offer the answers were given under, the step on screen, and the `updatedAt` of the saved entry it starts from (null when
  nothing was saved). Nothing is stored for a level the venue does not offer.
- **When it comes back.** Only if all of that still holds: the same member is signed in, the match is open (before kickoff, no
  finalized result), the venue and its offer fingerprint are the same, and the saved entry is the one the draft started from. A
  different offer or venue drops it and says so. A signed-out visitor, another person, a closed match, a match that is no longer listed,
  corrupt or tampered storage (strict shape check, size limit, digits-only answers) all remove it. Nothing is restored into a form it
  does not fit.
- **What restoring does.** Puts answers back in the form and says so. It never sends and never saves. The person sees, in words, the
  difference between "Borrador en este navegador: todavía no está enviado ni guardado" and "Guardado en tu cuenta: …", and both when they
  differ.
- **A saved entry that is not the draft's starting point** (for example saved from another device, or from another tab) is never
  overwritten silently: the page shows both levels and scorelines and asks whether to keep what is saved (the draft is discarded) or to
  continue from the draft (which stays unsent until the person confirms).
- **Cleanup.** The identity reset the shared sign-in module announces (sign-out, another person) removes every draft this page stored,
  before and independently of the list being rebuilt. After a successful send the draft is removed, so nothing above the chosen level is
  kept anywhere. Sending a lower level than was answered leaves no answer above it.
- **When the browser will not store.** If session storage is blocked or full the page works the same; it then asks the browser to
  confirm leaving the page while answers exist only on screen (the earlier behaviour), and says nothing is kept.
- **A changed offer after a failed send** (409) rebuilds the list on the current offer and discards the draft instead of carrying
  answers given under the old offer to the new one: the person is told, and answers again. That is a deliberate consequence of "do not
  restore if the offer changed".

## 8. Known limitations

- Participation is limited per **Gaming Member** (one prediction per member and match, a database uniqueness). Nothing here establishes
  one account per person, and a position reading is evidence of a device, not of a person. The page does not claim otherwise.
- A draft lives in one tab: closing the tab, or opening the match in another tab or browser, starts without it.
- The old application cannot show a progressive participation correctly, and cannot create or edit one (section 6, section 9).
- A request that is repeated is recognised by its content (section 9), not by a request key. The guarantee is about the request that is
  **currently** accepted: an older request that reaches the server late, after a newer one was accepted, is a new edit before kickoff
  (it replaces the newer answers; the member sees the result) and is refused after it. A request key would close that, and is a design
  addition that was not made.
- No accuracy threshold exists: the geolocation rule is the distance between the reported position and the venue's own coordinates
  against the venue's radius. The reported accuracy is recorded (`reported_accuracy_meters`) and never used to refuse or to widen the
  radius. A reading with a large accuracy circle whose centre is inside the radius is accepted. This predates the ladder and is unchanged.
- A progressive match created through the admin route is the default; a historical match can still be created by naming the historical
  contract. The admin page cannot yet switch an existing match's contract (a data step).
- The public list exposes each offer's fingerprint; it is not a secret.
- A typo in a prize label cannot be corrected after the first participation at that venue (the offer is frozen).
- XP and Metagame are untouched: a progressive prediction still records `CORRECT_n_OF_4` from the number of correct categories, whatever
  level was attempted.

## 9. Corrections after the review (F-1 and F-2)

Both were found by the review of this delta and are corrected here, in the migration that was not yet applied anywhere
(`20261023180000`, edited in place) and in the in-memory model that mirrors it. Nothing else changed: XP and Metagame, the settlement
functions, the pages, the offer rules, the fingerprint and the closing rules are as before.

**F-1 — a repeated request that was already accepted.** `upsert_progressive_prediction_atomically` now decides, right after the Match
is locked and its contract is checked, whether the call is an **exact replay** of the request already accepted for this member and match:
same venue activation, every category's state and value identical (including the attempted level, the scoreline and the added time),
and the same offer fingerprint, which must be present. If so it returns the stored row and **writes nothing**: the row keeps its
`updated_at` and its geolocation evidence (verified at, measured distance, reported accuracy), and it is not rewritten (proved by `xmin`).
Because it changes nothing, it is decided **before** the checks that close a match, so a retry that arrives after kickoff, after the
activation was closed, after the match was cancelled, after a result was finalized or from outside the radius gets the confirmed row
instead of a refusal for something that happened after the acceptance. Anything that is not identical (any answer, the level, the venue,
the fingerprint, another member) is a new edit and passes every check as before: **nothing can be changed after kickoff, after a
finalized result, with a closed activation, for a cancelled match or from outside the radius.** A malformed request cannot equal a stored
row, so it is refused as malformed. Concurrent identical requests serialize on the Match lock: the first writes, the others replay, and
the row ends with the same creation and last-update instant. Not a replay key: see section 8.

**F-2 — the historical function and progressive matches.** `upsert_prediction_atomically` is replaced in place (`create or replace`, same
signature, same ACL, re-asserted and covered by the privilege check) with migration 0096's body and one first check after the Match is
found: a Match whose contract is not `COMPLETE_COUNT_V1` is refused with `CONTRACT_MISMATCH`, for a creation and for an edit alike,
before cancellation, kickoff, activation or geolocation are looked at. The predictions guard alone refused only the INSERT of a
historical-shaped row; the UPDATE of an existing progressive row passed it, bounded only by the table's CHECK constraints. The in-memory
model had already refused both; its check now sits in the same place as the database's.

**Evidence** (disposable local database, fresh apply of every migration of the integrated tree; in-memory suite): the new contract
tests (replay writes nothing; replay after each way of closing; outside the radius; at the function with "not eligible" evidence and a
past kickoff; each answer, the level, the venue and the fingerprint as a new edit; a malformed request; the stale-request limit; six
identical first requests and six repeats at once; a repeat racing a finalization; the historical function refusing a creation and an
edit, in order, through the application and at the function; the privilege set including the replaced function), seven SQL and six
in-memory negative controls (each mutation that removes a protection is caught, and the original definition is restored byte for byte).
