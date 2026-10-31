import { readFileSync } from "node:fs";

import { describe, expect, it, vi } from "vitest";

/**
 * UG-IV-GATE-018 — the pure logic behind the contest's voter page and operator station, executed from the EXACT deployed source text (the technique
 * competitionsLifecycle.test.ts uses). No DOM, no network, no timers: the clock, the storage and the server are all injected, which is what makes the
 * rules that matter provable here:
 *   - every time a person reads is the EVENT's (America/Tegucigalpa) in 12 hours, and midnight is the word "medianoche";
 *   - a vote is confirmed only on the server's 200, and a lost response is retried with the SAME intent;
 *   - the contest has NO location: nothing in either module reads, asks for or sends a position;
 *   - the public code is typed any way a person types it, and never matches a look-alike;
 *   - the WhatsApp number is composed with its country code and read back to the person before it is sent;
 *   - the station knows exactly what each candidacy still needs, and what keeps a category from opening.
 */

function load<T>(file: string, name: string): T {
  const source = readFileSync(`public/${file}`, "utf-8");
  // eslint-disable-next-line @typescript-eslint/no-implied-eval
  return new Function(`${source}\nreturn ${name};`)() as T;
}
const read = (file: string) => readFileSync(`public/${file}`, "utf-8");

type Json = Record<string, any>;
type Reply = { status: number; json: Json | null };
type FetchImpl = (url: string, init: Json) => Promise<{ status: number; json: () => Promise<Json> }>;

interface Voter {
  describeError(code: string | undefined | null): string;
  identityStep(status: string): "SIGN_IN" | "PROFILE" | "READY";
  stepForError(code: string): "SIGN_IN" | "PROFILE" | null;
  PROFILE_NOTICE: string;
  SIGN_IN_NOTICE: string;
  createPendingSelection(storage: Pick<Storage, "getItem" | "setItem" | "removeItem">, instanceId: string, now?: () => number): { get(): string | null; set(alias: string): boolean; clear(): void };
  resumeSelection(pending: string | null, items: Json[], phase: string, myCandidateId: string | null): Json | null;
  createCountdown(initialMs: number | null, now?: () => number): { remaining(): number | null; resync(ms: number | null): void; expired(): boolean };
  formatCountdown(ms: number): string;
  formatEventTime(iso: string | null): string;
  formatEventRange(from: string | null, to: string | null): string;
  formatEventDate(iso: string | null): string;
  formatEventDayShort(iso: string | null): string;
  atTime(iso: string | null): string;
  untilTime(iso: string | null): string;
  registrationWindowText(from: string | null, to: string | null): string;
  votingWindowText(from: string | null, to: string | null): string;
  EVENT_TIME_ZONE: string;
  phaseNotice(info: Json): string;
  registrationNotice(reg: Json | null): string;
  categoryState(cat: Json | null, myVote: string | null): { label: string; open: boolean; tone: string };
  resultsHeadline(results: Json | null): string | null;
  normalizeCode(raw: unknown): string | null;
  searchGallery(items: Json[], query: string): Json[];
  candidacyTitle(item: Json | null): string;
  shareText(ficha: Json | null): string;
  COUNTRY_CODES: Array<{ code: string; label: string }>;
  DEFAULT_COUNTRY: string;
  composeWhatsapp(country: string, national: string): string;
  displayWhatsapp(e164: string): string;
  validateRegistration(v: Json): { ok: boolean; errors: Record<string, string>; whatsapp: string; name: string };
  registrationStage(registration: Json | null, mine: Json | null): "MINE" | "FORM" | "NOT_OPEN" | "CLOSED" | "NOT_SCHEDULED";
  myCandidacyText(mine: Json | null): string;
  deliveryText(status: string | null): string;
  HOW_TO_PARTICIPATE: string[];
  computeVirtualWindow(o: Json): Json;
  deckNavigate(index: number, delta: number, total: number): number;
  swipeIntent(o: { dx: number; dy: number; minDistance?: number }): "next" | "prev" | null;
  castFavorite(deps: Json): Promise<Json>;
  pollDelayMs(ctx: Json): number;
  POLL: Record<string, number>;
  buildApi(fetchImpl: FetchImpl, getToken: () => Promise<string | null>, instanceId: string): Record<string, (...a: any[]) => Promise<Reply>>;
  buildContestApi(fetchImpl: FetchImpl, getToken: () => Promise<string | null>, contestId: string): Record<string, (...a: any[]) => Promise<Reply>>;
}
interface Operator {
  EVENT_PLAN: Record<string, string>;
  eventInstant(date: string, time: string, plusDays?: number): string | null;
  fromEventInstant(iso: string): { date: string; time: string };
  scheduleFromForm(form: Json): Json | null;
  planResize(w: number, h: number, maxLongSide: number): { width: number; height: number; scale: number };
  PHOTO_LIMITS: { full: number; thumb: number };
  formatClaimCode(code: string): string;
  isMember(e: Json): boolean;
  isReady(e: Json): boolean;
  entryTitle(e: Json | null): string;
  stationSteps(e: Json | null): Array<{ key: string; label: string; state: "done" | "current" | "todo" }>;
  currentStep(e: Json | null): string | null;
  categoryReadiness(overview: Json | null): { opened: boolean; total: number; ready: number; pending: Json[]; canOpen: boolean; reasons: string[] };
  categoryPhaseLabel(overview: Json | null): string;
  afterCloseStep(overview: Json | null): "REVIEW" | "PUBLISH" | "DONE" | null;
  deliveryLabel(status: string): string;
  DELIVERY_NOTICE: string;
  describeError(code: string): string;
  buildOperatorApi(fetchImpl: FetchImpl, getToken: () => Promise<string | null>, getHost: () => string, instanceId: string): Record<string, (...a: any[]) => Promise<Reply>>;
  buildSetupApi(fetchImpl: FetchImpl, getToken: () => Promise<string | null>): Record<string, (...a: any[]) => Promise<Reply>>;
  STORE_KEY: string;
  parseKeys(raw: unknown): Json | null;
  keysComplete(keys: Json | null): boolean;
}

const R = load<Voter>("communityVotingRound.js", "CommunityVotingRound");
const O = load<Operator>("communityVotingRoundOperator.js", "CommunityVotingOperator");

const ID = "11111111-2222-4333-8444-555555555555";
const CAND = "aaaaaaaa-bbbb-4ccc-8ddd-000000000001";
const INTERACTION = "bbbbbbbb-bbbb-4ccc-8ddd-000000000002";
const BINDING = "cccccccc-bbbb-4ccc-8ddd-000000000003";

// The approved plan of 31 October 2026, as the instants the server stores (Tegucigalpa is UTC-6, all year).
const REG_OPENS = "2026-11-01T02:00:00.000Z"; // 8:00 p. m.
const REG_CLOSES = "2026-11-01T05:00:00.000Z"; // 11:00 p. m.
const VOTE_OPENS = "2026-11-01T05:00:00.000Z"; // 11:00 p. m.
const VOTE_CLOSES = "2026-11-01T06:00:00.000Z"; // midnight, entering Sunday 1 November

// ---------------------------------------------------------------- time: the event's, in 12 hours, midnight a word

