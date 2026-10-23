import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// The one module boundary between the routes and the outside world: credentials, repository construction, caller identity and the
// error-status map. The readiness guard keeps its REAL implementation, so the tests prove the actual wiring rather than a stand-in.
vi.mock("@/lib/gaming/competitions/httpAuth", async () => {
  const actual = await vi.importActual<typeof import("../lib/gaming/competitions/httpAuth")>("../lib/gaming/competitions/httpAuth");
  return {
    getSupabaseCredentials: vi.fn(),
    buildCompetitionsRepo: vi.fn(),
    requireGamingMember: vi.fn(),
    statusForCompetitionsError: actual.statusForCompetitionsError,
    requireCompetitionsSchemaReady: actual.requireCompetitionsSchemaReady,
    isCompetitionsSchemaReady: actual.isCompetitionsSchemaReady,
    normalizeCompetitionsSchemaReady: actual.normalizeCompetitionsSchemaReady,
  };
});

import {
  holdsOrganizerAccess, holdsActiveOrganizerAuthority, isActiveCompetitionState, hasOrganizerAccess, listAdministrableCompetitions,
  getAdministrativeOperations, describeAdministration, appointedFixtureIds,
} from "../lib/gaming/competitions/administration";
import { getCompetitionView } from "../lib/gaming/competitions/getCompetitionView";
import { isListedFor } from "../lib/gaming/competitions/organizerAccess";
import type { CompetitionAdministrationReads } from "../lib/gaming/competitions/db/competitionsRepository";
import type { CompetitionRecord } from "../lib/gaming/competitions/types";

/**
 * UG-CR-GATE-100 — Competition Organizer entry and scoped administration (bounded organizer-access correction).
 *
 * Covers the strict domain rules, the three routes (Organizer Access, default administration, contextual scorekeeper administration) and the
 * addressed-competition view field. Real-database behaviour is in competitionAdministrationSupabase.contract.test.ts, the pages in
 * competitionAdminPage.test.ts. Administration is not member discovery: nothing here changes the general list.
 *
 * ACTIVE organizer authority is the only thing the Home boolean and the default administrative source represent. An approved-but-unused
 * capability, a scorekeeper appointment, a captaincy, a registration, an application, the OPERATIONAL authority on its own, and a finished
 * (COMPLETE / CANCELLED_WITHOUT_CHAMPION) competition are none of it.
 */

type Appointment = { competitionId?: unknown; competitionFixtureId?: unknown };

const ME = "member-me";
const OTHER = "member-other";

function competition(over: Partial<CompetitionRecord> & { competitionId: string }): CompetitionRecord {
  return {
    publicCode: `${over.competitionId}-code`, activityKey: "SOCCER_5V5", name: `Name of ${over.competitionId}`, organizerGamingMemberId: OTHER,
    state: "TEAM_REGISTRATION_OPEN", cancelledReason: null, createdAt: "2026-10-01T00:00:00Z", publishedAt: null, ...over,
  };
}

/**
 * A repository offering the two permitted reads — plus two TRAPS standing for the reads this gate removed (an appointment list across
 * competitions, an unused-pilot-ability check). The corrected code must never call either, so a stray call fails the test.
 */
function adminRepo(competitions: unknown, appointments: Appointment[] | unknown = [], abilities: { unusedPilot?: unknown; operational?: unknown } = {}) {
  return {
    listCompetitions: vi.fn().mockResolvedValue(competitions),
    listScorekeeperAppointments: vi.fn().mockResolvedValue(appointments),
    hasUnusedPilotAbility: vi.fn().mockResolvedValue(abilities.unusedPilot ?? false),
    hasOperationalAuthority: vi.fn().mockResolvedValue(abilities.operational ?? false),
  } as unknown as CompetitionAdministrationReads & {
    listCompetitions: ReturnType<typeof vi.fn>; listScorekeeperAppointments: ReturnType<typeof vi.fn>;
    hasUnusedPilotAbility: ReturnType<typeof vi.fn>; hasOperationalAuthority: ReturnType<typeof vi.fn>;
  };
}

describe("holdsOrganizerAccess — strict, fail-closed", () => {
  it("is true for the organizer of an internal competition, and of a host pilot whose access is explicitly not revoked", () => {
    expect(holdsOrganizerAccess(competition({ competitionId: "c1", organizerGamingMemberId: ME }), ME)).toBe(true);
    expect(holdsOrganizerAccess(competition({ competitionId: "c1", organizerGamingMemberId: ME, hostBound: true, hostAccessRevoked: false }), ME)).toBe(true);
  });

  it("is false for anyone who is not its organizer, and for a revoked host", () => {
    expect(holdsOrganizerAccess(competition({ competitionId: "c1", organizerGamingMemberId: OTHER }), ME)).toBe(false);
    expect(holdsOrganizerAccess(competition({ competitionId: "c1", organizerGamingMemberId: ME, hostBound: true, hostAccessRevoked: true }), ME)).toBe(false);
  });

  it("treats every malformed or ambiguous record as NOT access", () => {
    const base = { competitionId: "c1", organizerGamingMemberId: ME };
    const malformed: unknown[] = [
      null, undefined, "c1", 42, true, [], [base],
      { ...base, competitionId: "" }, { ...base, competitionId: undefined }, { ...base, organizerGamingMemberId: "" }, { ...base, organizerGamingMemberId: undefined },
      { ...base, organizerGamingMemberId: 7 },
      { ...base, hostBound: true },                                              // a host pilot with no binding state
      { ...base, hostBound: true, hostAccessRevoked: undefined },
      { ...base, hostBound: true, hostAccessRevoked: "false" },
      { ...base, hostBound: true, hostAccessRevoked: 0 },
      { ...base, hostBound: "true", hostAccessRevoked: false },                  // an unexpected binding value
      { ...base, hostAccessRevoked: "no" },
      { ...base, hostAccessRevoked: true },
    ];
    for (const record of malformed) expect(holdsOrganizerAccess(record, ME), JSON.stringify(record)).toBe(false);
  });

  it("is false for an empty or non-string caller", () => {
    for (const caller of ["", undefined, null, 7] as unknown[]) {
      expect(holdsOrganizerAccess(competition({ competitionId: "c1", organizerGamingMemberId: ME }), caller as string)).toBe(false);
    }
  });
});

