# URBANO Gaming Application Shell

## Objective

Create the first member-facing URBANO Gaming landing/application shell — a real product surface establishing URBANO Gaming as something a member enters directly, rather than exposing the existing host/participant development surfaces (`host.html`, `participant.html`) as the primary entrance. Prioritized ahead of the paused Slice 008/009/010 structural roadmap because of a near-term commercial objective: preparing URBANO Gaming to receive a Soccer Predictions experience (the validated Finca 8 Golazo capability, currently under a separate Foreign Evidence Intake) around the August 22 Real Madrid match.

This is **not** an Interaction Engine slice and is not numbered as one. It is a member-facing product-surface implementation, using this repository's existing precedent for non-slice-numbered, descriptively-named structural work (`UI_CONVERGENCE_IMPLEMENTATION_RECORD.md`, `STRUCTURAL_TIER2_IMPLEMENTATION_RECORD.md`, `EXPERIENCE_LAYER_IMPLEMENTATION_RECORD.md`, `SESSION_CONTINUITY_IMPLEMENTATION_RECORD.md`, `AUTHORING_WORKSPACE_IMPLEMENTATION_RECORD.md`) rather than inventing a new evidence-artifact convention.

Explicitly out of scope, per instruction: any Prediction mechanics, schemas, scoring, geolocation, OTP, or settlement logic; any Golazo reconstruction from memory; any Slice 008/009/010 work; any auth system, Gaming-specific accounts, or connection to the existing Supabase project's service-role credential for anything resembling user identity.

## What was found before implementing

- **No authentication abstraction exists anywhere in this codebase.** A repository-wide search for auth-related code (`auth.`, `signIn`, `signUp`, `getUser`, any Supabase Auth usage) found nothing — the only Supabase credential in use is `SUPABASE_SERVICE_ROLE_KEY`, a server-side, RLS-bypassing key used exclusively by `SupabaseSessionRepository`, never anything resembling user login. Host/participant identity is entirely bespoke per-session tokens (`hostToken`/`participantToken`, generated at `CREATE_SESSION`/`JOIN_SESSION`, held in `sessionStorage`) — not tied to any real member identity. There was therefore nothing to reuse and nothing to avoid reusing; the auth seam below is new, not a repurposing of anything existing.
- **The application has no React UI anywhere.** `react`/`react-dom` are present only transitively (as a `next` dependency); every existing page (`host.html`, `participant.html`) is plain static HTML with inline `<style>` and vanilla JS, and `app/` contains only API route handlers (`app/api/sessions/...`), no page components. The shell below follows this same established pattern rather than introducing React for the first time in this repository.
- **The existing Product Experience Catalog** (`Product/Experience_Catalog.md`, external to this repository) names the football prediction experience "Golazo" as its internal/architecture name. No member-facing copy override was found there or anywhere else in Product guidance, so the founder-supplied "Soccer Predictions / Predict the biggest matches. Compete with the community." copy was used as given.
- **`Product/Interaction_Engine_Taxonomy.md`'s Voting section** (from the Post-Slice-007 architecture checkpoint) already names a plain participant roster as a valid Candidate source backed by Session Membership — consistent with, though not a dependency of, this shell's separate Community Voting catalog entry, which is presentational only here.

## Route structure introduced

- **`GET /`** — `app/route.ts`, a thin route handler reading and returning `public/index.html`'s markup. A `next.config.cjs` rewrite (`{ source: "/", destination: "/index.html" }`) was tried first and did not work: Next's App Router (`app/api/...`) claims an unmatched `/` as its own not-found page before an ordinary rewrite runs, and a `beforeFiles` rewrite did not change this either. The route-handler approach is the same thin-route pattern already used throughout `app/api/`, and was verified to resolve `/` to `200` with the correct landing-page content, including in a production build (where Next statically pre-renders it, per the build output: `○ / … Static`).
- **`GET /soccer-predictions.html`** — new static file, served directly from `public/` exactly like `host.html`/`participant.html` already are.
- **`GET /urbanoAuth.js`** — new shared static script, served the same way as the existing `sessionSync.js`.
- **`/host.html`, `/participant.html`, all `/api/sessions/*` routes** — untouched, unmodified, verified still `200`.

No React, no new build step, no restructuring of the existing API route tree.

## Authentication seam

`public/urbanoAuth.js` — a small, dependency-free module (`UrbanoAuth`) with `getState()` (always returns `{ status: "unauthenticated" }`), `isAuthenticated()` (always `false`), `signIn()` (resolves `{ status: "not_connected" }`, never fabricates success), `signOut()`, and `attachSignInButton()` (wires a button + adjacent status element to honest copy: *"URBANO sign-in isn't connected here yet — you can still browse Gaming. This will use your existing URBANO membership once identity is connected."*).

This is the entire seam. It intentionally does not decide between Supabase Auth, cross-app SSO, OAuth/OIDC, or shared session cookies — that decision depends on the Golazo Foreign Evidence Package and canonical-identity investigation, per instruction. When a real provider is chosen, only this one file should need to change; every page that calls `UrbanoAuth` today will pick up the new behavior without modification. The catalog remains fully browsable while unauthenticated; nothing currently requires participation, so no protected-entry gate was built yet — the seam exists so one can be added at the point of participation later without redesigning the shell.

## Landing-page hierarchy (as implemented)

```
URBANO Gaming identity (mark, wordmark, purple "Gaming" badge)
↓
"Sign in with URBANO" entry (honest, non-functional)
↓
Featured Experience — Soccer Predictions (large card, purple Experience-Layer accent)
↓
Explore Games & Experiences (horizontally-scrollable catalog, mobile-safe)
```

## Catalog contents and status assigned