describe("time: the event's zone, 12 hours, midnight is a word", () => {
  it("says the approved public plan in exactly the Founder's words", () => {
    expect(R.formatEventDate("2026-10-31T15:00:00.000Z")).toBe("sábado 31 de octubre de 2026"); // 9:00 a. m. of the 31st
    expect(R.formatEventDate("2026-11-01T02:00:00.000Z")).toBe("sábado 31 de octubre de 2026"); // 8:00 p. m. on the 31st, whatever the phone's zone says
    expect(R.formatEventDayShort(VOTE_CLOSES)).toBe("domingo 1 de noviembre");
    expect(R.registrationWindowText(REG_OPENS, REG_CLOSES)).toBe("Inscripciones y fotos: 8:00–11:00 p. m.");
    expect(R.votingWindowText(VOTE_OPENS, VOTE_CLOSES)).toBe("Votación: 11:00 p. m.–medianoche, entrando al domingo 1 de noviembre");
  });

  it("formats single times and ranges: a. m. / p. m., noon and midnight, a shared meridiem written once", () => {
    expect(R.formatEventTime(VOTE_OPENS)).toBe("11:00 p. m.");
    expect(R.formatEventTime(VOTE_CLOSES)).toBe("medianoche");
    expect(R.formatEventTime("2026-10-31T18:00:00.000Z")).toBe("12:00 p. m."); // noon of the 31st (UTC-6)
    expect(R.formatEventTime("2026-10-31T15:05:00.000Z")).toBe("9:05 a. m.");
    expect(R.formatEventTime("2026-11-01T06:30:00.000Z")).toBe("12:30 a. m."); // half past midnight is NOT "medianoche"
    expect(R.formatEventRange("2026-11-01T02:00:00.000Z", "2026-11-01T03:30:00.000Z")).toBe("8:00–9:30 p. m.");
    expect(R.formatEventRange("2026-10-31T16:00:00.000Z", "2026-11-01T01:00:00.000Z")).toBe("10:00 a. m.–7:00 p. m.");
    expect(R.formatEventRange(VOTE_OPENS, VOTE_CLOSES)).toBe("11:00 p. m.–medianoche");
    expect(R.formatEventRange(null, VOTE_CLOSES)).toBe("");
    expect(R.formatEventTime("not a date")).toBe("");
    expect(R.formatEventTime(null)).toBe("");
  });

  it("writes times inside sentences: «a las 11:00 p. m.», «a medianoche», «hasta las …»", () => {
    expect(R.atTime(VOTE_OPENS)).toBe("a las 11:00 p. m.");
    expect(R.atTime(VOTE_CLOSES)).toBe("a medianoche");
    expect(R.untilTime(REG_CLOSES)).toBe("hasta las 11:00 p. m.");
    expect(R.untilTime(VOTE_CLOSES)).toBe("hasta medianoche");
    expect(R.atTime(null)).toBe("");
  });

  it("never reads the phone's clock or zone: the same words in any process zone", () => {
    const zone = process.env.TZ;
    for (const tz of ["UTC", "Asia/Tokyo", "America/Los_Angeles"]) {
      process.env.TZ = tz;
      expect(R.votingWindowText(VOTE_OPENS, VOTE_CLOSES)).toBe("Votación: 11:00 p. m.–medianoche, entrando al domingo 1 de noviembre");
    }
    if (zone === undefined) delete process.env.TZ; else process.env.TZ = zone;
  });

  it("keeps the zone's name as a fact of the module", () => {
    expect(R.EVENT_TIME_ZONE).toBe("America/Tegucigalpa");
  });
});

// ---------------------------------------------------------------- what the page says about each state

describe("what the page says: registration, voting, and the states in between", () => {
  it("says what registration is doing, by the server's phase — and invents no time when none is configured", () => {
    expect(R.registrationNotice({ phase: "OPEN", opensAt: REG_OPENS, closesAt: REG_CLOSES })).toBe("La inscripción de concursantes está abierta hasta las 11:00 p. m. (hora de Honduras).");
    expect(R.registrationNotice({ phase: "NOT_OPEN", opensAt: REG_OPENS, closesAt: REG_CLOSES })).toBe("La inscripción de concursantes abre a las 8:00 p. m. (hora de Honduras).");
    expect(R.registrationNotice({ phase: "CLOSED", opensAt: REG_OPENS, closesAt: REG_CLOSES })).toBe("La inscripción de concursantes terminó. Ya no se aceptan nuevas candidaturas.");
    expect(R.registrationNotice({ phase: "NOT_SCHEDULED", opensAt: null, closesAt: null })).toBe("Pronto anunciaremos el horario de inscripción.");
    expect(R.registrationNotice(null)).toBe("Pronto anunciaremos el horario de inscripción.");
  });

  it("a category that is only scheduled is not open: it says when it is planned and that the team opens it", () => {
    expect(R.phaseNotice({ phase: "NOT_OPEN", votingOpensAt: VOTE_OPENS, tentative: false })).toBe("La votación todavía no está abierta: está prevista a las 11:00 p. m. (hora de Honduras) y la abre el equipo del evento.");
    expect(R.phaseNotice({ phase: "NOT_OPEN", votingOpensAt: VOTE_OPENS, tentative: true })).toContain("El horario es tentativo hasta que se confirme.");
    expect(R.phaseNotice({ phase: "NOT_OPEN", votingOpensAt: null, tentative: false })).toBe("La votación todavía no está abierta. Volvé en unos minutos.");
    expect(R.phaseNotice({ phase: "OPEN", deadlineAt: VOTE_CLOSES })).toBe("La votación está abierta. Elegí a tu favorito: podés cambiar tu voto hasta que cierre. Cierra a medianoche (hora de Honduras).");
    expect(R.phaseNotice({ phase: "CLOSED", published: false })).toContain("los resultados se publican después de que el equipo los revise");
    expect(R.phaseNotice({ phase: "CLOSED", published: true })).toBe("La votación de esta categoría cerró y ya están los resultados.");
  });

  it("names the category's state for the picker: voted or not, open, closed, results", () => {
    expect(R.categoryState({ phase: "OPEN" }, null)).toMatchObject({ label: "Votación abierta · todavía no votaste", open: true, tone: "open" });
    expect(R.categoryState({ phase: "OPEN" }, CAND)).toMatchObject({ label: "Ya votaste · podés cambiarlo", tone: "voted" });
    expect(R.categoryState({ phase: "NOT_OPEN" }, null)).toMatchObject({ label: "La votación todavía no abre", open: false });
    expect(R.categoryState({ phase: "CLOSED", published: false }, CAND).label).toBe("Votación cerrada · tu voto quedó registrado");
    expect(R.categoryState({ phase: "CLOSED", published: true }, null).label).toBe("Resultados publicados");
  });

  it("announces a published category without a count: shared winners, a single winner, or no winner when nobody cast a valid vote", () => {
    expect(R.resultsHeadline({ published: true, items: [{ alias: "1" }] })).toBe("¡Tenemos ganador!");
    expect(R.resultsHeadline({ published: true, items: [{ alias: "1" }, { alias: "2" }] })).toBe("¡Tenemos ganadores compartidos!");
    expect(R.resultsHeadline({ published: true, items: [] })).toBe("Sin resultado ganador");
    expect(R.resultsHeadline({ published: false, items: [] })).toBeNull();
  });

  it("«Cómo participar» keeps every essential condition: adults, once per person, no location, one changeable vote per category, no self-vote, ties, review, the prize promise", () => {
    const all = R.HOW_TO_PARTICIPATE.join(" ");
    for (const must of [/mayores de edad/, /una sola candidatura por persona, en una sola categoría/, /no pedimos tu ubicación/, /un voto por categoría/, /cambiar(?:lo)? hasta que cierre/, /No podés votar por tu propio disfraz ni por el de tu grupo/, /Si hay empate, hay más de un ganador/, /los revise/, /Habrá premios en cada categoría/]) expect(all).toMatch(must);
    // and it promises nothing else about prizes
    expect(all.replace("Habrá premios en cada categoría", "")).not.toMatch(/premio|ganá|valor|\$|L\s?\d/i);
  });

  it("states the identity steps and the notices without asking for a telephone", () => {
    expect(R.identityStep("authenticated")).toBe("READY");
    expect(R.identityStep("profile_incomplete")).toBe("PROFILE");
    expect(R.identityStep("unauthenticated")).toBe("SIGN_IN");
    expect(R.identityStep(undefined as never)).toBe("SIGN_IN");
    expect(R.stepForError("PROFILE_INCOMPLETE")).toBe("PROFILE");
    expect(R.stepForError("AUTHENTICATION_REQUIRED")).toBe("SIGN_IN");
    expect(R.stepForError("VERIFIED_EMAIL_REQUIRED")).toBe("SIGN_IN");
    expect(R.stepForError("INVALID_REQUEST")).toBeNull();
    expect(R.SIGN_IN_NOTICE).toMatch(/correo/);
    expect(R.SIGN_IN_NOTICE).toMatch(/No hace falta teléfono/);
    expect(`${R.SIGN_IN_NOTICE} ${R.PROFILE_NOTICE}`).not.toMatch(/SMS|WhatsApp|ubicaci/i);
  });

  it("describes every refusal in plain words and never repeats a technical text", () => {
    for (const code of ["ALREADY_CANDIDATE", "REGISTRATION_NOT_OPEN", "CUTOFF_PASSED", "PREPARATION_CLOSED", "CONSENT_REQUIRED", "ENTRY_NOT_FOUND", "SELF_VOTE_NOT_ALLOWED", "VOTING_WINDOW_ELAPSED", "STALE_INTENT", "NETWORK"]) {
      const text = R.describeError(code);
      expect(text.length, code).toBeGreaterThan(10);
      expect(text, code).not.toMatch(/CV_|SQL|stack|undefined|null|HTTP \d|\bcode\b/i);
    }
    expect(R.describeError("SOMETHING_NEW")).toBe("No pudimos completar la acción. Intentalo de nuevo.");
    expect(R.describeError(null)).toBe("No pudimos completar la acción. Intentalo de nuevo.");
    expect(R.describeError("ALREADY_CANDIDATE")).toBe("Ya tenés una candidatura en el concurso. Cada persona participa una sola vez, en una sola categoría.");
    expect(R.describeError("CUTOFF_PASSED")).toBe("La inscripción terminó. Ya no se aceptan nuevas candidaturas.");
  });
});

