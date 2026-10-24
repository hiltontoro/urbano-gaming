import { describe, expect, it } from "vitest";
import { JSDOM } from "jsdom";
import { readFileSync } from "node:fs";
import path from "node:path";
import {
  openAmendAdminPage, openAmendMemberPage, defer, never, SIGNED_IN, viewBody, statusBody, planningBody, proposal,
  CID, CODE, DIGEST_A, DIGEST_B, ADMIN_SOURCE, VIEW_URL, PLANNING_URL, AMENDMENT_URL, DECISION_URL, WITHDRAW_URL,
  CURRENT_FACTS, PROPOSED_FACTS, TEAM_NAMES,
  type AmendPage, type AmendReply, type AmendRequest, type Facts,
} from "./helpers/competitionPlanAmendmentPageHarness";

/**
 * UG-CR-GATE-SSS-014 — the post-freeze plan-amendment surfaces, run whole in jsdom as shipped:
 *   - the organizer section "Change venue or tournament dates" on /competitions-admin.html, and
 *   - the captain card "Tournament plan change" on the addressed competition page /competitions.html.
 *
 * EVIDENCE CLASS. Every test here gives the shipped page an AUTHENTICATION DOUBLE and a SERVER DOUBLE (the exact shapes the accepted routes return). It
 * proves what the page does with the answers it is given — never that the real backend gives them. The real backend is exercised separately, in a real
 * browser against the real local routes and a disposable loopback database.
 */

const ADMIN_HTML = readFileSync(path.join(process.cwd(), "public/competitions-admin.html"), "utf8");
const MEMBER_HTML = readFileSync(path.join(process.cwd(), "public/competitions.html"), "utf8");

type Reply = AmendReply | Promise<AmendReply>;
const ABSENT = Symbol("absent");
const SIGNED_OUT = { status: "unauthenticated" };
const ORGANIZER_SIGNAL = { organizer: true, captain: false };
const CAPTAIN_SIGNAL = { organizer: false, captain: true };
const UUID_ANY = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;
const HEX64 = /[0-9a-f]{64}/i;
const HOSTILE = '<img src=x onerror="window.__xss=(window.__xss||0)+1">';
const HOSTILE_BREAKOUT = '"><script>window.__xss=(window.__xss||0)+1</script>';

const BASELINE_ADMIN_READY_CONTROLS = [
  "select#comp-select", "button#btn-load-competition", "button#btn-open-cancel", "button[Copy Invitation Link]", "button[Copy Invitation Link]",
  "button[Copy Invitation Link]", "button[Copy Invitation Link]", "select#p-sf1a", "select#p-sf1b", "input#p-sf1-time", "select#p-sf2a", "select#p-sf2b",
  "input#p-sf2-time", "input#p-final-time", "button#btn-publish",
];

// ---------------------------------------------------------------------------------------------------------------------------------------------
// The organizer page
// ---------------------------------------------------------------------------------------------------------------------------------------------

interface AdminScenario {
  state?: string;
  signal?: unknown | typeof ABSENT;
  planning?: (req: AmendRequest) => Reply;
  status?: (req: AmendRequest) => Reply;
  post?: (req: AmendRequest) => Reply;
  entries?: unknown[];
  timeoutMs?: number;
}

function adminTransport(s: AdminScenario) {
  const entries = s.entries ?? [{ competitionId: CID, name: "Frozen Cup", state: s.state ?? "READY_TO_PUBLISH", access: "ORGANIZER" }];
  return (r: AmendRequest): Reply => {
    if (r.url === ADMIN_SOURCE) return { status: 200, json: { competitions: entries, operations: { createCompetition: false } } };
    if (r.url === VIEW_URL) return { status: 200, json: viewBody({ state: s.state, signal: s.signal === ABSENT ? undefined : (s.signal ?? ORGANIZER_SIGNAL) }) };
    if (r.url === PLANNING_URL && r.method === "GET") return (s.planning ?? (() => ({ status: 200, json: planningBody() })))(r);
    if (r.url === AMENDMENT_URL && r.method === "GET") return (s.status ?? (() => ({ status: 200, json: statusBody({ amendment: null }) })))(r);
    if ((r.url === AMENDMENT_URL || r.url === DECISION_URL || r.url === WITHDRAW_URL) && r.method === "POST") return (s.post ?? (() => ({ status: 500, json: { error: "unexpected write" } })))(r);
    if (r.url.endsWith("/admin-detail")) return { status: 200, json: { fixture: {}, teamARoster: null, teamBRoster: null, checkIns: [], attestations: [], evidence: null, goalEvents: [], assistEvents: [], shootout: null, disputes: [], finalization: null, eligibleMembers: [], displayNames: {} } };
    return { status: 404, json: { error: "unexpected request" } };
  };
}

async function admin(s: AdminScenario = {}): Promise<AmendPage> {
  const page = openAmendAdminPage({ auth: SIGNED_IN, transport: adminTransport(s) });
  if (s.timeoutMs !== undefined) page.run(`AMENDMENT_TIMEOUT_MS = ${s.timeoutMs}`);
  await page.settle(() => page.$$("#comp-select option").length > 0, "the competition list");
  return page;
}
async function loadCompetition(page: AmendPage, id: string = CID) {
  page.$("#comp-select").value = id;
  page.click(page.$("#btn-load-competition"));
  await page.settle(() => page.visible(page.$("#competition-detail")), "the competition detail");
}
async function openSection(page: AmendPage) {
  await loadCompetition(page);
  await page.settle(() => !!page.$("#plan-change-section"), "the plan-change section");
}
const amendRequests = (page: AmendPage) => page.requests.filter((r) => r.url.includes("/plan-amendment") || r.url.endsWith("/planning"));
const keyOf = (r: AmendRequest) => `${r.method} ${r.url}`;
const section = (page: AmendPage) => page.$("#plan-change-section");
const sectionControls = (page: AmendPage) =>
  [...(section(page)?.querySelectorAll("button, input:not([type=hidden]), select, textarea, a[href], summary") ?? [])].filter((el: Element) => page.visible(el));
const buttonByText = (root: ParentNode, text: string): HTMLButtonElement | null =>
  ([...root.querySelectorAll("button")] as HTMLButtonElement[]).find((b) => (b.textContent ?? "").trim() === text) ?? null;
const rowOf = (page: AmendPage, label: string): HTMLElement | null =>
  (page.$$("#plan-change-comparison tbody tr") as HTMLElement[]).find((tr) => (tr.querySelector("td")?.textContent ?? "").trim().startsWith(label)) ?? null;
const cell = (row: HTMLElement | null, label: string) => (row?.querySelector(`td[data-label="${label}"]`)?.textContent ?? "").trim();
const pending = (over: Parameters<typeof proposal>[0] = {}) => proposal({ decisions: ["CONFIRMED", "CONFIRMED", null, null], ...over });
/**
 * What the comparison table says about a resolved proposal. Once a change is APPROVED the server's current plan IS the proposal, so a column of "Unchanged"
 * rows would mislead: the table then shows only the plan now in force. Every other state still compares the plan in force with what was proposed.
 */
function expectComparisonShape(page: AmendPage, status: string) {
  const heads = (page.$$("#plan-change-comparison th") as HTMLElement[]).map((th) => (th.textContent ?? "").trim());
  const table = page.$("#plan-change-comparison");
  if (status === "ACTIVATED") {
    expect(heads).toEqual(["What", "Plan now in force"]);
    expect(table.textContent).not.toMatch(/Changed|Unchanged/);
    expect(table.querySelectorAll("tr[data-changed]")).toHaveLength(0);
    expect(table.querySelectorAll("td[data-label='Proposed'], td[data-label='Current']")).toHaveLength(0);
  } else {
    expect(heads).toEqual(["What", "Current", "Proposed"]);
    expect(table.querySelectorAll("tr[data-changed]").length).toBeGreaterThan(0);
  }
}

