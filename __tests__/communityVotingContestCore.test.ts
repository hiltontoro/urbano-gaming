import { readFileSync } from "node:fs";
import vm from "node:vm";

import { describe, expect, it, vi } from "vitest";

import { CATEGORIES, CATEGORY_KEYS, EVENT_TEMPLATE, EVENT_TIME_ZONE, MAX_GROUP_MEMBERS, PRIZE_PROMISE, isCategoryKey } from "../lib/gaming/communityVoting/contest/categories";
import {
  candidacyPageUrl,
  confirmRegistration,
  contestPageUrl,
  contestRegisterUrl,
  correctCandidacyName,
  findStationCandidacy,
  getCandidacyFicha,
  getContestPublicInfo,
  getDeliveryMaterial,
  getFeaturedContest,
  getMyCandidacy,
  markDelivered,
  registerAsContestant,
  registerCommunityVotingCategoryRound,
  summarizePhase,
  summarizeRegistration,
} from "../lib/gaming/communityVoting/contest/operations";
import {
  DELIVERY_SHA256,
  DELIVERY_TEXT,
  DELIVERY_VERSION,
  PUBLIC_CODE_ALPHABET,
  PUBLIC_CODE_PATTERN,
  REQUIREMENTS_SHA256,
  REQUIREMENTS_TEXT,
  REQUIREMENTS_VERSION,
  deliveryMessage,
  normalizePublicCode,
  normalizePublicName,
  normalizeWhatsapp,
  whatsappLink,
} from "../lib/gaming/communityVoting/contest/registration";
import { SupabaseContestRepository } from "../lib/gaming/communityVoting/contest/supabaseContestRepository";
import { communityVotingErrorBody, statusForCommunityVotingError } from "../lib/gaming/communityVoting/httpSupport";
import { GALLERY_CONSENT_SHA256, sha256Hex } from "../lib/gaming/communityVoting/rounds/constants";
import { CommunityVotingError } from "../lib/gaming/communityVoting/types";
import type { CommunityVotingErrorCode } from "../lib/gaming/communityVoting/types";

/**
 * UG-IV-GATE-018 — the contest's server-side operations, against in-memory fakes: what each operation validates, what it takes from the server
 * and what it never takes from a request, and the facts of the contract that a test pins one by one. The database's own rules are proven against
 * real Postgres in the contract suites; this file proves the layer between the route and the database.
 */

const ID = "11111111-2222-4333-8444-555555555555";
const INSTANCE = "aaaaaaaa-bbbb-4ccc-8ddd-000000000001";
const ENTRY = "eeeeeeee-bbbb-4ccc-8ddd-000000000009";
const AUTH_USER = "99999999-bbbb-4ccc-8ddd-000000000007";
const OPERATOR = "77777777-bbbb-4ccc-8ddd-000000000005";
const CTX = { instanceId: INSTANCE, hostToken: "host-token", operatorMemberId: OPERATOR };
const REG_OPENS = "2026-11-01T02:00:00.000Z";
const REG_CLOSES = "2026-11-01T05:00:00.000Z";
const VOTE_OPENS = "2026-11-01T05:00:00.000Z";
const VOTE_CLOSES = "2026-11-01T06:00:00.000Z";

const read = (rel: string) => readFileSync(rel, "utf8");

// ---------------------------------------------------------------- the facts of the contract

describe("the contest's fixed facts are the approved contract, one by one", () => {
  it("has exactly four categories: three for one person's costume, one for a group", () => {
    expect([...CATEGORY_KEYS]).toEqual(["MOST_ELABORATE", "SEXIEST", "BEST_GROUP", "FUNNIEST"]);
    expect(CATEGORY_KEYS.map((k) => CATEGORIES[k].name.es)).toEqual(["Más Elaborado", "Más Sexy", "Dúo o Grupo", "Más Divertido"]);
    expect(CATEGORY_KEYS.map((k) => CATEGORIES[k].name.en)).toEqual(["Most Elaborate", "Sexiest", "Duo or Group", "Funniest"]);
    expect(CATEGORY_KEYS.map((k) => CATEGORIES[k].kind)).toEqual(["INDIVIDUAL", "INDIVIDUAL", "GROUP", "INDIVIDUAL"]);
    expect(isCategoryKey("SEXIEST")).toBe(true);
    expect(isCategoryKey("BEST_COUPLE")).toBe(false);
    expect(isCategoryKey(undefined)).toBe(false);
  });

  it("asks a neutral question in every category: it names nobody, ranks nobody, and says the vote can change until the close", () => {
    for (const k of CATEGORY_KEYS) {
      expect(CATEGORIES[k].prompt.es, k).toMatch(/Podés cambiar tu voto hasta que cierre la votación\./);
      expect(CATEGORIES[k].prompt.en, k).toMatch(/You can change your vote until voting closes\./);
      expect(`${CATEGORIES[k].prompt.es} ${CATEGORIES[k].prompt.en}`, k).not.toMatch(/ganador|winner|premio|prize|favorit/i);
    }
  });

  it("makes ONE public statement about prizes, in both languages, and no other word about value, quantity or redemption", () => {
    expect(PRIZE_PROMISE).toEqual({ es: "Habrá premios en cada categoría", en: "There will be prizes in every category" });
    const server = [read("lib/gaming/communityVoting/contest/categories.ts"), read("lib/gaming/communityVoting/contest/registration.ts"), read("lib/gaming/communityVoting/contest/operations.ts")].join("\n");
    // (the property that carries the promise is named after it; every OTHER word about prizes — a value, a quantity, a redemption — is absent)
    expect(server.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "").replace(/Habrá premios en cada categoría|There will be prizes in every category|The Pub define y entrega los premios\.|prizePromise|PRIZE_PROMISE/g, "")).not.toMatch(/premio|prize|canje|redeem|redenci|\bL\.?\s?\d|\$\s?\d|cupo|capacity/i);
  });

  it("lives in Honduras: the zone is America/Tegucigalpa and the template is 20:00–23:00 registration and 23:00–midnight voting of 31 October 2026", () => {
    expect(EVENT_TIME_ZONE).toBe("America/Tegucigalpa");
    expect(EVENT_TEMPLATE).toEqual({ registrationOpensAt: REG_OPENS, contestantCutoffAt: REG_CLOSES, votingOpensAt: VOTE_OPENS, votingClosesAt: VOTE_CLOSES });
    // 8:00 p. m. Honduras (UTC-6) is 02:00 UTC of the next day; midnight is 06:00 UTC
    expect(Date.parse(REG_OPENS) - Date.UTC(2026, 9, 31, 20, 0)).toBe(6 * 3600_000);
    expect(Date.parse(VOTE_CLOSES) - Date.UTC(2026, 10, 1, 0, 0)).toBe(6 * 3600_000);
    expect(MAX_GROUP_MEMBERS).toBe(30);
  });

  it("the public-code alphabet is the database's, symbol for symbol, and has no look-alike", () => {
    const sql = read("supabase/migrations/20261031120300_community_voting_self_registration.sql");
    expect(sql).toContain(`v_alphabet constant text := '${PUBLIC_CODE_ALPHABET}'`);
    expect(PUBLIC_CODE_ALPHABET).toHaveLength(30);
    expect(PUBLIC_CODE_ALPHABET).not.toMatch(/[01ILOU]/);
    expect(new Set(PUBLIC_CODE_ALPHABET).size).toBe(30);
    // the shape check in the table and the page's pattern use the same class
    expect(sql).toContain("public_code ~ '^HAL-[2-9A-HJKMNP-TV-Z]{5}$'");
    expect(PUBLIC_CODE_PATTERN.source).toBe("^HAL-[2-9A-HJKMNP-TV-Z]{5}$");
    for (const ch of PUBLIC_CODE_ALPHABET) expect(PUBLIC_CODE_PATTERN.test(`HAL-${ch.repeat(5)}`), ch).toBe(true);
    for (const ch of "01ILOU") expect(PUBLIC_CODE_PATTERN.test(`HAL-${ch.repeat(5)}`), ch).toBe(false);
  });
});