// ---------------------------------------------------------------- the public code, the search, the ficha

describe("the public code and its search", () => {
  it("is typed any way a person types it, and never matches a look-alike or the wrong length", () => {
    for (const typed of ["HAL-K7M2Q", "hal-k7m2q", "HALK7M2Q", "  hal k7m2q ", "Hal-K7 M2Q"]) expect(R.normalizeCode(typed), typed).toBe("HAL-K7M2Q");
    for (const bad of ["HAL-K7M2O", "HAL-K7M2I", "HAL-K7M2L", "HAL-K7M2U", "HAL-K7M20", "HAL-K7M21", "HAL-K7M2", "HAL-K7M2QQ", "ABC-K7M2Q", "K7M2Q", "", null, undefined, 12345]) expect(R.normalizeCode(bad as never), String(bad)).toBeNull();
  });

  it("filters a gallery by a complete code (exactly that candidacy) or by name and code fragments, accents and case ignored; empty shows everything; order never changes", () => {
    const items = [
      { alias: "1111", name: "Frankenstein del Barrio", code: "HAL-9Z272" },
      { alias: "2222", name: "La Catrina Moderna", code: "HAL-JZAFZ" },
      { alias: "3333", name: "Capitán Calabaza", code: "HAL-NX79Z" },
      { alias: "4444", name: null, code: "HAL-V3P2S" },
    ];
    expect(R.searchGallery(items, "").map((i) => i.alias)).toEqual(["1111", "2222", "3333", "4444"]);
    expect(R.searchGallery(items, "   ").map((i) => i.alias)).toEqual(["1111", "2222", "3333", "4444"]);
    expect(R.searchGallery(items, "hal-nx79z").map((i) => i.alias)).toEqual(["3333"]);
    expect(R.searchGallery(items, "HAL NX79Z").map((i) => i.alias)).toEqual(["3333"]);
    expect(R.searchGallery(items, "capitan").map((i) => i.alias)).toEqual(["3333"]); // accent ignored
    expect(R.searchGallery(items, "CATRINA").map((i) => i.alias)).toEqual(["2222"]);
    expect(R.searchGallery(items, "z").map((i) => i.alias)).toEqual(["1111", "2222", "3333"]); // order of the voter's own sequence, untouched
    expect(R.searchGallery(items, "hal-v3").map((i) => i.alias)).toEqual(["4444"]);
    expect(R.searchGallery(items, "nobody")).toEqual([]);
    expect(R.searchGallery(null as never, "x")).toEqual([]);
  });

  it("titles a candidacy by the name its person chose, or by its ballot number when the team made it by hand and has not named it", () => {
    expect(R.candidacyTitle({ name: "Capitán Calabaza", alias: "3333" })).toBe("Capitán Calabaza");
    expect(R.candidacyTitle({ name: null, alias: "3333" })).toBe("Disfraz #3333");
    expect(R.candidacyTitle({ name: "", alias: "3333" })).toBe("Disfraz #3333");
    expect(R.candidacyTitle(null)).toBe("Disfraz");
  });

  it("shares neutrally: the name, the code and the link — never a request to vote", () => {
    const text = R.shareText({ candidacy: { name: "Capitán Calabaza", code: "HAL-NX79Z", ficheUrl: "https://x.test/c?c=1&codigo=HAL-NX79Z" } });
    expect(text).toBe("Mirá la candidatura de Capitán Calabaza (código HAL-NX79Z) en el concurso de disfraces de The Pub by Beer Box: https://x.test/c?c=1&codigo=HAL-NX79Z");
    expect(text).not.toMatch(/vot[aá]/i);
    expect(R.shareText(null)).toBe("");
  });
});

// ---------------------------------------------------------------- the contestant's registration form

