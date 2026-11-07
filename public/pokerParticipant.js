/**
 * pokerParticipant.js — Participant Unified Entry Slice 002, extended
 * by the Poker Playtest UX + Showdown Transparency Slice and the
 * Player Table UI Slice 001.
 *
 * Poker's own participant-facing behavior (join, table fetch, private
 * cards, board, pot, seats, legal actions, hand result), shared by the
 * canonical /participant.html entry point and the standalone
 * /poker-table.html compatibility surface so they cannot silently
 * drift apart. Poker rules themselves are unchanged — this module only
 * renders what the server already decided (myLegalActions is computed
 * server-side; every button tap still goes through PLAYER_ACTION's own
 * full server-side validation, exactly as before).
 *
 * Poker seat identity persists in sessionStorage (tab-scoped), not
 * localStorage — a Participant Unified Entry Slice 002 correction: a
 * Poker seat joined in one browser tab must not silently become the
 * active Poker identity of every other tab, matching how Session
 * participant identity already works on this same page.
 *
 * Active Input Preservation (Poker Playtest UX Slice; see
 * ENGINEERING_PATTERNS.md's own named invariant): the live Bet/Raise
 * amount <input> must never be destroyed by a poll tick. The output is
 * split into a stable shell — #poker-live (screen-reader turn
 * announcements); #poker-table, the one green playing surface, holding
 * #poker-chrome (turn, pot, community cards, the player's own cards —
 * none of it is ever mid-edit, so it refreshes unconditionally every
 * successful poll), #poker-action-area (rebuilt only when the decision
 * it represents has genuinely changed — see renderPokerActionArea()) and
 * #poker-notice (the connection notice, last); and #poker-info, outside
 * the table, holding the hand result, the players and the room details
 * (also refreshed every successful poll). A FAILED poll no
 * longer replaces any of it: the last table stays on screen, clearly
 * labelled as possibly out of date, consequential actions are disabled
 * until a poll succeeds again, and nothing is ever replayed automatically.
 *
 * Data meaning (every number shown is a field of the table-state read
 * model or a derivation stated here — nothing is invented):
 *   - pot            = sum of every seat's committedThisHand (dead money from
 *                      folded seats and unmatched bets included); it persists
 *                      after the hand completes.
 *   - chips left     = stack − committedThisHand while a hand is in progress
 *                      (a seat's `stack` is the hand-START value until the hand
 *                      completes); the plain `stack` once the hand is COMPLETE
 *                      or there is no hand. The server uses the same formula for
 *                      the viewer's own remaining stack.
 *   - To call        = myLegalActions.callAmount (already clamped to the stack).
 *   - Bet / Raise to = myLegalActions.minRaiseTo .. maxAmount, both STREET TOTALS
 *                      (raise-TO, not raise-BY).
 *   - All-in puts in = the viewer's remaining stack (stack − committedThisHand),
 *                      not maxAmount (a street total).
 *   - payouts        = GROSS chips received from the pot (an uncalled excess is
 *                      refunded through the same list); never profit, never
 *                      summed across players.
 * Deliberately NOT shown because the read model cannot support it: a table-wide
 * "bet to match", blind positions, last actions, timers, or a side-pot breakdown.
 */
