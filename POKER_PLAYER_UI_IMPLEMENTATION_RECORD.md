# Poker Player Table UI — Slice 001 Implementation Record

Status: local candidate, **uncommitted**, awaiting Poker Code Review and Founder visual acceptance. Not pushed, deployed, migrated, or tested against any database.

Revision 3 (Founder's unified green table direction) supersedes the arrangement of separate community-card, private-card and action panels described by revisions 1 and 2: see "Layout hierarchy (revision 3)" below, which is the controlling description. The data rules, action rules, wording rules and safety sections are unchanged by it.

Revision 3 was reviewed independently (five read-only reviewers, then an adversarial verifier per finding: no blocker, no major; 21 verified minor or nit findings). Triaged under the narrow-scope rule, the findings tied to this gate's contract were fixed: the "Out of date" tag could wrap onto its own line at 320px with a pot of three or more digits and push the controls down (it is now out of the flow, in a reserved band; measured: 0px displacement of the table top, the cards, the action section, the amount field, the pot row and every action button in 26 clean live/stale pairs, which carry the same typed amount in both states); the full notice was off-screen at the smallest scroll that shows the buttons (a one-line reminder now sits directly under the buttons); "Sending…" stayed on screen after an accepted action whose refresh failed; an action answered after the page had left the table redrew the old table into the cleared container; the page's own "Join a different room" button was about 39px tall (it is now 44px, by a Poker-scoped sibling rule); and several tests were strengthened or given negative controls (see "Review outcome"). Everything not fixed is listed under "Known limits" or "Transfers".

Revision 2 (bounded corrections, `RETURN_FOR_CORRECTIONS`): the action area is no longer pinned (see "Small-screen layout"), and the result wording was made neutral wherever the result record is ambiguous (see "Result wording"). Revision 2 was then reviewed independently (four read-only reviewers plus an adversarial verifier per finding: no blocker, no major); the findings it confirmed were fixed or are listed under "Known limits". Everything else below is unchanged.

Base: `b8bfe39762eb71780ccf5c9f3bf84f36a20e7902` (origin/main) plus the carried safety commit `5e4f34a1f5b970a0e514ddcaba89d1e14a80666b` (`fix(gaming): render Poker player names safely`, carried from `78daa2f`).

## Scope

The accepted visual direction (classic green felt, charcoal, readable ivory, restrained URBANO purple/gold) applied to the Poker **player table only**. Visual direction only: rules, data meaning and actions come from the repository's read model, not from the design prototype.

Changed paths:

| Path | Change |
|---|---|
| `public/pokerParticipant.js` | Player-table rendering rewritten; connection-failure behaviour; amount validation. Public API unchanged. |
| `public/participant.html` | Poker-scoped `<style>` only: the Poker-only rules were replaced by one marked block. The old Poker `:root` tokens and the `.msg` rules were left exactly as they were: nothing else in the page uses them and the new block overrides `.msg` inside `.pk-root`, so they are inert here (removing them is a separate cleanup). Every selector in the block hangs off `.pk-root`, with one deliberate exception that a test pins: `.pk-root ~ .btn-ghost`, the room's own "Join a different room" button that follows the Poker container (a 44px minimum). Bytes outside `<style>` are identical to the base. |
| `public/poker-table.html` | The same marked block, identical to `participant.html`'s (a test fails if they drift). The old standalone `.felt` rule and its comment, outside the block, were removed; the `--felt` token stays in `:root`, now unused by Poker. Bytes outside `<style>` are identical to the base. |
| `__tests__/pokerParticipantUi.test.ts` | New (see the report for the current test count). |
| `package.json` | `scripts.test` only: the new file registered after `pokerPagesDomSafety.test.ts`. |

Not touched: Host surfaces, `sessionSync.js`, `urbanoAuth.js`, Home/navigation, API/domain/repository/migration code, joining flow, the rest of `participant.html`, translation, Predictions, Competitions, `__tests__/pokerPagesDomSafety.test.ts`.

## Layout hierarchy (revision 3)

The Founder's direction: the green felt belongs only to the panel that represents the Poker table, never to the page. The player should perceive ONE playing surface containing what is needed to act.

**Inside ONE continuous green table (`#poker-table`, class `pk-table felt`, `role="group"`, label "Poker table")**, as sections told apart by labels, spacing and hairline dividers (no nested cards):

1. the turn strip: "Your turn", "Waiting for Sam to act", "Hand complete…", "This table has ended…" (words first; the purple bar is only emphasis);
2. the pot ("Pot", or "Final pot" with its note once the hand is complete); while the connection is stale, a small "Out of date" tag sits in the table's own top band (extra top padding the table always has), positioned out of the flow so it cannot take a line of its own, whatever the width or the size of the pot;
3. the community cards ("N of 5");
4. the player's own cards (private note, or "Folded");
5. the actions: Fold, Check/Call, Bet/Raise, All-in, the amount field with its hint and error, and the action feedback line (only when the server offers actions). While the table is out of date the feedback line, which is the last thing in the action area, also says "Actions are paused until the table refreshes." right under the buttons (it replaces only an empty line or "Sending…", never an earlier failure message, and is taken back on recovery);
6. the connection notice, LAST, below the controls (hidden unless a poll failed or the first load failed).

**Outside the table, on the ordinary URBANO page background (`#poker-info`):**

- the hand result card (a hand detail; the gate did not place it, so it sits first in the information area, a judgement call for the Founder);
- one information panel: the players (stacks, chips put in, statuses) and the room details (room code, hand number, street with its plain-language note).

Nothing in the information area repeats the turn line, the private cards or an action. The page body, `.pk-root` and the information panel have no green; the felt gradient is used by exactly one selector, `.pk-root .pk-table` (a test pins this).

Shell order: `#poker-live` (screen-reader announcements), `#poker-table` [`#poker-chrome`, `#poker-action-area`, `#poker-notice`], `#poker-info`.

## What the player now sees

Top to bottom: the green table (turn, pot, community cards, your cards, actions), then the result card when a hand has finished, then the information panel (players, then room details).

## Small-screen layout (correction 1)

The first candidate pinned the action area to the bottom of the screen. At 320×568 it covered about half the viewport and hid the player's own cards. The actions are now a section of the green table, in ordinary document flow, at every screen height (revision 3 keeps this and moves them inside the one felt):

- Nothing in the Poker UI is `sticky`, `fixed`, clipped or overlaid. A test fails if the Poker CSS ever contains `position: sticky|fixed` (prefixed or not), `clip-path`, `z-index`, an absolutely positioned element other than the visually hidden live region and the small stale tag (which a test shows lies wholly inside the band the table reserves for it, and which takes no taps), or a `box-shadow` spread beyond the 6px focus ring; other tests pin the touch-target, focus, font-inheritance, scroll-margin and wrapping rules.
- Shell order is `#poker-live`, `#poker-table` [`#poker-chrome` (turn, pot, community cards, your cards), `#poker-action-area`, `#poker-notice`], then `#poker-info` (result, players, room details): the table in playing order, then everything else. The connection notice is the last thing in the table, below the controls, the "Out of date" tag is out of the flow, and the one-line reminder is the last thing in the action area, so none of them can move the amount field or the buttons (measured: 0px shift of the table top, the cards, the action section, the amount field, the pot row and every action button between a live and a stale capture, in 26 clean pairs where both captures carry the same typed amount, so only the connection state differs: 10 standard pairs, and 16 stress pairs with pots of 3 and 7 digits, very long names, and a long "Waiting for <very long name> to act" turn strip, on both pages at 320 and 375 wide. A live capture with the default amount compared with a stale one with 120 typed does show the buttons below the field moving, because the help line under the field depends on the typed value, not on the connection).
- The amount field is an item of the same grid as the buttons, directly before the Bet/Raise it feeds: visually adjacent, and tab order is Fold, Call/Check, amount, Raise/Bet, All-in. The `.action-btn` order is unchanged: the safety test pins FOLD, CALL, RAISE, ALL_IN for one case, and `pokerParticipantUi.test.ts` pins the order (FOLD, CHECK, CALL, BET, RAISE, ALL_IN) for every legal-action combination it covers.
- A button group with an odd count gives its last button the full row.
- A focused amount field is scrolled into view by the browser, with 150px of `scroll-margin` below it so the help line and the Bet/Raise button it feeds come into view with it. Typed amounts survive polling and the stale state exactly as before (same field element, same value). The amount error is an alert region, written only when its text changes and written afresh when the player submits again.
- Measured with headless Chrome device emulation (not a real device) over a 60-capture standard matrix (both pages; 320×568, 375×667, 375×812, tablet 768×1024, desktop 1280×800; your turn, waiting, amount error, stale, showdown, closed) plus 74 further captures (both pages at 320 and 375: pots of 3, 5, 7 and 9 digits, very long player names with six-digit chip counts, a long turn strip, live and stale, the long names at showdown, and clean live partners that carry the same typed amount as their stale capture): the player's cards plus the whole action panel span 395–422px on your turn, 403–430px with an invalid amount typed, and 425–490px while stale (with the reminder line), so they fit in the viewport together after one scroll in all 30 of those captures (the tightest, 320×568 stale, is 490px of 568px); every action button is at least 125×48px and the amount field at least 50px tall; the page's own exit button is 44px tall; no horizontal overflow in any of the 134 captures, no sticky/fixed element, and no script execution. After focusing the amount field from the top of the page, the field and the Raise button below it were both inside the emulated viewport at 320×568, 375×667 and 375×812 on both pages (6 of 6). These are emulation measurements with no browser toolbars and no on-screen keyboard: they are not a guarantee on a real phone.

## Result wording (correction 2)

The result record cannot always say who "won". `handResult.pots[].payouts` are gross chips (an uncalled excess is handed back through the same list), and `eligibleSeatNumbers` says who could contest each pot. Real settlement splits the chips into layers by commitment level and pays, for each pot, only the best-ranked group among that pot's eligible seats. The first layer has every contender eligible, so the pots with the most eligible seats are the ones every revealed hand was compared for. Wording is only as strong as that evidence, and it fails closed. (An independent read-only audit of the settlement code and an adversarial attack on the first version of these rules shaped this table; its counterexamples are regression tests.)

| Where | Wording | Evidence required |
|---|---|---|
| Showdown headline | always the neutral "Hand complete" | none |
| Viewer line | "Your payout: N chips (you put in M)"; "You received no chips this hand." only for a viewer who was dealt in and a readable record | the viewer's own gross payout and stake |
| A revealed player's line | "**won**" | sole payee of a pot with the most eligible seats (the best hand among all contenders) |
| | "**shared the pot**" | one of several payees of such a pot (a tie, split by chips, not by strength) |
| | "**lost**" | received no chips from any pot of a well-formed record (in real settlement every revealed seat is eligible for the first layer, so this means outranked there; the verb does not re-check that, and it is the same zero-payout rule the original lines used) |
| | "**showed**" | everything else, notably chips paid only from a smaller part: chips handed back, folded players' chips, or a smaller contest. A deep stack can take a small layer and still be down on the hand, and a stronger hand can be absent from it, so neither "won" nor "lost" is said |
| | "**showed**" for everyone | the record is not well-formed: a pot lacks its eligibility or payout list, payouts are not positive numbers, they do not add up to their pot, or there are no pots |
| Each player's amount | "Payout N chips · put in M" | gross chips received and the chips that player bet (`committedThisHand`); nothing is subtracted, summed across players, called profit, or called a refund (a layer can also hold folded players' chips) |
| More than one distinct set of eligible seats | one neutral line: chips are paid out in separate parts, and a hand can be paid from a part a stronger hand could not take part in | the pots' eligible sets differ |
| No showdown | "X won — everyone else in the hand folded" only when exactly one seat is paid, that seat is not folded, every pot lists only that seat as eligible, and every other dealt-in seat is folded; otherwise "Hand complete" and one "X received N chips (put in M)" line per paid seat | |

