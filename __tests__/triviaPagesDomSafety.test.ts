import { afterEach, describe, expect, it } from "vitest";
import { JSDOM, VirtualConsole } from "jsdom";
import { readFileSync } from "node:fs";
import path from "node:path";

/**
 * Trivia rendering safety. Everything below is chosen by someone other than the page that shows it:
 *   - a participant's display name (the join route is unauthenticated and the name is only trimmed and capped at 40 characters);
 *   - a question's text and its options (typed or imported by the host, with no content filter);
 *   - the label of an answer shown in results (derived from the option picked, or the raw text for Open Response).
 * host.html and participant.html show them to the host and to every participant, so each renderer that does must produce LITERAL text:
 * no element, no attribute and no event handler may come out of the data, whatever characters it contains.
 *
 * These tests run the ACTUAL shipped pages whole in jsdom, restored from storage into a live Session exactly as a reload would, and fed
 * by the same GET /api/sessions/:id polling path the pages use in production — nothing is reimplemented. They assert on DOM STRUCTURE and
 * exact text, and additionally DISPATCH events on every rendered element: a handler attribute that survived into the DOM would run and set
 * the harmless marker `window.__xss`. (Events are what trigger inline handlers; jsdom does not load images, so a bare onerror would otherwise
 * never fire. Real-browser execution is verified separately in the validation report.)
 */

const read = (relative: string) => readFileSync(path.join(process.cwd(), relative), "utf8");
const HOST_HTML = read("public/host.html");
const PARTICIPANT_HTML = read("public/participant.html");
const SESSION_SYNC_JS = read("public/sessionSync.js");
const POKER_PARTICIPANT_JS = read("public/pokerParticipant.js");

const SESSION_ID = "11111111-2222-3333-4444-555555555555";
const HOST_TOKEN = "synthetic-host-token";
const PARTICIPANT_TOKEN = "synthetic-participant-token";
const ME = "pppppppp-0000-0000-0000-00000000000a";
const INTERACTION_ID = "iiiiiiii-0000-0000-0000-000000000001";

/** Harmless marker. Anything that runs it proves a handler was live. */
const MARK = "window.__xss=(window.__xss||0)+1";

/** Synthetic hostile values. Names are capped at 40 characters server-side; the longer ones can only arrive as question or option text. */
const HOSTILE: Array<{ label: string; value: string }> = [
  { label: "img onerror", value: `<img src=x onerror="${MARK}">` },
  { label: "attribute-breakout script", value: `"><script>${MARK}</script>` },
  { label: "svg onload", value: `<svg onload="${MARK}">` },
  { label: "benign tag with id", value: '<b id="trvB">bold</b>' },
  { label: "bare double-quote attribute breakout", value: `" onmouseover="${MARK}" x="` },
  { label: "single-quote attribute breakout", value: `' onfocus='${MARK}' autofocus='` },
  { label: "javascript link", value: `<a href="javascript:${MARK}">x</a>` },
  { label: "list-item breakout", value: `</li><li><img src=x onerror=${MARK}>` },
  { label: "container breakout", value: `</span></div><img src=x onerror=${MARK}>` },
  { label: "button breakout", value: `</button><img src=x onerror=${MARK}>` },
  { label: "iframe srcdoc", value: `<iframe srcdoc="<script>parent.${MARK}</script>"></iframe>` },
  { label: "handler-looking text with entities", value: "&lt;img src=x onerror=1&gt; &amp;" },
];

/** Ordinary values that must be shown exactly as typed, including characters that are special in HTML. */
const ORDINARY: Array<{ label: string; value: string }> = [
  { label: "plain", value: "Alex" },
  { label: "Spanish accents and punctuation", value: "¿Cuál es la capital de Perú? Ñandú — José María" },
  { label: "apostrophe", value: "O'Brien's" },
  { label: "double quotes", value: 'Ben "The Bluff" Neil' },
  { label: "ampersand", value: "Tom & Jerry" },
  { label: "angle brackets as text", value: "5 > 3 and 2 < 4" },
  { label: "leading less-than", value: "<3 trivia" },
  { label: "literal entity text", value: "&lt;b&gt; &amp; &#39; &quot;" },
  { label: "emoji and CJK", value: "Pat 😀 李雷" },
];

const ALL = [...HOSTILE, ...ORDINARY];
const ALL_VALUES = ALL.map((v) => v.value);

type Call = { url: string; method: string; headers: Record<string, string>; body: any };
type Out = { status: number; json: unknown };
type Responder = (call: Call) => Out | Promise<Out>;

const openWindows: Array<{ close(): void }> = [];
afterEach(() => {
  while (openWindows.length) openWindows.pop()!.close();
});

function quietConsole() {
  const virtualConsole = new VirtualConsole();
  virtualConsole.on("jsdomError", (error) => {
    if (!/Not implemented/.test(String(error?.message))) console.error(error);
  });
  return virtualConsole;
}

const tick = () => new Promise<void>((r) => setTimeout(r, 0));
async function settle(times = 6) {
  for (let i = 0; i < times; i++) await tick();
}

interface Harness {
  win: any;
  doc: Document;
  calls: Call[];
  setModel(next: unknown): void;
  refresh(): Promise<void>;
  byId(id: string): HTMLElement;
}

/**
 * Loads a shipped page whole, restored from storage into a live Session, with the real shared polling factory, and with every request
 * answered by `current` (the Session read model) or by `respond`. `refresh()` is the page's own refresh function — the one the polling
 * tick calls — so every render here goes through the production path.
 */
