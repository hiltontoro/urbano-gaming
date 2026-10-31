# Home — Featured Card and Four Experiences — Implementation Record

**Status: LOCAL CANDIDATE. Uncommitted. Not pushed, not deployed.** Worktree `worktrees/urbano-gaming/home-four-experiences-001`, branch `claude/home-four-experiences-001`, cut from `origin/main` @ `98bb902`.
**Date:** 2026-10-31 · **Authority:** explicit Founder instructions in chat (Hilton Toro), 2026-10-31, in this order:

1. Redesign the Home so the four main experiences are seen on entry, each as an "experience" with **one** button, "Discover more", that opens its own page; no "play now" buttons; no link that does not work (traffic expected the same day). Keep the ten crests on the Score panel ("it adds validity"); generate AI pictures for Score and Trivia like the Halloween and Poker ones.
2. (Spanish) The four are **URBANO Voting** (renamed from "Community voting"), **URBANO Score**, **URBANO Trivia** (renamed from "Noches de Trivia") and **URBANO Poker**; remove the "more experiences" block from every page ("it only confuses"); replace the football-pitch picture of Score with an AI picture about sports, several sports if possible; Trivia with an AI picture of people playing trivia; Poker stays; add an extra **"Destacado"** card for **Halloween · The Pub by Beer Box · 31 de octubre**, an URBANO Voting experience, whose two buttons (instead of "Discover more") say **"Votar por tu disfraz favorito"** and **"Participar como concursante"**.
3. The Founder supplied the three photographs (Score multisport, Trivia on a phone, Voting) made with built-in OpenAI image generation; the originals and their prompts are in `Product/AI Photos/2026-10-31/`.

This record is evidence for a reviewer. It grants nothing and releases nothing.

## 1. What the Home is now

`public/index.html`: the header and navigation of the shell, a hero, then