// ---------------------------------------------------------------- the two statements a person accepts

describe("the statements a person accepts: versioned text and Founder-approved seven-day retention", () => {
  it("each digest is the SHA-256 of exactly its text, and the two are different statements", () => {
    expect(REQUIREMENTS_SHA256).toBe(sha256Hex(REQUIREMENTS_TEXT));
    expect(DELIVERY_SHA256).toBe(sha256Hex(DELIVERY_TEXT));
    expect(REQUIREMENTS_SHA256).toMatch(/^[0-9a-f]{64}$/);
    expect(DELIVERY_SHA256).not.toBe(REQUIREMENTS_SHA256);
    expect(DELIVERY_SHA256).not.toBe(GALLERY_CONSENT_SHA256); // the delivery authorization is not the photograph's consent
    expect(REQUIREMENTS_VERSION).toMatch(/^[A-Za-z0-9._-]{1,64}$/);
    expect(DELIVERY_VERSION).toMatch(/^[A-Za-z0-9._-]{1,64}$/);
    expect(REQUIREMENTS_VERSION).toBe("halloween-2026-v2-requirements-7days");
    expect(DELIVERY_VERSION).toMatch(/draft/);
  });

  it("says what the Founder decided and nothing else: adults, once, one category, when the candidacy becomes public, no self-vote, the whole group accepts", () => {
    for (const must of [/mayor de edad/, /The Pub by Beer Box/, /una sola vez y en una sola categoría/, /solo después de que el equipo del concurso verifique en la estación mi nombre y mi categoría/, /tome mi fotografía/, /no puedo votar por mi propia candidatura/, /todas las personas que aparecen en la fotografía deben aceptar/]) expect(REQUIREMENTS_TEXT).toMatch(must);
  });

  it("the delivery authorization is manual, from the team's own WhatsApp, separate from marketing and from the photograph's consent, and the number serves nothing else", () => {
    for (const must of [/de forma manual/, /su propio WhatsApp/, /fotografía, mi código y el enlace/, /no es una autorización de publicidad ni de marketing/i, /tampoco autoriza el uso de mi imagen/, /no se usa para votar ni para identificarme/]) expect(DELIVERY_TEXT).toMatch(must);
  });

  it("applies seven days to photos, WhatsApps and winners without extending marketing permission", () => {
    expect(REQUIREMENTS_TEXT).toContain("7 días desde el cierre del concurso");
    expect(REQUIREMENTS_TEXT).toContain("también para las fotos de ganadores");
    expect(REQUIREMENTS_TEXT).toContain("El uso promocional es opcional y no amplía ese plazo");
    expect(REQUIREMENTS_TEXT).not.toMatch(/30 días|72 horas/);
  });
});

// ---------------------------------------------------------------- normalizers

describe("a public name, a WhatsApp number, a public code, a delivery message", () => {
  it("trims a name and keeps it between 2 and 40 characters, with no control character", () => {
    expect(normalizePublicName("  Drácula de Tegucigalpa ")).toBe("Drácula de Tegucigalpa");
    expect(normalizePublicName("Zé")).toBe("Zé");
    expect(normalizePublicName("X")).toBeNull();
    expect(normalizePublicName("   ")).toBeNull();
    expect(normalizePublicName("x".repeat(40))).toHaveLength(40);
    expect(normalizePublicName("x".repeat(41))).toBeNull();
    expect(normalizePublicName("Drac\u0007ula")).toBeNull();
    expect(normalizePublicName("línea\nnueva")).toBeNull();
    expect(normalizePublicName("👻👻")).toBe("👻👻"); // characters, not UTF-16 units
    expect(normalizePublicName(42)).toBeNull();
    expect(normalizePublicName(undefined)).toBeNull();
  });

  it("normalizes a WhatsApp number to E.164 and refuses one without its country code", () => {
    expect(normalizeWhatsapp("+504 9988-7766")).toBe("+50499887766");
    expect(normalizeWhatsapp("00504 (9988) 7766")).toBe("+50499887766");
    expect(normalizeWhatsapp(" +1 202.555.0143 ")).toBe("+12025550143");
    for (const bad of ["99887766", "9988-7766", "+0499887766", "+5049988", "+5049988776655443", "+504ABCDEFGH", "", "+", "++50499887766", "+504 9988 7766 ext 3", 99887766, null, undefined]) expect(normalizeWhatsapp(bad as never), String(bad)).toBeNull();
    expect(normalizeWhatsapp("+" + "9".repeat(60))).toBeNull();
  });

  it("types a code any way a person does and never matches a look-alike", () => {
    expect(normalizePublicCode("hal k7m2q")).toBe("HAL-K7M2Q");
    expect(normalizePublicCode("HALK7M2Q")).toBe("HAL-K7M2Q");
    expect(normalizePublicCode("HAL-K7M2O")).toBeNull();
    expect(normalizePublicCode("HAL-K7M2")).toBeNull();
    expect(normalizePublicCode(null)).toBeNull();
  });

  it("composes the delivery message with the code and the link, and NEVER claims a picture is attached", () => {
    const msg = deliveryMessage({ publicName: "Drácula", publicCode: "HAL-K7M2Q", ficheUrl: "https://gaming.urbanohn.com/community-voting-round.html?c=1&codigo=HAL-K7M2Q" });
    expect(msg).toBe("Hola Drácula, te escribimos del concurso de disfraces de The Pub by Beer Box. Tu código de candidatura es HAL-K7M2Q. Aquí está tu ficha: https://gaming.urbanohn.com/community-voting-round.html?c=1&codigo=HAL-K7M2Q");
    expect(msg).not.toMatch(/adjunt|foto|imagen|attached/i);
    expect(deliveryMessage({ publicName: null, publicCode: "HAL-K7M2Q", ficheUrl: "https://x" })).toMatch(/^Hola, te escribimos/);
  });

  it("builds a wa.me link addressed to the digits of the number, with the message encoded", () => {
    const link = whatsappLink("+50499887766", "Hola Ñandú & co: ¿ok?");
    expect(link).toBe(`https://wa.me/50499887766?text=${encodeURIComponent("Hola Ñandú & co: ¿ok?")}`);
    expect(new URL(link).host).toBe("wa.me");
    expect(new URL(link).pathname).toBe("/50499887766");
  });
});

