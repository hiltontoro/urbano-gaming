import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";

// Mocks the ONE module boundary between an app/api/gaming/host/* route and
// the outside world (credentials, repository construction, caller identity).
// The readiness gate and the error-to-status mapping keep their REAL
// implementation (importActual) — they are pure Become a Host logic worth
// exercising for real, and the gate is exactly the production guard each real
// route handler must be proven to run first.
vi.mock("@/lib/gaming/host/httpAuth", async () => {
  const actual = await vi.importActual<typeof import("../lib/gaming/host/httpAuth")>("../lib/gaming/host/httpAuth");
  return {
    getSupabaseCredentials: vi.fn(),
    buildHostRepo: vi.fn(),
    requireGamingMember: vi.fn(),
    statusForHostError: actual.statusForHostError,
    bodyForHostError: actual.bodyForHostError,
    logHostFailure: actual.logHostFailure,
    requireHostSchemaReady: actual.requireHostSchemaReady,
    isBecomeAHostSchemaReady: actual.isBecomeAHostSchemaReady,
    normalizeBecomeAHostSchemaReady: actual.normalizeBecomeAHostSchemaReady,
  };
});

// supabase-js is replaced for the translation tests at the bottom of this file
// only (a stub client whose rpc() returns a canned response).
const rpcStub = vi.hoisted(() => vi.fn());
const fromStub = vi.hoisted(() => vi.fn());
vi.mock("@supabase/supabase-js", async () => {
  const actual = await vi.importActual<typeof import("@supabase/supabase-js")>("@supabase/supabase-js");
  return { ...actual, createClient: vi.fn(() => ({ rpc: rpcStub, from: (table: string) => fromStub(table) })) };
});

import * as hostTypes from "../lib/gaming/host/types";
import {
  InvalidHostApplicationError,
  InvalidHostCompetitionError,
  InvalidHostDecisionError,
  InvalidHostReviewViewError,
  HostApplicationAlreadyActiveError,
  HostApplicationNotFoundError,
  HostApplicationNotPendingError,
  HostApplicationAlreadyDecidedError,
  HostSelfReviewForbiddenError,
  HostCapabilityNotFoundError,
  HostCapabilityRequiredError,
  HostCapabilityAlreadyConsumedError,
  HostCapabilityRevokedError,
  HostReasonRequiredError,
  HostReviewerAuthorityRequiredError,
} from "../lib/gaming/host/types";
import type { HostApplicationInput } from "../lib/gaming/host/types";
import { validateHostApplication, HOST_APPLICATION_LIMITS } from "../lib/gaming/host/validateHostApplication";
import { InMemoryHostRepository } from "../lib/gaming/host/db/inMemoryHostRepository";
import { SupabaseHostRepository } from "../lib/gaming/host/db/supabaseHostRepository";
import { SupabaseCompetitionsRepository } from "../lib/gaming/competitions/db/supabaseCompetitionsRepository";
import { submitHostApplication } from "../lib/gaming/host/submitHostApplication";
import { withdrawHostApplication } from "../lib/gaming/host/withdrawHostApplication";
import { getHostStatus, phaseOf } from "../lib/gaming/host/getHostStatus";
import { decideHostApplication } from "../lib/gaming/host/decideHostApplication";
import { revokeHostCapability } from "../lib/gaming/host/revokeHostCapability";
import { listHostApplicationsForReview } from "../lib/gaming/host/listHostApplicationsForReview";
import { createHostCompetition } from "../lib/gaming/host/createHostCompetition";
import { isWellFormedPublicCode } from "../lib/gaming/host/publicCodeShape";
import { cleanReason } from "../lib/gaming/host/cleanReason";
import {
  statusForHostError,
  bodyForHostError,
  normalizeBecomeAHostSchemaReady,
  isBecomeAHostSchemaReady,
  requireHostSchemaReady,
} from "../lib/gaming/host/httpAuth";
import { isActiveOrganizer, isListedFor, toPublicCompetition } from "../lib/gaming/competitions/organizerAccess";
import { getCompetitionView } from "../lib/gaming/competitions/getCompetitionView";
import type { CompetitionsRepository } from "../lib/gaming/competitions/db/competitionsRepository";
import type { CompetitionRecord, CompetitionTeamRecord } from "../lib/gaming/competitions/types";

/**
 * UG-CR-GATE-088 — Become a Host, in-memory behavioral suite. Real Postgres
 * proof (RLS, grants, concurrency, the organizer-function guards) lives in
 * hostApplicationsSupabase.contract.test.ts; this file proves the command
 * layer, the route boundary and the browser-visible contracts without
 * credentials.
 */

const VALID_INPUT: HostApplicationInput = {
  venueName: "Riverside Five-a-Side",
  cityArea: "Riverside District",
  playingFields: 3,
  venueDescription: "We run two small leagues at our venue each season and host a charity cup every spring.",
  expectedWindow: "weekend of 14 November",
  expectedTeamCount: 6,
  confirmAllAdults: true,
  confirmIndependentScorekeepers: true,
  confirmPilotExclusions: true,
};

const UUID_PATTERN = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;

function seeded() {
  const repo = new InMemoryHostRepository();
  repo.seedMember("applicant", "Alex Applicant");
  repo.seedMember("applicant-2", "Sam Second");
  repo.seedMember("reviewer", "Riley Reviewer");
  repo.seedGovernance("reviewer");
  return repo;
}

async function submitAndGetCode(repo: InMemoryHostRepository, member = "applicant"): Promise<string> {
  const result = await submitHostApplication(repo, member, VALID_INPUT);
  return result.publicCode;
}

describe("validateHostApplication — what the application collects, and nothing else", () => {
  it("accepts a valid submission and returns exactly the collected fields, trimmed", () => {
    const result = validateHostApplication({ ...VALID_INPUT, venueName: "  Riverside Five-a-Side  " });
    expect(result.venueName).toBe("Riverside Five-a-Side");
    expect(Object.keys(result).sort()).toEqual(
      [
        "cityArea",
        "confirmAllAdults",
        "confirmIndependentScorekeepers",
        "confirmPilotExclusions",
        "expectedTeamCount",
        "expectedWindow",
        "playingFields",
        "venueDescription",
        "venueName",
      ].sort()
    );
  });

  it("drops every unknown field — identity, status, reviewer and timestamp fields included — so none can reach the repository", () => {
    const result = validateHostApplication({
      ...VALID_INPUT,
      gamingMemberId: "attacker",
      state: "APPROVED",
      decidedBy: "attacker",
      submittedAt: "1999-01-01T00:00:00Z",
      governance: true,
      email: "someone@example.com",
      phone: "555-0100",
    });
    expect(JSON.stringify(result)).not.toMatch(/attacker|APPROVED|someone@example|555-0100|1999/);
  });

  const BOUNDARIES: Array<[keyof typeof HOST_APPLICATION_LIMITS, string | number, string | number, string | number, string | number]> = [
    ["venueName", "a", "ab", "a".repeat(80), "a".repeat(81)],
    ["cityArea", "a", "ab", "a".repeat(80), "a".repeat(81)],
    ["venueDescription", "x".repeat(19), "x".repeat(20), "x".repeat(800), "x".repeat(801)],
    ["expectedWindow", "ab", "abc", "w".repeat(100), "w".repeat(101)],
    ["playingFields", 0, 1, 50, 51],
    ["expectedTeamCount", 3, 4, 16, 17],
  ];
  for (const [field, belowMin, atMin, atMax, aboveMax] of BOUNDARIES) {
    it(`${field}: rejects just below the minimum and just above the maximum, accepts both bounds`, () => {
      expect(() => validateHostApplication({ ...VALID_INPUT, [field]: belowMin })).toThrow(InvalidHostApplicationError);
      expect(() => validateHostApplication({ ...VALID_INPUT, [field]: aboveMax })).toThrow(InvalidHostApplicationError);
      expect(() => validateHostApplication({ ...VALID_INPUT, [field]: atMin })).not.toThrow();
      expect(() => validateHostApplication({ ...VALID_INPUT, [field]: atMax })).not.toThrow();
      try {
        validateHostApplication({ ...VALID_INPUT, [field]: belowMin });
      } catch (err) {
        expect((err as InvalidHostApplicationError).field).toBe(field);
      }
    });
  }

  it("rejects wrong types: numeric strings, fractions, NaN, booleans, null and arrays are never coerced", () => {
    for (const bad of ["4", 4.5, Number.NaN, true, null, [4], undefined]) {
      expect(() => validateHostApplication({ ...VALID_INPUT, expectedTeamCount: bad })).toThrow(InvalidHostApplicationError);
      expect(() => validateHostApplication({ ...VALID_INPUT, playingFields: bad })).toThrow(InvalidHostApplicationError);
    }
    for (const bad of [42, null, ["Riverside"], { a: 1 }, undefined]) {
      expect(() => validateHostApplication({ ...VALID_INPUT, venueName: bad })).toThrow(InvalidHostApplicationError);
    }
  });

  it("rejects a non-object body", () => {
    for (const bad of [null, undefined, "string", 5, [], [VALID_INPUT]]) {
      expect(() => validateHostApplication(bad)).toThrow(InvalidHostApplicationError);
    }
  });

  it("requires all three confirmations to be exactly true (a truthy string or number is not enough)", () => {
    for (const key of ["confirmAllAdults", "confirmIndependentScorekeepers", "confirmPilotExclusions"] as const) {
      for (const bad of [false, undefined, "true", 1, null]) {
        try {
          validateHostApplication({ ...VALID_INPUT, [key]: bad });
          throw new Error("expected the confirmation to be rejected");
        } catch (err) {
          expect(err).toBeInstanceOf(InvalidHostApplicationError);
          expect((err as InvalidHostApplicationError).field).toBe("confirmations");
        }
      }
    }
  });

  it("rejects a NUL byte and other control characters (which Postgres cannot store) with a field error, never a 500", () => {
    for (const field of ["venueName", "cityArea", "expectedWindow"] as const) {
      expect(() => validateHostApplication({ ...VALID_INPUT, [field]: "ok\u0000ok" })).toThrow(InvalidHostApplicationError);
      expect(() => validateHostApplication({ ...VALID_INPUT, [field]: "line one\nline two" })).toThrow(InvalidHostApplicationError);
    }
    expect(() => validateHostApplication({ ...VALID_INPUT, venueDescription: "x".repeat(25) + "\u0000" })).toThrow(InvalidHostApplicationError);
    expect(() => validateHostApplication({ ...VALID_INPUT, venueDescription: "x".repeat(25) + "\u001b[31m" })).toThrow(InvalidHostApplicationError);
  });

  it("keeps line breaks in the multi-line description", () => {
    const description = "First paragraph about the venue.\n\nSecond paragraph about tournaments we have run.";
    expect(validateHostApplication({ ...VALID_INPUT, venueDescription: description }).venueDescription).toBe(description);
  });

  it("accepts hostile markup and quotes as ordinary text — it is stored literally and only ever rendered through textContent", () => {
    const hostile = '<img src=x onerror="alert(1)"> "quoted" \'single\' \\ back; DROP TABLE x; --';
    const result = validateHostApplication({ ...VALID_INPUT, venueName: hostile.slice(0, 80), venueDescription: hostile + " ".repeat(5) + "padding to reach twenty chars" });
    expect(result.venueName).toBe(hostile.slice(0, 80).trim());
  });
});

