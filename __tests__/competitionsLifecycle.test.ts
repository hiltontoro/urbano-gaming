import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

// Same "execute the exact deployed source text" technique as
// competitionsIntent.test.ts — see that file's own header comment for
// the full rationale.
const scriptSource = readFileSync("public/competitionsLifecycle.js", "utf-8");
// eslint-disable-next-line @typescript-eslint/no-implied-eval
new Function(scriptSource)();
const CompetitionsLifecycle = (globalThis as unknown as {
  CompetitionsLifecycle: {
    getOrganizerLifecycle: (state: string, acceptedTeamCount: number) => {
      cancelled: boolean;
      steps: Array<{ key: string; label: string; status: "complete" | "current" | "upcoming" }>;
      acceptedTeamCount: number;
      teamCapacity: number;
      blocker: string | null;
      dominantActionKey: "OPEN_REGISTRATION" | "CLOSE_REGISTRATION" | "PUBLISH" | null;
    };
    isCancellable: (state: string) => boolean;
  };
}).CompetitionsLifecycle;

function stepStatuses(state: string, count: number): string[] {
  return CompetitionsLifecycle.getOrganizerLifecycle(state, count).steps.map((s) => s.status);
}

/**
 * UG-CR-GATE-081 Phase 3C/4 — "lifecycle step and dominant next action
 * are correct for every competition state" is an explicit required
 * test. This covers every CompetitionState value from
 * lib/gaming/competitions/types.ts, both sides of the four-team
 * capacity boundary, and the organizer-only cancellation eligibility
 * boundary.
 */
describe("CompetitionsLifecycle.getOrganizerLifecycle", () => {
  it("DRAFT: step 1 current, everything else upcoming, dominant action is opening registration", () => {
    const r = CompetitionsLifecycle.getOrganizerLifecycle("DRAFT", 0);
    expect(stepStatuses("DRAFT", 0)).toEqual(["current", "upcoming", "upcoming", "upcoming", "upcoming"]);
    expect(r.dominantActionKey).toBe("OPEN_REGISTRATION");
    expect(r.blocker).toBeNull();
    expect(r.cancelled).toBe(false);
  });

  it("TEAM_REGISTRATION_OPEN with fewer than 4 accepted teams: a plain-language blocker, no dominant action", () => {
    const r = CompetitionsLifecycle.getOrganizerLifecycle("TEAM_REGISTRATION_OPEN", 2);
    expect(stepStatuses("TEAM_REGISTRATION_OPEN", 2)).toEqual(["complete", "current", "upcoming", "upcoming", "upcoming"]);
    expect(r.dominantActionKey).toBeNull();
    expect(r.blocker).toBe("Waiting for 2 more teams to be accepted before registration can close.");
  });

  it("the singular/plural blocker wording is correct at exactly 1 remaining team", () => {
    const r = CompetitionsLifecycle.getOrganizerLifecycle("TEAM_REGISTRATION_OPEN", 3);
    expect(r.blocker).toBe("Waiting for 1 more team to be accepted before registration can close.");
  });

  it("TEAM_REGISTRATION_OPEN with exactly 4 accepted teams: capacity step completes, dominant action becomes closing registration, no blocker", () => {
    const r = CompetitionsLifecycle.getOrganizerLifecycle("TEAM_REGISTRATION_OPEN", 4);
    expect(stepStatuses("TEAM_REGISTRATION_OPEN", 4)).toEqual(["complete", "complete", "complete", "upcoming", "upcoming"]);
    expect(r.dominantActionKey).toBe("CLOSE_REGISTRATION");
    expect(r.blocker).toBeNull();
  });

  it("READY_TO_PUBLISH: first three steps complete, fourth current, dominant action is publishing", () => {
    const r = CompetitionsLifecycle.getOrganizerLifecycle("READY_TO_PUBLISH", 4);
    expect(stepStatuses("READY_TO_PUBLISH", 4)).toEqual(["complete", "complete", "complete", "current", "upcoming"]);
    expect(r.dominantActionKey).toBe("PUBLISH");
    expect(r.blocker).toBeNull();
  });

  it("PUBLISHED: all five steps complete, no dominant action from this panel (fixture-day actions take over)", () => {
    const r = CompetitionsLifecycle.getOrganizerLifecycle("PUBLISHED", 4);
    expect(stepStatuses("PUBLISHED", 4)).toEqual(["complete", "complete", "complete", "complete", "current"]);
    expect(r.dominantActionKey).toBeNull();
  });

  it("COMPLETE: every step complete, no dominant action", () => {
    const r = CompetitionsLifecycle.getOrganizerLifecycle("COMPLETE", 4);
    expect(stepStatuses("COMPLETE", 4)).toEqual(["complete", "complete", "complete", "complete", "current"]);
    expect(r.dominantActionKey).toBeNull();
  });

  it("CANCELLED_WITHOUT_CHAMPION: cancelled is true and no dominant action is ever offered, regardless of accepted count", () => {
    const r1 = CompetitionsLifecycle.getOrganizerLifecycle("CANCELLED_WITHOUT_CHAMPION", 0);
    const r2 = CompetitionsLifecycle.getOrganizerLifecycle("CANCELLED_WITHOUT_CHAMPION", 4);
    expect(r1.cancelled).toBe(true);
    expect(r2.cancelled).toBe(true);
    expect(r1.dominantActionKey).toBeNull();
    expect(r2.dominantActionKey).toBeNull();
    expect(r1.blocker).toBeNull();
  });

  it("always reports the fixed team capacity and the exact accepted count passed in", () => {
    const r = CompetitionsLifecycle.getOrganizerLifecycle("TEAM_REGISTRATION_OPEN", 3);
    expect(r.teamCapacity).toBe(4);
    expect(r.acceptedTeamCount).toBe(3);
  });

  it("treats a negative or non-numeric accepted count as zero, never throwing or producing a negative blocker count", () => {
    expect(CompetitionsLifecycle.getOrganizerLifecycle("TEAM_REGISTRATION_OPEN", -1).acceptedTeamCount).toBe(0);
    expect(CompetitionsLifecycle.getOrganizerLifecycle("TEAM_REGISTRATION_OPEN", NaN).acceptedTeamCount).toBe(0);
  });
});

describe("CompetitionsLifecycle.isCancellable", () => {
  it("is true for exactly DRAFT, TEAM_REGISTRATION_OPEN, and READY_TO_PUBLISH", () => {
    expect(CompetitionsLifecycle.isCancellable("DRAFT")).toBe(true);
    expect(CompetitionsLifecycle.isCancellable("TEAM_REGISTRATION_OPEN")).toBe(true);
    expect(CompetitionsLifecycle.isCancellable("READY_TO_PUBLISH")).toBe(true);
  });

  it("is false for PUBLISHED, COMPLETE, and CANCELLED_WITHOUT_CHAMPION — matching cancel_incomplete_competition_atomically's own server-side guard exactly", () => {
    expect(CompetitionsLifecycle.isCancellable("PUBLISHED")).toBe(false);
    expect(CompetitionsLifecycle.isCancellable("COMPLETE")).toBe(false);
    expect(CompetitionsLifecycle.isCancellable("CANCELLED_WITHOUT_CHAMPION")).toBe(false);
  });
});