Other consequences: another player who chose the display name "You" is shown as "You (another player)" so the viewer's own "You" cannot be spoofed; a player who joined mid-hand is covered by "in the hand"; no pot is ever called "main" or "side"; the gold styling follows only "won" and "shared the pot". The first candidate called a handed-back-chips player a loser, called every member of a tie a winner, and called any contested sub-pot winner a winner. The verdict logic is `showdownVerbs()` in `public/pokerParticipant.js`. No net-profit figure and no new gameplay semantics were introduced.

## Data meaning (read model, nothing invented)

| Shown | Source |
|---|---|
| Pot | `pot` = sum of every seat's `committedThisHand` (dead money and unmatched bets included). Labelled "Pot" while the hand is live; "Final pot" with the note "All the chips bet this hand, already paid out." once COMPLETE. |
| Chips left | Live hand: `stack − committedThisHand` (the stack is the hand-START value until the hand completes). COMPLETE / no hand: `stack`. |
| In the pot | `committedThisHand`, live hands only. |
| To call | `myLegalActions.callAmount` (already clamped to the stack). |
| Raise-to / Bet range | `minRaiseTo` … `maxAmount`, both street TOTALS. |
| All-in label | The viewer's remaining stack (`stack − committedThisHand`), not `maxAmount`. A call that uses the whole stack is labelled "(all-in)". |
| Payouts | `handResult.pots[].payouts`, gross, per player, never summed across players, never called profit; shown beside the player's own `committedThisHand` ("put in"), which is a fact, not a net figure. |
| Won / shared / lost / showed at showdown | See "Result wording": "won" and "shared the pot" only for payees of the widest pot; "lost" only for a player who received nothing from a readable record; "showed" otherwise. |
| Fold winner | Named only when exactly one seat is paid, that seat is not folded, every pot lists only that seat as eligible, and every other dealt-in seat is folded. |

