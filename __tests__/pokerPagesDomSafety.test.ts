import { afterEach, describe, expect, it } from "vitest";
import { JSDOM, VirtualConsole } from "jsdom";
import { readFileSync } from "node:fs";
import path from "node:path";

/**
 * Poker player-name DOM safety. A Poker seat name is chosen by whoever joins (the join route is unauthenticated and the name is only
 * trimmed and capped at 40 characters), and it is then shown to the host and to every other player. Every place the Poker surfaces
 * render it must therefore produce literal text.
 *
 * These tests run the ACTUAL shipped files in jsdom — host.html and poker-host.html whole, pokerParticipant.js evaluated into a window the
 * way a browser's <script> tag would — and assert on the resulting DOM STRUCTURE (which elements exist, which attributes they carry, the
 * exact text), never on whether an injected script happened to run.
 */

const read = (relative: string) => readFileSync(path.join(process.cwd(), relative), "utf8");
const HOST_HTML = read("public/host.html");
const POKER_HOST_HTML = read("public/poker-host.html");
const POKER_PARTICIPANT_JS = read("public/pokerParticipant.js");
const SESSION_SYNC_JS = read("public/sessionSync.js");

const TABLE_ID = "11111111-2222-3333-4444-555555555555";
const HAND_ID = "66666666-7777-8888-9999-000000000000";
const HOST_TOKEN = "synthetic-host-token";
const SEAT_TOKEN = "synthetic-seat-token";

/** Synthetic hostile names. The server caps a name at 40 characters, so the short ones are what an attacker could actually submit. */
const HOSTILE_NAMES: Array<{ label: string; value: string }> = [
  { label: "img onerror", value: '<img src=x onerror="window.__xss=1">' },
  { label: "attribute-breakout script", value: '"><script>window.__xss=1</script>' },
  { label: "svg onload", value: '<svg onload="window.__xss=1">' },
  { label: "benign tag", value: "<b>bold</b>" },
  { label: "bare attribute-breakout", value: '" onmouseover="window.__xss=1" x="' },
  { label: "javascript link", value: '<a href="javascript:window.__xss=1">x</a>' },
  { label: "container breakout", value: "</span></div><img src=x onerror=1>" },
  { label: "table-cell breakout", value: "</td><td><img src=x onerror=1>" },
];

/** Ordinary names that must be shown exactly as typed, including characters that are special in HTML. */
const ORDINARY_NAMES: Array<{ label: string; value: string }> = [
  { label: "plain", value: "Alex" },
  { label: "accents", value: "María José" },
  { label: "diacritics", value: "Zoë Łukasz" },
  { label: "CJK", value: "李雷" },
  { label: "emoji", value: "Pat 😀" },
  { label: "apostrophe", value: "O'Brien" },
  { label: "ampersand", value: "Tom & Jerry" },
  { label: "double quotes", value: 'Ben "The Bluff" Neil' },
  { label: "angle brackets as text", value: "5 > 3 and 2 < 4" },
  { label: "leading less-than", value: "<3 poker" },
  { label: "literal entity text", value: "&lt;b&gt; &amp; &#39;" },
];

type FetchCall = { url: string; method: string; headers: Record<string, string>; body: any };
type Responder = (call: FetchCall) => { status: number; json: unknown };

const openWindows: Array<{ close(): void }> = [];
afterEach(() => {
  while (openWindows.length) openWindows.pop()!.close();
});

/** The pages log their own diagnostics (e.g. the shared poller's start message); keep that out of the test output but surface real page errors. */
function quietConsole() {
  const virtualConsole = new VirtualConsole();
  virtualConsole.on("jsdomError", (error) => console.error(error));
  return virtualConsole;
}

function installFetch(win: any, respond: Responder): FetchCall[] {
  const calls: FetchCall[] = [];
  win.fetch = async (url: string, init: any = {}) => {
    const call: FetchCall = {
      url: String(url),
      method: init.method ?? "GET",
      headers: init.headers ?? {},
      body: init.body ? JSON.parse(init.body) : undefined,
    };
    calls.push(call);
    const out = respond(call);
    return { status: out.status, json: async () => out.json };
  };
  return calls;
}

function seatsFor(names: string[], extra: Record<string, unknown> = {}) {
  return names.map((displayName, i) => ({
    seatNumber: i,
    displayName,
    isDealer: i === 0,
    inCurrentHand: true,
    stack: 1000 - i * 10,
    committedThisHand: i * 10,
    committedThisStreet: 0,
    folded: false,
    allIn: false,
    isCurrentActor: i === 1,
    revealedHoleCards: null,
    ...extra,
  }));
}