describe("the registration form: the number is composed with its country code and read back", () => {
  it("composes E.164 from a country and a national number, ignoring spaces and punctuation", () => {
    expect(R.composeWhatsapp("504", "9988 7766")).toBe("+50499887766");
    expect(R.composeWhatsapp("+504", "(9988)-7766")).toBe("+50499887766");
    expect(R.composeWhatsapp("1", "202 555 0143")).toBe("+12025550143");
    expect(R.composeWhatsapp("", "99887766")).toBe("");
    expect(R.composeWhatsapp("504", "")).toBe("");
    expect(R.DEFAULT_COUNTRY).toBe("504");
    expect(R.COUNTRY_CODES[0]).toMatchObject({ code: "504" });
    expect(R.COUNTRY_CODES.some((c) => c.code === "other")).toBe(true);
  });

  it("reads a Honduran number back as the person would say it, and any other as its digits", () => {
    expect(R.displayWhatsapp("+50499887766")).toBe("+504 9988-7766");
    expect(R.displayWhatsapp("+12025550143")).toBe("+12025550143");
    expect(R.displayWhatsapp("not a number")).toBe("");
  });

  const good = { name: "  Drácula de Tegucigalpa ", category: "MOST_ELABORATE", country: "504", otherCountry: "", number: "9988 7766", whatsappConfirmed: true, requirementsAccepted: true, deliveryAuthorized: true };

  it("accepts a complete form and returns the trimmed name and the E.164 number to send", () => {
    const r = R.validateRegistration(good);
    expect(r.ok).toBe(true);
    expect(r.errors).toEqual({});
    expect(r.name).toBe("Drácula de Tegucigalpa");
    expect(r.whatsapp).toBe("+50499887766");
    expect(R.validateRegistration({ ...good, country: "other", otherCountry: "52", number: "55 1234 5678" }).whatsapp).toBe("+525512345678");
  });

  it("names every missing piece, one by one, in plain words", () => {
    expect(R.validateRegistration({ ...good, name: "X" }).errors.name).toMatch(/de 2 a 40/);
    expect(R.validateRegistration({ ...good, name: "x".repeat(41) }).errors.name).toBeTruthy();
    expect(R.validateRegistration({ ...good, name: "Drac\u0007ula" }).errors.name).toBeTruthy();
    expect(R.validateRegistration({ ...good, category: "" }).errors.category).toMatch(/categoría/);
    expect(R.validateRegistration({ ...good, category: "BEST_COUPLE" }).errors.category).toBeTruthy();
    expect(R.validateRegistration({ ...good, number: "" }).errors.whatsapp).toMatch(/código del país/);
    expect(R.validateRegistration({ ...good, number: "123" }).errors.whatsapp).toBeTruthy();
    expect(R.validateRegistration({ ...good, whatsappConfirmed: false }).errors.whatsappConfirmed).toMatch(/Confirmá que este número es tuyo/);
    expect(R.validateRegistration({ ...good, requirementsAccepted: false }).errors.requirements).toMatch(/mayor de edad/);
    expect(R.validateRegistration({ ...good, deliveryAuthorized: false }).errors.delivery).toMatch(/WhatsApp/);
    const empty = R.validateRegistration({ name: "", category: "", country: "504", otherCountry: "", number: "", whatsappConfirmed: false, requirementsAccepted: false, deliveryAuthorized: false });
    expect(empty.ok).toBe(false);
    expect(Object.keys(empty.errors).sort()).toEqual(["category", "delivery", "name", "requirements", "whatsapp"]);
  });

  it("shows the right view: the person's own candidacy first, then the form only while registration is open — and nothing to fill in after the cutoff", () => {
    const mine = { publicCode: "HAL-K7M2Q" };
    expect(R.registrationStage({ phase: "OPEN" }, mine)).toBe("MINE");
    expect(R.registrationStage({ phase: "CLOSED" }, mine)).toBe("MINE"); // having registered, they still see theirs after the cutoff
    expect(R.registrationStage({ phase: "OPEN" }, null)).toBe("FORM");
    expect(R.registrationStage({ phase: "NOT_OPEN" }, null)).toBe("NOT_OPEN");
    expect(R.registrationStage({ phase: "CLOSED" }, null)).toBe("CLOSED");
    expect(R.registrationStage({ phase: "NOT_SCHEDULED" }, null)).toBe("NOT_SCHEDULED");
    expect(R.registrationStage(null, null)).toBe("NOT_SCHEDULED");
  });

  it("tells a person where their candidacy stands, and says nothing about the delivery that the team has not promised", () => {
    expect(R.myCandidacyText({ role: "INDIVIDUAL", state: "REGISTERED" })).toContain("Pasá por la estación del concurso con tu código");
    expect(R.myCandidacyText({ role: "INDIVIDUAL", state: "PUBLIC" })).toBe("Tu candidatura ya es pública: aparece en la galería con tu foto.");
    expect(R.myCandidacyText({ role: "INDIVIDUAL", state: "WITHDRAWN" })).toBe("Esta candidatura fue retirada.");
    expect(R.myCandidacyText({ role: "MEMBER", state: "REGISTERED" })).toContain("candidatura de grupo");
    expect(R.myCandidacyText(null)).toBe("");
    expect(R.deliveryText("PENDING")).toContain("Mientras tanto, tu candidatura no depende de ese envío");
    expect(R.deliveryText("DELIVERED")).toBe("Tu foto y tu código ya te los enviaron por WhatsApp.");
    expect(R.deliveryText(null)).toBe("");
  });
});

// ---------------------------------------------------------------- one vote, start to finish

describe("casting a favorite: the vote is confirmed only on the server's 200; a lost response retries the SAME intent", () => {
  const reply = (status: number, json: Json | null = null): Reply => ({ status, json });
  const apiWith = (steps: { bind?: Reply; intent?: Reply; vote?: Reply | Reply[] }) => {
    const calls: string[] = [];
    const votes = Array.isArray(steps.vote) ? [...steps.vote] : steps.vote ? [steps.vote] : [reply(200, { outcome: "APPLIED", candidateId: CAND })];
    return {
      calls,
      api: {
        bind: vi.fn(async () => { calls.push("bind"); return steps.bind ?? reply(200, { bindingId: BINDING }); }),
        intent: vi.fn(async () => { calls.push("intent"); return steps.intent ?? reply(201, { intentNo: 7 }); }),
        vote: vi.fn(async (body: Json) => { calls.push(`vote:${JSON.stringify(body)}`); return votes.length > 1 ? votes.shift()! : votes[0]; }),
      },
    };
  };

  it("binds, takes a fresh intent and votes — with NO location in the request", async () => {
    const { api, calls } = apiWith({});
    const out = await R.castFavorite({ api, candidateId: CAND, interactionInstanceId: INTERACTION });
    expect(out).toMatchObject({ ok: true, outcome: "APPLIED", candidateId: CAND });
    expect(calls[0]).toBe("bind");
    expect(calls[1]).toBe("intent");
    expect(JSON.parse(calls[2].slice(5))).toEqual({ bindingId: BINDING, intentNo: 7, interactionInstanceId: INTERACTION, candidateId: CAND });
    expect(calls[2]).not.toMatch(/location|latitude|longitude|accuracy/i);
  });

  it("a lost response is neither a failure nor a success: it carries the SAME intent, and retrying sends exactly that", async () => {
    const first = apiWith({ vote: reply(0, { code: "NETWORK" }) });
    const lost = await R.castFavorite({ api: first.api, candidateId: CAND, interactionInstanceId: INTERACTION });
    expect(lost).toMatchObject({ ok: false, code: "NETWORK", retry: { bindingId: BINDING, intentNo: 7, candidateId: CAND, interactionInstanceId: INTERACTION } });
    const second = apiWith({ vote: reply(200, { outcome: "REPLAYED", candidateId: CAND }) });
    const again = await R.castFavorite({ api: second.api, candidateId: CAND, interactionInstanceId: INTERACTION, retry: lost.retry });
    expect(again).toMatchObject({ ok: true, outcome: "REPLAYED" });
    expect(second.api.bind).not.toHaveBeenCalled();
    expect(second.api.intent).not.toHaveBeenCalled(); // no new intent: nothing can be duplicated
    expect(JSON.parse(second.calls[0].slice(5)).intentNo).toBe(7);
  });

  it("a retry for another candidate is not a retry: it takes a fresh intent", async () => {
    const { api } = apiWith({});
    await R.castFavorite({ api, candidateId: CAND, interactionInstanceId: INTERACTION, retry: { bindingId: BINDING, intentNo: 3, candidateId: "someone-else", interactionInstanceId: INTERACTION } });
    expect(api.intent).toHaveBeenCalledTimes(1);
  });

  it("nothing is shown as accepted unless the server answered 200 with an outcome; every refusal carries its own code and the caller's own current state", async () => {
    for (const [status, code] of [[409, "VOTING_WINDOW_ELAPSED"], [400, "SELF_VOTE_NOT_ALLOWED"], [403, "VERIFIED_EMAIL_REQUIRED"], [500, "INTERNAL_ERROR"]] as const) {
      const { api } = apiWith({ vote: reply(status, { code }) });
      const out = await R.castFavorite({ api, candidateId: CAND, interactionInstanceId: INTERACTION });
      expect(out.ok, code).toBe(false);
      expect(out.code, code).toBe(code);
    }
    const stale = apiWith({ vote: reply(409, { code: "STALE_INTENT", current: { myCandidateId: CAND } }) });
    expect(await R.castFavorite({ api: stale.api, candidateId: CAND, interactionInstanceId: INTERACTION })).toMatchObject({ ok: false, code: "STALE_INTENT", current: { myCandidateId: CAND } });
    const odd = apiWith({ vote: reply(200, { outcome: "SOMETHING" }) });
    expect((await R.castFavorite({ api: odd.api, candidateId: CAND, interactionInstanceId: INTERACTION })).ok).toBe(false);
  });

  it("a bind or intent failure stops everything: no vote is sent", async () => {
    const noBind = apiWith({ bind: reply(409, { code: "ADMISSION_CLOSED" }) });
    expect(await R.castFavorite({ api: noBind.api, candidateId: CAND, interactionInstanceId: INTERACTION })).toMatchObject({ ok: false, code: "ADMISSION_CLOSED" });
    expect(noBind.api.vote).not.toHaveBeenCalled();
    const noIntent = apiWith({ intent: reply(500, { code: "INTERNAL_ERROR" }) });
    expect((await R.castFavorite({ api: noIntent.api, candidateId: CAND, interactionInstanceId: INTERACTION })).ok).toBe(false);
    expect(noIntent.api.vote).not.toHaveBeenCalled();
  });

  it("when the page has moved on (another person, a sign-out) nothing further is sent", async () => {
    const { api } = apiWith({});
    const out = await R.castFavorite({ api, candidateId: CAND, interactionInstanceId: INTERACTION, isCurrent: () => false });
    expect(out).toMatchObject({ ok: false, code: "STALE_ACTION", stale: true });
    expect(api.bind).not.toHaveBeenCalled();
    let calls = 0;
    const midway = apiWith({});
    const out2 = await R.castFavorite({ api: midway.api, candidateId: CAND, interactionInstanceId: INTERACTION, isCurrent: () => ++calls < 3 });
    expect(out2.stale).toBe(true);
    expect(midway.api.vote).not.toHaveBeenCalled();
  });
});