async function loadPage(kind: "host" | "participant", initialModel: unknown, opts: { displayName?: string; respond?: Responder } = {}): Promise<Harness> {
  let current = JSON.stringify(initialModel);
  const calls: Call[] = [];
  const html = kind === "host" ? HOST_HTML : PARTICIPANT_HTML;
  const respond: Responder = opts.respond ?? (() => ({ status: 200, json: {} }));
  const dom = new JSDOM(html, {
    url: `http://localhost/${kind}.html`,
    runScripts: "dangerously",
    pretendToBeVisual: true,
    virtualConsole: quietConsole(),
    beforeParse(window) {
      const w = window as any;
      w.scrollTo = () => {};
      if (kind === "host") {
        w.sessionStorage.setItem("urbano_gaming_active_host_runtime_type", "SESSION");
        w.sessionStorage.setItem("urbano_gaming_dev_harness_host", JSON.stringify({ sessionId: SESSION_ID, roomCode: "ABC234", hostToken: HOST_TOKEN }));
      } else {
        w.sessionStorage.setItem("urbano_gaming_active_runtime_type", "SESSION");
        w.sessionStorage.setItem(
          "urbano_gaming_dev_harness_participant",
          JSON.stringify({ sessionId: SESSION_ID, participantId: ME, participantToken: PARTICIPANT_TOKEN, displayName: opts.displayName ?? "Me" })
        );
      }
      w.fetch = async (url: string, init: any = {}) => {
        const call: Call = {
          url: String(url),
          method: init.method ?? "GET",
          headers: init.headers ?? {},
          body: init.body ? JSON.parse(init.body) : undefined,
        };
        calls.push(call);
        const out: Out =
          call.method === "GET" && call.url === `/api/sessions/${SESSION_ID}` ? { status: 200, json: JSON.parse(current) } : await respond(call);
        return { status: out.status, json: async () => out.json };
      };
      w.eval(SESSION_SYNC_JS); // the real shared polling factory, as /sessionSync.js would define it
      w.eval(POKER_PARTICIPANT_JS);
    },
  });
  openWindows.push(dom.window);
  const win = dom.window as any;
  const doc = win.document as Document;
  const refreshFn = kind === "host" ? "hostRefresh" : "participantRefresh";
  const harness: Harness = {
    win,
    doc,
    calls,
    setModel(next) {
      current = JSON.stringify(next);
    },
    refresh: () => win[refreshFn](),
    byId: (id) => doc.getElementById(id) as HTMLElement,
  };
  await settle(); // the page's own boot refresh
  await harness.refresh();
  return harness;
}

// ---------------------------------------------------------------------------------------------------------------------------------
// Synthetic Session read models, shaped like getSession's response
// ---------------------------------------------------------------------------------------------------------------------------------

function roster(values: string[]) {
  return values.map((displayName, i) => ({ participantId: `p-${i}`, displayName }));
}

function baseModel(over: Record<string, unknown> = {}): Record<string, any> {
  return {
    sessionId: SESSION_ID,
    state: "LOBBY_LOCKED",
    stateVersion: 4,
    participants: [],
    interactionNumber: 1,
    segmentNumber: 1,
    interactionState: "PROMPT_ACTIVE",
    currentInteractionInstanceId: INTERACTION_ID,
    currentEngineType: "MULTIPLE_CHOICE",
    currentPrompt: { text: "Which one?", options: ["Alpha", "Beta", "Gamma", "Delta"], correctOptionIndex: null },
    submittedCount: 0,
    eligibleParticipantCount: 0,
    submissions: null,
    standings: [],
    preparedQuestions: [],
    successorSessionId: null,
    successorRoomCode: null,
    currentVotingCandidates: null,
    myVoteCandidateId: null,
    votingResults: null,
    questionProgress: { current: 1, total: 3 },
    currentQuiz: null,
    declaredCapabilities: ["TRIVIA"],
    capabilitiesLocked: true,
    legacyUndeclared: false,
    activeDuel: null,
    duelHistory: [],
    ...over,
  };
}

/** One revealed Multiple Choice question: every value is both a participant's name and the label of the answer that participant gave. */
function revealedModel(values: string[], over: Record<string, unknown> = {}): Record<string, any> {
  const people = roster(values);
  return baseModel({
    interactionState: "RESULT_REVEAL",
    participants: people,
    currentPrompt: { text: "Which one?", options: values.slice(0, 4), correctOptionIndex: 1 },
    submittedCount: values.length,
    eligibleParticipantCount: values.length,
    submissions: people.map((p, i) => ({
      participantId: p.participantId,
      displayName: p.displayName,
      text: values[(i + 1) % values.length],
      isCorrect: i % 3 === 0 ? true : i % 3 === 1 ? false : null,
    })),
    standings: people.map((p, i) => ({ ...p, score: (i % 4) * 10 })),
    ...over,
  });
}

// ---------------------------------------------------------------------------------------------------------------------------------
// Inertness checks
// ---------------------------------------------------------------------------------------------------------------------------------

/** Structural problems anywhere under `root`: an element outside the tags that surface authors, an event-handler attribute, or a script URL. */
function structureViolations(root: Element, allowedTags: string[]): string[] {
  const problems: string[] = [];
  for (const el of Array.from(root.querySelectorAll("*"))) {
    const tag = el.tagName.toLowerCase();
    if (!allowedTags.includes(tag)) problems.push(`unexpected <${tag}>`);
    for (const attr of Array.from(el.attributes)) {
      if (attr.name.toLowerCase().startsWith("on")) problems.push(`<${tag}> carries ${attr.name}`);
      if (/^\s*javascript:/i.test(attr.value)) problems.push(`<${tag}> ${attr.name} is a script URL`);
    }
  }
  return problems;
}

const EVENTS_THAT_TRIGGER_INLINE_HANDLERS = ["error", "load", "mouseover", "mouseenter", "focus", "toggle", "animationstart"];

/** Dispatches the events inline handlers listen for on every rendered element. Deliberately NOT `click`: legitimate controls act on it. */
function fireHandlerEvents(win: any, root: Element) {
  for (const el of Array.from(root.querySelectorAll("*"))) {
    for (const type of EVENTS_THAT_TRIGGER_INLINE_HANDLERS) el.dispatchEvent(new win.Event(type, { bubbles: false }));
  }
}