Deliberately not shown (the read model cannot support them): a table-wide "bet to match", per-seat street bets, blind positions, last action, timers, side-pot breakdown, profit.

## Action rules preserved

- Buttons are exactly the server's `myLegalActions`, in the order FOLD, CHECK, CALL, BET, RAISE, ALL_IN.
- ALL_IN is its own command with no amount; it is never routed through the Raise field. RAISE is sent only when `canRaise`; BET only when `canBet`.
- The amount must be a complete whole number typed as digits within the server's min/max. Anything else is refused with a reason; it is never truncated, rounded or clamped into a different wager.
- A tap never retries by itself; a request that did not reach the server says the action may not have arrived.

## Safety

`pokerPagesDomSafety.test.ts` passes **unmodified** (96 tests, including its negative controls). The module keeps the two literal escape sites those controls anchor on. In `pokerParticipantUi.test.ts`, hostile-name tests (8 hostile and 6 ordinary names) cover every path that writes a player name: the seat list, the "waiting for" turn line and its screen-reader announcement, showdown lines, and the fold-win headline and payout line. Server-provided text is covered separately: connection and action messages (written as text), and the room code, hand number, pot and hand description (escaped). Negative controls (mutated copies of the shipped source that must be caught) exist for the turn line, the fold-win headline, the payout line, the connection notice, the action message, the hand description and the non-number fallback, as well as for the result verbs, the fold-win guard, the "You" disambiguation, the in-flight guard, the gold row marker, truncating `parseInt`, All-in routed through Raise, and the stale block. The module still produces only `div, span, p, button, input, label`.

