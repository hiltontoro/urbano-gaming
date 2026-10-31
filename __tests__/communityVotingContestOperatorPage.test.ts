import { describe, expect, it, vi } from "vitest";

import {
  CONTEST, CONTESTS, INST, KEYS, NAMES, PAGES, ROUNDS, TEXTS, contestBody, loadPage, uuid,
} from "./helpers/contestPageHarness";
import type { Call, Json, Key, Page, Reply } from "./helpers/contestPageHarness";

/**
 * UG-IV-GATE-018 — the operator's STATION, the ACTUAL shipped page parsed and run whole in jsdom with the real logic modules, a stubbed identity seam and
 * a scripted fake server. What these tests pin is behaviour: what each credential is for, what the page sends at each step (and that it sends nothing
 * before the operator acts), what keeps a category from opening, and that the delivery number exists on the page only while the operator asks for it.
 * The real camera pipeline (a canvas) is verified in a real browser; everything around it is here.
 */

vi.setConfig({ testTimeout: 60_000 });

const HOST: Record<Key, string> = { MOST_ELABORATE: "host-1", SEXIEST: "host-2", BEST_GROUP: "host-3", FUNNIEST: "host-4" };
const SESSION: Record<Key, string> = { MOST_ELABORATE: uuid(51), SEXIEST: uuid(52), BEST_GROUP: uuid(53), FUNNIEST: uuid(54) };
const STORE = "cv:operator:contest:v1";
const keysJson = () => JSON.stringify({ contestId: CONTEST, ownerUserId: "stub-user", categories: Object.fromEntries(KEYS.map((k) => [k, { instanceId: INST[k], sessionId: SESSION[k], hostToken: HOST[k] }])) });
const operatorAuth = { status: "authenticated", email: "operador@ensayo.invalid" } as const;
const NUMBER = "+50499887766";

const entry = (n: number, over: Json = {}) => ({
  entryId: uuid(200 + n), label: `#${1000 + n}`, association: "CONFIRMED", media: "APPROVED", photoId: uuid(300 + n), promotional: "NOT_ASKED", withdrawn: false, carried: false, claimable: false, claimExpiresAt: null,
  kind: "INDIVIDUAL", groupEntryId: null, memberConsent: null, groupComplete: null, entryConsent: true, photoDecision: "APPROVED", publicCode: `HAL-${["22222", "33333", "44444", "55555"][n - 1] ?? "66666"}`, publicName: `Concursante ${n}`,
  selfRegistered: true, hasWhatsapp: true, deliveryStatus: "PENDING", ...over,
});
const overview = (entries: Json[], over: Json = {}) => ({ roundRole: "PRELIMINARY", isTest: false, sessionState: "LOBBY_OPEN", interactionState: null, opened: false, closed: false, published: false, serverNow: "2026-11-01T03:00:00.000Z", deadlineAt: null, review: null, entries, ...over });

