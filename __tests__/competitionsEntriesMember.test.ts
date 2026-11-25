import { describe, expect, it } from "vitest";
import {
  API, CID, CODE, OTHER_CID, PAT, SAM, LEE, TEAM_A, TEAM_B, ENTRY_A, CLAIM_1, CLAIM_2, OFFER_1, OFFER_2, HOSTILE, HOSTILE_BREAKOUT, JOIN_CODE, SIGNED_OUT,
  competitionView, defer, ledClaim, ledEntry, memberBase, newWorld, offer, openMemberPage, ownClaim, signedIn, team, transportOf, never,
  type EntriesPage, type EntriesRequest, type World,
} from "./helpers/competitionEntriesPageHarness";

/**
 * UG-CR-GATE-CFM-016 — the invite-only pilot's MEMBER surface (public/competitionsEntries.js, mounted by /competitions.html): a member's team invitations and requests, their
 * teams (and the creation of one), and — on one addressed competition — their team's entry and their own roster proposal.
 *
 * EVIDENCE CLASS. Every test gives the SHIPPED page and the SHIPPED script an AUTHENTICATION DOUBLE and a SERVER DOUBLE (the exact shapes the accepted routes return). It proves what
 * the browser code builds, sends, says and forgets for the answers it is given — never that the real backend gives them. The real backend is exercised separately, in a real
 * browser against the real local routes and a disposable loopback database.
 */

const REGION = "#team-entries";
const LIFETIME_READ = /\/lifetime-(offers|teams|entries|roster-claims)$/;

async function member(world: World, options: { auth?: unknown; token?: string; view?: ReturnType<typeof competitionView>; search?: string } = {}): Promise<EntriesPage> {
  const world2 = options.view ? Object.assign(world, { base: memberBase({ view: options.view }) }) : world;
  const page = openMemberPage({ auth: options.auth ?? signedIn(PAT), token: options.token, transport: transportOf(world2), search: options.search ?? `?c=${CODE}` });
  await page.settle(() => !!page.$(REGION), "the team entries surface");
  return page;
}
const regionOf = (page: EntriesPage) => page.$(REGION) as HTMLElement | null;
const said = (page: EntriesPage) => (regionOf(page)?.textContent ?? "").replace(/\s+/g, " ").trim();
const button = (page: EntriesPage, text: string, within = REGION): HTMLButtonElement | null =>
  (page.$$(`${within} button`) as HTMLButtonElement[]).find((b) => (b.textContent ?? "").trim() === text) ?? null;
const readsOf = (page: EntriesPage, name: string) => page.requests.filter((r) => r.method === "GET" && r.url.endsWith(`/${name}`)).length;
const writesOf = (page: EntriesPage): EntriesRequest[] => page.requests.filter((r) => r.method !== "GET");
const status = (page: EntriesPage) => page.$(`${REGION} .ce-status`) as HTMLElement;
const idle = (page: EntriesPage) => page.settle(() => { const r = regionOf(page); return !r || !r.hasAttribute("aria-busy"); }, "the surface to be idle");
async function press(page: EntriesPage, el: HTMLElement | null) {
  expect(el, "the control exists").not.toBeNull();
  page.click(el);
  await idle(page);
}
const XSS = (page: EntriesPage) => (page.win as any).__xss;

/** A captain with one team, entered or not, in the addressed competition. */
function captainWorld(over: { entry?: unknown; claims?: unknown[]; teams?: unknown[]; entryStatus?: string } = {}): World {
  const world = newWorld(memberBase());
  world.teams = over.teams ?? [team()];
  world.ledEntries = over.entry === null ? [] : [over.entry ?? ledEntry({ status: over.entryStatus ?? "PENDING_ORGANIZER_APPROVAL", claims: over.claims ?? [] })];
  return world;
}

// ---------------------------------------------------------------------------------------------------------------------------------------------
describe("the surface exists only after the server has answered, and asks for no identifier", () => {
  it("1. nothing is built while the reads are outstanding; everything appears once they are answered", async () => {
    const world = newWorld(memberBase());
    const gates = { offers: defer<any>(), teams: defer<any>(), ledEntries: defer<any>(), claims: defer<any>() };
    for (const [name, gate] of Object.entries(gates)) world.read[name] = () => gate.promise;
    const page = openMemberPage({ auth: signedIn(PAT), transport: transportOf(world), search: `?c=${CODE}` });
    await page.settle(() => !!page.$("#registration-status"), "the competition page");
    await page.settle(() => readsOf(page, "lifetime-offers") === 1 && readsOf(page, "lifetime-roster-claims") === 1, "the four reads");
    expect(page.$(REGION)).toBeNull();
    expect(page.$("#team-entries-host")!.children).toHaveLength(0);
    gates.offers.resolve({ status: 200, json: { offers: [] } }); gates.teams.resolve({ status: 200, json: { teams: [team()] } });
    gates.ledEntries.resolve({ status: 200, json: { entries: [] } }); gates.claims.resolve({ status: 200, json: { claims: [] } });
    await page.settle(() => !!page.$(REGION), "the surface");
    expect(said(page)).toContain("Los Halcones");
    page.close();
  });

  it("2. when no read can be answered there is no surface and the page is the page it always was; a partial answer builds what it can and says what it could not read", async () => {
    const down = newWorld(memberBase());
    for (const name of ["offers", "teams", "ledEntries", "claims"]) down.read[name] = { status: 503, json: { error: "Competitions are temporarily unavailable." } };
    const none = openMemberPage({ auth: signedIn(PAT), transport: transportOf(down), search: `?c=${CODE}` });
    await none.settle(() => !!none.$("#registration-status"), "the competition page");
    await none.settle(() => readsOf(none, "lifetime-roster-claims") === 1, "the reads");
    await none.idle(80);
    expect(none.$(REGION)).toBeNull();
    expect(none.$("#team-entries-host")!.children).toHaveLength(0);
    none.close();

    const partial = newWorld(memberBase());
    partial.teams = [team()];
    partial.read.offers = { status: 500, json: { error: "This could not be completed right now. Try again." } };
    const some = await member(partial);
    expect(some.$("#team-invitations")!.textContent).toContain("This could not be loaded right now.");
    expect(some.$("#my-teams")!.textContent).toContain("Los Halcones");
    some.close();
  });

  it("3. an answer that is not exactly a list is a failed read, and a row that is not exactly a row is left out — nothing is repaired", async () => {
    const world = newWorld(memberBase());
    world.teams = [team(), { lifetimeTeamId: "not-an-id", publicCode: "x", name: "Broken", status: "ACTIVE", joinedAt: "2026-11-20T10:00:00+00:00", role: "CAPTAIN" },
      team({ lifetimeTeamId: TEAM_B, name: "Disbanded FC", status: "DISBANDED" }), team({ lifetimeTeamId: TEAM_B, name: "Odd Role FC", role: "OWNER" }), null, 7];
    world.read.offers = { status: 200, json: { offers: "none" } };
    world.read.ledEntries = { status: 200, json: { entries: { not: "a list" } } };
    const page = await member(world);
    const names = (page.$$(`${REGION} .ce-team-name`) as HTMLElement[]).map((e) => e.textContent);
    expect(names).toEqual(["Los Halcones"]);
    expect(page.$("#team-invitations")!.textContent).toContain("This could not be loaded right now.");
    page.close();
  });

  it("4. no control asks for an identifier and no list of members exists: the only text field is the team name, and no identifier is ever shown", async () => {
    const world = captainWorld({ entryStatus: "ACCEPTED", claims: [ledClaim(), ledClaim({ claimId: CLAIM_2, gamingMemberId: SAM, displayName: "Sam", status: "ACCEPTED" })] });
    world.offers = [offer(), offer({ offerId: OFFER_2, direction: "OUTGOING", counterparty: { gamingMemberId: LEE, displayName: "Lee" } })];
    world.claims = [ownClaim()];
    const page = await member(world);
    const fields = page.$$(`${REGION} input, ${REGION} textarea, ${REGION} select`) as HTMLInputElement[];
    // one field takes typing (a new team's name); the other is the captain's own join link, which is read and copied, never typed
    expect(fields.map((f) => `${f.tagName.toLowerCase()}#${f.id}:${f.getAttribute("type")}:${f.readOnly}`)).toEqual([`input#ce-join-link-${team().publicCode}:text:true`, "input#create-team-name:text:false"]);
    expect(fields[0].value).toBe(`http://localhost/competitions.html?join=${team().publicCode}`);
    expect(page.$$(`${REGION} datalist, ${REGION} [list]`)).toHaveLength(0);
    expect(said(page)).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i);
    expect(regionOf(page)!.outerHTML).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i);
    // the only reads the surface makes are the member's own four — no search, no directory, no lookup of anybody
    const reads = page.requests.filter((r) => r.url.includes("/lifetime-") || /member|search|lookup|directory|people|player/i.test(r.url));
    expect(reads.map((r) => `${r.method} ${r.url}`).sort()).toEqual([
      `GET ${API}/lifetime-entries`, `GET ${API}/lifetime-offers`, `GET ${API}/lifetime-roster-claims`, `GET ${API}/lifetime-teams`,
    ]);
    // there is nothing to type a person into: no invite control, no search
    expect((page.$$(`${REGION} button`) as HTMLElement[]).map((b) => (b.textContent ?? "").trim()).join("|")).not.toMatch(/invite (a|another|member|player)|add (a )?(player|member)|search|find (a )?(player|member)/i);
    page.close();
  });
});

