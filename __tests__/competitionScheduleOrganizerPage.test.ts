import { describe, expect, it } from "vitest";
import { JSDOM } from "jsdom";
import { createHash } from "node:crypto";
import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";

import { parseScheduleProposalRequest } from "../lib/gaming/competitions/scheduleProposal";
import { parsePublishRequest } from "../lib/gaming/competitions/schedulePublication";
import { openAmendAdminPage, openAmendMemberPage } from "./helpers/competitionPlanAmendmentPageHarness";
import {
  ABSENT, ADMIN_SOURCE, CID, CODE, GOOD_PLACEMENTS, MiniScheduleServer, OTHER_PLACEMENTS, ORGANIZER_SIGNAL, PITCH_A, PITCH_B, PITCH_C, PITCH_D, PUBLISH_URL, SCHEDULE_URL, SIGNED_IN, TEAM_NAMES,
  UUID_ANY, HEX64, chain, choose, chooseAll, contextRecord, defer, historyOf, loadCompetition, makeFacts, makeRecord, never, openScheduleAdmin, openSection, optionTexts, optionValues,
  publicationWire, publishRequests, readWire, scheduleRequests, scheduleTransport, viewBody, writes,
} from "./helpers/competitionScheduleOrganizerPageHarness";
import type { SchedulePage, ScheduleReply, ScheduleRequest, ScheduleScenario } from "./helpers/competitionScheduleOrganizerPageHarness";

/**
 * UG-CR-GATE-SSS-028 — the organizer's schedule-and-publish surface on the SHIPPED /competitions-admin.html, run whole in jsdom.
 *
 * WHAT THIS PROVES, AND WHAT IT DOES NOT. Everything here proves what the PAGE does with the answers a server gives it: when it shows the surface and when it never does,
 * what it sends, what it keeps and when it forgets, what it claims and when it refuses to claim. The server is a DOUBLE — but a faithful one: every answer is produced by the
 * real, already contract-tested server functions (the evaluator, the digests, the strict request parsers, the stored-evidence verifiers and the public mappers; see
 * helpers/competitionScheduleOrganizerPageHarness.ts), and every request the page sends is judged by the real parsers. It is not evidence about the real database, which the
 * loopback Supabase contract suites prove separately; and it is not a browser — the real page is also walked in a real browser at 375, 390 and desktop widths.
 *
 * Every test begins from a POSITIVE CONTROL (the surface does appear when the server confirms everything) so that a test of a refusal can never pass merely because the
 * surface does not exist at all.
 */

const ADMIN_HTML = readFileSync(path.join(process.cwd(), "public/competitions-admin.html"), "utf8");
const MEMBER_HTML = readFileSync(path.join(process.cwd(), "public/competitions.html"), "utf8");
const HOSTILE = '<img src=x onerror="window.__xss=(window.__xss||0)+1">';
const HOSTILE_BREAKOUT = '"><script>window.__xss=(window.__xss||0)+1</script>';
const CID2 = "99999999-9999-4999-8999-999999999999";
const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

const COPY4 = ["button[Copy Invitation Link]", "button[Copy Invitation Link]", "button[Copy Invitation Link]", "button[Copy Invitation Link]"];
/** The organizer page for a READY_TO_PUBLISH competition when nothing about the schedule is offered: no manual publication form any more. */
const BASE_READY = ["select#comp-select", "button#btn-load-competition", "button#btn-open-cancel", ...COPY4];
const SCHEDULE_FORM_CONTROLS = [
  "select#schedule-sf1-pitch", "select#schedule-sf1-date", "select#schedule-sf1-time", "select#schedule-sf2-pitch", "select#schedule-sf2-date", "select#schedule-sf2-time",
  "select#schedule-final-pitch", "select#schedule-final-date", "select#schedule-final-time", "button#schedule-propose",
];
const SCHEDULE_CONTROLS_CURRENT = ["button#schedule-publish", ...SCHEDULE_FORM_CONTROLS];
const BASELINE_LOADED_STATES: Array<[string, string, unknown[]]> = [
  ["TEAM_REGISTRATION_OPEN", "TEAM_REGISTRATION_OPEN", ["select#comp-select", "button#btn-load-competition", "button#btn-close-registration", "button#btn-open-cancel", ...COPY4]],
  ["PUBLISHED with two fixtures", "PUBLISHED", ["select#comp-select", "button#btn-load-competition", ...COPY4, "button[Load Fixture Detail]", "button[Load Fixture Detail]"]],
  ["COMPLETE with two fixtures", "COMPLETE", ["select#comp-select", "button#btn-load-competition", ...COPY4, "button[Load Fixture Detail]", "button[Load Fixture Detail]"]],
  ["CANCELLED", "CANCELLED_WITHOUT_CHAMPION", ["select#comp-select", "button#btn-load-competition", ...COPY4]],
];
const FIXTURES = [
  { competitionFixtureId: "fx-1", fixtureRole: "SEMIFINAL_1", state: "CHECKIN_OPEN", scheduledAt: "2026-11-14T16:00:00.000Z", teamACompetitionTeamId: "t1", teamBCompetitionTeamId: "t2", scorekeeperGamingMemberId: null },
  { competitionFixtureId: "fx-2", fixtureRole: "FINAL", state: "SCHEDULED", scheduledAt: "2026-11-14T21:00:00.000Z", teamACompetitionTeamId: null, teamBCompetitionTeamId: null, scorekeeperGamingMemberId: null },
];
/** The 26 controls of the post-freeze plan-change section (UG-CR-GATE-SSS-014), exactly as the untouched page builds them for an empty plan-change status. */
const PLAN_CHANGE_CONTROLS = [
  "input#plan-change-venue-name", "textarea#plan-change-venue-location", "input#plan-change-venue-capacity", "textarea#plan-change-venue-notes", "input[Pitch label]",
  "input[plan-change-pitch-usable]", "input[plan-change-pitch-format]", "input[Restrictions (optional)]", "button[Remove pitch]", "input[Pitch label]", "input[plan-change-pitch-usable]",
  "input[plan-change-pitch-format]", "input[Restrictions (optional)]", "button[Remove pitch]", "button#plan-change-add-pitch", "input[Tournament date]", "input[Window start]",
  "input[Window end]", "button[Remove window]", "input[Window start]", "input[Window end]", "button[Remove window]", "button#plan-change-add-date", "button#plan-change-submit",
];

const text = (el: Element | null): string => (el?.textContent ?? "").replace(/\s+/g, " ").trim();
const clone = <T,>(value: T): any => JSON.parse(JSON.stringify(value));

/** A mini server behind the scenario: the real routes' parsers and evaluator answer, and the competition's view follows its state. */
function withServer(server: MiniScheduleServer, extra: Partial<ScheduleScenario> = {}): ScheduleScenario {
  return {
    schedule: () => ({ status: 200, json: server.read() }),
    propose: (r) => server.propose(r.json()),
    publish: (r) => server.publish(r.json()),
    view: () => ({ status: 200, json: viewBody({ state: server.published ? "PUBLISHED" : "READY_TO_PUBLISH", signal: ORGANIZER_SIGNAL }) }),
    ...extra,
  };
}
const seeded = (n = 3) => new MiniScheduleServer({ records: chain(n) });
async function sectionWith(server: MiniScheduleServer, extra: Partial<ScheduleScenario> = {}): Promise<SchedulePage> {
  const page = await openScheduleAdmin(withServer(server, extra));
  await openSection(page);
  return page;
}
const section = (page: SchedulePage) => page.$("#schedule-section");
const tick = (page: SchedulePage, ms = 60) => page.idle(ms);
/** The context facts as { term: [values...] } — a term can repeat (one per date). */
function contextFacts(page: SchedulePage): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  for (const dt of page.$$("#schedule-context dt") as Element[]) {
    const term = text(dt);
    if (!out[term]) out[term] = [];
    out[term].push(text(dt.nextElementSibling));
  }
  return out;
}
/** The live facts the page uses to decide whether publication may be offered, evaluated on a COPY of the live state with a patch applied. */
function factsWith(page: SchedulePage, patch: string): Record<string, boolean> {
  return JSON.parse(page.run(`JSON.stringify(scheduleFacts(Object.assign({}, scheduleState, ${patch})))`) as string);
}
const proposalPatch = (fields: string) => `{ proposal: Object.assign({}, scheduleState.proposal, ${fields}) }`;
function visibleText(page: SchedulePage, selector: string): string { return text(page.$(selector)); }

// ---------------------------------------------------------------------------------------------------------------------------------------------
describe("first paint, authority and visibility: the surface exists only for the confirmed organizer of one addressed competition", () => {
  it("1. nothing schedule-related is on first paint — not in the shipped markup, not once signed in, not once the competitions are listed — and no schedule request is made", async () => {
    const shipped = new JSDOM(ADMIN_HTML).window.document;
    const ids = [...shipped.querySelectorAll("[id]")].map((e) => e.id).filter((id) => /schedule|publish|^p-/.test(id)).sort();
    expect(ids, "the only schedule-related markup is three empty containers").toEqual(["msg-schedule", "schedule-host", "schedule-read-note"]);
    expect(shipped.querySelectorAll("#schedule-host *, #schedule-read-note *, #msg-schedule *")).toHaveLength(0);
    expect((shipped.getElementById("schedule-read-note") as HTMLElement).hidden).toBe(true);
    const copy = shipped.body.cloneNode(true) as HTMLElement;
    copy.querySelectorAll("script, style").forEach((n) => n.remove());
    expect(copy.textContent).not.toContain("Publish Competition");

    const page = await openScheduleAdmin(withServer(seeded()));
    expect(page.$$('[id^="schedule-"]').map((e: Element) => e.id).sort()).toEqual(["schedule-host", "schedule-read-note"]);
    expect(scheduleRequests(page)).toEqual([]);
    expect(page.controls()).toEqual(["select#comp-select", "button#btn-load-competition"]);
    expect(page.visible(page.$("#schedule-read-note"))).toBe(false);
    expect(visibleText(page, "#msg-schedule")).toBe("");
    // positive control: the surface does appear once the server has confirmed everything
    await openSection(page);
    expect(section(page)).not.toBeNull();
    page.close();
  });

  it("2. the manual team-and-time publication form is gone — from the markup, from the page's code and from the loaded page, whatever the schedule read does", async () => {
    for (const gone of ["publish-form", "btn-publish", "msg-publish", "p-sf1a", "p-sf1b", "p-sf2a", "p-sf2b", "p-sf1-time", "p-sf2-time", "p-final-time"]) {
      expect(ADMIN_HTML, gone).not.toContain(`"${gone}"`);
    }
    for (const legacy of ["semifinal1TeamAId", "semifinal1TeamBId", "semifinal2TeamAId", "semifinal2TeamBId", "semifinal1ScheduledAt", "semifinal2ScheduledAt", "finalScheduledAt"]) {
      expect(ADMIN_HTML, `the legacy field ${legacy}`).not.toContain(legacy);
    }
    const outcomes: Array<[string, ScheduleScenario]> = [
      ["a good read", {}],
      ["a refused read", { schedule: () => ({ status: 404, json: { error: "A schedule proposal was not found for this competition." } }) }],
      ["a failed read", { schedule: () => ({ status: 500, json: { error: "boom" } }) }],
      ["a dropped read", { schedule: () => Promise.reject(new Error("offline")) }],
      ["a malformed read", { schedule: () => ({ status: 200, json: { not: "a schedule" } }) }],
      ["a silent read", { schedule: () => never(), timeoutMs: 30 }],
    ];
    for (const [label, scenario] of outcomes) {
      const page = await openScheduleAdmin(scenario);
      await loadCompetition(page);
      await page.settle(() => scheduleRequests(page).length >= 1, `${label}: the schedule read`);
      await tick(page, 120);
      expect(page.$$('input[type="datetime-local"]'), label).toHaveLength(0);
      expect(page.$$("select").map((s: Element) => s.id).filter((id: string) => !id.startsWith("schedule-") && id !== "comp-select" && id !== "c-activity"), label).toEqual([]);
      expect(page.controls().filter((c) => /p-sf|p-final|btn-publish|datetime/.test(c)), label).toEqual([]);
      page.close();
    }
    // positive control
    const page = await openScheduleAdmin(withServer(seeded()));
    await openSection(page);
    expect(page.controls()).toEqual([...BASE_READY, ...SCHEDULE_CONTROLS_CURRENT]);
    page.close();
  });

  it("3. a signed-out visitor sees nothing, and signing out removes the surface in the same turn, with every outstanding answer ignored", async () => {
    // (a signed-out page never lists competitions, so it is opened directly rather than through the helper that waits for the list)
    const out = openAmendAdminPage({ auth: { status: "unauthenticated" }, transport: scheduleTransport(withServer(seeded())) });
    await tick(out, 120);
    expect(out.requests).toEqual([]);
    expect(out.visible(out.$("#admin-sections"))).toBe(false);
    out.close();

    const page = await sectionWith(seeded());
    expect(page.$$("#schedule-section")).toHaveLength(1);
    const publishButton = page.$("#schedule-publish");
    page.setAuth({ status: "unauthenticated" });
    const before = page.requests.length;
    await page.fireAuthChange();
    expect(page.visible(page.$("#admin-sections"))).toBe(false);
    expect(section(page)).toBeNull();
    expect(page.$("#schedule-host").children).toHaveLength(0);
    expect(page.run("scheduleState")).toBeNull();
    // a control captured before sign-out does nothing when it is activated afterwards
    publishButton.click();
    await tick(page);
    expect(publishRequests(page)).toEqual([]);
    expect(page.requests.length).toBe(before);
    page.close();
  });

  it("4. a scorekeeper-only caller gets the addressed fixture and nothing of the schedule: no surface, no read, and nothing hidden does anything", async () => {
    const organizer = await sectionWith(seeded());
    organizer.close();

    const sk = openAmendAdminPage({
      auth: SIGNED_IN, search: `?c=${CODE}`,
      transport: (r) => r.url.startsWith("/api/gaming/competitions/resolve") ? { status: 200, json: { competitionId: CID } }
        : r.url === `/api/gaming/competitions/${CID}/scorekeeper-administration` ? { status: 200, json: { competition: { name: "Frozen Cup", state: "PUBLISHED" }, fixtures: [{ competitionFixtureId: "fx-1", state: "CHECKIN_OPEN", fixtureRole: "FINAL", scheduledAt: "2026-11-14T16:00:00.000Z", teamACompetitionTeamId: "t1", teamBCompetitionTeamId: "t2", scorekeeperGamingMemberId: "m-1" }], teams: [{ competitionTeamId: "t1", name: "Alpha" }, { competitionTeamId: "t2", name: "Bravo" }] } }
        : { status: 404, json: { error: "x" } },
    });
    await sk.settle(() => sk.text().includes("Frozen Cup"), "the scorekeeper view");
    await tick(sk);
    expect(sk.$("#schedule-section")).toBeNull();
    expect(sk.$("#schedule-host").children).toHaveLength(0);
    expect(scheduleRequests(sk)).toEqual([]);
    expect(sk.controls()).toEqual(["button[Load Fixture Detail]"]);
    expect(sk.visible(sk.$("#organizer-only"))).toBe(false);
    // the persistent publication line and the read note stay empty and hidden
    expect(visibleText(sk, "#msg-schedule")).toBe("");
    expect(sk.visible(sk.$("#schedule-read-note"))).toBe(false);
    await tick(sk);
    expect(sk.requests.filter((r) => r.method !== "GET")).toEqual([]);
    sk.close();
  });

  it("5. while the competitions, the competition detail or the schedule read is pending there is nothing on the page", async () => {
    const detail = defer<ScheduleReply>();
    const read = defer<ScheduleReply>();
    const server = seeded();
    const page = await openScheduleAdmin(withServer(server, { view: () => detail.promise, schedule: () => read.promise }));
    page.$("#comp-select").value = CID;
    page.click(page.$("#btn-load-competition"));
    await page.settle(() => page.requests.some((r) => r.url === `/api/gaming/competitions/${CID}`), "the detail request");
    // the detail is pending: no organizer information, no schedule request, no surface
    expect(scheduleRequests(page)).toEqual([]);
    expect(section(page)).toBeNull();
    expect(page.controls()).toEqual(["select#comp-select", "button#btn-load-competition"]);
    detail.resolve({ status: 200, json: viewBody({ state: "READY_TO_PUBLISH", signal: ORGANIZER_SIGNAL }) });
    await page.settle(() => scheduleRequests(page).length === 1, "the schedule request");
    // the schedule read is pending: still nothing schedule-related, and no manual form either
    expect(section(page)).toBeNull();
    expect(page.$("#schedule-host").children).toHaveLength(0);
    expect(page.controls()).toEqual(BASE_READY);
    expect(page.visible(page.$("#schedule-read-note"))).toBe(false);
    read.resolve({ status: 200, json: server.read() });
    await page.settle(() => !!section(page), "the surface once the read has succeeded");
    expect(page.controls()).toEqual([...BASE_READY, ...SCHEDULE_CONTROLS_CURRENT]);
    page.close();
  });

  it("5b. the authorization source pending: nothing is offered until it answers", async () => {
    const source = defer<ScheduleReply>();
    const page = openAmendAdminPage({
      auth: SIGNED_IN, transport: (r) => (r.url === ADMIN_SOURCE ? source.promise : { status: 404, json: { error: "x" } }),
    });
    await tick(page);
    expect(page.$$("#comp-select option")).toHaveLength(0);
    expect(page.$("#schedule-host").children).toHaveLength(0);
    expect(page.requests.filter((r) => r.url.includes("schedule-proposal"))).toEqual([]);
    source.resolve({ status: 200, json: { competitions: [{ competitionId: CID, name: "Frozen Cup", state: "READY_TO_PUBLISH", access: "ORGANIZER" }], operations: { createCompetition: false } } });
    await page.settle(() => page.$$("#comp-select option").length === 1, "the list");
    expect(page.$("#schedule-host").children).toHaveLength(0);
    page.close();
  });

  it("5c. only an organizer view of a READY_TO_PUBLISH competition that carries the server's organizer signal ever asks: every other state, signal and caller asks nothing and shows nothing", async () => {
    const control = await sectionWith(seeded());
    control.close();
    const cases: Array<[string, ScheduleScenario]> = [
      ["no organizer signal at all", { signal: ABSENT }],
      ["a captain-only signal", { signal: { organizer: false, captain: true } }],
      ["a signal that is neither role", { signal: { organizer: false, captain: false } }],
      ["a signal that says organizer in text", { signal: { organizer: "true", captain: false } }],
      ["DRAFT", { state: "DRAFT" }],
      ["TEAM_REGISTRATION_OPEN", { state: "TEAM_REGISTRATION_OPEN" }],
      ["PUBLISHED", { state: "PUBLISHED" }],
      ["COMPLETE", { state: "COMPLETE" }],
      ["CANCELLED_WITHOUT_CHAMPION", { state: "CANCELLED_WITHOUT_CHAMPION" }],
    ];
    const server = seeded();
    for (const [label, scenario] of cases) {
      // the schedule routes answer fully and happily in every case; only the page's own preconditions differ (the view follows the scenario's state and signal)
      const page = await openScheduleAdmin({ schedule: () => ({ status: 200, json: server.read() }), propose: (r) => server.propose(r.json()), publish: (r) => server.publish(r.json()), ...scenario });
      await loadCompetition(page);
      await tick(page, 100);
      expect(section(page), label).toBeNull();
      expect(scheduleRequests(page), label).toEqual([]);
      expect(page.$("#schedule-host").children, label).toHaveLength(0);
      expect(publishRequests(page), label).toEqual([]);
      page.close();
    }
  });
});

