import { describe, expect, it } from "vitest";
import { JSDOM } from "jsdom";
import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";

import { parseDrawRequest } from "../lib/gaming/competitions/draw";
import { parseScheduleProposalRequest } from "../lib/gaming/competitions/scheduleProposal";
import { parsePublishRequest } from "../lib/gaming/competitions/schedulePublication";
import { openAmendAdminPage, openAmendMemberPage } from "./helpers/competitionPlanAmendmentPageHarness";
import { MiniDrawServer, REFUSAL_CODES, defaultDrawWire, drawWire, makeDrawRecord, refusalReply, seedFor } from "./helpers/competitionDrawOrganizerPageHarness";
import {
  ABSENT, ADMIN_SOURCE, CID, CODE, DRAW_URL, MiniScheduleServer, ORGANIZER_SIGNAL, PUBLISH_URL, SCHEDULE_URL, SIGNED_IN, TEAM_NAMES, UUID_ANY, HEX64, chain, chooseAll,
  defer, drawRequests, loadCompetition, never, openScheduleAdmin, publishRequests, scheduleRequests, scheduleTransport, viewBody, writes,
} from "./helpers/competitionScheduleOrganizerPageHarness";
import type { SchedulePage, ScheduleReply, ScheduleRequest, ScheduleScenario } from "./helpers/competitionScheduleOrganizerPageHarness";

/**
 * UG-CR-GATE-SSS-031 — the organizer's four-team draw surface on the SHIPPED /competitions-admin.html, run whole in jsdom.
 *
 * WHAT THIS PROVES, AND WHAT IT DOES NOT. Everything here proves what the PAGE does with the answers a server gives it: when it shows the draw surface and when it never does,
 * what it sends (one identifier of its own and nothing else), what it keeps and when it forgets, what it claims and when it refuses to claim, and that the schedule surface waits for a
 * verified draw. The server is a DOUBLE — but a faithful one: every draw is produced by the real, already contract-tested server functions and verified by the server's own verifier,
 * every request the page sends is judged by the real strict parser, and every refusal is the real route's own status and body (see helpers/competitionDrawOrganizerPageHarness.ts).
 * It is NOT integrated Supabase evidence: the database decides who may draw, the lifecycle, the entropy, replay and conflict, and the loopback contract suite proves that separately.
 * And it is not a browser — the real page is also walked in a real browser at 375, 390 and desktop widths.
 *
 * Every test begins from a POSITIVE CONTROL (the surface does appear when the server confirms everything) so that a test of a refusal can never pass merely because the
 * surface does not exist at all.
 */

const ADMIN_HTML = readFileSync(path.join(process.cwd(), "public/competitions-admin.html"), "utf8");
const MEMBER_HTML = readFileSync(path.join(process.cwd(), "public/competitions.html"), "utf8");
const CID2 = "99999999-9999-4999-8999-999999999999";
const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

const HOSTILE_PAYLOADS: Array<{ label: string; value: string }> = [
  { label: "img onerror", value: '<img src=x onerror="window.__xss=(window.__xss||0)+1">' },
  { label: "attribute-breakout script", value: '"><script>window.__xss=(window.__xss||0)+1</script>' },
  { label: "svg onload", value: "<svg onload=\"window.__xss=(window.__xss||0)+1\">" },
  { label: "benign tag", value: "<b>bold</b>" },
  { label: "bare attribute-breakout", value: '" onmouseover="window.__xss=(window.__xss||0)+1" autofocus="' },
];

const COPY4 = ["button[Copy Invitation Link]", "button[Copy Invitation Link]", "button[Copy Invitation Link]", "button[Copy Invitation Link]"];
/** The organizer page for a READY_TO_PUBLISH competition when neither the draw nor the schedule is offered. */
const BASE_READY = ["select#comp-select", "button#btn-load-competition", "button#btn-open-cancel", ...COPY4];
const SCHEDULE_FORM_CONTROLS = [
  "select#schedule-sf1-pitch", "select#schedule-sf1-date", "select#schedule-sf1-time", "select#schedule-sf2-pitch", "select#schedule-sf2-date", "select#schedule-sf2-time",
  "select#schedule-final-pitch", "select#schedule-final-date", "select#schedule-final-time", "button#schedule-propose",
];

/** itertools.permutations([1, 2, 3, 4]), in the order it yields them: the independent oracle for what position each input team takes (copied from competitionDraw.test.ts). */
const LEXICOGRAPHIC: number[][] = [
  [1, 2, 3, 4], [1, 2, 4, 3], [1, 3, 2, 4], [1, 3, 4, 2], [1, 4, 2, 3], [1, 4, 3, 2],
  [2, 1, 3, 4], [2, 1, 4, 3], [2, 3, 1, 4], [2, 3, 4, 1], [2, 4, 1, 3], [2, 4, 3, 1],
  [3, 1, 2, 4], [3, 1, 4, 2], [3, 2, 1, 4], [3, 2, 4, 1], [3, 4, 1, 2], [3, 4, 2, 1],
  [4, 1, 2, 3], [4, 1, 3, 2], [4, 2, 1, 3], [4, 2, 3, 1], [4, 3, 1, 2], [4, 3, 2, 1],
];

/** The words the page says, pinned exactly: the page's own sentences, never the server's. */
const COPY = {
  readFailed: "The draw could not be loaded, so nothing can be drawn or scheduled from here right now. Choose Load to try again.",
  readSignedOut: "Your session could not be confirmed, so the draw cannot be shown. Sign in again, then choose Load.",
  readUnavailable: "A draw is not available to you for this competition.",
  intro: "The draw is permanent. When you make it, the server randomly assigns the four frozen teams to positions 1 to 4. You cannot choose, change, repeat or undo it.",
  rules: ["Positions 1 and 2 play Semifinal 1.", "Positions 3 and 4 play Semifinal 2.", "A position is a place in the bracket, not a ranking."],
  make: "Make Permanent Draw",
  making: "Making the draw…",
  made: "The draw was made. It is shown below.",
  replay: "This draw had already been made from the same request. It is shown below.",
  alreadyDrawn: "The draw had already been made, so nothing new was made. It is shown below.",
  foundAfterUncertain: "The server's answer did not arrive, but the draw was made. It is shown below.",
  timeout: "The server did not answer in time, so it is not known whether the draw was made.",
  network: "The server could not be reached, so it is not known whether the draw was made.",
  unreadable: "The server's answer could not be understood, so it is not known whether the draw was made.",
  unknown: "The server could not complete the request, so it is not known whether the draw was made.",
  noneYet: " The server shows no draw yet. Making the draw again sends the same request, so a draw can never be made twice.",
  unconfirmed: " Choose Load to check again.",
  madeUnconfirmed: "The draw was made, but it could not be confirmed with the server just now. Choose Load to see it.",
  interrupted: "The draw request was interrupted before the server answered, so it is not known whether the draw was made.",
  checking: " The server is being asked what it holds.",
  refused400: "The server did not accept the draw request. No draw was made.",
  refused401: "Your session could not be confirmed, so no draw was made. Sign in again, then choose Load.",
  refusedUnavailable: "A draw is not available to you for this competition. No draw was made.",
  refused409: "The server refused to make the draw. No draw was made.",
  codes: {
    WRONG_STATE: "The draw can be made only while the competition is ready to publish and nothing has been scheduled. No draw was made.",
    FREEZE_REQUIRED: "Registration must be closed and frozen before the draw can be made. No draw was made.",
    FREEZE_INCONSISTENT: "The frozen registration no longer matches this competition, so the draw cannot be made. No draw was made.",
    AMENDMENT_PENDING: "A plan change is still waiting for the captains' answers. Wait until it is decided, withdrawn or expired, then make the draw. No draw was made.",
    ALREADY_DRAWN: "The draw had already been made, so nothing new was made. It is shown below.",
  } as Record<string, string>,
};

const text = (el: Element | null): string => (el?.textContent ?? "").replace(/\s+/g, " ").trim();
const clone = <T,>(value: T): any => JSON.parse(JSON.stringify(value));
const section = (page: SchedulePage) => page.$("#draw-section");
const tick = (page: SchedulePage, ms = 60) => page.idle(ms);
const drawGets = (page: SchedulePage) => drawRequests(page).filter((r) => r.method === "GET");
const drawPosts = (page: SchedulePage) => drawRequests(page).filter((r) => r.method === "POST");
const activeId = (page: SchedulePage): string => (page.doc.activeElement as HTMLElement | null)?.id ?? "";
const note = (page: SchedulePage) => text(page.$("#draw-read-note"));
const status = (page: SchedulePage) => text(page.$("#draw-status"));
/** The order the page asked for things in, reduced to the routes that matter here. */
const trail = (page: SchedulePage): string[] =>
  page.requests.filter((r) => r.url.endsWith("/draw") || r.url.includes("/schedule-proposal") || r.url.endsWith("/publish")).map((r) => `${r.method} ${r.url.endsWith("/draw") ? "draw" : r.url.endsWith("/publish") ? "publish" : "schedule"}`);
/** Every control inside the draw section, whatever its kind. */
const drawControls = (page: SchedulePage): Element[] => page.$$("#draw-section button, #draw-section input, #draw-section select, #draw-section textarea, #draw-section a, #draw-section summary, #draw-section form, #draw-section [tabindex]:not([tabindex='-1']), #draw-section [contenteditable]");
const intentOf = (request: ScheduleRequest): string => request.json().intentId;

function assertNoLiveInjection(root: Element) {
  expect(root.querySelector("script")).toBeNull();
  for (const el of [root, ...Array.from(root.querySelectorAll("*"))]) for (const attr of Array.from(el.attributes || [])) expect(attr.name.toLowerCase().startsWith("on")).toBe(false);
}

/** The scenario behind which sit a mini draw server and (optionally) a mini schedule server. */
function withDraw(draw: MiniDrawServer, extra: Partial<ScheduleScenario> = {}): ScheduleScenario {
  return { draw: () => draw.get(), drawPost: (r) => draw.post(r.json()), ...extra };
}
function withBoth(draw: MiniDrawServer, schedule: MiniScheduleServer, extra: Partial<ScheduleScenario> = {}): ScheduleScenario {
  return withDraw(draw, {
    schedule: () => ({ status: 200, json: schedule.read() }),
    propose: (r) => schedule.propose(r.json()),
    publish: (r) => schedule.publish(r.json()),
    view: () => ({ status: 200, json: viewBody({ state: schedule.published ? "PUBLISHED" : "READY_TO_PUBLISH", signal: ORGANIZER_SIGNAL }) }),
    ...extra,
  });
}
/** Opens the organizer page, loads the competition and waits for the draw section. */
async function drawPage(draw: MiniDrawServer = new MiniDrawServer(), extra: Partial<ScheduleScenario> = {}): Promise<SchedulePage> {
  const page = await openScheduleAdmin(withDraw(draw, extra));
  await loadCompetition(page);
  await page.settle(() => !!section(page), "the draw section");
  return page;
}
const seededSchedule = (n = 3) => new MiniScheduleServer({ records: chain(n) });

/** Two READY_TO_PUBLISH competitions the caller organizes, so a late answer for one can be told from the other. */
function twoCompetitions(drawOf: (id: string) => Promise<ScheduleReply> | ScheduleReply, extra: Partial<ScheduleScenario> = {}): ScheduleScenario {
  const view = (_r: ScheduleRequest, id: string): ScheduleReply => {
    const body = clone(viewBody({ state: "READY_TO_PUBLISH", signal: ORGANIZER_SIGNAL }));
    body.view.competition.competitionId = id;
    body.view.competition.name = id === CID ? "Frozen Cup" : "Second Cup";
    return { status: 200, json: body };
  };
  return {
    entries: [{ competitionId: CID, name: "Frozen Cup", state: "READY_TO_PUBLISH", access: "ORGANIZER" }, { competitionId: CID2, name: "Second Cup", state: "READY_TO_PUBLISH", access: "ORGANIZER" }],
    view, draw: (_r, id) => drawOf(id), ...extra,
  };
}
const drawOfNames = (names: string[], competitionId = CID): ScheduleReply => ({ status: 200, json: { draw: drawWire(makeDrawRecord({ teamNames: names, competitionId })) } });
const changeTo = (page: SchedulePage, id: string) => { page.$("#comp-select").value = id; page.$("#comp-select").dispatchEvent(new page.win.Event("change", { bubbles: true })); };
const ignoreAbort = (page: SchedulePage) => { page.run("AbortController.prototype.abort = function () { /* a fetch that does not honour abort */ }"); };