/** Everything wrong with `root`, as a list: structure, plus whether the marker ran after events were dispatched on every element. */
function inertnessProblems(win: any, root: Element, allowedTags: string[]): string[] {
  const problems = structureViolations(root, allowedTags);
  if (/<(img|svg|script|iframe|a|b)\b/i.test(root.innerHTML)) problems.push("serialized markup contains an injected tag");
  fireHandlerEvents(win, root);
  if (win.__xss !== undefined) problems.push("marker executed");
  return problems;
}

/** The text nodes that are DIRECT children of `el`, joined — what was written as text rather than as nested markup. */
function ownText(el: Element): string {
  return Array.from(el.childNodes)
    .filter((n) => n.nodeType === 3)
    .map((n) => n.nodeValue ?? "")
    .join("");
}

const texts = (els: ArrayLike<Element>) => Array.from(els).map((e) => e.textContent ?? "");

// ===============================================================================================================================
// host.html
// ===============================================================================================================================

describe("host.html — lobby roster (participant names)", () => {
  it("shows every name as literal text in its own list item, creating no element and no handler", async () => {
    const h = await loadPage("host", baseModel({ state: "LOBBY_OPEN", interactionState: null, currentInteractionInstanceId: null, currentEngineType: null, currentPrompt: null, questionProgress: null, participants: roster(ALL_VALUES) }));
    const list = h.byId("participantList");
    expect(inertnessProblems(h.win, list, ["li"])).toEqual([]);
    expect(texts(list.children)).toEqual(ALL_VALUES);
    Array.from(list.children).forEach((li, i) => expect(li.children.length, `item ${i}`).toBe(0));
    expect(h.byId("participantCount").textContent).toBe(String(ALL_VALUES.length));
  });
});

describe("host.html — the active question and its options", () => {
  it("shows hostile and ordinary option text literally, with the index badge on each row", async () => {
    const h = await loadPage("host", baseModel({ currentPrompt: { text: "Which one?", options: ALL_VALUES, correctOptionIndex: null } }));
    const list = h.byId("promptOptionsList");
    expect(inertnessProblems(h.win, list, ["li", "span"])).toEqual([]);
    const rows = Array.from(list.children);
    expect(rows).toHaveLength(ALL_VALUES.length);
    rows.forEach((row, i) => {
      expect(row.tagName, `row ${i}`).toBe("LI");
      expect(row.className.trim(), `row ${i}`).toBe("option-row");
      expect(texts(row.children), `row ${i}`).toEqual([String(i + 1), ALL_VALUES[i]]);
      expect(row.children[1].children.length, `option ${i} text`).toBe(0);
    });
    expect(list.querySelector(".correct-tag")).toBeNull(); // the correct answer is not shown before reveal
  });

  it("marks only the correct option at reveal and still shows the others literally", async () => {
    const h = await loadPage("host", baseModel({ interactionState: "RESULT_REVEAL", currentPrompt: { text: "Which one?", options: ALL_VALUES, correctOptionIndex: 3 } }));
    const list = h.byId("promptOptionsList");
    expect(inertnessProblems(h.win, list, ["li", "span"])).toEqual([]);
    const rows = Array.from(list.children);
    rows.forEach((row, i) => {
      expect(row.classList.contains("is-correct"), `row ${i}`).toBe(i === 3);
      expect(row.querySelectorAll(".correct-tag").length, `row ${i}`).toBe(i === 3 ? 1 : 0);
      expect(row.children[1].textContent, `row ${i}`).toBe(ALL_VALUES[i]);
    });
    expect(rows[3].querySelector(".correct-tag")!.textContent).toBe("✓ Correct");
  });

  it("keeps showing the question text as text (it already used textContent)", async () => {
    for (const { label, value } of ALL) {
      const h = await loadPage("host", baseModel({ currentPrompt: { text: value, options: ["A", "B"], correctOptionIndex: null } }));
      const promptText = h.byId("promptText");
      expect(promptText.textContent, label).toBe(value);
      expect(promptText.children.length, label).toBe(0);
    }
  });
});

describe("host.html — results (names and answer labels)", () => {
  it("shows each name and each answer as literal text, with the correctness badge and card class intact", async () => {
    const model = revealedModel(ALL_VALUES);
    const h = await loadPage("host", model);
    const list = h.byId("resultsList");
    expect(inertnessProblems(h.win, list, ["div", "span"])).toEqual([]);
    const cards = Array.from(list.children);
    expect(cards).toHaveLength(ALL_VALUES.length);
    cards.forEach((card, i) => {
      const sub = (model.submissions as any[])[i];
      expect(card.tagName, `card ${i}`).toBe("DIV");
      expect(card.classList.contains("result-card"), `card ${i}`).toBe(true);
      expect(card.classList.contains("is-correct"), `card ${i}`).toBe(sub.isCorrect === true);
      expect(card.classList.contains("is-wrong"), `card ${i}`).toBe(sub.isCorrect === false);
      const [name, text] = Array.from(card.children);
      expect(name.className, `card ${i}`).toBe("result-name");
      expect(ownText(name), `card ${i} name`).toBe(sub.displayName);
      expect(text.className, `card ${i}`).toBe("result-text");
      expect(text.textContent, `card ${i} answer`).toBe(sub.text);
      expect(text.children.length, `card ${i} answer`).toBe(0);
      const badge = name.querySelector(".correctness-badge");
      expect(badge ? badge.textContent : null, `card ${i} badge`).toBe(sub.isCorrect === true ? "✓" : sub.isCorrect === false ? "✗" : null);
    });
  });

  it("says so when nobody answered", async () => {
    const h = await loadPage("host", revealedModel(["Ana", "Luis"], { submissions: [] }));
    const list = h.byId("resultsList");
    expect(list.children).toHaveLength(1);
    expect(list.children[0].className).toBe("waiting");
    expect(list.textContent).toBe("No responses were submitted.");
  });
});

