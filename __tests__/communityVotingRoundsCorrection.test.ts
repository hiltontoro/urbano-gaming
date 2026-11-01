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

  it("serves the voting API from exactly two route families: the contest's own and the category rounds' — the single-choice `instances/**` write path (UG-IV-GATE-003) is retired", () => {
    const families = readdirSync(path.join(ROOT, "app/api/gaming/community-voting")).sort();
    expect(families).not.toContain("ranked");
    expect(families).not.toContain("instances");
    expect(families.filter((f) => f !== "route.ts")).toEqual(["contests", "rounds"]);
  });

  it("mentions no five-option ballot, telephone possession, messaging provider or Instagram in the contest's code, routes or pages — WhatsApp appears only as the person's own number for a delivery BY HAND", () => {
    const files = [
      ...walk(path.join(ROOT, "lib/gaming/communityVoting/rounds")),
      ...walk(path.join(ROOT, "lib/gaming/communityVoting/contest")),
      ...walk(path.join(ROOT, "app/api/gaming/community-voting")),
      ...["community-voting-round.html", "community-voting-round-operator.html", "community-voting-round-display.html", "communityVotingRound.js", "communityVotingRoundOperator.js"].map((f) => path.join(ROOT, "public", f)),
    ].filter((f) => /\.(ts|js|html)$/.test(f));
    expect(files.length).toBeGreaterThan(40);
    for (const f of files) {
      const code = stripComments(readFileSync(f, "utf8"));
      expect(code, rel(f)).not.toMatch(/ranked|RANK_POINTS|phoneDigest|phone_digest|twilio|\bsms\b|instagram|PUBLIC_PHOTO_RETENTION|removal_due|media-purge|purge/i);
      // no provider, no API, no automatic sending: the only WhatsApp URL is the wa.me link the operator opens themself, and nothing is posted to one
      expect(code, rel(f)).not.toMatch(/api\.whatsapp|graph\.facebook|whatsapp-web|WhatsApp Business|cloud api|sendMessage|messages\.create/i);
    }
    // the five-option ballot of the retired ranked format has no trace in the code the contest ships
    for (const f of files) expect(stripComments(readFileSync(f, "utf8")), rel(f)).not.toMatch(/community_voting_ballots|ballot_picks|RANKED_TOP_5/);
  });

  it("keeps the GATE-003 foundation's migrations and modules (committed history stays); only its HTTP write path is gone", () => {
    for (const f of [
      "supabase/migrations/20261020190000_create_community_voting_instances.sql",
      "supabase/migrations/20261020190100_create_community_voting_functions.sql",
      "supabase/migrations/20261020190200_guard_ordinary_join_for_community_voting.sql",
      "supabase/migrations/20261020190300_guard_event_bound_opening_and_ballot.sql",
      "lib/gaming/communityVoting/verifiedIdentity.ts",
      "lib/gaming/communityVoting/db/supabaseCommunityVotingRepository.ts",
    ]) expect(exists(f), f).toBe(true);
    expect(exists("app/api/gaming/community-voting/instances")).toBe(false);
  });

  it("has exactly thirteen Community Voting migrations, including explicit registration and operator workspaces — additive, none ranked, no historical file edited", () => {
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
      "20261031120000_community_voting_four_category_foundation.sql",
      "20261031120100_community_voting_four_category_functions.sql",
      "20261031120200_community_voting_four_category_guards.sql",
      "20261031120300_community_voting_self_registration.sql",
      "20261031234948_community_voting_operator_workspaces.sql",
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

// (the initial two-round schedule and the old page texts were retired by UG-IV-GATE-018: the four-category plan's times and words are pinned in communityVotingContestUiLogic.test.ts)

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