interface OpWorld {
  overviews?: Partial<Record<Key, Json>>;
  found?: Record<string, { instanceId: string; categoryKey: Key; entryId: string }>;
  results?: Json;
  contest?: Parameters<typeof contestBody>[0];
  reply?: (call: Call) => Reply | undefined | Promise<Reply | undefined>;
}
function opServer(w: OpWorld = {}) {
  const state = { overviews: { ...(w.overviews ?? {}) } as Partial<Record<Key, Json>> };
  const responder = async (call: Call): Promise<Reply> => {
    const u = call.url.replace("http://localhost", "");
    const custom = w.reply ? await w.reply(call) : undefined;
    if (custom) return custom;
    if (u === `${CONTESTS}/${CONTEST}`) return { status: 200, json: contestBody(w.contest ?? {}) };
    const r = u.match(new RegExp(`^${ROUNDS}/([0-9a-f-]{36})/operator/(.+?)(\\?.*)?$`));
    if (r) {
      const key = KEYS.find((k) => INST[k] === r[1])!;
      // every operator call proves WHO (the bearer) and WHICH event (this category's own host token)
      if (!call.headers.Authorization || call.headers["x-host-token"] !== HOST[key]) return { status: 403, json: { code: "OPERATOR_REQUIRED" } };
      if (r[2] === "overview") return { status: 200, json: state.overviews[key] ?? overview([]) };
      if (r[2] === "candidacies") {
        const code = decodeURIComponent((u.split("code=")[1] ?? "").split("&")[0]);
        const hit = w.found?.[code];
        const e = hit ? (state.overviews[hit.categoryKey]?.entries as Json[]).find((x) => x.entryId === hit.entryId) : null;
        return { status: 200, json: { valid: true, candidacy: hit && e ? { entryId: e.entryId, instanceId: hit.instanceId, categoryKey: hit.categoryKey, publicCode: code, publicName: e.publicName } : null } };
      }
      if (r[2] === "results") return { status: 200, json: w.results ?? { rows: [], evidence: {} } };
      if (/\/contact$/.test(r[2])) return { status: 200, json: { whatsapp: NUMBER, deliveryStatus: "PENDING", message: "Hola Concursante 1, te escribimos del concurso de disfraces de The Pub by Beer Box. Tu código de candidatura es HAL-22222. Aquí está tu ficha: http://localhost/x", whatsappUrl: `https://wa.me/50499887766?text=${encodeURIComponent("Hola Concursante 1")}`, ficheUrl: "http://localhost/x", publicCode: "HAL-22222", publicName: "Concursante 1" } };
      if (/\/delivery$/.test(r[2])) return { status: 200, json: { entryId: "x", deliveryStatus: "DELIVERED", deliveredAt: "2026-11-01T03:10:00.000Z" } };
      // the acts change what the next read says, as the real server does
      const change = (patch: Json) => { state.overviews[key] = { ...(state.overviews[key] ?? overview([])), ...patch }; };
      if (r[2] === "open") { change({ opened: true }); return { status: 201, json: { started: {} } }; }
      if (r[2] === "close") { change({ closed: true }); return { status: 200, json: { closure: {} } }; }
      if (r[2] === "review") { change({ review: { current: true } }); return { status: 201, json: { review: {} } }; }
      if (r[2] === "publish") { change({ published: true }); return { status: 201, json: { publication: {} } }; }
      if (/\/(confirmation|consent|decision|name|photo|association|members|member-consent|withdrawal)$/.test(r[2]) || /^entries/.test(r[2]) || r[2] === "listing") return { status: r[2].endsWith("photo") || r[2].endsWith("consent") ? 201 : 200, json: { photoId: uuid(399), entry: { entryId: uuid(250), claimCode: "ABCDEFGHJKMN" } } };
    }
    if (u.endsWith("/schedule") || u === "/api/sessions" || /\/api\/sessions\/.+\/(capabilities|lock)$/.test(u) || u === ROUNDS) return { status: 200, json: {} };
    return { status: 404, json: { code: "NOT_FOUND" } };
  };
  return { state, responder };
}

const station = (w: OpWorld = {}, extra: { auth?: Parameters<typeof loadPage>[0]["auth"]; local?: Record<string, string> } = {}) => {
  const server = opServer(w);
  return loadPage({ html: PAGES.operator, query: "", respond: server.responder, auth: extra.auth ?? operatorAuth, local: extra.local ?? { [STORE]: keysJson() } }).then((p) => Object.assign(p, { server }));
};
const readyWorld = (over: Partial<OpWorld> = {}): OpWorld => ({
  overviews: {
    MOST_ELABORATE: overview([entry(1), entry(2)]),
    SEXIEST: overview([entry(1, { entryId: uuid(260) }), entry(2, { entryId: uuid(261) })]),
    BEST_GROUP: overview([entry(1, { entryId: uuid(270), kind: "GROUP", groupComplete: true })]),
    FUNNIEST: overview([entry(1, { entryId: uuid(280) }), entry(2, { entryId: uuid(281), association: "UNCLAIMED", media: "NONE", entryConsent: false, photoDecision: null, deliveryStatus: null })]),
  },
  ...over,
});
const writes = (p: Page, re: RegExp) => p.posts().filter((c) => re.test(c.url));

// ---------------------------------------------------------------- identity and the operator's keys

