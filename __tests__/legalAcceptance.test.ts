import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";

import { InMemoryLegalAcceptanceRepository } from "../lib/gaming/legal/db/inMemoryLegalAcceptanceRepository";
import { hashDocument } from "../lib/gaming/legal/documents";
import {
  acceptConditions,
  assertConditionsAccepted,
  conditionStatus,
  makeAdmissionGate,
  resolveRequirements,
} from "../lib/gaming/legal/requirements";
import {
  InvalidLegalSubmissionError,
  LegalAcceptanceHashConflictError,
  LegalAgeDeclarationRequiredError,
  LegalConditionsRequiredError,
  LegalDocumentStaleError,
  LegalDocumentsNotPublishedError,
  type LegalDocumentEntry,
} from "../lib/gaming/legal/types";
import { acceptEverything, fixtureEntry, fixtureRegistry, fixtureRegistryWithNewVersion } from "./helpers/legalFixtures";

/**
 * ACCEPTING THE CONDITIONS, in the domain, against the in-memory repository (the same rules the database repeats; see the contract suite).
 * Terms and event rules are ACCEPTED, the privacy notice is READ and acknowledged, the event rules carry the declaration of being 18 or
 * older, nothing is ever recorded for anyone but the person asking, and an act is never counted for a text, a version or an event it was
 * not given for.
 */

const KICKOFF = "2026-10-25T20:00:00.000Z";
const matchA = { matchId: randomUUID(), kickoffAt: KICKOFF };
const matchB = { matchId: randomUUID(), kickoffAt: KICKOFF }; // another match that starts at the same instant: its own rules acceptance
const registry = fixtureRegistry(KICKOFF);

function submission(entry: LegalDocumentEntry, extra: Record<string, unknown> = {}) {
  return { documentKey: entry.key, documentVersion: entry.version, contentSha256: entry.sha256, ...extra };
}
const terms = registry[0];
const privacy = registry[1];
const rules = registry[2];

describe("what a match needs, and what a member is missing", () => {
  it("needs the two global texts and the rules of that event; a member who has accepted nothing is missing all three", async () => {
    const repo = new InMemoryLegalAcceptanceRepository();
    const { required, unpublished } = resolveRequirements(registry, matchA);
    expect(required.map((d) => [d.key, d.actType, d.scopeMatchId])).toEqual([
      ["ACCOUNT_TERMS", "ACCEPTANCE", null],
      ["PRIVACY_NOTICE", "READ_ACKNOWLEDGMENT", null],
      ["EVENT_RULES", "ACCEPTANCE", matchA.matchId],
    ]);
    expect(unpublished).toEqual([]);
    const status = await conditionStatus(repo, registry, matchA, "member");
    expect(status).toMatchObject({ published: true, satisfied: false });
    expect(status.documents.map((d) => d.accepted)).toEqual([false, false, false]);
    expect(status.documents.find((d) => d.key === "EVENT_RULES")!.needsAgeDeclaration).toBe(true);
    expect(status.documents.find((d) => d.key === "PRIVACY_NOTICE")!.actType).toBe("READ_ACKNOWLEDGMENT");
    await expect(assertConditionsAccepted(repo, registry, matchA, "member")).rejects.toBeInstanceOf(LegalConditionsRequiredError);
  });

  it("is satisfied only when all three are done, and a partial acceptance leaves exactly what is left", async () => {
    const repo = new InMemoryLegalAcceptanceRepository();
    await acceptConditions(repo, registry, matchA, "member", [submission(terms)]);
    let status = await conditionStatus(repo, registry, matchA, "member");
    expect(status.satisfied).toBe(false);
    expect(status.documents.filter((d) => !d.accepted).map((d) => d.key)).toEqual(["PRIVACY_NOTICE", "EVENT_RULES"]);
    await acceptConditions(repo, registry, matchA, "member", [submission(privacy), submission(rules, { ageDeclared18: true })]);
    status = await conditionStatus(repo, registry, matchA, "member");
    expect(status.satisfied).toBe(true);
    await expect(assertConditionsAccepted(repo, registry, matchA, "member")).resolves.toBeUndefined();
  });

  it("the gate asks the same question", async () => {
    const repo = new InMemoryLegalAcceptanceRepository();
    const gate = makeAdmissionGate({ repo, registry, match: matchA, gamingMemberId: "member" });
    await expect(gate.assertConditions()).rejects.toBeInstanceOf(LegalConditionsRequiredError);
    await acceptEverything(repo, registry, matchA, "member");
    await expect(gate.assertConditions()).resolves.toBeUndefined();
  });
});

