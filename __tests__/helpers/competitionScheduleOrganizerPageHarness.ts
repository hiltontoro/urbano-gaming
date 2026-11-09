import { createHash } from "node:crypto";

import {
  ADMIN_SOURCE, AMENDMENT_URL, CID, CODE, PLANNING_URL, SIGNED_IN, TEAM_NAMES, VIEW_URL, defer, never, openAmendAdminPage, viewBody,
} from "./competitionPlanAmendmentPageHarness";
import type { AmendPage, AmendReply, AmendRequest } from "./competitionPlanAmendmentPageHarness";
import {
  computeScheduleProposalDigest, computeScheduleRequestDigest, evaluateScheduleProposal, parseScheduleProposalRequest, publicScheduleProposal, publicScheduleRead,
  scheduleTimingFor, verifyScheduleProposal,
} from "../../lib/gaming/competitions/scheduleProposal";
import type { ScheduleFacts } from "../../lib/gaming/competitions/scheduleProposal";
import { computeSchedulePublicationDigest, parsePublishRequest, publicScheduledPublication, verifySchedulePublication } from "../../lib/gaming/competitions/schedulePublication";
import type {
  PublishScheduledCompetitionResult, ScheduleContextRecord, ScheduleFixtureRole, SchedulePublicationRecord, ScheduleProposalRecord, ScheduleProposalStatus, ScheduleRequestPlacement,
} from "../../lib/gaming/competitions/types";
import { DRAW_URL, defaultDrawWire } from "./competitionDrawOrganizerPageHarness";

/**
 * UG-CR-GATE-SSS-028 — test support for the organizer's schedule-and-publish surface on the SHIPPED /competitions-admin.html, run whole in jsdom.
 *
 * EVERYTHING HERE IS A DOUBLE. The page is the real page; the network and authentication are supplied by the test. What makes these doubles worth having is that they
 * are not hand-typed look-alikes of the server's answers: every proposal, context, history and publication below is produced by the REAL, already contract-tested
 * server functions (the evaluator, the request and proposal digests, the strict request parsers, the verifier of a stored proposal, the verifier of a stored publication
 * and the public mappers a browser is shown), and each one is VERIFIED by the server's own verifier before it is handed to the page. The mini server below also judges
 * every request the page sends with the real parsers, so a request the real route would refuse is refused here too. The evidence these tests give is about what the
 * page does with those answers — never about the real database, which is exercised separately by the loopback Supabase contract suites.
 */

export { CID, CODE, SIGNED_IN, TEAM_NAMES, defer, never, ADMIN_SOURCE, VIEW_URL, PLANNING_URL, AMENDMENT_URL, viewBody };
export type SchedulePage = AmendPage;
export type ScheduleRequest = AmendRequest;
export type ScheduleReply = AmendReply;

export const SCHEDULE_URL = `/api/gaming/competitions/${CID}/schedule-proposal`;
export const PUBLISH_URL = `/api/gaming/competitions/${CID}/publish`;
// UG-CR-GATE-SSS-031: the schedule surface is offered only after the organizer page has read an existing, verified draw (see competitionDrawOrganizerPageHarness.ts).
export { DRAW_URL };
export const ORGANIZER_SIGNAL = { organizer: true, captain: false };
export const ABSENT = Symbol("absent");

const sha = (text: string) => createHash("sha256").update(text, "utf8").digest("hex");
const wire = <T,>(value: T): any => JSON.parse(JSON.stringify(value));

export const PITCH_A = "a0000000-0000-4000-8000-00000000000a";
export const PITCH_B = "b0000000-0000-4000-8000-00000000000b";
export const PITCH_C = "c0000000-0000-4000-8000-00000000000c";
export const PITCH_D = "d0000000-0000-4000-8000-00000000000d";
export const TEAM_IDS = ["10000000-0000-4000-8000-000000000001", "10000000-0000-4000-8000-000000000002", "10000000-0000-4000-8000-000000000003", "10000000-0000-4000-8000-000000000004"];
export const REVISION_ID = "22222222-2222-4222-8222-222222222222";
export const DRAW_ID = "55555555-5555-4555-8555-555555555555";
export const DRAW_DIGEST = sha("draw");
export const ORGANIZER_ID = "66666666-6666-4666-8666-666666666666";
export const FIXTURE_IDS = ["f0000000-0000-4000-8000-000000000001", "f0000000-0000-4000-8000-000000000002", "f0000000-0000-4000-8000-000000000003"];
export const UUID_ANY = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;
export const HEX64 = /[0-9a-f]{64}/i;

