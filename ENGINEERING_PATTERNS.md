# Engineering Patterns

Reusable, code-level patterns discovered during implementation of
Slices 001–006 — not one-time details of any single slice, but shapes
a future engine or slice's design phase should start from rather than
re-derive. This document is implementation-tier, not constitutional:
it explains *how* to build consistent with the accepted architecture,
not *why* the architecture is shaped the way it is (that's the
Architecture Decision Record in the constitutional repository).

An entry only belongs here once it's actually been validated — either
by being explicitly flagged in a slice's own record as worth reusing,
or by being independently reached for the same reason more than once.
A pattern used exactly once, with no such signal, stays in that
slice's implementation record instead of being promoted here
prematurely.

## Transactional reveal-and-score

**Origin**: Slice 003 (Multiple Choice), `reveal_results_atomically`.

**The pattern**: when an engine can deterministically compute an
outcome as a *consequence* of a state transition, perform that
computation inside the same atomic database operation as the
transition itself — never as a follow-up call from the domain layer.

**Why it matters**: this eliminates an entire class of partial-
completion bug (a state persisted as "transitioned" with its
consequence not yet applied) by construction, rather than by retry
logic bolted on afterward. Multiple Choice's automatic scoring at
reveal is the first instance: the same Postgres function that flips an
interaction instance to `RESULT_REVEAL` also evaluates every
submission and writes the resulting point awards, all inside one
transaction.

**When to reach for it**: any future engine with a server-computable
outcome at reveal — an auto-tallied vote, a prediction scored against
a later-revealed actual outcome, anything where "the answer" is
knowable the instant the state transitions.

## Stale-response race guard

**Origin**: Slice 004 (Passive Synchronization), independently
implemented in both `host.html`'s `hostRefresh()` and
`participant.html`'s `participantRefresh()`.

**The pattern**: before awaiting an async request, capture the
identifier of whatever the request is *about* (a session id, in this
case). When the response arrives, compare that captured identifier
against the current one — if they no longer match, discard the
response instead of applying it.

**Why it matters**: `sessionSync.js` itself is deliberately unaware of
sessions or requests — it only knows when to call back into the page,
never what the callback is about. That means it cannot protect against
a response arriving *after* something newer has superseded it (e.g.
after a new session was created while an old request was still in
flight) — only the caller, which knows what "current" means, can. This
was found the hard way: a delayed "session not found" response from a
request made before a session existed could arrive after the real
session had already started, and if treated as terminal, would
silently kill passive sync with no visible error.

**When to reach for it**: any client-side code that fires a request
whose target could change before the response arrives — which, given
passive sync runs continuously in the background, is effectively every
request in `host.html` and `participant.html`.

## Role-aware response projection

**Origin**: Slice 003, `GET_SESSION`'s `preparedQuestions` field.

**The pattern**: a single response type where a field's *presence*, not
just its *value*, depends on which authorized caller is asking — the
host sees each prepared question's correct answer before it's ever
asked; a participant sees `null` for the same field, despite both
being equally authorized to call `GET_SESSION` at all.

**Current state — a precedent, not yet an abstraction**: today this is
one inline `isHost ? ... : null` ternary at the single call site that
needs it. This entry exists so the precedent is visible, not because
the abstraction has been extracted — it hasn't, because it's only
needed once so far. **Extract it** (a proper "host view" vs.
"participant view" projection function) if and when a second or third
role-differentiated field appears; extracting it now, with only one
example, would be guessing at a shape from insufficient evidence.

## Workspace/editor engine seam

**Origin**: Slice 006 (Authoring Workspace), `ITEM_EDITORS[engineType]`.

**The pattern**: the Authoring Workspace itself — the draft queue,
Create/Import/Review, filtering, save — never references a single
Multiple-Choice-specific field. Everything that needs to know what an
item of a given engine's type actually looks like (its fields, how to
validate it, how to summarize it in one line, how to render its full
editor) goes through one seam: `ITEM_EDITORS[item.engineType]`.

**Current state — designed for reuse, not yet proven by reuse**: there
is exactly one key in that object today, because Multiple Choice is
the only engine with authored content so far. This pattern is included
here because it was *deliberately* built with a second engine in mind,
not because a second engine has actually validated it yet — a future
engine (Pictionary, Photo Challenge, Truth or Dare) provides its own
`createBlank` / `validate` / `summary` / `renderFields` and should need
to touch nothing else in the workspace to do so. If a second engine's
authoring needs turn out not to fit this shape cleanly, that's real
evidence the seam needs revising — treat it as a hypothesis worth
re-checking against the first real second engine, not as settled.

## Derive, don't persist, a read-model fact reconstructible from immutable source data

**Origin**: Multiple Choice's `correctness` (Slice 003) and Voting's `placement` (Slice 007) — reached independently, at different times, for different engines, by the same underlying reasoning, not copied from one to the other.

**The pattern**: when a read-model fact (a per-submission correctness flag, a per-candidate rank) can be deterministically recomputed, on demand, from source data that is already immutable by the time anything is allowed to read the fact, compute it at read time instead of writing and maintaining a separate stored copy. Multiple Choice never stores `isCorrect` — `getSession.ts` computes it from `selectedIndex === correctOptionIndex` on every call. Voting never stores `placement` — `computeVotingResults` recomputes standard-competition rank from `votes` on every call, shared by both `InMemorySessionRepository` and `SupabaseSessionRepository` specifically so the two implementations can never disagree with each other.

