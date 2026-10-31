# Community Voting — Four-Category Halloween Contest (UG-IV-GATE-018) — Implementation Record

**Product:** URBANO Gaming · **Activation:** Halloween costume contest, The Pub by Beer Box, Saturday 31 October 2026
**Branch:** `claude/halloween-four-category-001` (isolated worktree, created from `origin/main` @ `98bb902`; the Voting history `a96596c` is merged in, both histories preserved)
**Status:** implementation record of the four-category candidate; publication and activation require separate dated evidence and must not be inferred from this file. It replaces, for the current format, `COMMUNITY_VOTING_TWO_ROUND_IMPLEMENTATION_RECORD.md`, which stays untouched as historical evidence of the two-round candidate.

---

## 0. Where each instruction reached the work (registered as asked)

| # | Instruction | Received (Honduras time) | State of the work at that moment |
|---|---|---|---|
| 1 | **GATE-018** — four categories, one public round, conditional release | 2026-10-31 ≈ 12:55 | nothing edited yet (state verified first: `origin/main` = `98bb902`, hosted ledger = 296 versions, 0 Community Voting objects in Production) |
| 2 | **Addendum to GATE-018** — self-registration, public code, manual WhatsApp, simple UI | 2026-10-31 ≈ 13:40 | merge commit `6224bff` (tree = the verified `cccf8e41…`); migrations `20261031120000/0100/0200` written and applied on the disposable local stack; 37 contract tests written first (37/37 red on the pre-contest schema, then 37/37 green); the contest's TypeScript layer, routes and the voter page rewritten (voter page not yet exercised in a browser); operator page, venue screen and Home entry **not started**; nothing committed besides the merge, nothing pushed, nothing written to any hosted system |
| 3 | **Precision of Home and schedule** — "Destacados" card, venue name, two public entries | 2026-10-31 ≈ 13:50 (mid-turn, while reading Home) | same as above; the Home card was still the static, locked announcement of 2026-10-29 |

Nothing of the earlier work was restarted or discarded: the three instructions are one scope and are implemented on top of one another.

*(Sections 1 onward are written at the end of the gate, from the final candidate.)*

## 1. Code Review continuation — 2026-10-31

The Founder authorized Codex Identity & Voting to continue after Claude's usage limit. The two sessions must not modify this candidate concurrently. This section records independent continuation evidence, not activation approval.

- Initial tip: `6eba135cfd81fcd261c3523eef2757c4ba901340`.
- Recovered the two already-applied Score migrations with their approved full SHA-256 values. Neither belongs in the pending hosted set.
- Found `main` advancing during validation from `727438c39422c80568e5bc8040e5ac19c366496c` to `a183bcab2afaec67e97df2ca681939e7df4f9c8f`. Reviewed its 18-path presentation/navigation diff, preserved it intact and merged without conflicts. Home's provider reader did not change.
- Before that second integration: 92 behavioral files / 4,221 tests passed; TypeScript and build passed. After integrating `a183bca`: 92 files / 4,223 tests passed; TypeScript and build passed.

### Local validation corrections

The initial remaining mail test was an environment mismatch: GoTrue generated `/verify`, whereas the test and gateway require `/auth/v1/verify`; the synthetic Auth allowlist also omitted the fixed Score admin return. Updated only the disposable Auth configuration and gateway. The previous Auth containers were preserved stopped. The fixture-exclusion suite then passed 7/7.

The Score admin browser contract extracted only six-digit codes although the pilot stack issues eight. Its extraction now accepts complete six- or eight-digit codes, without truncation or changing product Auth. The suite passed 6/6 after the correction.

The first independent full serial contractual run passed 42/43 files and 1,330/1,331 tests, with that OTP extraction failure. A subsequent run on a hosted-aligned synthetic schema exposed three old assertions requiring EVENT_BOUND even when pre-existing Session RLS prevents an invoker from seeing the Session. Those assertions now determine Session visibility under the actual caller and require the exact corresponding denial: EVENT_BOUND_SESSION when visible, SESSION_NOT_FOUND when hidden. Owner-level event guards and no-partial-write assertions remain mandatory. These are test corrections, not authorization or SQL changes.

### Protected recovery and upgrade rehearsal

A new encrypted GATE-018 snapshot captured 85 sources and 6,285 rows, with no movement across the capture window. It covers public data/schema, the migration ledger and identity subsets, not complete Auth credentials/sessions or provider configuration. The encrypted volume remains the only location of real exported rows.

On a network-disabled disposable copy of that snapshot, all 12 pending migrations applied as postgres. The 6,285 pre-existing rows remained unchanged. The only changed pre-existing function was the body of join_participant_atomically; its signature, owner and privileges were preserved. Six guards were added on existing tables. All 25 new tables had RLS enabled and no browser-role grants. The three public lookup helpers are the documented exceptions; the initial rehearsal allowlist incorrectly listed only one and was corrected against the historical structural addendum.

The synthetic test database initially differed from hosted RLS and used supabase_admin ownership for the latest migration. It was aligned locally to hosted flags and the actual postgres migration owner; a leftover induced-failure helper was removed without CASCADE. No corresponding hosted objects were changed.