/** The decision instant the mini server judges every proposal at: a week before the tournament dates below. */
export const NOW_MS = Date.parse("2026-11-07T12:00:00.000Z");
export const PROPOSED_AT = "2026-11-07T14:30:00.123456Z";

/** The accepted plan: a 5-a-side venue in Costa Rica (UTC-6, no daylight saving), two pitches that can be used, one that cannot, one that is not set up for this format. */
export function makeFacts(overrides: Partial<ScheduleFacts> = {}): ScheduleFacts {
  return {
    formatKey: "SOCCER_5V5",
    timeZone: "America/Costa_Rica",
    simultaneousMatchCapacity: 2,
    pitches: [
      { planningPitchId: PITCH_A, label: "Pitch A", usable: true, supportedFormats: ["SOCCER_5V5"] },
      { planningPitchId: PITCH_B, label: "Pitch B", usable: true, supportedFormats: ["SOCCER_5V5", "SOCCER_6V6"] },
      { planningPitchId: PITCH_C, label: "Pitch C (under repair)", usable: false, supportedFormats: ["SOCCER_5V5"] },
      { planningPitchId: PITCH_D, label: "Pitch D (training)", usable: true, supportedFormats: ["SOCCER_6V6"] },
    ],
    dates: [
      { date: "2026-11-14", windows: [{ start: "09:00", end: "13:00" }, { start: "15:00", end: "19:00" }] },
      { date: "2026-11-15", windows: [{ start: "10:00", end: "14:00" }] },
    ],
    ...overrides,
  };
}

export const GOOD_PLACEMENTS: ScheduleRequestPlacement[] = [
  { fixtureRole: "SEMIFINAL_1", planningPitchId: PITCH_A, planDate: "2026-11-14", startTime: "10:00" },
  { fixtureRole: "SEMIFINAL_2", planningPitchId: PITCH_B, planDate: "2026-11-14", startTime: "10:00" },
  { fixtureRole: "FINAL", planningPitchId: PITCH_A, planDate: "2026-11-14", startTime: "15:00" },
];
export const OTHER_PLACEMENTS: ScheduleRequestPlacement[] = [
  { fixtureRole: "SEMIFINAL_1", planningPitchId: PITCH_B, planDate: "2026-11-15", startTime: "10:00" },
  { fixtureRole: "SEMIFINAL_2", planningPitchId: PITCH_A, planDate: "2026-11-15", startTime: "10:00" },
  { fixtureRole: "FINAL", planningPitchId: PITCH_B, planDate: "2026-11-15", startTime: "12:00" },
];

export function contextRecord(facts: ScheduleFacts = makeFacts(), planningRevisionNumber = 2): ScheduleContextRecord {
  const t = scheduleTimingFor(facts.formatKey);
  return {
    planningRevisionNumber, formatKey: facts.formatKey, timeZone: facts.timeZone, simultaneousMatchCapacity: facts.simultaneousMatchCapacity,
    timing: { occupancyMinutes: t.occupancyMinutes, pitchTransitionMinutes: t.pitchTransitionMinutes, minimumTeamRestMinutes: t.minimumTeamRestMinutes },
    pitches: facts.pitches.map((p) => ({ planningPitchId: p.planningPitchId, label: p.label, usable: p.usable, supportedFormats: [...p.supportedFormats] })),
    dates: facts.dates.map((d) => ({ date: d.date, windows: d.windows.map((w) => ({ start: w.start, end: w.end })) })),
  };
}

export interface RecordOptions {
  sequenceNumber?: number;
  status?: ScheduleProposalStatus;
  planningRevisionCurrent?: boolean;
  drawDigestMatches?: boolean;
  placements?: ScheduleRequestPlacement[];
  intentId?: string;
  supersedesDigest?: string | null;
  createdAt?: string;
  facts?: ScheduleFacts;
  teamNames?: string[];
  planningRevisionNumber?: number;
}