describe("the application collects no private contact, identity, financial, roster or medical data", () => {
  it("has no such field in the input type, the validator, the status record or the review record", () => {
    const source = readFileSync(path.join(process.cwd(), "lib/gaming/host/types.ts"), "utf8");
    const validator = readFileSync(path.join(process.cwd(), "lib/gaming/host/validateHostApplication.ts"), "utf8");
    for (const forbidden of [/\bemail\b/i, /\bphone\b/i, /\baddress\b/i, /passport/i, /\bssn\b/i, /national_?id/i, /\bbank/i, /\bcard\b/i, /\broster\b/i, /medical/i, /birth/i, /\btoken\b/i]) {
      expect(source.replace(/\/\*[\s\S]*?\*\//g, "")).not.toMatch(forbidden);
      expect(validator.replace(/\/\*[\s\S]*?\*\//g, "")).not.toMatch(forbidden);
    }
  });
});

describe("submitHostApplication — one live application per member (tests 2, 3)", () => {
  it("an authenticated member submits one valid application and it is PENDING", async () => {
    const repo = seeded();
    const result = await submitHostApplication(repo, "applicant", VALID_INPUT);
    expect(result.state).toBe("PENDING");
    expect(isWellFormedPublicCode(result.publicCode)).toBe(true);
    const status = await getHostStatus(repo, "applicant");
    expect(status.phase).toBe("UNDER_REVIEW");
    expect(status.application?.publicCode).toBe(result.publicCode);
  });

  it("a duplicate while one is pending is truthfully refused and nothing is duplicated", async () => {
    const repo = seeded();
    await submitHostApplication(repo, "applicant", VALID_INPUT);
    await expect(submitHostApplication(repo, "applicant", VALID_INPUT)).rejects.toBeInstanceOf(HostApplicationAlreadyActiveError);
    expect(repo.applicationCount()).toBe(1);
  });

  it("a duplicate while one is APPROVED is also refused", async () => {
    const repo = seeded();
    const code = await submitAndGetCode(repo);
    await decideHostApplication(repo, "reviewer", code, "APPROVE", null);
    await expect(submitHostApplication(repo, "applicant", VALID_INPUT)).rejects.toBeInstanceOf(HostApplicationAlreadyActiveError);
  });

  it("two simultaneous submissions yield exactly one application", async () => {
    const repo = seeded();
    const settled = await Promise.allSettled([
      submitHostApplication(repo, "applicant", VALID_INPUT),
      submitHostApplication(repo, "applicant", VALID_INPUT),
    ]);
    expect(settled.filter((s) => s.status === "fulfilled")).toHaveLength(1);
    expect(repo.applicationCount()).toBe(1);
  });

  it("after a rejection or a withdrawal the member may apply again, and history is kept", async () => {
    const repo = seeded();
    const first = await submitAndGetCode(repo);
    await decideHostApplication(repo, "reviewer", first, "REJECT", "Not a fit for the pilot.");
    const second = await submitAndGetCode(repo);
    await withdrawHostApplication(repo, "applicant", second);
    const third = await submitAndGetCode(repo);
    expect(new Set([first, second, third]).size).toBe(3);
    expect(repo.applicationCount()).toBe(3);
  });

  it("an invalid submission is rejected by the command before the repository is called", async () => {
    const repo = seeded();
    const spy = vi.spyOn(repo, "submitApplication");
    await expect(submitHostApplication(repo, "applicant", { ...VALID_INPUT, playingFields: 0 })).rejects.toBeInstanceOf(InvalidHostApplicationError);
    expect(spy).not.toHaveBeenCalled();
  });
});

describe("an applicant sees only their own application, and cannot touch anyone else's (tests 4, 5)", () => {
  it("getHostStatus is keyed on the verified caller: another member's application never appears", async () => {
    const repo = seeded();
    await submitHostApplication(repo, "applicant", VALID_INPUT);
    expect((await getHostStatus(repo, "applicant-2")).phase).toBe("NOT_APPLIED");
    expect((await getHostStatus(repo, "applicant-2")).application).toBeNull();
  });

  it("another member cannot withdraw it, and cannot tell it exists", async () => {
    const repo = seeded();
    const code = await submitAndGetCode(repo);
    await expect(withdrawHostApplication(repo, "applicant-2", code)).rejects.toBeInstanceOf(HostApplicationNotFoundError);
    await expect(withdrawHostApplication(repo, "applicant-2", "A".repeat(22))).rejects.toBeInstanceOf(HostApplicationNotFoundError);
    expect((await getHostStatus(repo, "applicant")).phase).toBe("UNDER_REVIEW");
  });

  it("the applicant's own view never carries the internal decision reason, any member id, or any reviewer name", async () => {
    const repo = seeded();
    const code = await submitAndGetCode(repo);
    await decideHostApplication(repo, "reviewer", code, "REJECT", "Internal note: venue too small");
    const status = await getHostStatus(repo, "applicant");
    const json = JSON.stringify(status);
    expect(status.phase).toBe("NOT_APPROVED");
    expect(json).not.toMatch(/Internal note|venue too small|Riley|reviewer/i);
    expect(Object.keys(status.application ?? {})).not.toContain("decisionReason");
    expect(json).not.toMatch(UUID_PATTERN);
  });

  it("a member cannot approve or reject — not their own application and not anyone else's", async () => {
    const repo = seeded();
    const code = await submitAndGetCode(repo);
    await expect(decideHostApplication(repo, "applicant", code, "APPROVE", null)).rejects.toBeInstanceOf(HostReviewerAuthorityRequiredError);
    await expect(decideHostApplication(repo, "applicant-2", code, "REJECT", "no")).rejects.toBeInstanceOf(HostReviewerAuthorityRequiredError);
    expect((await getHostStatus(repo, "applicant")).phase).toBe("UNDER_REVIEW");
  });

  it("a request body cannot supply who the applicant is, the state, or the reviewer", async () => {
    const repo = seeded();
    await submitHostApplication(repo, "applicant", { ...VALID_INPUT, gamingMemberId: "applicant-2", state: "APPROVED", decidedBy: "reviewer" } as unknown as HostApplicationInput);
    expect((await getHostStatus(repo, "applicant")).phase).toBe("UNDER_REVIEW");
    expect((await getHostStatus(repo, "applicant-2")).phase).toBe("NOT_APPLIED");
  });
});

describe("the internal review surface is governance-only (tests 6, 7, 8)", () => {
  it("a non-governance member cannot list, approve, reject, or revoke", async () => {
    const repo = seeded();
    const code = await submitAndGetCode(repo);
    await expect(listHostApplicationsForReview(repo, "applicant-2", "PENDING")).rejects.toBeInstanceOf(HostReviewerAuthorityRequiredError);
    await expect(listHostApplicationsForReview(repo, "applicant", "HISTORY")).rejects.toBeInstanceOf(HostReviewerAuthorityRequiredError);
    await expect(decideHostApplication(repo, "applicant-2", code, "APPROVE", null)).rejects.toBeInstanceOf(HostReviewerAuthorityRequiredError);
    await expect(revokeHostCapability(repo, "applicant-2", code, "reason")).rejects.toBeInstanceOf(HostReviewerAuthorityRequiredError);
  });

  it("a governance reviewer lists pending applications by NAME and application text, never by identifier", async () => {
    const repo = seeded();
    await submitHostApplication(repo, "applicant", VALID_INPUT);
    const list = await listHostApplicationsForReview(repo, "reviewer", "PENDING");
    expect(list).toHaveLength(1);
    expect(list[0].applicantDisplayName).toBe("Alex Applicant");
    expect(list[0].venueName).toBe(VALID_INPUT.venueName);
    expect(JSON.stringify(list)).not.toMatch(UUID_PATTERN);
    expect(JSON.stringify(list)).not.toMatch(/"(gamingMemberId|memberId|applicationId|hostApplicationId)"/);
  });

  it("the three review views partition applications: PENDING, ACTIVE (live hosts, uncapped) and HISTORY (rejected or revoked); withdrawn rows are in none of them", async () => {
    const repo = seeded();
    repo.seedMember("applicant-3", "Third Person");
    repo.seedMember("applicant-4", "Fourth Person");
    const pending = await submitAndGetCode(repo, "applicant");
    const live = await submitAndGetCode(repo, "applicant-2");
    await decideHostApplication(repo, "reviewer", live, "APPROVE", null);
    await createHostCompetition(repo, "applicant-2", "A Live Pilot");
    const rejected = await submitAndGetCode(repo, "applicant-3");
    await decideHostApplication(repo, "reviewer", rejected, "REJECT", "Not this time.");
    const withdrawn = await submitAndGetCode(repo, "applicant-4");
    await withdrawHostApplication(repo, "applicant-4", withdrawn);
    const codes = async (view: string) => (await listHostApplicationsForReview(repo, "reviewer", view)).map((r) => r.publicCode).sort();

    expect(await codes("PENDING")).toEqual([pending]);
    expect(await codes("ACTIVE")).toEqual([live]);
    expect(await codes("HISTORY")).toEqual([rejected]);
    for (const view of ["PENDING", "ACTIVE", "HISTORY"]) expect(await codes(view)).not.toContain(withdrawn);

    // Revoking moves a live host out of ACTIVE and into HISTORY: revocation itself is never a dead end.
    await revokeHostCapability(repo, "reviewer", live, "Rules were not followed.");
    expect(await codes("ACTIVE")).toEqual([]);
    expect(await codes("HISTORY")).toEqual([live, rejected].sort());
  });

  it("an approved host whose pilot has not been created yet is ACTIVE (revocable before use) too", async () => {
    const repo = seeded();
    const code = await submitAndGetCode(repo);
    await decideHostApplication(repo, "reviewer", code, "APPROVE", null);
    expect((await listHostApplicationsForReview(repo, "reviewer", "ACTIVE")).map((r) => r.publicCode)).toEqual([code]);
  });

  it("rejects an unknown review view and an unknown decision", async () => {
    const repo = seeded();
    await expect(listHostApplicationsForReview(repo, "reviewer", "ALL")).rejects.toBeInstanceOf(InvalidHostReviewViewError);
    const code = await submitAndGetCode(repo);
    await expect(decideHostApplication(repo, "reviewer", code, "MAYBE", null)).rejects.toBeInstanceOf(InvalidHostDecisionError);
    await expect(decideHostApplication(repo, "reviewer", code, undefined, null)).rejects.toBeInstanceOf(InvalidHostDecisionError);
  });

  it("a malformed application code is treated as not found without reaching the repository", async () => {
    const repo = seeded();
    const spy = vi.spyOn(repo, "decideApplication");
    for (const bad of ["short", "x".repeat(23), "not a code!!!!!!!!!!!!", 42, null, undefined, "../../etc/passwd"]) {
      await expect(decideHostApplication(repo, "reviewer", bad, "APPROVE", null)).rejects.toBeInstanceOf(HostApplicationNotFoundError);
    }
    expect(spy).not.toHaveBeenCalled();
  });

  it("rejection requires a reason: missing, empty and whitespace-only are all refused and change nothing", async () => {
    const repo = seeded();
    const code = await submitAndGetCode(repo);
    for (const bad of [undefined, null, "", "   ", "\n\t", "\u0000\u0001"]) {
      await expect(decideHostApplication(repo, "reviewer", code, "REJECT", bad)).rejects.toBeInstanceOf(HostReasonRequiredError);
    }
    expect((await getHostStatus(repo, "applicant")).phase).toBe("UNDER_REVIEW");
  });

  it("an approval records actor and timestamp, and exactly one audit event", async () => {
    const repo = seeded();
    const code = await submitAndGetCode(repo);
    const result = await decideHostApplication(repo, "reviewer", code, "APPROVE", null);
    expect(result).toMatchObject({ state: "APPROVED", capabilityState: "AVAILABLE", alreadyDecided: false });
    const events = repo.auditEvents.filter((e) => e.actionType === "HOST_APPLICATION_APPROVED");
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ actorMemberId: "reviewer", authorityClassUsed: "PRODUCT_GOVERNANCE", outcome: "SUCCESS" });
    expect(Number.isNaN(Date.parse(events[0].occurredAt))).toBe(false);
  });

  it("a reviewer may not decide their own application", async () => {
    const repo = seeded();
    const code = await submitAndGetCode(repo, "reviewer");
    await expect(decideHostApplication(repo, "reviewer", code, "APPROVE", null)).rejects.toBeInstanceOf(HostSelfReviewForbiddenError);
    expect(repo.capabilityCount()).toBe(0);
  });

  it("an unknown application code is not found", async () => {
    const repo = seeded();
    await expect(decideHostApplication(repo, "reviewer", "Z".repeat(22), "APPROVE", null)).rejects.toBeInstanceOf(HostApplicationNotFoundError);
  });
});

describe("decisions are single and replay-safe (tests 7, 9, 10)", () => {
  it("approval creates exactly one unused capability; a replayed approval creates nothing and logs nothing new", async () => {
    const repo = seeded();
    const code = await submitAndGetCode(repo);
    await decideHostApplication(repo, "reviewer", code, "APPROVE", null);
    const replay = await decideHostApplication(repo, "reviewer", code, "APPROVE", null);
    expect(replay).toMatchObject({ state: "APPROVED", alreadyDecided: true });
    expect(repo.capabilityCount()).toBe(1);
    expect(repo.capabilityStateFor("applicant")).toBe("AVAILABLE");
    expect(repo.auditEvents.filter((e) => e.actionType === "HOST_APPLICATION_APPROVED")).toHaveLength(1);
  });

  it("the opposite decision after a terminal one is refused", async () => {
    const repo = seeded();
    const approved = await submitAndGetCode(repo);
    await decideHostApplication(repo, "reviewer", approved, "APPROVE", null);
    await expect(decideHostApplication(repo, "reviewer", approved, "REJECT", "changed my mind")).rejects.toBeInstanceOf(HostApplicationAlreadyDecidedError);

    const rejected = await submitAndGetCode(repo, "applicant-2");
    await decideHostApplication(repo, "reviewer", rejected, "REJECT", "Not this time.");
    await expect(decideHostApplication(repo, "reviewer", rejected, "APPROVE", null)).rejects.toBeInstanceOf(HostApplicationAlreadyDecidedError);
    expect(repo.capabilityCount()).toBe(1);
  });

  it("a rejection replay is idempotent and leaves exactly one rejection event", async () => {
    const repo = seeded();
    const code = await submitAndGetCode(repo);
    await decideHostApplication(repo, "reviewer", code, "REJECT", "Not this time.");
    const replay = await decideHostApplication(repo, "reviewer", code, "REJECT", "Not this time.");
    expect(replay.alreadyDecided).toBe(true);
    expect(repo.auditEvents.filter((e) => e.actionType === "HOST_APPLICATION_REJECTED")).toHaveLength(1);
  });

  it("an approval and a rejection racing each other yield exactly one terminal outcome and a consistent capability", async () => {
    for (let i = 0; i < 20; i++) {
      const repo = seeded();
      const code = await submitAndGetCode(repo);
      const settled = await Promise.allSettled([
        decideHostApplication(repo, "reviewer", code, "APPROVE", null),
        decideHostApplication(repo, "reviewer", code, "REJECT", "racing"),
      ]);
      expect(settled.filter((s) => s.status === "fulfilled")).toHaveLength(1);
      const phase = (await getHostStatus(repo, "applicant")).phase;
      if (phase === "APPROVED_READY") expect(repo.capabilityCount()).toBe(1);
      else {
        expect(phase).toBe("NOT_APPROVED");
        expect(repo.capabilityCount()).toBe(0);
      }
      const decisions = repo.auditEvents.filter((e) => e.actionType === "HOST_APPLICATION_APPROVED" || e.actionType === "HOST_APPLICATION_REJECTED");
      expect(decisions).toHaveLength(1);
    }
  });

  it("an approval and a withdrawal racing each other also yield one terminal outcome", async () => {
    for (let i = 0; i < 20; i++) {
      const repo = seeded();
      const code = await submitAndGetCode(repo);
      const settled = await Promise.allSettled([
        decideHostApplication(repo, "reviewer", code, "APPROVE", null),
        withdrawHostApplication(repo, "applicant", code),
      ]);
      expect(settled.filter((s) => s.status === "fulfilled")).toHaveLength(1);
      const phase = (await getHostStatus(repo, "applicant")).phase;
      expect(["APPROVED_READY", "WITHDRAWN"]).toContain(phase);
      expect(repo.capabilityCount()).toBe(phase === "APPROVED_READY" ? 1 : 0);
    }
  });
});

describe("withdrawal", () => {
  it("withdraws only a pending application, is idempotent, and is audited once", async () => {
    const repo = seeded();
    const code = await submitAndGetCode(repo);
    expect(await withdrawHostApplication(repo, "applicant", code)).toMatchObject({ state: "WITHDRAWN", alreadyWithdrawn: false });
    expect(await withdrawHostApplication(repo, "applicant", code)).toMatchObject({ state: "WITHDRAWN", alreadyWithdrawn: true });
    expect(repo.auditEvents.filter((e) => e.actionType === "HOST_APPLICATION_WITHDRAWN")).toHaveLength(1);
    expect((await getHostStatus(repo, "applicant")).phase).toBe("WITHDRAWN");
  });

  it("cannot withdraw an approved or rejected application", async () => {
    const repo = seeded();
    const approved = await submitAndGetCode(repo);
    await decideHostApplication(repo, "reviewer", approved, "APPROVE", null);
    await expect(withdrawHostApplication(repo, "applicant", approved)).rejects.toBeInstanceOf(HostApplicationNotPendingError);
    const rejected = await submitAndGetCode(repo, "applicant-2");
    await decideHostApplication(repo, "reviewer", rejected, "REJECT", "No.");
    await expect(withdrawHostApplication(repo, "applicant-2", rejected)).rejects.toBeInstanceOf(HostApplicationNotPendingError);
  });
});

describe("the approved host creates exactly one private pilot (tests 11, 12, 13)", () => {
  async function approvedHost() {
    const repo = seeded();
    const code = await submitAndGetCode(repo);
    await decideHostApplication(repo, "reviewer", code, "APPROVE", null);
    return { repo, code };
  }

  it("creates the competition, consumes the capability, and binds them permanently", async () => {
    const { repo } = await approvedHost();
    const created = await createHostCompetition(repo, "applicant", "  Riverside Pilot Cup  ");
    expect(created.state).toBe("DRAFT");
    expect(repo.competitionCount()).toBe(1);
    expect(repo.capabilityStateFor("applicant")).toBe("CONSUMED");
    const status = await getHostStatus(repo, "applicant");
    expect(status.phase).toBe("PILOT_CREATED");
    expect(status.application?.competitionName).toBe("Riverside Pilot Cup");
    expect(repo.auditEvents.filter((e) => e.actionType === "HOST_CAPABILITY_CONSUMED")).toHaveLength(1);
  });

  it("a second creation is refused and no second competition exists", async () => {
    const { repo } = await approvedHost();
    await createHostCompetition(repo, "applicant", "First Pilot");
    await expect(createHostCompetition(repo, "applicant", "Second Pilot")).rejects.toBeInstanceOf(HostCapabilityAlreadyConsumedError);
    expect(repo.competitionCount()).toBe(1);
  });

  it("concurrent creations yield exactly one competition", async () => {
    for (let i = 0; i < 20; i++) {
      const { repo } = await approvedHost();
      const settled = await Promise.allSettled([
        createHostCompetition(repo, "applicant", "Pilot A"),
        createHostCompetition(repo, "applicant", "Pilot B"),
        createHostCompetition(repo, "applicant", "Pilot C"),
      ]);
      expect(settled.filter((s) => s.status === "fulfilled")).toHaveLength(1);
      expect(repo.competitionCount()).toBe(1);
    }
  });

  it("a failed creation does not consume the capability, so the host may retry", async () => {
    const { repo } = await approvedHost();
    repo.failNextCreation = true;
    await expect(createHostCompetition(repo, "applicant", "Will Fail")).rejects.toThrow("simulated creation failure");
    expect(repo.capabilityStateFor("applicant")).toBe("AVAILABLE");
    expect(repo.competitionCount()).toBe(0);
    await expect(createHostCompetition(repo, "applicant", "Will Work")).resolves.toMatchObject({ state: "DRAFT" });
    expect(repo.competitionCount()).toBe(1);
  });

  it("an invalid name is rejected before anything is consumed", async () => {
    const { repo } = await approvedHost();
    for (const bad of ["", "ab", "x".repeat(81), 5, null, undefined, "bad\u0000name", "two\nlines"]) {
      await expect(createHostCompetition(repo, "applicant", bad)).rejects.toBeInstanceOf(InvalidHostCompetitionError);
    }
    await expect(createHostCompetition(repo, "applicant", "Fine Name", "POKER")).rejects.toBeInstanceOf(InvalidHostCompetitionError);
    expect(repo.capabilityStateFor("applicant")).toBe("AVAILABLE");
  });

  it("is refused without an approved application: never applied, pending, rejected, or withdrawn", async () => {
    const repo = seeded();
    await expect(createHostCompetition(repo, "applicant-2", "No Application")).rejects.toBeInstanceOf(HostCapabilityRequiredError);
    const pending = await submitAndGetCode(repo);
    await expect(createHostCompetition(repo, "applicant", "Still Pending")).rejects.toBeInstanceOf(HostCapabilityRequiredError);
    await decideHostApplication(repo, "reviewer", pending, "REJECT", "No.");
    await expect(createHostCompetition(repo, "applicant", "Rejected")).rejects.toBeInstanceOf(HostCapabilityRequiredError);
    const next = await submitAndGetCode(repo);
    await withdrawHostApplication(repo, "applicant", next);
    await expect(createHostCompetition(repo, "applicant", "Withdrawn")).rejects.toBeInstanceOf(HostCapabilityRequiredError);
    expect(repo.competitionCount()).toBe(0);
  });
});

describe("revocation (test 17) preserves history and blocks the future", () => {
  async function hostWithPilot() {
    const repo = seeded();
    const code = await submitAndGetCode(repo);
    await decideHostApplication(repo, "reviewer", code, "APPROVE", null);
    const created = await createHostCompetition(repo, "applicant", "Riverside Pilot Cup");
    return { repo, code, competitionId: created.competitionId };
  }

  it("revoking an unused capability prevents creation, with a truthful message", async () => {
    const repo = seeded();
    const code = await submitAndGetCode(repo);
    await decideHostApplication(repo, "reviewer", code, "APPROVE", null);
    await revokeHostCapability(repo, "reviewer", code, "Venue could not be verified.");
    await expect(createHostCompetition(repo, "applicant", "Too Late")).rejects.toBeInstanceOf(HostCapabilityRevokedError);
    expect((await getHostStatus(repo, "applicant")).phase).toBe("ACCESS_REVOKED");
  });

  it("revoking a used capability keeps the application, the capability binding, the competition and every audit event", async () => {
    const { repo, code } = await hostWithPilot();
    const auditBefore = repo.auditEvents.length;
    expect(await revokeHostCapability(repo, "reviewer", code, "Rules were not followed.")).toMatchObject({ capabilityState: "REVOKED", alreadyRevoked: false });
    expect(repo.competitionCount()).toBe(1);
    expect(repo.applicationCount()).toBe(1);
    expect(repo.capabilityCount()).toBe(1);
    expect(repo.auditEvents.length).toBe(auditBefore + 1);
    const status = await getHostStatus(repo, "applicant");
    expect(status.phase).toBe("ACCESS_REVOKED");
    expect(status.application?.competitionName).toBe("Riverside Pilot Cup");
  });

  it("organizer access to the competition is refused once revoked", async () => {
    const { repo, code, competitionId } = await hostWithPilot();
    expect(() => repo.assertOrganizerAccess(competitionId)).not.toThrow();
    await revokeHostCapability(repo, "reviewer", code, "Rules were not followed.");
    expect(() => repo.assertOrganizerAccess(competitionId)).toThrow("HOST_ACCESS_REVOKED");
  });

  it("is idempotent, requires a reason, and cannot revoke what was never approved", async () => {
    const { repo, code } = await hostWithPilot();
    await expect(revokeHostCapability(repo, "reviewer", code, "")).rejects.toBeInstanceOf(HostReasonRequiredError);
    await revokeHostCapability(repo, "reviewer", code, "Reason one.");
    expect(await revokeHostCapability(repo, "reviewer", code, "Reason two.")).toMatchObject({ alreadyRevoked: true });
    expect(repo.auditEvents.filter((e) => e.actionType === "HOST_CAPABILITY_REVOKED")).toHaveLength(1);

    const fresh = seeded();
    const pending = await submitAndGetCode(fresh);
    await expect(revokeHostCapability(fresh, "reviewer", pending, "Nothing to revoke.")).rejects.toBeInstanceOf(HostCapabilityNotFoundError);
  });

  it("a revoked host cannot create again, and cannot simply re-apply: revocation is a deliberate act, not a state they can reset", async () => {
    const { repo, code } = await hostWithPilot();
    await revokeHostCapability(repo, "reviewer", code, "Rules were not followed.");
    await expect(createHostCompetition(repo, "applicant", "Another")).rejects.toBeInstanceOf(HostCapabilityRevokedError);
    // The approved application is still the member's live application (history is kept, not reset).
    await expect(submitHostApplication(repo, "applicant", VALID_INPUT)).rejects.toBeInstanceOf(HostApplicationAlreadyActiveError);
    expect(repo.capabilityCount()).toBe(1);
    expect(repo.competitionCount()).toBe(1);
  });
});

describe("audit events are complete (test 19)", () => {
  it("every lifecycle step writes one event with an actor, a target, an outcome and a timestamp", async () => {
    const repo = seeded();
    const code = await submitAndGetCode(repo);
    await decideHostApplication(repo, "reviewer", code, "APPROVE", "Looks good.");
    await createHostCompetition(repo, "applicant", "Riverside Pilot Cup");
    await revokeHostCapability(repo, "reviewer", code, "Rules were not followed.");
    const other = await submitAndGetCode(repo, "applicant-2");
    await withdrawHostApplication(repo, "applicant-2", other);

    expect(repo.auditEvents.map((e) => e.actionType)).toEqual([
      "HOST_APPLICATION_SUBMITTED",
      "HOST_APPLICATION_APPROVED",
      "HOST_CAPABILITY_CONSUMED",
      "HOST_CAPABILITY_REVOKED",
      "HOST_APPLICATION_SUBMITTED",
      "HOST_APPLICATION_WITHDRAWN",
    ]);
    for (const event of repo.auditEvents) {
      expect(event.actorMemberId).toBeTruthy();
      expect(event.targetType).toMatch(/^competition_host_/);
      expect(event.targetId).toBeTruthy();
      expect(event.outcome).toBe("SUCCESS");
      expect(Number.isNaN(Date.parse(event.occurredAt))).toBe(false);
    }
    expect(repo.auditEvents[1].reason).toBe("Looks good.");
    expect(repo.auditEvents[3].reason).toBe("Rules were not followed.");
  });

  it("refused attempts leave no audit event", async () => {
    const repo = seeded();
    const code = await submitAndGetCode(repo);
    const before = repo.auditEvents.length;
    await expect(decideHostApplication(repo, "applicant-2", code, "APPROVE", null)).rejects.toBeDefined();
    await expect(createHostCompetition(repo, "applicant-2", "Nope Pilot")).rejects.toBeDefined();
    await expect(withdrawHostApplication(repo, "applicant-2", code)).rejects.toBeDefined();
    expect(repo.auditEvents.length).toBe(before);
  });
});

describe("phaseOf — plain-language phases, one per situation", () => {
  const base = {
    publicCode: "A".repeat(22), venueName: "v", cityArea: "c", playingFields: 1, venueDescription: "d", expectedWindow: "w",
    expectedTeamCount: 4, submittedAt: "2026-10-07T12:00:00Z", decidedAt: null, withdrawnAt: null,
    competitionName: null, competitionPublicCode: null, competitionState: null,
  } as const;
  it("maps every application/capability combination", () => {
    expect(phaseOf(null)).toBe("NOT_APPLIED");
    expect(phaseOf({ ...base, state: "PENDING", capabilityState: null })).toBe("UNDER_REVIEW");
    expect(phaseOf({ ...base, state: "REJECTED", capabilityState: null })).toBe("NOT_APPROVED");
    expect(phaseOf({ ...base, state: "WITHDRAWN", capabilityState: null })).toBe("WITHDRAWN");
    expect(phaseOf({ ...base, state: "APPROVED", capabilityState: "AVAILABLE" })).toBe("APPROVED_READY");
    expect(phaseOf({ ...base, state: "APPROVED", capabilityState: "CONSUMED" })).toBe("PILOT_CREATED");
    expect(phaseOf({ ...base, state: "APPROVED", capabilityState: "REVOKED" })).toBe("ACCESS_REVOKED");
  });
});

describe("cleanReason / isWellFormedPublicCode", () => {
  it("cleans control characters, trims, caps at 500, and returns null when nothing is left", () => {
    expect(cleanReason("  fine reason  ")).toBe("fine reason");
    expect(cleanReason("a\u0000b")).toBe("a b");
    expect(cleanReason("keeps\nline\tbreaks")).toBe("keeps\nline\tbreaks");
    expect(cleanReason("x".repeat(600))).toHaveLength(500);
    expect(cleanReason("\u0000\u0001  ")).toBeNull();
    expect(cleanReason(undefined)).toBeNull();
    expect(cleanReason(12)).toBeNull();
  });
  it("accepts only 22-character base64url codes", () => {
    expect(isWellFormedPublicCode("A".repeat(22))).toBe(true);
    expect(isWellFormedPublicCode("a-_Z0".padEnd(22, "9"))).toBe(true);
    for (const bad of ["", "A".repeat(21), "A".repeat(23), "A".repeat(21) + "+", "A".repeat(21) + "/", "A".repeat(21) + "=", " " + "A".repeat(21), null, undefined, 5]) {
      expect(isWellFormedPublicCode(bad)).toBe(false);
    }
  });
});

describe("statusForHostError — every exported host error class has a status", () => {
  const NOT_FOUND: Error[] = [new HostApplicationNotFoundError(), new HostCapabilityNotFoundError()];
  const FORBIDDEN: Error[] = [new HostReviewerAuthorityRequiredError(), new HostSelfReviewForbiddenError(), new HostCapabilityRequiredError(), new HostCapabilityRevokedError()];
  const CONFLICT: Error[] = [new HostApplicationAlreadyActiveError(), new HostApplicationNotPendingError(), new HostApplicationAlreadyDecidedError(), new HostCapabilityAlreadyConsumedError()];
  const BAD_REQUEST: Error[] = [new InvalidHostApplicationError("venueName"), new InvalidHostCompetitionError("name"), new InvalidHostDecisionError(), new InvalidHostReviewViewError(), new HostReasonRequiredError()];

  it("maps each bucket to its status", () => {
    for (const e of NOT_FOUND) expect(statusForHostError(e)).toBe(404);
    for (const e of FORBIDDEN) expect(statusForHostError(e)).toBe(403);
    for (const e of CONFLICT) expect(statusForHostError(e)).toBe(409);
    for (const e of BAD_REQUEST) expect(statusForHostError(e)).toBe(400);
  });

  it("returns null for an unknown error so the route answers a generic 500", () => {
    expect(statusForHostError(new Error("boom"))).toBeNull();
    expect(statusForHostError("string")).toBeNull();
    expect(statusForHostError(null)).toBeNull();
  });

  it("this file's four buckets cover every error class exported by host/types.ts (fails loudly if one is added unmapped)", () => {
    const exportedErrorNames = Object.keys(hostTypes).filter((name) => name.endsWith("Error"));
    const covered = new Set([...NOT_FOUND, ...FORBIDDEN, ...CONFLICT, ...BAD_REQUEST].map((e) => e.constructor.name));
    expect(exportedErrorNames.filter((name) => !covered.has(name))).toEqual([]);
  });

  it("an error body names the rejected field but never raw database text", () => {
    expect(bodyForHostError(new InvalidHostApplicationError("venueName"))).toMatchObject({ field: "venueName" });
    const body = bodyForHostError(new HostCapabilityRevokedError());
    expect(body.error).toBe("Your hosting access has been revoked.");
    expect(body.field).toBeUndefined();
  });

  it("the plain-language messages the page shows are the Founder-specified ones", () => {
    expect(new HostCapabilityAlreadyConsumedError().message).toBe("Your approved pilot has already been created.");
    expect(new HostCapabilityRevokedError().message).toBe("Your hosting access has been revoked.");
    // Applicant-facing messages never use authority-system terminology.
    for (const e of [...NOT_FOUND, ...CONFLICT, ...BAD_REQUEST, new HostCapabilityRequiredError(), new HostCapabilityRevokedError(), new HostReviewerAuthorityRequiredError()]) {
      expect(e.message).not.toMatch(/PRODUCT_GOVERNANCE|OPERATIONAL|CONSEQUENTIAL_FINALIZER|authority class|capability|governance/i);
    }
  });
});

describe("BECOME_A_HOST_SCHEMA_READY — fail-closed exact-true readiness gate", () => {
  const original = process.env.BECOME_A_HOST_SCHEMA_READY;
  afterEach(() => {
    if (original === undefined) delete process.env.BECOME_A_HOST_SCHEMA_READY;
    else process.env.BECOME_A_HOST_SCHEMA_READY = original;
  });

  it("only the exact string \"true\" enables the feature", () => {
    expect(normalizeBecomeAHostSchemaReady("true")).toBe(true);
    for (const bad of [undefined, "", "false", "TRUE", "True", "1", "yes", " true", "true ", "on"]) {
      expect(normalizeBecomeAHostSchemaReady(bad)).toBe(false);
    }
  });

  it("reads the environment fresh on every call", () => {
    delete process.env.BECOME_A_HOST_SCHEMA_READY;
    expect(isBecomeAHostSchemaReady()).toBe(false);
    expect(requireHostSchemaReady()?.status).toBe(503);
    process.env.BECOME_A_HOST_SCHEMA_READY = "true";
    expect(isBecomeAHostSchemaReady()).toBe(true);
    expect(requireHostSchemaReady()).toBeNull();
    process.env.BECOME_A_HOST_SCHEMA_READY = "TRUE";
    expect(requireHostSchemaReady()?.status).toBe(503);
  });

  it("the unavailable response is generic: no table, migration, provider or environment detail", async () => {
    delete process.env.BECOME_A_HOST_SCHEMA_READY;
    const body = JSON.stringify(await requireHostSchemaReady()!.json());
    expect(body).toBe('{"error":"Become a Host is not open yet."}');
  });
});

describe("organizer access in the TypeScript layer (the four sites that used to compare ids)", () => {
  const record = (over: Partial<CompetitionRecord> = {}): CompetitionRecord => ({
    competitionId: "c1", publicCode: "P".repeat(22), activityKey: "SOCCER_5V5", name: "Cup", organizerGamingMemberId: "host",
    state: "TEAM_REGISTRATION_OPEN", cancelledReason: null, createdAt: "2026-10-07T00:00:00Z", publishedAt: null, ...over,
  });

  it("isActiveOrganizer: the organizer, unless their host access has been revoked", () => {
    expect(isActiveOrganizer(record(), "host")).toBe(true);
    expect(isActiveOrganizer(record(), "someone-else")).toBe(false);
    expect(isActiveOrganizer(record({ hostBound: true, hostAccessRevoked: false }), "host")).toBe(true);
    expect(isActiveOrganizer(record({ hostBound: true, hostAccessRevoked: true }), "host")).toBe(false);
    expect(isActiveOrganizer(null, "host")).toBe(false);
    expect(isActiveOrganizer(undefined, "host")).toBe(false);
    // A public code or competition id presented by the caller is not an input at all.
    expect(isActiveOrganizer(record(), "P".repeat(22))).toBe(false);
  });

  it("isListedFor: internal competitions keep the existing rule exactly", () => {
    expect(isListedFor(record({ state: "DRAFT" }), "host")).toBe(true);
    expect(isListedFor(record({ state: "DRAFT" }), "other")).toBe(false);
    for (const state of ["TEAM_REGISTRATION_OPEN", "READY_TO_PUBLISH", "PUBLISHED", "COMPLETE", "CANCELLED_WITHOUT_CHAMPION"] as const) {
      expect(isListedFor(record({ state }), "other")).toBe(true);
    }
  });

  it("isListedFor: a host's private pilot is listed to its organizer, and to a member who holds a role in it — in every state — never to anyone else", () => {
    for (const state of ["DRAFT", "TEAM_REGISTRATION_OPEN", "READY_TO_PUBLISH", "PUBLISHED", "COMPLETE", "CANCELLED_WITHOUT_CHAMPION"] as const) {
      const pilot = record({ state, hostBound: true, hostAccessRevoked: false });
      expect(isListedFor(pilot, "host")).toBe(true);
      expect(isListedFor(pilot, "other")).toBe(false);
      expect(isListedFor(pilot, "other", new Set())).toBe(false);
      expect(isListedFor(pilot, "other", new Set(["some-other-competition"]))).toBe(false);
      expect(isListedFor(pilot, "assigned-scorekeeper", new Set(["c1"]))).toBe(true);
      expect(isListedFor(record({ state, hostBound: true, hostAccessRevoked: true }), "other")).toBe(false);
      expect(isListedFor(record({ state, hostBound: true, hostAccessRevoked: true }), "returning-player", new Set(["c1"]))).toBe(true);
    }
  });

  it("isListedFor: a role in a competition never changes how an ordinary competition is listed", () => {
    expect(isListedFor(record({ state: "DRAFT" }), "other", new Set(["c1"]))).toBe(false);
    expect(isListedFor(record({ state: "PUBLISHED" }), "other", new Set())).toBe(true);
  });

  it("toPublicCompetition removes exactly the host-binding flags and nothing else", () => {
    const stripped = toPublicCompetition(record({ hostBound: true, hostAccessRevoked: true }));
    expect(Object.keys(stripped)).not.toContain("hostBound");
    expect(Object.keys(stripped)).not.toContain("hostAccessRevoked");
    expect(stripped).toEqual(record());
  });

  function fakeRepo(competition: CompetitionRecord, teams: CompetitionTeamRecord[]): CompetitionsRepository {
    const resolvers: Record<string, unknown> = {
      getCompetitionById: competition,
      getCompetitionTeams: teams,
      getCompetitionFixtures: [],
      getMyRegistration: null,
      getMyTeamMembership: null,
      getMyPendingJoinRequest: null,
      getMemberParticipationRecords: [],
      getDisplayNames: {},
      getTeamMemberships: [],
    };
    return new Proxy({}, { get: (_t, name: string) => vi.fn().mockResolvedValue(name in resolvers ? resolvers[name] : null) }) as unknown as CompetitionsRepository;
  }
  const pendingTeam: CompetitionTeamRecord = {
    competitionTeamId: "t1", competitionId: "c1", publicCode: "T".repeat(22), name: "Pending FC", captainGamingMemberId: "captain",
    status: "PENDING_ORGANIZER_APPROVAL", provenance: "MEMBER_PROPOSED", rejectionReason: null, decidedAt: null, decidedByGamingMemberId: null, createdAt: "x",
  } as CompetitionTeamRecord;

  it("getCompetitionView shows an active host the organizer review queue", async () => {
    const view = await getCompetitionView(fakeRepo(record({ hostBound: true, hostAccessRevoked: false }), [pendingTeam]), "c1", "host");
    expect(view.isOrganizer).toBe(true);
    expect(view.pendingTeamProposals).toHaveLength(1);
  });

  it("getCompetitionView withholds organizer-only data from a REVOKED host, while the public view stays", async () => {
    const view = await getCompetitionView(fakeRepo(record({ hostBound: true, hostAccessRevoked: true }), [pendingTeam]), "c1", "host");
    expect(view.isOrganizer).toBe(false);
    expect(view.pendingTeamProposals).toEqual([]);
    expect(view.rejectedTeamProposals).toEqual([]);
    expect(view.competition.name).toBe("Cup");
  });

  it("getCompetitionView never returns the host-binding or revocation flags to anyone", async () => {
    for (const caller of ["host", "invited-member"]) {
      const view = await getCompetitionView(fakeRepo(record({ hostBound: true, hostAccessRevoked: true }), [pendingTeam]), "c1", caller);
      expect(JSON.stringify(view)).not.toMatch(/hostBound|hostAccessRevoked/);
    }
  });

  it("getCompetitionView gives a non-organizer, including anyone holding the public code, no organizer data", async () => {
    const view = await getCompetitionView(fakeRepo(record({ hostBound: true, hostAccessRevoked: false }), [pendingTeam]), "c1", "invited-member");
    expect(view.isOrganizer).toBe(false);
    expect(view.pendingTeamProposals).toEqual([]);
  });
});

describe("host routes (the HTTP boundary)", () => {
  let httpAuth: typeof import("../lib/gaming/host/httpAuth");
  let repo: InMemoryHostRepository;
  const ORIGINAL_HOST_READY = process.env.BECOME_A_HOST_SCHEMA_READY;
  const ORIGINAL_COMPETITIONS_READY = process.env.COMPETITIONS_SCHEMA_READY;

  beforeEach(async () => {
    process.env.BECOME_A_HOST_SCHEMA_READY = "true";
    process.env.COMPETITIONS_SCHEMA_READY = "true";
    httpAuth = await import("../lib/gaming/host/httpAuth");
    vi.clearAllMocks();
    repo = seeded();
    vi.mocked(httpAuth.getSupabaseCredentials).mockReturnValue({ url: "http://fake", serviceKey: "fake" });
    vi.mocked(httpAuth.buildHostRepo).mockReturnValue(repo as unknown as ReturnType<typeof httpAuth.buildHostRepo>);
    vi.mocked(httpAuth.requireGamingMember).mockResolvedValue({ gamingMemberId: "applicant" });
  });

  afterEach(() => {
    if (ORIGINAL_HOST_READY === undefined) delete process.env.BECOME_A_HOST_SCHEMA_READY;
    else process.env.BECOME_A_HOST_SCHEMA_READY = ORIGINAL_HOST_READY;
    if (ORIGINAL_COMPETITIONS_READY === undefined) delete process.env.COMPETITIONS_SCHEMA_READY;
    else process.env.COMPETITIONS_SCHEMA_READY = ORIGINAL_COMPETITIONS_READY;
  });

  function request(method: string, body?: unknown, url = "http://localhost/probe") {
    return new Request(url, { method, headers: { authorization: "Bearer token" }, body: body === undefined ? undefined : JSON.stringify(body) });
  }
  const asReviewer = () => vi.mocked(httpAuth.requireGamingMember).mockResolvedValue({ gamingMemberId: "reviewer" });

  it("POST /applications: submits as the verified caller and ignores every identity/state field in the body", async () => {
    const { POST } = await import("../app/api/gaming/host/applications/route");
    const res = await POST(request("POST", { ...VALID_INPUT, gamingMemberId: "applicant-2", state: "APPROVED", decidedBy: "reviewer" }));
    expect(res.status).toBe(201);
    const json = await res.json();
    expect(json.application.state).toBe("PENDING");
    expect(JSON.stringify(json)).not.toMatch(UUID_PATTERN);
    expect((await getHostStatus(repo, "applicant")).phase).toBe("UNDER_REVIEW");
    expect((await getHostStatus(repo, "applicant-2")).phase).toBe("NOT_APPLIED");
  });

  it("POST /applications: 400 with the field named for an invalid submission, 409 for a duplicate, 400 for non-JSON", async () => {
    const { POST } = await import("../app/api/gaming/host/applications/route");
    const bad = await POST(request("POST", { ...VALID_INPUT, expectedTeamCount: 2 }));
    expect(bad.status).toBe(400);
    expect((await bad.json()).field).toBe("expectedTeamCount");
    expect((await POST(request("POST", VALID_INPUT))).status).toBe(201);
    expect((await POST(request("POST", VALID_INPUT))).status).toBe(409);
    const notJson = await POST(new Request("http://localhost/probe", { method: "POST", headers: { authorization: "Bearer token" }, body: "{not json" }));
    expect(notJson.status).toBe(400);
  });

  it("rejects an unauthenticated caller before the repository is built or called", async () => {
    const { POST } = await import("../app/api/gaming/host/applications/route");
    const { NextResponse } = await import("next/server");
    vi.mocked(httpAuth.requireGamingMember).mockResolvedValue({ errorResponse: NextResponse.json({ error: "no" }, { status: 401 }) });
    const res = await POST(request("POST", VALID_INPUT));
    expect(res.status).toBe(401);
    expect(httpAuth.buildHostRepo).not.toHaveBeenCalled();
  });

  it("GET /status: returns the caller's own phase and nothing about anyone else", async () => {
    const { GET } = await import("../app/api/gaming/host/status/route");
    await submitHostApplication(repo, "applicant-2", VALID_INPUT);
    const res = await GET(request("GET"));
    expect(res.status).toBe(200);
    expect((await res.json()).phase).toBe("NOT_APPLIED");
  });

  it("GET /review: 403 for a non-governance member, 200 with names for a reviewer, 400 for a bad view", async () => {
    const { GET } = await import("../app/api/gaming/host/review/route");
    await submitHostApplication(repo, "applicant", VALID_INPUT);
    const denied = await GET(request("GET", undefined, "http://localhost/api/gaming/host/review?view=PENDING"));
    expect(denied.status).toBe(403);
    expect(JSON.stringify(await denied.json())).not.toMatch(/PRODUCT_GOVERNANCE|OPERATIONAL/);
    asReviewer();
    const ok = await GET(request("GET", undefined, "http://localhost/api/gaming/host/review?view=PENDING"));
    expect(ok.status).toBe(200);
    const json = await ok.json();
    expect(json.applications[0].applicantDisplayName).toBe("Alex Applicant");
    expect(JSON.stringify(json)).not.toMatch(UUID_PATTERN);
    const bad = await GET(request("GET", undefined, "http://localhost/api/gaming/host/review?view=EVERYTHING"));
    expect(bad.status).toBe(400);
    const active = await GET(request("GET", undefined, "http://localhost/api/gaming/host/review?view=ACTIVE"));
    expect(active.status).toBe(200);
  });

  it("POST /review/[code]/decide: governance decides, anyone else gets 403, a rejection without a reason gets 400", async () => {
    const { POST } = await import("../app/api/gaming/host/review/[applicationCode]/decide/route");
    const code = await submitAndGetCode(repo);
    const params = { params: { applicationCode: code } };
    expect((await POST(request("POST", { decision: "APPROVE" }), params)).status).toBe(403);
    asReviewer();
    expect((await POST(request("POST", { decision: "REJECT" }), params)).status).toBe(400);
    expect((await POST(request("POST", { decision: "BANANA" }), params)).status).toBe(400);
    const ok = await POST(request("POST", { decision: "APPROVE" }), params);
    expect(ok.status).toBe(200);
    expect((await ok.json()).application).toMatchObject({ state: "APPROVED", capabilityState: "AVAILABLE" });
    expect((await POST(request("POST", { decision: "REJECT", reason: "late" }), params)).status).toBe(409);
  });

  it("POST /review/[code]/decide: the reviewer identity is the verified caller, never a body field", async () => {
    const { POST } = await import("../app/api/gaming/host/review/[applicationCode]/decide/route");
    const code = await submitAndGetCode(repo);
    // The applicant is the caller; claiming to be the reviewer in the body changes nothing.
    const res = await POST(request("POST", { decision: "APPROVE", reviewerGamingMemberId: "reviewer", gamingMemberId: "reviewer", actor: "reviewer" }), { params: { applicationCode: code } });
    expect(res.status).toBe(403);
    expect((await getHostStatus(repo, "applicant")).phase).toBe("UNDER_REVIEW");
  });

  it("POST /review/[code]/revoke: governance only, reason required", async () => {
    const { POST } = await import("../app/api/gaming/host/review/[applicationCode]/revoke/route");
    const code = await submitAndGetCode(repo);
    await decideHostApplication(repo, "reviewer", code, "APPROVE", null);
    const params = { params: { applicationCode: code } };
    expect((await POST(request("POST", { reason: "why" }), params)).status).toBe(403);
    asReviewer();
    expect((await POST(request("POST", {}), params)).status).toBe(400);
    const ok = await POST(request("POST", { reason: "Rules were not followed." }), params);
    expect(ok.status).toBe(200);
    expect((await ok.json()).application).toMatchObject({ capabilityState: "REVOKED" });
  });

  it("POST /applications/[code]/withdraw: only the owner can withdraw", async () => {
    const { POST } = await import("../app/api/gaming/host/applications/[applicationCode]/withdraw/route");
    const code = await submitAndGetCode(repo);
    const params = { params: { applicationCode: code } };
    vi.mocked(httpAuth.requireGamingMember).mockResolvedValue({ gamingMemberId: "applicant-2" });
    expect((await POST(request("POST", {}), params)).status).toBe(404);
    vi.mocked(httpAuth.requireGamingMember).mockResolvedValue({ gamingMemberId: "applicant" });
    const ok = await POST(request("POST", {}), params);
    expect(ok.status).toBe(200);
    expect((await ok.json()).application.state).toBe("WITHDRAWN");
  });

  it("POST /competition: an approved host creates exactly one pilot; the second attempt is a 409; an unapproved member gets 403", async () => {
    const { POST } = await import("../app/api/gaming/host/competition/route");
    vi.mocked(httpAuth.requireGamingMember).mockResolvedValue({ gamingMemberId: "applicant-2" });
    expect((await POST(request("POST", { name: "Not Approved" }))).status).toBe(403);
    vi.mocked(httpAuth.requireGamingMember).mockResolvedValue({ gamingMemberId: "applicant" });
    const code = await submitAndGetCode(repo);
    await decideHostApplication(repo, "reviewer", code, "APPROVE", null);
    const first = await POST(request("POST", { name: "Riverside Pilot Cup", activityKey: "POKER", organizerGamingMemberId: "attacker" }));
    expect(first.status).toBe(201);
    expect(repo.competitionCount()).toBe(1);
    const second = await POST(request("POST", { name: "Another Cup" }));
    expect(second.status).toBe(409);
    expect((await second.json()).error).toBe("Your approved pilot has already been created.");
    expect(repo.competitionCount()).toBe(1);
  });

  it("POST /competition: after revocation the host gets a truthful 403", async () => {
    const { POST } = await import("../app/api/gaming/host/competition/route");
    const code = await submitAndGetCode(repo);
    await decideHostApplication(repo, "reviewer", code, "APPROVE", null);
    await revokeHostCapability(repo, "reviewer", code, "Rules were not followed.");
    const res = await POST(request("POST", { name: "Too Late" }));
    expect(res.status).toBe(403);
    expect((await res.json()).error).toBe("Your hosting access has been revoked.");
  });

  it("an unexpected failure answers a generic 500: no raw error text, and nothing but the failure class reaches the log", async () => {
    const { POST } = await import("../app/api/gaming/host/applications/route");
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(repo, "submitApplication").mockRejectedValue(Object.assign(new Error("duplicate key value violates unique constraint (venue_name)=(Secret Venue)"), { code: "23505" }));
    const res = await POST(request("POST", VALID_INPUT));
    expect(res.status).toBe(500);
    expect(JSON.stringify(await res.json())).not.toMatch(/Secret Venue|duplicate key|23505/);
    const logged = spy.mock.calls.map((c) => c.join(" ")).join("\n");
    expect(logged).toContain("SUBMIT_HOST_APPLICATION");
    expect(logged).not.toMatch(/Secret Venue|duplicate key|Riverside/);
    spy.mockRestore();
  });

  it("no route logs the request body, the Authorization header or an application's text", () => {
    for (const file of routeFiles()) {
      const source = readFileSync(file, "utf8");
      expect(source).not.toMatch(/console\.(log|info|debug|warn)/);
      expect(source).not.toMatch(/console\.error\([^)]*(body|authorization|headers|request)/i);
    }
  });
});

/**
 * UG-CR-GATE-090: the one host route that is intentionally NOT behind requireHostSchemaReady(). It IS the readiness answer — a bounded
 * `{ available: boolean }` read from the same gate — and reads no credentials, session, body or database. Its own contract is pinned in
 * hostAvailability.test.ts. Every other route must still be gated first.
 */
const UNGATED_BY_DESIGN = ["app/api/gaming/host/availability/route.ts"];

function routeFiles(dir = path.join(process.cwd(), "app/api/gaming/host")): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...routeFiles(full));
    else if (entry === "route.ts") out.push(full);
  }
  return out;
}