// ---------------------------------------------------------------------------------------------------------------------------------------------
describe("failed, timed-out and malformed schedule reads close the surface and say so in one bounded sentence", () => {
  const closedAfter = async (scenario: ScheduleScenario) => {
    const page = await openScheduleAdmin(scenario);
    await loadCompetition(page);
    await page.settle(() => scheduleRequests(page).length >= 1, "the schedule read");
    return page;
  };

  it("6a. a refusal, a failure and a dropped connection: the surface stays closed, the old form does not return, and the note is the page's own sentence (never the server's)", async () => {
    const control = await sectionWith(seeded());
    expect(section(control)).not.toBeNull();
    control.close();
    const reads: Array<[string, () => ScheduleReply | Promise<ScheduleReply>]> = [
      ["401", () => ({ status: 401, json: { error: "RAW SERVER WORDS" } })],
      ["403", () => ({ status: 403, json: { error: "RAW SERVER WORDS" } })],
      ["404", () => ({ status: 404, json: { error: "RAW SERVER WORDS" } })],
      ["500", () => ({ status: 500, json: { error: "RAW SERVER WORDS" } })],
      ["503", () => ({ status: 503, json: { error: "RAW SERVER WORDS" } })],
      ["a 200 with no body", () => ({ status: 200 })],
      ["a rejected request", () => Promise.reject(new Error("RAW SERVER WORDS"))],
      // a status that is not 200 is not a read, however much its body looks like one
      ["a 403 that carries a complete, valid schedule", () => ({ status: 403, json: readWire() })],
      ["a 404 that carries a complete, valid schedule", () => ({ status: 404, json: readWire() })],
      ["a 500 that carries a complete, valid schedule", () => ({ status: 500, json: readWire() })],
      ["a 201 that carries a complete, valid schedule", () => ({ status: 201, json: readWire() })],
      ["a 206 that carries a complete, valid schedule", () => ({ status: 206, json: readWire() })],
    ];
    for (const [label, read] of reads) {
      const page = await closedAfter({ schedule: read });
      await page.settle(() => page.visible(page.$("#schedule-read-note")), `${label}: the note`);
      expect(section(page), label).toBeNull();
      expect(page.controls(), label).toEqual(BASE_READY);
      expect(visibleText(page, "#schedule-read-note"), label).toMatch(/schedule could not be loaded/i);
      expect(page.text(), label).not.toContain("RAW SERVER WORDS");
      expect(visibleText(page, "#schedule-read-note").length, label).toBeLessThan(220);
      page.close();
    }
  });

  it("6b. a read that never answers is a FAILED read: after the timeout nothing is open, the request was aborted, and a late answer changes nothing", async () => {
    const late = defer<ScheduleReply>();
    const server = seeded();
    const page = await closedAfter({ schedule: () => late.promise, timeoutMs: 40 });
    expect(section(page)).toBeNull();
    await page.settle(() => page.visible(page.$("#schedule-read-note")), "the note");
    const [request] = scheduleRequests(page);
    expect(request.hasSignal).toBe(true);
    expect(request.aborted()).toBe(true);
    late.resolve({ status: 200, json: server.read() });
    await tick(page, 80);
    expect(section(page), "an answer after the timeout is ignored").toBeNull();
    expect(page.controls()).toEqual(BASE_READY);
    page.close();
  });

  const good = () => clone(readWire({ proposal: chain(3)[2], history: historyOf(chain(3)) }));
  type Mutate = (body: any) => unknown;
  const MALFORMED: Array<[string, Mutate]> = [
    ["null", () => null],
    ["an array", () => []],
    ["a string", () => "schedule"],
    ["an empty object", () => ({})],
    ["no context key", (b) => { delete b.context; return b; }],
    ["no proposal key", (b) => { delete b.proposal; return b; }],
    ["no history key", (b) => { delete b.history; return b; }],
    ["a history that is not a list", (b) => ({ ...b, history: "none" })],
    ["a context with no pitches", (b) => { delete b.context.pitches; return b; }],
    ["a pitch whose id is not an id", (b) => { b.context.pitches[0].planningPitchId = "pitch-a"; return b; }],
    ["two pitches with the same id", (b) => { b.context.pitches[1].planningPitchId = b.context.pitches[0].planningPitchId; return b; }],
    ["a pitch with no label", (b) => { b.context.pitches[0].label = ""; return b; }],
    ["a usable flag that is text", (b) => { b.context.pitches[0].usable = "yes"; return b; }],
    ["a date that is not a calendar day", (b) => { b.context.dates[0].date = "2026-13-45"; return b; }],
    ["two entries for one date", (b) => { b.context.dates[1].date = b.context.dates[0].date; return b; }],
    ["a window that ends before it starts", (b) => { b.context.dates[0].windows[0] = { start: "13:00", end: "09:00" }; return b; }],
    ["a time that is not a time", (b) => { b.context.dates[0].windows[0].start = "9am"; return b; }],
    ["a match that reserves no time", (b) => { b.context.timing.occupancyMinutes = 0; return b; }],
    ["a venue that can host no match", (b) => { b.context.simultaneousMatchCapacity = 0; return b; }],
    ["a status the page does not know", (b) => { b.proposal.status = "APPROVED"; b.history[0].status = "APPROVED"; return b; }],
    ["two placements", (b) => { b.proposal.placements.pop(); return b; }],
    ["four placements", (b) => { b.proposal.placements.push(clone(b.proposal.placements[0])); return b; }],
    ["placements out of role order", (b) => { b.proposal.placements.reverse(); return b; }],
    ["a placement with no start", (b) => { delete b.proposal.placements[0].startUtc; return b; }],
    ["a start that is not an instant", (b) => { b.proposal.placements[1].startUtc = "tomorrow"; return b; }],
    ["a placement with no pitch label", (b) => { b.proposal.placements[0].pitchLabel = ""; return b; }],
    ["a semifinal with no teams", (b) => { b.proposal.placements[0].teamA = null; return b; }],
    ["a semifinal team with no name", (b) => { b.proposal.placements[1].teamB.teamName = ""; return b; }],
    ["a final that already names a team", (b) => { b.proposal.placements[2].teamA = clone(b.proposal.placements[0].teamA); return b; }],
    ["a digest in capitals", (b) => { b.proposal.proposalDigest = b.proposal.proposalDigest.toUpperCase().replace(/[0-9]/g, "A"); b.history[0].proposalDigest = b.proposal.proposalDigest; return b; }],
    ["a digest of 63 digits", (b) => { b.proposal.proposalDigest = b.proposal.proposalDigest.slice(0, 63); b.history[0].proposalDigest = b.proposal.proposalDigest; return b; }],
    ["a digest with a character that is not hexadecimal", (b) => { b.proposal.proposalDigest = "g" + b.proposal.proposalDigest.slice(1); b.history[0].proposalDigest = b.proposal.proposalDigest; return b; }],
    ["no digest", (b) => { delete b.proposal.proposalDigest; return b; }],
    ["a planning flag that is text", (b) => { b.proposal.planningRevisionCurrent = "true"; return b; }],
    ["no draw flag", (b) => { delete b.proposal.drawDigestMatches; return b; }],
    ["a history that does not begin with the proposal", (b) => { b.history[0].sequenceNumber = 2; return b; }],
    ["a history whose first digest is not the proposal's", (b) => { b.history[0].proposalDigest = "e".repeat(64); return b; }],
    ["a history whose first status is not the proposal's", (b) => { b.history[0].status = "STALE"; return b; }],
    ["a history that repeats a sequence number", (b) => { b.history[2].sequenceNumber = 2; return b; }],
    ["a history that is not newest first", (b) => { b.history.reverse(); return b; }],
    ["a proposal with no history at all", (b) => { b.history = []; return b; }],
    ["more history than the server ever sends", (b) => { for (let i = 0; i < 49; i++) b.history.push({ ...clone(b.history[2]), sequenceNumber: 0 - i }); return b; }],
    ["a proposal beside a missing plan", (b) => { b.context = null; return b; }],
    ["a history with no proposal", (b) => { b.proposal = null; return b; }],
  ];
  it.each(MALFORMED)("6c. a malformed answer — %s — leaves the surface closed, with no control and no manual form", async (label, mutate) => {
    const control = await sectionWith(seeded());
    expect(section(control)).not.toBeNull();
    control.close();
    const page = await closedAfter({ schedule: () => ({ status: 200, json: mutate(good()) }) });
    await page.settle(() => page.visible(page.$("#schedule-read-note")), `${label}: the note`);
    expect(section(page)).toBeNull();
    expect(page.$("#schedule-host").children).toHaveLength(0);
    expect(page.controls()).toEqual(BASE_READY);
    expect(visibleText(page, "#schedule-read-note")).toMatch(/schedule could not be loaded/i);
    page.close();
  });

  it("6d. a good read AFTER a failed one opens the surface and clears the note; a bad read AFTER a good one closes it again", async () => {
    const server = seeded();
    let mode: "bad" | "good" = "bad";
    const page = await openScheduleAdmin(withServer(server, { schedule: () => (mode === "bad" ? { status: 500, json: { error: "x" } } : { status: 200, json: server.read() }) }));
    await loadCompetition(page);
    await page.settle(() => page.visible(page.$("#schedule-read-note")), "the note");
    mode = "good";
    page.click(page.$("#btn-load-competition"));
    await page.settle(() => !!section(page), "the surface");
    expect(page.visible(page.$("#schedule-read-note"))).toBe(false);
    mode = "bad";
    page.click(page.$("#btn-load-competition"));
    await page.settle(() => section(page) === null && page.visible(page.$("#schedule-read-note")), "closed again");
    expect(page.controls()).toEqual(BASE_READY);
    page.close();
  });
});

// ---------------------------------------------------------------------------------------------------------------------------------------------
describe("the context: truthful, read-only, and nothing the server did not say", () => {
  it("7. after an exact successful read the section shows the format, the zone, the dates and windows, the pitches and the timing — as text, with no control", async () => {
    const page = await sectionWith(seeded());
    expect(text(page.$("#schedule-heading"))).toBe("Schedule and publish");
    const f = contextFacts(page);
    expect(f["Format"]).toEqual(["Soccer 5v5"]);
    expect(f["Venue time zone"][0]).toContain("America/Costa_Rica");
    expect(f["Tournament date"]).toEqual(["2026-11-14: 09:00–13:00, 15:00–19:00", "2026-11-15: 10:00–14:00"]);
    expect(f["Usable pitches"]).toEqual(["Pitch A, Pitch B"]);
    expect(f["Pitches not offered"][0]).toContain("Pitch C (under repair)");
    expect(f["Pitches not offered"][0]).toContain("Pitch D (training)");
    expect(f["Matches at the same time"]).toEqual(["2"]);
    expect(f["Each match reserves"][0]).toContain("38 minutes");
    expect(f["Between matches on a pitch"][0]).toContain("10 minutes");
    expect(f["Rest for a finalist"][0]).toContain("30 minutes");
    expect(page.$$("#schedule-context button, #schedule-context input, #schedule-context select, #schedule-context textarea, #schedule-context a")).toHaveLength(0);
    // the checks the page makes are described as a convenience, never as authority
    expect(text(page.$("#schedule-intro"))).toMatch(/convenience/i);
    expect(text(page.$("#schedule-intro"))).toMatch(/server checks every rule again/i);
    expect(text(page.$("#schedule-intro"))).not.toMatch(/validated|authorized|approved by this page/i);
    page.close();
  });

  it("7b. no hidden identifier is shown as copy: no id, digest or internal word appears in what a reader sees, and a digest appears nowhere in the page", async () => {
    const records = chain(3);
    const page = await sectionWith(new MiniScheduleServer({ records }));
    const visible = text(section(page));
    expect(visible).not.toMatch(UUID_ANY);
    expect(visible).not.toMatch(HEX64);
    expect(visible).not.toMatch(/planningPitchId|teamId|drawDigest|proposalDigest|planning_revision|gamingMemberId|competitionId|intent/i);
    const html = (section(page) as Element).outerHTML;
    for (const r of records) expect(html).not.toContain(r.proposalDigest);
    expect(html).not.toMatch(HEX64);
    // the only identifiers in attributes are the pitch ids that are the VALUES of the pitch choices — never labels, titles or data attributes
    const attrs = [...(section(page) as Element).querySelectorAll("*")].flatMap((el) => Array.from(el.attributes).map((a) => ({ tag: el.tagName, name: a.name, value: a.value })));
    for (const a of attrs.filter((x) => UUID_ANY.test(x.value))) expect([a.tag, a.name]).toEqual(["OPTION", "value"]);
    page.close();
  });

  it("8. hostile text from the server is rendered literally — pitch labels and team names, in the context, the choices and the proposal — and nothing executes", async () => {
    for (const hostile of [HOSTILE, HOSTILE_BREAKOUT, "<b>bold</b>"]) {
      const facts = makeFacts();
      facts.pitches = [{ ...facts.pitches[0], label: hostile }, ...facts.pitches.slice(1)];
      const teamNames = [hostile, `${hostile} B`, "Charlie Town", HOSTILE_BREAKOUT];
      const record = makeRecord({ facts, teamNames });
      const server = new MiniScheduleServer({ facts, records: [record] });
      const page = await sectionWith(server);
      const root = section(page) as Element;
      expect(root.querySelector("img, script, svg, b"), hostile).toBeNull();
      for (const el of [root, ...Array.from(root.querySelectorAll("*"))]) for (const attr of Array.from(el.attributes)) expect(attr.name.startsWith("on"), `${hostile}: ${attr.name}`).toBe(false);
      expect(text(page.$("#schedule-context"))).toContain(hostile);
      expect(text(page.$("#schedule-table"))).toContain(hostile);
      expect(optionTexts(page, "#schedule-sf1-pitch")).toContain(hostile);
      expect(text(page.$("#schedule-table"))).toContain(`${hostile} vs ${hostile} B`);
      expect((page.win as any).__xss).toBeUndefined();
      page.close();
    }
  });
});