// ---------------------------------------------------------------------------------------------------------------------------------------------
describe("team invitations and requests", () => {
  it("5. a person finds their invitation and accepts it: the exact request, with this session's token, then what the server holds now", async () => {
    const world = newWorld(memberBase());
    world.offers = [offer()];
    world.after["decide-offer"] = () => { world.offers = []; world.teams = [team({ role: "MEMBER" })]; };
    const page = await member(world);
    expect(said(page)).toContain("Sam invited you to join Los Halcones.");
    expect(said(page)).toContain("Valid until 2026-12-01 10:00 UTC");
    await press(page, button(page, "Accept invitation"));
    const [write, ...more] = writesOf(page);
    expect(more).toEqual([]);
    expect({ method: write.method, url: write.url, body: write.json(), token: write.token(), cache: write.cache, signal: write.hasSignal }).toEqual({
      method: "POST", url: `${API}/lifetime-memberships/${OFFER_1}/decision`, body: { decision: "ACCEPT" }, token: "token-1", cache: "no-store", signal: true,
    });
    expect(readsOf(page, "lifetime-offers")).toBe(2);
    expect(said(page)).toContain("Accepted.");
    expect(said(page)).not.toContain("Sam invited you");
    expect(page.$$(`${REGION} .ce-team-name`).map((e: HTMLElement) => e.textContent)).toEqual(["Los Halcones"]);
    page.close();
  });

  it("6. declining sends DECLINE; a request to a captain is worded as one; only an incoming offer can be answered and only an outgoing one withdrawn", async () => {
    const world = newWorld(memberBase());
    world.teams = [team()]; // the member leads Los Halcones, so an incoming offer from Sam is Sam's REQUEST to join it
    world.offers = [
      offer({ offerId: OFFER_1 }),
      offer({ offerId: OFFER_2, direction: "OUTGOING", counterparty: { gamingMemberId: LEE, displayName: "Lee" } }),
      offer({ offerId: "f3f3f3f3-f3f3-4f3f-8f3f-f3f3f3f3f3f3", direction: "OUTGOING", counterparty: null, team: { lifetimeTeamId: TEAM_B, publicCode: "TEAMCODE_B_bbbbbbbbbbbb", name: "Los Pumas" } }),
      offer({ offerId: "f4f4f4f4-f4f4-4f4f-8f4f-f4f4f4f4f4f4", kind: "LEADERSHIP" }),
    ];
    const page = await member(world);
    const text = said(page);
    expect(text).toContain("Sam asked to join Los Halcones.");
    expect(text).toContain("You invited Lee to join Los Halcones. Waiting for their answer.");
    expect(text).toContain("You asked to join Los Pumas. Waiting for the team's answer.");
    expect(page.$$(`${REGION} .ce-offer`)).toHaveLength(3); // the sub-captain seat offer is not part of this pilot
    const rows = page.$$(`${REGION} .ce-offer`) as HTMLElement[];
    const labels = rows.map((row) => [...row.querySelectorAll("button")].map((b) => b.textContent));
    expect(labels).toEqual([["Accept request", "Decline"], ["Withdraw"], ["Withdraw"]]);
    await press(page, button(page, "Decline"));
    expect(writesOf(page)[0].json()).toEqual({ decision: "DECLINE" });
    await press(page, page.$$(`${REGION} .ce-offer`)[1].querySelector("button"));
    const withdraw = writesOf(page)[1];
    expect({ url: withdraw.url, body: withdraw.json() }).toEqual({ url: `${API}/lifetime-offers/${OFFER_2}/withdraw`, body: { kind: "MEMBERSHIP" } });
    page.close();
  });

  it("7. a refusal is shown as the server said it; a failure with no usable answer is one fixed sentence; the offer stays until the server says otherwise", async () => {
    const world = newWorld(memberBase());
    world.offers = [offer()];
    world.write["decide-offer"] = () => ({ status: 409, json: { error: "This offer has lapsed. Ask for a new one." } });
    const page = await member(world);
    await press(page, button(page, "Accept invitation"));
    expect(status(page).textContent).toBe("This offer has lapsed. Ask for a new one.");
    expect(status(page).className).toContain("error");
    expect(said(page)).toContain("Sam invited you to join Los Halcones.");
    world.write["decide-offer"] = () => ({ status: 500 });
    await press(page, button(page, "Accept invitation"));
    expect(status(page).textContent).toBe("This could not be completed right now. Try again.");
    world.write["decide-offer"] = () => ({ status: 401, json: {} });
    await press(page, button(page, "Accept invitation"));
    expect(status(page).textContent).toBe("Your session has ended. Sign in again.");
    world.write["decide-offer"] = () => ({ status: 404, json: { error: "That offer could not be found." } });
    await press(page, button(page, "Decline"));
    expect(status(page).textContent).toBe("That offer could not be found.");
    page.close();
  });

  it("8. one action at a time: a second click while a request is out sends nothing, and the controls are disabled until the server has answered", async () => {
    const world = newWorld(memberBase());
    world.offers = [offer()];
    const gate = defer<any>();
    world.write["decide-offer"] = () => gate.promise;
    const page = await member(world);
    const accept = button(page, "Accept invitation")!;
    page.click(accept);
    expect(regionOf(page)!.getAttribute("aria-busy")).toBe("true");
    expect((page.$$(`${REGION} button`) as HTMLButtonElement[]).every((b) => b.disabled)).toBe(true);
    page.click(accept); page.click(button(page, "Decline"));
    await page.idle(30);
    expect(writesOf(page)).toHaveLength(1);
    gate.resolve({ status: 200, json: { membership: { lifetimeTeamMembershipId: OFFER_1, status: "ACTIVE", joinedAt: null } } });
    await idle(page);
    expect((page.$$(`${REGION} button`) as HTMLButtonElement[]).some((b) => b.disabled)).toBe(false);
    page.close();
  });
});

describe("keyboard and screen-reader users are not left on nothing", () => {
  it("8b. after an action started from a focused control, focus lands on what the server said; a control that had no focus does not pull it", async () => {
    const world = newWorld(memberBase());
    world.offers = [offer()];
    const page = await member(world);
    const accept = button(page, "Accept invitation")!;
    accept.focus();
    expect(page.doc.activeElement).toBe(accept);
    page.click(accept);
    await idle(page);
    expect(page.doc.activeElement).toBe(status(page));
    expect(status(page).getAttribute("aria-live")).toBe("polite");
    (page.doc.activeElement as HTMLElement).blur(); // a click that does not move focus (a script, an assistive tool) must not steal it either
    await press(page, button(page, "Decline"));
    expect(page.doc.activeElement).not.toBe(status(page));
    page.close();
  });
});