describe("holdsActiveOrganizerAuthority and isActiveCompetitionState — ACTIVE authority, not mere ownership", () => {
  it("only the four running states are active; the two terminal states and anything unknown or malformed are not", () => {
    for (const state of ["DRAFT", "TEAM_REGISTRATION_OPEN", "READY_TO_PUBLISH", "PUBLISHED"]) expect(isActiveCompetitionState(state), state).toBe(true);
    for (const state of ["COMPLETE", "CANCELLED_WITHOUT_CHAMPION", "ARCHIVED", "", "published", undefined, null, 7, {}, []]) expect(isActiveCompetitionState(state), String(state)).toBe(false);
  });

  it("holds for the organizer of a running competition, and not once it is terminal — even though ownership remains", () => {
    const running = competition({ competitionId: "c", organizerGamingMemberId: ME, state: "PUBLISHED" });
    expect(holdsActiveOrganizerAuthority(running, ME)).toBe(true);
    for (const state of ["COMPLETE", "CANCELLED_WITHOUT_CHAMPION"] as const) {
      const ended = competition({ competitionId: "c", organizerGamingMemberId: ME, state });
      expect(holdsOrganizerAccess(ended, ME), `ownership of a ${state} competition remains a relationship`).toBe(true);
      expect(holdsActiveOrganizerAuthority(ended, ME), state).toBe(false);
    }
    expect(holdsActiveOrganizerAuthority({ ...running, state: undefined }, ME)).toBe(false);
    expect(holdsActiveOrganizerAuthority({ ...running, state: "SOMETHING_NEW" }, ME)).toBe(false);
  });
});

describe("hasOrganizerAccess — the signal behind Organizer Access", () => {
  it("is true when the caller actively organizes at least one competition, among others they do not", async () => {
    const repo = adminRepo([competition({ competitionId: "a" }), competition({ competitionId: "b", organizerGamingMemberId: ME }), competition({ competitionId: "c" })]);
    expect(await hasOrganizerAccess(repo, ME)).toBe(true);
  });

  it("is true for an active host pilot with its binding explicitly un-revoked, and for any running state", async () => {
    for (const state of ["DRAFT", "TEAM_REGISTRATION_OPEN", "READY_TO_PUBLISH", "PUBLISHED"] as const) {
      expect(await hasOrganizerAccess(adminRepo([competition({ competitionId: "p", organizerGamingMemberId: ME, hostBound: true, hostAccessRevoked: false, state })]), ME), state).toBe(true);
    }
  });

  it("is false for a member who only holds roles: scorekeeper appointments are not global organizer access, and are never read", async () => {
    const repo = adminRepo([competition({ competitionId: "a" })], [{ competitionId: "a", competitionFixtureId: "f1" }]);
    expect(await hasOrganizerAccess(repo, ME)).toBe(false);
    expect(repo.listScorekeeperAppointments).not.toHaveBeenCalled();
  });

  it("is false for a revoked organizer, and for a member whose only competition is another's", async () => {
    expect(await hasOrganizerAccess(adminRepo([competition({ competitionId: "a", organizerGamingMemberId: ME, hostBound: true, hostAccessRevoked: true })]), ME)).toBe(false);
    expect(await hasOrganizerAccess(adminRepo([competition({ competitionId: "a" })]), ME)).toBe(false);
    expect(await hasOrganizerAccess(adminRepo([]), ME)).toBe(false);
  });

  it("is false when the repository answers something that is not a list, and for an empty caller", async () => {
    for (const bad of [undefined, null, {}, "x", 5]) expect(await hasOrganizerAccess(adminRepo(bad), ME)).toBe(false);
    expect(await hasOrganizerAccess(adminRepo([competition({ competitionId: "a", organizerGamingMemberId: "" })]), "")).toBe(false);
  });

  it("does not swallow a repository failure: it rejects, so a route can answer 500 and never a guessed value", async () => {
    const repo = adminRepo([]);
    repo.listCompetitions.mockRejectedValue(new Error("db down"));
    await expect(hasOrganizerAccess(repo, ME)).rejects.toThrow("db down");
  });

  describe("an approved Competition Organizer whose one pilot capability is still unused", () => {
    it("is FALSE: a capability is permission to create one pilot, not authority over any competition — and it is never even read", async () => {
      for (const others of [[], [competition({ competitionId: "someone-elses" })]]) {
        const repo = adminRepo(others, [], { unusedPilot: true });
        expect(await hasOrganizerAccess(repo, ME)).toBe(false);
        expect(repo.hasUnusedPilotAbility).not.toHaveBeenCalled();
      }
    });

    it("becomes true only once the pilot exists and is running; false again when the pilot ends or the host's access is revoked", async () => {
      const pilot = (over: Partial<CompetitionRecord>) => competition({ competitionId: "pilot", organizerGamingMemberId: ME, hostBound: true, hostAccessRevoked: false, ...over });
      expect(await hasOrganizerAccess(adminRepo([pilot({ state: "DRAFT" })]), ME)).toBe(true);
      expect(await hasOrganizerAccess(adminRepo([pilot({ state: "CANCELLED_WITHOUT_CHAMPION" })]), ME)).toBe(false);
      expect(await hasOrganizerAccess(adminRepo([pilot({ state: "COMPLETE" })]), ME)).toBe(false);
      expect(await hasOrganizerAccess(adminRepo([pilot({ hostAccessRevoked: true })]), ME)).toBe(false);
    });
  });

  describe("a finished competition is not active Organizer Access", () => {
    it.each(["COMPLETE", "CANCELLED_WITHOUT_CHAMPION"] as const)("a %s competition alone yields false (internal organizer and host pilot alike)", async (state) => {
      expect(await hasOrganizerAccess(adminRepo([competition({ competitionId: "t", organizerGamingMemberId: ME, state })]), ME)).toBe(false);
      expect(await hasOrganizerAccess(adminRepo([competition({ competitionId: "t", organizerGamingMemberId: ME, state, hostBound: true, hostAccessRevoked: false })]), ME)).toBe(false);
    });

    it("one running competition among finished ones is enough — and finished ones alone are not", async () => {
      const ended = (id: string) => competition({ competitionId: id, organizerGamingMemberId: ME, state: "COMPLETE" });
      expect(await hasOrganizerAccess(adminRepo([ended("a"), ended("b")]), ME)).toBe(false);
      expect(await hasOrganizerAccess(adminRepo([ended("a"), competition({ competitionId: "live", organizerGamingMemberId: ME, state: "DRAFT" })]), ME)).toBe(true);
    });
  });
});