describe("organizer entry: the section exists only on exact server confirmation", () => {
  it("1. there is no amendment markup or control on first paint — in the shipped markup, once signed in, once the competitions are listed — and no amendment request is made", async () => {
    const shipped = new JSDOM(ADMIN_HTML).window.document;
    expect(shipped.querySelectorAll('[id*="plan-change"], [class*="plan-change"], [name*="plan-change"]')).toHaveLength(0);
    expect(ADMIN_HTML).not.toMatch(/id="plan-change/);
    const page = await admin({ status: () => ({ status: 200, json: statusBody({ amendment: pending() }) }) });
    expect(page.$$('[id*="plan-change"], [class*="plan-change"]')).toHaveLength(0);
    expect(amendRequests(page)).toEqual([]);
    expect(page.controls()).toEqual(["select#comp-select", "button#btn-load-competition"]);
    page.close();
  });

  it("2. there is no section for a scorekeeper-only caller, a captain-only signal, an unrelated caller, or a revoked organizer", async () => {
    // Scorekeeper-only: the contextual scorekeeper experience never builds an organizer view at all.
    const sk = openAmendAdminPage({
      auth: SIGNED_IN, search: `?c=${CODE}`,
      transport: (r) => r.url.startsWith("/api/gaming/competitions/resolve") ? { status: 200, json: { competitionId: CID } }
        : r.url === `/api/gaming/competitions/${CID}/scorekeeper-administration` ? { status: 200, json: { competition: { name: "Frozen Cup", state: "PUBLISHED" }, fixtures: [{ competitionFixtureId: "fx-1", state: "CHECKIN_OPEN", fixtureRole: "FINAL", scheduledAt: "2026-11-01T10:00:00Z", teamACompetitionTeamId: "t1", teamBCompetitionTeamId: "t2", scorekeeperGamingMemberId: "m-1" }], teams: [{ competitionTeamId: "t1", name: "A" }, { competitionTeamId: "t2", name: "B" }] } }
        : { status: 404, json: { error: "x" } },
    });
    await sk.settle(() => sk.text().includes("Frozen Cup"), "the scorekeeper view");
    await sk.idle();
    expect(sk.$('[id*="plan-change"]')).toBeNull();
    expect(amendRequests(sk)).toEqual([]);
    sk.close();
    // A captain-only signal, an unrelated caller (no signal), and a signal that is neither role: nothing is asked and nothing is built.
    for (const signal of [CAPTAIN_SIGNAL, { organizer: false, captain: false }, ABSENT] as const) {
      const page = await admin({ signal });
      await loadCompetition(page);
      await page.idle();
      expect(section(page), JSON.stringify(signal === ABSENT ? "absent" : signal)).toBeNull();
      expect(amendRequests(page)).toEqual([]);
      expect(page.controls()).toEqual(BASELINE_ADMIN_READY_CONTROLS);
      page.close();
    }
    // A revoked organizer: the view may still carry the signal from before, but the status read says there is no part for this caller (the uniform 404).
    const revoked = await admin({ status: () => ({ status: 404, json: { error: "A plan change was not found for this competition." } }) });
    await loadCompetition(revoked);
    await revoked.settle(() => amendRequests(revoked).length === 2, "both reads");
    await revoked.idle();
    expect(section(revoked)).toBeNull();
    expect(revoked.controls()).toEqual(BASELINE_ADMIN_READY_CONTROLS);
    revoked.close();
  });

  it("3. nothing is actionable — nothing exists — while either required read is pending; the section appears only when both have succeeded", async () => {
    const planning = defer<AmendReply>();
    const status = defer<AmendReply>();
    const page = await admin({ planning: () => planning.promise, status: () => status.promise });
    await loadCompetition(page);
    await page.settle(() => amendRequests(page).length === 2, "both reads to be issued");
    expect(section(page)).toBeNull();
    expect(page.$$('[id*="plan-change"]')).toHaveLength(0);
    status.resolve({ status: 200, json: statusBody({ amendment: null }) });
    await page.idle();
    expect(section(page), "one read done, one pending").toBeNull();
    planning.resolve({ status: 200, json: planningBody() });
    await page.settle(() => !!section(page), "the section");
    expect(page.$("#plan-change-heading").textContent).toBe("Change venue or tournament dates");
    page.close();
  });

  it.each([
    ["organizer is the string 'true'", { organizer: "true", captain: false }], ["organizer is 1", { organizer: 1, captain: false }], ["organizer is null", { organizer: null, captain: false }],
    ["the signal is the boolean true", true], ["the signal is a list", [true]], ["the signal is an empty object", {}], ["the signal is a string", "organizer"],
    ["organizer is false", { organizer: false, captain: false }], ["organizer is nested", { organizer: { value: true } }],
  ])("4a. a malformed or non-exact signal (%s) asks nothing and builds nothing", async (_label, signal) => {
    const page = await admin({ signal });
    await loadCompetition(page);
    await page.idle();
    expect(section(page)).toBeNull();
    expect(amendRequests(page)).toEqual([]);
    page.close();
  });

  it("4b. the exact signal still needs both reads to succeed with the organizer role and an open window, and the competition to be READY_TO_PUBLISH", async () => {
    const closedWindow = await admin({ status: () => ({ status: 200, json: statusBody({ windowOpen: false, amendment: null }) }) });
    await loadCompetition(closedWindow);
    await closedWindow.settle(() => amendRequests(closedWindow).length === 2, "both reads");
    await closedWindow.idle();
    expect(section(closedWindow), "window closed").toBeNull();
    closedWindow.close();

    const notOrganizer = await admin({ status: () => ({ status: 200, json: statusBody({ organizer: false, captain: true, amendment: pending({ myDecision: null }) }) }) });
    await loadCompetition(notOrganizer);
    await notOrganizer.settle(() => amendRequests(notOrganizer).length === 2, "both reads");
    await notOrganizer.idle();
    expect(section(notOrganizer), "the status read says this caller is not the organizer").toBeNull();
    notOrganizer.close();

    for (const state of ["DRAFT", "TEAM_REGISTRATION_OPEN", "PUBLISHED", "COMPLETE", "CANCELLED_WITHOUT_CHAMPION"]) {
      const other = await admin({ state });
      await loadCompetition(other);
      await other.idle();
      expect(section(other), state).toBeNull();
      expect(amendRequests(other).filter((r) => r.url.includes("/plan-amendment")), state).toEqual([]);
      other.close();
    }
    const ok = await admin();
    await openSection(ok);
    expect(amendRequests(ok).map(keyOf).sort()).toEqual([`GET ${AMENDMENT_URL}`, `GET ${PLANNING_URL}`]);
    ok.close();
  });
});

describe("organizer proposal form", () => {
  it("5. the form offers only the amendable controls, with the preserved time zone as read-only context", async () => {
    const page = await admin();
    await openSection(page);
    const form = page.$("#plan-change-form");
    expect(form).not.toBeNull();
    expect(page.$("#plan-change-venue-name").value).toBe(CURRENT_FACTS.venue.name);                     // prefilled from the current authoritative plan
    expect(page.$("#plan-change-venue-location").value).toBe(CURRENT_FACTS.venue.locationDescription);
    expect(page.$("#plan-change-venue-notes").value).toBe(CURRENT_FACTS.venue.restrictionNotes);
    expect(page.$("#plan-change-venue-capacity").value).toBe("2");
    expect(page.$$("#plan-change-pitches .plan-change-pitch-row")).toHaveLength(2);
    expect(page.$$(".plan-change-pitch-label").map((i: HTMLInputElement) => i.value)).toEqual(["A", "B"]);
    expect(page.$$(".plan-change-date-input").map((i: HTMLInputElement) => i.value)).toEqual(["2026-11-07"]);
    expect(page.$$(".plan-change-window-start").map((i: HTMLInputElement) => i.value)).toEqual(["09:00", "15:00"]);
    // The control inventory of the form: exactly the amendable facts and the buttons that edit their lists.
    const kinds = new Set([...form.querySelectorAll("button, input, select, textarea")].map((el: any) => (el.className || el.id || el.tagName).toString().split(" ").find((c: string) => c.startsWith("plan-change")) ?? el.tagName));
    expect([...kinds].sort()).toEqual([
      "plan-change-add-date", "plan-change-add-pitch", "plan-change-add-window", "plan-change-date-input", "plan-change-date-remove", "plan-change-pitch-format", "plan-change-pitch-label",
      "plan-change-pitch-notes", "plan-change-pitch-remove", "plan-change-pitch-usable", "plan-change-submit", "plan-change-venue-capacity", "plan-change-venue-location",
      "plan-change-venue-name", "plan-change-venue-notes", "plan-change-window-end", "plan-change-window-remove", "plan-change-window-start",
    ].sort());
    // Nothing preserved is a control: no format, roster, deadline, rules, team, captain, member or time-zone input.
    const blob = [...form.querySelectorAll("input, select, textarea")].map((el: any) => `${el.id} ${el.className} ${el.name} ${el.getAttribute("data-field")} ${el.getAttribute("aria-label")}`).join("\n");
    expect(blob).not.toMatch(/roster|deadline|rules|captain|member|timezone|time-zone|time zone|format-key|team/i);
    // The preserved time zone is context, not a control.
    expect(page.$("#plan-change-timezone").textContent).toContain("America/Costa_Rica");
    expect(["INPUT", "SELECT", "TEXTAREA"]).not.toContain(page.$("#plan-change-timezone").tagName);
    expect(page.text()).toContain("cannot be changed here");
    page.close();
  });

  it("6/7. submitting posts exactly { intentId, amendment } with only the three amendable sections, nothing preserved, uncached, with the edits on screen", async () => {
    const page = await admin({ post: () => ({ status: 201, json: { amendment: { digest: DIGEST_A, sequenceNumber: 1, createdAt: "2026-10-23T12:00:00.000Z", expiresAt: "2026-10-24T12:00:00.000Z", alreadyProposed: false, supersededDigest: null } } }) });
    await openSection(page);
    page.setValue(page.$("#plan-change-venue-name"), "Cancha Nueva");
    page.setValue(page.$("#plan-change-venue-capacity"), "1");
    page.click(page.$$(".plan-change-pitch-remove")[1]);                                                     // drop pitch B
    page.click(page.$("#plan-change-add-date"));
    page.setValue(page.$$(".plan-change-date-input")[1], "2026-11-08");
    page.setValue(page.$$(".plan-change-date-row")[1].querySelector(".plan-change-window-start"), "10:00");
    page.setValue(page.$$(".plan-change-date-row")[1].querySelector(".plan-change-window-end"), "14:00");
    page.click(page.$("#plan-change-submit"));
    await page.settle(() => page.requests.some((r) => r.method === "POST"), "the proposal request");
    const post = page.requests.find((r) => r.method === "POST")!;
    expect([post.method, post.url, post.cache, post.headers.authorization, post.hasSignal]).toEqual(["POST", AMENDMENT_URL, "no-store", "Bearer stub-token", true]);
    const body = post.json();
    expect(Object.keys(body).sort()).toEqual(["amendment", "intentId"]);
    expect(body.intentId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(Object.keys(body.amendment).sort()).toEqual(["dates", "pitches", "venue"]);
    expect(Object.keys(body.amendment.venue).sort()).toEqual(["locationDescription", "name", "restrictionNotes", "simultaneousMatchCapacity"]);
    expect(body.amendment).toEqual({
      venue: { name: "Cancha Nueva", locationDescription: "Calle 5, San José", restrictionNotes: "No metal cleats.", simultaneousMatchCapacity: 1 },
      pitches: [{ label: "A", usable: true, supportedFormats: ["SOCCER_5V5"], restrictionNotes: "" }],
      dates: [
        { date: "2026-11-07", windows: [{ start: "09:00", end: "13:00" }, { start: "15:00", end: "19:00" }] },
        { date: "2026-11-08", windows: [{ start: "10:00", end: "14:00" }] },
      ],
    });
    expect(post.body).not.toMatch(/timeZone|roster|registrationDeadline|rules|captain|member|team|format"|activity|digest|organizer/i);
    page.close();
  });

  it("6b. a pitch's support for other registry formats is kept exactly as the current plan has it, without being shown", async () => {
    const page = await admin({ post: () => ({ status: 500, json: { error: "stop" } }) });
    await openSection(page);
    page.click(page.$("#plan-change-submit"));
    await page.settle(() => page.requests.some((r) => r.method === "POST"), "the proposal request");
    expect(page.requests.find((r) => r.method === "POST")!.json().amendment.pitches[1].supportedFormats).toEqual(["SOCCER_5V5", "SOCCER_6V6"]);
    expect(page.text()).not.toMatch(/6v6|SOCCER_6V6/i);
    page.close();
  });

  it("7b. the save identifier is fresh for a new attempt, kept only for an identical retry whose outcome is unknown, and never carried to another proposal", async () => {
    let attempt = 0;
    const page = await admin({ timeoutMs: 40, post: () => (++attempt === 1 ? never() : { status: 400, json: { error: "The plan change is not valid.", problems: [{ field: "venue.name", code: "REQUIRED", message: "Enter the venue name." }] } }) });
    await openSection(page);
    page.click(page.$("#plan-change-submit"));
    await page.settle(() => page.requests.filter((r) => r.method === "POST").length === 1, "the first attempt");
    await page.settle(() => /did not answer in time/i.test(page.text()), "the timeout message");
    page.click(page.$("#plan-change-submit"));                                                              // an identical retry of an attempt whose outcome is unknown
    await page.settle(() => page.requests.filter((r) => r.method === "POST").length === 2, "the retry");
    const [first, second] = page.requests.filter((r) => r.method === "POST");
    expect(second.json().intentId).toBe(first.json().intentId);
    await page.settle(() => /Enter the venue name/.test(page.text()), "the validation problem");       // a definitive answer ends that attempt
    page.click(page.$("#plan-change-submit"));
    await page.settle(() => page.requests.filter((r) => r.method === "POST").length === 3, "the third attempt");
    expect(page.requests.filter((r) => r.method === "POST")[2].json().intentId).not.toBe(first.json().intentId);
    page.close();
  });

  it("8. a second click while the first submission is pending sends nothing, and the controls that would conflict are disabled", async () => {
    const answer = defer<AmendReply>();
    const page = await admin({ post: () => answer.promise });
    await openSection(page);
    page.click(page.$("#plan-change-submit"));
    page.click(page.$("#plan-change-submit"));
    page.click(page.$("#plan-change-submit"));
    await page.idle();
    expect(page.requests.filter((r) => r.method === "POST")).toHaveLength(1);
    expect(page.$("#plan-change-submit").disabled).toBe(true);
    answer.resolve({ status: 500, json: { error: "stop" } });
    await page.settle(() => page.$("#plan-change-submit") && !page.$("#plan-change-submit").disabled, "the button to be enabled again");
    page.close();
  });

  it("validation problems the server lists are shown as text and mark their fields; the section stays as it was", async () => {
    const page = await admin({ post: () => ({ status: 400, json: { error: "The plan change is not valid.", problems: [
      { field: "venue.name", code: "REQUIRED", message: "Enter the venue name." },
      { field: "dates[0].windows[1].start", code: "WINDOW_OVERLAP", message: HOSTILE },
    ] } }) });
    await openSection(page);
    page.setValue(page.$("#plan-change-venue-name"), "");
    page.click(page.$("#plan-change-submit"));
    await page.settle(() => page.$$("#plan-change-problems li").length === 2, "the problem list");
    expect(page.$$("#plan-change-problems li").map((li: HTMLElement) => li.textContent)).toEqual(["Enter the venue name.", HOSTILE]);
    expect(page.$("#plan-change-venue-name").getAttribute("aria-invalid")).toBe("true");
    expect(page.$$("#plan-change-problems img")).toHaveLength(0);
    expect((page.win as any).__xss).toBeUndefined();
    page.close();
  });
});

describe("organizer: a pending proposal, withdrawal, replacement and terminal states", () => {
  it("9. a pending proposal shows the current and the proposed plan, what changed, the expiry, the progress and the four teams' answers", async () => {
    const page = await admin({ status: () => ({ status: 200, json: statusBody({ amendment: pending({ decisions: ["CONFIRMED", "CONFIRMED", null, "REJECTED"].map((d, i) => (i === 3 ? null : d)) as any }) }) }) });
    await openSection(page);
    expect(page.$("#plan-change-state").textContent).toBe("Waiting for all four captains to confirm");
    expect(page.$("#plan-change-expiry").textContent).toBe("Expires 2026-10-24 12:00 UTC");
    expect(page.$("#plan-change-progress").textContent).toBe("2 of 4 captains have confirmed");
    expect(page.$$("#plan-change-teams li").map((li: HTMLElement) => li.textContent)).toEqual(["Alpha FC: Confirmed", "Bravo United: Confirmed", "Charlie Town: No answer yet", "Delta Rovers: No answer yet"]);
    const name = rowOf(page, "Venue name");
    expect([name?.dataset.changed, cell(name, "Current"), cell(name, "Proposed")]).toEqual(["true", "Cancha Central", "Cancha Nueva"]);
    expect(rowOf(page, "Venue restrictions")?.dataset.changed).toBe("false");
    expect(cell(rowOf(page, "Matches at the same time"), "Proposed")).toBe("1");
    expect(rowOf(page, "Pitch A")?.dataset.changed).toBe("false");
    const added = rowOf(page, "Pitch C");
    expect([added?.dataset.changed, cell(added, "Current"), cell(added, "Proposed")]).toEqual(["true", "Not in the current plan", "Not usable; suitable for Soccer 5v5; Under repair."]);
    expect([rowOf(page, "Pitch B")?.dataset.changed, cell(rowOf(page, "Pitch B"), "Proposed")]).toEqual(["true", "Removed"]);
    expect(cell(rowOf(page, "Date 2026-11-07"), "Current")).toBe("09:00–13:00, 15:00–19:00");
    expect(cell(rowOf(page, "Date 2026-11-07"), "Proposed")).toBe("Removed");
    expect([cell(rowOf(page, "Date 2026-11-08"), "Current"), cell(rowOf(page, "Date 2026-11-08"), "Proposed")]).toEqual(["Not in the current plan", "10:00–14:00"]);
    // The pending proposal offers exactly its two organizer actions; the proposal form is behind the replacement.
    expect(buttonByText(section(page), "Withdraw proposed change")).not.toBeNull();
    expect(buttonByText(section(page), "Replace with a revised proposal")).not.toBeNull();
    expect(page.$("#plan-change-form")).toBeNull();
    expect(sectionControls(page).map((el: any) => (el.textContent ?? "").trim())).toEqual(["Withdraw proposed change", "Replace with a revised proposal"]);
    expect(page.text()).not.toMatch(/Confirm plan change|Reject plan change/);
    page.close();
  });

  it("10. withdrawal posts exactly the digest of the proposal on screen, shows the truthful terminal state afterwards, and the digest is never displayed", async () => {
    let withdrawn = false;
    const page = await admin({
      status: () => ({ status: 200, json: statusBody({ amendment: withdrawn ? proposal({ status: "WITHDRAWN", actionable: false, resolvedAt: "2026-10-23T13:00:00.000Z" }) : pending() }) }),
      post: (r) => { if (r.url === WITHDRAW_URL) { withdrawn = true; return { status: 200, json: { status: "WITHDRAWN", alreadyWithdrawn: false } }; } return { status: 500, json: { error: "unexpected" } }; },
    });
    await openSection(page);
    expect(section(page).outerHTML).not.toMatch(HEX64);
    expect(section(page).textContent).not.toMatch(HEX64);
    page.click(buttonByText(section(page), "Withdraw proposed change"));
    await page.settle(() => page.requests.some((r) => r.url === WITHDRAW_URL), "the withdrawal");
    const post = page.requests.find((r) => r.url === WITHDRAW_URL)!;
    expect([post.method, post.cache, post.headers.authorization]).toEqual(["POST", "no-store", "Bearer stub-token"]);
    expect(post.json()).toEqual({ amendmentDigest: DIGEST_A });
    await page.settle(() => (section(page)?.textContent ?? "").includes("Withdrawn by the organizer"), "the terminal state");
    expect(buttonByText(section(page), "Withdraw proposed change")).toBeNull();
    expect(buttonByText(section(page), "Replace with a revised proposal")).toBeNull();
    // The state was read back from the server after the answer, not assumed.
    expect(page.requests.filter((r) => r.method === "GET" && r.url === AMENDMENT_URL).length).toBeGreaterThanOrEqual(2);
    page.close();
  });

  it("11. a replacement is a new proposal through the normal route with a new save identifier, started from the change on screen; confirmations are not carried", async () => {
    let posted = 0;
    const first = { intentId: "" };
    const page = await admin({
      status: () => ({ status: 200, json: statusBody({ amendment: posted === 0 ? pending() : proposal({ digest: DIGEST_B, sequenceNumber: 2, decisions: [null, null, null, null], proposed: { ...PROPOSED_FACTS, venue: { ...PROPOSED_FACTS.venue, name: "Cancha Revisada" } } }) }) }),
      post: (r) => { posted += 1; first.intentId = first.intentId || r.json().intentId; return { status: 201, json: { amendment: { digest: DIGEST_B, sequenceNumber: 2, createdAt: "2026-10-23T14:00:00.000Z", expiresAt: "2026-10-24T14:00:00.000Z", alreadyProposed: false, supersededDigest: DIGEST_A } } }; },
    });
    await openSection(page);
    expect(page.$("#plan-change-form")).toBeNull();
    page.click(buttonByText(section(page), "Replace with a revised proposal"));
    await page.settle(() => !!page.$("#plan-change-form"), "the revised proposal form");
    expect(page.$("#plan-change-venue-name").value).toBe("Cancha Nueva");                                  // it starts from the change currently proposed
    expect(page.text()).toMatch(/replaces the current proposal/i);
    expect(page.text()).toMatch(/captains who confirmed it will need to confirm the new proposal/i);
    page.setValue(page.$("#plan-change-venue-name"), "Cancha Revisada");
    page.click(buttonByText(page.$("#plan-change-form"), "Submit revised proposal"));
    await page.settle(() => page.requests.some((r) => r.method === "POST"), "the replacement request");
    const post = page.requests.find((r) => r.method === "POST")!;
    expect(post.url).toBe(AMENDMENT_URL);
    expect(post.json().amendment.venue.name).toBe("Cancha Revisada");
    await page.settle(() => (page.$("#plan-change-progress")?.textContent ?? "") === "0 of 4 captains have confirmed", "the new proposal's progress");
    expect(page.$$("#plan-change-teams li").every((li: HTMLElement) => /No answer yet$/.test(li.textContent ?? ""))).toBe(true);
    // Replacing again sends yet another identifier.
    page.click(buttonByText(section(page), "Replace with a revised proposal"));
    await page.settle(() => !!page.$("#plan-change-form"), "the form again");
    page.click(buttonByText(page.$("#plan-change-form"), "Submit revised proposal"));
    await page.settle(() => page.requests.filter((r) => r.method === "POST").length === 2, "the second replacement");
    expect(page.requests.filter((r) => r.method === "POST")[1].json().intentId).not.toBe(first.intentId);
    page.close();
  });

  it.each([
    ["ACTIVATED", "Approved by all four captains"], ["REJECTED", "Rejected by a captain"], ["WITHDRAWN", "Withdrawn by the organizer"],
    ["SUPERSEDED", "Replaced by a newer proposal"], ["EXPIRED", "Expired before all four captains confirmed"],
  ])("12. a %s proposal is shown truthfully with no confirm, reject, withdraw or replace control — and a new proposal is offered because the window is open", async (status, words) => {
    const page = await admin({ status: () => ({ status: 200, json: statusBody({ amendment: proposal({ status, actionable: false, decisions: ["CONFIRMED", "CONFIRMED", "CONFIRMED", status === "ACTIVATED" ? "CONFIRMED" : null], resolvedAt: "2026-10-23T13:00:00.000Z" }), history: [{ sequenceNumber: 1, status, createdAt: "2026-10-23T12:00:00.000Z", resolvedAt: "2026-10-23T13:00:00.000Z" }] }) }) });
    await openSection(page);
    expect(page.$("#plan-change-state").textContent).toContain(words);
    expectComparisonShape(page, status);
    for (const text of ["Withdraw proposed change", "Replace with a revised proposal", "Confirm plan change", "Reject plan change"]) expect(buttonByText(section(page), text), text).toBeNull();
    expect(page.$("#plan-change-form")).not.toBeNull();                                                     // windowOpen is true: a new proposal may be made
    expect(page.$$("#plan-change-history li")).toHaveLength(1);
    expect(page.$("#plan-change-history").textContent).not.toMatch(UUID_ANY);
    page.close();
  });

  it("12b. a proposal that became EXPIRED between two reads removes the controls it offered", async () => {
    let expired = false;
    const page = await admin({
      status: () => ({ status: 200, json: statusBody({ amendment: expired ? proposal({ status: "EXPIRED", actionable: false }) : pending() }) }),
      post: () => { expired = true; return { status: 409, json: { error: "This plan change has expired.", code: "EXPIRED" } }; },
    });
    await openSection(page);
    page.click(buttonByText(section(page), "Withdraw proposed change"));
    await page.settle(() => (section(page)?.textContent ?? "").includes("Expired before all four captains confirmed"), "the expired state");
    expect(buttonByText(section(page), "Withdraw proposed change")).toBeNull();
    expect(buttonByText(section(page), "Replace with a revised proposal")).toBeNull();
    expect(page.$("#plan-change-status").textContent).toContain("expired");
    page.close();
  });
});

describe("organizer: errors, timeouts, malformed answers and a changed context fail closed", () => {
  it.each([
    ["the planning read fails", { planning: () => ({ status: 500, json: { error: "x" } }) }],
    ["the planning read is not found", { planning: () => ({ status: 404, json: { error: "x" } }) }],
    ["the planning read carries no revision", { planning: () => ({ status: 200, json: { ...planningBody(), revision: null } }) }],
    ["the planning read is malformed", { planning: () => ({ status: 200, json: { context: {}, revision: {} } }) }],
    ["the status read fails", { status: () => ({ status: 500, json: { error: "x" } }) }],
    ["the status read has no body", { status: () => ({ status: 200 }) }],
    ["the status read is the wrong shape", { status: () => ({ status: 200, json: { amendment: "organizer" } }) }],
    ["a proposal with only three teams", { status: () => ({ status: 200, json: statusBody({ amendment: { ...pending(), teams: pending().teams.slice(0, 3) } }) }) }],
    ["a confirmed count that disagrees with the teams", { status: () => ({ status: 200, json: statusBody({ amendment: { ...pending(), confirmedCount: 4 } }) }) }],
    ["an unknown status", { status: () => ({ status: 200, json: statusBody({ amendment: { ...pending(), status: "APPROVED" } }) }) }],
    ["an actionable proposal in a closed window", { status: () => ({ status: 200, json: statusBody({ windowOpen: false, amendment: pending() }) }) }],
    ["an actionable terminal proposal", { status: () => ({ status: 200, json: statusBody({ amendment: proposal({ status: "REJECTED", actionable: true }) }) }) }],
    ["a pending proposal that is not actionable in an open window", { status: () => ({ status: 200, json: statusBody({ amendment: pending({ actionable: false }) }) }) }],
    ["a proposal whose current plan disagrees with the plan just read", { status: () => ({ status: 200, json: statusBody({ amendment: pending({ current: PROPOSED_FACTS }) }) }) }],
    ["a digest that is not a digest", { status: () => ({ status: 200, json: statusBody({ amendment: { ...pending(), digest: "not-a-digest" } }) }) }],
  ] as Array<[string, AdminScenario]>)("13a. %s: no section is built", async (_label, scenario) => {
    const page = await admin(scenario);
    await loadCompetition(page);
    await page.settle(() => amendRequests(page).length === 2, "both reads");
    await page.idle(60);
    expect(section(page)).toBeNull();
    expect(page.$$('[id*="plan-change"]')).toHaveLength(0);
    expect(page.controls()).toEqual(BASELINE_ADMIN_READY_CONTROLS);
    page.close();
  });

  it("13b. a read that never answers is a FAILED read: after the timeout nothing is built, and the request was aborted", async () => {
    const page = await admin({ timeoutMs: 40, status: () => never() });
    await loadCompetition(page);
    await page.settle(() => amendRequests(page).length === 2, "both reads");
    await page.idle(150);
    expect(section(page)).toBeNull();
    const statusRead = page.requests.find((r) => r.url === AMENDMENT_URL)!;
    expect([statusRead.hasSignal, statusRead.aborted(), statusRead.cache]).toEqual([true, true, "no-store"]);
    page.close();
  });

  it("13c. a malformed answer AFTER a good one closes the section; so does a failed or silent read after an action", async () => {
    let malformed = false;
    const page = await admin({
      status: () => (malformed ? { status: 200, json: { amendment: { role: {} } } } : { status: 200, json: statusBody({ amendment: pending() }) }),
      post: () => { malformed = true; return { status: 200, json: { status: "WITHDRAWN", alreadyWithdrawn: false } }; },
    });
    await openSection(page);
    page.click(buttonByText(section(page), "Withdraw proposed change"));
    await page.settle(() => !section(page), "the section to close");
    expect(page.$$('[id*="plan-change"]')).toHaveLength(0);
    page.close();
  });

  it("13d. a failed action keeps nothing stale: the refusal is shown, the server's state is re-read, and an action refused as not-found closes the section", async () => {
    let denied = false;
    const page = await admin({
      status: () => (denied ? { status: 404, json: { error: "A plan change was not found for this competition." } } : { status: 200, json: statusBody({ amendment: pending() }) }),
      post: () => { denied = true; return { status: 404, json: { error: "A plan change was not found for this competition." } }; },
    });
    await openSection(page);
    page.click(buttonByText(section(page), "Withdraw proposed change"));
    await page.settle(() => !section(page), "the section to close");
    page.close();
  });

  it("13e. changing the selection removes the section synchronously, a late answer for the old competition builds nothing, and its requests were aborted", async () => {
    const OTHER = "22222222-2222-4222-8222-222222222222";
    const planning = defer<AmendReply>();
    const page = await admin({
      entries: [{ competitionId: CID, name: "Frozen Cup", state: "READY_TO_PUBLISH", access: "ORGANIZER" }, { competitionId: OTHER, name: "Other Cup", state: "DRAFT", access: "ORGANIZER" }],
      planning: () => planning.promise,
    });
    await loadCompetition(page);
    await page.settle(() => amendRequests(page).length === 2, "both reads");
    page.setValue(page.$("#comp-select"), OTHER);                                                           // the selection changes while the reads are pending
    planning.resolve({ status: 200, json: planningBody() });
    await page.idle(80);
    expect(section(page)).toBeNull();
    // The read that was still outstanding was aborted (the one that had already answered has nothing left to abort).
    expect(page.requests.find((r) => r.url === PLANNING_URL)!.aborted()).toBe(true);
    page.close();

    // After a completed load, a selection change removes the section in the same turn.
    const loaded = await admin({ entries: [{ competitionId: CID, name: "Frozen Cup", state: "READY_TO_PUBLISH", access: "ORGANIZER" }, { competitionId: OTHER, name: "Other Cup", state: "DRAFT", access: "ORGANIZER" }] });
    await openSection(loaded);
    loaded.setValue(loaded.$("#comp-select"), OTHER);
    expect(section(loaded)).toBeNull();
    loaded.close();
  });

  it("13f. sign-out and an authorization change remove the section synchronously and invalidate outstanding answers; a re-read decides what returns", async () => {
    const page = await admin();
    await openSection(page);
    page.setAuth(SIGNED_OUT);
    void page.fireAuthChange();
    expect(section(page)).toBeNull();                                                                       // synchronously, before any answer
    await page.idle(60);
    expect(section(page)).toBeNull();
    page.close();

    // Authorization lost: the same signed-in session, but the server now says there is no part for this caller.
    let revoked = false;
    const second = await admin({ status: () => (revoked ? { status: 404, json: { error: "x" } } : { status: 200, json: statusBody({ amendment: null }) }) });
    await openSection(second);
    revoked = true;
    void second.fireAuthChange();
    expect(section(second)).toBeNull();
    await second.idle(120);
    expect(section(second)).toBeNull();
    second.close();

    // A late answer that was in flight when the session changed is ignored.
    const late = defer<AmendReply>();
    const third = await admin({ status: () => late.promise });
    await loadCompetition(third);
    await third.settle(() => amendRequests(third).length === 2, "both reads");
    third.setAuth(SIGNED_OUT);
    void third.fireAuthChange();
    late.resolve({ status: 200, json: statusBody({ amendment: null }) });
    await third.idle(80);
    expect(section(third)).toBeNull();
    third.close();
  });
});

describe("organizer: unsent edits and outcomes that are not known", () => {
  it("an authorization event removes the section at once; its unsent edits return only if the server confirms everything again for the same plan — any other change discards them", async () => {
    const page = await admin();
    await openSection(page);
    page.setValue(page.$("#plan-change-venue-name"), "Typed but unsent");
    page.setValue(page.$("#plan-change-venue-capacity"), "1");
    void page.fireAuthChange();
    expect(section(page)).toBeNull();
    await page.settle(() => !!section(page), "the section again");
    expect(page.$("#plan-change-venue-name").value).toBe("Typed but unsent");
    expect(page.$("#plan-change-venue-capacity").value).toBe("1");
    page.close();

    // The plan changed meanwhile: edits made against the old plan are not carried over.
    let current: Facts = CURRENT_FACTS;
    const changed = await admin({ planning: () => ({ status: 200, json: planningBody(current) }) });
    await openSection(changed);
    changed.setValue(changed.$("#plan-change-venue-name"), "Typed against the old plan");
    current = { ...CURRENT_FACTS, venue: { ...CURRENT_FACTS.venue, name: "Changed meanwhile" } };
    void changed.fireAuthChange();
    await changed.settle(() => !!section(changed), "the section again");
    expect(changed.$("#plan-change-venue-name").value).toBe("Changed meanwhile");
    changed.close();

    // Sign-out and another selection never keep them.
    const out = await admin();
    await openSection(out);
    out.setValue(out.$("#plan-change-venue-name"), "Secret draft");
    out.setAuth(SIGNED_OUT);
    void out.fireAuthChange();
    await out.idle(60);
    out.setAuth(SIGNED_IN);
    await out.fireAuthChange();
    await out.idle(60);
    await loadCompetition(out);
    await out.settle(() => !!section(out), "the section after a fresh load");
    expect(out.$("#plan-change-venue-name").value).toBe(CURRENT_FACTS.venue.name);
    out.close();
  });

  it("several authorization events in a row (a session refresh is often followed by another) keep the draft for the re-read that finally succeeds", async () => {
    const page = await admin();
    await openSection(page);
    page.setValue(page.$("#plan-change-venue-name"), "Typed through two events");
    void page.fireAuthChange();
    void page.fireAuthChange();
    expect(section(page)).toBeNull();
    await page.settle(() => !!section(page), "the section again");
    await page.idle(80);
    expect(page.$$("#plan-change-section")).toHaveLength(1);
    expect(page.$("#plan-change-venue-name").value).toBe("Typed through two events");
    page.close();
  });

  it("a replacement form being edited survives an authorization event the same way, and only for the same pending proposal", async () => {
    const page = await admin({ status: () => ({ status: 200, json: statusBody({ amendment: pending() }) }) });
    await openSection(page);
    page.click(buttonByText(section(page), "Replace with a revised proposal")!);
    await page.settle(() => !!page.$("#plan-change-form"), "the form");
    page.setValue(page.$("#plan-change-venue-name"), "Half-typed revision");
    void page.fireAuthChange();
    expect(section(page)).toBeNull();
    await page.settle(() => !!section(page), "the section again");
    expect(page.$("#plan-change-form")).not.toBeNull();
    expect(page.$("#plan-change-venue-name").value).toBe("Half-typed revision");
    page.close();
  });

  it("an answer that is lost is settled by asking the server: if the proposal was recorded the pending proposal replaces the form; if not, the form and its edits stay", async () => {
    let recorded = false;
    const page = await admin({ timeoutMs: 40, status: () => ({ status: 200, json: statusBody({ amendment: recorded ? pending({ decisions: [null, null, null, null] }) : null }) }), post: () => { recorded = true; return never(); } });
    await openSection(page);
    page.click(page.$("#plan-change-submit"));
    await page.settle(() => (page.$("#plan-change-state")?.textContent ?? "") === "Waiting for all four captains to confirm", "the pending proposal");
    expect(page.$("#plan-change-form")).toBeNull();                                                         // no stale form beside a proposal that exists
    expect(page.$("#plan-change-status").textContent).toMatch(/did not answer in time/i);
    page.close();

    const kept = await admin({ timeoutMs: 40, post: () => never() });
    await openSection(kept);
    kept.setValue(kept.$("#plan-change-venue-name"), "Kept edit");
    kept.click(kept.$("#plan-change-submit"));
    await kept.settle(() => /did not answer in time/i.test(section(kept)?.textContent ?? ""), "the timeout message");
    expect(kept.$("#plan-change-venue-name").value).toBe("Kept edit");
    expect(kept.$("#plan-change-submit").disabled).toBe(false);
    kept.close();
  });

  it("an unreadable 201 or 200 is settled the same way, and a server that cannot confirm anything afterwards closes the section", async () => {
    const unreadable = await admin({ post: () => ({ status: 201 }) });
    await openSection(unreadable);
    unreadable.click(unreadable.$("#plan-change-submit"));
    await unreadable.settle(() => /could not be understood/i.test(section(unreadable)?.textContent ?? ""), "the message");
    expect(unreadable.$("#plan-change-form")).not.toBeNull();
    unreadable.close();

    let broken = false;
    const closed = await admin({ status: () => (broken ? { status: 500, json: { error: "x" } } : { status: 200, json: statusBody({ amendment: null }) }), post: () => { broken = true; return { status: 201 }; } });
    await openSection(closed);
    closed.click(closed.$("#plan-change-submit"));
    await closed.settle(() => !section(closed), "the section to close");
    closed.close();
  });
});

// ---------------------------------------------------------------------------------------------------------------------------------------------
// The addressed competition page: the captain card
// ---------------------------------------------------------------------------------------------------------------------------------------------

interface MemberScenario {
  signal?: unknown | typeof ABSENT;
  status?: (req: AmendRequest) => Reply;
  post?: (req: AmendRequest) => Reply;
  search?: string;
  list?: (req: AmendRequest) => Reply;
  timeoutMs?: number;
  registered?: boolean;
}

function memberTransport(s: MemberScenario) {
  return (r: AmendRequest): Reply => {
    if (r.url.startsWith("/api/gaming/competitions/resolve")) return { status: 200, json: { competitionId: CID } };
    if (r.url === VIEW_URL) return { status: 200, json: viewBody({ signal: s.signal === ABSENT ? undefined : (s.signal ?? CAPTAIN_SIGNAL), extra: { isOrganizer: false } }) };
    if (r.url === AMENDMENT_URL && r.method === "GET") return (s.status ?? (() => ({ status: 200, json: statusBody({ organizer: false, captain: true, amendment: pending() }) })))(r);
    if (r.url === DECISION_URL && r.method === "POST") return (s.post ?? (() => ({ status: 500, json: { error: "unexpected write" } })))(r);
    if (r.url === "/api/gaming/competitions" && r.method === "GET") return (s.list ?? (() => ({ status: 200, json: { competitions: [] } })))(r);
    return { status: 404, json: { error: "unexpected request" } };
  };
}
async function member(s: MemberScenario = {}): Promise<AmendPage> {
  const page = openAmendMemberPage({ auth: SIGNED_IN, search: s.search ?? `?c=${CODE}`, transport: memberTransport(s) });
  if (s.timeoutMs !== undefined) page.run(`AMENDMENT_TIMEOUT_MS = ${s.timeoutMs}`);
  await page.settle(() => page.text().includes("Frozen Cup") || page.text().includes("Sign in with URBANO"), "the page");
  return page;
}
async function memberWithCard(s: MemberScenario = {}): Promise<AmendPage> {
  const page = await member(s);
  await page.settle(() => !!page.$("#plan-change-card"), "the captain card");
  return page;
}
const card = (page: AmendPage) => page.$("#plan-change-card");
const cardButtons = (page: AmendPage) => ([...(card(page)?.querySelectorAll("button") ?? [])] as HTMLButtonElement[]).filter((b) => page.visible(b)).map((b) => (b.textContent ?? "").trim());
const actionable = (over: Parameters<typeof proposal>[0] = {}) => statusBody({ organizer: false, captain: true, amendment: pending({ decisions: ["CONFIRMED", null, null, null], myDecision: null, ...over }) });
const memberAmendRequests = (page: AmendPage) => page.requests.filter((r) => r.url.includes("/plan-amendment"));

describe("captain entry: the card exists only in an addressed competition, on exact server confirmation", () => {
  it("14. there is no global or unaddressed entry: the list view, the shipped markup and the organizer page never offer captain confirmation", async () => {
    expect(new JSDOM(MEMBER_HTML).window.document.querySelectorAll('[id*="plan-change"], [class*="plan-change"]')).toHaveLength(0);
    expect(MEMBER_HTML).not.toMatch(/id="plan-change/);
    const listed = await member({ search: "", list: () => ({ status: 200, json: { competitions: [{ competitionId: CID, publicCode: CODE, name: "Frozen Cup", state: "READY_TO_PUBLISH" }] } }) });
    await listed.settle(() => listed.text().includes("Competitions"), "the competition list");
    await listed.idle();
    expect(listed.$('[id*="plan-change"]')).toBeNull();
    expect(memberAmendRequests(listed)).toEqual([]);
    listed.close();
    // The organizer page, for a person who is BOTH the organizer and a frozen captain, offers organizer management only.
    const both = await admin({ signal: { organizer: true, captain: true }, status: () => ({ status: 200, json: statusBody({ organizer: true, captain: true, amendment: pending() }) }) });
    await openSection(both);
    expect(buttonByText(both.doc.body, "Confirm plan change")).toBeNull();
    expect(buttonByText(both.doc.body, "Reject plan change")).toBeNull();
    expect(both.text()).not.toContain("Tournament plan change");
    both.close();
  });

  it("15a. the card needs the exact captain signal and a successful captain status with an amendment", async () => {
    const ok = await memberWithCard();
    expect(card(ok).querySelector("h2")!.textContent).toBe("Tournament plan change");
    expect(memberAmendRequests(ok).map(keyOf)).toEqual([`GET ${AMENDMENT_URL}`]);
    ok.close();
    for (const [label, scenario] of [
      ["no amendment exists", { status: () => ({ status: 200, json: statusBody({ organizer: false, captain: true, amendment: null }) }) }],
      ["the status says not a captain", { status: () => ({ status: 200, json: statusBody({ organizer: false, captain: false, amendment: pending() }) }) }],
      ["the status read is the uniform not-found", { status: () => ({ status: 404, json: { error: "x" } }) }],
      ["the status read fails", { status: () => ({ status: 500, json: { error: "x" } }) }],
    ] as Array<[string, MemberScenario]>) {
      const page = await member(scenario);
      await page.settle(() => memberAmendRequests(page).length === 1, label);
      await page.idle();
      expect(card(page), label).toBeNull();
      page.close();
    }
  });

  it.each([
    ["captain is the string 'true'", { organizer: false, captain: "true" }], ["captain is 1", { organizer: false, captain: 1 }], ["the signal is the boolean true", true],
    ["the signal is a list", [true]], ["the signal is absent", ABSENT], ["captain is false", { organizer: true, captain: false }], ["captain is nested", { captain: { value: true } }],
  ])("15b. a malformed or non-exact signal (%s) asks nothing and builds nothing", async (_label, signal) => {
    const page = await member({ signal: signal as never });
    await page.idle(60);
    expect(card(page)).toBeNull();
    expect(memberAmendRequests(page)).toEqual([]);
    page.close();
  });

  it("16. the captain card carries no organizer control, even if the status claims the organizer role", async () => {
    const page = await memberWithCard({ status: () => ({ status: 200, json: statusBody({ organizer: true, captain: true, amendment: pending({ myDecision: null }), history: [{ sequenceNumber: 1, status: "PENDING", createdAt: "x", resolvedAt: null }] }) }) });
    expect(page.$("#plan-change-form")).toBeNull();
    for (const text of ["Withdraw proposed change", "Replace with a revised proposal", "Propose this change", "Submit revised proposal"]) expect(buttonByText(page.doc.body, text), text).toBeNull();
    expect(page.$("#plan-change-history")).toBeNull();
    expect(page.text()).not.toContain("Change venue or tournament dates");
    page.close();
  });

  it("the card shows the caller's team, the current and the proposed plan, the expiry, the progress and the four teams — with the two actions", async () => {
    const page = await memberWithCard({ status: () => ({ status: 200, json: actionable() }) });
    expect(card(page).textContent).toContain("Your team: Alpha FC");
    expect(page.$("#plan-change-state").textContent).toBe("Waiting for all four captains to confirm");
    expect(page.$("#plan-change-expiry").textContent).toBe("Expires 2026-10-24 12:00 UTC");
    expect(page.$("#plan-change-progress").textContent).toBe("1 of 4 captains have confirmed");
    expect(page.$$("#plan-change-teams li").map((li: HTMLElement) => li.textContent)).toEqual(["Alpha FC: Confirmed", "Bravo United: No answer yet", "Charlie Town: No answer yet", "Delta Rovers: No answer yet"]);
    expect(cell(rowOf(page, "Venue name"), "Current")).toBe("Cancha Central");
    expect(cell(rowOf(page, "Venue name"), "Proposed")).toBe("Cancha Nueva");
    expect(rowOf(page, "Venue name")?.dataset.changed).toBe("true");
    expect(rowOf(page, "Pitch A")?.dataset.changed).toBe("false");
    expect(cardButtons(page)).toEqual(["Confirm plan change", "Reject plan change"]);
    page.close();
  });
});

describe("captain decisions", () => {
  it("17. confirming posts exactly the digest and CONFIRMED, uncached; the result is read back from the server and never inferred", async () => {
    let answered = false;
    const page = await memberWithCard({
      status: () => ({ status: 200, json: answered ? actionable({ decisions: ["CONFIRMED", "CONFIRMED", null, null], myDecision: "CONFIRMED" }) : actionable() }),
      // The decision answer even claims activation; the page must still show only what the server's own status then says.
      post: () => { answered = true; return { status: 200, json: { decision: "CONFIRMED", status: "ACTIVATED", confirmedCount: 4, requiredCount: 4, alreadyDecided: false, activatedRevisionNumber: 3 } }; },
    });
    expect(card(page).outerHTML).not.toMatch(HEX64);
    page.click(buttonByText(card(page), "Confirm plan change")!);
    await page.settle(() => page.requests.some((r) => r.url === DECISION_URL), "the decision request");
    const post = page.requests.find((r) => r.url === DECISION_URL)!;
    expect([post.method, post.cache, post.headers.authorization, post.hasSignal]).toEqual(["POST", "no-store", "Bearer stub-token", true]);
    expect(post.json()).toEqual({ amendmentDigest: DIGEST_A, decision: "CONFIRMED" });
    await page.settle(() => (page.$("#plan-change-my-decision")?.textContent ?? "").includes("You confirmed"), "the recorded decision");
    expect(page.$("#plan-change-state").textContent).toBe("Waiting for all four captains to confirm");       // not "approved": the status read says pending
    expect(cardButtons(page)).toEqual([]);
    expect(page.text()).not.toMatch(/Approved by all four captains/);
    expect(memberAmendRequests(page).filter((r) => r.method === "GET").length).toBeGreaterThanOrEqual(2);
    page.close();
  });

  it("18. rejecting needs an explicit final confirmation; nothing is sent until it is given, and declining sends nothing", async () => {
    let rejected = false;
    const page = await memberWithCard({
      status: () => ({ status: 200, json: rejected ? statusBody({ organizer: false, captain: true, amendment: proposal({ status: "REJECTED", actionable: false, decisions: ["CONFIRMED", "REJECTED", null, null], myDecision: "REJECTED" }) }) : actionable() }),
      post: () => { rejected = true; return { status: 200, json: { decision: "REJECTED", status: "REJECTED", confirmedCount: 1, requiredCount: 4, alreadyDecided: false, activatedRevisionNumber: null } }; },
    });
    page.click(buttonByText(card(page), "Reject plan change")!);
    await page.settle(() => !!page.$("#plan-change-reject-panel") && page.visible(page.$("#plan-change-reject-panel")), "the confirmation panel");
    await page.idle();
    expect(page.requests.filter((r) => r.method === "POST")).toEqual([]);
    expect(page.$("#plan-change-reject-panel").textContent).toMatch(/ends this proposed change/i);
    expect(page.$("#plan-change-reject-panel").textContent).toMatch(/cannot be undone/i);
    expect(page.doc.activeElement).toBe(buttonByText(page.$("#plan-change-reject-panel"), "Keep deciding"));  // the safe choice has the focus
    // Declining sends nothing and restores the two actions.
    page.click(buttonByText(page.$("#plan-change-reject-panel"), "Keep deciding")!);
    expect(page.requests.filter((r) => r.method === "POST")).toEqual([]);
    expect(cardButtons(page)).toEqual(["Confirm plan change", "Reject plan change"]);
    // Escape dismisses it too, and returns the focus to the button that opened it.
    page.click(buttonByText(card(page), "Reject plan change")!);
    await page.settle(() => page.visible(page.$("#plan-change-reject-panel")), "the panel again");
    page.$("#plan-change-reject-panel").dispatchEvent(new page.win.KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    expect(page.visible(page.$("#plan-change-reject-panel"))).toBe(false);
    expect(page.doc.activeElement).toBe(buttonByText(card(page), "Reject plan change"));
    // The final confirmation sends exactly the digest and REJECTED.
    page.click(buttonByText(card(page), "Reject plan change")!);
    await page.settle(() => page.visible(page.$("#plan-change-reject-panel")), "the panel a third time");
    page.click(buttonByText(page.$("#plan-change-reject-panel"), "Yes, reject the plan change")!);
    await page.settle(() => page.requests.some((r) => r.url === DECISION_URL), "the rejection request");
    expect(page.requests.filter((r) => r.method === "POST")).toHaveLength(1);
    expect(page.requests.find((r) => r.url === DECISION_URL)!.json()).toEqual({ amendmentDigest: DIGEST_A, decision: "REJECTED" });
    await page.settle(() => (page.$("#plan-change-state")?.textContent ?? "").startsWith("Rejected by a captain"), "the rejected state");
    expect(cardButtons(page)).toEqual([]);
    page.close();
  });

  it("a second click on either action while a decision is pending sends nothing more", async () => {
    const answer = defer<AmendReply>();
    const page = await memberWithCard({ status: () => ({ status: 200, json: actionable() }), post: () => answer.promise });
    const confirm = buttonByText(card(page), "Confirm plan change")!;
    page.click(confirm);
    page.click(confirm);
    page.click(buttonByText(card(page), "Reject plan change")!);
    await page.idle();
    expect(page.requests.filter((r) => r.method === "POST")).toHaveLength(1);
    expect(cardButtons(page).length).toBe(2);
    expect(([...card(page).querySelectorAll("button")] as HTMLButtonElement[]).every((b) => b.disabled)).toBe(true);
    answer.resolve({ status: 500, json: { error: "stop" } });
    page.close();
  });

  it.each([["CONFIRMED", "You confirmed this plan change."], ["REJECTED", "You rejected this plan change."]])("19. a recorded %s decision removes both controls and says what was recorded", async (decision, words) => {
    const page = await memberWithCard({ status: () => ({ status: 200, json: actionable({ decisions: [decision === "CONFIRMED" ? "CONFIRMED" : "REJECTED", null, null, null] as never, myDecision: decision as never, status: decision === "REJECTED" ? "REJECTED" : "PENDING", actionable: decision !== "REJECTED" }) }) });
    expect(page.$("#plan-change-my-decision").textContent).toBe(words);
    expect(cardButtons(page)).toEqual([]);
    expect(page.$("#plan-change-reject-panel")).toBeNull();
    page.close();
  });

  it("20. a closed window, a non-actionable proposal or a revoked authority shows history only: no control, no panel, no way to act", async () => {
    for (const [label, body] of [
      ["window closed and not actionable (organizer's authority revoked)", statusBody({ organizer: false, captain: true, windowOpen: false, amendment: pending({ actionable: false, myDecision: null }) })],
      ["open window but not actionable", statusBody({ organizer: false, captain: true, windowOpen: true, amendment: pending({ actionable: false, myDecision: null }) })],
    ] as const) {
      // 'open window but not actionable' for a pending proposal is contradictory for the organizer's page, but the captain card simply offers nothing.
      const page = await member({ status: () => ({ status: 200, json: body }) });
      if (label.startsWith("window closed")) {
        await page.settle(() => !!card(page), label);
        expect(cardButtons(page), label).toEqual([]);
        expect(card(page).textContent).toContain("Waiting for all four captains to confirm");               // the historical information remains
        expect(card(page).textContent).toMatch(/can no longer be (confirmed|changed)|no longer be acted on|no action/i);
      } else {
        await page.idle(80);
        if (card(page)) expect(cardButtons(page), label).toEqual([]);
      }
      page.close();
    }
    // The contradiction — an actionable proposal in a closed window — is not rendered at all.
    const contradictory = await member({ status: () => ({ status: 200, json: statusBody({ organizer: false, captain: true, windowOpen: false, amendment: pending({ actionable: true }) }) }) });
    await contradictory.settle(() => memberAmendRequests(contradictory).length === 1, "the read");
    await contradictory.idle(60);
    expect(card(contradictory)).toBeNull();
    contradictory.close();
  });

  it.each([
    ["ACTIVATED", "Approved by all four captains"], ["REJECTED", "Rejected by a captain"], ["WITHDRAWN", "Withdrawn by the organizer"],
    ["SUPERSEDED", "Replaced by a newer proposal"], ["EXPIRED", "Expired before all four captains confirmed"],
  ])("21. a %s proposal is shown truthfully with no control", async (status, words) => {
    const page = await memberWithCard({ status: () => ({ status: 200, json: statusBody({ organizer: false, captain: true, amendment: proposal({ status, actionable: false, decisions: ["CONFIRMED", null, null, null], myDecision: null }) }) }) });
    expect(page.$("#plan-change-state").textContent).toContain(words);
    expectComparisonShape(page, status);
    expect(cardButtons(page)).toEqual([]);
    page.close();
  });

  it("22a. a failed decision shows the refusal, re-reads the server's state, and leaves no stale control behind", async () => {
    let expired = false;
    const page = await memberWithCard({
      status: () => ({ status: 200, json: expired ? statusBody({ organizer: false, captain: true, amendment: proposal({ status: "EXPIRED", actionable: false, decisions: ["CONFIRMED", null, null, null] }) }) : actionable() }),
      post: () => { expired = true; return { status: 409, json: { error: "This plan change has expired.", code: "EXPIRED" } }; },
    });
    page.click(buttonByText(card(page), "Confirm plan change")!);
    await page.settle(() => (page.$("#plan-change-state")?.textContent ?? "").startsWith("Expired"), "the expired state");
    expect(cardButtons(page)).toEqual([]);
    expect(page.$("#plan-change-status").textContent).toContain("expired");
    page.close();
  });

  it("22b. a decision that never answers is reported as unconfirmed, the state is re-read, and the request was aborted", async () => {
    let reads = 0;
    const page = await memberWithCard({
      timeoutMs: 50,
      status: () => { reads += 1; return { status: 200, json: actionable() }; },
      post: () => never(),
    });
    page.click(buttonByText(card(page), "Confirm plan change")!);
    await page.settle(() => /did not answer in time/i.test(card(page)?.textContent ?? ""), "the timeout message");
    expect(page.requests.find((r) => r.url === DECISION_URL)!.aborted()).toBe(true);
    await page.settle(() => reads >= 2, "the re-read");
    expect(cardButtons(page)).toEqual(["Confirm plan change", "Reject plan change"]);                            // the server says nothing was recorded, so the actions return
    page.close();
  });

  it("22c. an unreadable decision answer or an unreadable re-read closes the card", async () => {
    let calls = 0;
    const page = await memberWithCard({
      status: () => { calls += 1; return calls === 1 ? { status: 200, json: actionable() } : { status: 200, json: { amendment: { role: { captain: true } } } }; },
      post: () => ({ status: 200 }),
    });
    page.click(buttonByText(card(page), "Confirm plan change")!);
    await page.settle(() => !card(page), "the card to close");
    expect(page.$$('[id*="plan-change"]')).toHaveLength(0);
    page.close();
  });

  it("22d. a status that never answers builds no card, and the request is aborted", async () => {
    const page = await member({ timeoutMs: 40, status: () => never() });
    await page.settle(() => memberAmendRequests(page).length === 1, "the read");
    await page.idle(150);
    expect(card(page)).toBeNull();
    const read = memberAmendRequests(page)[0];
    expect([read.hasSignal, read.aborted(), read.cache]).toEqual([true, true, "no-store"]);
    page.close();
  });

  it("22e. a late answer from an older render or a signed-out session builds nothing, and navigating away removes the card at once", async () => {
    const late = defer<AmendReply>();
    const page = await member({ status: () => late.promise, list: () => ({ status: 200, json: { competitions: [] } }) });
    await page.settle(() => memberAmendRequests(page).length === 1, "the read");
    page.click(page.$("#back-to-list"));                                                                    // the page context changes while the read is pending
    late.resolve({ status: 200, json: actionable() });
    await page.idle(100);
    expect(card(page)).toBeNull();
    page.close();

    const signedOut = defer<AmendReply>();
    const second = await member({ status: () => signedOut.promise });
    await second.settle(() => memberAmendRequests(second).length === 1, "the read");
    second.setAuth(SIGNED_OUT);
    void second.fireAuthChange();
    signedOut.resolve({ status: 200, json: actionable() });
    await second.idle(100);
    expect(card(second)).toBeNull();
    second.close();

    // With the card on screen, any new render removes it in the same turn (before the next answers).
    const third = await memberWithCard({ status: () => ({ status: 200, json: actionable() }), list: () => ({ status: 200, json: { competitions: [] } }) });
    third.click(third.$("#back-to-list"));
    expect(card(third)).toBeNull();
    third.close();
  });
});

// ---------------------------------------------------------------------------------------------------------------------------------------------
// Shared properties
// ---------------------------------------------------------------------------------------------------------------------------------------------

describe("hostile text, privacy, authority and unchanged pages", () => {
  const hostileFacts: Facts = {
    venue: { name: HOSTILE, locationDescription: HOSTILE_BREAKOUT, restrictionNotes: '<b onmouseover="window.__xss=1">x</b>', simultaneousMatchCapacity: 1 },
    pitches: [{ label: HOSTILE, usable: true, supportedFormats: ["SOCCER_5V5"], restrictionNotes: HOSTILE_BREAKOUT }],
    dates: [{ date: "2026-11-08", windows: [{ start: "10:00", end: "14:00" }] }],
  };
  const hostileCurrent: Facts = { ...CURRENT_FACTS, venue: { ...CURRENT_FACTS.venue, name: HOSTILE } };
  const hostileStatus = (organizer: boolean) => {
    const base = proposal({ proposed: hostileFacts, current: organizer ? hostileCurrent : CURRENT_FACTS, decisions: ["CONFIRMED", null, null, null] });
    return statusBody({ organizer, captain: !organizer, myTeamName: HOSTILE, amendment: { ...base, teams: [HOSTILE, HOSTILE_BREAKOUT, "<svg onload=window.__xss=1>", "Delta"].map((teamName, i) => ({ teamName, decision: i === 0 ? "CONFIRMED" : null })) } as never,
      history: organizer ? [{ sequenceNumber: 1, status: "PENDING", createdAt: "2026-10-23T12:00:00.000Z", resolvedAt: null }] : null });
  };
  const inert = (page: AmendPage, root: Element) => {
    expect(root.querySelector("script")).toBeNull();
    for (const el of [root, ...root.querySelectorAll("*")]) for (const attr of Array.from(el.attributes)) expect(attr.name.toLowerCase().startsWith("on")).toBe(false);
    expect(root.querySelectorAll("img, svg, b")).toHaveLength(0);
    expect((page.win as any).__xss).toBeUndefined();
  };

  it("23a. hostile venue, pitch and team text is inert on the organizer page: shown literally, never parsed", async () => {
    const page = await admin({ status: () => ({ status: 200, json: hostileStatus(true) }), planning: () => ({ status: 200, json: planningBody(hostileCurrent) }), post: () => ({ status: 400, json: { error: HOSTILE, problems: [{ field: "venue.name", code: "X", message: HOSTILE_BREAKOUT }] } }) });
    await openSection(page);
    expect(section(page).textContent).toContain(HOSTILE);                                                  // present literally as text
    expect(section(page).textContent).toContain("<svg onload=window.__xss=1>");
    page.click(buttonByText(section(page), "Replace with a revised proposal")!);
    await page.settle(() => !!page.$("#plan-change-form"), "the form");
    expect(page.$("#plan-change-venue-name").value).toBe(HOSTILE);                                         // a value, not markup
    page.click(page.$("#plan-change-submit"));
    await page.settle(() => page.$$("#plan-change-problems li").length === 1, "the problems");
    inert(page, section(page));
    page.close();
  });

  it("23b. hostile venue, pitch and team text is inert on the captain card, including the caller's own team name", async () => {
    const page = await memberWithCard({ status: () => ({ status: 200, json: hostileStatus(false) }), post: () => ({ status: 409, json: { error: HOSTILE, code: "STALE" } }) });
    expect(card(page).textContent).toContain(`Your team: ${HOSTILE}`);
    expect(card(page).textContent).toContain(HOSTILE_BREAKOUT);
    page.click(buttonByText(card(page), "Confirm plan change")!);
    await page.settle(() => (page.$("#plan-change-status")?.textContent ?? "").includes(HOSTILE), "the refusal");
    inert(page, card(page));
    page.close();
  });

  it("24. no internal identifier, digest, role flag or authority datum is rendered on either surface", async () => {
    const adminPage = await admin({ status: () => ({ status: 200, json: statusBody({ amendment: pending(), history: [{ sequenceNumber: 3, status: "REJECTED", createdAt: "2026-10-23T12:00:00.000Z", resolvedAt: "2026-10-23T13:00:00.000Z" }] }) }) });
    await openSection(adminPage);
    const memberPage = await memberWithCard({ status: () => ({ status: 200, json: actionable() }) });
    for (const root of [section(adminPage), card(memberPage)] as Element[]) {
      const html = root.outerHTML;
      expect(html).not.toMatch(UUID_ANY);
      expect(html).not.toMatch(HEX64);
      expect(html).not.toMatch(/organizer["':= ]+true|captain["':= ]+true|gamingMemberId|competitionTeamId|planning_revision|amendment_digest|amendmentDigest|digest/i);
      expect([...root.querySelectorAll("*")].flatMap((el) => Array.from(el.attributes).map((a) => `${a.name}=${a.value}`)).join(" ")).not.toMatch(new RegExp(`${DIGEST_A}|${CID}`));
    }
    adminPage.close();
    memberPage.close();
  });

  it("25. neither surface uses the general discovery list as authority: the amendment is reached only from the addressed competition, by its own routes", async () => {
    const adminPage = await admin();
    await openSection(adminPage);
    expect(adminPage.requests.some((r) => r.url === "/api/gaming/competitions")).toBe(false);
    expect(amendRequests(adminPage).every((r) => r.url.startsWith(`/api/gaming/competitions/${CID}/`))).toBe(true);
    adminPage.close();
    // The discovery list failing or being empty changes nothing for a captain who reached the competition by its code.
    const memberPage = await memberWithCard({ list: () => ({ status: 500, json: { error: "list down" } }) });
    expect(memberPage.requests.some((r) => r.url === "/api/gaming/competitions")).toBe(false);
    expect(memberAmendRequests(memberPage).every((r) => r.url.startsWith(`/api/gaming/competitions/${CID}/`))).toBe(true);
    memberPage.close();
    // The page source does not read amendment authority from the list or from a stored value.
    for (const html of [ADMIN_HTML, MEMBER_HTML]) {
      const code = html.slice(html.indexOf("plan-change") - 400);
      expect(code).not.toMatch(/localStorage|sessionStorage|document\.cookie/);
    }
  });

  it("26. the existing pages are unchanged where this feature is not confirmed: the same controls, the same words", async () => {
    const adminPage = await admin({ signal: ABSENT });
    await loadCompetition(adminPage);
    await adminPage.idle(60);
    expect(adminPage.controls()).toEqual(BASELINE_ADMIN_READY_CONTROLS);
    expect(adminPage.requests.map(keyOf)).toEqual(["GET /api/gaming/competitions/administration", `GET ${VIEW_URL}`]);
    adminPage.close();
    const memberPage = await member({ signal: ABSENT });
    await memberPage.idle(60);
    expect(memberPage.controls()).toEqual([]);
    expect(memberPage.doc.getElementById("content")!.textContent!.replace(/\s+/g, " ").trim()).toBe("← All competitions Frozen Cup Finalizing bracket RegistrationRegistration is closed for this competition.");
    expect(memberPage.requests.map(keyOf)).toEqual([`GET /api/gaming/competitions/resolve?c=${CODE}`, `GET ${VIEW_URL}`]);
    memberPage.close();
  });
});

describe("keyboard, focus and the 375 px layout", () => {
  it("27a. every control is native and in document order (no positive tabindex, no trap), and finishing an action returns the focus to the section's heading", async () => {
    const page = await admin({ post: () => ({ status: 201, json: { amendment: { digest: DIGEST_A, sequenceNumber: 1, createdAt: "2026-10-23T12:00:00.000Z", expiresAt: "2026-10-24T12:00:00.000Z", alreadyProposed: false, supersededDigest: null } } }),
      status: (() => { let n = 0; return () => ({ status: 200, json: statusBody({ amendment: ++n > 1 ? pending() : null }) }); })() });
    await openSection(page);
    for (const el of sectionControls(page) as HTMLElement[]) {
      expect(["BUTTON", "INPUT", "SELECT", "TEXTAREA", "SUMMARY", "A"]).toContain(el.tagName);
      expect(el.tabIndex, el.outerHTML.slice(0, 80)).toBeGreaterThanOrEqual(0);
      expect(el.getAttribute("tabindex") === null || Number(el.getAttribute("tabindex")) <= 0).toBe(true);
    }
    expect(section(page).getAttribute("role")).toBe("region");
    expect(section(page).getAttribute("aria-labelledby")).toBe("plan-change-heading");
    expect(page.$("#plan-change-status").getAttribute("aria-live")).toBe("polite");
    // Labels: every text control has a visible or accessible name.
    for (const el of page.$$("#plan-change-form input:not([type=checkbox]), #plan-change-form textarea")) expect((el.labels?.length ?? 0) > 0 || !!el.getAttribute("aria-label"), el.outerHTML.slice(0, 80)).toBe(true);
    page.click(page.$("#plan-change-submit"));
    await page.settle(() => !!page.$("#plan-change-state"), "the pending state");
    expect(page.doc.activeElement).toBe(page.$("#plan-change-heading"));
    expect(page.$("#plan-change-heading").tabIndex).toBe(-1);
    page.close();
  });

  it("27b. the captain card is keyboard-complete too: native buttons in order, a labelled region, and the heading takes the focus after a decision", async () => {
    let done = false;
    const page = await memberWithCard({ status: () => ({ status: 200, json: done ? actionable({ decisions: ["CONFIRMED", "CONFIRMED", null, null], myDecision: "CONFIRMED" }) : actionable() }), post: () => { done = true; return { status: 200, json: { decision: "CONFIRMED", status: "PENDING", confirmedCount: 2, requiredCount: 4, alreadyDecided: false, activatedRevisionNumber: null } }; } });
    expect(card(page).getAttribute("role")).toBe("region");
    expect(card(page).getAttribute("aria-labelledby")).toBe("plan-change-heading");
    expect(([...card(page).querySelectorAll("button")] as HTMLButtonElement[]).filter((b) => page.visible(b)).map((b) => [b.textContent, b.tabIndex])).toEqual([["Confirm plan change", 0], ["Reject plan change", 0]]);
    page.click(buttonByText(card(page), "Confirm plan change")!);
    await page.settle(() => (page.$("#plan-change-my-decision")?.textContent ?? "").includes("You confirmed"), "the recorded decision");
    expect(page.doc.activeElement).toBe(page.$("#plan-change-heading"));
    page.close();
  });

  it("28. the stylesheet reflows the comparison, wraps long text and keeps 44 px targets at phone width (375 px), on both pages", () => {
    for (const [label, html] of [["competitions-admin.html", ADMIN_HTML], ["competitions.html", MEMBER_HTML]] as const) {
      const css = html.slice(html.indexOf("<style>"), html.indexOf("</style>"));
      const phone = [...css.matchAll(/@media\s*\(max-width:\s*(\d+)px\)\s*\{([\s\S]*?)\n  \}/g)].filter((m) => Number(m[1]) >= 640 && /plan-change/.test(m[2]));
      expect(phone.length, `${label} has a phone-width block for the plan-change surfaces`).toBeGreaterThan(0);
      const block = phone.map((m) => m[2]).join("\n");
      expect(block, `${label}: the comparison table becomes stacked cards`).toMatch(/plan-change-table[^{]*\{\s*[^}]*display:\s*block/);
      expect(block, `${label}: buttons keep a 44px target`).toMatch(/plan-change[^{]*button[^{]*\{[^}]*min-height:\s*44px/);
      expect(css, `${label}: long text wraps`).toMatch(/plan-change[^{]*\{[^}]*overflow-wrap:\s*(anywhere|break-word)/);
      expect(css, `${label}: nothing forces the section wider than the screen`).not.toMatch(/plan-change[^{]*\{[^}]*(min-width:\s*(?!0)\d{3,}px|width:\s*\d{4,}px)/);
    }
  });
});