// ---------------------------------------------------------------------------------------------------------------------------------------------
describe("first paint, authority and visibility: the draw surface exists only for the confirmed organizer of one READY_TO_PUBLISH competition", () => {
  it("1. nothing draw-related is on first paint — not in the shipped markup, not once signed in, not once the competitions are listed — and no draw request is made", async () => {
    const shipped = new JSDOM(ADMIN_HTML).window.document;
    const copy = shipped.body.cloneNode(true) as HTMLElement;
    copy.querySelectorAll("script, style").forEach((n) => n.remove());
    expect(copy.innerHTML.toLowerCase(), "the shipped markup says nothing at all about a draw").not.toContain("draw");
    expect(shipped.querySelectorAll('[id*="draw"], [class*="draw"], [name*="draw"], [for*="draw"], [data-state]')).toHaveLength(0);

    const page = await openScheduleAdmin(withDraw(new MiniDrawServer()));
    expect(page.$$('[id^="draw-"], [class*="draw"]')).toHaveLength(0);
    expect(drawRequests(page)).toEqual([]);
    expect(page.controls()).toEqual(["select#comp-select", "button#btn-load-competition"]);
    // positive control: the surface does appear once the server has confirmed everything
    await loadCompetition(page);
    await page.settle(() => !!section(page), "the draw section once the server has confirmed everything");
    expect(page.$$('[id^="draw-"]').length).toBeGreaterThan(0);
    page.close();
  });

  it("2. a signed-out visitor sees nothing, and signing out removes the surface in the same turn, with every outstanding control dead", async () => {
    const out = openAmendAdminPage({ auth: { status: "unauthenticated" }, transport: scheduleTransport(withDraw(new MiniDrawServer())) });
    await tick(out, 120);
    expect(out.requests).toEqual([]);
    expect(out.visible(out.$("#admin-sections"))).toBe(false);
    expect(out.$$('[id^="draw-"]')).toHaveLength(0);
    out.close();

    const page = await drawPage();
    expect(page.$$("#draw-section")).toHaveLength(1);
    const make = page.$("#draw-make");
    page.setAuth({ status: "unauthenticated" });
    const before = page.requests.length;
    await page.fireAuthChange();
    expect(page.visible(page.$("#admin-sections"))).toBe(false);
    expect(section(page)).toBeNull();
    expect(page.$("#draw-read-note")).toBeNull();
    expect(page.run("drawState")).toBeNull();
    expect(page.run("drawAttempt")).toBeNull();
    make.click();
    await tick(page);
    expect(drawPosts(page)).toEqual([]);
    expect(page.requests.length).toBe(before);
    page.close();
  });

  it("3. a scorekeeper-only caller gets the addressed fixture and nothing of the draw: no surface, no read, no write, and nothing the page offers does anything", async () => {
    const organizer = await drawPage();
    organizer.close();

    const sk = openAmendAdminPage({
      auth: SIGNED_IN, search: `?c=${CODE}`,
      transport: (r) => r.url.startsWith("/api/gaming/competitions/resolve") ? { status: 200, json: { competitionId: CID } }
        : r.url === `/api/gaming/competitions/${CID}/scorekeeper-administration` ? { status: 200, json: { competition: { name: "Frozen Cup", state: "PUBLISHED" }, fixtures: [{ competitionFixtureId: "fx-1", state: "CHECKIN_OPEN", fixtureRole: "FINAL", scheduledAt: "2026-11-14T16:00:00.000Z", teamACompetitionTeamId: "t1", teamBCompetitionTeamId: "t2", scorekeeperGamingMemberId: "m-1" }], teams: [{ competitionTeamId: "t1", name: "Alpha" }, { competitionTeamId: "t2", name: "Bravo" }] } }
        : { status: 404, json: { error: "x" } },
    });
    await sk.settle(() => sk.text().includes("Frozen Cup"), "the scorekeeper view");
    await tick(sk);
    expect(sk.$$('[id^="draw-"]')).toHaveLength(0);
    expect(drawRequests(sk)).toEqual([]);
    expect(sk.controls()).toEqual(["button[Load Fixture Detail]"]);
    expect(sk.visible(sk.$("#organizer-only"))).toBe(false);
    // the page's own entry points, handed a perfectly confirmed organizer view, still do nothing in the scorekeeper context
    sk.run(`ensureDraw({ competitionId: ${JSON.stringify(CID)}, state: "READY_TO_PUBLISH" }, { planAmendment: { organizer: true } }); reestablishDraw();`);
    await tick(sk);
    expect(drawRequests(sk)).toEqual([]);
    expect(sk.$$('[id^="draw-"]')).toHaveLength(0);
    expect(sk.requests.filter((r) => r.method !== "GET")).toEqual([]);
    sk.close();
  });

  it("4. only READY_TO_PUBLISH asks: every other state asks nothing and shows nothing", async () => {
    const control = await drawPage();
    control.close();
    for (const state of ["DRAFT", "TEAM_REGISTRATION_OPEN", "PUBLISHED", "COMPLETE", "CANCELLED_WITHOUT_CHAMPION"]) {
      const page = await openScheduleAdmin({ ...withDraw(new MiniDrawServer()), state });
      await loadCompetition(page);
      await tick(page, 100);
      expect(section(page), state).toBeNull();
      expect(page.$$('[id^="draw-"]'), state).toHaveLength(0);
      expect(drawRequests(page), state).toEqual([]);
      page.close();
    }
  });

  it("5. the server's organizer signal is required: no signal, a captain-only signal, a signal that is neither role, and a signal that says organizer in text all ask nothing and show nothing", async () => {
    const control = await drawPage();
    control.close();
    const cases: Array<[string, ScheduleScenario]> = [
      ["no organizer signal at all", { signal: ABSENT }],
      ["a captain-only signal", { signal: { organizer: false, captain: true } }],
      ["a signal that is neither role", { signal: { organizer: false, captain: false } }],
      ["a signal that says organizer in text", { signal: { organizer: "true", captain: false } }],
    ];
    for (const [label, scenario] of cases) {
      const page = await openScheduleAdmin({ ...withDraw(new MiniDrawServer()), ...scenario });
      await loadCompetition(page);
      await tick(page, 100);
      expect(section(page), label).toBeNull();
      expect(page.$$('[id^="draw-"]'), label).toHaveLength(0);
      expect(drawRequests(page), label).toEqual([]);
      expect(page.controls(), label).toEqual(BASE_READY);
      page.close();
    }
  });

  it("6. while the authorization source, the competition detail or the draw read is pending there is nothing on the page", async () => {
    const control = await drawPage();
    control.close();

    const source = defer<ScheduleReply>();
    const early = openAmendAdminPage({ auth: SIGNED_IN, transport: (r) => (r.url === ADMIN_SOURCE ? source.promise : { status: 404, json: { error: "x" } }) });
    await tick(early);
    expect(early.$$('[id^="draw-"]')).toHaveLength(0);
    expect(drawRequests(early)).toEqual([]);
    source.resolve({ status: 200, json: { competitions: [{ competitionId: CID, name: "Frozen Cup", state: "READY_TO_PUBLISH", access: "ORGANIZER" }], operations: { createCompetition: false } } });
    await early.settle(() => early.$$("#comp-select option").length === 1, "the list");
    expect(early.$$('[id^="draw-"]')).toHaveLength(0);
    early.close();

    const detail = defer<ScheduleReply>();
    const read = defer<ScheduleReply>();
    const server = new MiniDrawServer();
    const page = await openScheduleAdmin(withDraw(server, { view: () => detail.promise, draw: () => read.promise }));
    page.$("#comp-select").value = CID;
    page.click(page.$("#btn-load-competition"));
    await page.settle(() => page.requests.some((r) => r.url === `/api/gaming/competitions/${CID}`), "the detail request");
    expect(drawRequests(page), "the detail is pending: no draw request").toEqual([]);
    expect(page.$$('[id^="draw-"]')).toHaveLength(0);
    detail.resolve({ status: 200, json: viewBody({ state: "READY_TO_PUBLISH", signal: ORGANIZER_SIGNAL }) });
    await page.settle(() => drawGets(page).length === 1, "the draw read");
    expect(page.$$('[id^="draw-"]'), "the draw read is pending: nothing of the draw, no note").toHaveLength(0);
    expect(page.controls()).toEqual(BASE_READY);
    expect(scheduleRequests(page)).toEqual([]);
    read.resolve(server.get());
    await page.settle(() => !!section(page), "the surface once the read has succeeded");
    expect(page.controls()).toEqual([...BASE_READY, "button#draw-make"]);
    page.close();
  });
});

// ---------------------------------------------------------------------------------------------------------------------------------------------
describe("failed, timed-out and malformed draw reads close the surface and say so in one bounded sentence — a malformed answer is never 'no draw yet'", () => {
  const closedAfter = async (scenario: ScheduleScenario) => {
    const page = await openScheduleAdmin(scenario);
    await loadCompetition(page);
    await page.settle(() => drawGets(page).length >= 1, "the draw read");
    await page.settle(() => !!page.$("#draw-read-note"), "the note");
    return page;
  };
  const GOOD = () => new MiniDrawServer();

  it("7a. a refusal, a failure and a dropped connection: the surface stays closed, there is no action and no schedule request, and the note is the page's own sentence (never the server's)", async () => {
    const control = await drawPage(GOOD());
    expect(text(control.$("#draw-heading"))).toBe("Make the draw");
    control.close();
    const cases: Array<[string, ScheduleScenario["draw"], string]> = [
      ["a 404", () => refusalReply("NOT_AVAILABLE"), COPY.readUnavailable],
      ["a 403", () => ({ status: 403, json: { error: "RAW 403 secret wording" } }), COPY.readUnavailable],
      ["a 401", () => ({ status: 401, json: { error: "RAW 401 secret wording" } }), COPY.readSignedOut],
      ["a 500", () => ({ status: 500, json: { error: "RAW 500: relation competition_draws does not exist" } }), COPY.readFailed],
      ["a 503", () => ({ status: 503, json: { error: "RAW 503 secret wording" } }), COPY.readFailed],
      ["a 400", () => ({ status: 400, json: { error: "RAW 400 secret wording" } }), COPY.readFailed],
      ["a dropped connection", () => Promise.reject(new Error("RAW offline wording")), COPY.readFailed],
    ];
    for (const [label, draw, expected] of cases) {
      const page = await closedAfter({ draw });
      expect(section(page), label).toBeNull();
      expect(note(page), label).toBe(expected);
      expect(page.visible(page.$("#draw-read-note")), label).toBe(true);
      expect(page.text(), `${label}: no raw server wording`).not.toMatch(/RAW /);
      expect(page.controls(), label).toEqual(BASE_READY);
      expect(page.$("#draw-make"), label).toBeNull();
      await tick(page, 60);
      expect(scheduleRequests(page), `${label}: no schedule request`).toEqual([]);
      expect(drawGets(page), `${label}: one read, no polling`).toHaveLength(1);
      page.close();
    }
  });

  it("7b. a read that never answers is a FAILED read: after the timeout nothing is open, the request was aborted, and a late answer changes nothing", async () => {
    const late = defer<ScheduleReply>();
    const page = await closedAfter({ draw: () => late.promise, drawTimeoutMs: 40 });
    expect(drawGets(page)[0].hasSignal).toBe(true);
    expect(drawGets(page)[0].aborted()).toBe(true);
    expect(note(page)).toBe(COPY.readFailed);
    expect(section(page)).toBeNull();
    late.resolve({ status: 200, json: { draw: null } });
    await tick(page, 80);
    expect(section(page), "a late answer renders nothing").toBeNull();
    expect(page.$("#draw-make")).toBeNull();
    expect(scheduleRequests(page)).toEqual([]);
    page.close();
  });

  const MALFORMED: Array<[string, unknown]> = [
    ["an empty object (the draw key is missing)", {}],
    ["draw: undefined", { draw: undefined }],
    ["draw: null with an extra key", { draw: null, alreadyDrawn: false }],
    ["draw: false", { draw: false }],
    ["draw: 0", { draw: 0 }],
    ["draw: an empty string", { draw: "" }],
    ["draw: an empty array", { draw: [] }],
    ["draw: an empty object", { draw: {} }],
    ["draw: a string", { draw: "none" }],
    ["a body that is a string", "nope"],
    ["a body that is an array", [null]],
    ["a body that is null", null],
    ["no body at all", undefined],
  ];
  it.each(MALFORMED)("7c. a malformed answer — %s — leaves the surface closed with no action: it is never read as 'no draw yet'", async (_label, body) => {
    const page = await closedAfter({ draw: () => ({ status: 200, json: body }) });
    expect(section(page)).toBeNull();
    expect(note(page)).toBe(COPY.readFailed);
    expect(page.$("#draw-make")).toBeNull();
    expect(page.text()).not.toContain(COPY.intro);
    expect(page.controls()).toEqual(BASE_READY);
    expect(scheduleRequests(page)).toEqual([]);
    page.close();
  });

  it("7d. a good read AFTER a failed one opens the surface and clears the note; a bad read AFTER a good one closes it again", async () => {
    let mode: "bad" | "good" = "bad";
    const server = GOOD();
    const page = await closedAfter({ draw: () => (mode === "bad" ? { status: 500, json: { error: "x" } } : server.get()) });
    expect(section(page)).toBeNull();
    mode = "good";
    page.click(page.$("#btn-load-competition"));
    await page.settle(() => !!section(page), "the surface after a good read");
    expect(page.$("#draw-read-note")).toBeNull();
    expect(page.controls()).toEqual([...BASE_READY, "button#draw-make"]);
    mode = "bad";
    page.click(page.$("#btn-load-competition"));
    await page.settle(() => !section(page) && !!page.$("#draw-read-note"), "the surface closed again");
    expect(note(page)).toBe(COPY.readFailed);
    expect(page.controls()).toEqual(BASE_READY);
    page.close();
  });
});