describe("route inventory and readiness canary (every host route is gated first, and none trusts a client identity)", () => {
  it("pins the exact set of host routes and handlers", () => {
    const files = routeFiles().map((f) => path.relative(process.cwd(), f)).sort();
    expect(files).toEqual([
      "app/api/gaming/host/applications/[applicationCode]/withdraw/route.ts",
      "app/api/gaming/host/applications/route.ts",
      "app/api/gaming/host/availability/route.ts",
      "app/api/gaming/host/competition/route.ts",
      "app/api/gaming/host/review/[applicationCode]/decide/route.ts",
      "app/api/gaming/host/review/[applicationCode]/revoke/route.ts",
      "app/api/gaming/host/review/route.ts",
      "app/api/gaming/host/status/route.ts",
    ]);
    const handlers = routeFiles().flatMap((f) => [...readFileSync(f, "utf8").matchAll(/export async function (GET|POST|PUT|PATCH|DELETE)\(/g)].map((m) => `${path.relative(process.cwd(), f)}:${m[1]}`));
    expect(handlers).toHaveLength(8); // seven gated handlers plus the availability GET
    expect(UNGATED_BY_DESIGN).toEqual(["app/api/gaming/host/availability/route.ts"]);
  });

  it("each handler calls requireHostSchemaReady() before reading credentials, authenticating, parsing a body, or building a repository", () => {
    for (const file of routeFiles()) {
      if (UNGATED_BY_DESIGN.includes(path.relative(process.cwd(), file))) continue;
      const source = readFileSync(file, "utf8");
      const gate = source.indexOf("requireHostSchemaReady()");
      expect(gate, file).toBeGreaterThan(-1);
      for (const later of ["getSupabaseCredentials()", "requireGamingMember(", "request.json()", "buildHostRepo("]) {
        const at = source.indexOf(later, source.indexOf("export async function"));
        // A route that never parses a body (withdraw, status, review list) simply has no such call.
        if (at !== -1) expect(at, `${file} ${later}`).toBeGreaterThan(gate);
      }
      expect(source.indexOf("requireGamingMember("), file).toBeGreaterThan(gate);
    }
  });

  it("every host route answers 503 with the generic body, and touches nothing, while the feature is off", async () => {
    delete process.env.BECOME_A_HOST_SCHEMA_READY;
    const httpAuth = await import("../lib/gaming/host/httpAuth");
    vi.clearAllMocks();
    const cases: Array<[string, string, Record<string, unknown> | undefined]> = [
      ["../app/api/gaming/host/status/route", "GET", undefined],
      ["../app/api/gaming/host/applications/route", "POST", undefined],
      ["../app/api/gaming/host/applications/[applicationCode]/withdraw/route", "POST", { params: { applicationCode: "A".repeat(22) } }],
      ["../app/api/gaming/host/review/route", "GET", undefined],
      ["../app/api/gaming/host/review/[applicationCode]/decide/route", "POST", { params: { applicationCode: "A".repeat(22) } }],
      ["../app/api/gaming/host/review/[applicationCode]/revoke/route", "POST", { params: { applicationCode: "A".repeat(22) } }],
      ["../app/api/gaming/host/competition/route", "POST", undefined],
    ];
    for (const [modulePath, method, ctx] of cases) {
      const mod = await import(modulePath);
      const res = await mod[method](new Request("http://localhost/probe", { method }), ctx);
      expect(res.status, modulePath).toBe(503);
      expect(await res.json()).toEqual({ error: "Become a Host is not open yet." });
    }
    expect(httpAuth.getSupabaseCredentials).not.toHaveBeenCalled();
    expect(httpAuth.requireGamingMember).not.toHaveBeenCalled();
    expect(httpAuth.buildHostRepo).not.toHaveBeenCalled();
  });

  it("the one ungated route answers the CLOSED state as a bounded 200 `{ available: false }` and touches nothing", async () => {
    delete process.env.BECOME_A_HOST_SCHEMA_READY;
    const httpAuth = await import("../lib/gaming/host/httpAuth");
    vi.clearAllMocks();
    const mod = await import("../app/api/gaming/host/availability/route");
    const res = await mod.GET();
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ available: false });
    expect(httpAuth.getSupabaseCredentials).not.toHaveBeenCalled();
    expect(httpAuth.requireGamingMember).not.toHaveBeenCalled();
    expect(httpAuth.buildHostRepo).not.toHaveBeenCalled();
  });

  it("no host route reads an acting identity from the body, query or headers", () => {
    for (const file of routeFiles()) {
      const source = readFileSync(file, "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
      expect(source, file).not.toMatch(/body\.(gamingMemberId|memberId|reviewerGamingMemberId|applicantGamingMemberId|actor|userId|authUserId|email)/);
      expect(source, file).not.toMatch(/searchParams\.get\(["'](gamingMemberId|memberId|actor|userId|email)["']\)/);
      expect(source, file).not.toMatch(/headers\.get\(["'](x-|user|member)/i);
    }
  });

  it("no host route or host module consults email domains, display names, user_metadata or any client flag for authorization", () => {
    const files = [...routeFiles(), ...["lib/gaming/host/httpAuth.ts", "lib/gaming/host/decideHostApplication.ts", "lib/gaming/host/listHostApplicationsForReview.ts", "lib/gaming/host/revokeHostCapability.ts"].map((f) => path.join(process.cwd(), f))];
    for (const file of files) {
      const source = readFileSync(file, "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
      expect(source, file).not.toMatch(/user_metadata|app_metadata|@urbano|\.endsWith\(["']@|email\.(includes|endsWith|split)|displayName\s*===|isAdmin|isGovernance|isStaff/);
    }
  });
});

describe("SupabaseHostRepository — RPC mapping and error translation", () => {
  const repo = new SupabaseHostRepository("http://127.0.0.1:1", "service-key-for-test-only");
  beforeEach(() => rpcStub.mockReset());

  it("passes the verified member as an explicit RPC argument, never anything from the browser", async () => {
    rpcStub.mockResolvedValue({ data: [{ public_code: "Q".repeat(22), state: "PENDING", submitted_at: "2026-10-07T12:00:00Z" }], error: null });
    await repo.submitApplication("member-1", VALID_INPUT);
    expect(rpcStub).toHaveBeenCalledWith("submit_host_application_atomically", expect.objectContaining({ p_gaming_member_id: "member-1", p_venue_name: VALID_INPUT.venueName }));
    const args = rpcStub.mock.calls[0][1];
    expect(Object.keys(args).sort()).toEqual(
      [
        "p_city_area", "p_confirm_all_adults", "p_confirm_independent_scorekeepers", "p_confirm_pilot_exclusions",
        "p_expected_team_count", "p_expected_window", "p_gaming_member_id", "p_playing_fields", "p_venue_description", "p_venue_name",
      ].sort()
    );
  });

  const SQL_ERRORS: Array<[string, new (...a: any[]) => Error]> = [
    ["INVALID_HOST_DECISION: decision must be APPROVE or REJECT", InvalidHostDecisionError],
    ["INVALID_HOST_REVIEW_VIEW: view must be PENDING or HISTORY", InvalidHostReviewViewError],
    ["GOVERNANCE_AUTHORITY_REQUIRED: only an active Product Governance reviewer may decide a host application", HostReviewerAuthorityRequiredError],
    ["REASON_REQUIRED: rejecting a host application requires a reason", HostReasonRequiredError],
    ["HOST_APPLICATION_ALREADY_ACTIVE: you already have a host application", HostApplicationAlreadyActiveError],
    ["HOST_APPLICATION_NOT_FOUND: no such host application", HostApplicationNotFoundError],
    ["HOST_APPLICATION_NOT_PENDING: only a pending application can be withdrawn", HostApplicationNotPendingError],
    ["HOST_APPLICATION_ALREADY_DECIDED: this host application has already been decided", HostApplicationAlreadyDecidedError],
    ["HOST_SELF_REVIEW_FORBIDDEN: a reviewer cannot decide their own host application", HostSelfReviewForbiddenError],
    ["HOST_CAPABILITY_NOT_FOUND: this application has no hosting access to revoke", HostCapabilityNotFoundError],
    ["HOST_CAPABILITY_REQUIRED: an approved host application is required", HostCapabilityRequiredError],
    ["HOST_CAPABILITY_ALREADY_CONSUMED: your approved pilot competition has already been created", HostCapabilityAlreadyConsumedError],
    ["HOST_CAPABILITY_REVOKED: your hosting access has been revoked", HostCapabilityRevokedError],
  ];
  for (const [message, ErrorClass] of SQL_ERRORS) {
    it(`translates ${message.split(":")[0]} to ${ErrorClass.name} with a plain-language message that never echoes the SQL text`, async () => {
      rpcStub.mockResolvedValue({ data: null, error: { code: "P0001", message } });
      const err = await repo.decideApplication("m", "Q".repeat(22), "APPROVE", null).catch((e) => e);
      expect(err).toBeInstanceOf(ErrorClass);
      // The typed error carries its own wording: never the SQL message, never its CODE prefix.
      expect((err as Error).message).not.toBe(message);
      expect((err as Error).message).not.toContain(message.split(":")[0]);
    });
  }

  it("translates a rejected field to a camelCase field name", async () => {
    for (const [sqlField, field] of [["venue_name", "venueName"], ["city_area", "cityArea"], ["playing_fields", "playingFields"], ["venue_description", "venueDescription"], ["expected_window", "expectedWindow"], ["expected_team_count", "expectedTeamCount"], ["confirmations", "confirmations"]] as const) {
      rpcStub.mockResolvedValue({ data: null, error: { code: "P0001", message: `INVALID_HOST_APPLICATION: ${sqlField}` } });
      const err = (await repo.submitApplication("m", VALID_INPUT).catch((e) => e)) as InvalidHostApplicationError;
      expect(err).toBeInstanceOf(InvalidHostApplicationError);
      expect(err.field).toBe(field);
    }
    rpcStub.mockResolvedValue({ data: null, error: { code: "P0001", message: "INVALID_HOST_COMPETITION: name" } });
    expect(((await repo.createHostCompetition("m", "x", "SOCCER_5V5", "c").catch((e) => e)) as InvalidHostCompetitionError).field).toBe("name");
    rpcStub.mockResolvedValue({ data: null, error: { code: "P0001", message: "UNSUPPORTED_ACTIVITY_KEY: only SOCCER_5V5" } });
    expect(((await repo.createHostCompetition("m", "x", "POKER", "c").catch((e) => e)) as InvalidHostCompetitionError).field).toBe("activityKey");
  });

  it("only a P0001 error is translated; anything else stays a plain Error for the route's generic 500", async () => {
    rpcStub.mockResolvedValue({ data: null, error: { code: "42501", message: "HOST_CAPABILITY_REVOKED: permission denied" } });
    const err = await repo.createHostCompetition("m", "Name Here", "SOCCER_5V5", "c").catch((e) => e);
    expect(err).not.toBeInstanceOf(HostCapabilityRevokedError);
    expect(statusForHostError(err)).toBeNull();
  });

  it("maps rows to records and unwraps arrays", async () => {
    rpcStub.mockResolvedValue({
      data: [{ public_code: "Q".repeat(22), state: "APPROVED", capability_state: "AVAILABLE", already_decided: false }],
      error: null,
    });
    expect(await repo.decideApplication("m", "Q".repeat(22), "APPROVE", null)).toEqual({ publicCode: "Q".repeat(22), state: "APPROVED", capabilityState: "AVAILABLE", alreadyDecided: false });
    rpcStub.mockResolvedValue({ data: [], error: null });
    expect(await repo.getStatus("m")).toBeNull();
    expect(await repo.listForReview("m", "PENDING")).toEqual([]);
  });
});

describe("SupabaseCompetitionsRepository.hostBindings — the private-pilot filter cannot fail open past PostgREST's row cap", () => {
  /** A chainable, awaitable stand-in for a PostgREST query builder. */
  function builder(resolve: () => { data: unknown[] | null; error: unknown }) {
    const b: Record<string, unknown> = {};
    for (const m of ["select", "not", "order", "eq", "range"]) b[m] = (...args: unknown[]) => { (b.calls as unknown[][]).push([m, ...args]); return b; };
    b.calls = [] as unknown[][];
    b.then = (ok: (v: unknown) => unknown, bad?: (e: unknown) => unknown) => Promise.resolve(resolve()).then(ok, bad);
    return b as any;
  }

  it("reads every page of bindings, so a pilot beyond the first 1000 is still marked host-bound", async () => {
    const firstPage = Array.from({ length: 1000 }, (_, i) => ({ competition_id: `bound-${String(i).padStart(4, "0")}`, state: "CONSUMED" }));
    const secondPage = [{ competition_id: "bound-1000", state: "REVOKED" }];
    const pages = [firstPage, secondPage];
    let capabilityReads = 0;
    const capabilityBuilders: any[] = [];
    fromStub.mockImplementation((table: string) => {
      if (table === "competitions") {
        return builder(() => ({
          data: [{ competition_id: "bound-1000", public_code: "p", activity_key: "SOCCER_5V5", name: "Late Pilot", organizer_gaming_member_id: "host", state: "PUBLISHED", cancelled_reason: null, created_at: "x", published_at: null }],
          error: null,
        }));
      }
      const b = builder(() => ({ data: pages[capabilityReads++] ?? [], error: null }));
      capabilityBuilders.push(b);
      return b;
    });
    const repo = new SupabaseCompetitionsRepository("http://127.0.0.1:1", "service-key-for-test-only");
    const [late] = await repo.listCompetitions();
    expect(capabilityReads).toBe(2);
    expect(late).toMatchObject({ competitionId: "bound-1000", hostBound: true, hostAccessRevoked: true });
    const ranges = capabilityBuilders.map((b) => b.calls.find((c: unknown[]) => c[0] === "range"));
    expect(ranges).toEqual([["range", 0, 999], ["range", 1000, 1999]]);
  });

  it("only a missing host table is treated as 'no bindings'; any other failure is thrown, never read as 'not host-bound'", async () => {
    for (const code of ["42P01", "PGRST205"]) {
      fromStub.mockImplementation((table: string) =>
        table === "competitions"
          ? builder(() => ({ data: [{ competition_id: "c", public_code: "p", activity_key: "SOCCER_5V5", name: "n", organizer_gaming_member_id: "o", state: "DRAFT", cancelled_reason: null, created_at: "x", published_at: null }], error: null }))
          : builder(() => ({ data: null, error: { code, message: "relation missing" } }))
      );
      const [row] = await new SupabaseCompetitionsRepository("http://127.0.0.1:1", "k").listCompetitions();
      expect(row.hostBound).toBeUndefined();
    }
    fromStub.mockImplementation((table: string) =>
      table === "competitions"
        ? builder(() => ({ data: [], error: null }))
        : builder(() => ({ data: null, error: { code: "57014", message: "statement timeout" } }))
    );
    await expect(new SupabaseCompetitionsRepository("http://127.0.0.1:1", "k").listCompetitions()).rejects.toMatchObject({ code: "57014" });
  });
});