// ---------------------------------------------------------------------------------------------------------------------------------------------
describe("a member's teams", () => {
  it("9. teams are listed with the member's own role and can be opened; a new team is created with exactly its name", async () => {
    const world = newWorld(memberBase());
    world.teams = [team(), team({ lifetimeTeamId: TEAM_B, publicCode: "TEAMCODE_B_bbbbbbbbbbbb", name: "Los Pumas", role: "SUB_CAPTAIN" })];
    const page = await member(world);
    const rows = page.$$(`${REGION} .ce-team`) as HTMLElement[];
    expect(rows.map((r) => r.querySelector(".ce-team-name")!.textContent)).toEqual(["Los Halcones", "Los Pumas"]);
    expect(rows.map((r) => r.querySelector(".ce-pill")!.textContent)).toEqual(["Captain", "Sub-captain"]);
    const details = rows[0].querySelector(".ce-team-details") as HTMLElement;
    expect(page.visible(details)).toBe(false);
    page.click(rows[0].querySelector('button[data-action="open-team"]'));
    expect(page.visible(details)).toBe(true);
    expect(details.textContent).toContain("Team code: TEAMCODE_A_aaaaaaaaaaaa");
    expect(details.textContent).toContain("On the team since 2026-11-20 10:00 UTC");
    page.click(rows[0].querySelector('button[data-action="open-team"]'));
    expect(page.visible(details)).toBe(false);
    world.after["create-team"] = () => { world.teams = [...world.teams, team({ lifetimeTeamId: "d4d4d4d4-d4d4-4d4d-8d4d-d4d4d4d4d4d4", name: "Los Zorros" })]; };
    page.setValue(page.$("#create-team-name"), "  Los   Zorros  ");
    await press(page, page.$("#create-team-submit"));
    const [create] = writesOf(page);
    expect({ url: create.url, body: create.json(), token: create.token() }).toEqual({ url: `${API}/lifetime-teams`, body: { name: "Los   Zorros" }, token: "token-1" });
    expect(said(page)).toContain("Team created. You are its captain.");
    expect(page.$$(`${REGION} .ce-team-name`).map((e: HTMLElement) => e.textContent)).toContain("Los Zorros");
    page.close();
  });

  it("9b. a card the person opened stays open across the page's re-renders (a token refresh, a returning tab); one they closed follows the server again", async () => {
    const page = await member(newWorld(memberBase()));
    const body = () => page.$("#team-entries-body") as HTMLElement;
    const rerender = async () => {
      const before = page.$(REGION);
      await page.switchSession(signedIn(PAT), "token-1");
      await page.settle(() => !!page.$(REGION) && page.$(REGION) !== before, "a new surface");
    };
    expect(body().hidden).toBe(true); // nothing to show: closed
    await rerender();
    expect(body().hidden).toBe(true);
    page.click(page.$("#team-entries-toggle"));
    page.setValue(page.$("#create-team-name"), "Half typed");
    await rerender();
    expect(body().hidden).toBe(false);
    expect((page.$("#create-team-name") as HTMLInputElement).value).toBe(""); // nothing typed is carried over
    page.click(page.$("#team-entries-toggle"));
    await rerender();
    expect(body().hidden).toBe(true);
    page.close();
  });

  it("10. an empty name sends nothing; the server's refusal of a name is shown as it said it", async () => {
    const world = newWorld(memberBase());
    world.write["create-team"] = () => ({ status: 409, json: { error: "An active team already has this name." } });
    const page = await member(world);
    expect(said(page)).toContain("You are not on a team yet.");
    page.setValue(page.$("#create-team-name"), "   ");
    page.click(page.$("#create-team-submit"));
    await page.idle(30);
    expect(status(page).textContent).toBe("A team name is required.");
    expect(writesOf(page)).toHaveLength(0);
    page.setValue(page.$("#create-team-name"), "Los Halcones");
    await press(page, page.$("#create-team-submit"));
    expect(status(page).textContent).toBe("An active team already has this name.");
    expect(writesOf(page)).toHaveLength(1);
    page.close();
  });
});