// ---------------------------------------------------------------------------------------------------------------------------------------------
describe("an exact { draw: null } opens the draw surface: a permanent-draw explanation and one action — nothing to choose", () => {
  it("8. the explanation, the positions rule and the single action are exactly the page's words, and the read was one uncached, authenticated, abortable GET", async () => {
    const server = new MiniDrawServer();
    const page = await drawPage(server);
    const s = section(page);
    expect(s.getAttribute("role")).toBe("region");
    expect(s.getAttribute("aria-labelledby")).toBe("draw-heading");
    expect(s.getAttribute("data-state")).toBe("absent");
    expect(s.hasAttribute("aria-busy")).toBe(false);
    expect(text(page.$("#draw-heading"))).toBe("Make the draw");
    expect(text(page.$("#draw-intro"))).toBe(COPY.intro);
    expect((page.$$("#draw-rules li") as Element[]).map(text)).toEqual(COPY.rules);
    expect(text(page.$("#draw-make"))).toBe(COPY.make);
    expect(page.$("#draw-make").className).toContain("dominant");
    expect(page.$("#draw-make").getAttribute("type")).toBe("button");
    expect(status(page)).toBe("");
    expect(page.controls()).toEqual([...BASE_READY, "button#draw-make"]);
    // a read, once: GET, uncached, authenticated, abortable, to the addressed competition's own route
    expect(drawGets(page)).toHaveLength(1);
    const [read] = drawGets(page);
    expect(read.url).toBe(DRAW_URL);
    expect(read.cache).toBe("no-store");
    expect(read.hasSignal).toBe(true);
    expect(read.headers.authorization).toBe("Bearer stub-token");
    expect(read.body).toBeUndefined();
    await tick(page, 150);
    expect(drawGets(page), "no polling").toHaveLength(1);
    expect(drawPosts(page)).toEqual([]);
    page.close();
  });

  it("8b. the section sits between the team tables and the schedule's own status lines, and the draw is read after the competition detail", async () => {
    const page = await drawPage();
    const order = (a: Element, b: Element) => !!(a.compareDocumentPosition(b) & 4);
    expect(order(page.$("#table-rejected-teams"), section(page))).toBe(true);
    expect(order(section(page), page.$("#schedule-read-note"))).toBe(true);
    expect(order(section(page), page.$("#schedule-host"))).toBe(true);
    expect(section(page).parentElement!.id).toBe("organizer-only");
    const urls = page.requests.map((r) => `${r.method} ${r.url}`);
    expect(urls.indexOf(`GET /api/gaming/competitions/${CID}`)).toBeGreaterThan(-1);
    expect(urls.indexOf(`GET ${DRAW_URL}`)).toBeGreaterThan(urls.indexOf(`GET /api/gaming/competitions/${CID}`));
    page.close();
  });

  it("9. before a draw the schedule is not asked for, offered or mentioned: no proposal request, no proposal or publication control, and no schedule-read failure — even when the schedule route would fail", async () => {
    const server = new MiniDrawServer();
    const page = await drawPage(server, { schedule: () => ({ status: 500, json: { error: "would fail" } }) });
    await tick(page, 150);
    expect(scheduleRequests(page)).toEqual([]);
    expect(publishRequests(page)).toEqual([]);
    expect(page.$("#schedule-section")).toBeNull();
    expect(page.$("#schedule-host").children).toHaveLength(0);
    expect(page.visible(page.$("#schedule-read-note"))).toBe(false);
    expect(text(page.$("#schedule-read-note"))).toBe("");
    expect(text(page.$("#msg-schedule"))).toBe("");
    expect(page.controls().filter((c) => c.includes("schedule"))).toEqual([]);
    expect(page.text()).not.toMatch(/schedule could not be loaded/i);
    page.close();
  });

  it("10. there is nothing to choose: the section holds exactly one control, no team, order, pairing, seed or format control, and no word that invites any", async () => {
    const page = await drawPage();
    expect((drawControls(page) as HTMLElement[]).map((c) => c.id)).toEqual(["draw-make"]);
    expect(page.$$("#draw-section input, #draw-section select, #draw-section textarea, #draw-section form, #draw-section a, #draw-section [draggable], #draw-section [contenteditable]")).toHaveLength(0);
    expect(page.$$("#draw-section [id*='seed'], #draw-section [id*='order'], #draw-section [id*='team'], #draw-section [id*='pair'], #draw-section [id*='format'], #draw-section [name]")).toHaveLength(0);
    const words = text(section(page));
    expect(words).not.toMatch(/re-?roll|re-?draw|shuffle|\bseed\b|entropy|permutation|choose (a |the )?team|pick (a |the )?team|reorder|drag|swap/i);
    expect(section(page).outerHTML).not.toMatch(UUID_ANY);
    expect(section(page).outerHTML).not.toMatch(HEX64);
    page.close();
  });
});