**Why it matters**: a stored copy of a derivable fact is a second source of truth that can go stale or disagree with its own source the moment something forgets to keep it in sync — the same class of bug Transactional reveal-and-score exists to prevent for facts that *do* need to be written. Deriving removes that failure class by construction, for the specific case where nothing needs to be written at all.

**Boundary — this is not "derived state should never be persisted"**: persisting a derived fact is the correct choice once any of the following is true, and none of it applies to either example above: the fact needs aggregating *across* Interaction Instances (Shared Game State's `champion`, per `ADR-012`, where re-deriving from raw per-instance data on every read stops being cheap); read performance genuinely requires a stored copy; the fact must stay stable even if the derivation logic changes later (a historical/audit requirement); or the source data isn't actually immutable by the time the fact is read. "Immutable source data + cheap deterministic recomputation" is the actual test — not "is this value derived."

**When to reach for it**: a future engine whose result at reveal is a pure function of data that the same reveal-time state transition already write-locks.

## Root-authority RPC privilege hardening must survive function recreation

**Origin**: Migration `0126_restrict_root_authority_rpcs_to_service_role.sql` (Platform Governance Root Bootstrap Security Hardening), discovered while auditing readiness for browser Auth restoration — not yet exercised a second time by any later migration.

**The pattern**: `bootstrap_governance_authority_atomically`, `grant_platform_authority_atomically`, and `revoke_platform_authority_atomically` were each created under this project's own standing `ALTER DEFAULT PRIVILEGES ... GRANT ALL ON FUNCTIONS TO anon, authenticated, service_role` rule — the same default every function in this schema receives at creation time, including `finalize_match_result_atomically`/`correct_match_result_atomically`/`redeem_prize_qualification_atomically`. That default is harmless for those other functions because each carries its own independent, RLS-independent in-SQL authority check before doing anything consequential. These three do not have that same margin: `grant`/`revoke` check the acting member's own active `PRODUCT_GOVERNANCE` grant, a real second layer, but `bootstrap` has no equivalent check at all, by necessity — establishing the very first Governance authority cannot require pre-existing authority. `0126` closed the resulting gap with an explicit `revoke execute ... from public, anon, authenticated`, leaving `service_role` untouched.

**Any future migration that recreates one of these three functions must reassert that same `revoke execute` in the same migration** — no `EXECUTE` for `PUBLIC`, `anon`, or `authenticated`; `service_role` execution remains available; before that migration is considered complete.

**Why it matters — the PostgreSQL distinction is exact, not approximate**: privileges (grants and revokes alike) attach to the function *object* itself, not to its name or signature in the abstract.

- **`CREATE OR REPLACE FUNCTION`** on an existing signature reuses the same object (same OID) — its ACL, including `0126`'s `REVOKE`, survives untouched. No reassertion is needed here.
- **`DROP FUNCTION` followed by `CREATE FUNCTION`** — the convention this repository actually uses for every one of these three functions' own prior signature changes (confirmed: `grant`/`revoke`/`bootstrap`-shaped signature evolution elsewhere in this schema consistently uses `drop function if exists ...; create function ...;`, not `CREATE OR REPLACE`) — destroys the old object and its ACL entirely. The new object is a fresh creation, and the project's standing default-privilege rule applies to it exactly as it did the first time, silently restoring `anon`/`authenticated` `EXECUTE` unless the migration explicitly revokes it again.

A signature change to any of these three (a new parameter, a changed return shape) that follows this repository's own established `drop`-then-`create` convention is exactly the case that reopens the gap. RLS remaining enabled on `authority_grants`/`admin_audit_events`/`gaming_members` with zero policies is real defense-in-depth, but it is an emergent property of this project's own platform-level auto-RLS-enable behavior, never declared or depended on by these functions' own migrations — it must not be treated as the sole boundary for root-authority RPCs. Privilege hardening and function evolution must stay coupled by discipline, not by an automated guard.

**Migration-author checklist, when modifying `bootstrap_governance_authority_atomically`, `grant_platform_authority_atomically`, or `revoke_platform_authority_atomically`**:

1. Preserve canonical authority semantics (`Product/Authority_and_Audit_Foundation.md`, ADR-037) — this is a privilege-durability rule, not license to redesign the authority model.
2. Preserve `security invoker` unless a separately authorized decision changes it.
3. Recreate/replace the function using whichever of the two forms above the change actually requires.
4. If the form used was `DROP`/`CREATE` (or any other path that creates a new function object), reassert `revoke execute ... from public, anon, authenticated` for that function in the same migration.
5. Verify `anon` → permission denied (`42501`), never reaching domain validation.
6. Verify `authenticated` → the same permission denial, proven with a real bearer token, not merely the anon key.
7. Verify `service_role` → reaches real domain validation, not permission denial.
8. Verify the proving steps above created zero unintended `authority_grants`/`admin_audit_events` rows.

**When to reach for it**: any future migration that touches the definition of one of these three specific functions. This is not a general rule for every RPC in the schema — the other consequential RPCs (`finalize`/`correct`/`redeem`) are intentionally left on the standing default because their own in-SQL authority check is independent of it; broadening this pattern to every function without the same "no independent check possible" reasoning `bootstrap` has would be over-generalizing past what repository evidence supports.

## Deliberately not included here

The core "generic Interaction Instance + engine-specific extension
table" pattern that both Open Response and Multiple Choice already
follow is **not** duplicated in this document — it's already
thoroughly covered by ADR-007, ADR-008, and ADR-009 in the
constitutional Architecture Decision Record, and by
`Session_Architecture.md`. Repeating it here would fragment the same
knowledge across two documents instead of consolidating it.