describe("the station: who may use it, and what this browser keeps", () => {
  it("signed out it offers only the sign-in and makes no request at all — not even with the keys in the browser", async () => {
    const p = await station({}, { auth: { status: "unauthenticated" } });
    expect(p.$("#stepIdentity")).toBeTruthy();
    expect(p.$("#tabs")!.className).toContain("hidden");
    expect(p.calls).toEqual([]);
    expect(p.text()).not.toMatch(/HAL-|Concursante/);
  });

  it("signed in with no keys it says there is no contest in this browser and leads to the configuration — and reads nothing", async () => {
    const p = await station({}, { local: {} });
    expect(p.text("#noContest")).toContain("Todavía no hay un concurso en este navegador");
    expect(p.$("#goConfig")).toBeTruthy();
    expect(p.calls).toEqual([]);
  });

  it("restores the keys from a copy, refuses a file that is not a copy, and then reads the four categories with each one's own host token", async () => {
    const p = await station({ ...readyWorld() }, { local: {} });
    await p.clickSel("#goConfig");
    const input = p.$("#restoreInput") as HTMLInputElement;
    const pick = async (text: string) => { Object.defineProperty(input, "files", { value: [{ text: async () => text }], configurable: true }); input.dispatchEvent(new p.win.Event("change", { bubbles: true })); await p.settle(); };
    await pick("this is not a copy");
    expect(p.text("#errorMsg")).toBe("Ese archivo no es una copia válida de las claves.");
    expect(p.win.localStorage.getItem(STORE)).toBeNull();
    await pick(keysJson());
    expect(p.text("#noticeMsg")).toBe("Claves restauradas.");
    expect(JSON.parse(p.win.localStorage.getItem(STORE)!).contestId).toBe(CONTEST);
    const overviews = p.calls.filter((c) => /operator\/overview/.test(c.url));
    expect(overviews).toHaveLength(4);
    for (const c of overviews) {
      const key = KEYS.find((k) => c.url.includes(INST[k]))!;
      expect(c.headers["x-host-token"]).toBe(HOST[key]);
      expect(c.headers.Authorization).toBe("Bearer stub-access-token");
    }
  });

  it("shows the four categories' state at a glance: where each stands, how many are ready and how many still need something", async () => {
    const p = await station(readyWorld());
    const strip = p.spaced("#strip");
    expect(strip).toContain("Disfraz más elaborado Preparando 2 listas · 0 por completar");
    expect(strip).toContain("Mejor disfraz en grupo Preparando 1 lista · 0 por completar");
    expect(strip).toContain("Disfraz más chistoso Preparando 1 lista · 1 por completar");
  });

  it("a refusal of the server is told in plain words and never repeats a technical text", async () => {
    const p = await station({ reply: (c) => (/operator\/overview/.test(c.url) ? { status: 403, json: { code: "HOST_TOKEN_MISMATCH" } } : undefined) });
    expect(p.text("#errorMsg")).toBe("Las claves guardadas en este navegador no corresponden a este concurso. Restaurá la copia de seguridad.");
  });
});

// ---------------------------------------------------------------- the station itself