/** A live (mid-hand) table state shaped like getTableState's response. */
function liveState(names: string[], overrides: Record<string, unknown> = {}) {
  return {
    pokerTableId: TABLE_ID,
    roomCode: "ABC234",
    maxSeats: 6,
    closedAt: null,
    startingStack: 1000,
    smallBlind: 5,
    bigBlind: 10,
    seats: seatsFor(names),
    currentHandId: HAND_ID,
    currentHandOrdinal: 1,
    street: "FLOP",
    board: ["AS", "KD", "7C"],
    pot: 30,
    myHoleCards: ["AH", "KH"],
    myLegalActions: null,
    handResult: null,
    ...overrides,
  };
}

/** An idle table state (no hand in progress), so the host's Start Hand and End Table controls are enabled. */
function idleState(names: string[]) {
  return liveState(names, { currentHandId: null, currentHandOrdinal: null, street: null, board: [], pot: 0, myHoleCards: null });
}

/** A completed hand that reached a real showdown; seat 0 is the viewer, so its own line reads "You". */
function showdownState(names: string[]) {
  const showdownHands: Record<string, { cards: [string, string]; rankName: string; descr: string }> = {};
  names.forEach((_, i) => {
    showdownHands[String(i)] = { cards: ["AH", "KH"], rankName: "Pair", descr: "Pair, A's" };
  });
  return liveState(names, {
    street: "COMPLETE",
    board: ["AS", "KD", "7C", "2H", "9S"],
    seats: seatsFor(names, { revealedHoleCards: ["AH", "KH"] }),
    handResult: {
      pokerHandId: HAND_ID,
      board: ["AS", "KD", "7C", "2H", "9S"],
      pots: [{ amount: 60, eligibleSeatNumbers: [0, 1], payouts: [{ seatNumber: 1, amount: 60 }] }],
      showdownHands,
      completedAt: "2026-11-03T12:00:00.000Z",
    },
  });
}

/**
 * Structural problems anywhere under `root`: an element outside the tags this surface authors, or any event-handler attribute. An empty
 * list means nothing was injected — whether or not a script would have run.
 */
function structureViolations(root: Element, allowedTags: string[]): string[] {
  const problems: string[] = [];
  for (const el of Array.from(root.querySelectorAll("*"))) {
    const tag = el.tagName.toLowerCase();
    if (!allowedTags.includes(tag)) problems.push(`unexpected <${tag}>`);
    for (const attr of Array.from(el.attributes)) {
      if (attr.name.toLowerCase().startsWith("on")) problems.push(`<${tag}> carries ${attr.name}`);
    }
  }
  return problems;
}

/** The text nodes that are DIRECT children of `el`, joined — what was written as text rather than as nested markup. */
function ownText(el: Element): string {
  return Array.from(el.childNodes)
    .filter((n) => n.nodeType === 3)
    .map((n) => n.nodeValue ?? "")
    .join("");
}

const PARTICIPANT_TAGS = ["div", "span", "p", "button", "input", "label"];
const HOST_TABLE_TAGS = ["tr", "td", "span"];

// ---------------------------------------------------------------------------------------------------------------------------------
// pokerParticipant.js — the seat list and the showdown lines every player sees (participant.html and poker-table.html both use it)
// ---------------------------------------------------------------------------------------------------------------------------------

async function renderForPlayer(state: unknown, source = POKER_PARTICIPANT_JS) {
  const dom = new JSDOM('<!doctype html><html><body><div id="c"></div></body></html>', {
    url: "http://localhost/participant.html",
    runScripts: "outside-only",
    pretendToBeVisual: true,
    virtualConsole: quietConsole(),
  });
  openWindows.push(dom.window);
  const win = dom.window as any;
  const calls = installFetch(win, (call) =>
    call.method === "GET" ? { status: 200, json: state } : { status: 200, json: { pokerHandId: HAND_ID, alreadyApplied: false } }
  );
  win.eval(source);
  const container = win.document.getElementById("c") as HTMLElement;
  const seat = { pokerTableId: TABLE_ID, participantToken: SEAT_TOKEN, seatNumber: 0 };
  await win.PokerParticipant.renderPokerTable(container, seat);
  return { win, calls, container, seat };
}