## Review outcome (revision 3)

Fixed in this revision: the stale tag out of the flow (reviewers: hierarchy F1, responsive F1, behaviour M2, tests-scope F2); the short reminder line under the controls and the "Sending…" line that outlived an accepted action whose refresh failed (hierarchy F2, behaviour M3); the guard on an action's answer after the page left the table, with two tests and a negative control (behaviour M1); the 44px exit button (session F3); hierarchy mutation controls and a no-card-styling check for the sections inside the felt (tests-scope F3); the outside-the-block scan now covers both pages' rules for Poker class names, Poker element ids, felt colours and gradients/greens on `html`/`body`/`:root`, and checks that the module sets no inline style (tests-scope F4); the retained `.msg` rules and `--good`/`--bad` tokens are pinned (whitespace aside), the Poker override and the source order are asserted, with titles that say what they check (session F2); the Session whole-page test now also asserts the Session panels are shown and the join form hidden (session F1); a card-code guard test with a control (tests-scope F6); stress captures in the matrix (tests-scope F11); and this record's measurement paragraph (tests-scope F1).

Judgement calls left as built (disclosed above): the hand result card outside the felt (hierarchy F3); the viewer's own cards also shown in their own showdown row, where they are public (hierarchy F4, tests-scope F10); the turn strip keeping its last wording while stale (responsive F2); live-region announcement details (responsive F3).

## Transfers (not fixed here, outside this gate's contract)

- `public/pokerParticipant.js`, the Raise/Bet amount input: `min`, `max` and `value` attributes are written from `myLegalActions.minRaiseTo` and `maxAmount` without escaping, as at the base commit (`fmt()` escapes the same values everywhere else). They are server-computed integers, so this is a latent hardening item rather than a reachable injection; it was left untouched because it is not part of the presentation change. (tests-scope F5, pre-existing at HEAD.)
- A screen-reader announcement when the connection recovers (responsive F3 part c) would be new behaviour.
- Shared stylesheet extraction (the identical Poker block lives in two pages, guarded by a test) and removing the inert old Poker `:root` tokens and `.msg` rules remain separate cleanups.

