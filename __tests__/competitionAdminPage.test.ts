import { describe, expect, it } from "vitest";
import { JSDOM } from "jsdom";
import { readFileSync } from "node:fs";
import path from "node:path";
import { openAdminPage, openMemberPage } from "./helpers/competitionAdminPageHarness";

/**
 * UG-CR-GATE-100 — the organizer page (/competitions-admin.html) and the member competition page (/competitions.html), run whole in jsdom as shipped.
 *
 * Proves: the default organizer experience reads ONLY the organizer-only administrative source; with no active organizer authority (or a failed,
 * silent or malformed source) it fails closed and shows no competition information and no creation control; the Create Competition form
 * appears only after the server answers exactly `true` for the OPERATIONAL relationship; scorekeeper access is contextual — offered by the
 * member competition page for ONE addressed competition, resolved to that exact id, re-confirmed by the server, and never enumerated from the
 * organizer page; a tampered selector cannot open anything the source did not return; and the public wording is pinned to the four accepted labels.
 */

const ADMIN_HTML = readFileSync(path.join(process.cwd(), "public/competitions-admin.html"), "utf8");
const BECOME_HTML = readFileSync(path.join(process.cwd(), "public/become-a-host.html"), "utf8");
const INTENT_SOURCE = readFileSync(path.join(process.cwd(), "public/competitionsIntent.js"), "utf8");
const LIFECYCLE_SOURCE = readFileSync(path.join(process.cwd(), "public/competitionsLifecycle.js"), "utf8");

const ADMIN_SOURCE = "/api/gaming/competitions/administration";
const GENERAL_LIST = "/api/gaming/competitions";
const CODE = "AbCdEfGhIjKlMnOpQrStUv";                                  // an opaque 22-character public code
const CID = "11111111-1111-4111-8111-111111111111";
const SCORER_ROUTE = `/api/gaming/competitions/${CID}/scorekeeper-administration`;
const NO_OPERATION = { createCompetition: false };

interface Call { url: string; method: string }
type Reply = { status: number; json?: unknown };
type Responder = (call: Call) => Reply | undefined;

const SIGNED_IN = { status: "authenticated", email: "a@example.com", gamingMemberId: "m-1", displayName: "Pat Organizer" };

async function loadAdmin(opts: { auth?: unknown; respond: Responder; search?: string }) {
  // The shipped page on the shared harness: its transport may answer synchronously, or never (a silent network).
  const page = await openAdminPage({
    auth: opts.auth ?? SIGNED_IN, search: opts.search,
    transport: (request) => opts.respond({ url: request.url, method: request.method }) ?? { status: 404, json: { error: "unexpected request" } },
  });
  const doc = page.doc;
  const settle = page.settle;
  const visible = (el: Element | null): boolean => {
    for (let node: Element | null = el; node; node = node.parentElement) {
      if (!el) return false;
      if ((node as HTMLElement).hidden) return false;
      if ((node as HTMLElement).style && (node as HTMLElement).style.display === "none") return false;
    }
    return !!el;
  };
  return { win: page.win, doc, calls: page.requests as Call[], settle, visible, text: page.text, controls: page.controls, fireAuthChange: page.fireAuthChange, close: page.close };
}

const FIXTURE_ROLES = ["SEMIFINAL_1", "SEMIFINAL_2", "FINAL"] as const;

function viewFor(competitionId: string, name: string, state = "PUBLISHED") {
  return {
    view: {
      competition: { competitionId, publicCode: `${competitionId}-code`, activityKey: "SOCCER_5V5", name, organizerGamingMemberId: "someone", state, cancelledReason: null, createdAt: "x", publishedAt: null },
      teams: [1, 2, 3, 4].map((n) => ({ competitionTeamId: `t${n}`, name: `Team ${n}`, captainDisplayName: `Captain ${n}`, publicCode: `t${n}-code` })),
      pendingTeamProposals: [], rejectedTeamProposals: [],
      fixtures: FIXTURE_ROLES.map((role, i) => ({
        fixture: { competitionFixtureId: `fx-${i + 1}`, competitionId, fixtureRole: role, state: "CHECKIN_OPEN", scheduledAt: "2026-11-01T10:00:00Z", teamACompetitionTeamId: "t1", teamBCompetitionTeamId: "t2", scorekeeperGamingMemberId: i === 0 ? "m-1" : null },
        myRoster: null, opponentRosterDeclared: false,
      })),
      isOrganizer: true,
    },
  };
}

const ADMIN_DETAIL = { fixture: {}, teamARoster: null, teamBRoster: null, checkIns: [], attestations: [], evidence: null, goalEvents: [], assistEvents: [], shootout: null, disputes: [], finalization: null, eligibleMembers: [], displayNames: {} };

function respondWith(entries: unknown, extra: Responder = () => undefined, operations: unknown = NO_OPERATION): Responder {
  return (call) => {
    if (call.url === ADMIN_SOURCE) return { status: 200, json: { competitions: entries, operations } };
    const detail = call.url.match(/^\/api\/gaming\/competitions\/(c-[a-z0-9-]+)$/);
    if (detail) return { status: 200, json: viewFor(detail[1], `Name of ${detail[1]}`) };
    if (call.url.endsWith("/admin-detail")) return { status: 200, json: ADMIN_DETAIL };
    return extra(call);
  };
}