Final rehearsal: 16/16 checks passed, including upgrade, ordinary Session join, recovery to the exact pre-upgrade application catalog and unchanged backed-up rows. Application schema equality excludes only the CLI migration ledger (absent in the hand-applied synthetic stack) and sequence last_value (data rather than schema). Owners, ACLs, RLS, constraints, indexes, triggers and function definitions are not ignored. Raw comparisons are retained separately. The disposable recovery containers were removed and the encrypted volume detached.

CLI 2.117.0 dry-run with --include-all and --skip-vault listed exactly eight earlier Voting files plus the four 20261031 contest files, with no historical Score SQL, seeds, roles or Vault changes. The CLI initialized its login role as a connection prerequisite; dry-run is not a claim of zero provider-side authentication bookkeeping. No application migration was applied by that dry-run.

## 2. Activation remains separate

This record does not approve consent wording, retention, a real participant-data capture, event creation, listing or voting. Requirements and WhatsApp delivery text remain drafts. The operator allowlist was absent from the Production environment-name inventory at inspection. No real contest has been created or opened by this continuation at the time this section was written.

Release and final contractual results must be appended when completed; the preceding results must not be silently relabeled as clean first-run evidence.

## 3. Public closed entry and subsequent Founder direction

The Founder subsequently requested that both Home controls lead somewhere useful before registration opens. The featured module now installs two fixed local informational links immediately when bound, even when the provider is absent, unavailable or malformed. Only a validated provider answer may replace them with contest-specific destinations. This changes the previous no-link behavior; it does not change admission rules or server authority.

The voter page without a contest id shows a read-only entry at `/community-voting-round.html` and a disabled registration walkthrough at `/community-voting-round.html?participar=1`. Neither sends registration/vote requests, asks for identity or location, saves entered data, creates an event, or records consent. The disabled example shows public name, WhatsApp, category, separate contest/photo and delivery/contact permissions, and optional promotion. A validated active contest may be reached through an explicit continuation. Explicit invalid contest ids still fail closed. A configured contest that is not accepting registration also shows disabled example fields.

Red-first evidence for this entry correction: 81 failures and 126 passing across the two focused files before implementation. After implementation the Home, shell and page suites passed 250/250. Two additional destination-security assertions then passed with the full page suite (50/50). The registered behavioral suite passed 92 files / 4,226 tests before those two final added assertions; no claim that this run included them. TypeScript and the production build passed after the added assertions.

Real Chrome checks of Home, registration preview and voting preview at 320, 360 and 390 CSS px: nine cases, zero horizontal overflow, zero POSTs, disabled registration fields and no submit control. This evidence fulfills `{featured:null}` in the browser and blocks external origins except Google Fonts; it is public-entry UI evidence, not real Auth, email, GPS or activation proof.

Two additional published Home commits arrived during this work: `d33901a1d65084811d63eae13e093d06c5be538d` (official category/prize announcement) and `aee59e8298249252ad37912a2f5f295fd6102835` (branding/contact footer). Their differences were inspected before integration. The accompanying verification record reports the Founder's request and The Pub's official announcement. This supersedes the earlier generic-only Home prize copy; no payout/redemption logic is introduced. Category keys remain MOST_ELABORATE, SEXIEST, BEST_GROUP and FUNNIEST; display names align to Más Elaborado, Más Sexy, Dúo o Grupo and Más Divertido. No production candidacies or votes exist to relabel at this checkpoint.

The hosted-aligned serial contract run passed 1,328/1,331, with three failures in adminAuthority's reused-database bootstrap/service-client fixtures. The test helper signed the shared cleanup client in as an ordinary user; it now uses a separate login client. Its bootstrap test now requires success only if Governance is absent; otherwise it requires rejection with no new grant, retaining the second-bootstrap rejection. The corrected file passed 12/12. This is not reported as a clean first-run contract suite. An earlier focused run of Voting overlapped the serial suite and its global prompt-count assertion was contaminated; that run is invalid evidence for isolation. The isolated corrected Voting and Score admin files passed 121/121.

The Founder directed that URBANO Gaming and The Pub jointly administer photos, that ordinary photos be deleted after 30 days, and that winner photos may be retained for commercial/marketing use with the relevant separate permission. The Founder also requested contact for prize delivery and promotional information. This direction does not create an automated purge or approve unlimited winner retention, WhatsApp retention, a withdrawal contact, or merged mandatory marketing consent. Those controls/texts remain required before real participant-data collection; the public walkthrough is not their acceptance record.

## 4. Final local release checkpoint

After the official category-label alignment and the published Home integration, the registered behavioral suite passed 92 files / 4,228 tests. TypeScript and the explicit production build passed. The eight affected contractual files passed together in one serial run: 224/224 tests (Voting foundation, categories, registration, contest routes, real Next runtime, platform authority, Score admin access and fixture exclusion). This is distinct from the earlier complete 43-file runs and their recorded fixture failures; it must not be described as a new clean 43-file run.

A further concurrent published commit, `637ad0a132834df141bbdaac3870d40688b1bfe5`, changed only the Home footer, its CSS/i18n and shell test (four files). Its diff was reviewed separately; no backend, rules, migrations or featured-reader changes are included. Its integration requires focused Home/shell verification, not another database campaign. All source histories are preserved; no force-push is permitted.

The encrypted snapshot was refreshed again immediately before the release preparation, preserving prior snapshots within the encrypted volume. The snapshot still captured 85 sources / 6,285 rows without movement during capture. The hosted pending set remains subject to the final dry-run and exact twelve-file check. No contest creation or activation is part of this checkpoint.