// ---------------------------------------------------------------------------------------------------------------------------------------------
describe("the proposal form: three rows, and only the choices the server's plan offers", () => {
  it("9. there are exactly three placement rows — Semifinal 1, Semifinal 2, Final — each a pitch, a date and a start time, and no team, pairing or free time anywhere", async () => {
    const page = await sectionWith(new MiniScheduleServer());
    const rows = page.$$("#schedule-form fieldset") as Element[];
    expect(rows.map((r) => r.getAttribute("data-role"))).toEqual(["SEMIFINAL_1", "SEMIFINAL_2", "FINAL"]);
    expect(rows.map((r) => text(r.querySelector("legend")))).toEqual(["Semifinal 1", "Semifinal 2", "Final"]);
    for (const row of rows) {
      expect([...row.querySelectorAll("select")].map((s) => s.id.split("-").pop())).toEqual(["pitch", "date", "time"]);
      expect(row.querySelectorAll("input, textarea, button, a")).toHaveLength(0);
    }
    expect(page.$$("#schedule-form select")).toHaveLength(9);
    expect(page.$$("#schedule-form input, #schedule-form textarea")).toHaveLength(0);
    expect(page.$$("#schedule-form button").map((b: Element) => b.id)).toEqual(["schedule-propose"]);
    expect(page.controls()).toEqual([...BASE_READY, ...SCHEDULE_FORM_CONTROLS]);
    expect(page.$("#schedule-final-pitch")).not.toBeNull();
    // every choice has a visible label, and the rows are announced by their legends
    for (const select of page.$$("#schedule-form select") as HTMLSelectElement[]) {
      const label = page.$(`label[for="${select.id}"]`);
      expect(label, select.id).not.toBeNull();
      expect(text(label)).toMatch(/^(Pitch|Date|Start time)/);
    }
    // nothing about teams or pairing can be chosen
    expect(text(page.$("#schedule-form"))).not.toMatch(/\bvs\b|team a|team b|pairing/i);
    expect(page.$$("#schedule-form [id*='team'], #schedule-form [name*='team']")).toHaveLength(0);
    page.close();
  });

  it("10. the choices are only what the server's plan offers: its usable pitches for this format, its dates, and start times inside one of its windows", async () => {
    const page = await sectionWith(new MiniScheduleServer());
    for (const role of ["sf1", "sf2", "final"]) {
      expect(optionValues(page, `#schedule-${role}-pitch`)).toEqual(["", PITCH_A, PITCH_B]);
      expect(optionTexts(page, `#schedule-${role}-pitch`)).toEqual(["Choose a pitch", "Pitch A", "Pitch B"]);
      expect(optionValues(page, `#schedule-${role}-pitch`)).not.toContain(PITCH_C);
      expect(optionValues(page, `#schedule-${role}-pitch`)).not.toContain(PITCH_D);
      expect(optionValues(page, `#schedule-${role}-date`)).toEqual(["", "2026-11-14", "2026-11-15"]);
      expect(optionValues(page, `#schedule-${role}-time`)).toEqual([""]);                       // nothing until a date is chosen
    }
    page.setValue(page.$("#schedule-sf1-date"), "2026-11-14");
    const times = optionValues(page, "#schedule-sf1-time").filter(Boolean);
    expect(times[0]).toBe("09:00");
    expect(times).toContain("12:20");                                                            // 12:20 + 38 minutes = 12:58: fits the 09:00–13:00 window
    expect(times).not.toContain("12:25");                                                        // 12:25 + 38 minutes = 13:03: does not
    expect(times).not.toContain("13:00");
    expect(times).not.toContain("14:00");                                                        // between the windows
    expect(times).toContain("15:00");
    expect(times[times.length - 1]).toBe("18:20");                                               // 18:20 + 38 minutes = 18:58: fits the 15:00–19:00 window
    expect(times).not.toContain("08:55");
    expect(times).not.toContain("19:00");
    for (const t of times) expect(t).toMatch(/^([01]\d|2[0-3]):[0-5][05]$/);
    page.setValue(page.$("#schedule-sf1-date"), "2026-11-15");
    const other = optionValues(page, "#schedule-sf1-time").filter(Boolean);
    expect(other[0]).toBe("10:00");
    expect(other[other.length - 1]).toBe("13:20");
    expect(other).not.toContain("09:00");
    expect(other).not.toContain("15:00");
    // a value the server never offered cannot be selected, and a form that is not complete sends nothing
    page.setValue(page.$("#schedule-sf1-pitch"), PITCH_C);
    expect(page.$("#schedule-sf1-pitch").value).toBe("");
    page.setValue(page.$("#schedule-sf1-time"), "23:59");
    expect(page.$("#schedule-sf1-time").value).toBe("");
    page.click(page.$("#schedule-propose"));
    await tick(page);
    expect(writes(page)).toEqual([]);
    page.close();
  });

  it("10b. changing a date offers that date's times and drops a time that no longer fits; a plan without a usable pitch or a long-enough window offers no form, and says why", async () => {
    const page = await sectionWith(new MiniScheduleServer());
    page.setValue(page.$("#schedule-sf1-date"), "2026-11-14");
    page.setValue(page.$("#schedule-sf1-time"), "15:00");
    expect(page.$("#schedule-sf1-time").value).toBe("15:00");
    page.setValue(page.$("#schedule-sf1-date"), "2026-11-15");
    expect(page.$("#schedule-sf1-time").value, "15:00 is outside the 10:00–14:00 window of the other date").toBe("");
    page.close();

    const noPitch = makeFacts();
    noPitch.pitches = noPitch.pitches.map((p) => ({ ...p, usable: false }));
    const a = await sectionWith(new MiniScheduleServer({ facts: noPitch }));
    expect(a.$("#schedule-form")).toBeNull();
    expect(text(section(a))).toMatch(/no usable pitch/i);
    expect(a.controls()).toEqual(BASE_READY);
    a.close();

    const shortWindows = makeFacts();
    shortWindows.dates = [{ date: "2026-11-14", windows: [{ start: "09:00", end: "09:30" }] }];
    const b = await sectionWith(new MiniScheduleServer({ facts: shortWindows }));
    expect(b.$("#schedule-form")).toBeNull();
    expect(text(section(b))).toMatch(/long enough/i);
    expect(b.controls()).toEqual(BASE_READY);
    b.close();
  });

  it("10c. a first proposal starts empty; a replacement starts from the latest proposal's choices where the plan still offers them", async () => {
    const empty = await sectionWith(new MiniScheduleServer());
    for (const id of ["sf1", "sf2", "final"]) for (const part of ["pitch", "date", "time"]) expect(empty.$(`#schedule-${id}-${part}`).value, `${id} ${part}`).toBe("");
    empty.close();

    const page = await sectionWith(seeded());
    expect(["sf1", "sf2", "final"].map((id) => [page.$(`#schedule-${id}-pitch`).value, page.$(`#schedule-${id}-date`).value, page.$(`#schedule-${id}-time`).value])).toEqual(
      GOOD_PLACEMENTS.map((p) => [p.planningPitchId, p.planDate, p.startTime]));
    page.close();

    // after the plan lost a date, the choices the plan no longer offers are left empty rather than carried over
    const server = seeded();
    server.facts.dates = [{ date: "2026-11-15", windows: [{ start: "10:00", end: "14:00" }] }];
    const changed = await sectionWith(server);
    expect(changed.$("#schedule-sf1-date").value).toBe("");
    expect(changed.$("#schedule-sf1-pitch").value).toBe(PITCH_A);
    changed.close();
  });
});