describe("listAdministrableCompetitions — the organizer-only administrative source", () => {
  const pilotMine = competition({ competitionId: "pilot-mine", organizerGamingMemberId: ME, hostBound: true, hostAccessRevoked: false, state: "DRAFT" });
  const internalMine = competition({ competitionId: "internal-mine", organizerGamingMemberId: ME, state: "PUBLISHED" });
  const unrelatedOpen = competition({ competitionId: "unrelated-open", state: "TEAM_REGISTRATION_OPEN" });
  const unrelatedPublished = competition({ competitionId: "unrelated-published", state: "PUBLISHED" });
  const scored = competition({ competitionId: "scored", state: "PUBLISHED" });

  it("returns the caller's own ACTIVE competitions as ORGANIZER and nothing else, in the repository's order", async () => {
    const out = await listAdministrableCompetitions(adminRepo([unrelatedOpen, pilotMine, unrelatedPublished, internalMine]), ME);
    expect(out.map((c) => [c.competitionId, c.access])).toEqual([["pilot-mine", "ORGANIZER"], ["internal-mine", "ORGANIZER"]]);
  });

  it("never returns a competition because of a scorekeeper appointment — and never reads the appointments", async () => {
    const repo = adminRepo([unrelatedOpen, scored], [{ competitionId: "scored", competitionFixtureId: "f-sf1" }, { competitionId: "scored", competitionFixtureId: "f-final" }]);
    expect(await listAdministrableCompetitions(repo, ME)).toEqual([]);
    expect(repo.listScorekeeperAppointments).not.toHaveBeenCalled();
  });

  it("returns a competition the caller organizes AND scores in exactly once, as ORGANIZER", async () => {
    const out = await listAdministrableCompetitions(adminRepo([internalMine], [{ competitionId: "internal-mine", competitionFixtureId: "f1" }]), ME);
    expect(out).toEqual([{ competitionId: "internal-mine", name: "Name of internal-mine", state: "PUBLISHED", access: "ORGANIZER" }]);
  });

  it("gives a revoked host no way back in — neither as organizer nor as a scorekeeper they appointed themselves", async () => {
    const revoked = competition({ competitionId: "revoked", organizerGamingMemberId: ME, hostBound: true, hostAccessRevoked: true, state: "PUBLISHED" });
    expect(await listAdministrableCompetitions(adminRepo([revoked], [{ competitionId: "revoked", competitionFixtureId: "f1" }]), ME)).toEqual([]);
  });

  it.each(["COMPLETE", "CANCELLED_WITHOUT_CHAMPION"] as const)("excludes a %s competition: it is not an active administration target", async (state) => {
    const repo = adminRepo([competition({ competitionId: "ended", organizerGamingMemberId: ME, state }), competition({ competitionId: "live", organizerGamingMemberId: ME, state: "PUBLISHED" })]);
    expect((await listAdministrableCompetitions(repo, ME)).map((c) => c.competitionId)).toEqual(["live"]);
    expect(await listAdministrableCompetitions(adminRepo([competition({ competitionId: "ended", organizerGamingMemberId: ME, state })]), ME)).toEqual([]);
  });

  it("ignores any malformed record, and returns exactly [] for a member with no relationship or for non-list or empty-caller input", async () => {
    const repo = adminRepo([null, "x", { competitionId: "no-name", organizerGamingMemberId: ME }, { ...internalMine, name: "" }, { ...internalMine, state: undefined }, { ...internalMine, competitionId: "" }, internalMine]);
    expect((await listAdministrableCompetitions(repo, ME)).map((c) => c.competitionId)).toEqual(["internal-mine"]);
    expect(await listAdministrableCompetitions(adminRepo([unrelatedOpen, unrelatedPublished, pilotMine]), OTHER + "-nobody")).toEqual([]);
    for (const bad of [undefined, null, {}, "x"]) expect(await listAdministrableCompetitions(adminRepo(bad), ME)).toEqual([]);
    expect(await listAdministrableCompetitions(adminRepo([internalMine]), "")).toEqual([]);
  });

  it("exposes exactly competitionId, name, state and access — never an organizer id, public code, fixture list or other field", async () => {
    const out = await listAdministrableCompetitions(adminRepo([internalMine, pilotMine]), ME);
    for (const entry of out) expect(Object.keys(entry).sort()).toEqual(["access", "competitionId", "name", "state"]);
    expect(JSON.stringify(out)).not.toMatch(/organizerGamingMemberId|publicCode|-code|cancelledReason|hostBound|hostAccessRevoked|scorekeeper/i);
  });

  it("NEGATIVE CONTROL: the general discovery list shows an unrelated open internal competition to this member — the observed defect — and the administrative source does not", async () => {
    // Member discovery is deliberately unchanged: an open internal competition is listed to every signed-in member.
    expect(isListedFor(unrelatedOpen, ME)).toBe(true);
    expect(isListedFor(unrelatedPublished, ME)).toBe(true);
    // An organizer page fed from that list would therefore show it. The administrative source never does.
    expect(await listAdministrableCompetitions(adminRepo([unrelatedOpen, unrelatedPublished]), ME)).toEqual([]);
  });
});

describe("appointedFixtureIds — scorekeeper access for ONE addressed competition, decided from its own fixtures", () => {
  const CID = "11111111-1111-4111-8111-111111111111";
  const fx = (id: string, scorekeeper: unknown, over: Record<string, unknown> = {}) => ({ competitionFixtureId: id, competitionId: CID, scorekeeperGamingMemberId: scorekeeper, ...over });
  const comp = (over: Record<string, unknown> = {}) => competition({ competitionId: CID, state: "PUBLISHED", ...(over as Partial<CompetitionRecord>) });

  it("returns exactly the fixtures whose CURRENT scorekeeper is the caller, in order, without duplicates", () => {
    expect(appointedFixtureIds(comp(), [fx("a", ME), fx("b", OTHER), fx("c", null), fx("d", ME), fx("a", ME)], ME)).toEqual(["a", "d"]);
  });

  it("a removed or replaced appointment is no appointment: the fixture row now names someone else (or no one)", () => {
    expect(appointedFixtureIds(comp(), [fx("a", OTHER), fx("b", null), fx("c", undefined)], ME)).toEqual([]);
  });

  it("is empty for an unrelated member, an empty caller, a non-list, and for fixtures that belong to a different competition", () => {
    expect(appointedFixtureIds(comp(), [fx("a", ME)], OTHER)).toEqual([]);
    for (const caller of ["", undefined, null, 7] as unknown[]) expect(appointedFixtureIds(comp(), [fx("a", ME)], caller as string)).toEqual([]);
    for (const bad of [undefined, null, {}, "x", 5]) expect(appointedFixtureIds(comp(), bad, ME)).toEqual([]);
    expect(appointedFixtureIds(comp(), [fx("a", ME, { competitionId: "another-competition" })], ME)).toEqual([]);
  });

  it("treats every malformed competition or fixture record as NOT an appointment", () => {
    for (const bad of [null, undefined, "c", 5, [], {}, { competitionId: "" }]) expect(appointedFixtureIds(bad, [fx("a", ME)], ME), JSON.stringify(bad)).toEqual([]);
    expect(appointedFixtureIds(comp(), [null, "x", 5, [], {}, fx("", ME), { ...fx("a", ME), competitionFixtureId: 9 }, fx("ok", ME)], ME)).toEqual(["ok"]);
    expect(appointedFixtureIds(comp(), [fx("a", { id: ME }), fx("b", [ME]), fx("c", `${ME} `)], ME)).toEqual([]);
  });

  it("a host whose access was revoked gains nothing by having appointed themselves — and a malformed binding is no route in either", () => {
    expect(appointedFixtureIds(comp({ organizerGamingMemberId: ME, hostBound: true, hostAccessRevoked: true }), [fx("a", ME)], ME)).toEqual([]);
    expect(appointedFixtureIds(comp({ organizerGamingMemberId: ME, hostBound: true }), [fx("a", ME)], ME)).toEqual([]);
    expect(appointedFixtureIds(comp({ organizerGamingMemberId: ME, hostBound: "true", hostAccessRevoked: false }), [fx("a", ME)], ME)).toEqual([]);
    expect(appointedFixtureIds(comp({ organizerGamingMemberId: ME, hostBound: true, hostAccessRevoked: false }), [fx("a", ME)], ME)).toEqual(["a"]);
    expect(appointedFixtureIds(comp({ organizerGamingMemberId: ME }), [fx("a", ME)], ME)).toEqual(["a"]);
  });

  it("an independent scorekeeper of a revoked host's competition keeps their own appointment (the same rule the fixture detail read applies)", () => {
    expect(appointedFixtureIds(comp({ organizerGamingMemberId: OTHER, hostBound: true, hostAccessRevoked: true }), [fx("a", ME)], ME)).toEqual(["a"]);
  });
});