describe("the station: search a code, verify the person, consent, approve", () => {
  const world = (over: Partial<OpWorld> = {}): OpWorld => {
    const fresh = entry(9, { entryId: uuid(209), association: "UNCLAIMED", media: "NONE", photoId: null, entryConsent: false, photoDecision: null, publicCode: "HAL-K7M2Q", publicName: "Drácula de Tegucigalpa" });
    const base = readyWorld();
    base.overviews!.MOST_ELABORATE = overview([entry(1), fresh]);
    base.found = { "HAL-K7M2Q": { instanceId: INST.MOST_ELABORATE, categoryKey: "MOST_ELABORATE", entryId: fresh.entryId } };
    return { ...base, ...over };
  };

  it("refuses a code that cannot be one — without asking the server — and says plainly when a good code finds nobody", async () => {
    const p = await station(world());
    await p.type(p.$("#codeSearch"), "HAL-0OIL1");
    await p.clickSel("#searchGo");
    expect(p.text("#searchBad")).toBe("Ese código no es válido. Los códigos se ven así: HAL-K7M2Q (no llevan 0, 1, I, L, O ni U).");
    expect(p.calls.filter((c) => /candidacies/.test(c.url))).toHaveLength(0);
    await p.type(p.$("#codeSearch"), "HAL-22222");
    await p.clickSel("#searchGo");
    expect(p.text("#searchMissing")).toBe("No encontramos ese código en este concurso. Revisalo con la persona.");
    expect(p.$("#workCard")).toBeNull();
  });

  it("finds the candidacy however the code is typed, with ONE request carrying both credentials, and opens its card: name, category, code and the steps", async () => {
    const p = await station(world());
    await p.type(p.$("#codeSearch"), " hal k7m2q ");
    await p.clickSel("#searchGo");
    const finds = p.calls.filter((c) => /candidacies/.test(c.url));
    expect(finds).toHaveLength(1);
    expect(finds[0].url).toContain("code=HAL-K7M2Q");
    expect(finds[0].headers["x-host-token"]).toBe(HOST.MOST_ELABORATE);
    expect(p.text("#workName")).toBe("Drácula de Tegucigalpa");
    expect(p.text("#workCode")).toBe("HAL-K7M2Q");
    expect(p.$$("#workSteps li").map((li) => `${li.dataset.step}:${li.className}`)).toEqual(["VERIFY:current", "PHOTO:todo", "CONSENT:todo", "APPROVE:todo"]);
    expect(p.text("#actionVerify")).toContain("Preguntale a la persona su nombre y su categoría");
    expect(p.text("#workCard")).toContain("Inscrita en línea");
    expect(p.markup()).not.toMatch(/99887766|9988-7766/); // no number anywhere on a card that has not asked for it
  });

  it("verifying sends ONE confirmation to the right category with its own host token — and nothing else is sent by looking", async () => {
    const p = await station(world());
    await p.type(p.$("#codeSearch"), "HAL-K7M2Q");
    await p.clickSel("#searchGo");
    expect(p.posts()).toEqual([]); // searching and reading write nothing
    await p.clickSel("#verifyBtn");
    const sent = writes(p, /confirmation$/);
    expect(sent).toHaveLength(1);
    expect(sent[0].url).toBe(`${ROUNDS}/${INST.MOST_ELABORATE}/operator/entries/${uuid(209)}/confirmation`);
    expect(sent[0].headers["x-host-token"]).toBe(HOST.MOST_ELABORATE);
    expect(sent[0].headers.Authorization).toBe("Bearer stub-access-token");
    expect(p.text("#noticeMsg")).toBe("Persona verificada.");
  });

  it("the consent step reads the SERVER's text to the person, keeps its button disabled until it is ticked, and sends the server's own version", async () => {
    const fresh = entry(9, { entryId: uuid(209), association: "CONFIRMED", media: "PENDING_CONSENT", photoId: uuid(309), entryConsent: false, photoDecision: null, publicCode: "HAL-K7M2Q", publicName: "Drácula" });
    const w = world();
    w.overviews!.MOST_ELABORATE = overview([entry(1), fresh]);
    const p = await station(w);
    await p.type(p.$("#codeSearch"), "HAL-K7M2Q");
    await p.clickSel("#searchGo");
    expect(p.$$("#workSteps li").map((li) => `${li.dataset.step}:${li.className}`)).toEqual(["VERIFY:done", "PHOTO:done", "CONSENT:current", "APPROVE:todo"]);
    expect(p.text("#consentText")).toBe(TEXTS.galleryConsent.text);
    expect((p.$("#consentBtn") as HTMLButtonElement).disabled).toBe(true);
    await p.check(p.$("#consentOk"));
    expect((p.$("#consentBtn") as HTMLButtonElement).disabled).toBe(false);
    await p.clickSel("#consentBtn");
    const sent = writes(p, /consent$/);
    expect(sent).toHaveLength(1);
    expect(sent[0].body).toEqual({ photoId: uuid(309), consentVersion: TEXTS.galleryConsent.version, accepted: true, ageConfirmed: true });
  });

  it("approving or rejecting sends the decision for THIS photograph; rejecting asks for another", async () => {
    const fresh = entry(9, { entryId: uuid(209), association: "CONFIRMED", media: "PENDING_REVIEW", photoId: uuid(309), entryConsent: true, photoDecision: null, publicCode: "HAL-K7M2Q" });
    const w = world();
    w.overviews!.MOST_ELABORATE = overview([entry(1), fresh]);
    const p = await station(w);
    await p.type(p.$("#codeSearch"), "HAL-K7M2Q");
    await p.clickSel("#searchGo");
    expect(p.$("#actionApprove")).toBeTruthy();
    await p.clickSel("#approveBtn");
    expect(writes(p, /decision$/)[0].body).toEqual({ photoId: uuid(309), decision: "APPROVED" });
    await p.clickSel("#rejectBtn");
    expect(writes(p, /decision$/)[1].body).toMatchObject({ photoId: uuid(309), decision: "REJECTED" });
  });

  it("a complete candidacy says so and offers the delivery; a withdrawn or removed one asks first", async () => {
    const p = await station(readyWorld({ found: { "HAL-22222": { instanceId: INST.MOST_ELABORATE, categoryKey: "MOST_ELABORATE", entryId: uuid(201) } } }));
    await p.type(p.$("#codeSearch"), "HAL-22222");
    await p.clickSel("#searchGo");
    expect(p.text("#workDone")).toBe("Esta candidatura está completa y es pública.");
    expect(p.$("#deliveryCard")).toBeTruthy();
    expect(p.$("#removeBtn")!.textContent).toBe("Retirar candidatura");
    await p.clickSel("#removeBtn");
    expect(p.modal()).toContain("¿Retirar esta candidatura?");
    expect(p.modal()).toContain("Esto no se puede deshacer");
    expect(writes(p, /withdrawal$/)).toHaveLength(0); // opening the question sends nothing
    await p.clickSel("#modalCancel");
    expect(writes(p, /withdrawal$/)).toHaveLength(0);
    await p.clickSel("#removeBtn");
    await p.clickSel("#modalConfirm");
    expect(writes(p, /withdrawal$/)).toHaveLength(1);
  });

  it("lists, apart and under their own heading, everything that still keeps a category from opening", async () => {
    const p = await station(readyWorld());
    expect(p.text("#pendingCard")).toContain("Por completar (1)");
    expect(p.text("#pendingCard")).toContain("Mientras quede alguna sin completar, esa categoría no se puede abrir.");
    expect(p.$$("#pendingCard [data-entry]")).toHaveLength(1);
  });
});

// ---------------------------------------------------------------- the delivery by hand