describe("pokerParticipant.js — seat list", () => {
  describe.each(HOSTILE_NAMES)("hostile name: $label", ({ value }) => {
    it("is shown as literal text, creating no element and no event-handler attribute", async () => {
      const { win, container } = await renderForPlayer(liveState(["Host Player", value, "Ordinary"]));
      expect(structureViolations(container, PARTICIPANT_TAGS)).toEqual([]);
      const names = Array.from(container.querySelectorAll(".seat-name")).map(ownText);
      expect(names).toEqual(["Host Player (you)", value, "Ordinary"]);
      expect(win.__xss).toBeUndefined();
    });

    it("is also literal when it is the viewer's own name and when cards are revealed beside it", async () => {
      const { container } = await renderForPlayer(showdownState([value, "Ordinary"]));
      expect(structureViolations(container, PARTICIPANT_TAGS)).toEqual([]);
      const names = Array.from(container.querySelectorAll(".seat-name")).map(ownText);
      expect(names).toEqual([`${value} (you)`, "Ordinary"]);
    });
  });

  describe.each(ORDINARY_NAMES)("ordinary name: $label", ({ value }) => {
    it("is displayed exactly as typed", async () => {
      const { container } = await renderForPlayer(liveState(["Host Player", value]));
      expect(structureViolations(container, PARTICIPANT_TAGS)).toEqual([]);
      const names = Array.from(container.querySelectorAll(".seat-name")).map(ownText);
      expect(names).toEqual(["Host Player (you)", value]);
    });
  });
});

describe("pokerParticipant.js — showdown lines", () => {
  const rowTexts = (container: HTMLElement) =>
    Array.from(container.querySelectorAll(".poker-result-row span"))
      .map((s) => s.textContent ?? "")
      .filter((t) => / (won|lost) — /.test(t));

  describe.each(HOSTILE_NAMES)("hostile name: $label", ({ value }) => {
    it("is shown as literal text in the showdown message", async () => {
      const { container } = await renderForPlayer(showdownState(["Host Player", value, "Ordinary"]));
      expect(structureViolations(container, PARTICIPANT_TAGS)).toEqual([]);
      expect(rowTexts(container)).toEqual(["You lost — Pair, A's", `${value} won — Pair, A's`, "Ordinary lost — Pair, A's"]);
    });
  });

  describe.each(ORDINARY_NAMES)("ordinary name: $label", ({ value }) => {
    it("is displayed exactly as typed in the showdown message", async () => {
      const { container } = await renderForPlayer(showdownState(["Host Player", value]));
      expect(structureViolations(container, PARTICIPANT_TAGS)).toEqual([]);
      expect(rowTexts(container)).toEqual(["You lost — Pair, A's", `${value} won — Pair, A's`]);
    });
  });
});