// ---------------------------------------------------------------------------------------------------------------------------------------------
describe("a team's entry in the addressed competition", () => {
  it("11. a captain enters the team with exactly its team id; a person who leads nothing is told who enters", async () => {
    const world = captainWorld({ entry: null });
    world.teams = [team(), team({ lifetimeTeamId: TEAM_B, publicCode: "TEAMCODE_B_bbbbbbbbbbbb", name: "Los Pumas", role: "MEMBER" })];
    world.after.enter = () => { world.ledEntries = [ledEntry()]; };
    const page = await member(world);
    expect(button(page, "Enter this competition with Los Pumas")).toBeNull();
    expect(said(page)).toContain("Your captain or sub-captain enters the team in a competition.");
    await press(page, button(page, "Enter this competition with Los Halcones"));
    const [enter] = writesOf(page);
    expect({ url: enter.url, body: enter.json(), token: enter.token() }).toEqual({ url: `${API}/${CID}/lifetime-entries`, body: { lifetimeTeamId: TEAM_A }, token: "token-1" });
    expect(said(page)).toContain("Entered. The organizer decides on the team's entry.");
    expect(button(page, "Enter this competition with Los Halcones")).toBeNull();
    expect(said(page)).toContain("Waiting for the organizer");
    page.close();
  });

  it("12. a sub-captain may enter too; an entry in ANOTHER competition does not count as an entry here", async () => {
    const world = captainWorld({ entry: ledEntry({ competitionId: OTHER_CID }), teams: [team({ role: "SUB_CAPTAIN" })] });
    const page = await member(world);
    expect(button(page, "Enter this competition with Los Halcones")).not.toBeNull();
    expect(said(page)).not.toContain("Waiting for the organizer");
    page.close();
  });

  it("13. a member who has not registered is told to register first, and the server's own refusal is shown as it said it", async () => {
    const world = captainWorld({ entry: null });
    world.write.enter = () => ({ status: 409, json: { error: "Register for this competition first." } });
    const page = await member(world, { view: competitionView({ registered: false }) });
    expect(said(page)).toContain("Register for this competition first (the registration card on this page)");
    await press(page, button(page, "Enter this competition with Los Halcones"));
    expect(status(page).textContent).toBe("Register for this competition first.");
    const registered = await member(captainWorld({ entry: null }));
    expect(said(registered)).not.toContain("Register for this competition first (");
    page.close(); registered.close();
  });

  it("14. the organizer's decision on the team, each player's own answer and payment are three different things, never one badge", async () => {
    const world = captainWorld({ entryStatus: "ACCEPTED", claims: [
      ledClaim({ claimId: CLAIM_1, displayName: "Lee", status: "PROPOSED" }), ledClaim({ claimId: CLAIM_2, gamingMemberId: SAM, displayName: "Sam", status: "ACCEPTED" }),
    ] });
    const page = await member(world);
    const decision = page.$(`${REGION} .ce-organizer-decision`) as HTMLElement;
    expect(decision.textContent).toContain("The organizer's decision on the team: Approved by the organizer");
    expect(decision.querySelector(".ce-pill")!.className).toContain("ce-pill-organizer");
    const places = page.$$(`${REGION} .ce-place`) as HTMLElement[];
    expect(places.map((p) => p.querySelector(".ce-person")!.textContent)).toEqual(["Lee", "Sam"]);
    // the team is approved while Lee has NOT answered: approval accepted nobody's place
    expect(places.map((p) => p.querySelector(".ce-pill")!.textContent)).toEqual(["Waiting for the player", "Accepted by the player"]);
    expect(places.every((p) => p.querySelector(".ce-pill")!.className.includes("ce-pill-player"))).toBe(true);
    expect(places[0].querySelector(".ce-pill")!.className).not.toContain("ce-pill-organizer");
    const text = said(page);
    expect(text).toContain("The organizer's approval is about the team only. It does not accept anyone's roster place, and it is not a payment.");
    expect(text).toContain("no payment is requested or confirmed on this page");
    expect(text).not.toMatch(/\bpaid\b|payment (received|confirmed|complete|made)|confirmed and paid|you('| a)re (in|set)\b/i);
    // a waiting entry reads as waiting, in the organizer's colour only
    const waiting = await member(captainWorld({ entryStatus: "PENDING_ORGANIZER_APPROVAL", claims: [ledClaim({ status: "ACCEPTED" })] }));
    expect(waiting.$(`${REGION} .ce-organizer-decision`)!.textContent).toContain("Waiting for the organizer");
    expect(waiting.$(`${REGION} .ce-place .ce-pill`)!.textContent).toBe("Accepted by the player");
    page.close(); waiting.close();
  });

  it("15. a leader releases a proposal or removes an accepted place; the entry is withdrawn only after a second, explicit step", async () => {
    const world = captainWorld({ claims: [ledClaim({ claimId: CLAIM_1, displayName: "Lee", status: "PROPOSED" }), ledClaim({ claimId: CLAIM_2, gamingMemberId: SAM, displayName: "Sam", status: "ACCEPTED" })] });
    const page = await member(world);
    expect((page.$$(`${REGION} .ce-place`) as HTMLElement[]).map((p) => p.querySelector("button")!.textContent)).toEqual(["Withdraw the proposal", "Remove from the roster"]);
    expect(button(page, "Choose players to propose"), "the roster picker is offered, and reads nothing until asked").not.toBeNull();
    expect(page.requests.filter((r) => r.url.includes("roster-candidates"))).toEqual([]);
    await press(page, button(page, "Withdraw the proposal"));
    expect(writesOf(page)[0].url).toBe(`${API}/${CID}/lifetime-roster-claims/${CLAIM_1}/release`);
    expect(writesOf(page)[0].body).toBeUndefined();
    await press(page, button(page, "Remove from the roster"));
    expect(writesOf(page)[1].url).toBe(`${API}/${CID}/lifetime-roster-claims/${CLAIM_2}/release`);
    // withdrawing the entry: the first click asks, nothing is sent until it is confirmed
    const open = button(page, "Withdraw the entry")!;
    page.click(open);
    expect(page.visible(open)).toBe(false);
    expect(page.visible(button(page, "Yes, withdraw the entry"))).toBe(true);
    expect(writesOf(page)).toHaveLength(2);
    page.click(button(page, "Keep the entry"));
    expect(page.visible(open)).toBe(true);
    expect(writesOf(page)).toHaveLength(2);
    page.click(open);
    await press(page, button(page, "Yes, withdraw the entry"));
    expect(writesOf(page)[2].url).toBe(`${API}/${CID}/lifetime-entries/${ENTRY_A}/withdraw`);
    page.close();
  });

  it("16. the server's refusals of the entry and of a place are shown as it said them (a frozen competition included)", async () => {
    const world = captainWorld({ claims: [ledClaim({ status: "ACCEPTED" })] });
    world.write["release-claim"] = () => ({ status: 409, json: { error: "The entries of this competition are frozen and can no longer change." } });
    world.write["withdraw-entry"] = () => ({ status: 409, json: { error: "The entries of this competition are frozen and can no longer change." } });
    const page = await member(world);
    await press(page, button(page, "Remove from the roster"));
    expect(status(page).textContent).toBe("The entries of this competition are frozen and can no longer change.");
    page.click(button(page, "Withdraw the entry"));
    await press(page, button(page, "Yes, withdraw the entry"));
    expect(status(page).textContent).toBe("The entries of this competition are frozen and can no longer change.");
    expect(status(page).className).toContain("error");
    page.close();
  });
});

// ---------------------------------------------------------------------------------------------------------------------------------------------
describe("a person's own roster proposal", () => {
  it("17. only this competition's proposals are shown; accepting and declining send exactly the answer", async () => {
    const world = newWorld(memberBase());
    world.claims = [ownClaim({ claimId: CLAIM_1 }), ownClaim({ claimId: CLAIM_2, competitionId: OTHER_CID, team: { lifetimeTeamId: TEAM_B, publicCode: "TEAMCODE_B_bbbbbbbbbbbb", name: "Los Pumas" } })];
    world.after["decide-claim"] = () => { world.claims = [ownClaim({ claimId: CLAIM_1, status: "ACCEPTED" })]; };
    const page = await member(world);
    const mine = page.$(`#my-roster-proposals`) as HTMLElement;
    expect(mine.textContent).toContain("Los Halcones proposed you for this competition's roster.");
    expect(mine.textContent).not.toContain("Los Pumas");
    expect(mine.textContent).toContain("This is your answer alone. The organizer's decision on the team does not accept this place for you, and no payment is part of it.");
    await press(page, button(page, "Accept my roster place"));
    const [accept] = writesOf(page);
    expect({ url: accept.url, body: accept.json(), token: accept.token() }).toEqual({ url: `${API}/${CID}/lifetime-roster-claims/${CLAIM_1}/decision`, body: { decision: "ACCEPT" }, token: "token-1" });
    expect(said(page)).toContain("You accepted your roster place.");
    expect(page.$("#my-roster-proposals")!.textContent).toContain("You accepted this place");
    // an accepted place can be withdrawn by the person
    await press(page, button(page, "Withdraw my place"));
    expect(writesOf(page)[1].url).toBe(`${API}/${CID}/lifetime-roster-claims/${CLAIM_1}/release`);
    page.close();
  });

  it("18. declining sends REJECT; a person with no proposal here is told so; an unregistered person is told to register first", async () => {
    const world = newWorld(memberBase());
    world.claims = [ownClaim()];
    world.write["decide-claim"] = () => ({ status: 409, json: { error: "Register for this competition first." } });
    const page = await member(world, { view: competitionView({ registered: false }) });
    expect(page.$("#my-roster-proposals")!.textContent).toContain("Register for this competition first (the registration card on this page); then you can answer.");
    await press(page, button(page, "Decline"));
    expect(writesOf(page)[0].json()).toEqual({ decision: "REJECT" });
    expect(status(page).textContent).toBe("Register for this competition first.");
    const none = await member(newWorld(memberBase()));
    expect(none.$("#my-roster-proposals")!.textContent).toContain("No team has proposed you for this competition's roster.");
    page.close(); none.close();
  });
});

// ---------------------------------------------------------------------------------------------------------------------------------------------
describe("on the list of competitions", () => {
  it("19. the list carries invitations and teams (and the count of proposals) but never an entry control; opening a competition mounts the competition's own surface", async () => {
    const world = newWorld(memberBase());
    world.offers = [offer()];
    world.teams = [team()];
    world.ledEntries = [ledEntry()];
    world.claims = [ownClaim(), ownClaim({ claimId: CLAIM_2, competitionId: OTHER_CID })];
    const page = await member(world, { search: "" });
    expect(said(page)).toContain("Sam asked to join Los Halcones.");
    expect(said(page)).toContain("Teams proposed you for 2 rosters. Open the competitions they are for to answer.");
    expect(page.$$(`${REGION} .ce-entry`)).toHaveLength(0);
    expect(button(page, "Enter this competition with Los Halcones")).toBeNull();
    expect(page.$("#my-roster-proposals")).toBeNull();
    const row = page.$$("button.team-row")[0] as HTMLElement;
    expect(row.textContent).toContain("Pilot Cup");
    page.click(row);
    await page.settle(() => !!page.$("#my-roster-proposals"), "the competition's own surface");
    expect(button(page, "Enter this competition with Los Halcones")).toBeNull(); // the team already has an entry
    expect(said(page)).toContain("Waiting for the organizer");
    expect(page.$$(REGION)).toHaveLength(1);
    page.close();
  });
});

// ---------------------------------------------------------------------------------------------------------------------------------------------
describe("the session: private data goes with it, and nothing late or foreign is shown or sent", () => {
  it("20. any session change removes the surface in the very turn it fires, aborts what it was waiting for and shows the next member only their own data", async () => {
    const world = newWorld(memberBase());
    world.offers = [offer()]; world.teams = [team()]; world.claims = [ownClaim()];
    const page = await member(world);
    expect(said(page)).toContain("Sam");
    const holdSam = defer<any>();
    world.read.offers = () => holdSam.promise; // the next member's offers are still on their way
    const changing = page.startSessionChange(signedIn(SAM, "Sam"), "token-2");
    // the same turn: no private value of the previous member is left in the document
    expect(page.$(REGION)).toBeNull();
    expect(page.text()).not.toContain("Los Halcones");
    expect(page.text()).not.toMatch(/Valid until/);
    await changing;
    // the next member's own data replaces it, fetched with the NEXT session's token and nothing else
    world.offers = [offer({ offerId: OFFER_2, counterparty: { gamingMemberId: PAT, displayName: "Pat" }, team: { lifetimeTeamId: TEAM_B, publicCode: "TEAMCODE_B_bbbbbbbbbbbb", name: "Los Pumas" } })];
    world.teams = []; world.claims = [];
    holdSam.resolve({ status: 200, json: { offers: world.offers } });
    await page.settle(() => !!page.$(REGION), "the next member's surface");
    expect(said(page)).toContain("Pat invited you to join Los Pumas.");
    expect(said(page)).not.toContain("Los Halcones");
    const lateReads = page.requests.slice(page.requests.findIndex((r) => r.token() === "token-2"));
    expect(lateReads.length).toBeGreaterThan(0);
    expect(lateReads.every((r) => r.token() === "token-2")).toBe(true);
    page.close();
  });

  it("21. an answer that arrives after the session changed is discarded: nothing of it is shown and nothing follows from it", async () => {
    const world = newWorld(memberBase());
    const lateOffers = defer<any>();
    world.read.offers = () => lateOffers.promise;
    world.teams = [team()];
    const page = openMemberPage({ auth: signedIn(PAT), transport: transportOf(world), search: `?c=${CODE}` });
    await page.settle(() => readsOf(page, "lifetime-offers") === 1 && readsOf(page, "lifetime-roster-claims") === 1, "the first member's reads");
    const first = page.requests.filter((r) => LIFETIME_READ.test(r.url));
    expect(first.every((r) => r.hasSignal)).toBe(true);
    delete world.read.offers; world.teams = []; world.offers = [];
    await page.switchSession(SIGNED_OUT);
    // the one read still outstanding was aborted (the others had already been answered)
    expect(first.find((r) => r.url.endsWith("/lifetime-offers"))!.aborted()).toBe(true);
    lateOffers.resolve({ status: 200, json: { offers: [offer({ counterparty: { gamingMemberId: SAM, displayName: "Secret Sender" } })] } });
    await page.idle(80);
    expect(page.$(REGION)).toBeNull();
    expect(page.text()).not.toContain("Secret Sender");
    page.close();
  });

  it("21b. the guard is the surface's own, not only the abort: an answer from a fetch that ignores the abort — to a read or to a write — is discarded", async () => {
    const page = openMemberPage({ auth: signedIn(PAT), transport: transportOf(newWorld(memberBase())), search: `?c=${CODE}` });
    await page.settle(() => !!page.$("#registration-status"), "the page");
    const entriesApi = (page.win as any).CompetitionsEntries;
    const answers: Record<string, unknown> = { "lifetime-offers": { offers: [offer()] }, "lifetime-teams": { teams: [team()] }, "lifetime-entries": { entries: [] }, "lifetime-roster-claims": { claims: [] } };
    const mountOwn = (fetch: (path: string, init: any) => Promise<unknown>) => {
      const host = page.doc.createElement("div");
      page.doc.body.appendChild(host);
      return { host, built: entriesApi.mountMember({ host, competition: null, memberId: async () => PAT, fetch }) as Promise<boolean> };
    };
    const listOf = (path: string) => ({ status: 200, json: answers[path.split("/").pop()!] });
    // a read still outstanding when the surface is removed
    const lateRead = defer<any>();
    const first = mountOwn((path) => (path.endsWith("lifetime-offers") ? lateRead.promise : Promise.resolve(listOf(path))));
    await page.idle(30);
    entriesApi.unmountAll();
    lateRead.resolve({ status: 200, json: answers["lifetime-offers"] });
    expect(await first.built).toBe(false);
    expect(first.host.children).toHaveLength(0);
    // a write still outstanding when the surface is removed
    const lateWrite = defer<any>();
    const calls: string[] = [];
    const second = mountOwn((path, init) => { calls.push(`${init.method} ${path}`); return init.method === "POST" ? lateWrite.promise : Promise.resolve(listOf(path)); });
    expect(await second.built).toBe(true);
    page.click(second.host.querySelector('button[data-action="decline-offer"]'));
    await page.settle(() => calls.some((c) => c.startsWith("POST")), "the write");
    entriesApi.unmountAll();
    const before = calls.length;
    lateWrite.resolve({ status: 200, json: { membership: { lifetimeTeamMembershipId: OFFER_1, status: "ENDED", joinedAt: null } } });
    await page.idle(40);
    expect(second.host.children).toHaveLength(0);
    expect(calls.length).toBe(before); // no read follows a late answer
    page.close();
  });

  it("22. signing out removes the surface and every name it held; nothing private is kept in storage or in the address", async () => {
    const world = newWorld(memberBase());
    world.offers = [offer()]; world.teams = [team()]; world.ledEntries = [ledEntry({ claims: [ledClaim()] })];
    const page = await member(world);
    await press(page, button(page, "Decline"));
    expect(page.win.localStorage.length).toBe(0);
    expect(page.win.sessionStorage.length).toBe(0);
    expect(page.win.location.search).toBe(`?c=${CODE}`);
    expect(page.win.document.cookie).toBe("");
    await page.switchSession(SIGNED_OUT);
    expect(page.$(REGION)).toBeNull();
    expect(page.$("#team-entries-host")).toBeNull();
    for (const secret of ["Sam", "Lee", "Los Halcones", "TEAMCODE_A"]) expect(page.text()).not.toContain(secret);
    page.close();
  });

  it("23. a click after the signed-in member changed — before any event announced it — sends nothing, for anybody", async () => {
    const world = newWorld(memberBase());
    world.offers = [offer()];
    const page = await member(world);
    const before = page.requests.length;
    const decline = button(page, "Decline")!;
    page.changeSessionSilently(signedIn(SAM, "Sam"), "token-2");
    page.click(decline);
    await page.idle(60);
    expect(writesOf(page)).toHaveLength(0);
    expect(page.requests.slice(before).filter((r) => r.token() === "token-1")).toEqual([]);
    expect(page.$(REGION)).toBeNull(); // the surface was built for another member: it is gone, not repaired
    page.close();
  });

  it("24. an answer to a write that arrives after the session changed is discarded and starts no further request", async () => {
    const world = newWorld(memberBase());
    world.offers = [offer()];
    const gate = defer<any>();
    world.write["decide-offer"] = () => gate.promise;
    const page = await member(world);
    page.click(button(page, "Accept invitation"));
    await page.settle(() => writesOf(page).length === 1, "the write");
    const readsBefore = page.requests.filter((r) => r.method === "GET").length;
    world.offers = [];
    await page.switchSession(signedIn(SAM, "Sam"), "token-2");
    await page.settle(() => !!page.$(REGION) && !regionOf(page)!.hasAttribute("aria-busy"), "the next member's surface");
    const afterSwitch = page.requests.length;
    gate.resolve({ status: 200, json: { membership: { lifetimeTeamMembershipId: OFFER_1, status: "ACTIVE", joinedAt: null } } });
    await page.idle(80);
    expect(page.requests.length).toBe(afterSwitch); // the late answer caused nothing
    expect(page.requests.filter((r) => r.method === "GET").length).toBeGreaterThanOrEqual(readsBefore);
    expect(said(page)).not.toContain("Accepted.");
    page.close();
  });

  it("25. a request that never answers is given up on, said so, and the server is read again", async () => {
    const world = newWorld(memberBase());
    world.offers = [offer()];
    const page = openMemberPage({ auth: signedIn(PAT), transport: transportOf(world), search: `?c=${CODE}` });
    await page.settle(() => !!page.$("#registration-status"), "the page");
    const host = page.doc.createElement("div");
    host.id = "own-host";
    page.doc.body.appendChild(host);
    const requests: Array<{ path: string; method?: string; aborted: () => boolean }> = [];
    const lists: Record<string, unknown> = {
      [`${API}/lifetime-offers`]: { offers: world.offers }, [`${API}/lifetime-teams`]: { teams: [] }, [`${API}/lifetime-entries`]: { entries: [] }, [`${API}/lifetime-roster-claims`]: { claims: [] },
    };
    const built = await (page.win as any).CompetitionsEntries.mountMember({
      host, timeoutMs: 40, competition: null, memberId: async () => PAT,
      fetch: (path: string, init: any) => {
        requests.push({ path, method: init.method, aborted: () => !!init.signal && init.signal.aborted });
        return init.method === "POST" ? never() : Promise.resolve({ status: 200, json: lists[path] });
      },
    });
    expect(built).toBe(true);
    page.click(host.querySelector('button[data-action="accept-offer"]'));
    await page.settle(() => (host.querySelector(".ce-status")?.textContent ?? "").startsWith("The server did not answer in time."), "the timeout message");
    expect(requests.find((r) => r.method === "POST")!.aborted()).toBe(true);
    expect(requests.filter((r) => r.path.endsWith("lifetime-offers")).length).toBe(2); // read again, not concluded from the silence
    page.close();
  });
});

// ---------------------------------------------------------------------------------------------------------------------------------------------
describe("every name and sentence a person or a server supplies is text", () => {
  it("26. hostile names and server sentences become literal text: no element, no handler, nothing executed", async () => {
    const world = captainWorld({ claims: [ledClaim({ displayName: HOSTILE }), ledClaim({ claimId: CLAIM_2, displayName: HOSTILE_BREAKOUT, status: "ACCEPTED" })], entryStatus: "ACCEPTED" });
    world.teams = [team({ name: HOSTILE_BREAKOUT })];
    world.ledEntries = [ledEntry({ name: HOSTILE, claims: [ledClaim({ displayName: HOSTILE }), ledClaim({ claimId: CLAIM_2, displayName: HOSTILE_BREAKOUT, status: "ACCEPTED" })] })];
    world.offers = [offer({ counterparty: { gamingMemberId: SAM, displayName: HOSTILE }, team: { lifetimeTeamId: TEAM_A, publicCode: "TEAMCODE_A_aaaaaaaaaaaa", name: HOSTILE_BREAKOUT } })];
    world.claims = [ownClaim({ team: { lifetimeTeamId: TEAM_A, publicCode: "TEAMCODE_A_aaaaaaaaaaaa", name: HOSTILE } })];
    world.write["decide-offer"] = () => ({ status: 409, json: { error: HOSTILE } });
    const page = await member(world, { view: competitionView({ name: HOSTILE }) });
    await press(page, button(page, "Decline"));
    const root = regionOf(page)!;
    expect(root.querySelector("img, script, svg, iframe, object, embed")).toBeNull();
    for (const el of [root, ...Array.from(root.querySelectorAll("*"))]) for (const attribute of Array.from(el.attributes)) expect(attribute.name.toLowerCase().startsWith("on")).toBe(false);
    expect(status(page).textContent).toBe(HOSTILE);
    expect(said(page)).toContain(HOSTILE);
    expect(said(page)).toContain(HOSTILE_BREAKOUT);
    expect(XSS(page)).toBeUndefined();
    page.close();
  });
});

// ---------------------------------------------------------------------------------------------------------------------------------------------
describe("a team's join link (UG-CR-GATE-CFM-016A)", () => {
  const JOIN = `?join=${JOIN_CODE}`;
  const joinCard = (page: EntriesPage) => page.$("#join-team") as HTMLElement | null;
  const cardText = (page: EntriesPage) => (joinCard(page)?.textContent ?? "").replace(/\s+/g, " ");
  const lookups = (page: EntriesPage) => page.requests.filter((r) => r.url.includes("/by-code/"));
  async function visit(world: World, options: { auth?: unknown; token?: string; search?: string } = {}): Promise<EntriesPage> {
    const page = openMemberPage({ auth: options.auth ?? signedIn(SAM, "Sam"), token: options.token, transport: transportOf(world), search: options.search ?? JOIN });
    await page.settle(() => !!joinCard(page), "the join card");
    return page;
  }

  it("30. signed out, the link asks the person to sign in and nothing is looked up; after sign-in the team's name appears first on the page, from exactly one lookup — and nothing is sent", async () => {
    const world = newWorld(memberBase());
    const page = openMemberPage({ auth: SIGNED_OUT, transport: transportOf(world), search: JOIN });
    await page.settle(() => page.text().includes("Sign in with URBANO to see this team and ask to join it."), "the sign-in message");
    await page.idle(60);
    expect(page.requests.filter((r) => r.url.includes("/lifetime-"))).toEqual([]);
    await page.switchSession(signedIn(SAM, "Sam"), "token-sam");
    await page.settle(() => !!joinCard(page), "the join card");
    expect(joinCard(page)!.querySelector(".ce-join-name")!.textContent).toBe("Los Halcones");
    expect(lookups(page).map((r) => [r.method, r.url, r.token(), r.cache])).toEqual([["GET", `${API}/lifetime-teams/by-code/${JOIN_CODE}`, "token-sam", "no-store"]]);
    expect(writesOf(page)).toEqual([]);
    expect((page.$("#team-entries-host") as HTMLElement).nextElementSibling?.textContent).toBe("Competitions");
    page.close();
  });

  it("31. only the button asks: exactly the person's own membership request, with their token; then the card and the inbox say what the server holds", async () => {
    const world = newWorld(memberBase());
    world.after["ask-to-join"] = () => { world.offers = [offer({ direction: "OUTGOING", counterparty: null })]; };
    const page = await visit(world, { token: "token-sam" });
    expect(cardText(page)).toContain("You are not on this team, and opening this link has not changed that.");
    await press(page, button(page, "Ask to join"));
    expect(writesOf(page).map((r) => ({ url: r.url, body: r.json(), token: r.token() }))).toEqual([{ url: `${API}/lifetime-teams/${TEAM_A}/memberships`, body: { gamingMemberId: SAM }, token: "token-sam" }]);
    expect(status(page).textContent).toBe("Your request was sent. A captain or sub-captain of the team answers it.");
    expect(cardText(page)).toContain("You have asked to join.");
    expect(button(page, "Ask to join")).toBeNull();
    expect(page.$("#team-invitations")!.textContent).toContain("You asked to join Los Halcones.");
    page.close();
  });

  it("32. the card says where the person already stands — on the team, asked, invited — and offers no second request; an invalid or unreadable link offers none either", async () => {
    const cases: Array<[string, (w: World) => void, string]> = [
      ["already on the team", (w) => { w.teams = [team({ role: "MEMBER" })]; }, "You are on this team."],
      ["a request waiting", (w) => { w.offers = [offer({ direction: "OUTGOING", counterparty: null })]; }, "You have asked to join."],
      ["an invitation waiting", (w) => { w.offers = [offer()]; }, "This team has invited you. Answer the invitation below."],
      ["an invalid link", (w) => { w.joinTeam = null; }, "This team link is not valid."],
      ["a lookup that failed", (w) => { w.read.join = { status: 500, json: { error: "This could not be completed right now. Try again." } }; }, "This could not be loaded right now."],
      ["a lookup answered with something else", (w) => { w.read.join = { status: 200, json: { team: { lifetimeTeamId: "nope", name: "X" } } }; }, "This could not be loaded right now."],
    ];
    for (const [label, arrange, said_] of cases) {
      const world = newWorld(memberBase());
      arrange(world);
      const page = await visit(world);
      expect(cardText(page), label).toContain(said_);
      expect(button(page, "Ask to join"), label).toBeNull();
      expect(button(page, "Close the link"), label).not.toBeNull();
      page.close();
    }
    // a request to ANOTHER team, or an offer of the sub-captain seat, is not a standing in this one
    const other = newWorld(memberBase());
    other.offers = [offer({ direction: "OUTGOING", counterparty: null, team: { lifetimeTeamId: TEAM_B, publicCode: "TEAMCODE_B_bbbbbbbbbbbb", name: "Los Pumas" } }), offer({ offerId: OFFER_2, kind: "LEADERSHIP" })];
    const page = await visit(other);
    expect(button(page, "Ask to join")).not.toBeNull();
    page.close();
  });

  it("33. the server's refusal of a request is shown as it said it", async () => {
    const world = newWorld(memberBase());
    world.write["ask-to-join"] = () => ({ status: 409, json: { error: "A person may belong to at most two teams at once. Leave one first." } });
    const page = await visit(world);
    await press(page, button(page, "Ask to join"));
    expect(status(page).textContent).toBe("A person may belong to at most two teams at once. Leave one first.");
    expect(status(page).className).toContain("error");
    page.close();
  });

  it("34. closing the link removes it — and only it — from the address, and the next view neither looks it up nor shows it", async () => {
    const world = newWorld(memberBase());
    const page = await visit(world, { search: `${JOIN}&utm=x` });
    page.click(button(page, "Close the link"));
    await page.settle(() => !!page.$("#team-entries-toggle") && !joinCard(page), "the page without the link");
    expect(page.win.location.search).toBe("?utm=x");
    expect(lookups(page)).toHaveLength(1);
    page.close();
  });

  it("35. the link stays while the person moves between the list and a competition", async () => {
    const world = newWorld(memberBase());
    const page = await visit(world);
    page.click((page.$$("button.team-row") as HTMLElement[])[0]);
    await page.settle(() => !!page.$("#registration-status") && !!joinCard(page), "the competition with the card");
    expect(new URLSearchParams(page.win.location.search).get("join")).toBe(JOIN_CODE);
    page.click(page.$("#back-to-list"));
    await page.settle(() => !page.$("#registration-status") && !!joinCard(page), "the list with the card");
    expect(page.win.location.search).toBe(JOIN);
    page.close();
  });

  it("36. a value that is not a team code is ignored — no lookup, no card — and with no competition at all a real link still works", async () => {
    for (const search of ["?join=abc", `?join=${JOIN_CODE}x`, "?join=%22%3E%3Cscript%3E"]) {
      const page = openMemberPage({ auth: signedIn(SAM, "Sam"), transport: transportOf(newWorld(memberBase())), search });
      await page.settle(() => !!page.$(REGION), "the surface");
      expect(joinCard(page), search).toBeNull();
      expect(lookups(page), search).toEqual([]);
      page.close();
    }
    const world = newWorld(memberBase({ list: [] }));
    const page = await visit(world);
    expect(page.text()).toContain("No competitions have been created yet");
    expect(joinCard(page)!.querySelector(".ce-join-name")!.textContent).toBe("Los Halcones");
    page.close();
    // without a link the empty catalog is exactly as before: no team surface
    const none = openMemberPage({ auth: signedIn(SAM, "Sam"), transport: transportOf(newWorld(memberBase({ list: [] }))), search: "" });
    await none.settle(() => none.text().includes("No competitions have been created yet"), "the empty list");
    await none.idle(60);
    expect(none.$("#team-entries-host")).toBeNull();
    expect(none.requests.filter((r) => r.url.includes("/lifetime-"))).toEqual([]);
    none.close();
  });

  it("37. a session change drops the card with the rest; an answer for the previous member that arrives late is never shown", async () => {
    const world = newWorld(memberBase());
    const gate = defer<any>();
    let first = true;
    world.read.join = () => { if (first) { first = false; return gate.promise; } return { status: 200, json: { team: { lifetimeTeamId: TEAM_A, name: "Los Halcones" } } }; };
    const page = openMemberPage({ auth: signedIn(SAM, "Sam"), token: "token-sam", transport: transportOf(world), search: JOIN });
    await page.settle(() => lookups(page).length === 1, "the first lookup");
    await page.switchSession(signedIn(LEE, "Lee"), "token-lee");
    await page.settle(() => !!joinCard(page), "the card for the next member");
    gate.resolve({ status: 200, json: { team: { lifetimeTeamId: TEAM_B, name: "PREVIOUS ANSWER" } } });
    await page.idle(80);
    expect(page.text()).not.toContain("PREVIOUS ANSWER");
    expect(lookups(page).map((r) => r.token())).toEqual(["token-sam", "token-lee"]);
    await press(page, button(page, "Ask to join"));
    expect(writesOf(page).map((r) => [r.json(), r.token()])).toEqual([[{ gamingMemberId: LEE }, "token-lee"]]);
    page.close();
  });

  it("38. a hostile team name from a link is literal text; a page whose script did not load stays as it was", async () => {
    const world = newWorld(memberBase());
    world.joinTeam = { lifetimeTeamId: TEAM_A, name: HOSTILE };
    const page = await visit(world);
    expect(joinCard(page)!.querySelector(".ce-join-name")!.textContent).toBe(HOSTILE);
    expect(joinCard(page)!.querySelector("img, script")).toBeNull();
    expect(XSS(page)).toBeUndefined();
    page.close();
    const bare = openMemberPage({ auth: signedIn(SAM, "Sam"), transport: transportOf(newWorld(memberBase())), search: JOIN, script: false });
    await bare.settle(() => bare.text().includes("Competitions") && !bare.text().includes("Loading Competitions"), "the page");
    await bare.idle(60);
    expect(bare.requests.filter((r) => r.url.includes("/lifetime-"))).toEqual([]);
    expect(bare.$("#team-entries-host")).toBeNull();
    bare.close();
  });

  it("39. a captain gets their team's link — this page and its team code, nothing else — and can copy it; a sub-captain and a member get no link", async () => {
    const copied: string[] = [];
    const page = await member(captainWorld({ entry: null }), { search: `?c=${CODE}&t=${CODE}` });
    Object.defineProperty(page.win, "isSecureContext", { value: true, configurable: true });
    Object.defineProperty(page.win.navigator, "clipboard", { value: { writeText: async (text: string) => { copied.push(text); } }, configurable: true });
    const input = page.$(`${REGION} .ce-share input`) as HTMLInputElement;
    expect(input.value).toBe(`http://localhost/competitions.html?join=${team().publicCode}`);
    expect(input.readOnly).toBe(true);
    expect(page.$(`${REGION} .ce-share`)!.textContent).toContain("Anyone signed in who has this link can see the team's name and ask to join");
    page.click(button(page, "Open"));
    await press(page, button(page, "Copy the link"));
    await page.settle(() => status(page).textContent === "Link copied.", "copied");
    expect(copied).toEqual([input.value]);
    // without a clipboard the link is selected for copying by hand
    Object.defineProperty(page.win.navigator, "clipboard", { value: undefined, configurable: true });
    page.click(button(page, "Copy the link"));
    await page.settle(() => status(page).textContent === "Select the link above and copy it.", "select");
    expect([input.selectionStart, input.selectionEnd]).toEqual([0, input.value.length]);
    page.close();
    for (const role of ["SUB_CAPTAIN", "MEMBER"]) {
      const other = await member(captainWorld({ entry: null, teams: [team({ role })] }));
      expect(other.$(`${REGION} .ce-share`), role).toBeNull();
      expect(button(other, "Copy the link"), role).toBeNull();
      other.close();
    }
  });
});

// ---------------------------------------------------------------------------------------------------------------------------------------------
describe("choosing players to propose, by display name (UG-CR-GATE-CFM-016A)", () => {
  const PICK_URL = `${API}/${CID}/lifetime-entries/${ENTRY_A}/roster-candidates`;
  const reads = (page: EntriesPage) => page.requests.filter((r) => r.url === PICK_URL);
  const names = (page: EntriesPage) => (page.$$(`${REGION} .ce-choice`) as HTMLElement[]).map((l) => (l.textContent ?? "").trim());
  const box = (page: EntriesPage, name: string) => (page.$$(`${REGION} .ce-choice`) as HTMLElement[]).find((l) => (l.textContent ?? "").trim().startsWith(name))!.querySelector("input") as HTMLInputElement;
  const people = [{ gamingMemberId: LEE, displayName: "Lee" }, { gamingMemberId: PAT, displayName: "Pat" }, { gamingMemberId: SAM, displayName: "Sam" }];
  async function open_(world: World, options: { auth?: unknown; token?: string } = {}) {
    const page = await member(world, options);
    await press(page, button(page, "Choose players to propose"));
    return page;
  }

  it("40. choosing reads the addressed entry once with this session's token and lists display names; nothing is sent until the leader proposes, then exactly the chosen people", async () => {
    const world = captainWorld();
    world.candidates = people;
    world.after.propose = () => { world.ledEntries = [ledEntry({ claims: [ledClaim()] })]; };
    const page = await open_(world, { token: "token-pat" });
    expect(reads(page).map((r) => [r.method, r.token(), r.cache])).toEqual([["GET", "token-pat", "no-store"]]);
    expect(names(page)).toEqual(["Lee", "Pat (you)", "Sam"]);
    expect(said(page)).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i);
    expect(regionOf(page)!.outerHTML).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i);
    expect(writesOf(page)).toEqual([]);
    page.click(button(page, "Propose the chosen players"));
    await page.idle();
    expect(status(page).textContent).toBe("Choose at least one player.");
    expect(writesOf(page)).toEqual([]);
    page.click(box(page, "Lee"));
    page.click(box(page, "Pat"));
    await press(page, button(page, "Propose the chosen players"));
    expect(writesOf(page).map((r) => ({ url: r.url, body: r.json(), token: r.token() }))).toEqual([{ url: `${API}/${CID}/lifetime-entries/${ENTRY_A}/roster-claims`, body: { gamingMemberIds: [LEE, PAT] }, token: "token-pat" }]);
    expect(status(page).textContent).toBe("Proposed. Each person accepts or declines for themselves.");
    expect(page.$(`${REGION} .ce-choices`)).toBeNull();
    expect(button(page, "Choose players to propose")).not.toBeNull();
    page.close();
  });

  it("41. nobody left to propose is said, with no propose button; Cancel closes the list and returns to the button; a sub-captain chooses too; a member has no picker", async () => {
    const world = captainWorld({ teams: [team({ role: "SUB_CAPTAIN" })] });
    const page = await open_(world);
    expect(page.$(`${REGION} .ce-no-candidates`)!.textContent).toBe("Everyone on the team already has an open proposal or a place on this entry.");
    expect(button(page, "Propose the chosen players")).toBeNull();
    page.click(button(page, "Cancel"));
    expect(page.$(`${REGION} .ce-choices`)).toBeNull();
    expect(page.doc.activeElement).toBe(button(page, "Choose players to propose"));
    page.close();
    const plain = await member(captainWorld({ teams: [team({ role: "MEMBER" })] }));
    expect(button(plain, "Choose players to propose")).toBeNull();
    plain.close();
  });

  it("42. a refused read shows the server's sentence and the surface is read again: a former leader is left with no entry, no names and no picker", async () => {
    const world = captainWorld();
    world.read.candidates = () => {
      world.teams = [team({ role: "MEMBER" })];
      world.ledEntries = [];
      return { status: 404, json: { error: "That entry could not be found." } };
    };
    const page = await open_(world);
    expect(status(page).textContent).toBe("That entry could not be found.");
    expect(page.$(`${REGION} .ce-entry-card`)).toBeNull();
    expect(page.$(`${REGION} .ce-choices`)).toBeNull();
    page.close();
  });

  it("43. an answer that arrives after the session changed is discarded: none of the previous team's names appear for the next person", async () => {
    const world = captainWorld();
    const gate = defer<any>();
    world.read.candidates = () => gate.promise;
    const page = await member(world, { token: "token-pat" });
    page.click(button(page, "Choose players to propose"));
    await page.settle(() => reads(page).length === 1, "the read");
    const next = newWorld(memberBase());
    world.teams = next.teams; world.ledEntries = next.ledEntries;
    await page.switchSession(signedIn(SAM, "Sam"), "token-sam");
    await page.settle(() => !!page.$(REGION), "the next member's surface");
    gate.resolve({ status: 200, json: { members: [{ gamingMemberId: LEE, displayName: "PRIVATE NAME" }] } });
    await page.idle(80);
    expect(page.text()).not.toContain("PRIVATE NAME");
    expect(page.$(`${REGION} .ce-choices`)).toBeNull();
    page.close();
  });

  it("44. a chosen player is proposed for nobody if the signed-in member changed before any event said so; a refusal is shown as said and names are text", async () => {
    const world = captainWorld();
    world.candidates = [{ gamingMemberId: LEE, displayName: HOSTILE }, { gamingMemberId: SAM, displayName: HOSTILE_BREAKOUT }];
    const page = await open_(world);
    expect(names(page)).toEqual([HOSTILE, HOSTILE_BREAKOUT]);
    expect(regionOf(page)!.querySelector("img, script")).toBeNull();
    expect(XSS(page)).toBeUndefined();
    world.write.propose = () => ({ status: 409, json: { error: "The entries of this competition are frozen and can no longer change." } });
    page.click(box(page, HOSTILE));
    await press(page, button(page, "Propose the chosen players"));
    expect(status(page).textContent).toBe("The entries of this competition are frozen and can no longer change.");
    await press(page, button(page, "Choose players to propose"));
    page.click(box(page, HOSTILE));
    page.changeSessionSilently(signedIn(SAM, "Sam"), "token-sam");
    page.click(button(page, "Propose the chosen players"));
    await page.idle(80);
    expect(writesOf(page)).toHaveLength(1);
    expect(page.$(REGION)).toBeNull();
    page.close();
  });

  it("45. a list read before another action is not offered after it, and a malformed answer lists nobody", async () => {
    const world = captainWorld({ claims: [ledClaim({ status: "ACCEPTED" })] });
    world.candidates = people;
    const page = await open_(world);
    await press(page, button(page, "Remove from the roster"));
    expect(page.$(`${REGION} .ce-choices`)).toBeNull();
    world.read.candidates = { status: 200, json: { members: [{ gamingMemberId: "nope", displayName: "Bad" }, { gamingMemberId: LEE, displayName: " " }] } };
    await press(page, button(page, "Choose players to propose"));
    expect(names(page)).toEqual([]);
    expect(page.$(`${REGION} .ce-no-candidates`)).not.toBeNull();
    world.read.candidates = { status: 200, json: { members: "everyone" } };
    await press(page, button(page, "Cancel"));
    await press(page, button(page, "Choose players to propose"));
    expect(status(page).textContent).toBe("The server's answer could not be understood; what is shown is what the server holds now.");
    expect(page.$(`${REGION} .ce-choices`)).toBeNull();
    page.close();
  });
});