describe("the delivery by hand: the number exists on the page only while the operator asks for it", () => {
  const ready = () => readyWorld({ found: { "HAL-22222": { instanceId: INST.MOST_ELABORATE, categoryKey: "MOST_ELABORATE", entryId: uuid(201) } } });
  const open = async () => { const p = await station(ready()); await p.type(p.$("#codeSearch"), "HAL-22222"); await p.clickSel("#searchGo"); return p; };

  it("before preparing the delivery there is no number, no link and no contact request: the card only says what it is", async () => {
    const p = await open();
    expect(p.text("#deliveryCard")).toContain("La persona autorizó recibir su foto y su código. Este envío no bloquea su candidatura ni su voto.");
    expect(p.markup()).not.toMatch(/99887766|9988-7766|wa\.me/);
    expect(p.calls.filter((c) => /contact/.test(c.url))).toHaveLength(0);
    expect(p.$("#openWhatsapp")).toBeNull();
  });

  it("preparing it makes ONE audited request, then shows the number, a WhatsApp link that opens a new tab safely, the message to copy and the photograph to download", async () => {
    const p = await open();
    await p.clickSel("#prepareDelivery");
    const reads = p.posts().filter((c) => /contact$/.test(c.url));
    expect(reads).toHaveLength(1);
    expect(reads[0].headers["x-host-token"]).toBe(HOST.MOST_ELABORATE);
    expect(p.text("#deliveryCard")).toContain("Número: +504 9988-7766");
    const a = p.$("#openWhatsapp") as HTMLAnchorElement;
    expect(a.getAttribute("href")).toMatch(/^https:\/\/wa\.me\/50499887766\?text=/);
    expect(a.target).toBe("_blank");
    expect(a.rel).toBe("noopener noreferrer");
    expect(p.$("#copyMessage")).toBeTruthy();
    expect(p.$("#downloadPhoto")).toBeTruthy();
    await p.clickSel("#copyMessage");
    expect(p.clipboard[0]).toMatch(/^Hola Concursante 1, te escribimos del concurso de disfraces de The Pub by Beer Box\. Tu código de candidatura es HAL-22222\./);
    expect(p.clipboard[0]).not.toMatch(/adjunt|foto/i);
  });

  it("says that the link cannot attach the picture, and that opening WhatsApp delivers nothing", async () => {
    const p = await open();
    await p.clickSel("#prepareDelivery");
    expect(p.text("#deliveryCard")).toContain("no adjunta la foto: descargala y adjuntala vos");
    expect(p.text("#deliveryCard")).toContain("Abrir WhatsApp no marca nada como entregado");
    await p.clickSel("#openWhatsapp");
    expect(p.posts().filter((c) => /delivery$/.test(c.url))).toHaveLength(0);
  });

  it("«entregado» is recorded only by the operator's explicit, confirmed act — once", async () => {
    const p = await open();
    await p.clickSel("#prepareDelivery");
    await p.clickSel("#markDelivered");
    expect(p.modal()).toContain("¿Ya se la enviaste?");
    expect(p.posts().filter((c) => /delivery$/.test(c.url))).toHaveLength(0); // the question alone sends nothing
    await p.clickSel("#modalCancel");
    expect(p.posts().filter((c) => /delivery$/.test(c.url))).toHaveLength(0);
    await p.clickSel("#markDelivered");
    await p.clickSel("#modalConfirm");
    expect(p.posts().filter((c) => /delivery$/.test(c.url))).toHaveLength(1);
    expect(p.text("#noticeMsg")).toBe("Marcado como entregado.");
  });

  it("hides the number again on request, never stores it, and never puts it in a URL but the wa.me link the operator opens", async () => {
    const p = await open();
    await p.clickSel("#prepareDelivery");
    expect(p.$("#deliveryCard")!.textContent).toContain("9988-7766");
    expect(JSON.stringify([p.win.localStorage, p.win.sessionStorage])).not.toMatch(/9988|99887766/);
    await p.clickSel("#hideDelivery");
    expect(p.markup()).not.toMatch(/9988-7766|99887766|wa\.me/);
    expect(p.$("#prepareDelivery")).toBeTruthy();
    for (const c of p.calls) expect(c.url, c.url).not.toMatch(/9988|99887766/);
  });

  it("a delivery that is already recorded says so and offers nothing more to mark", async () => {
    const w = ready();
    w.overviews!.MOST_ELABORATE = overview([entry(1, { deliveryStatus: "DELIVERED" }), entry(2)]);
    const p = await station(w);
    await p.type(p.$("#codeSearch"), "HAL-22222");
    await p.clickSel("#searchGo");
    expect(p.text("#deliveryStatus")).toBe("Ya está marcado como entregado.");
    await p.clickSel("#prepareDelivery");
    expect(p.$("#markDelivered")).toBeNull();
  });
});

// ---------------------------------------------------------------- tracking, opening, closing, results