* **the featured card** (`article.xf#featured-contest`, label "Destacado", kicker "URBANO Voting", title **Halloween**, "Concurso de disfraces · The Pub by Beer Box · 31 de octubre", one sentence, two buttons, one status sentence);
* **the four experiences** (`ul.xp-grid#play`, in the Founder's order): URBANO Voting → `/voting.html`, URBANO Score → `/score.html`, URBANO Trivia → `/trivia.html`, URBANO Poker → `/poker.html`. Each panel is an `article.xp` with a kicker, a title, a description and **one** link (`a.xp-cta`, "Descubrí más" / "Discover more", whose accessible name carries the experience's name). The whole panel is the tap target (the link's pseudo-element covers it, with no radius of its own, so every corner answers).

The four panels are static (every word in the first HTML, no request of their own). The only thing the page asks a server is the featured card's one answer (§2). No page lists the other experiences (the "more experiences" block and its key are gone); each page has "← Todas las experiencias" back to `/#experiences`.

Shared stylesheet `public/experience.css`: the shell (copied unchanged from the old Home), the panels, the featured card and the pages. The four pages are generated from one template and share the Home's header, navigation and footer (a test pins that they are identical).

| Page | Content | Links out |
|------|---------|-----------|
| `/voting.html` | Lead, the Halloween block (the same two buttons, same module, same rules), "Cómo funciona" (sign in with email code → one vote per category, changeable until close → results after the team reviews), "Bueno saber" | none except the featured block's two, when live |
| `/score.html` | Lead ("Por ahora solo hay fútbol disponible"), three steps, notes | `/soccer-predictions.html` and `#historial` (the existing application) |
| `/trivia.html`, `/poker.html` | Information only | none |

The copy of `/voting.html` is taken only from facts already stated by the voting lane's own page (email code, one vote per category changeable until close, results published after review); no prize, sponsor, fee, capacity or rule is invented (a test scans the `lp.voting.*`, `home.feat.*` and `home.xp.voting.*` keys).

**Removed from the Home** (by direction): the "Próximos partidos" card, the Poker / Trivia / Rutas / Towers / Become a Host / Competitions cards, the old Halloween announcement, and the intermediate `halloween.html` page of the first iteration (never committed). Nothing else was deleted from `public/`: `homeUpcoming.js`, `homeUpcomingData.js` (still loaded by the Score page), `urbanoClubCrests.js`, `hostAvailability.js` are untouched. The old Home is kept verbatim in `archive/home.score-card-2026-10-29.html` and in git at `98bb902`.

## 2. The featured card and the voting lane's server

The two buttons are **words in a dashed outline, not links** in the first HTML, and the sentence under them says that registration and voting are not available yet. `public/featuredContest.js` (the only place that decides) asks the server **once** (`GET /api/gaming/community-voting/contests/featured`, no credentials, no cache, 8 s timeout) and turns them into real links **only** for the exact documented answer of the Community Voting four-category branch (`claude/halloween-four-category-001`, read in that session's worktree, uncommitted there: `getFeaturedContest` in `lib/gaming/communityVoting/contest/operations.ts`):

```
{ featured: { contestId, voteUrl: "/community-voting-round.html?c=<uuid>", registerUrl: "/community-voting-round.html?c=<uuid>&participar=1",
              phase: NOT_OPEN|OPEN|CLOSED|RESULTS, registration: { phase: NOT_SCHEDULED|NOT_OPEN|OPEN|CLOSED, … },
              categories: [{ name: { es, en }, … }], … } }
```

* "Votar por tu disfraz favorito" → `voteUrl` (the contest's front door); "Participar como concursante" → `registerUrl` (opens straight on the registration form). Both pages are public; completing either needs the verified-email sign-in and a Gaming profile, which that page asks for.
* The answer is checked strictly: both URLs must be of exactly those shapes **and about the same contest id** (and `contestId`, if present, the same); `phase` one of four words; `categories` a non-empty list. `{ featured: null }`, a 404 (**the endpoint is not deployed: this is what Production answers today**), a 500, a late or malformed body, a URL to another site or page, extra parameters, the two buttons swapped, two different ids, an unknown phase, a contest with no category → **no link at all**; the card stays as written.
* The sentence under the buttons says where things stand: while voting has not opened, where registration stands when the server says (`Las inscripciones abren pronto / están abiertas / ya cerraron.`), then where voting stands (`La votación se abre pronto / está abierta / ya cerró.` / `Ya están los resultados.`); category names are listed, drawn as text only (never markup). A change of language repaints the card.
* It sends nothing, stores nothing, and never blocks the page.

**What this means for release:** the featured card does nothing useful in Production until the voting lane's work is released (the page, the contest API, 12 migrations applied in order, the operator allow-list, the four categories created and the contest **listed** by the operator with "Mostrar el concurso en Inicio"). None of that is on `origin/main`. Until then the Home shows the dashed words and the honest sentence; **once it is released and listed, the buttons become links with no further Home release.** Nothing here depends on that lane's code: it is tested against the documented answer with a stubbed network and against every other answer a browser could receive.

**Coordination:** the other lane must not also edit `public/index.html` (this change rewrites it), and its own `public/homeContest.js` (which edits ids of the old Halloween card) would find none of those ids on this Home. Its contest page is Spanish only, and its sign-in email link returns to the Home rather than to the contest page (both found by the research; for that lane).

## 3. A defect found and fixed before it shipped

`/urbanoAuth.js` declares `const UrbanoAuth` at top level: a global binding, **not** a property of `window`. The first version of the pages guarded the sign-in call with `if (window.UrbanoAuth)`, which is false in a real browser, so the header's sign-in control would never have been attached or revealed. Caught by the existing `i18nModuleFailure` test (it runs the real shared client); fixed with `typeof UrbanoAuth !== "undefined"` on all five pages, and pinned by tests that run the real client through jsdom's own script loading on all five pages (control revealed, panel opens in Spanish; static check that no page uses `window.UrbanoAuth`).

## 4. The crests

Kept on the Score panel as the Founder asked: same markup (`ul.ten-crests > li.crest-chip[data-club]`, ten teams in the Founder's order of 2026-10-29), same label (`home.upcoming.teamsLabel`), same approved sentence (`upcoming.disclaimer`: the crests only identify the teams; URBANO is not affiliated with, sponsored by or endorsed by any club, league or competition), drawn by the unchanged central module. The crest registry's rule stands: showing crests establishes **no licence**, so the sentence is never separated from the strip (a test pins that they are one unit) and no copy presents the crests as a guarantee or endorsement. In a wide card the strip sits in its own dark box (two rows of five), in a stacked card one row of ten, five again at 320 px; with no crest drawn the names have their own layout.

## 5. Pictures

Five photographs, all small local WebP derivatives (1280×720, cover crop, lossy quality 72, simple `VP8 ` container), each pinned by hash and weight in `__tests__/homeArtCards.test.ts` with its source hash; **no picture is a drawing made in code any more** and none appears twice on the Home:

| File | Where | Source | Bytes |
|------|-------|--------|-------|
| `halloween-community.webp` | the featured card | `Halloween voting.png` (Founder Design Review artwork package) | 48 926 |
| `urbano-voting.webp` | URBANO Voting panel and page | `URBANO Voting.png` (Founder, OpenAI image generation; prompt kept beside it) | 27 702 |
| `urbano-score.webp` | URBANO Score panel and page | `URBANO Score Multisport v2.png` (football, basketball and American football) | 80 896 |
| `urbano-trivia.webp` | URBANO Trivia panel and page | `URBANO Trivia Mobile v2.png` (four friends answering on a phone) | 42 326 |
| `urbano-poker.webp` | URBANO Poker panel and page | `Poker table.png` (unchanged) | 34 368 |

The Voting photograph is a **conceptual promotional photograph, not a screenshot of an implemented interface**: the portraits on the phone are not the screen of any URBANO page. The Score photograph shows three sports while the copy says that for now only football is available ("Por ahora solo hay fútbol disponible."); the page states that explicitly. The stadium photograph without provenance stays unpublished (a test pins that it is not in the tree). Total 234 218 bytes (budget 300 000).

## 6. Layout

Two shapes of card, chosen by width. From 641 px a panel is a **wide card**: the picture fills it and the words sit on its dark left side over a scrim that opens to the right (two columns from 900 px, one column from 641 to 899). Up to 640 px it is a **stacked card**: the whole 16:9 picture on top (nothing cropped, nothing over it) and the words below it; the featured card follows the same two shapes with its two buttons full width on a phone. Measured in headless Chrome at 375 / 820 / 1440 px: no horizontal overflow; the buttons are at least 44 px high; the focus ring is visible; motion is a pointer-device refinement and is off for reduced motion.

## 7. Tests — triage

Method: every previously passing assertion about shipped behaviour was kept or ported; assertions whose **only subject** was a removed card were retired, with a tool that removes exactly the tests that failed in a recorded run (and nothing that passed), then prunes empty blocks and unused helpers. Retired tests remain in git history at `98bb902`.

| File | After | What happened |
|---|---|---|
| `experienceHome.test.ts` (new) | 157 | The featured card and the four panels and their order, one link each, no play/join controls, no dead link or file on the five pages, headings, shared frame, language table (Spanish default = markup, English present, fallback = module), the featured card's module against the documented answer and against 39 other answers, each on the Home and on the Voting page (strict URL shapes, same id, phases, registration states, text-only categories, English, no module), the real shared sign-in client on all five pages, the crest strip, the CSS contract (columns, whole-panel tap target, motion, scrim, legibility, no sideways scroll) |
| `homePredictionsEntry.test.ts` | 134 | 144 tests that booted the old Home to exercise the card were retired; the module-level tests (the module the Score page still runs) are unchanged |
| `homeArtCards.test.ts` | 6 | The asset registry and its provenance kept (five photographs, no drawing); the cards' availability, wording, CSS and negative controls retired (the legibility principles are pinned for the panels in `experienceHome.test.ts`) |
| `hostAvailability.test.ts` | 15 | The Home's Become a Host card tests retired (the same fail-closed matrix is proven on the shared reader by `hostDirectPageReadiness.test.ts`); route tests and the 320 px header rules kept |
| `i18nModuleFailure.test.ts` | 86 | 13 Home-card tests retired; the differential compares the new Home's panels, featured card, strip, header and footer with and without the module (a leftover duplicate key found by `tsc` was removed) |
| `clubCrests.test.ts` | 64 | Ported to the Score panel and `experience.css` |
| `shellPublic.test.ts` | 43 | Shell contract kept; Spanish-first, English and "honest cards" ported to the panels and the featured card |
| `urbanoScoreName.test.ts` | 26 | Ported to the Score panel and `/score.html`; the route `/soccer-predictions.html` is unchanged and `/score.html` is a page that links to it |
| `urbanoI18n.test.ts` | 31 | The five pages are wired to the table; names legitimately the same in both languages allow-listed |
| `participationWindow.test.ts` | 14 | The Home keeps no clock |

`package.json`: `experienceHome.test.ts` registered in the explicit `npm test` list.

## 8. Evidence

`npm test` → 84 files, **3725 / 3725** passed (exit 0). `npx tsc --noEmit` → exit 0 (it caught one duplicate object key left in `i18nModuleFailure.test.ts` from the port; removed). `npm run build` → exit 0.

Real headless Chrome (my own process; GET only; a local static server plus a local stand-in that answers **only** the featured URL; no sign-in, no OTP, no write of any kind), 375 / 820 / 1440 px, Spanish and English, on the Home and on `/voting.html`:

* **Eleven answers of the server** — `404` (today's Production), `{ featured: null }`, `500`, an answer whose URLs point to another site, and voting `NOT_OPEN` with registration `NOT_SCHEDULED` / `NOT_OPEN` / `OPEN` / `CLOSED`, voting `OPEN`, `CLOSED`, `RESULTS`. The first four leave **no link at all** (two dashed outlines, default cursor, "Las inscripciones y la votación todavía no están disponibles."); the other seven draw two real links with exactly the documented addresses (`…?c=<id>` and `…?c=<id>&participar=1`), 46–48 px high, the four categories as text, and the sentence for that phase ("Las inscripciones están abiertas. La votación se abre pronto.", "Registration is open. Voting opens soon.", …).
* No horizontal overflow at any width; no console error other than the expected "no Supabase configuration" of a server with no API; every picture painted (a full-page capture of a long phone page shows lazily decoded pictures as blank unless the page is scrolled first, which is a property of the capture, not of the page).
* Keyboard: after the navigation, Tab reaches the vote link and then the participate link, each with the 2 px gold focus ring.

Screenshots were sent to the Founder in the conversation.

## 9. Not done / for the Founder

* **Nothing is committed, pushed or deployed.** No Preview has been built.
* The featured card is wired but **inactive until the voting lane is released and the operator lists the contest** (§2); until then it shows the dashed buttons and "Las inscripciones y la votación todavía no están disponibles."
* The Halloween card is time-bound ("31 de octubre"): after the event it needs the Founder's decision (remove, or let the operator unlist the contest).
* The voting lane's contest page is Spanish only and its sign-in email link returns to the Home; the English Home leads to a Spanish page.
* Where the Become a Host entry goes when applications open (it left the Home with its card); where Poker / Trivia hosts find their entries (direct URLs unchanged).
* The Voting photograph is conceptual, not a screenshot; the Score photograph shows three sports while only football is available (the copy says so).
* Dead dictionary keys (`home.upcoming.*`, `home.poker.*`, `home.host.*`, the old Halloween announcement keys) remain in the language table; removing them is a separate clean-up.
* Signed-in behaviour was not validated; no OTP, account, vote, registration or database write was made.
