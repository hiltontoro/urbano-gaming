import { describe, expect, it } from "vitest";
import {
  API, CID, CODE, ENTRY_A, ENTRY_B, HOSTILE, HOSTILE_BREAKOUT, ORG, PAT, adminBase, competitionView, defer, newWorld, openAdminPage, organizerEntry, signedIn, transportOf,
  type EntriesPage, type EntriesRequest, type World,
} from "./helpers/competitionEntriesPageHarness";

/**
 * UG-CR-GATE-CFM-016 — the invite-only pilot's ORGANIZER surface (public/competitionsEntries.js, mounted by /competitions-admin.html): switch a competition's team entries on or
 * off, review its entries, approve, reject or remove them, and freeze the entries.
 *
 * EVIDENCE CLASS. Every test gives the SHIPPED page and the SHIPPED script an AUTHENTICATION DOUBLE and a SERVER DOUBLE (the exact shapes the accepted routes return). It proves what
 * the browser code builds, sends, says and forgets for the answers it is given — never that the real backend gives them. The real backend is exercised separately, in a real
 * browser against the real local routes and a disposable loopback database.
 */

const SECTION = "#entries-organizer";
const ENTRIES_READ = new RegExp(`/${CID}/lifetime-entries$`);
const PLAYERS = "Players who accepted their place";

async function openCompetition(page: EntriesPage) {
  await page.settle(() => page.$$("#comp-select option").length > 0, "the competition list");
  page.$("#comp-select").value = CID;
  page.click(page.$("#btn-load-competition"));
  await page.settle(() => page.visible(page.$("#competition-detail")), "the competition detail");
}
async function organizer(world: World, options: { auth?: unknown; token?: string; state?: string; v1Teams?: boolean } = {}): Promise<EntriesPage> {
  world.base = adminBase({ view: competitionView({ state: options.state ?? "TEAM_REGISTRATION_OPEN", organizer: true, v1Teams: options.v1Teams }) });
  const page = openAdminPage({ auth: options.auth ?? signedIn(ORG, "Olivia"), token: options.token, transport: transportOf(world) });
  await openCompetition(page);
  await page.settle(() => !!page.$(SECTION), "the team entries section");
  return page;
}
const sectionOf = (page: EntriesPage) => page.$(SECTION) as HTMLElement | null;
const said = (page: EntriesPage) => (sectionOf(page)?.textContent ?? "").replace(/\s+/g, " ").trim();
const button = (page: EntriesPage, text: string): HTMLButtonElement | null =>
  (page.$$(`${SECTION} button`) as HTMLButtonElement[]).find((b) => (b.textContent ?? "").trim() === text) ?? null;
const writesOf = (page: EntriesPage): EntriesRequest[] => page.requests.filter((r) => r.method !== "GET" && r.url.includes("lifetime-"));
const readsOfEntries = (page: EntriesPage) => page.requests.filter((r) => r.method === "GET" && ENTRIES_READ.test(r.url)).length;
const status = (page: EntriesPage) => page.$(`${SECTION} .ce-status`) as HTMLElement;
const idle = (page: EntriesPage) => page.settle(() => { const s = sectionOf(page); return !s || !s.hasAttribute("aria-busy"); }, "the section to be idle");
async function press(page: EntriesPage, el: HTMLElement | null) {
  expect(el, "the control exists").not.toBeNull();
  page.click(el);
  await idle(page);
}
const rows = (page: EntriesPage) => page.$$(`${SECTION} .ce-organizer-entry`) as HTMLElement[];
const rowOf = (page: EntriesPage, name: string) => rows(page).find((r) => r.querySelector(".ce-entry-name")!.textContent === name)!;
const inRow = (row: HTMLElement, text: string): HTMLButtonElement | null => ([...row.querySelectorAll("button")] as HTMLButtonElement[]).find((b) => (b.textContent ?? "").trim() === text) ?? null;

const TWO = () => [
  organizerEntry({ competitionTeamId: ENTRY_A, publicCode: "ENTRYCODE_A_aaaaaaaaaaa", name: "Los Halcones", status: "PENDING_ORGANIZER_APPROVAL", acceptedPlayers: 3, proposedPlayers: 2 }),
  organizerEntry({ competitionTeamId: ENTRY_B, publicCode: "ENTRYCODE_B_bbbbbbbbbbb", name: "Los Pumas", status: "ACCEPTED", acceptedPlayers: 5, proposedPlayers: 0 }),
];