describe("getCompetitionView — the addressed competition carries the caller's own scorekeeper fixtures (and discovery behaviour is untouched)", () => {
  const CID = "11111111-1111-4111-8111-111111111111";
  const fixture = (id: string, scorekeeper: string | null, over: Record<string, unknown> = {}) => ({
    competitionFixtureId: id, competitionId: CID, fixtureRole: "SEMIFINAL_1", scheduledAt: "2026-11-01T10:00:00Z", teamACompetitionTeamId: "ta", teamBCompetitionTeamId: "tb",
    teamASourceFixtureId: null, teamBSourceFixtureId: null, state: "CHECKIN_OPEN", scorekeeperGamingMemberId: scorekeeper, createdAt: "x", ...over,
  });
  const stub = (competitionOver: Partial<CompetitionRecord>, fixtures: unknown[]) => ({
    getCompetitionById: vi.fn().mockResolvedValue(competition({ competitionId: CID, state: "PUBLISHED", ...competitionOver })),
    getCompetitionTeams: vi.fn().mockResolvedValue([]), getCompetitionFixtures: vi.fn().mockResolvedValue(fixtures),
    getMyRegistration: vi.fn().mockResolvedValue(null), getMyTeamMembership: vi.fn().mockResolvedValue(null),
    getMyPendingJoinRequest: vi.fn().mockResolvedValue(null), getMemberParticipationRecords: vi.fn().mockResolvedValue([]),
    getDisplayNames: vi.fn().mockResolvedValue({}), getCurrentRoster: vi.fn().mockResolvedValue(null),
    getRegistrationStatus: vi.fn().mockResolvedValue(null), getRegistrationFreeze: vi.fn().mockResolvedValue(null),
  });

  it("lists only the fixtures of THIS competition the caller is currently appointed to; an unrelated member gets an empty list", async () => {
    const repo = stub({}, [fixture("f-mine", ME), fixture("f-theirs", OTHER), fixture("f-none", null)]);
    expect((await getCompetitionView(repo as never, CID, ME)).myScorekeeperFixtureIds).toEqual(["f-mine"]);
    expect((await getCompetitionView(repo as never, CID, "member-nobody")).myScorekeeperFixtureIds).toEqual([]);
  });

  it("a replaced appointment, a revoked host's self-appointment and another competition's fixture produce no scorekeeper fixture", async () => {
    expect((await getCompetitionView(stub({}, [fixture("f", OTHER)]) as never, CID, ME)).myScorekeeperFixtureIds).toEqual([]);
    expect((await getCompetitionView(stub({ organizerGamingMemberId: ME, hostBound: true, hostAccessRevoked: true }, [fixture("f", ME)]) as never, CID, ME)).myScorekeeperFixtureIds).toEqual([]);
    expect((await getCompetitionView(stub({}, [fixture("f", ME, { competitionId: "elsewhere" })]) as never, CID, ME)).myScorekeeperFixtureIds).toEqual([]);
  });

  it("adds nothing else: every fixture is still part of the ordinary addressed view, and organizer status is unchanged", async () => {
    const view = await getCompetitionView(stub({}, [fixture("f-mine", ME), fixture("f-theirs", OTHER)]) as never, CID, ME);
    expect(view.fixtures.map((e) => e.fixture.competitionFixtureId)).toEqual(["f-mine", "f-theirs"]);
    expect(view.isOrganizer).toBe(false);
    expect(Object.keys(view).sort()).toEqual([
      "competition", "fixtures", "isOrganizer", "myPendingJoinRequest", "myPersistentRecords", "myRegistration", "myScorekeeperFixtureIds",
      "myTeamMembership", "myTeamMemberships", "myTeamProposals", "pendingTeamProposals", "registration", "registrationFreeze", "registrationReadiness",
      "rejectedTeamProposals", "teams",
    ]);
  });
});