describe("the three acts are different acts", () => {
  it("records the terms and the rules as ACCEPTANCE and the privacy notice as READ_ACKNOWLEDGMENT, with the age declaration only on the rules", async () => {
    const repo = new InMemoryLegalAcceptanceRepository();
    await acceptEverything(repo, registry, matchA, "member");
    const rows = await repo.listForMember("member");
    const byKey = Object.fromEntries(rows.map((r) => [r.documentKey, r]));
    expect(byKey.ACCOUNT_TERMS).toMatchObject({ actType: "ACCEPTANCE", ageDeclared18: null, scopeMatchId: null });
    expect(byKey.PRIVACY_NOTICE).toMatchObject({ actType: "READ_ACKNOWLEDGMENT", ageDeclared18: null, scopeMatchId: null });
    expect(byKey.EVENT_RULES).toMatchObject({ actType: "ACCEPTANCE", ageDeclared18: true, scopeMatchId: matchA.matchId });
    for (const row of rows) {
      expect(row.contentSha256).toBe(registry.find((e) => e.key === row.documentKey)!.sha256);
      expect(row.source).toBe("PRE_PARTICIPATION");
    }
  });

  it("a privacy acknowledgment recorded as an acceptance (or the reverse) does not cover the document", async () => {
    const repo = new InMemoryLegalAcceptanceRepository();
    const base = { gamingMemberId: "member", locale: "es" as const, source: "PRE_PARTICIPATION" as const, ageDeclared18: null, scopeMatchId: null };
    await repo.recordAcceptance({ ...base, documentKey: "PRIVACY_NOTICE", documentVersion: privacy.version, contentSha256: privacy.sha256, actType: "ACCEPTANCE" });
    await repo.recordAcceptance({ ...base, documentKey: "ACCOUNT_TERMS", documentVersion: terms.version, contentSha256: terms.sha256, actType: "READ_ACKNOWLEDGMENT" });
    const status = await conditionStatus(repo, registry, matchA, "member");
    expect(status.documents.map((d) => d.accepted)).toEqual([false, false, false]);
  });

  it("the event rules need the declaration of being 18 or older: without it (missing, false) nothing is written for them", async () => {
    const repo = new InMemoryLegalAcceptanceRepository();
    await expect(acceptConditions(repo, registry, matchA, "member", [submission(rules)])).rejects.toBeInstanceOf(LegalAgeDeclarationRequiredError);
    await expect(acceptConditions(repo, registry, matchA, "member", [submission(rules, { ageDeclared18: false })])).rejects.toBeInstanceOf(LegalAgeDeclarationRequiredError);
    expect(repo.count()).toBe(0);
  });

  it("the other documents take no age declaration", async () => {
    const repo = new InMemoryLegalAcceptanceRepository();
    await expect(acceptConditions(repo, registry, matchA, "member", [submission(terms, { ageDeclared18: true })])).rejects.toBeInstanceOf(InvalidLegalSubmissionError);
    expect(repo.count()).toBe(0);
  });

  it("a request must name something real: no documents, an unknown document, the same one twice", async () => {
    const repo = new InMemoryLegalAcceptanceRepository();
    await expect(acceptConditions(repo, registry, matchA, "member", [])).rejects.toBeInstanceOf(InvalidLegalSubmissionError);
    await expect(acceptConditions(repo, registry, matchA, "member", [{ documentKey: "MARKETING", documentVersion: "v", contentSha256: "x" }])).rejects.toBeInstanceOf(InvalidLegalSubmissionError);
    await expect(acceptConditions(repo, registry, matchA, "member", [submission(terms), submission(terms)])).rejects.toBeInstanceOf(InvalidLegalSubmissionError);
    expect(repo.count()).toBe(0);
  });
});