// ---------------------------------------------------------------- the operations, over a fake repository

function fakeRepo(over: Record<string, unknown> = {}) {
  const calls: Array<[string, unknown]> = [];
  const rec = (name: string, value: unknown) => vi.fn(async (input: unknown) => { calls.push([name, input]); return typeof value === "function" ? (value as (i: unknown) => unknown)(input) : value; });
  const repo = {
    bindVoter: rec("bindVoter", { bindingId: "b1", instanceId: INSTANCE, created: true }),
    registerCandidacy: rec("registerCandidacy", { entryId: ENTRY, categoryKey: "MOST_ELABORATE", publicCode: "HAL-K7M2Q", publicName: "Drácula", kind: "INDIVIDUAL" }),
    readCategoryOf: rec("readCategoryOf", { contestId: ID, categoryKey: "MOST_ELABORATE" }),
    readMyCandidacy: rec("readMyCandidacy", null),
    readCandidacyByCode: rec("readCandidacyByCode", null),
    readRoundPublicInfo: rec("readRoundPublicInfo", null),
    findCandidacyByCode: rec("findCandidacyByCode", null),
    confirmRegistration: rec("confirmRegistration", { entryId: ENTRY, confirmed: true }),
    readRegistrationContact: rec("readRegistrationContact", { whatsapp: "+50499887766", deliveryStatus: "PENDING" }),
    readCategoryStructure: rec("readCategoryStructure", [{ entryId: ENTRY, kind: "INDIVIDUAL", publicCode: "HAL-K7M2Q", publicName: "Drácula" }]),
    markRegistrationDelivered: rec("markRegistrationDelivered", { entryId: ENTRY, deliveryStatus: "DELIVERED", deliveredAt: "2026-11-01T03:00:00.000Z" }),
    correctCandidacyName: rec("correctCandidacyName", { entryId: ENTRY, publicName: "Nombre" }),
    readContestCategories: rec("readContestCategories", []),
    readFeaturedContest: rec("readFeaturedContest", null),
    ...over,
  };
  return { repo: repo as unknown as SupabaseContestRepository, calls, raw: repo as Record<string, ReturnType<typeof vi.fn>> };
}
const voterDeps = (over: { verified?: boolean; token?: string | null; member?: boolean } = {}) => ({
  repo: {} as never,
  emailVerifier: { verifyAccessToken: vi.fn(async (t: string) => (t === (over.token ?? "good") ? { authUserId: AUTH_USER, emailVerified: over.verified ?? true } : null)) },
  gamingRepo: { resolveGamingMemberByAuthUserId: vi.fn(async () => (over.member === false ? null : { gamingMemberId: "m1", authUserId: AUTH_USER, displayName: "X", createdAt: "" })), createGamingMember: vi.fn() } as never,
});
const goodBody = () => ({
  publicName: " Drácula de Tegucigalpa ", adultConfirmed: true, requirementsAccepted: true, requirementsVersion: REQUIREMENTS_VERSION,
  whatsapp: "+504 9988-7766", whatsappConfirmed: true, deliveryAuthorized: true, deliveryVersion: DELIVERY_VERSION,
});
const rejectsWith = async (p: Promise<unknown>, code: CommunityVotingErrorCode) => { await expect(p).rejects.toMatchObject({ name: "CommunityVotingError", code }); };

describe("self-registration: the identity is the server's, the texts are the server's, and the request chooses nothing else", () => {
  it("binds the caller, registers them with the normalized values and the SERVER's digests, and answers with the code and the link — never the number", async () => {
    const { repo, calls, raw } = fakeRepo();
    const out = await registerAsContestant(repo, voterDeps(), "Bearer good", INSTANCE, goodBody());
    expect(calls.map(([n]) => n)).toEqual(["bindVoter", "registerCandidacy", "readCategoryOf"]);
    expect(raw.bindVoter).toHaveBeenCalledWith({ instanceId: INSTANCE, authUserId: AUTH_USER });
    expect(raw.registerCandidacy).toHaveBeenCalledWith({
      instanceId: INSTANCE, authUserId: AUTH_USER, publicName: "Drácula de Tegucigalpa", adultConfirmed: true,
      requirementsVersion: REQUIREMENTS_VERSION, requirementsSha256: REQUIREMENTS_SHA256, whatsapp: "+50499887766", whatsappConfirmed: true,
      deliveryVersion: DELIVERY_VERSION, deliverySha256: DELIVERY_SHA256, deliveryAuthorized: true,
    });
    expect(out.candidacy).toMatchObject({ entryId: ENTRY, publicCode: "HAL-K7M2Q", state: "REGISTERED", deliveryStatus: "PENDING" });
    expect(out.candidacy.ficheUrl).toBe(`/community-voting-round.html?c=${ID}&codigo=HAL-K7M2Q`);
    expect(JSON.stringify(out)).not.toMatch(/9988|whatsapp|authUser|email/i);
  });

  it("takes the person from the verified token only: no token, a forged token, an unverified e-mail or no profile each stop it before anything is written", async () => {
    for (const [label, header, deps, code] of [
      ["no header", null, voterDeps(), "AUTHENTICATION_REQUIRED"],
      ["not a bearer", "Basic abc", voterDeps(), "AUTHENTICATION_REQUIRED"],
      ["a forged token", "Bearer forged", voterDeps(), "AUTHENTICATION_REQUIRED"],
      ["an unverified e-mail", "Bearer good", voterDeps({ verified: false }), "VERIFIED_EMAIL_REQUIRED"],
      ["no Gaming profile", "Bearer good", voterDeps({ member: false }), "PROFILE_INCOMPLETE"],
    ] as const) {
      const { repo, calls } = fakeRepo();
      await rejectsWith(registerAsContestant(repo, deps, header, INSTANCE, goodBody()), code);
      expect(calls, label).toEqual([]);
    }
  });

  it("never accepts an identity, a role, a category or a position from the body", async () => {
    for (const forbidden of ["location", "latitude", "longitude", "coordinates", "phoneOtp", "otp", "authUserId", "gamingMemberId", "role", "categoryKey"]) {
      const { repo, calls } = fakeRepo();
      await rejectsWith(registerAsContestant(repo, voterDeps(), "Bearer good", INSTANCE, { ...goodBody(), [forbidden]: "x" }), "INVALID_REQUEST");
      expect(calls, forbidden).toEqual([]);
    }
  });

  it("refuses a stale page (an older text), a bad name, a bad number, and every missing confirmation — each before the database is touched", async () => {
    const attempts: Array<[string, Record<string, unknown>, CommunityVotingErrorCode]> = [
      ["an older requirements text", { requirementsVersion: "halloween-2026-v0" }, "INVALID_REQUEST"],
      ["an older delivery text", { deliveryVersion: "halloween-2026-v0" }, "INVALID_REQUEST"],
      ["a one-letter name", { publicName: "X" }, "INVALID_REQUEST"],
      ["no name", { publicName: undefined }, "INVALID_REQUEST"],
      ["a number without its country code", { whatsapp: "99887766" }, "INVALID_REQUEST"],
      ["a number that is not one", { whatsapp: "hola" }, "INVALID_REQUEST"],
      ["no age confirmation", { adultConfirmed: false }, "CONSENT_REQUIRED"],
      ["requirements not accepted", { requirementsAccepted: false }, "CONSENT_REQUIRED"],
      ["a number the person did not confirm", { whatsappConfirmed: false }, "CONSENT_REQUIRED"],
      ["no delivery authorization", { deliveryAuthorized: false }, "CONSENT_REQUIRED"],
      ["a confirmation sent as text", { whatsappConfirmed: "true" }, "CONSENT_REQUIRED"],
    ];
    for (const [label, over, code] of attempts) {
      const { repo, calls } = fakeRepo();
      await rejectsWith(registerAsContestant(repo, voterDeps(), "Bearer good", INSTANCE, { ...goodBody(), ...over }), code);
      expect(calls, label).toEqual([]);
    }
    const { repo } = fakeRepo();
    await rejectsWith(registerAsContestant(repo, voterDeps(), "Bearer good", "not-an-id", goodBody()), "INSTANCE_NOT_FOUND");
    await rejectsWith(registerAsContestant(repo, voterDeps(), "Bearer good", INSTANCE, "text"), "INVALID_REQUEST");
    await rejectsWith(registerAsContestant(repo, voterDeps(), "Bearer good", INSTANCE, [1]), "INVALID_REQUEST");
  });

  it("lets the database's refusal through as its own typed error — the window, the cutoff, the second candidacy — and the second attempt is not retried", async () => {
    for (const code of ["ALREADY_CANDIDATE", "REGISTRATION_NOT_OPEN", "CUTOFF_PASSED", "PREPARATION_CLOSED", "SCHEDULE_REQUIRED"] as const) {
      const { repo, raw } = fakeRepo({ registerCandidacy: vi.fn(async () => { throw new CommunityVotingError(code); }) });
      await rejectsWith(registerAsContestant(repo, voterDeps(), "Bearer good", INSTANCE, goodBody()), code);
      expect(raw.registerCandidacy).toHaveBeenCalledTimes(1);
    }
  });
});