describe("pokerParticipant.js — existing controls still work", () => {
  const LEGAL = { canFold: true, canCheck: false, canCall: true, callAmount: 10, canBet: false, canRaise: true, minRaiseTo: 20, canAllIn: true, maxAmount: 990 };

  it("Call sends the seat's own token and action even with a hostile-named seat at the table", async () => {
    const hostile = HOSTILE_NAMES[0].value;
    const { container, calls } = await renderForPlayer(liveState(["Host Player", hostile], { myLegalActions: LEGAL }));
    const buttons = Array.from(container.querySelectorAll<HTMLButtonElement>("#poker-action-area .action-btn")).map((b) => b.dataset.action);
    expect(buttons).toEqual(["FOLD", "CALL", "RAISE", "ALL_IN"]);

    container.querySelector<HTMLButtonElement>('[data-action="CALL"]')!.click();
    await new Promise((r) => setTimeout(r, 0));
    const post = calls.find((c) => c.method === "POST")!;
    expect(post.url).toBe(`/api/gaming/poker/tables/${TABLE_ID}/action`);
    expect(post.headers.authorization).toBe(`Bearer ${SEAT_TOKEN}`);
    expect(post.body).toMatchObject({ pokerHandId: HAND_ID, actionType: "CALL", amount: null });
  });

  it("Raise sends the typed amount, and Enter in the amount field submits the same action", async () => {
    const { win, container, calls } = await renderForPlayer(liveState(["Host Player", "Ordinary"], { myLegalActions: LEGAL }));
    const input = container.querySelector<HTMLInputElement>("#amount-input")!;
    input.value = "40";
    container.querySelector<HTMLButtonElement>('[data-action="RAISE"]')!.click();
    await new Promise((r) => setTimeout(r, 0));
    expect(calls.filter((c) => c.method === "POST").map((c) => c.body)).toEqual([
      expect.objectContaining({ actionType: "RAISE", amount: 40 }),
    ]);

    const again = await renderForPlayer(liveState(["Host Player", "Ordinary"], { myLegalActions: LEGAL }));
    const field = again.container.querySelector<HTMLInputElement>("#amount-input")!;
    field.value = "55";
    field.dispatchEvent(new win.KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
    await new Promise((r) => setTimeout(r, 0));
    expect(again.calls.filter((c) => c.method === "POST").map((c) => c.body)).toEqual([
      expect.objectContaining({ actionType: "RAISE", amount: 55 }),
    ]);
  });

  it("a poll tick with an unchanged decision keeps the amount the player was typing", async () => {
    const state = liveState(["Host Player", HOSTILE_NAMES[0].value], { myLegalActions: LEGAL });
    const { win, container, seat } = await renderForPlayer(state);
    const input = container.querySelector<HTMLInputElement>("#amount-input")!;
    input.value = "77";
    await win.PokerParticipant.renderPokerTable(container, seat);
    expect(container.querySelector<HTMLInputElement>("#amount-input")).toBe(input);
    expect(input.value).toBe("77");
  });
});

// ---------------------------------------------------------------------------------------------------------------------------------
// host.html and poker-host.html — the seat table the host sees
// ---------------------------------------------------------------------------------------------------------------------------------

async function settleUntil(predicate: () => boolean, label: string, timeoutMs = 3000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    await new Promise((r) => setTimeout(r, 0));
    if (predicate()) return;
    if (Date.now() > deadline) throw new Error(`timed out waiting for: ${label}`);
  }
}

function hostResponder(state: unknown): Responder {
  return (call) => {
    if (call.method === "GET") return { status: 200, json: state };
    if (call.url.endsWith("/hand")) return { status: 200, json: { pokerHandId: HAND_ID, alreadyStarted: false } };
    if (call.url.endsWith("/close")) return { status: 200, json: { pokerTableId: TABLE_ID, closedAt: "2026-11-03T12:00:00.000Z", alreadyClosed: false } };
    return { status: 404, json: { error: "unexpected" } };
  };
}

/** host.html, loaded whole, restored (from tab storage) into an active Poker table, exactly as a reload mid-table would. */
async function loadHostPage(state: unknown, expectedRows: number, html = HOST_HTML) {
  let calls: FetchCall[] = [];
  const dom = new JSDOM(html, {
    url: "http://localhost/host.html",
    runScripts: "dangerously",
    pretendToBeVisual: true,
    virtualConsole: quietConsole(),
    beforeParse(window) {
      const w = window as any;
      w.sessionStorage.setItem("urbano_gaming_active_host_runtime_type", "POKER_TABLE");
      w.sessionStorage.setItem("urbano_gaming_host_poker", JSON.stringify({ pokerTableId: TABLE_ID, roomCode: "ABC234", hostToken: HOST_TOKEN }));
      calls = installFetch(w, hostResponder(state));
      w.confirm = () => true;
      w.eval(SESSION_SYNC_JS); // the real shared polling factory, as /sessionSync.js would define it
    },
  });
  openWindows.push(dom.window);
  const doc = dom.window.document;
  await settleUntil(() => doc.querySelectorAll("#pokerSeatsBody tr").length === expectedRows, "host seat rows");
  return { win: dom.window as any, doc, calls: () => calls, body: doc.getElementById("pokerSeatsBody") as HTMLElement };
}

/** poker-host.html, loaded whole, with the table it keeps in localStorage. */
async function loadStandaloneHostPage(state: unknown, expectedRows: number, html = POKER_HOST_HTML) {
  let calls: FetchCall[] = [];
  const dom = new JSDOM(html, {
    url: "http://localhost/poker-host.html",
    runScripts: "dangerously",
    pretendToBeVisual: true,
    virtualConsole: quietConsole(),
    beforeParse(window) {
      const w = window as any;
      w.localStorage.setItem("urbano_poker_host", JSON.stringify({ pokerTableId: TABLE_ID, roomCode: "ABC234", hostToken: HOST_TOKEN }));
      calls = installFetch(w, hostResponder(state));
      w.confirm = () => true;
    },
  });
  openWindows.push(dom.window);
  const doc = dom.window.document;
  await settleUntil(() => doc.querySelectorAll("#seats-body tr").length === expectedRows, "standalone host seat rows");
  return { win: dom.window as any, doc, calls: () => calls, body: doc.getElementById("seats-body") as HTMLElement };
}

