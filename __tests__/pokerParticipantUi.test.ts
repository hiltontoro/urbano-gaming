import { afterEach, describe, expect, it } from "vitest";
import { JSDOM, VirtualConsole } from "jsdom";
import { readFileSync } from "node:fs";
import path from "node:path";

/**
 * Poker player table UI (Player Table UI Slice 001). These tests run the ACTUAL shipped files in jsdom — pokerParticipant.js evaluated into
 * a window exactly as a browser <script> tag would, the real sessionSync.js poller, and participant.html loaded whole — and assert on the
 * resulting DOM and on the requests the page makes. Layout and colour are NOT asserted here (jsdom has no layout); they are inspected
 * separately in a real browser (see POKER_PLAYER_UI_IMPLEMENTATION_RECORD.md).
 */

const read = (relative: string) => readFileSync(path.join(process.cwd(), relative), "utf8");
const POKER_JS = read("public/pokerParticipant.js");
const SESSION_SYNC_JS = read("public/sessionSync.js");
const PARTICIPANT_HTML = read("public/participant.html");
const POKER_TABLE_HTML = read("public/poker-table.html");

const TABLE_ID = "11111111-2222-3333-4444-555555555555";
const HAND_ID = "66666666-7777-8888-9999-000000000000";
const SEAT_TOKEN = "synthetic-seat-token";
const SEAT = { pokerTableId: TABLE_ID, participantToken: SEAT_TOKEN, seatNumber: 0 };
const ALLOWED_TAGS = ["div", "span", "p", "button", "input", "label"];

// ---------------------------------------------------------------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------------------------------------------------------------

type Call = { url: string; method: string; headers: Record<string, string>; body: any };
type Reply = { status: number; json: unknown };

/** What the pretend server does right now. `get` may return a promise (to hold a response back) or throw (a network failure). */
type Table = {
  state: unknown;
  online: boolean;
  getReply?: Reply;
  get?: (call: Call) => Promise<Reply>;
  post: (call: Call) => Promise<Reply>;
};

const windows: Array<{ close(): void }> = [];
afterEach(() => {
  while (windows.length) windows.pop()!.close();
});

const quiet = () => {
  const vc = new VirtualConsole();
  vc.on("jsdomError", (e) => console.error(e));
  return vc;
};

function newTable(state: unknown): Table {
  return { state, online: true, post: async () => ({ status: 200, json: { pokerHandId: HAND_ID, alreadyApplied: false } }) };
}

function installFetch(win: any, table: Table): Call[] {
  const calls: Call[] = [];
  win.fetch = (url: string, init: any = {}) => {
    const call: Call = { url: String(url), method: init.method ?? "GET", headers: init.headers ?? {}, body: init.body ? JSON.parse(init.body) : undefined };
    calls.push(call);
    const settle = (reply: Reply) => ({ status: reply.status, json: async () => reply.json });
    if (call.method === "GET") {
      if (!table.online) return Promise.reject(new TypeError("offline"));
      if (table.get) return table.get(call).then(settle);
      const reply = table.getReply ?? { status: 200, json: table.state };
      return Promise.resolve(settle(reply));
    }
    if (!table.online) return Promise.reject(new TypeError("offline"));
    return table.post(call).then(settle);
  };
  return calls;
}

async function mount(table: Table) {
  const dom = new JSDOM('<!doctype html><html><body><div id="c"></div></body></html>', { url: "http://localhost/participant.html", runScripts: "outside-only", pretendToBeVisual: true, virtualConsole: quiet() });
  windows.push(dom.window);
  const win = dom.window as any;
  const calls = installFetch(win, table);
  win.eval(POKER_JS);
  const container = win.document.getElementById("c") as HTMLElement;
  const render = () => win.PokerParticipant.renderPokerTable(container, SEAT) as Promise<void>;
  await render();
  return { win, container, calls, render, table };
}

const tick = () => new Promise((r) => setTimeout(r, 0));
async function until(predicate: () => boolean, label: string, timeoutMs = 3000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    await tick();
    if (predicate()) return;
    if (Date.now() > deadline) throw new Error(`timed out waiting for: ${label}`);
  }
}

function violations(root: Element, allowed = ALLOWED_TAGS): string[] {
  const out: string[] = [];
  for (const el of Array.from(root.querySelectorAll("*"))) {
    const tag = el.tagName.toLowerCase();
    if (!allowed.includes(tag)) out.push(`unexpected <${tag}>`);
    for (const attr of Array.from(el.attributes)) if (attr.name.toLowerCase().startsWith("on")) out.push(`<${tag}> carries ${attr.name}`);
  }
  return out;
}
const ownText = (el: Element) => Array.from(el.childNodes).filter((n) => n.nodeType === 3).map((n) => n.nodeValue ?? "").join("");
const text = (root: ParentNode, selector: string) => (root.querySelector(selector)?.textContent ?? "").replace(/\s+/g, " ").trim();
const allText = (root: Element) => (root.textContent ?? "").replace(/\s+/g, " ");
const actions = (container: Element) => Array.from(container.querySelectorAll<HTMLButtonElement>("#poker-action-area .action-btn"));
const actionNames = (container: Element) => actions(container).map((b) => b.dataset.action);
const posts = (calls: Call[]) => calls.filter((c) => c.method === "POST");
const input = (container: Element) => container.querySelector<HTMLInputElement>("#amount-input")!;

// ---------------------------------------------------------------------------------------------------------------------------------
// Synthetic states shaped like getTableState's response (chip totals consistent with the read model)
// ---------------------------------------------------------------------------------------------------------------------------------

const seat = (i: number, displayName: string, o: Record<string, unknown> = {}) => ({
  seatNumber: i, displayName, isDealer: false, inCurrentHand: true, stack: 1000, committedThisHand: 0, committedThisStreet: 0,
  folded: false, allIn: false, isCurrentActor: false, revealedHoleCards: null, ...o,
});
const state = (o: Record<string, unknown> = {}) => ({
  pokerTableId: TABLE_ID, roomCode: "ABC234", maxSeats: 6, closedAt: null, startingStack: 1000, smallBlind: 5, bigBlind: 10, seats: [],
  currentHandId: HAND_ID, currentHandOrdinal: 4, street: "FLOP", board: ["AS", "KD", "7C"], pot: 0, myHoleCards: ["AH", "QH"],
  myLegalActions: null, handResult: null, ...o,
});
const legal = (o: Record<string, unknown> = {}) => ({
  canFold: true, canCheck: false, canCall: false, callAmount: 0, canBet: false, canRaise: false, minRaiseTo: null, canAllIn: true, maxAmount: 1000, ...o,
});

/** Viewer (seat 0) is the actor, facing a raise: has put in 5, owes 25 more, may raise to 50..1000 (a street TOTAL). */
const FACING = legal({ canCall: true, callAmount: 25, canRaise: true, minRaiseTo: 50, maxAmount: 1000 });
function turnState(la: Record<string, unknown> = FACING, o: Record<string, unknown> = {}, viewer: Record<string, unknown> = {}) {
  const seats = [
    seat(0, "Maya", { isCurrentActor: true, committedThisHand: 5, committedThisStreet: 5, ...viewer }),
    seat(1, "Sam", { committedThisHand: 10, committedThisStreet: 10 }),
    seat(2, "Alex", { committedThisHand: 30, committedThisStreet: 30 }),
    seat(3, "Jordan", { isDealer: true, folded: true }),
  ];
  return state({ street: "PRE_FLOP", board: [], pot: 45, seats, myLegalActions: la, ...o });
}
function waitingState(names: [string, string, string] = ["Maya", "Sam", "Alex"], o: Record<string, unknown> = {}) {
  const seats = [seat(0, names[0], { committedThisHand: 60 }), seat(1, names[1], { isCurrentActor: true, committedThisHand: 60 }), seat(2, names[2], { committedThisHand: 60 })];
  return state({ pot: 180, seats, ...o });
}

const FULL_BOARD = ["AS", "KD", "7C", "2H", "9S"];
type Hand = { cards: [string, string]; rankName: string; descr?: string };
/** A finished showdown: seats 0..2 each put in 120, seat 3 folded after 20 (two pots: 80 + 300). */
function showdownState(names: string[], winners: Array<{ seat: number; amount: number }[]>, hands?: Record<string, Hand>, o: Record<string, unknown> = {}) {
  const committed = [120, 120, 120, 20];
  const showdownHands = hands ?? Object.fromEntries([0, 1, 2].map((i) => [String(i), { cards: ["AH", "KH"], rankName: "Pair", descr: "Pair, A's" }]));
  const seats = names.map((n, i) => seat(i, n, { isDealer: i === 3, folded: i === 3, stack: 900, committedThisHand: committed[i], revealedHoleCards: i < 3 ? (showdownHands as any)[String(i)]?.cards ?? null : null }));
  const handResult = {
    pokerHandId: HAND_ID, board: FULL_BOARD, completedAt: "2026-11-05T21:00:00.000Z", showdownHands,
    pots: [
      { amount: 80, eligibleSeatNumbers: [0, 1, 2], payouts: winners[0].map((w) => ({ seatNumber: w.seat, amount: w.amount })) },
      { amount: 300, eligibleSeatNumbers: [0, 1, 2], payouts: winners[1].map((w) => ({ seatNumber: w.seat, amount: w.amount })) },
    ],
  };
  return state({ street: "COMPLETE", board: FULL_BOARD, pot: 380, seats, handResult, myHoleCards: ["AH", "QH"], ...o });
}
const SAM_WINS = [[{ seat: 1, amount: 80 }], [{ seat: 1, amount: 300 }]];

/** A hand that ended because everyone else folded: `winner` took both pots, which only that seat was eligible for. */
function foldWinState(names: string[], winner: number, o: Record<string, unknown> = {}) {
  const committed = [140, 140, 20, 20];
  const seats = names.map((n, i) => seat(i, n, { isDealer: i === 3, folded: i !== winner, stack: 1000 - committed[i] + (i === winner ? 320 : 0), committedThisHand: committed[i] }));
  const handResult = {
    pokerHandId: HAND_ID, board: ["AS", "KD", "7C"], completedAt: "2026-11-05T21:00:00.000Z", showdownHands: null,
    pots: [
      { amount: 80, eligibleSeatNumbers: [winner], payouts: [{ seatNumber: winner, amount: 80 }] },
      { amount: 240, eligibleSeatNumbers: [winner], payouts: [{ seatNumber: winner, amount: 240 }] },
    ],
  };
  return state({ street: "COMPLETE", board: ["AS", "KD", "7C"], pot: 320, seats, handResult, ...o });
}

const HANDS_3: Record<string, Hand> = {
  "0": { cards: ["AH", "QH"], rankName: "Pair", descr: "Pair, A's" },
  "1": { cards: ["KH", "KC"], rankName: "Two Pair", descr: "Two Pair, K's & 7's" },
  "2": { cards: ["7D", "7H"], rankName: "Pair", descr: "Pair, 7's" },
};
type Pot = { amount: number; eligibleSeatNumbers?: number[]; payouts: Array<{ seatNumber: number; amount: number }> };
/** A completed showdown among seats 0..2 (viewer = seat 0) with exactly the pots given; chip totals are not needed to word the result. */
function resultState(pots: Pot[], hands: Record<string, Hand> = HANDS_3, o: Record<string, unknown> = {}) {
  const seats = [seat(0, "Maya", { stack: 900, committedThisHand: 100 }), seat(1, "Sam", { stack: 900, committedThisHand: 100 }), seat(2, "Alex", { stack: 900, committedThisHand: 100 })];
  const handResult = { pokerHandId: HAND_ID, board: FULL_BOARD, completedAt: "x", showdownHands: hands, pots };
  return state({ street: "COMPLETE", board: FULL_BOARD, pot: 300, seats, handResult, ...o });
}
/** Seat `refundSeat` bet 300 and was called all-in for 100 by seat `other`, who wins the contested pots; the refund seat gets 200 back. */
function uncalledPots(refundSeat: number, other: number): Pot[] {
  return [
    { amount: 60, eligibleSeatNumbers: [refundSeat, other].sort(), payouts: [{ seatNumber: other, amount: 60 }] },
    { amount: 160, eligibleSeatNumbers: [refundSeat, other].sort(), payouts: [{ seatNumber: other, amount: 160 }] },
    { amount: 200, eligibleSeatNumbers: [refundSeat], payouts: [{ seatNumber: refundSeat, amount: 200 }] },
  ];
}
/** The verb on each seat's showdown line ("won" | "lost" | "showed" | "shared the pot"), keyed by who the line names. */
function verbsByName(container: Element): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of Array.from(container.querySelectorAll(".pk-reveal-line"))) {
    const m = /^(.+?) (won|lost|showed|shared the pot) — /.exec(line.textContent ?? "");
    if (m) out[m[1]] = m[2];
  }
  return out;
}

// ---------------------------------------------------------------------------------------------------------------------------------
// 1. Which actions are offered, and exactly which command each one sends
// ---------------------------------------------------------------------------------------------------------------------------------

describe("legal-action combinations", () => {
  const CASES: Array<{ label: string; la: Record<string, unknown>; viewer?: Record<string, unknown>; expected: string[]; amountLabel: string | null }> = [
    { label: "facing a bet", la: FACING, expected: ["FOLD", "CALL", "RAISE", "ALL_IN"], amountLabel: "Raise to" },
    { label: "check or bet", la: legal({ canCheck: true, canBet: true, minRaiseTo: 10, maxAmount: 980 }), expected: ["FOLD", "CHECK", "BET", "ALL_IN"], amountLabel: "Bet" },
    { label: "the big-blind option (check or raise)", la: legal({ canCheck: true, canRaise: true, minRaiseTo: 20, maxAmount: 990 }), expected: ["FOLD", "CHECK", "RAISE", "ALL_IN"], amountLabel: "Raise to" },
    { label: "a call that uses the whole stack (cannot raise)", la: legal({ canCall: true, callAmount: 120, maxAmount: 120 }), viewer: { stack: 150, committedThisHand: 30, committedThisStreet: 0 }, expected: ["FOLD", "CALL", "ALL_IN"], amountLabel: null },
  ];

  it.each(CASES)("$label: offers exactly the server-authorized actions, in order, with an amount field only for Bet/Raise", async ({ la, viewer, expected, amountLabel }) => {
    const { container } = await mount(newTable(turnState(la, {}, viewer)));
    expect(actionNames(container)).toEqual(expected);
    if (amountLabel) {
      expect(text(container, "label.amount-label")).toBe(amountLabel);
      expect(input(container)).toBeTruthy();
    } else {
      expect(container.querySelector("#amount-input")).toBeNull();
    }
  });

  it.each(CASES)("$label: every button sends its own command type (All-in is never sent as Raise)", async ({ la, viewer, expected }) => {
    for (const name of expected) {
      const { container, calls } = await mount(newTable(turnState(la, {}, viewer)));
      if (input(container)) input(container).value = String(la.minRaiseTo ?? 10);
      container.querySelector<HTMLButtonElement>(`[data-action="${name}"]`)!.click();
      await until(() => posts(calls).length === 1, `${name} request`);
      const body = posts(calls)[0].body;
      expect(body.actionType).toBe(name);
      expect(body.pokerHandId).toBe(HAND_ID);
      expect(posts(calls)[0].headers.authorization).toBe(`Bearer ${SEAT_TOKEN}`);
      if (name === "BET" || name === "RAISE") expect(body.amount).toBe(Number(la.minRaiseTo));
      else expect(body.amount).toBeNull();
    }
  });

  it("All-in ignores whatever is typed in the Raise field and carries no amount", async () => {
    const { container, calls } = await mount(newTable(turnState()));
    input(container).value = "500";
    container.querySelector<HTMLButtonElement>('[data-action="ALL_IN"]')!.click();
    await until(() => posts(calls).length === 1, "All-in request");
    expect(posts(calls)[0].body).toMatchObject({ actionType: "ALL_IN", amount: null });
  });

  it("Raise is offered only when the server says canRaise, and Bet only when canBet", async () => {
    const noRaise = await mount(newTable(turnState(legal({ canCall: true, callAmount: 25, canRaise: false, maxAmount: 995 }))));
    expect(actionNames(noRaise.container)).not.toContain("RAISE");
    expect(actionNames(noRaise.container)).not.toContain("BET");
    expect(noRaise.container.querySelector("#amount-input")).toBeNull();
  });

  it("All-in shows the chips it puts in (remaining stack), not the street total; a call that uses the whole stack says so", async () => {
    const facing = await mount(newTable(turnState()));
    expect(text(facing.container, '[data-action="ALL_IN"]')).toBe("All-in 995"); // stack 1000 − 5 committed; maxAmount (a street total) is 1000
    expect(text(facing.container, '[data-action="CALL"]')).toBe("Call 25");
    expect(allText(facing.container)).toContain("To call 25");

    const short = await mount(newTable(turnState(legal({ canCall: true, callAmount: 120, maxAmount: 120 }), {}, { stack: 150, committedThisHand: 30 })));
    expect(text(short.container, '[data-action="CALL"]')).toBe("Call 120 (all-in)");
    expect(text(short.container, '[data-action="ALL_IN"]')).toBe("All-in 120");
  });

  it("never shows a table-wide 'bet to match', blinds, last actions or timers", async () => {
    const { container } = await mount(newTable(turnState()));
    const t = allText(container).toLowerCase();
    for (const forbidden of ["bet to match", "to match", "small blind", "big blind", "last action", "timer", "seconds left", "side pot"]) expect(t).not.toContain(forbidden);
  });
});

// ---------------------------------------------------------------------------------------------------------------------------------
// 1b. Small-screen layout: reading order, tab order, and nothing pinned over the cards
// ---------------------------------------------------------------------------------------------------------------------------------