describe("tracking: what keeps a category from opening, and the explicit acts that open, close and announce", () => {
  const tracking = async (w = readyWorld()) => { const p = await station(w); await p.clickSel("#tabTracking"); return p; };

  it("opens nothing by itself: reading the contest, however ready, sends no write at all", async () => {
    const p = await tracking();
    expect(p.posts()).toEqual([]);
  });

  it("disables the opening of a category that is not ready and says exactly why — fewer than two, or a registration still to complete", async () => {
    const p = await tracking();
    const btn = (k: Key) => p.$(`[data-open="${k}"]`) as HTMLButtonElement;
    expect(btn("MOST_ELABORATE").disabled).toBe(false);
    expect(btn("BEST_GROUP").disabled).toBe(true);
    expect(btn("FUNNIEST").disabled).toBe(true);
    expect(p.spaced('section[data-category="BEST_GROUP"]')).toContain("Todavía no se puede abrir. Se necesitan al menos 2 candidaturas.");
    expect(p.spaced('section[data-category="FUNNIEST"]')).toContain("Todavía no se puede abrir. Falta completar 1 candidatura.");
  });

  it("offers to open every ready category at once, but only after an explicit confirmation naming them", async () => {
    const p = await tracking();
    expect(p.text("#openAll")).toContain("2 categorías están listas para abrir.");
    await p.clickSel("#openAllBtn");
    expect(p.modal()).toContain("¿Abrir las categorías listas?");
    expect(p.modal()).toContain("Se abren: Disfraz más elaborado, Disfraz más sexy.");
    expect(p.posts()).toEqual([]);
    await p.clickSel("#modalCancel");
    expect(p.posts()).toEqual([]);
  });

  it("opening a category locks its lobby with ITS host token, then opens it with the category's own prompt — in that order, and not before the operator confirms", async () => {
    const p = await tracking();
    await p.clickSel('[data-open="MOST_ELABORATE"]');
    expect(p.modal()).toContain("¿Abrir «Disfraz más elaborado»?");
    expect(p.modal()).toContain("A partir de ese momento no se pueden inscribir más personas");
    expect(p.posts()).toEqual([]);
    await p.clickSel("#modalConfirm");
    const order = p.posts().map((c) => c.url.replace(/^.*\/(sessions|rounds)\//, "$1/").replace(/[0-9a-f-]{36}/, "<id>"));
    expect(order).toEqual(["sessions/<id>/lock", "rounds/<id>/operator/open"]);
    expect(p.posts()[0].body).toEqual({ hostToken: HOST.MOST_ELABORATE });
    expect(p.posts()[0].url).toBe(`/api/sessions/${SESSION.MOST_ELABORATE}/lock`);
    expect(p.posts()[1].body.promptText).toMatch(/Elegí el disfraz más elaborado\. Podés cambiar tu voto hasta que cierre la votación\./);
    expect(p.posts()[1].headers["x-host-token"]).toBe(HOST.MOST_ELABORATE);
  });

  it("does not open when the lobby cannot be locked: nothing is started on a failed step", async () => {
    const p = await station(readyWorld({ reply: (c) => (/\/lock$/.test(c.url) ? { status: 500, json: {} } : undefined) }));
    await p.clickSel("#tabTracking");
    await p.clickSel('[data-open="MOST_ELABORATE"]');
    await p.clickSel("#modalConfirm");
    expect(p.posts().filter((c) => /operator\/open$/.test(c.url))).toHaveLength(0);
    expect(p.$("#errorMsg")).toBeTruthy();
  });

  it("an open category can be closed only after a confirmation that says nobody can vote or change their vote afterwards", async () => {
    const w = readyWorld();
    w.overviews!.MOST_ELABORATE = overview([entry(1), entry(2)], { opened: true, deadlineAt: "2026-11-01T06:00:00.000Z" });
    const p = await tracking(w);
    expect(p.$('[data-open="MOST_ELABORATE"]')).toBeNull();
    await p.clickSel('[data-close="MOST_ELABORATE"]');
    expect(p.modal()).toContain("Nadie podrá votar ni cambiar su voto.");
    expect(p.posts()).toEqual([]);
    await p.clickSel("#modalConfirm");
    expect(p.posts().map((c) => c.url.split("/").pop())).toEqual(["close"]);
  });

  it("after the close the operator reviews, then publishes — each a confirmed act, in that order, with the winners shown by name for the review", async () => {
    const w = readyWorld({ results: { rows: [{ entryId: uuid(201), label: "#1001", votes: 5, winner: true }, { entryId: uuid(202), label: "#1002", votes: 2, winner: false }], evidence: {} } });
    w.overviews!.MOST_ELABORATE = overview([entry(1), entry(2)], { opened: true, closed: true, review: null });
    const p = await station(w);
    await p.clickSel("#tabResults");
    await p.clickSel('[data-load-results="MOST_ELABORATE"]');
    expect(p.spaced('section[data-category="MOST_ELABORATE"]')).toContain("Concursante 1 5 votos · ganador");
    expect(p.spaced('section[data-category="MOST_ELABORATE"]')).toContain("Concursante 2 2 votos");
    expect(p.$('[data-publish="MOST_ELABORATE"]')).toBeNull(); // publishing needs the review first
    await p.clickSel('[data-review="MOST_ELABORATE"]');
    await p.clickSel("#modalConfirm");
    expect(p.posts().map((c) => c.url.split("/").pop())).toEqual(["review"]);
    expect(p.$('[data-review="MOST_ELABORATE"]')).toBeNull(); // the review is done: the next step is to publish
    await p.clickSel('[data-publish="MOST_ELABORATE"]');
    expect(p.modal()).toContain("Se anuncia públicamente quién ganó esta categoría. Esto no se puede deshacer.");
    await p.clickSel("#modalConfirm");
    expect(p.posts().map((c) => c.url.split("/").pop())).toEqual(["review", "publish"]);
  });
});

// ---------------------------------------------------------------- the contest's own configuration

describe("configuration: creating the contest and its schedule, away from the station", () => {
  const cfg = async (reply?: OpWorld["reply"]) => { const p = await station({ reply }, { local: {} }); await p.clickSel("#goConfig"); return p; };

  it("creates nothing until the operator asks, and then creates the four categories in order, each with its own Session, its VOTING capability and its registration", async () => {
    const created: Json[] = [];
    let n = 0;
    const p = await cfg((c) => {
      const u = c.url.replace("http://localhost", "");
      if (u === "/api/sessions") return { status: 201, json: { sessionId: uuid(600 + ++n), hostToken: `host-new-${n}` } };
      if (/\/capabilities$/.test(u)) return { status: 200, json: {} };
      if (/operator\/overview/.test(u)) return { status: 200, json: overview([]) };
      if (u === ROUNDS) { created.push(c.body); return { status: 201, json: { round: { instanceId: uuid(700 + created.length), contestId: CONTEST, categoryKey: c.body.categoryKey } } }; }
      return undefined;
    });
    expect(p.posts()).toEqual([]);
    expect(p.text("#setupState")).toBe("Todavía no están creadas las cuatro categorías.");
    await p.clickSel("#createContest");
    expect(created.map((b) => b.categoryKey)).toEqual(["MOST_ELABORATE", "SEXIEST", "BEST_GROUP", "FUNNIEST"]);
    expect(created[0].contestId).toBeUndefined(); // the first creates the contest
    for (const b of created.slice(1)) expect(b.contestId).toBe(CONTEST); // the rest join it
    const caps = p.posts().filter((c) => /capabilities$/.test(c.url));
    expect(caps.map((c) => c.body)).toEqual([1, 2, 3, 4].map((i) => ({ hostToken: `host-new-${i}`, capabilities: ["VOTING"] })));
    expect(p.text("#setupState")).toBe("Las cuatro categorías existen y sus claves están guardadas en este navegador.");
    const saved = JSON.parse(p.win.localStorage.getItem(STORE)!);
    expect(Object.keys(saved.categories)).toEqual(["MOST_ELABORATE", "SEXIEST", "BEST_GROUP", "FUNNIEST"]);
    expect(saved.categories.SEXIEST).toMatchObject({ hostToken: "host-new-2", sessionId: uuid(602) });
  });

  it("keeps the keys of whatever it created if a step fails, and a retry creates only what is missing", async () => {
    let n = 0; let fail = true; const registered: string[] = [];
    const reply: OpWorld["reply"] = (c) => {
      const u = c.url.replace("http://localhost", "");
      if (u === "/api/sessions") return { status: 201, json: { sessionId: uuid(600 + ++n), hostToken: `h${n}` } };
      if (/\/capabilities$/.test(u)) return { status: 200, json: {} };
      if (/operator\/overview/.test(u)) return { status: 200, json: overview([]) };
      if (u === ROUNDS) {
        if (c.body.categoryKey === "BEST_GROUP" && fail) return { status: 500, json: { code: "INTERNAL_ERROR" } };
        registered.push(c.body.categoryKey);
        return { status: 201, json: { round: { instanceId: uuid(700 + registered.length), contestId: CONTEST } } };
      }
      return undefined;
    };
    const p = await cfg(reply);
    await p.clickSel("#createContest");
    expect(p.text("#errorMsg")).toBe("Algo salió mal del lado del servidor. Intentalo de nuevo.");
    expect(Object.keys(JSON.parse(p.win.localStorage.getItem(STORE)!).categories)).toEqual(["MOST_ELABORATE", "SEXIEST"]);
    fail = false;
    await p.clickSel("#createContest");
    expect(registered).toEqual(["MOST_ELABORATE", "SEXIEST", "BEST_GROUP", "FUNNIEST"]);
    expect(p.text("#setupLog")).toContain("Disfraz más elaborado: ya existía");
  });

  it("saves the Halloween schedule into all four categories as the instants the server stores — and a nonsense order is refused before anything is sent", async () => {
    const p = await station({}, { auth: operatorAuth });
    await p.clickSel("#tabConfig");
    await p.clickSel("#fillPlan");
    await p.clickSel("#saveSchedule");
    const puts = p.calls.filter((c) => c.method === "PUT" && /schedule$/.test(c.url));
    expect(puts.map((c) => KEYS.find((k) => c.url.includes(INST[k])))).toEqual([...KEYS]);
    for (const c of puts) {
      expect(c.body).toEqual({ registrationOpensAt: "2026-11-01T02:00:00.000Z", contestantCutoffAt: "2026-11-01T05:00:00.000Z", votingOpensAt: "2026-11-01T05:00:00.000Z", votingClosesAt: "2026-11-01T06:00:00.000Z", status: "TENTATIVE" });
      expect(c.headers["x-host-token"]).toBe(HOST[KEYS.find((k) => c.url.includes(INST[k]))!]);
    }
    expect(p.text("#noticeMsg")).toBe("Horarios guardados en las cuatro categorías.");
    const before = puts.length;
    await p.type(p.$("#fRegClose"), "19:00"); // closes before it opens
    await p.clickSel("#saveSchedule");
    expect(p.calls.filter((c) => c.method === "PUT" && /schedule$/.test(c.url))).toHaveLength(before);
    expect(p.text("#errorMsg")).toBe("Los horarios no tienen sentido: inscripción, cierre de inscripción, apertura y cierre deben ir en ese orden.");
  });

  it("shows the Home entry as off until the operator turns it on, with a confirmation that says what Home will show", async () => {
    const p = await station({ contest: { listed: false } });
    await p.clickSel("#tabConfig");
    expect(p.text("#listingState")).toContain("El concurso no aparece en Inicio todavía");
    expect(p.$("#toggleListing")!.textContent).toBe("Mostrar el concurso en Inicio");
    await p.clickSel("#toggleListing");
    expect(p.modal()).toContain("¿Mostrar el concurso en Inicio?");
    expect(p.calls.filter((c) => /listing$/.test(c.url))).toHaveLength(0);
    await p.clickSel("#modalConfirm");
    const sent = p.calls.filter((c) => /listing$/.test(c.url));
    expect(sent).toHaveLength(1);
    expect(sent[0].method).toBe("PUT");
    expect(sent[0].body).toEqual({ listed: true });
  });

  it("lists the three public links of the contest (vote, register, venue) and says that opening them does not open voting", async () => {
    const p = await station();
    await p.clickSel("#tabConfig");
    expect(p.text("#linkVote")).toBe(`http://localhost/community-voting-round.html?c=${CONTEST}`);
    expect(p.text("#linkRegister")).toBe(`http://localhost/community-voting-round.html?c=${CONTEST}&participar=1`);
    expect(p.text("#linkDisplay")).toBe(`http://localhost/community-voting-round-display.html?c=${CONTEST}`);
    expect(p.text("#linksCard")).toContain("Abrirlos no abre la votación.");
  });

  it("offers a backup of the keys that stays in the browser's own download, and restoring is a separate, explicit act", async () => {
    const p = await station();
    await p.clickSel("#tabConfig");
    expect(p.$("#backupKeys")).toBeTruthy();
    expect(p.$("#restoreKeys")).toBeTruthy();
    expect(p.text("#backupCard")).toContain("Las claves de las cuatro categorías viven solo en este navegador.");
    expect(p.calls.filter((c) => c.method !== "GET")).toEqual([]);
  });
});

// ---------------------------------------------------------------- nothing of the retired format

describe("the station carries no trace of the retired format", () => {
  it("no geofence, no final, no cut, no policies and no location test in anything it renders", async () => {
    const FORBIDDEN = /geofence|geovalla|finalista|preliminar|\bla final\b|segunda ronda|ubicaci[oó]n|latitud|longitud|pol[ií]tica pendiente|prueba de ubicaci/i;
    const p = await station(readyWorld());
    for (const tab of ["#tabStation", "#tabTracking", "#tabResults", "#tabConfig"]) { await p.clickSel(tab); expect(p.text("#app"), tab).not.toMatch(FORBIDDEN); }
    expect(p.markup()).not.toMatch(FORBIDDEN);
    expect(NAMES.BEST_GROUP.kind).toBe("GROUP");
  });

  it("every request goes to the contest's own routes or to the platform's Session routes the station drives with the category's host token", async () => {
    const p = await station(readyWorld());
    await p.clickSel("#tabTracking");
    await p.clickSel('[data-open="MOST_ELABORATE"]');
    await p.clickSel("#modalConfirm");
    for (const c of p.calls) expect(c.url.replace("http://localhost", ""), c.url).toMatch(new RegExp(`^(${CONTESTS}/${CONTEST}|${ROUNDS}/[0-9a-f-]{36}/operator/(overview|candidacies|open)|/api/sessions/[0-9a-f-]{36}/lock)`));
  });
});