describe("GET /api/gaming/competitions/organizer-access, /administration and /[competitionId]/scorekeeper-administration", () => {
  const ORIGINAL = { competitions: process.env.COMPETITIONS_SCHEMA_READY, host: process.env.BECOME_A_HOST_SCHEMA_READY };
  let httpAuth: typeof import("../lib/gaming/competitions/httpAuth");

  beforeEach(async () => {
    process.env.COMPETITIONS_SCHEMA_READY = "true";
    delete process.env.BECOME_A_HOST_SCHEMA_READY; // applications CLOSED — the default
    httpAuth = await import("../lib/gaming/competitions/httpAuth");
    vi.clearAllMocks();
    vi.mocked(httpAuth.getSupabaseCredentials).mockReturnValue({ url: "http://fake", serviceKey: "fake" });
    vi.mocked(httpAuth.requireGamingMember).mockResolvedValue({ gamingMemberId: ME });
  });

  afterEach(() => {
    for (const [key, value] of [["COMPETITIONS_SCHEMA_READY", ORIGINAL.competitions], ["BECOME_A_HOST_SCHEMA_READY", ORIGINAL.host]] as const) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  const request = () => new Request("http://localhost/probe", { headers: { authorization: "Bearer token" } });
  const use = (repo: unknown) => vi.mocked(httpAuth.buildCompetitionsRepo).mockReturnValue(repo as ReturnType<typeof httpAuth.buildCompetitionsRepo>);
  const NO_STORE = "no-store, max-age=0";

  it("organizer-access: exactly {\"organizerAccess\":true}, uncached, for an active organizer — while applications are closed", async () => {
    use(adminRepo([competition({ competitionId: "mine", organizerGamingMemberId: ME, hostBound: true, hostAccessRevoked: false })]));
    const { GET } = await import("../app/api/gaming/competitions/organizer-access/route");
    const res = await GET(request());
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe(NO_STORE);
    expect(await res.text()).toBe('{"organizerAccess":true}');
    expect(process.env.BECOME_A_HOST_SCHEMA_READY).toBeUndefined(); // and it needed no application readiness at all
  });

  it("organizer-access: a real organizer's answer is identical whatever the application-availability flag holds (absent, false, malformed, true)", async () => {
    use(adminRepo([competition({ competitionId: "mine", organizerGamingMemberId: ME })]));
    const { GET } = await import("../app/api/gaming/competitions/organizer-access/route");
    const answers: string[] = [];
    for (const flag of [undefined, "", "false", "TRUE", "garbage", "true"]) {
      if (flag === undefined) delete process.env.BECOME_A_HOST_SCHEMA_READY;
      else process.env.BECOME_A_HOST_SCHEMA_READY = flag;
      answers.push(await (await GET(request())).text());
    }
    expect(new Set(answers)).toEqual(new Set(['{"organizerAccess":true}']));
  });

  it("organizer-access: exactly {\"organizerAccess\":false} for plain, scorekeeper-only, approved-unused, revoked, terminal-only, operator-only and malformed state", async () => {
    const { GET } = await import("../app/api/gaming/competitions/organizer-access/route");
    const cases: Array<[string, unknown, unknown?, { unusedPilot?: unknown; operational?: unknown }?]> = [
      ["a member with no competitions", [competition({ competitionId: "a" })]],
      ["an appointed scorekeeper only", [competition({ competitionId: "a" })], [{ competitionId: "a", competitionFixtureId: "f1" }]],
      ["an approved member whose capability is unused", [competition({ competitionId: "a" })], [], { unusedPilot: true }],
      ["an internal operator with no competition of their own", [competition({ competitionId: "a" })], [], { operational: true }],
      ["a revoked organizer", [competition({ competitionId: "a", organizerGamingMemberId: ME, hostBound: true, hostAccessRevoked: true })]],
      ["an organizer whose only competition is COMPLETE", [competition({ competitionId: "a", organizerGamingMemberId: ME, state: "COMPLETE" })]],
      ["an organizer whose only competition is cancelled", [competition({ competitionId: "a", organizerGamingMemberId: ME, state: "CANCELLED_WITHOUT_CHAMPION", hostBound: true, hostAccessRevoked: false })]],
      ["malformed state", [competition({ competitionId: "a", organizerGamingMemberId: ME, hostBound: true, hostAccessRevoked: "false" as unknown as boolean })]],
      ["a non-list answer", { competitions: "nope" }],
    ];
    for (const [label, competitions, appointments, abilities] of cases) {
      use(adminRepo(competitions, appointments ?? [], abilities ?? {}));
      const res = await GET(request());
      expect(res.status, label).toBe(200);
      expect(await res.text(), label).toBe('{"organizerAccess":false}');
    }
  });

  it("organizer-access: a signed-out or invalid caller follows the existing bounded 401, uncached, and the repository is never built", async () => {
    vi.mocked(httpAuth.requireGamingMember).mockResolvedValue({ errorResponse: new Response(JSON.stringify({ error: "A valid Authorization header for an authenticated Gaming Member is required." }), { status: 401 }) as never });
    const { GET } = await import("../app/api/gaming/competitions/organizer-access/route");
    const res = await GET(new Request("http://localhost/probe"));
    expect(res.status).toBe(401);
    expect(res.headers.get("cache-control")).toBe(NO_STORE);
    expect((await res.json()) as Record<string, unknown>).not.toHaveProperty("organizerAccess");
    expect(httpAuth.buildCompetitionsRepo).not.toHaveBeenCalled();
  });

  it("all three routes: Competitions readiness off is a 503 before any authentication, uncached", async () => {
    process.env.COMPETITIONS_SCHEMA_READY = "false";
    for (const route of ["organizer-access", "administration", "[competitionId]/scorekeeper-administration"]) {
      const { GET } = await import(`../app/api/gaming/competitions/${route}/route`);
      const res = await GET(request(), { params: { competitionId: "11111111-1111-4111-8111-111111111111" } });
      expect(res.status, route).toBe(503);
      expect(res.headers.get("cache-control"), route).toBe(NO_STORE);
      expect(httpAuth.requireGamingMember, route).not.toHaveBeenCalled();
    }
  });

  it("organizer-access: an internal failure is a generic 500 with no boolean, never a guessed true", async () => {
    const failing = adminRepo([]);
    failing.listCompetitions.mockRejectedValue(Object.assign(new Error("connection string leaked here"), { code: "XX000" }));
    use(failing);
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const { GET } = await import("../app/api/gaming/competitions/organizer-access/route");
    const res = await GET(request());
    const text = await res.text();
    expect(res.status).toBe(500);
    expect(res.headers.get("cache-control")).toBe(NO_STORE);
    expect(text).toBe('{"error":"Could not determine organizer access."}');
    expect(text).not.toMatch(/organizerAccess|connection string/);
    expect(JSON.stringify(spy.mock.calls)).not.toContain("connection string"); // only the error code is logged
    spy.mockRestore();
  });

  it("organizer-access: reads only the competitions — never host applications, capabilities, authority or any appointment", async () => {
    const repo = adminRepo([competition({ competitionId: "mine", organizerGamingMemberId: ME })]);
    use(repo);
    const { GET } = await import("../app/api/gaming/competitions/organizer-access/route");
    await GET(request());
    expect(repo.listCompetitions).toHaveBeenCalledTimes(1);
    expect(repo.listScorekeeperAppointments).not.toHaveBeenCalled();
    expect(repo.hasUnusedPilotAbility).not.toHaveBeenCalled();
    expect(repo.hasOperationalAuthority).not.toHaveBeenCalled(); // operational authority is never part of this signal
  });

  it("administration: the caller's own active competitions only, uncached; an unrelated open one, a scorekeeper appointment and a terminal one reveal nothing", async () => {
    const repo = adminRepo(
      [
        competition({ competitionId: "unrelated-open" }), competition({ competitionId: "mine", organizerGamingMemberId: ME, state: "DRAFT" }),
        competition({ competitionId: "scored", state: "PUBLISHED" }), competition({ competitionId: "mine-ended", organizerGamingMemberId: ME, state: "COMPLETE" }),
      ],
      [{ competitionId: "scored", competitionFixtureId: "f1" }]
    );
    use(repo);
    const { GET } = await import("../app/api/gaming/competitions/administration/route");
    const res = await GET(request());
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe(NO_STORE);
    const body = (await res.json()) as { competitions: Array<{ competitionId: string; access: string }> };
    expect(body.competitions.map((c) => [c.competitionId, c.access])).toEqual([["mine", "ORGANIZER"]]);
    for (const hidden of ["unrelated-open", "scored", "mine-ended"]) expect(JSON.stringify(body)).not.toContain(hidden);
    expect(repo.listScorekeeperAppointments).not.toHaveBeenCalled();
  });

  it("administration: a member with no administrative relationship receives exactly an empty list and no operation", async () => {
    use(adminRepo([competition({ competitionId: "a" }), competition({ competitionId: "b", state: "PUBLISHED" }), competition({ competitionId: "c", hostBound: true, hostAccessRevoked: false })], [{ competitionId: "b", competitionFixtureId: "f" }], { unusedPilot: true }));
    const { GET } = await import("../app/api/gaming/competitions/administration/route");
    const res = await GET(request());
    const text = await res.text();
    expect(text).toBe('{"competitions":[],"operations":{"createCompetition":false}}');
    for (const leak of ["Name of", "a\"", "PUBLISHED", "TEAM_REGISTRATION_OPEN", "DRAFT", "createFirstPilot"]) expect(text).not.toContain(leak);
  });

  it("administration: createCompetition is true only for the OPERATIONAL relationship, and independent of which competitions the caller organizes", async () => {
    const { GET } = await import("../app/api/gaming/competitions/administration/route");
    use(adminRepo([competition({ competitionId: "mine", organizerGamingMemberId: ME, hostBound: true, hostAccessRevoked: false })], [], { operational: false }));
    expect((await (await GET(request())).json() as { operations: unknown }).operations).toEqual({ createCompetition: false });
    use(adminRepo([], [], { operational: true }));
    expect(await (await GET(request())).text()).toBe('{"competitions":[],"operations":{"createCompetition":true}}');
  });

  it("administration: 401 follows the existing contract and an internal failure is a generic 500, both uncached", async () => {
    const { GET } = await import("../app/api/gaming/competitions/administration/route");
    vi.mocked(httpAuth.requireGamingMember).mockResolvedValue({ errorResponse: new Response(JSON.stringify({ error: "x" }), { status: 401 }) as never });
    const unauthenticated = await GET(request());
    expect(unauthenticated.status).toBe(401);
    expect(unauthenticated.headers.get("cache-control")).toBe(NO_STORE);

    vi.mocked(httpAuth.requireGamingMember).mockResolvedValue({ gamingMemberId: ME });
    const failing = adminRepo([]);
    failing.listCompetitions.mockRejectedValue(new Error("boom"));
    use(failing);
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const res = await GET(request());
    expect(res.status).toBe(500);
    expect(res.headers.get("cache-control")).toBe(NO_STORE);
    expect(await res.text()).toBe('{"error":"Failed to load your competitions."}');
    spy.mockRestore();
  });

  it("administration: a failed read of the OPERATIONAL authority is a generic 500 — the create operation is never guessed open", async () => {
    const { GET } = await import("../app/api/gaming/competitions/administration/route");
    const failing = adminRepo([]);
    failing.hasOperationalAuthority.mockRejectedValue(new Error("authority unreadable"));
    use(failing);
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const res = await GET(request());
    expect(res.status).toBe(500);
    expect(await res.text()).toBe('{"error":"Failed to load your competitions."}');
    spy.mockRestore();
  });

  describe("scorekeeper-administration: ONE addressed competition, the appointment re-confirmed on the server", () => {
    const CID = "11111111-1111-4111-8111-111111111111";
    const OTHER_CID = "22222222-2222-4222-8222-222222222222";
    const fixture = (id: string, scorekeeper: unknown, over: Record<string, unknown> = {}) => ({
      competitionFixtureId: id, competitionId: CID, fixtureRole: "SEMIFINAL_1", scheduledAt: "2026-11-01T10:00:00Z", teamACompetitionTeamId: "ta", teamBCompetitionTeamId: "tb",
      teamASourceFixtureId: "SECRET-SOURCE", teamBSourceFixtureId: null, state: "CHECKIN_OPEN", scorekeeperGamingMemberId: scorekeeper, createdAt: "x", ...over,
    });
    const team = (id: string, name: string, status = "ACCEPTED") => ({ competitionTeamId: id, competitionId: CID, name, status, captainGamingMemberId: "captain", publicCode: `${id}-code` });
    function scoreRepo(competitionRecord: unknown, fixtures: unknown, teams: unknown = []) {
      return {
        getCompetitionById: vi.fn().mockResolvedValue(competitionRecord), getCompetitionFixtures: vi.fn().mockResolvedValue(fixtures), getCompetitionTeams: vi.fn().mockResolvedValue(teams),
        // traps: this route never lists, never reads authority, never reads appointments across competitions
        listCompetitions: vi.fn(), listScorekeeperAppointments: vi.fn(), hasUnusedPilotAbility: vi.fn(), hasOperationalAuthority: vi.fn(),
      };
    }
    const comp = (over: Partial<CompetitionRecord> = {}) => competition({ competitionId: CID, state: "PUBLISHED", name: "The Cup", ...over });
    const call = async (competitionId: string, repo = scoreRepo(comp(), [fixture("f1", ME)])) => {
      use(repo);
      const { GET } = await import("../app/api/gaming/competitions/[competitionId]/scorekeeper-administration/route");
      const res = await GET(request(), { params: { competitionId } });
      return { res, text: await res.text(), repo };
    };

    it("returns only that competition, only the fixtures currently assigned to the caller, and only the teams of those fixtures — uncached", async () => {
      const repo = scoreRepo(comp(), [fixture("f-mine", ME), fixture("f-theirs", OTHER, { teamACompetitionTeamId: "tc", teamBCompetitionTeamId: "td" }), fixture("f-none", null)], [
        team("ta", "Alpha"), team("tb", "Bravo"), team("tc", "Charlie"), team("td", "Delta"), team("te", "Echo"),
      ]);
      const out = await call(CID, repo);
      expect(out.res.status).toBe(200);
      expect(out.res.headers.get("cache-control")).toBe(NO_STORE);
      expect(JSON.parse(out.text)).toEqual({
        competition: { competitionId: CID, name: "The Cup", state: "PUBLISHED" },
        teams: [{ competitionTeamId: "ta", name: "Alpha" }, { competitionTeamId: "tb", name: "Bravo" }],
        fixtures: [{ competitionFixtureId: "f-mine", fixtureRole: "SEMIFINAL_1", state: "CHECKIN_OPEN", scheduledAt: "2026-11-01T10:00:00Z", teamACompetitionTeamId: "ta", teamBCompetitionTeamId: "tb" }],
      });
      for (const leak of ["f-theirs", "f-none", "Charlie", "Delta", "Echo", "SECRET-SOURCE", "organizer", "publicCode", "-code", ME, OTHER]) expect(out.text, leak).not.toContain(leak);
    });

    it("hands the EXACT addressed id to the repository and reads nothing else: no competition list, no appointment list, no authority", async () => {
      const out = await call(CID);
      expect(out.res.status).toBe(200);
      expect(out.repo.getCompetitionById).toHaveBeenCalledWith(CID);
      expect(out.repo.getCompetitionFixtures).toHaveBeenCalledWith(CID);
      for (const trap of [out.repo.listCompetitions, out.repo.listScorekeeperAppointments, out.repo.hasUnusedPilotAbility, out.repo.hasOperationalAuthority]) expect(trap).not.toHaveBeenCalled();
    });

    it("the identical 404 for a wrong competition, an unrelated member, a removed or replaced appointment, a revoked host's self-appointment and a malformed fixture list", async () => {
      const cases: Array<[string, string, ReturnType<typeof scoreRepo>]> = [
        ["a competition that does not exist", OTHER_CID, scoreRepo(null, [])],
        ["a competition the caller does not score in", CID, scoreRepo(comp(), [fixture("f1", OTHER)])],
        ["an appointment that was replaced", CID, scoreRepo(comp(), [fixture("f1", "someone-new")])],
        ["an appointment that was removed", CID, scoreRepo(comp(), [fixture("f1", null)])],
        ["a fixture of a different competition", CID, scoreRepo(comp(), [fixture("f1", ME, { competitionId: OTHER_CID })])],
        ["a revoked host's self-appointment", CID, scoreRepo(comp({ organizerGamingMemberId: ME, hostBound: true, hostAccessRevoked: true }), [fixture("f1", ME)])],
        ["a host pilot with no binding state", CID, scoreRepo(comp({ organizerGamingMemberId: ME, hostBound: true }), [fixture("f1", ME)])],
        ["a non-list fixture answer", CID, scoreRepo(comp(), "nope")],
        ["a malformed fixture record", CID, scoreRepo(comp(), [null, { competitionFixtureId: 9, competitionId: CID, scorekeeperGamingMemberId: ME }])],
      ];
      const bodies = new Set<string>();
      for (const [label, id, repo] of cases) {
        const out = await call(id, repo);
        expect(out.res.status, label).toBe(404);
        expect(out.res.headers.get("cache-control"), label).toBe(NO_STORE);
        expect(repo.getCompetitionTeams, label).not.toHaveBeenCalled();
        bodies.add(out.text);
      }
      expect(bodies.size).toBe(1);                                                    // the very same body every time: it reveals nothing about what exists
      expect([...bodies][0]).toBe('{"error":"Scorekeeper access was not found for this competition."}');
    });

    it("a malformed competition id is the same 404 and the repository is never even built", async () => {
      for (const bad of ["", "not-a-uuid", "../../x", "11111111-1111-4111-8111-11111111111", "11111111-1111-4111-8111-1111111111111", "' or 1=1 --", CID.toUpperCase() + "x"]) {
        vi.mocked(httpAuth.buildCompetitionsRepo).mockClear();
        const { GET } = await import("../app/api/gaming/competitions/[competitionId]/scorekeeper-administration/route");
        const res = await GET(request(), { params: { competitionId: bad } });
        expect(res.status, bad).toBe(404);
        expect(httpAuth.buildCompetitionsRepo, bad).not.toHaveBeenCalled();
      }
    });

    it("the competition's own organizer who is also appointed (with standing) is a scorekeeper of that fixture; a terminal competition does not hide a current appointment", async () => {
      expect((await call(CID, scoreRepo(comp({ organizerGamingMemberId: ME }), [fixture("f1", ME)]))).res.status).toBe(200);
      expect((await call(CID, scoreRepo(comp({ state: "COMPLETE" }), [fixture("f1", ME)]))).res.status).toBe(200);
    });

    it("401 follows the existing contract (uncached, repository never built); a failed read is a generic 500 that logs only a code", async () => {
      const { GET } = await import("../app/api/gaming/competitions/[competitionId]/scorekeeper-administration/route");
      vi.mocked(httpAuth.requireGamingMember).mockResolvedValue({ errorResponse: new Response(JSON.stringify({ error: "x" }), { status: 401 }) as never });
      const unauthenticated = await GET(request(), { params: { competitionId: CID } });
      expect(unauthenticated.status).toBe(401);
      expect(unauthenticated.headers.get("cache-control")).toBe(NO_STORE);
      expect(httpAuth.buildCompetitionsRepo).not.toHaveBeenCalled();

      vi.mocked(httpAuth.requireGamingMember).mockResolvedValue({ gamingMemberId: ME });
      const failing = scoreRepo(comp(), []);
      failing.getCompetitionFixtures.mockRejectedValue(Object.assign(new Error("connection string leaked here"), { code: "XX000" }));
      use(failing);
      const spy = vi.spyOn(console, "error").mockImplementation(() => {});
      const res = await GET(request(), { params: { competitionId: CID } });
      const text = await res.text();
      expect(res.status).toBe(500);
      expect(res.headers.get("cache-control")).toBe(NO_STORE);
      expect(text).toBe('{"error":"Failed to load your scorekeeper assignment."}');
      expect(JSON.stringify(spy.mock.calls)).not.toContain("connection string");
      spy.mockRestore();
    });
  });

  it("all three routes are read-only: GET is the only method any module exports", async () => {
    for (const route of ["organizer-access", "administration", "[competitionId]/scorekeeper-administration"]) {
      const mod = (await import(`../app/api/gaming/competitions/${route}/route`)) as Record<string, unknown>;
      expect(Object.keys(mod).filter((k) => ["POST", "PUT", "PATCH", "DELETE"].includes(k)), route).toEqual([]);
      expect(typeof mod.GET, route).toBe("function");
    }
  });
});

describe("operations — what THIS caller may start creating, decided on the server from the OPERATIONAL relationship alone", () => {
  it("is false for every member without it — including an approved applicant whose capability is unused, who is never even asked", async () => {
    expect(await getAdministrativeOperations(adminRepo([]), ME)).toEqual({ createCompetition: false });
    const repo = adminRepo([], [], { unusedPilot: true });
    expect(await getAdministrativeOperations(repo, ME)).toEqual({ createCompetition: false });
    expect(repo.hasUnusedPilotAbility).not.toHaveBeenCalled();
  });

  it("createCompetition is true only for the active OPERATIONAL authority — and offers exactly that one operation", async () => {
    expect(await getAdministrativeOperations(adminRepo([], [], { operational: true }), ME)).toEqual({ createCompetition: true });
    expect(Object.keys(await getAdministrativeOperations(adminRepo([], [], { operational: true }), ME))).toEqual(["createCompetition"]);
  });

  it("anything but exactly true is false (a malformed answer never opens the creation control), and an empty caller gets none", async () => {
    for (const malformed of ["yes", 1, "true", {}, [], null, undefined]) {
      expect(await getAdministrativeOperations(adminRepo([], [], { operational: malformed }), ME), String(malformed)).toEqual({ createCompetition: false });
    }
    expect(await getAdministrativeOperations(adminRepo([], [], { operational: true }), ""), "empty caller").toEqual({ createCompetition: false });
  });

  it("a scorekeeper, a revoked organizer and an applicant are given no creation: only the competitions they actively organize are returned", async () => {
    const revoked = competition({ competitionId: "r", organizerGamingMemberId: ME, hostBound: true, hostAccessRevoked: true });
    const out = await describeAdministration(adminRepo([revoked, competition({ competitionId: "s", state: "PUBLISHED" })], [{ competitionId: "s", competitionFixtureId: "f1" }]), ME);
    expect(out).toEqual({ competitions: [], operations: { createCompetition: false } });
  });

  it("OPERATIONAL authority alone is not Organizer Access, and Organizer Access alone is not the create operation", async () => {
    const operatorOnly = adminRepo([competition({ competitionId: "other" })], [], { operational: true });
    expect(await hasOrganizerAccess(operatorOnly, ME)).toBe(false);
    expect((await describeAdministration(operatorOnly, ME)).operations).toEqual({ createCompetition: true });
    const organizerOnly = adminRepo([competition({ competitionId: "mine", organizerGamingMemberId: ME, hostBound: true, hostAccessRevoked: false })], [], { operational: false });
    expect(await hasOrganizerAccess(organizerOnly, ME)).toBe(true);
    expect((await describeAdministration(organizerOnly, ME)).operations).toEqual({ createCompetition: false });
  });

  it("a repository failure while reading the authority rejects, so the route answers a generic 500 and never an open control", async () => {
    const repo = adminRepo([]);
    repo.hasOperationalAuthority.mockRejectedValue(new Error("authority unreadable"));
    await expect(getAdministrativeOperations(repo, ME)).rejects.toThrow("authority unreadable");
  });
});

// =============================================================================
// UG-CR-GATE-100 — Bounded Organizer Access Correction Gate: the nine required cases (unit level)
//
// Written and run red against the RPT-100A candidate BEFORE any source change (see the gate return). The repository fake still OFFERS the two reads
// the correction removes (an appointment list, an unused-ability check) as TRAPS: the corrected code must not call them, so a stray call fails.
// =============================================================================

describe("UG-CR-GATE-100 correction — the nine required cases (unit)", () => {
  const TERMINAL = ["COMPLETE", "CANCELLED_WITHOUT_CHAMPION"] as const;
  const mine = (over: Partial<CompetitionRecord> & { competitionId: string }) => competition({ organizerGamingMemberId: ME, ...over });

  it("CASE-1 approved-unused capability: Organizer Access is FALSE (a capability is not active Competition Organizer authority)", async () => {
    const repo = adminRepo([competition({ competitionId: "someone-elses" })], [], { unusedPilot: true });
    expect(await hasOrganizerAccess(repo, ME)).toBe(false);
    expect(repo.hasUnusedPilotAbility).not.toHaveBeenCalled();
  });

  it("CASE-2 a scorekeeper appointment never places a competition in the default administration list", async () => {
    const repo = adminRepo([competition({ competitionId: "scored", state: "PUBLISHED" })], [{ competitionId: "scored", competitionFixtureId: "f1" }]);
    expect(await listAdministrableCompetitions(repo, ME)).toEqual([]);
  });

  it("CASE-3 no global enumeration of scorekeeper appointments — not for Home, not for the default source", async () => {
    const repo = adminRepo([mine({ competitionId: "m1", state: "PUBLISHED" })], [{ competitionId: "x", competitionFixtureId: "f1" }]);
    await hasOrganizerAccess(repo, ME);
    await listAdministrableCompetitions(repo, ME);
    await describeAdministration(repo, ME);
    expect(repo.listScorekeeperAppointments).not.toHaveBeenCalled();
  });

  it.each(TERMINAL)("CASE-4 a %s competition does not yield active Organizer Access (internal organizer and host pilot alike)", async (state) => {
    expect(await hasOrganizerAccess(adminRepo([mine({ competitionId: "t", state })]), ME)).toBe(false);
    expect(await hasOrganizerAccess(adminRepo([mine({ competitionId: "t", state, hostBound: true, hostAccessRevoked: false })]), ME)).toBe(false);
  });

  it.each(TERMINAL)("CASE-5 a %s competition is not an active administration target — only the active one is returned", async (state) => {
    const repo = adminRepo([mine({ competitionId: "ended", state }), mine({ competitionId: "live", state: "PUBLISHED" })]);
    expect((await listAdministrableCompetitions(repo, ME)).map((c) => c.competitionId)).toEqual(["live"]);
    expect(await listAdministrableCompetitions(adminRepo([mine({ competitionId: "ended", state })]), ME)).toEqual([]);
  });

  it("CASE-6 the addressed competition view carries the caller's own scorekeeper fixtures — and the bounded route returns only that competition and those fixtures", async () => {
    const { getCompetitionView } = await import("../lib/gaming/competitions/getCompetitionView");
    const fixture = (id: string, scorekeeper: string | null) => ({
      competitionFixtureId: id, competitionId: "11111111-1111-4111-8111-111111111111", fixtureRole: "SEMIFINAL_1", scheduledAt: "2026-11-01T10:00:00Z",
      teamACompetitionTeamId: "ta", teamBCompetitionTeamId: "tb", teamASourceFixtureId: null, teamBSourceFixtureId: null, state: "CHECKIN_OPEN",
      scorekeeperGamingMemberId: scorekeeper, createdAt: "x",
    });
    const stub = {
      getCompetitionById: vi.fn().mockResolvedValue(competition({ competitionId: "11111111-1111-4111-8111-111111111111", state: "PUBLISHED" })),
      getCompetitionTeams: vi.fn().mockResolvedValue([]),
      getCompetitionFixtures: vi.fn().mockResolvedValue([fixture("f-mine", ME), fixture("f-theirs", OTHER), fixture("f-unassigned", null)]),
      getMyRegistration: vi.fn().mockResolvedValue(null), getMyTeamMembership: vi.fn().mockResolvedValue(null),
      getMyPendingJoinRequest: vi.fn().mockResolvedValue(null), getMemberParticipationRecords: vi.fn().mockResolvedValue([]),
      getDisplayNames: vi.fn().mockResolvedValue({}), getCurrentRoster: vi.fn().mockResolvedValue(null),
      getRegistrationStatus: vi.fn().mockResolvedValue(null), getRegistrationFreeze: vi.fn().mockResolvedValue(null),
    };
    const view = await getCompetitionView(stub as never, "11111111-1111-4111-8111-111111111111", ME);
    expect((view as unknown as { myScorekeeperFixtureIds?: string[] }).myScorekeeperFixtureIds).toEqual(["f-mine"]);

    const mod = (await import("../app/api/gaming/competitions/[competitionId]/scorekeeper-administration/route")) as { GET: (r: Request, c: { params: { competitionId: string } }) => Promise<Response> };
    expect(typeof mod.GET).toBe("function");
  });

  it("CASE-7 the Create Competition operation exists for the OPERATIONAL relationship only — no other creation operation is ever offered", async () => {
    expect(await getAdministrativeOperations(adminRepo([], [], { unusedPilot: true }), ME)).toEqual({ createCompetition: false });
    expect(await getAdministrativeOperations(adminRepo([], [], { operational: true }), ME)).toEqual({ createCompetition: true });
    expect(await describeAdministration(adminRepo([], [], { unusedPilot: true }), ME)).toEqual({ competitions: [], operations: { createCompetition: false } });
  });

  it("CASE-9 a malformed or failed read of any authorization input fails closed — never a guessed true", async () => {
    for (const malformed of ["yes", 1, "true", {}, [], null, undefined]) {
      expect(await getAdministrativeOperations(adminRepo([], [], { operational: malformed }), ME), String(malformed)).toEqual({ createCompetition: false });
    }
    for (const bad of [undefined, null, {}, "x", 5]) expect(await hasOrganizerAccess(adminRepo(bad), ME)).toBe(false);
    const failing = adminRepo([]);
    failing.hasOperationalAuthority.mockRejectedValue(new Error("authority unreadable"));
    await expect(getAdministrativeOperations(failing, ME)).rejects.toThrow("authority unreadable");
  });
});