describe("host.html — standings", () => {
  it("shows each name literally with its score, ordered by score, and no award control for Trivia", async () => {
    const people = roster(ALL_VALUES);
    const standings = people.map((p, i) => ({ ...p, score: i * 5 }));
    const h = await loadPage("host", baseModel({ interactionState: "RESULT_REVEAL", participants: people, standings }));
    const list = h.byId("standingsList");
    expect(inertnessProblems(h.win, list, ["div"])).toEqual([]);
    const rows = Array.from(list.children);
    expect(rows).toHaveLength(ALL_VALUES.length);
    const expected = [...standings].sort((a, b) => b.score - a.score);
    rows.forEach((row, i) => {
      expect(row.className, `row ${i}`).toBe("standing-row");
      expect(texts(row.children), `row ${i}`).toEqual([expected[i].displayName, String(expected[i].score)]);
      expect(row.children[0].children.length, `row ${i}`).toBe(0);
      expect(row.querySelector("button"), `row ${i}`).toBeNull();
    });
  });

  it("announces tied winners as text at the end of the Session", async () => {
    const names = [HOSTILE[0].value, HOSTILE[3].value, "Ana"];
    const people = roster(names);
    const h = await loadPage("host", baseModel({ state: "SESSION_COMPLETE", interactionState: "RESULT_REVEAL", participants: people, standings: [{ ...people[0], score: 110 }, { ...people[1], score: 110 }, { ...people[2], score: 50 }] }));
    const banner = h.byId("winnerBanner");
    expect(banner.textContent).toBe(`Joint winners: ${names[0]} & ${names[1]} (110 pts)`);
    expect(banner.children.length).toBe(0);
    expect(inertnessProblems(h.win, h.byId("standingsList"), ["div"])).toEqual([]);
  });
});

describe("host.html — the +10 award control (shared standings renderer, Open Response)", () => {
  const openResponse = (people: Array<{ participantId: string; displayName: string }>) =>
    baseModel({
      interactionState: "RESULT_REVEAL",
      currentEngineType: "OPEN_RESPONSE",
      currentPrompt: { text: "Say something", options: null, correctOptionIndex: null },
      declaredCapabilities: ["OPEN_RESPONSE"],
      questionProgress: null,
      participants: people,
      standings: people.map((p) => ({ ...p, score: 0 })),
    });

  it("builds one button per participant with no inline handler, and sends that participant's exact id", async () => {
    // The ids contain quotes and markup on purpose: the old inline onclick="awardPoints('<id>', 10)" string would have broken on them.
    const people = [
      { participantId: `p'1"><img src=x onerror=${MARK}>`, displayName: HOSTILE[0].value },
      { participantId: "plain-id", displayName: "Ana" },
    ];
    const h = await loadPage("host", openResponse(people), { respond: () => ({ status: 200, json: {} }) });
    const list = h.byId("standingsList");
    expect(inertnessProblems(h.win, list, ["div", "button"])).toEqual([]);
    const buttons = Array.from(list.querySelectorAll<HTMLButtonElement>("button.award-btn"));
    expect(buttons.map((b) => b.textContent)).toEqual(["+10", "+10"]);
    expect(buttons.every((b) => !b.hasAttribute("onclick"))).toBe(true);

    buttons[0].click();
    await settle();
    const post = h.calls.find((c) => c.method === "POST")!;
    expect(post.url).toBe(`/api/sessions/${SESSION_ID}/award-points`);
    expect(post.body).toMatchObject({ participantId: people[0].participantId, points: 10, hostToken: HOST_TOKEN, interactionInstanceId: INTERACTION_ID });
    expect(h.win.__xss).toBeUndefined();
  });

  it("shows the in-flight state on the pressed button only, then restores it", async () => {
    const people = [{ participantId: "p-a", displayName: "Ana" }, { participantId: "p-b", displayName: "Luis" }];
    let release: (o: Out) => void = () => {};
    const gate = new Promise<Out>((r) => (release = r));
    const h = await loadPage("host", openResponse(people), { respond: () => gate });
    const buttons = () => Array.from(h.byId("standingsList").querySelectorAll<HTMLButtonElement>("button.award-btn"));
    buttons()[0].click();
    expect(buttons().map((b) => [b.textContent, b.disabled])).toEqual([["Awarding…", true], ["+10", false]]);
    release({ status: 200, json: {} });
    await settle();
    expect(buttons().map((b) => [b.textContent, b.disabled])).toEqual([["+10", false], ["+10", false]]);
  });
});

describe("host.html — the saved question queue", () => {
  function prepared(values: string[]) {
    return values.map((v, i) => ({
      preparedQuestionId: `q-${i}`,
      ordinal: i + 1,
      promptText: v,
      options: [values[(i + 1) % values.length], v, "Other"],
      correctOptionIndex: 0,
      pointsForCorrect: 10 + i,
      consumedAt: i % 2 === 0 ? "2026-11-06T12:00:00.000Z" : null,
    }));
  }

  it("shows question text and the correct answer literally, with ordinal, points and Asked/Waiting status", async () => {
    const questions = prepared(ALL_VALUES);
    const h = await loadPage("host", baseModel({ preparedQuestions: questions }));
    const list = h.byId("preparedQueueList");
    expect(inertnessProblems(h.win, list, ["h2", "div", "span"])).toEqual([]);
    expect(list.firstElementChild!.tagName).toBe("H2");
    expect(list.firstElementChild!.textContent).toBe("Question Queue");
    const rows = Array.from(list.querySelectorAll(".prepared-question-row"));
    expect(rows).toHaveLength(questions.length);
    rows.forEach((row, i) => {
      const q = questions[i];
      const [ordinal, body, status] = Array.from(row.children);
      expect(ordinal.className, `row ${i}`).toBe("ordinal-badge");
      expect(ordinal.textContent, `row ${i}`).toBe(String(q.ordinal));
      expect(ownText(body), `row ${i} question`).toBe(`${q.promptText} `);
      expect(body.children).toHaveLength(1);
      expect(body.children[0].textContent, `row ${i} note`).toBe(`(correct: “${q.options[q.correctOptionIndex]}”, ${q.pointsForCorrect} pts)`);
      expect(status.textContent, `row ${i}`).toBe(q.consumedAt ? "Asked" : "Waiting");
      expect(row.classList.contains("consumed"), `row ${i}`).toBe(Boolean(q.consumedAt));
    });
  });

  it("is emptied when the Session has no saved questions", async () => {
    const h = await loadPage("host", baseModel({ preparedQuestions: prepared(["One"]) }));
    expect(h.byId("preparedQueueList").children.length).toBeGreaterThan(0);
    h.setModel(baseModel({ preparedQuestions: [] }));
    await h.refresh();
    expect(h.byId("preparedQueueList").children.length).toBe(0);
  });
});