describe("fail closed: no active organizer authority, or a source that fails", () => {
  it("an empty source shows ONE truthful sentence and the two other entries — no selector, no detail, no competition information", async () => {
    const page = await loadAdmin({ respond: respondWith([], (c) => (c.url === GENERAL_LIST ? { status: 200, json: { competitions: [{ competitionId: "c-secret", name: "SECRET OPEN COMPETITION", state: "TEAM_REGISTRATION_OPEN" }] } } : undefined)) });
    await page.settle(() => (page.doc.getElementById("admin-gate")?.textContent ?? "").length > 0, "the closed state");
    const gate = page.doc.getElementById("admin-gate")!;
    expect(gate.textContent).toContain("You do not currently organize any competition, so there is nothing to administer here.");
    expect([...gate.querySelectorAll("a")].map((a) => [a.textContent, a.getAttribute("href")])).toEqual([["Explore Competitions", "/competitions.html"], ["Apply to Host Competitions", "/become-a-host.html"]]);
    expect(page.visible(page.doc.getElementById("select-section"))).toBe(false);
    expect(page.visible(page.doc.getElementById("competition-detail"))).toBe(false);
    expect(page.doc.querySelectorAll("#comp-select option")).toHaveLength(0);
    expect(page.text()).not.toContain("SECRET OPEN COMPETITION");
    // The general member-discovery list is never requested, so even a source that would answer is never consulted.
    expect(page.calls.filter((c) => c.url === GENERAL_LIST && c.method === "GET")).toEqual([]);
    expect(page.calls.map((c) => c.url)).toEqual([ADMIN_SOURCE]);
    page.close();
  });

  it("before the source answers, nothing is shown at all (first paint is closed)", async () => {
    let release: (() => void) | undefined;
    const gate = new Promise<void>((r) => { release = r; });
    const dom = new JSDOM(ADMIN_HTML, {
      url: "http://localhost/competitions-admin.html", runScripts: "dangerously", pretendToBeVisual: true,
      beforeParse(window) {
        const w = window as unknown as Record<string, any>;
        w.UrbanoAuth = { attachSignInButton: () => {}, getState: async () => SIGNED_IN, getAccessToken: async () => "t", onAuthStateChange: async () => () => {} };
        w.fetch = async () => { await gate; return { status: 200, json: async () => ({ competitions: [] }) }; };
        window.eval(LIFECYCLE_SOURCE);
      },
    });
    await new Promise((r) => setTimeout(r, 30));
    const doc = dom.window.document;
    expect((doc.getElementById("select-section") as HTMLElement).hidden).toBe(true);
    expect((doc.getElementById("create-section") as HTMLElement).hidden).toBe(true);
    expect(doc.querySelectorAll("#comp-select option")).toHaveLength(0);
    expect((doc.getElementById("competition-detail") as HTMLElement).style.display).toBe("none");
    release!();
    dom.window.close();
  });

  it.each([
    ["401 (a session that has lapsed)", { status: 401, json: { error: "A valid Authorization header for an authenticated Gaming Member is required." } }, "A valid Authorization header"],
    ["503 (Competitions unavailable)", { status: 503, json: { error: "URBANO Gaming Competitions is temporarily unavailable while its database is being prepared." } }, "temporarily unavailable"],
    ["500", { status: 500, json: { error: "Failed to load your competitions." } }, "Failed to load your competitions."],
    ["200 with a body that is not a list", { status: 200, json: { competitions: "nope" } }, "Failed to load your competitions."],
    ["200 with no body", { status: 200 }, "Failed to load your competitions."],
  ])("a failing source — %s — shows its truthful message and nothing else", async (_label, reply, expected) => {
    const page = await loadAdmin({ respond: (c) => (c.url === ADMIN_SOURCE ? (reply as Reply) : undefined) });
    await page.settle(() => (page.doc.getElementById("admin-gate")?.textContent ?? "").length > 0, "the failure message");
    expect(page.doc.getElementById("admin-gate")!.textContent).toContain(expected);
    expect(page.doc.getElementById("admin-gate")!.querySelectorAll("a")).toHaveLength(0);
    expect(page.visible(page.doc.getElementById("select-section"))).toBe(false);
    expect(page.visible(page.doc.getElementById("competition-detail"))).toBe(false);
    page.close();
  });

  it("a signed-out visitor sees no administrative section and no source is requested", async () => {
    const page = await loadAdmin({ auth: { status: "unauthenticated" }, respond: () => ({ status: 500 }) });
    await page.settle(() => page.doc.getElementById("auth-status")?.textContent === "Not signed in.", "the signed-out state");
    expect(page.visible(page.doc.getElementById("admin-sections"))).toBe(false);
    expect(page.calls).toEqual([]);
    page.close();
  });
});