// ---------------------------------------------------------------------------------------------------------------------------------------------
describe("the section exists only on the server's word", () => {
  it("1. nothing is built while the organizer's read is outstanding; the section appears once it answers, even with no entry yet", async () => {
    const world = newWorld();
    const gate = defer<any>();
    world.read.organizerEntries = () => gate.promise;
    world.base = adminBase({ view: competitionView({ organizer: true }) });
    const page = openAdminPage({ auth: signedIn(ORG, "Olivia"), transport: transportOf(world) });
    await openCompetition(page);
    await page.settle(() => readsOfEntries(page) === 1, "the entries read");
    expect(page.$(SECTION)).toBeNull();
    expect(page.$("#entries-host")!.children).toHaveLength(0);
    gate.resolve({ status: 200, json: { entries: [] } });
    await page.settle(() => !!page.$(SECTION), "the section");
    expect(said(page)).toContain("There are no entries to decide on.");
    expect(button(page, "Switch team entries on")).not.toBeNull();
    page.close();
  });

  it("2. a caller the server does not recognise as this competition's organizer — a stranger, a revoked organizer, a failed or malformed read — gets nothing", async () => {
    for (const [label, reply] of [
      ["a refusal of standing", { status: 404, json: { error: "That competition could not be found." } }],
      ["a sign-in that ended", { status: 401, json: { error: "Sign in required." } }],
      ["a server failure", { status: 500, json: { error: "This could not be completed right now. Try again." } }],
      ["an unavailable service", { status: 503, json: { error: "unavailable" } }],
      ["an answer that is not a list", { status: 200, json: { entries: "none" } }],
      ["an answer with no body", { status: 200 }],
    ] as const) {
      const world = newWorld();
      world.read.organizerEntries = reply as any;
      world.base = adminBase({ view: competitionView({ organizer: true }) });
      const page = openAdminPage({ auth: signedIn(ORG, "Olivia"), transport: transportOf(world) });
      await openCompetition(page);
      await page.settle(() => readsOfEntries(page) === 1, `${label}: the read`);
      await page.idle(80);
      expect(page.$(SECTION), label).toBeNull();
      expect(page.$("#entries-host")!.children, label).toHaveLength(0);
      expect(page.$("#organizer-only")!.hidden, `${label}: the page's own organizer controls are as they were`).toBe(false);
      page.close();
    }
  });

  it("3. a competition that is closed to entries, or already runs the V1 team flow, offers nothing to switch on — unless entries exist", async () => {
    for (const state of ["READY_TO_PUBLISH", "PUBLISHED", "COMPLETE", "CANCELLED_WITHOUT_CHAMPION"]) {
      const world = newWorld();
      world.base = adminBase({ view: competitionView({ state, organizer: true }) });
      const page = openAdminPage({ auth: signedIn(ORG, "Olivia"), transport: transportOf(world) });
      await openCompetition(page);
      await page.settle(() => readsOfEntries(page) === 1, `${state}: the read`);
      await page.idle(60);
      expect(page.$(SECTION), state).toBeNull();
      page.close();
    }
    const v1 = newWorld();
    const v1page = openAdminPage({ auth: signedIn(ORG, "Olivia"), transport: transportOf(Object.assign(v1, { base: adminBase({ view: competitionView({ organizer: true, v1Teams: true }) }) })) });
    await openCompetition(v1page);
    await v1page.settle(() => readsOfEntries(v1page) === 1, "the V1 competition's read");
    await v1page.idle(60);
    expect(v1page.$(SECTION)).toBeNull();
    v1page.close();
    const mixed = newWorld();
    mixed.organizerEntries = TWO();
    const shown = await organizer(mixed, { v1Teams: true });
    expect(rows(shown)).toHaveLength(2);
    shown.close();
    const draft = await organizer(newWorld(), { state: "DRAFT" });
    expect(sectionOf(draft)).not.toBeNull();
    draft.close();
  });

  it("4. a scorekeeper-only caller never gets an organizer section — nothing is even asked", async () => {
    const world = newWorld((r) => r.url.startsWith(`${API}/resolve`) ? { status: 200, json: { competitionId: CID } }
      : r.url === `${API}/${CID}/scorekeeper-administration` ? { status: 200, json: { competition: { name: "Pilot Cup", state: "PUBLISHED" }, fixtures: [{ competitionFixtureId: "fx-1", state: "CHECKIN_OPEN", fixtureRole: "FINAL", scheduledAt: "2026-11-01T10:00:00Z", teamACompetitionTeamId: "t1", teamBCompetitionTeamId: "t2", scorekeeperGamingMemberId: ORG }], teams: [{ competitionTeamId: "t1", name: "A" }, { competitionTeamId: "t2", name: "B" }] } }
      : { status: 404, json: { error: "unexpected request" } });
    world.organizerEntries = TWO();
    const page = openAdminPage({ auth: signedIn(ORG, "Olivia"), transport: transportOf(world), search: `?c=${CODE}` });
    await page.settle(() => page.text().includes("Pilot Cup"), "the scorekeeper view");
    await page.idle(80);
    expect(page.$(SECTION)).toBeNull();
    expect(page.requests.filter((r) => r.url.includes("lifetime-"))).toEqual([]);
    page.close();
  });
});