describe("host.html — authoring and reviewing questions before saving (already text-only; guarded so it stays that way)", () => {
  it("shows imported hostile rows literally in the draft queue and in the expanded editor", async () => {
    const h = await loadPage("host", baseModel({ state: "LOBBY_LOCKED", interactionState: null, currentEngineType: null, currentInteractionInstanceId: null, currentPrompt: null, questionProgress: null }));
    const hostile = HOSTILE[0].value.replace(/\|/g, "/"); // the import format is pipe-separated
    const rows = [`${hostile} | Uno | ${HOSTILE[3].value.replace(/\|/g, "/")} | Uno | 15`, `¿Cuál es la capital de Perú? | Lima | Cusco | Lima | 10`];
    (h.byId("bulkImportText") as HTMLTextAreaElement).value = rows.join("\n");
    h.win.parseAndAddBulkItems();

    const list = h.byId("itemQueueList");
    expect(inertnessProblems(h.win, list, ["div", "button"])).toEqual([]);
    const summaries = texts(list.querySelectorAll(".draft-question-text"));
    expect(summaries).toHaveLength(2);
    expect(summaries[0]).toContain(hostile);
    expect(summaries[1]).toBe("¿Cuál es la capital de Perú? — 2 options, correct: “Lima”, 10 pts");

    (list.querySelector("button.btn-ghost") as HTMLButtonElement).click(); // Edit on the first row
    const inputs = Array.from(list.querySelectorAll<HTMLInputElement>('input[type="text"]'));
    expect(inputs[0].value).toBe(hostile);
    expect(inputs.slice(1).map((i) => i.value)).toEqual(["Uno", HOSTILE[3].value.replace(/\|/g, "/")]);
    expect(inertnessProblems(h.win, list, ["div", "button", "input", "ul", "li", "span"])).toEqual([]);
  });
});

describe("host.html — polling and re-rendering never reinterpret what was shown", () => {
  it("renders identical DOM on every poll, never grows, and leaves no residue when the data changes and returns", async () => {
    const model = revealedModel(ALL_VALUES, { preparedQuestions: ALL_VALUES.map((v, i) => ({ preparedQuestionId: `q${i}`, ordinal: i + 1, promptText: v, options: [v, "Other"], correctOptionIndex: 0, pointsForCorrect: 10, consumedAt: null })) });
    const h = await loadPage("host", model);
    const ids = ["participantList", "promptOptionsList", "resultsList", "standingsList", "preparedQueueList"];
    const snapshot = () => ids.map((id) => h.byId(id).innerHTML);
    const first = snapshot();
    for (let i = 0; i < 5; i++) await h.refresh();
    expect(snapshot()).toEqual(first);
    ids.forEach((id) => expect(inertnessProblems(h.win, h.byId(id), ["li", "span", "div", "button", "h2"]), id).toEqual([]));

    h.setModel(revealedModel(["Ana", "Luis"], { preparedQuestions: [] }));
    await h.refresh();
    expect(texts(h.byId("participantList").children)).toEqual(["Ana", "Luis"]);
    expect(h.byId("preparedQueueList").children.length).toBe(0);

    h.setModel(model);
    await h.refresh();
    expect(snapshot()).toEqual(first);
    expect(h.win.__xss).toBeUndefined();
  });
});

// ===============================================================================================================================
// participant.html
// ===============================================================================================================================

describe("participant.html — the lobby card that greets the participant by their own name", () => {
  it("shows the name literally inside <strong>, for every value, and nothing else is parsed", async () => {
    const h = await loadPage("participant", baseModel({ state: "LOBBY_OPEN", interactionState: null, currentInteractionInstanceId: null, currentEngineType: null, currentPrompt: null, questionProgress: null, participants: roster(["Me"]) }), { displayName: "Me" });
    for (const { label, value } of ALL) {
      h.win.eval(`participantState.displayName = ${JSON.stringify(value)}`);
      await h.refresh();
      const card = h.byId("state-card");
      expect(inertnessProblems(h.win, card, ["div", "span", "strong"]), label).toEqual([]);
      expect(card.querySelector("strong")!.textContent, label).toBe(value);
      expect(card.querySelector("strong")!.children.length, label).toBe(0);
      expect(card.textContent, label).toBe(`🕒You're in as ${value}. Waiting for the host to lock the lobby…`);
    }
  });

  it("keeps the other waiting messages and hides the card while a question is active", async () => {
    const h = await loadPage("participant", baseModel({ interactionState: null, currentPrompt: null, questionProgress: null }));
    expect(h.byId("state-card").textContent).toBe("🔒Lobby locked. Waiting for the host to start the game…");
    h.setModel(baseModel({ interactionState: "SUBMISSIONS_CLOSED" }));
    await h.refresh();
    expect(h.byId("state-card").textContent).toBe("✋Submissions closed. Waiting for the host to reveal results…");
    h.setModel(baseModel({ interactionState: "PROMPT_ACTIVE" }));
    await h.refresh();
    expect(h.byId("state-card").style.display).toBe("none");
    h.setModel(baseModel({ state: "SESSION_COMPLETE" }));
    await h.refresh();
    expect(h.byId("state-card").style.display).toBe("none"); // the completion screen replaces it
  });
});

