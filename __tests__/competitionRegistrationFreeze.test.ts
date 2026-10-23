import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { openAdminPage, openMemberPage } from "./helpers/competitionAdminPageHarness";

// Mocks the ONE module boundary between a route and the outside world (credentials, repository construction, caller identity), exactly as
// competitions.test.ts does; statusForCompetitionsError and the schema-ready guard keep their REAL implementation.
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

import type { CompetitionsRepository } from "../lib/gaming/competitions/db/competitionsRepository";
import { getCompetitionView } from "../lib/gaming/competitions/getCompetitionView";
import { closeTeamRegistration } from "../lib/gaming/competitions/closeTeamRegistration";
import { statusForCompetitionsError } from "../lib/gaming/competitions/httpAuth";
import { translateError } from "../lib/gaming/competitions/db/supabaseCompetitionsRepository";
import {
  CompetitionAccessDeniedError, CompetitionNotFoundError, HostAccessRevokedError, TeamRegistrationCapacityNotReachedError, TeamRegistrationNotOpenError,
} from "../lib/gaming/competitions/types";

/**
 * UG-CR-GATE-SSS-007 — Registration Deadline and Competition Freeze Foundation: the application side.
 *
 * The decisions themselves (the deadline, the freeze, who may do what) are made inside the atomic database operations and proved against a real
 * database in competitionRegistrationFreezeSupabase.contract.test.ts. This file proves what the application adds on top, and that it adds
 * nothing it should not: the bounded, server-derived registration status in the addressed competition view (and nowhere else), the typed
 * errors and their stable codes, the deterministic freeze digest, the routes' error mapping, and the two pages — which render what the server
 * says and never decide that a write is allowed.
 */

const loadFreeze = () => import("../lib/gaming/competitions/registrationFreeze");

const COMPETITION_ID = "11111111-1111-4111-8111-111111111111";
const CODE = "AbCdEfGhIjKlMnOpQrStUv";
const SIGNED = { status: "authenticated", email: "a@example.com", gamingMemberId: "m-1", displayName: "Pat" };
const UUID_LIKE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;

function makeFake(): CompetitionsRepository {
  const names = [
    "createCompetition", "addCompetitionTeam", "openTeamRegistration", "proposeCompetitionTeam", "decideCompetitionTeam", "closeTeamRegistration",
    "resolveCompetitionByPublicCode", "resolveCompetitionTeamByPublicCode", "cancelCompetition", "publishCompetition", "registerForCompetition", "requestJoinTeam",
    "decideJoinRequest", "organizerReviewJoinRequest", "declareRoster", "checkIn", "appointScorekeeper", "submitFixtureEvidence", "raiseDispute", "correctFixture",
    "finalizeFixture", "forfeitFixture", "voidFixture", "listCompetitions", "listCompetitionIdsInvolvingMember", "getCompetitionById", "getCompetitionTeams",
    "getCompetitionTeamById", "getCompetitionFixtures", "getFixtureById", "getMyRegistration", "getCompetitionRegistrations", "getMyTeamMembership",
    "getMyPendingJoinRequest", "getPendingJoinRequestsForTeam", "getTeamMemberships", "getDisplayNames", "getCurrentRoster", "getCheckIns", "getCurrentAttestations",
    "getCurrentEvidence", "getCurrentGoalEvents", "getCurrentAssistEvents", "getCurrentShootout", "getDisputes", "getCurrentFinalization", "getMemberParticipationRecords",
    "getRegistrationStatus", "getRegistrationFreeze",
  ];
  return Object.fromEntries(names.map((n) => [n, vi.fn()])) as unknown as CompetitionsRepository;
}
const fn = (f: unknown) => f as ReturnType<typeof vi.fn>;

// ---------------------------------------------------------------------------------------------------------------------------------------------
// The module: errors, codes and the deterministic digest
// ---------------------------------------------------------------------------------------------------------------------------------------------

describe("registration errors: stable codes, bounded wording, and the database messages that produce them", () => {
  it("the registration-opening error carries one of three stable codes and says what to do", async () => {
    const { RegistrationOpeningError } = await loadFreeze();
    for (const code of ["PLAN_MISSING", "PLAN_INVALID", "DEADLINE_EXPIRED"] as const) {
      const err = new RegistrationOpeningError(code);
      expect(err).toBeInstanceOf(Error);
      expect(err.name).toBe("RegistrationOpeningError");
      expect(err.code).toBe(code);
      expect(err.message.length).toBeGreaterThan(20);
      expect(err.message.length).toBeLessThan(200);
    }
    expect(new RegistrationOpeningError("PLAN_MISSING").message).toMatch(/plan/i);
    expect(new RegistrationOpeningError("DEADLINE_EXPIRED").message).toMatch(/deadline/i);
  });

  it("the freeze error carries one of eight stable codes", async () => {
    const { RegistrationFreezeError } = await loadFreeze();
    const codes = ["PLAN_MISSING", "PLAN_INVALID", "DEADLINE_NOT_REACHED", "PENDING_PROPOSALS", "PENDING_JOIN_REQUESTS", "ROSTER_BELOW_MINIMUM", "ROSTER_ABOVE_MAXIMUM", "MEMBER_CONFLICT"] as const;
    for (const code of codes) {
      const err = new RegistrationFreezeError(code);
      expect(err.name).toBe("RegistrationFreezeError");
      expect(err.code).toBe(code);
      expect(err.message.length).toBeLessThan(200);
    }
  });

  it("each database message becomes the right typed error (and an unrelated message becomes none)", async () => {
    const { registrationOpeningErrorFromDatabase, registrationFreezeErrorFromDatabase } = await loadFreeze();
    expect(registrationOpeningErrorFromDatabase("REGISTRATION_OPENING_PLAN_MISSING: no plan")?.code).toBe("PLAN_MISSING");
    expect(registrationOpeningErrorFromDatabase("REGISTRATION_OPENING_PLAN_INVALID: roster bounds")?.code).toBe("PLAN_INVALID");
    expect(registrationOpeningErrorFromDatabase("REGISTRATION_OPENING_DEADLINE_EXPIRED: passed")?.code).toBe("DEADLINE_EXPIRED");
    expect(registrationOpeningErrorFromDatabase("COMPETITION_NOT_DRAFT: x")).toBeNull();
    const table: Array<[string, string]> = [
      ["REGISTRATION_FREEZE_PLAN_MISSING: x", "PLAN_MISSING"], ["REGISTRATION_FREEZE_PLAN_INVALID: x", "PLAN_INVALID"],
      ["REGISTRATION_FREEZE_DEADLINE_NOT_REACHED: x", "DEADLINE_NOT_REACHED"], ["REGISTRATION_FREEZE_PENDING_PROPOSALS: 2 team proposal(s) are still pending", "PENDING_PROPOSALS"],
      ["REGISTRATION_FREEZE_PENDING_JOIN_REQUESTS: 3 join request(s) are still pending", "PENDING_JOIN_REQUESTS"],
      ["REGISTRATION_FREEZE_ROSTER_BELOW_MINIMUM: a team has 4 member(s); the minimum is 5", "ROSTER_BELOW_MINIMUM"],
      ["REGISTRATION_FREEZE_ROSTER_ABOVE_MAXIMUM: a team has 12 member(s); the maximum is 8", "ROSTER_ABOVE_MAXIMUM"], ["REGISTRATION_FREEZE_MEMBER_CONFLICT: x", "MEMBER_CONFLICT"],
    ];
    for (const [message, code] of table) expect(registrationFreezeErrorFromDatabase(message)?.code, message).toBe(code);
    expect(registrationFreezeErrorFromDatabase("TEAM_REGISTRATION_CAPACITY_NOT_REACHED: x")).toBeNull();
    // The counts the database states reach the wording; nothing else of the message does.
    expect(registrationFreezeErrorFromDatabase(table[5][0])!.message).toMatch(/4/);
    expect(registrationFreezeErrorFromDatabase(table[5][0])!.message).toMatch(/5/);
    expect(registrationFreezeErrorFromDatabase(table[6][0])!.message).toMatch(/12/);
    expect(registrationFreezeErrorFromDatabase("REGISTRATION_FREEZE_PENDING_PROPOSALS: 2 team proposal(s) are still pending<script>")!.message).not.toMatch(/script|</);
  });

  it("the repository's translateError maps every new database code to its error and keeps the existing ones", async () => {
    const { RegistrationOpeningError, RegistrationFreezeError } = await loadFreeze();
    const db = (message: string) => translateError({ code: "P0001", message });
    expect(db("REGISTRATION_OPENING_PLAN_MISSING: x")).toBeInstanceOf(RegistrationOpeningError);
    expect(db("REGISTRATION_OPENING_DEADLINE_EXPIRED: x")).toBeInstanceOf(RegistrationOpeningError);
    expect(db("REGISTRATION_FREEZE_ROSTER_BELOW_MINIMUM: a team has 4 member(s); the minimum is 5")).toBeInstanceOf(RegistrationFreezeError);
    expect(db("REGISTRATION_FREEZE_MEMBER_CONFLICT: x")).toBeInstanceOf(RegistrationFreezeError);
    // The existing codes are untouched: a deadline or freeze refusal on any other write reuses the already-mapped "not open" error.
    expect(db("TEAM_REGISTRATION_NOT_OPEN: the registration deadline for this competition has passed")).toBeInstanceOf(TeamRegistrationNotOpenError);
    expect(db("TEAM_REGISTRATION_CAPACITY_NOT_REACHED: exactly four accepted teams are required to close team registration (found 3)")).toBeInstanceOf(TeamRegistrationCapacityNotReachedError);
    expect(db("COMPETITION_ACCESS_DENIED: only this competition's own organizer may close team registration")).toBeInstanceOf(CompetitionAccessDeniedError);
    expect(db("HOST_ACCESS_REVOKED: x")).toBeInstanceOf(HostAccessRevokedError);
    expect(db("COMPETITION_NOT_FOUND: x")).toBeInstanceOf(CompetitionNotFoundError);
  });

  it("neither error is exported from types.ts (so the shared status table and its coverage test are untouched), and the status table does not know them", async () => {
    const types = await import("../lib/gaming/competitions/types");
    expect(Object.keys(types).filter((k) => /Registration(Opening|Freeze)Error/.test(k))).toEqual([]);
    const { RegistrationOpeningError, RegistrationFreezeError } = await loadFreeze();
    expect(statusForCompetitionsError(new RegistrationOpeningError("PLAN_MISSING"))).toBeNull(); // the two routes that raise them answer for them
    expect(statusForCompetitionsError(new RegistrationFreezeError("DEADLINE_NOT_REACHED"))).toBeNull();
  });
});