// ---------------------------------------------------------------------------------------------------------------------------------------------
describe("switching team entries on and off", () => {
  it("5. switching on sends the exact request with this session's token and says what the server said; switching off likewise", async () => {
    const world = newWorld();
    const page = await organizer(world);
    expect(said(page)).toContain("No team has entered yet.");
    await press(page, button(page, "Switch team entries on"));
    const [on] = writesOf(page);
    expect({ method: on.method, url: on.url, body: on.body, token: on.token(), cache: on.cache, signal: on.hasSignal }).toEqual({
      method: "POST", url: `${API}/${CID}/lifetime-entry-flow/enable`, body: undefined, token: "token-1", cache: "no-store", signal: true,
    });
    expect(status(page).textContent).toBe("Team entries are switched on. Teams can now enter.");
    expect(said(page)).toContain("Team entries are switched on for this competition.");
    world.write.enable = () => ({ status: 200, json: { flow: { competitionId: CID, enabledAt: "2026-11-24T09:00:00+00:00", alreadyEnabled: true } } });
    await press(page, button(page, "Switch team entries on"));
    expect(status(page).textContent).toBe("Team entries were already switched on.");
    await press(page, button(page, "Switch team entries off"));
    expect(writesOf(page)[2].url).toBe(`${API}/${CID}/lifetime-entry-flow/disable`);
    expect(status(page).textContent).toBe("Team entries are switched off.");
    expect(said(page)).toContain("Team entries are switched off for this competition.");
    page.close();
  });

  it("6. a refusal is shown as the server said it, and nothing is concluded from it", async () => {
    const world = newWorld();
    world.write.enable = () => ({ status: 409, json: { error: "This competition already uses the legacy team flow." } });
    world.write.disable = () => ({ status: 409, json: { error: "Team entries can only be switched off before publication and before anything has been entered, decided or frozen." } });
    const page = await organizer(world);
    await press(page, button(page, "Switch team entries on"));
    expect(status(page).textContent).toBe("This competition already uses the legacy team flow.");
    expect(status(page).className).toContain("error");
    expect(said(page)).not.toContain("switched on for this competition");
    await press(page, button(page, "Switch team entries off"));
    expect(status(page).textContent).toBe("Team entries can only be switched off before publication and before anything has been entered, decided or frozen.");
    page.close();
  });
});