describe("the voter's clients: only the routes of the contest, the bearer only where it is needed, no location anywhere", () => {
  const record = (reply: { status: number; json?: Json } = { status: 200, json: {} }) => {
    const seen: Array<{ url: string; init: Json }> = [];
    const fetchImpl: FetchImpl = async (url, init) => { seen.push({ url, init }); return { status: reply.status, json: async () => reply.json ?? {} }; };
    return { seen, fetchImpl };
  };

  it("buildApi: public reads carry no credentials; the voter's calls carry the bearer; register posts to the category's own route", async () => {
    const { seen, fetchImpl } = record();
    const api = R.buildApi(fetchImpl, async () => "tok", ID);
    await api.info(); await api.results(); await api.bind(); await api.status(); await api.gallery(); await api.intent(); await api.vote({ a: 1 }); await api.claim("ABCD-EFGH-JKMN"); await api.register({ publicName: "X" });
    const base = `/api/gaming/community-voting/rounds/${ID}`;
    expect(seen.map((s) => `${s.init.method} ${s.url.replace(base, "")}`)).toEqual(["GET /info", "GET /results", "POST /binding", "GET /status", "GET /gallery", "POST /intents", "POST /votes", "POST /claims", "POST /registration"]);
    expect(seen.map((s) => Boolean((s.init.headers as Json).Authorization))).toEqual([false, false, true, true, true, true, true, true, true]);
    expect(JSON.parse(seen[8].init.body)).toEqual({ publicName: "X" });
    expect(Object.keys(api).sort()).toEqual(["bind", "claim", "gallery", "info", "intent", "register", "results", "status", "vote"]);
  });

  it("buildContestApi: my candidacy needs the bearer; a ficha never sends one; the code is encoded", async () => {
    const { seen, fetchImpl } = record();
    const api = R.buildContestApi(fetchImpl, async () => "tok", ID);
    await api.mine();
    await api.ficha("HAL-K7M2Q");
    await api.ficha("a/b?c");
    const base = `/api/gaming/community-voting/contests/${ID}`;
    expect(seen.map((s) => s.url)).toEqual([`${base}/mine`, `${base}/candidacies/HAL-K7M2Q`, `${base}/candidacies/a%2Fb%3Fc`]);
    expect(seen.map((s) => Boolean((s.init.headers as Json).Authorization))).toEqual([true, false, false]);
  });

  it("a network failure is a typed result, never a throw", async () => {
    const boom: FetchImpl = async () => { throw new Error("offline"); };
    expect(await R.buildApi(boom, async () => null, ID).bind()).toEqual({ status: 0, json: { code: "NETWORK" } });
    expect(await R.buildContestApi(boom, async () => null, ID).mine()).toEqual({ status: 0, json: { code: "NETWORK" } });
  });
});

describe("the deck, the countdown and the pending choice", () => {
  it("counts down from the SERVER's remaining time on a monotonic clock, and resyncs", () => {
    let t = 1000;
    const c = R.createCountdown(60_000, () => t);
    expect(c.remaining()).toBe(60_000);
    t += 15_000;
    expect(c.remaining()).toBe(45_000);
    t += 100_000;
    expect(c.remaining()).toBe(0);
    expect(c.expired()).toBe(true);
    c.resync(10_000);
    expect(c.expired()).toBe(false);
    expect(R.createCountdown(null).remaining()).toBeNull();
    expect(R.formatCountdown(3_725_000)).toBe("1:02:05");
    expect(R.formatCountdown(65_000)).toBe("1:05");
    expect(R.formatCountdown(0)).toBe("0:00");
  });

  it("remembers the chosen candidacy across a sign-in, only highlights it, and resumes only when it is safe", () => {
    const store = new Map<string, string>();
    const storage = { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => void store.set(k, v), removeItem: (k: string) => void store.delete(k) };
    let now = 0;
    const p = R.createPendingSelection(storage, ID, () => now);
    expect(p.set("1111")).toBe(true);
    expect(p.set("not-a-number")).toBe(false);
    expect(p.get()).toBe("1111");
    now += 3 * 60 * 60 * 1000;
    expect(p.get()).toBeNull(); // forgotten after two hours
    const items = [{ alias: "1111", candidateId: CAND, mine: false }, { alias: "2222", candidateId: "x", mine: true }];
    expect(R.resumeSelection("1111", items, "OPEN", null)).toMatchObject({ alias: "1111" });
    expect(R.resumeSelection("1111", items, "NOT_OPEN", null)).toBeNull();
    expect(R.resumeSelection("1111", items, "OPEN", CAND)).toBeNull(); // already their vote
    expect(R.resumeSelection("2222", items, "OPEN", null)).toBeNull(); // their own costume
    expect(R.resumeSelection(null, items, "OPEN", null)).toBeNull();
    const failing = { getItem: () => { throw new Error("blocked"); }, setItem: () => { throw new Error("blocked"); }, removeItem: () => { throw new Error("blocked"); } };
    const safe = R.createPendingSelection(failing, ID);
    expect(safe.set("1111")).toBe(false);
    expect(safe.get()).toBeNull();
    expect(() => safe.clear()).not.toThrow();
  });

  it("navigates a deck that wraps and recognises a swipe only when it is horizontal and long enough", () => {
    expect(R.deckNavigate(0, -1, 4)).toBe(3);
    expect(R.deckNavigate(3, 1, 4)).toBe(0);
    expect(R.deckNavigate(0, 0, 0)).toBe(0);
    expect(R.swipeIntent({ dx: -100, dy: 10 })).toBe("next");
    expect(R.swipeIntent({ dx: 100, dy: 10 })).toBe("prev");
    expect(R.swipeIntent({ dx: 30, dy: 0 })).toBeNull();
    expect(R.swipeIntent({ dx: 100, dy: 200 })).toBeNull();
  });

  it("asks the server again quickly while a category is open and after it closes, and slowly once everything is published", () => {
    expect(R.pollDelayMs({ phase: "OPEN" })).toBe(R.POLL.openMs);
    expect(R.pollDelayMs({ phase: "NOT_OPEN" })).toBe(R.POLL.waitMs);
    expect(R.pollDelayMs({ phase: "CLOSED", published: false, sinceChangeMs: 1000 })).toBe(R.POLL.afterCloseMs);
    expect(R.pollDelayMs({ phase: "CLOSED", published: false, sinceChangeMs: 10 * 60_000 })).toBe(R.POLL.settledMs);
    expect(R.pollDelayMs({ phase: "RESULTS", published: true })).toBe(R.POLL.publishedMs);
    for (const v of Object.values(R.POLL)) expect(v === R.POLL.afterCloseWindowMs || v >= 5000, String(v)).toBe(true); // never faster than 5 s
  });
});