// ---------------------------------------------------------------------------------------------------------------------------------------------
describe("making the draw: exactly { intentId }, one request at a time, and the intent is kept when the outcome is unknown and replaced when it is known", () => {
  it("11. the request is a POST of exactly {\"intentId\":\"<uuid>\"} — which the real parser accepts — to the addressed competition's route, uncached, authenticated and abortable", async () => {
    const server = new MiniDrawServer();
    const page = await drawPage(server);
    page.click(page.$("#draw-make"));
    await page.settle(() => drawPosts(page).length === 1, "the draw request");
    const [post] = drawPosts(page);
    expect(post.url).toBe(DRAW_URL);
    expect(post.method).toBe("POST");
    expect(post.body, "the raw body is exactly one key").toMatch(/^\{"intentId":"[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}"\}$/);
    expect(Object.keys(post.json())).toEqual(["intentId"]);
    expect(intentOf(post)).toMatch(UUID_V4);
    expect(parseDrawRequest(post.json())).toEqual({ intentId: intentOf(post) });
    expect(post.cache).toBe("no-store");
    expect(post.hasSignal).toBe(true);
    expect(post.headers.authorization).toBe("Bearer stub-token");
    await page.settle(() => page.$("#draw-section")?.getAttribute("data-state") === "present", "the draw");
    expect(writes(page)).toHaveLength(1);
    expect(server.posts()).toEqual([{ intentId: intentOf(post) }]);
    page.close();
  });

  it("12. while the draw is being made nothing can be activated again: one request however many times it is activated, the action is disabled, the region is busy, and the focus does not fall to the page", async () => {
    const server = new MiniDrawServer();
    const answer = defer<ScheduleReply>();
    const page = await drawPage(server, { drawPost: () => answer.promise });
    const make = page.$("#draw-make");
    make.focus();
    expect(activeId(page)).toBe("draw-make");
    make.click(); make.click(); make.click();
    expect(make.disabled).toBe(true);
    expect(section(page).getAttribute("aria-busy")).toBe("true");
    expect(status(page)).toBe(COPY.making);
    // the page's own entry point is dead while a request is out, whoever calls it
    page.run("submitDraw(drawState)");
    page.run("submitDraw(drawState)");
    await tick(page, 80);
    expect(drawPosts(page)).toHaveLength(1);
    expect(page.controls()).toEqual([...BASE_READY, "button#draw-make"]);
    answer.resolve(server.post(drawPosts(page)[0].json()));
    await page.settle(() => section(page)?.getAttribute("data-state") === "present", "the draw");
    expect(section(page).hasAttribute("aria-busy")).toBe(false);
    expect(drawPosts(page)).toHaveLength(1);
    page.close();
  });

  type Build = (server: MiniDrawServer) => Partial<ScheduleScenario>;
  const UNCERTAIN: Array<[string, Build, string]> = [
    ["a request nobody answers (the page's own timeout)", () => ({ drawPost: () => never(), drawTimeoutMs: 40 }), COPY.timeout],
    ["a dropped connection", () => ({ drawPost: () => Promise.reject(new Error("offline")) }), COPY.network],
    ["a 201 whose body is not a draw", () => ({ drawPost: () => ({ status: 201, json: { not: "a draw" } }) }), COPY.unreadable],
    ["a 200 whose body is not a draw", () => ({ drawPost: () => ({ status: 200, json: { not: "a draw" } }) }), COPY.unreadable],
    ["a 201 with no body at all", () => ({ drawPost: () => ({ status: 201 }) }), COPY.unreadable],
    ["a 500", () => ({ drawPost: () => ({ status: 500, json: { error: "RAW 500: relation competition_draws does not exist" } }) }), COPY.unknown],
    ["a 502 with no body", () => ({ drawPost: () => ({ status: 502 }) }), COPY.unknown],
    ["a 503", () => ({ drawPost: () => ({ status: 503, json: { error: "RAW 503" } }) }), COPY.unknown],
  ];
  it.each(UNCERTAIN)("13. after %s the page asks the server what it holds BEFORE offering the action again, and the same intent goes out again", async (_label, build, expected) => {
    const server = new MiniDrawServer();
    const page = await drawPage(server, build(server));
    page.click(page.$("#draw-make"));
    await page.settle(() => drawPosts(page).length === 1 && drawGets(page).length === 2 && !!page.$("#draw-make") && !page.$("#draw-make").disabled, "the reconciling read and then the action");
    expect(trail(page), "a read, the write, then the reconciling read — and no second write").toEqual(["GET draw", "POST draw", "GET draw"]);
    expect(status(page)).toBe(expected + COPY.noneYet);
    expect(page.text(), "never the server's words").not.toMatch(/RAW /);
    expect(section(page).getAttribute("data-state")).toBe("absent");
    if (expected === COPY.timeout) expect(drawPosts(page)[0].aborted(), "the request that timed out was aborted").toBe(true);
    const first = intentOf(drawPosts(page)[0]);
    for (let n = 2; n <= 3; n++) {
      page.click(page.$("#draw-make"));
      await page.settle(() => drawPosts(page).length === n && drawGets(page).length === n + 1 && !!page.$("#draw-make") && !page.$("#draw-make").disabled, `attempt ${n}`);
      expect(intentOf(drawPosts(page)[n - 1]), `attempt ${n} keeps the intent`).toBe(first);
    }
    expect(page.run("drawAttempt.intentId")).toBe(first);
    page.close();
  });

  it("13b. when the lost answer was in fact a success, the reconciling read shows the draw: nothing more is offered, nothing is sent again, and the schedule follows", async () => {
    const server = new MiniDrawServer({ seed: seedFor(5) });
    const page = await drawPage(server, { drawPost: (r) => { server.post(r.json()); return never(); }, drawTimeoutMs: 40 });
    page.click(page.$("#draw-make"));
    await page.settle(() => section(page)?.getAttribute("data-state") === "present", "the draw found by the reconciling read");
    expect(status(page)).toBe(COPY.foundAfterUncertain);
    expect(page.$("#draw-make")).toBeNull();
    expect(drawControls(page)).toHaveLength(0);
    expect(drawPosts(page)).toHaveLength(1);
    expect(page.run("drawAttempt")).toBeNull();
    await page.settle(() => scheduleRequests(page).length === 1, "the schedule read, only now");
    expect(trail(page)).toEqual(["GET draw", "POST draw", "GET draw", "GET schedule"]);
    page.close();
  });

  it("13c. when a reconciling read is stale and the retry meets the committed draw, the same intent is answered with the exact replay (200) and the page shows the draw", async () => {
    const server = new MiniDrawServer();
    let reads = 0;
    let writesSeen = 0;
    const page = await drawPage(server, {
      // the first write reaches the database and commits, but its answer is lost as a 500; the next read is stale (still no draw)
      drawPost: (r) => { const out = server.post(r.json()); return ++writesSeen === 1 ? { status: 500, json: { error: "x" } } : out; },
      draw: () => (++reads <= 2 ? { status: 200, json: { draw: null } } : server.get()),
    });
    page.click(page.$("#draw-make"));
    await page.settle(() => drawPosts(page).length === 1 && reads === 2 && !!page.$("#draw-make") && !page.$("#draw-make").disabled, "the stale reconciling read and the action");
    expect(server.draw).not.toBeNull();
    const first = intentOf(drawPosts(page)[0]);
    page.click(page.$("#draw-make"));
    await page.settle(() => section(page)?.getAttribute("data-state") === "present", "the replay");
    expect(intentOf(drawPosts(page)[1])).toBe(first);
    expect(status(page)).toBe(COPY.replay);
    expect(drawPosts(page)).toHaveLength(2);
    expect(page.$("#draw-make")).toBeNull();
    page.close();
  });

  it("14. a new intent follows every conclusive refusal where no draw was made: a 400 and each 409 that is not ALREADY_DRAWN, and the action returns", async () => {
    const cases: Array<[string, (server: MiniDrawServer) => Partial<ScheduleScenario>]> = [
      ["a 400", () => ({ drawPost: () => ({ status: 400, json: { error: "The draw request is not valid.", problems: [{ field: "intentId", code: "INTENT_INVALID", message: "A draw identifier is required." }] } }) })],
      ...REFUSAL_CODES.filter((code) => code !== "ALREADY_DRAWN").map((code): [string, (server: MiniDrawServer) => Partial<ScheduleScenario>] => [`a 409 ${code}`, (server) => { server.refuse = code; return {}; }]),
    ];
    for (const [label, build] of cases) {
      const server = new MiniDrawServer();
      const page = await drawPage(server, build(server));
      page.click(page.$("#draw-make"));
      await page.settle(() => drawPosts(page).length === 1 && !!page.$("#draw-make") && !page.$("#draw-make").disabled && status(page) !== "", `${label}: the refusal`);
      expect(page.run("drawAttempt"), `${label}: the finished attempt is forgotten`).toBeNull();
      const first = intentOf(drawPosts(page)[0]);
      page.click(page.$("#draw-make"));
      await page.settle(() => drawPosts(page).length === 2 && !!page.$("#draw-make") && !page.$("#draw-make").disabled, `${label}: the second attempt`);
      const second = intentOf(drawPosts(page)[1]);
      expect(second, `${label}: a conclusive refusal is followed by a NEW intent`).not.toBe(first);
      expect(second).toMatch(UUID_V4);
      page.close();
    }
  });

  it("14b. a 401, 403 or 404 closes the surface (nothing else is offered); choosing Load reads again, and the next attempt is a NEW intent", async () => {
    for (const [label, reply] of [["a 401", { status: 401, json: { error: "x" } }], ["a 403", { status: 403, json: { error: "x" } }], ["a 404", refusalReply("NOT_AVAILABLE")]] as Array<[string, ScheduleReply]>) {
      const server = new MiniDrawServer();
      let refuse = true;
      const page = await drawPage(server, { drawPost: (r) => (refuse ? reply : server.post(r.json())) });
      page.click(page.$("#draw-make"));
      await page.settle(() => !section(page) && !!page.$("#draw-read-note"), `${label}: the surface closed`);
      expect(page.run("drawAttempt"), label).toBeNull();
      expect(page.controls(), label).toEqual(BASE_READY);
      const first = intentOf(drawPosts(page)[0]);
      refuse = false;
      page.click(page.$("#btn-load-competition"));
      await page.settle(() => !!section(page), `${label}: the surface after Load`);
      expect(page.$("#draw-read-note")).toBeNull();
      page.click(page.$("#draw-make"));
      await page.settle(() => drawPosts(page).length === 2, `${label}: the second attempt`);
      expect(intentOf(drawPosts(page)[1]), label).not.toBe(first);
      page.close();
    }
  });

  it("14c. an uncertain attempt's intent survives Load for the same competition and is forgotten for another one, a sign-out, and a finished attempt", async () => {
    const server = new MiniDrawServer();
    const page = await openScheduleAdmin(twoCompetitions(() => server.get(), { drawPost: () => Promise.reject(new Error("offline")) }));
    page.$("#comp-select").value = CID;
    page.click(page.$("#btn-load-competition"));
    await page.settle(() => !!section(page), "the first competition's surface");
    page.click(page.$("#draw-make"));
    await page.settle(() => drawPosts(page).length === 1 && drawGets(page).length === 2 && !page.$("#draw-make")?.disabled, "the uncertain attempt");
    const first = intentOf(drawPosts(page)[0]);
    // the same competition, loaded again: the intent is still there, and the next attempt reuses it
    page.click(page.$("#btn-load-competition"));
    await page.settle(() => !!section(page) && drawGets(page).length === 3, "the section after Load");
    expect(page.run("drawAttempt.intentId")).toBe(first);
    // another competition: forgotten at once
    changeTo(page, CID2);
    expect(page.run("drawAttempt")).toBeNull();
    page.close();

    const again = await openScheduleAdmin(withDraw(new MiniDrawServer(), { drawPost: () => Promise.reject(new Error("offline")) }));
    await loadCompetition(again);
    await again.settle(() => !!section(again), "the surface");
    again.click(again.$("#draw-make"));
    await again.settle(() => drawPosts(again).length === 1 && drawGets(again).length === 2 && !again.$("#draw-make")?.disabled, "the uncertain attempt");
    expect(again.run("drawAttempt")).not.toBeNull();
    again.setAuth({ status: "unauthenticated" });
    await again.fireAuthChange();
    expect(again.run("drawAttempt"), "signing out forgets it").toBeNull();
    again.close();
  });

  it("15. a 201 with the draw is not trusted on its own: the draw is read again from the server and THAT is what is shown — then, and only then, the schedule is asked for", async () => {
    const server = new MiniDrawServer({ seed: seedFor(5) });
    const page = await drawPage(server);
    page.click(page.$("#draw-make"));
    await page.settle(() => section(page)?.getAttribute("data-state") === "present", "the draw");
    await page.settle(() => scheduleRequests(page).length === 1, "the schedule read");
    expect(trail(page)).toEqual(["GET draw", "POST draw", "GET draw", "GET schedule"]);
    expect(drawGets(page)).toHaveLength(2);
    // index 5 is the lexicographic order [1, 4, 3, 2]
    const names = LEXICOGRAPHIC[5].map((p) => TEAM_NAMES[p - 1]);
    expect(names).toEqual(["Alpha FC", "Delta Rovers", "Charlie Town", "Bravo United"]);
    expect((page.$$("#draw-positions li") as Element[]).map(text)).toEqual(names.map((n, i) => `Position ${i + 1}: ${n}`));
    expect(text(page.$("#draw-heading"))).toBe("The permanent draw");
    expect(status(page)).toBe(COPY.made);
    expect(text(page.$("#draw-made"))).toBe("Made on 2026-11-07 14:20 UTC. This draw is permanent: it cannot be repeated, changed or undone.");
    expect(page.run("drawAttempt")).toBeNull();
    page.close();
  });

  it("15b. a 201 that the refreshing read contradicts — no draw, a different draw, a failure — is never shown as a success: the surface closes and says so", async () => {
    const other = makeDrawRecord({ index: 9 });
    const cases: Array<[string, ScheduleReply]> = [
      ["no draw", { status: 200, json: { draw: null } }],
      ["a different draw", { status: 200, json: { draw: drawWire(other) } }],
      ["a failure", { status: 500, json: { error: "x" } }],
      ["a malformed answer", { status: 200, json: { draw: {} } }],
    ];
    for (const [label, refreshed] of cases) {
      // the first read (the page's own) finds no draw; the write succeeds; the READ that follows the write is the one that disagrees
      const server = new MiniDrawServer({ seed: seedFor(5) });
      let reads = 0;
      const page = await drawPage(server, { draw: () => (++reads === 1 ? server.get() : refreshed) });
      page.click(page.$("#draw-make"));
      await page.settle(() => !section(page) && !!page.$("#draw-read-note"), `${label}: the surface closed`);
      expect(note(page), label).toBe(COPY.madeUnconfirmed);
      expect(page.$("#draw-make"), label).toBeNull();
      expect(page.$("#draw-positions"), label).toBeNull();
      expect(scheduleRequests(page), label).toEqual([]);
      page.close();
    }
  });

  it("16. a 200 with alreadyDrawn: true is an exact replay: the draw is read again, shown, and said to have been made already from the same request", async () => {
    const record = makeDrawRecord({ index: 11 });
    let made = false;
    const page = await drawPage(new MiniDrawServer(), {
      draw: () => ({ status: 200, json: { draw: made ? drawWire(record) : null } }),
      drawPost: () => { made = true; return { status: 200, json: { draw: drawWire(record), alreadyDrawn: true } }; },
    });
    page.click(page.$("#draw-make"));
    await page.settle(() => section(page)?.getAttribute("data-state") === "present", "the draw");
    expect(status(page)).toBe(COPY.replay);
    expect(drawGets(page)).toHaveLength(2);
    expect(page.$("#draw-make")).toBeNull();
    page.close();
  });

  const INCONSISTENT: Array<[string, number, (draw: any) => unknown]> = [
    ["a 201 that says alreadyDrawn: true", 201, (draw) => ({ draw, alreadyDrawn: true })],
    ["a 200 that says alreadyDrawn: false", 200, (draw) => ({ draw, alreadyDrawn: false })],
    ["a 201 without the flag", 201, (draw) => ({ draw })],
    ["a 201 whose flag is the text \"false\"", 201, (draw) => ({ draw, alreadyDrawn: "false" })],
    ["a 200 whose flag is the number 1", 200, (draw) => ({ draw, alreadyDrawn: 1 })],
    ["a 201 with an extra key", 201, (draw) => ({ draw, alreadyDrawn: false, intentId: "33333333-3333-4333-8333-333333333333" })],
    ["a 201 whose draw is null", 201, () => ({ draw: null, alreadyDrawn: false })],
    ["a 201 whose draw is not exactly a draw", 201, (draw) => ({ draw: { ...draw, teams: draw.teams.slice(0, 3) }, alreadyDrawn: false })],
    ["a 202 with a valid body", 202, (draw) => ({ draw, alreadyDrawn: false })],
  ];
  it.each(INCONSISTENT)("17. %s is never reported as a success: the page says it does not know, asks the server, and offers the action again with the same intent", async (_label, statusCode, build) => {
    const wireDraw = defaultDrawWire();
    const page = await drawPage(new MiniDrawServer(), { drawPost: () => ({ status: statusCode, json: build(clone(wireDraw)) }) });
    page.click(page.$("#draw-make"));
    await page.settle(() => drawPosts(page).length === 1 && drawGets(page).length === 2 && !!page.$("#draw-make") && !page.$("#draw-make").disabled, "the reconciling read and the action");
    expect(section(page).getAttribute("data-state")).toBe("absent");
    expect(status(page)).toContain("it is not known whether the draw was made");
    expect(status(page)).not.toMatch(/was made\. It is shown below/);
    expect(page.$("#draw-positions")).toBeNull();
    expect(scheduleRequests(page)).toEqual([]);
    page.click(page.$("#draw-make"));
    await page.settle(() => drawPosts(page).length === 2, "the retry");
    expect(intentOf(drawPosts(page)[1])).toBe(intentOf(drawPosts(page)[0]));
    page.close();
  });

  it("18. each refusal is explained in the page's own bounded words — never the server's — and says nothing about whether anything exists: 400, 401, 403, 404 and every 409 code", async () => {
    const withRaw = (reply: ScheduleReply): ScheduleReply => ({ status: reply.status, json: { ...(reply.json as object), error: `RAW ${reply.status} wording that must never be shown`, problems: [{ field: "x", code: "Y", message: "RAW PROBLEM wording" }] } });
    // 400
    {
      const page = await drawPage(new MiniDrawServer(), { drawPost: () => withRaw({ status: 400, json: { error: "x" } }) });
      page.click(page.$("#draw-make"));
      await page.settle(() => status(page) === COPY.refused400 && !page.$("#draw-make")?.disabled, "the 400");
      expect(page.text()).not.toMatch(/RAW /);
      expect(section(page).getAttribute("data-state")).toBe("absent");
      page.close();
    }
    // 401 / 403 / 404: the surface closes, and 403 and 404 are told identically — nothing says whether the competition or a draw exists
    const closed: Array<[string, ScheduleReply, string]> = [
      ["401", { status: 401, json: { error: "x" } }, COPY.refused401],
      ["403", { status: 403, json: { error: "x" } }, COPY.refusedUnavailable],
      ["404", refusalReply("NOT_AVAILABLE"), COPY.refusedUnavailable],
    ];
    const seen: string[] = [];
    for (const [label, reply, expected] of closed) {
      const page = await drawPage(new MiniDrawServer(), { drawPost: () => withRaw(reply) });
      page.click(page.$("#draw-make"));
      await page.settle(() => !section(page) && !!page.$("#draw-read-note"), `${label}: closed`);
      expect(note(page), label).toBe(expected);
      expect(page.text(), label).not.toMatch(/RAW /);
      expect(page.controls(), label).toEqual(BASE_READY);
      seen.push(`${label === "401" ? "" : note(page)}|${page.text()}`);
      page.close();
    }
    expect(seen[1], "a 403 and a 404 read exactly alike").toBe(seen[2]);
    // 409, by its stable code
    for (const code of REFUSAL_CODES) {
      const server = new MiniDrawServer();
      const lateDraw = makeDrawRecord({ index: 2 });
      let reads = 0;
      const page = await drawPage(server, {
        drawPost: () => withRaw(refusalReply(code)),
        // for ALREADY_DRAWN someone else has made the draw by the time the page reads again
        draw: () => (++reads === 1 || code !== "ALREADY_DRAWN" ? { status: 200, json: { draw: null } } : { status: 200, json: { draw: drawWire(lateDraw) } }),
      });
      page.click(page.$("#draw-make"));
      if (code === "ALREADY_DRAWN") {
        await page.settle(() => section(page)?.getAttribute("data-state") === "present", `${code}: the existing draw`);
        expect(page.$("#draw-make")).toBeNull();
      } else {
        await page.settle(() => status(page) === COPY.codes[code] && !!page.$("#draw-make") && !page.$("#draw-make").disabled, `${code}: the refusal`);
        expect(section(page).getAttribute("data-state")).toBe("absent");
      }
      expect(status(page), code).toBe(COPY.codes[code]);
      expect(page.text(), code).not.toMatch(/RAW /);
      page.close();
    }
    // a 409 with a code the page does not know, or none, is a refusal too — in the page's own generic words
    for (const body of [{ error: "RAW x", code: "SOMETHING_NEW" }, { error: "RAW y" }, "not json"]) {
      const page = await drawPage(new MiniDrawServer(), { drawPost: () => ({ status: 409, json: body }) });
      page.click(page.$("#draw-make"));
      await page.settle(() => status(page) === COPY.refused409 && !page.$("#draw-make")?.disabled, "the unknown 409");
      expect(page.text()).not.toMatch(/RAW /);
      page.close();
    }
  });

  it("18b. a 409 that says a draw already exists is believed only when the server then shows one: if the confirming read fails, or shows none, the surface closes and says only that it could not be loaded", async () => {
    const lateDraw = makeDrawRecord({ index: 2 });
    for (const [label, after] of [["a failing read", { status: 500, json: { error: "x" } } as ScheduleReply], ["a read that shows no draw", { status: 200, json: { draw: null } } as ScheduleReply], ["a malformed read", { status: 200, json: { draw: {} } } as ScheduleReply]] as Array<[string, ScheduleReply]>) {
      let reads = 0;
      const page = await drawPage(new MiniDrawServer(), { drawPost: () => refusalReply("ALREADY_DRAWN"), draw: () => (++reads === 1 ? { status: 200, json: { draw: null } } : after) });
      page.click(page.$("#draw-make"));
      await page.settle(() => !section(page) && !!page.$("#draw-read-note"), `${label}: the surface closed`);
      expect(note(page), label).toBe(COPY.readFailed);
      expect(page.text(), label).not.toContain(COPY.alreadyDrawn);
      expect(page.$("#draw-make"), label).toBeNull();
      expect(scheduleRequests(page), label).toEqual([]);
      page.close();
    }
    // and when it does show a draw, that draw is shown, and the schedule follows
    let reads = 0;
    const page = await drawPage(new MiniDrawServer(), { drawPost: () => refusalReply("ALREADY_DRAWN"), draw: () => (++reads === 1 ? { status: 200, json: { draw: null } } : { status: 200, json: { draw: drawWire(lateDraw) } }) });
    page.click(page.$("#draw-make"));
    await page.settle(() => section(page)?.getAttribute("data-state") === "present", "the existing draw");
    expect(status(page)).toBe(COPY.alreadyDrawn);
    expect(page.run("drawAttempt")).toBeNull();
    await page.settle(() => scheduleRequests(page).length === 1, "the schedule read");
    page.close();
  });

  it("20. the reconciling read comes BEFORE the action: while it is pending the region is busy and nothing can be sent; when it fails the surface closes and offers nothing, and Load brings the action back with the same intent", async () => {
    const server = new MiniDrawServer();
    const reconcile = defer<ScheduleReply>();
    let reads = 0;
    const page = await drawPage(server, { drawPost: () => Promise.reject(new Error("offline")), draw: () => (++reads === 2 ? reconcile.promise : server.get()) });
    page.click(page.$("#draw-make"));
    await page.settle(() => drawGets(page).length === 2, "the reconciling read");
    expect(page.$("#draw-make").disabled).toBe(true);
    expect(section(page).getAttribute("aria-busy")).toBe("true");
    page.run("submitDraw(drawState)");
    await tick(page, 60);
    expect(drawPosts(page), "nothing is sent while the server is being asked").toHaveLength(1);
    reconcile.resolve({ status: 500, json: { error: "x" } });
    await page.settle(() => !section(page) && !!page.$("#draw-read-note"), "the surface closed");
    expect(note(page)).toBe(COPY.network + COPY.unconfirmed);
    expect(page.$("#draw-make")).toBeNull();
    expect(page.controls()).toEqual(BASE_READY);
    const first = intentOf(drawPosts(page)[0]);
    page.click(page.$("#btn-load-competition"));
    await page.settle(() => !!section(page), "the surface after Load");
    page.click(page.$("#draw-make"));
    await page.settle(() => drawPosts(page).length === 2, "the retry");
    expect(intentOf(drawPosts(page)[1])).toBe(first);
    page.close();
  });
});