// ---------------------------------------------------------------------------------------------------------------------------------------------
describe("reviewing and deciding entries", () => {
  it("7. each entry shows its name, the organizer's decision state and — labelled apart — what the players have done", async () => {
    const world = newWorld();
    world.organizerEntries = TWO();
    const page = await organizer(world);
    const [waiting, approved] = rows(page);
    expect(waiting.querySelector(".ce-entry-name")!.textContent).toBe("Los Halcones");
    expect(waiting.querySelector(".ce-pill")!.textContent).toBe("Waiting for your decision");
    expect(approved.querySelector(".ce-pill")!.textContent).toBe("Approved by you");
    expect(waiting.querySelector(".ce-pill")!.className).toContain("ce-pill-organizer");
    expect(waiting.querySelector(".ce-counts")!.textContent).toBe(`${PLAYERS}: 3 · Roster proposals waiting for a player: 2`);
    expect(approved.querySelector(".ce-counts")!.textContent).toBe(`${PLAYERS}: 5 · Roster proposals waiting for a player: 0`);
    // the organizer's approval is a different thing from each player's acceptance, and neither is a payment
    const text = said(page);
    expect(text).toContain("Your approval is about the team only: it does not accept any player's roster place (each player accepts their own) and it is not a payment.");
    expect(text).toContain("No payment is requested or confirmed here.");
    expect(text).not.toMatch(/\bpaid\b|payment (received|confirmed|complete|made)|confirmed and paid/i);
    expect(approved.querySelector(".ce-counts .ce-pill")).toBeNull();
    page.close();
  });

  it("8. approving sends exactly an approval, says it is the team that was approved, and shows what the server holds now", async () => {
    const world = newWorld();
    world.organizerEntries = TWO();
    world.after["decide-entry"] = () => { world.organizerEntries = [{ ...(world.organizerEntries[0] as any), status: "ACCEPTED" }, world.organizerEntries[1]]; };
    const page = await organizer(world);
    expect(inRow(rowOf(page, "Los Pumas"), "Approve")).toBeNull(); // an approved entry is not approved again
    await press(page, inRow(rowOf(page, "Los Halcones"), "Approve"));
    const [approve, ...more] = writesOf(page);
    expect(more).toEqual([]);
    expect({ url: approve.url, body: approve.json(), token: approve.token() }).toEqual({ url: `${API}/${CID}/lifetime-entries/${ENTRY_A}/decision`, body: { decision: "APPROVE" }, token: "token-1" });
    expect(status(page).textContent).toBe("Approved. This approves the team only; each player still accepts their own roster place.");
    expect(rowOf(page, "Los Halcones").querySelector(".ce-pill")!.textContent).toBe("Approved by you");
    expect(rowOf(page, "Los Halcones").querySelector(".ce-counts")!.textContent).toContain(`${PLAYERS}: 3`); // approval changed no player's answer
    expect(readsOfEntries(page)).toBe(2);
    page.close();
  });

  it("9. rejecting needs a reason from the list; nothing is sent until it is confirmed; the note is optional and sent only when written", async () => {
    const world = newWorld();
    world.organizerEntries = TWO();
    const page = await organizer(world);
    const row = rowOf(page, "Los Halcones");
    page.click(inRow(row, "Reject…"));
    const panel = row.querySelector(".ce-panel") as HTMLElement;
    expect(page.visible(panel)).toBe(true);
    const select = panel.querySelector("select") as HTMLSelectElement;
    expect([...select.options].map((o) => o.value)).toEqual(["", "INELIGIBLE_TEAM", "INCOMPLETE_ENTRY", "DUPLICATE_OR_MISTAKEN_ENTRY", "COMPETITION_CAPACITY", "RULE_VIOLATION", "OTHER_ORGANIZER_DECISION"]);
    const confirm = inRow(row, "Confirm rejection")!;
    expect(confirm.disabled).toBe(true);
    expect((panel.querySelector("textarea") as HTMLTextAreaElement).getAttribute("maxlength")).toBe("280");
    // keep deciding: nothing was sent
    page.click(inRow(row, "Keep deciding"));
    expect(page.visible(panel)).toBe(false);
    expect(writesOf(page)).toHaveLength(0);
    page.click(inRow(row, "Reject…"));
    page.setValue(select, "INCOMPLETE_ENTRY");
    expect(confirm.disabled).toBe(false);
    await press(page, confirm);
    expect({ url: writesOf(page)[0].url, body: writesOf(page)[0].json() }).toEqual({ url: `${API}/${CID}/lifetime-entries/${ENTRY_A}/decision`, body: { decision: "REJECT", reasonCode: "INCOMPLETE_ENTRY" } });
    expect(status(page).textContent).toBe("The entry was rejected.");
    // with a note
    const again = rowOf(page, "Los Halcones");
    page.click(inRow(again, "Reject…"));
    page.setValue(again.querySelector("select"), "RULE_VIOLATION");
    page.setValue(again.querySelector("textarea"), "  Two captains on one team.  ");
    await press(page, inRow(again, "Confirm rejection"));
    expect(writesOf(page)[1].json()).toEqual({ decision: "REJECT", reasonCode: "RULE_VIOLATION", note: "Two captains on one team." });
    page.close();
  });

  it("10. an approved entry can be removed, with a reason, and says so; the refusals the server gives are shown as it said them", async () => {
    const world = newWorld();
    world.organizerEntries = TWO();
    world.write["decide-entry"] = () => ({ status: 409, json: { error: "This entry has already been decided or withdrawn." } });
    const page = await organizer(world);
    const row = rowOf(page, "Los Pumas");
    expect(inRow(row, "Reject…")).toBeNull();
    page.click(inRow(row, "Remove…"));
    page.setValue(row.querySelector("select"), "COMPETITION_CAPACITY");
    await press(page, inRow(row, "Confirm removal"));
    expect({ url: writesOf(page)[0].url, body: writesOf(page)[0].json() }).toEqual({ url: `${API}/${CID}/lifetime-entries/${ENTRY_B}/decision`, body: { decision: "REMOVE", reasonCode: "COMPETITION_CAPACITY" } });
    expect(status(page).textContent).toBe("This entry has already been decided or withdrawn.");
    expect(status(page).className).toContain("error");
    delete world.write["decide-entry"];
    page.click(inRow(rowOf(page, "Los Pumas"), "Remove…"));
    page.setValue(rowOf(page, "Los Pumas").querySelector("select"), "OTHER_ORGANIZER_DECISION");
    await press(page, inRow(rowOf(page, "Los Pumas"), "Confirm removal"));
    expect(status(page).textContent).toBe("The entry was removed.");
    page.close();
  });

  it("11. one decision at a time: a second click while a request is out sends nothing", async () => {
    const world = newWorld();
    world.organizerEntries = TWO();
    const gate = defer<any>();
    world.write["decide-entry"] = () => gate.promise;
    const page = await organizer(world);
    const approve = inRow(rowOf(page, "Los Halcones"), "Approve")!;
    page.click(approve);
    expect((page.$$(`${SECTION} button`) as HTMLButtonElement[]).every((b) => b.disabled)).toBe(true);
    page.click(approve);
    await page.idle(30);
    expect(writesOf(page)).toHaveLength(1);
    gate.resolve({ status: 200, json: { entry: { competitionTeamId: ENTRY_A, status: "ACCEPTED", decision: "APPROVE", decidedAt: "2026-11-24T12:00:00+00:00", releasedClaims: 0 } } });
    await idle(page);
    expect(status(page).textContent).toContain("Approved.");
    page.close();
  });
});