describe("versions and hashes", () => {
  it("refuses a version that is not the current one, or the right version with a different hash, and writes nothing", async () => {
    const repo = new InMemoryLegalAcceptanceRepository();
    await expect(acceptConditions(repo, registry, matchA, "member", [{ ...submission(terms), documentVersion: "fixture-0" }])).rejects.toBeInstanceOf(LegalDocumentStaleError);
    await expect(acceptConditions(repo, registry, matchA, "member", [{ ...submission(terms), contentSha256: "f".repeat(64) }])).rejects.toBeInstanceOf(LegalDocumentStaleError);
    // one stale item among good ones: none of them is written
    await expect(acceptConditions(repo, registry, matchA, "member", [submission(privacy), { ...submission(terms), contentSha256: "f".repeat(64) }])).rejects.toBeInstanceOf(LegalDocumentStaleError);
    expect(repo.count()).toBe(0);
  });

  it("a new version needs a new act: what was accepted for the old one does not count, and the old rows stay as evidence", async () => {
    const repo = new InMemoryLegalAcceptanceRepository();
    await acceptEverything(repo, registry, matchA, "member");
    const v2 = fixtureRegistryWithNewVersion(KICKOFF);
    const before = await conditionStatus(repo, v2, matchA, "member");
    expect(before).toMatchObject({ published: true, satisfied: false });
    expect(before.documents.every((d) => d.version === "fixture-2" && !d.accepted)).toBe(true);
    // the member still holding the page of v1 is told it is stale
    await expect(acceptConditions(repo, v2, matchA, "member", [submission(terms)])).rejects.toBeInstanceOf(LegalDocumentStaleError);
    await acceptEverything(repo, v2, matchA, "member");
    expect((await conditionStatus(repo, v2, matchA, "member")).satisfied).toBe(true);
    expect(repo.count()).toBe(6); // three for v1, three for v2: nothing was replaced
  });

  it("a text whose content changes but keeps its version number is a different text: it is not covered by the old act", async () => {
    const repo = new InMemoryLegalAcceptanceRepository();
    await acceptEverything(repo, registry, matchA, "member");
    const quietlyEdited: LegalDocumentEntry[] = registry.map((entry) => {
      if (entry.key !== "ACCOUNT_TERMS") return entry;
      const content = { ...entry.content, blocks: [...entry.content.blocks, { kind: "paragraph" as const, text: "a clause added without a new version" }] };
      return { ...entry, content, sha256: hashDocument(content) };
    });
    const status = await conditionStatus(repo, quietlyEdited, matchA, "member");
    expect(status.documents.find((d) => d.key === "ACCOUNT_TERMS")!.accepted).toBe(false);
    expect(status.satisfied).toBe(false);
  });

  it("the repository refuses to record a version again for a different text", async () => {
    const repo = new InMemoryLegalAcceptanceRepository();
    await acceptConditions(repo, registry, matchA, "member", [submission(terms)]);
    await expect(
      repo.recordAcceptance({ gamingMemberId: "member", documentKey: "ACCOUNT_TERMS", documentVersion: terms.version, contentSha256: "a".repeat(64), actType: "ACCEPTANCE", scopeMatchId: null, ageDeclared18: null, locale: "es", source: "PRE_PARTICIPATION" })
    ).rejects.toBeInstanceOf(LegalAcceptanceHashConflictError);
    expect(repo.count()).toBe(1);
  });
});