// ---------------------------------------------------------------------------------------------------------------------------------------------
describe("the draw as the server describes it: strictly validated, four unique positions and teams, and the semifinals follow the positions", () => {
  const BASE = () => clone(defaultDrawWire());
  type Mutation = [string, (d: any) => void];
  const swap = (a: any[], i: number, j: number) => { const t = a[i]; a[i] = a[j]; a[j] = t; };
  const MUTATIONS: Mutation[] = [
    ["an extra key on the draw", (d) => { d.createdBy = "m-1"; }],
    ["a missing key (seed)", (d) => { delete d.seed; }],
    ["a missing key (semifinals)", (d) => { delete d.semifinals; }],
    ["another algorithm", (d) => { d.algorithm = "URBANO-DRAW-PERMUTATION-V2"; }],
    ["no algorithm", (d) => { delete d.algorithm; }],
    ["a draw time without the six fractional digits", (d) => { d.drawnAt = "2026-11-07T14:20:00Z"; }],
    ["a draw time that is not a real instant", (d) => { d.drawnAt = "2026-13-07T14:20:00.654321Z"; }],
    ["a draw time that is not a date at all", (d) => { d.drawnAt = "yesterday"; }],
    ["a draw time that is a number", (d) => { d.drawnAt = 1794092485; }],
    ["a seed that is not 64 lowercase hexadecimal digits", (d) => { d.seed = d.seed.toUpperCase(); }],
    ["a seed that is too short", (d) => { d.seed = d.seed.slice(1); }],
    ["a permutation index out of range", (d) => { d.permutationIndex = 24; }],
    ["a negative permutation index", (d) => { d.permutationIndex = -1; }],
    ["a fractional permutation index", (d) => { d.permutationIndex = 1.5; }],
    ["a permutation index that is text", (d) => { d.permutationIndex = "3"; }],
    ["a draw digest in capitals", (d) => { d.drawDigest = d.drawDigest.toUpperCase(); }],
    ["a freeze digest that is short", (d) => { d.freezeDigest = d.freezeDigest.slice(2); }],
    ["three teams", (d) => { d.teams = d.teams.slice(0, 3); }],
    ["five teams", (d) => { d.teams.push(clone(d.teams[0])); }],
    ["teams that are not a list", (d) => { d.teams = "four"; }],
    ["the same team twice", (d) => { d.teams[1].teamId = d.teams[0].teamId; d.teams[1].teamName = d.teams[0].teamName; d.teams[1].inputPosition = d.teams[0].inputPosition; }],
    ["a draw position repeated", (d) => { d.teams[1].drawPosition = 1; }],
    ["positions out of order", (d) => { swap(d.teams, 0, 1); }],
    ["an input position repeated", (d) => { d.teams[1].inputPosition = d.teams[0].inputPosition; }],
    ["an input position out of range", (d) => { d.teams[3].inputPosition = 5; }],
    ["a team name that is empty", (d) => { d.teams[0].teamName = ""; d.semifinals[0].teamA.teamName = ""; d.inputOrder[0].teamName = ""; }],
    ["a team name that is only spaces", (d) => { d.teams[0].teamName = "   "; d.semifinals[0].teamA.teamName = "   "; d.inputOrder[0].teamName = "   "; }],
    ["a team name that is a number", (d) => { d.teams[0].teamName = 7; }],
    ["a team identifier that is not a UUID", (d) => { d.teams[0].teamId = "team-1"; }],
    ["an extra key on a team (a member identifier)", (d) => { d.teams[0].gamingMemberId = "m-1"; }],
    ["a team the input order does not know", (d) => { d.teams[0].teamId = "10000000-0000-4000-8000-0000000000ff"; }],
    ["a team name that differs from the input order's", (d) => { d.teams[0].teamName = "Somebody Else"; }],
    ["an input order that is not canonical", (d) => { swap(d.inputOrder, 0, 1); d.inputOrder[0].inputPosition = 1; d.inputOrder[1].inputPosition = 2; }],
    ["an input order with the wrong position numbers", (d) => { d.inputOrder[2].inputPosition = 4; }],
    ["an input order of three", (d) => { d.inputOrder = d.inputOrder.slice(0, 3); }],
    ["semifinals in the wrong order", (d) => { swap(d.semifinals, 0, 1); }],
    ["a wrong fixture role", (d) => { d.semifinals[1].fixtureRole = "FINAL"; }],
    ["one semifinal only", (d) => { d.semifinals = d.semifinals.slice(0, 1); }],
    ["three semifinals", (d) => { d.semifinals.push({ fixtureRole: "FINAL", teamA: d.teams[0], teamB: d.teams[1] }); }],
    ["a semifinal that pairs position 1 with position 3", (d) => { d.semifinals[0].teamB = { drawPosition: 3, teamId: d.teams[2].teamId, teamName: d.teams[2].teamName }; }],
    ["a semifinal whose sides are swapped", (d) => { const a = d.semifinals[0].teamA; d.semifinals[0].teamA = d.semifinals[0].teamB; d.semifinals[0].teamB = a; }],
    ["a semifinal side with an extra key", (d) => { d.semifinals[0].teamA.rank = 1; }],
    ["a semifinal side that names another team", (d) => { d.semifinals[1].teamB.teamId = "10000000-0000-4000-8000-0000000000ee"; }],
    // Each of these breaks exactly ONE rule and keeps every other field in agreement, so that no rule can hide behind another that happens to catch the same fault.
    ["the same team in two positions, with the semifinals made to agree (only the uniqueness rule can refuse it)", (d) => { d.teams[1] = { ...d.teams[0], drawPosition: 2 }; d.semifinals[0].teamB = { drawPosition: 2, teamId: d.teams[0].teamId, teamName: d.teams[0].teamName }; }],
    ["an extra key on an input team, nothing else wrong", (d) => { d.inputOrder[0].gamingMemberId = "m-1"; }],
    ["a team identifier that is not a UUID, everywhere it appears (and still first in order)", (d) => { const id = "0-not-a-uuid"; d.inputOrder[0].teamId = id; d.teams[0].teamId = id; d.semifinals[0].teamA.teamId = id; }],
    ["a team name that is a number, everywhere it appears", (d) => { d.inputOrder[0].teamName = 7; d.teams[0].teamName = 7; d.semifinals[0].teamA.teamName = 7; }],
    ["an input order that is not canonical, with everything else made to agree", (d) => { swap(d.inputOrder, 0, 1); d.inputOrder[0].inputPosition = 1; d.inputOrder[1].inputPosition = 2; d.teams[0].inputPosition = 2; d.teams[1].inputPosition = 1; }],
    ["a draw position that is not the team's place, with the semifinals made to agree", (d) => { d.teams[3].drawPosition = 5; d.semifinals[1].teamB.drawPosition = 5; }],
    ["a drawn team the input order does not know, with the semifinals made to agree", (d) => { const id = "10000000-0000-4000-8000-0000000000ff"; d.teams[0].teamId = id; d.semifinals[0].teamA.teamId = id; }],
    ["a drawn team named differently from the input team its position names, with the semifinals made to agree", (d) => { d.teams[0].teamName = "Somebody Else"; d.semifinals[0].teamA.teamName = "Somebody Else"; }],
    ["an input order of five (the fifth is never looked at unless the count is)", (d) => { d.inputOrder.push({ inputPosition: 5, teamId: "10000000-0000-4000-8000-000000000005", teamName: "Echo" }); }],
    ["an extra key on a semifinal itself", (d) => { d.semifinals[0].venue = "Pitch A"; }],
  ];

  it("21. an exact draw opens the surface (positive control); every deviation — a key more or less, a wrong type, a wrong count, a repeated team or position, semifinals that do not follow the positions — leaves it closed with the note and no partial draw", async () => {
    const control = await openScheduleAdmin({ draw: () => ({ status: 200, json: { draw: BASE() } }) });
    await loadCompetition(control);
    await control.settle(() => control.$("#draw-section")?.getAttribute("data-state") === "present", "the exact draw");
    control.close();
    expect(MUTATIONS.length).toBeGreaterThanOrEqual(53);
    for (const [label, mutate] of MUTATIONS) {
      const body = BASE();
      mutate(body);
      const page = await openScheduleAdmin({ draw: () => ({ status: 200, json: { draw: body } }) });
      await loadCompetition(page);
      await page.settle(() => !!page.$("#draw-read-note"), label);
      expect(note(page), label).toBe(COPY.readFailed);
      expect(section(page), label).toBeNull();
      expect(page.$("#draw-positions"), label).toBeNull();
      expect(page.$("#draw-make"), label).toBeNull();
      expect(scheduleRequests(page), label).toEqual([]);
      page.close();
    }
  });

  it("21b. the same strictness applies to a draw inside a 201: a deviation is an unreadable answer, never a success", async () => {
    for (const [label, mutate] of MUTATIONS.filter((_m, i) => i % 5 === 0)) {
      const body = BASE();
      mutate(body);
      const page = await drawPage(new MiniDrawServer(), { drawPost: () => ({ status: 201, json: { draw: body, alreadyDrawn: false } }) });
      page.click(page.$("#draw-make"));
      await page.settle(() => drawPosts(page).length === 1 && drawGets(page).length === 2 && !!page.$("#draw-make") && !page.$("#draw-make").disabled, label);
      expect(status(page), label).toBe(COPY.unreadable + COPY.noneYet);
      expect(page.$("#draw-positions"), label).toBeNull();
      page.close();
    }
  });

  it("22. four unique positions and four unique teams are shown, each exactly once, as the server returned them", async () => {
    const record = makeDrawRecord({ index: 13 });
    const page = await openScheduleAdmin({ draw: () => ({ status: 200, json: { draw: drawWire(record) } }) });
    await loadCompetition(page);
    await page.settle(() => !!page.$("#draw-positions"), "the draw");
    const items = (page.$$("#draw-positions li") as Element[]).map(text);
    expect(items).toHaveLength(4);
    expect(items.map((t) => t.match(/^Position (\d): /)![1])).toEqual(["1", "2", "3", "4"]);
    expect(new Set(items.map((t) => t.replace(/^Position \d: /, ""))).size).toBe(4);
    expect(items).toEqual(record.order.map((t) => `Position ${t.drawPosition}: ${t.teamName}`));
    page.close();
  });

  it("23. the semifinals follow the positions: positions 1 and 2 meet in Semifinal 1 and positions 3 and 4 in Semifinal 2 — for every one of the 24 possible draws, against an independent oracle", async () => {
    for (let index = 0; index < 24; index++) {
      const names = LEXICOGRAPHIC[index].map((p) => TEAM_NAMES[p - 1]);
      const page = await openScheduleAdmin({ draw: () => ({ status: 200, json: { draw: drawWire(makeDrawRecord({ index })) } }) });
      await loadCompetition(page);
      await page.settle(() => !!page.$("#draw-semifinals"), `draw ${index}`);
      expect((page.$$("#draw-positions li") as Element[]).map(text), `draw ${index}: positions`).toEqual(names.map((n, i) => `Position ${i + 1}: ${n}`));
      expect((page.$$("#draw-semifinals li") as Element[]).map(text), `draw ${index}: semifinals`).toEqual([
        `Semifinal 1 (positions 1 and 2): ${names[0]} vs ${names[1]}`,
        `Semifinal 2 (positions 3 and 4): ${names[2]} vs ${names[3]}`,
      ]);
      page.close();
    }
  });

  it("22b. what a reader sees: the draw time, the positions as bracket slots (never rankings), the pairings, and bounded audit references — no identifier, no seed, nothing that reads as a ranking", async () => {
    const record = makeDrawRecord({ index: 16 });
    const page = await openScheduleAdmin({ draw: () => ({ status: 200, json: { draw: drawWire(record) } }) });
    await loadCompetition(page);
    await page.settle(() => !!page.$("#draw-evidence"), "the draw");
    const s = section(page);
    expect(s.getAttribute("data-state")).toBe("present");
    expect(s.getAttribute("role")).toBe("region");
    expect(s.getAttribute("aria-labelledby")).toBe("draw-heading");
    expect(text(page.$("#draw-heading"))).toBe("The permanent draw");
    expect(text(page.$("#draw-made"))).toBe("Made on 2026-11-07 14:20 UTC. This draw is permanent: it cannot be repeated, changed or undone.");
    expect(text(page.$("#draw-slot-note"))).toBe("A position is a place in the bracket, not a ranking, a seeding or a priority.");
    const pairs = (page.$$("#draw-evidence dt") as Element[]).map((dt) => [text(dt), text(dt.nextElementSibling)]);
    expect(pairs).toEqual([["Method", record.algorithm], ["Draw record", record.drawDigest], ["Registration record", record.freezeDigest]]);
    // the audit references are the only hexadecimal in the section; the seed, the permutation and every identifier stay out of it
    expect([...(s.outerHTML.match(/[0-9a-f]{64}/gi) ?? [])].sort()).toEqual([record.drawDigest, record.freezeDigest].sort());
    expect(s.outerHTML).not.toContain(record.seed);
    expect(s.outerHTML).not.toMatch(UUID_ANY);
    // (the method's own name, URBANO-DRAW-PERMUTATION-V1, is the one place the word appears: it is the audit record's "Method", not the permutation that was drawn)
    expect(text(s).replace(record.algorithm, "")).not.toMatch(/\bseed\b|permutation|entropy|\bwinner|favou?rite|\branked\b|\bbest\b|\bstrongest\b/i);
    expect(text(s)).not.toMatch(/\bm-1\b|gamingMemberId|teamId|intent/i);
    page.close();
  });

  it("24. there is no redraw: once a draw exists the section has no control at all, no word that offers a redraw, and the page's own entry point refuses — also from a control captured earlier", async () => {
    const server = new MiniDrawServer();
    const page = await drawPage(server);
    const captured = page.$("#draw-make");
    page.click(captured);
    await page.settle(() => section(page)?.getAttribute("data-state") === "present", "the draw");
    expect(drawControls(page)).toHaveLength(0);
    expect(page.$("#draw-make")).toBeNull();
    expect(page.$$("#draw-section button")).toHaveLength(0);
    expect(text(section(page))).not.toMatch(/re-?draw|re-?roll|draw again|try again|replace|delete|edit|new draw|another draw/i);
    const before = drawPosts(page).length;
    captured.click();
    page.run("submitDraw(drawState)");
    await tick(page, 80);
    expect(drawPosts(page)).toHaveLength(before);
    expect(page.run("drawState.phase")).toBe("present");
    // reloading the competition with a draw in place offers no action either
    page.click(page.$("#btn-load-competition"));
    await page.settle(() => section(page)?.getAttribute("data-state") === "present" && drawGets(page).length === 3, "the reloaded draw");
    expect(drawControls(page)).toHaveLength(0);
    expect(drawPosts(page)).toHaveLength(before);
    page.close();
  });

  it("24b. a draw that was there before the page looked is shown the same way — read-only, with no action — and a later read that shows no draw, or another one, closes the draw AND the schedule that depends on it (a permanent draw never changes)", async () => {
    const record = makeDrawRecord({ index: 7 });
    let answer: ScheduleReply = { status: 200, json: { draw: drawWire(record) } };
    const page = await openScheduleAdmin({ draw: () => answer });
    await loadCompetition(page);
    await page.settle(() => section(page)?.getAttribute("data-state") === "present" && !!page.$("#schedule-section"), "the existing draw and the schedule that follows it");
    expect(drawControls(page)).toHaveLength(0);
    expect(status(page)).toBe("");
    answer = { status: 200, json: { draw: null } };
    page.run("refreshDraw(drawState, '', '', false, null)");
    await page.settle(() => !section(page) && !!page.$("#draw-read-note"), "the surface closed by a draw that vanished");
    expect(note(page)).toBe(COPY.readFailed);
    expect(page.$("#schedule-section"), "the schedule closes with the draw it depends on").toBeNull();
    expect(page.$("#schedule-host").children).toHaveLength(0);
    expect(page.run("scheduleState")).toBeNull();
    answer = { status: 200, json: { draw: drawWire(record) } };
    page.click(page.$("#btn-load-competition"));
    await page.settle(() => section(page)?.getAttribute("data-state") === "present" && !!page.$("#schedule-section"), "the draw and the schedule again");
    answer = { status: 200, json: { draw: drawWire(makeDrawRecord({ index: 8 })) } };
    page.run("refreshDraw(drawState, '', '', false, null)");
    await page.settle(() => !section(page) && !!page.$("#draw-read-note"), "the surface closed by a different draw");
    expect(page.$("#schedule-section"), "the schedule closes with the draw it depends on").toBeNull();
    expect(page.run("scheduleState")).toBeNull();
    page.close();
  });

  it("24c. the page's own check of its context refuses on its own, fact by fact — a competition no longer READY_TO_PUBLISH, a scorekeeper's access, a lost or inexact organizer signal, another competition's view or access, no view at all — even while the section is still standing", async () => {
    const control = await drawPage();
    control.click(control.$("#draw-make"));
    await control.settle(() => drawPosts(control).length === 1, "the positive control: with every fact true the request is sent");
    control.close();
    const PATCHES: Array<[string, string]> = [
      ["a competition that is no longer READY_TO_PUBLISH", "currentView.competition.state = 'PUBLISHED'"],
      ["a scorekeeper's access", "currentAccess = { competitionId: currentAccess.competitionId, access: 'SCOREKEEPER' }"],
      // (a signal is REPLACED, never edited in place: the harness hands every page the same signal object, and editing it would change every page that follows)
      ["a lost organizer signal", "currentView.planAmendment = { organizer: false, captain: false }"],
      ["a signal that says organizer in text", "currentView.planAmendment = { organizer: 'true', captain: false }"],
      ["no signal object", "currentView.planAmendment = null"],
      ["another competition's view", `currentView.competition.competitionId = '${CID2}'`],
      ["access to another competition", `currentAccess = Object.assign({}, currentAccess, { competitionId: '${CID2}' })`],
      ["no view at all", "currentView = null"],
    ];
    for (const [label, patch] of PATCHES) {
      const page = await drawPage();
      page.run(patch);
      page.click(page.$("#draw-make"));
      await tick(page, 80);
      expect(drawPosts(page), label).toEqual([]);
      expect(page.$("#draw-make").disabled, `${label}: nothing even started`).toBe(false);
      expect(section(page).hasAttribute("aria-busy"), label).toBe(false);
      page.close();
    }
  });

  for (const { label, value } of HOSTILE_PAYLOADS) {
    it(`25. a hostile team name (${label}) is shown as literal text — in the positions, the pairings and nowhere as markup — and nothing executes`, async () => {
      const page = await openScheduleAdmin({ draw: () => drawOfNames([value, `${value} 2`, `${value} 3`, `${value} 4`]) });
      await loadCompetition(page);
      await page.settle(() => !!page.$("#draw-positions"), "the draw");
      const s = section(page);
      assertNoLiveInjection(s);
      expect(s.querySelectorAll("img, svg, b, script, iframe")).toHaveLength(0);
      expect(text(s)).toContain(value);
      expect((page.$$("#draw-positions .draw-team") as Element[]).map((e) => e.textContent)).toEqual([value, `${value} 2`, `${value} 3`, `${value} 4`]);
      expect((page.$$("#draw-positions .draw-team") as Element[]).every((e) => e.children.length === 0)).toBe(true);
      expect((page.win as any).__xss).toBeUndefined();
      page.close();
    });
  }

  it("25b. a very long team name with no break in it stays whole, and the stylesheet lets it wrap instead of widening the page", async () => {
    const long = "W".repeat(5000);
    const page = await openScheduleAdmin({ draw: () => drawOfNames([long, "Bravo United", "Charlie Town", "Delta Rovers"]) });
    await loadCompetition(page);
    await page.settle(() => !!page.$("#draw-positions"), "the draw");
    expect((page.$$("#draw-positions .draw-team") as Element[])[0].textContent).toBe(long);
    expect(text(page.$$("#draw-semifinals li")[0])).toContain(long);
    const css = ADMIN_HTML.slice(ADMIN_HTML.indexOf("<style>"), ADMIN_HTML.indexOf("</style>"));
    expect(css).toMatch(/\.draw-card[^{]*\{[^}]*overflow-wrap:\s*break-word/);
    expect(css, "the page's stylesheet never uses the squeezing overflow-wrap: anywhere (UG-CR-GATE-087)").not.toContain("overflow-wrap: anywhere");
    page.close();
  });
});

// ---------------------------------------------------------------------------------------------------------------------------------------------
describe("changes of selection, session and detail reject late answers; nothing is duplicated", () => {
  const OLD = ["Old One", "Old Two", "Old Three", "Old Four"];
  const NEW = ["Zulu", "Yankee", "X-ray", "Whiskey"];

  it("26a. choosing another competition while the first one's draw read is pending: the first answer, arriving late, renders nothing — and the first request was aborted", async () => {
    const first = defer<ScheduleReply>();
    const page = await openScheduleAdmin(twoCompetitions((id) => (id === CID ? first.promise : drawOfNames(NEW, CID2))));
    page.$("#comp-select").value = CID;
    page.click(page.$("#btn-load-competition"));
    await page.settle(() => drawGets(page).length === 1, "the first read");
    changeTo(page, CID2);
    expect(page.$$('[id^="draw-"]'), "cleared in the same turn").toHaveLength(0);
    page.click(page.$("#btn-load-competition"));
    await page.settle(() => text(page.$("#draw-positions")).includes("Zulu"), "the second competition's draw");
    expect(drawGets(page)[0].aborted(), "the first read was aborted").toBe(true);
    first.resolve(drawOfNames(OLD));
    await tick(page, 80);
    expect(text(page.$("#draw-positions"))).toContain("Zulu");
    expect(text(section(page))).not.toContain("Old One");
    expect(page.$$("#draw-section")).toHaveLength(1);
    page.close();
  });

  it("26b. signing out while the draw read is pending: the late answer renders nothing and enables nothing — and no schedule is asked for", async () => {
    const read = defer<ScheduleReply>();
    const page = await openScheduleAdmin(withDraw(new MiniDrawServer(), { draw: () => read.promise }));
    await loadCompetition(page);
    await page.settle(() => drawGets(page).length === 1, "the read");
    page.setAuth({ status: "unauthenticated" });
    await page.fireAuthChange();
    read.resolve({ status: 200, json: { draw: defaultDrawWire() } });
    await tick(page, 80);
    expect(section(page)).toBeNull();
    expect(page.controls()).toEqual([]);
    expect(drawGets(page)[0].aborted()).toBe(true);
    expect(scheduleRequests(page)).toEqual([]);
    page.close();
  });

  it("26c. reloading the same competition's detail while a draw read is pending: only the newest read is believed, whatever order the answers arrive in", async () => {
    const old = defer<ScheduleReply>();
    const fresh = defer<ScheduleReply>();
    let n = 0;
    const page = await openScheduleAdmin({ draw: () => (++n === 1 ? old.promise : fresh.promise) });
    await loadCompetition(page);
    await page.settle(() => drawGets(page).length === 1, "the first read");
    page.click(page.$("#btn-load-competition"));
    await page.settle(() => drawGets(page).length === 2, "the second read");
    expect(drawGets(page)[0].aborted()).toBe(true);
    fresh.resolve(drawOfNames(["New One", "New Two", "New Three", "New Four"]));
    await page.settle(() => !!section(page), "the newest answer");
    old.resolve(drawOfNames(OLD));
    await tick(page, 80);
    expect(text(section(page))).toContain("New One");
    expect(text(section(page))).not.toContain("Old One");
    expect(page.$$("#draw-section")).toHaveLength(1);
    page.close();
  });

  it("26d. changing the selection while the draw is being made: the late answer neither renders nor claims anything, the request was aborted, and the other competition's draw read is its own", async () => {
    const answer = defer<ScheduleReply>();
    const server = new MiniDrawServer();
    const page = await openScheduleAdmin(twoCompetitions((id) => (id === CID ? server.get() : drawOfNames(NEW, CID2)), { drawPost: () => answer.promise }));
    page.$("#comp-select").value = CID;
    page.click(page.$("#btn-load-competition"));
    await page.settle(() => !!page.$("#draw-make"), "the first competition's surface");
    page.click(page.$("#draw-make"));
    await page.settle(() => drawPosts(page).length === 1, "the draw request");
    changeTo(page, CID2);
    expect(section(page), "the surface is cleared in the same turn").toBeNull();
    expect(drawPosts(page)[0].aborted()).toBe(true);
    expect(page.run("drawAttempt"), "another competition: the unfinished attempt is forgotten").toBeNull();
    answer.resolve({ status: 201, json: { draw: drawWire(makeDrawRecord()), alreadyDrawn: false } });
    await tick(page, 80);
    expect(section(page)).toBeNull();
    expect(drawGets(page), "no confirming read for the abandoned attempt").toHaveLength(1);
    page.click(page.$("#btn-load-competition"));
    await page.settle(() => !!section(page), "the other competition");
    expect(text(page.$("#draw-positions"))).toContain("Zulu");
    page.close();
  });

  it("26e. a session refresh while the draw is being made interrupts it honestly: the request is aborted, the page says it does not know, the intent is kept, and the surface returns from a fresh read that says what the server holds", async () => {
    const answer = defer<ScheduleReply>();
    const checking = defer<ScheduleReply>();
    const server = new MiniDrawServer();
    let reads = 0;
    // the read that re-establishes the surface after the refresh is the second one; a test holds it so the interim state can be seen
    const page = await drawPage(server, { drawPost: () => answer.promise, draw: () => (++reads === 2 ? checking.promise : server.get()) });
    page.click(page.$("#draw-make"));
    await page.settle(() => drawPosts(page).length === 1, "the draw request");
    const first = intentOf(drawPosts(page)[0]);
    await page.fireAuthChange();
    expect(drawPosts(page)[0].aborted()).toBe(true);
    expect(section(page), "removed in the same turn").toBeNull();
    expect(note(page)).toBe(COPY.interrupted + COPY.checking);
    // the interrupted write's own answer arrives late and, although it is a perfectly good 201, claims nothing and asks for nothing
    answer.resolve({ status: 201, json: { draw: drawWire(makeDrawRecord()), alreadyDrawn: false } });
    await tick(page, 60);
    expect(section(page)).toBeNull();
    expect(drawGets(page)).toHaveLength(2);
    checking.resolve(server.get());
    await page.settle(() => !!section(page), "the surface re-established from a fresh read");
    expect(page.$("#draw-read-note"), "the interim note goes once the server has answered").toBeNull();
    expect(section(page).getAttribute("data-state")).toBe("absent");
    expect(status(page), "what became of the interrupted request is kept, truthfully").toBe(COPY.interrupted + COPY.noneYet);
    expect(page.$$("#draw-section")).toHaveLength(1);
    expect(page.run("drawAttempt.intentId"), "the unfinished attempt keeps its intent").toBe(first);
    page.click(page.$("#draw-make"));
    await page.settle(() => drawPosts(page).length === 2, "the retry");
    expect(intentOf(drawPosts(page)[1])).toBe(first);
    page.close();
  });

  it("26e2. an interruption whose re-establishing read finds the draw says so truthfully and offers nothing; one whose read fails says it does not know and keeps the intent; signing out forgets both", async () => {
    // (a) the interrupted write had in fact been made: the fresh read shows the draw, and the unfinished attempt is over
    {
      const answer = defer<ScheduleReply>();
      const checking = defer<ScheduleReply>();
      const server = new MiniDrawServer();
      let reads = 0;
      const page = await drawPage(server, { drawPost: (r) => { server.post(r.json()); return answer.promise; }, draw: () => (++reads === 2 ? checking.promise : server.get()) });
      page.click(page.$("#draw-make"));
      await page.settle(() => drawPosts(page).length === 1, "the draw request");
      await page.fireAuthChange();
      expect(note(page)).toBe(COPY.interrupted + COPY.checking);
      checking.resolve(server.get());
      await page.settle(() => section(page)?.getAttribute("data-state") === "present", "the draw found by the fresh read");
      expect(status(page)).toBe(COPY.foundAfterUncertain);
      expect(page.$("#draw-make")).toBeNull();
      expect(page.$("#draw-read-note")).toBeNull();
      expect(page.run("drawAttempt")).toBeNull();
      expect(page.run("drawCarry")).toBeNull();
      page.close();
    }
    // (b) the fresh read fails: the surface stays closed, the note keeps what is known, and the intent is kept for a later Load
    {
      const answer = defer<ScheduleReply>();
      const checking = defer<ScheduleReply>();
      let reads = 0;
      const page = await drawPage(new MiniDrawServer(), { drawPost: () => answer.promise, draw: (_r, _id) => (++reads === 2 ? checking.promise : new MiniDrawServer().get()) });
      page.click(page.$("#draw-make"));
      await page.settle(() => drawPosts(page).length === 1, "the draw request");
      const first = intentOf(drawPosts(page)[0]);
      await page.fireAuthChange();
      checking.resolve({ status: 500, json: { error: "x" } });
      await page.settle(() => !section(page) && note(page) === COPY.interrupted + COPY.unconfirmed, "the closed surface and its note");
      expect(page.$("#draw-make")).toBeNull();
      expect(page.run("drawAttempt.intentId")).toBe(first);
      page.close();
    }
    // (c) the session ends while the interruption is being checked: nothing of it survives
    {
      const answer = defer<ScheduleReply>();
      const checking = defer<ScheduleReply>();
      let reads = 0;
      const page = await drawPage(new MiniDrawServer(), { drawPost: () => answer.promise, draw: () => (++reads === 2 ? checking.promise : new MiniDrawServer().get()) });
      page.click(page.$("#draw-make"));
      await page.settle(() => drawPosts(page).length === 1, "the draw request");
      await page.fireAuthChange();
      expect(note(page)).toBe(COPY.interrupted + COPY.checking);
      page.setAuth({ status: "unauthenticated" });
      await page.fireAuthChange();
      expect(page.$("#draw-read-note")).toBeNull();
      expect(page.run("drawAttempt")).toBeNull();
      expect(page.run("drawCarry")).toBeNull();
      checking.resolve(new MiniDrawServer({ draw: makeDrawRecord() }).get());
      await tick(page, 80);
      expect(section(page)).toBeNull();
      page.close();
    }
  });

  it("26f. a control captured before the surface was cleared does nothing when activated afterwards: after a selection change, a sign-out and a reload", async () => {
    const page = await openScheduleAdmin(twoCompetitions(() => new MiniDrawServer().get(), { drawPost: () => ({ status: 500, json: { error: "unexpected" } }) }));
    page.$("#comp-select").value = CID;
    page.click(page.$("#btn-load-competition"));
    await page.settle(() => !!page.$("#draw-make"), "the surface");
    const a = page.$("#draw-make");
    changeTo(page, CID2);
    a.click();
    page.click(page.$("#btn-load-competition"));
    await page.settle(() => !!page.$("#draw-make"), "the second surface");
    const b = page.$("#draw-make");
    page.click(page.$("#btn-load-competition"));
    await page.settle(() => !!page.$("#draw-make") && page.$("#draw-make") !== b, "the reloaded surface");
    b.click();
    const c = page.$("#draw-make");
    page.setAuth({ status: "unauthenticated" });
    await page.fireAuthChange();
    c.click();
    await tick(page, 80);
    expect(drawPosts(page)).toEqual([]);
    page.close();
  });

  it("26g. a draw read or a draw answer that arrives after the surface was removed renders nothing even when the fetch ignores abort: after a selection change, a sign-out, a reload and a lost organizer signal", async () => {
    const first = defer<ScheduleReply>();
    const a = await openScheduleAdmin(twoCompetitions((id) => (id === CID ? first.promise : drawOfNames(NEW, CID2))));
    ignoreAbort(a);
    a.$("#comp-select").value = CID;
    a.click(a.$("#btn-load-competition"));
    await a.settle(() => drawGets(a).length === 1, "the first read");
    changeTo(a, CID2);
    a.click(a.$("#btn-load-competition"));
    await a.settle(() => text(a.$("#draw-positions")).includes("Zulu"), "the second competition's draw");
    first.resolve(drawOfNames(OLD));
    await tick(a, 80);
    expect(text(a.$("#draw-positions"))).toContain("Zulu");
    expect(text(section(a))).not.toContain("Old One");
    a.close();

    const second = defer<ScheduleReply>();
    const b = await openScheduleAdmin(withDraw(new MiniDrawServer(), { draw: () => second.promise }));
    ignoreAbort(b);
    await loadCompetition(b);
    await b.settle(() => drawGets(b).length === 1, "the read");
    b.setAuth({ status: "unauthenticated" });
    await b.fireAuthChange();
    second.resolve({ status: 200, json: { draw: null } });
    await tick(b, 80);
    expect(section(b)).toBeNull();
    expect(b.controls()).toEqual([]);
    b.close();

    // a write answered after the surface was removed claims nothing and asks for nothing — even though the answer is a perfectly good 201
    const answer = defer<ScheduleReply>();
    const server = new MiniDrawServer();
    const c = await drawPage(server, { drawPost: () => answer.promise });
    ignoreAbort(c);
    c.click(c.$("#draw-make"));
    await c.settle(() => drawPosts(c).length === 1, "the write");
    c.click(c.$("#btn-load-competition"));
    await c.settle(() => !!c.$("#draw-make") && !c.$("#draw-make").disabled, "the reloaded surface");
    const reads = drawGets(c).length;
    answer.resolve({ status: 201, json: { draw: drawWire(makeDrawRecord()), alreadyDrawn: false } });
    await tick(c, 100);
    expect(c.$("#draw-section")?.getAttribute("data-state")).toBe("absent");
    expect(status(c)).toBe("");
    expect(drawGets(c), "no confirming read for an abandoned attempt").toHaveLength(reads);
    c.close();
  });

  it("26h. losing the organizer signal on a reload closes both the draw and the schedule at once", async () => {
    let signal: unknown = ORGANIZER_SIGNAL;
    const page = await openScheduleAdmin({ view: () => ({ status: 200, json: viewBody({ state: "READY_TO_PUBLISH", signal }) }) });
    await loadCompetition(page);
    await page.settle(() => !!page.$("#schedule-section") && !!section(page), "both surfaces");
    signal = { organizer: false, captain: true };
    page.click(page.$("#btn-load-competition"));
    await page.settle(() => !section(page) && !page.$("#schedule-section"), "both closed");
    expect(page.$$('[id^="draw-"]')).toHaveLength(0);
    expect(page.$("#schedule-host").children).toHaveLength(0);
    expect(page.run("drawState")).toBeNull();
    expect(page.run("scheduleState")).toBeNull();
    page.close();
  });

  it("26i. when the list of the caller's competitions fails to load, everything closes — the draw and the schedule included — and the unfinished attempt is forgotten", async () => {
    // (a competition that already has its draw, so that both surfaces stand before the list fails)
    const base = scheduleTransport(withDraw(new MiniDrawServer({ draw: makeDrawRecord() })));
    let adminFails = false;
    const page = openAmendAdminPage({ auth: SIGNED_IN, transport: (r) => (adminFails && r.url === ADMIN_SOURCE ? { status: 500, json: { error: "x" } } : base(r)) });
    await page.settle(() => page.$$("#comp-select option").length > 0, "the list");
    await loadCompetition(page);
    await page.settle(() => !!section(page) && !!page.$("#schedule-section"), "both surfaces");
    adminFails = true;
    await page.fireAuthChange();
    expect(section(page)).toBeNull();
    expect(page.$("#schedule-section")).toBeNull();
    expect(page.$$('[id^="draw-"]')).toHaveLength(0);
    expect(page.run("drawState")).toBeNull();
    expect(page.run("drawAttempt")).toBeNull();
    page.close();
  });

  it("27. nothing is duplicated however often the page reloads, re-authorizes or rebuilds: one section, one action, one handler, one request per activation", async () => {
    const server = new MiniDrawServer();
    const page = await drawPage(server);
    for (let i = 0; i < 3; i++) {
      page.click(page.$("#btn-load-competition"));
      await page.settle(() => !!section(page) && drawGets(page).length === 2 + i * 2, `reload ${i + 1}`);
      await page.fireAuthChange();
      await page.settle(() => !!section(page) && drawGets(page).length === 3 + i * 2, `re-authorization ${i + 1}`);
    }
    expect(page.$$("#draw-section")).toHaveLength(1);
    expect(page.$$("#draw-make")).toHaveLength(1);
    expect(page.$$("#draw-heading")).toHaveLength(1);
    expect(page.$$("#draw-status")).toHaveLength(1);
    expect(page.$$("#draw-read-note")).toHaveLength(0);
    expect(page.controls()).toEqual([...BASE_READY, "button#draw-make"]);
    // one activation reaches the page's submit routine exactly once
    page.run("window.__submits = 0; const original = submitDraw; submitDraw = function (state) { window.__submits += 1; return original(state); };");
    page.click(page.$("#draw-make"));
    await page.settle(() => section(page)?.getAttribute("data-state") === "present", "the draw");
    expect(page.run("window.__submits")).toBe(1);
    expect(drawPosts(page)).toHaveLength(1);
    expect(page.$$("#draw-section")).toHaveLength(1);
    expect(page.$$("#draw-positions")).toHaveLength(1);
    expect(page.$$("#schedule-section")).toHaveLength(1);
    page.close();
  });
});

// ---------------------------------------------------------------------------------------------------------------------------------------------
describe("the schedule waits for the draw: nothing of it is asked for, offered or reported until a fresh read has confirmed that a valid permanent draw exists", () => {
  it("28. the order is the detail, the draw read, and only then the schedule read: the schedule section comes after the draw section", async () => {
    const page = await openScheduleAdmin(withBoth(new MiniDrawServer({ draw: makeDrawRecord() }), seededSchedule()));
    await loadCompetition(page);
    await page.settle(() => !!page.$("#schedule-section") && !!section(page), "both sections");
    const urls = page.requests.map((r) => `${r.method} ${r.url}`);
    const at = (needle: string) => urls.indexOf(needle);
    expect(at(`GET /api/gaming/competitions/${CID}`)).toBeLessThan(at(`GET ${DRAW_URL}`));
    expect(at(`GET ${DRAW_URL}`)).toBeLessThan(at(`GET ${SCHEDULE_URL}`));
    expect(!!(section(page).compareDocumentPosition(page.$("#schedule-section")) & 4), "the schedule section follows the draw section").toBe(true);
    expect(page.controls()).toEqual([...BASE_READY, "button#schedule-publish", ...SCHEDULE_FORM_CONTROLS]);
    page.close();
  });

  it("28b. while the draw read is pending the schedule is not asked for; when it fails or is malformed the schedule is never asked for", async () => {
    const read = defer<ScheduleReply>();
    const pending = await openScheduleAdmin(withBoth(new MiniDrawServer({ draw: makeDrawRecord() }), seededSchedule(), { draw: () => read.promise }));
    await loadCompetition(pending);
    await pending.settle(() => drawGets(pending).length === 1, "the draw read");
    await tick(pending, 100);
    expect(scheduleRequests(pending)).toEqual([]);
    expect(pending.$("#schedule-section")).toBeNull();
    read.resolve({ status: 200, json: { draw: defaultDrawWire() } });
    await pending.settle(() => !!pending.$("#schedule-section"), "the schedule once the draw has been read");
    pending.close();
    for (const [label, answer] of [["a failure", { status: 500, json: { error: "x" } }], ["a malformed answer", { status: 200, json: { draw: { algorithm: "x" } } }], ["a refusal", refusalReply("NOT_AVAILABLE")], ["no draw", { status: 200, json: { draw: null } }]] as Array<[string, ScheduleReply]>) {
      const page = await openScheduleAdmin(withBoth(new MiniDrawServer(), seededSchedule(), { draw: () => answer }));
      await loadCompetition(page);
      await page.settle(() => drawGets(page).length === 1, label);
      await tick(page, 100);
      expect(scheduleRequests(page), label).toEqual([]);
      expect(publishRequests(page), label).toEqual([]);
      expect(page.$("#schedule-section"), label).toBeNull();
      page.close();
    }
  });

  it("28c. a draw made on this page is followed by the schedule: write, confirming read, then the schedule read — and not before", async () => {
    const draw = new MiniDrawServer();
    const schedule = seededSchedule();
    const page = await openScheduleAdmin(withBoth(draw, schedule));
    await loadCompetition(page);
    await page.settle(() => !!section(page), "the draw section");
    await tick(page, 120);
    expect(scheduleRequests(page), "before the draw: nothing").toEqual([]);
    page.click(page.$("#draw-make"));
    await page.settle(() => !!page.$("#schedule-section"), "the schedule section");
    expect(trail(page)).toEqual(["GET draw", "POST draw", "GET draw", "GET schedule"]);
    expect(!!(section(page).compareDocumentPosition(page.$("#schedule-section")) & 4)).toBe(true);
    page.close();
  });

  it("29. the existing schedule journey is unchanged after a draw made here: propose posts the same exact body, publish posts the same exact digest, and a published competition shows neither surface", async () => {
    const draw = new MiniDrawServer();
    const schedule = new MiniScheduleServer();
    const page = await openScheduleAdmin(withBoth(draw, schedule));
    await loadCompetition(page);
    await page.settle(() => !!section(page), "the draw section");
    page.click(page.$("#draw-make"));
    await page.settle(() => !!page.$("#schedule-section"), "the schedule section");
    expect(text(page.$("#schedule-latest"))).toContain("No schedule has been proposed yet.");
    chooseAll(page);
    page.click(page.$("#schedule-propose"));
    await page.settle(() => text(page.$("#schedule-latest")).includes("Proposal 1"), "the proposal");
    const proposal = writes(page).filter((r) => r.url === SCHEDULE_URL);
    expect(proposal).toHaveLength(1);
    expect(Object.keys(proposal[0].json())).toEqual(["intentId", "placements"]);
    expect(parseScheduleProposalRequest(proposal[0].json()).placements).toHaveLength(3);
    page.click(page.$("#schedule-publish"));
    await page.settle(() => publishRequests(page).length === 1, "the publication");
    expect(publishRequests(page)[0].url).toBe(PUBLISH_URL);
    expect(parsePublishRequest(publishRequests(page)[0].json())).toEqual({ kind: "SCHEDULE", scheduleProposalDigest: schedule.latest()!.proposalDigest });
    await page.settle(() => text(page.$("#comp-state-pill")) === "In progress" && !page.$("#schedule-section") && !section(page), "the published competition");
    expect(page.$$('[id^="draw-"]')).toHaveLength(0);
    expect(drawPosts(page)).toHaveLength(1);
    page.close();
  });

  it("29b. a schedule that fails after the draw is shown says so in the schedule's own sentence and leaves the draw on screen; a failure of the draw never produces the schedule's sentence", async () => {
    const page = await openScheduleAdmin(withDraw(new MiniDrawServer({ draw: makeDrawRecord() }), { schedule: () => ({ status: 500, json: { error: "x" } }) }));
    await loadCompetition(page);
    await page.settle(() => !page.$("#schedule-read-note")?.hidden && !!section(page), "the schedule note beside the draw");
    expect(text(page.$("#schedule-read-note"))).toMatch(/schedule could not be loaded/i);
    expect(section(page).getAttribute("data-state")).toBe("present");
    expect(page.$("#draw-read-note")).toBeNull();
    page.close();
    const failing = await openScheduleAdmin({ draw: () => ({ status: 500, json: { error: "x" } }) });
    await loadCompetition(failing);
    await failing.settle(() => !!failing.$("#draw-read-note"), "the draw note");
    expect(failing.visible(failing.$("#schedule-read-note"))).toBe(false);
    failing.close();
  });
});

// ---------------------------------------------------------------------------------------------------------------------------------------------
describe("nothing else changes: no format becomes selectable, no captain or member sees a draw, and the other pages are exactly what they were", () => {
  it("30. no new format is exposed: the draw section names no format, the only format choice is still the creation form's, and the page names no format beyond five-a-side", async () => {
    const page = await drawPage();
    expect(page.$$("#draw-section [id*='format'], #draw-section [name*='format'], #draw-section [class*='format'], #draw-section select")).toHaveLength(0);
    expect(section(page).outerHTML).not.toMatch(/SOCCER_|\b[5-8]\s?v\s?[5-8]\b/i);
    expect(ADMIN_HTML).not.toMatch(/SOCCER_[678]V[678]/i);
    expect(ADMIN_HTML).not.toMatch(/\b[678]\s?v\s?[678]\b/i);
    const selects = [...ADMIN_HTML.matchAll(/<select[^>]*>([\s\S]*?)<\/select>/g)].map((m) => m[1]).filter((s) => /SOCCER_/.test(s));
    expect(selects).toHaveLength(1);
    expect([...selects[0].matchAll(/<option value="([^"]*)"/g)].map((m) => m[1])).toEqual(["SOCCER_5V5"]);
    page.close();
  });

  it("31. no captain, member or public draw view is added: a captain-only signal on the organizer page asks nothing, the member page makes no draw request for a captain, and no other public file carries the draw", async () => {
    const control = await drawPage();
    expect(section(control)).not.toBeNull();
    control.close();

    const captainOnOrganizerPage = await openScheduleAdmin({ ...withDraw(new MiniDrawServer({ draw: makeDrawRecord() })), signal: { organizer: false, captain: true } });
    await loadCompetition(captainOnOrganizerPage);
    await tick(captainOnOrganizerPage, 120);
    expect(drawRequests(captainOnOrganizerPage)).toEqual([]);
    expect(captainOnOrganizerPage.$$('[id^="draw-"]')).toHaveLength(0);
    captainOnOrganizerPage.close();

    const captain = openAmendMemberPage({
      auth: SIGNED_IN, search: `?c=${CODE}`,
      transport: (r) => r.url.startsWith("/api/gaming/competitions/resolve") ? { status: 200, json: { competitionId: CID } }
        : r.url === `/api/gaming/competitions/${CID}` ? { status: 200, json: viewBody({ state: "READY_TO_PUBLISH", signal: { organizer: false, captain: true } }) }
        : r.url === DRAW_URL ? { status: 200, json: { draw: defaultDrawWire() } }
        : { status: 404, json: { error: "x" } },
    });
    await captain.settle(() => captain.requests.some((r) => r.url === `/api/gaming/competitions/${CID}`), "the addressed competition");
    await tick(captain, 150);
    expect(captain.requests.filter((r) => r.url.endsWith("/draw"))).toEqual([]);
    expect(captain.$$('[id^="draw-"]')).toHaveLength(0);
    expect(captain.text()).not.toMatch(/permanent draw|Make Permanent Draw/);
    captain.close();

    const files = walk(path.join(process.cwd(), "public"), (f) => /\.(html|js)$/.test(f));
    const carrying = files.filter((f) => /draw-section|draw-make|Make Permanent Draw|DRAW_PATH/.test(readFileSync(f, "utf8"))).map((f) => path.relative(process.cwd(), f));
    expect(carrying, "only the organizer page carries the draw").toEqual(["public/competitions-admin.html"]);
    expect(MEMBER_HTML).not.toMatch(/\/draw\b|draw-section|Make Permanent Draw/);
  });
});

function walk(dir: string, accept: (file: string) => boolean): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...walk(full, accept));
    else if (accept(full)) out.push(full);
  }
  return out;
}

