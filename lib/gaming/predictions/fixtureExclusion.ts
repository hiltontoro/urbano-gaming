import { createHash } from "node:crypto";
import { EFFECTIVE_FIXTURE_EXCLUSION } from "./fixtureExclusionManifest";

/**
 * Temporary exclusion of an exact, verified set of test fixtures from the public match list and from the administration portal's
 * default view. See fixtureExclusionManifest.ts for what the set is and how it was verified.
 *
 * Deliberately NOT a rule: nothing here looks at a name, a prefix, a date, an age, an activity classification or a competition. A
 * row is excluded if and only if its id is one of the ids in the manifest. A match created later, however it is named or dated, is
 * never excluded, and a legitimate old match is never hidden because it is old.
 *
 * Nothing is deleted or altered. The exclusion is applied to the list the server has just read and BEFORE anything that depends on
 * those rows is loaded (teams, rosters, activations, venues, prize tiers, results), so an excluded row costs no further query.
 */

export type FixtureKind = "matches" | "teams" | "venues" | "activations";

export interface FixtureManifest {
  readonly manifestId: string;
  readonly fingerprints: Readonly<Record<FixtureKind, { readonly count: number; readonly sha256: string }>>;
  readonly matches: readonly string[];
  readonly teams: readonly string[];
  readonly venues: readonly string[];
  readonly activations: readonly string[];
}

const KINDS: readonly FixtureKind[] = ["matches", "teams", "venues", "activations"];

export class FixtureManifestIntegrityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FixtureManifestIntegrityError";
  }
}

/** SHA-256 of the ids sorted ascending and joined by ",": the same fingerprint the read-only inventory computed in Production. */
export function fixtureFingerprint(ids: readonly string[]): string {
  return createHash("sha256").update([...ids].sort().join(",")).digest("hex");
}

/** A manifest that excludes nothing: the catalog as it was before the exclusion. For tests and measurements only. */
export function emptyFixtureManifest(): FixtureManifest {
  const none = { count: 0, sha256: fixtureFingerprint([]) };
  return { manifestId: "none", fingerprints: { matches: none, teams: none, venues: none, activations: none }, matches: [], teams: [], venues: [], activations: [] };
}

/** Throws unless every list is free of duplicates and matches its declared count and fingerprint. */
export function verifyFixtureManifest(manifest: FixtureManifest): void {
  for (const kind of KINDS) {
    const ids = manifest[kind];
    const declared = manifest.fingerprints[kind];
    if (new Set(ids).size !== ids.length) throw new FixtureManifestIntegrityError(`${manifest.manifestId}: ${kind} has a duplicate id`);
    if (ids.length !== declared.count) throw new FixtureManifestIntegrityError(`${manifest.manifestId}: ${kind} has ${ids.length} ids, declared ${declared.count}`);
    if (fixtureFingerprint(ids) !== declared.sha256) throw new FixtureManifestIntegrityError(`${manifest.manifestId}: ${kind} does not match its fingerprint`);
  }
}

const verifiedSets = new WeakMap<object, Readonly<Record<FixtureKind, ReadonlySet<string>>>>();

function setsOf(manifest: FixtureManifest): Readonly<Record<FixtureKind, ReadonlySet<string>>> {
  let sets = verifiedSets.get(manifest);
  if (!sets) {
    verifyFixtureManifest(manifest); // an edited list that was not re-inventoried fails loudly instead of hiding the wrong rows
    sets = {
      matches: new Set(manifest.matches.map((id) => id.toLowerCase())),
      teams: new Set(manifest.teams.map((id) => id.toLowerCase())),
      venues: new Set(manifest.venues.map((id) => id.toLowerCase())),
      activations: new Set(manifest.activations.map((id) => id.toLowerCase())),
    };
    verifiedSets.set(manifest, sets);
  }
  return sets;
}

export function isFixtureId(kind: FixtureKind, id: string, manifest: FixtureManifest = EFFECTIVE_FIXTURE_EXCLUSION): boolean {
  return setsOf(manifest)[kind].has(String(id).toLowerCase());
}

/** The items whose id is not in the manifest, in their original order. */
export function excludeFixtures<T>(items: readonly T[], kind: FixtureKind, idOf: (item: T) => string, manifest: FixtureManifest = EFFECTIVE_FIXTURE_EXCLUSION): T[] {
  const excluded = setsOf(manifest)[kind];
  if (excluded.size === 0) return [...items];
  return items.filter((item) => !excluded.has(String(idOf(item)).toLowerCase()));
}

/** The administration lists show the historical test data only when it is asked for by name: ?includeFixtures=1. */
export function includeFixturesRequested(request: Request): boolean {
  try {
    return new URL(request.url).searchParams.get("includeFixtures") === "1";
  } catch {
    return false;
  }
}

/** The default administration view: fixtures excluded unless the request explicitly asks for them. */
export function visibleInAdminView<T>(
  request: Request,
  items: readonly T[],
  kind: FixtureKind,
  idOf: (item: T) => string,
  manifest: FixtureManifest = EFFECTIVE_FIXTURE_EXCLUSION
): T[] {
  return includeFixturesRequested(request) ? [...items] : excludeFixtures(items, kind, idOf, manifest);
}