describe("defence in depth: what counts as an act does not depend on the repository having filtered it", () => {
  // A repository that returns EVERY row of the member, whatever was asked: a bug of the layer below must not be able to admit anyone.
  class ReturnsEverything extends InMemoryLegalAcceptanceRepository {
    async listForMember(gamingMemberId: string) {
      return super.listForMember(gamingMemberId);
    }
  }
  const base = { gamingMemberId: "member", locale: "es" as const, source: "PRE_PARTICIPATION" as const };

  it("a row recorded for another match's rules does not cover this match's rules", async () => {
    const repo = new ReturnsEverything();
    await repo.recordAcceptance({ ...base, documentKey: "ACCOUNT_TERMS", documentVersion: terms.version, contentSha256: terms.sha256, actType: "ACCEPTANCE", scopeMatchId: null, ageDeclared18: null });
    await repo.recordAcceptance({ ...base, documentKey: "PRIVACY_NOTICE", documentVersion: privacy.version, contentSha256: privacy.sha256, actType: "READ_ACKNOWLEDGMENT", scopeMatchId: null, ageDeclared18: null });
    await repo.recordAcceptance({ ...base, documentKey: "EVENT_RULES", documentVersion: rules.version, contentSha256: rules.sha256, actType: "ACCEPTANCE", scopeMatchId: matchB.matchId, ageDeclared18: true });
    expect((await conditionStatus(repo, registry, matchA, "member")).satisfied).toBe(false);
    expect((await conditionStatus(repo, registry, matchB, "member")).satisfied).toBe(true);
  });

  it("the same text under a new version number is a new act: the old version's row does not cover it", async () => {
    const repo = new InMemoryLegalAcceptanceRepository();
    await acceptEverything(repo, registry, matchA, "member");
    const renumbered = registry.map((entry) => ({ ...entry, version: "fixture-1-republished" })); // identical content, identical hash, another version
    const status = await conditionStatus(repo, renumbered, matchA, "member");
    expect(status.documents.every((d) => d.sha256 === registry.find((e) => e.key === d.key)!.sha256)).toBe(true);
    expect(status.documents.map((d) => d.accepted)).toEqual([false, false, false]);
    expect(status.satisfied).toBe(false);
  });

  it("a row for the event rules without the declaration of being 18 or older does not cover them, whatever wrote it", async () => {
    for (const age of [null, false]) {
      const forged = new InMemoryLegalAcceptanceRepository();
      await acceptConditions(forged, registry, matchA, "member", [submission(terms), submission(privacy)]);
      await forged.recordAcceptance({ ...base, documentKey: "EVENT_RULES", documentVersion: rules.version, contentSha256: rules.sha256, actType: "ACCEPTANCE", scopeMatchId: matchA.matchId, ageDeclared18: age });
      const status = await conditionStatus(forged, registry, matchA, "member");
      expect(status.documents.find((d) => d.key === "EVENT_RULES")!.accepted, String(age)).toBe(false);
      expect(status.satisfied).toBe(false);
    }
  });
});

describe("isolation: what one person or one event did is never counted for another", () => {
  it("another member's acceptance is not mine", async () => {
    const repo = new InMemoryLegalAcceptanceRepository();
    await acceptEverything(repo, registry, matchA, "ana");
    expect((await conditionStatus(repo, registry, matchA, "ana")).satisfied).toBe(true);
    expect((await conditionStatus(repo, registry, matchA, "beto")).satisfied).toBe(false);
    expect(await repo.listForMember("beto")).toEqual([]);
  });

  it("the rules accepted for one match do not cover another match, even one that starts at the same instant; the global texts do carry over", async () => {
    const repo = new InMemoryLegalAcceptanceRepository();
    await acceptEverything(repo, registry, matchA, "ana");
    const forB = await conditionStatus(repo, registry, matchB, "ana");
    expect(forB.documents.filter((d) => d.accepted).map((d) => d.key)).toEqual(["ACCOUNT_TERMS", "PRIVACY_NOTICE"]);
    expect(forB.satisfied).toBe(false);
    await acceptConditions(repo, registry, matchB, "ana", [submission(rules, { ageDeclared18: true })]);
    expect((await conditionStatus(repo, registry, matchB, "ana")).satisfied).toBe(true);
    // listing for one match leaves the other match's rows out
    const forA = await repo.listForMember("ana", matchA.matchId);
    expect(forA.some((r) => r.scopeMatchId === matchB.matchId)).toBe(false);
  });

  it("an event with no published rules cannot be entered, however much is accepted for other events", async () => {
    const repo = new InMemoryLegalAcceptanceRepository();
    const otherEvent = { matchId: randomUUID(), kickoffAt: "2026-11-01T20:00:00.000Z" };
    const status = await conditionStatus(repo, registry, otherEvent, "ana");
    expect(status).toMatchObject({ published: false, unpublished: ["EVENT_RULES"], satisfied: false });
    await expect(acceptConditions(repo, registry, otherEvent, "ana", [submission(terms)])).rejects.toBeInstanceOf(LegalDocumentsNotPublishedError);
    await expect(assertConditionsAccepted(repo, registry, otherEvent, "ana")).rejects.toBeInstanceOf(LegalDocumentsNotPublishedError);
    expect(repo.count()).toBe(0);
  });
});