describe("participant.html — option buttons", () => {
  it("shows hostile and ordinary option text literally on tappable buttons", async () => {
    const h = await loadPage("participant", baseModel({ currentPrompt: { text: "Which one?", options: ALL_VALUES, correctOptionIndex: null } }));
    const list = h.byId("optionsList");
    expect(inertnessProblems(h.win, list, ["button", "span"])).toEqual([]);
    const buttons = Array.from(list.children) as HTMLButtonElement[];
    expect(buttons).toHaveLength(ALL_VALUES.length);
    buttons.forEach((b, i) => {
      expect(b.tagName, `button ${i}`).toBe("BUTTON");
      expect(b.disabled, `button ${i}`).toBe(false);
      expect(b.hasAttribute("onclick"), `button ${i}`).toBe(false);
      expect(texts(b.children), `button ${i}`).toEqual([String(i + 1), ALL_VALUES[i]]);
      expect(b.children[1].children.length, `button ${i} text`).toBe(0);
    });
  });

  it("sends the tapped option's index with the participant's own token, and keeps the selection across polls", async () => {
    const h = await loadPage("participant", baseModel({ currentPrompt: { text: "Which one?", options: HOSTILE.map((v) => v.value).slice(0, 4), correctOptionIndex: null } }));
    const buttons = () => Array.from(h.byId("optionsList").children) as HTMLButtonElement[];
    buttons()[2].click();
    await settle();
    const post = h.calls.find((c) => c.method === "POST")!;
    expect(post.url).toBe(`/api/sessions/${SESSION_ID}/submit`);
    expect(post.headers.authorization).toBe(`Bearer ${PARTICIPANT_TOKEN}`);
    expect(post.body).toEqual({ text: "2" });
    expect(buttons().map((b) => b.classList.contains("selected"))).toEqual([false, false, true, false]);
    for (let i = 0; i < 3; i++) await h.refresh();
    expect(buttons().map((b) => b.classList.contains("selected"))).toEqual([false, false, true, false]);
    expect(h.win.__xss).toBeUndefined();
  });

  it("revision: tapping another option while the question is open sends the new index", async () => {
    const h = await loadPage("participant", baseModel());
    const buttons = () => Array.from(h.byId("optionsList").children) as HTMLButtonElement[];
    buttons()[0].click();
    await settle();
    buttons()[3].click();
    await settle();
    expect(h.calls.filter((c) => c.method === "POST").map((c) => c.body)).toEqual([{ text: "0" }, { text: "3" }]);
    expect(buttons().map((b) => b.classList.contains("selected"))).toEqual([false, false, false, true]);
  });

  it("disables the buttons once submissions close, and a tap then sends nothing", async () => {
    const h = await loadPage("participant", baseModel({ interactionState: "SUBMISSIONS_CLOSED" }));
    const buttons = Array.from(h.byId("optionsList").children) as HTMLButtonElement[];
    expect(buttons.every((b) => b.disabled)).toBe(true);
    buttons[1].click();
    await settle();
    expect(h.calls.filter((c) => c.method === "POST")).toEqual([]);
  });

  it("at reveal highlights the correct option and the participant's wrong pick", async () => {
    const h = await loadPage("participant", baseModel({ currentPrompt: { text: "Which one?", options: ["Alpha", "Beta", "Gamma", "Delta"], correctOptionIndex: null } }));
    (h.byId("optionsList").children[0] as HTMLButtonElement).click(); // picks Alpha
    await settle();
    h.setModel(baseModel({ interactionState: "RESULT_REVEAL", currentPrompt: { text: "Which one?", options: ["Alpha", "Beta", "Gamma", "Delta"], correctOptionIndex: 2 } }));
    await h.refresh();
    const buttons = Array.from(h.byId("optionsList").children) as HTMLButtonElement[];
    expect(buttons.map((b) => [b.classList.contains("is-correct"), b.classList.contains("is-wrong-selected"), b.disabled])).toEqual([
      [false, true, true],
      [false, false, true],
      [true, false, true],
      [false, false, true],
    ]);
  });

  it("shows 'Question X of N' and the question text as text", async () => {
    const h = await loadPage("participant", baseModel({ currentPrompt: { text: HOSTILE[0].value, options: ["A", "B"], correctOptionIndex: null }, questionProgress: { current: 2, total: 10 } }));
    expect(h.byId("questionProgressLabel").textContent).toBe("Question 2 of 10");
    expect(h.byId("promptText").textContent).toBe(HOSTILE[0].value);
    expect(h.byId("promptText").children.length).toBe(0);
  });
});

describe("participant.html — results (names and answer labels)", () => {
  it("shows every name and answer literally, marks the participant's own card, and keeps the ✓/✗ badges", async () => {
    const people = roster(ALL_VALUES);
    people[2] = { participantId: ME, displayName: ALL_VALUES[2] }; // the viewer is one of the participants
    const model = revealedModel(ALL_VALUES, { participants: people });
    (model.submissions as any[]).forEach((s, i) => (s.participantId = people[i].participantId));
    const h = await loadPage("participant", model);
    const list = h.byId("resultsList");
    expect(inertnessProblems(h.win, list, ["div", "span"])).toEqual([]);
    const cards = Array.from(list.children);
    expect(cards).toHaveLength(ALL_VALUES.length);
    cards.forEach((card, i) => {
      const sub = (model.submissions as any[])[i];
      const isOwn = sub.participantId === ME;
      const [name, text] = Array.from(card.children);
      expect(card.classList.contains("own"), `card ${i}`).toBe(isOwn);
      expect(card.classList.contains("is-correct"), `card ${i}`).toBe(sub.isCorrect === true);
      expect(card.classList.contains("is-wrong"), `card ${i}`).toBe(sub.isCorrect === false);
      const badge = sub.isCorrect === true ? " ✓" : sub.isCorrect === false ? " ✗" : "";
      expect(ownText(name), `card ${i} name`).toBe((isOwn ? `${sub.displayName} ` : sub.displayName) + badge);
      expect(name.querySelectorAll(".you").length, `card ${i}`).toBe(isOwn ? 1 : 0);
      expect(text.textContent, `card ${i} answer`).toBe(sub.text);
      expect(text.children.length, `card ${i} answer`).toBe(0);
    });
  });

  it("says so when nobody answered", async () => {
    const h = await loadPage("participant", revealedModel(["Ana", "Luis"], { submissions: [] }));
    const list = h.byId("resultsList");
    expect(list.children).toHaveLength(1);
    expect(list.children[0].className).toBe("waiting");
    expect(list.textContent).toBe("No responses were submitted.");
  });

  it("still shows the participant their own correctness banner", async () => {
    const people = [{ participantId: ME, displayName: "Me" }, { participantId: "p-x", displayName: "Ana" }];
    const mk = (isCorrect: boolean) => revealedModel(["Me", "Ana"], { participants: people, submissions: [{ participantId: ME, displayName: "Me", text: "Beta", isCorrect }, { participantId: "p-x", displayName: "Ana", text: "Alpha", isCorrect: !isCorrect }] });
    const h = await loadPage("participant", mk(true));
    expect(h.byId("ownCorrectnessBanner").textContent).toBe("✓ Correct!");
    h.setModel(mk(false));
    await h.refresh();
    expect(h.byId("ownCorrectnessBanner").textContent).toBe("✗ Not quite — the correct answer is highlighted below.");
  });
});