/** A REAL stored proposal: derived by the server's own evaluator, digested by its own functions, and checked by its own verifier before any page sees it. */
export function makeRecord(o: RecordOptions = {}): ScheduleProposalRecord {
  const facts = o.facts ?? makeFacts();
  const placements = o.placements ?? GOOD_PLACEMENTS;
  const sequenceNumber = o.sequenceNumber ?? 3;
  const status = o.status ?? "CURRENT";
  const stale = status === "STALE";
  const planningRevisionCurrent = o.planningRevisionCurrent ?? !stale;
  const drawDigestMatches = o.drawDigestMatches ?? true;
  const intentId = o.intentId ?? `33333333-3333-4333-8333-${String(sequenceNumber).padStart(12, "0")}`;
  const evaluated = evaluateScheduleProposal(facts, placements, null);
  if (!evaluated.ok) throw new Error(`the fixture schedule is not valid: ${JSON.stringify(evaluated.violations)}`);
  const names = o.teamNames ?? TEAM_NAMES;
  const t = scheduleTimingFor(facts.formatKey);
  const timing = { occupancyMinutes: t.occupancyMinutes, pitchTransitionMinutes: t.pitchTransitionMinutes, minimumTeamRestMinutes: t.minimumTeamRestMinutes };
  const requestDigest = computeScheduleRequestDigest(CID, intentId, placements);
  const planningRevisionNumber = o.planningRevisionNumber ?? 2;
  const supersedesDigest = o.supersedesDigest === undefined ? (sequenceNumber === 1 ? null : sha(`previous-${sequenceNumber}`)) : o.supersedesDigest;
  const base = {
    sequenceNumber, supersedesDigest, requestDigest, planningRevisionId: REVISION_ID, drawId: DRAW_ID, drawDigest: DRAW_DIGEST, formatKey: facts.formatKey, timeZone: facts.timeZone,
    simultaneousMatchCapacity: facts.simultaneousMatchCapacity, timing,
  };
  const proposalDigest = computeScheduleProposalDigest(CID, { ...base, placements: evaluated.placements });
  const team = (i: number) => ({ teamId: TEAM_IDS[i], teamName: names[i] });
  const record: ScheduleProposalRecord = {
    sequenceNumber, createdAt: o.createdAt ?? PROPOSED_AT, status, planningRevisionCurrent, drawDigestMatches, proposalDigest, requestDigest, supersedesDigest,
    planningRevisionId: REVISION_ID, planningRevisionNumber, drawId: DRAW_ID, drawDigest: DRAW_DIGEST, formatKey: facts.formatKey, timeZone: facts.timeZone,
    simultaneousMatchCapacity: facts.simultaneousMatchCapacity, timing,
    placements: evaluated.placements.map((p, i) => ({ ...p, teamA: i === 0 ? team(0) : i === 1 ? team(2) : null, teamB: i === 0 ? team(1) : i === 1 ? team(3) : null })),
  };
  const verdict = verifyScheduleProposal(CID, record);
  if (!verdict.ok) throw new Error(`the fixture proposal does not verify: ${verdict.reason}`);
  return record;
}

export const summaryOf = (r: ScheduleProposalRecord) => ({ sequenceNumber: r.sequenceNumber, createdAt: r.createdAt, status: r.status, proposalDigest: r.proposalDigest });

/** The body GET /schedule-proposal returns (the real public mapper's output, as it crosses the wire). Newest first. */
export function readWire(o: { context?: ScheduleContextRecord | null; proposal?: ScheduleProposalRecord | null; history?: Array<ReturnType<typeof summaryOf>> } = {}) {
  const proposal = o.proposal === undefined ? makeRecord() : o.proposal;
  const history = o.history ?? (proposal ? [summaryOf(proposal)] : []);
  return wire(publicScheduleRead({ context: o.context === undefined ? contextRecord() : o.context, proposal, history }));
}