// ---------------------------------------------------------------------------------------------------------------------------------------------
describe("proposing: the exact request, and one intent per attempt — kept when the outcome is unknown, replaced when it is known", () => {
  it("11. proposing posts exactly { intentId, placements } — three placements of exactly { fixtureRole, planningPitchId, planDate, startTime } — which the real parser accepts", async () => {
    const server = new MiniScheduleServer();
    const page = await sectionWith(server);
    chooseAll(page);
    page.click(page.$("#schedule-propose"));
    await page.settle(() => writes(page).length === 1, "the proposal request");
    const [request] = writes(page);
    expect(request.method).toBe("POST");
    expect(request.url).toBe(SCHEDULE_URL);
    expect(request.cache).toBe("no-store");
    expect(request.hasSignal).toBe(true);
    const body = request.json();
    expect(Object.keys(body)).toEqual(["intentId", "placements"]);
    expect(body.intentId).toMatch(UUID_V4);
    expect(body.placements).toHaveLength(3);
    expect(body.placements.map((p: any) => Object.keys(p))).toEqual(Array(3).fill(["fixtureRole", "planningPitchId", "planDate", "startTime"]));
    expect(body.placements).toEqual(GOOD_PLACEMENTS);
    expect(() => parseScheduleProposalRequest(body), "the real request parser accepts exactly this body").not.toThrow();
    expect(parseScheduleProposalRequest(body).placements).toEqual(GOOD_PLACEMENTS);
    expect(JSON.stringify(body)).not.toMatch(/team|pairing|timeZone|utc|duration|capacity|venue|format|fixtureId|competitionId|planningRevision|draw|digest|actor|organizer/i);
    await page.settle(() => page.visible(page.$("#schedule-latest")) && text(page.$("#schedule-latest")).includes("Proposal 1"), "the new proposal");
    expect(text(page.$("#schedule-status"))).toMatch(/proposed as proposal 1/i);
    expect(page.$("#schedule-status").className).toContain("success");
    expect(page.requests.filter((r) => r.method === "GET" && r.url === SCHEDULE_URL).length, "the new state is read again, not assumed").toBe(2);
    expect(page.$("#schedule-publish"), "the new CURRENT proposal can now be published").not.toBeNull();
    expect(document_activeId(page)).toBe("schedule-heading");
    page.close();
  });

  it("11b. an incomplete form sends nothing, marks what is missing and says so; the server is never asked to guess", async () => {
    const page = await sectionWith(new MiniScheduleServer());
    choose(page, "sf1", { pitch: PITCH_A, date: "2026-11-14", time: "10:00" });
    page.click(page.$("#schedule-propose"));
    await tick(page);
    expect(writes(page)).toEqual([]);
    expect(text(page.$("#schedule-status"))).toMatch(/pitch, a date and a start time for every match/i);
    const invalid = (page.$$('#schedule-form [aria-invalid="true"]') as Element[]).map((e) => e.id);
    expect(invalid).toEqual(["schedule-sf2-pitch", "schedule-sf2-date", "schedule-sf2-time", "schedule-final-pitch", "schedule-final-date", "schedule-final-time"]);
    page.close();
  });

  it("11c. a replacement posts the same exact body; the old proposal becomes history, the new one is current, and the digest the page holds is the new one", async () => {
    // (proposal 2 holds the "other" placements; proposing the first set again is a real change, and it supersedes proposal 2)
    const server = seeded(2);
    const page = await sectionWith(server);
    chooseAll(page, GOOD_PLACEMENTS);
    page.click(page.$("#schedule-propose"));
    await page.settle(() => text(page.$("#schedule-latest")).includes("Proposal 3"), "proposal 3");
    expect(writes(page)).toHaveLength(1);
    expect(parseScheduleProposalRequest(writes(page)[0].json()).placements).toEqual(GOOD_PLACEMENTS);
    expect(page.$("#schedule-latest").getAttribute("data-status")).toBe("CURRENT");
    expect((page.$$("#schedule-history li") as Element[]).map(text)).toEqual([expect.stringContaining("Proposal 2"), expect.stringContaining("Proposal 1")]);
    expect(page.run("scheduleState.proposal.proposalDigest")).toBe(server.latest()!.proposalDigest);
    page.close();
  });

  it("11d. while a proposal is pending nothing can be sent again: not by the button, not by a raw click, not by the form itself being submitted; and every control is disabled", async () => {
    const answer = defer<ScheduleReply>();
    const server = new MiniScheduleServer();
    const page = await sectionWith(server, { propose: (r) => { const out = server.propose(r.json()); return answer.promise.then(() => out); } });
    chooseAll(page);
    const button = page.$("#schedule-propose");
    button.click();
    button.click();
    button.dispatchEvent(new page.win.MouseEvent("click", { bubbles: true }));
    page.$("#schedule-form").dispatchEvent(new page.win.Event("submit", { bubbles: true, cancelable: true }));
    await tick(page);
    expect(writes(page)).toHaveLength(1);
    expect(button.disabled).toBe(true);
    expect((page.$$("#schedule-form select") as HTMLSelectElement[]).every((s) => s.disabled)).toBe(true);
    expect(text(page.$("#schedule-status"))).toMatch(/sending/i);
    answer.resolve({ status: 200 });
    await page.settle(() => text(page.$("#schedule-latest")).includes("Proposal 1"), "the proposal");
    expect(writes(page)).toHaveLength(1);
    page.close();
  });

  // Each of these leaves the page not knowing whether the server recorded the schedule.
  const UNCERTAIN: Array<[string, (server: MiniScheduleServer) => ScheduleScenario]> = [
    ["a silent server (timeout)", (server) => ({ timeoutMs: 40, propose: () => never(), schedule: () => ({ status: 200, json: server.read() }) })],
    ["a lost connection", (server) => ({ propose: () => Promise.reject(new Error("offline")), schedule: () => ({ status: 200, json: server.read() }) })],
    ["a 201 the page cannot read", (server) => ({ propose: () => ({ status: 201, json: { proposal: "x" } }), schedule: () => ({ status: 200, json: server.read() }) })],
    ["a 200 with no body", (server) => ({ propose: () => ({ status: 200 }), schedule: () => ({ status: 200, json: server.read() }) })],
    ["a 500", (server) => ({ propose: () => ({ status: 500, json: { error: "RAW SERVER WORDS" } }), schedule: () => ({ status: 200, json: server.read() }) })],
    ["a 502", (server) => ({ propose: () => ({ status: 502 }), schedule: () => ({ status: 200, json: server.read() }) })],
    ["a 201 that is not for the schedule that was sent", (server) => ({ propose: () => ({ status: 201, json: { proposal: readWire({ proposal: makeRecord({ sequenceNumber: 1, placements: OTHER_PLACEMENTS }) }).proposal, alreadyProposed: false } }), schedule: () => ({ status: 200, json: server.read() }) })],
    ["a 201 that says it was a replay", (server) => ({ propose: () => ({ status: 201, json: { proposal: readWire({ proposal: makeRecord({ sequenceNumber: 1, placements: GOOD_PLACEMENTS }) }).proposal, alreadyProposed: true } }), schedule: () => ({ status: 200, json: server.read() }) })],
  ];
  it.each(UNCERTAIN)("12. after %s the intent is kept: the same choices go out again with the same intent, and the page said it did not know", async (_label, build) => {
    const server = new MiniScheduleServer();
    const page = await sectionWith(server, build(server));
    chooseAll(page);
    page.click(page.$("#schedule-propose"));
    await page.settle(() => writes(page).length === 1 && !page.$("#schedule-propose").disabled, "the first attempt to end");
    expect(text(page.$("#schedule-status"))).toMatch(/not known whether the schedule was recorded/i);
    expect(text(page.$("#schedule-status"))).not.toContain("RAW SERVER WORDS");
    expect(page.$("#schedule-status").className).toContain("error");
    await page.settle(() => page.requests.filter((r) => r.method === "GET" && r.url === SCHEDULE_URL).length >= 2, "the reconciling read");
    // the choices are still on the screen, ready to be sent again
    expect(["sf1", "sf2", "final"].map((id) => page.$(`#schedule-${id}-time`).value)).toEqual(["10:00", "10:00", "15:00"]);
    page.click(page.$("#schedule-propose"));
    await page.settle(() => writes(page).length === 2, "the retry");
    const [first, second] = writes(page);
    expect(second.json().intentId).toBe(first.json().intentId);
    expect(second.json().placements).toEqual(first.json().placements);
    page.close();
  });

  it("12b. the intent survives a rebuild of the surface: when the reconciling read shows a different server state, the same choices still go out with the same intent", async () => {
    const server = new MiniScheduleServer();
    // someone else's proposal lands while this attempt's answer is lost
    const other = makeRecord({ sequenceNumber: 1, placements: OTHER_PLACEMENTS });
    let lost = true;
    const page = await sectionWith(server, {
      propose: () => { if (lost) { server.records.push(other); lost = false; return never(); } return server.propose(writes(page).slice(-1)[0].json()); },
      timeoutMs: 40,
    });
    chooseAll(page);
    page.click(page.$("#schedule-propose"));
    await page.settle(() => text(page.$("#schedule-latest")).includes("Proposal 1"), "the surface rebuilt around the other proposal");
    expect(["sf1", "sf2", "final"].map((id) => page.$(`#schedule-${id}-time`).value), "the organizer's own choices are kept, not replaced").toEqual(["10:00", "10:00", "15:00"]);
    page.click(page.$("#schedule-propose"));
    await page.settle(() => writes(page).length === 2, "the retry");
    expect(writes(page)[1].json().intentId).toBe(writes(page)[0].json().intentId);
    page.close();
  });

  it("12c. when the lost answer was in fact a success, the reconciling read shows it and the same choices are not sent again", async () => {
    const server = new MiniScheduleServer();
    let first = true;
    const page = await sectionWith(server, {
      propose: (r) => { const out = server.propose(r.json()); if (first) { first = false; return never(); } return out; },
      timeoutMs: 40,
    });
    chooseAll(page);
    page.click(page.$("#schedule-propose"));
    await page.settle(() => text(page.$("#schedule-latest")).includes("Proposal 1"), "the proposal the lost answer had created");
    page.click(page.$("#schedule-propose"));
    await tick(page);
    expect(writes(page), "nothing is sent again for a schedule that is already the current proposal").toHaveLength(1);
    expect(text(page.$("#schedule-status"))).toMatch(/already the current proposal/i);
    page.close();
  });

  it("13. a new intent follows a deliberate edit and every conclusive answer: a rejection, a refusal, a success", async () => {
    // a deliberate edit after an uncertain outcome
    const a = await sectionWith(new MiniScheduleServer(), { propose: () => Promise.reject(new Error("offline")) });
    chooseAll(a);
    a.click(a.$("#schedule-propose"));
    await a.settle(() => writes(a).length === 1 && !a.$("#schedule-propose").disabled, "the first attempt");
    await a.settle(() => a.requests.filter((r) => r.url === SCHEDULE_URL && r.method === "GET").length >= 2, "reconciled");
    choose(a, "final", { pitch: PITCH_B, date: "2026-11-14", time: "16:00" });
    a.click(a.$("#schedule-propose"));
    await a.settle(() => writes(a).length === 2, "the edited attempt");
    expect(writes(a)[1].json().intentId).not.toBe(writes(a)[0].json().intentId);
    a.close();

    // a conclusive rejection (400) and a conclusive refusal (409)
    for (const [status, body] of [[400, { error: "The schedule proposal is not valid.", problems: [{ field: "placements[0].startTime", code: "OUTSIDE_WINDOW", message: "The match does not fit." }] }], [409, { error: "x", code: "DRAW_REQUIRED" }]] as const) {
      const page = await sectionWith(new MiniScheduleServer(), { propose: () => ({ status, json: body }) });
      chooseAll(page);
      page.click(page.$("#schedule-propose"));
      await page.settle(() => writes(page).length === 1 && !page.$("#schedule-propose").disabled, `${status}: the first attempt`);
      await page.settle(() => !page.$("#schedule-propose").disabled, "idle");
      page.click(page.$("#schedule-propose"));
      await page.settle(() => writes(page).length === 2, `${status}: the second attempt`);
      expect(writes(page)[1].json().intentId, `a new intent after a ${status}`).not.toBe(writes(page)[0].json().intentId);
      expect(writes(page)[1].json().placements).toEqual(writes(page)[0].json().placements);
      page.close();
    }

    // after a success, the next proposal is a new one
    const server = new MiniScheduleServer();
    const c = await sectionWith(server);
    chooseAll(c);
    c.click(c.$("#schedule-propose"));
    await c.settle(() => text(c.$("#schedule-latest")).includes("Proposal 1"), "the first proposal");
    choose(c, "final", { pitch: PITCH_B, date: "2026-11-14", time: "16:00" });
    c.click(c.$("#schedule-propose"));
    await c.settle(() => text(c.$("#schedule-latest")).includes("Proposal 2"), "the second proposal");
    expect(writes(c)[1].json().intentId).not.toBe(writes(c)[0].json().intentId);
    c.close();
  });

  it("13d. after a success the intent is forgotten: the same choices proposed again later (after someone else's proposal replaced them) are a NEW request and create a new proposal", async () => {
    const server = new MiniScheduleServer();
    const page = await sectionWith(server);
    chooseAll(page, GOOD_PLACEMENTS);
    page.click(page.$("#schedule-propose"));
    await page.settle(() => text(page.$("#schedule-latest")).includes("Proposal 1"), "proposal 1");
    server.propose({ intentId: "99999999-9999-4999-8999-999999999999", placements: OTHER_PLACEMENTS });          // someone else proposes meanwhile
    page.click(page.$("#btn-load-competition"));
    await page.settle(() => !!section(page) && text(page.$("#schedule-latest")).includes("Proposal 2"), "proposal 2 on screen");
    chooseAll(page, GOOD_PLACEMENTS);
    page.click(page.$("#schedule-propose"));
    await page.settle(() => text(page.$("#schedule-latest")).includes("Proposal 3"), "proposal 3");
    expect(writes(page)).toHaveLength(2);
    expect(writes(page)[1].json().intentId, "a replayed intent would only have returned the old proposal").not.toBe(writes(page)[0].json().intentId);
    page.close();
  });

  it("13b. a rejection shows the server's reasons as plain text, marks the fields, and never shows success", async () => {
    const problems = [
      { field: "placements[0].startTime", code: "OUTSIDE_WINDOW", message: `The match does not fit inside one operating window. ${HOSTILE}` },
      { field: "schedule", code: "PITCH_TRANSITION", message: "The same pitch needs 10 minutes after a match before the next one." },
    ];
    const page = await sectionWith(new MiniScheduleServer(), { propose: () => ({ status: 400, json: { error: "RAW SERVER WORDS", problems } }) });
    chooseAll(page);
    page.click(page.$("#schedule-propose"));
    await page.settle(() => page.$$("#schedule-problems li").length === 2, "the reasons");
    expect(text(page.$("#schedule-problems"))).toContain("The match does not fit inside one operating window.");
    expect(text(page.$("#schedule-problems"))).toContain(HOSTILE);
    expect(page.$("#schedule-problems img")).toBeNull();
    expect((page.win as any).__xss).toBeUndefined();
    expect(page.$("#schedule-sf1-time").getAttribute("aria-invalid")).toBe("true");
    expect(page.$("#schedule-status").className).toContain("error");
    expect(text(page.$("#schedule-status"))).not.toMatch(/proposed as proposal/i);
    expect(text(page.$("#schedule-status"))).not.toContain("RAW SERVER WORDS");
    expect(page.$("#schedule-publish"), "a rejected proposal never offers publication").toBeNull();
    page.close();
  });

  it("13c. each refusal the server states by code is explained in the page's own bounded words, and the surface is read again", async () => {
    const CODES = ["WRONG_STATE", "FREEZE_REQUIRED", "FREEZE_INCONSISTENT", "DRAW_REQUIRED", "PLAN_REQUIRED", "AMENDMENT_PENDING", "INTENT_MISMATCH", "SOMETHING_NEW"];
    const seen = new Set<string>();
    for (const code of CODES) {
      const page = await sectionWith(new MiniScheduleServer(), { propose: () => ({ status: 409, json: { error: "RAW SERVER WORDS", code } }) });
      chooseAll(page);
      const reads = page.requests.filter((r) => r.url === SCHEDULE_URL && r.method === "GET").length;
      page.click(page.$("#schedule-propose"));
      await page.settle(() => page.requests.filter((r) => r.url === SCHEDULE_URL && r.method === "GET").length > reads && text(page.$("#schedule-status")) !== "", `${code}: the refusal and the fresh read`);
      const said = text(page.$("#schedule-status"));
      expect(said, code).not.toContain("RAW SERVER WORDS");
      expect(said.length, code).toBeLessThan(300);
      expect(said, code).not.toMatch(/proposed as proposal/i);
      seen.add(said);
      // the organizer's choices survive the fresh read, so that they can try again when the obstacle is gone
      expect(page.$("#schedule-sf1-time").value, code).toBe("10:00");
      page.close();
    }
    expect(seen.size, "each code has its own sentence, and an unknown code falls back to one general sentence").toBe(CODES.length);
  });
});

function document_activeId(page: SchedulePage): string { return (page.doc.activeElement as HTMLElement | null)?.id ?? ""; }

// ---------------------------------------------------------------------------------------------------------------------------------------------
describe("the proposal review: what the server derived, shown without decoration and without the digest", () => {
  it("14. a CURRENT proposal: its number, status, time, zone, three derived placements, the teams exactly as returned, the final's pending finalists, and the bounded history", async () => {
    const records = chain(3);
    const page = await sectionWith(new MiniScheduleServer({ records }));
    const latest = page.$("#schedule-latest");
    expect(latest.getAttribute("data-status")).toBe("CURRENT");
    expect(text(page.$("#schedule-latest .schedule-head"))).toContain("Proposal 3");
    expect(text(page.$("#schedule-latest .pill"))).toBe("Current");
    expect(page.$("#schedule-latest .pill").className).toContain("good");
    expect(text(latest)).toContain("2026-11-07 14:13 UTC");
    expect(text(latest)).toContain("America/Costa_Rica");
    const rows = (page.$$("#schedule-table tbody tr") as Element[]).map((r) => [...r.querySelectorAll("td")].map(text));
    expect(rows).toEqual([
      ["Semifinal 1", "Alpha FC vs Bravo United", "Pitch A", "2026-11-14 10:00", "2026-11-14 16:00 UTC"],
      ["Semifinal 2", "Charlie Town vs Delta Rovers", "Pitch B", "2026-11-14 10:00", "2026-11-14 16:00 UTC"],
      ["Final", "Winner of Semifinal 1 vs Winner of Semifinal 2", "Pitch A", "2026-11-14 15:00", "2026-11-14 21:00 UTC"],
    ]);
    expect((page.$$("#schedule-table thead th") as Element[]).map(text)).toEqual(["Match", "Teams", "Pitch", "Starts (venue time)", "Starts (UTC)"]);
    expect((page.$$("#schedule-table tbody td") as Element[]).map((td) => td.getAttribute("data-label"))).toEqual(
      ["Match", "Teams", "Pitch", "Starts (venue time)", "Starts (UTC)", "Match", "Teams", "Pitch", "Starts (venue time)", "Starts (UTC)", "Match", "Teams", "Pitch", "Starts (venue time)", "Starts (UTC)"]);
    // the derived UTC time is clearly labelled as UTC, and the local time as the venue's
    expect(text(page.$("#schedule-latest"))).toMatch(/times are in America\/Costa_Rica/i);
    expect((page.$$("#schedule-history li") as Element[]).map(text)).toEqual([
      "Proposal 2: Superseded (proposed 2026-11-07 14:12 UTC)", "Proposal 1: Superseded (proposed 2026-11-07 14:11 UTC)",
    ]);
    expect(page.$$("#schedule-history li")).toHaveLength(2);
    expect(page.$("#schedule-publish")).not.toBeNull();
    expect(text(page.$("#schedule-publish"))).toBe("Publish Competition Schedule");
    expect(text(page.$("#schedule-form legend"))).toBe("Semifinal 1");
    page.close();
  });

  it("14b. the history is bounded by what the server sends (at most 50 proposals) and the review shows the newest only", async () => {
    const records = chain(50);
    const page = await sectionWith(new MiniScheduleServer({ records }));
    expect(text(page.$("#schedule-latest .schedule-head"))).toContain("Proposal 50");
    expect(page.$$("#schedule-history li")).toHaveLength(49);
    expect(text(page.$("#schedule-history li"))).toContain("Proposal 49");
    page.close();
  });

  it("14c. before any proposal the page says so, offers the form and no publication", async () => {
    const page = await sectionWith(new MiniScheduleServer());
    expect(text(page.$("#schedule-latest"))).toMatch(/no schedule has been proposed yet/i);
    expect(page.$("#schedule-table")).toBeNull();
    expect(page.$("#schedule-publish")).toBeNull();
    expect(page.$$("#schedule-history li")).toHaveLength(0);
    expect(page.controls()).toEqual([...BASE_READY, ...SCHEDULE_FORM_CONTROLS]);
    page.close();
  });

  it("15. a STALE or a SUPERSEDED latest proposal is shown as such, with its reason, and offers no publication — only the form to propose again", async () => {
    const stale = seeded();
    stale.planCurrent = false;
    const a = await sectionWith(stale);
    expect(a.$("#schedule-latest").getAttribute("data-status")).toBe("STALE");
    expect(text(a.$("#schedule-latest .pill"))).toBe("Stale");
    expect(text(a.$("#schedule-latest"))).toMatch(/plan or the draw has changed/i);
    expect(a.$("#schedule-publish")).toBeNull();
    expect(a.controls()).toEqual([...BASE_READY, ...SCHEDULE_FORM_CONTROLS]);
    expect(text(a.$("#schedule-publish-note"))).toMatch(/cannot be published/i);
    a.close();

    const drawChanged = seeded();
    drawChanged.drawMatches = false;
    const b = await sectionWith(drawChanged);
    expect(b.$("#schedule-latest").getAttribute("data-status")).toBe("STALE");
    expect(b.$("#schedule-publish")).toBeNull();
    b.close();

    // a latest proposal that says it was superseded (the server never says this of the latest, but the page must not offer publication if it ever does)
    const body = clone(readWire({ proposal: chain(3)[2], history: historyOf(chain(3)) }));
    body.proposal.status = "SUPERSEDED";
    body.history[0].status = "SUPERSEDED";
    const c = await sectionWith(seeded(), { schedule: () => ({ status: 200, json: body }) });
    expect(c.$("#schedule-latest").getAttribute("data-status")).toBe("SUPERSEDED");
    expect(text(c.$("#schedule-latest .pill"))).toBe("Superseded");
    expect(text(c.$("#schedule-latest"))).toMatch(/later proposal replaced this one/i);
    expect(c.$("#schedule-publish")).toBeNull();
    c.close();
  });
});