// ---------------------------------------------------------------------------------------------------------------------------------------------
describe("freezing registration", () => {
  it("12. freezing needs a second, explicit step; confirming sends the exact request and shows exactly what was recorded", async () => {
    const world = newWorld();
    world.organizerEntries = [TWO()[1]];
    const page = await organizer(world);
    const start = button(page, "Freeze registration")!;
    page.click(start);
    expect(writesOf(page)).toHaveLength(0);
    expect(page.visible(button(page, "Yes, freeze registration"))).toBe(true);
    expect(said(page)).toContain("Freezing registration is permanent.");
    page.click(button(page, "Not yet"));
    expect(page.visible(start)).toBe(true);
    expect(writesOf(page)).toHaveLength(0);
    page.click(start);
    await press(page, button(page, "Yes, freeze registration"));
    const [freeze] = writesOf(page);
    expect({ method: freeze.method, url: freeze.url, body: freeze.body, token: freeze.token() }).toEqual({ method: "POST", url: `${API}/${CID}/lifetime-entries/freeze`, body: undefined, token: "token-1" });
    expect(status(page).textContent).toBe("Registration is frozen.");
    expect(page.$(`${SECTION} .ce-frozen`)!.textContent).toBe("Registration is frozen (2026-12-05 00:01 UTC). Recorded: 2 entries and 10 accepted players.");
    // after the freeze nothing offers to decide or to freeze again
    expect(button(page, "Freeze registration")).toBeNull();
    expect(inRow(rowOf(page, "Los Pumas"), "Remove…")).toBeNull();
    page.close();
  });

  it("13. a freeze the server refuses says why, in its own words — a pending entry, the deadline, too few entries, a roster out of range — and changes nothing", async () => {
    const world = newWorld();
    world.organizerEntries = TWO();
    const page = await organizer(world);
    for (const sentence of [
      "Decide every pending entry before freezing the entries.",
      "The registration deadline has not been reached yet.",
      "At least two accepted entries are needed (found 1).",
      "An entry has 3 accepted players, below the roster minimum of 5.",
      "An entry has 9 accepted players, above the roster maximum of 8.",
      "This competition has no usable registration plan.",
      "The entries of this competition are frozen and can no longer change.",
    ]) {
      world.write.freeze = () => ({ status: 409, json: { error: sentence } });
      page.click(button(page, "Freeze registration"));
      await press(page, button(page, "Yes, freeze registration"));
      expect(status(page).textContent).toBe(sentence);
      expect(status(page).className).toContain("error");
      // what the server holds is shown again: the pending entry is still there, still waiting for the organizer, and may still be decided
      expect(rowOf(page, "Los Halcones").querySelector(".ce-pill")!.textContent).toBe("Waiting for your decision");
      expect(inRow(rowOf(page, "Los Halcones"), "Approve")).not.toBeNull();
      expect(page.$(`${SECTION} .ce-frozen`)).toBeNull();
      expect(button(page, "Freeze registration")).not.toBeNull();
    }
    page.close();
  });

  it("14. a freeze that was already done is reported as such, and the surface treats the entries as frozen", async () => {
    const world = newWorld();
    world.organizerEntries = TWO();
    world.write.freeze = () => ({ status: 200, json: { freeze: { competitionId: CID, frozenAt: "2026-12-05T00:01:00+00:00", entryCount: 1, claimCount: 1, alreadyFrozen: true } } });
    const page = await organizer(world);
    page.click(button(page, "Freeze registration"));
    await press(page, button(page, "Yes, freeze registration"));
    expect(status(page).textContent).toBe("Registration was already frozen.");
    expect(page.$(`${SECTION} .ce-frozen`)!.textContent).toContain("Recorded: 1 entry and 1 accepted player.");
    page.close();
  });

  it("15. an answer that is not the freeze the route returns is never taken as success", async () => {
    const world = newWorld();
    world.organizerEntries = TWO();
    world.write.freeze = () => ({ status: 200, json: { freeze: { competitionId: CID, entryCount: "2" } } });
    const page = await organizer(world);
    page.click(button(page, "Freeze registration"));
    await press(page, button(page, "Yes, freeze registration"));
    expect(status(page).textContent).toBe("The server's answer could not be understood; what is shown is what the server holds now.");
    expect(status(page).className).toContain("error");
    expect(page.$(`${SECTION} .ce-frozen`)).toBeNull();
    page.close();
  });
});

