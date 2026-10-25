import { createHash } from "node:crypto";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import {
  LEGAL_DOCUMENTS,
  canonicalDocumentJson,
  entryByVersion,
  eventInstant,
  hashDocument,
  isIntact,
  legalRegistry,
  publishedEntry,
} from "../lib/gaming/legal/documents";
import { resolveRequirements } from "../lib/gaming/legal/requirements";
import { fixtureEntry, fixtureRegistry } from "./helpers/legalFixtures";

/**
 * THE TEXTS AND THEIR HASHES. Nothing is approved: the real registry is empty, so nothing is published and nobody can be admitted. The
 * machinery is proved with invented fixture texts that live only in tests.
 */

const CLASICO = "2026-10-25T20:00:00.000Z";
const GLOBAL = { kind: "GLOBAL" } as const;
const EVENT = { kind: "EVENT", kickoffAt: CLASICO } as const;

describe("the registry holds exactly the approved texts", () => {
  const PINNED = {
    "ACCOUNT_TERMS": {
      "version": "2026-10-25.1",
      "sha256": "a98420db978325fe097a1c2e75bf38f0e15b8df38852abe846587f7d5a41d5b2"
    },
    "PRIVACY_NOTICE": {
      "version": "2026-10-25.1",
      "sha256": "b2542e59a508456e3a37d9d28279c5cea5f2186b4cf1a99efd480b98ac30677d"
    },
    "EVENT_RULES": {
      "version": "2026-10-25.1",
      "sha256": "0291684f8e9340cbcb411485afdaddfb2098b8ab4f8ed604e2ead4f1e2060b87"
    }
  };

  it("has the three approved texts, each intact, with the hash that was approved, and the server's registry is that one", () => {
    expect(legalRegistry()).toBe(LEGAL_DOCUMENTS);
    expect(LEGAL_DOCUMENTS.map((entry) => entry.key).sort()).toEqual(["ACCOUNT_TERMS", "EVENT_RULES", "PRIVACY_NOTICE"]);
    for (const entry of LEGAL_DOCUMENTS) {
      expect(entry.current, entry.key).toBe(true);
      expect(entry.version, entry.key).toBe(PINNED[entry.key as keyof typeof PINNED].version);
      expect(entry.sha256, entry.key).toBe(PINNED[entry.key as keyof typeof PINNED].sha256);
      expect(isIntact(entry), entry.key).toBe(true);
      expect(hashDocument(entry.content), entry.key).toBe(entry.sha256);
    }
  });

  it("publishes the three required texts for the Clasico, and for no other kick-off the event rules", () => {
    const { required, unpublished } = resolveRequirements(legalRegistry(), { matchId: "m", kickoffAt: CLASICO });
    expect(unpublished).toEqual([]);
    expect(required.map((r) => r.key).sort()).toEqual(["ACCOUNT_TERMS", "EVENT_RULES", "PRIVACY_NOTICE"]);
    const other = resolveRequirements(legalRegistry(), { matchId: "m2", kickoffAt: "2026-11-01T20:00:00.000Z" });
    expect(other.unpublished).toEqual(["EVENT_RULES"]);
  });

  it("no draft text ships: the marker of an unfinished draft appears nowhere in the code or the public pages", () => {
    const roots = ["lib", "app", "public"];
    const hits: string[] = [];
    const walk = (dir: string) => {
      for (const name of readdirSync(dir)) {
        if (name === "node_modules" || name === ".next") continue;
        const path = join(dir, name);
        if (statSync(path).isDirectory()) walk(path);
        else if (/\.(ts|tsx|js|html|json|md)$/.test(name) && /\[PENDIENTE|NO APROBADO/.test(readFileSync(path, "utf8"))) hits.push(path);
      }
    };
    for (const root of roots) walk(root);
    expect(hits).toEqual([]);
  });
});

describe("the hash", () => {
  const content = { title: "T", blocks: [{ kind: "paragraph", text: "hello" }] } as const;

  it("is the SHA-256 of the canonical form, encoded as UTF-8 (independently recomputed)", () => {
    const canonical = canonicalDocumentJson({ title: content.title, blocks: [...content.blocks] });
    expect(canonical).toBe('["T",[["paragraph","hello"]]]');
    expect(hashDocument({ title: content.title, blocks: [...content.blocks] })).toBe(createHash("sha256").update(canonical, "utf8").digest("hex"));
  });

  it("changes with one character, with the order of the blocks, with the kind of a block and with the title", () => {
    const base = { title: "T", blocks: [{ kind: "paragraph", text: "hello" }, { kind: "paragraph", text: "world" }] } as const;
    const h = hashDocument({ title: base.title, blocks: [...base.blocks] });
    const variants = [
      { title: "T", blocks: [{ kind: "paragraph", text: "hellp" }, { kind: "paragraph", text: "world" }] },
      { title: "T", blocks: [{ kind: "paragraph", text: "world" }, { kind: "paragraph", text: "hello" }] },
      { title: "T", blocks: [{ kind: "heading", text: "hello" }, { kind: "paragraph", text: "world" }] },
      { title: "U", blocks: [{ kind: "paragraph", text: "hello" }, { kind: "paragraph", text: "world" }] },
      { title: "T", blocks: [{ kind: "list", items: ["hello"] }, { kind: "paragraph", text: "world" }] },
      { title: "T", blocks: [{ kind: "paragraph", text: "hello" }] },
    ];
    const seen = new Set([h]);
    for (const v of variants) seen.add(hashDocument(v as never));
    expect(seen.size).toBe(variants.length + 1);
  });

  it("does not confuse a list of two items with one item holding both, nor a table with the same words as a list", () => {
    const a = hashDocument({ title: "T", blocks: [{ kind: "list", items: ["a", "b"] }] });
    const b = hashDocument({ title: "T", blocks: [{ kind: "list", items: ["a,b"] }] });
    const c = hashDocument({ title: "T", blocks: [{ kind: "table", header: ["a"], rows: [["b"]] }] });
    expect(new Set([a, b, c]).size).toBe(3);
  });

  it("an entry is intact only when its pinned hash is the hash of its text", () => {
    const entry = fixtureEntry("ACCOUNT_TERMS", "v1", GLOBAL);
    expect(isIntact(entry)).toBe(true);
    expect(isIntact({ ...entry, sha256: "0".repeat(64) })).toBe(false);
    expect(isIntact({ ...entry, sha256: entry.sha256.toUpperCase() })).toBe(false);
    expect(isIntact({ ...entry, sha256: "" })).toBe(false);
    expect(isIntact({ ...entry, content: { ...entry.content, title: "edited after the hash was pinned" } })).toBe(false);
  });
});

describe("which text is the published one", () => {
  it("is the single current, intact text of that document and scope", () => {
    const registry = fixtureRegistry(CLASICO);
    expect(publishedEntry(registry, "ACCOUNT_TERMS", GLOBAL)?.version).toBe("fixture-1");
    expect(publishedEntry(registry, "EVENT_RULES", EVENT)?.version).toBe("fixture-1");
  });

  it("is nothing when there is none, when there are two current ones, or when the text was changed after its hash was pinned", () => {
    expect(publishedEntry([], "ACCOUNT_TERMS", GLOBAL)).toBeNull();
    const twice = [fixtureEntry("ACCOUNT_TERMS", "a", GLOBAL), fixtureEntry("ACCOUNT_TERMS", "b", GLOBAL)];
    expect(publishedEntry(twice, "ACCOUNT_TERMS", GLOBAL)).toBeNull(); // ambiguous: publishes nothing, never "the latest"
    const tampered = [{ ...fixtureEntry("ACCOUNT_TERMS", "a", GLOBAL), content: { title: "x", blocks: [] } }];
    expect(publishedEntry(tampered, "ACCOUNT_TERMS", GLOBAL)).toBeNull();
    const old = [fixtureEntry("ACCOUNT_TERMS", "a", GLOBAL, { current: false })];
    expect(publishedEntry(old, "ACCOUNT_TERMS", GLOBAL)).toBeNull(); // a superseded version is readable, not current
  });

  it("keys the event rules to the exact instant the event starts, however the instant is written", () => {
    const registry = fixtureRegistry(CLASICO);
    expect(publishedEntry(registry, "EVENT_RULES", { kind: "EVENT", kickoffAt: "2026-10-25T14:00:00-06:00" })?.version).toBe("fixture-1");
    for (const other of ["2026-10-25T20:00:00.001Z", "2026-10-25T19:59:59.999Z", "2026-10-26T20:00:00.000Z", "not a date", ""]) {
      expect(publishedEntry(registry, "EVENT_RULES", { kind: "EVENT", kickoffAt: other }), other).toBeNull();
    }
    expect(eventInstant("not a date")).toBeNull();
  });

  it("never lets a global scope stand for an event scope or the reverse", () => {
    const registry = fixtureRegistry(CLASICO);
    expect(publishedEntry(registry, "EVENT_RULES", GLOBAL)).toBeNull();
    expect(publishedEntry(registry, "ACCOUNT_TERMS", EVENT)).toBeNull();
  });

  it("an older version stays readable by its number; an unknown or duplicated one does not", () => {
    const older = fixtureEntry("PRIVACY_NOTICE", "v1", GLOBAL, { current: false });
    const newer = fixtureEntry("PRIVACY_NOTICE", "v2", GLOBAL);
    expect(entryByVersion([older, newer], "PRIVACY_NOTICE", "v1", GLOBAL)?.version).toBe("v1");
    expect(entryByVersion([older, newer], "PRIVACY_NOTICE", "v3", GLOBAL)).toBeNull();
    expect(entryByVersion([older, older], "PRIVACY_NOTICE", "v1", GLOBAL)).toBeNull();
  });
});