describe("what makes publication offerable: every fact exactly true, each one tested alone", () => {
  it("16. a missing or malformed digest offers nothing: the read is refused whole, and the page's own check refuses it alone", async () => {
    const page = await sectionWith(seeded());
    expect(factsWith(page, "{}").digestValid).toBe(true);
    for (const bad of ["", "A".repeat(64), "a".repeat(63), "a".repeat(65), "g".repeat(64), " " + "a".repeat(63), null, 7, undefined]) {
      expect(factsWith(page, proposalPatch(`{ proposalDigest: ${JSON.stringify(bad) ?? "undefined"} }`)).digestValid, String(bad)).toBe(false);
    }
    page.close();
  });

  it("17. a wrong placement count or order offers nothing, in the page's own check", async () => {
    const page = await sectionWith(seeded());
    expect(factsWith(page, "{}").placementsValid).toBe(true);
    expect(factsWith(page, proposalPatch("{ placements: scheduleState.proposal.placements.slice(0, 2) }")).placementsValid).toBe(false);
    expect(factsWith(page, proposalPatch("{ placements: scheduleState.proposal.placements.concat(scheduleState.proposal.placements[0]) }")).placementsValid).toBe(false);
    expect(factsWith(page, proposalPatch("{ placements: scheduleState.proposal.placements.slice().reverse() }")).placementsValid).toBe(false);
    expect(factsWith(page, proposalPatch("{ placements: [null, null, null] }")).placementsValid).toBe(false);
    expect(factsWith(page, proposalPatch("{ placements: 'three' }")).placementsValid).toBe(false);
    page.close();
  });

  it("18. planningRevisionCurrent must be exactly true: a stale plan, and anything that is not the boolean true, offers nothing", async () => {
    const stale = seeded();
    stale.planCurrent = false;
    const a = await sectionWith(stale);
    expect(a.$("#schedule-publish")).toBeNull();
    expect(factsWith(a, "{}").planCurrent).toBe(false);
    a.close();
    const page = await sectionWith(seeded());
    expect(factsWith(page, "{}").planCurrent).toBe(true);
    for (const bad of [false, "true", 1, null, undefined]) {
      expect(factsWith(page, proposalPatch(`{ planningRevisionCurrent: ${JSON.stringify(bad) ?? "undefined"} }`)).planCurrent, String(bad)).toBe(false);
    }
    page.close();
  });

  it("19. drawDigestMatches must be exactly true: a changed draw, and anything that is not the boolean true, offers nothing", async () => {
    const changed = seeded();
    changed.drawMatches = false;
    const a = await sectionWith(changed);
    expect(a.$("#schedule-publish")).toBeNull();
    expect(factsWith(a, "{}").drawMatches).toBe(false);
    a.close();
    const page = await sectionWith(seeded());
    expect(factsWith(page, "{}").drawMatches).toBe(true);
    for (const bad of [false, "true", 1, null, undefined]) {
      expect(factsWith(page, proposalPatch(`{ drawDigestMatches: ${JSON.stringify(bad) ?? "undefined"} }`)).drawMatches, String(bad)).toBe(false);
    }
    page.close();
  });

  it("19b. each of the other facts is judged alone: the status, the competition's state, the organizer view, the read and a request already pending", async () => {
    const page = await sectionWith(seeded());
    const live = JSON.parse(page.run("JSON.stringify(scheduleFacts(scheduleState))") as string);
    expect(live).toEqual({ organizerView: true, readyToPublish: true, readSucceeded: true, hasProposal: true, statusCurrent: true, planCurrent: true, drawMatches: true, digestValid: true, placementsValid: true, idle: true });
    expect(page.run("schedulePublishable(scheduleState)")).toBe(true);
    // only the live section's own state can publish: an identical copy of it is not that section
    expect(page.run("schedulePublishable(Object.assign({}, scheduleState))")).toBe(false);
    expect(factsWith(page, proposalPatch("{ status: 'STALE' }")).statusCurrent).toBe(false);
    expect(factsWith(page, proposalPatch("{ status: 'SUPERSEDED' }")).statusCurrent).toBe(false);
    expect(factsWith(page, proposalPatch("{ status: 'current' }")).statusCurrent).toBe(false);
    expect(factsWith(page, "{ proposal: null }").hasProposal).toBe(false);
    expect(factsWith(page, "{ readOk: false }").readSucceeded).toBe(false);
    expect(factsWith(page, "{ busy: true }").idle).toBe(false);
    expect(factsWith(page, "{ competitionId: 'another' }").organizerView).toBe(false);
    page.run("currentView.competition.state = 'PUBLISHED'");
    expect(JSON.parse(page.run("JSON.stringify(scheduleFacts(scheduleState))") as string).readyToPublish).toBe(false);
    expect(page.run("schedulePublishable(scheduleState)")).toBe(false);
    page.run("currentView.competition.state = 'READY_TO_PUBLISH'");
    page.run("currentAccess = { competitionId: currentAccess.competitionId, access: 'SCOREKEEPER' }");
    expect(JSON.parse(page.run("JSON.stringify(scheduleFacts(scheduleState))") as string).organizerView).toBe(false);
    page.close();
  });
});

// ---------------------------------------------------------------------------------------------------------------------------------------------
describe("publishing: the exact request, one at a time, and an answer is believed only when it is exactly the evidence of this very proposal", () => {
  it("20. publishing posts exactly {\"scheduleProposalDigest\":\"<the digest of the proposal on screen>\"} — nothing else — which the real parser accepts", async () => {
    const server = seeded();
    const page = await sectionWith(server);
    expect(page.$("#schedule-publish")).not.toBeNull();
    const digest = server.latest()!.proposalDigest;
    page.click(page.$("#schedule-publish"));
    await page.settle(() => publishRequests(page).length === 1, "the publication request");
    const [request] = publishRequests(page);
    expect(request.method).toBe("POST");
    expect(request.url).toBe(PUBLISH_URL);
    expect(request.body).toBe(JSON.stringify({ scheduleProposalDigest: digest }));
    expect(request.body).toBe(`{"scheduleProposalDigest":"${digest}"}`);
    expect(Object.keys(request.json())).toEqual(["scheduleProposalDigest"]);
    expect(request.cache).toBe("no-store");
    expect(request.hasSignal).toBe(true);
    expect(parsePublishRequest(request.json())).toEqual({ kind: "SCHEDULE", scheduleProposalDigest: digest });
    expect(writes(page).filter((r) => r.url !== PUBLISH_URL)).toEqual([]);
    page.close();
  });

  it("21. while the publication is pending nothing can be activated again: one request however many times it is activated, and every control is disabled", async () => {
    const answer = defer<ScheduleReply>();
    const server = seeded();
    const page = await sectionWith(server, { publish: () => answer.promise });
    const button = page.$("#schedule-publish");
    button.click();
    button.click();
    button.dispatchEvent(new page.win.MouseEvent("click", { bubbles: true }));
    page.$("#schedule-propose").click();
    await tick(page);
    expect(publishRequests(page)).toHaveLength(1);
    expect(writes(page)).toHaveLength(1);
    expect(button.disabled).toBe(true);
    expect(page.$("#schedule-propose").disabled).toBe(true);
    expect((page.$$("#schedule-form select") as HTMLSelectElement[]).every((s) => s.disabled)).toBe(true);
    expect(section(page)!.getAttribute("aria-busy")).toBe("true");
    expect(text(page.$("#msg-schedule"))).toMatch(/publishing/i);
    answer.resolve(server.publish({ scheduleProposalDigest: server.latest()!.proposalDigest }));
    await page.settle(() => /schedule published/i.test(text(page.$("#msg-schedule"))), "the outcome");
    expect(publishRequests(page)).toHaveLength(1);
    page.close();
  });

  it("22. a 201 with the evidence of this proposal is reported as a success only then, and the competition is reloaded from the server", async () => {
    const server = seeded();
    const page = await sectionWith(server);
    const viewReads = () => page.requests.filter((r) => r.method === "GET" && r.url === `/api/gaming/competitions/${CID}`).length;
    const before = viewReads();
    page.click(page.$("#schedule-publish"));
    await page.settle(() => /schedule published/i.test(text(page.$("#msg-schedule"))), "the success");
    expect(page.$("#msg-schedule").className).toContain("success");
    await page.settle(() => viewReads() > before && section(page) === null, "the reload");
    expect(text(page.$("#comp-state-pill"))).toBe("In progress");
    expect(page.controls().filter((c) => c.includes("schedule")), "no schedule control after publication").toEqual([]);
    expect(page.requests.filter((r) => r.url === SCHEDULE_URL && r.method === "GET")).toHaveLength(1);
    expect(text(page.$("#msg-schedule"))).toMatch(/schedule published/i);
    expect(document_activeId(page)).toBe("msg-schedule");
    page.close();
  });

  it("23. a 200 with the exact evidence of a replay is reported as already published, then the competition is reloaded", async () => {
    const server = seeded();
    const digest = server.latest()!.proposalDigest;
    let published = false;
    const page = await sectionWith(server, {
      publish: () => { published = true; return { status: 200, json: publicationWire({ alreadyPublished: true, scheduleProposalDigest: digest }) }; },
      view: () => ({ status: 200, json: viewBody({ state: published ? "PUBLISHED" : "READY_TO_PUBLISH", signal: ORGANIZER_SIGNAL }) }),
    });
    page.click(page.$("#schedule-publish"));
    await page.settle(() => /already been published/i.test(text(page.$("#msg-schedule"))), "the replay message");
    expect(page.$("#msg-schedule").className).toContain("success");
    await page.settle(() => section(page) === null && text(page.$("#comp-state-pill")) === "In progress", "the reload");
    page.close();
  });

  const WRONG_ANSWERS: Array<[string, number, (digest: string) => unknown]> = [
    ["a 201 that claims to be a replay", 201, (d) => publicationWire({ alreadyPublished: true, scheduleProposalDigest: d })],
    ["a 200 that claims not to be a replay", 200, (d) => publicationWire({ alreadyPublished: false, scheduleProposalDigest: d })],
    ["a 201 for another proposal's digest", 201, () => publicationWire({ alreadyPublished: false, scheduleProposalDigest: "e".repeat(64), proposalSequence: 1 })],
    ["a 201 for another competition", 201, (d) => { const w = publicationWire({ scheduleProposalDigest: d }); w.result.competitionId = CID2; return w; }],
    ["a 201 whose state is not PUBLISHED", 201, (d) => { const w = publicationWire({ scheduleProposalDigest: d }); w.result.state = "READY_TO_PUBLISH"; return w; }],
    ["a 201 with two fixtures", 201, (d) => { const w = publicationWire({ scheduleProposalDigest: d }); w.publication.fixtures.pop(); return w; }],
    ["a 201 with its fixtures out of order", 201, (d) => { const w = publicationWire({ scheduleProposalDigest: d }); w.publication.fixtures.reverse(); return w; }],
    ["a 201 whose fixtures disagree with its result", 201, (d) => { const w = publicationWire({ scheduleProposalDigest: d }); w.result.finalFixtureId = w.result.semifinal1FixtureId; return w; }],
    ["a 201 with a malformed publication digest", 201, (d) => { const w = publicationWire({ scheduleProposalDigest: d }); w.publication.publicationDigest = "nope"; return w; }],
    ["a 201 with no publication", 201, (d) => { const w = publicationWire({ scheduleProposalDigest: d }); delete w.publication; return w; }],
    ["a 201 with no body", 201, () => undefined],
    ["a 200 with text", 200, () => "published"],
    ["a 204", 204, () => undefined],
  ];
  it.each(WRONG_ANSWERS)("23b. %s is never reported as a publication: the page says it does not know, and reloads the competition", async (_label, status, build) => {
    const server = seeded();
    const digest = server.latest()!.proposalDigest;
    const page = await sectionWith(server, { publish: () => ({ status, json: build(digest) }) });
    const reads = page.requests.filter((r) => r.method === "GET" && r.url === `/api/gaming/competitions/${CID}`).length;
    page.click(page.$("#schedule-publish"));
    await page.settle(() => /not known whether the competition was published/i.test(text(page.$("#msg-schedule"))), "the honest message");
    expect(page.$("#msg-schedule").className).toContain("error");
    expect(text(page.$("#msg-schedule"))).not.toMatch(/schedule published|already been published/i);
    await page.settle(() => page.requests.filter((r) => r.method === "GET" && r.url === `/api/gaming/competitions/${CID}`).length > reads, "the reload");
    page.close();
  });

  const REFUSALS: Array<[string, number, unknown]> = [
    ["400", 400, { error: "RAW SERVER WORDS", problems: [{ field: "scheduleProposalDigest", code: "DIGEST_INVALID", message: "RAW PROBLEM" }] }],
    ["401", 401, { error: "RAW SERVER WORDS" }],
    ["403", 403, { error: "RAW SERVER WORDS" }],
    ["404", 404, { error: "RAW SERVER WORDS", code: "PROPOSAL_NOT_FOUND" }],
    ["409 WRONG_STATE", 409, { error: "RAW SERVER WORDS", code: "WRONG_STATE" }],
    ["409 FREEZE_REQUIRED", 409, { error: "RAW SERVER WORDS", code: "FREEZE_REQUIRED" }],
    ["409 FREEZE_INCONSISTENT", 409, { error: "RAW SERVER WORDS", code: "FREEZE_INCONSISTENT" }],
    ["409 DRAW_REQUIRED", 409, { error: "RAW SERVER WORDS", code: "DRAW_REQUIRED" }],
    ["409 PLAN_REQUIRED", 409, { error: "RAW SERVER WORDS", code: "PLAN_REQUIRED" }],
    ["409 AMENDMENT_PENDING", 409, { error: "RAW SERVER WORDS", code: "AMENDMENT_PENDING" }],
    ["409 DRAW_NOT_VERIFIABLE", 409, { error: "RAW SERVER WORDS", code: "DRAW_NOT_VERIFIABLE" }],
    ["409 PROPOSAL_SUPERSEDED", 409, { error: "RAW SERVER WORDS", code: "PROPOSAL_SUPERSEDED" }],
    ["409 PROPOSAL_STALE", 409, { error: "RAW SERVER WORDS", code: "PROPOSAL_STALE" }],
    ["409 PROPOSAL_NOT_VERIFIABLE", 409, { error: "RAW SERVER WORDS", code: "PROPOSAL_NOT_VERIFIABLE" }],
    ["409 PUBLICATION_CONFLICT", 409, { error: "RAW SERVER WORDS", code: "PUBLICATION_CONFLICT" }],
    ["409 PUBLICATION_NOT_VERIFIABLE", 409, { error: "RAW SERVER WORDS", code: "PUBLICATION_NOT_VERIFIABLE" }],
    ["409 SCHEDULE_NOT_PUBLISHABLE", 409, { error: "RAW SERVER WORDS", code: "SCHEDULE_NOT_PUBLISHABLE", problems: [{ field: "placements[0].startTime", code: "START_NOT_FUTURE", message: "The match must start after the moment this schedule is proposed." }] }],
    ["409 with a code nobody knows", 409, { error: "RAW SERVER WORDS", code: "SOMETHING_NEW" }],
    ["409 with no code", 409, { error: "RAW SERVER WORDS" }],
  ];
  it.each(REFUSALS)("24. a %s refusal: bounded copy of the page's own, nothing published, and both the competition and the schedule are read again before the control returns", async (_label, status, body) => {
    const server = seeded();
    const page = await sectionWith(server, { publish: () => ({ status, json: body }) });
    const viewUrl = `/api/gaming/competitions/${CID}`;
    const views = () => page.requests.filter((r) => r.method === "GET" && r.url === viewUrl).length;
    const reads = () => page.requests.filter((r) => r.method === "GET" && r.url === SCHEDULE_URL).length;
    const [v0, r0] = [views(), reads()];
    page.click(page.$("#schedule-publish"));
    await page.settle(() => text(page.$("#msg-schedule")) !== "" && !/publishing/i.test(text(page.$("#msg-schedule"))), "the refusal");
    const said = text(page.$("#msg-schedule"));
    expect(page.$("#msg-schedule").className).toContain("error");
    expect(said).not.toContain("RAW SERVER WORDS");
    expect(said).not.toContain("RAW PROBLEM");
    expect(said.length).toBeLessThan(420);
    expect(said).toMatch(/nothing was (published|changed)|already published|sign in/i);
    expect(said).not.toMatch(/schedule published\./i);
    await page.settle(() => views() === v0 + 1 && reads() === r0 + 1, "both fresh reads");
    expect(publishRequests(page)).toHaveLength(1);
    if (status === 409 && (body as any).code === "SCHEDULE_NOT_PUBLISHABLE") expect(said).toContain("The match must start after the moment this schedule is proposed.");
    page.close();
  });

  it("24b. the control does not return until the fresh reads have said it may: while they are pending nothing is offered, and a read that shows the proposal stale never brings it back", async () => {
    const server = seeded();
    const view = defer<ScheduleReply>();
    let refused = false;
    const page = await sectionWith(server, {
      publish: () => { refused = true; server.planCurrent = false; return { status: 409, json: { error: "x", code: "PROPOSAL_STALE" } }; },
      view: () => (refused ? view.promise : { status: 200, json: viewBody({ state: "READY_TO_PUBLISH", signal: ORGANIZER_SIGNAL }) }),
    });
    page.click(page.$("#schedule-publish"));
    await page.settle(() => section(page) === null && /nothing was published/i.test(text(page.$("#msg-schedule"))), "closed pending the fresh reads");
    expect(page.controls().filter((c) => c.includes("schedule"))).toEqual([]);
    view.resolve({ status: 200, json: viewBody({ state: "READY_TO_PUBLISH", signal: ORGANIZER_SIGNAL }) });
    await page.settle(() => !!section(page), "the surface again");
    expect(page.$("#schedule-latest").getAttribute("data-status")).toBe("STALE");
    expect(page.$("#schedule-publish")).toBeNull();
    expect(text(page.$("#msg-schedule"))).toMatch(/changed after this schedule was proposed/i);
    page.close();
  });

  const UNKNOWN_OUTCOMES: Array<[string, (server: MiniScheduleServer) => ScheduleScenario]> = [
    ["a silent server (timeout)", () => ({ publish: () => never(), timeoutMs: 40 })],
    ["a lost connection", () => ({ publish: () => Promise.reject(new Error("offline")) })],
    ["a 500", () => ({ publish: () => ({ status: 500, json: { error: "RAW SERVER WORDS" } }) })],
    ["a 502", () => ({ publish: () => ({ status: 502 }) })],
  ];
  it.each(UNKNOWN_OUTCOMES)("25. after %s the page does not claim to know: bounded copy, a fresh read of the competition and of the schedule, and a request that was aborted when it timed out", async (_label, build) => {
    const server = seeded();
    const scenario = build(server);
    const page = await sectionWith(server, scenario);
    const views = () => page.requests.filter((r) => r.method === "GET" && r.url === `/api/gaming/competitions/${CID}`).length;
    const v0 = views();
    page.click(page.$("#schedule-publish"));
    await page.settle(() => /not known whether the competition was published/i.test(text(page.$("#msg-schedule"))), "the honest message");
    expect(page.$("#msg-schedule").className).toContain("error");
    expect(text(page.$("#msg-schedule"))).not.toContain("RAW SERVER WORDS");
    expect(text(page.$("#msg-schedule"))).not.toMatch(/schedule published|nothing was published/i);
    await page.settle(() => views() > v0 && !!section(page), "reconciled through fresh reads");
    expect(publishRequests(page)).toHaveLength(1);
    if (_label.includes("timeout")) expect(publishRequests(page)[0].aborted()).toBe(true);
    page.close();
  });

  it("25b. when the fresh read shows the competition IS published, the page says so — from the server's state, not from a guess", async () => {
    const server = seeded();
    const page = await sectionWith(server, {
      publish: () => { server.publish({ scheduleProposalDigest: server.latest()!.proposalDigest }); return never(); },
      timeoutMs: 40,
    });
    page.click(page.$("#schedule-publish"));
    await page.settle(() => /now published/i.test(text(page.$("#msg-schedule"))), "the recognition");
    expect(page.$("#msg-schedule").className).not.toContain("error");
    expect(text(page.$("#comp-state-pill"))).toBe("In progress");
    expect(section(page)).toBeNull();
    page.close();
  });
});