// ---------------------------------------------------------------------------------------------------------------------------------------------
describe("the session and organizer denial", () => {
  it("16. a session change removes the section in the very turn it fires; the next member, who organizes nothing, finds no entries, no name and no control", async () => {
    const world = newWorld();
    world.organizerEntries = TWO();
    world.base = (r) => {
      const url = r.url.replace(/\?.*$/, "");
      const mine = r.token() === "token-1";
      if (url === `${API}/administration`) return { status: 200, json: { competitions: mine ? [{ competitionId: CID, name: "Pilot Cup", state: "TEAM_REGISTRATION_OPEN", access: "ORGANIZER" }] : [], operations: { createCompetition: false } } };
      if (url === `${API}/${CID}`) return mine ? { status: 200, json: competitionView({ organizer: true }) } : { status: 404, json: { error: "That competition could not be found." } };
      return { status: 404, json: { error: "unexpected request" } };
    };
    const page = openAdminPage({ auth: signedIn(ORG, "Olivia"), transport: transportOf(world) });
    await openCompetition(page);
    await page.settle(() => !!page.$(SECTION), "the section");
    expect(said(page)).toContain("Los Halcones");
    // a Participant who organizes nothing signs in on the same page
    world.read.organizerEntries = { status: 404, json: { error: "That competition could not be found." } };
    const changing = page.startSessionChange(signedIn(PAT, "Pat"), "token-2");
    expect(page.$(SECTION)).toBeNull(); // the same turn
    for (const secret of ["Los Halcones", "Los Pumas"]) expect(page.text()).not.toContain(secret);
    await changing;
    await page.idle(80);
    expect(page.$(SECTION)).toBeNull();
    expect(page.$("#entries-host")!.children).toHaveLength(0);
    expect(page.$("#admin-gate")!.textContent).toContain("You do not currently organize any competition");
    for (const secret of ["Los Halcones", "Los Pumas", "Olivia"]) expect(page.text()).not.toContain(secret);
    // nothing was asked for the next member's competition with the old member's token, and nothing was asked at all about its entries
    expect(page.requests.filter((r) => r.token() === "token-2" && ENTRIES_READ.test(r.url))).toEqual([]);
    expect(page.requests.filter((r) => r.token() === "token-1").every((r) => page.requests.indexOf(r) < page.requests.findIndex((q) => q.token() === "token-2"))).toBe(true);
    page.close();
  });

  it("17. an answer that arrives after the session changed is discarded; signing out leaves no section and no name", async () => {
    const world = newWorld();
    const late = defer<any>();
    world.read.organizerEntries = () => late.promise;
    world.base = adminBase({ view: competitionView({ organizer: true }) });
    const page = openAdminPage({ auth: signedIn(ORG, "Olivia"), transport: transportOf(world) });
    await openCompetition(page);
    await page.settle(() => readsOfEntries(page) === 1, "the entries read");
    const pending = page.requests.find((r) => ENTRIES_READ.test(r.url))!;
    await page.switchSession({ status: "unauthenticated" });
    expect(pending.aborted()).toBe(true);
    late.resolve({ status: 200, json: { entries: [organizerEntry({ name: "Secret Entry" })] } });
    await page.idle(80);
    expect(page.$(SECTION)).toBeNull();
    expect(page.text()).not.toContain("Secret Entry");
    expect(page.win.localStorage.length + page.win.sessionStorage.length).toBe(0);
    page.close();
  });

  it("17b. the guard is the section's own, not only the abort: an answer from a fetch that ignores the abort is discarded", async () => {
    const page = await organizer(newWorld());
    const entriesApi = (page.win as any).CompetitionsEntries;
    const host = page.doc.createElement("div");
    page.doc.body.appendChild(host);
    const late = defer<any>();
    const built = entriesApi.mountOrganizer({ host, v1InUse: false, competition: { competitionId: CID, name: "Pilot Cup", state: "TEAM_REGISTRATION_OPEN" }, memberId: async () => ORG, fetch: () => late.promise }) as Promise<boolean>;
    await page.idle(30);
    entriesApi.unmountAll();
    late.resolve({ status: 200, json: { entries: TWO() } });
    expect(await built).toBe(false);
    expect(host.children).toHaveLength(0);
    page.close();
  });

  it("18. an organizer whose standing ended is refused uniformly: the section and every name it held are removed, and only a plain note is left", async () => {
    const world = newWorld();
    world.organizerEntries = TWO();
    const page = await organizer(world);
    world.write["decide-entry"] = () => ({ status: 404, json: { error: "That competition could not be found." } });
    world.read.organizerEntries = { status: 404, json: { error: "That competition could not be found." } };
    page.click(inRow(rowOf(page, "Los Halcones"), "Approve"));
    await page.settle(() => !page.$(SECTION), "the section to go");
    expect(writesOf(page)).toHaveLength(1);
    expect(page.$("#entries-host")!.textContent).toBe("You do not currently organize this competition's team entries.");
    expect(page.text()).not.toContain("Los Halcones");
    expect(page.text()).not.toContain("Los Pumas");
    page.close();
  });

  it("19. a click after the signed-in member changed — before any event announced it — sends nothing", async () => {
    const world = newWorld();
    world.organizerEntries = TWO();
    const page = await organizer(world);
    const approve = inRow(rowOf(page, "Los Halcones"), "Approve")!;
    page.changeSessionSilently(signedIn(PAT, "Pat"), "token-2");
    page.click(approve);
    await page.idle(60);
    expect(writesOf(page)).toHaveLength(0);
    expect(page.requests.filter((r) => r.token() === "token-2")).toEqual([]);
    expect(page.$(SECTION)).toBeNull();
    page.close();
  });

  it("20. a request that never answers is given up on, said so, and the server is read again", async () => {
    const world = newWorld();
    world.organizerEntries = TWO();
    const page = await organizer(world);
    const host = page.doc.createElement("div");
    page.doc.body.appendChild(host);
    const calls: Array<{ path: string; method?: string; aborted: () => boolean }> = [];
    const built = await (page.win as any).CompetitionsEntries.mountOrganizer({
      host, timeoutMs: 40, v1InUse: false, competition: { competitionId: CID, name: "Pilot Cup", state: "TEAM_REGISTRATION_OPEN" }, memberId: async () => ORG,
      fetch: (path: string, init: any) => {
        calls.push({ path, method: init.method, aborted: () => !!init.signal && init.signal.aborted });
        return init.method === "POST" ? new Promise(() => {}) : Promise.resolve({ status: 200, json: { entries: TWO() } });
      },
    });
    expect(built).toBe(true);
    page.click(host.querySelector('button[data-action="freeze"]'));
    page.click(host.querySelector('button[data-action="confirm-freeze"]'));
    await page.settle(() => (host.querySelector(".ce-status")?.textContent ?? "").startsWith("The server did not answer in time."), "the timeout message");
    expect(calls.find((c) => c.method === "POST")!.aborted()).toBe(true);
    expect(calls.filter((c) => c.method !== "POST")).toHaveLength(2);
    expect(host.querySelector(".ce-frozen")).toBeNull();
    page.close();
  });
});

