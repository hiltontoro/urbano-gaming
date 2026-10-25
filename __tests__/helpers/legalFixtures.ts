import { hashDocument } from "../../lib/gaming/legal/documents";
import type { LegalAcceptanceRepository } from "../../lib/gaming/legal/db/legalAcceptanceRepository";
import { acceptConditions, resolveRequirements, type LegalMatchRef } from "../../lib/gaming/legal/requirements";
import type { LegalBlock, LegalDocumentEntry, LegalDocumentKey, LegalScope } from "../../lib/gaming/legal/types";

/**
 * TEST FIXTURES ONLY. These are invented placeholder texts for the machinery to chew on; they are not the Founder's drafts and they are
 * never imported by production code. The real registry (lib/gaming/legal/documents.ts) ships empty.
 */

export function fixtureBlocks(key: LegalDocumentKey, revision: string): LegalBlock[] {
  return [
    { kind: "heading", text: `Fixture ${key} (${revision})` },
    { kind: "paragraph", text: `This is test text number ${revision} for ${key}. It stands for nothing.` },
    { kind: "list", items: ["one", "two"] },
    { kind: "table", header: ["a", "b"], rows: [["1", "2"]] },
  ];
}

export function fixtureEntry(
  key: LegalDocumentKey,
  version: string,
  scope: LegalScope,
  options: { current?: boolean; revision?: string; locale?: "es" | "en" } = {}
): LegalDocumentEntry {
  const content = { title: `Fixture ${key}`, blocks: fixtureBlocks(key, options.revision ?? version) };
  return { key, version, locale: options.locale ?? "es", scope, current: options.current ?? true, sha256: hashDocument(content), content };
}

/** A complete, valid registry for the event that starts at `kickoffAt`: the two global texts and that event's rules, all at `version`. */
export function fixtureRegistry(kickoffAt: string, version = "fixture-1"): LegalDocumentEntry[] {
  return [
    fixtureEntry("ACCOUNT_TERMS", version, { kind: "GLOBAL" }),
    fixtureEntry("PRIVACY_NOTICE", version, { kind: "GLOBAL" }),
    fixtureEntry("EVENT_RULES", version, { kind: "EVENT", kickoffAt }),
  ];
}

/** The same registry with a newer version current and the older one still readable. */
export function fixtureRegistryWithNewVersion(kickoffAt: string, older = "fixture-1", newer = "fixture-2"): LegalDocumentEntry[] {
  const before = fixtureRegistry(kickoffAt, older).map((entry) => ({ ...entry, current: false }));
  return [...before, ...fixtureRegistry(kickoffAt, newer)];
}

/** What a member does in the page: accepts the current text of everything the match needs (the event rules with the age declaration). */
export async function acceptEverything(
  repo: LegalAcceptanceRepository,
  registry: ReadonlyArray<LegalDocumentEntry>,
  match: LegalMatchRef,
  gamingMemberId: string
) {
  const { required } = resolveRequirements(registry, match);
  return acceptConditions(
    repo,
    registry,
    match,
    gamingMemberId,
    required.map((doc) => ({
      documentKey: doc.key,
      documentVersion: doc.entry.version,
      contentSha256: doc.entry.sha256,
      ...(doc.key === "EVENT_RULES" ? { ageDeclared18: true } : {}),
    }))
  );
}