describe("the default experience: the competitions the caller actively organizes, and nothing else", () => {
  const entries = [
    { competitionId: "c-mine", name: "My Cup", state: "PUBLISHED", access: "ORGANIZER" },
    { competitionId: "c-draft", name: "Draft Cup", state: "DRAFT", access: "ORGANIZER" },
  ];

  async function open(competitionId: string) {
    const page = await loadAdmin({ respond: respondWith(entries) });
    await page.settle(() => page.doc.querySelectorAll("#comp-select option").length === 2, "the selector");
    (page.doc.getElementById("comp-select") as HTMLSelectElement).value = competitionId;
    (page.doc.getElementById("btn-load-competition") as HTMLButtonElement).click();
    await page.settle(() => page.visible(page.doc.getElementById("competition-detail")), "the competition detail");
    return page;
  }

  it("lists each active competition by name and stage — one relationship, so no relationship label", async () => {
    const page = await loadAdmin({ respond: respondWith(entries) });
    await page.settle(() => page.doc.querySelectorAll("#comp-select option").length === 2, "the selector");
    expect([...page.doc.querySelectorAll("#comp-select option")].map((o) => o.textContent)).toEqual(["My Cup (In progress)", "Draft Cup (Not yet open)"]);
    page.close();
  });

  it("an organizer gets the organizer controls and every fixture", async () => {
    const page = await open("c-mine");
    expect(page.visible(page.doc.getElementById("organizer-only"))).toBe(true);
    expect(page.visible(page.doc.getElementById("scorekeeper-note"))).toBe(false);
    expect(page.doc.querySelectorAll("#fixtures-list .fixture-block")).toHaveLength(3);
    (page.doc.querySelector("#fixtures-list .btn-load-detail") as HTMLButtonElement).click();
    await page.settle(() => page.doc.querySelector("#fixtures-list fieldset") !== null, "the fixture detail");
    const legends = [...page.doc.querySelectorAll("#fixtures-list legend")].map((l) => l.textContent);
    expect(legends).toEqual(expect.arrayContaining(["Appoint Scorekeeper", "Submit Evidence (Scorekeeper)", "Correct Fixture (Organizer)", "Close Fixture (Organizer)"]));
    page.close();
  });

  it("an entry that is not an ORGANIZER entry is ignored — a stale or hostile SCOREKEEPER entry produces no selector, no detail and no name", async () => {
    const page = await loadAdmin({
      respond: respondWith([
        { competitionId: "c-scored", name: "Their Cup", state: "PUBLISHED", access: "SCOREKEEPER", scorekeeperFixtureIds: ["fx-2"] },
        { competitionId: "c-noaccess", name: "No Access Cup", state: "PUBLISHED" },
        { competitionId: "c-lower", name: "Lower Cup", state: "PUBLISHED", access: "organizer" },
        { name: "No Id Cup", state: "PUBLISHED", access: "ORGANIZER" },
      ]),
    });
    await page.settle(() => (page.doc.getElementById("admin-gate")?.textContent ?? "").length > 0, "the closed state");
    expect(page.visible(page.doc.getElementById("select-section"))).toBe(false);
    expect(page.doc.querySelectorAll("#comp-select option")).toHaveLength(0);
    for (const name of ["Their Cup", "No Access Cup", "Lower Cup", "No Id Cup"]) expect(page.text()).not.toContain(name);
    page.close();
  });

  it("a selector value the source did not return opens nothing (no request is made for it)", async () => {
    const page = await loadAdmin({ respond: respondWith(entries) });
    await page.settle(() => page.doc.querySelectorAll("#comp-select option").length === 2, "the selector");
    const select = page.doc.getElementById("comp-select") as HTMLSelectElement;
    const forged = page.doc.createElement("option");
    forged.value = "c-not-mine";
    forged.textContent = "forged";
    select.appendChild(forged);
    select.value = "c-not-mine";
    (page.doc.getElementById("btn-load-competition") as HTMLButtonElement).click();
    await page.settle(() => (page.doc.getElementById("msg-load")?.textContent ?? "") === "Select a competition.", "the refusal");
    expect(page.calls.some((c) => c.url.includes("c-not-mine"))).toBe(false);
    expect(page.visible(page.doc.getElementById("competition-detail"))).toBe(false);
    page.close();
  });

  it("hostile competition names are rendered as text, never as markup", async () => {
    const hostile = '<img src=x onerror="window.__xss=1">';
    const page = await loadAdmin({ respond: respondWith([{ competitionId: "c-evil", name: hostile, state: "PUBLISHED", access: "ORGANIZER" }]) });
    await page.settle(() => page.doc.querySelectorAll("#comp-select option").length === 1, "the selector");
    expect(page.doc.querySelector("#comp-select option")!.textContent).toContain(hostile);
    expect(page.doc.querySelectorAll("#comp-select img")).toHaveLength(0);
    expect((page.win as unknown as Record<string, unknown>).__xss).toBeUndefined();
    page.close();
  });

  it("after creating a competition the page reloads from the administrative source, never from the general list", async () => {
    let created = false;
    const page = await loadAdmin({
      respond: (call) => {
        if (call.url === ADMIN_SOURCE) return { status: 200, json: { competitions: created ? [{ competitionId: "c-new", name: "Fresh", state: "DRAFT", access: "ORGANIZER" }] : entries, operations: { createCompetition: true } } };
        if (call.url === GENERAL_LIST && call.method === "POST") { created = true; return { status: 201, json: { competition: { competitionId: "c-new" } } }; }
        return undefined;
      },
    });
    await page.settle(() => page.doc.querySelectorAll("#comp-select option").length === 2, "the selector");
    (page.doc.getElementById("c-name") as HTMLInputElement).value = "Fresh";
    (page.doc.getElementById("btn-create-competition") as HTMLButtonElement).click();
    await page.settle(() => page.doc.querySelectorAll("#comp-select option").length === 1, "the reloaded selector");
    expect(page.calls.filter((c) => c.url === GENERAL_LIST && c.method === "GET")).toEqual([]);
    expect(page.calls.filter((c) => c.url === ADMIN_SOURCE)).toHaveLength(2);
    page.close();
  });
});