// ---------------------------------------------------------------------------------------------------------------------------------------------
describe("every name and sentence a person or a server supplies is text", () => {
  it("21. hostile team names and server sentences become literal text: no element, no handler, nothing executed", async () => {
    const world = newWorld();
    world.organizerEntries = [
      organizerEntry({ name: HOSTILE, status: "PENDING_ORGANIZER_APPROVAL" }),
      organizerEntry({ competitionTeamId: ENTRY_B, publicCode: "ENTRYCODE_B_bbbbbbbbbbb", name: HOSTILE_BREAKOUT, status: "ACCEPTED" }),
    ];
    world.write["decide-entry"] = () => ({ status: 409, json: { error: HOSTILE } });
    const page = await organizer(world);
    await press(page, inRow(rows(page)[0], "Approve"));
    const root = sectionOf(page)!;
    expect(root.querySelector("img, script, svg, iframe, object, embed")).toBeNull();
    for (const el of [root, ...Array.from(root.querySelectorAll("*"))]) for (const attribute of Array.from(el.attributes)) expect(attribute.name.toLowerCase().startsWith("on")).toBe(false);
    expect(status(page).textContent).toBe(HOSTILE);
    expect(said(page)).toContain(HOSTILE_BREAKOUT);
    expect((page.win as any).__xss).toBeUndefined();
    page.close();
  });
});