describe("action layout", () => {
  const follows = (a: Element, b: Element) => Boolean(a.compareDocumentPosition(b) & 4); // b comes after a

  it("reads in playing order inside the one table (turn, pot, community cards, your cards, actions, connection notice), then the information panel", async () => {
    const { container } = await mount(newTable(turnState()));
    expect(Array.from(container.children).map((c) => c.id)).toEqual(["poker-live", "poker-table", "poker-info"]);
    const table = container.querySelector("#poker-table")!;
    expect(Array.from(table.children).map((c) => c.id)).toEqual(["poker-chrome", "poker-action-area", "poker-notice"]);
    const inOrder = [".pk-turn", ".pk-pot", ".pk-board", ".pk-hand", ".pk-actionbar", "#poker-notice"].map((sel) => table.querySelector(sel)!);
    inOrder.forEach((el, i) => {
      expect(el, String(i)).toBeTruthy();
      if (i > 0) expect(follows(inOrder[i - 1], el), `section ${i} follows section ${i - 1}`).toBe(true);
    });
    expect(follows(table, container.querySelector('[aria-label="Players"]')!)).toBe(true);
  });

  it("the amount field sits in the action grid between Call and Raise, so tab order is Fold, Call, amount, Raise, All-in", async () => {
    const { win, container } = await mount(newTable(turnState()));
    const grid = container.querySelector(".action-bar")!;
    const order = Array.from(grid.children).map((c) => (c.classList.contains("pk-amount") ? "amount" : (c as HTMLElement).dataset.action));
    expect(order).toEqual(["FOLD", "CALL", "amount", "RAISE", "ALL_IN"]);
    expect(grid.querySelector(".pk-amount #amount-input")).toBeTruthy();
    // the focusable controls in document order
    const focusable = Array.from(container.querySelectorAll<HTMLElement>("#poker-action-area button, #poker-action-area input")).map((e) => e.dataset.action ?? e.id);
    expect(focusable).toEqual(["FOLD", "CALL", "amount-input", "RAISE", "ALL_IN"]);
    expect(win.document.querySelector("#poker-action-area")!.contains(input(container))).toBe(true);
  });

  it("with no amount field the buttons form one group, and a group with an odd count gives its last button the full row", async () => {
    const odd = await mount(newTable(turnState(legal({ canCall: true, callAmount: 120, maxAmount: 120 }), {}, { stack: 150, committedThisHand: 30 })));
    expect(odd.container.querySelector(".pk-amount")).toBeNull();
    expect(actions(odd.container).map((b) => [b.dataset.action, b.classList.contains("pk-wide")])).toEqual([["FOLD", false], ["CALL", false], ["ALL_IN", true]]);
    const even = await mount(newTable(turnState()));
    expect(actions(even.container).some((b) => b.classList.contains("pk-wide"))).toBe(false);
    const bet = await mount(newTable(turnState(legal({ canCheck: true, canBet: true, minRaiseTo: 10, maxAmount: 980 }))));
    expect(actionNames(bet.container)).toEqual(["FOLD", "CHECK", "BET", "ALL_IN"]);
    expect(Array.from(bet.container.querySelector(".action-bar")!.children).map((c) => (c.classList.contains("pk-amount") ? "amount" : (c as HTMLElement).dataset.action))).toEqual(["FOLD", "CHECK", "amount", "BET", "ALL_IN"]);
  });

  it("has exactly one copy of the player's cards and one set of actions anywhere in the container", async () => {
    const { container } = await mount(newTable(turnState()));
    expect(container.querySelectorAll(".hole-cards")).toHaveLength(1);
    expect(container.querySelectorAll('[aria-label="Ace of hearts"]')).toHaveLength(1);
    expect(container.querySelectorAll('[aria-label="Queen of hearts"]')).toHaveLength(1);
    expect(container.querySelectorAll("[data-action]")).toHaveLength(actions(container).length);
    expect(container.querySelectorAll("button")).toHaveLength(actions(container).length);
    expect(container.querySelectorAll("input")).toHaveLength(1);
  });

  it("the typed amount and the amount-to-Raise association survive polling and stale handling in the new grid", async () => {
    const t = newTable(turnState());
    const { container, render } = await mount(t);
    const field = input(container);
    field.value = "88";
    await render();
    t.online = false;
    await render();
    t.online = true;
    await render();
    expect(input(container)).toBe(field);
    expect(field.value).toBe("88");
    expect(field.closest(".action-bar")).toBe(container.querySelector(".action-bar"));
  });
});

// ---------------------------------------------------------------------------------------------------------------------------------
// 1c. The unified green table: one felt surface holds everything needed to act; everything else is in the panel outside it
// ---------------------------------------------------------------------------------------------------------------------------------

/** What the Founder's hierarchy requires of the rendered DOM, as a list of problems (empty = correct). Used by the tests and by the mutation controls. */
function hierarchyProblems(container: Element, expectActions = true): string[] {
  const out: string[] = [];
  const table = container.querySelector("#poker-table");
  const info = container.querySelector("#poker-info");
  if (!table || !info) return ["missing #poker-table or #poker-info"];
  if (container.querySelectorAll(".felt, .pk-table").length !== 1) out.push("not exactly one felt element");
  if (table.contains(info) || info.contains(table)) out.push("the table and the information panel are nested");
  if (!(table.compareDocumentPosition(info) & 4)) out.push("the information panel does not come after the table");
  const inside: Array<[string, string]> = [[".pk-turn", "turn indication"], [".pk-pot-value", "pot"], [".board-cards", "community cards"], [".hole-cards", "private cards"], ["#amount-input", "amount field"], ["#action-msg", "action feedback"]];
  for (const [selector, label] of inside) if (!table.querySelector(selector)) out.push(`${label} is not inside the table`);
  if (expectActions && table.querySelectorAll(".action-btn").length !== 4) out.push("the four actions are not all inside the table");
  for (const selector of [".seat-list", ".status-pill", ".pk-room", ".poker-result-card", ".pk-info"]) if (table.querySelector(selector)) out.push(`${selector} is inside the table`);
  if (container.querySelectorAll(".hole-cards").length !== 1) out.push("the private cards are duplicated");
  if (container.querySelectorAll(".action-btn").length !== (expectActions ? 4 : 0)) out.push("the action controls are duplicated");
  if (table.lastElementChild?.id !== "poker-notice") out.push("the connection notice is not the last thing in the table");
  if (table.querySelectorAll(".pk-panel, .card, .poker-result-card, .pk-info").length) out.push("a nested card or panel is inside the table");
  return out;
}

/** Rules that would turn a section INSIDE the felt into its own card (a background, a full border, rounded corners or a shadow). */
function sectionCardProblems(html: string): string[] {
  const SECTIONS = /\.pk-(sec|pot|board|hand|actionbar|turnline|potrow)\b|\.board-cards\b|\.pk-board-label\b|\.pk-pot-|\.pk-amount\b|\.hole-cards\b/;
  const cardLike = /(?:^|[; ])(background|background-color|background-image|border|border-radius|border-left|border-right|border-bottom|box-shadow|outline|backdrop-filter)\s*:/;
  return pokerRules(html).filter((r) => r.selectors.some((x) => SECTIONS.test(x)) && cardLike.test(r.decl)).map((r) => r.selectors.join(", "));
}

describe("unified green table", () => {
  const follows = (a: Element, b: Element) => Boolean(a.compareDocumentPosition(b) & 4);

  it("ONE green table root contains the turn indication, pot, community cards, the player's private cards, every action, the amount field with its hint, error and feedback", async () => {
    const { container } = await mount(newTable(turnState()));
    expect(container.querySelectorAll("#poker-table")).toHaveLength(1);
    expect(container.querySelectorAll(".pk-table")).toHaveLength(1);
    expect(container.querySelectorAll(".felt")).toHaveLength(1);
    const table = container.querySelector("#poker-table")!;
    expect(table.getAttribute("aria-label")).toBe("Poker table");
    expect(text(table, ".pk-turn")).toBe("Your turn");
    expect(text(table, ".pk-pot-value")).toBe("45");
    expect(table.querySelectorAll(".board-cards .playing-card")).toHaveLength(5);
    expect(Array.from(table.querySelectorAll('[aria-label="Your cards"] .playing-card')).map((c) => c.getAttribute("aria-label"))).toEqual(["Ace of hearts", "Queen of hearts"]);
    expect(Array.from(table.querySelectorAll<HTMLElement>(".action-btn")).map((b) => b.dataset.action)).toEqual(["FOLD", "CALL", "RAISE", "ALL_IN"]);
    for (const id of ["#amount-input", "#amount-help", "#amount-error", "#action-msg", "#poker-notice"]) expect(table.querySelector(id), id).toBeTruthy();
    // and nothing that belongs to the table is anywhere else
    expect(container.querySelectorAll(".action-btn")).toHaveLength(4);
    expect(container.querySelectorAll(".hole-cards")).toHaveLength(1);
    expect(container.querySelectorAll(".board-cards")).toHaveLength(1);
    expect(container.querySelectorAll(".pk-turn")).toHaveLength(1);
    expect(hierarchyProblems(container)).toEqual([]);
  });

  it("the players, their stacks and statuses, the room code, hand number and street are OUTSIDE the table, in the information panel below it", async () => {
    const { container } = await mount(newTable(turnState()));
    const table = container.querySelector("#poker-table")!;
    const info = container.querySelector("#poker-info")!;
    expect(table.contains(info)).toBe(false);
    expect(info.contains(table)).toBe(false);
    expect(follows(table, info)).toBe(true);
    for (const selector of [".seat-list", ".seat-row", ".seat-badge", ".status-pill", ".pk-room", ".pk-street", ".poker-result-card", ".pk-info"]) {
      expect(table.querySelector(selector), `${selector} must not be inside the table`).toBeNull();
    }
    expect(Array.from(info.querySelectorAll(".seat-name")).map(ownText)).toEqual(["Maya (you)", "Sam", "Alex", "Jordan"]);
    expect(Array.from(info.querySelectorAll(".status-pill")).map((e) => e.textContent)).toEqual(["Room ABC234", "Hand 4", "Pre-flop"]);
    expect(text(info, ".pk-street-note")).toBe("No community cards yet");
    expect(info.querySelector('[aria-label="Room details"]')).toBeTruthy();
    expect(info.querySelector('[aria-label="Players"]')).toBeTruthy();
    expect(info.querySelector(".pk-turn, .action-btn, input, .hole-cards, .board-cards")).toBeNull();
  });

  it("the table reads as one surface: sections told apart by labels, not nested cards or panels", async () => {
    const { container } = await mount(newTable(turnState()));
    const table = container.querySelector("#poker-table")!;
    expect(table.querySelectorAll(".pk-panel, .card, .poker-result-card, .pk-info")).toHaveLength(0);
    expect(table.querySelectorAll(".pk-sec").length).toBeGreaterThanOrEqual(3);
    for (const section of Array.from(table.querySelectorAll(".pk-sec"))) expect(section.parentElement).toBe(table.querySelector("#poker-chrome"));
    const labels = Array.from(table.querySelectorAll(".pk-title, .pk-board-label, .pk-pot-label, .pk-turnline .street-label")).map((e) => (e.textContent ?? "").replace(/\s+/g, " ").trim());
    for (const wanted of [/^Pot$/, /^Community cards/, /^Your cards/, /^Choose an action$/]) expect(labels.some((l) => wanted.test(l)), String(wanted)).toBe(true);
    // and the CSS does not turn those sections into cards either: no background, full border, rounded corners or shadow of their own
    expect(sectionCardProblems(PARTICIPANT_HTML)).toEqual([]);
    expect(sectionCardProblems(POKER_TABLE_HTML)).toEqual([]);
  });

  it("the turn indication is inside the table in every state, and the information panel never carries one", async () => {
    const seats = [seat(0, "Maya"), seat(1, "Sam")];
    const idle = state({ currentHandId: null, currentHandOrdinal: null, street: null, board: [], pot: 0, myHoleCards: null, seats });
    const cases: Array<[string, unknown, string]> = [
      ["your turn", turnState(), "Your turn"],
      ["waiting for someone", waitingState(), "Waiting for Sam to act"],
      ["no hand", idle, "Waiting for the host to deal."],
      ["showdown", showdownState(["Maya", "Sam", "Alex", "Jordan"], SAM_WINS), "Hand complete. Waiting for the host to deal the next hand."],
      ["closed", showdownState(["Maya", "Sam", "Alex", "Jordan"], SAM_WINS, undefined, { closedAt: "2026-11-05T21:10:00.000Z" }), "This table has ended. Thanks for playing."],
    ];
    for (const [label, s, expected] of cases) {
      const { container } = await mount(newTable(s));
      expect(text(container.querySelector("#poker-table")!, ".pk-turn"), label).toBe(expected);
      expect(container.querySelector("#poker-info .pk-turn"), label).toBeNull();
    }
  });

  it("when no action is available the table offers none: waiting, folded, all-in, joined mid-hand, showdown, closed", async () => {
    const folded = waitingState(["Maya", "Sam", "Alex"], { seats: [seat(0, "Maya", { folded: true, committedThisHand: 20 }), seat(1, "Sam", { isCurrentActor: true }), seat(2, "Alex")] });
    const allIn = waitingState(["Maya", "Sam", "Alex"], { seats: [seat(0, "Maya", { allIn: true, committedThisHand: 1000 }), seat(1, "Sam", { isCurrentActor: true }), seat(2, "Alex")] });
    const joiner = waitingState(["Maya", "Sam", "Alex"], { myHoleCards: null, seats: [seat(0, "Maya", { inCurrentHand: false }), seat(1, "Sam", { isCurrentActor: true }), seat(2, "Alex")] });
    for (const s of [waitingState(), folded, allIn, joiner, showdownState(["Maya", "Sam", "Alex", "Jordan"], SAM_WINS), showdownState(["Maya", "Sam", "Alex", "Jordan"], SAM_WINS, undefined, { closedAt: "x" })]) {
      const { container } = await mount(newTable(s));
      const table = container.querySelector("#poker-table")!;
      expect(table.querySelectorAll("button, input")).toHaveLength(0);
      expect(container.querySelector("#poker-action-area")!.innerHTML).toBe("");
    }
  });

  it("the hand result, when there is one, is outside the green table, in the information area", async () => {
    const { container } = await mount(newTable(showdownState(["Maya", "Sam", "Alex", "Jordan"], SAM_WINS)));
    const table = container.querySelector("#poker-table")!;
    const info = container.querySelector("#poker-info")!;
    expect(table.querySelector(".poker-result-card")).toBeNull();
    expect(info.querySelector(".poker-result-card")).toBeTruthy();
    expect(follows(table, info.querySelector(".poker-result-card")!)).toBe(true);
    // the table keeps the final pot, the board and the player's own (now revealed) cards
    expect(text(table, ".pk-pot-label")).toBe("Final pot");
    expect(table.querySelectorAll(".board-cards .playing-card:not(.slot)")).toHaveLength(5);
    expect(table.querySelector(".hole-cards")).toBeTruthy();
  });

  it("the connection warning stays inside the table: the tag is out of the pot row's flow, one line under the controls says why, the full notice is last, and nothing above or among the controls moves", async () => {
    const t = newTable(turnState());
    const { container, render } = await mount(t);
    const table = container.querySelector("#poker-table")!;
    const chrome = container.querySelector("#poker-chrome")!;
    const area = container.querySelector("#poker-action-area")!;
    const field = input(container);
    field.value = "77";
    const chromeBefore = chrome.innerHTML;
    // every control in the action area (everything except the message line), without the disabled flag
    const controls = () => Array.from(area.querySelectorAll(".pk-actionbar > :not(#action-msg)")).map((e) => e.outerHTML.replace(/ disabled=""/g, "")).join("");
    const controlsBefore = controls();
    expect(controlsBefore).toContain('id="amount-input"');
    t.online = false;
    await render();
    const notice = container.querySelector<HTMLElement>("#poker-notice")!;
    expect(notice.hidden).toBe(false);
    expect(table.contains(notice)).toBe(true);
    expect(table.lastElementChild).toBe(notice);
    expect(follows(area, notice)).toBe(true);
    expect(container.querySelector("#poker-info #poker-notice")).toBeNull();
    // the chrome (turn, pot, community cards, your cards) is exactly as it was, plus one small tag that is a direct child of the chrome:
    // not in the pot row, where a long pot on a narrow phone could push it onto a line of its own
    expect(chrome.innerHTML.replace('<span class="pk-stale-tag">Out of date</span>', "")).toBe(chromeBefore);
    const tag = chrome.querySelector(".pk-stale-tag")!;
    expect(tag.parentElement).toBe(chrome);
    expect(container.querySelector(".pk-potrow .pk-stale-tag")).toBeNull();
    // the controls are the same markup, merely disabled; the one-line reminder is the LAST thing in the action area, below them
    expect(controls()).toBe(controlsBefore);
    expect(actions(container).every((b) => b.disabled)).toBe(true);
    const msg = container.querySelector("#action-msg")!;
    expect(msg.textContent).toBe("Actions are paused until the table refreshes.");
    expect(area.querySelector(".pk-actionbar")!.lastElementChild).toBe(msg);
    expect(input(container)).toBe(field);
    expect(field.value).toBe("77");
    // recovery removes all three, again without touching the field
    t.online = true;
    await render();
    expect(container.querySelector<HTMLElement>("#poker-notice")!.hidden).toBe(true);
    expect(container.querySelector(".pk-stale-tag")).toBeNull();
    expect(container.querySelector("#action-msg")!.textContent).toBe("");
    expect(input(container)).toBe(field);
  });

  it("the connection warning also appears inside the table when there are no controls, and on a first load that failed", async () => {
    const t = newTable(waitingState());
    const { container, render } = await mount(t);
    t.online = false;
    await render();
    expect(container.querySelector("#poker-table #poker-notice:not([hidden])")).toBeTruthy();
    const first = newTable(turnState());
    first.getReply = { status: 500, json: { error: "Server error." } };
    const failed = await mount(first);
    expect(failed.container.querySelector("#poker-table #poker-notice:not([hidden])")).toBeTruthy();
    expect(failed.container.querySelector("#poker-table .pk-turn")).toBeNull(); // nothing to show yet
  });

  it("the felt is the green panel only: no green on the page, the root, or the information panel", () => {
    for (const html of [PARTICIPANT_HTML, POKER_TABLE_HTML]) {
      const rules = pokerRules(html);
      // only USES of the green are considered (the tokens are defined on .pk-root); ink/divider/shade are text, hairline and darkening
      const GREEN = /var\(--pk-felt\)|var\(--pk-felt-deep\)|var\(--pk-felt-line\)|radial-gradient/;
      const greenRules = rules.filter((r) => GREEN.test(r.decl));
      expect(greenRules.length).toBeGreaterThan(0);
      for (const r of greenRules) expect(r.selectors, r.decl).toEqual([".pk-root .pk-table"]);
      const rootDecl = rules.find((r) => r.selectors.includes(".pk-root"))!.decl;
      expect(rootDecl).not.toMatch(/background/);
      expect(rules.some((r) => r.selectors.some((x) => /^(body|html|:root)/.test(x)))).toBe(false);
      const info = rules.filter((r) => r.selectors.some((x) => /\.pk-info|\.pk-panel|\.pk-room/.test(x)));
      for (const r of info) expect(r.decl).not.toMatch(GREEN);
    }
  });
});