describe("participant.html — standings", () => {
  it("shows each name literally with its score, ordered by score, with the participant's own row marked", async () => {
    const people = roster(ALL_VALUES);
    people[4] = { participantId: ME, displayName: ALL_VALUES[4] };
    const standings = people.map((p, i) => ({ ...p, score: i * 5 }));
    const h = await loadPage("participant", baseModel({ interactionState: "RESULT_REVEAL", participants: people, standings }));
    const list = h.byId("standingsList");
    expect(inertnessProblems(h.win, list, ["div", "span"])).toEqual([]);
    const expected = [...standings].sort((a, b) => b.score - a.score);
    const rows = Array.from(list.children);
    expect(rows).toHaveLength(expected.length);
    rows.forEach((row, i) => {
      const isOwn = expected[i].participantId === ME;
      expect(row.classList.contains("own"), `row ${i}`).toBe(isOwn);
      const [name, score] = Array.from(row.children);
      expect(ownText(name), `row ${i} name`).toBe(isOwn ? `${expected[i].displayName} ` : expected[i].displayName);
      expect(name.querySelectorAll(".you").length, `row ${i}`).toBe(isOwn ? 1 : 0);
      expect(score.textContent, `row ${i} score`).toBe(String(expected[i].score));
    });
  });

  it("announces tied winners as text, and 'no winner' when nothing was scored", async () => {
    const names = [HOSTILE[0].value, HOSTILE[3].value, "Ana"];
    const people = roster(names);
    const h = await loadPage("participant", baseModel({ state: "SESSION_COMPLETE", interactionState: "RESULT_REVEAL", participants: people, standings: [{ ...people[0], score: 110 }, { ...people[1], score: 110 }, { ...people[2], score: 50 }] }));
    expect(h.byId("winnerBanner").textContent).toBe(`Joint winners: ${names[0]} & ${names[1]} (110 pts)`);
    expect(h.byId("winnerBanner").children.length).toBe(0);
    h.setModel(baseModel({ state: "SESSION_COMPLETE", interactionState: "RESULT_REVEAL", participants: people, standings: people.map((p) => ({ ...p, score: 0 })) }));
    await h.refresh();
    expect(h.byId("winnerBanner").textContent).toBe("No winner determined — no points were awarded.");
  });
});

describe("participant.html — polling and re-rendering never reinterpret what was shown", () => {
  it("renders identical DOM on every poll, never grows, and leaves no residue when the data changes and returns", async () => {
    const people = roster(ALL_VALUES);
    people[1] = { participantId: ME, displayName: ALL_VALUES[1] };
    const model = revealedModel(ALL_VALUES, { participants: people, currentPrompt: { text: "Which one?", options: ALL_VALUES, correctOptionIndex: 1 } });
    (model.submissions as any[]).forEach((s, i) => (s.participantId = people[i].participantId));
    const h = await loadPage("participant", model);
    const ids = ["optionsList", "resultsList", "standingsList"];
    const snapshot = () => ids.map((id) => h.byId(id).innerHTML);
    const first = snapshot();
    for (let i = 0; i < 5; i++) await h.refresh();
    expect(snapshot()).toEqual(first);
    ids.forEach((id) => expect(inertnessProblems(h.win, h.byId(id), ["button", "span", "div"]), id).toEqual([]));

    h.setModel(revealedModel(["Ana", "Luis"]));
    await h.refresh();
    // revealedModel scores participant i at (i % 4) * 10, so Luis (10) outranks Ana (0).
    expect(texts(h.byId("standingsList").querySelectorAll(".standing-name"))).toEqual(["Luis", "Ana"]);
    expect(h.byId("standingsList").children).toHaveLength(2);

    h.setModel(model);
    await h.refresh();
    expect(snapshot()).toEqual(first);
    expect(h.win.__xss).toBeUndefined();
  });
});

// ===============================================================================================================================
// Negative controls: each protection is removed from a COPY of the shipped source (in memory; the files are not touched) and the same
// checks are shown to catch it. A control that still passed would mean the checks above prove nothing.
// ===============================================================================================================================

/** Replaces `anchor` everywhere it occurs and fails loudly unless it occurs exactly `expectedCount` times, so a control can never silently no-op. */
function unsafeCopy(source: string, anchor: string, replacement: string, expectedCount = 1): string {
  const parts = source.split(anchor);
  expect(parts.length - 1, `mutation anchor must occur exactly ${expectedCount}× : ${anchor}`).toBe(expectedCount);
  const mutated = parts.join(replacement);
  expect(mutated).not.toBe(source);
  return mutated;
}