// ---------------------------------------------------------------------------------------------------------------------------------------------
describe("the keyboard, the focus and the 375 px layout", () => {
  it("32. the action is a native button in document order with a name, the region is labelled, status is announced politely, and focus lands where the outcome is", async () => {
    const server = new MiniDrawServer();
    const page = await drawPage(server);
    const make = page.$("#draw-make") as HTMLButtonElement;
    expect(make.tagName).toBe("BUTTON");
    expect(make.tabIndex).toBe(0);
    expect(text(make)).toBe(COPY.make);
    expect(make.getAttribute("aria-describedby")!.split(" ").every((id) => !!page.doc.getElementById(id))).toBe(true);
    expect(page.$("#draw-heading").tabIndex).toBe(-1);
    expect(page.$("#draw-heading").tagName).toBe("H3");
    expect(page.$("#draw-status").getAttribute("aria-live")).toBe("polite");
    for (const el of drawControls(page) as HTMLElement[]) { expect(el.getAttribute("tabindex") === null || Number(el.getAttribute("tabindex")) <= 0).toBe(true); }
    expect(page.controls().indexOf("button#draw-make")).toBe(BASE_READY.length);
    make.focus();
    page.click(make);
    await page.settle(() => section(page)?.getAttribute("data-state") === "present", "the draw");
    expect(activeId(page), "success moves the focus to the new heading").toBe("draw-heading");
    page.close();
  });

  it("32b. the keyboard focus is not lost while a request is out: it returns to the action after a refusal, and after a reconciling read, whether the section is only re-enabled or rebuilt", async () => {
    // A browser moves the focus away from a control that becomes disabled; jsdom does not, so the transport does the equivalent at the moment of the request.
    let awayA = "";
    const a: SchedulePage = await drawPage(new MiniDrawServer(), { drawPost: () => { a.$("#comp-select").focus(); awayA = activeId(a); return { status: 400, json: { error: "x" } }; } });
    a.$("#draw-make").focus();
    expect(activeId(a)).toBe("draw-make");
    a.click(a.$("#draw-make"));
    await a.settle(() => status(a) === COPY.refused400 && !a.$("#draw-make").disabled, "the refusal");
    expect(awayA, "the focus really was taken away while the request was out").toBe("comp-select");
    expect(activeId(a), "re-enabled: the focus is back on the action").toBe("draw-make");
    a.close();

    let awayB = "";
    const server = new MiniDrawServer();
    server.refuse = "AMENDMENT_PENDING";
    const b: SchedulePage = await drawPage(server, { drawPost: (r) => { b.$("#comp-select").focus(); awayB = activeId(b); return server.post(r.json()); } });
    b.$("#draw-make").focus();
    b.click(b.$("#draw-make"));
    await b.settle(() => status(b) === COPY.codes.AMENDMENT_PENDING && !b.$("#draw-make").disabled, "the 409 and the reading that follows it");
    expect(awayB).toBe("comp-select");
    expect(activeId(b), "rebuilt: the focus is back on the action").toBe("draw-make");
    b.close();
  });

  it("32c. when the surface closes while the keyboard is inside it, the focus moves to the note that says why", async () => {
    const page = await drawPage(new MiniDrawServer(), { drawPost: () => ({ status: 404, json: { error: "x" } }) });
    page.$("#draw-make").focus();
    page.click(page.$("#draw-make"));
    await page.settle(() => !section(page) && !!page.$("#draw-read-note"), "the closed surface");
    expect(activeId(page)).toBe("draw-read-note");
    expect(page.$("#draw-read-note").tabIndex).toBe(-1);
    page.close();
  });

  it("33. the stylesheet gives the section a phone layout: wrapping text, 44 px targets, a single-column record at 720 px and below, and nothing that forces it wider than the screen", () => {
    const css = ADMIN_HTML.slice(ADMIN_HTML.indexOf("<style>"), ADMIN_HTML.indexOf("</style>"));
    const phone = [...css.matchAll(/@media\s*\(max-width:\s*(\d+)px\)\s*\{([\s\S]*?)\n  \}/g)].filter((m) => Number(m[1]) >= 640 && /draw/.test(m[2]));
    expect(phone.length, "a phone-width block for the draw section").toBeGreaterThan(0);
    const block = phone.map((m) => m[2]).join("\n");
    expect(block, "buttons keep a 44px target").toMatch(/draw-card[^{]*button[^{]*\{[^}]*min-height:\s*44px/);
    expect(block, "the record becomes one column").toMatch(/draw-facts[^{]*\{[^}]*grid-template-columns:\s*1fr/);
    expect(css, "long text wraps").toMatch(/\.draw-card[^{]*\{[^}]*overflow-wrap:\s*break-word/);
    expect(css, "touch targets on coarse pointers").toMatch(/@media \(pointer: coarse\) \{[^}]*\.draw-card button/);
    expect(css, "the focus ring on the heading and the note").toMatch(/#draw-heading:focus[^{]*\{[^}]*outline:/);
    expect(css, "nothing forces the section wider than the screen").not.toMatch(/draw[^{]*\{[^}]*(min-width:\s*(?!0)\d{3,}px|width:\s*\d{4,}px)/);
  });
});

// ---------------------------------------------------------------------------------------------------------------------------------------------
describe("the code: one request wrapper, one body, no randomness, no storage, no markup parsing", () => {
  const HEADER = 'UG-CR-GATE-SSS-031 — "Make the draw"';
  const NEXT_BLOCK = 'UG-CR-GATE-SSS-028 — "Schedule and publish"';
  const start = ADMIN_HTML.indexOf(HEADER);
  const block = () => ADMIN_HTML.slice(start, ADMIN_HTML.indexOf(NEXT_BLOCK, start));
  const functionsReading = (source: string, constant: string) => {
    let current = "";
    const reading = new Set<string>();
    for (const line of source.split("\n")) {
      current = /^(?:async\s+)?function\s+(\w+)\(/.exec(line)?.[1] ?? current;
      if (new RegExp(`\\b${constant}\\b`).test(line) && !line.startsWith(`const ${constant} =`)) reading.add(current);
    }
    return Array.from(reading).sort();
  };

  it("34. the draw code stores nothing, polls nothing, parses no server text as markup, and contains no source of randomness of its own", () => {
    expect(start).toBeGreaterThan(-1);
    const code = block();
    expect(code.length).toBeGreaterThan(3000);
    expect(code).not.toMatch(/localStorage|sessionStorage|document\.cookie|indexedDB|setInterval|navigator\.sendBeacon|XMLHttpRequest|WebSocket|EventSource/);
    expect(code).not.toMatch(/innerHTML|\bel\(|elRow\(|insertAdjacentHTML|outerHTML\s*=|document\.write|new Function|\beval\(|srcdoc|createContextualFragment/);
    expect(code).not.toMatch(/setAttribute\(\s*["']on/i);
    expect(code).not.toMatch(/\.href\s*=|\.src\s*=|location\.(assign|replace|href)|window\.open/);
    expect(code, "the one identifier it sends comes from the page's one UUID helper").not.toMatch(/Math\.random|getRandomValues|randomUUID|crypto\./);
    expect(code).not.toMatch(/createElement\(\s*["'](input|select|textarea|form)["']\)/);
  });

  it("35. one bounded request wrapper: every draw request goes through it, the path is one bounded constant read only there, and the only body ever built is { intentId }", () => {
    const code = block();
    expect(code.match(/\bauthedFetch\(/g) ?? []).toHaveLength(1);
    expect(code.match(/\bfetch\(/g) ?? []).toHaveLength(0);
    expect(ADMIN_HTML.match(/"\/draw"/g) ?? [], "the draw path is named once, as a bounded constant").toHaveLength(1);
    expect(code).toMatch(/const DRAW_PATH = "\/draw";/);
    expect(functionsReading(ADMIN_HTML, "DRAW_PATH")).toEqual(["drawFetch"]);
    expect(code.match(/\bdrawFetch\(/g) ?? [], "the declaration, the read and the write").toHaveLength(3);
    expect(code).toMatch(/drawFetch\(state, "GET"\)/);
    expect(code).toMatch(/drawFetch\(state, "POST", \{ intentId \}\)/);
    expect(code.match(/JSON\.stringify\(/g) ?? [], "the body is serialised in one place").toHaveLength(1);
    expect(ADMIN_HTML).not.toMatch(/competitions\/[^\s"'`<>]*\/draw(?![A-Za-z])/);
  });

  it("36. the code never builds a request from anything the organizer can touch: no form value, no select, no team, no seed, no order is read into a request", () => {
    const code = block();
    const submit = /async function submitDraw\(state\) \{[\s\S]*?\n\}\n/.exec(code);
    expect(submit, "submitDraw was found").not.toBeNull();
    expect(submit![0]).not.toMatch(/\.value|querySelector|getElementById|teamId|\bseed\b|pairing|\bformat|memberId/i);
    expect(submit![0].match(/drawFetch\(/g) ?? []).toHaveLength(1);
  });
});

describe("the new tests are registered in the explicit list", () => {
  it("package.json runs this file in the ordinary suite (npm test names every behavioral file explicitly)", () => {
    const pkg = JSON.parse(readFileSync(path.join(process.cwd(), "package.json"), "utf8"));
    expect(String(pkg.scripts.test).split(/\s+/)).toContain("__tests__/competitionDrawOrganizerPage.test.ts");
  });
});
