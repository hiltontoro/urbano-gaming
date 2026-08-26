/**
 * pokerParticipant.js — Participant Unified Entry Slice 002.
 *
 * Poker's own participant-facing behavior (join, table fetch, private
 * cards, board, pot, seats, legal actions, hand result), extracted
 * from what was previously poker-table.html's own inline copy so the
 * canonical /participant.html entry point and the standalone
 * /poker-table.html compatibility surface share one implementation
 * instead of two that could silently drift apart. Poker rules
 * themselves are unchanged by this extraction — this module only
 * renders what the server already decided (myLegalActions is computed
 * server-side; every button tap still goes through PLAYER_ACTION's
 * own full server-side validation, exactly as before).
 *
 * Poker seat identity now persists in sessionStorage (tab-scoped), not
 * localStorage — a deliberate Founder correction: a Poker seat joined
 * in one browser tab must not silently become the active Poker
 * identity of every other tab in the same browser, matching how
 * Session participant identity already works on this same page. This
 * is the one behavior change this extraction makes to Poker's
 * existing, proven gameplay; every other function below is preserved
 * verbatim from poker-table.html's own original implementation.
 *
 * Exposed as window.PokerParticipant (not bare globals) so this
 * module's small function names (renderCard, apiFetch, ...) cannot
 * collide with participant.html's own much larger existing global
 * surface.
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

  function renderCard(code) {
    if (!code) return `<div class="playing-card face-down">?</div>`;
    const rank = code[0];
    const suit = code[1];
    const suitSymbol = { C: "♣", D: "♦", H: "♥", S: "♠" }[suit] || suit;
    const isRed = suit === "D" || suit === "H";
    return `<div class="playing-card${isRed ? " red" : ""}">${rank}${suitSymbol}</div>`;
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

  // container is the element to render into — participant.html and
  // poker-table.html each pass their own (#poker-container /
  // #table-card) so this module owns no page-specific DOM assumptions
  // beyond "give me somewhere to render." Every element this function
  // itself needs afterward (action buttons, the amount input) is
  // looked up scoped to that same container, never via a bare
  // document.getElementById, so this is safe to render into either
  // page without id-collision risk.
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

    const holeCardsHtml = state.myHoleCards
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
      resultHtml = `<div class="card poker-result-card">
        <div class="poker-result-row"><span>Hand result</span><span>${myPayout > 0 ? "You won " + myPayout : "No win this hand"}</span></div>
      </div>`;
    }

    let actionHtml = "";
    if (state.myLegalActions) {
      const la = state.myLegalActions;
      const buttons = [];
      if (la.canFold) buttons.push(`<button class="action-btn fold" data-action="FOLD">Fold</button>`);
      if (la.canCheck) buttons.push(`<button class="action-btn" data-action="CHECK">Check</button>`);
      if (la.canCall) buttons.push(`<button class="action-btn primary" data-action="CALL">Call ${la.callAmount}</button>`);
      if (la.canBet) buttons.push(`<button class="action-btn aggressive" data-action="BET" data-needs-amount="1">Bet</button>`);
      if (la.canRaise) buttons.push(`<button class="action-btn aggressive" data-action="RAISE" data-needs-amount="1">Raise</button>`);
      if (la.canAllIn) buttons.push(`<button class="action-btn fold" data-action="ALL_IN">All-in ${la.maxAmount}</button>`);

      actionHtml = `
        <div class="street-label">Your turn</div>
        <div class="action-bar">${buttons.join("")}</div>
        ${(la.canBet || la.canRaise) ? `<div class="amount-row">
          <input type="number" id="amount-input" placeholder="Amount" min="${la.minRaiseTo || 0}" max="${la.maxAmount}" value="${la.minRaiseTo || la.maxAmount}" />
        </div>` : ""}
        <p class="msg" id="action-msg"></p>
      `;
    }

    container.innerHTML = "";
    container.appendChild(el(`
      <div>
        <div class="card felt">
          <span class="status-pill">Room ${state.roomCode} — ${state.street || "Waiting"}</span>
          <div class="pot-row">Pot: ${state.pot} chips</div>
          ${boardHtml}
          ${holeCardsHtml}
        </div>
        ${resultHtml}
        <div class="card">
          <div class="seat-list">${seatRows}</div>
          ${actionHtml}
        </div>
      </div>
    `));

    if (state.myLegalActions) {
      const amountInput = container.querySelector("#amount-input");
      container.querySelectorAll(".action-btn").forEach((btn) => {
        btn.addEventListener("click", async () => {
          const actionType = btn.dataset.action;
          const needsAmount = btn.dataset.needsAmount === "1";
          const amount = needsAmount && amountInput ? parseInt(amountInput.value, 10) : null;
          container.querySelectorAll(".action-btn").forEach((b) => (b.disabled = true));
          const actionMsg = container.querySelector("#action-msg");
          if (actionMsg) actionMsg.textContent = "Sending…";
          const result = await sendPokerAction(seat, state.currentHandId, actionType, amount);
          if (result.status !== 200) {
            const msg = container.querySelector("#action-msg");
            if (msg) {
              msg.className = "msg error";
              msg.textContent = (result.json && result.json.error) || "Action failed.";
            }
            container.querySelectorAll(".action-btn").forEach((b) => (b.disabled = false));
          } else {
            await renderPokerTable(container, seat);
          }
        });
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
