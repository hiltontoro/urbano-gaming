import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { GALLERY_CONSENT_TEXT, PROMO_CONSENT_TEXT } from "../lib/gaming/communityVoting/rounds/constants";
import * as constants from "../lib/gaming/communityVoting/rounds/constants";
import { cutPolicyRequirement, reviewDigest, type RoundTally } from "../lib/gaming/communityVoting/rounds/finalists";
import { deriveRoundPhase, deadlineRemainingMs } from "../lib/gaming/communityVoting/rounds/phase";

/**
 * UG-IV-GATE-005 / 005A — the corrections that need no database. WRITTEN BEFORE the corrections they cover (see the implementation record
 * for what failed first): the active candidate has ONE supported two-round path, and an obsolete route cannot be reached because it does not
 * exist; the pending Product policies and the schedule are exact; nothing the page does creates or opens an event.
 */

const ROOT = process.cwd();
const exists = (rel: string) => existsSync(path.join(ROOT, rel));
const read = (rel: string) => readFileSync(path.join(ROOT, rel), "utf8");
const walk = (dir: string): string[] =>
  !existsSync(dir)
    ? []
    : readdirSync(dir).flatMap((name) => {
        const full = path.join(dir, name);
        return statSync(full).isDirectory() ? walk(full) : [full];
      });
const rel = (f: string) => path.relative(ROOT, f);
const stripComments = (src: string) => src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

function load<T>(file: string, name: string): T {
  // eslint-disable-next-line @typescript-eslint/no-implied-eval
  return new Function(`${read(`public/${file}`)}\nreturn ${name};`)() as T;
}

// =====================================================================================================================
// The active candidate has one supported two-round path
// =====================================================================================================================