describe("the scorekeeper experience: contextual to ONE addressed competition, never enumerated", () => {
  const FIXTURES = [{ competitionFixtureId: "fx-2", fixtureRole: "SEMIFINAL_2", state: "CHECKIN_OPEN", scheduledAt: "2026-11-01T11:00:00Z", teamACompetitionTeamId: "t1", teamBCompetitionTeamId: "t2" }];
  const GOOD = { competition: { competitionId: CID, name: "Their Cup", state: "PUBLISHED" }, teams: [{ competitionTeamId: "t1", name: "Alpha" }, { competitionTeamId: "t2", name: "Bravo" }], fixtures: FIXTURES };

  function responder(over: { resolve?: Reply; scorer?: Reply } = {}): Responder {
    return (call) => {
      if (call.url.startsWith("/api/gaming/competitions/resolve")) return over.resolve ?? { status: 200, json: { competitionId: CID } };
      if (call.url === SCORER_ROUTE) return over.scorer ?? { status: 200, json: GOOD };
      if (call.url.endsWith("/admin-detail")) return { status: 200, json: ADMIN_DETAIL };
      return undefined;
    };
  }
  async function context(over: { resolve?: Reply; scorer?: Reply } = {}, search = `?c=${CODE}`) {
    return loadAdmin({ respond: responder(over), search });
  }
  const NOT_APPOINTED = "You are not currently appointed to score any fixture in this competition.";

  it("resolves the opaque code, hands that exact id to the bounded route, and asks nothing else — never the default source, never the general list", async () => {
    const page = await context();
    await page.settle(() => page.visible(page.doc.getElementById("competition-detail")), "the scorekeeper view");
    expect(page.calls.map((c) => c.url)).toEqual([`/api/gaming/competitions/resolve?c=${CODE}`, SCORER_ROUTE]);
    expect(page.calls.every((c) => c.method === "GET")).toBe(true);
    page.close();
  });

  it("shows that one competition and ONLY the fixture assigned to the caller — no selector, no organizer control, no creation control", async () => {
    const page = await context();
    await page.settle(() => page.visible(page.doc.getElementById("competition-detail")), "the scorekeeper view");
    expect(page.doc.getElementById("comp-title")!.textContent).toBe("Their Cup");
    expect(page.doc.getElementById("page-title")!.textContent).toBe("Competitions — Scorekeeping");
    expect(page.visible(page.doc.getElementById("scorekeeper-note"))).toBe(true);
    for (const id of ["organizer-only", "select-section", "create-section", "admin-gate", "btn-open-registration", "btn-close-registration", "btn-publish", "btn-open-cancel", "btn-create-competition", "comp-select", "table-teams"]) {
      expect(page.visible(page.doc.getElementById(id)), id).toBe(false);
    }
    const blocks = [...page.doc.querySelectorAll("#fixtures-list .fixture-block")];
    expect(blocks).toHaveLength(1);
    expect(blocks[0].querySelector("[data-fixture]")!.getAttribute("data-fixture")).toBe("fx-2");
    expect(blocks[0].textContent).toContain("Alpha vs Bravo");
    page.close();
  });

  it("offers only the accepted scorekeeping functions: a fixture's detail and Submit Evidence — nothing organizer-only", async () => {
    const page = await context();
    await page.settle(() => page.doc.querySelectorAll("#fixtures-list .btn-load-detail").length === 1, "the assigned fixture");
    expect(page.controls()).toEqual(["button[Load Fixture Detail]"]);
    (page.doc.querySelector("#fixtures-list .btn-load-detail") as HTMLButtonElement).click();
    await page.settle(() => page.doc.querySelector("#fixtures-list fieldset") !== null, "the fixture detail");
    expect([...page.doc.querySelectorAll("#fixtures-list legend")].map((l) => l.textContent)).toEqual(["Submit Evidence (Scorekeeper)"]);
    expect(page.doc.querySelectorAll("#fixtures-list .btn-appoint, #fixtures-list .btn-correct, #fixtures-list .btn-finalize, #fixtures-list .btn-forfeit, #fixtures-list .btn-void, #fixtures-list .btn-dispute")).toHaveLength(0);
    expect(page.calls.filter((c) => c.url.endsWith("/admin-detail")).map((c) => c.url)).toEqual(["/api/gaming/competitions/fixtures/fx-2/admin-detail"]);
    page.close();
  });

  it("organizer actions cannot run from this view even if a hidden control is clicked programmatically", async () => {
    const page = await context();
    await page.settle(() => page.visible(page.doc.getElementById("competition-detail")), "the scorekeeper view");
    for (const id of ["btn-open-registration", "btn-close-registration", "btn-publish", "btn-cancel-confirm", "btn-create-competition"]) (page.doc.getElementById(id) as HTMLButtonElement).click();
    await new Promise((r) => setTimeout(r, 40));
    expect(page.calls.filter((c) => c.method !== "GET")).toEqual([]);
    page.close();
  });

  it("hostile competition and team names are rendered as text, never as markup", async () => {
    const hostile = '<img src=x onerror="window.__xss=1">';
    const page = await context({ scorer: { status: 200, json: { ...GOOD, competition: { ...GOOD.competition, name: hostile }, teams: [{ competitionTeamId: "t1", name: hostile }, { competitionTeamId: "t2", name: "Bravo" }] } } });
    await page.settle(() => page.visible(page.doc.getElementById("competition-detail")), "the scorekeeper view");
    expect(page.doc.getElementById("comp-title")!.textContent).toBe(hostile);
    expect(page.doc.querySelectorAll("#competition-detail img")).toHaveLength(0);
    expect((page.win as unknown as Record<string, unknown>).__xss).toBeUndefined();
    page.close();
  });

  it.each([
    ["the code does not resolve (404)", { resolve: { status: 404, json: { error: "This link is no longer valid." } } }],
    ["the code resolves to no id", { resolve: { status: 200, json: {} } }],
    ["the code resolves to a non-string id", { resolve: { status: 200, json: { competitionId: 5 } } }],
    ["the resolve answer has no body", { resolve: { status: 200 } }],
  ])("a scorekeeper link that cannot be used (%s) opens nothing and never asks the scorekeeper route", async (_label, over) => {
    const page = await context(over as never);
    await page.settle(() => (page.doc.getElementById("admin-gate")?.textContent ?? "").length > 0, "the closed state");
    expect(page.doc.getElementById("admin-gate")!.textContent).toBe(NOT_APPOINTED);
    expect(page.controls()).toEqual([]);
    expect(page.calls.some((c) => c.url.includes("scorekeeper-administration"))).toBe(false);
    page.close();
  });

  it.each([
    ["the server says there is no such assignment (404): a wrong competition, or a removed or replaced appointment", { scorer: { status: 404, json: { error: "Scorekeeper access was not found for this competition." } } }, NOT_APPOINTED],
    ["a lapsed session (401)", { scorer: { status: 401, json: { error: "A valid Authorization header for an authenticated Gaming Member is required." } } }, "A valid Authorization header"],
    ["Competitions unavailable (503)", { scorer: { status: 503, json: { error: "temporarily unavailable" } } }, "temporarily unavailable"],
    ["an internal failure (500)", { scorer: { status: 500, json: { error: "Failed to load your scorekeeper assignment." } } }, NOT_APPOINTED],
    ["a 200 with no fixtures", { scorer: { status: 200, json: { ...GOOD, fixtures: [] } } }, NOT_APPOINTED],
    ["a 200 whose fixtures are malformed", { scorer: { status: 200, json: { ...GOOD, fixtures: [{ competitionFixtureId: 7 }] } } }, NOT_APPOINTED],
    ["a 200 with no competition", { scorer: { status: 200, json: { fixtures: FIXTURES, teams: [] } } }, NOT_APPOINTED],
    ["a 200 with no teams list", { scorer: { status: 200, json: { competition: GOOD.competition, fixtures: FIXTURES } } }, NOT_APPOINTED],
    ["a 200 with no body", { scorer: { status: 200 } }, NOT_APPOINTED],
  ])("when %s the page shows one truthful sentence — no competition name, no fixture, no control", async (_label, over, expected) => {
    const page = await context(over as never);
    await page.settle(() => (page.doc.getElementById("admin-gate")?.textContent ?? "").length > 0, "the closed state");
    expect(page.doc.getElementById("admin-gate")!.textContent).toContain(expected);
    expect(page.controls()).toEqual([]);
    expect(page.visible(page.doc.getElementById("competition-detail"))).toBe(false);
    expect(page.text()).not.toContain("Their Cup");
    expect(page.doc.querySelectorAll("#fixtures-list .fixture-block")).toHaveLength(0);
    page.close();
  });

  it("a silent route is a FAILED route: after the read timeout nothing is open and the truthful failure is shown", async () => {
    const never = new Promise<never>(() => {});
    const page = await loadAdmin({ search: `?c=${CODE}`, respond: (call) => (call.url.startsWith("/api/gaming/competitions/resolve") ? { status: 200, json: { competitionId: CID } } : (never as never)) });
    page.win.eval("READ_TIMEOUT_MS = 40");
    await page.settle(() => page.calls.some((c) => c.url === SCORER_ROUTE), "the scorekeeper request");
    await page.settle(() => (page.doc.getElementById("admin-gate")?.textContent ?? "").length > 0, "the timeout outcome");
    expect(page.doc.getElementById("admin-gate")!.textContent).toBe("Failed to load your scorekeeper assignment.");
    expect(page.controls()).toEqual([]);
    page.close();
  });

  it.each([
    ["a code that is too short", "?c=short"], ["a code that is one character short", `?c=${CODE.slice(1)}`], ["a code that is one character long", `?c=${CODE}x`],
    ["a code with markup", '?c=<script>alert(1)</script>aa'], ["an empty code", "?c="], ["a raw competition id", `?c=${CID}`], ["an unrelated parameter", "?competition=" + CID],
  ])("%s is no scorekeeper context at all: the default organizer experience runs and no code is ever resolved", async (_label, search) => {
    const page = await loadAdmin({ respond: respondWith([]), search });
    await page.settle(() => (page.doc.getElementById("admin-gate")?.textContent ?? "").length > 0, "the closed state");
    expect(page.calls.map((c) => c.url)).toEqual([ADMIN_SOURCE]);
    expect(page.doc.getElementById("page-title")!.textContent).toBe("Competitions — Organizer Admin");
    page.close();
  });

  it("the public-code shape this page accepts is exactly the one the member page's intent helper validates", () => {
    const pattern = /var PUBLIC_CODE_PATTERN = (\/\^\[A-Za-z0-9_-\]\{22\}\$\/);/.exec(INTENT_SOURCE);
    expect(pattern?.[1]).toBe("/^[A-Za-z0-9_-]{22}$/");
    expect(ADMIN_HTML).toContain("const PUBLIC_CODE_PATTERN = /^[A-Za-z0-9_-]{22}$/;");
  });
});