describe("the contest has no location, no geofence, no preliminary and no final — anywhere in what ships", () => {
  const FORBIDDEN = /geolocation|getCurrentPosition|watchPosition|latitude|longitude|geofence|geovalla|\bGPS\b|ubicaci[oó]n exacta|finalista|preliminar|\bla final\b|segunda ronda|primera ronda/i;
  const SHIPPED = ["communityVotingRound.js", "communityVotingRoundOperator.js", "communityVotingSlideshow.js", "community-voting-round.html", "community-voting-round-operator.html", "community-voting-round-display.html"];

  it("none of the pages or scripts reads a position, names a geofence, a final or a cut", () => {
    for (const f of SHIPPED) {
      const text = read(f).replace(/\/\*[\s\S]*?\*\//g, "").replace(/<!--[\s\S]*?-->/g, "").replace(/^\s*\/\/.*$/gm, "");
      expect(text, f).not.toMatch(FORBIDDEN);
    }
  });

  it("the only place that says the contest never asks for a position is the people's own explanation", () => {
    expect(R.HOW_TO_PARTICIPATE.join(" ")).toMatch(/no pedimos tu ubicación/);
    expect(R.describeError("LOCATION_OUTSIDE")).toBe("No pudimos completar la acción. Intentalo de nuevo."); // a refusal the contest cannot produce has no text of its own
  });
});

// ---------------------------------------------------------------- the operator station

describe("the station's time: the form's times become the instants the server stores", () => {
  it("builds the approved Halloween plan as instants: registration 8–11 p. m., voting 11 p. m. to midnight of the next day", () => {
    expect(O.scheduleFromForm({ ...O.EVENT_PLAN, confirmed: false })).toEqual({
      registrationOpensAt: REG_OPENS, contestantCutoffAt: REG_CLOSES, votingOpensAt: VOTE_OPENS, votingClosesAt: VOTE_CLOSES, status: "TENTATIVE",
    });
    expect(O.scheduleFromForm({ ...O.EVENT_PLAN, confirmed: true })!.status).toBe("CONFIRMED");
  });

  it("a closing time at or before the opening time is the NEXT day; an impossible order is refused", () => {
    expect(O.scheduleFromForm({ date: "2026-10-31", registrationOpens: "20:00", registrationCloses: "23:00", votingOpens: "23:00", votingCloses: "23:30", confirmed: false })!.votingClosesAt).toBe("2026-11-01T05:30:00.000Z");
    expect(O.scheduleFromForm({ date: "2026-10-31", registrationOpens: "23:30", registrationCloses: "23:00", votingOpens: "23:00", votingCloses: "00:00", confirmed: false })).toBeNull(); // registration closes before it opens
    expect(O.scheduleFromForm({ date: "2026-10-31", registrationOpens: "20:00", registrationCloses: "23:30", votingOpens: "23:00", votingCloses: "00:00", confirmed: false })).toBeNull(); // registration outlives the opening
    expect(O.scheduleFromForm({ date: "", registrationOpens: "20:00", registrationCloses: "23:00", votingOpens: "23:00", votingCloses: "00:00", confirmed: false })).toBeNull();
    expect(O.scheduleFromForm({ date: "2026-10-31", registrationOpens: "8 pm", registrationCloses: "23:00", votingOpens: "23:00", votingCloses: "00:00", confirmed: false })).toBeNull();
  });

  it("converts back and forth without the phone's zone", () => {
    expect(O.eventInstant("2026-10-31", "20:00")).toBe("2026-11-01T02:00:00.000Z");
    expect(O.eventInstant("2026-10-31", "00:00", 1)).toBe("2026-11-01T06:00:00.000Z");
    expect(O.fromEventInstant("2026-11-01T02:00:00.000Z")).toEqual({ date: "2026-10-31", time: "20:00" });
    expect(O.fromEventInstant("2026-11-01T06:00:00.000Z")).toEqual({ date: "2026-11-01", time: "00:00" });
    expect(O.fromEventInstant("nope")).toEqual({ date: "", time: "" });
    expect(O.eventInstant("2026-13-45", "99:99")).toBeNull();
  });

  it("scales a photograph down and never up", () => {
    expect(O.planResize(4000, 3000, 1600)).toEqual({ width: 1600, height: 1200, scale: 0.4 });
    expect(O.planResize(800, 600, 1600)).toEqual({ width: 800, height: 600, scale: 1 });
    expect(O.planResize(0, 0, 1600)).toEqual({ width: 1, height: 1, scale: 1 });
    expect(O.PHOTO_LIMITS).toEqual({ full: 1600, thumb: 480 });
    expect(O.formatClaimCode("ABCDEFGHJKMN")).toBe("ABCD-EFGH-JKMN");
    expect(O.formatClaimCode("short")).toBe("short");
  });
});

describe("the station: what each candidacy still needs, and what keeps a category from opening", () => {
  const base = { entryId: "e1", label: "#1111", kind: "INDIVIDUAL", withdrawn: false, association: "CONFIRMED", media: "APPROVED", selfRegistered: true, publicName: "Drácula", publicCode: "HAL-K7M2Q", entryConsent: true, photoDecision: "APPROVED" };

  it("walks a self-registered candidacy through verify → photo → consent → approve, showing the first unfinished step as current", () => {
    const fresh = { ...base, association: "UNCLAIMED", media: "NONE", entryConsent: false, photoDecision: null };
    expect(O.stationSteps(fresh).map((s) => `${s.key}:${s.state}`)).toEqual(["VERIFY:current", "PHOTO:todo", "CONSENT:todo", "APPROVE:todo"]);
    expect(O.currentStep(fresh)).toBe("VERIFY");
    const verified = { ...fresh, association: "CONFIRMED" };
    expect(O.stationSteps(verified).map((s) => `${s.key}:${s.state}`)).toEqual(["VERIFY:done", "PHOTO:current", "CONSENT:todo", "APPROVE:todo"]);
    const photographed = { ...verified, media: "PENDING_CONSENT" };
    expect(O.currentStep(photographed)).toBe("CONSENT");
    const consented = { ...verified, media: "PENDING_REVIEW", entryConsent: true };
    expect(O.currentStep(consented)).toBe("APPROVE");
    expect(O.currentStep(base)).toBeNull();
    expect(O.isReady(base)).toBe(true);
    const rejected = { ...verified, media: "REJECTED", entryConsent: true };
    expect(O.currentStep(rejected)).toBe("PHOTO"); // a rejected photograph is taken again
  });

  it("a candidacy the team made by hand is associated through the person's own phone, and a group needs its members", () => {
    const manual = { ...base, selfRegistered: false, association: "PENDING_CONFIRMATION", media: "NONE", entryConsent: false, photoDecision: null };
    expect(O.stationSteps(manual)[0]).toMatchObject({ key: "ASSOCIATE", state: "current" });
    const group = { ...base, kind: "GROUP", groupComplete: false };
    expect(O.stationSteps(group).map((s) => s.key)).toEqual(["VERIFY", "PHOTO", "CONSENT", "APPROVE", "MEMBERS"]);
    expect(O.currentStep(group)).toBe("MEMBERS");
    expect(O.currentStep({ ...group, groupComplete: true })).toBeNull();
    expect(O.stationSteps(null)).toEqual([]);
  });

  it("titles a candidacy by its public name, or says it has none", () => {
    expect(O.entryTitle(base)).toBe("Drácula");
    expect(O.entryTitle({ ...base, publicName: null })).toBe("Sin nombre · #1111");
    expect(O.entryTitle({ ...base, publicName: null, label: "" })).toBe("Sin nombre");
    expect(O.entryTitle(null)).toBe("");
  });

  it("a category opens only when EVERY candidacy is ready and there are at least two; a registration nobody completed is never dropped silently", () => {
    const ready = (id: string) => ({ ...base, entryId: id });
    const half = { ...base, entryId: "half", association: "UNCLAIMED", media: "NONE" };
    expect(O.categoryReadiness({ opened: false, entries: [ready("a"), ready("b")] })).toMatchObject({ canOpen: true, ready: 2, total: 2, reasons: [] });
    expect(O.categoryReadiness({ opened: false, entries: [ready("a")] })).toMatchObject({ canOpen: false, reasons: ["Se necesitan al menos 2 candidaturas."] });
    expect(O.categoryReadiness({ opened: false, entries: [] })).toMatchObject({ canOpen: false, reasons: ["Todavía no hay candidaturas."] });
    const blocked = O.categoryReadiness({ opened: false, entries: [ready("a"), ready("b"), half] });
    expect(blocked.canOpen).toBe(false);
    expect(blocked.pending.map((e) => e.entryId)).toEqual(["half"]);
    expect(blocked.reasons).toEqual(["Falta completar 1 candidatura."]);
    expect(O.categoryReadiness({ opened: false, entries: [ready("a"), ready("b"), half, { ...half, entryId: "h2" }] }).reasons).toEqual(["Faltan completar 2 candidaturas."]);
    // attributed members and withdrawn candidacies are not candidacies of the ballot
    expect(O.categoryReadiness({ opened: false, entries: [ready("a"), ready("b"), { ...half, kind: "GROUP_MEMBER" }, { ...half, entryId: "w", withdrawn: true }] }).canOpen).toBe(true);
    expect(O.categoryReadiness({ opened: true, entries: [ready("a")] })).toMatchObject({ opened: true, canOpen: false, reasons: [] });
    expect(O.categoryReadiness(null)).toMatchObject({ canOpen: false });
  });

  it("names the category's phase and the step after it closes: review, then publish", () => {
    expect(O.categoryPhaseLabel(null)).toBe("Sin datos");
    expect(O.categoryPhaseLabel({ opened: false })).toBe("Preparando");
    expect(O.categoryPhaseLabel({ opened: true, closed: false })).toBe("Votación abierta");
    expect(O.categoryPhaseLabel({ opened: true, closed: true, published: false })).toBe("Cerrada");
    expect(O.categoryPhaseLabel({ opened: true, closed: true, published: true })).toBe("Resultados publicados");
    expect(O.afterCloseStep({ closed: false })).toBeNull();
    expect(O.afterCloseStep({ closed: true, review: null })).toBe("REVIEW");
    expect(O.afterCloseStep({ closed: true, review: { current: false } })).toBe("REVIEW"); // a stale review is a review to do again
    expect(O.afterCloseStep({ closed: true, review: { current: true } })).toBe("PUBLISH");
    expect(O.afterCloseStep({ closed: true, published: true })).toBe("DONE");
  });

  it("states that the WhatsApp link cannot attach the picture and that opening it delivers nothing", () => {
    expect(O.DELIVERY_NOTICE).toMatch(/no adjunta la foto/);
    expect(O.DELIVERY_NOTICE).toMatch(/Abrir WhatsApp no marca nada como entregado/);
    expect(O.deliveryLabel("PENDING")).toBe("Envío pendiente");
    expect(O.deliveryLabel("DELIVERED")).toBe("Entregado");
    expect(O.deliveryLabel("???")).toBe("");
  });

  it("describes the operator's refusals in plain words", () => {
    for (const code of ["OPERATOR_REQUIRED", "HOST_TOKEN_MISMATCH", "PREPARATION_INCOMPLETE", "ALREADY_CANDIDATE", "SCHEDULE_INVALID", "CONFIRMATION_REJECTED", "ENTRY_HAS_MEDIA", "REVIEW_REQUIRED", "NETWORK"]) {
      const text = O.describeError(code);
      expect(text.length, code).toBeGreaterThan(10);
      expect(text, code).not.toMatch(/CV_|SQL|undefined|null/);
    }
    expect(O.describeError("OPERATOR_REQUIRED")).toBe("Esta cuenta no es la del operador del concurso.");
    expect(O.describeError("NEW_UNKNOWN")).toBe("No se pudo completar la acción. Intentalo de nuevo.");
  });
});

describe("the operator's clients: the bearer proves WHO, the category's host token proves the event, and the number has exactly one route", () => {
  const record = (reply: { status: number; json?: Json } = { status: 200, json: {} }) => {
    const seen: Array<{ url: string; init: Json }> = [];
    const fetchImpl: FetchImpl = async (url, init) => { seen.push({ url, init }); return { status: reply.status, json: async () => reply.json ?? {} }; };
    return { seen, fetchImpl };
  };

  it("every call carries both credentials; every route is the contest's own; the delivery number is read only by POST …/contact", async () => {
    const { seen, fetchImpl } = record();
    const api = O.buildOperatorApi(fetchImpl, async () => "bearer", () => "host-token", ID);
    await api.overview(); await api.results(); await api.info(); await api.schedule({ a: 1 }); await api.listing(true); await api.find("HAL-K7M2Q");
    await api.createEntry("INDIVIDUAL"); await api.createEntry("GROUP"); await api.removeEntry("e1"); await api.rename("e1", "Nombre");
    await api.confirmation("e1"); await api.photo("e1", "FULL", "THUMB"); await api.consent("e1", "p1", "v1"); await api.decision("e1", "p1", "APPROVED", "ok");
    await api.association("e1", "123456"); await api.addMember("g1"); await api.memberConsent("m1", "p1", "v1"); await api.withdraw("e1", "motivo", true);
    await api.contact("e1"); await api.delivered("e1"); await api.open("Elegí"); await api.close(); await api.review("nota"); await api.review(); await api.publish();
    const base = `/api/gaming/community-voting/rounds/${ID}`;
    expect(seen.map((s) => `${s.init.method} ${s.url.replace(base, "")}`)).toEqual([
      "GET /operator/overview", "GET /operator/results", "GET /info", "PUT /schedule", "PUT /operator/listing", "GET /operator/candidacies?code=HAL-K7M2Q",
      "POST /operator/entries", "POST /operator/entries", "DELETE /operator/entries/e1", "PUT /operator/entries/e1/name",
      "POST /operator/entries/e1/confirmation", "POST /operator/entries/e1/photo", "POST /operator/entries/e1/consent", "POST /operator/entries/e1/decision",
      "POST /operator/entries/e1/association", "POST /operator/entries/g1/members", "POST /operator/entries/m1/member-consent", "POST /operator/entries/e1/withdrawal",
      "POST /operator/entries/e1/contact", "POST /operator/entries/e1/delivery", "POST /operator/open", "POST /operator/close", "POST /operator/review", "POST /operator/review", "POST /operator/publish",
    ]);
    for (const s of seen) {
      expect((s.init.headers as Json).Authorization, s.url).toBe("Bearer bearer");
      expect((s.init.headers as Json)["x-host-token"], s.url).toBe("host-token");
    }
    expect(seen.filter((s) => /contact/.test(s.url)).length).toBe(1);
    expect(JSON.parse(seen[7].init.body)).toEqual({ kind: "GROUP" });
    expect(JSON.parse(seen[6].init.body)).toEqual({});
    expect(JSON.parse(seen[11].init.body)).toEqual({ fullImage: "FULL", thumbImage: "THUMB" });
    expect(JSON.parse(seen[12].init.body)).toEqual({ photoId: "p1", consentVersion: "v1", accepted: true, ageConfirmed: true });
    expect(JSON.parse(seen[17].init.body)).toEqual({ reason: "motivo", hidePhoto: true });
  });

  it("the code travels encoded and the setup calls are the platform's own plus the category's registration", async () => {
    const { seen, fetchImpl } = record({ status: 201, json: {} });
    const op = O.buildOperatorApi(fetchImpl, async () => null, () => "", ID);
    await op.find("HAL K7M2Q&x=1");
    expect(seen[0].url).toContain("code=HAL%20K7M2Q%26x%3D1");
    expect((seen[0].init.headers as Json).Authorization).toBeUndefined();
    const setup = O.buildSetupApi(fetchImpl, async () => "bearer");
    await setup.createSession(); await setup.declareVoting("s1", "h1"); await setup.registerCategory("s1", "h1", "SEXIEST", null); await setup.registerCategory("s2", "h2", "FUNNIEST", "c1"); await setup.contest("c1");
    expect(seen.slice(1).map((s) => `${s.init.method} ${s.url}`)).toEqual([
      "POST /api/sessions", "POST /api/sessions/s1/capabilities", "POST /api/gaming/community-voting/rounds", "POST /api/gaming/community-voting/rounds", "GET /api/gaming/community-voting/contests/c1",
    ]);
    expect(JSON.parse(seen[2].init.body)).toEqual({ hostToken: "h1", capabilities: ["VOTING"] });
    expect(JSON.parse(seen[3].init.body)).toEqual({ sessionId: "s1", categoryKey: "SEXIEST" });
    expect(JSON.parse(seen[4].init.body)).toEqual({ sessionId: "s2", categoryKey: "FUNNIEST", contestId: "c1" });
    expect((seen[3].init.headers as Json)["x-host-token"]).toBe("h1");
  });

  it("a failed network is a typed result, never a throw", async () => {
    const boom: FetchImpl = async () => { throw new Error("offline"); };
    expect(await O.buildOperatorApi(boom, async () => null, () => "", ID).overview()).toEqual({ status: 0, json: { code: "NETWORK" } });
  });
});

describe("what this browser keeps: the contest's keys, checked on every read", () => {
  const cat = (n: number) => ({ instanceId: `inst-${n}`, sessionId: `sess-${n}`, hostToken: `tok-${n}` });
  const full = { contestId: ID, ownerUserId: "u1", categories: { MOST_ELABORATE: cat(1), SEXIEST: cat(2), BEST_GROUP: cat(3), FUNNIEST: cat(4) } };

  it("accepts a well-formed copy, in text or as an object, and knows when all four categories are there", () => {
    expect(O.STORE_KEY).toBe("cv:operator:contest:v1");
    const parsed = O.parseKeys(JSON.stringify(full))!;
    expect(parsed.contestId).toBe(ID);
    expect(O.keysComplete(parsed)).toBe(true);
    expect(O.keysComplete(O.parseKeys({ ...full, categories: { MOST_ELABORATE: cat(1) } }))).toBe(false);
    expect(O.keysComplete(null)).toBe(false);
  });

  it("ignores anything else — garbage, a missing token, extra fields — and never trusts what is not a string", () => {
    for (const bad of ["", "not json", "[]", "null", JSON.stringify({}), JSON.stringify({ contestId: 1, categories: {} }), JSON.stringify({ contestId: ID }), JSON.stringify({ contestId: ID, categories: null })]) expect(O.parseKeys(bad), String(bad)).toBeNull();
    const noToken = O.parseKeys({ contestId: ID, categories: { SEXIEST: { instanceId: "i", hostToken: "" }, FUNNIEST: { instanceId: "i", hostToken: "t", extra: "x" } } })!;
    expect(Object.keys(noToken.categories)).toEqual(["FUNNIEST"]);
    expect(noToken.categories.FUNNIEST).toEqual({ instanceId: "i", sessionId: "", hostToken: "t" });
    expect(O.parseKeys({ contestId: ID, categories: { NOT_A_CATEGORY: cat(1) } })!.categories).toEqual({});
  });
});

describe("the venue's rotation: every shown costume once per pass, in a fresh order, no standing", () => {
  const Slideshow = load<{ createRotation(random?: () => number): { load(items: Json[]): void; next(): Json | null; needsRefresh(): boolean; passSize(): number } }>("communityVotingSlideshow.js", "CommunityVotingSlideshow");
  it("shows each item once per pass and starts the next pass with a different first", () => {
    const rot = Slideshow.createRotation(() => 0.42);
    rot.load([1, 2, 3, 4].map((n) => ({ alias: `c:${n}`, imageUrl: `/${n}` })));
    const first = Array.from({ length: 4 }, () => rot.next()!.alias);
    expect(new Set(first).size).toBe(4);
    expect(rot.needsRefresh()).toBe(true);
    const second = Array.from({ length: 4 }, () => rot.next()!.alias);
    expect(new Set(second).size).toBe(4);
    expect(second[0]).not.toBe(first[3]);
    expect(rot.passSize()).toBe(4);
  });
  it("drops a withdrawn candidacy at once and never repeats keys that share a number across categories", () => {
    const rot = Slideshow.createRotation(() => 0.1);
    rot.load([{ alias: "A:1111", imageUrl: "/a" }, { alias: "B:1111", imageUrl: "/b" }, { alias: "A:2222", imageUrl: "/c" }]);
    rot.next();
    rot.load([{ alias: "B:1111", imageUrl: "/b" }]);
    const rest: string[] = [];
    for (let i = 0; i < 2; i++) { const n = rot.next(); if (n) rest.push(n.alias); }
    expect(rest).toContain("B:1111");
    expect(rest).not.toContain("A:2222");
    expect(Slideshow.createRotation().next()).toBeNull();
  });
});