Current state (after the Trivia Playtest follow-up below — see that section for the full history of how Trivia's status changed twice):

| Experience | Status | Actionable | Destination |
|---|---|---|---|
| Soccer Predictions | Featured | Yes | `/soccer-predictions.html` |
| Trivia | Playtest | Yes | `/trivia-playtest.html` |
| Community Voting | Coming Soon | No | — |
| Level 33 | Coming Soon | No | — |
| Duels | Coming Soon | No | — |

Community Voting was deliberately marked **Coming Soon**, not Experimental, per instruction to use the more conservative status when uncertain: Voting the *engine* is production-validated, but it has no finished member-facing standalone entry — no self-serve way for a member to start a Community Voting round today, and its Segment/Turn/scoring member experience remains scheduled behind the paused structural roadmap. Presenting it as "Experimental" (implying it is playable now, just rough) would overstate current reality.

Coming Soon cards render as inert `<div>` elements with no `href` and no click handler at all — verified directly (not just visually dimmed) via a DOM query confirming zero of the four Coming Soon cards carry a navigable element, versus the single actionable card (Soccer Predictions) rendering as a real `<a>` tag.

**Trivia — corrected, per explicit founder review.** An earlier version of this shell marked Trivia "Available" and routed it to `/participant.html`, reasoning that `participant.html` was "genuinely the only current member-side surface" for the validated Multiple Choice engine. That reasoning was rejected on review, correctly: `/participant.html` is a session-participation surface requiring an externally created session and room code — it is not a standalone Trivia Experience, and routing a member with no room code in hand into it would be misleading regardless of how the card's subtitle was worded. **Validated engine capability is not the same thing as a finished member-facing Experience.** Multiple Choice/Trivia is real, tested, and production-validated as an *engine* — but no self-serve, member-initiated Trivia Experience exists yet on top of it. The Gaming catalog now correctly reflects that gap by marking Trivia Coming Soon and non-actionable, exactly like Community Voting, Level 33, and Duels, rather than routing members into session infrastructure that was built for hosted playtests, not for a stranger arriving at the landing page. `/participant.html` itself is unchanged and remains directly reachable at its existing path for hosted/playtest sessions — only the landing catalog's link to it was removed.

## Trivia Playtest follow-up (founder-directed)

The reasoning in the paragraph above is preserved unchanged and remains correct: it is the reason Trivia was marked Coming Soon in the first place, and that reasoning is not being revised or walked back here.

Subsequently, the founder authorized a narrower, explicitly-scoped follow-up: an **invited playtest entrance**, not a reclassification of Trivia as a finished Experience. The distinction the founder drew is preserved exactly: *validated Interaction Engine capability is not the same thing as a finished member-facing Experience.* Trivia is not being marked "Available," "Live," "Released," or "Production Ready" — it is marked **Playtest**, a status deliberately chosen to be unmistakable as preview/testing, not general availability. The purpose is to let invited reviewers (starting with Roberto, who is separately the implementer of the historical Finca 8 Golazo capability under Foreign Evidence Intake) coherently inspect the already-validated, already-shipped hosted Trivia capability, without a member-facing landing page routing strangers directly into session infrastructure built for hosted playtests.

**What changed:** the Trivia catalog card became actionable again, but its destination is no longer `/participant.html` directly. It now opens a new, small dedicated page, `public/trivia-playtest.html`, which explains in member-facing language that this is an early playtest, and offers two explicit actions — **Host a Trivia Session** (→ `/host.html`) and **Join a Trivia Session** (→ `/participant.html`) — rather than silently picking one. `/host.html` and `/participant.html` themselves remain completely unmodified; only a new, small routing page was added in front of them. No new session logic, matchmaking, or gameplay change was made anywhere. `UrbanoAuth` was not touched — the same honest, non-functional "Sign in with URBANO" seam appears on the new page, and no mock or temporary authentication was added merely to let a reviewer in.

## Soccer Predictions destination behavior

`public/soccer-predictions.html` — a polished, member-facing pre-launch page: brand header (with the same honest sign-in seam), a hero card explaining what the experience will do ("Predict the biggest matches and compete with the community... check back soon to make your picks"), an "Opening Soon" status pill, and a short "What to expect" panel. No internal development language anywhere (no "Roberto," "FEI," "Golazo," "migration," "pending"). No prediction mechanics, match data, forms, schemas, or scoring UI — purely presentational, as instructed, intended to receive the reviewed Golazo/Finca 8 implementation once the Foreign Evidence Package is returned.

## Files changed

Original checkpoint (`6ea3e82`):
- `app/route.ts` — new; serves the landing page at `/`.
- `public/index.html` — new; the landing shell.
- `public/soccer-predictions.html` — new; the Soccer Predictions destination shell.
- `public/urbanoAuth.js` — new; the authentication seam.
- `APPLICATION_SHELL_IMPLEMENTATION_RECORD.md` — this file.

Trivia Playtest follow-up (this pass):
- `public/trivia-playtest.html` — new; the Trivia Playtest destination, routing to `/host.html` and `/participant.html`.
- `public/index.html` — modified; Trivia's catalog entry changed from Coming Soon/inert to Playtest/actionable, pointing at `/trivia-playtest.html`. The `status-available` CSS class was renamed to `status-playtest` to match (same ivory-outline visual treatment, distinct from Featured's purple and Coming Soon's muted styling — never rendered as equivalent to Featured).
- `APPLICATION_SHELL_IMPLEMENTATION_RECORD.md` — this file, updated.

No changes to `host.html`, `participant.html`, `sessionSync.js`, `urbanoAuth.js`, `lib/session/*`, any API route, any migration, or `next.config.cjs` at any point across either pass (a rewrite was tried there and reverted once the route-handler approach proved correct — final state is unchanged from before this work).

## Verification

- `npx tsc --noEmit`: clean.
- `npm test`: 219/219 passing, unaffected (presentation-only change; no domain/API code touched).
- `npm run build`: clean; `/` correctly statically pre-rendered.
- Dev-server verification: `/`, `/soccer-predictions.html`, `/urbanoAuth.js`, `/host.html`, `/participant.html` all confirmed `200`.
- Desktop (native viewport) and mobile (375×812) screenshots taken of both new pages: header, Featured card, and carousel all render correctly at both sizes; sign-in click shows the honest not-connected message with no fabricated authenticated state.
- Confirmed no page-level horizontal overflow at mobile width (`document.documentElement.scrollWidth === window.innerWidth`) — only the intended carousel scrolls horizontally, verified by scrolling it to reveal the Duels card at the far end.
- Confirmed via DOM inspection that all four Coming Soon cards (Trivia, Community Voting, Level 33, Duels) carry no `href` or click handler; only the Featured Soccer Predictions card does.

**Trivia Playtest follow-up verification** (re-run after the change above):
- `npx tsc --noEmit`, `npm test` (219/219), `npm run build`: all clean, re-run and unaffected.
- DOM inspection re-confirmed: Soccer Predictions (`<a>`, Featured) and Trivia (`<a>`, Playtest) are the only two actionable cards; Community Voting, Level 33, and Duels remain inert `<div>` elements with no `href`.
- `/trivia-playtest.html` confirmed `200`; its "Host a Trivia Session" and "Join a Trivia Session" buttons confirmed via direct click-through to land on the real, unmodified `/host.html` and `/participant.html`.
- Desktop and mobile (375×812) screenshots confirm the Playtest pill (ivory outline) is visually distinct from and clearly subordinate to the Featured card's purple glow — never rendered as equivalent.
- No page-level horizontal overflow at mobile width on either `/` or `/trivia-playtest.html` (`document.documentElement.scrollWidth === window.innerWidth`, verified on both).
- `/host.html` and `/participant.html` re-confirmed byte-for-byte unchanged and directly reachable.

Deployed and publicly verified at `https://urbano-gaming-playtest.vercel.app` following this checkpoint (see commit history — this record's own prior sections predate that deployment and are preserved as written, not retroactively edited).

## Product Shell Refinement (founder-directed, after public deployment)

Performed after the shell above was already live and publicly shared for founder review. This pass is a visual/navigation refinement, not a new capability — it does not add any Interaction Engine, mechanic, backend, or persistence anywhere. The findings and decisions from every earlier section of this record are preserved unchanged; this section only adds to them.

**1. Logo glow fix.** Founder visual review identified a visible rectangular/boxed border around the URBANO U mark. Root cause, confirmed by inspecting computed styles rather than guessing: `.brand-mark` applied `filter: drop-shadow(0 0 6px var(--exp-purple-glow))` directly to the `<img>`. `drop-shadow` blurs the *alpha silhouette* of its target — and `urbano-mark.svg` is a fully opaque square (a black background rect baked into the asset, with the ivory U and gold dot drawn on top), not a transparent cutout of just the U. The filter was therefore tracing a crisp purple-glowing rectangle around the mark's own square edge, reading as an unwanted box. Fixed by removing the `drop-shadow` from the image entirely (confirmed via computed style: `filter: none`) and producing the glow instead from a separate `::before` pseudo-element on a new wrapping `.brand-mark-wrap` span — a blurred `radial-gradient` circle positioned behind the mark. This keeps a soft atmospheric purple halo (not removed) while eliminating the rectangular edge-tracing (the actual defect). The mark asset itself (`urbano-mark.svg`) was not touched, distorted, or redrawn. Applied identically across every shell page (`index.html`, `soccer-predictions.html`, `trivia-playtest.html`, and the two new pages below) — `host.html`/`participant.html` were not touched, per standing instruction.

**2. Hero copy.** Kept the existing primary line (`Play, predict, and compete with your community.`) unchanged, per instruction to preserve it absent a stronger reason to change it. Replaced only the supporting sentence, from a Trivia/Predictions-only description to: *"Trivia, predictions, competitive minigames, and live experiences — built for playing together."* — broadening the stated scope to match `Product_Hierarchy.md`'s own Level 2 Experience examples (Trivia Night, Drawing Challenge, Prediction Games, Party Mode, among others) without claiming any of the unbuilt categories are playable today.

**3. Featured Soccer Predictions — real match content.** Replaced the generic Featured tagline with the founder-verified fixture: Espanyol vs Real Madrid, LaLiga, Saturday August 22 2026, RCDE Stadium, 21:30 Madrid / 13:30 Tegucigalpa. This is real, founder-supplied schedule data, not fabricated content. The match is rendered inside `.match-track`, a horizontally-scrollable single-item track (`scroll-snap` + `overflow-x: auto`) — structured so a second or third upcoming fixture could be appended as another `.match-slide` later without redesigning the module, but no slide controls, dots, or second match were built, since there is nothing yet to navigate between. Visual treatment is original: typography, a diagonal `repeating-linear-gradient` texture (evoking stadium light without depicting it), and gradient framing — no club crests, no broadcast graphics, no third-party marks; team names appear as plain text only. The same fixture card was also added to `/soccer-predictions.html` itself, for coherence between what the homepage advertises and what a visitor actually finds on arrival — a deliberate choice beyond the letter of the founder's Featured-module spec, made for consistency, not scope creep.

**4. Games & Minigames vs. Experiences.** The single "Explore Games & Experiences" carousel was split into two independently labeled sections, each with its own `<div id="...">` anchor target for the new primary nav:
- **Games & Minigames** (`#play`): Trivia (Playtest, actionable), Duels (Coming Soon, inert). A short note — "More competitive games are on the way." — communicates more are coming without inventing placeholder cards.
- **Experiences** (`#experiences`): Community Voting (Coming Soon, inert), Level 33 (Coming Soon, inert).

Soccer Predictions is **not** duplicated into the Experiences carousel — a deliberate design choice, not an oversight: it is already the Featured module directly above, and a second full card for the same destination would be redundant clutter rather than additive information, matching the founder's own "does not necessarily need a duplicate... if duplication hurts the design" guidance. Level 33 is correctly placed under Experiences, not Games & Minigames, consistent with its Product-architecture identity as the future orchestrated multi-game Experience — no third-party name (no "33 Rounds," no Mario/Mario Party/Nintendo reference) appears anywhere in the shell.

**5. Primary navigation.** Added `<nav class="primary-nav">` (Home / Play / Experiences / Leaderboards / Rewards) to every shell page, horizontally scrollable so it never wraps awkwardly on narrow phones. Home, Play, and Experiences are plain anchor links into `index.html` (`/`, `/#play`, `/#experiences`); Leaderboards and Rewards are their own small static pages. No router, no framework, no client-side navigation state beyond a hard-coded `is-active` class per page — the smallest structure consistent with every other page in this shell. Profile was deliberately not added, per instruction, since canonical URBANO authentication remains unresolved.

**6. Leaderboards shell** (`public/leaderboards.html`, new). Three tabs (Global / By Game / My Circles), toggled with plain vanilla JS (`hidden` attribute, no framework) — matching this shell's established no-build-step convention. Every view is an honest empty state; no user, score, ranking, venue, or history was fabricated anywhere. By Game shows two category chips (Trivia, Soccer Predictions) as labels only, not results. My Circles explicitly states it isn't connected yet, tying the gap directly to identity: *"My Circles will show rankings among your friends and communities once URBANO identity is connected."* A single info card names Venue/Location filtering as a future, clearly-unavailable concept, per instruction — not implemented, not backed by fake data. No backend schema, no persistence, and the existing `point_awards`/standings implementation was not read from or written to anywhere on this page.

**7. Rewards shell** (`public/rewards.html`, new). Five sections — Achievements, Unlockables, Collections, Cosmetic Rewards, and URBANO Ecosystem Benefits — each an honest empty/future state, no fabricated owned items or balances. The architectural boundary the founder was explicit about is stated directly in the UI copy itself (a gold-bordered card, distinct from the plain empty-state cards above it): *"Gaming and URBANO Lifestyle rewards are separate today. As URBANO Gaming grows, eligible participation may unlock broader URBANO benefits — but Gaming progress does not automatically convert into currency or points, and no such exchange exists yet."* No currency, exchange rate, point balance, Lifestyle-point minting, commerce redemption, or Reward Economy logic was implemented anywhere.

**8. Deferred concepts, recorded but not built, per explicit instruction:**
- **Commerce/offers engine** — no offer schema, no redemption engine, no venue reward logic. The intended future chain (Commerce Campaign → URBANO Lifestyle/Participation → Gaming eligibility/activity → validated gameplay outcome → campaign evaluates condition → benefit/reward) is recorded here only as a concept for a future task, not designed further.
- **Challenge concept** — no wagers, bets, money custody, economic settlement, drink-payment enforcement, or Challenge/Duel backend were implemented. No Challenge button or entry point was added anywhere in this refinement, matching the founder's default-off instruction ("this task should not add a Challenge button yet unless current UI structure truly requires a placeholder — default is not to add one"); the current UI structure did not require one. Recorded here only because future navigation pressure (a "Challenge someone at the table" entry point) is a real, anticipated future need, not because anything was built toward it.
- **Soccer Predictions geolocation seam** — the future flow (member location → participating URBANO venue → venue-enabled Prediction experience → participate) was not implemented and no fake venue detection or permission prompt was added. The historical Golazo implementation already solved this in production and remains under Foreign Evidence Intake; this shell does not duplicate that work ahead of reviewing it.

## Files changed (Product Shell Refinement)

- `public/index.html` — modified: logo fix, primary nav, refined hero copy, redesigned Featured match module, Games & Minigames / Experiences split.
- `public/soccer-predictions.html` — modified: logo fix, primary nav, added the same real fixture card.
- `public/trivia-playtest.html` — modified: logo fix, primary nav (no content change beyond that).
- `public/leaderboards.html` — new.
- `public/rewards.html` — new.
- `APPLICATION_SHELL_IMPLEMENTATION_RECORD.md` — this section.

No change to `app/route.ts`, `public/urbanoAuth.js`, `host.html`, `participant.html`, `lib/session/*`, any API route, or any migration.

## Verification (Product Shell Refinement)

- `npx tsc --noEmit`, `npm test` (219/219), `npm run build`: all clean.
- Logo fix confirmed precisely via computed styles, not just visually: `.brand-mark`'s `filter` is `none` (drop-shadow removed), no border/box-shadow/outline present; the glow is confirmed present via `.brand-mark-wrap::before`'s `radial-gradient` background and `blur(4px)` filter.
- All routes confirmed `200`: `/`, `/soccer-predictions.html`, `/trivia-playtest.html`, `/leaderboards.html`, `/rewards.html`, `/host.html`, `/participant.html`.
- DOM inspection confirms the Games & Minigames / Experiences split renders exactly as designed (Trivia actionable/Playtest, Duels/Community Voting/Level 33 inert/Coming Soon).
- Leaderboards' tab switching verified interactively (clicking "By Game" correctly reveals its panel, including the Trivia/Soccer Predictions filter chips, and hides the others).
- Desktop and mobile (375×812) screenshots taken of all five shell pages; no page-level horizontal overflow on any of them (`document.documentElement.scrollWidth === window.innerWidth`, verified per page).
- `git diff --stat -- public/host.html public/participant.html`: empty — confirmed byte-for-byte unchanged.

Not committed, not pushed, not deployed, per instruction.

## Explicitly deferred / unresolved pending the Golazo Foreign Evidence Package

- Soccer Predictions mechanics, schemas, scoring, geolocation, OTP, and settlement — entirely undesigned here, intentionally.
- Which identity mechanism (Supabase Auth, cross-app SSO, OAuth/OIDC, shared cookies, other) will back "Sign in with URBANO" — depends on the canonical-identity determination the Foreign Evidence Intake is making.
- Whether/how Prediction generalizes beyond soccer — the shell's catalog and copy do not assume "Prediction means soccer forever" (the Soccer Predictions card and destination are named for the sport specifically, not for "Prediction" generically), but no abstraction for other prediction categories was built.
- The Trivia self-serve entry gap named in the Trivia Playtest section above — unchanged by this refinement.
- A protected-participation gate at the point of actually joining/playing an Experience — not needed yet, since nothing in this shell currently requires authentication to use.
- Commerce/offers engine, Challenge/Duel backend, and Soccer Predictions geolocation — all recorded as concepts in this section, none implemented.

## Founder-directed corrections (naming and boundary review, same pass)

**Rewards boundary — reviewed, no change made.** Re-read the "URBANO Ecosystem Benefits" copy in `public/rewards.html` against the specific failure modes the founder named: (A) implying automatic Gaming → Lifestyle conversion, or (B) implying Gaming rewards can never connect to broader URBANO benefits. The existing sentence — *"Gaming and URBANO Lifestyle rewards are separate today. As URBANO Gaming grows, eligible participation may unlock broader URBANO benefits — but Gaming progress does not automatically convert into currency or points, and no such exchange exists yet."* — already avoids both: it explicitly denies automatic conversion (not A), and "may unlock" plus "not yet" both leave the door open rather than closing it (not B). Left unchanged, per instruction to make no change if the distinction is already accurate.

**"Games & Minigames" renamed to "Skill Games."** A naming/taxonomy correction only — the category's contents, statuses, and destinations are unchanged (Trivia: Playtest, actionable; Duels: Coming Soon, inert). Renamed in `public/index.html`: the visible section label, the section's own code comment, and the internal JS catalog variable (`GAMES_CATALOG` → `SKILL_GAMES_CATALOG`, for code-comment consistency — not a member-facing change, but left inconsistent it would have been confusing against the new visible label). The `id="games-carousel"` DOM id and the `#play` anchor/nav-link target were deliberately left unchanged — this is copy/taxonomy, not a routing change, and nothing in the instruction asked for the underlying anchor or nav-link wording ("Play") to change. No other page referenced the old label; confirmed via a repository-wide search of `public/` after the rename. Internal Interaction Engines (Multiple Choice, Voting, etc.) were not renamed — this correction is scoped entirely to member-facing product category copy.

## Featured match time display correction (founder-directed, after `bbbe1f9`)

The match meta line previously showed both zones — `21:30 Madrid · 13:30 Tegucigalpa` — on both `public/index.html`'s Featured module and `public/soccer-predictions.html`'s destination card. Founder direction: show only the time relevant to the member's current URBANO market/experience context, which for this launch is Tegucigalpa — not a dual-timezone display, and not Madrid/Spain time at all. Changed both occurrences to `1:30 PM · Tegucigalpa`. Confirmed via repository-wide search that no other occurrence of the match time exists anywhere in `public/`. This is a display-copy change only — no dynamic timezone localization, no member-location detection, and no per-market configuration were built; the principle ("show the market-relevant time") is recorded here as the reasoning, not implemented as a general capability. That remains explicitly deferred until URBANO Gaming expands to additional markets.

## Recommended next smallest step while Golazo evidence remains pending

Nothing further on this shell is required to receive the Golazo evidence review — it remains an intentionally stable, low-churn surface between refinement passes. The smallest next step, when authorized, is independent of this work: continue the paused Slice 008 (Segment/Turn grouping) once the Prediction deployment priority stabilizes, per the founder's own stated sequencing. No action recommended on this shell itself until the Foreign Evidence Package returns and Soccer Predictions' real mechanics are scoped.

## Experience Discovery Slice 1 — Discovery Truthfulness + Poker/Quiz Integration + Semantic Iconography (2026-08-23)

**Why this section exists.** A read-only Product + UI Classification gate audited every current member-facing Gaming surface against what actually exists behind it and found two concrete stale/misleading discovery states (Soccer Predictions' Featured card described a live, fully built prediction form as "opening soon"; Poker's fully deployed, production-validated backend had zero presence anywhere in discovery) and two real gaps (Quiz had no discovery entry at all; Duel's real, deployed, mechanic-aware backend was indistinguishable from Level 33/Community Voting's genuinely-nothing-built Coming Soon state). This Slice corrects exactly those findings. Duel gameplay UI itself — competitor selection, mechanic-aware rendering, privacy states, Host/participant/spectator controls, exceptional resolution — is explicitly out of scope here and deferred to its own dedicated gate, per Founder-directed sequencing; only Duel's *discovery card wording* changed.

**1. Icon layer added.** A `.exp-icon`/`.exp-card-top` treatment was added to the existing `exp-card` markup so each catalog item can carry a lightweight emoji glyph next to its status pill — additive to the existing shell tokens, not a new design system. Approved-now mapping, per explicit Founder direction: Trivia 🧠, Quiz 📝, Poker 🃏, Duel ⚔️, Soccer Predictions ⚽ (already informally in use on the Featured eyebrow). Community Voting and Level 33 deliberately received no icon — no Founder direction was given for either, and inventing one would exceed this Slice's scope. Puzzle/Karaoke/Impersonator icons (🧩, 🎤/🎵, 🕵️) remain documented context only from the prior classification gate — none of the three were added as cards, and no route or placeholder card was created for any of them.

**2. Soccer Predictions Featured card corrected.** `"Prediction experience opening soon."` → `"Live now — sign in with URBANO to make your prediction."` — a copy-only change against `public/soccer-predictions.html`, which was independently confirmed (prior classification gate) to already be a fully built, live prediction form (score, goalscorer, minute, first-team-to-score, geolocation venue eligibility, evaluation display). No Predictions backend, schema, or Gaming Member requirement was touched.

**3. Poker added to discovery.** New Skill Games card — 🃏, "Poker," "Host a private No-Limit Hold'em table for your group.," status `playtest` (the same tier already honestly describing Trivia — a real, functioning, Host-organized format, not a polished stranger-facing self-serve entry), action label `Host →`, `href="/poker-host.html"`. No Poker backend, API contract, or table-creation semantics were touched — confirmed by an unchanged `app/api/gaming/poker/**` and an identical `POST /api/gaming/poker/tables` request/response shape before and after.

**4. Quiz added to discovery.** New Skill Games card — 📝, "Quiz," "Self-paced — everyone answers on their own time, results reveal together.," status `playtest`, `href="/quiz-playtest.html"`. `public/quiz-playtest.html` (new) is a mechanical mirror of the existing, already-accepted `trivia-playtest.html` router pattern — same hero/status-pill/two-action-button shell, swapped to Quiz's own copy, both actions routing into the already-existing, already-production-validated `host.html`/`participant.html` Quiz flow (`QUIZ_EXPERIENCE_IMPLEMENTATION_RECORD.md`). No new session logic; `host.html`/`participant.html` are byte-for-byte unmodified by this Slice.

**5. Duel's discovery state corrected without becoming falsely playable.** The card previously read exactly like Level 33/Community Voting — `Coming Soon`, implying nothing exists yet, which is false: Duel's backend is deployed and mechanic-aware (`0136`, `mechanicKey`). One new status was added to the existing Featured/Playtest/Coming Soon vocabulary — `building` → member-facing label **"In Development"** — used by Duel alone. Rendered non-actionable (`<div>`, no `href`, dashed-border pill visually distinct from both Playtest's solid outline and Coming Soon's fully muted style) so no dead Play button was exposed. Sub-copy: *"Head-to-head challenges between members — gameplay screen is in development."* No internal status language (`BACKEND_READY_UI_MISSING`, `mechanicKey`, etc.) reached the UI. No Duel competitor-picker, Host controls, participant answer card, spectator state, privacy UI, mechanic rendering, forfeit controls, or routing were built — confirmed by an unchanged `host.html`/`participant.html` (zero "duel" references, matching the pre-Slice grep result) and zero new files under any Duel-specific path.

**6. Poker Host shell-integration pass.** `public/poker-host.html` rewritten for presentation only — the same brand header, Montserrat/token system, card/field/button conventions, and purple Gaming-layer accent (applied to the room-code display, mirroring the Featured card's own treatment) already used everywhere else in the shell. Every element id (`cfg-stack`, `cfg-sb`, `cfg-bb`, `btn-create`, `pre-create`, `post-create`, `room-code-display`, `btn-start-hand`, `hand-msg`, `status-line`, `board`, `seats-body`) and the entire `<script>` block are byte-for-byte identical to the pre-pass version — confirmed by diffing the script contents before and after. No animation was added; no new design system was introduced.

**7. Status vocabulary, final.** `Featured / Playtest / In Development (Duel only) / Coming Soon`. No other new status was introduced; `NON_ACTIONABLE_LABEL` keeps Community Voting/Level 33's visible text (`"Coming soon"`) byte-identical to before this Slice.

**8. Section structure.** The existing `Skill Games` / `Experiences` split was reviewed and preserved unchanged — adding Quiz/Poker/Duel to Skill Games and leaving Community Voting/Level 33 under Experiences remains truthful (short-form competitive play vs. broader social/participatory moments); no Experience Family layer was introduced, per instruction.

**9. Auth/Guest/mobile/brand boundary.** `"Sign in with URBANO"` untouched everywhere, including the new `quiz-playtest.html`. No login gate was added to any Guest-compatible flow (Trivia, Quiz, Poker, and the still-inert Duel card all remain Guest-reachable exactly as before); Soccer Predictions' existing Gaming-Member requirement for prediction submission was not touched. Mobile-first conventions (≥44px tap targets, no horizontal overflow, hidden-scrollbar carousels) were verified, not merely reused — see Verification below. Brand tokens (logo, wordmark, Montserrat, purple Gaming accent, gold Recognition reservation) were reused verbatim; none were altered.

## Files changed (Experience Discovery Slice 1)

- `public/index.html` — modified: icon layer (CSS + catalog data + render function), Featured Soccer Predictions copy correction, Quiz/Poker cards added, Duel card corrected to a new `building`/"In Development" status. (+46/-9 lines, per `git diff --numstat`.)
- `public/poker-host.html` — modified: shell-integration restyle only; all element ids and all JS logic byte-identical. (+147/-38 lines, per `git diff --numstat`; entirely presentational.)
- `public/quiz-playtest.html` — new: mechanical mirror of `trivia-playtest.html`, Quiz-specific copy.
- `APPLICATION_SHELL_IMPLEMENTATION_RECORD.md` — this section.

No change to `app/route.ts`, `app/api/**` (any route), `lib/**`, any migration, `.env.local`, `host.html`, `participant.html`, `leaderboards.html`, `rewards.html`, `soccer-predictions.html`, `poker-table.html`, or `urbanoAuth.js`.

## Verification (Experience Discovery Slice 1)

- `npm test`: 641/641 passed, unchanged from before this Slice (no TypeScript/backend file was touched).
- `npx tsc --noEmit`: clean.
- `npm run build`: clean, all routes listed, exit 0.
- All seven pre-existing shell pages (`host.html`, `participant.html`, `leaderboards.html`, `rewards.html`, `soccer-predictions.html`, `poker-table.html`, `trivia-playtest.html`) confirmed `200` against the local dev server post-change.
- Discovery inventory confirmed live via DOM inspection: Trivia/Quiz/Poker render as real `<a>` elements with the correct `href`s; Duel/Community Voting/Level 33 render as inert `<div>`s with no `href` — matching the intended actionable/non-actionable split exactly.
- Poker Host's create-table → room-code → status-poll flow verified end-to-end against local Postgres through the page's own real click handler (not a bypass): `POST /api/gaming/poker/tables` → `201`, `localStorage` populated, `pre-create` hidden/`post-create` shown, room code rendered, and the `setInterval` polling `GET` against the table (bearer-authenticated) returned a clean `200` with the expected empty-table state — proving the API contract and client wiring are unchanged by the restyle.
- Mobile (375×812) verified for `index.html`, `poker-host.html`, and `quiz-playtest.html`: `document.documentElement.scrollWidth === window.innerWidth` on all three (no horizontal overflow); button/input tap targets measured 44–47px tall.
- Desktop (1280×800) screenshots taken of the Skill Games row (all four cards in one view) and Poker Host (pre-create and post-create states).
- Credential scan (`SUPABASE_SERVICE_ROLE_KEY`, `service_role`, `sk-`, `SECRET`, API-key/password patterns) against all three changed files: clean.
- `git diff --stat -- public/index.html public/poker-host.html` plus `git status --short -- public/quiz-playtest.html`: confirmed exactly these three files changed; `.env.local`, `supabase/migrations/`, `app/api/`, and `lib/` all show zero changes.

Not staged, not committed, not pushed, not deployed, per instruction — left for Founder visual review.

## Experience Discovery Slice 1 — Production Deployment (2026-08-24)

**What changed since local acceptance.** The candidate accepted above (commit `5dcdabb5442766fee5e91a4b0c6917c0b4b41ca4`, parent `099b3823d5d9914d93d8707e102e4838fefc7888`) underwent one additional local-acceptance pass — a fresh line-by-line diff review that found and corrected two minor factual inaccuracies (a dangling code-comment reference in `poker-host.html` to a nonexistent file, and stale diff-line counts in this record's own "Files changed" list, both fixed to match `git diff --numstat` exactly) — before a Founder-authorized production readiness gate and this deployment gate.

**Push and deployment.** `git push origin HEAD:main` performed as a clean fast-forward (`69522ef..5dcdabb`, no force, no rebase, no history rewrite), confirmed via a pre-push `git merge-base --is-ancestor origin/main HEAD` check. Vercel deployment of `5dcdabb` confirmed successful via GitHub's commit-status API (`"state":"success","description":"Deployment has completed"`). Deployed SHA verified two ways: (1) the live homepage no longer shows the stale "opening soon" copy and does show all five approved icons; (2) `curl`-fetched production `index.html` and `poker-host.html` are **byte-identical** to the local candidate files — the same rigor used at every prior deployment gate in this engagement.

**Discovery inventory verified live**, via direct DOM inspection (not just visual review): Trivia/Quiz/Poker render as real `<a>` elements with `href="/trivia-playtest.html"` / `/quiz-playtest.html"` / `/poker-host.html"` respectively; Duel/Community Voting/Level 33 render as inert `<div>`s with `href: null` and `onclick: null`. Duel's status pill and action text read "In Development" / "In development" exactly as designed — no internal terminology reached the page. The Featured card's `.featured-note` reads "Live now — sign in with URBANO to make your prediction," and `Sign in with URBANO` itself is untouched.

**Poker Host production proving.** `GET /poker-host.html` → `200`, shell branding confirmed rendered (brand header, purple room-code accent, Montserrat). One bounded smoke-test table was created through the page's own real UI flow — no custom name field exists in the Poker schema (the room code is the only system-generated identifier), so the smoke evidence is identified by its live-generated room code `582W96` rather than a custom label, consistent with every prior Poker proving case in this engagement. `POST /api/gaming/poker/tables` → `201`; room code rendered; the polling `GET` returned a clean `200` ("No hand in progress"); `btn-start-hand` confirmed present, enabled, and correctly labeled. `/poker-table.html` confirmed healthy with zero console errors. This table was intentionally left in its pre-hand state — no hand was started, since the smoke-test plan only required proving the create → poll path.

**Quiz route production proving.** `GET /quiz-playtest.html` → `200` (previously `404`, now correctly live). Both actions confirmed pointing at `/host.html`/`/participant.html`, both independently confirmed `200`.

**Desktop production proving.** Homepage screenshotted live at 1280×900: corrected Featured copy, all four Skill Games cards (Trivia/Quiz/Poker/Duel) visible in one row with icons and correct statuses, matching the local pass exactly.

**Mobile production proving.** Verified directly on the live URL, not assumed from the local pass: `document.documentElement.scrollWidth === window.innerWidth` at 375px on the homepage (zero horizontal overflow); homepage and Poker Host (pre-create and the smoke-test's post-create state) both screenshotted at 375×812 and confirmed visually clean.

**Backend regression, verified live:** `GET /api/gaming/predictions/matches` → `200`; `GET /api/gaming/leaderboard` → `200`, honestly empty (`{"entries":[]}`); `GET /api/gaming/config` → `200` (unchanged environment state, not investigated further, not reopened). `host.html`, `participant.html`, `trivia-playtest.html`, `soccer-predictions.html`, `leaderboards.html`, `rewards.html` all confirmed `200`.

**Zero automatic consequence, confirmed by direct row counts before and after this deployment:** `duels` = 10, `duel_responses` = 8 — both **unchanged** from the prior Duel Mechanic Boundary deployment's own final figures, proving this frontend-only Slice touched zero Duel backend state. `authority_grants` = 0, `admin_audit_events` = 0 — **PLATFORM GOVERNANCE NOT ACTIVATED**. `gaming_members` = 0, `gaming_xp_events` = 0 — **GAMING XP NOT ACTIVATED**. `poker_tables` rose by exactly one (the bounded smoke-test table above) — the only production data mutation this deployment caused.

**Schema state, unchanged:** production remains at migration `0136` applied, `0125` still deliberately unapplied — this Slice contained no migration and required none.

**Final regression, re-run after production proving:** 641/641 behavioral, 144/144 contract, `tsc --noEmit` clean, `npm run build` clean.

**Duel release boundary, confirmed live:** Duel remains genuinely non-playable in production — no href, no onclick, no competitor picker, no participant controls, no mechanic renderer exist anywhere in the deployed page. The backend correction from the prior Slice remains live and untouched; only the discovery card's own honesty changed.

## Application Shell Convergence Slice 001 — Home and Discovery (Product Integration, 2026-10-16)

**Status (current source-control state): committed locally on a feature branch; not pushed.** The implementation is committed locally as `22902772d3d58d53433dc2d125111bb33f94c703` on branch `feature/application-shell-home-discovery-slice-001`, whose parent is `a816e4003417e9f453bad854f64d7d7d141f4f10`. Nothing has been pushed, merged, deployed or released, there is no migration, and no provider was accessed; push remains unauthorized. The one validation item still open — actual 200% browser zoom in a 390 px browser window — is deferred to Preview/release validation (see Zoom). A later documentation-only commit updates this status record; it is not the implementation commit, and the implementation commit above is unchanged. This section is evidence for the events it records; it does not authorize a Slice 002, a push or a release.

**Source-control history of this Slice.** (1) *Original local-validation event (historical).* The implementation was written and validated locally in an isolated detached worktree, with nothing committed, staged, pushed, deployed, migrated or provider-accessed, and it then awaited lane-specific Code Review and Founder acceptance; the account of that event below, including its validation figures, is preserved as recorded. (2) Founder and Code Review then accepted the corrected local implementation and authorized source-control preparation: one named local branch and one local commit. (3) The implementation was committed locally as the commit named in the Status above.

**Governance.** URBANO Gaming — Product Integration is a bounded cross-portfolio implementation workstream governed by Canon & Sequencing. Product & Experience Design owns the frozen visual reference (baseline `bb5d1bd8`); this Slice implements it for one page and does not redefine it. Implementation and local validation were originally done in an isolated detached worktree created from exactly `a816e4003417e9f453bad854f64d7d7d141f4f10` (= `origin/main` = `origin/integrate/join-session` at the time), with no branch and no commit at that time; the Slice has since been committed locally on a feature branch, as recorded in the Status above.

### What changed

Only `public/index.html` changed behavior. The Home is now a discovery page with this bounded structure:

- Navigation: **Home, Play, Experiences, Competitions, Host** (stable anchors `#play`, `#experiences`, `#host`; Competitions is a direct link to `/competitions.html`). No Profile.
- **Play** — Mini Games: URBANO Rutas and URBANO Towers (`Playtest`). Hosted group games: Trivia and Quiz (`Playtest`, existing destinations) and Duel, informational only ("Available inside hosted Sessions — no standalone play."; not a link, not focusable).
- **Experiences** — Soccer Predictions (Dedicated Experience, date-independent copy), **Poker** (Dedicated Experience, `Playtest`, player-side route `/poker-table.html`), Community Voting and Level 33 (non-actionable, `Future`).
- **Competitions** — one entry, exact visible label `Competitions`, link exactly `/competitions.html` (bare, same-origin; no query, fragment, competition-derived name/count/status/invitation/team/participant data; never `competitions-admin.html`).
- **Host** — four distinct entries: Session Host (`/host.html`), **Poker Host** (`/host.html?experience=poker`), **Competitions** (member-facing, bare `/competitions.html`; organizer authority is named only as a separate approval through Become a Host — see the copy correction below), and Become a Host (server-controlled, see below). Venue Operations is not offered.
- The stale hard-coded Soccer fixture (teams, venue, date/time, "Live now") is removed and not replaced with another dated or live-looking item. The horizontally scrolling carousel and the Featured block are gone with it.

Not exposed or implied anywhere: Pulse, Race, Rebote, Daily, automated matchmaking, other Competition sports, persistent Gaming XP or rewards, Profile.

### Become a Host (Host availability seam preserved)

The seam is unchanged in substance: first paint is the closed informational card; the card becomes a link to `/become-a-host.html` only when the shared reader `public/hostAvailability.js` (unchanged) resolves `true`, i.e. HTTP 200 and a body of exactly `{"available":true}`. Pending, failed, timed-out, malformed, non-200, reader-missing and `{"available":false}` outcomes all leave it closed and non-actionable. `/become-a-host.html` appears exactly once in the markup, only inside the script; a `<noscript>` fallback renders the closed card with no link. Exactly one availability request per load, GET, credentials omitted.

### Frozen assets (copied byte-for-byte; source = `URBANO Gaming Design Baseline.zip`, SHA-256 `e093b7ea9378f7c3823960c259e6027956a8e3ecd4156a3001a6bda13f06c3d9`)

| Baseline entry | Repository path | SHA-256 (source = destination) | Bytes |
| --- | --- | --- | --- |
| `Logos/Pixel Mark Proposals/URBANO Gaming Unframed Lockup Digital Glow Proposed.svg` | `public/assets/brand/urbano-gaming-lockup-digital-glow.svg` | `fd3d54590a7486e68b4a45cc6e2856079b4a80dee4a6f533e795cf3aeb9c61c6` | 6133 |
| `Logos/Pixel Mark Proposals/URBANO Gaming Unframed Lockup Structural Proposed.svg` | `public/assets/brand/urbano-gaming-lockup-structural.svg` | `b15b7d4e70d992b4c4e4030680e2957eb3c77e2f4f3c64376453fa85e50da2cb` | 5474 |
| `Logos/Pixel Mark Proposals/URBANO Gaming Pixel Symbol Optical Small No Glow Proposed.svg` | `public/assets/brand/urbano-gaming-symbol-optical-small.svg` | `708a69e652701ef6396a6fc860d106a8eda9065ff17df048376924cc0e0eafa0` | 1699 |
| `Product/Brandbook/Fonts/Montserrat Variable.ttf` | `public/assets/fonts/Montserrat-Variable.ttf` | `0f7b311b2f3279e4eef9b2f968bcdbab6e28f4daeb1f049f4f278a902bcd82f7` | 744936 |
| `Product/Brandbook/Fonts/OFL.txt` | `public/assets/fonts/OFL.txt` | `8b7141c03fa4f8d44e6345d5d4931709290f0f67875e452e95ac1fd3a027802e` | 4400 |
| `Product/Brandbook/Fonts/Font provenance.json` | `public/assets/fonts/PROVENANCE.json` | `2d9cb6610e6e86753d5edb81453e19f1225fbf65d3652eee71e1c928c36c19c1` | 476 |

The lockups are used only through `<img>`/`<picture>` (never inlined) because the frozen SVG files carry an internal "proposed" title that must not become an accessible name. No editorial artwork PNG was copied. `public/urbano-mark.svg` is untouched and still used by the sibling pages.

Brand behavior: the digital-glow lockup is the default presentation (≥ 821 px); the structural lockup is selected by `prefers-reduced-motion: reduce`; at constrained widths (≤ 820 px) the optical-small symbol plus visible `URBANO`/`GAMING` text replaces the lockup. Montserrat is served locally with a system fallback stack; no Google Fonts or other external provider, and the Home requires no external network dependency to render.

### Decisions to flag for review

1. **Poker destination.** The Dedicated Experience entry routes to `/poker-table.html` (the player-side surface), so it cannot be confused with Poker Host (`/host.html?experience=poker`). Review may prefer a different existing player-side route.
2. **New wording** introduced by this Slice and not taken from a frozen artifact: the `Future` pill (Community Voting, Level 33), the `Not open yet` pill and "Host applications are not open yet." (closed Become a Host), the hero copy, and the group/section lead lines.
3. **Leaderboards and Rewards** are no longer linked from the Home (navigation is bounded to five items). Their pages are unchanged and still reachable directly.
4. **Brandbook 0.5 is not final.** The frozen lockups are labelled "Proposed" in their own metadata; this Slice implements them as the frozen reference without declaring them final.
5. **Decorative arrow (copy correction).** The Host section's Competitions action label is exactly `Explore Competitions`; the arrow that every other card spells as a literal `→` is, on that card only, generated by CSS (`.exp-action-arrow::after`, empty alternative text), so the label's own text is the accepted wording while the card still looks like its three siblings. If a literal `→` in the text is preferred, it is a one-line change.

### Competition copy correction (UG Code Review — Competitions: `ACCEPT_WITH_COPY_CORRECTION`, 2026-10-17)

The Host section's third card — the Competition card, formerly titled `Competition Organizer` (Become a Host is fourth) — now reads exactly:

- Title: `Competitions`
- Explanatory copy: `Explore competitions as a member. Organizing a competition requires separate approval through Become a Host.`
- Action label: `Explore Competitions`
- Destination: `/competitions.html` (bare, same-origin; the card is the only anchor)

The card no longer implies that the current member holds organizer authority, and it does not claim Become a Host is open (it names Become a Host in words only and never links to it). The other two Competitions links — the navigation item and the Competitions section card — are unchanged. The four Host concepts stay apart: Session Host, Poker Host, the member-facing Competitions entry (organizer authority being the separate approval it points at), and the server-controlled Become a Host application. No Competition behavior, Become a Host behavior or Poker route changed.

Test changes (no existing assertion weakened): titles, entry fixtures and counts in `homeDiscovery.test.ts` and `hostAvailability.test.ts` now expect `Competitions`; one existing assertion had to be adapted because the accepted copy deliberately names Become a Host — `hostAvailability.test.ts` formerly forbade the word `become` anywhere in that entry's text, and now tolerates it only inside the exact accepted sentence (any other `become` in the card still fails) while also requiring the exact copy and action label, no nested anchor, and no `organizer`, `admin`, `console`, `apply` or `invitation` text. A new block in `homeDiscovery.test.ts` pins the exact title, copy, action and destination, and carries 16 in-suite negative controls plus a runtime control, each a copy of the shipped page with one defect: the title `Competition Organizer`; organizer-authority copy (two variants); the previous copy and action label; a copy claiming Become a Host is open; a copy carrying Competition context; a direct admin destination; a direct organizer-console destination; a query string (`?c=&t=`); a fragment; falling through to the application page; an application link added inside the card; an admin link elsewhere in the Host section; the navigation link gaining a query; the section card gaining a fragment; and a closed Become a Host entry that carries the application href.

Mutation check on the real page (both Home and Host suites run against each mutated copy of `public/index.html`, restored byte-identical afterwards): all 13 mutations were rejected — the title `Competition Organizer`; two organizer-authority copies; a direct admin destination; `?c=&t=`; a fragment; fall-through to the application page; Competition context in the copy; a closed entry carrying the application href; first paint opening Become a Host; the old action label; the navigation link gaining a query; the section card gaining a fragment.

### Tests

- New `__tests__/homeDiscovery.test.ts` (76 tests after the copy correction; registered in the explicit `npm test` list): document structure and landmarks, heading hierarchy, skip link, exact navigation and anchors, closed same-origin link inventory, the full Competitions contract, Poker vs Poker Host separation, status truthfulness (Duel informational; Rutas/Towers `Playtest`; Voting/Level 33 non-actionable), absence of Pulse/Race/Rebote/Daily/matchmaking/XP/Profile/other sports, stale fixture removed, no external host or font provider, local asset paths and frozen-hash verification, brand lockup selection, focus-visible and reduced-motion provisions, 44 px targets, palette and contrast (computed), and responsive document structure (including the pill-wrap fix found in the browser pass) and the Host section's Competitions card contract with its negative controls (above).
- `__tests__/hostAvailability.test.ts` extended (38 → 41 tests): locator re-anchored to `#host-entries .exp-card`, open/closed assertions re-pointed at the four-entry Host list, and the old "rest of the landing page unchanged" test replaced by four tests (four distinct entries; plain entries identical across readiness states; the Host section's Competitions entry is a bare link with the exact accepted copy and the only application link is Become a Host's; no Venue Operations and four distinct explanations). All negative controls (mutated page and reader), fail-closed cases and the 320 px header CSS pins are retained and pass; only control 1's mutation anchor and the locators and script regexes were re-pointed at the new Host markup, while controls 2–6, the other negative controls and the CSS pin tests are untouched.
- The Home tests were mutation-checked twice. First pass: six deliberate defects (Competitions link gaining a query, Duel becoming a link, an external font import, Pulse appearing, Rutas labelled Available, focus ring removed) each failed the suite. Second pass (copy correction): the 13 mutations listed above.

### Verification (local, clean environment — no `.env.local`, no provider variables)

- `npm test`: 42 files, 1706 tests passed (baseline before this Slice: 41 files, 1627 tests; the 1683 recorded before the copy correction became 1706 with its 23 new Home tests). `npx tsc --noEmit`: clean. `npm run build`: clean.
- Real-browser validation against a production build served locally: no horizontal overflow at 320, 360, 390, 768 and 1280 px, and at a 195 CSS px viewport (a viewport simulation, **not** browser zoom — see Zoom below); keyboard-only traversal covers 19 focus stops in DOM order starting with the skip link, every stop showing a 3 px `:focus-visible` outline; the three anchors and the skip link work; Become a Host closed (no application link) and, using only a local `BECOME_A_HOST_SCHEMA_READY=true` test control, explicitly open; all page requests same-origin; frozen assets served byte-identical.
- A defect found by that pass and fixed in this Slice: the `Not open yet` pill (127 px) overflowed its card by 17 px and the page by 1 px at 195 CSS px. `.exp-card-top` now wraps and `.pill` is capped at its container width; pinned by a test.
- Reduced motion: confirmed by headless Chrome with `--force-prefers-reduced-motion` (only the structural lockup is requested; the default requests only the digital-glow lockup); the animation/transition/scroll-behavior suppression is verified by static CSS assertions rather than a computed-style probe.

**Zoom.** The in-app browser cannot change zoom: eight zoom-in key presses left `innerWidth` at 1024 and DPR at 2, and the only control it offers is viewport emulation. A locally installed Chrome 155 can. It was driven headless over the DevTools protocol in throwaway profiles carrying Chrome's own page-zoom preference, with every non-localhost name lookup blocked. Desktop Chrome will not go below a 500 px window, even through its own window API, so a 390 px browser window could not be produced. Genuine results, against the corrected page: a 100% control gave `innerWidth` 500 at DPR 1; **genuine 200% zoom gave 250 CSS px at DPR 2**; genuine 256% zoom gave **195 CSS px** at DPR 2.56. At both zoom levels, with Become a Host closed and with it explicitly open (local test control): no horizontal overflow, all 19 exercised focus stops `:focus-visible` (the closed state has exactly 19 stops; the open state has 20, of which the first 19 were exercised; the ring is 3 px at 200%, and Chrome snaps it to 2.73 px at 256% to whole device pixels), the exact accepted Competitions copy, no application link while closed and one only on the server's `true`, no external resource, one availability request. **The literal item — actual 200% browser zoom in a 390 px browser window — remains an unresolved manual-validation item.** The 195 CSS px viewport simulation, and the genuine 256% zoom that yields the same 195 CSS px layout width, are stress evidence, not a substitute for it.

### Files changed (Application Shell Convergence Slice 001)

`public/index.html`, `__tests__/hostAvailability.test.ts`, `package.json` (one entry appended to the `test` script), `APPLICATION_SHELL_IMPLEMENTATION_RECORD.md` (this section), `__tests__/homeDiscovery.test.ts`, and the six asset files above. Nothing else.

### Remaining gaps

- Competitions: the destination page, its invitation handling and its API are unchanged and unreviewed here; the Home links to the bare page only.
- Production behavior, deployment and the real sign-in flow were not exercised (provider-free by design; the shared sign-in script reports a configuration error in that environment and the Home still renders).
- Become a Host remains closed in Production; activation is a separate Founder gate.
- Actual 200% browser zoom at a 390 px browser window: unresolved; deferred to Preview/release validation, where it requires manual validation (see Zoom).
- Real-device and screen-reader testing were not performed.