/** A chain of proposals 1..n against the same plan: all but the last SUPERSEDED, the last in `lastStatus`. */
export function chain(n: number, lastStatus: ScheduleProposalStatus = "CURRENT") {
  const records: ScheduleProposalRecord[] = [];
  for (let i = 1; i <= n; i++) {
    const last = i === n;
    const placements = i % 2 === 1 ? GOOD_PLACEMENTS : OTHER_PLACEMENTS;
    records.push(makeRecord({
      sequenceNumber: i, placements, status: last ? lastStatus : "SUPERSEDED", createdAt: `2026-11-07T14:${String(10 + i).padStart(2, "0")}:00.123456Z`,
      supersedesDigest: i === 1 ? null : records[i - 2].proposalDigest, planningRevisionCurrent: last ? lastStatus !== "STALE" : true,
    }));
  }
  return records;
}
export const historyOf = (records: ScheduleProposalRecord[]) => [...records].reverse().map(summaryOf);

/** A REAL publication evidence, verified by the server's own verifier, as the publish route's public mapper presents it. */
export function publicationWire(o: { alreadyPublished?: boolean; scheduleProposalDigest?: string; proposalSequence?: number } = {}) {
  const record = o.proposalSequence ?? 3;
  const digest = o.scheduleProposalDigest ?? makeRecord({ sequenceNumber: record }).proposalDigest;
  const placements = makeRecord({ sequenceNumber: record }).placements;
  const input = {
    scheduleProposalSequence: record, scheduleProposalDigest: digest, planningRevisionId: REVISION_ID, drawId: DRAW_ID, drawDigest: DRAW_DIGEST, publishedByGamingMemberId: ORGANIZER_ID,
    publishedAt: "2026-11-07T15:00:00.654321Z",
    fixtures: [
      { fixtureRole: "SEMIFINAL_1" as ScheduleFixtureRole, competitionFixtureId: FIXTURE_IDS[0], startsAt: placements[0].startUtc, teamAId: TEAM_IDS[0], teamBId: TEAM_IDS[1], sourceFixtureAId: null, sourceFixtureBId: null },
      { fixtureRole: "SEMIFINAL_2" as ScheduleFixtureRole, competitionFixtureId: FIXTURE_IDS[1], startsAt: placements[1].startUtc, teamAId: TEAM_IDS[2], teamBId: TEAM_IDS[3], sourceFixtureAId: null, sourceFixtureBId: null },
      { fixtureRole: "FINAL" as ScheduleFixtureRole, competitionFixtureId: FIXTURE_IDS[2], startsAt: placements[2].startUtc, teamAId: null, teamBId: null, sourceFixtureAId: FIXTURE_IDS[0], sourceFixtureBId: FIXTURE_IDS[1] },
    ],
  };
  const publication: SchedulePublicationRecord = { ...input, publicationDigest: computeSchedulePublicationDigest(CID, input) };
  const verdict = verifySchedulePublication(CID, publication);
  if (!verdict.ok) throw new Error(`the fixture publication does not verify: ${verdict.reason}`);
  const result: PublishScheduledCompetitionResult = { competitionId: CID, alreadyPublished: o.alreadyPublished === true, publication };
  return wire(publicScheduledPublication(result));
}

// ---------------------------------------------------------------------------------------------------------------------------------------------
// The mini server: the real parsers, evaluator and mappers behind GET/POST schedule-proposal and POST publish
// ---------------------------------------------------------------------------------------------------------------------------------------------

/**
 * A faithful stand-in for the three routes the page consumes, behind which sit the REAL server functions. It is as strict as the routes are about what a request may
 * contain (the real parsers), judges a proposed schedule with the real evaluator at a fixed decision instant, keeps a gap-free sequence, supersedes earlier proposals,
 * answers an exact replay of an intent with the existing proposal (200) and a reused intent with different values with INTENT_MISMATCH (409), and refuses a publication
 * of anything but the latest CURRENT proposal. It has no clock of its own: `nowMs` is moved by the test.
 */
export class MiniScheduleServer {
  readonly facts: ScheduleFacts;
  nowMs = NOW_MS;
  records: ScheduleProposalRecord[] = [];
  planCurrent = true;
  drawMatches = true;
  published: ReturnType<typeof publicationWire> | null = null;
  readonly log: Array<{ route: "GET" | "PROPOSE" | "PUBLISH"; body?: unknown }> = [];
  private intents = new Map<string, { key: string; sequence: number }>();