describe("the member competition page: the scorekeeper action, contextual to the one addressed competition", () => {
  const SIGNED = { status: "authenticated", email: "a@example.com", gamingMemberId: "m-1", displayName: "Pat" };
  const memberView = (extra: Record<string, unknown> = {}, competition: Record<string, unknown> = {}) => ({
    view: {
      competition: { competitionId: CID, publicCode: CODE, activityKey: "SOCCER_5V5", name: "Cup", state: "PUBLISHED", cancelledReason: null, ...competition },
      teams: [], pendingTeamProposals: [], rejectedTeamProposals: [], myTeamProposals: [], fixtures: [],
      myRegistration: null, myTeamMembership: null, myTeamMemberships: [], myPendingJoinRequest: null, myPersistentRecords: [], isOrganizer: false, ...extra,
    },
  });
  const transport = (extra: Record<string, unknown>, competition: Record<string, unknown> = {}) => (r: { url: string }) =>
    r.url.startsWith("/api/gaming/competitions/resolve") ? { status: 200, json: { competitionId: CID } }
      : r.url === `/api/gaming/competitions/${CID}` ? { status: 200, json: memberView(extra, competition) }
      : { status: 404, json: { error: "unexpected" } };
  async function member(extra: Record<string, unknown>, competition: Record<string, unknown> = {}, auth: unknown = SIGNED) {
    const page = await openMemberPage({ auth, search: `?c=${CODE}`, transport: transport(extra, competition) });
    await page.settle(() => page.text().includes((competition.name as string) ?? "Cup") || page.text().includes("Sign in with URBANO"), "the page");
    await new Promise((r) => setTimeout(r, 20));
    return page;
  }

  it("is offered only when the server says the caller is currently appointed to a fixture of THIS competition, and goes to the scoring page with only the opaque code", async () => {
    const page = await member({ myScorekeeperFixtureIds: ["fx-1", "fx-2"] });
    const action = page.doc.getElementById("scorekeeper-action") as HTMLAnchorElement;
    expect(action).not.toBeNull();
    expect(action.textContent).toBe("Score your fixtures");
    expect(action.getAttribute("href")).toBe(`/competitions-admin.html?c=${CODE}`);
    expect(action.getAttribute("href")).not.toContain(CID);                         // never a raw competition id in a link
    expect(page.doc.querySelector("#scorekeeper-card .scorekeeper-summary")!.textContent).toBe("You are the appointed scorekeeper for 2 fixtures in this competition.");
    page.close();
    const single = await member({ myScorekeeperFixtureIds: ["fx-1"] });
    expect(single.doc.querySelector("#scorekeeper-card .scorekeeper-summary")!.textContent).toBe("You are the appointed scorekeeper for 1 fixture in this competition.");
    single.close();
  });

  it.each([
    ["no appointment (an empty list)", []], ["a field the server did not send", undefined], ["a string instead of a list", "fx-1"],
    ["entries that are not strings", [1, null]], ["a mix of a good and a malformed entry", ["fx-1", 7]], ["empty-string entries", [""]], ["an object", { 0: "fx-1" }],
  ])("is NOT offered for %s — and the page shows no scorekeeper wording at all", async (_label, value) => {
    const page = await member(value === undefined ? {} : { myScorekeeperFixtureIds: value });
    expect(page.doc.getElementById("scorekeeper-action")).toBeNull();
    expect(page.doc.getElementById("scorekeeper-card")).toBeNull();
    expect(page.doc.getElementById("content")!.textContent).not.toMatch(/Scorekeeping|appointed scorekeeper|Score your fixtures/);
    page.close();
  });

  it("is NOT offered when the competition's own public code is not a valid code (fail closed), nor to a signed-out visitor", async () => {
    const bad = await member({ myScorekeeperFixtureIds: ["fx-1"] }, { publicCode: "not-a-code" });
    expect(bad.doc.getElementById("scorekeeper-action")).toBeNull();
    bad.close();
    const out = await member({ myScorekeeperFixtureIds: ["fx-1"] }, {}, { status: "unauthenticated" });
    expect(out.doc.getElementById("scorekeeper-action")).toBeNull();
    out.close();
  });

  it("appears only after the one addressed competition has loaded, and its request carries that exact id", async () => {
    const hang = new Promise<never>(() => {});
    const calls: string[] = [];
    const page = await openMemberPage({
      auth: SIGNED, search: `?c=${CODE}`,
      transport: (r) => { calls.push(r.url); return r.url.startsWith("/api/gaming/competitions/resolve") ? { status: 200, json: { competitionId: CID } } : (hang as never); },
    });
    await page.settle(() => calls.includes(`/api/gaming/competitions/${CID}`), "the addressed competition request");
    expect(page.doc.getElementById("scorekeeper-action")).toBeNull();
    expect(calls).toEqual([`/api/gaming/competitions/resolve?c=${CODE}`, `/api/gaming/competitions/${CID}`]);
    page.close();
  });

  it("a hostile competition name cannot inject into the scorekeeper card", async () => {
    const hostile = '<img src=x onerror="window.__xss=1">';
    const page = await member({ myScorekeeperFixtureIds: ["fx-1"] }, { name: hostile });
    expect(page.doc.getElementById("scorekeeper-action")).not.toBeNull();
    expect(page.doc.querySelectorAll("#content img")).toHaveLength(0);
    expect((page.win as unknown as Record<string, unknown>).__xss).toBeUndefined();
    page.close();
  });
});