async function loadMutated(kind: "host" | "participant", source: string, model: unknown, opts: { displayName?: string } = {}) {
  // loadPage reads the shipped constants, so swap the source for just this load.
  const original = kind === "host" ? HOST_HTML : PARTICIPANT_HTML;
  expect(source).not.toBe(original);
  const dom = new JSDOM(source, {
    url: `http://localhost/${kind}.html`,
    runScripts: "dangerously",
    pretendToBeVisual: true,
    virtualConsole: quietConsole(),
    beforeParse(window) {
      const w = window as any;
      w.scrollTo = () => {};
      if (kind === "host") {
        w.sessionStorage.setItem("urbano_gaming_active_host_runtime_type", "SESSION");
        w.sessionStorage.setItem("urbano_gaming_dev_harness_host", JSON.stringify({ sessionId: SESSION_ID, roomCode: "ABC234", hostToken: HOST_TOKEN }));
      } else {
        w.sessionStorage.setItem("urbano_gaming_active_runtime_type", "SESSION");
        w.sessionStorage.setItem("urbano_gaming_dev_harness_participant", JSON.stringify({ sessionId: SESSION_ID, participantId: ME, participantToken: PARTICIPANT_TOKEN, displayName: opts.displayName ?? "Me" }));
      }
      w.fetch = async (url: string, init: any = {}) => ({ status: 200, json: async () => ((init.method ?? "GET") === "GET" ? JSON.parse(JSON.stringify(model)) : {}) });
      w.eval(SESSION_SYNC_JS);
      w.eval(POKER_PARTICIPANT_JS);
    },
  });
  openWindows.push(dom.window);
  const win = dom.window as any;
  await settle();
  await win[kind === "host" ? "hostRefresh" : "participantRefresh"]();
  return { win, byId: (id: string) => win.document.getElementById(id) as HTMLElement };
}

const IMG = HOSTILE[0].value;
const CAUGHT = ["unexpected <img>", "<img> carries onerror", "marker executed"];

describe("negative controls — restoring HTML interpretation is caught by the checks above", () => {
  it("host.html: letting the text helper parse HTML exposes the roster, the options and the standings", async () => {
    const unsafe = unsafeCopy(HOST_HTML, "if (text !== undefined) node.textContent = String(text);", "if (text !== undefined) node.innerHTML = String(text);");
    const people = roster([IMG, "Ana"]);
    const h = await loadMutated("host", unsafe, baseModel({ participants: people, standings: people.map((p) => ({ ...p, score: 1 })), currentPrompt: { text: "Q", options: [IMG, "B"], correctOptionIndex: null } }));
    expect(inertnessProblems(h.win, h.byId("participantList"), ["li"])).toEqual(expect.arrayContaining(CAUGHT));
    expect(inertnessProblems(h.win, h.byId("promptOptionsList"), ["li", "span"])).toEqual(expect.arrayContaining(CAUGHT));
    expect(inertnessProblems(h.win, h.byId("standingsList"), ["div"])).toEqual(expect.arrayContaining(["unexpected <img>", "<img> carries onerror"]));
  });

  it("host.html: inserting a result name as markup is caught", async () => {
    const unsafe = unsafeCopy(HOST_HTML, "name.appendChild(document.createTextNode(String(s.displayName)));", "name.insertAdjacentHTML(\"beforeend\", String(s.displayName));");
    const h = await loadMutated("host", unsafe, revealedModel([IMG, "Ana"]));
    expect(inertnessProblems(h.win, h.byId("resultsList"), ["div", "span"])).toEqual(expect.arrayContaining(CAUGHT));
  });

  it("host.html: inserting a saved question's text as markup is caught", async () => {
    const unsafe = unsafeCopy(HOST_HTML, "body.appendChild(document.createTextNode(`${q.promptText} `));", "body.insertAdjacentHTML(\"beforeend\", `${q.promptText} `);");
    const q = [{ preparedQuestionId: "q0", ordinal: 1, promptText: IMG, options: ["A", "B"], correctOptionIndex: 0, pointsForCorrect: 10, consumedAt: null }];
    const h = await loadMutated("host", unsafe, baseModel({ preparedQuestions: q }));
    expect(inertnessProblems(h.win, h.byId("preparedQueueList"), ["h2", "div", "span"])).toEqual(expect.arrayContaining(CAUGHT));
  });

  it("participant.html: letting the text helper parse HTML exposes the option buttons and the lobby card", async () => {
    const unsafe = unsafeCopy(PARTICIPANT_HTML, "if (text !== undefined) node.textContent = String(text);", "if (text !== undefined) node.innerHTML = String(text);");
    const options = await loadMutated("participant", unsafe, baseModel({ currentPrompt: { text: "Q", options: [IMG, "B"], correctOptionIndex: null } }));
    expect(inertnessProblems(options.win, options.byId("optionsList"), ["button", "span"])).toEqual(expect.arrayContaining(CAUGHT));
    const lobby = await loadMutated("participant", unsafe, baseModel({ state: "LOBBY_OPEN", interactionState: null, currentPrompt: null, questionProgress: null }), { displayName: IMG });
    expect(inertnessProblems(lobby.win, lobby.byId("state-card"), ["div", "span", "strong"])).toEqual(expect.arrayContaining(CAUGHT));
  });

  it("participant.html: inserting result and standing names as markup is caught", async () => {
    const unsafe = unsafeCopy(
      PARTICIPANT_HTML,
      "name.appendChild(document.createTextNode(isOwn ? `${s.displayName} ` : String(s.displayName)));",
      "name.insertAdjacentHTML(\"beforeend\", isOwn ? `${s.displayName} ` : String(s.displayName));",
      2
    );
    const h = await loadMutated("participant", unsafe, revealedModel([IMG, "Ana"]));
    expect(inertnessProblems(h.win, h.byId("resultsList"), ["div", "span"])).toEqual(expect.arrayContaining(CAUGHT));
    expect(inertnessProblems(h.win, h.byId("standingsList"), ["div", "span"])).toEqual(expect.arrayContaining(["unexpected <img>", "<img> carries onerror"]));
  });

  it("the controls change only their own in-memory copies: the shipped pages still use text nodes", () => {
    expect(HOST_HTML).toContain("if (text !== undefined) node.textContent = String(text);");
    expect(PARTICIPANT_HTML).toContain("if (text !== undefined) node.textContent = String(text);");
  });
});