  constructor(options: { facts?: ScheduleFacts; records?: ScheduleProposalRecord[] } = {}) {
    this.facts = options.facts ?? makeFacts();
    if (options.records) this.records = [...options.records];
  }

  context() { return contextRecord(this.facts); }
  latest(): ScheduleProposalRecord | null { return this.records.length ? this.statusApplied(this.records[this.records.length - 1], true) : null; }

  private statusApplied(r: ScheduleProposalRecord, isLatest: boolean): ScheduleProposalRecord {
    if (!isLatest) return { ...r, status: "SUPERSEDED" };
    const status: ScheduleProposalStatus = this.planCurrent && this.drawMatches ? "CURRENT" : "STALE";
    return { ...r, status, planningRevisionCurrent: this.planCurrent, drawDigestMatches: this.drawMatches };
  }

  read(): ReturnType<typeof readWire> {
    this.log.push({ route: "GET" });
    const latest = this.latest();
    const history = this.records.map((r, i) => summaryOf(this.statusApplied(r, i === this.records.length - 1))).reverse();
    return readWire({ context: this.context(), proposal: latest, history });
  }

  propose(body: unknown): ScheduleReply {
    this.log.push({ route: "PROPOSE", body });
    let parsed;
    try {
      parsed = parseScheduleProposalRequest(body);
    } catch (err) {
      const violations = (err as { violations?: unknown }).violations;
      return { status: 400, json: { error: (err as Error).message, problems: violations } };
    }
    const key = JSON.stringify(parsed.placements);
    const seen = this.intents.get(parsed.intentId);
    if (seen) {
      if (seen.key !== key) return { status: 409, json: { error: "This request identifier was already used for a different schedule.", code: "INTENT_MISMATCH" } };
      const existing = this.records[seen.sequence - 1];
      return { status: 200, json: wire({ proposal: publicScheduleProposal(this.statusApplied(existing, seen.sequence === this.records.length)), alreadyProposed: true }) };
    }
    const evaluated = evaluateScheduleProposal(this.facts, parsed.placements, this.nowMs);
    if (!evaluated.ok) return { status: 400, json: { error: "The schedule proposal is not valid.", problems: evaluated.violations } };
    const previous = this.records.length ? this.records[this.records.length - 1] : null;
    const record = makeRecord({
      sequenceNumber: this.records.length + 1, placements: parsed.placements, intentId: parsed.intentId, facts: this.facts, supersedesDigest: previous ? previous.proposalDigest : null,
      createdAt: `2026-11-07T14:${String(31 + this.records.length).padStart(2, "0")}:00.123456Z`,
    });
    this.records.push(record);
    this.intents.set(parsed.intentId, { key, sequence: record.sequenceNumber });
    return { status: 201, json: wire({ proposal: publicScheduleProposal(this.statusApplied(record, true)), alreadyProposed: false }) };
  }

  publish(body: unknown): ScheduleReply {
    this.log.push({ route: "PUBLISH", body });
    let parsed;
    try {
      parsed = parsePublishRequest(body);
    } catch (err) {
      return { status: 400, json: { error: "Invalid publish payload.", problems: (err as { violations?: unknown }).violations } };
    }
    if (parsed.kind !== "SCHEDULE") return { status: 409, json: { error: "This competition is published from its schedule proposal.", code: "SCHEDULE_PROPOSAL_PUBLICATION_REQUIRED" } };
    const index = this.records.findIndex((r) => r.proposalDigest === parsed.scheduleProposalDigest);
    if (index < 0) return { status: 404, json: { error: "This competition has no schedule proposal with that digest.", code: "PROPOSAL_NOT_FOUND" } };
    if (this.published) {
      if (this.published.publication.scheduleProposalDigest === parsed.scheduleProposalDigest) {
        return { status: 200, json: { ...this.published, publication: { ...this.published.publication, alreadyPublished: true } } };
      }
      return { status: 409, json: { error: "This competition was already published from a different schedule proposal.", code: "PUBLICATION_CONFLICT" } };
    }
    if (index !== this.records.length - 1) return { status: 409, json: { error: "A later schedule proposal exists.", code: "PROPOSAL_SUPERSEDED" } };
    if (!this.planCurrent || !this.drawMatches) return { status: 409, json: { error: "The plan or the draw has changed.", code: "PROPOSAL_STALE" } };
    const again = evaluateScheduleProposal(this.facts, this.records[index].placements.map((p) => ({ fixtureRole: p.fixtureRole, planningPitchId: p.planningPitchId, planDate: p.planDate, startTime: p.startTime })), this.nowMs);
    if (!again.ok) {
      return { status: 409, json: { error: "This schedule can no longer be published as proposed. Propose the schedule again and publish the new proposal.", code: "SCHEDULE_NOT_PUBLISHABLE", problems: again.violations } };
    }
    this.published = publicationWire({ scheduleProposalDigest: parsed.scheduleProposalDigest, proposalSequence: this.records[index].sequenceNumber });
    return { status: 201, json: this.published };
  }
}