describe("terminology is pinned to the four accepted public labels", () => {
  const LABELS = { explore: "Explore Competitions", apply: "Apply to Host Competitions", role: "Competition Organizer", access: "Organizer Access" } as const;

  /** The page as a reader sees its words: scripts' comments, HTML comments and block comments removed. */
  function readable(source: string) {
    return source
      .replace(/<!--[\s\S]*?-->/g, "")
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/^\s*\/\/.*$/gm, "");
  }

  const FORBIDDEN = [
    "Tournament Organizer", "Competition Host", "certified organizer", "Become a Host", "Hosting access", "hosting access",
    "host application", "Host application", "universal Host", "Open organizer tools",
  ];

  it("the application page uses Apply to Host Competitions, Competition Organizer and Organizer Access — and none of the retired wording", () => {
    const text = readable(BECOME_HTML);
    expect(text).toContain(`<title>${LABELS.apply} — URBANO Gaming</title>`);
    expect(text).toContain(`<h1 id="page-title">${LABELS.apply}</h1>`);
    expect(text).toContain(`<h2 id="apply-title">${LABELS.apply}</h2>`);
    expect(text).toContain(LABELS.role);
    expect(text).toContain(`"${LABELS.access}"`);
    for (const term of FORBIDDEN) expect(text, `the application page must not say "${term}"`).not.toContain(term);
  });

  it("the application page never presents the role as a Session Host, Poker Host, venue or Level 33 authority", () => {
    const text = readable(BECOME_HTML);
    expect(text).toContain("it gives you no other role in URBANO Gaming (for example hosting a game session or a poker table)");
    expect(text).not.toMatch(/Session Host|Poker Host|Level 33/);
  });

  it("the organizer page offers Explore Competitions and Apply to Host Competitions when there is nothing to administer, and names the role in the Create guidance", () => {
    const text = readable(ADMIN_HTML);
    expect(text).toContain(LABELS.explore);
    expect(text).toContain(LABELS.apply);
    expect(text).toContain(`approved ${LABELS.role}`);
    for (const term of FORBIDDEN) expect(text, `the organizer page must not say "${term}"`).not.toContain(term);
  });

  it("neither page uses the internal authority names or universal Host wording in what a member reads (static markup and the sentences the scripts write)", () => {
    const INTERNAL = ["OPERATIONAL", "PRODUCT_GOVERNANCE", "authority_grants", "Tournament Organizer", "Competition Host", "universal Host"];
    for (const [label, html] of [["competitions-admin.html", ADMIN_HTML], ["competitions.html", readFileSync(path.join(process.cwd(), "public/competitions.html"), "utf8")]] as const) {
      const dom = new JSDOM(html);
      const scripts = [...dom.window.document.querySelectorAll("script")].map((n) => n.textContent ?? "");
      dom.window.document.querySelectorAll("script,style").forEach((n) => n.remove());
      const markup = dom.window.document.body.textContent ?? "";
      for (const term of INTERNAL) expect(markup, `${label} markup must not say ${term}`).not.toContain(term);
      // every sentence-sized string literal a script can write to the page
      const sentences = scripts.flatMap((code) => [...readable(code).matchAll(/(["`])((?:\\.|(?!\1)[^\\\n]){14,})\1/g)].map((m) => m[2]));
      expect(sentences.length, `${label} has user-facing sentences to check`).toBeGreaterThan(10);
      for (const sentence of sentences) for (const term of INTERNAL) expect(sentence, `${label}: "${sentence.slice(0, 60)}"`).not.toContain(term);
    }
  });

  it("the four labels are exactly these strings", () => {
    expect(LABELS).toEqual({ explore: "Explore Competitions", apply: "Apply to Host Competitions", role: "Competition Organizer", access: "Organizer Access" });
  });

  it("the application page offers no Organizer Access link for a pilot that has ended — only for one still being run", () => {
    expect(BECOME_HTML).toContain('state === "COMPLETE" || state === "CANCELLED_WITHOUT_CHAMPION"');
    expect(BECOME_HTML).toContain("This pilot has ended, so there is nothing left to administer.");
  });
});

describe("controls: what the server's per-caller answer lets the page show (no creation control without it)", () => {
  const SIGNED = { status: "authenticated", email: "a@example.com", gamingMemberId: "m-1", displayName: "Pat" };
  const ADMIN = "/api/gaming/competitions/administration";
  const organizerEntry = { competitionId: "c-mine", name: "My Cup", state: "DRAFT", access: "ORGANIZER" };
  const NAV = ["a[Explore Competitions]", "a[Apply to Host Competitions]"];
  const CREATE_FORM = ["input#c-name", "select#c-activity", "button#btn-create-competition"];

  async function controlsFor(body: unknown, status = 200) {
    const page = await openAdminPage({ auth: SIGNED, transport: (r) => (r.url === ADMIN ? { status, json: body } : { status: 404, json: { error: "unexpected" } }) });
    await page.settle(() => page.requests.some((r) => r.url === ADMIN), "the administrative source");
    await new Promise((r) => setTimeout(r, 120));
    const out = { controls: page.controls(), text: page.text(), requests: page.requests.map((r) => `${r.method} ${r.url}`) };
    page.close();
    return out;
  }

  it("no operation at all: only the two ways onward — never the create form", async () => {
    const { controls, requests } = await controlsFor({ competitions: [], operations: NO_OPERATION });
    expect(controls).toEqual(NAV);
    expect(requests).toEqual([`GET ${ADMIN}`]);                       // the page asks one plain question: no flag, no state, no query
  });

  it.each([
    ["missing", undefined], ["null", null], ["a string", "true"], ["an array", [true, true]],
    ["a string instead of a boolean", { createCompetition: "true" }], ["a number", { createCompetition: 1 }], ["nested", { createCompetition: { value: true } }],
    ["an array value", { createCompetition: [true] }], ["null", { createCompetition: null }], ["only a stale first-pilot flag", { createFirstPilot: true }],
  ])("a malformed or unrecognised `operations` (%s) opens nothing", async (_label, operations) => {
    const body: Record<string, unknown> = { competitions: [] };
    if (operations !== undefined) body.operations = operations;
    expect((await controlsFor(body)).controls).toEqual(NAV);
  });

  it("an internal operator with no competition yet sees the create-competition form and nothing else", async () => {
    expect((await controlsFor({ competitions: [], operations: { createCompetition: true } })).controls).toEqual(CREATE_FORM);
  });

  it("an active organizer WITHOUT the operational authority sees the selector and no create form", async () => {
    expect((await controlsFor({ competitions: [organizerEntry], operations: NO_OPERATION })).controls).toEqual(["select#comp-select", "button#btn-load-competition"]);
  });

  it("an organizer who ALSO holds the operational authority sees both", async () => {
    expect((await controlsFor({ competitions: [organizerEntry], operations: { createCompetition: true } })).controls).toEqual([...CREATE_FORM, "select#comp-select", "button#btn-load-competition"]);
  });

  it("a stale first-pilot flag never reveals a card, a link or any creation control — an unused capability is handled on the application page only", async () => {
    const { controls, text } = await controlsFor({ competitions: [], operations: { createCompetition: false, createFirstPilot: true } });
    expect(controls).toEqual(NAV);
    expect(text).not.toMatch(/Create your one pilot|approved Competition Organizer. You have not created/);
  });

  it.each([[401, { error: "A valid Authorization header for an authenticated Gaming Member is required." }], [503, { error: "temporarily unavailable" }], [500, { error: "Failed to load your competitions." }]])(
    "a failing source (%i) opens nothing, even if its body carries operations",
    async (status, body) => {
      const { controls } = await controlsFor({ ...body, competitions: [organizerEntry], operations: { createCompetition: true } }, status);
      expect(controls).toEqual([]);
    }
  );

  it("a read that never answers is a FAILED read: after the timeout nothing is open, whatever an earlier answer showed", async () => {
    let calls = 0;
    const hang = new Promise<never>(() => {});
    const page = await openAdminPage({
      auth: SIGNED,
      transport: () => { calls += 1; return calls === 1 ? { status: 200, json: { competitions: [organizerEntry], operations: { createCompetition: true } } } : (hang as never); },
    });
    await page.settle(() => page.controls().includes("button#btn-create-competition"), "the confirmed create form");
    page.win.eval("READ_TIMEOUT_MS = 40");
    const refresh = page.fireAuthChange();
    await refresh;
    expect(page.controls()).toEqual([]);
    expect(page.doc.getElementById("admin-gate")!.textContent).toBe("Failed to load your competitions.");
    page.close();
  });

  it("a malformed answer AFTER a good one closes everything the good one opened", async () => {
    let calls = 0;
    const page = await openAdminPage({
      auth: SIGNED,
      transport: () => { calls += 1; return calls === 1 ? { status: 200, json: { competitions: [organizerEntry], operations: { createCompetition: true } } } : { status: 200, json: { competitions: "nope", operations: { createCompetition: true } } }; },
    });
    await page.settle(() => page.controls().includes("button#btn-create-competition"), "the confirmed create form");
    await page.fireAuthChange();
    expect(page.controls()).toEqual([]);
    page.close();
  });
});

// =============================================================================
// UG-CR-GATE-100 — Bounded Organizer Access Correction Gate: the nine required cases (page level)
//
// Written and run red against the RPT-100A candidate BEFORE any source change (see the gate return).
// =============================================================================

describe("UG-CR-GATE-100 correction — the nine required cases (page)", () => {
  const SIGNED = { status: "authenticated", email: "a@example.com", gamingMemberId: "m-1", displayName: "Pat" };
  const ADMIN = "/api/gaming/competitions/administration";
  const CODE = "AbCdEfGhIjKlMnOpQrStUv";                                  // an opaque 22-character public code
  const CID = "11111111-1111-4111-8111-111111111111";
  const NAV = ["a[Explore Competitions]", "a[Apply to Host Competitions]"];

  const memberView = (extra: Record<string, unknown> = {}) => ({
    view: {
      competition: { competitionId: CID, publicCode: CODE, activityKey: "SOCCER_5V5", name: "Cup", state: "PUBLISHED", cancelledReason: null },
      teams: [], pendingTeamProposals: [], rejectedTeamProposals: [], myTeamProposals: [], fixtures: [],
      myRegistration: null, myTeamMembership: null, myTeamMemberships: [], myPendingJoinRequest: null, myPersistentRecords: [], isOrganizer: false, ...extra,
    },
  });
  const memberTransport = (extra: Record<string, unknown>) => (r: { url: string }) =>
    r.url.startsWith("/api/gaming/competitions/resolve") ? { status: 200, json: { competitionId: CID } }
      : r.url === `/api/gaming/competitions/${CID}` ? { status: 200, json: memberView(extra) }
      : { status: 404, json: { error: "unexpected" } };

  it("CASE-6 the addressed competition surface offers the scorekeeper action — only when the server says the caller is appointed to a fixture of it", async () => {
    const appointed = await openMemberPage({ auth: SIGNED, search: `?c=${CODE}`, transport: memberTransport({ myScorekeeperFixtureIds: ["fx-1"] }) });
    await appointed.settle(() => appointed.text().includes("Cup"), "the addressed competition");
    expect(appointed.doc.getElementById("scorekeeper-action")).not.toBeNull();
    appointed.close();
    for (const [label, value] of [["empty", []], ["missing", undefined], ["malformed", "fx-1"], ["not strings", [1, null]]] as Array<[string, unknown]>) {
      const page = await openMemberPage({ auth: SIGNED, search: `?c=${CODE}`, transport: memberTransport(value === undefined ? {} : { myScorekeeperFixtureIds: value }) });
      await page.settle(() => page.text().includes("Cup"), "the addressed competition");
      expect(page.doc.getElementById("scorekeeper-action"), label).toBeNull();
      page.close();
    }
  });

  it("CASE-7 an approved member with an unused capability is offered NO creation control on the organizer page — not even a stale server flag reveals one", async () => {
    const page = await openAdminPage({ auth: SIGNED, transport: () => ({ status: 200, json: { competitions: [], operations: { createCompetition: false, createFirstPilot: true } } }) });
    await page.settle(() => (page.doc.getElementById("admin-gate")?.textContent ?? "").length > 0 || page.controls().length > 0, "the first answer");
    await new Promise((r) => setTimeout(r, 80));
    expect(page.controls()).toEqual(NAV);
    page.close();
  });

  it("CASE-8 before the server answers nothing is actionable; and a scorekeeper deep link asks only the two bounded questions, never the default source", async () => {
    const hang = new Promise<never>(() => {});
    const pending = await openAdminPage({ auth: SIGNED, transport: () => hang });
    await new Promise((r) => setTimeout(r, 60));
    expect(pending.controls()).toEqual([]);
    pending.close();

    const requests: string[] = [];
    const deep = await openAdminPage({ auth: SIGNED, search: `?c=${CODE}`, transport: (r) => { requests.push(r.url); return hang; } });
    await new Promise((r) => setTimeout(r, 60));
    expect(deep.controls()).toEqual([]);
    expect(requests).not.toContain(ADMIN);
    expect(requests.some((u) => u.startsWith("/api/gaming/competitions/resolve"))).toBe(true);
    deep.close();
  });

  it("CASE-9 a failed authorization read AFTER a successful one closes the creation control — a thrown network error is not 'still authorized'", async () => {
    let calls = 0;
    const page = await openAdminPage({
      auth: SIGNED,
      transport: () => {
        calls += 1;
        if (calls === 1) return { status: 200, json: { competitions: [], operations: { createCompetition: true } } };
        throw new Error("network down");
      },
    });
    await page.settle(() => page.controls().includes("button#btn-create-competition"), "the confirmed create form");
    await page.fireAuthChange();
    await new Promise((r) => setTimeout(r, 80));
    expect(page.controls()).not.toContain("button#btn-create-competition");
    page.close();
  });
});