// ---------------------------------------------------------------------------------------------------------------------------------------------
describe("changes of selection, session and detail reject late answers; nothing is duplicated", () => {
  /** Two READY_TO_PUBLISH competitions the caller organizes, with different teams, so a late answer for one can be told from the other. */
  function twoCompetitions(readOf: (id: string) => Promise<ScheduleReply> | ScheduleReply, extra: Partial<ScheduleScenario> = {}): ScheduleScenario {
    const view = (_r: ScheduleRequest, id: string): ScheduleReply => {
      const body = clone(viewBody({ state: "READY_TO_PUBLISH", signal: ORGANIZER_SIGNAL }));
      body.view.competition.competitionId = id;
      body.view.competition.name = id === CID ? "Frozen Cup" : "Second Cup";
      return { status: 200, json: body };
    };
    return {
      entries: [{ competitionId: CID, name: "Frozen Cup", state: "READY_TO_PUBLISH", access: "ORGANIZER" }, { competitionId: CID2, name: "Second Cup", state: "READY_TO_PUBLISH", access: "ORGANIZER" }],
      view, schedule: (_r, id) => readOf(id), ...extra,
    };
  }
  const teamsOf = (names: string[]) => readWire({ proposal: makeRecord({ teamNames: names }), history: [{ ...historyOf([makeRecord({ teamNames: names })])[0] }] });

  it("26a. choosing another competition while the first one's schedule read is pending: the first answer, arriving late, renders nothing", async () => {
    const first = defer<ScheduleReply>();
    const page = await openScheduleAdmin(twoCompetitions((id) => (id === CID ? first.promise : { status: 200, json: teamsOf(["Zulu", "Yankee", "X-ray", "Whiskey"]) })));
    page.$("#comp-select").value = CID;
    page.click(page.$("#btn-load-competition"));
    await page.settle(() => scheduleRequests(page).length === 1, "the first read");
    page.$("#comp-select").value = CID2;
    page.$("#comp-select").dispatchEvent(new page.win.Event("change", { bubbles: true }));
    page.click(page.$("#btn-load-competition"));
    await page.settle(() => !!section(page), "the second competition's surface");
    expect(text(section(page))).toContain("Zulu");
    expect(scheduleRequests(page)[0].aborted(), "the first read was aborted").toBe(true);
    first.resolve({ status: 200, json: teamsOf(["Alpha FC", "Bravo United", "Charlie Town", "Delta Rovers"]) });
    await tick(page, 80);
    expect(text(section(page))).toContain("Zulu");
    expect(text(page.$("#schedule-host"))).not.toContain("Alpha FC");
    expect(page.$$("#schedule-section")).toHaveLength(1);
    page.close();
  });

  it("26b. signing out while the read is pending: the late answer renders nothing and enables nothing", async () => {
    const read = defer<ScheduleReply>();
    const page = await openScheduleAdmin(withServer(seeded(), { schedule: () => read.promise }));
    await loadCompetition(page);
    await page.settle(() => scheduleRequests(page).length === 1, "the read");
    page.setAuth({ status: "unauthenticated" });
    await page.fireAuthChange();
    read.resolve({ status: 200, json: readWire() });
    await tick(page, 80);
    expect(section(page)).toBeNull();
    expect(page.controls()).toEqual([]);
    expect(scheduleRequests(page)[0].aborted()).toBe(true);
    page.close();
  });

  it("26c. reloading the same competition's detail while a read is pending: only the newest read is believed, whatever order the answers arrive in", async () => {
    const old = defer<ScheduleReply>();
    const fresh = defer<ScheduleReply>();
    let n = 0;
    const page = await openScheduleAdmin(withServer(seeded(), { schedule: () => (++n === 1 ? old.promise : fresh.promise) }));
    await loadCompetition(page);
    await page.settle(() => scheduleRequests(page).length === 1, "the first read");
    page.click(page.$("#btn-load-competition"));
    await page.settle(() => scheduleRequests(page).length === 2, "the second read");
    expect(scheduleRequests(page)[0].aborted()).toBe(true);
    fresh.resolve({ status: 200, json: teamsOf(["New One", "New Two", "New Three", "New Four"]) });
    await page.settle(() => !!section(page), "the newest answer");
    old.resolve({ status: 200, json: teamsOf(["Old One", "Old Two", "Old Three", "Old Four"]) });
    await tick(page, 80);
    expect(text(section(page))).toContain("New One");
    expect(text(section(page))).not.toContain("Old One");
    expect(page.$$("#schedule-section")).toHaveLength(1);
    page.close();
  });

  it("26d. changing the selection while a proposal is being sent: the late answer neither renders nor claims anything, and the request was aborted", async () => {
    const answer = defer<ScheduleReply>();
    const page = await openScheduleAdmin(twoCompetitions(() => ({ status: 200, json: readWire({ proposal: null, history: [] }) }), { propose: () => answer.promise }));
    await openSection(page, CID);
    chooseAll(page);
    page.click(page.$("#schedule-propose"));
    await page.settle(() => writes(page).length === 1, "the proposal request");
    page.$("#comp-select").value = CID2;
    page.$("#comp-select").dispatchEvent(new page.win.Event("change", { bubbles: true }));
    expect(section(page), "the surface is cleared in the same turn").toBeNull();
    expect(writes(page)[0].aborted()).toBe(true);
    answer.resolve({ status: 201, json: { proposal: readWire({ proposal: makeRecord({ sequenceNumber: 1 }) }).proposal, alreadyProposed: false } });
    await tick(page, 80);
    expect(section(page)).toBeNull();
    expect(text(page.$("#schedule-host"))).toBe("");
    page.close();
  });

  it("26e. changing the selection while the competition is being published: the late 201 is not confirmed on the new screen and the first competition is not reloaded over it", async () => {
    const answer = defer<ScheduleReply>();
    const server = seeded();
    const page = await openScheduleAdmin(twoCompetitions((id) => (id === CID ? { status: 200, json: server.read() } : { status: 200, json: teamsOf(["Zulu", "Yankee", "X-ray", "Whiskey"]) }), { publish: () => answer.promise }));
    await openSection(page, CID);
    page.click(page.$("#schedule-publish"));
    await page.settle(() => publishRequests(page).length === 1, "the publication request");
    page.$("#comp-select").value = CID2;
    page.$("#comp-select").dispatchEvent(new page.win.Event("change", { bubbles: true }));
    page.click(page.$("#btn-load-competition"));
    await page.settle(() => text(section(page)).includes("Zulu"), "the other competition's surface");
    const views = page.requests.filter((r) => r.method === "GET" && r.url === `/api/gaming/competitions/${CID}`).length;
    answer.resolve(server.publish({ scheduleProposalDigest: server.latest()!.proposalDigest }));
    await tick(page, 100);
    expect(text(page.$("#msg-schedule"))).toBe("");
    expect(text(page.$("#comp-title"))).toBe("Second Cup");
    expect(page.requests.filter((r) => r.method === "GET" && r.url === `/api/gaming/competitions/${CID}`).length, "the first competition is not reloaded").toBe(views);
    expect(publishRequests(page)[0].aborted()).toBe(true);
    page.close();
  });

  it("26f. a session refresh while the competition is being published interrupts it honestly: the request is aborted, the page says it does not know, and the surface returns from fresh answers", async () => {
    const answer = defer<ScheduleReply>();
    const server = seeded();
    const page = await sectionWith(server, { publish: () => answer.promise });
    page.click(page.$("#schedule-publish"));
    await page.settle(() => publishRequests(page).length === 1, "the publication request");
    expect(page.visible(section(page)!)).toBe(true);
    await page.fireAuthChange();
    expect(publishRequests(page)[0].aborted()).toBe(true);
    expect(text(page.$("#msg-schedule"))).toMatch(/interrupted/i);
    expect(text(page.$("#msg-schedule"))).toMatch(/reload/i);
    answer.resolve(server.publish({ scheduleProposalDigest: server.latest()!.proposalDigest }));
    await page.settle(() => !!section(page) && scheduleRequests(page).length >= 2, "the surface re-established from a fresh read");
    expect(text(page.$("#msg-schedule"))).not.toMatch(/schedule published/i);
    expect(page.$$("#schedule-section")).toHaveLength(1);
    page.close();
  });

  it("26g. an answer to a publication of a proposal that has since been replaced on screen confirms nothing and enables nothing", async () => {
    const old = defer<ScheduleReply>();
    const server = seeded(2);
    const page = await sectionWith(server, { publish: () => old.promise });
    const oldDigest = server.latest()!.proposalDigest;
    page.click(page.$("#schedule-publish"));
    await page.settle(() => publishRequests(page).length === 1, "the publication request");
    // the surface is rebuilt around a newer proposal (as a session refresh does)
    server.propose({ intentId: "77777777-7777-4777-8777-777777777777", placements: OTHER_PLACEMENTS });
    await page.fireAuthChange();
    await page.settle(() => text(page.$("#schedule-latest")).includes("Proposal 3"), "the newer proposal on screen");
    const newDigest = page.run("scheduleState.proposal.proposalDigest");
    expect(newDigest).not.toBe(oldDigest);
    old.resolve({ status: 201, json: publicationWire({ scheduleProposalDigest: oldDigest, proposalSequence: 2 }) });
    await tick(page, 100);
    expect(text(page.$("#msg-schedule"))).not.toMatch(/schedule published/i);
    expect(page.run("scheduleState.proposal.proposalDigest")).toBe(newDigest);
    expect(text(page.$("#schedule-latest"))).toContain("Proposal 3");
    expect(publishRequests(page)).toHaveLength(1);
    page.close();
  });

  it("26h. a control captured before the surface was cleared does nothing when activated afterwards", async () => {
    const page = await sectionWith(seeded());
    const publish = page.$("#schedule-publish");
    const propose = page.$("#schedule-propose");
    chooseAll(page, OTHER_PLACEMENTS);
    page.$("#comp-select").dispatchEvent(new page.win.Event("change", { bubbles: true }));
    expect(section(page)).toBeNull();
    publish.disabled = false;
    propose.disabled = false;
    publish.click();
    propose.click();
    await tick(page, 80);
    expect(writes(page)).toEqual([]);
    page.close();
  });

  it("26i. the held proposal is forgotten whenever the surface is: no digest survives a selection change, a sign-out or a reload of the detail", async () => {
    const page = await sectionWith(seeded());
    expect(page.run("typeof scheduleState.proposal.proposalDigest")).toBe("string");
    const held = page.run("scheduleState");
    page.$("#comp-select").dispatchEvent(new page.win.Event("change", { bubbles: true }));
    expect(page.run("scheduleState")).toBeNull();
    expect((held as any).proposal, "the state the removed surface held no longer carries the proposal").toBeNull();
    page.click(page.$("#btn-load-competition"));
    await page.settle(() => !!section(page), "the surface again");
    const second = page.run("scheduleState");
    page.click(page.$("#btn-load-competition"));
    expect(page.run("scheduleState"), "reloading the detail clears the surface and the held digest in the same turn").toBeNull();
    expect((second as any).proposal).toBeNull();
    expect(section(page)).toBeNull();
    page.close();
  });

  it("27. nothing is duplicated however often the page reloads, re-authorizes or rebuilds: one surface, one set of controls, one request per activation", async () => {
    const server = seeded();
    const page = await sectionWith(server);
    for (let i = 0; i < 3; i++) {
      page.click(page.$("#btn-load-competition"));
      await page.settle(() => !!section(page) && !page.$("#schedule-publish").disabled, `reload ${i + 1}`);
      await page.fireAuthChange();
      await page.settle(() => !!section(page) && !page.$("#schedule-publish").disabled, `re-authorization ${i + 1}`);
    }
    expect(page.$$("#schedule-section")).toHaveLength(1);
    expect(page.$$("#schedule-publish")).toHaveLength(1);
    expect(page.$$("#schedule-propose")).toHaveLength(1);
    expect(page.$$("#schedule-form select")).toHaveLength(9);
    expect(page.controls()).toEqual([...BASE_READY, ...SCHEDULE_CONTROLS_CURRENT]);
    chooseAll(page, OTHER_PLACEMENTS);
    page.click(page.$("#schedule-propose"));
    await page.settle(() => text(page.$("#schedule-latest")).includes("Proposal 4"), "the new proposal");
    expect(writes(page)).toHaveLength(1);
    expect(page.$$("#schedule-section")).toHaveLength(1);
    page.click(page.$("#schedule-publish"));
    await page.settle(() => publishRequests(page).length === 1, "one publication request");
    await page.settle(() => section(page) === null && text(page.$("#comp-state-pill")) === "In progress", "the published competition");
    expect(publishRequests(page)).toHaveLength(1);
    expect(page.$$("#schedule-section")).toHaveLength(0);
    page.close();
  });

  // ------------------------------------------------------------------------------------------------------------------------------------------
  // Guards that must hold ON THEIR OWN: when a fetch ignores abort (abort is only a request), when an action's own refresh fails, when the session ends,
  // when the administration closes. Nothing here may be hidden behind another guard that happens to catch the same fault.
  // ------------------------------------------------------------------------------------------------------------------------------------------
  const ignoreAbort = (page: SchedulePage) => { page.run("AbortController.prototype.abort = function () { /* a fetch that does not honour abort */ }"); };
  const changeTo = (page: SchedulePage, id: string) => { page.$("#comp-select").value = id; page.$("#comp-select").dispatchEvent(new page.win.Event("change", { bubbles: true })); };

  it("26j. a schedule read answered after the section was removed renders nothing even when the fetch ignores abort: after a selection change, after a sign-out, after a reload", async () => {
    const OLD = ["Old One", "Old Two", "Old Three", "Old Four"];
    const NEW = ["New One", "New Two", "New Three", "New Four"];
    const first = defer<ScheduleReply>();
    const a = await openScheduleAdmin(twoCompetitions((id) => (id === CID ? first.promise : { status: 200, json: teamsOf(NEW) })));
    ignoreAbort(a);
    a.$("#comp-select").value = CID;
    a.click(a.$("#btn-load-competition"));
    await a.settle(() => scheduleRequests(a).length === 1, "the first read");
    changeTo(a, CID2);
    a.click(a.$("#btn-load-competition"));
    await a.settle(() => text(section(a)).includes("New One"), "the second competition's surface");
    first.resolve({ status: 200, json: teamsOf(OLD) });
    await tick(a, 80);
    expect(text(section(a))).toContain("New One");
    expect(text(a.$("#schedule-host"))).not.toContain("Old One");
    expect(a.$$("#schedule-section")).toHaveLength(1);
    a.close();

    const second = defer<ScheduleReply>();
    const b = await openScheduleAdmin(withServer(seeded(), { schedule: () => second.promise }));
    ignoreAbort(b);
    await loadCompetition(b);
    await b.settle(() => scheduleRequests(b).length === 1, "the read");
    b.setAuth({ status: "unauthenticated" });
    await b.fireAuthChange();
    second.resolve({ status: 200, json: readWire() });
    await tick(b, 80);
    expect(section(b)).toBeNull();
    expect(b.controls()).toEqual([]);
    b.close();

    const old = defer<ScheduleReply>();
    const fresh = defer<ScheduleReply>();
    let n = 0;
    const c = await openScheduleAdmin(withServer(seeded(), { schedule: () => (++n === 1 ? old.promise : fresh.promise) }));
    ignoreAbort(c);
    await loadCompetition(c);
    await c.settle(() => scheduleRequests(c).length === 1, "the first read");
    c.click(c.$("#btn-load-competition"));
    await c.settle(() => scheduleRequests(c).length === 2, "the second read");
    fresh.resolve({ status: 200, json: teamsOf(NEW) });
    await c.settle(() => !!section(c), "the newest answer");
    old.resolve({ status: 200, json: teamsOf(OLD) });
    await tick(c, 80);
    expect(text(section(c))).toContain("New One");
    expect(text(section(c))).not.toContain("Old One");
    c.close();
  });

  it("26k. a reconciling read answered after the section was removed changes nothing, even when the fetch ignores abort", async () => {
    const server = new MiniScheduleServer();
    const late = defer<ScheduleReply>();
    let reads = 0;
    const page = await sectionWith(server, { propose: () => Promise.reject(new Error("offline")), schedule: () => (++reads === 1 ? { status: 200, json: server.read() } : late.promise) });
    ignoreAbort(page);
    chooseAll(page);
    page.click(page.$("#schedule-propose"));
    await page.settle(() => reads === 2, "the reconciling read, still unanswered");
    page.$("#comp-select").dispatchEvent(new page.win.Event("change", { bubbles: true }));
    expect(section(page)).toBeNull();
    server.propose({ intentId: "88888888-8888-4888-8888-888888888888", placements: GOOD_PLACEMENTS });
    late.resolve({ status: 200, json: server.read() });
    await tick(page, 100);
    expect(section(page), "the answer of a section that no longer exists builds nothing").toBeNull();
    expect(page.visible(page.$("#schedule-read-note"))).toBe(false);
    page.close();
  });

  it("26l. an answer to a proposal or a publication that arrives after the section was removed changes nothing and asks for nothing, even when the fetch ignores abort", async () => {
    const answer = defer<ScheduleReply>();
    const a = await openScheduleAdmin(twoCompetitions(() => ({ status: 200, json: readWire({ proposal: null, history: [] }) }), { propose: () => answer.promise }));
    ignoreAbort(a);
    await openSection(a, CID);
    chooseAll(a);
    a.click(a.$("#schedule-propose"));
    await a.settle(() => writes(a).length === 1, "the proposal request");
    changeTo(a, CID2);
    const reads = scheduleRequests(a).filter((r) => r.method === "GET").length;
    answer.resolve({ status: 201, json: { proposal: readWire({ proposal: makeRecord({ sequenceNumber: 1 }) }).proposal, alreadyProposed: false } });
    await tick(a, 100);
    expect(section(a)).toBeNull();
    expect(scheduleRequests(a).filter((r) => r.method === "GET"), "the late answer asked for nothing").toHaveLength(reads);
    a.close();

    const publication = defer<ScheduleReply>();
    const server = seeded();
    const b = await openScheduleAdmin(twoCompetitions(() => ({ status: 200, json: server.read() }), { publish: () => publication.promise }));
    ignoreAbort(b);
    await openSection(b, CID);
    b.click(b.$("#schedule-publish"));
    await b.settle(() => publishRequests(b).length === 1, "the publication request");
    changeTo(b, CID2);
    const views = b.requests.filter((r) => r.method === "GET" && r.url === `/api/gaming/competitions/${CID}`).length;
    publication.resolve(server.publish({ scheduleProposalDigest: server.latest()!.proposalDigest }));
    await tick(b, 100);
    expect(text(b.$("#msg-schedule")), "a late success is not announced").toBe("");
    expect(b.requests.filter((r) => r.method === "GET" && r.url === `/api/gaming/competitions/${CID}`), "and the competition is not reloaded over what is on screen").toHaveLength(views);
    b.close();
  });

  it("26m. choosing Load with no valid selection clears the surface too: nothing is left standing for a competition that is no longer the one selected", async () => {
    const page = await sectionWith(seeded());
    page.$("#comp-select").value = "not-a-competition";
    expect(page.$("#comp-select").value).toBe("");
    page.click(page.$("#btn-load-competition"));
    expect(section(page)).toBeNull();
    expect(page.run("scheduleState")).toBeNull();
    page.close();
  });

  it("26n. the session ending forgets an unanswered request: after signing out and in again, the same choices are a new request", async () => {
    const page = await sectionWith(new MiniScheduleServer(), { propose: () => Promise.reject(new Error("offline")) });
    chooseAll(page);
    page.click(page.$("#schedule-propose"));
    await page.settle(() => writes(page).length === 1 && !page.$("#schedule-propose").disabled, "the first attempt");
    page.setAuth({ status: "unauthenticated" });
    await page.fireAuthChange();
    page.setAuth(SIGNED_IN);
    await page.fireAuthChange();
    await page.settle(() => !!section(page) && !page.$("#schedule-propose").disabled, "the surface again after signing in");
    chooseAll(page);
    page.click(page.$("#schedule-propose"));
    await page.settle(() => writes(page).length === 2, "the second attempt");
    expect(writes(page)[1].json().intentId, "an intent does not outlive the session that made it").not.toBe(writes(page)[0].json().intentId);
    page.close();
  });

  it("26o. when the list of the caller's competitions fails to load after creating one, everything closes — the schedule section included", async () => {
    const server = seeded();
    const inner = scheduleTransport(withServer(server));
    let listReads = 0;
    const page = openAmendAdminPage({
      auth: SIGNED_IN,
      transport: (r) => {
        if (r.url === ADMIN_SOURCE) {
          listReads += 1;
          return listReads === 1
            ? { status: 200, json: { competitions: [{ competitionId: CID, name: "Frozen Cup", state: "READY_TO_PUBLISH", access: "ORGANIZER" }], operations: { createCompetition: true } } }
            : { status: 500, json: {} };
        }
        if (r.url === "/api/gaming/competitions" && r.method === "POST") return { status: 201, json: {} };
        return inner(r);
      },
    });
    await page.settle(() => page.$$("#comp-select option").length === 1, "the list");
    await openSection(page);
    page.setValue(page.$("#c-name"), "Another Cup");
    page.click(page.$("#btn-create-competition"));
    await page.settle(() => section(page) === null && text(page.$("#admin-gate")) !== "", "everything closed");
    expect(page.$("#schedule-host").children).toHaveLength(0);
    expect(page.run("scheduleState")).toBeNull();
    expect(page.controls()).toEqual([]);
    page.close();
  });

  it("26p. when the read that follows an action fails, the section closes and says so — after a success, after a refusal, after an unknown outcome, and after a publication refusal", async () => {
    const failingAfterTheFirst = (server: MiniScheduleServer) => { let n = 0; return (): ScheduleReply => (++n === 1 ? { status: 200, json: server.read() } : { status: 500, json: { error: "x" } }); };
    const closedWithNote = async (page: SchedulePage, label: string) => {
      await page.settle(() => section(page) === null && page.visible(page.$("#schedule-read-note")), `${label}: closed, with the note`);
      expect(page.controls(), label).toEqual(BASE_READY);
      expect(text(page.$("#schedule-read-note")), label).toMatch(/schedule could not be loaded/i);
    };
    const proposing: Array<[string, ScheduleScenario["propose"]]> = [
      ["after a success", undefined],
      ["after a refusal (409)", () => ({ status: 409, json: { error: "x", code: "DRAW_REQUIRED" } })],
      ["after an unknown outcome (500)", () => ({ status: 500, json: { error: "x" } })],
    ];
    for (const [label, propose] of proposing) {
      const server = new MiniScheduleServer();
      const page = await sectionWith(server, { schedule: failingAfterTheFirst(server), ...(propose ? { propose } : {}) });
      chooseAll(page);
      page.click(page.$("#schedule-propose"));
      await closedWithNote(page, label);
      page.close();
    }
    const server = seeded();
    const page = await sectionWith(server, { schedule: failingAfterTheFirst(server), publish: () => ({ status: 409, json: { error: "x", code: "PROPOSAL_STALE" } }) });
    page.click(page.$("#schedule-publish"));
    await closedWithNote(page, "after a publication refusal");
    expect(text(page.$("#msg-schedule")), "the refusal's own words stay beside the note").toMatch(/nothing was published/i);
    page.close();
  });
});