describe("a person's own candidacy, and a candidacy's public ficha", () => {
  it("reads the caller's OWN candidacy with the server's identity, names its category and its ficha — and never a number", async () => {
    const mine = { categoryKey: "SEXIEST", instanceId: INSTANCE, role: "INDIVIDUAL", kind: "INDIVIDUAL", publicCode: "HAL-K7M2Q", publicName: "Drácula", state: "REGISTERED", deliveryStatus: "PENDING" };
    const { repo, raw } = fakeRepo({ readMyCandidacy: vi.fn(async () => mine) });
    const out = await getMyCandidacy(repo, voterDeps(), "Bearer good", ID);
    expect(raw.readMyCandidacy).toHaveBeenCalledWith(ID, AUTH_USER);
    expect(out.candidacy).toMatchObject({ publicCode: "HAL-K7M2Q", categoryName: { es: "Más Sexy" }, ficheUrl: `/community-voting-round.html?c=${ID}&codigo=HAL-K7M2Q` });
    expect(JSON.stringify(out)).not.toMatch(/whatsapp|\+504|authUser|email/i);
    expect((await getMyCandidacy(fakeRepo().repo, voterDeps(), "Bearer good", ID)).candidacy).toBeNull();
    await rejectsWith(getMyCandidacy(fakeRepo().repo, voterDeps(), null, ID), "AUTHENTICATION_REQUIRED");
    await rejectsWith(getMyCandidacy(fakeRepo().repo, voterDeps(), "Bearer good", "nope"), "CONTEST_NOT_FOUND");
  });

  const publicInfo = (over: Record<string, unknown> = {}) => ({
    roundRole: "PRELIMINARY", sessionState: "LOBBY_LOCKED", interactionState: null, openedAt: null, windowSeconds: null, deadlineAt: VOTE_CLOSES, serverNow: "2026-11-01T04:00:00.000Z",
    locationRequired: false, registrationOpensAt: REG_OPENS, contestantCutoffAt: REG_CLOSES, votingOpensAt: VOTE_OPENS, votingClosesAt: VOTE_CLOSES, scheduleStatus: "CONFIRMED",
    approvedContestants: 3, closed: false, published: false, isTest: false, ...over,
  });
  const found = { categoryKey: "SEXIEST", instanceId: INSTANCE, alias: "#4821", candidateId: null, ordinal: 1, publicCode: "HAL-K7M2Q", publicName: "Vampiresa" };

  it("answers a public ficha with what the gallery shows and where the category stands in time, and nothing that identifies a person", async () => {
    const { repo, raw } = fakeRepo({ readCandidacyByCode: vi.fn(async () => found), readRoundPublicInfo: vi.fn(async () => publicInfo()) });
    const out = await getCandidacyFicha(repo, ID, "hal k7m2q");
    expect(raw.readCandidacyByCode).toHaveBeenCalledWith(ID, "HAL-K7M2Q");
    expect(out.candidacy).toMatchObject({
      code: "HAL-K7M2Q", name: "Vampiresa", category: { key: "SEXIEST", instanceId: INSTANCE, kind: "INDIVIDUAL" },
      thumbUrl: `/api/gaming/community-voting/rounds/${INSTANCE}/photos/4821?v=thumb`, imageUrl: `/api/gaming/community-voting/rounds/${INSTANCE}/photos/4821?v=full`,
      ficheUrl: `/community-voting-round.html?c=${ID}&codigo=HAL-K7M2Q`,
    });
    expect(out.voting).toMatchObject({ phase: "NOT_OPEN", published: false, votingOpensAt: VOTE_OPENS, votingClosesAt: VOTE_CLOSES, pageUrl: `/community-voting-round.html?c=${ID}` });
    expect(out.prizePromise).toEqual(PRIZE_PROMISE);
    expect(JSON.stringify(out)).not.toMatch(/whatsapp|authUser|email|binding|candidateId|#4821/i);
  });

  it("says the same «not found» for an unknown code, a malformed one and a candidacy that is not public — nothing tells them apart", async () => {
    const unknown = fakeRepo({ readCandidacyByCode: vi.fn(async () => null) });
    await rejectsWith(getCandidacyFicha(unknown.repo, ID, "HAL-22222"), "ENTRY_NOT_FOUND");
    await rejectsWith(getCandidacyFicha(unknown.repo, ID, "HAL-0OIL1"), "ENTRY_NOT_FOUND");
    expect(unknown.raw.readCandidacyByCode).toHaveBeenCalledTimes(1); // the malformed one never reached the database
    await rejectsWith(getCandidacyFicha(unknown.repo, "not-an-id", "HAL-22222"), "CONTEST_NOT_FOUND");
    const messages = await Promise.all([getCandidacyFicha(unknown.repo, ID, "HAL-22222"), getCandidacyFicha(unknown.repo, ID, "HAL-0OIL1")].map((p) => p.catch((e: Error) => e.message)));
    expect(new Set(messages).size).toBe(1);
  });

  it("reflects an open category's deadline and a published result, by the server's clock", async () => {
    const open = fakeRepo({ readCandidacyByCode: vi.fn(async () => found), readRoundPublicInfo: vi.fn(async () => publicInfo({ sessionState: "LOBBY_LOCKED", interactionState: "PROMPT_ACTIVE", openedAt: VOTE_OPENS, serverNow: "2026-11-01T05:30:00.000Z" })) });
    const o = await getCandidacyFicha(open.repo, ID, "HAL-K7M2Q");
    expect(o.voting.phase).toBe("OPEN");
    expect(o.voting.deadlineRemainingMs).toBe(30 * 60_000);
    const closed = fakeRepo({ readCandidacyByCode: vi.fn(async () => found), readRoundPublicInfo: vi.fn(async () => publicInfo({ closed: true, published: true, interactionState: "SUBMISSIONS_CLOSED", serverNow: "2026-11-01T06:10:00.000Z" })) });
    const c = await getCandidacyFicha(closed.repo, ID, "HAL-K7M2Q");
    expect(c.voting).toMatchObject({ phase: "CLOSED", published: true });
  });
});

describe("the station: search a code, confirm the person, rename, read the delivery number, mark delivered", () => {
  it("searches by the normalized code only; an invalid code never reaches the database and says so", async () => {
    const { repo, raw } = fakeRepo({ findCandidacyByCode: vi.fn(async () => ({ entryId: ENTRY, instanceId: INSTANCE, categoryKey: "SEXIEST", kind: "INDIVIDUAL", publicCode: "HAL-K7M2Q", publicName: "V", selfRegistered: true, hasWhatsapp: true, deliveryStatus: "PENDING", withdrawn: false, createdAt: "x" })) });
    const hit = await findStationCandidacy(repo, CTX, " hal-k7m2q ");
    expect(raw.findCandidacyByCode).toHaveBeenCalledWith({ ...CTX, code: "HAL-K7M2Q" });
    expect(hit).toMatchObject({ valid: true, candidacy: { categoryName: { es: "Más Sexy" }, hasWhatsapp: true } });
    expect(JSON.stringify(hit)).not.toMatch(/\+504|99887766/);
    expect(await findStationCandidacy(repo, CTX, "HAL-0OIL1")).toEqual({ valid: false, candidacy: null });
    expect(await findStationCandidacy(repo, CTX, undefined)).toEqual({ valid: false, candidacy: null });
    expect(raw.findCandidacyByCode).toHaveBeenCalledTimes(1);
    const none = await findStationCandidacy(fakeRepo().repo, CTX, "HAL-22222");
    expect(none).toEqual({ valid: true, candidacy: null });
  });

  it("confirms, renames and marks delivered only for an entry that is an id, and validates the name's shape before the database", async () => {
    const { repo, raw } = fakeRepo();
    await confirmRegistration(repo, CTX, ENTRY);
    expect(raw.confirmRegistration).toHaveBeenCalledWith({ ...CTX, entryId: ENTRY });
    await markDelivered(repo, CTX, ENTRY);
    expect(raw.markRegistrationDelivered).toHaveBeenCalledWith({ ...CTX, entryId: ENTRY });
    await correctCandidacyName(repo, CTX, ENTRY, { publicName: "  Nuevo Nombre " });
    expect(raw.correctCandidacyName).toHaveBeenCalledWith({ ...CTX, entryId: ENTRY, publicName: "Nuevo Nombre" });
    expect(() => confirmRegistration(repo, CTX, "x")).toThrow(CommunityVotingError);
    expect(() => markDelivered(repo, CTX, "x")).toThrow(CommunityVotingError);
    expect(() => correctCandidacyName(repo, CTX, "x", { publicName: "Ok" })).toThrow(CommunityVotingError);
    expect(() => correctCandidacyName(repo, CTX, ENTRY, { publicName: "X" })).toThrow(/2 to 40|2 a 40|name/i);
    expect(() => correctCandidacyName(repo, CTX, ENTRY, "Nombre")).toThrow();
  });

  it("gives the operator the number, the status and a ready message with a wa.me link — composed from the candidacy's own code and the request's origin", async () => {
    const { repo, raw } = fakeRepo();
    const out = await getDeliveryMaterial(repo, CTX, ENTRY, "https://gaming.urbanohn.com");
    expect(raw.readRegistrationContact).toHaveBeenCalledWith({ ...CTX, entryId: ENTRY });
    expect(out).toMatchObject({ whatsapp: "+50499887766", deliveryStatus: "PENDING", publicCode: "HAL-K7M2Q", publicName: "Drácula" });
    expect(out.ficheUrl).toBe(`https://gaming.urbanohn.com/community-voting-round.html?c=${ID}&codigo=HAL-K7M2Q`);
    expect(out.message).toBe(`Hola Drácula, te escribimos del concurso de disfraces de The Pub by Beer Box. Tu código de candidatura es HAL-K7M2Q. Aquí está tu ficha: ${out.ficheUrl}`);
    expect(out.whatsappUrl).toBe(`https://wa.me/50499887766?text=${encodeURIComponent(out.message)}`);
    expect(out.message).not.toMatch(/adjunt|foto/i);
  });

  it("refuses to compose material for an entry the structure does not show (a member, or another round's), after the database has audited nothing wrong", async () => {
    const { repo } = fakeRepo({ readCategoryStructure: vi.fn(async () => []) });
    await rejectsWith(getDeliveryMaterial(repo, CTX, ENTRY, "https://x.test"), "ENTRY_NOT_FOUND");
    await expect(Promise.resolve().then(() => getDeliveryMaterial(fakeRepo().repo, CTX, "x", "https://x.test"))).rejects.toMatchObject({ code: "ENTRY_NOT_FOUND" });
  });
});

// ---------------------------------------------------------------- the contest's public state

describe("what the contest tells the public: phases by the server's clock, the registration window, the texts, the links", () => {
  type Ph = "NOT_OPEN" | "OPEN" | "CLOSED" | "ENDED";
  const cat = (key: string, phase: Ph, over: Partial<{ registrationOpensAt: string | null; contestantCutoffAt: string | null; serverNow: string; published: boolean }> = {}) => ({ key, phase, published: false, registrationOpensAt: REG_OPENS as string | null, contestantCutoffAt: REG_CLOSES as string | null, serverNow: "2026-11-01T03:00:00.000Z", ...over });

  it("registration is OPEN between its two instants, NOT_OPEN before, CLOSED after the cutoff and for good once any category votes, and NOT_SCHEDULED without both times", () => {
    const at = (now: string, phase: Ph = "NOT_OPEN") => summarizeRegistration([cat("A", phase, { serverNow: now }), cat("B", "NOT_OPEN", { serverNow: now })]);
    expect(at("2026-11-01T01:59:59.000Z")).toMatchObject({ phase: "NOT_OPEN", opensAt: REG_OPENS, closesAt: REG_CLOSES });
    expect(at("2026-11-01T02:00:00.000Z").phase).toBe("OPEN");
    expect(at("2026-11-01T04:59:59.000Z").phase).toBe("OPEN");
    expect(at("2026-11-01T05:00:00.000Z").phase).toBe("CLOSED"); // the cutoff instant itself is already closed
    expect(at("2026-11-01T03:00:00.000Z", "OPEN").phase).toBe("CLOSED"); // a category voting closes registration, whatever the clock says
    expect(summarizeRegistration([cat("A", "NOT_OPEN", { registrationOpensAt: null, contestantCutoffAt: null })])).toEqual({ phase: "NOT_SCHEDULED", opensAt: null, closesAt: null });
    expect(summarizeRegistration([cat("A", "NOT_OPEN", { contestantCutoffAt: null })]).phase).toBe("NOT_SCHEDULED");
  });

  it("takes the earliest opening and the latest cutoff of the categories", () => {
    const r = summarizeRegistration([cat("A", "NOT_OPEN", { registrationOpensAt: "2026-11-01T03:00:00.000Z", contestantCutoffAt: "2026-11-01T04:00:00.000Z" }), cat("B", "NOT_OPEN", { registrationOpensAt: "2026-11-01T02:30:00.000Z", contestantCutoffAt: "2026-11-01T05:00:00.000Z" })]);
    expect(r).toMatchObject({ opensAt: "2026-11-01T02:30:00.000Z", closesAt: "2026-11-01T05:00:00.000Z" });
  });

  it("one word for the whole contest: OPEN while any category is open, CLOSED after, RESULTS when everything opened is published", () => {
    const c = (phase: "NOT_OPEN" | "OPEN" | "CLOSED" | "ENDED", published = false) => ({ phase, published });
    expect(summarizePhase([c("NOT_OPEN"), c("NOT_OPEN")])).toBe("NOT_OPEN");
    expect(summarizePhase([c("OPEN"), c("NOT_OPEN")])).toBe("OPEN");
    expect(summarizePhase([c("CLOSED"), c("OPEN")])).toBe("OPEN");
    expect(summarizePhase([c("CLOSED"), c("CLOSED")])).toBe("CLOSED");
    expect(summarizePhase([c("CLOSED", true), c("CLOSED", false)])).toBe("CLOSED");
    expect(summarizePhase([c("CLOSED", true), c("CLOSED", true), c("NOT_OPEN")])).toBe("RESULTS"); // a category that never opened does not hold the results back
    expect(summarizePhase([])).toBe("NOT_OPEN");
  });

  it("builds the three addresses of the contest page from its id alone, all relative to the same site", () => {
    expect(contestPageUrl(ID)).toBe(`/community-voting-round.html?c=${ID}`);
    expect(contestRegisterUrl(ID)).toBe(`/community-voting-round.html?c=${ID}&participar=1`);
    expect(candidacyPageUrl(ID, "HAL-K7M2Q")).toBe(`/community-voting-round.html?c=${ID}&codigo=HAL-K7M2Q`);
    for (const url of [contestPageUrl(ID), contestRegisterUrl(ID), candidacyPageUrl(ID, "HAL-K7M2Q")]) expect(url.startsWith("/")).toBe(true);
    expect(candidacyPageUrl(ID, "a b&c")).toContain("codigo=a%20b%26c");
  });

  const infoFor = (phase: string) => ({
    roundRole: "PRELIMINARY", sessionState: phase === "OPEN" ? "LOBBY_LOCKED" : "LOBBY_OPEN", interactionState: phase === "OPEN" ? "PROMPT_ACTIVE" : null, openedAt: phase === "OPEN" ? VOTE_OPENS : null, windowSeconds: null,
    deadlineAt: VOTE_CLOSES, serverNow: "2026-11-01T03:00:00.000Z", locationRequired: false, registrationOpensAt: REG_OPENS, contestantCutoffAt: REG_CLOSES, votingOpensAt: VOTE_OPENS, votingClosesAt: VOTE_CLOSES,
    scheduleStatus: "TENTATIVE", approvedContestants: 2, closed: false, published: false, isTest: false,
  });
  const refs = CATEGORY_KEYS.map((k, i) => ({ categoryKey: k, instanceId: `00000000-0000-4000-8000-00000000000${i + 1}`, listed: true, purpose: "LIVE" as const, registrationOpened: true }));

  it("keeps public registration closed without the explicit opening, even inside its scheduled window", async () => {
    const { repo } = fakeRepo({ readContestCategories: vi.fn(async () => refs.map((r) => ({ ...r, registrationOpened: false }))), readRoundPublicInfo: vi.fn(async () => infoFor("NOT_OPEN")) });
    expect((await getContestPublicInfo(repo, ID)).registration).toMatchObject({ phase: "NOT_OPEN", manualOpened: false });
  });

  it("describes the contest to anyone: the four categories, their phase, the registration, the plan, the three texts and the ONE sentence about prizes — and no count, rank, total, venue or location", async () => {
    const { repo } = fakeRepo({ readContestCategories: vi.fn(async () => refs), readRoundPublicInfo: vi.fn(async () => infoFor("NOT_OPEN")) });
    const out = await getContestPublicInfo(repo, ID);
    expect(out.categories.map((c) => c.key)).toEqual([...CATEGORY_KEYS]);
    expect(out).toMatchObject({ contestId: ID, listed: true, timeZone: "America/Tegucigalpa", prizePromise: PRIZE_PROMISE, phase: "NOT_OPEN", registration: { phase: "OPEN", opensAt: REG_OPENS, closesAt: REG_CLOSES } });
    expect(out.categories[0]).toMatchObject({ phase: "NOT_OPEN", tentative: true, approvedCandidacies: 2, votingOpensAt: VOTE_OPENS, votingClosesAt: VOTE_CLOSES });
    expect(out.texts.requirements).toEqual({ version: REQUIREMENTS_VERSION, text: REQUIREMENTS_TEXT });
    expect(out.texts.whatsappDelivery).toEqual({ version: DELIVERY_VERSION, text: DELIVERY_TEXT });
    expect(out.texts.galleryConsent.version).toMatch(/gallery/);
    expect(JSON.stringify(out)).not.toMatch(/venue|latitude|longitude|geofence|isTest|locationRequired|roundRole|finalist|rank|totalVotes|voteCount|whatsapp_e164|authUser/i);
    await rejectsWith(getContestPublicInfo(fakeRepo().repo, ID), "CONTEST_NOT_FOUND");
    await rejectsWith(getContestPublicInfo(repo, "no"), "CONTEST_NOT_FOUND");
  });

  it("featured: nothing when no contest is listed — never a link to an event that is not there — and the two entries when one is", async () => {
    expect(await getFeaturedContest(fakeRepo().repo)).toEqual({ featured: null });
    const { repo } = fakeRepo({ readFeaturedContest: vi.fn(async () => ID), readContestCategories: vi.fn(async () => refs), readRoundPublicInfo: vi.fn(async () => infoFor("NOT_OPEN")) });
    const out = await getFeaturedContest(repo);
    expect(out.featured).toMatchObject({
      contestId: ID, voteUrl: `/community-voting-round.html?c=${ID}`, registerUrl: `/community-voting-round.html?c=${ID}&participar=1`, phase: "NOT_OPEN",
      registration: { phase: "OPEN" }, prizePromise: PRIZE_PROMISE,
    });
    expect(out.featured!.categories).toHaveLength(4);
    expect(Object.keys(out.featured!.categories[0]).sort()).toEqual(["key", "name", "phase", "votingClosesAt", "votingOpensAt"]);
  });

  it("featured: the Home's own reader (public/featuredContest.js) accepts exactly what this endpoint answers, in every phase — and turns the buttons off the moment a field drifts", async () => {
    const win: Record<string, unknown> = {};
    vm.runInNewContext(read("public/featuredContest.js"), { window: win });
    type Seen = { vote: string; join: string; phase: string; registration: string; names: Array<{ es: string; en: string }> };
    const validate = (win.UrbanoFeaturedContest as { validate: (data: unknown) => Seen | null }).validate;
    const answerFor = async (info: Record<string, unknown>) =>
      JSON.parse(JSON.stringify(await getFeaturedContest(fakeRepo({ readFeaturedContest: vi.fn(async () => ID), readContestCategories: vi.fn(async () => refs), readRoundPublicInfo: vi.fn(async () => info) }).repo)));
    const open = infoFor("OPEN");
    for (const [phase, info] of [["NOT_OPEN", infoFor("NOT_OPEN")], ["OPEN", open], ["CLOSED", { ...open, closed: true }], ["RESULTS", { ...open, closed: true, published: true }]] as const) {
      const seen = validate(await answerFor(info));
      expect(seen, phase).not.toBeNull();
      expect(seen).toMatchObject({ vote: contestPageUrl(ID), join: contestRegisterUrl(ID), phase });
      expect(seen!.names).toEqual(CATEGORY_KEYS.map((k) => CATEGORIES[k].name));
    }
    for (const [registration, over] of [["NOT_OPEN", { serverNow: "2026-11-01T01:00:00.000Z" }], ["OPEN", {}], ["CLOSED", { serverNow: "2026-11-01T05:30:00.000Z" }], ["NOT_SCHEDULED", { registrationOpensAt: null, contestantCutoffAt: null }]] as const) {
      expect(validate(await answerFor({ ...infoFor("NOT_OPEN"), ...over }))?.registration, registration).toBe(registration);
    }
    // the same reader refuses a drifted answer, so this test is an oracle and not a rubber stamp
    const good = await answerFor(infoFor("NOT_OPEN"));
    expect(validate({ featured: null })).toBeNull();
    for (const [what, mutate] of [
      ["an absolute url", (f: Record<string, unknown>) => { f.voteUrl = `https://gaming.urbanohn.com${f.voteUrl}`; }],
      ["two different contests", (f: Record<string, unknown>) => { f.registerUrl = `/community-voting-round.html?c=${ID.replace("1", "2")}&participar=1`; }],
      ["a phase of another vocabulary", (f: Record<string, unknown>) => { f.phase = "REGISTRATION"; }],
      ["no categories", (f: Record<string, unknown>) => { f.categories = []; }],
    ] as const) {
      const drifted = JSON.parse(JSON.stringify(good));
      mutate(drifted.featured);
      expect(validate(drifted), what).toBeNull();
    }
    // a category name that loses its English form is not refused by the reader: it is silently left out of the list — which the loop above would catch
    const unnamed = JSON.parse(JSON.stringify(good));
    unnamed.featured.categories = unnamed.featured.categories.map((c: Record<string, unknown>) => ({ ...c, name: { es: "x" } }));
    expect(validate(unnamed)?.names).toEqual([]);
  });
});

describe("the operator's registration of a category: only the designated operator, only the four categories, and nothing that belongs to the retired format", () => {
  const body = { sessionId: ID, categoryKey: "SEXIEST" };
  const input = (over: Record<string, unknown> = {}) => ({ body, hostToken: "h", operatorMemberId: OPERATOR, allowlistRaw: OPERATOR, ...over }) as Parameters<typeof registerCommunityVotingCategoryRound>[1];

  it("registers with the caller as the operator when they are on the allow-list", async () => {
    const registerCategoryRound = vi.fn(async (i: unknown) => i);
    const out = await registerCommunityVotingCategoryRound({ registerCategoryRound } as never, input());
    expect(registerCategoryRound).toHaveBeenCalledWith({ sessionId: ID, hostToken: "h", operatorMemberId: OPERATOR, ruleVersion: 1, contestId: null, categoryKey: "SEXIEST", purpose: "LIVE" });
    expect(out).toBeTruthy();
  });

  it("fails closed: no valid allow-list, a member not on it, an unknown category, a bad id, and every field of the retired format", async () => {
    const registerCategoryRound = vi.fn();
    const repo = { registerCategoryRound } as never;
    await rejectsWith(registerCommunityVotingCategoryRound(repo, input({ allowlistRaw: undefined })), "OPERATOR_NOT_CONFIGURED");
    await rejectsWith(registerCommunityVotingCategoryRound(repo, input({ allowlistRaw: "not-a-uuid" })), "OPERATOR_NOT_CONFIGURED");
    await rejectsWith(registerCommunityVotingCategoryRound(repo, input({ allowlistRaw: "00000000-0000-4000-8000-000000000000" })), "OPERATOR_REQUIRED");
    await rejectsWith(registerCommunityVotingCategoryRound(repo, input({ body: { ...body, categoryKey: "BEST_COUPLE" } })), "INVALID_REQUEST");
    await rejectsWith(registerCommunityVotingCategoryRound(repo, input({ body: { ...body, sessionId: "x" } })), "INVALID_REQUEST");
    await rejectsWith(registerCommunityVotingCategoryRound(repo, input({ body: { ...body, ruleVersion: 0 } })), "INVALID_REQUEST");
    for (const retired of ["roundRole", "sourceInstanceId", "venue", "testMode", "windowSeconds"]) await rejectsWith(registerCommunityVotingCategoryRound(repo, input({ body: { ...body, [retired]: 1 } })), "INVALID_REQUEST");
    expect(registerCategoryRound).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------- HTTP

describe("HTTP: every error the contest can raise has its own status and a plain body", () => {
  const ALL: CommunityVotingErrorCode[] = [
    "ALREADY_CANDIDATE", "REGISTRATION_NOT_OPEN", "CUTOFF_PASSED", "PREPARATION_CLOSED", "SCHEDULE_REQUIRED", "CONSENT_REQUIRED", "ENTRY_NOT_FOUND", "CONTEST_NOT_FOUND",
    "NOT_A_CATEGORY_ROUND", "CATEGORY_ALREADY_REGISTERED", "WRONG_CATEGORY", "WRONG_ENTRY_KIND", "GROUP_FULL", "OBSOLETE_FOR_CATEGORY", "OPERATOR_REQUIRED", "VERIFIED_EMAIL_REQUIRED", "PROFILE_INCOMPLETE",
  ];
  it("maps each to a 4xx (a refusal) — and never a 5xx — with its code in the body", () => {
    for (const code of ALL) {
      const mapped = statusForCommunityVotingError(new CommunityVotingError(code));
      expect(mapped, code).not.toBeNull();
      expect(mapped!.status, code).toBeGreaterThanOrEqual(400);
      expect(mapped!.status, code).toBeLessThan(500);
      expect(communityVotingErrorBody(new CommunityVotingError(code, "fixed text")), code).toEqual({ error: "fixed text", code });
    }
    expect(statusForCommunityVotingError(new CommunityVotingError("REGISTRATION_NOT_OPEN"))!.status).toBe(409);
    expect(statusForCommunityVotingError(new CommunityVotingError("ENTRY_NOT_FOUND"))!.status).toBe(404);
    expect(statusForCommunityVotingError(new CommunityVotingError("CONTEST_NOT_FOUND"))!.status).toBe(404);
    expect(statusForCommunityVotingError(new CommunityVotingError("CONSENT_REQUIRED"))!.status).toBe(409);
    expect(statusForCommunityVotingError(new CommunityVotingError("OPERATOR_REQUIRED"))!.status).toBe(403);
    expect(statusForCommunityVotingError(new Error("boom"))).toBeNull();
  });

  it("the repository turns the database's CV_ refusals of the contest into typed errors with fixed messages, and keeps the pilot's own", () => {
    class Probe extends SupabaseContestRepository {
      probe(message: string) { return this.translate({ code: "P0001", message }); }
    }
    const probe = new Probe("http://127.0.0.1:1", "service-key");
    for (const code of ["ALREADY_CANDIDATE", "REGISTRATION_NOT_OPEN", "WRONG_CATEGORY", "WRONG_ENTRY_KIND", "GROUP_FULL", "OBSOLETE_FOR_CATEGORY", "CONTEST_NOT_FOUND", "NOT_A_CATEGORY_ROUND", "CATEGORY_ALREADY_REGISTERED"]) {
      const err = probe.probe(`CV_${code}: some detail the caller must never see 1234 secret`) as CommunityVotingError;
      expect(err, code).toBeInstanceOf(CommunityVotingError);
      expect(err.code, code).toBe(code);
      expect(err.message, code).not.toMatch(/detail|1234|secret/);
    }
    expect((probe.probe("CV_CUTOFF_PASSED: x") as CommunityVotingError).code).toBe("CUTOFF_PASSED"); // the pilot's own, through the parent
    expect((probe.probe("CV_NOT_BOUND: x") as CommunityVotingError).code).toBe("NOT_BOUND");
    expect(probe.probe("something unknown")).not.toBeInstanceOf(CommunityVotingError);
    expect(probe.probe("something unknown").message).not.toMatch(/something unknown/);
  });
});

// ---------------------------------------------------------------- what leaves the server

describe("what leaves the server never carries the number or a person's identity", () => {
  const SERVER_FILES = [
    "lib/gaming/communityVoting/contest/categories.ts",
    "app/api/gaming/community-voting/contests/[contestId]/route.ts",
    "app/api/gaming/community-voting/contests/[contestId]/mine/route.ts",
    "app/api/gaming/community-voting/contests/[contestId]/candidacies/[code]/route.ts",
    "app/api/gaming/community-voting/contests/featured/route.ts",
    "app/api/gaming/community-voting/rounds/[instanceId]/registration/route.ts",
    "app/api/gaming/community-voting/rounds/[instanceId]/operator/candidacies/route.ts",
  ];

  it("only one route returns the delivery number: the operator's …/contact — and nothing logs a request body", () => {
    const contact = read("app/api/gaming/community-voting/rounds/[instanceId]/operator/entries/[entryId]/contact/route.ts");
    expect(contact).toContain("getDeliveryMaterial");
    expect(contact).toContain('dynamic = "force-dynamic"');
    for (const f of SERVER_FILES) {
      const text = read(f).replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
      expect(text, f).not.toMatch(/whatsappE164|whatsapp_e164|readRegistrationContact|getDeliveryMaterial/);
    }
    const routes = [
      "app/api/gaming/community-voting/rounds/[instanceId]/registration/route.ts",
      "app/api/gaming/community-voting/contests/[contestId]/mine/route.ts",
      "app/api/gaming/community-voting/rounds/[instanceId]/operator/entries/[entryId]/contact/route.ts",
    ];
    for (const f of routes) expect(read(f).replace(/\/\*[\s\S]*?\*\//g, ""), f).not.toMatch(/console\.(log|info|warn|error)\(/);
  });

  it("the registration and contact routes are never cached", () => {
    for (const f of ["app/api/gaming/community-voting/rounds/[instanceId]/registration/route.ts", "app/api/gaming/community-voting/contests/[contestId]/mine/route.ts", "app/api/gaming/community-voting/rounds/[instanceId]/operator/entries/[entryId]/contact/route.ts", "app/api/gaming/community-voting/contests/[contestId]/candidacies/[code]/route.ts"]) {
      expect(read(f), f).toContain('export const dynamic = "force-dynamic"');
    }
  });

  it("the contest has no route for a position, a geofence, a final, a cut or a preliminary", () => {
    const routes = (function walk(dir: string): string[] {
      const fs = require("node:fs") as typeof import("node:fs");
      return fs.readdirSync(dir, { withFileTypes: true }).flatMap((d) => (d.isDirectory() ? walk(`${dir}/${d.name}`) : [`${dir}/${d.name}`]));
    })("app/api/gaming/community-voting");
    expect(routes.filter((r) => /geofence|finalist|prepare-final|policies|promo-consent|tasks|instances\//i.test(r))).toEqual([]);
    expect(routes.length).toBeGreaterThan(20);
  });
});
