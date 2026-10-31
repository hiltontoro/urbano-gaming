/**
 * The four-category Halloween contest (UG-IV-GATE-018) — fixed facts. These are literal transcriptions of the approved contract; a test pins every
 * one. Nothing here is a production schedule: the times are configuration the operator enters and the database keeps (see the schedule
 * operations); the Tegucigalpa template below only FILLS A FORM, it saves and opens nothing.
 */

export const CATEGORY_KEYS = ["MOST_ELABORATE", "SEXIEST", "BEST_GROUP", "FUNNIEST"] as const;
export type CategoryKey = (typeof CATEGORY_KEYS)[number];

export function isCategoryKey(value: unknown): value is CategoryKey {
  return typeof value === "string" && (CATEGORY_KEYS as readonly string[]).includes(value);
}

/** What a category takes: three take one person's costume, the group category takes a group (one photograph, a representative, attributed members). */
export type CandidacyKind = "INDIVIDUAL" | "GROUP";

export interface CategoryDefinition {
  key: CategoryKey;
  kind: CandidacyKind;
  /** The category's name as the pages show it. */
  name: { es: string; en: string };
  /** What the voter is asked: neutral (it never names or ranks a candidacy), in the register of the contest's pages. */
  prompt: { es: string; en: string };
}

export const CATEGORIES: Readonly<Record<CategoryKey, CategoryDefinition>> = {
  MOST_ELABORATE: {
    key: "MOST_ELABORATE",
    kind: "INDIVIDUAL",
    name: { es: "Disfraz más elaborado", en: "Most elaborate costume" },
    prompt: { es: "Elegí el disfraz más elaborado. Podés cambiar tu voto hasta que cierre la votación.", en: "Pick the most elaborate costume. You can change your vote until voting closes." },
  },
  SEXIEST: {
    key: "SEXIEST",
    kind: "INDIVIDUAL",
    name: { es: "Disfraz más sexy", en: "Sexiest costume" },
    prompt: { es: "Elegí el disfraz más sexy. Podés cambiar tu voto hasta que cierre la votación.", en: "Pick the sexiest costume. You can change your vote until voting closes." },
  },
  BEST_GROUP: {
    key: "BEST_GROUP",
    kind: "GROUP",
    name: { es: "Mejor disfraz en grupo", en: "Best group costume" },
    prompt: { es: "Elegí el mejor disfraz en grupo. Podés cambiar tu voto hasta que cierre la votación.", en: "Pick the best group costume. You can change your vote until voting closes." },
  },
  FUNNIEST: {
    key: "FUNNIEST",
    kind: "INDIVIDUAL",
    name: { es: "Disfraz más chistoso", en: "Funniest costume" },
    prompt: { es: "Elegí el disfraz más chistoso. Podés cambiar tu voto hasta que cierre la votación.", en: "Pick the funniest costume. You can change your vote until voting closes." },
  },
};

/** The ONLY public statement about prizes the contract allows. No value, no quantity, no split in a tie, no digital redemption. */
export const PRIZE_PROMISE = { es: "Habrá premios en cada categoría", en: "There will be prizes in every category" } as const;

/** The event's zone: a presentation fact of the pages (UTC−6, no daylight saving time). The database keeps instants. */
export const EVENT_TIME_ZONE = "America/Tegucigalpa";

/**
 * The approved schedule of 31 October 2026 as instants, to FILL the operator's form (a button that saves nothing and opens nothing):
 * registration 20:00–23:00 and voting 23:00 – 00:00 of 1 November, Tegucigalpa time.
 */
export const EVENT_TEMPLATE = {
  registrationOpensAt: "2026-11-01T02:00:00.000Z",
  contestantCutoffAt: "2026-11-01T05:00:00.000Z",
  votingOpensAt: "2026-11-01T05:00:00.000Z",
  votingClosesAt: "2026-11-01T06:00:00.000Z",
} as const;

/** A group has its representative and at most this many attributed members (the database enforces it). */
export const MAX_GROUP_MEMBERS = 30;