// ---------------------------------------------------------------------------------------------------------------------------------------------
describe("V1 and the page's existing behaviour are untouched", () => {
  /** Everything the page shows and asks for OUTSIDE the surface this gate adds. */
  async function outside(options: { script: boolean; lifetime: "empty" | "down"; search?: string; view?: ReturnType<typeof competitionView> }) {
    const world = newWorld((r) => {
      const url = r.url.replace(/\?.*$/, "");
      if (/\/teams\/[^/]+\/join-requests$/.test(url)) return { status: 200, json: { joinRequests: [] } };
      return memberBase({ view: options.view })(r) as any;
    });
    if (options.lifetime === "down") for (const name of ["offers", "teams", "ledEntries", "claims"]) world.read[name] = { status: 503, json: { error: "unavailable" } };
    const page = openMemberPage({ auth: signedIn(PAT), transport: transportOf(world), search: options.search ?? "", script: options.script });
    await page.settle(() => !page.text().includes("Loading Competitions"), "the page");
    await page.idle(160);
    page.$("#team-entries-host")?.remove();
    const snapshot = {
      html: page.doc.body.innerHTML.replace(/<script[\s\S]*?<\/script>/g, "").replace(/<style[\s\S]*?<\/style>/g, ""),
      controls: page.controls(),
      requests: page.requests.filter((r) => !LIFETIME_READ.test(r.url)).map((r) => `${r.method} ${r.url}`),
    };
    page.close();
    return snapshot;
  }

  const SCENARIOS: Array<[string, { search?: string; view?: ReturnType<typeof competitionView> }]> = [
    ["the list of competitions", {}],
    ["an unregistered member's competition", { search: `?c=${CODE}`, view: competitionView({ registered: false }) }],
    ["a registered member without a team", { search: `?c=${CODE}` }],
    ["a competition that runs the V1 team flow", { search: `?c=${CODE}`, view: competitionView({ v1Teams: true }) }],
    ["a draft competition", { search: `?c=${CODE}`, view: competitionView({ state: "DRAFT", registered: false }) }],
  ];
  for (const [label, scenario] of SCENARIOS) {
    it(`27. ${label}: the page outside the new surface — its markup, its controls and the requests it makes — is identical with and without the script, whether the lifetime reads answer or fail`, async () => {
      const base = await outside({ script: false, lifetime: "empty", ...scenario });
      const withEmpty = await outside({ script: true, lifetime: "empty", ...scenario });
      const withDown = await outside({ script: true, lifetime: "down", ...scenario });
      for (const other of [withEmpty, withDown]) {
        expect(other.controls).toEqual(base.controls);
        expect(other.requests).toEqual(base.requests);
        expect(other.html).toBe(base.html);
      }
    });
  }

  it("28. a script that did not load leaves the page working exactly as before: no host, no error, no lifetime request", async () => {
    const world = newWorld(memberBase());
    world.offers = [offer()];
    const page = openMemberPage({ auth: signedIn(PAT), transport: transportOf(world), search: `?c=${CODE}`, script: false });
    await page.settle(() => !!page.$("#registration-status"), "the page");
    await page.idle(80);
    expect(page.$("#team-entries-host")).toBeNull();
    expect(page.requests.filter((r) => LIFETIME_READ.test(r.url))).toEqual([]);
    expect(page.$("#btn-create-team")).not.toBeNull(); // V1's own controls are all there
    page.close();
  });

  it("29. the shipped pages load the script and nothing in it can write markup", async () => {
    const { MEMBER_HTML, ADMIN_HTML, ENTRIES_SOURCE } = await import("./helpers/competitionEntriesPageHarness");
    expect(MEMBER_HTML).toContain('<script src="/competitionsEntries.js"></script>');
    expect(ADMIN_HTML).toContain('<script src="/competitionsEntries.js"></script>');
    expect(ENTRIES_SOURCE).not.toMatch(/innerHTML|outerHTML|insertAdjacentHTML|document\.write|\beval\(|new Function|localStorage|sessionStorage|document\.cookie|history\.(push|replace)State/);
  });
});