// ---------------------------------------------------------------------------------------------------------------------------------------------
// The page, its scenario and the usual moves
// ---------------------------------------------------------------------------------------------------------------------------------------------

export interface ScheduleScenario {
  state?: string;
  signal?: unknown | typeof ABSENT;
  entries?: unknown[];
  auth?: unknown;
  search?: string;
  /** Answers GET /schedule-proposal (the id is the competition addressed). */
  schedule?: (request: ScheduleRequest, competitionId: string) => ScheduleReply | Promise<ScheduleReply>;
  propose?: (request: ScheduleRequest) => ScheduleReply | Promise<ScheduleReply>;
  publish?: (request: ScheduleRequest) => ScheduleReply | Promise<ScheduleReply>;
  /** Answers GET /competitions/{id} (the addressed competition's view). */
  view?: (request: ScheduleRequest, competitionId: string) => ScheduleReply | Promise<ScheduleReply>;
  planning?: (request: ScheduleRequest) => ScheduleReply | Promise<ScheduleReply>;
  amendment?: (request: ScheduleRequest) => ScheduleReply | Promise<ScheduleReply>;
  /** UG-CR-GATE-SSS-031: answers GET /draw. By default the competition HAS a draw (verified by the server's own verifier), so every schedule scenario reaches its schedule read. */
  draw?: (request: ScheduleRequest, competitionId: string) => ScheduleReply | Promise<ScheduleReply>;
  /** UG-CR-GATE-SSS-031: answers POST /draw. By default an unexpected write (500): a scenario that makes a draw says how. */
  drawPost?: (request: ScheduleRequest) => ScheduleReply | Promise<ScheduleReply>;
  timeoutMs?: number;
  /** UG-CR-GATE-SSS-031: the page's own bound on a draw request. */
  drawTimeoutMs?: number;
}

const ID_PATTERN = /^\/api\/gaming\/competitions\/([0-9a-f-]{36})(\/[a-z-]+)?$/;