// ---------------------------------------------------------------------------------------------------------------------------------
// 2. Amount entry
// ---------------------------------------------------------------------------------------------------------------------------------

describe("amount entry", () => {
  it.each<[string, number]>([["50", 50], ["0050", 50], ["500", 500], ["1000", 1000]])("accepts the complete whole number %s and sends %i", async (typed, sent) => {
    const { container, calls } = await mount(newTable(turnState()));
    input(container).value = typed;
    container.querySelector<HTMLButtonElement>('[data-action="RAISE"]')!.click();
    await until(() => posts(calls).length === 1, "Raise request");
    expect(posts(calls)[0].body).toMatchObject({ actionType: "RAISE", amount: sent });
  });

  it.each<[string, string]>([
    ["", "Enter a whole number."],
    ["4.5", "Enter a whole number."],
    ["50.0", "Enter a whole number."],
    ["1e2", "Enter a whole number."],
    ["-60", "Enter a whole number."],
    ["49", "The minimum is 50."],
    ["0", "The minimum is 50."],
    ["1001", "The most you can raise to is 1,000 (all-in)."],
    ["9007199254740993", "The most you can raise to is 1,000 (all-in)."],
  ])("refuses %j with a reason, sends nothing, and leaves what was typed alone", async (typed, message) => {
    const { container, calls } = await mount(newTable(turnState()));
    const field = input(container);
    field.value = typed;
    container.querySelector<HTMLButtonElement>('[data-action="RAISE"]')!.click();
    await tick();
    expect(posts(calls)).toHaveLength(0);
    expect(text(container, "#amount-error")).toBe(message);
    expect(field.getAttribute("aria-invalid")).toBe("true");
    expect(field.value).toBe(typed);
    expect(container.ownerDocument.activeElement).toBe(field);
  });

  it("treats text a number field cannot hold as 'not a number' rather than guessing (parseInt would have read '60abc' as 60)", async () => {
    const { container, calls } = await mount(newTable(turnState()));
    input(container).value = "60abc"; // a number input sanitizes this to ""
    container.querySelector<HTMLButtonElement>('[data-action="RAISE"]')!.click();
    await tick();
    expect(posts(calls)).toHaveLength(0);
    expect(text(container, "#amount-error")).toBe("Enter a whole number.");
  });

  it("Enter in the field validates exactly like the button", async () => {
    const { win, container, calls } = await mount(newTable(turnState()));
    const press = () => input(container).dispatchEvent(new win.KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
    input(container).value = "4.5";
    press();
    await tick();
    expect(posts(calls)).toHaveLength(0);
    input(container).value = "75";
    press();
    await until(() => posts(calls).length === 1, "Enter submit");
    expect(posts(calls)[0].body).toMatchObject({ actionType: "RAISE", amount: 75 });
  });

  it("Bet uses the server's own minimum, and the field starts at it", async () => {
    const { container, calls } = await mount(newTable(turnState(legal({ canCheck: true, canBet: true, minRaiseTo: 10, maxAmount: 980 }))));
    expect(input(container).value).toBe("10");
    expect(input(container).min).toBe("10");
    expect(input(container).max).toBe("980");
    input(container).value = "9";
    container.querySelector<HTMLButtonElement>('[data-action="BET"]')!.click();
    await tick();
    expect(posts(calls)).toHaveLength(0);
    expect(text(container, "#amount-error")).toBe("The minimum is 10.");
  });

  it("explains a valid raise-to amount as a total (and how many more chips it is), and an invalid one by its reason, while typing", async () => {
    const { win, container } = await mount(newTable(turnState()));
    const field = input(container);
    field.value = "120";
    field.dispatchEvent(new win.Event("input", { bubbles: true }));
    expect(text(container, "#amount-help")).toContain("Your total bet this round would be 120 (115 more chips).");
    expect(container.querySelector("#amount-error")!.hasAttribute("hidden")).toBe(true);
    field.value = "7";
    field.dispatchEvent(new win.Event("input", { bubbles: true }));
    expect(field.getAttribute("aria-invalid")).toBe("true");
    expect(text(container, "#amount-error")).toBe("The minimum is 50.");
    expect(field.value).toBe("7");
  });

  it("the amount error is an alert region, written only when its text changes, and announced afresh when the player submits again", async () => {
    const { win, container } = await mount(newTable(turnState()));
    const err = container.querySelector<HTMLElement>("#amount-error")!;
    expect(err.getAttribute("role")).toBe("alert");
    const field = input(container);
    field.value = "7";
    field.dispatchEvent(new win.Event("input", { bubbles: true }));
    expect(err.textContent).toBe("The minimum is 50.");
    const written = err.firstChild;
    field.value = "8"; // the same message again: typing must not rewrite (and so re-announce) it
    field.dispatchEvent(new win.Event("input", { bubbles: true }));
    expect(err.firstChild).toBe(written);
    // Enter with the same bad value: the region is cleared, then written again, so it is announced although focus does not move
    field.dispatchEvent(new win.KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
    expect(err.textContent).toBe("");
    await new Promise((r) => setTimeout(r, 150));
    expect(err.textContent).toBe("The minimum is 50.");
    expect(err.hidden).toBe(false);
    // a valid value clears and hides it
    field.value = "60";
    field.dispatchEvent(new win.Event("input", { bubbles: true }));
    expect(err.hidden).toBe(true);
    expect(err.textContent).toBe("");
  });

  it("the amount field is labelled and described for assistive technology", async () => {
    const { container } = await mount(newTable(turnState()));
    const field = input(container);
    const label = container.querySelector<HTMLLabelElement>(`label[for="${field.id}"]`)!;
    expect(label.textContent).toBe("Raise to");
    expect(field.getAttribute("aria-describedby")).toBe("amount-help amount-error");
    expect(container.querySelector("#amount-help")).toBeTruthy();
    expect(container.querySelector("#amount-error")).toBeTruthy();
    expect(field.getAttribute("inputmode")).toBe("numeric");
  });
});

// ---------------------------------------------------------------------------------------------------------------------------------
// 3. Polling: the typed amount survives the real poller
// ---------------------------------------------------------------------------------------------------------------------------------

describe("real polling", () => {
  it("keeps the same field, its value and its focus across many ticks of the shared poller", async () => {
    const { win, container, calls } = await mount(newTable(turnState()));
    const field = input(container);
    field.value = "77";
    field.focus();
    win.eval(SESSION_SYNC_JS); // the real shared polling factory, exactly as /sessionSync.js defines it
    const poller = win.createSessionSync(() => win.PokerParticipant.renderPokerTable(container, SEAT), 15);
    poller.start();
    const before = calls.filter((c) => c.method === "GET").length;
    await until(() => calls.filter((c) => c.method === "GET").length >= before + 4, "four poll ticks");
    poller.stop();
    expect(input(container)).toBe(field);
    expect(field.value).toBe("77");
    expect(win.document.activeElement).toBe(field);
  });

  it("the chrome refreshes while the field is left alone (a new pot appears, the typed value stays)", async () => {
    const t = newTable(turnState());
    const { container, render } = await mount(t);
    input(container).value = "88";
    t.state = turnState(FACING, { pot: 46 });
    await render();
    expect(text(container, ".pk-pot-value")).toBe("46");
    expect(input(container).value).toBe("88");
  });

  it("a different hand with an identical decision starts with a fresh field", async () => {
    const t = newTable(turnState());
    const { container, render } = await mount(t);
    input(container).value = "88";
    const old = input(container);
    t.state = turnState(FACING, { currentHandId: "another-hand" });
    await render();
    expect(input(container)).not.toBe(old);
    expect(input(container).value).toBe("50");
  });

  it("a response that arrives late can never overwrite a newer one", async () => {
    const pending: Array<(r: Reply) => void> = [];
    const t = newTable(turnState());
    const { container, render } = await mount(t);
    t.get = () => new Promise<Reply>((resolve) => pending.push(resolve));
    const first = render();
    const second = render();
    await tick();
    pending[1]({ status: 200, json: turnState(FACING, { pot: 99 }) });
    await second;
    pending[0]({ status: 200, json: turnState(FACING, { pot: 45 }) });
    await first;
    expect(text(container, ".pk-pot-value")).toBe("99");
  });

  it("a response that arrives after the page left the table draws nothing", async () => {
    const pending: Array<(r: Reply) => void> = [];
    const t = newTable(turnState());
    const { container, render } = await mount(t);
    t.get = () => new Promise<Reply>((resolve) => pending.push(resolve));
    const late = render();
    container.innerHTML = ""; // the page clears the container (e.g. "Join a different room") while the request is in flight
    pending[0]({ status: 200, json: turnState() });
    await late;
    expect(container.innerHTML).toBe("");
  });

  it.each<[string, Reply]>([["accepted", { status: 200, json: {} }], ["refused", { status: 409, json: { error: "It is not your turn." } }]])("an action answered after the page left the table (%s) draws nothing and asks for nothing", async (_label, reply) => {
    const r = await leaveWhileActionInFlight(POKER_JS, reply, false);
    expect(r.container.innerHTML).toBe("");
    expect(r.getsAfter).toBe(r.getsBefore);
  });

  it("an action answered after the page moved on to another table leaves that table alone", async () => {
    const r = await leaveWhileActionInFlight(POKER_JS, { status: 200, json: {} }, true);
    expect(r.getsAfter).toBe(r.getsBefore); // the late answer fetched nothing
    expect(actions(r.container).every((b) => !b.disabled)).toBe(true);
    expect(text(r.container, "#action-msg")).toBe("");
    expect(hierarchyProblems(r.container)).toEqual([]);
  });
});

/** Tap Call, hold the POST, clear the container (the page leaves the table), then let the POST answer. */
async function leaveWhileActionInFlight(source: string, reply: Reply, rejoin: boolean) {
  const t = newTable(turnState());
  const { win, container, calls } = await mountWith(source, t);
  let release!: (r: Reply) => void;
  t.post = () => new Promise<Reply>((resolve) => { release = resolve; });
  container.querySelector<HTMLButtonElement>('[data-action="CALL"]')!.click();
  await tick();
  expect(posts(calls)).toHaveLength(1);
  container.innerHTML = ""; // "Join a different room" while the action is in flight
  if (rejoin) await win.PokerParticipant.renderPokerTable(container, SEAT); // and a table is rendered again before the answer arrives
  const getsBefore = calls.filter((c) => c.method === "GET").length;
  release(reply);
  await tick();
  await tick();
  return { container, getsBefore, getsAfter: calls.filter((c) => c.method === "GET").length };
}

/** Press Enter twice in the amount field while the first request is still pending; how many requests went out? */
async function postsAfterTwoEnters(source: string) {
  const t = newTable(turnState());
  const dom = new JSDOM('<!doctype html><html><body><div id="c"></div></body></html>', { url: "http://localhost/participant.html", runScripts: "outside-only", pretendToBeVisual: true, virtualConsole: quiet() });
  windows.push(dom.window);
  const win = dom.window as any;
  const calls = installFetch(win, t);
  win.eval(source);
  const container = win.document.getElementById("c") as HTMLElement;
  await win.PokerParticipant.renderPokerTable(container, SEAT);
  let release!: (r: Reply) => void;
  t.post = () => new Promise<Reply>((resolve) => { release = resolve; });
  input(container).value = "75";
  const press = () => input(container).dispatchEvent(new win.KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
  press();
  await tick();
  press();
  press();
  await tick();
  const count = posts(calls).length;
  release({ status: 200, json: {} });
  await tick();
  return { count };
}

// ---------------------------------------------------------------------------------------------------------------------------------
// 4. A failed poll: the table and the input stay, actions are blocked, nothing is replayed, and recovery is safe
// ---------------------------------------------------------------------------------------------------------------------------------

describe("poll failure", () => {
  it("keeps the table and the typed amount, labels it as out of date, and blocks every consequential action", async () => {
    const t = newTable(turnState());
    const { win, container, calls, render } = await mount(t);
    const field = input(container);
    field.value = "77";
    t.online = false;
    await render();

    expect(text(container, ".pk-pot-value")).toBe("45"); // the last table is still on screen
    expect(input(container)).toBe(field);
    expect(field.value).toBe("77");
    const notice = container.querySelector<HTMLElement>("#poker-notice")!;
    expect(notice.hidden).toBe(false);
    expect(notice.getAttribute("role")).toBe("alert");
    expect(notice.textContent).toContain("This table may be out of date");
    expect(notice.textContent).toMatch(/as of \d/);
    expect(notice.textContent).toContain("Actions are paused");
    expect(actions(container).every((b) => b.disabled)).toBe(true);
    expect(text(container, ".pk-stale-tag")).toBe("Out of date");

    // clicking a disabled button, or pressing Enter in the field, makes no request
    actions(container).forEach((b) => b.click());
    input(container).dispatchEvent(new win.KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
    await tick();
    expect(posts(calls)).toHaveLength(0);
    expect(text(container, "#action-msg")).toBe("Actions are paused until the table refreshes.");
  });

  it("never replays anything by itself, and recovers on the next successful poll with the same field and value", async () => {
    const t = newTable(turnState());
    const { container, calls, render } = await mount(t);
    const field = input(container);
    field.value = "77";
    t.online = false;
    await render();
    await render();
    expect(posts(calls)).toHaveLength(0);

    t.online = true;
    await render();
    expect(posts(calls)).toHaveLength(0);
    expect(container.querySelector<HTMLElement>("#poker-notice")!.hidden).toBe(true);
    expect(container.querySelector("#poker-notice")!.textContent).toBe("");
    expect(actions(container).every((b) => !b.disabled)).toBe(true);
    expect(container.querySelector(".pk-stale-tag")).toBeNull();
    expect(input(container)).toBe(field);
    expect(field.value).toBe("77");

    container.querySelector<HTMLButtonElement>('[data-action="RAISE"]')!.click();
    await until(() => posts(calls).length === 1, "Raise after recovery");
    expect(posts(calls)[0].body).toMatchObject({ actionType: "RAISE", amount: 77 });
  });

  it("if the decision changed while the connection was down, recovery rebuilds the actions for the new decision", async () => {
    const t = newTable(turnState());
    const { container, render } = await mount(t);
    input(container).value = "77";
    t.online = false;
    await render();
    t.online = true;
    t.state = waitingState();
    await render();
    expect(container.querySelector("#poker-action-area")!.innerHTML).toBe("");
    expect(container.querySelector<HTMLElement>("#poker-notice")!.hidden).toBe(true);
  });

  describe("the reminder line under the controls", () => {
    const PAUSED = "Actions are paused until the table refreshes.";
    const msg = (container: Element) => text(container, "#action-msg");

    it("appears while the table is out of date, and is taken back when it refreshes", async () => {
      const t = newTable(turnState());
      const { container, render } = await mount(t);
      expect(msg(container)).toBe("");
      t.online = false;
      await render();
      expect(msg(container)).toBe(PAUSED);
      expect(container.querySelector("#action-msg")!.className).toBe("msg error");
      await render();
      expect(msg(container)).toBe(PAUSED);
      t.online = true;
      await render();
      expect(msg(container)).toBe("");
      expect(container.querySelector("#action-msg")!.className).toBe("msg");
    });

    it("never replaces the failure message of an earlier action (not by the poll, not by a press of Enter), and does not take that message back either", async () => {
      const t = newTable(turnState());
      const { win, container, calls, render } = await mount(t);
      t.post = async () => ({ status: 409, json: { error: "It is not your turn." } });
      container.querySelector<HTMLButtonElement>('[data-action="CALL"]')!.click();
      await until(() => msg(container) === "It is not your turn.", "the refusal");
      t.online = false;
      await render();
      expect(msg(container)).toBe("It is not your turn.");
      input(container).dispatchEvent(new win.KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
      await tick();
      expect(msg(container)).toBe("It is not your turn."); // Enter while out of date sends nothing and keeps the earlier message
      expect(posts(calls)).toHaveLength(1);
      t.online = true;
      await render();
      expect(msg(container)).toBe("It is not your turn.");
    });

    it("pressing Enter while out of date sends nothing and leaves the reminder in place, which recovery then takes back", async () => {
      const t = newTable(turnState());
      const { win, container, calls, render } = await mount(t);
      t.online = false;
      await render();
      input(container).dispatchEvent(new win.KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
      await tick();
      expect(posts(calls)).toHaveLength(0);
      expect(msg(container)).toBe("Actions are paused until the table refreshes.");
      t.online = true;
      await render();
      expect(msg(container)).toBe("");
    });

    it("an accepted action whose refresh then fails no longer says 'Sending…': it says the table is out of date, and clears when it refreshes", async () => {
      const t = newTable(turnState());
      const { container, calls, render } = await mount(t);
      t.post = async () => {
        t.get = () => Promise.reject(new TypeError("offline")); // the connection drops right after the action was accepted
        return { status: 200, json: { pokerHandId: HAND_ID, alreadyApplied: false } };
      };
      container.querySelector<HTMLButtonElement>('[data-action="CALL"]')!.click();
      await until(() => msg(container) === PAUSED, "the out-of-date line");
      expect(text(container, "#action-msg")).not.toContain("Sending");
      expect(actions(container).every((b) => b.disabled)).toBe(true);
      expect(posts(calls)).toHaveLength(1);
      t.get = undefined;
      await render();
      expect(msg(container)).toBe("");
      expect(actions(container).every((b) => !b.disabled)).toBe(true);
    });

    it("an accepted action whose refresh succeeds with the same decision on screen no longer says 'Sending…'", async () => {
      const t = newTable(turnState());
      const { container, calls } = await mount(t);
      container.querySelector<HTMLButtonElement>('[data-action="CALL"]')!.click();
      await until(() => posts(calls).length === 1 && !actions(container)[0].disabled, "the action to finish");
      expect(msg(container)).toBe("");
    });

    it("an answer to an earlier action does not release the in-flight lock of an action on a newer table in the same container", async () => {
      const run = async (source: string) => {
        const t = newTable(turnState());
        const { win, container, calls } = await mountWith(source, t);
        const release: Array<(r: Reply) => void> = [];
        t.post = () => new Promise<Reply>((resolve) => release.push(resolve));
        container.querySelector<HTMLButtonElement>('[data-action="CALL"]')!.click(); // action A, held
        await tick();
        container.innerHTML = ""; // the page leaves the table...
        await win.PokerParticipant.renderPokerTable(container, SEAT); // ...and a table is rendered again
        container.querySelector<HTMLButtonElement>('[data-action="CALL"]')!.click(); // action B on the new table, held
        await tick();
        expect(posts(calls)).toHaveLength(2);
        release[0]({ status: 200, json: {} }); // A is answered late
        await tick();
        await tick();
        // B is still in flight, so Enter in the amount field (which bypasses the disabled buttons) must send nothing more
        input(container).dispatchEvent(new win.KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
        await tick();
        return { postsSent: posts(calls).length };
      };
      expect(await run(POKER_JS)).toEqual({ postsSent: 2 });
      const releasing = unsafeCopy(POKER_JS, "if (!container.contains(actionAreaEl)) return;", "if (!container.contains(actionAreaEl)) { ctx.busy = false; return; }");
      expect((await run(releasing)).postsSent).toBe(3);
    });

    it("the single-tag guard: repeated failed polls leave exactly one 'Out of date' tag", async () => {
      const count = async (source: string) => {
        const t = newTable(turnState());
        const { win, container } = await mountWith(source, t);
        t.online = false;
        for (let i = 0; i < 3; i++) await win.PokerParticipant.renderPokerTable(container, SEAT);
        return container.querySelectorAll(".pk-stale-tag").length;
      };
      expect(await count(POKER_JS)).toBe(1);
      expect(await count(unsafeCopy(POKER_JS, 'if (!chrome.querySelector(".pk-stale-tag")) {', "if (true) {"))).toBe(3);
    });

    it("without the guard on the answer, an action answered after leaving the table redraws it (the check above is what catches that)", async () => {
      const unsafe = unsafeCopy(POKER_JS, "if (!container.contains(actionAreaEl)) return;", "if (false) return;");
      const r = await leaveWhileActionInFlight(unsafe, { status: 200, json: {} }, false);
      expect(r.getsAfter).toBeGreaterThan(r.getsBefore);
      expect(r.container.innerHTML).not.toBe("");
    });
  });

  it.each<[number, string]>([[403, "Not a member of this table."], [404, "Table not found."], [500, "Server error."]])("an HTTP %i is handled the same way, and the server's message is shown as text", async (status, error) => {
    const t = newTable(turnState());
    const { container, render } = await mount(t);
    t.getReply = { status, json: { error } };
    await render();
    expect(text(container, ".pk-pot-value")).toBe("45");
    expect(actions(container).every((b) => b.disabled)).toBe(true);
    expect(container.querySelector("#poker-notice")!.textContent).toContain(`The server said: ${error}`);
  });

  it("a first load that fails shows why, with nothing else to preserve", async () => {
    const t = newTable(turnState());
    t.getReply = { status: 404, json: { error: "Table not found." } };
    const { container } = await mount(t);
    expect(container.querySelector<HTMLElement>("#poker-notice")!.hidden).toBe(false);
    expect(text(container, "#poker-notice")).toContain("Couldn't load the table.");
    expect(text(container, "#poker-notice")).toContain("Table not found.");
    expect(container.querySelector("#poker-chrome")!.innerHTML).toBe("");
  });

  it("an action in flight blocks a second tap; a failed action re-enables the buttons and says why", async () => {
    const t = newTable(turnState());
    const { container, calls } = await mount(t);
    let release!: (r: Reply) => void;
    t.post = () => new Promise<Reply>((resolve) => { release = resolve; });
    const call = container.querySelector<HTMLButtonElement>('[data-action="CALL"]')!;
    call.click();
    await tick();
    expect(actions(container).every((b) => b.disabled)).toBe(true);
    call.click();
    container.querySelector<HTMLButtonElement>('[data-action="FOLD"]')!.click();
    await tick();
    expect(posts(calls)).toHaveLength(1);
    release({ status: 409, json: { error: "It is not your turn." } });
    await until(() => !actions(container)[0].disabled, "buttons re-enabled");
    expect(text(container, "#action-msg")).toBe("It is not your turn.");
  });

  it("pressing Enter again while an action is in flight sends nothing more", async () => {
    expect((await postsAfterTwoEnters(POKER_JS)).count).toBe(1);
  });

  it("a request that never reached the server says the action may not have arrived (and is not retried)", async () => {
    const t = newTable(turnState());
    const { container, calls } = await mount(t);
    t.post = () => Promise.reject(new TypeError("offline"));
    container.querySelector<HTMLButtonElement>('[data-action="CALL"]')!.click();
    await until(() => text(container, "#action-msg").includes("may not have been received"), "offline action message");
    expect(posts(calls)).toHaveLength(1);
    expect(actions(container).every((b) => !b.disabled)).toBe(true);
  });
});

// ---------------------------------------------------------------------------------------------------------------------------------
// 5. What is shown, in each state
// ---------------------------------------------------------------------------------------------------------------------------------

describe("table content", () => {
  it("keeps the community cards and the player's private cards in separate, labelled areas", async () => {
    const { container } = await mount(newTable(turnState(FACING, { street: "FLOP", board: ["AS", "KD", "7C"] })));
    const board = container.querySelector<HTMLElement>('.board-cards')!;
    const hand = container.querySelector<HTMLElement>('[aria-label="Your cards"]')!;
    expect(board.getAttribute("aria-label")).toBe("Community cards: Ace of spades, King of diamonds, Seven of clubs");
    expect(board.querySelectorAll(".playing-card:not(.slot)")).toHaveLength(3);
    expect(board.querySelectorAll(".playing-card.slot")).toHaveLength(2);
    expect(Array.from(hand.querySelectorAll("[aria-label]")).map((e) => e.getAttribute("aria-label"))).toEqual(["Ace of hearts", "Queen of hearts"]);
    expect(hand.contains(board)).toBe(false);
    expect(board.contains(hand)).toBe(false);
    expect(allText(container)).toContain("Only you can see these");
    expect(text(container, ".pk-board-label")).toBe("Community cards 3 of 5");
  });

  it("suits are written as symbols (not colour alone) and a Ten reads as 10", async () => {
    const { container } = await mount(newTable(turnState(FACING, { myHoleCards: ["TD", "2C"], street: "FLOP", board: ["TS", "3H", "JC"] })));
    expect(Array.from(container.querySelectorAll(".pk-hand .playing-card")).map((c) => c.textContent)).toEqual(["10♦", "2♣"]);
    expect(Array.from(container.querySelectorAll(".board-cards .playing-card:not(.slot)")).map((c) => c.textContent)).toEqual(["10♠", "3♥", "J♣"]);
    expect(container.querySelector(".pk-hand .playing-card")!.classList.contains("red")).toBe(true);
  });

  it.each<[string, string, string[]]>([
    ["PRE_FLOP", "Pre-flop", []],
    ["FLOP", "Flop", ["AS", "KD", "7C"]],
    ["TURN", "Turn", ["AS", "KD", "7C", "2H"]],
    ["RIVER", "River", FULL_BOARD],
  ])("shows %s as a plain label with the matching number of board cards", async (street, label, board) => {
    const { container } = await mount(newTable(waitingState(["Maya", "Sam", "Alex"], { street, board })));
    expect(text(container, ".pk-street")).toBe(label);
    expect(text(container, ".pk-board-label")).toBe(`Community cards ${board.length} of 5`);
  });

  it("whose turn it is: yours (stated in text at the top and in the action panel), someone's, folded, all-in, mid-hand joiner", async () => {
    const mine = await mount(newTable(turnState()));
    expect(text(mine.container, ".pk-turn")).toBe("Your turn");
    expect(mine.container.querySelector(".pk-turn")!.classList.contains("is-mine")).toBe(true);
    expect(text(mine.container, ".pk-actionbar .street-label")).toBe("Choose an action");
    expect(text(mine.container, "#poker-live")).toBe("Your turn");
    expect(text(mine.container, ".seat-row.is-turn .seat-badge.turn")).toBe("Acting");

    const waiting = await mount(newTable(waitingState()));
    expect(text(waiting.container, ".pk-turn")).toBe("Waiting for Sam to act");
    expect(text(waiting.container, ".seat-row.is-turn .seat-name")).toBe("Sam");
    expect(waiting.container.querySelector("#poker-action-area")!.innerHTML).toBe("");

    const folded = await mount(newTable(waitingState(["Maya", "Sam", "Alex"], { seats: [seat(0, "Maya", { folded: true, committedThisHand: 20 }), seat(1, "Sam", { isCurrentActor: true }), seat(2, "Alex")] })));
    expect(text(folded.container, ".pk-turn")).toBe("You folded. Waiting for Sam to act");
    expect(text(folded.container, ".pk-hand .seat-badge")).toBe("Folded");

    const allIn = await mount(newTable(waitingState(["Maya", "Sam", "Alex"], { seats: [seat(0, "Maya", { allIn: true, committedThisHand: 1000 }), seat(1, "Sam", { isCurrentActor: true }), seat(2, "Alex")] })));
    expect(text(allIn.container, ".pk-turn")).toBe("You're all-in. Waiting for Sam to act");

    const joiner = await mount(newTable(waitingState(["Maya", "Sam", "Alex"], { myHoleCards: null, seats: [seat(0, "Maya", { inCurrentHand: false }), seat(1, "Sam", { isCurrentActor: true }), seat(2, "Alex")] })));
    expect(text(joiner.container, ".pk-turn")).toBe("You'll join the next hand.");
    expect(joiner.container.querySelector(".pk-hand")).toBeNull();
    expect(text(joiner.container, ".seat-row.is-me .seat-badge.wait")).toBe("Joins next hand");
  });

  it("at SHOWDOWN there is no acting-player instruction and no Acting badge, even if a stale actor flag is present", async () => {
    const seats = [seat(0, "Maya", { committedThisHand: 120 }), seat(1, "Sam", { isCurrentActor: true, committedThisHand: 120 }), seat(2, "Alex", { committedThisHand: 120 })];
    const { container } = await mount(newTable(state({ street: "SHOWDOWN", board: FULL_BOARD, pot: 360, seats })));
    const t = allText(container);
    expect(text(container, ".pk-turn")).toBe("Showdown. Waiting for the result.");
    expect(t).not.toMatch(/Waiting for Sam/);
    expect(t).not.toContain("Acting");
    expect(container.querySelector(".seat-row.is-turn")).toBeNull();
    expect(container.querySelector("#poker-action-area")!.innerHTML).toBe("");
  });

  it("when no hand is in progress there is no pot or board, just the wait message", async () => {
    const seats = [seat(0, "Maya"), seat(1, "Sam")];
    const { container } = await mount(newTable(state({ currentHandId: null, currentHandOrdinal: null, street: null, board: [], pot: 0, myHoleCards: null, seats })));
    expect(text(container, ".pk-turn")).toBe("Waiting for the host to deal.");
    expect(container.querySelector("#poker-table")).toBeTruthy(); // the green table is always there, here with only its turn line
    expect(container.querySelector(".pk-potrow")).toBeNull();
    expect(container.querySelector(".board-cards")).toBeNull();
    expect(text(container, ".pk-street")).toBe("No hand in progress");
    expect(Array.from(container.querySelectorAll(".seat-row")).map((r) => text(r, ".pk-seat-chips"))).toEqual(["1,000 chips", "1,000 chips"]);
  });

  it("chips left: stack minus what is committed while the hand is live; the settled stack once it is finished", async () => {
    const live = await mount(newTable(turnState()));
    expect(Array.from(live.container.querySelectorAll(".seat-row")).map((r) => text(r, ".pk-seat-chips"))).toEqual([
      "995 chips left 5 in the pot", "990 chips left 10 in the pot", "970 chips left 30 in the pot", "1,000 chips left",
    ]);
    const done = await mount(newTable(showdownState(["Maya", "Sam", "Alex", "Jordan"], SAM_WINS)));
    expect(Array.from(done.container.querySelectorAll(".seat-row")).map((r) => text(r, ".pk-seat-chips"))).toEqual(["900 chips", "900 chips", "900 chips", "900 chips"]);
  });

  it("labels the pot as live while the hand is in progress and as final, already paid out, once it is finished", async () => {
    const live = await mount(newTable(turnState()));
    expect(text(live.container, ".pk-pot-label")).toBe("Pot");
    expect(text(live.container, ".pk-pot-value")).toBe("45");
    expect(live.container.querySelector(".pk-pot-note")).toBeNull();
    const done = await mount(newTable(showdownState(["Maya", "Sam", "Alex", "Jordan"], SAM_WINS)));
    expect(text(done.container, ".pk-pot-label")).toBe("Final pot");
    expect(text(done.container, ".pk-pot-note")).toBe("All the chips bet this hand, already paid out.");
  });

  it("groups large chip counts for reading, and shows them in full", async () => {
    const seats = [seat(0, "Maya", { stack: 1250000, isCurrentActor: false }), seat(1, "Sam", { isCurrentActor: true, stack: 1250000 })];
    const { container } = await mount(newTable(state({ pot: 2500000, seats })));
    expect(text(container, ".pk-pot-value")).toBe("2,500,000");
    expect(text(container, ".seat-row", )).toContain("1,250,000");
  });

  it("a closed table shows the end message and the last result, and offers no private cards or actions", async () => {
    const { container } = await mount(newTable(showdownState(["Maya", "Sam", "Alex", "Jordan"], SAM_WINS, undefined, { closedAt: "2026-11-05T21:10:00.000Z" })));
    expect(text(container, ".pk-turn")).toBe("This table has ended. Thanks for playing.");
    expect(text(container, ".pk-street")).toBe("Table ended");
    expect(container.querySelector(".pk-hand")).toBeNull();
    expect(container.querySelector("#poker-action-area")!.innerHTML).toBe("");
    expect(container.querySelector(".poker-result-card")).toBeTruthy();
    expect(allText(container)).not.toMatch(/host deals|waiting for the host/i);
  });
});

// ---------------------------------------------------------------------------------------------------------------------------------
// 6. Results, from the evidence in the read model
// ---------------------------------------------------------------------------------------------------------------------------------

describe("hand results", () => {
  const NAMES = ["Maya", "Sam", "Alex", "Jordan"];
  const rows = (container: Element) => Array.from(container.querySelectorAll(".poker-result-row")).map((r) => r.textContent!.replace(/\s+/g, " ").trim());
  const CAPTION = 'Payout is the number of chips a player received this hand. "Put in" is the chips that player bet.';

  it("a showdown where the viewer received nothing: a neutral headline, who won, each hand, and each player's own gross payout and stake", async () => {
    const hands: Record<string, Hand> = {
      "0": { cards: ["AH", "QH"], rankName: "Pair", descr: "Pair, A's" },
      "1": { cards: ["KH", "KC"], rankName: "Three of a Kind", descr: "Three of a Kind, K's" },
      "2": { cards: ["7D", "7H"], rankName: "Three of a Kind", descr: "Three of a Kind, 7's" },
    };
    const { container } = await mount(newTable(showdownState(NAMES, SAM_WINS, hands)));
    expect(text(container, ".pk-result-headline")).toBe("Hand complete");
    expect(text(container, ".pk-result-detail")).toBe("You received no chips this hand.");
    expect(rows(container)).toEqual([
      "You lost — Pair, A'sA♥Q♥",
      "Sam won — Three of a Kind, K'sK♥K♣Payout 380 chips · put in 120",
      "Alex lost — Three of a Kind, 7's7♦7♥",
    ]);
    expect(allText(container)).toContain(CAPTION);
    expect(container.querySelector(".poker-result-card")!.classList.contains("poker-result-win")).toBe(false);
  });

  it("a showdown the viewer won: the neutral headline, the viewer's own payout and stake, and an explicit 'won' on the viewer's own line", async () => {
    const { container } = await mount(newTable(showdownState(NAMES, [[{ seat: 0, amount: 80 }], [{ seat: 0, amount: 300 }]])));
    expect(text(container, ".pk-result-headline")).toBe("Hand complete");
    expect(text(container, ".pk-result-detail")).toBe("Your payout: 380 chips (you put in 120)");
    expect(rows(container)[0]).toBe("You won — Pair, A'sA♥K♥Payout 380 chips · put in 120");
    expect(container.querySelector(".poker-result-card")!.classList.contains("poker-result-win")).toBe(true);
  });

  it("a tied pot is 'shared', with each player's own payout and never one player's total", async () => {
    const split = [[{ seat: 0, amount: 40 }, { seat: 1, amount: 40 }], [{ seat: 0, amount: 150 }, { seat: 1, amount: 150 }]];
    const { container } = await mount(newTable(showdownState(NAMES, split)));
    const t = rows(container).join(" | ");
    expect(text(container, ".pk-result-headline")).toBe("Hand complete");
    expect(t).toContain("You shared the pot — Pair, A'sA♥K♥Payout 190 chips · put in 120");
    expect(t).toContain("Sam shared the pot — Pair, A'sA♥K♥Payout 190 chips · put in 120");
    expect(t).not.toMatch(/(You|Sam) won —/);
    expect(t).toContain("Alex lost");
    expect(text(container, ".pk-result-detail")).toBe("Your payout: 190 chips (you put in 120)");
    expect(allText(container.querySelector(".poker-result-card")!)).not.toContain("380");
  });

  it("chips received only from a part of the pot nobody else could take are a payout: neither a win nor a loss", async () => {
    // seat 0 bet 300, seat 1 called all-in for 100: seat 1 wins the pots both could contest (60 + 160); seat 0 is paid the 200 only it could take.
    const hands: Record<string, Hand> = { "0": { cards: ["AH", "QH"], rankName: "Pair", descr: "Pair, A's" }, "1": { cards: ["KH", "KC"], rankName: "Two Pair", descr: "Two Pair, K's & 7's" } };
    const seats = [seat(0, "Maya", { stack: 900, committedThisHand: 300 }), seat(1, "Sam", { stack: 1120, committedThisHand: 100 }), seat(2, "Alex", { isDealer: true, folded: true, stack: 980, committedThisHand: 20 })];
    const handResult = {
      pokerHandId: HAND_ID, board: FULL_BOARD, completedAt: "x", showdownHands: hands,
      pots: [
        { amount: 60, eligibleSeatNumbers: [0, 1], payouts: [{ seatNumber: 1, amount: 60 }] },
        { amount: 160, eligibleSeatNumbers: [0, 1], payouts: [{ seatNumber: 1, amount: 160 }] },
        { amount: 200, eligibleSeatNumbers: [0], payouts: [{ seatNumber: 0, amount: 200 }] },
      ],
    };
    const { container } = await mount(newTable(state({ street: "COMPLETE", board: FULL_BOARD, pot: 420, seats, handResult })));
    expect(text(container, ".pk-result-headline")).toBe("Hand complete");
    expect(text(container, ".pk-result-detail")).toBe("Your payout: 200 chips (you put in 300)");
    const t = rows(container);
    expect(t[0]).toBe("You showed — Pair, A'sA♥Q♥Payout 200 chips · put in 300");
    expect(container.querySelector(".poker-result-card")!.classList.contains("poker-result-win")).toBe(false);
    expect(t[1]).toBe("Sam won — Two Pair, K's & 7'sK♥K♣Payout 220 chips · put in 100");
    expect(allText(container)).not.toMatch(/side pot/i);
  });

  it("older hands without a hand description fall back to the hand category", async () => {
    const hands: Record<string, Hand> = { "0": { cards: ["AH", "QH"], rankName: "Pair" }, "1": { cards: ["KH", "KC"], rankName: "Flush" }, "2": { cards: ["7D", "7H"], rankName: "Pair" } };
    const { container } = await mount(newTable(showdownState(NAMES, SAM_WINS, hands)));
    expect(rows(container)[1]).toContain("Sam won — Flush");
  });

  it("flush descriptions embedding an internal card token are reformatted", async () => {
    const hands: Record<string, Hand> = { "0": { cards: ["AH", "QH"], rankName: "Flush", descr: "Flush, Kh High" }, "1": { cards: ["KH", "KC"], rankName: "Pair", descr: "Pair, K's" }, "2": { cards: ["7D", "7H"], rankName: "Pair", descr: "Pair, 7's" } };
    const { container } = await mount(newTable(showdownState(NAMES, [[{ seat: 0, amount: 80 }], [{ seat: 0, amount: 300 }]], hands)));
    expect(rows(container)[0]).toContain("You won — Flush, King High");
  });

  it("no showdown: names the winner only when the evidence is unambiguous, and says 'everyone else in the hand folded'", async () => {
    const me = await mount(newTable(foldWinState(NAMES, 0)));
    expect(text(me.container, ".pk-result-headline")).toBe("You won — everyone else in the hand folded");
    expect(text(me.container, ".pk-result-detail")).toBe("Your payout: 320 chips (you put in 140)");
    expect(me.container.querySelectorAll(".poker-result-row")).toHaveLength(0); // the headline already says it; no second line

    const other = await mount(newTable(foldWinState(NAMES, 1)));
    expect(text(other.container, ".pk-result-headline")).toBe("Sam won — everyone else in the hand folded");
    expect(rows(other.container)).toEqual(["Sam received 320 chips (put in 140)"]);
    expect(text(other.container, ".pk-result-sub")).toBe("Hand 4 · Ended without a showdown");
  });

  it("does not name a fold winner when payouts go to several seats, when the payee is marked folded, when others were eligible, or when another dealt-in seat did not fold", async () => {
    const several = foldWinState(NAMES, 0) as any;
    several.handResult.pots[1].payouts = [{ seatNumber: 1, amount: 240 }];
    several.handResult.pots[1].eligibleSeatNumbers = [1];
    const a = await mount(newTable(several));
    expect(text(a.container, ".pk-result-headline")).toBe("Hand complete");
    expect(rows(a.container)).toEqual(["You received 80 chips (put in 140)", "Sam received 240 chips (put in 140)"]);

    const folded = foldWinState(NAMES, 1) as any;
    folded.seats[1].folded = true;
    expect(text((await mount(newTable(folded))).container, ".pk-result-headline")).toBe("Hand complete");

    const contested = foldWinState(NAMES, 1) as any;
    contested.handResult.pots[0].eligibleSeatNumbers = [1, 2];
    expect(text((await mount(newTable(contested))).container, ".pk-result-headline")).toBe("Hand complete");

    // another seat that was dealt in is not marked folded, so "everyone else in the hand folded" cannot be said
    const unfolded = foldWinState(NAMES, 1) as any;
    unfolded.seats[2].folded = false;
    expect(text((await mount(newTable(unfolded))).container, ".pk-result-headline")).toBe("Hand complete");
  });

  it("a player who joined mid-hand never folded, and the sentence says 'in the hand' so it stays true for them", async () => {
    const s = foldWinState(NAMES, 1) as any;
    s.seats.push(seat(4, "Casey", { inCurrentHand: false, folded: false, stack: 1000 }));
    const { container } = await mount(newTable(s));
    expect(text(container, ".pk-result-headline")).toBe("Sam won — everyone else in the hand folded");
    expect(text(container, ".pk-result-headline")).not.toMatch(/everyone else folded/);
  });

  it("another player who chose the display name 'You' cannot be read as the viewer", async () => {
    const fold = await mount(newTable(foldWinState(["Maya", "You", "Alex", "Jordan"], 1)));
    expect(text(fold.container, ".pk-result-headline")).toBe("You (another player) won — everyone else in the hand folded");
    expect(rows(fold.container)).toEqual(["You (another player) received 320 chips (put in 140)"]);
    const show = await mount(newTable(showdownState(["Maya", "YOU", "Alex", "Jordan"], SAM_WINS)));
    expect(Array.from(show.container.querySelectorAll(".pk-reveal-line")).map((e) => e.textContent)).toEqual([
      "You lost — Pair, A's",
      "YOU (another player) won — Pair, A's",
      "Alex lost — Pair, A's",
    ]);
    // the viewer's own name is untouched
    const mine = await mount(newTable(foldWinState(["You", "Sam", "Alex", "Jordan"], 0)));
    expect(text(mine.container, ".pk-result-headline")).toBe("You won — everyone else in the hand folded");
  });

  it("a player who was not dealt in sees only that the hand is complete", async () => {
    const s = showdownState(NAMES, SAM_WINS) as any;
    s.seats[0].inCurrentHand = false;
    s.myHoleCards = null;
    const { container } = await mount(newTable(s));
    expect(text(container, ".pk-result-headline")).toBe("Hand complete");
    expect(text(container, ".pk-result-detail")).toBe("");
  });

  it("never presents a payout as profit", async () => {
    const { container } = await mount(newTable(showdownState(NAMES, SAM_WINS)));
    const t = allText(container).toLowerCase();
    expect(t).not.toContain("profit");
    expect(t).not.toMatch(/\+\d/);
    expect(t).not.toMatch(/net |gain|winnings/);
  });

  describe("wording never claims more than the result record supports", () => {
    const scenarios: Array<[string, Pot[]]> = [
      ["the viewer received nothing", [{ amount: 300, eligibleSeatNumbers: [0, 1, 2], payouts: [{ seatNumber: 1, amount: 300 }] }]],
      ["the viewer took the pot", [{ amount: 300, eligibleSeatNumbers: [0, 1, 2], payouts: [{ seatNumber: 0, amount: 300 }] }]],
      ["a split pot", [{ amount: 300, eligibleSeatNumbers: [0, 1, 2], payouts: [{ seatNumber: 0, amount: 150 }, { seatNumber: 1, amount: 150 }] }]],
      ["the viewer was handed chips back", uncalledPots(0, 1)],
    ];
    it.each(scenarios)("every showdown has the same neutral headline, whatever happened: %s", async (_label, pots) => {
      const { container } = await mount(newTable(resultState(pots)));
      expect(text(container, ".pk-result-headline")).toBe("Hand complete");
      expect(text(container, ".pk-result-detail")).toMatch(/^(Your payout: [\d,]+ chips \(you put in [\d,]+\)|You received no chips this hand\.)$/);
    });

    it("a player who only received chips from a part of the pot nobody else could take is neither a winner nor a loser", async () => {
      const mine = await mount(newTable(resultState(uncalledPots(0, 1))));
      expect(verbsByName(mine.container)).toEqual({ You: "showed", Sam: "won", Alex: "lost" });
      expect(text(mine.container, ".pk-result-detail")).toBe("Your payout: 200 chips (you put in 100)");
      expect(container0(mine.container).classList.contains("poker-result-win")).toBe(false);

      // the same, seen from another seat's line
      const other = await mount(newTable(resultState(uncalledPots(1, 0))));
      expect(verbsByName(other.container)).toEqual({ You: "won", Sam: "showed", Alex: "lost" });
      expect(rows(other.container)[1]).toBe("Sam showed — Two Pair, K's & 7'sK♥K♣Payout 200 chips · put in 100");
      expect(allText(other.container)).not.toMatch(/Sam (won|lost) —/);
    });

    it("a pot only one seat was eligible for is not a win, however large (seats that received nothing keep the original 'lost' rule)", async () => {
      const { container } = await mount(newTable(resultState([{ amount: 300, eligibleSeatNumbers: [1], payouts: [{ seatNumber: 1, amount: 300 }] }])));
      expect(verbsByName(container)).toEqual({ You: "lost", Sam: "showed", Alex: "lost" });
    });

    it("the gold row marker follows 'won' and 'shared the pot' only, never a player who merely received chips", async () => {
      const gold = (container: Element) => Array.from(container.querySelectorAll(".poker-result-row.pk-winner .pk-reveal-line")).map((e) => (e.textContent ?? "").split(" — ")[0]);
      expect(gold((await mount(newTable(resultState(uncalledPots(0, 1))))).container)).toEqual(["Sam won"]);
      expect(gold((await mount(newTable(resultState([{ amount: 300, eligibleSeatNumbers: [0, 1, 2], payouts: [{ seatNumber: 0, amount: 150 }, { seatNumber: 1, amount: 150 }] }])))).container)).toEqual(["You shared the pot", "Sam shared the pot"]);
      expect(gold((await mount(newTable(resultState([{ amount: 300, eligibleSeatNumbers: [1], payouts: [{ seatNumber: 1, amount: 300 }] }])))).container)).toEqual([]);
      expect(gold((await mount(newTable(resultState([{ amount: 300, payouts: [{ seatNumber: 1, amount: 300 }] }])))).container)).toEqual([]);
    });

    it("a record that cannot be read for who could contest what names nobody a winner or a loser", async () => {
      const noEligibility = await mount(newTable(resultState([{ amount: 300, payouts: [{ seatNumber: 1, amount: 300 }] }])));
      expect(verbsByName(noEligibility.container)).toEqual({ You: "showed", Sam: "showed", Alex: "showed" });
      expect(text(noEligibility.container, ".pk-result-headline")).toBe("Hand complete");
      expect(noEligibility.container.querySelector(".poker-result-card")!.classList.contains("poker-result-win")).toBe(false);
      expect(text(noEligibility.container, ".pk-result-detail")).toBe("");
      expect(rows(noEligibility.container)[1]).toContain("Payout 300 chips");

      // no pots at all: zero payouts here would be missing data, not a result
      const noPots = await mount(newTable(resultState([])));
      expect(verbsByName(noPots.container)).toEqual({ You: "showed", Sam: "showed", Alex: "showed" });
      expect(allText(noPots.container.querySelector(".poker-result-card")!)).not.toMatch(/received no chips|\blost\b|\bwon\b/);

      // a pot without a payout list
      const badPot = await mount(newTable(resultState([{ amount: 300, eligibleSeatNumbers: [0, 1, 2] } as any])));
      expect(verbsByName(badPot.container)).toEqual({ You: "showed", Sam: "showed", Alex: "showed" });

      // payouts that are not positive whole amounts, or do not add up to their pot
      for (const pots of [
        [{ amount: 300, eligibleSeatNumbers: [0, 1, 2], payouts: [{ seatNumber: 1, amount: 200 }] }],
        [{ amount: 300, eligibleSeatNumbers: [0, 1, 2], payouts: [{ seatNumber: 1, amount: 350 }, { seatNumber: 0, amount: -50 }] }],
        [{ amount: 300, eligibleSeatNumbers: [0, 1, 2], payouts: [{ seatNumber: 1, amount: "300" }] }],
      ] as Pot[][]) {
        const { container } = await mount(newTable(resultState(pots)));
        expect(verbsByName(container)).toEqual({ You: "showed", Sam: "showed", Alex: "showed" });
      }
    });

    it("a player who lost the only comparison among all contenders but is paid from parts only they could take is not called a loser", async () => {
      // A shoves 100, B and C call; C bets 100 on the flop, B raises to 300, C folds: A takes the pot every contender was in, B is paid 400 from parts only B could take
      const pots: Pot[] = [
        { amount: 300, eligibleSeatNumbers: [0, 1], payouts: [{ seatNumber: 0, amount: 300 }] },
        { amount: 200, eligibleSeatNumbers: [1], payouts: [{ seatNumber: 1, amount: 200 }] },
        { amount: 200, eligibleSeatNumbers: [1], payouts: [{ seatNumber: 1, amount: 200 }] },
      ];
      const { container } = await mount(newTable(resultState(pots, { "0": HANDS_3["0"], "1": HANDS_3["1"] })));
      expect(verbsByName(container)).toEqual({ You: "won", Sam: "showed" });
      expect(rows(container)[1]).toBe("Sam showed — Two Pair, K's & 7'sK♥K♣Payout 400 chips · put in 100");
    });

    it("winning, or even tying for, a smaller part of the chips does not make a player the winner: only the pot every contender was in does", async () => {
      const tied: Pot[] = [
        { amount: 240, eligibleSeatNumbers: [0, 1, 2], payouts: [{ seatNumber: 0, amount: 240 }] },
        { amount: 100, eligibleSeatNumbers: [0, 1], payouts: [{ seatNumber: 0, amount: 50 }, { seatNumber: 1, amount: 50 }] },
      ];
      expect(verbsByName((await mount(newTable(resultState(tied)))).container)).toEqual({ You: "won", Sam: "showed", Alex: "lost" });

      const layered: Pot[] = [
        { amount: 240, eligibleSeatNumbers: [0, 1, 2], payouts: [{ seatNumber: 0, amount: 240 }] },
        { amount: 100, eligibleSeatNumbers: [1, 2], payouts: [{ seatNumber: 1, amount: 100 }] },
      ];
      const { container } = await mount(newTable(resultState(layered)));
      expect(verbsByName(container)).toEqual({ You: "won", Sam: "showed", Alex: "lost" });
      expect(rows(container)[1]).toContain("Payout 100 chips");
      expect(allText(container)).not.toMatch(/side pot|main pot|overall|winner of the hand/i);
      expect(text(container, ".pk-result-headline")).toBe("Hand complete");
    });

    it("a deep stack paid a small part while a stronger hand took the main pot is not styled or worded as a win", async () => {
      // seat 1 holds the best hand and takes the 300 every contender was in; seat 0 put in 110 and wins only the 20 between two deep stacks
      const pots: Pot[] = [
        { amount: 300, eligibleSeatNumbers: [0, 1, 2], payouts: [{ seatNumber: 1, amount: 300 }] },
        { amount: 20, eligibleSeatNumbers: [0, 2], payouts: [{ seatNumber: 0, amount: 20 }] },
      ];
      const seats = [seat(0, "Maya", { stack: 890, committedThisHand: 110 }), seat(1, "Sam", { stack: 1200, committedThisHand: 100 }), seat(2, "Alex", { stack: 890, committedThisHand: 110 })];
      const { container } = await mount(newTable(resultState(pots, HANDS_3, { seats, pot: 320 })));
      expect(verbsByName(container)).toEqual({ You: "showed", Sam: "won", Alex: "lost" });
      expect(text(container, ".pk-result-headline")).toBe("Hand complete");
      expect(text(container, ".pk-result-detail")).toBe("Your payout: 20 chips (you put in 110)");
      expect(container0(container).classList.contains("poker-result-win")).toBe(false);
      expect(allText(container.querySelector(".poker-result-card")!)).toContain("Chips are paid out in separate parts.");
    });

    it("a stronger hand shown as 'lost' beside a weaker hand paid from a part it was not in is explained, and the weaker hand is not 'won'", async () => {
      const hands: Record<string, Hand> = {
        "0": { cards: ["AH", "AC"], rankName: "Three of a Kind", descr: "Three of a Kind, A's" },
        "1": { cards: ["9H", "8H"], rankName: "Straight", descr: "Straight, 10 High" },
        "2": { cards: ["KH", "2C"], rankName: "Pair", descr: "Pair, 9's" },
        "3": { cards: ["3H", "4C"], rankName: "High Card", descr: "High Card" },
      };
      const seats = [0, 1, 2, 3].map((i) => seat(i, NAMES[i], { stack: 800, committedThisHand: [100, 100, 300, 300][i] }));
      const pots: Pot[] = [
        { amount: 400, eligibleSeatNumbers: [0, 1, 2, 3], payouts: [{ seatNumber: 0, amount: 400 }] },
        { amount: 400, eligibleSeatNumbers: [2, 3], payouts: [{ seatNumber: 2, amount: 400 }] },
      ];
      const { container } = await mount(newTable(state({ street: "COMPLETE", board: FULL_BOARD, pot: 800, seats, handResult: { pokerHandId: HAND_ID, board: FULL_BOARD, completedAt: "x", showdownHands: hands, pots } })));
      expect(verbsByName(container)).toEqual({ You: "won", Sam: "lost", Alex: "showed", Jordan: "lost" });
      const t = allText(container.querySelector(".poker-result-card")!);
      expect(t).toContain("Chips are paid out in separate parts. A hand can be paid from a part that a stronger hand could not take part in.");
      expect(t).not.toMatch(/side pot|main pot/i);
    });

    it("the 'separate parts' note appears only when the chips really were paid in parts", async () => {
      const single = await mount(newTable(resultState([{ amount: 300, eligibleSeatNumbers: [0, 1, 2], payouts: [{ seatNumber: 1, amount: 300 }] }])));
      expect(allText(single.container)).not.toContain("separate parts");
      const same = await mount(newTable(resultState([
        { amount: 150, eligibleSeatNumbers: [0, 1], payouts: [{ seatNumber: 1, amount: 150 }] },
        { amount: 150, eligibleSeatNumbers: [0, 1], payouts: [{ seatNumber: 1, amount: 150 }] },
      ])));
      expect(allText(same.container)).not.toContain("separate parts");
    });

    it("amounts are chips received (a payout) plus the player's own stake, per player; nothing is summed across players or subtracted into a profit", async () => {
      const { container } = await mount(newTable(resultState(uncalledPots(0, 1))));
      const t = allText(container.querySelector(".poker-result-card")!);
      expect(t).toContain("Payout 200 chips · put in 100");
      expect(t).toContain("Payout 220 chips · put in 100");
      expect(t).not.toMatch(/420/);
      expect(t).not.toMatch(/profit|\bnet\b|won \d|\+\d|[−-]\d/i);
      expect(t).toContain(CAPTION);
      expect(t).not.toMatch(/refund|returned/i);
    });

    it("the unambiguous no-showdown win keeps its presentation, and ambiguous ones stay neutral", async () => {
      const clear = await mount(newTable(foldWinState(["Maya", "Sam", "Alex", "Jordan"], 1)));
      expect(text(clear.container, ".pk-result-headline")).toBe("Sam won — everyone else in the hand folded");
      const noList = foldWinState(["Maya", "Sam", "Alex", "Jordan"], 1) as any;
      noList.handResult.pots.forEach((p: any) => delete p.eligibleSeatNumbers);
      const ambiguous = await mount(newTable(noList));
      expect(text(ambiguous.container, ".pk-result-headline")).toBe("Hand complete");
      expect(rows(ambiguous.container)).toEqual(["Sam received 320 chips (put in 140)"]);
    });
  });
});

const container0 = (c: Element) => c.querySelector(".poker-result-card") as Element;

// ---------------------------------------------------------------------------------------------------------------------------------
// 7. Hostile player names, on every path that now renders one
// ---------------------------------------------------------------------------------------------------------------------------------

const HOSTILE: Array<{ label: string; value: string }> = [
  { label: "img onerror", value: '<img src=x onerror="window.__xss=1">' },
  { label: "attribute-breakout script", value: '"><script>window.__xss=1</script>' },
  { label: "svg onload", value: '<svg onload="window.__xss=1">' },
  { label: "benign tag", value: "<b>bold</b>" },
  { label: "bare attribute-breakout", value: '" onmouseover="window.__xss=1" x="' },
  { label: "javascript link", value: '<a href="javascript:window.__xss=1">x</a>' },
  { label: "container breakout", value: "</span></div><img src=x onerror=1>" },
  { label: "table-cell breakout", value: "</td><td><img src=x onerror=1>" },
];
const ORDINARY = ["María José", "李雷", "O'Brien", "Tom & Jerry", "5 > 3 and 2 < 4", "&lt;b&gt; &amp; &#39;"];

/** Each scenario puts the name where one rendering path writes it, and names the element whose text must be exactly the literal name. */
const PATHS: Array<{ path: string; build: (name: string) => unknown; check: (container: HTMLElement, name: string) => void }> = [
  {
    path: "the seat list",
    build: (n) => waitingState(["Maya", n, "Alex"]),
    check: (c, n) => expect(Array.from(c.querySelectorAll(".seat-name")).map(ownText)).toEqual(["Maya (you)", n, "Alex"]),
  },
  {
    path: "the 'waiting for' turn line and the screen-reader announcement",
    build: (n) => waitingState(["Maya", n, "Alex"]),
    check: (c, n) => {
      expect(text(c, ".pk-turn")).toBe(`Waiting for ${n} to act`.replace(/\s+/g, " ").trim());
      expect(c.querySelector("#poker-live")!.textContent).toBe(`Waiting for ${n} to act`);
    },
  },
  {
    path: "a showdown line",
    build: (n) => showdownState(["Maya", n, "Alex", "Jordan"], SAM_WINS),
    check: (c, n) => expect(Array.from(c.querySelectorAll(".pk-reveal-line")).map((e) => e.textContent)).toContain(`${n} won — Pair, A's`),
  },
  {
    path: "the fold-win headline and the payout line",
    build: (n) => foldWinState(["Maya", n, "Alex", "Jordan"], 1),
    check: (c, n) => {
      expect(c.querySelector(".pk-result-headline")!.textContent).toBe(`${n} won — everyone else in the hand folded`);
      expect(c.querySelector(".pk-payee")!.textContent).toBe(`${n} received 320 chips (put in 140)`);
    },
  },
];

describe("player names are literal text on every path", () => {
  describe.each(PATHS)("$path", ({ build, check }) => {
    it.each(HOSTILE)("hostile name: $label", async ({ value }) => {
      const { win, container } = await mount(newTable(build(value)));
      expect(violations(container)).toEqual([]);
      check(container, value);
      expect(win.__xss).toBeUndefined();
    });
    it.each(ORDINARY)("ordinary name %j is shown exactly as typed", async (value) => {
      const { container } = await mount(newTable(build(value)));
      expect(violations(container)).toEqual([]);
      check(container, value);
    });
  });

  it.each(HOSTILE)("a server message in the connection notice is text, never markup: $label", async ({ value }) => {
    const t = newTable(turnState());
    const { win, container, render } = await mount(t);
    t.getReply = { status: 500, json: { error: value } };
    await render();
    expect(violations(container)).toEqual([]);
    expect(container.querySelector(".pk-notice-line:last-child")!.textContent).toBe(`The server said: ${value}`);
    expect(win.__xss).toBeUndefined();

    const first = newTable(turnState());
    first.getReply = { status: 500, json: { error: value } };
    const fresh = await mount(first);
    expect(violations(fresh.container)).toEqual([]);
    expect(fresh.container.querySelector(".pk-notice-line")!.textContent).toBe(value);
  });

  it.each(HOSTILE)("a server message after a failed action is text: $label", async ({ value }) => {
    const t = newTable(turnState());
    const { win, container } = await mount(t);
    t.post = async () => ({ status: 409, json: { error: value } });
    container.querySelector<HTMLButtonElement>('[data-action="CALL"]')!.click();
    await until(() => text(container, "#action-msg") === value.replace(/\s+/g, " ").trim(), "error message");
    expect(violations(container)).toEqual([]);
    expect(win.__xss).toBeUndefined();
  });
});

describe("server-derived values are escaped as well", () => {
  const evil = HOSTILE[0].value;
  it.each(HOSTILE)("room code, hand number, pot and hand description written as hostile text stay text: $label", async ({ value }) => {
    const { win, container } = await mount(newTable(waitingState(["Maya", "Sam", "Alex"], { roomCode: value, currentHandOrdinal: value, pot: value })));
    expect(violations(container)).toEqual([]);
    expect(text(container, ".status-pill")).toBe(`Room ${value}`.replace(/\s+/g, " ").trim());
    expect(container.querySelector(".pk-pot-value")!.textContent).toBe(value);
    expect(win.__xss).toBeUndefined();

    const hands: Record<string, Hand> = { "0": { cards: ["AH", "QH"], rankName: "Pair", descr: value }, "1": { cards: ["KH", "KC"], rankName: "Pair", descr: value }, "2": { cards: ["7D", "7H"], rankName: "Pair", descr: value } };
    const shown = await mount(newTable(showdownState(["Maya", "Sam", "Alex", "Jordan"], SAM_WINS, hands, { currentHandOrdinal: value })));
    expect(violations(shown.container)).toEqual([]);
    expect(Array.from(shown.container.querySelectorAll(".pk-reveal-line")).map((e) => e.textContent)).toContain(`Sam won — ${value}`);
    expect(text(shown.container, ".pk-result-sub")).toBe(`Hand ${value} · Showdown`.replace(/\s+/g, " ").trim());
  });
  it("a chip amount that is not a number (a malformed server value) is shown as text, never as markup", async () => {
    const { container } = await mount(newTable(turnState(legal({ canCall: true, callAmount: evil as any, canRaise: true, minRaiseTo: 50, maxAmount: 1000 }))));
    expect(violations(container)).toEqual([]);
    expect(text(container, '[data-action="CALL"]')).toContain(evil.replace(/\s+/g, " "));
  });
});

// ---------------------------------------------------------------------------------------------------------------------------------
// Negative controls: each protection is removed from a COPY of the shipped source and the same checks are shown to catch it.
// ---------------------------------------------------------------------------------------------------------------------------------

function unsafeCopy(source: string, anchor: string, replacement: string): string {
  const count = source.split(anchor).length - 1;
  expect(count, `mutation anchor must occur exactly once: ${anchor}`).toBe(1);
  const mutated = source.replace(anchor, () => replacement);
  expect(mutated).not.toBe(source);
  return mutated;
}

async function mountWith(source: string, table: Table) {
  const dom = new JSDOM('<!doctype html><html><body><div id="c"></div></body></html>', { url: "http://localhost/participant.html", runScripts: "outside-only", pretendToBeVisual: true, virtualConsole: quiet() });
  windows.push(dom.window);
  const win = dom.window as any;
  const calls = installFetch(win, table);
  win.eval(source);
  const container = win.document.getElementById("c") as HTMLElement;
  await win.PokerParticipant.renderPokerTable(container, SEAT);
  return { win, container, calls };
}

describe("negative controls — removing a protection is caught by the checks above", () => {
  const hostile = HOSTILE[0].value;
  const INJECTED = expect.arrayContaining(["unexpected <img>", "<img> carries onerror"]);

  it("the 'waiting for' turn line: an unescaped name injects an element and a handler", async () => {
    const unsafe = unsafeCopy(POKER_JS, 'escapeHtml(turn.name || "")', '(turn.name || "")');
    const { container } = await mountWith(unsafe, newTable(waitingState(["Maya", hostile, "Alex"])));
    expect(violations(container)).toEqual(INJECTED);
  });

  it("the fold-win headline: an unescaped name injects an element and a handler", async () => {
    const unsafe = unsafeCopy(POKER_JS, "${escapeHtml(winnerName)} won", "${winnerName} won");
    const { container } = await mountWith(unsafe, newTable(foldWinState(["Maya", hostile, "Alex", "Jordan"], 1)));
    expect(violations(container)).toEqual(INJECTED);
  });

  it("the payout line: an unescaped name injects an element and a handler", async () => {
    const unsafe = unsafeCopy(POKER_JS, "${escapeHtml(payeeName)} received", "${payeeName} received");
    const { container } = await mountWith(unsafe, newTable(foldWinState(["Maya", hostile, "Alex", "Jordan"], 1)));
    expect(violations(container)).toEqual(INJECTED);
  });

  it("the connection notice: writing a server message as markup injects an element and a handler", async () => {
    const unsafe = unsafeCopy(POKER_JS, "p.textContent = line;", "p.innerHTML = line;");
    const t = newTable(turnState());
    t.getReply = { status: 500, json: { error: hostile } };
    const { container } = await mountWith(unsafe, t);
    expect(violations(container)).toEqual(INJECTED);
  });

  it("the failed-action message: writing a server message as markup injects an element and a handler", async () => {
    const unsafe = unsafeCopy(POKER_JS, "actionMsg.textContent = text;", "actionMsg.innerHTML = text;");
    const t = newTable(turnState());
    const { container } = await mountWith(unsafe, t);
    t.post = async () => ({ status: 409, json: { error: hostile } });
    container.querySelector<HTMLButtonElement>('[data-action="CALL"]')!.click();
    await until(() => container.querySelector("#action-msg img") !== null, "injected element");
    expect(violations(container)).toEqual(INJECTED);
  });

  /** The command(s) a click on All-in sends, or the bodies sent for a typed Raise amount: the very checks the shipped source must pass. */
  async function sentBodies(source: string, click: string, typed?: string) {
    const bodies: any[] = [];
    const t = newTable(turnState());
    t.post = async (call) => { bodies.push(call.body); return { status: 200, json: {} }; };
    const { container } = await mountWith(source, t);
    if (typed !== undefined) container.querySelector<HTMLInputElement>("#amount-input")!.value = typed;
    container.querySelector<HTMLButtonElement>(`[data-action="${click}"]`)!.click();
    await tick();
    await tick();
    return bodies;
  }

  it("All-in must send ALL_IN: the shipped source does, and a copy that routes it through Raise is caught", async () => {
    expect((await sentBodies(POKER_JS, "ALL_IN", "500")).map((b) => [b.actionType, b.amount])).toEqual([["ALL_IN", null]]);
    const unsafe = unsafeCopy(POKER_JS, "submit(actionType, null);", 'submit(actionType === "ALL_IN" ? "RAISE" : actionType, null);');
    expect((await sentBodies(unsafe, "ALL_IN", "500")).map((b) => b.actionType)).toEqual(["RAISE"]);
  });

  it("'60.9' must be refused: the shipped source sends nothing, and a copy using truncating parseInt would wager 60", async () => {
    expect(await sentBodies(POKER_JS, "RAISE", "60.9")).toEqual([]);
    const unsafe = unsafeCopy(
      POKER_JS,
      'if (!/^\\d+$/.test(text)) return { ok: false, message: "Enter a whole number." };\n      const value = Number(text);',
      'const value = parseInt(text, 10); if (Number.isNaN(value)) return { ok: false, message: "Enter a whole number." };'
    );
    expect((await sentBodies(unsafe, "RAISE", "60.9")).map((b) => b.amount)).toEqual([60]);
  });

  it("the result verbs are only as strong as the evidence: the shipped source is exact, and copies that blur a distinction are caught", async () => {
    const verbsFor = async (source: string, pots: Pot[], o: Record<string, unknown> = {}) => {
      const { container } = await mountWith(source, newTable(resultState(pots, HANDS_3, o)));
      return verbsByName(container);
    };
    const chop: Pot[] = [{ amount: 300, eligibleSeatNumbers: [0, 1, 2], payouts: [{ seatNumber: 0, amount: 150 }, { seatNumber: 1, amount: 150 }] }];
    const refund = uncalledPots(0, 1);
    const smallerPart: Pot[] = [
      { amount: 240, eligibleSeatNumbers: [0, 1, 2], payouts: [{ seatNumber: 0, amount: 240 }] },
      { amount: 100, eligibleSeatNumbers: [1, 2], payouts: [{ seatNumber: 1, amount: 100 }] },
    ];
    expect(await verbsFor(POKER_JS, refund)).toEqual({ You: "showed", Sam: "won", Alex: "lost" });
    expect(await verbsFor(POKER_JS, chop)).toEqual({ You: "shared the pot", Sam: "shared the pot", Alex: "lost" });
    expect(await verbsFor(POKER_JS, [])).toEqual({ You: "showed", Sam: "showed", Alex: "showed" });
    expect(await verbsFor(POKER_JS, smallerPart)).toEqual({ You: "won", Sam: "showed", Alex: "lost" });

    // chips from a part only one seat could take, or a smaller contest, counted as a win
    const partIsWin = unsafeCopy(POKER_JS, "if (pot.eligibleSeatNumbers.length !== widest) continue;", "if (pot.eligibleSeatNumbers.length < 2) continue;");
    expect((await verbsFor(partIsWin, smallerPart)).Sam).toBe("won");
    const anyPartIsWin = unsafeCopy(POKER_JS, "if (pot.eligibleSeatNumbers.length !== widest) continue;", "");
    expect((await verbsFor(anyPartIsWin, refund)).You).toBe("won");
    // chips from an uncontested layer read as a loss
    const refundIsLoss = unsafeCopy(POKER_JS, '(payout[seatNumber] || 0) > 0 ? "showed" : "lost"', '"lost"');
    expect((await verbsFor(refundIsLoss, refund)).You).toBe("lost");
    // a tie read as a win
    const chopIsWin = unsafeCopy(POKER_JS, "(payees.length === 1 ? soleWinners : sharers).add(seatNumber)", "soleWinners.add(seatNumber)");
    expect((await verbsFor(chopIsWin, chop)).You).toBe("won");
    // missing data read as a loss for everyone
    const emptyIsLoss = unsafeCopy(POKER_JS, "const usable = pots.length > 0 && pots.every(wellFormed);", "const usable = pots.every(wellFormed);");
    expect((await verbsFor(emptyIsLoss, [])).You).toBe("lost");
    // payouts that do not add up to their pot trusted anyway
    const unbalanced: Pot[] = [{ amount: 300, eligibleSeatNumbers: [0, 1, 2], payouts: [{ seatNumber: 1, amount: 200 }] }];
    expect(await verbsFor(POKER_JS, unbalanced)).toEqual({ You: "showed", Sam: "showed", Alex: "showed" });
    const trustsSums = unsafeCopy(POKER_JS, "p.payouts.reduce((n, x) => n + x.amount, 0) === p.amount", "true");
    expect((await verbsFor(trustsSums, unbalanced)).You).toBe("lost");
  });

  it("'everyone else in the hand folded' needs every other dealt-in seat to be folded, and another player named 'You' is told apart from the viewer", async () => {
    const headline = async (source: string, s: unknown) => {
      const { container } = await mountWith(source, newTable(s));
      return text(container, ".pk-result-headline");
    };
    const unfolded = foldWinState(["Maya", "Sam", "Alex", "Jordan"], 1) as any;
    unfolded.seats[2].folded = false;
    expect(await headline(POKER_JS, unfolded)).toBe("Hand complete");
    const noFoldCheck = unsafeCopy(POKER_JS, " &&\n        (state.seats || []).every((x) => x.seatNumber === sole || !x.inCurrentHand || x.folded)", "");
    expect(await headline(noFoldCheck, unfolded)).toBe("Sam won — everyone else in the hand folded");

    const spoof = foldWinState(["Maya", "You", "Alex", "Jordan"], 1);
    expect(await headline(POKER_JS, spoof)).toBe("You (another player) won — everyone else in the hand folded");
    const noSpoofGuard = unsafeCopy(POKER_JS, "/^\\s*you\\s*$/i.test(seatInfo.displayName)", "false");
    expect(await headline(noSpoofGuard, spoof)).toBe("You won — everyone else in the hand folded");
  });

  it("the in-flight guard is what stops a second Enter: without it a second request goes out", async () => {
    expect((await postsAfterTwoEnters(POKER_JS)).count).toBe(1);
    const unguarded = unsafeCopy(POKER_JS, "if (ctx.busy) return;", "");
    expect((await postsAfterTwoEnters(unguarded)).count).toBeGreaterThan(1);
  });

  it("the gold row marker is tied to the verb: a copy that marks every payee is caught", async () => {
    const gold = async (source: string) => {
      const { container } = await mountWith(source, newTable(resultState(uncalledPots(0, 1))));
      return Array.from(container.querySelectorAll(".poker-result-row.pk-winner .pk-reveal-line")).map((e) => (e.textContent ?? "").split(" — ")[0]);
    };
    expect(await gold(POKER_JS)).toEqual(["Sam won"]);
    const everyPayee = unsafeCopy(POKER_JS, 'verbs.explicitWinners.has(seatNumber) ? " pk-winner" : ""', 'payout > 0 ? " pk-winner" : ""');
    expect(await gold(everyPayee)).toEqual(["You showed", "Sam won"]);
  });

  it("server-derived text is escaped: copies that trust a non-number or a hand description are caught", async () => {
    const evil = HOSTILE[0].value;
    const potState = waitingState(["Maya", "Sam", "Alex"], { pot: evil });
    const showState = () => {
      const hands: Record<string, Hand> = { "0": { cards: ["AH", "QH"], rankName: "Pair", descr: evil }, "1": { cards: ["KH", "KC"], rankName: "Pair", descr: "Pair, K's" }, "2": { cards: ["7D", "7H"], rankName: "Pair", descr: "Pair, 7's" } };
      return showdownState(["Maya", "Sam", "Alex", "Jordan"], SAM_WINS, hands);
    };
    expect(violations((await mountWith(POKER_JS, newTable(potState))).container)).toEqual([]);
    expect(violations((await mountWith(POKER_JS, newTable(showState()))).container)).toEqual([]);
    const trustsNonNumbers = unsafeCopy(POKER_JS, "return escapeHtml(String(n));", "return String(n);");
    expect(violations((await mountWith(trustsNonNumbers, newTable(potState))).container)).toEqual(INJECTED);
    const trustsDescr = unsafeCopy(POKER_JS, "— ${escapeHtml(descr)}", "— ${descr}");
    expect(violations((await mountWith(trustsDescr, newTable(showState()))).container)).toEqual(INJECTED);
  });

  it("blocking is what stops actions while stale: without it a disabled-state check would fail", async () => {
    const unsafe = unsafeCopy(POKER_JS, "const blocked = ctx.busy || ctx.stale;", "const blocked = false;");
    const t = newTable(turnState());
    const { container } = await mountWith(unsafe, t);
    t.online = false;
    await (container.ownerDocument.defaultView as any).PokerParticipant.renderPokerTable(container, SEAT);
    expect(actions(container).some((b) => !b.disabled)).toBe(true);
  });

  describe("the hierarchy checks catch each way of breaking the unified table", () => {
    const problemsOf = async (source: string) => hierarchyProblems((await mountWith(source, newTable(turnState()))).container);
    const NOTICE = '`<div id="poker-notice" class="pk-notice" role="alert" hidden></div>` +';
    const AREA = '`<div id="poker-action-area"></div>` +';

    it("the shipped source has none of them", async () => {
      expect(await problemsOf(POKER_JS)).toEqual([]);
    });

    it("moving the information panel into the green table is caught", async () => {
      const inside = unsafeCopy(unsafeCopy(POKER_JS, NOTICE, '`<div id="poker-notice" class="pk-notice" role="alert" hidden></div><div id="poker-info"></div>` +'), '`<div id="poker-info"></div>`;', "``;");
      const problems = await problemsOf(inside);
      expect(problems).toContain("the table and the information panel are nested");
    });

    it("putting the connection notice before the controls is caught", async () => {
      const swapped = unsafeCopy(POKER_JS, AREA + "\n        " + NOTICE, NOTICE + "\n        " + AREA);
      expect(await problemsOf(swapped)).toContain("the connection notice is not the last thing in the table");
    });

    it("a second felt element is caught", async () => {
      const twoFelts = unsafeCopy(POKER_JS, '`<div id="poker-info"></div>`;', '`<div id="poker-info" class="felt"></div>`;');
      expect(await problemsOf(twoFelts)).toContain("not exactly one felt element");
    });

    it("repeating the private cards in the information panel is caught", async () => {
      const twice = unsafeCopy(POKER_JS, '${buildSeatsHtml(state, mySeatNumber)}${buildRoomHtml(state)}</div>`', '${buildSeatsHtml(state, mySeatNumber)}${buildHandHtml(state, mySeatNumber)}${buildRoomHtml(state)}</div>`');
      expect(await problemsOf(twice)).toContain("the private cards are duplicated");
    });

    const CHROME = "return [buildTurnHtml(turn), buildPotHtml(state), buildBoardHtml(state), buildHandHtml(state, mySeatNumber)].join(\"\");";

    it("the player list inside the green table is caught", async () => {
      const unsafe = unsafeCopy(POKER_JS, CHROME, "return [buildTurnHtml(turn), buildPotHtml(state), buildBoardHtml(state), buildHandHtml(state, mySeatNumber), buildSeatsHtml(state, mySeatNumber)].join(\"\");");
      expect(await problemsOf(unsafe)).toContain(".seat-list is inside the table");
    });

    it("a nested card or panel inside the green table is caught", async () => {
      const unsafe = unsafeCopy(POKER_JS, CHROME, "return [buildTurnHtml(turn), buildPotHtml(state), buildBoardHtml(state), buildHandHtml(state, mySeatNumber)].join(\"\") + '<div class=\"pk-panel\"></div>';");
      expect(await problemsOf(unsafe)).toContain("a nested card or panel is inside the table");
    });

    it("a table without its community cards (or its pot, or its turn indication) is caught", async () => {
      const noBoard = unsafeCopy(POKER_JS, CHROME, "return [buildTurnHtml(turn), buildPotHtml(state), buildHandHtml(state, mySeatNumber)].join(\"\");");
      expect(await problemsOf(noBoard)).toContain("community cards is not inside the table");
      const noPot = unsafeCopy(POKER_JS, CHROME, "return [buildTurnHtml(turn), buildBoardHtml(state), buildHandHtml(state, mySeatNumber)].join(\"\");");
      expect(await problemsOf(noPot)).toContain("pot is not inside the table");
      const noTurn = unsafeCopy(POKER_JS, CHROME, "return [buildPotHtml(state), buildBoardHtml(state), buildHandHtml(state, mySeatNumber)].join(\"\");");
      expect(await problemsOf(noTurn)).toContain("turn indication is not inside the table");
    });

    it("turning a section inside the felt into its own card (background, border, rounded corners) is caught", () => {
      expect(sectionCardProblems(PARTICIPANT_HTML)).toEqual([]);
      for (const added of [".pk-root .pk-table .pk-sec { background: var(--pk-surface); }", ".pk-root .pk-hand { border: 1px solid var(--pk-line); }", ".pk-root .pk-actionbar { border-radius: 14px; }", ".pk-root .pk-potrow { box-shadow: 0 0 4px #000; }", ".pk-root .pk-board { background: var(--pk-surface); border: 1px solid var(--pk-line); border-radius: 12px; }", ".pk-root .pk-pot { background: var(--pk-surface); }", ".pk-root .pk-turnline { border-left: 3px solid #fff; }", ".pk-root .pk-hand { outline: 1px solid #fff; }"]) {
        const mutated = PARTICIPANT_HTML.replace("/* POKER-PLAYER-TABLE-UI:END */", `${added}\n  /* POKER-PLAYER-TABLE-UI:END */`);
        expect(mutated).not.toBe(PARTICIPANT_HTML);
        expect(sectionCardProblems(mutated), added).not.toEqual([]);
      }
    });

    it("a green background anywhere but the table panel is caught by the felt-only check", () => {
      const GREEN = /var\(--pk-felt\)|var\(--pk-felt-deep\)|var\(--pk-felt-line\)|radial-gradient/;
      const offenders = (html: string) => pokerRules(html).filter((r) => GREEN.test(r.decl) && !(r.selectors.length === 1 && r.selectors[0] === ".pk-root .pk-table")).map((r) => r.selectors.join(", "));
      expect(offenders(PARTICIPANT_HTML)).toEqual([]);
      const mutated = PARTICIPANT_HTML.replace("/* POKER-PLAYER-TABLE-UI:END */", ".pk-root { background: var(--pk-felt); }\n  /* POKER-PLAYER-TABLE-UI:END */");
      expect(offenders(mutated)).toEqual([".pk-root"]);
    });
  });

  it("a card code that is not a card is shown as a face-down 'Unknown card', never as text or markup, on the board, in the hand and at showdown", async () => {
    const codes = ['<img src=x onerror="window.__xss=1">', 'AS"><b>', "ZZ", 7 as any, { a: 1 } as any];
    const hands: Record<string, Hand> = { "0": { cards: [codes[0], codes[1]] as any, rankName: "Pair", descr: "Pair" }, "1": { cards: ["KH", "KC"], rankName: "Pair", descr: "Pair" } };
    const board = turnState(FACING, { board: codes, myHoleCards: [codes[0], "QH"] });
    for (const s of [board, showdownState(["Maya", "Sam", "Alex", "Jordan"], SAM_WINS, hands)]) {
      const { win, container } = await mount(newTable(s));
      expect(violations(container)).toEqual([]);
      expect(win.__xss).toBeUndefined();
      expect(container.querySelectorAll('.playing-card.face-down[aria-label="Unknown card"]').length).toBeGreaterThanOrEqual(2);
      expect(container.querySelector(".playing-card:not(.face-down) .pk-rank")?.textContent ?? "").not.toMatch(/[<">]/);
    }
    // without the early guard those codes are drawn as faces (with a rank and an "undefined" suit) instead of face-down cards
    const unguarded = unsafeCopy(POKER_JS, 'if (typeof code !== "string" || !CARD_CODE.test(code)) {', "if (false) {");
    const { container } = await mountWith(unguarded, newTable(board));
    expect(container.querySelectorAll('.playing-card.face-down[aria-label="Unknown card"]').length).toBe(0);
    expect(allText(container)).toContain("undefined");
  });

  it("the controls change only their own copies: the shipped source still contains every protection", () => {
    for (const protection of ['escapeHtml(turn.name || "")', "${escapeHtml(winnerName)} won", "${escapeHtml(payeeName)} received", "p.textContent = line;", "actionMsg.textContent = text;", "const blocked = ctx.busy || ctx.stale;", "if (pot.eligibleSeatNumbers.length !== widest) continue;", '(payout[seatNumber] || 0) > 0 ? "showed" : "lost"', "(payees.length === 1 ? soleWinners : sharers).add(seatNumber)", "const usable = pots.length > 0 && pots.every(wellFormed);", "p.payouts.reduce((n, x) => n + x.amount, 0) === p.amount", "(state.seats || []).every((x) => x.seatNumber === sole || !x.inCurrentHand || x.folded)", "${escapeHtml(winnerName)} won", "if (ctx.busy) return;", 'verbs.explicitWinners.has(seatNumber) ? " pk-winner" : ""', "return escapeHtml(String(n));", "— ${escapeHtml(descr)}", "if (!container.contains(actionAreaEl)) return;", 'if (typeof code !== "string" || !CARD_CODE.test(code)) {']) {
      expect(POKER_JS).toContain(protection);
    }
  });
});

// ---------------------------------------------------------------------------------------------------------------------------------
// 8. Styling stays Poker-scoped and identical in both pages
// ---------------------------------------------------------------------------------------------------------------------------------

function pokerBlock(html: string): string {
  const begin = html.indexOf("/* POKER-PLAYER-TABLE-UI:BEGIN");
  const end = html.indexOf("/* POKER-PLAYER-TABLE-UI:END */");
  expect(begin, "begin marker").toBeGreaterThan(-1);
  expect(end, "end marker").toBeGreaterThan(begin);
  return html.slice(begin, end + "/* POKER-PLAYER-TABLE-UI:END */".length);
}

/** The rules of the Poker CSS block (comments stripped, @media flattened): each rule's selector list and its declarations. */
function pokerRules(html: string): Array<{ selectors: string[]; decl: string }> {
  const css = pokerBlock(html).replace(/\/\*[\s\S]*?\*\//g, "");
  const out: Array<{ selectors: string[]; decl: string }> = [];
  for (const m of css.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    const head = m[1].trim();
    if (head.startsWith("@")) continue;
    out.push({ selectors: head.split(",").map((x) => x.trim()), decl: m[2].replace(/\s+/g, " ").trim() });
  }
  return out;
}
/** The style text of participant.html with the Poker block cut out: what the rest of the page (including Session) still styles. */
function styleOutsideBlock(html: string): string {
  const begin = html.indexOf("/* POKER-PLAYER-TABLE-UI:BEGIN");
  const end = html.indexOf("/* POKER-PLAYER-TABLE-UI:END */") + "/* POKER-PLAYER-TABLE-UI:END */".length;
  const without = html.slice(0, begin) + html.slice(end);
  return without.slice(without.indexOf("<style>") + 7, without.indexOf("</style>")).replace(/\/\*[\s\S]*?\*\//g, "");
}

describe("Poker styling", () => {
  it("is the same block in participant.html and poker-table.html, so the two pages cannot drift apart", () => {
    expect(pokerBlock(PARTICIPANT_HTML)).toBe(pokerBlock(POKER_TABLE_HTML));
  });

  it("every selector hangs off .pk-root, so it cannot reach Session UI or any shared rule", () => {
    const css = pokerBlock(PARTICIPANT_HTML).replace(/\/\*[\s\S]*?\*\//g, "");
    const selectors: string[] = [];
    // flatten @media: take every `selector {` that is not an at-rule, and every `{` that opens a declaration block
    for (const match of css.matchAll(/([^{}]+)\{/g)) {
      const head = match[1].trim();
      if (head.startsWith("@")) continue;
      selectors.push(...head.split(",").map((x) => x.trim()));
    }
    expect(selectors.length).toBeGreaterThan(40);
    expect(selectors.filter((x) => !x.startsWith(".pk-root"))).toEqual([]);
    // the one selector that leaves the .pk-root subtree (a sibling combinator) is the room's own exit button, on purpose
    expect(selectors.filter((x) => /[~+](?!\d)/.test(x) && x.startsWith(".pk-root ~"))).toEqual([".pk-root ~ .btn-ghost"]);
    expect(selectors.filter((x) => /^\.pk-root\s*[~+>]/.test(x))).toEqual([".pk-root ~ .btn-ghost"]);
  });

  it("pins and overlays nothing: no sticky or fixed positioning (prefixed or not), no clip-path, no z-index, two absolutely positioned elements (the hidden live region and the small stale tag inside the table's own reserved band), no shadow spread beyond a 6px focus ring", () => {
    const css = pokerBlock(PARTICIPANT_HTML).replace(/\/\*[\s\S]*?\*\//g, "");
    expect(css).not.toMatch(/position\s*:\s*(-webkit-)?(sticky|fixed)/);
    expect(css).not.toMatch(/clip-path|100vmax|z-index/);
    // the only absolutely positioned elements are the visually hidden live region and the "Out of date" tag
    const absolute = css.match(/[^{}]*\{[^{}]*position\s*:\s*absolute[^{}]*\}/g) ?? [];
    expect(absolute).toHaveLength(2);
    expect(absolute.filter((r) => r.includes(".pk-sr-only"))).toHaveLength(1);
    expect(absolute.filter((r) => r.includes(".pk-stale-tag"))).toHaveLength(1);
    // the tag lies wholly inside the band the table reserves for it (its top padding), so it covers no content, and it takes no taps
    for (const html of [PARTICIPANT_HTML, POKER_TABLE_HTML]) {
      const rules = pokerRules(html);
      const tag = rules.find((r) => r.selectors.includes(".pk-root .pk-stale-tag"))!.decl;
      const table = rules.find((r) => r.selectors.includes(".pk-root .pk-table"))!.decl;
      expect(table).toMatch(/position:\s*relative/);
      expect(tag).toContain("pointer-events: none");
      const top = Number(/(?:^|[; ])top:\s*(\d+)px/.exec(tag)?.[1]);
      const line = Number(/line-height:\s*(\d+)px/.exec(tag)?.[1]);
      const border = Number(/border:\s*(\d+)px/.exec(tag)?.[1]);
      const tagPad = Number(/padding:\s*(\d+)/.exec(tag)?.[1]); // the first value of the shorthand is the vertical padding
      const band = Number(/padding:\s*(\d+)px/.exec(table)?.[1]); // the first value of the shorthand is the top padding
      expect(top + line + 2 * tagPad + 2 * border).toBeLessThanOrEqual(band);
    }
    // a box-shadow with a spread (its 4th length) is how a bar could be painted past the page; only the focus ring may have one
    for (const rule of pokerRules(PARTICIPANT_HTML)) {
      for (const m of rule.decl.matchAll(/box-shadow\s*:\s*([^;]+)/g)) {
        let depth = 0;
        let current = "";
        const layers: string[] = [];
        for (const ch of m[1]) {
          if (ch === "(") depth++;
          if (ch === ")") depth--;
          if (ch === "," && depth === 0) { layers.push(current); current = ""; } else current += ch;
        }
        layers.push(current);
        for (const layer of layers) {
          const lengths = layer.replace(/(rgba?|var)\([^)]*\)/g, "").split(/\s+/).filter((t) => /^-?\d/.test(t)).map(parseFloat);
          if (lengths.length >= 4) expect(Math.abs(lengths[3]), layer).toBeLessThanOrEqual(6);
        }
      }
    }
  });

  it("keeps what the small-screen gate asks to preserve: touch targets, visible focus, scroll margin, font inheritance, wrapping", () => {
    for (const html of [PARTICIPANT_HTML, POKER_TABLE_HTML]) {
      const rules = pokerRules(html);
      const decl = (selector: string) => rules.find((r) => r.selectors.includes(selector))?.decl ?? "";
      const px = (d: string, prop: string) => Number(new RegExp(`(?:^|[; ])${prop}\\s*:\\s*(\\d+)px`).exec(d)?.[1]);
      // touch targets
      expect(px(decl(".pk-root .action-btn"), "min-height")).toBeGreaterThanOrEqual(44);
      expect(px(decl(".pk-root #amount-input"), "min-height")).toBeGreaterThanOrEqual(44);
      // the page's own "Join a different room" button follows the Poker container and gets the same minimum
      expect(px(decl(".pk-root ~ .btn-ghost"), "min-height")).toBeGreaterThanOrEqual(44);
      // the Poker controls inherit the page font (poker-table.html has no global button/input font rule)
      expect(decl(".pk-root .action-btn")).toContain("font-family: inherit");
      expect(decl(".pk-root #amount-input")).toContain("font-family: inherit");
      // visible keyboard focus
      expect(decl(".pk-root button:focus-visible")).toMatch(/outline:\s*3px solid/);
      expect(decl(".pk-root input:focus-visible")).toMatch(/outline:\s*3px solid/);
      // a focused amount field scrolls into view with room below it for the help line and the Bet/Raise button it feeds
      const margin = /scroll-margin\s*:\s*(\d+)px\s+\d+(?:px)?\s+(\d+)px/.exec(decl(".pk-root #amount-input"));
      expect(Number(margin?.[2])).toBeGreaterThanOrEqual(100);
      // no horizontal overflow from long names, large numbers or a narrow phone
      expect(decl(".pk-root .seat-name")).toContain("overflow-wrap: anywhere");
      expect(decl(".pk-root .seat-name")).toContain("min-width: 0");
      expect(decl(".pk-root .action-bar")).toContain("grid-template-columns: repeat(2, minmax(0, 1fr))");
      expect(decl(".pk-root .action-btn")).toContain("overflow-wrap: anywhere");
      expect(decl(".pk-root .pk-title")).toContain("flex-wrap: wrap");
      // hidden stays hidden, and a disabled button stays readable
      expect(decl(".pk-root [hidden]")).toMatch(/display:\s*none\s*!important/);
      expect(decl(".pk-root .action-btn:disabled")).toContain("opacity: 1");
      // the action panel is ordinary flow
      expect(decl(".pk-root .pk-actionbar")).not.toContain("position");
    }
  });

  it("brings in nothing from outside and animates nothing", () => {
    const css = pokerBlock(PARTICIPANT_HTML);
    expect(css).not.toMatch(/@import|url\(|https?:|@keyframes|animation\s*:/);
  });

  /** The rules of a stylesheet text as [selector list, declarations] pairs (flattening @media). */
  const rulesOf = (css: string) => Array.from(css.matchAll(/([^{}]+)\{([^{}]*)\}/g)).filter((m) => !m[1].trim().startsWith("@") && !/^\d+%$|^(from|to)$/.test(m[1].trim())).map((m) => ({ selectors: m[1].split(",").map((x) => x.trim()), decl: m[2].replace(/\s+/g, " ").trim() }));

  it("in either page, no rule outside the Poker block styles a Poker class or element id, or uses the felt colours", () => {
    const POKER_CLASSES = ["seat-row", "seat-name", "seat-stack", "seat-badge", "seat-list", "action-btn", "action-bar", "amount-row", "amount-label", "amount-help", "playing-card", "hole-cards", "board-cards", "felt", "pot-row", "street-label", "status-pill", "poker-result-card", "poker-result-row", "poker-result-win", "pk-root"];
    const POKER_IDS = ["poker-container", "poker-panels", "table-card", "poker-table", "poker-info", "poker-chrome", "poker-action-area", "poker-notice", "poker-live", "amount-input"];
    for (const html of [PARTICIPANT_HTML, POKER_TABLE_HTML]) {
      const outside = rulesOf(styleOutsideBlock(html));
      expect(outside.length).toBeGreaterThan(15); // a real stylesheet was scanned (poker-table.html has about 26 rules outside the block, participant.html about 105)
      const selectors = outside.flatMap((r) => r.selectors);
      expect(selectors.filter((sel) => POKER_CLASSES.some((c) => new RegExp(`\\.${c}(?![\\w-])`).test(sel)))).toEqual([]);
      expect(selectors.filter((sel) => POKER_IDS.some((id) => new RegExp(`#${id}(?![\\w-])`).test(sel)))).toEqual([]);
      // nothing outside the block paints the felt: no felt colour, and no gradient on the page itself
      for (const r of outside) {
        expect(r.decl, r.selectors.join(", ")).not.toMatch(/#0f3a28|#0a2a1d|#1f5a40|pk-felt/i);
        if (r.selectors.some((x) => /^(html|body|:root)\b/.test(x))) expect(r.decl, r.selectors.join(", ")).not.toMatch(/gradient|green/i);
      }
    }
    // the module sets no inline style and no style property of its own, so there is no way to paint outside the stylesheet
    expect(POKER_JS).not.toMatch(/\.style\b|\bstyle=|cssText|setAttribute\(\s*["']style/);
  });

  it("the Session selectors beside the Poker block are still there", () => {
    for (const html of [PARTICIPANT_HTML]) {
      const selectors = rulesOf(styleOutsideBlock(html)).flatMap((r) => r.selectors);
      for (const sessionSelector of [".card", ".option-btn", ".stepper", ".prompt-text", ".sr-only", ".winner-banner.tone-neutral"]) {
        expect(selectors, sessionSelector).toContain(sessionSelector);
      }
    }
  });

  it("keeps the retained .msg rules and the --good/--bad tokens unchanged (whitespace aside) in both pages, and the Poker block overrides every property they declare", () => {
    const RETAINED = [".msg { font-size: 13px; color: var(--muted); margin: 10px 0 0; line-height: 1.5; }", ".msg.error { color: var(--bad); }", ".msg.success { color: var(--good); }", "--good: #4ade80; --bad: #f87171;"];
    for (const html of [PARTICIPANT_HTML, POKER_TABLE_HTML]) {
      const outside = styleOutsideBlock(html).replace(/\s+/g, " ");
      for (const rule of RETAINED) expect(outside, rule).toContain(rule);
      // inside Poker the retained .msg is fully overridden (same properties, higher specificity), and .msg.error too
      const rules = pokerRules(html);
      const poker = rules.find((r) => r.selectors.includes(".pk-root .msg"))!.decl;
      for (const property of ["font-size", "color", "margin", "line-height"]) expect(poker, property).toContain(`${property}:`);
      expect(rules.find((r) => r.selectors.includes(".pk-root .msg.error"))!.decl).toContain("color:");
      // .msg.success ties .pk-root .msg on specificity and loses only on source order, so the Poker block must come later
      expect(html.indexOf(".msg.success {")).toBeLessThan(html.indexOf("/* POKER-PLAYER-TABLE-UI:BEGIN"));
    }
    // and the module never emits a success message, which is the only way that tie could show
    expect(POKER_JS).not.toMatch(/msg success/);
  });

  it("the module is the only place Poker markup is produced: both pages still just call it", () => {
    for (const html of [PARTICIPANT_HTML, POKER_TABLE_HTML]) {
      expect(html).toContain('<script src="/pokerParticipant.js"></script>');
      expect(html).toContain("PokerParticipant.renderPokerTable(");
    }
  });
});

// ---------------------------------------------------------------------------------------------------------------------------------
// 9. participant.html, loaded whole: the shared page still routes Poker and Session separately
// ---------------------------------------------------------------------------------------------------------------------------------

type PageOptions = { runtime: "POKER_TABLE" | "SESSION" | null; table?: Table; sessionReply?: Reply };

async function loadParticipantPage({ runtime, table, sessionReply }: PageOptions) {
  const calls: Call[] = [];
  const dom = new JSDOM(PARTICIPANT_HTML, {
    url: "http://localhost/participant.html",
    runScripts: "dangerously",
    pretendToBeVisual: true,
    virtualConsole: quiet(),
    beforeParse(window) {
      const w = window as any;
      w.scrollTo = () => {}; // jsdom does not implement it; the page calls it when it shows a panel
      if (runtime === "POKER_TABLE") {
        w.sessionStorage.setItem("urbano_gaming_active_runtime_type", "POKER_TABLE");
        w.sessionStorage.setItem("urbano_poker_seat", JSON.stringify(SEAT));
      } else if (runtime === "SESSION") {
        w.sessionStorage.setItem("urbano_gaming_active_runtime_type", "SESSION");
        w.sessionStorage.setItem("urbano_gaming_dev_harness_participant", JSON.stringify({ sessionId: "sess-1", participantId: "p-1", participantToken: "tok", displayName: "Pat" }));
      }
      w.fetch = (url: string, init: any = {}) => {
        const call: Call = { url: String(url), method: init.method ?? "GET", headers: init.headers ?? {}, body: init.body ? JSON.parse(init.body) : undefined };
        calls.push(call);
        const reply = (r: Reply) => Promise.resolve({ status: r.status, json: async () => r.json });
        if (/\/api\/gaming\/poker\/tables\/[^/]+$/.test(call.url) && table) return reply(table.getReply ?? { status: 200, json: table.state });
        if (/\/api\/sessions\/sess-1$/.test(call.url) && sessionReply) return reply(sessionReply);
        return reply({ status: 404, json: { error: "not available in this test" } });
      };
      w.eval(SESSION_SYNC_JS);
      w.eval(POKER_JS);
    },
  });
  windows.push(dom.window);
  return { win: dom.window as any, doc: dom.window.document, calls };
}

describe("participant.html (whole page)", () => {
  it("restores a Poker seat: the Poker panel shows the table through the shared module and Session UI stays out of the way", async () => {
    const { win, doc, calls } = await loadParticipantPage({ runtime: "POKER_TABLE", table: newTable(turnState()) });
    const container = doc.getElementById("poker-container")!;
    await until(() => container.querySelector("#poker-chrome .pk-pot-value") !== null, "Poker table rendered");
    // the page's own exit button is the next sibling of the Poker container, and the Poker block gives it a 44px touch target
    const exit = doc.querySelector("#poker-container ~ .btn-ghost") as HTMLElement;
    expect(exit.textContent).toContain("Join a different room");
    expect(win.getComputedStyle(exit).minHeight).toBe("44px");
    expect((doc.getElementById("poker-panels") as HTMLElement).style.display).toBe("block");
    expect((doc.getElementById("game-panels") as HTMLElement).style.display).not.toBe("block");
    expect(container.classList.contains("pk-root")).toBe(true);
    expect(actionNames(container)).toEqual(["FOLD", "CALL", "RAISE", "ALL_IN"]);
    expect(calls.some((c) => /\/api\/sessions\//.test(c.url))).toBe(false);
    expect(doc.querySelector(".btn-ghost")!.textContent).toContain("Join a different room");
  });

  it("the page's own poller keeps a typed amount, and a failed poll keeps the table and blocks actions", async () => {
    const t = newTable(turnState());
    const { win, doc } = await loadParticipantPage({ runtime: "POKER_TABLE", table: t });
    const container = doc.getElementById("poker-container")!;
    await until(() => container.querySelector("#amount-input") !== null, "Poker table rendered");
    const field = input(container);
    field.value = "91";
    await win.eval("pokerSync.refreshNow()");
    await until(() => true, "poll");
    expect(input(container)).toBe(field);
    expect(field.value).toBe("91");

    t.getReply = { status: 500, json: { error: "Server error." } };
    await win.eval("pokerSync.refreshNow()");
    await until(() => !(container.querySelector("#poker-notice") as HTMLElement).hidden, "notice");
    expect(actions(container).every((b) => b.disabled)).toBe(true);
    expect(input(container)).toBe(field);
    expect(field.value).toBe("91");
  });

  it("poker-table.html (the standalone page) renders the same table through the same module", async () => {
    const dom = new JSDOM(POKER_TABLE_HTML, {
      url: "http://localhost/poker-table.html",
      runScripts: "dangerously",
      pretendToBeVisual: true,
      virtualConsole: quiet(),
      beforeParse(window) {
        const w = window as any;
        w.scrollTo = () => {};
        w.sessionStorage.setItem("urbano_poker_seat", JSON.stringify(SEAT));
        installFetch(w, newTable(turnState()));
        w.eval(SESSION_SYNC_JS);
        w.eval(POKER_JS);
      },
    });
    windows.push(dom.window);
    const doc = dom.window.document;
    const container = doc.getElementById("table-card")!;
    await until(() => container.querySelector(".pk-pot-value") !== null, "table rendered");
    expect(container.classList.contains("pk-root")).toBe(true);
    expect(actionNames(container)).toEqual(["FOLD", "CALL", "RAISE", "ALL_IN"]);
    expect((doc.getElementById("join-card") as HTMLElement).style.display).toBe("none");
    expect((doc.getElementById("table-card") as HTMLElement).style.display).toBe("block");
  });

  it("restores a Session: the Poker panel stays hidden, no Poker request is made, and no Poker styling hook is applied on load", async () => {
    const session = {
      sessionId: "sess-1", state: "LOBBY_OPEN", participants: [{ participantId: "p-1", displayName: "Pat" }], interactions: [], currentInteraction: null,
      title: "Synthetic", roomCode: "ABC234",
    };
    const { doc, calls } = await loadParticipantPage({ runtime: "SESSION", sessionReply: { status: 200, json: session } });
    await until(() => calls.some((c) => /\/api\/sessions\/sess-1$/.test(c.url)), "Session fetched");
    // the Session itself was restored: its panels are shown and the join form is not (so this is not just the untouched markup)
    await until(() => (doc.getElementById("game-panels") as HTMLElement).style.display === "block", "Session panels shown");
    expect((doc.getElementById("join-panel") as HTMLElement).style.display).toBe("none");
    expect((doc.getElementById("poker-panels") as HTMLElement).style.display).toBe("none");
    expect(calls.some((c) => /\/api\/gaming\/poker\//.test(c.url))).toBe(false);
    expect(doc.querySelector(".pk-root")).toBeNull();
    expect(doc.getElementById("poker-container")!.innerHTML).toBe("");
  });
});