describe("superseded files are not part of the active candidate", () => {
  const REMOVED = [
    "supabase/migrations/20261028120000_community_voting_ranked_ballot_foundation.sql",
    "supabase/migrations/20261028120100_community_voting_ranked_ballot_functions.sql",
    "supabase/migrations/20261028120200_community_voting_ranked_ballot_guards.sql",
    "lib/gaming/communityVoting/ranked",
    "app/api/gaming/community-voting/ranked",
    "public/community-voting.html",
    "public/community-voting-operator.html",
    "public/community-voting-display.html",
    "public/communityVotingVoter.js",
    "public/communityVotingOperator.js",
    "__tests__/communityVotingRankedCore.test.ts",
    "__tests__/communityVotingRankedPages.test.ts",
    "__tests__/communityVotingRankedRoutes.contract.test.ts",
    "__tests__/communityVotingRankedSupabase.contract.test.ts",
    "__tests__/communityVotingRankedUiLogic.test.ts",
  ];
  for (const file of REMOVED) {
    it(`${file} is gone`, () => {
      expect(exists(file)).toBe(false);
    });
  }

  it("leaves no migration, module, route or page whose name says ranked, ballot or phone-possession", () => {
    const names = [
      ...walk(path.join(ROOT, "supabase/migrations")),
      ...walk(path.join(ROOT, "lib/gaming/communityVoting")),
      ...walk(path.join(ROOT, "app/api/gaming/community-voting")),
      ...walk(path.join(ROOT, "public")).filter((f) => /community-?voting/i.test(f)),
    ].map(rel);
    // The one exception is the name of the GATE-003 foundation's own migration (20261020190300 ... _and_ballot), which is frozen by its hash.
    expect(names.filter((n) => /ranked|ballot|phoneNumber|phoneProvider|phone\//i.test(n) && !/verifiedIdentity|20261020190300_guard_event_bound_opening_and_ballot/.test(n))).toEqual([]);
  });

  it("serves the voting API from exactly two route families: the GATE-003 foundation and the pilot's rounds", () => {
    const families = readdirSync(path.join(ROOT, "app/api/gaming/community-voting")).sort();
    expect(families).toEqual(["instances", "rounds", "route.ts"].filter((f) => families.includes(f)).sort());
    expect(families).not.toContain("ranked");
    expect(families.filter((f) => f !== "route.ts")).toEqual(["instances", "rounds"]);
  });

  it("mentions no five-option ballot, telephone possession, provider or Instagram in the pilot's code, routes or pages", () => {
    const files = [
      ...walk(path.join(ROOT, "lib/gaming/communityVoting/rounds")),
      ...walk(path.join(ROOT, "app/api/gaming/community-voting/rounds")),
      ...["community-voting-round.html", "community-voting-round-operator.html", "community-voting-round-display.html", "communityVotingRound.js", "communityVotingRoundOperator.js"].map((f) => path.join(ROOT, "public", f)),
    ].filter((f) => /\.(ts|js|html)$/.test(f));
    expect(files.length).toBeGreaterThan(30);
    for (const f of files) {
      expect(stripComments(readFileSync(f, "utf8")), rel(f)).not.toMatch(/ranked|ballot|RANK_POINTS|phoneDigest|phone_digest|twilio|whatsapp|\bsms\b|instagram|PUBLIC_PHOTO_RETENTION|removal_due|media-purge|purge/i);
    }
  });

  it("keeps the GATE-003 foundation: its migrations, modules and routes are all still there", () => {
    for (const f of [
      "supabase/migrations/20261020190000_create_community_voting_instances.sql",
      "supabase/migrations/20261020190100_create_community_voting_functions.sql",
      "supabase/migrations/20261020190200_guard_ordinary_join_for_community_voting.sql",
      "supabase/migrations/20261020190300_guard_event_bound_opening_and_ballot.sql",
      "lib/gaming/communityVoting/verifiedIdentity.ts",
      "lib/gaming/communityVoting/db/supabaseCommunityVotingRepository.ts",
      "app/api/gaming/community-voting/instances/route.ts",
    ]) expect(exists(f), f).toBe(true);
  });

  it("has only the pilot's migrations after the GATE-003 foundation: the three of the pilot and the one of GATE-010 (geofence setup, test events), additive, none of them ranked", () => {
    const mine = readdirSync(path.join(ROOT, "supabase/migrations")).filter((f) => /community_voting|event_bound_opening/.test(f)).sort();
    expect(mine).toEqual([
      "20261020190000_create_community_voting_instances.sql",
      "20261020190100_create_community_voting_functions.sql",
      "20261020190200_guard_ordinary_join_for_community_voting.sql",
      "20261020190300_guard_event_bound_opening_and_ballot.sql",
      "20261029100000_community_voting_two_round_foundation.sql",
      "20261029100100_community_voting_two_round_functions.sql",
      "20261029100200_community_voting_two_round_guards.sql",
      "20261030100000_community_voting_geofence_setup_and_test_events.sql",
    ]);
    const sql = mine.map((f) => read(`supabase/migrations/${f}`)).join("\n");
    expect(sql).not.toMatch(/RANKED_TOP_5|community_voting_ballots|ballot_picks|phone_digest|removal_due_at|RETENTION_EXPIRED/);
  });
});

describe("no retention period is operative", () => {
  it("exports no retention duration and states none to a contestant", () => {
    expect(Object.keys(constants).filter((k) => /RETENTION|REMOVAL/i.test(k))).toEqual([]);
    expect(GALLERY_CONSENT_TEXT).not.toMatch(/72|horas/i);
    expect(PROMO_CONSENT_TEXT).not.toMatch(/72|horas/i);
  });

  it("has no SQL or route that purges photographs or cuts public display at a time", () => {
    const sql = walk(path.join(ROOT, "supabase/migrations")).filter((f) => /20261029/.test(f)).map((f) => readFileSync(f, "utf8")).join("\n");
    expect(sql).not.toMatch(/interval '72 hours'|bytes_deleted_reason = 'RETENTION|purge_community|removal_due/i);
    expect(exists("app/api/gaming/community-voting/rounds/[instanceId]/operator/media-purge/route.ts")).toBe(false);
  });
});

// =====================================================================================================================
// Pending Product policies, mirrored in TypeScript
// =====================================================================================================================

const tally = (votes: number[], withdrawn: number[] = []): RoundTally[] => votes.map((v, i) => ({ ordinal: i + 1, label: `#${1000 + i}`, withdrawn: withdrawn.includes(i), votes: v }));

describe("which pending policy a cut needs", () => {
  it("none when every finalist has votes", () => {
    expect(cutPolicyRequirement(tally([3, 2, 1]))).toBeNull();
    expect(cutPolicyRequirement(tally([12, 11, 10, 9, 8, 7, 6, 5, 4, 3, 2, 1]))).toBeNull();
  });

  it("ZERO_VALID_VOTES_PRELIMINARY when nobody voted for an eligible contestant — even if votes for withdrawn contestants exist", () => {
    expect(cutPolicyRequirement(tally([0, 0, 0]))).toBe("ZERO_VALID_VOTES_PRELIMINARY");
    expect(cutPolicyRequirement(tally([5, 0, 0], [0]))).toBe("ZERO_VALID_VOTES_PRELIMINARY");
  });

  it("ZERO_VOTE_ENTRIES_AT_CUTOFF when a zero-vote entry would advance, in a small field or in a tie at the cutoff", () => {
    expect(cutPolicyRequirement(tally([3, 2, 0]))).toBe("ZERO_VOTE_ENTRIES_AT_CUTOFF");
    expect(cutPolicyRequirement(tally([4, 3, 3, 2, 2, 1, 1, 1, 0, 0, 0, 0]))).toBe("ZERO_VOTE_ENTRIES_AT_CUTOFF");
  });

  it("is not needed for a zero-vote entry that falls below the cutoff", () => {
    expect(cutPolicyRequirement(tally([12, 11, 10, 9, 8, 7, 6, 5, 4, 3, 0]))).toBeNull(); // eleventh and last: rank 11, outside
  });
});

describe("the review digest covers the competitive state", () => {
  it("changes with the round, the cut, the withdrawn contestants and the approved policies", () => {
    const base = reviewDigest("a".repeat(64), "b".repeat(64), [], []);
    expect(base).toMatch(/^[0-9a-f]{64}$/);
    expect(reviewDigest("a".repeat(64), "b".repeat(64), [3], [])).not.toBe(base);
    expect(reviewDigest("a".repeat(64), "b".repeat(64), [], [{ key: "FINALIST_WITHDRAWAL_AFTER_SELECTION", value: "EXCLUDE_WITHOUT_REFILL" }])).not.toBe(base);
    expect(reviewDigest("a".repeat(64), null, [], [])).not.toBe(base);
    expect(reviewDigest("c".repeat(64), "b".repeat(64), [], [])).not.toBe(base);
  });

  it("does not depend on the order of the withdrawn contestants or of the policies", () => {
    const p = [{ key: "ZERO_VOTE_ENTRIES_AT_CUTOFF", value: "X" }, { key: "FINALIST_WITHDRAWAL_AFTER_SELECTION", value: "Y" }];
    expect(reviewDigest("a".repeat(64), null, [5, 2], p)).toBe(reviewDigest("a".repeat(64), null, [2, 5], [...p].reverse()));
  });
});

// =====================================================================================================================
// The schedule: the Founder's initial times, exact; and nothing creates an event
// =====================================================================================================================

interface Operator {
  EVENT_TIME_ZONE: string;
  EVENT_SCHEDULE_TEMPLATE: { date: string; registrationOpens: string; registrationCloses: string; preliminaryOpens: string; preliminaryCloses: string; finalWindowSeconds: number };
  toEventInstant(date: string, time: string): string | null;
  templateInstants(): { registrationOpensAt: string; contestantCutoffAt: string; votingOpensAt: string; votingClosesAt: string };
  fromEventInstant(iso: string | null): { date: string; time: string } | null;
}
interface RoundLogic {
  EVENT_TIME_ZONE: string;
  formatEventTime(iso: string | null): string;
  phaseNotice(info: Record<string, unknown>): string;
  deadlineRemainingText(info: Record<string, unknown>): string | null;
}

describe("the initial schedule (31 October 2026, America/Tegucigalpa)", () => {
  const O = load<Operator>("communityVotingRoundOperator.js", "CommunityVotingRoundOperator");

  it("is registration and photographs 19:00–20:30, the preliminary 20:30–21:30, and a final of five minutes from its own opening", () => {
    expect(O.EVENT_TIME_ZONE).toBe("America/Tegucigalpa");
    expect(O.EVENT_SCHEDULE_TEMPLATE).toEqual({
      date: "2026-10-31", registrationOpens: "19:00", registrationCloses: "20:30", preliminaryOpens: "20:30", preliminaryCloses: "21:30", finalWindowSeconds: 300,
    });
  });

  it("converts to exact instants (Honduras is UTC−6 all year) for the cutoff, the opening and the deadline", () => {
    expect(O.templateInstants()).toEqual({
      registrationOpensAt: "2026-11-01T01:00:00.000Z",
      contestantCutoffAt: "2026-11-01T02:30:00.000Z",
      votingOpensAt: "2026-11-01T02:30:00.000Z",
      votingClosesAt: "2026-11-01T03:30:00.000Z",
    });
    expect(O.toEventInstant("2026-10-31", "21:30")).toBe("2026-11-01T03:30:00.000Z");
    expect(O.toEventInstant("2026-10-31", "00:00")).toBe("2026-10-31T06:00:00.000Z");
  });

  it("reads an instant back as the event's own date and time, whatever the device's time zone", () => {
    expect(O.fromEventInstant("2026-11-01T03:30:00.000Z")).toEqual({ date: "2026-10-31", time: "21:30" });
    expect(O.fromEventInstant("2026-11-01T01:00:00.000Z")).toEqual({ date: "2026-10-31", time: "19:00" });
    expect(O.fromEventInstant(null)).toBeNull();
    expect(O.fromEventInstant("not a date")).toBeNull();
  });

  it("refuses an invalid date or time", () => {
    for (const [d, t] of [["", "20:30"], ["2026-13-01", "20:30"], ["2026-10-31", "25:00"], ["2026-10-31", "7pm"], ["31/10/2026", "20:30"]]) expect(O.toEventInstant(d, t), `${d} ${t}`).toBeNull();
  });

  it("is data and pure functions only: loading it makes no request, reads no environment, creates and opens nothing", () => {
    const src = stripComments(read("public/communityVotingRoundOperator.js"));
    const templateStart = src.indexOf("EVENT_SCHEDULE_TEMPLATE");
    expect(templateStart).toBeGreaterThan(-1);
    expect(src.slice(templateStart, templateStart + 600)).not.toMatch(/fetch|XMLHttpRequest|process\.env|localStorage/);
  });
});

describe("what a visitor is told about the time", () => {
  const R = load<RoundLogic>("communityVotingRound.js", "CommunityVotingRound");

  it("shows times in the event's zone, not the device's", () => {
    expect(R.EVENT_TIME_ZONE).toBe("America/Tegucigalpa");
    expect(R.formatEventTime("2026-11-01T02:30:00.000Z")).toMatch(/20:30/);
    expect(R.formatEventTime("2026-11-01T03:30:00.000Z")).toMatch(/21:30/);
    expect(R.formatEventTime(null)).toBe("");
  });

  it("distinguishes a round that is SCHEDULED from one that is actually OPEN", () => {
    const scheduled = R.phaseNotice({ phase: "NOT_OPEN", roundRole: "PRELIMINARY", scheduledOpensAt: "2026-11-01T02:30:00.000Z", deadlineAt: "2026-11-01T03:30:00.000Z" });
    expect(scheduled).toMatch(/programada/i);
    expect(scheduled).toMatch(/20:30/);
    expect(scheduled).toMatch(/aún no está abierta|todavía no está abierta|no ha abierto/i);
    const open = R.phaseNotice({ phase: "OPEN", roundRole: "PRELIMINARY", deadlineAt: "2026-11-01T03:30:00.000Z" });
    expect(open).toMatch(/abierta/i);
    expect(open).toMatch(/21:30/);
    expect(open).not.toMatch(/programada/i);
  });

  it("shows the remaining time from the server's clock for BOTH rounds", () => {
    expect(R.deadlineRemainingText({ deadlineRemainingMs: 90_000 })).toBe("1:30");
    expect(R.deadlineRemainingText({ deadlineRemainingMs: 0 })).toBe("0:00");
    expect(R.deadlineRemainingText({ deadlineRemainingMs: null })).toBeNull();
  });
});

describe("the phase a screen shows follows the server's deadline", () => {
  const base = { sessionState: "LOBBY_LOCKED", interactionState: "PROMPT_ACTIVE", closed: false, deadlineAt: null as string | null, serverNow: "2026-11-01T03:00:00.000Z" };

  it("is OPEN until the deadline on the SERVER's clock, for the preliminary too, and CLOSED from the deadline on", () => {
    expect(deriveRoundPhase({ ...base, deadlineAt: "2026-11-01T03:30:00.000Z" })).toBe("OPEN");
    expect(deriveRoundPhase({ ...base, deadlineAt: "2026-11-01T03:00:00.000Z" })).toBe("CLOSED");
    expect(deriveRoundPhase({ ...base, deadlineAt: "2026-11-01T02:59:59.000Z" })).toBe("CLOSED");
  });

  it("is NOT_OPEN before an explicit opening however near the scheduled time is", () => {
    expect(deriveRoundPhase({ ...base, interactionState: null, deadlineAt: "2026-11-01T03:30:00.000Z" })).toBe("NOT_OPEN");
  });

  it("measures the remaining time against the server's clock and never below zero", () => {
    expect(deadlineRemainingMs({ deadlineAt: "2026-11-01T03:30:00.000Z", serverNow: base.serverNow })).toBe(1_800_000);
    expect(deadlineRemainingMs({ deadlineAt: "2026-11-01T02:00:00.000Z", serverNow: base.serverNow })).toBe(0);
    expect(deadlineRemainingMs({ deadlineAt: null, serverNow: base.serverNow })).toBeNull();
  });
});