describe("no approval, no admission", () => {
  it("an empty registry publishes nothing: nothing can be accepted and nobody is admitted", async () => {
    const repo = new InMemoryLegalAcceptanceRepository();
    const status = await conditionStatus(repo, [], matchA, "member");
    expect(status).toMatchObject({ published: false, satisfied: false, documents: [], unpublished: ["ACCOUNT_TERMS", "PRIVACY_NOTICE", "EVENT_RULES"] });
    await expect(assertConditionsAccepted(repo, [], matchA, "member")).rejects.toBeInstanceOf(LegalDocumentsNotPublishedError);
    await expect(acceptConditions(repo, [], matchA, "member", [submission(terms)])).rejects.toBeInstanceOf(LegalDocumentsNotPublishedError);
    expect(repo.count()).toBe(0);
  });

  it("one missing text is enough: with the privacy notice unpublished, even a member who accepted the other two is not admitted", async () => {
    const repo = new InMemoryLegalAcceptanceRepository();
    await acceptEverything(repo, registry, matchA, "member");
    const withoutPrivacy = registry.filter((e) => e.key !== "PRIVACY_NOTICE");
    await expect(assertConditionsAccepted(repo, withoutPrivacy, matchA, "member")).rejects.toMatchObject({ code: "LEGAL_DOCUMENTS_NOT_PUBLISHED", missing: [{ documentKey: "PRIVACY_NOTICE", documentVersion: null }] });
  });

  it("an ambiguous or tampered registry publishes nothing for that document", async () => {
    const repo = new InMemoryLegalAcceptanceRepository();
    await acceptEverything(repo, registry, matchA, "member");
    const twoCurrent = [...registry, fixtureEntry("ACCOUNT_TERMS", "fixture-9", { kind: "GLOBAL" })];
    await expect(assertConditionsAccepted(repo, twoCurrent, matchA, "member")).rejects.toBeInstanceOf(LegalDocumentsNotPublishedError);
    const tampered = registry.map((e) => (e.key === "EVENT_RULES" ? { ...e, content: { ...e.content, title: "changed" } } : e));
    await expect(assertConditionsAccepted(repo, tampered, matchA, "member")).rejects.toBeInstanceOf(LegalDocumentsNotPublishedError);
  });
});

describe("repeats and concurrent requests never duplicate", () => {
  it("asking again records nothing new and says so", async () => {
    const repo = new InMemoryLegalAcceptanceRepository();
    const first = await acceptEverything(repo, registry, matchA, "member");
    const again = await acceptEverything(repo, registry, matchA, "member");
    expect(first).toMatchObject({ recorded: 3, alreadyRecorded: 0 });
    expect(again).toMatchObject({ recorded: 0, alreadyRecorded: 3 });
    expect(repo.count()).toBe(3);
  });

  it("many requests at the same moment for the GLOBAL documents (scope NULL) end in one row each", async () => {
    const repo = new InMemoryLegalAcceptanceRepository();
    const results = await Promise.all(Array.from({ length: 40 }, () => acceptEverything(repo, registry, matchA, "member")));
    expect(repo.count()).toBe(3);
    expect(results.reduce((n, r) => n + r.recorded, 0)).toBe(3);
    expect(results.reduce((n, r) => n + r.alreadyRecorded, 0)).toBe(40 * 3 - 3);
    const global = (await repo.listForMember("member")).filter((r) => r.scopeMatchId === null);
    expect(global.map((r) => r.documentKey).sort()).toEqual(["ACCOUNT_TERMS", "PRIVACY_NOTICE"]);
  });

  it("concurrent requests from different members each get their own rows, never someone else's", async () => {
    const repo = new InMemoryLegalAcceptanceRepository();
    await Promise.all(["a", "b", "c", "d"].flatMap((member) => Array.from({ length: 10 }, () => acceptEverything(repo, registry, matchA, member))));
    expect(repo.count()).toBe(12);
    for (const member of ["a", "b", "c", "d"]) expect(await repo.listForMember(member)).toHaveLength(3);
  });
});