describe("the freeze digest: deterministic, order-independent, and sensitive to every competitive fact", () => {
  const T = (n: string) => `aaaaaaaa-0000-4000-8000-${n.padStart(12, "0")}`;
  const evidence = () => ({
    competitionId: COMPETITION_ID, planningRevisionId: "22222222-2222-4222-8222-222222222222", formatKey: "SOCCER_5V5" as const,
    rosterMinimum: 5, rosterMaximum: 8, registrationDeadlineUtc: "2026-11-01T00:00:00.000Z",
    teams: [
      { competitionTeamId: T("a"), captainGamingMemberId: "cccccccc-0000-4000-8000-00000000000a", memberGamingMemberIds: ["eeeeeeee-0000-4000-8000-000000000002", "eeeeeeee-0000-4000-8000-000000000001"] },
      { competitionTeamId: T("1"), captainGamingMemberId: "cccccccc-0000-4000-8000-000000000001", memberGamingMemberIds: [] },
      { competitionTeamId: "bbbbbbbb-0000-4000-8000-000000000002", captainGamingMemberId: "cccccccc-0000-4000-8000-000000000002", memberGamingMemberIds: ["eeeeeeee-0000-4000-8000-000000000003"] },
      { competitionTeamId: T("3"), captainGamingMemberId: "cccccccc-0000-4000-8000-000000000003", memberGamingMemberIds: ["eeeeeeee-0000-4000-8000-000000000004", "eeeeeeee-0000-4000-8000-000000000005"] },
    ],
  });
  // Computed independently (Python hashlib) from the canonical text in registrationFreeze.ts's header; this pins the format forever. UG-CR-GATE-SSS-007A: the
  // deadline line is the exact UTC instant to the millisecond (three fractional digits and "Z"), so this vector is the one for "…T00:00:00.000Z".
  const KNOWN_ANSWER = "7042abe552f0494cf59287b6473578e07025d2c2e1b0d05e62775f2cd394dbbc";
  // The same facts at other valid millisecond instants (also computed independently): the fraction is part of the evidence and is never truncated.
  const FRACTIONAL_ANSWERS: Array<[string, string]> = [
    ["2026-11-01T00:00:00.000Z", "7042abe552f0494cf59287b6473578e07025d2c2e1b0d05e62775f2cd394dbbc"],
    ["2026-11-01T00:00:00.100Z", "5ea9742910e021fd01a6d39fa3407ab8d547680720d0da43eebb9f9ce0b5d78e"],
    ["2026-11-01T00:00:00.250Z", "fa4869b90aac485ff125b463e323657e3e7f8dc50608ee1e774080c528c48935"],
    ["2026-11-01T00:00:00.999Z", "775252914893b4d98111fc3657568cdabeb8f7a9284e8160f79f7b2bcd3ca318"],
  ];

  it("matches an independently computed known answer", async () => {
    const { computeRegistrationFreezeDigest } = await loadFreeze();
    expect(computeRegistrationFreezeDigest(evidence())).toBe(KNOWN_ANSWER);
  });

  it("UG-CR-GATE-SSS-007A: preserves the deadline to the millisecond — .000, .100, .250 and .999 each have their own independently computed digest", async () => {
    const { computeRegistrationFreezeDigest } = await loadFreeze();
    for (const [deadline, answer] of FRACTIONAL_ANSWERS) {
      expect(computeRegistrationFreezeDigest({ ...evidence(), registrationDeadlineUtc: deadline }), deadline).toBe(answer);
    }
    expect(new Set(FRACTIONAL_ANSWERS.map(([, a]) => a)).size).toBe(4);
  });

  it("UG-CR-GATE-SSS-007A: two deadlines that differ only in milliseconds never share a digest (not even one millisecond apart)", async () => {
    const { computeRegistrationFreezeDigest } = await loadFreeze();
    const at = (iso: string) => computeRegistrationFreezeDigest({ ...evidence(), registrationDeadlineUtc: iso });
    expect(at("2026-11-01T00:00:00.000Z")).not.toBe(at("2026-11-01T00:00:00.001Z"));
    expect(at("2026-11-01T00:00:00.249Z")).not.toBe(at("2026-11-01T00:00:00.250Z"));
    expect(at("2026-11-01T00:00:00.998Z")).not.toBe(at("2026-11-01T00:00:00.999Z"));
    expect(at("2026-11-01T00:00:00.999Z")).not.toBe(at("2026-11-01T00:00:01.000Z"));
  });

  it("UG-CR-GATE-SSS-007A: every spelling of one instant canonicalizes to one text — the stored timestamp forms the database returns and the plain ISO form agree", async () => {
    const { computeRegistrationFreezeDigest } = await loadFreeze();
    const at = (value: string) => computeRegistrationFreezeDigest({ ...evidence(), registrationDeadlineUtc: value });
    for (const same of ["2026-11-01T00:00:00Z", "2026-11-01T00:00:00.000Z", "2026-11-01T00:00:00+00:00", "2026-11-01T00:00:00.000000+00:00", "2026-10-31T18:00:00-06:00"]) {
      expect(at(same), same).toBe(KNOWN_ANSWER);
    }
    for (const same of ["2026-11-01T00:00:00.25Z", "2026-11-01T00:00:00.250Z", "2026-11-01T00:00:00.25+00:00", "2026-11-01T00:00:00.250000+00:00", "2026-10-31T18:00:00.250-06:00"]) {
      expect(at(same), same).toBe("fa4869b90aac485ff125b463e323657e3e7f8dc50608ee1e774080c528c48935");
    }
  });

  it("UG-CR-GATE-SSS-007A: an instant finer than a millisecond is refused, never rounded or truncated into another instant's digest", async () => {
    const { computeRegistrationFreezeDigest } = await loadFreeze();
    for (const finer of ["2026-11-01T00:00:00.0001Z", "2026-11-01T00:00:00.250001+00:00", "2026-11-01T00:00:00.999999Z"]) {
      expect(() => computeRegistrationFreezeDigest({ ...evidence(), registrationDeadlineUtc: finer }), finer).toThrow(RangeError);
    }
    for (const unreadable of ["", "tomorrow", "2026-13-45T00:00:00Z"]) {
      expect(() => computeRegistrationFreezeDigest({ ...evidence(), registrationDeadlineUtc: unreadable }), unreadable).toThrow(RangeError);
    }
  });

  it("does not depend on the order teams or members arrive in, and ignores facts that are not competitive data (when, by whom, which record)", async () => {
    const { computeRegistrationFreezeDigest } = await loadFreeze();
    const shuffled = evidence();
    shuffled.teams.reverse();
    for (const t of shuffled.teams) t.memberGamingMemberIds.reverse();
    expect(computeRegistrationFreezeDigest(shuffled)).toBe(KNOWN_ANSWER);
    const extras = { ...evidence(), frozenAt: "2030-01-01T00:00:00.000Z", frozenByGamingMemberId: "ffffffff-0000-4000-8000-000000000001", registrationFreezeId: "dddddddd-0000-4000-8000-000000000001", snapshotDigest: "x" };
    expect(computeRegistrationFreezeDigest(extras as never)).toBe(KNOWN_ANSWER);
  });

  it("changes when any one competitive fact changes", async () => {
    const { computeRegistrationFreezeDigest } = await loadFreeze();
    const mutations: Array<[string, (e: ReturnType<typeof evidence>) => void]> = [
      ["competition", (e) => { e.competitionId = "11111111-1111-4111-8111-111111111112"; }],
      ["planning revision", (e) => { e.planningRevisionId = "22222222-2222-4222-8222-222222222223"; }],
      ["format", (e) => { (e as { formatKey: string }).formatKey = "SOCCER_6V6"; }],
      ["roster minimum", (e) => { e.rosterMinimum = 6; }], ["roster maximum", (e) => { e.rosterMaximum = 9; }],
      ["deadline", (e) => { e.registrationDeadlineUtc = "2026-11-01T00:00:01.000Z"; }],
      ["deadline by one millisecond", (e) => { e.registrationDeadlineUtc = "2026-11-01T00:00:00.001Z"; }],
      ["a team id", (e) => { e.teams[0].competitionTeamId = T("b"); }],
      ["a captain", (e) => { e.teams[1].captainGamingMemberId = "cccccccc-0000-4000-8000-0000000000ff"; }],
      ["a member added", (e) => { e.teams[1].memberGamingMemberIds.push("eeeeeeee-0000-4000-8000-0000000000ff"); }],
      ["a member removed", (e) => { e.teams[3].memberGamingMemberIds.pop(); }],
      ["a member moved to another team", (e) => { const m = e.teams[3].memberGamingMemberIds.pop()!; e.teams[1].memberGamingMemberIds.push(m); }],
    ];
    for (const [label, mutate] of mutations) {
      const e = evidence();
      mutate(e);
      expect(computeRegistrationFreezeDigest(e), label).not.toBe(KNOWN_ANSWER);
    }
  });

  it("verifyRegistrationFreeze is true only when the stored digest equals the recomputed one", async () => {
    const { verifyRegistrationFreeze } = await loadFreeze();
    expect(verifyRegistrationFreeze({ ...evidence(), snapshotDigest: KNOWN_ANSWER } as never)).toBe(true);
    expect(verifyRegistrationFreeze({ ...evidence(), snapshotDigest: KNOWN_ANSWER.replace(/.$/, "0") } as never)).toBe(false);
    expect(verifyRegistrationFreeze({ ...evidence(), rosterMaximum: 9, snapshotDigest: KNOWN_ANSWER } as never)).toBe(false);
  });
});

// ---------------------------------------------------------------------------------------------------------------------------------------------
// The addressed competition view
// ---------------------------------------------------------------------------------------------------------------------------------------------