// ---------------------------------------------------------------------------------------------------------------------------------------------
describe("everything else on the organizer page is exactly what it was", () => {
  it("28a. the controls of every other state are unchanged, with and without fixtures: no schedule control appears outside READY_TO_PUBLISH", async () => {
    for (const [label, state, expected] of BASELINE_LOADED_STATES) {
      const page = await openScheduleAdmin({ state, signal: ORGANIZER_SIGNAL, view: () => ({ status: 200, json: viewBody({ state, signal: ORGANIZER_SIGNAL, extra: { fixtures: state === "PUBLISHED" || state === "COMPLETE" ? FIXTURES : [] } }) }) });
      await loadCompetition(page);
      await tick(page, 100);
      expect(page.controls(), label).toEqual(expected);
      expect(section(page), label).toBeNull();
      page.close();
    }
    // positive control
    const control = await sectionWith(seeded());
    expect(section(control)).not.toBeNull();
    control.close();
  });

  it("28b. the post-freeze plan-change section is untouched and lives beside the schedule surface: its twenty-six controls are exactly the same, in the same order", async () => {
    const { planningBody, statusBody } = await import("./helpers/competitionPlanAmendmentPageHarness");
    const page = await openScheduleAdmin(withServer(seeded(), {
      planning: () => ({ status: 200, json: planningBody() }),
      amendment: () => ({ status: 200, json: statusBody({ amendment: null }) }),
    }));
    await loadCompetition(page);
    await page.settle(() => !!page.$("#plan-change-section") && !!section(page), "both sections");
    const inChange = (page.$$("#plan-change-section button, #plan-change-section input, #plan-change-section select, #plan-change-section textarea, #plan-change-section summary") as Element[]).length;
    expect(inChange).toBe(26);
    expect(page.controls()).toEqual(["select#comp-select", "button#btn-load-competition", ...PLAN_CHANGE_CONTROLS, "button#btn-open-cancel", ...COPY4, ...SCHEDULE_CONTROLS_CURRENT]);
    page.close();
  });

  it("28c. creation, selection, cancellation and fixture-day controls keep working beside it", async () => {
    const page = await openScheduleAdmin({ ...withServer(seeded()) });
    expect(page.visible(page.$("#create-section"))).toBe(false);
    await openSection(page);
    expect(page.visible(page.$("#select-section"))).toBe(true);
    page.click(page.$("#btn-open-cancel"));
    expect(page.visible(page.$("#cancel-panel"))).toBe(true);
    expect(page.$("#btn-cancel-confirm").disabled).toBe(true);
    page.setValue(page.$("#cancel-reason"), "Not enough pitches");
    expect(page.$("#btn-cancel-confirm").disabled).toBe(false);
    page.close();

    const creation = openAmendAdminPage({
      auth: SIGNED_IN,
      transport: (r) => r.url === ADMIN_SOURCE ? { status: 200, json: { competitions: [{ competitionId: CID, name: "Frozen Cup", state: "READY_TO_PUBLISH", access: "ORGANIZER" }], operations: { createCompetition: true } } } : { status: 404, json: { error: "x" } },
    });
    await creation.settle(() => creation.visible(creation.$("#create-section")), "the creation form");
    expect(creation.controls().slice(0, 3)).toEqual(["input#c-name", "select#c-activity", "button#btn-create-competition"]);
    creation.close();
  });

  it("28d. the fixture-day controls of a published competition are reachable exactly as before", async () => {
    const page = await openScheduleAdmin({
      state: "PUBLISHED", view: () => ({ status: 200, json: viewBody({ state: "PUBLISHED", signal: ORGANIZER_SIGNAL, extra: { fixtures: FIXTURES } }) }),
    });
    await loadCompetition(page);
    await page.settle(() => page.$$("#fixtures-list .btn-load-detail").length === 2, "the fixtures");
    page.click(page.$("#fixtures-list .btn-load-detail"));
    await page.settle(() => page.$("#fixtures-list fieldset") !== null, "the fixture detail");
    expect((page.$$("#fixtures-list legend") as Element[]).map(text)).toEqual(["Appoint Scorekeeper", "Submit Evidence (Scorekeeper)", "Correct Fixture (Organizer)", "Close Fixture (Organizer)"]);
    expect(section(page)).toBeNull();
    page.close();
  });

  it("29. no new format is exposed: the page names no format beyond five-a-side, the only format choice is the creation form's, and the schedule surface chooses no format", async () => {
    expect(ADMIN_HTML).not.toMatch(/SOCCER_[678]V[678]/i);
    expect(ADMIN_HTML).not.toMatch(/\b[678]\s?v\s?[678]\b/i);
    const selects = [...ADMIN_HTML.matchAll(/<select[^>]*>([\s\S]*?)<\/select>/g)].map((m) => m[1]).filter((s) => /SOCCER_/.test(s));
    expect(selects).toHaveLength(1);
    const page = await sectionWith(seeded());
    expect(page.$$("#schedule-section [id*='format'], #schedule-section [name*='format'], #schedule-section [class*='format']")).toHaveLength(0);
    expect((page.$$("#schedule-section select") as Element[]).map((s) => s.id).filter((id) => /format/i.test(id))).toEqual([]);
    expect(optionValues(page, "#schedule-section select").some((v: string) => /SOCCER_/.test(v))).toBe(false);
    expect(contextFacts(page)["Format"]).toEqual(["Soccer 5v5"]);
    page.close();
  });

  it("30. no captain, member or public schedule view is added: no other public page carries any of this, the member page is unchanged and asks nothing, and the schedule has no public route", async () => {
    const files = walk(path.join(process.cwd(), "public"), (f) => /\.(html|js)$/.test(f));
    const carrying = files.filter((f) => /schedule-proposal|scheduleProposal|schedule-section|Publish Competition Schedule/.test(readFileSync(f, "utf8"))).map((f) => path.relative(process.cwd(), f));
    expect(carrying, "only the organizer page offers the schedule").toEqual(["public/competitions-admin.html"]);
    expect(MEMBER_HTML).not.toMatch(/schedule-proposal|scheduleProposalDigest|schedule-section|\/publish\b/);
    // a frozen captain who opens the addressed competition makes no schedule request and sees no schedule
    const captain = openAmendMemberPage({
      auth: SIGNED_IN, search: `?c=${CODE}`,
      transport: (r) => r.url.startsWith("/api/gaming/competitions/resolve") ? { status: 200, json: { competitionId: CID } }
        : r.url === `/api/gaming/competitions/${CID}` ? { status: 200, json: viewBody({ state: "READY_TO_PUBLISH", signal: { organizer: false, captain: true } }) }
        : { status: 404, json: { error: "x" } },
    });
    await captain.settle(() => captain.requests.some((r) => r.url === `/api/gaming/competitions/${CID}`), "the addressed competition");
    await tick(captain, 120);
    expect(captain.requests.filter((r) => r.url.includes("schedule") || r.url.endsWith("/publish"))).toEqual([]);
    expect(captain.$("#schedule-section")).toBeNull();
    captain.close();
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
describe("the code and the keyboard", () => {
  // The block begins at its own header; the small hooks in older functions carry the gate's id too, but not this heading.
  const BLOCK_HEADER = 'UG-CR-GATE-SSS-028 — "Schedule and publish"';
  const CODE_START = ADMIN_HTML.indexOf(BLOCK_HEADER);
  const code = () => ADMIN_HTML.slice(CODE_START, ADMIN_HTML.indexOf("UrbanoAuth.onAuthStateChange(", CODE_START));

  it("31. the schedule code stores nothing, polls nothing, parses no server text as markup, sends nothing but what is documented, and mentions the proposal path and the digest key once each", () => {
    expect(CODE_START).toBeGreaterThan(-1);
    const block = code();
    expect(block.length).toBeGreaterThan(2000);
    expect(block).not.toMatch(/localStorage|sessionStorage|document\.cookie|indexedDB|setInterval|navigator\.sendBeacon|XMLHttpRequest|WebSocket|EventSource/);
    expect(block).not.toMatch(/\bel\(|insertAdjacentHTML|outerHTML\s*=|document\.write|new Function|\beval\(/);
    for (const match of block.matchAll(/innerHTML/g)) expect(block.slice(match.index!, match.index! + 16), "innerHTML is only ever cleared").toMatch(/^innerHTML\s*=\s*"";/);
    expect(ADMIN_HTML.match(/schedule-proposal/g) ?? []).toHaveLength(1);
    expect(ADMIN_HTML.match(/scheduleProposalDigest/g) ?? []).toHaveLength(1);
    expect(block).not.toMatch(/schedule[_ ]?publication|SchedulePublication/i);
    expect(block).not.toMatch(/schedule_proposal/i);
    expect(ADMIN_HTML).not.toMatch(/competitions\/[^\s"'`<>]*\/draw(?![A-Za-z])/);
    // one request wrapper: every schedule request goes through the abortable, bounded, uncached helper
    expect(block.match(/\bauthedFetch\(/g) ?? []).toHaveLength(1);
    expect(block.match(/\bfetch\(/g) ?? []).toHaveLength(0);
  });

  it("32. the keyboard path is the document order, every control is a native control with a visible name, and focus lands where the outcome is", async () => {
    const page = await sectionWith(new MiniScheduleServer());
    const order = page.controls().filter((c) => c.includes("schedule"));
    expect(order).toEqual(SCHEDULE_FORM_CONTROLS);
    for (const c of page.$$("#schedule-section button, #schedule-section select") as HTMLElement[]) {
      expect(c.tabIndex, c.id).toBeGreaterThanOrEqual(0);
      expect(["BUTTON", "SELECT"]).toContain(c.tagName);
    }
    expect(page.$("#schedule-section").getAttribute("role")).toBe("region");
    expect(page.$("#schedule-section").getAttribute("aria-labelledby")).toBe("schedule-heading");
    expect(page.$("#schedule-heading").tabIndex).toBe(-1);
    expect(page.$("#schedule-status").getAttribute("aria-live")).toBe("polite");
    expect(page.$("#msg-schedule").getAttribute("aria-live")).toBe("polite");
    expect(page.$("#schedule-problems").tagName).toBe("UL");
    // a refusal keeps the focus on the control that was used (or on the first thing to fix); success moves to the new heading
    page.click(page.$("#schedule-propose"));
    await tick(page);
    expect(document_activeId(page)).toBe("schedule-sf1-pitch");
    chooseAll(page);
    page.click(page.$("#schedule-propose"));
    await page.settle(() => document_activeId(page) === "schedule-heading", "focus on the heading");
    page.close();
  });

  it("32b. the keyboard focus is not lost while a request is out: it returns to the control that had it, whether the section is only re-enabled or is rebuilt from a fresh read", async () => {
    // A browser moves the focus away from a focused control that becomes disabled. jsdom does not (and its blur() does nothing on a disabled control), so the transport does the
    // equivalent here, at the moment of the request: the focus is taken to another control, and only the page's own remembering can bring it back.
    let awayA = "";
    let awayB = "";
    // Re-enabled: an unknown outcome that changes nothing on the server.
    const a: SchedulePage = await sectionWith(new MiniScheduleServer(), { propose: () => { a.$("#comp-select").focus(); awayA = document_activeId(a); return { status: 500, json: { error: "x" } }; } });
    chooseAll(a);
    a.$("#schedule-propose").focus();
    expect(document_activeId(a)).toBe("schedule-propose");
    a.click(a.$("#schedule-propose"));
    await a.settle(() => writes(a).length === 1 && !a.$("#schedule-propose").disabled, "the first attempt to end");
    expect(awayA, "the focus really was taken away while the request was out").toBe("comp-select");
    expect(document_activeId(a)).toBe("schedule-propose");
    a.close();
    // Rebuilt: a refusal makes the page read the server again and build the section anew.
    const b: SchedulePage = await sectionWith(new MiniScheduleServer(), { propose: () => { b.$("#comp-select").focus(); awayB = document_activeId(b); return { status: 409, json: { error: "x", code: "DRAW_REQUIRED" } }; } });
    chooseAll(b);
    b.$("#schedule-propose").focus();
    b.click(b.$("#schedule-propose"));
    await b.settle(() => text(b.$("#schedule-status")) !== "" && !b.$("#schedule-propose").disabled, "the refusal");
    expect(awayB, "the focus really was taken away while the request was out").toBe("comp-select");
    expect(document_activeId(b), "the section was rebuilt and the focus is back on the control that had it").toBe("schedule-propose");
    b.close();
  });

  it("33. the serving surface cannot be reached through the old manual route: the page never sends the seven legacy fields, whatever is clicked", async () => {
    const server = seeded();
    const page = await sectionWith(server);
    for (const el of page.$$("#schedule-section button") as HTMLButtonElement[]) el.click();
    await tick(page, 120);
    const bodies = writes(page).map((r) => r.body ?? "");
    for (const body of bodies) expect(body).not.toMatch(/semifinal1|semifinal2|finalScheduledAt|TeamAId|TeamBId/);
    page.close();
  });
});

describe("the real request parsers accept what the page sends, and refuse the shapes it must never send", () => {
  it("34. the bodies of the exact examples in the gate parse; mixed, extra and legacy bodies do not (the contract the page is held to)", () => {
    const digest = "d".repeat(64);
    expect(parsePublishRequest({ scheduleProposalDigest: digest })).toEqual({ kind: "SCHEDULE", scheduleProposalDigest: digest });
    expect(() => parsePublishRequest({ scheduleProposalDigest: digest, teams: [] })).toThrow();
    expect(() => parsePublishRequest({ scheduleProposalDigest: digest, semifinal1TeamAId: "x" })).toThrow();
    expect(() => parsePublishRequest({ scheduleProposalDigest: digest.toUpperCase() })).toThrow();
    const intentId = "88888888-8888-4888-8888-888888888888";
    expect(parseScheduleProposalRequest({ intentId, placements: GOOD_PLACEMENTS }).placements).toEqual(GOOD_PLACEMENTS);
    expect(() => parseScheduleProposalRequest({ intentId, placements: GOOD_PLACEMENTS, teams: [] })).toThrow();
    expect(() => parseScheduleProposalRequest({ intentId, placements: GOOD_PLACEMENTS.map((p) => ({ ...p, startUtc: "2026-11-14T16:00:00.000Z" })) })).toThrow();
    expect(() => parseScheduleProposalRequest({ intentId, placements: GOOD_PLACEMENTS.slice(0, 2) })).toThrow();
  });


  it("34c. the page's validators judge each rule alone, so no rule hides behind another that happens to catch the same fault", async () => {
    const page = await sectionWith(seeded());
    const judge = (fn: string, arg: unknown) => page.run(`${fn}(${JSON.stringify(arg)})`);
    const good = clone(readWire({ proposal: chain(3)[2], history: historyOf(chain(3)) }));
    expect(judge("schedValidProposal", good.proposal)).toBe(true);
    expect(judge("schedValidContext", good.context)).toBe(true);
    expect(judge("schedValidRead", good) !== null).toBe(true);

    const proposals: Array<[string, (p: any) => void]> = [
      ["an unknown status", (p) => { p.status = "APPROVED"; }],
      ["a lower-case status", (p) => { p.status = "current"; }],
      ["a planning flag that is not a boolean", (p) => { p.planningRevisionCurrent = "true"; }],
      ["a draw flag that is not a boolean", (p) => { p.drawDigestMatches = 1; }],
      ["a proposal digest in capitals", (p) => { p.proposalDigest = "A".repeat(64); }],
      ["a draw digest of 63 digits", (p) => { p.drawDigest = p.drawDigest.slice(0, 63); }],
      ["a superseded digest that is not a digest", (p) => { p.supersedesDigest = "x"; }],
      ["a sequence number of zero", (p) => { p.sequenceNumber = 0; }],
      ["a creation time that is not an instant", (p) => { p.createdAt = "yesterday"; }],
      ["a plan revision of zero", (p) => { p.planningRevisionNumber = 0; }],
      ["no format", (p) => { p.formatKey = ""; }],
      ["no time zone", (p) => { p.timeZone = ""; }],
      ["a capacity of zero", (p) => { p.simultaneousMatchCapacity = 0; }],
      ["a reserved time of zero", (p) => { p.timing.occupancyMinutes = 0; }],
      ["a negative transition", (p) => { p.timing.pitchTransitionMinutes = -1; }],
      ["placements out of role order", (p) => { p.placements.reverse(); }],
      ["a placement pitch that is not an id", (p) => { p.placements[0].planningPitchId = "pitch"; }],
      ["a placement with no pitch label", (p) => { p.placements[1].pitchLabel = ""; }],
      ["a placement date that is not a day", (p) => { p.placements[0].planDate = "2026-02-30"; }],
      ["a placement time that is not a time", (p) => { p.placements[0].startTime = "25:00"; }],
      ["an end that is not an instant", (p) => { p.placements[0].endUtc = "x"; }],
      ["a window start that is not an instant", (p) => { p.placements[1].windowStartUtc = "x"; }],
      ["a semifinal team without an id", (p) => { p.placements[0].teamA.teamId = ""; }],
      ["a semifinal team without a name", (p) => { p.placements[1].teamB.teamName = ""; }],
      ["a semifinal without a team", (p) => { p.placements[0].teamB = null; }],
      ["a final naming a team", (p) => { p.placements[2].teamB = { teamId: "t", teamName: "x" }; }],
    ];
    for (const [label, mutate] of proposals) { const p = clone(good.proposal); mutate(p); expect(judge("schedValidProposal", p), label).toBe(false); }

    const contexts: Array<[string, (c: any) => void]> = [
      ["a plan revision of zero", (c) => { c.planningRevisionNumber = 0; }],
      ["no format", (c) => { c.formatKey = ""; }],
      ["no time zone", (c) => { c.timeZone = ""; }],
      ["a capacity of zero", (c) => { c.simultaneousMatchCapacity = 0; }],
      ["a match that reserves no time", (c) => { c.timing.occupancyMinutes = 0; }],
      ["a pitch id that is not an id", (c) => { c.pitches[0].planningPitchId = "x"; }],
      ["two pitches with one id", (c) => { c.pitches[1].planningPitchId = c.pitches[0].planningPitchId.toUpperCase(); }],
      ["a pitch with no label", (c) => { c.pitches[0].label = ""; }],
      ["a usable flag that is text", (c) => { c.pitches[0].usable = "yes"; }],
      ["supported formats that are not a list", (c) => { c.pitches[0].supportedFormats = "SOCCER_5V5"; }],
      ["too many pitches", (c) => { c.pitches = Array.from({ length: 65 }, (_, i) => ({ planningPitchId: `a0000000-0000-4000-8000-${String(i).padStart(12, "0")}`, label: `P${i}`, usable: true, supportedFormats: [] })); }],
      ["a date that is not a day", (c) => { c.dates[0].date = "2026-13-01"; }],
      ["a date listed twice", (c) => { c.dates[1].date = c.dates[0].date; }],
      ["a window with no end", (c) => { delete c.dates[0].windows[0].end; }],
      ["a window that ends where it starts", (c) => { c.dates[0].windows[0] = { start: "09:00", end: "09:00" }; }],
      ["too many windows", (c) => { c.dates[0].windows = Array.from({ length: 9 }, (_, i) => ({ start: `0${i}:00`, end: `0${i}:30` })); }],
    ];
    for (const [label, mutate] of contexts) { const c = clone(good.context); mutate(c); expect(judge("schedValidContext", c), label).toBe(false); }

    const reads: Array<[string, (r: any) => void]> = [
      ["a first history entry with another number", (r) => { r.history[0].sequenceNumber = 2; }],
      ["a first history entry with another digest", (r) => { r.history[0].proposalDigest = "e".repeat(64); }],
      ["a first history entry with another status", (r) => { r.history[0].status = "STALE"; }],
      ["a history that is not strictly newest first", (r) => { r.history[2].sequenceNumber = 2; }],
      ["a history entry with a digest in capitals", (r) => { r.history[1].proposalDigest = "F".repeat(64); }],
      ["a history entry with an unknown status", (r) => { r.history[1].status = "OLD"; }],
      ["a history entry with no creation time", (r) => { delete r.history[1].createdAt; }],
      ["more history than the server sends", (r) => { r.history = Array.from({ length: 51 }, (_, i) => ({ ...r.history[0], sequenceNumber: 100 - i })); r.proposal.sequenceNumber = 100; }],
      ["a proposal with an empty history", (r) => { r.history = []; }],
      ["a history without a proposal", (r) => { r.proposal = null; }],
      ["a proposal without a plan", (r) => { r.context = null; }],
      ["a history that is not a list", (r) => { r.history = {}; }],
    ];
    for (const [label, mutate] of reads) { const r = clone(good); mutate(r); expect(judge("schedValidRead", r) === null, label).toBe(true); }
    expect(judge("schedValidRead", { context: null, proposal: null, history: [] }) !== null, "no plan, no proposal, no history is a valid, empty read").toBe(true);
    page.close();
  });

  it("34b. the fixtures the page is shown are the server's own: each verifies, and the helper's digests are the real functions' (a known answer pins one)", () => {
    const record = makeRecord();
    expect(record.proposalDigest).toMatch(/^[0-9a-f]{64}$/);
    expect(createHash("sha256").update("x").digest("hex")).toHaveLength(64);
    expect(contextRecord().pitches).toHaveLength(4);
    expect([PITCH_A, PITCH_B, PITCH_C, PITCH_D].every((id) => UUID_ANY.test(id))).toBe(true);
    expect(TEAM_NAMES).toHaveLength(4);
  });
});