/** Each row must be exactly five cells (seat, name, stack, in-hand, badges) with the name cell holding the literal name and nothing else. */
function expectSeatRows(body: HTMLElement, names: string[]) {
  expect(structureViolations(body, HOST_TABLE_TAGS)).toEqual([]);
  const rows = Array.from(body.querySelectorAll("tr"));
  expect(rows).toHaveLength(names.length);
  rows.forEach((row, i) => {
    expect(row.querySelectorAll("td")).toHaveLength(5);
    expect(row.children[0].textContent).toBe(String(i));
    expect(ownText(row.children[1])).toBe(names[i]);
    expect(row.children[1].children).toHaveLength(0);
  });
}

describe.each([
  { surface: "host.html (Poker host panel)", load: loadHostPage },
  { surface: "poker-host.html (standalone Poker host)", load: loadStandaloneHostPage },
])("$surface — seat table", ({ load }) => {
  describe.each(HOSTILE_NAMES)("hostile name: $label", ({ value }) => {
    it("is shown as literal text in its own cell, creating no element and no event-handler attribute", async () => {
      const names = ["Ordinary", value, "Another"];
      const { win, body } = await load(liveState(names), names.length);
      expectSeatRows(body, names);
      expect(win.__xss).toBeUndefined();
    });
  });

  describe.each(ORDINARY_NAMES)("ordinary name: $label", ({ value }) => {
    it("is displayed exactly as typed", async () => {
      const names = ["Ordinary", value];
      const { body } = await load(liveState(names), names.length);
      expectSeatRows(body, names);
    });
  });

  it("keeps the other cells and the badges intact", async () => {
    const names = ["Dealer Dan", HOSTILE_NAMES[0].value];
    const { body } = await load(liveState(names, { seats: seatsFor(names).map((s, i) => ({ ...s, allIn: i === 1 })) }), names.length);
    const rows = Array.from(body.querySelectorAll("tr"));
    expect(rows.map((r) => [r.children[2].textContent, r.children[3].textContent])).toEqual([["1000", "Yes"], ["990", "Yes"]]);
    expect(rows[0].children[4].textContent).toContain("Dealer");
    expect(rows[1].children[4].textContent).toContain("Acting");
    expect(rows[1].children[4].textContent).toContain("All-in");
  });
});

describe("host controls still work", () => {
  it("host.html: Start Hand and End Table send the host token to the right routes", async () => {
    const names = ["Ordinary", HOSTILE_NAMES[0].value];
    const { doc, calls, body } = await loadHostPage(idleState(names), names.length);

    (doc.getElementById("btn-poker-start-hand") as HTMLButtonElement).click();
    await settleUntil(() => calls().some((c) => c.url.endsWith("/hand")), "Start Hand request");
    const start = calls().find((c) => c.url.endsWith("/hand"))!;
    expect(start.method).toBe("POST");
    expect(start.url).toBe(`/api/gaming/poker/tables/${TABLE_ID}/hand`);
    expect(start.headers.authorization).toBe(`Bearer ${HOST_TOKEN}`);

    (doc.getElementById("btn-poker-end-table") as HTMLButtonElement).click();
    await settleUntil(() => calls().some((c) => c.url.endsWith("/close")), "End Table request");
    const end = calls().find((c) => c.url.endsWith("/close"))!;
    expect(end.method).toBe("POST");
    expect(end.headers.authorization).toBe(`Bearer ${HOST_TOKEN}`);
    expect(body.querySelectorAll("tr")).toHaveLength(names.length);
  });

  it("poker-host.html: Start Hand and End Table send the host token to the right routes", async () => {
    const names = ["Ordinary", HOSTILE_NAMES[0].value];
    const { doc, calls, body } = await loadStandaloneHostPage(idleState(names), names.length);

    (doc.getElementById("btn-start-hand") as HTMLButtonElement).click();
    await settleUntil(() => calls().some((c) => c.url.endsWith("/hand")), "Start Hand request");
    const start = calls().find((c) => c.url.endsWith("/hand"))!;
    expect(start.method).toBe("POST");
    expect(start.url).toBe(`/api/gaming/poker/tables/${TABLE_ID}/hand`);
    expect(start.headers.authorization).toBe(`Bearer ${HOST_TOKEN}`);

    (doc.getElementById("btn-end-table") as HTMLButtonElement).click();
    await settleUntil(() => calls().some((c) => c.url.endsWith("/close")), "End Table request");
    const end = calls().find((c) => c.url.endsWith("/close"))!;
    expect(end.method).toBe("POST");
    expect(end.headers.authorization).toBe(`Bearer ${HOST_TOKEN}`);
    expect(body.querySelectorAll("tr")).toHaveLength(names.length);
  });
});