describe("getCompetitionView: the bounded, server-derived registration status", () => {
  const competition = (over: Record<string, unknown> = {}) => ({
    competitionId: COMPETITION_ID, publicCode: CODE, activityKey: "SOCCER_5V5", name: "Cup", organizerGamingMemberId: "org-1", state: "TEAM_REGISTRATION_OPEN", cancelledReason: null, createdAt: "x", publishedAt: null, ...over,
  });
  const STATUS = {
    deadlineUtc: "2026-11-01T00:00:00.000Z", timeZone: "America/Costa_Rica", deadlineLocal: "2026-10-31T18:00", deadlinePassed: false, acceptingNewWrites: true, frozen: false,
    rosterMinimum: 5, rosterMaximum: 8,
  };
  const EVIDENCE = {
    registrationFreezeId: "dddddddd-0000-4000-8000-000000000001", competitionId: COMPETITION_ID, planningRevisionId: "22222222-2222-4222-8222-222222222222", formatKey: "SOCCER_5V5",
    rosterMinimum: 5, rosterMaximum: 8, registrationDeadlineUtc: "2026-11-01T00:00:00.000Z", frozenAt: "2026-11-01T00:00:05.000Z", frozenByGamingMemberId: "org-1",
    teamCount: 4, memberCount: 3, snapshotDigest: "a".repeat(64),
    teams: [1, 2, 3, 4].map((n) => ({ position: n, competitionTeamId: `t${n}`, captainGamingMemberId: `cap-${n}`, memberCount: n === 1 ? 3 : 0, memberGamingMemberIds: n === 1 ? ["m1", "m2", "m3"] : [] })),
  };
  let repo: CompetitionsRepository;
  beforeEach(() => {
    repo = makeFake();
    fn(repo.getCompetitionById).mockResolvedValue(competition());
    fn(repo.getCompetitionTeams).mockResolvedValue([1, 2, 3, 4].map((n) => ({ competitionTeamId: `t${n}`, publicCode: `p${n}`, competitionId: COMPETITION_ID, name: `Team ${n}`, captainGamingMemberId: `cap-${n}`, status: "ACCEPTED", provenance: "ORGANIZER_CREATED", decidedAt: null, decidedByGamingMemberId: null, rejectionReason: null, createdAt: "x" })));
    fn(repo.getCompetitionFixtures).mockResolvedValue([]);
    fn(repo.getMyRegistration).mockResolvedValue(null);
    fn(repo.getMyTeamMembership).mockResolvedValue(null);
    fn(repo.getMyPendingJoinRequest).mockResolvedValue(null);
    fn(repo.getMemberParticipationRecords).mockResolvedValue([]);
    fn(repo.getDisplayNames).mockResolvedValue({});
    fn(repo.getTeamMemberships).mockResolvedValue([]);
    fn(repo.getPendingJoinRequestsForTeam).mockResolvedValue([]);
    fn(repo.getRegistrationStatus).mockResolvedValue({ ...STATUS });
    fn(repo.getRegistrationFreeze).mockResolvedValue(null);
  });

  it("carries exactly six fields, derived by the server, for any signed-in viewer of the addressed competition", async () => {
    const view = await getCompetitionView(repo, COMPETITION_ID, "viewer-1");
    expect(view.registration).toEqual({ deadlineUtc: "2026-11-01T00:00:00.000Z", timeZone: "America/Costa_Rica", deadlineLocal: "2026-10-31T18:00", deadlinePassed: false, acceptingNewWrites: true, frozen: false });
    expect(Object.keys(view.registration!).sort()).toEqual(["acceptingNewWrites", "deadlineLocal", "deadlinePassed", "deadlineUtc", "frozen", "timeZone"]);
    expect(repo.getRegistrationStatus).toHaveBeenCalledWith(COMPETITION_ID);
    expect(JSON.stringify(view.registration)).not.toMatch(/roster|venue|note|digest|revision|organizer|authority/i);
  });

  it("is absent (null) for a DRAFT competition — its plan is still a draft — and the status is not even read", async () => {
    fn(repo.getCompetitionById).mockResolvedValue(competition({ state: "DRAFT" }));
    const view = await getCompetitionView(repo, COMPETITION_ID, "viewer-1");
    expect(view.registration).toBeNull();
    expect(repo.getRegistrationStatus).not.toHaveBeenCalled();
  });

  it("is absent (null) for a competition with no usable plan (no status row) — and the page treats absent as CLOSED", async () => {
    fn(repo.getRegistrationStatus).mockResolvedValue(null);
    expect((await getCompetitionView(repo, COMPETITION_ID, "viewer-1")).registration).toBeNull();
  });

  it("reports a passed deadline and a frozen competition exactly as the server derived them, and never opens writes after either", async () => {
    fn(repo.getRegistrationStatus).mockResolvedValue({ ...STATUS, deadlinePassed: true, acceptingNewWrites: false });
    expect((await getCompetitionView(repo, COMPETITION_ID, "viewer-1")).registration).toMatchObject({ deadlinePassed: true, acceptingNewWrites: false, frozen: false });
    fn(repo.getCompetitionById).mockResolvedValue(competition({ state: "READY_TO_PUBLISH" }));
    fn(repo.getRegistrationStatus).mockResolvedValue({ ...STATUS, deadlinePassed: true, acceptingNewWrites: true /* a contradictory read */, frozen: true });
    const frozen = await getCompetitionView(repo, COMPETITION_ID, "viewer-1");
    expect(frozen.registration).toMatchObject({ frozen: true, acceptingNewWrites: false });
  });

  it("accepting writes requires the OPEN state too: a status that says accepting for a competition that is not open is reported as not accepting", async () => {
    fn(repo.getCompetitionById).mockResolvedValue(competition({ state: "PUBLISHED" }));
    expect((await getCompetitionView(repo, COMPETITION_ID, "viewer-1")).registration?.acceptingNewWrites).toBe(false);
    fn(repo.getCompetitionById).mockResolvedValue(competition({ state: "CANCELLED_WITHOUT_CHAMPION" }));
    expect((await getCompetitionView(repo, COMPETITION_ID, "viewer-1")).registration?.acceptingNewWrites).toBe(false);
  });

  it("coerces strictly: a non-boolean flag from the read is never treated as true", async () => {
    fn(repo.getRegistrationStatus).mockResolvedValue({ ...STATUS, acceptingNewWrites: "true", deadlinePassed: 0, frozen: "yes" });
    const view = await getCompetitionView(repo, COMPETITION_ID, "viewer-1");
    expect(view.registration).toMatchObject({ acceptingNewWrites: false, deadlinePassed: false, frozen: false });
  });

  it("fails closed when the status cannot be read: the view is not built without it", async () => {
    fn(repo.getRegistrationStatus).mockRejectedValue(new Error("database unavailable"));
    await expect(getCompetitionView(repo, COMPETITION_ID, "viewer-1")).rejects.toThrow("database unavailable");
  });

  it("gives a non-organizer neither the readiness nor the freeze summary, and makes none of the reads behind them", async () => {
    fn(repo.getRegistrationStatus).mockResolvedValue({ ...STATUS, frozen: true, deadlinePassed: true, acceptingNewWrites: false });
    fn(repo.getRegistrationFreeze).mockResolvedValue(EVIDENCE);
    const view = await getCompetitionView(repo, COMPETITION_ID, "viewer-1");
    expect(view.registrationFreeze ?? null).toBeNull();
    expect(view.registrationReadiness ?? null).toBeNull();
    expect(repo.getRegistrationFreeze).not.toHaveBeenCalled();
    expect(repo.getTeamMemberships).not.toHaveBeenCalled();
    expect(repo.getPendingJoinRequestsForTeam).not.toHaveBeenCalled();
  });

  it("gives the active organizer the freeze prerequisites while registration is open: counts and roster bounds, with no id or digest", async () => {
    fn(repo.getCompetitionTeams).mockImplementation(async () => [
      ...[1, 2, 3, 4].map((n) => ({ competitionTeamId: `t${n}`, publicCode: `p${n}`, competitionId: COMPETITION_ID, name: `Team ${n}`, captainGamingMemberId: `cap-${n}`, status: "ACCEPTED", provenance: "ORGANIZER_CREATED", decidedAt: null, decidedByGamingMemberId: null, rejectionReason: null, createdAt: "x" })),
      { competitionTeamId: "t5", publicCode: "p5", competitionId: COMPETITION_ID, name: "Proposed", captainGamingMemberId: "cap-5", status: "PENDING_ORGANIZER_APPROVAL", provenance: "MEMBER_PROPOSED", decidedAt: null, decidedByGamingMemberId: null, rejectionReason: null, createdAt: "x" },
    ]);
    fn(repo.getTeamMemberships).mockImplementation(async (teamId: string) => (teamId === "t1" ? [{ competitionTeamMembershipId: "x1", competitionId: COMPETITION_ID, competitionTeamId: "t1", gamingMemberId: "a", approvedAt: "x", approvedByGamingMemberId: "o" }, { competitionTeamMembershipId: "x2", competitionId: COMPETITION_ID, competitionTeamId: "t1", gamingMemberId: "b", approvedAt: "x", approvedByGamingMemberId: "o" }] : []));
    fn(repo.getPendingJoinRequestsForTeam).mockImplementation(async (teamId: string) => (teamId === "t2" ? [{ competitionJoinRequestId: "j1" }, { competitionJoinRequestId: "j2" }, { competitionJoinRequestId: "j3" }] : []));
    const view = await getCompetitionView(repo, COMPETITION_ID, "org-1");
    expect(view.registrationReadiness).toEqual({
      deadlinePassed: false, acceptedTeamCount: 4, pendingProposalCount: 1, pendingJoinRequestCount: 3, rosterMinimum: 5, rosterMaximum: 8,
      teams: [{ name: "Team 1", memberCount: 2 }, { name: "Team 2", memberCount: 0 }, { name: "Team 3", memberCount: 0 }, { name: "Team 4", memberCount: 0 }],
    });
    expect(JSON.stringify(view.registrationReadiness)).not.toMatch(UUID_LIKE);
    expect(view.registration).not.toHaveProperty("rosterMinimum");
  });

  it("gives the active organizer the frozen summary — team names and counts only — and a revoked host nothing", async () => {
    fn(repo.getCompetitionById).mockResolvedValue(competition({ state: "READY_TO_PUBLISH" }));
    fn(repo.getRegistrationStatus).mockResolvedValue({ ...STATUS, frozen: true, deadlinePassed: true, acceptingNewWrites: false });
    fn(repo.getRegistrationFreeze).mockResolvedValue(EVIDENCE);
    const view = await getCompetitionView(repo, COMPETITION_ID, "org-1");
    expect(view.registrationFreeze).toEqual({
      frozenAt: "2026-11-01T00:00:05.000Z", registrationDeadlineUtc: "2026-11-01T00:00:00.000Z", rosterMinimum: 5, rosterMaximum: 8, teamCount: 4, memberCount: 3,
      teams: [{ name: "Team 1", memberCount: 3 }, { name: "Team 2", memberCount: 0 }, { name: "Team 3", memberCount: 0 }, { name: "Team 4", memberCount: 0 }],
    });
    expect(JSON.stringify(view.registrationFreeze)).not.toMatch(/digest|[0-9a-f]{8}-[0-9a-f]{4}|cap-|m1|frozenBy/i);
    expect(view.registrationReadiness ?? null).toBeNull(); // nothing left to prepare once frozen
    fn(repo.getCompetitionById).mockResolvedValue(competition({ state: "READY_TO_PUBLISH", hostAccessRevoked: true }));
    const revoked = await getCompetitionView(repo, COMPETITION_ID, "org-1");
    expect(revoked.isOrganizer).toBe(false);
    expect(revoked.registrationFreeze ?? null).toBeNull();
  });

  it("source: the view and the freeze module never read a clock of their own to decide anything", () => {
    for (const file of ["lib/gaming/competitions/getCompetitionView.ts", "lib/gaming/competitions/registrationFreeze.ts"]) {
      let source = "";
      try { source = readFileSync(path.join(process.cwd(), file), "utf8"); } catch { /* absent until implemented: the assertion below fails */ }
      expect(source.length, file).toBeGreaterThan(0);
      expect(source, file).not.toMatch(/Date\.now\(|new Date\(\)|performance\.now\(|setTimeout\(/);
    }
  });
});

// ---------------------------------------------------------------------------------------------------------------------------------------------
// The close command: the freeze checkpoint and its summary
// ---------------------------------------------------------------------------------------------------------------------------------------------

describe("closeTeamRegistration: the freeze summary", () => {
  const EVIDENCE = {
    registrationFreezeId: "d1", competitionId: COMPETITION_ID, planningRevisionId: "r1", formatKey: "SOCCER_5V5", rosterMinimum: 5, rosterMaximum: 8,
    registrationDeadlineUtc: "2026-11-01T00:00:00.000Z", frozenAt: "2026-11-01T00:00:05.000Z", frozenByGamingMemberId: "org-1", teamCount: 4, memberCount: 20, snapshotDigest: "a".repeat(64),
    teams: [1, 2, 3, 4].map((n) => ({ position: n, competitionTeamId: `t${n}`, captainGamingMemberId: `cap-${n}`, memberCount: 5, memberGamingMemberIds: ["a", "b", "c", "d", "e"] })),
  };
  it("maps onto the repository exactly, then returns the stored freeze as team names and counts (no ids, no digest)", async () => {
    const repo = makeFake();
    fn(repo.closeTeamRegistration).mockResolvedValue({ competitionId: COMPETITION_ID, state: "READY_TO_PUBLISH" });
    fn(repo.getRegistrationFreeze).mockResolvedValue(EVIDENCE);
    fn(repo.getCompetitionTeams).mockResolvedValue([1, 2, 3, 4].map((n) => ({ competitionTeamId: `t${n}`, name: `Team ${n}`, status: "ACCEPTED" })));
    const result = await closeTeamRegistration(repo, COMPETITION_ID, "org-1");
    expect(repo.closeTeamRegistration).toHaveBeenCalledWith(COMPETITION_ID, "org-1");
    expect(result.competitionId).toBe(COMPETITION_ID);
    expect(result.state).toBe("READY_TO_PUBLISH");
    expect(result.freeze).toEqual({
      frozenAt: "2026-11-01T00:00:05.000Z", registrationDeadlineUtc: "2026-11-01T00:00:00.000Z", rosterMinimum: 5, rosterMaximum: 8, teamCount: 4, memberCount: 20,
      teams: [1, 2, 3, 4].map((n) => ({ name: `Team ${n}`, memberCount: 5 })),
    });
    expect(JSON.stringify(result)).not.toMatch(/digest|cap-|"t1"|frozenBy/i);
  });

  it("returns no freeze for a competition that has none (an older competition), and never invents one", async () => {
    const repo = makeFake();
    fn(repo.closeTeamRegistration).mockResolvedValue({ competitionId: COMPETITION_ID, state: "READY_TO_PUBLISH" });
    fn(repo.getRegistrationFreeze).mockResolvedValue(null);
    fn(repo.getCompetitionTeams).mockResolvedValue([]);
    const result = await closeTeamRegistration(repo, COMPETITION_ID, "org-1");
    expect(result.freeze ?? null).toBeNull();
    expect(result).toEqual({ competitionId: COMPETITION_ID, state: "READY_TO_PUBLISH" });
  });

  it("does not read the freeze at all when the close itself failed", async () => {
    const repo = makeFake();
    fn(repo.closeTeamRegistration).mockRejectedValue(new TeamRegistrationCapacityNotReachedError());
    await expect(closeTeamRegistration(repo, COMPETITION_ID, "org-1")).rejects.toBeInstanceOf(TeamRegistrationCapacityNotReachedError);
    expect(repo.getRegistrationFreeze).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------------------------------------------------------------------------
// The routes
// ---------------------------------------------------------------------------------------------------------------------------------------------

describe("routes: error mapping, no client time, no caching", () => {
  let httpAuth: typeof import("../lib/gaming/competitions/httpAuth");
  let repo: CompetitionsRepository;
  const ORIGINAL = process.env.COMPETITIONS_SCHEMA_READY;
  afterAll(() => { if (ORIGINAL === undefined) delete process.env.COMPETITIONS_SCHEMA_READY; else process.env.COMPETITIONS_SCHEMA_READY = ORIGINAL; });
  beforeEach(async () => {
    process.env.COMPETITIONS_SCHEMA_READY = "true";
    httpAuth = await import("../lib/gaming/competitions/httpAuth");
    vi.clearAllMocks();
    repo = makeFake();
    vi.mocked(httpAuth.getSupabaseCredentials).mockReturnValue({ url: "http://fake", serviceKey: "fake" });
    vi.mocked(httpAuth.buildCompetitionsRepo).mockReturnValue(repo as unknown as ReturnType<typeof httpAuth.buildCompetitionsRepo>);
    vi.mocked(httpAuth.requireGamingMember).mockResolvedValue({ gamingMemberId: "auth-derived-member" });
  });
  const post = (body?: unknown) => new Request("http://localhost/probe", { method: "POST", headers: { authorization: "Bearer token" }, body: body === undefined ? undefined : JSON.stringify(body) });
  const ctx = { params: { competitionId: "comp-1" } };

  it("open: a registration-opening error is a 409 with its stable code and bounded wording; everything else keeps its own mapping", async () => {
    const { POST } = await import("../app/api/gaming/competitions/[competitionId]/open-team-registration/route");
    const { RegistrationOpeningError } = await loadFreeze();
    for (const code of ["PLAN_MISSING", "PLAN_INVALID", "DEADLINE_EXPIRED"] as const) {
      fn(repo.openTeamRegistration).mockRejectedValueOnce(new RegistrationOpeningError(code));
      const res = await POST(post(), ctx);
      expect(res.status, code).toBe(409);
      const body = await res.json();
      expect(body.code).toBe(code);
      expect(typeof body.error).toBe("string");
    }
    fn(repo.openTeamRegistration).mockRejectedValueOnce(new HostAccessRevokedError());
    expect((await POST(post(), ctx)).status).toBe(403);
    fn(repo.openTeamRegistration).mockRejectedValueOnce(new Error("boom with <details>"));
    const unknown = await POST(post(), ctx);
    expect(unknown.status).toBe(500);
    expect(JSON.stringify(await unknown.json())).not.toContain("boom");
  });

  it("open: the organizer is always the caller and no body field is read", async () => {
    const { POST } = await import("../app/api/gaming/competitions/[competitionId]/open-team-registration/route");
    fn(repo.openTeamRegistration).mockResolvedValue({ competitionId: "comp-1", state: "TEAM_REGISTRATION_OPEN" });
    const res = await POST(post({ organizerGamingMemberId: "attacker", now: "1999-01-01T00:00:00Z", registrationDeadline: "2999-01-01T00:00:00Z" }), ctx);
    expect(res.status).toBe(200);
    expect(repo.openTeamRegistration).toHaveBeenCalledWith("comp-1", "auth-derived-member");
    const source = readFileSync(path.join(process.cwd(), "app/api/gaming/competitions/[competitionId]/open-team-registration/route.ts"), "utf8");
    expect(source).not.toMatch(/request\.(json|text|formData)\(/);
  });

  it("close: every freeze refusal is a 409 carrying its stable code, and the existing refusals gain a code without changing their status", async () => {
    const { POST } = await import("../app/api/gaming/competitions/[competitionId]/close-team-registration/route");
    const { RegistrationFreezeError } = await loadFreeze();
    const freezeCodes = ["PLAN_MISSING", "PLAN_INVALID", "DEADLINE_NOT_REACHED", "PENDING_PROPOSALS", "PENDING_JOIN_REQUESTS", "ROSTER_BELOW_MINIMUM", "ROSTER_ABOVE_MAXIMUM", "MEMBER_CONFLICT"] as const;
    for (const code of freezeCodes) {
      fn(repo.closeTeamRegistration).mockRejectedValueOnce(new RegistrationFreezeError(code));
      const res = await POST(post(), ctx);
      expect(res.status, code).toBe(409);
      expect((await res.json()).code).toBe(code);
    }
    const existing: Array<[Error, number, string]> = [
      [new TeamRegistrationCapacityNotReachedError(), 409, "TEAM_COUNT"], [new TeamRegistrationNotOpenError(), 409, "WRONG_STATE"],
      [new HostAccessRevokedError(), 403, "ORGANIZER_REVOKED"], [new CompetitionAccessDeniedError(), 403, "NOT_ORGANIZER"], [new CompetitionNotFoundError(), 404, "NOT_FOUND"],
    ];
    for (const [err, status, code] of existing) {
      fn(repo.closeTeamRegistration).mockRejectedValueOnce(err);
      const res = await POST(post(), ctx);
      expect(res.status, err.name).toBe(status);
      expect((await res.json()).code, err.name).toBe(code);
    }
    fn(repo.closeTeamRegistration).mockRejectedValueOnce(new Error("internal <detail>"));
    const unknown = await POST(post(), ctx);
    expect(unknown.status).toBe(500);
    expect(JSON.stringify(await unknown.json())).not.toContain("internal");
  });

  it("close: a success answers with the result and the freeze summary; the actor is the caller and the body is never read", async () => {
    const { POST } = await import("../app/api/gaming/competitions/[competitionId]/close-team-registration/route");
    fn(repo.closeTeamRegistration).mockResolvedValue({ competitionId: "comp-1", state: "READY_TO_PUBLISH" });
    fn(repo.getRegistrationFreeze).mockResolvedValue({
      registrationFreezeId: "d1", competitionId: "comp-1", planningRevisionId: "r1", formatKey: "SOCCER_5V5", rosterMinimum: 5, rosterMaximum: 8, registrationDeadlineUtc: "2026-11-01T00:00:00.000Z",
      frozenAt: "2026-11-01T00:00:05.000Z", frozenByGamingMemberId: "auth-derived-member", teamCount: 4, memberCount: 4, snapshotDigest: "a".repeat(64),
      teams: [1, 2, 3, 4].map((n) => ({ position: n, competitionTeamId: `t${n}`, captainGamingMemberId: `cap-${n}`, memberCount: 1, memberGamingMemberIds: [`m${n}`] })),
    });
    fn(repo.getCompetitionTeams).mockResolvedValue([1, 2, 3, 4].map((n) => ({ competitionTeamId: `t${n}`, name: `Team ${n}` })));
    const res = await POST(post({ organizerGamingMemberId: "attacker", frozenAt: "1999-01-01T00:00:00Z", teams: ["x"] }), ctx);
    expect(res.status).toBe(200);
    expect(repo.closeTeamRegistration).toHaveBeenCalledWith("comp-1", "auth-derived-member");
    const body = await res.json();
    expect(body.result.state).toBe("READY_TO_PUBLISH");
    expect(body.result.freeze.teamCount).toBe(4);
    expect(body.result.freeze.teams[0]).toEqual({ name: "Team 1", memberCount: 1 });
    expect(JSON.stringify(body)).not.toMatch(/digest|attacker|1999/);
    const source = readFileSync(path.join(process.cwd(), "app/api/gaming/competitions/[competitionId]/close-team-registration/route.ts"), "utf8");
    expect(source).not.toMatch(/request\.(json|text|formData)\(/);
  });

  it("close and open: signed out is still a 401 before the repository is touched", async () => {
    vi.mocked(httpAuth.requireGamingMember).mockResolvedValue({ errorResponse: new Response(JSON.stringify({ error: "unauthenticated" }), { status: 401 }) as never });
    const { POST: close } = await import("../app/api/gaming/competitions/[competitionId]/close-team-registration/route");
    const { POST: open } = await import("../app/api/gaming/competitions/[competitionId]/open-team-registration/route");
    expect((await close(post(), ctx)).status).toBe(401);
    expect((await open(post(), ctx)).status).toBe(401);
    expect(repo.closeTeamRegistration).not.toHaveBeenCalled();
    expect(repo.openTeamRegistration).not.toHaveBeenCalled();
  });

  it("view: the addressed competition is never cached, and carries the registration status the view built", async () => {
    const { GET } = await import("../app/api/gaming/competitions/[competitionId]/route");
    fn(repo.getCompetitionById).mockResolvedValue({ competitionId: "comp-1", publicCode: CODE, activityKey: "SOCCER_5V5", name: "Cup", organizerGamingMemberId: "someone", state: "TEAM_REGISTRATION_OPEN", cancelledReason: null, createdAt: "x", publishedAt: null });
    fn(repo.getCompetitionTeams).mockResolvedValue([]);
    fn(repo.getCompetitionFixtures).mockResolvedValue([]);
    fn(repo.getMyRegistration).mockResolvedValue(null);
    fn(repo.getMyTeamMembership).mockResolvedValue(null);
    fn(repo.getMyPendingJoinRequest).mockResolvedValue(null);
    fn(repo.getMemberParticipationRecords).mockResolvedValue([]);
    fn(repo.getDisplayNames).mockResolvedValue({});
    fn(repo.getRegistrationStatus).mockResolvedValue({ deadlineUtc: "2026-11-01T00:00:00.000Z", timeZone: "America/Costa_Rica", deadlineLocal: "2026-10-31T18:00", deadlinePassed: false, acceptingNewWrites: true, frozen: false, rosterMinimum: 5, rosterMaximum: 8 });
    const res = await GET(new Request("http://localhost/probe", { headers: { authorization: "Bearer token" } }), ctx);
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toMatch(/no-store/);
    const body = await res.json();
    expect(body.view.registration).toEqual({ deadlineUtc: "2026-11-01T00:00:00.000Z", timeZone: "America/Costa_Rica", deadlineLocal: "2026-10-31T18:00", deadlinePassed: false, acceptingNewWrites: true, frozen: false });
  });

  it("register: only the verified member and the attestation reach the repository; a client time is never forwarded; a closed registration is a 409", async () => {
    const { POST } = await import("../app/api/gaming/competitions/[competitionId]/register/route");
    fn(repo.registerForCompetition).mockResolvedValue({ competitionRegistrationId: "r1", registeredAt: "x", alreadyRegistered: false });
    const ok = await POST(post({ isAdultSelfAttested: true, now: "1999-01-01T00:00:00Z", registeredAt: "1999-01-01T00:00:00Z", deadline: "2999-01-01T00:00:00Z" }), ctx);
    expect([200, 201]).toContain(ok.status);
    expect(fn(repo.registerForCompetition).mock.calls[0]).toEqual(["comp-1", "auth-derived-member", true]);
    fn(repo.registerForCompetition).mockRejectedValueOnce(new TeamRegistrationNotOpenError("TEAM_REGISTRATION_NOT_OPEN: the registration deadline for this competition has passed"));
    const closed = await POST(post({ isAdultSelfAttested: true }), ctx);
    expect(closed.status).toBe(409);
    expect((await closed.json()).error).toMatch(/deadline/i);
  });
});

// ---------------------------------------------------------------------------------------------------------------------------------------------
// The member page
// ---------------------------------------------------------------------------------------------------------------------------------------------

describe("the member competition page renders the server's registration status and never decides a write itself", () => {
  const REG = { deadlineUtc: "2026-11-01T00:00:00.000Z", timeZone: "America/Costa_Rica", deadlineLocal: "2026-10-31T18:00", deadlinePassed: false, acceptingNewWrites: true, frozen: false };
  const view = (competition: Record<string, unknown>, extra: Record<string, unknown> = {}) => ({
    view: {
      competition: { competitionId: COMPETITION_ID, publicCode: CODE, activityKey: "SOCCER_5V5", name: "Cup", state: "TEAM_REGISTRATION_OPEN", cancelledReason: null, ...competition },
      teams: [], pendingTeamProposals: [], rejectedTeamProposals: [], myTeamProposals: [], fixtures: [],
      myRegistration: null, myTeamMembership: null, myTeamMemberships: [], myPendingJoinRequest: null, myPersistentRecords: [], isOrganizer: false, ...extra,
    },
  });
  async function member(body: unknown, auth: unknown = SIGNED) {
    const calls: string[] = [];
    const page = await openMemberPage({
      auth, search: `?c=${CODE}`,
      transport: (r) => { calls.push(`${r.method} ${r.url}`); return r.url.startsWith("/api/gaming/competitions/resolve") ? { status: 200, json: { competitionId: COMPETITION_ID } } : r.url === `/api/gaming/competitions/${COMPETITION_ID}` ? { status: 200, json: body } : { status: 404, json: { error: "unexpected" } }; },
    });
    await page.settle(() => page.doc.getElementById("content")!.textContent!.length > 0 && !/Loading/i.test(page.doc.getElementById("content")!.textContent!), "the page");
    await new Promise((r) => setTimeout(r, 25));
    return { page, calls };
  }
  const writeControls = (page: Awaited<ReturnType<typeof member>>["page"]) => ({
    register: !!page.doc.getElementById("btn-register"), propose: !!page.doc.getElementById("btn-create-team"),
    join: page.doc.querySelectorAll("#teams-list .team-row button").length,
  });
  const TEAMS = [{ competitionTeamId: "t1", name: "Alpha", publicCode: "pa", captainGamingMemberId: "c1", captainDisplayName: "C1" }];
  const REGISTERED = { myRegistration: { competitionRegistrationId: "r", competitionId: COMPETITION_ID, gamingMemberId: "m-1", isAdultSelfAttested: true, registeredAt: "x" }, teams: TEAMS };

  it("shows when registration closes, in the venue's own words, and offers registration while the server says it is accepting", async () => {
    const { page } = await member(view({}, { registration: REG }));
    const status = page.doc.getElementById("registration-status")!;
    expect(status).not.toBeNull();
    expect(status.textContent).toMatch(/2026-10-31 18:00/);
    expect(status.textContent).toMatch(/America\/Costa_Rica/);
    expect(status.textContent).toMatch(/open/i);
    expect(writeControls(page).register).toBe(true);
    page.close();
  });

  it("once the server says the deadline has passed, no write control is offered even though the competition state still reads open", async () => {
    const reg = { ...REG, deadlinePassed: true, acceptingNewWrites: false };
    const unregistered = await member(view({ state: "TEAM_REGISTRATION_OPEN" }, { registration: reg }));
    expect(unregistered.page.doc.getElementById("registration-status")!.textContent).toMatch(/closed/i);
    expect(writeControls(unregistered.page)).toEqual({ register: false, propose: false, join: 0 });
    unregistered.page.close();
    const registered = await member(view({ state: "TEAM_REGISTRATION_OPEN" }, { ...REGISTERED, registration: reg }));
    expect(writeControls(registered.page)).toEqual({ register: false, propose: false, join: 0 });
    expect(registered.page.doc.getElementById("registration-status")!.textContent).toMatch(/closed/i);
    registered.page.close();
  });

  it("once frozen, the page says the teams are locked and offers nothing — in READY_TO_PUBLISH and in PUBLISHED, where the older rules still offered registration", async () => {
    for (const state of ["READY_TO_PUBLISH", "PUBLISHED"]) {
      const reg = { ...REG, deadlinePassed: true, acceptingNewWrites: false, frozen: true };
      const a = await member(view({ state }, { registration: reg }));
      expect(a.page.doc.getElementById("registration-status")!.textContent).toMatch(/locked/i);
      expect(writeControls(a.page), state).toEqual({ register: false, propose: false, join: 0 });
      a.page.close();
      const b = await member(view({ state }, { ...REGISTERED, registration: reg }));
      expect(writeControls(b.page), state).toEqual({ register: false, propose: false, join: 0 });
      b.page.close();
    }
  });

  it("a server that says accepting for a competition that is not open still gets no write control (a closed state is never turned into an open action)", async () => {
    for (const state of ["READY_TO_PUBLISH", "PUBLISHED", "COMPLETE", "CANCELLED_WITHOUT_CHAMPION", "DRAFT"]) {
      const { page } = await member(view({ state }, { ...REGISTERED, registration: { ...REG, acceptingNewWrites: true } }));
      expect(writeControls(page), state).toEqual({ register: false, propose: false, join: 0 });
      page.close();
    }
  });

  it("offers the team controls to a registered member while accepting, and the join buttons carry the team the member chose", async () => {
    const { page } = await member(view({}, { ...REGISTERED, registration: REG }));
    expect(writeControls(page)).toEqual({ register: false, propose: true, join: 1 });
    page.close();
  });

  it("a malformed status is a closed registration: no control, and a truthful sentence", async () => {
    const malformed: unknown[] = [
      { ...REG, acceptingNewWrites: "true" }, { ...REG, acceptingNewWrites: undefined }, { ...REG, deadlineLocal: 5 }, { ...REG, timeZone: null }, "open", 7, [], {},
    ];
    for (const registration of malformed) {
      const { page } = await member(view({}, { ...REGISTERED, registration }));
      expect(writeControls(page), JSON.stringify(registration)).toEqual({ register: false, propose: false, join: 0 });
      expect(page.doc.getElementById("content")!.textContent).toMatch(/registration status is unavailable/i);
      page.close();
    }
  });

  // UG-CR-GATE-SSS-007A Correction A. A competition that is no longer a draft and has no usable registration status is a CLOSED registration. The page never
  // falls back to the older lifecycle rules, which offered registration in OPEN, READY_TO_PUBLISH and PUBLISHED without any deadline.
  const NO_CONTROLS = { register: false, propose: false, join: 0 };
  const STATES_WITH_STATUS = ["TEAM_REGISTRATION_OPEN", "READY_TO_PUBLISH", "PUBLISHED", "COMPLETE"] as const;

  it("UG-CR-GATE-SSS-007A: a missing or null status is a CLOSED registration in every state that follows a draft — no write control, and a truthful sentence", async () => {
    for (const state of STATES_WITH_STATUS) {
      const bodies: Array<[string, unknown]> = [
        ["absent, unregistered", view({ state })], ["null, unregistered", view({ state }, { registration: null })],
        ["absent, registered", view({ state }, REGISTERED)], ["null, registered", view({ state }, { ...REGISTERED, registration: null })],
      ];
      for (const [label, body] of bodies) {
        const { page } = await member(body);
        expect(writeControls(page), `${state} ${label}`).toEqual(NO_CONTROLS);
        const status = page.doc.getElementById("registration-status");
        expect(status, `${state} ${label}`).not.toBeNull();
        expect(status!.textContent, `${state} ${label}`).toMatch(/registration is closed/i);
        expect(page.doc.getElementById("content")!.textContent, `${state} ${label}`).not.toMatch(/\bRegister\b|Propose Team|Request to Join|Create Your Team|Join a Team/);
        page.close();
      }
    }
    // A cancelled competition shows no status card at all (its own sentence says why) and still offers nothing.
    for (const registration of [undefined, null]) {
      const extra = registration === undefined ? REGISTERED : { ...REGISTERED, registration };
      const { page } = await member(view({ state: "CANCELLED_WITHOUT_CHAMPION", cancelledReason: "Called off." }, extra));
      expect(writeControls(page)).toEqual(NO_CONTROLS);
      page.close();
    }
  });

  it("UG-CR-GATE-SSS-007A: a DRAFT competition keeps its own wording — registration has not opened, there is no status card, and still no control", async () => {
    const { page } = await member(view({ state: "DRAFT" }, { registration: null }));
    expect(page.doc.getElementById("registration-status")).toBeNull();
    expect(page.doc.getElementById("content")!.textContent).toMatch(/registration opens once the organizer opens team registration/i);
    expect(writeControls(page)).toEqual(NO_CONTROLS);
    page.close();
  });

  it("UG-CR-GATE-SSS-007A: a PARTIAL status (any one of its six facts missing) is not a status: no control in any state, and the unavailable sentence", async () => {
    for (const missing of ["deadlineUtc", "timeZone", "deadlineLocal", "deadlinePassed", "acceptingNewWrites", "frozen"]) {
      const partial: Record<string, unknown> = { ...REG };
      delete partial[missing];
      for (const state of STATES_WITH_STATUS) {
        const { page } = await member(view({ state }, { ...REGISTERED, registration: partial }));
        expect(writeControls(page), `${state} without ${missing}`).toEqual(NO_CONTROLS);
        expect(page.doc.getElementById("content")!.textContent, `${state} without ${missing}`).toMatch(/registration status is unavailable/i);
        page.close();
      }
    }
  });

  it("UG-CR-GATE-SSS-007A: a malformed status opens nothing in any state either (wrong types, an array, a string, a number, an empty object)", async () => {
    const malformed: unknown[] = [
      { ...REG, deadlinePassed: "false" }, { ...REG, frozen: 0 }, { ...REG, acceptingNewWrites: 1 }, { ...REG, deadlineUtc: 20261101 }, { ...REG, timeZone: {} }, [REG], "open", 7, true, {},
    ];
    for (const state of STATES_WITH_STATUS) {
      for (const registration of malformed) {
        const { page } = await member(view({ state }, { ...REGISTERED, registration }));
        expect(writeControls(page), `${state} ${JSON.stringify(registration)}`).toEqual(NO_CONTROLS);
        page.close();
      }
    }
  });

  it("UG-CR-GATE-SSS-007A: a status that contradicts itself (accepting, yet passed or frozen) is not trusted to open anything", async () => {
    for (const registration of [{ ...REG, deadlinePassed: true }, { ...REG, frozen: true }, { ...REG, deadlinePassed: true, frozen: true }]) {
      const { page } = await member(view({}, { ...REGISTERED, registration }));
      expect(writeControls(page), JSON.stringify(registration)).toEqual(NO_CONTROLS);
      page.close();
      const { page: unregistered } = await member(view({}, { registration }));
      expect(writeControls(unregistered), JSON.stringify(registration)).toEqual(NO_CONTROLS);
      unregistered.close();
    }
  });

  it("UG-CR-GATE-SSS-007A: a request that fails — an error status, a refusal or a network failure — never restores a write control", async () => {
    const attempts: Array<[string, (url: string) => unknown]> = [
      ["500", (url) => (url.startsWith("/api/gaming/competitions/resolve") ? { status: 200, json: { competitionId: COMPETITION_ID } } : { status: 500, json: { error: "boom" } })],
      ["503 without a body", (url) => (url.startsWith("/api/gaming/competitions/resolve") ? { status: 200, json: { competitionId: COMPETITION_ID } } : { status: 503 })],
      ["a thrown fetch", (url) => { if (url.startsWith("/api/gaming/competitions/resolve")) return { status: 200, json: { competitionId: COMPETITION_ID } }; throw new Error("network down"); }],
    ];
    for (const [label, answer] of attempts) {
      const asked: string[] = [];
      const page = await openMemberPage({ auth: SIGNED, search: `?c=${CODE}`, transport: (r) => { asked.push(r.url); return answer(r.url) as never; } });
      await page.settle(() => asked.includes(`/api/gaming/competitions/${COMPETITION_ID}`), `the competition request for ${label}`);
      await page.settle(() => !/Loading/i.test(page.doc.getElementById("content")!.textContent ?? ""), `the answer for ${label}`);
      expect(writeControls(page), label).toEqual(NO_CONTROLS);
      expect(page.doc.getElementById("registration-status"), label).toBeNull();
      // One bounded sentence, whatever failed: the page never stays on "Loading", and a thrown request is not an unhandled error.
      expect(page.doc.getElementById("content")!.textContent!.trim().length, label).toBeGreaterThan(0);
      if (label === "a thrown fetch") expect(page.doc.getElementById("content")!.textContent, label).toMatch(/could not be loaded right now/i);
      page.close();
    }
  });

  it("UG-CR-GATE-SSS-007A: ONLY an exact valid status that is accepting, in an open competition, offers the intake controls — and exactly the ones that member is entitled to", async () => {
    // Unregistered: registration only. Registered: the team controls only.
    const a = await member(view({ state: "TEAM_REGISTRATION_OPEN" }, { registration: REG }));
    expect(writeControls(a.page)).toEqual({ register: true, propose: false, join: 0 });
    a.page.close();
    const b = await member(view({ state: "TEAM_REGISTRATION_OPEN" }, { ...REGISTERED, registration: REG }));
    expect(writeControls(b.page)).toEqual({ register: false, propose: true, join: 1 });
    b.page.close();
    // The same exact status in any other state offers nothing, and a status that is not accepting offers nothing in the open state.
    for (const state of ["READY_TO_PUBLISH", "PUBLISHED", "COMPLETE", "DRAFT"]) {
      const { page } = await member(view({ state }, { ...REGISTERED, registration: REG }));
      expect(writeControls(page), state).toEqual(NO_CONTROLS);
      page.close();
    }
    const closed = await member(view({ state: "TEAM_REGISTRATION_OPEN" }, { ...REGISTERED, registration: { ...REG, acceptingNewWrites: false } }));
    expect(writeControls(closed.page)).toEqual(NO_CONTROLS);
    closed.page.close();
  });

  it("hostile text in the status is rendered as text, never as markup", async () => {
    const hostile = '<img src=x onerror="window.__xss=1">';
    const { page } = await member(view({}, { registration: { ...REG, timeZone: hostile, deadlineLocal: hostile } }));
    expect(page.doc.querySelectorAll("#content img")).toHaveLength(0);
    expect((page.win as unknown as Record<string, unknown>).__xss).toBeUndefined();
    expect(page.doc.getElementById("registration-status")!.textContent).toContain(hostile);
    page.close();
  });

  it("first paint reveals nothing: before the server answers the page holds no deadline or freeze text, and a signed-out visitor never gets any", async () => {
    const hang = new Promise<never>(() => {});
    const calls: string[] = [];
    const early = await openMemberPage({ auth: SIGNED, search: `?c=${CODE}`, transport: (r) => { calls.push(r.url); return r.url.startsWith("/api/gaming/competitions/resolve") ? { status: 200, json: { competitionId: COMPETITION_ID } } : (hang as never); } });
    await early.settle(() => calls.includes(`/api/gaming/competitions/${COMPETITION_ID}`), "the competition request");
    expect(early.doc.getElementById("registration-status")).toBeNull();
    // What a reader sees (the rendered content), not the page's own script text.
    expect(early.doc.getElementById("content")!.textContent).not.toMatch(/deadline|registration closes|teams are locked|2026-/i);
    expect(calls.some((u) => /planning|freeze/.test(u))).toBe(false);
    early.close();
    const { page: out, calls: outCalls } = await member(view({}, { registration: REG }), { status: "unauthenticated" });
    expect(out.doc.getElementById("registration-status")).toBeNull();
    expect(out.doc.getElementById("content")!.textContent).not.toMatch(/2026-10-31|America\/Costa_Rica/);
    expect(outCalls.some((c) => c === `GET /api/gaming/competitions/${COMPETITION_ID}`)).toBe(false);
    out.close();
  });

  it("an unauthorized answer (the existing 401/404 refusal) shows no status", async () => {
    const calls: string[] = [];
    const page = await openMemberPage({
      auth: SIGNED, search: `?c=${CODE}`,
      transport: (r) => { calls.push(r.url); return r.url.startsWith("/api/gaming/competitions/resolve") ? { status: 200, json: { competitionId: COMPETITION_ID } } : { status: 404, json: { error: "This competition could not be found." } }; },
    });
    await page.settle(() => /could not be found/i.test(page.text()), "the refusal");
    expect(page.doc.getElementById("registration-status")).toBeNull();
    page.close();
  });
});

// ---------------------------------------------------------------------------------------------------------------------------------------------
// The organizer page
// ---------------------------------------------------------------------------------------------------------------------------------------------

describe("the organizer page presents Close Team Registration as the freeze checkpoint and never claims success before the server confirms", () => {
  const CID = "c-freeze-1";
  const ADMIN_SOURCE = "/api/gaming/competitions/administration";
  const CLOSE = `/api/gaming/competitions/${CID}/close-team-registration`;
  const OPEN = `/api/gaming/competitions/${CID}/open-team-registration`;
  const REG = { deadlineUtc: "2026-11-01T00:00:00.000Z", timeZone: "America/Costa_Rica", deadlineLocal: "2026-10-31T18:00", deadlinePassed: true, acceptingNewWrites: false, frozen: false };
  const READINESS = {
    deadlinePassed: true, acceptedTeamCount: 4, pendingProposalCount: 0, pendingJoinRequestCount: 0, rosterMinimum: 5, rosterMaximum: 8,
    teams: [{ name: "Alpha", memberCount: 5 }, { name: "Bravo", memberCount: 6 }, { name: "Charlie", memberCount: 5 }, { name: "Delta", memberCount: 8 }],
  };
  const FREEZE = {
    frozenAt: "2026-11-01T00:00:05.000Z", registrationDeadlineUtc: "2026-11-01T00:00:00.000Z", rosterMinimum: 5, rosterMaximum: 8, teamCount: 4, memberCount: 24,
    teams: READINESS.teams,
  };
  function viewFor(state: string, extra: Record<string, unknown> = {}) {
    return {
      view: {
        competition: { competitionId: CID, publicCode: CODE, activityKey: "SOCCER_5V5", name: "Freeze Cup", organizerGamingMemberId: "m-1", state, cancelledReason: null, createdAt: "x", publishedAt: null },
        teams: READINESS.teams.map((t, i) => ({ competitionTeamId: `t${i}`, name: t.name, captainDisplayName: `Captain ${i}`, publicCode: `t${i}-code` })),
        pendingTeamProposals: [], rejectedTeamProposals: [], myTeamProposals: [], fixtures: [], myRegistration: null, myTeamMembership: null, myTeamMemberships: [], myPendingJoinRequest: null,
        myPersistentRecords: [], isOrganizer: true, myScorekeeperFixtureIds: [],
        registration: REG, registrationReadiness: READINESS, registrationFreeze: null, ...extra,
      },
    };
  }
  interface Script { view?: () => unknown; close?: (n: number) => unknown; open?: () => unknown }
  async function organizer(state: string, script: Script = {}, viewExtra: Record<string, unknown> = {}) {
    let closeCalls = 0;
    let current = script.view ? script.view : () => ({ status: 200, json: viewFor(state, viewExtra) });
    const page = await openAdminPage({
      auth: SIGNED,
      transport: (r) => {
        if (r.url === ADMIN_SOURCE) return { status: 200, json: { competitions: [{ competitionId: CID, name: "Freeze Cup", state, access: "ORGANIZER" }], operations: { createCompetition: false } } };
        if (r.url === `/api/gaming/competitions/${CID}`) return current() as never;
        if (r.url === CLOSE && r.method === "POST") return (script.close ?? (() => ({ status: 500, json: { error: "unexpected" } })))(++closeCalls) as never;
        if (r.url === OPEN && r.method === "POST") return (script.open ?? (() => ({ status: 500, json: { error: "unexpected" } })))() as never;
        if (r.url.endsWith("/planning")) return { status: 404, json: { error: "n/a" } };
        return { status: 404, json: { error: "unexpected request" } };
      },
    });
    await page.settle(() => page.doc.querySelectorAll("#comp-select option").length > 0, "the competition list");
    (page.doc.getElementById("comp-select") as HTMLSelectElement).value = CID;
    (page.doc.getElementById("btn-load-competition") as HTMLButtonElement).click();
    await page.settle(() => (page.doc.getElementById("comp-title")?.textContent ?? "") === "Freeze Cup", "the competition detail");
    await new Promise((r) => setTimeout(r, 25));
    const $ = (s: string) => page.doc.querySelector(s) as HTMLElement | null;
    const visible = (el: Element | null): boolean => { for (let n: Element | null = el; n; n = n.parentElement) { if (!el) return false; const e = n as HTMLElement; if (e.hidden || e.style?.display === "none") return false; } return !!el; };
    const posts = () => page.requests.filter((r) => r.method === "POST").map((r) => `${r.method} ${r.url}`);
    return { page, $, visible, posts, setView: (f: () => unknown) => { current = f; } };
  }
  const click = (el: Element | null) => (el as HTMLButtonElement).click();

  it("shows the authoritative deadline and the freeze prerequisites, from what the server said", async () => {
    const o = await organizer("TEAM_REGISTRATION_OPEN");
    const card = o.$("#freeze-card")!;
    expect(o.visible(card)).toBe(true);
    expect(o.$("#freeze-deadline")!.textContent).toMatch(/2026-10-31 18:00/);
    expect(o.$("#freeze-deadline")!.textContent).toMatch(/America\/Costa_Rica/);
    expect(o.$("#freeze-deadline")!.textContent).toMatch(/reached/i);
    const items = [...o.page.doc.querySelectorAll("#freeze-checklist > li")];
    expect(items.map((li) => li.getAttribute("data-key"))).toEqual(["deadline", "teams", "proposals", "joins", "rosters"]);
    expect(items.map((li) => li.getAttribute("data-met"))).toEqual(["true", "true", "true", "true", "true"]);
    expect(o.page.doc.getElementById("freeze-checklist")!.textContent).toMatch(/5.*8/); // the configured roster range
    expect(o.$("#btn-close-registration")!.textContent).toBe("Freeze Registration");
    expect(o.visible(o.$("#btn-close-registration"))).toBe(true);
    o.page.close();
  });

  it("marks each unmet prerequisite as unmet, from the server's counts, without deciding anything", async () => {
    const readiness = { ...READINESS, deadlinePassed: false, acceptedTeamCount: 3, pendingProposalCount: 2, pendingJoinRequestCount: 1, teams: [{ name: "Alpha", memberCount: 4 }, { name: "Bravo", memberCount: 9 }, { name: "Charlie", memberCount: 5 }] };
    const o = await organizer("TEAM_REGISTRATION_OPEN", {}, { registrationReadiness: readiness, registration: { ...REG, deadlinePassed: false } });
    const met = Object.fromEntries([...o.page.doc.querySelectorAll("#freeze-checklist > li")].map((li) => [li.getAttribute("data-key"), li.getAttribute("data-met")]));
    expect(met).toEqual({ deadline: "false", teams: "false", proposals: "false", joins: "false", rosters: "false" });
    expect(o.$("#freeze-deadline")!.textContent).toMatch(/not yet/i);
    // The button is still the server's to answer: the page does not disable it from its own arithmetic.
    expect((o.$("#btn-close-registration") as HTMLButtonElement).disabled).toBe(false);
    o.page.close();
  });

  it("asks for confirmation first, and sends nothing until it is given", async () => {
    const o = await organizer("TEAM_REGISTRATION_OPEN", { close: () => ({ status: 200, json: { result: { competitionId: CID, state: "READY_TO_PUBLISH", freeze: FREEZE } } }) });
    expect(o.visible(o.$("#freeze-confirm"))).toBe(false);
    click(o.$("#btn-close-registration"));
    expect(o.visible(o.$("#freeze-confirm"))).toBe(true);
    expect(o.posts()).toEqual([]);
    click(o.$("#btn-freeze-dismiss"));
    expect(o.visible(o.$("#freeze-confirm"))).toBe(false);
    expect(o.posts()).toEqual([]);
    o.page.close();
  });

  it("claims success only after the server confirms with a well-formed freeze, then shows the summary", async () => {
    let frozen = false;
    const o = await organizer("TEAM_REGISTRATION_OPEN", {
      close: () => { frozen = true; return { status: 200, json: { result: { competitionId: CID, state: "READY_TO_PUBLISH", freeze: FREEZE } } }; },
      view: () => ({ status: 200, json: frozen ? viewFor("READY_TO_PUBLISH", { registration: { ...REG, frozen: true }, registrationReadiness: null, registrationFreeze: FREEZE }) : viewFor("TEAM_REGISTRATION_OPEN") }),
    });
    click(o.$("#btn-close-registration"));
    expect(o.$("#freeze-status")!.textContent).not.toMatch(/frozen|success/i);
    click(o.$("#btn-freeze-confirm"));
    expect(o.$("#freeze-status")!.textContent).not.toMatch(/registration frozen/i); // not before the answer
    await o.page.settle(() => o.visible(o.$("#freeze-summary")), "the freeze summary");
    expect(o.posts()).toEqual([`POST ${CLOSE}`]);
    const summary = o.$("#freeze-summary")!.textContent!;
    for (const name of ["Alpha", "Bravo", "Charlie", "Delta"]) expect(summary).toContain(name);
    expect(summary).toMatch(/24/);
    expect(summary).toMatch(/2026-11-01/);
    expect(o.page.doc.getElementById("comp-state-pill")!.textContent).toBe("Finalizing bracket");
    expect(o.visible(o.$("#btn-close-registration"))).toBe(false);
    o.page.close();
  });

  it("renders the summary for an already-frozen competition on load, and offers no freeze control", async () => {
    const o = await organizer("READY_TO_PUBLISH", {}, { registration: { ...REG, frozen: true }, registrationReadiness: null, registrationFreeze: FREEZE });
    expect(o.visible(o.$("#freeze-summary"))).toBe(true);
    expect(o.visible(o.$("#btn-close-registration"))).toBe(false);
    expect(o.visible(o.$("#freeze-confirm"))).toBe(false);
    o.page.close();
  });

  it("UG-CR-GATE-SSS-007A: an open competition with no usable plan says plainly that nothing is accepted and that cancelling is the way out — and sends nothing on its own", async () => {
    const o = await organizer("TEAM_REGISTRATION_OPEN", {}, { registration: null, registrationReadiness: null });
    expect(o.visible(o.$("#freeze-card"))).toBe(true);
    expect(o.$("#freeze-deadline")!.textContent).toMatch(/no registration deadline is recorded/i);
    expect(o.$("#freeze-deadline")!.textContent).toMatch(/accepts no new registrations/i);
    expect(o.$("#freeze-deadline")!.textContent).toMatch(/cancel/i);
    expect(o.visible(o.$("#freeze-checklist"))).toBe(false);
    expect(o.visible(o.$("#cancel-section"))).toBe(true);
    expect(o.posts()).toEqual([]);
    o.page.close();
  });

  it("UG-CR-GATE-SSS-007A: the recorded freeze shows the deadline to the millisecond when it has one, and without a fraction when it has none", async () => {
    const cases: Array<[string, string]> = [
      ["2026-11-01T00:00:00.000Z", "2026-11-01 00:00:00Z"], ["2026-11-01T00:00:00.100Z", "2026-11-01 00:00:00.100Z"],
      ["2026-11-01T00:00:00.250Z", "2026-11-01 00:00:00.250Z"], ["2026-11-01T00:00:00.999Z", "2026-11-01 00:00:00.999Z"],
    ];
    for (const [deadline, shown] of cases) {
      const o = await organizer("READY_TO_PUBLISH", {}, { registration: { ...REG, frozen: true }, registrationReadiness: null, registrationFreeze: { ...FREEZE, registrationDeadlineUtc: deadline } });
      const terms = [...o.page.doc.querySelectorAll("#freeze-summary dt")];
      const term = terms.find((t) => t.textContent === "Registration deadline");
      expect(term, deadline).toBeDefined();
      expect(term!.nextElementSibling!.textContent, deadline).toBe(shown);
      o.page.close();
    }
  });

  const MESSAGES: Array<[string, number, string, RegExp]> = [
    ["DEADLINE_NOT_REACHED", 409, "DEADLINE_NOT_REACHED", /deadline.*not.*reached/i],
    ["PLAN_MISSING", 409, "PLAN_MISSING", /no registration plan/i],
    ["PLAN_INVALID", 409, "PLAN_INVALID", /plan.*cannot be used/i],
    ["TEAM_COUNT", 409, "TEAM_COUNT", /exactly four/i],
    ["PENDING_PROPOSALS", 409, "PENDING_PROPOSALS", /proposal/i],
    ["PENDING_JOIN_REQUESTS", 409, "PENDING_JOIN_REQUESTS", /join request/i],
    ["ROSTER_BELOW_MINIMUM", 409, "ROSTER_BELOW_MINIMUM", /below.*minimum|fewer/i],
    ["ROSTER_ABOVE_MAXIMUM", 409, "ROSTER_ABOVE_MAXIMUM", /above.*maximum|more/i],
    ["MEMBER_CONFLICT", 409, "MEMBER_CONFLICT", /more than one team/i],
    ["ORGANIZER_REVOKED", 403, "ORGANIZER_REVOKED", /organizer access.*ended|no longer/i],
    ["NOT_ORGANIZER", 403, "NOT_ORGANIZER", /only.*organizer/i],
    ["WRONG_STATE", 409, "WRONG_STATE", /not open/i],
  ];
  it.each(MESSAGES)("shows a bounded, actionable message for %s and never claims success", async (_label, status, code, expected) => {
    const o = await organizer("TEAM_REGISTRATION_OPEN", { close: () => ({ status, json: { error: "RAW SERVER TEXT <b>x</b> with internals", code } }) });
    click(o.$("#btn-close-registration"));
    click(o.$("#btn-freeze-confirm"));
    await o.page.settle(() => /error/.test(o.$("#freeze-status")!.className), "the failure");
    const text = o.$("#freeze-status")!.textContent!;
    expect(text).toMatch(expected);
    expect(text).not.toMatch(/RAW SERVER TEXT|internals|<b>/);
    expect(text).not.toMatch(/registration frozen|has been frozen/i);
    expect(o.visible(o.$("#freeze-summary"))).toBe(false);
    expect(o.$("#freeze-status")!.className).toMatch(/error/);
    o.page.close();
  });

  it("an unknown code gets one generic, honest sentence — never the raw server text", async () => {
    const o = await organizer("TEAM_REGISTRATION_OPEN", { close: () => ({ status: 409, json: { error: "SECRET internal detail", code: "SOMETHING_NEW" } }) });
    click(o.$("#btn-close-registration"));
    click(o.$("#btn-freeze-confirm"));
    await o.page.settle(() => /error/.test(o.$("#freeze-status")!.className), "the failure");
    expect(o.$("#freeze-status")!.textContent).toMatch(/could not freeze registration/i);
    expect(o.$("#freeze-status")!.textContent).not.toContain("SECRET");
    o.page.close();
  });

  const MALFORMED: Array<[string, unknown]> = [
    ["no result", { }], ["a result without a freeze", { result: { competitionId: CID, state: "READY_TO_PUBLISH" } }],
    ["the wrong state", { result: { competitionId: CID, state: "TEAM_REGISTRATION_OPEN", freeze: FREEZE } }],
    ["three teams", { result: { competitionId: CID, state: "READY_TO_PUBLISH", freeze: { ...FREEZE, teamCount: 3, teams: FREEZE.teams.slice(0, 3) } } }],
    ["teams that are not names and counts", { result: { competitionId: CID, state: "READY_TO_PUBLISH", freeze: { ...FREEZE, teams: [1, 2, 3, 4] } } }],
    ["a non-numeric member count", { result: { competitionId: CID, state: "READY_TO_PUBLISH", freeze: { ...FREEZE, memberCount: "many" } } }],
    ["a string instead of an object", "frozen"],
  ];
  it.each(MALFORMED)("a 200 answer with %s is NOT success: the page says it could not verify the answer and shows no summary", async (_label, json) => {
    const o = await organizer("TEAM_REGISTRATION_OPEN", { close: () => ({ status: 200, json }) });
    click(o.$("#btn-close-registration"));
    click(o.$("#btn-freeze-confirm"));
    await o.page.settle(() => /error/.test(o.$("#freeze-status")!.className), "the outcome");
    expect(o.$("#freeze-status")!.textContent).toMatch(/could not be verified/i);
    expect(o.$("#freeze-status")!.textContent).not.toMatch(/registration frozen|has been frozen/i);
    expect(o.visible(o.$("#freeze-summary"))).toBe(false);
    expect(o.$("#freeze-status")!.className).toMatch(/error/);
    o.page.close();
  });

  it("a request that never answers fails closed after the page's read timeout, and one that throws fails closed at once", async () => {
    const never = new Promise<never>(() => {});
    const slow = await organizer("TEAM_REGISTRATION_OPEN", { close: () => never as never });
    slow.page.win.eval("READ_TIMEOUT_MS = 40");
    click(slow.$("#btn-close-registration"));
    click(slow.$("#btn-freeze-confirm"));
    await slow.page.settle(() => /could not be verified|reload/i.test(slow.$("#freeze-status")!.textContent ?? ""), "the timeout outcome");
    expect(slow.$("#freeze-status")!.textContent).not.toMatch(/registration frozen|has been frozen/i);
    expect(slow.visible(slow.$("#freeze-summary"))).toBe(false);
    slow.page.close();

    const thrown = await organizer("TEAM_REGISTRATION_OPEN", { close: () => { throw new Error("network down"); } });
    click(thrown.$("#btn-close-registration"));
    click(thrown.$("#btn-freeze-confirm"));
    await thrown.page.settle(() => /could not|reload/i.test(thrown.$("#freeze-status")!.textContent ?? ""), "the failure");
    expect(thrown.$("#freeze-status")!.textContent).not.toMatch(/registration frozen|has been frozen/i);
    expect(thrown.visible(thrown.$("#freeze-summary"))).toBe(false);
    thrown.page.close();
  });

  it("a second click while the request is in flight sends nothing more", async () => {
    let release: ((v: unknown) => void) | undefined;
    const held = new Promise((r) => { release = r; });
    const o = await organizer("TEAM_REGISTRATION_OPEN", { close: () => held as never });
    click(o.$("#btn-close-registration"));
    click(o.$("#btn-freeze-confirm"));
    click(o.$("#btn-freeze-confirm"));
    click(o.$("#btn-freeze-confirm"));
    await new Promise((r) => setTimeout(r, 30));
    expect(o.posts()).toEqual([`POST ${CLOSE}`]);
    expect((o.$("#btn-freeze-confirm") as HTMLButtonElement).disabled).toBe(true);
    release!({ status: 409, json: { code: "DEADLINE_NOT_REACHED", error: "x" } });
    await o.page.settle(() => !(o.$("#btn-freeze-confirm") as HTMLButtonElement).disabled, "the controls to return");
    o.page.close();
  });

  it("hostile team names are inert in the checklist and the summary", async () => {
    const hostile = '<img src=x onerror="window.__xss=1">';
    const teams = [{ name: hostile, memberCount: 5 }, { name: "B", memberCount: 5 }, { name: "C", memberCount: 5 }, { name: "D", memberCount: 5 }];
    const open = await organizer("TEAM_REGISTRATION_OPEN", {}, { registrationReadiness: { ...READINESS, teams } });
    expect(open.page.doc.querySelectorAll("#freeze-card img")).toHaveLength(0);
    expect((open.page.win as unknown as Record<string, unknown>).__xss).toBeUndefined();
    open.page.close();
    const frozen = await organizer("READY_TO_PUBLISH", {}, { registration: { ...REG, frozen: true }, registrationReadiness: null, registrationFreeze: { ...FREEZE, teams } });
    expect(frozen.page.doc.querySelectorAll("#freeze-card img")).toHaveLength(0);
    expect(frozen.page.doc.getElementById("freeze-summary")!.textContent).toContain(hostile);
    expect((frozen.page.win as unknown as Record<string, unknown>).__xss).toBeUndefined();
    frozen.page.close();
  });

  it("opening: a refusal for a missing plan or an expired deadline is explained in the page's own bounded words", async () => {
    for (const [code, expected] of [["PLAN_MISSING", /save a registration plan/i], ["DEADLINE_EXPIRED", /deadline.*passed/i], ["PLAN_INVALID", /plan.*cannot be used|save the plan again/i]] as const) {
      const o = await organizer("DRAFT", { open: () => ({ status: 409, json: { error: "RAW TEXT", code } }) }, { registration: null, registrationReadiness: null });
      click(o.$("#btn-open-registration"));
      await o.page.settle(() => (o.$("#msg-registration")!.textContent ?? "").length > 0, "the opening outcome");
      expect(o.$("#msg-registration")!.textContent, code).toMatch(expected);
      expect(o.$("#msg-registration")!.textContent).not.toContain("RAW TEXT");
      expect(o.$("#msg-registration")!.className).toMatch(/error/);
      o.page.close();
    }
  });

  it("the freeze card is part of the organizer-only block: a scorekeeper context never shows it, and a hidden freeze control sends nothing", async () => {
    const markup = readFileSync(path.join(process.cwd(), "public/competitions-admin.html"), "utf8");
    const organizerBlock = markup.slice(markup.indexOf('<div id="organizer-only">'));
    expect(organizerBlock.indexOf('id="freeze-card"')).toBeGreaterThan(-1);
    expect(markup.slice(0, markup.indexOf('<div id="organizer-only">'))).not.toContain('id="freeze-card"');
    const shipped = new (await import("jsdom")).JSDOM(markup).window.document;
    expect(shipped.querySelectorAll('[id*="planning"], [class*="planning"], [name*="planning"]')).toHaveLength(0); // the draft editor's markup rule still holds
    expect((shipped.getElementById("freeze-card") as HTMLElement).hidden).toBe(true);
    expect((shipped.getElementById("freeze-confirm") as HTMLElement).hidden).toBe(true);
    expect((shipped.getElementById("freeze-summary") as HTMLElement).hidden).toBe(true);
  });
});
