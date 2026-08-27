/**
 * pokerParticipant.js — Participant Unified Entry Slice 002, extended
 * by the Poker Playtest UX + Showdown Transparency Slice.
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
 * ENGINEERING_PATTERNS.md's own named invariant): renderPokerTable()
 * used to rebuild its entire output — including the live Bet/Raise
 * amount <input> — via one `innerHTML` assignment on every ~2s poll
 * tick, destroying whatever a participant was mid-typing before they
 * could submit it. This is the same defect class already fixed for
 * Math Duel (participant.html's renderMathDuelActive()) and for Host
 * point-award/Duel-reason entry — the fix here uses the same "split
 * chrome from the editable subtree" technique renderMathDuelActive()
 * already uses: a stable #poker-chrome container (status pill, pot,
 * board, hole cards, seat list, hand result — none of it is ever
 * mid-edit, so it refreshes unconditionally every poll) and a separate
 * #poker-action-area container, rebuilt only when the decision it
 * represents has genuinely changed — see renderPokerActionArea()'s own
 * comment for the exact context key.
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

  function el(html) {
    const div = document.createElement("div");
    div.innerHTML = html.trim();
    return div.firstElementChild;
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

  // Poker Playtest UX Slice (card-rank display, §5): presentation
  // only — "T" is pokersolver's and this codebase's own internal rank
  // code for Ten (deck generation, the evaluator, storage, and the API
  // all keep using "T" unchanged); this map exists solely so a human
  // reader sees "10" on the card face instead of an unfamiliar letter.
  function displayRank(rank) {
    return rank === "T" ? "10" : rank;
  }

  function renderCard(code) {
    if (!code) return `<div class="playing-card face-down">?</div>`;
    const rank = displayRank(code[0]);
    const suit = code[1];
    const suitSymbol = { C: "♣", D: "♦", H: "♥", S: "♠" }[suit] || suit;
    const isRed = suit === "D" || suit === "H";
    return `<div class="playing-card${isRed ? " red" : ""}">${rank}${suitSymbol}</div>`;
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

  // Poker Playtest UX Slice (showdown transparency, §6-8): every
  // revealed (non-folded) seat's own line — "{name} won/lost —
  // {hand}" — built from data GET_TABLE_STATE already returns in full
  // to every caller once street reaches COMPLETE (handResult.
  // showdownHands), just never rendered until now. `descr` falls back
  // to `rankName` for any hand settled before this Slice shipped (a
  // real production case: existing poker_hand_results rows have no
  // `descr` field at all) so older completed hands still show
  // something truthful, just coarser. Folded seats are never present
  // in showdownHands at any point — this renders only what the
  // existing, unchanged reveal rule already exposes.
  function buildShowdownLines(state, mySeatNumber) {
    const handResult = state.handResult;
    if (!handResult || !handResult.showdownHands) return "";

    const payoutBySeat = {};
    for (const pot of handResult.pots || []) {
      for (const p of pot.payouts || []) {
        payoutBySeat[p.seatNumber] = (payoutBySeat[p.seatNumber] || 0) + p.amount;
      }
    }
    const seatByNumber = new Map((state.seats || []).map((s) => [s.seatNumber, s]));

    const rows = Object.keys(handResult.showdownHands)
      .map(Number)
      .sort((a, b) => a - b)
      .map((seatNumber) => {
        const entry = handResult.showdownHands[String(seatNumber)];
        const seatInfo = seatByNumber.get(seatNumber);
        const name = seatNumber === mySeatNumber ? "You" : (seatInfo ? seatInfo.displayName : `Seat ${seatNumber}`);
        const outcome = (payoutBySeat[seatNumber] || 0) > 0 ? "won" : "lost";
        const descr = cleanHandDescr(entry.descr || entry.rankName);
        return `<div class="poker-result-row"><span>${name} ${outcome} — ${descr}</span></div>`;
      });

    return rows.join("");
  }

  // container is the element to render into — participant.html and
  // poker-table.html each pass their own (#poker-container /
  // #table-card) so this module owns no page-specific DOM assumptions
  // beyond "give me somewhere to render." A stable #poker-chrome +
  // #poker-action-area shell is created once per container on first
  // call (mirrors renderMathDuelActive()'s own "shell built once"
  // check); thereafter chrome is refreshed unconditionally and the
  // action area is rebuilt only when its own decision context changes
  // — see renderPokerActionArea().
  async function renderPokerTable(container, seat) {
    const res = await pokerApiFetch(`/api/gaming/poker/tables/${seat.pokerTableId}`, {
      headers: { authorization: "Bearer " + seat.participantToken },
    });

    if (res.status !== 200) {
      container.innerHTML = "";
      container.appendChild(el(`<div class="card"><p class="msg error">${(res.json && res.json.error) || "Failed to load table."}</p></div>`));
      return;
    }

    const state = res.json;
    const mySeatNumber = seat.seatNumber;

    let chromeEl = container.querySelector("#poker-chrome");
    let actionAreaEl = container.querySelector("#poker-action-area");
    if (!chromeEl) {
      container.innerHTML = `<div id="poker-chrome"></div><div id="poker-action-area"></div>`;
      chromeEl = container.querySelector("#poker-chrome");
      actionAreaEl = container.querySelector("#poker-action-area");
    }

    const seatRows = state.seats.map((s) => {
      const classes = ["seat-row"];
      if (s.seatNumber === mySeatNumber) classes.push("is-me");
      if (s.isCurrentActor) classes.push("is-turn");
      if (s.folded) classes.push("is-folded");
      const badges = [
        s.isDealer ? '<span class="seat-badge">Dealer</span>' : "",
        s.isCurrentActor ? '<span class="seat-badge turn">Acting</span>' : "",
        s.allIn ? '<span class="seat-badge allin">All-in</span>' : "",
        state.currentHandId && !s.inCurrentHand ? '<span class="seat-badge">Waiting</span>' : "",
      ].join("");
      const cardsRow = s.revealedHoleCards
        ? `<div class="hole-cards" style="margin:4px 0 0;">${s.revealedHoleCards.map(renderCard).join("")}</div>`
        : "";
      return `<div class="${classes.join(" ")}">
        <span class="seat-name">${s.displayName}${s.seatNumber === mySeatNumber ? " (you)" : ""}${cardsRow}</span>
        <span><span class="seat-stack">${s.stack} chips${s.committedThisHand ? " (" + s.committedThisHand + " in)" : ""}</span>${badges}</span>
      </div>`;
    }).join("");

    // Poker End Table Lifecycle Slice: purely additive — myLegalActions
    // is already null whenever closedAt is set (closing is legal only
    // once the most recent Hand reaches street='COMPLETE', the exact
    // same condition that already clears myLegalActions in
    // getTableState.ts), so the action area below needs no new logic
    // at all; only the chrome gets a terminal message.
    const holeCardsHtml = state.closedAt !== null
      ? `<p class="msg">This table has ended. Thanks for playing.</p>`
      : state.myHoleCards
        ? `<div class="hole-cards">${state.myHoleCards.map(renderCard).join("")}</div>`
        : state.currentHandId
          ? `<p class="msg">You'll join the next Hand.</p>`
          : `<p class="msg">Waiting for the host to deal.</p>`;

    const boardHtml = state.board && state.board.length > 0
      ? `<div class="board-cards">${state.board.map(renderCard).join("")}</div>`
      : "";

    let resultHtml = "";
    if (state.handResult) {
      const myPayout = state.handResult.pots
        .flatMap((p) => p.payouts)
        .filter((p) => p.seatNumber === mySeatNumber)
        .reduce((s, p) => s + p.amount, 0);
      const isWin = myPayout > 0;
      const showdownLines = buildShowdownLines(state, mySeatNumber);
      resultHtml = `<div class="card poker-result-card${isWin ? " poker-result-win" : ""}">
        <div class="poker-result-row"><span>Hand result</span><span>${isWin ? "You won " + myPayout : "No win this hand"}</span></div>
        ${showdownLines}
      </div>`;
    }

    const statusLabel = state.closedAt !== null ? "Table Ended" : (state.street || "Waiting");
    chromeEl.innerHTML = `
      <div class="card felt">
        <span class="status-pill">Room ${state.roomCode} — ${statusLabel}</span>
        <div class="pot-row">🪙 Pot: ${state.pot} chips</div>
        ${boardHtml}
        ${holeCardsHtml}
      </div>
      ${resultHtml}
      <div class="card">
        <div class="seat-list">${seatRows}</div>
      </div>
    `;

    renderPokerActionArea(actionAreaEl, seat, state);
  }

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
  function renderPokerActionArea(actionAreaEl, seat, state) {
    const la = state.myLegalActions;
    if (!la) {
      actionAreaEl.innerHTML = "";
      return;
    }

    const contextKey = `${state.currentHandId}:${JSON.stringify(la)}`;
    const existing = actionAreaEl.querySelector("[data-context]");
    if (existing && existing.dataset.context === contextKey) {
      return; // same decision still pending — leave the input/focus/value untouched
    }

    const buttons = [];
    if (la.canFold) buttons.push(`<button class="action-btn fold" data-action="FOLD">Fold</button>`);
    if (la.canCheck) buttons.push(`<button class="action-btn" data-action="CHECK">Check</button>`);
    if (la.canCall) buttons.push(`<button class="action-btn primary" data-action="CALL">Call ${la.callAmount}</button>`);
    if (la.canBet) buttons.push(`<button class="action-btn aggressive" data-action="BET" data-needs-amount="1">Bet</button>`);
    if (la.canRaise) buttons.push(`<button class="action-btn aggressive" data-action="RAISE" data-needs-amount="1">Raise</button>`);
    if (la.canAllIn) buttons.push(`<button class="action-btn fold" data-action="ALL_IN">All-in ${la.maxAmount}</button>`);

    // Bet/Raise-to labeling (§2): backend semantics verified against
    // computeLegalActions() and the min-raise test comments in
    // pokerGameplay.test.ts — both minRaiseTo and maxAmount are already
    // "total after this action" values (raise-TO, not raise-BY), so
    // "Raise to" is the truthful label, not "Raise by". canBet/canRaise
    // are mutually exclusive by construction (computeLegalActions'
    // own currentBet===0 branch never sets both), so exactly one label
    // ever applies.
    const amountLabel = la.canBet ? "Bet" : la.canRaise ? "Raise to" : null;
    const amountHtml = amountLabel
      ? `<div class="amount-row">
          <label for="amount-input" class="amount-label">${amountLabel}</label>
          <input type="number" id="amount-input" inputmode="numeric" min="${la.minRaiseTo || 0}" max="${la.maxAmount}" value="${la.minRaiseTo || la.maxAmount}" />
        </div>
        <p class="amount-help">Min ${la.minRaiseTo || 0} · All-in ${la.maxAmount}</p>`
      : "";

    // contextKey is built from JSON.stringify(la) — full of literal
    // double-quote characters, which would prematurely terminate an
    // HTML attribute value if embedded directly in a template string
    // (data-context="${contextKey}" truncates at the first `"` inside
    // the JSON, silently corrupting the stored value and making the
    // "same decision" comparison above always false). Set via the
    // dataset API instead, after insertion, which needs no escaping.
    actionAreaEl.innerHTML = `<div>
      <div class="street-label">Your turn</div>
      <div class="action-bar">${buttons.join("")}</div>
      ${amountHtml}
      <p class="msg" id="action-msg"></p>
    </div>`;
    actionAreaEl.firstElementChild.dataset.context = contextKey;

    const amountInput = actionAreaEl.querySelector("#amount-input");

    async function submitAggressiveAction(actionType) {
      const needsAmount = true;
      const amount = needsAmount && amountInput ? parseInt(amountInput.value, 10) : null;
      await submit(actionType, amount);
    }

    async function submit(actionType, amount) {
      actionAreaEl.querySelectorAll(".action-btn").forEach((b) => (b.disabled = true));
      const actionMsg = actionAreaEl.querySelector("#action-msg");
      if (actionMsg) actionMsg.textContent = "Sending…";
      const result = await sendPokerAction(seat, state.currentHandId, actionType, amount);
      if (result.status !== 200) {
        const msg = actionAreaEl.querySelector("#action-msg");
        if (msg) {
          msg.className = "msg error";
          msg.textContent = (result.json && result.json.error) || "Action failed.";
        }
        actionAreaEl.querySelectorAll(".action-btn").forEach((b) => (b.disabled = false));
      } else {
        // #poker-action-area's own parent is always the container
        // originally passed to renderPokerTable() — #poker-chrome and
        // #poker-action-area are direct siblings created inside it.
        await renderPokerTable(actionAreaEl.parentElement, seat);
      }
    }

    actionAreaEl.querySelectorAll(".action-btn").forEach((btn) => {
      btn.addEventListener("click", () => {
        const actionType = btn.dataset.action;
        const needsAmount = btn.dataset.needsAmount === "1";
        const amount = needsAmount && amountInput ? parseInt(amountInput.value, 10) : null;
        submit(actionType, amount);
      });
    });

    // Enter-to-submit (§3), matching the same safe convention already
    // established for Math Duel's own answer input: prevent default,
    // ignore IME composition, invoke whichever aggressive action is
    // currently offered. The normal button path is unchanged.
    if (amountInput && amountLabel) {
      amountInput.addEventListener("keydown", (event) => {
        if (event.key === "Enter" && !event.isComposing) {
          event.preventDefault();
          const actionType = la.canBet ? "BET" : "RAISE";
          submitAggressiveAction(actionType);
        }
      });
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