// ---------------------------------------------------------------------------------------------------------------------------------------------
describe("the organizer page's existing behaviour is untouched", () => {
  async function outside(options: { script: boolean; reads: "empty" | "refused" | "down"; state?: string; v1Teams?: boolean }) {
    const world = newWorld();
    if (options.reads === "refused") world.read.organizerEntries = { status: 404, json: { error: "That competition could not be found." } };
    if (options.reads === "down") world.read.organizerEntries = { status: 503, json: { error: "unavailable" } };
    world.base = adminBase({ view: competitionView({ state: options.state ?? "TEAM_REGISTRATION_OPEN", organizer: true, v1Teams: options.v1Teams }) });
    const page = openAdminPage({ auth: signedIn(ORG, "Olivia"), transport: transportOf(world), script: options.script });
    await openCompetition(page);
    await page.idle(160);
    page.$("#entries-host")?.replaceChildren();
    const snapshot = {
      html: page.doc.body.innerHTML.replace(/<script[\s\S]*?<\/script>/g, "").replace(/<style[\s\S]*?<\/style>/g, ""),
      controls: page.controls(),
      requests: page.requests.filter((r) => !r.url.includes("/lifetime-")).map((r) => `${r.method} ${r.url}`),
    };
    page.close();
    return snapshot;
  }
  const SCENARIOS: Array<[string, { state?: string; v1Teams?: boolean }]> = [
    ["a draft competition", { state: "DRAFT" }], ["a competition open for team registration", {}], ["a competition that runs the V1 team flow", { v1Teams: true }], ["a frozen V1 competition", { state: "READY_TO_PUBLISH" }],
  ];
  for (const [label, scenario] of SCENARIOS) {
    it(`22. ${label}: everything outside the new section — its markup, its controls and the requests it makes — is identical with and without the script, whatever the entries read answers`, async () => {
      const base = await outside({ script: false, reads: "empty", ...scenario });
      for (const reads of ["empty", "refused", "down"] as const) {
        const other = await outside({ script: true, reads, ...scenario });
        expect(other.controls, reads).toEqual(base.controls);
        expect(other.requests, reads).toEqual(base.requests);
        expect(other.html, reads).toBe(base.html);
      }
    });
  }

  it("23. the freeze this section adds is named for what it freezes, apart from the page's own V1 freeze, which keeps its own checklist and words", async () => {
    const world = newWorld();
    world.organizerEntries = TWO();
    const page = await organizer(world);
    expect(page.$("#btn-close-registration")).not.toBeNull(); // V1's own control is still there
    expect(page.$("#freeze-card")).not.toBeNull();
    expect((page.$("#btn-close-registration") as HTMLElement).textContent).toBe("Freeze Registration");
    expect(page.$(`${SECTION} #entries-freeze h3`)!.textContent).toBe("Freeze registration");
    expect(sectionOf(page)!.contains(page.$("#btn-close-registration"))).toBe(false);
    page.close();
  });
});