export function scheduleTransport(s: ScheduleScenario) {
  const entries = s.entries ?? [{ competitionId: CID, name: "Frozen Cup", state: s.state ?? "READY_TO_PUBLISH", access: "ORGANIZER" }];
  const defaultView = (_r: ScheduleRequest, id: string): ScheduleReply => ({ status: 200, json: viewBody({ state: s.state, signal: s.signal === ABSENT ? undefined : (s.signal ?? ORGANIZER_SIGNAL), extra: id === CID ? {} : { } }) });
  return (r: ScheduleRequest): ScheduleReply | Promise<ScheduleReply> => {
    if (r.url === ADMIN_SOURCE) return { status: 200, json: { competitions: entries, operations: { createCompetition: false } } };
    const m = ID_PATTERN.exec(r.url);
    if (m) {
      const [, id, suffix] = m;
      if (!suffix && r.method === "GET") return (s.view ?? defaultView)(r, id);
      if (suffix === "/draw" && r.method === "GET") return (s.draw ?? (() => ({ status: 200, json: { draw: defaultDrawWire() } })))(r, id);
      if (suffix === "/draw" && r.method === "POST") return (s.drawPost ?? (() => ({ status: 500, json: { error: "unexpected draw write" } })))(r);
      if (suffix === "/schedule-proposal" && r.method === "GET") return (s.schedule ?? (() => ({ status: 200, json: readWire() })))(r, id);
      if (suffix === "/schedule-proposal" && r.method === "POST") return (s.propose ?? (() => ({ status: 500, json: { error: "unexpected proposal write" } })))(r);
      if (suffix === "/publish" && r.method === "POST") return (s.publish ?? (() => ({ status: 500, json: { error: "unexpected publication write" } })))(r);
      if (suffix === "/planning" && r.method === "GET") return (s.planning ?? (() => ({ status: 404, json: { error: "x" } })))(r);
      if (suffix === "/plan-amendment" && r.method === "GET") return (s.amendment ?? (() => ({ status: 404, json: { error: "x" } })))(r);
    }
    if (r.url.endsWith("/admin-detail")) {
      return { status: 200, json: { fixture: {}, teamARoster: null, teamBRoster: null, checkIns: [], attestations: [], evidence: null, goalEvents: [], assistEvents: [], shootout: null, disputes: [], finalization: null, eligibleMembers: [], displayNames: {} } };
    }
    return { status: 404, json: { error: "unexpected request" } };
  };
}

/** The shipped organizer page, signed in, with the scenario's answers; resolves once the competition list has been filled. */
export async function openScheduleAdmin(s: ScheduleScenario = {}): Promise<SchedulePage> {
  const page = openAmendAdminPage({ auth: s.auth ?? SIGNED_IN, search: s.search, transport: scheduleTransport(s) });
  if (s.timeoutMs !== undefined) page.run(`SCHEDULE_TIMEOUT_MS = ${s.timeoutMs}`);
  if (s.drawTimeoutMs !== undefined) page.run(`DRAW_TIMEOUT_MS = ${s.drawTimeoutMs}`);
  await page.settle(() => page.$$("#comp-select option").length > 0 || (page.$("#admin-gate") && page.$("#admin-gate").textContent !== ""), "the competition list");
  return page;
}

export async function loadCompetition(page: SchedulePage, id: string = CID) {
  page.$("#comp-select").value = id;
  page.click(page.$("#btn-load-competition"));
  await page.settle(() => page.visible(page.$("#competition-detail")) && page.$("#comp-title").textContent !== "", "the competition detail");
}
export async function openSection(page: SchedulePage, id: string = CID) {
  await loadCompetition(page, id);
  await page.settle(() => !!page.$("#schedule-section"), "the schedule section");
}

export const ROLE_KEYS = ["sf1", "sf2", "final"] as const;
export type RoleKey = (typeof ROLE_KEYS)[number];
export interface Choice { pitch: string; date: string; time: string }
export function choose(page: SchedulePage, role: RoleKey, c: Choice) {
  page.setValue(page.$(`#schedule-${role}-pitch`), c.pitch);
  page.setValue(page.$(`#schedule-${role}-date`), c.date);
  page.setValue(page.$(`#schedule-${role}-time`), c.time);
}
export function chooseAll(page: SchedulePage, placements: ScheduleRequestPlacement[] = GOOD_PLACEMENTS) {
  placements.forEach((p, i) => choose(page, ROLE_KEYS[i], { pitch: p.planningPitchId, date: p.planDate, time: p.startTime }));
}
export const optionValues = (page: SchedulePage, selector: string): string[] => page.$$(`${selector} option`).map((o: HTMLOptionElement) => o.value);
export const optionTexts = (page: SchedulePage, selector: string): string[] => page.$$(`${selector} option`).map((o: HTMLOptionElement) => o.textContent ?? "");
export const scheduleRequests = (page: SchedulePage) => page.requests.filter((r) => r.url.includes("/schedule-proposal"));
export const drawRequests = (page: SchedulePage) => page.requests.filter((r) => r.url.endsWith("/draw"));
export const publishRequests = (page: SchedulePage) => page.requests.filter((r) => r.url.endsWith("/publish"));
export const writes = (page: SchedulePage) => page.requests.filter((r) => r.method === "POST");