## Known limits (see also the review report)

Device and accessibility (unverified; headless emulation cannot show them):

- jsdom has no layout; layout and colour were inspected in a real browser through a local fixture harness (synthetic data, mocked network, loopback only). The harness is not part of the repository.
- Real-device behaviour is unverified: the on-screen keyboard (iOS Safari / Android Chrome), scroll-into-view of a focused field above a virtual keyboard, dynamic browser toolbars, `visualViewport`, whether the iOS numeric pad offers a Return key (so Enter-to-submit may not be reachable there; the Bet/Raise button is), landscape and very short viewports (not in the matrix), OS text scaling, and screen readers (VoiceOver/TalkBack/NVDA) including how the alert/status regions that toggle visibility are announced.
- Stress data is measured only as far as the stress captures go (pots up to 9 digits, names of about 40 characters with six-digit chip counts, at 320 and 375 wide). A 9-digit pot at 320px wraps inside the pot row in the live state as well (the row is 56px instead of 34px); the stale tag does not change that, because it is out of the flow. The reminder line wraps to two lines at 320px, and with a 9-digit pot at 320×568 in the stale state the cards and the actions span 580px (12px more than the viewport; 7 digits: 538px). 16-digit chip counts and landscape or very short viewports were not captured.

Known behaviours left as they are (judgement calls for Code Review; each is small):

- While the table is out of date the player sees, without scrolling to the end of the table: the small "Out of date" tag at the top of the table, the disabled buttons, and a short line directly under the buttons ("Actions are paused until the table refreshes."; it wraps to two lines on a 320px-wide phone). The full notice (time of the last good table, the server's message) is the last thing in the table, so on the smallest phones it is one scroll below the buttons. The turn strip itself keeps its last wording ("Your turn") while stale: it is the last known turn, and the tag, the line and the disabled buttons say it may be out of date. With no controls on screen (waiting, showdown) the notice is still inside the table, directly below the player's cards.
- The table has about 8px more top padding than its other sides, in every state: that band is where the stale tag sits, so the tag cannot wrap onto a line of its own and, at 100% text size, lies inside the band (OS text scaling was not tested). The page's own "Join a different room" button (a sibling of the Poker container, outside `.pk-root`) is raised to 44px by `.pk-root ~ .btn-ghost { min-height: 44px }`, which keeps every selector in the block under `.pk-root`; that rule is inert in `poker-table.html` (no such button there) and was added because the gate asks for 44px targets on the Poker screen. It is shared Session chrome that the Founder may prefer to leave untouched; removing the one rule restores the old height.
- Screen readers: the stale reminder line and the first "Sending…" are in a status region that is `display: none` while empty, so their first appearance may not be announced; the connection notice is an alert region and is. A screen-reader user is not told when the connection returns (the buttons simply become enabled again).
- The green table is tall on a phone (turn, pot, community cards, your cards and the actions in one panel): the page scrolls normally; nothing is shrunk to fit one screen.
- The hand result card is placed outside the green table, first in the information area (the gate did not place it); it can be moved into the table if the Founder prefers.
- Action buttons use the native `disabled` attribute (busy and stale), so a keyboard user who activates a button can lose their tab position when the buttons are re-enabled. `aria-disabled` would change the deliberate "disabled until refreshed" behaviour.
- The empty `#action-msg` status region is `display: none` until it has text, so its very first "Sending…" may not be announced; failure text then updates a region that is already shown.
- The chrome and player list are rebuilt on every successful poll even when unchanged (as before this slice); there are no focusable or editable elements in them.
- The viewer's own cards appear in their own showdown row (revealed cards are public at showdown) as well as in "Your cards".
- The result panel's "separate parts" note shows whenever pots differ in who could take them, including the plain handed-back case, where its second sentence is not needed.
- A player with no chips left sees "Hand complete. Waiting for the host to deal the next hand." (the wording does not know who will be dealt in; that is a gameplay rule outside this slice).
- On `poker-table.html` the page header (back link, title, subtitle) uses about 100px more than on the canonical page, so at 320×568 no action is visible on first paint on that page.
- Tablet/desktop show the same single column (the pages cap their body at 560px / 480px); the prototype's wide two-column arrangement needs shared page layout and is deferred.
- A hand stuck at SHOWDOWN (known finding F3, plus a latent short-big-blind settlement case traced in the audit) shows "Showdown. Waiting for the result." indefinitely.
- English only.