// ---------------------------------------------------------------------------------------------------------------------------------
// Negative controls: each protection is removed from a COPY of the shipped source and the same checks are shown to catch it. A control
// that still passed would mean the checks above prove nothing.
// ---------------------------------------------------------------------------------------------------------------------------------

/** Replaces the single place `anchor` occurs; fails loudly if it occurs any other number of times, so a control can never silently no-op. */
function unsafeCopy(source: string, anchor: string | RegExp, replacement: string): string {
  const pattern = typeof anchor === "string" ? new RegExp(anchor.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "g") : new RegExp(anchor.source, "g");
  expect([...source.matchAll(pattern)], `mutation anchor must occur exactly once: ${String(anchor)}`).toHaveLength(1);
  const mutated = source.replace(pattern, () => replacement);
  expect(mutated).not.toBe(source);
  return mutated;
}

// The seat-row construction exactly as it was before the correction: the whole row parsed from one HTML string.
const ROW_BLOCK = /const tr = document\.createElement\("tr"\);[\s\S]*?tr\.appendChild\(badgesTd\);/;
const ORIGINAL_ROW =
  'const tr = document.createElement("tr");\n' +
  '    tr.innerHTML = `<td>${seat.seatNumber}</td><td>${seat.displayName}</td><td>${seat.stack}</td><td>${state.currentHandId && seat.inCurrentHand ? "Yes" : "—"}</td><td>${badges}</td>`;';

describe("negative controls — removing a protection is caught by the checks above", () => {
  const hostile = HOSTILE_NAMES[0].value;
  const names = ["Ordinary", hostile];

  it("host.html: building the row from one HTML string injects an element and a handler", async () => {
    const { body } = await loadHostPage(liveState(names), names.length, unsafeCopy(HOST_HTML, ROW_BLOCK, ORIGINAL_ROW));
    expect(structureViolations(body, HOST_TABLE_TAGS)).toEqual(expect.arrayContaining(["unexpected <img>", "<img> carries onerror"]));
  });

  it("poker-host.html: building the row from one HTML string injects an element and a handler", async () => {
    const { body } = await loadStandaloneHostPage(liveState(names), names.length, unsafeCopy(POKER_HOST_HTML, ROW_BLOCK, ORIGINAL_ROW));
    expect(structureViolations(body, HOST_TABLE_TAGS)).toEqual(expect.arrayContaining(["unexpected <img>", "<img> carries onerror"]));
  });

  it("pokerParticipant.js seat list: an unescaped name injects an element and a handler", async () => {
    const unsafe = unsafeCopy(POKER_PARTICIPANT_JS, "${escapeHtml(s.displayName)}", "${s.displayName}");
    const { container } = await renderForPlayer(liveState(["Host Player", hostile]), unsafe);
    expect(structureViolations(container, PARTICIPANT_TAGS)).toEqual(expect.arrayContaining(["unexpected <img>", "<img> carries onerror"]));
  });

  it("pokerParticipant.js showdown line: an unescaped name injects an element and a handler", async () => {
    const unsafe = unsafeCopy(POKER_PARTICIPANT_JS, "${escapeHtml(name)} ${outcome}", "${name} ${outcome}");
    const { container } = await renderForPlayer(showdownState(["Host Player", hostile]), unsafe);
    expect(structureViolations(container, PARTICIPANT_TAGS)).toEqual(expect.arrayContaining(["unexpected <img>", "<img> carries onerror"]));
  });

  it("the controls change only their own copies: the shipped sources still contain the protections", () => {
    expect(POKER_PARTICIPANT_JS).toContain("${escapeHtml(s.displayName)}");
    expect(POKER_PARTICIPANT_JS).toContain("${escapeHtml(name)} ${outcome}");
    expect(HOST_HTML).toMatch(ROW_BLOCK);
    expect(POKER_HOST_HTML).toMatch(ROW_BLOCK);
  });
});