(function (global) {
  const POKER_SEAT_STORAGE_KEY = "urbano_poker_seat";

  function savePokerSeat(seat) {
    sessionStorage.setItem(POKER_SEAT_STORAGE_KEY, JSON.stringify(seat));
  }
  function loadPokerSeat() {
    try {
      return JSON.parse(sessionStorage.getItem(POKER_SEAT_STORAGE_KEY) || "null");
    } catch {
      return null;
    }
  }
  function clearPokerSeat() {
    sessionStorage.removeItem(POKER_SEAT_STORAGE_KEY);
  }

  // A seat's display name is chosen by whoever joined the table, so it is escaped wherever it is written into the HTML templates below.
  function escapeHtml(text) {
    return String(text)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;");
  }

  async function pokerApiFetch(path, options) {
    let res;
    try {
      res = await fetch(path, options);
    } catch (e) {
      return { status: 0, json: null };
    }
    const json = await res.json().catch(() => null);
    return { status: res.status, json };
  }

  // Chip counts are grouped for readability ("1,250,000"); the amount <input> itself always holds plain digits.
  const CHIP_FORMAT = typeof Intl !== "undefined" && Intl.NumberFormat ? new Intl.NumberFormat("en-US") : null;
  function fmt(n) {
    // Anything that is not a finite number can only be a malformed server value: show it, escaped, rather than trust it as markup.
    if (typeof n !== "number" || !isFinite(n)) return escapeHtml(String(n));
    return CHIP_FORMAT ? CHIP_FORMAT.format(n) : String(n);
  }

  // Poker Playtest UX Slice (card-rank display, §5): presentation
  // only — "T" is pokersolver's and this codebase's own internal rank
  // code for Ten (deck generation, the evaluator, storage, and the API
  // all keep using "T" unchanged); this map exists solely so a human
  // reader sees "10" on the card face instead of an unfamiliar letter.
  function displayRank(rank) {
    return rank === "T" ? "10" : rank;
  }

  const RANK_NAMES = {
    "2": "Two", "3": "Three", "4": "Four", "5": "Five", "6": "Six", "7": "Seven", "8": "Eight", "9": "Nine",
    T: "Ten", J: "Jack", Q: "Queen", K: "King", A: "Ace",
  };
  const SUIT_NAMES = { C: "clubs", D: "diamonds", H: "hearts", S: "spades" };
  const SUIT_SYMBOLS = { C: "♣", D: "♦", H: "♥", S: "♠" };
  const CARD_CODE = /^[2-9TJQKA][CDHS]$/;

  function cardName(code) {
    return typeof code === "string" && CARD_CODE.test(code) ? `${RANK_NAMES[code[0]]} of ${SUIT_NAMES[code[1]]}` : "Unknown card";
  }

  // Each face-up card carries its rank and a suit SYMBOL (so suit never depends on colour alone) and a spoken name.
  function renderCard(code, extraClass) {
    const extra = extraClass ? " " + extraClass : "";
    if (!code) return `<div class="playing-card face-down${extra}" aria-hidden="true"></div>`;
    if (typeof code !== "string" || !CARD_CODE.test(code)) {
      return `<div class="playing-card face-down${extra}" role="img" aria-label="Unknown card"></div>`;
    }
    const suit = code[1];
    const isRed = suit === "D" || suit === "H";
    return `<div class="playing-card${isRed ? " red" : ""}${extra}" role="img" aria-label="${cardName(code)}"><span class="pk-rank">${displayRank(code[0])}</span><span class="pk-suit">${SUIT_SYMBOLS[suit]}</span></div>`;
  }

  // Poker Playtest UX Slice (descriptor cleanup, §8): pokersolver's own
  // `descr` is clean, presentable prose for seven of nine hand
  // categories ("Pair, A's", "Straight, 10 High", "Full House, A's
  // over 9's", ...) — verified directly against the live library
  // across every category during this Slice's own readiness gate.
  // Exactly two categories (Flush, Straight Flush) embed a raw internal
  // card token instead of a clean rank word ("Flush, Kh High",
  // "Straight Flush, 10c High"). Rather than reconstructing the string
  // from scratch, this reformats only that one trailing token — every
  // other descr passes through untouched, since the regex only matches
  // the specific "{rank}{suit-letter} High" shape pokersolver produces
  // for those two categories.
  const RANK_WORDS = {
    "2": "2", "3": "3", "4": "4", "5": "5", "6": "6", "7": "7", "8": "8", "9": "9",
    "10": "10", T: "10", J: "Jack", Q: "Queen", K: "King", A: "Ace",
  };
  function cleanHandDescr(descr) {
    if (!descr) return descr;
    return descr.replace(/(\d{1,2}|[TJQKA])[cdhs]\s+High$/i, (match, rank) => {
      const word = RANK_WORDS[rank.toUpperCase()] || rank;
      return `${word} High`;
    });
  }

  function randomIdempotencyKey() {
    return crypto.randomUUID ? crypto.randomUUID() : String(Date.now()) + Math.random();
  }

  async function joinPokerTable(roomCode, displayName) {
    return pokerApiFetch(`/api/gaming/poker/tables/${roomCode}/join`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ displayName }),
    });
  }

  async function sendPokerAction(seat, pokerHandId, actionType, amount) {
    return pokerApiFetch(`/api/gaming/poker/tables/${seat.pokerTableId}/action`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: "Bearer " + seat.participantToken },
      body: JSON.stringify({ pokerHandId, actionType, amount: amount ?? null, idempotencyKey: randomIdempotencyKey() }),
    });
  }

  // ------------------------------------------------------------------------------------------------------------------------------
  // Read-model helpers
  // ------------------------------------------------------------------------------------------------------------------------------

  const BETTING_STREETS = ["PRE_FLOP", "FLOP", "TURN", "RIVER"];
  const STREET_LABELS = {
    PRE_FLOP: "Pre-flop",
    FLOP: "Flop",
    TURN: "Turn",
    RIVER: "River",
    SHOWDOWN: "Showdown",
    COMPLETE: "Hand complete",
  };
  const STREET_NOTES = {
    PRE_FLOP: "No community cards yet",
    FLOP: "3 community cards",
    TURN: "4 community cards",
    RIVER: "5 community cards",
    SHOWDOWN: "",
    COMPLETE: "",
  };

  function isClosed(state) {
    return state.closedAt !== null && state.closedAt !== undefined;
  }
  // A hand exists and has not completed: seat `stack` values are hand-START values, so chips left must subtract what is committed.
  function handInProgress(state) {
    return !!state.currentHandId && !!state.street && state.street !== "COMPLETE";
  }
  // Only these streets can have an acting player; SHOWDOWN and COMPLETE never show an acting-player instruction.
  function bettingOpen(state) {
    return !isClosed(state) && !!state.currentHandId && BETTING_STREETS.indexOf(state.street) !== -1;
  }
  function findSeat(state, seatNumber) {
    return (state.seats || []).find((s) => s.seatNumber === seatNumber) || null;
  }
  function chipsLeft(seat, inProgress) {
    return Math.max(0, inProgress ? seat.stack - seat.committedThisHand : seat.stack);
  }

  // Gross payout per seat (sum of that seat's own payout lines only — never summed across different seats).
  function payoutsBySeat(handResult) {
    const payoutBySeat = {};
    for (const pot of (handResult && handResult.pots) || []) {
      for (const p of pot.payouts || []) {
        payoutBySeat[p.seatNumber] = (payoutBySeat[p.seatNumber] || 0) + p.amount;
      }
    }
    return payoutBySeat;
  }
  // What the result record supports saying about each revealed seat at a showdown. Real settlement splits the chips into layers by
  // commitment level and, for each layer ("pot"), pays only the best-ranked group among that pot's ELIGIBLE seats. The first layer has
  // every contender eligible, so the pots with the most eligible seats are the ones every revealed hand was compared for:
  //   - "won"            = the sole payee of such a widest pot (the best hand among all contenders);
  //   - "shared the pot" = one of several payees of such a pot (a tie, split by chips, not by strength);
  //   - "lost"           = received no chips from any pot of a well-formed record. (Real settlement makes every revealed seat eligible
  //                        for the first layer, so in practice this means it was outranked in that widest comparison; the verb does
  //                        not re-check that, and it is the same zero-payout rule the original result lines used.)
  //   - "showed"         = everything else. A seat paid only from a smaller pot (a layer fewer seats could take: chips handed back, folded
  //                        players' chips, or a smaller contest) is neither a winner nor a loser of the hand — a deep stack can take a
  //                        small layer and still be down on the hand, and a stronger hand can be absent from it.
  // The record must be well-formed: every pot has an eligibility list and a payout list of positive amounts that adds up to the pot.
  // Otherwise nobody is called a winner or a loser (zero payout would then be missing data, not a result).
  function showdownVerbs(handResult) {
    const pots = (handResult && handResult.pots) || [];
    const wellFormed = (p) =>
      Array.isArray(p.eligibleSeatNumbers) &&
      Array.isArray(p.payouts) &&
      p.payouts.every((x) => typeof x.amount === "number" && isFinite(x.amount) && x.amount > 0) &&
      p.payouts.reduce((n, x) => n + x.amount, 0) === p.amount;
    const usable = pots.length > 0 && pots.every(wellFormed);
    const widest = usable ? Math.max(...pots.map((p) => p.eligibleSeatNumbers.length)) : 0;
    const soleWinners = new Set();
    const sharers = new Set();
    if (usable && widest >= 2) {
      for (const pot of pots) {
        if (pot.eligibleSeatNumbers.length !== widest) continue;
        const payees = Array.from(new Set(pot.payouts.map((p) => p.seatNumber)));
        for (const seatNumber of payees) (payees.length === 1 ? soleWinners : sharers).add(seatNumber);
      }
    }
    // Chips are paid in more than one distinct part when the pots do not all have the same eligible seats.
    const partsDiffer = usable && new Set(pots.map((p) => p.eligibleSeatNumbers.slice().sort((x, y) => x - y).join(","))).size > 1;
    const payout = payoutsBySeat(handResult);
    return {
      usable,
      partsDiffer,
      explicitWinners: new Set([...soleWinners, ...sharers]),
      verb: (seatNumber) =>
        !usable ? "showed" : soleWinners.has(seatNumber) ? "won" : sharers.has(seatNumber) ? "shared the pot" : (payout[seatNumber] || 0) > 0 ? "showed" : "lost",
    };
  }

  // How a seat is named in a result sentence. The viewer is "You"; so that another player who chose the display name "You" cannot be
  // read as the viewer (and invert the sentence), that name gets a plain suffix.
  function resultName(state, seatNumber, mySeatNumber) {
    if (seatNumber === mySeatNumber) return "You";
    const seatInfo = findSeat(state, seatNumber);
    if (!seatInfo) return `Seat ${seatNumber}`;
    return /^\s*you\s*$/i.test(seatInfo.displayName) ? `${seatInfo.displayName} (another player)` : seatInfo.displayName;
  }
  // The chips a seat bet this hand, as the read model reports it (not a profit figure: nothing is subtracted).
  function putIn(state, seatNumber) {
    const seatInfo = findSeat(state, seatNumber);
    return seatInfo && seatInfo.inCurrentHand && seatInfo.committedThisHand > 0 ? seatInfo.committedThisHand : 0;
  }

  // What the player is waiting for / being asked to do, as plain text parts. `name` is raw (unescaped) and optional.
  function describeTurn(state, mySeatNumber) {
    if (isClosed(state)) return { kind: "closed", before: "This table has ended. Thanks for playing.", name: null, after: "" };
    if (!state.currentHandId) return { kind: "idle", before: "Waiting for the host to deal.", name: null, after: "" };
    const me = findSeat(state, mySeatNumber);
    if (!me || !me.inCurrentHand) return { kind: "next", before: "You'll join the next hand.", name: null, after: "" };
    if (state.street === "COMPLETE") {
      return { kind: "complete", before: "Hand complete. Waiting for the host to deal the next hand.", name: null, after: "" };
    }
    if (state.street === "SHOWDOWN") return { kind: "showdown", before: "Showdown. Waiting for the result.", name: null, after: "" };
    if (state.myLegalActions) return { kind: "mine", before: "Your turn", name: null, after: "" };
    const prefix = me.folded ? "You folded. " : me.allIn ? "You're all-in. " : "";
    const actor = (state.seats || []).find((s) => s.isCurrentActor);
    if (actor && actor.seatNumber !== mySeatNumber) {
      return { kind: "waiting", before: prefix + "Waiting for ", name: actor.displayName, after: " to act" };
    }
    return { kind: "waiting", before: prefix + "Waiting for the table to continue.", name: null, after: "" };
  }
  function turnPlainText(turn) {
    return turn.before + (turn.name !== null && turn.name !== undefined ? turn.name : "") + (turn.after || "");
  }
  function turnHtml(turn) {
    return turn.before + (turn.name !== null && turn.name !== undefined ? escapeHtml(turn.name || "") : "") + (turn.after || "");
  }

  // ------------------------------------------------------------------------------------------------------------------------------
  // Chrome (rebuilt on every successful poll — contains no editable control)
  // ------------------------------------------------------------------------------------------------------------------------------

  // Poker Playtest UX Slice (showdown transparency, §6-8): every
  // revealed (non-folded) seat's own line — "{name} won/lost/showed/shared the pot —
  // {hand}" — built from data GET_TABLE_STATE already returns in full
  // to every caller once street reaches COMPLETE (handResult.
  // showdownHands). `descr` falls back to `rankName` for any hand
  // settled before that Slice shipped (a real production case:
  // existing poker_hand_results rows have no `descr` field at all) so
  // older completed hands still show something truthful, just coarser.
  // Folded seats are never present in showdownHands at any point — this
  // renders only what the existing, unchanged reveal rule already
  // exposes. Player Table UI Slice 001: each row also shows the revealed
  // cards and that seat's own gross payout, in separate elements so the
  // "{name} won/lost/showed/shared the pot — {hand}" line stays exactly that text.
  //
  // The verb is only as strong as the evidence (see showdownVerbs): "won" = sole payee of a contested pot; "shared the pot" = tied for
  // one; "lost" = received no chips at all; "showed" = received chips only from pots nobody else could contest (for example chips handed
  // back), or the record cannot support a verdict — neither a win nor a loss, so the line just says the hand was shown and lists the payout.
  function buildShowdownLines(state, mySeatNumber) {
    const handResult = state.handResult;
    if (!handResult || !handResult.showdownHands) return "";

    const payoutBySeat = payoutsBySeat(handResult);
    const verbs = showdownVerbs(handResult);
    const seatByNumber = new Map((state.seats || []).map((s) => [s.seatNumber, s]));

    const rows = Object.keys(handResult.showdownHands)
      .map(Number)
      .sort((a, b) => a - b)
      .map((seatNumber) => {
        const entry = handResult.showdownHands[String(seatNumber)];
        const seatInfo = seatByNumber.get(seatNumber);
        const name = resultName(state, seatNumber, mySeatNumber);
        const payout = payoutBySeat[seatNumber] || 0;
        const outcome = verbs.verb(seatNumber);
        const descr = cleanHandDescr(entry.descr || entry.rankName) || "";
        const cards = (entry.cards || (seatInfo && seatInfo.revealedHoleCards) || []).map((c) => renderCard(c, "pk-mini")).join("");
        const stake = putIn(state, seatNumber);
        const payoutHtml = payout > 0 ? `<span class="pk-payout">Payout ${fmt(payout)} chips${stake > 0 ? ` · put in ${fmt(stake)}` : ""}</span>` : "";
        return `<div class="poker-result-row${verbs.explicitWinners.has(seatNumber) ? " pk-winner" : ""}"><span class="pk-reveal-line">${escapeHtml(name)} ${outcome} — ${escapeHtml(descr)}</span><div class="pk-mini-cards">${cards}</div>${payoutHtml}</div>`;
      });

    return rows.join("");
  }

  // Payees that have no showdown line of their own (every payee in a fold-to-one hand; defensively, any unexpected payee at showdown).
  function buildPayoutLines(state, mySeatNumber, skipSeats) {
    const handResult = state.handResult;
    if (!handResult) return "";
    const payoutBySeat = payoutsBySeat(handResult);
    return Object.keys(payoutBySeat)
      .map(Number)
      .filter((n) => payoutBySeat[n] > 0 && !skipSeats.has(n))
      .sort((a, b) => a - b)
      .map((seatNumber) => {
        const payeeName = resultName(state, seatNumber, mySeatNumber);
        const stake = putIn(state, seatNumber);
        return `<div class="poker-result-row pk-payout-row"><span class="pk-payee">${escapeHtml(payeeName)} received ${fmt(payoutBySeat[seatNumber])} chips${stake > 0 ? ` (put in ${fmt(stake)})` : ""}</span></div>`;
      })
      .join("");
  }

  function buildResultHtml(state, mySeatNumber) {
    const hr = state.handResult;
    if (!hr) return "";
    const payoutBySeat = payoutsBySeat(hr);
    const payeeSeats = Object.keys(payoutBySeat).map(Number).filter((n) => payoutBySeat[n] > 0).sort((a, b) => a - b);
    const showdown = !!hr.showdownHands;
    const me = findSeat(state, mySeatNumber);
    const played = !!(me && me.inCurrentHand);
    const myPayout = payoutBySeat[mySeatNumber] || 0;

    let headlineHtml = "Hand complete";
    let detail = "";
    let iWon = false;
    let partsNote = false;
    let sub;

    if (showdown) {
      sub = `Hand ${escapeHtml(String(state.currentHandOrdinal))} · Showdown`;
      // The headline stays neutral. Who won which pot is stated per player below, and only where the record supports it.
      const verbs = showdownVerbs(hr);
      iWon = verbs.explicitWinners.has(mySeatNumber);
      // "No chips" is a statement about the record, so it is made only when the record is complete enough to bear it out.
      if (played && myPayout > 0) detail = `Your payout: ${fmt(myPayout)} chips${putIn(state, mySeatNumber) > 0 ? ` (you put in ${fmt(putIn(state, mySeatNumber))})` : ""}`;
      else if (played && verbs.usable) detail = "You received no chips this hand.";
      partsNote = verbs.partsDiffer;
    } else {
      sub = `Hand ${escapeHtml(String(state.currentHandOrdinal))} · Ended without a showdown`;
      // Name a winner only when the evidence is unambiguous: exactly one payee, that seat is not folded, every pot lists only that seat
      // as eligible, and every other seat that was dealt in is marked folded (so "everyone else in the hand folded" is itself true).
      const sole = payeeSeats.length === 1 ? payeeSeats[0] : null;
      const soleSeat = sole === null ? null : findSeat(state, sole);
      const unambiguous =
        sole !== null &&
        !!soleSeat &&
        !soleSeat.folded &&
        (hr.pots || []).length > 0 &&
        hr.pots.every((p) => Array.isArray(p.eligibleSeatNumbers) && p.eligibleSeatNumbers.length === 1 && p.eligibleSeatNumbers[0] === sole) &&
        (state.seats || []).every((x) => x.seatNumber === sole || !x.inCurrentHand || x.folded);
      if (unambiguous) {
        if (sole === mySeatNumber) {
          iWon = true;
          headlineHtml = "You won — everyone else in the hand folded";
          detail = `Your payout: ${fmt(myPayout)} chips${putIn(state, mySeatNumber) > 0 ? ` (you put in ${fmt(putIn(state, mySeatNumber))})` : ""}`;
        } else {
          const winnerName = resultName(state, sole, mySeatNumber);
          headlineHtml = `${escapeHtml(winnerName)} won — everyone else in the hand folded`;
        }
      }
    }

    const showdownLines = buildShowdownLines(state, mySeatNumber);
    // Seats already described above (a showdown line of their own, or the viewer's own payout in the headline) get no second line.
    const listed = new Set(showdown ? Object.keys(hr.showdownHands).map(Number) : []);
    if (!showdown && iWon) listed.add(mySeatNumber);
    const payoutLines = buildPayoutLines(state, mySeatNumber, listed);
    const anyPayout = payeeSeats.length > 0;

    return `<div class="pk-panel poker-result-card${iWon ? " poker-result-win" : ""}" role="group" aria-label="Hand result">
      <div class="pk-result-sub">${sub}</div>
      <div class="pk-result-headline">${headlineHtml}</div>
      ${detail ? `<div class="pk-result-detail">${detail}</div>` : ""}
      ${showdownLines}
      ${payoutLines}
      ${anyPayout ? `<p class="pk-note">Payout is the number of chips a player received this hand. "Put in" is the chips that player bet.</p>` : ""}
      ${partsNote ? `<p class="pk-note">Chips are paid out in separate parts. A hand can be paid from a part that a stronger hand could not take part in.</p>` : ""}
    </div>`;
  }

  // The players list (stacks, chips put in, statuses). It belongs to the information panel BELOW the green table, not to the table.
  function buildSeatsHtml(state, mySeatNumber) {
    const inProgress = handInProgress(state);
    const betting = bettingOpen(state);
    const hasHand = !!state.currentHandId;
    const rows = state.seats.map((s) => {
      const classes = ["seat-row"];
      if (s.seatNumber === mySeatNumber) classes.push("is-me");
      if (betting && s.isCurrentActor) classes.push("is-turn");
      if (hasHand && s.folded) classes.push("is-folded");
      const badges = [
        hasHand && s.isDealer ? '<span class="seat-badge">Dealer</span>' : "",
        betting && s.isCurrentActor ? '<span class="seat-badge turn">Acting</span>' : "",
        hasHand && s.allIn ? '<span class="seat-badge allin">All-in</span>' : "",
        hasHand && s.folded ? '<span class="seat-badge out">Folded</span>' : "",
        hasHand && !s.inCurrentHand ? '<span class="seat-badge wait">Joins next hand</span>' : "",
      ].join("");
      const left = chipsLeft(s, inProgress);
      const inPot = inProgress && s.committedThisHand > 0 ? `<span class="pk-seat-pot">${fmt(s.committedThisHand)} in the pot</span>` : "";
      return `<div class="${classes.join(" ")}" role="listitem">
        <span class="seat-name">${escapeHtml(s.displayName)}${s.seatNumber === mySeatNumber ? " (you)" : ""}</span>
        <span class="pk-seat-chips"><span class="seat-stack"><span class="pk-seat-left">${fmt(left)}</span> ${inProgress ? "chips left" : "chips"}</span> ${inPot}</span>
        ${badges ? `<span class="pk-seat-tags">${badges}</span>` : ""}
      </div>`;
    });
    return `<div role="group" aria-label="Players">
      <div class="pk-title"><span>Players</span> <span class="pk-count">${state.seats.length}</span></div>
      <div class="seat-list" role="list">${rows.join("")}</div>
    </div>`;
  }

  // ------------------------------------------------------------------------------------------------------------------------------
  // THE GREEN PLAYING TABLE. One continuous felt surface (#poker-table) holds everything needed to act, as sections told apart by
  // labels, spacing and hairline dividers (not by separate cards): whose turn it is, the pot, the community cards, the player's own
  // cards, the actions with the amount field, and the connection notice. The sections below are the part of it rebuilt on every poll;
  // the actions (which hold the editable field) and the notice are the stable parts — see ensureShell().
  // ------------------------------------------------------------------------------------------------------------------------------

  // Whose turn it is, in words (the colour is only emphasis). It stays inside the table so nobody has to scroll to learn whether to act.
  function buildTurnHtml(turn) {
    return `<div class="pk-turn is-${turn.kind}" role="group" aria-label="Whose turn">${turnHtml(turn)}</div>`;
  }

  function buildPotHtml(state) {
    if (!state.currentHandId) return "";
    const inProgress = handInProgress(state);
    return `<div class="pk-sec pk-pot">
      <div class="pk-potrow">
        <span class="pk-pot-label">${inProgress ? "Pot" : "Final pot"}</span>
        <span class="pk-pot-value">${fmt(state.pot)}</span>
        <span class="pk-pot-unit">chips</span>
      </div>
      ${inProgress ? "" : `<p class="pk-pot-note">All the chips bet this hand, already paid out.</p>`}
    </div>`;
  }

  function buildBoardHtml(state) {
    if (!state.currentHandId) return "";
    const board = state.board || [];
    const slots = [];
    for (let i = 0; i < 5; i++) slots.push(board[i] ? renderCard(board[i]) : `<div class="playing-card slot" aria-hidden="true"></div>`);
    const boardLabel = board.length ? "Community cards: " + board.map(cardName).join(", ") : "Community cards: none yet";
    return `<div class="pk-sec pk-board">
      <div class="pk-board-label"><span>Community cards</span> <span class="pk-count">${board.length} of 5</span></div>
      <div class="board-cards" role="group" aria-label="${boardLabel}">${slots.join("")}</div>
    </div>`;
  }

  function buildHandHtml(state, mySeatNumber) {
    // Poker End Table Lifecycle Slice: a closed table shows only the terminal message (in the turn line); the private cards are dropped.
    if (isClosed(state) || !state.myHoleCards) return "";
    const me = findSeat(state, mySeatNumber);
    const folded = !!(me && me.folded);
    const hr = state.handResult;
    const revealed = !!(hr && hr.showdownHands && hr.showdownHands[String(mySeatNumber)]);
    const note = folded ? `<span class="seat-badge out">Folded</span>` : revealed ? "" : `<span class="pk-private">Only you can see these</span>`;
    return `<div class="pk-sec pk-hand${folded ? " is-folded" : ""}" role="group" aria-label="Your cards">
      <div class="pk-title"><span>Your cards</span>${note}</div>
      <div class="hole-cards">${state.myHoleCards.map((c) => renderCard(c)).join("")}</div>
    </div>`;
  }

  // The part of the table rebuilt on every successful poll. It contains nothing editable.
  function buildChromeHtml(state, mySeatNumber, turn) {
    return [buildTurnHtml(turn), buildPotHtml(state), buildBoardHtml(state), buildHandHtml(state, mySeatNumber)].join("");
  }

  // While the table is out of date a small tag sits in the table's own top band. It is positioned out of the flow (CSS reserves the band
  // in every state), so it cannot take a line of its own, whatever the width or the size of the pot: appearing or clearing moves
  // nothing. The full notice is the last thing in the table, below the controls, and a short reminder appears right under the controls.
  function markStale(chrome) {
    if (!chrome.querySelector(".pk-stale-tag")) {
      const tag = document.createElement("span");
      tag.className = "pk-stale-tag";
      tag.textContent = "Out of date";
      chrome.appendChild(tag);
    }
  }

  // ------------------------------------------------------------------------------------------------------------------------------
  // THE INFORMATION PANEL, outside the green table, on the ordinary page background: the hand result, the players with their stacks
  // and statuses, and the room, hand and street details.
  // ------------------------------------------------------------------------------------------------------------------------------

  function buildRoomHtml(state) {
    const live = bettingOpen(state);
    const street = state.street;
    const pills = [`<span class="status-pill">Room ${escapeHtml(state.roomCode)}</span>`];
    if (state.currentHandOrdinal) pills.push(`<span class="status-pill">Hand ${escapeHtml(String(state.currentHandOrdinal))}</span>`);
    if (isClosed(state)) {
      pills.push(`<span class="status-pill pk-street idle">Table ended</span>`);
    } else if (street && STREET_LABELS[street]) {
      pills.push(`<span class="status-pill pk-street${live ? "" : " idle"}">${STREET_LABELS[street]}</span>`);
    } else {
      pills.push(`<span class="status-pill pk-street idle">No hand in progress</span>`);
    }
    const note = !isClosed(state) && street && STREET_NOTES[street] ? `<span class="pk-street-note">${STREET_NOTES[street]}</span>` : "";
    return `<div class="pk-room" role="group" aria-label="Room details">
      <div class="pk-title"><span>Room details</span></div>
      <div class="pk-status">${pills.join("")}${note}</div>
    </div>`;
  }

  function buildInfoHtml(state, mySeatNumber) {
    return (
      buildResultHtml(state, mySeatNumber) +
      `<div class="pk-panel pk-info" role="group" aria-label="Table information">${buildSeatsHtml(state, mySeatNumber)}${buildRoomHtml(state)}</div>`
    );
  }

  // ------------------------------------------------------------------------------------------------------------------------------
  // Shell, connection notice, and per-container state
  // ------------------------------------------------------------------------------------------------------------------------------

  // One small record per rendered container: request ordering, whether the last poll failed, and whether an action is in flight.
  const CONTEXTS = new WeakMap();
  function getContext(container) {
    let ctx = CONTEXTS.get(container);
    if (!ctx) {
      ctx = { requestSeq: 0, appliedSeq: 0, stale: false, busy: false, hasRendered: false, lastOkAt: null, announced: "" };
      CONTEXTS.set(container, ctx);
    }
    return ctx;
  }

  // The shell is created once per container and left alone afterwards, so the editable subtree and the notice survive every poll.
  //   #poker-table  the ONE green playing surface: #poker-chrome (turn, pot, community cards, the player's cards, rebuilt every poll),
  //                 #poker-action-area (the actions and amount field, rebuilt only when the decision changes) and #poker-notice (the
  //                 connection notice, last, so it never moves the controls)
  //   #poker-info   outside the table: the hand result, the players, the room details (rebuilt every poll)
  function ensureShell(container, ctx) {
    container.classList.add("pk-root");
    let live = container.querySelector("#poker-live");
    let table = container.querySelector("#poker-table");
    let chrome = container.querySelector("#poker-table > #poker-chrome");
    let area = container.querySelector("#poker-table > #poker-action-area");
    let notice = container.querySelector("#poker-table > #poker-notice");
    let info = container.querySelector("#poker-info");
    if (!live || !table || !chrome || !area || !notice || !info) {
      container.innerHTML =
        `<div id="poker-live" class="pk-sr-only" role="status" aria-live="polite"></div>` +
        `<div id="poker-table" class="pk-table felt" role="group" aria-label="Poker table">` +
        `<div id="poker-chrome"></div>` +
        `<div id="poker-action-area"></div>` +
        `<div id="poker-notice" class="pk-notice" role="alert" hidden></div>` +
        `</div>` +
        `<div id="poker-info"></div>`;
      live = container.querySelector("#poker-live");
      table = container.querySelector("#poker-table");
      chrome = container.querySelector("#poker-chrome");
      area = container.querySelector("#poker-action-area");
      notice = container.querySelector("#poker-notice");
      info = container.querySelector("#poker-info");
      ctx.stale = false;
      ctx.busy = false;
      ctx.hasRendered = false;
      ctx.lastOkAt = null;
      ctx.announced = "";
    }
    return { live, table, chrome, area, notice, info };
  }

  // The notice is built with DOM text (never markup): its text can include a message returned by the server.
  function setNotice(notice, title, lines) {
    if (!title) {
      if (!notice.hidden) {
        notice.hidden = true;
        notice.replaceChildren();
      }
      return;
    }
    const signature = title + "\n" + lines.join("\n");
    if (!notice.hidden && notice.dataset.signature === signature) return;
    const titleEl = document.createElement("div");
    titleEl.className = "pk-notice-title";
    titleEl.textContent = title;
    const kids = [titleEl];
    lines.forEach((line) => {
      const p = document.createElement("p");
      p.className = "pk-notice-line";
      p.textContent = line;
      kids.push(p);
    });
    notice.replaceChildren(...kids);
    notice.dataset.signature = signature;
    notice.hidden = false;
  }

  function timeLabel(date) {
    try {
      return date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
    } catch (e) {
      return date.toISOString();
    }
  }

  const ACTIONS_PAUSED = "Actions are paused until the table refreshes.";

  // While the last poll failed, or while an action is in flight, no consequential button can be pressed. The amount field stays editable.
  // While the table is out of date the same fact is also said in a short line directly under the controls (the message line is the last
  // thing in the action area, so writing it moves nothing above it), and taken back when the table refreshes. Only an empty line or a
  // "Sending…" line is replaced; a failure message from an earlier action is never overwritten, here or by a press of Enter.
  function syncActionState(container, ctx) {
    const area = container.querySelector("#poker-action-area");
    if (!area) return;
    const blocked = ctx.busy || ctx.stale;
    area.querySelectorAll(".action-btn").forEach((b) => {
      b.disabled = blocked;
    });
    const msg = area.querySelector("#action-msg");
    if (!msg) return;
    const kind = msg.dataset.kind || "";
    if (ctx.stale && !ctx.busy) {
      if (msg.textContent === "" || kind === "sending") {
        msg.className = "msg error";
        msg.dataset.kind = "paused";
        msg.textContent = ACTIONS_PAUSED;
      }
    } else if (!ctx.stale && kind === "paused") {
      msg.className = "msg";
      msg.dataset.kind = "";
      msg.textContent = "";
    }
  }

  // container is the element to render into — participant.html and
  // poker-table.html each pass their own (#poker-container /
  // #table-card) so this module owns no page-specific DOM assumptions
  // beyond "give me somewhere to render." The stable shell is created
  // once per container on first call; thereafter chrome is refreshed on
  // every successful poll and the action area is rebuilt only when its
  // own decision context changes — see renderPokerActionArea().
  async function renderPokerTable(container, seat) {
    const ctx = getContext(container);
    const shell = ensureShell(container, ctx);
    const requestId = ++ctx.requestSeq;

    const res = await pokerApiFetch(`/api/gaming/poker/tables/${seat.pokerTableId}`, {
      headers: { authorization: "Bearer " + seat.participantToken },
    });

    // The page may have left the table while the request was in flight (it clears the container), or a newer response may already
    // have been applied: either way this response must not draw anything.
    if (!container.contains(shell.chrome)) return;
    if (requestId < ctx.appliedSeq) return;
    ctx.appliedSeq = requestId;

    if (res.status !== 200 || !res.json) {
      const serverMessage = res.json && res.json.error ? String(res.json.error) : "";
      if (ctx.hasRendered) {
        // Keep the last table and any typed amount; say plainly that it may be out of date; block consequential actions.
        ctx.stale = true;
        const lines = [`Showing the table as of ${timeLabel(ctx.lastOkAt)}. ${ACTIONS_PAUSED}`];
        if (serverMessage) lines.push(`The server said: ${serverMessage}`);
        setNotice(shell.notice, "Connection problem. This table may be out of date.", lines);
        markStale(shell.chrome);
        syncActionState(container, ctx);
      } else {
        setNotice(shell.notice, "Couldn't load the table.", [serverMessage || "Failed to load table."]);
      }
      return;
    }

    const state = res.json;
    const mySeatNumber = seat.seatNumber;
    ctx.stale = false;
    ctx.hasRendered = true;
    ctx.lastOkAt = new Date();
    setNotice(shell.notice, null, []);

    const turn = describeTurn(state, mySeatNumber);
    shell.chrome.innerHTML = buildChromeHtml(state, mySeatNumber, turn);
    shell.info.innerHTML = buildInfoHtml(state, mySeatNumber);

    // A screen reader hears the turn only when it actually changes (the chrome itself is rebuilt on every poll).
    const spoken = turnPlainText(turn);
    if (spoken !== ctx.announced) {
      ctx.announced = spoken;
      shell.live.textContent = spoken;
    }

    renderPokerActionArea(shell.area, seat, state, container, ctx);
    syncActionState(container, ctx);
  }

  // ------------------------------------------------------------------------------------------------------------------------------
  // Action area (the editable subtree)
  // ------------------------------------------------------------------------------------------------------------------------------

  // Active Input Preservation — the editable subtree. myLegalActions
  // is already the server's own complete statement of "what this seat
  // may currently do and for how much" (canFold/canCheck/canCall/
  // callAmount/canBet/canRaise/minRaiseTo/canAllIn/maxAmount); if it is
  // byte-identical to the last render, this is unambiguously the same
  // pending decision, and leaving the input alone is not just safe but
  // correct — the same min/max still apply, so whatever the participant
  // already typed remains a legal amount. Prefixed with currentHandId
  // (mirroring how renderMathDuelActive() keys specifically on
  // activeDuel.duelId, not just answer-shape) so a brand-new Hand that
  // happens to present an identical legal-action shape (e.g. the same
  // seat as big blind in two consecutive Hands) still starts with a
  // fresh, empty amount field rather than carrying over a stale value
  // from a previous Hand's decision.
  function renderPokerActionArea(actionAreaEl, seat, state, container, ctx) {
    const la = state.myLegalActions;
    if (!la || isClosed(state)) {
      actionAreaEl.innerHTML = "";
      return;
    }

    const contextKey = `${state.currentHandId}:${JSON.stringify(la)}`;
    const existing = actionAreaEl.querySelector("[data-context]");
    if (existing && existing.dataset.context === contextKey) {
      return; // same decision still pending — leave the input/focus/value untouched
    }

    const me = findSeat(state, seat.seatNumber);
    // What an All-in actually puts in: the seat's remaining stack (maxAmount is a street TOTAL, not the chips pushed).
    const remaining = me ? Math.max(0, me.stack - me.committedThisHand) : null;
    const callIsAllIn = !!(la.canCall && remaining !== null && la.callAmount >= remaining);

    // The server decides which of these exist; the order below is the order they are offered in (and the tab order). ALL_IN is its own
    // authorized command (its amount is ignored server-side) and is never routed through the Raise field.
    const button = (action, cls, label, extra) =>
      ({ html: (wide) => `<button type="button" class="action-btn ${cls}${wide ? " pk-wide" : ""}" data-action="${action}"${extra || ""}>${label}</button>` });
    const before = [];
    const after = [];
    if (la.canFold) before.push(button("FOLD", "fold", "Fold"));
    if (la.canCheck) before.push(button("CHECK", "primary", "Check"));
    if (la.canCall) {
      before.push(button("CALL", "primary", `Call ${fmt(la.callAmount)}${callIsAllIn ? ` <span class="pk-btn-note">(all-in)</span>` : ""}`));
    }
    const wagering = [];
    if (la.canBet) wagering.push(button("BET", "aggressive", "Bet", ' data-needs-amount="1"'));
    if (la.canRaise) wagering.push(button("RAISE", "aggressive", "Raise", ' data-needs-amount="1"'));
    const allInButton = la.canAllIn ? button("ALL_IN", "allin", `All-in${remaining !== null ? " " + fmt(remaining) : ""}`) : null;

    // Bet/Raise-to labeling (§2): backend semantics verified against
    // computeLegalActions() and the min-raise test comments in
    // pokerGameplay.test.ts — both minRaiseTo and maxAmount are already
    // "total after this action" values (raise-TO, not raise-BY), so
    // "Raise to" is the truthful label, not "Raise by". canBet/canRaise
    // are mutually exclusive by construction (computeLegalActions'
    // own currentBet===0 branch never sets both), so exactly one label
    // ever applies.
    const amountLabel = la.canBet ? "Bet" : la.canRaise ? "Raise to" : null;
    const minAmount = la.minRaiseTo || 0;
    const maxAmount = la.maxAmount;
    // The amount field sits in the grid right before the Bet/Raise it feeds, so it is next to that button on screen and in tab order.
    const amountHtml = amountLabel
      ? `<div class="pk-amount">
          <div class="amount-row">
            <label for="amount-input" class="amount-label">${amountLabel}</label>
            <input type="number" id="amount-input" inputmode="numeric" step="1" min="${minAmount}" max="${maxAmount}" value="${la.minRaiseTo || la.maxAmount}" aria-describedby="amount-help amount-error" />
          </div>
          <p class="amount-help" id="amount-help"></p>
          <p class="msg error" id="amount-error" role="alert" hidden></p>
        </div>`
      : "";
    if (amountLabel) {
      after.push(...wagering);
      if (allInButton) after.push(allInButton);
    } else if (allInButton) {
      before.push(allInButton);
    }
    // A group with an odd number of buttons gives its last one the full row.
    const group = (list) => list.map((b, i) => b.html(list.length % 2 === 1 && i === list.length - 1)).join("");
    const gridHtml = group(before) + amountHtml + group(after);

    const owed = la.canCall ? `To call ${fmt(la.callAmount)}` : "Nothing to call";
    // contextKey is built from JSON.stringify(la) — full of literal
    // double-quote characters, which would prematurely terminate an
    // HTML attribute value if embedded directly in a template string
    // (data-context="${contextKey}" truncates at the first `"` inside
    // the JSON, silently corrupting the stored value and making the
    // "same decision" comparison above always false). Set via the
    // dataset API instead, after insertion, which needs no escaping.
    actionAreaEl.innerHTML = `<div class="pk-actionbar" role="group" aria-label="Your actions">
      <div class="pk-turnline"><span class="street-label">Choose an action</span><span class="pk-owed">${owed} · Pot ${fmt(state.pot)}</span></div>
      <div class="action-bar">${gridHtml}</div>
      <p class="msg" id="action-msg" role="status"></p>
    </div>`;
    actionAreaEl.firstElementChild.dataset.context = contextKey;

    const amountInput = actionAreaEl.querySelector("#amount-input");
    const helpEl = actionAreaEl.querySelector("#amount-help");
    const errorEl = actionAreaEl.querySelector("#amount-error");
    const actionMsg = actionAreaEl.querySelector("#action-msg");

    // kind marks the two lines this module may later replace or take back on its own: "sending" and "paused".
    function showActionMessage(text, isError, kind) {
      if (!actionMsg) return;
      actionMsg.className = isError ? "msg error" : "msg";
      actionMsg.dataset.kind = kind || "";
      actionMsg.textContent = text;
    }

    // The amount must be a COMPLETE whole number typed as digits, within the server's own min/max (raise-TO totals). Anything else is
    // refused with a reason — never rounded, truncated, clamped, or turned into some other wager.
    function checkAmount(raw) {
      const text = raw === null || raw === undefined ? "" : String(raw);
      if (!/^\d+$/.test(text)) return { ok: false, message: "Enter a whole number." };
      const value = Number(text);
      const verb = la.canBet ? "bet" : "raise to";
      if (!Number.isSafeInteger(value) || value > maxAmount) {
        return { ok: false, message: `The most you can ${verb} is ${fmt(maxAmount)} (all-in).` };
      }
      if (value < minAmount) return { ok: false, message: `The minimum is ${fmt(minAmount)}.` };
      return { ok: true, value };
    }

    function describeAmount(value) {
      if (la.canBet) return `You would put in ${fmt(value)} chips.`;
      const more = me ? value - me.committedThisStreet : null;
      return more !== null && more >= 0
        ? `Your total bet this round would be ${fmt(value)} (${fmt(more)} more chips).`
        : `Your total bet this round would be ${fmt(value)}.`;
    }

    // The error is an alert region. It is written only when its text changes (so typing does not repeat it), and written afresh when the
    // player explicitly tries to submit (so Enter on a bad value is announced even though focus does not move).
    function showAmountError(message, force) {
      if (force && !errorEl.hidden && errorEl.textContent === message) {
        errorEl.textContent = "";
        setTimeout(() => {
          errorEl.textContent = message;
        }, 60);
      } else if (errorEl.hidden || errorEl.textContent !== message) {
        errorEl.textContent = message;
      }
      errorEl.hidden = false;
    }
    function clearAmountError() {
      if (!errorEl.hidden) {
        errorEl.hidden = true;
        errorEl.textContent = "";
      }
    }

    // Typing updates the help line and the invalid state; it never rewrites the value being typed.
    function syncAmountHelp() {
      if (!amountInput) return;
      const check = checkAmount(amountInput.value);
      const base = `Min ${fmt(minAmount)} · Max ${fmt(maxAmount)} (all-in).`;
      helpEl.textContent = check.ok ? `${base} ${describeAmount(check.value)}` : base;
      amountInput.setAttribute("aria-invalid", check.ok || amountInput.value === "" ? "false" : "true");
      if (check.ok) {
        clearAmountError();
      } else if (amountInput.value !== "") {
        showAmountError(check.message, false);
      }
    }

    async function submit(actionType, amount) {
      if (ctx.busy) return;
      if (ctx.stale) {
        // Nothing is sent. The reminder line is already there (syncActionState wrote it when the poll failed); this only makes sure it is,
        // and never replaces a failure message from an earlier action.
        syncActionState(container, ctx);
        return;
      }
      ctx.busy = true;
      syncActionState(container, ctx);
      showActionMessage("Sending…", false, "sending");
      const result = await sendPokerAction(seat, state.currentHandId, actionType, amount);
      // The page may have left the table while the action was in flight (it clears the container). There is then nothing to update and
      // nothing may be drawn: no refresh, no message, no change to a table that may since have been rendered for another seat.
      if (!container.contains(actionAreaEl)) return; // (ctx.busy is not touched: it may belong to a newer table in the same container)
      if (result.status !== 200) {
        showActionMessage(
          result.status === 0
            ? "Couldn't reach the table. Your action may not have been received — check the table before trying again."
            : (result.json && result.json.error) || "Action failed.",
          true
        );
        ctx.busy = false;
        syncActionState(container, ctx);
      } else {
        // #poker-action-area's own parent is always the container
        // originally passed to renderPokerTable() — the shell's parts
        // are direct children of it.
        await renderPokerTable(container, seat);
        ctx.busy = false;
        // The action was accepted, so "Sending…" is no longer true. If the refresh failed, the table is stale and syncActionState says
        // so instead; if the same decision is still on screen, the line is simply cleared.
        if (actionMsg && actionMsg.dataset.kind === "sending") {
          actionMsg.className = "msg";
          actionMsg.dataset.kind = "";
          actionMsg.textContent = "";
        }
        syncActionState(container, ctx);
      }
    }

    function submitWithAmount(actionType) {
      const check = checkAmount(amountInput ? amountInput.value : "");
      if (!check.ok) {
        showAmountError(check.message, true);
        amountInput.setAttribute("aria-invalid", "true");
        amountInput.focus();
        return;
      }
      return submit(actionType, check.value);
    }

    actionAreaEl.querySelectorAll(".action-btn").forEach((btn) => {
      btn.addEventListener("click", () => {
        const actionType = btn.dataset.action;
        if (btn.dataset.needsAmount === "1" && amountInput) {
          submitWithAmount(actionType);
        } else {
          submit(actionType, null);
        }
      });
    });

    if (amountInput) {
      amountInput.addEventListener("input", syncAmountHelp);
      // Enter-to-submit (§3), matching the same safe convention already
      // established for Math Duel's own answer input: prevent default,
      // ignore IME composition, invoke whichever aggressive action is
      // currently offered. The normal button path is unchanged.
      amountInput.addEventListener("keydown", (event) => {
        if (event.key === "Enter" && !event.isComposing) {
          event.preventDefault();
          submitWithAmount(la.canBet ? "BET" : "RAISE");
        }
      });
      syncAmountHelp();
    }
  }

  global.PokerParticipant = {
    savePokerSeat,
    loadPokerSeat,
    clearPokerSeat,
    joinPokerTable,
    sendPokerAction,
    renderPokerTable,
    randomIdempotencyKey,
  };
})(window);
