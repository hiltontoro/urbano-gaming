import { describe, expect, it } from "vitest";
import { JSDOM } from "jsdom";
import { readFileSync } from "node:fs";
import path from "node:path";

/**
 * URBANO Score — the member's stepper over the ladder (public/soccer-predictions.html), and the administrator's level controls
 * (public/predictions-admin.html), each parsed and run whole in jsdom as shipped, with a stubbed fetch and a stubbed UrbanoAuth: no
 * network, no credentials. Proves, in Spanish and English:
 *   - the stepper ends at the highest level the venue OFFERS and says what is possible, never that a prize was won;
 *   - a person can send after completing any level, continue, go back and edit, with no skipped step and no default answer;
 *   - exactly the levels up to the one chosen at the moment of sending leave the browser; reducing asks for confirmation and clears
 *     what is above;
 *   - a saved participation comes back on reload; a failed send can be retried without a double send; a changed offer is reported;
 *   - "no team / no player / no goals" is an answer, a level that was not reached is not, and the result shows the difference;
 *   - the administrator keys a progressive match's prizes by ladder level and sees which venues take participations.
 */

const SCORE_HTML = readFileSync(path.join(process.cwd(), "public/soccer-predictions.html"), "utf8");
const ADMIN_HTML = readFileSync(path.join(process.cwd(), "public/predictions-admin.html"), "utf8");
const I18N_SOURCE = readFileSync(path.join(process.cwd(), "public/urbanoI18n.js"), "utf8");
const API = "/api/gaming/predictions";
const DIGEST = "ab".repeat(32);
const HOSTILE = '<img src=x onerror="window.__xss=(window.__xss||0)+1">';

interface Call { url: string; method: string; body: any }

function ladderOffer(levels: number[], digest = DIGEST) {
  return {
    available: levels.length > 0 && levels.every((l, i) => l === i + 1),
    maxLevel: levels.length,
    levels: levels.map((level) => ({ level, label: `Prize L${level}` })),
    digest: levels.length > 0 && levels.every((l, i) => l === i + 1) ? digest : null,
    problem: levels.length === 0 ? "NO_LEVELS" : levels.every((l, i) => l === i + 1) ? null : "GAP",
  };
}

function ladderMatch(over: Record<string, unknown> = {}, levels = [1, 2, 3, 4]) {
  return {
    matchId: "m1",
    predictionContract: "PROGRESSIVE_LADDER_V1",
    homeTeam: { teamId: "team-a", name: "Alpha FC", players: [{ playerId: "p1", name: "Ana Díaz" }, { playerId: "p2", name: "Bob Stone" }] },
    awayTeam: { teamId: "team-b", name: "Beta FC", players: [{ playerId: "p3", name: "Cleo Park" }] },
    competition: "Liga Nacional",
    kickoffAt: new Date(Date.now() + 3600_000).toISOString(),
    cancelledAt: null,
    finalized: false,
    finalResult: null,
    venueActivations: [
      {
        venueActivationId: "act-1",
        enabled: true,
        venue: { venueId: "v1", name: "Beer Box", latitude: 14.07, longitude: -87.19, radiusMeters: 150, active: true },
        prizeTiers: levels.map((l) => ({ prizeTierId: `tier-${l}`, correctDimensionCount: null, ladderLevel: l, prizeLabel: `Prize L${l}` })),
        offer: ladderOffer(levels),
      },
    ],
    ...over,
  };
}

function savedView(level: number, over: Record<string, unknown> = {}) {
  const view: Record<string, unknown> = {
    predictionId: "pr1", matchId: "m1", venueActivationId: "act-1", predictionContract: "PROGRESSIVE_LADDER_V1", attemptedLevel: level,
    scoreline: { home: 2, away: 1 }, acceptedOffer: { maxLevel: 4, digest: DIGEST }, createdAt: "x", updatedAt: "y",
  };
  if (level >= 2) view.firstTeam = { kind: "PICKED", team: "HOME" };
  if (level >= 3) view.goalscorer = { kind: "PICKED", playerId: "p1" };
  if (level >= 4) view.goalMinute = { kind: "PICKED", regulation: 30, stoppage: null };
  return { ...view, ...over };
}

interface LoadOptions {
  lang?: "es" | "en";
  match?: Record<string, unknown>;
  levels?: number[];
  mine?: Record<string, unknown>;
  authenticated?: boolean;
  memberId?: string;
  /** Entries already in this tab's session storage when the page starts: what a reload finds. */
  session?: Record<string, string>;
  /** "blocked": touching session storage throws; "full": reading works but every write throws (quota). */
  sessionStorage?: "blocked" | "full";
  geolocation?: boolean;
  predict?: (call: Call, index: number) => { status: number; json?: unknown } | "reject" | Promise<{ status: number; json?: unknown } | "reject">;
  matchesAfterFirst?: () => Record<string, unknown>;
}

async function loadScore(opts: LoadOptions = {}) {
  const calls: Call[] = [];
  let predictIndex = 0;
  let matchesLoads = 0;
  const initialMatch = ladderMatch(opts.match, opts.levels);
  const auth = { signedIn: opts.authenticated !== false, memberId: opts.memberId ?? "member-1" };
  const resetCallbacks: Array<() => void> = [];
  const changeCallbacks: Array<(state: unknown) => unknown> = [];
  const dom = new JSDOM(SCORE_HTML, {
    url: "http://localhost/soccer-predictions.html",
    runScripts: "dangerously",
    pretendToBeVisual: true,
    beforeParse(window) {
      const w = window as unknown as Record<string, any>;
      if (opts.lang === "en") window.localStorage.setItem("urbano.lang", "en");
      if (opts.sessionStorage === "blocked") {
        Object.defineProperty(window, "sessionStorage", { configurable: true, get() { throw new window.DOMException("denied", "SecurityError"); } });
      } else {
        for (const [key, value] of Object.entries(opts.session ?? {})) window.sessionStorage.setItem(key, value);
        if (opts.sessionStorage === "full") {
          const real = window.sessionStorage;
          Object.defineProperty(window, "sessionStorage", {
            configurable: true,
            value: {
              getItem: (key: string) => real.getItem(key),
              setItem: () => { throw new window.DOMException("full", "QuotaExceededError"); },
              removeItem: (key: string) => real.removeItem(key),
              key: (index: number) => real.key(index),
              get length() { return real.length; },
            },
          });
        }
      }
      window.eval(I18N_SOURCE);
      if (opts.geolocation !== false) {
        Object.defineProperty(window.navigator, "geolocation", {
          configurable: true,
          value: { getCurrentPosition: (ok: (p: unknown) => void) => ok({ coords: { latitude: 14.07, longitude: -87.19, accuracy: 5 } }) },
        });
      }
      w.UrbanoAuth = {
        attachSignInButton: () => {},
        getState: async () => (auth.signedIn ? { status: "authenticated", email: "m@example.com", gamingMemberId: auth.memberId, displayName: "Member" } : { status: "unauthenticated" }),
        getAccessToken: async () => "stub-token",
        onAuthStateChange: async () => () => {},
        onIdentityReset: async (callback: () => void) => { resetCallbacks.push(callback); return () => {}; },
        onIdentityChange: async (callback: (state: unknown) => unknown) => { changeCallbacks.push(callback); return () => {}; },
      };
      w.fetch = async (url: string, init: Record<string, any> = {}) => {
        const call: Call = { url: String(url), method: (init.method || "GET").toUpperCase(), body: typeof init.body === "string" ? JSON.parse(init.body) : undefined };
        calls.push(call);
        const reply = (status: number, json: unknown) => ({ status, json: async () => JSON.parse(JSON.stringify(json)) });
        if (call.url === `${API}/matches`) {
          matchesLoads += 1;
          const match = matchesLoads > 1 && opts.matchesAfterFirst ? { ...initialMatch, ...opts.matchesAfterFirst() } : initialMatch;
          return reply(200, { matches: [match] });
        }
        if (call.url === `${API}/matches/m1/mine`) return reply(200, opts.mine ?? { prediction: null, evaluation: null, qualification: null });
        if (call.url === `${API}/matches/m1/predict` && call.method === "POST") {
          const index = predictIndex++;
          const custom = opts.predict ? await opts.predict(call, index) : undefined;
          if (custom === "reject") throw new TypeError("network failure");
          if (custom) return reply(custom.status, custom.json ?? null);
          const b = call.body;
          const view: Record<string, unknown> = {
            predictionId: "pr1", matchId: "m1", venueActivationId: b.venueActivationId, predictionContract: "PROGRESSIVE_LADDER_V1",
            attemptedLevel: b.attemptedLevel, scoreline: b.scoreline, acceptedOffer: { maxLevel: 4, digest: b.offerDigest }, createdAt: "x", updatedAt: "y",
          };
          if (b.firstTeam) view.firstTeam = b.firstTeam;
          if (b.goalscorer) view.goalscorer = b.goalscorer;
          if (b.goalMinute) view.goalMinute = b.goalMinute;
          return reply(201, { prediction: view });
        }
        return reply(404, { error: "unexpected request" });
      };
    },
  });
  const win = dom.window as unknown as Window & Record<string, any>;
  const doc = win.document;
  const until = async (predicate: () => boolean, label = "condition", timeoutMs = 3000) => {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      if (predicate()) return;
      await new Promise((r) => setTimeout(r, 0));
      if (Date.now() > deadline) throw new Error("timed out waiting for " + label);
    }
  };
  await until(() => !!doc.querySelector("#content .card"), "the match card");
  const q = (sel: string) => doc.querySelector(sel) as HTMLElement | null;
  const qa = (sel: string) => [...doc.querySelectorAll(sel)] as HTMLElement[];
  const text = (el: Element | null) => (el?.textContent ?? "").replace(/\s+/g, " ").trim();
  const settle = (ms = 30) => new Promise((r) => setTimeout(r, ms));
  const actions = () => qa(".ladder-actions button");
  const action = (re: RegExp) => actions().find((b) => re.test(text(b))) as HTMLButtonElement | undefined;
  const click = async (el: Element | null | undefined) => { (el as HTMLElement).click(); await settle(); };
  const type = async (el: Element | null, value: string) => {
    const input = el as HTMLInputElement;
    input.value = value;
    input.dispatchEvent(new win.Event("input", { bubbles: true }));
    await settle();
  };
  const choose = async (el: Element | null, value: string) => {
    const select = el as HTMLSelectElement;
    select.value = value;
    select.dispatchEvent(new win.Event("change", { bubbles: true }));
    await settle();
  };
  const posts = () => calls.filter((c) => c.method === "POST" && c.url.endsWith("/predict"));
  // What this tab's session storage holds right now (empty when the browser denies it).
  const session = (): Record<string, string> => {
    try {
      const out: Record<string, string> = {};
      for (let i = 0; i < win.sessionStorage.length; i++) { const key = win.sessionStorage.key(i)!; out[key] = win.sessionStorage.getItem(key)!; }
      return out;
    } catch { return {}; }
  };
  // The person signs out, or another person signs in, in this tab: the shared module announces a reset, then the new identity.
  const changeIdentity = async (next: { signedIn: boolean; memberId?: string; resetOnly?: boolean }) => {
    auth.signedIn = next.signedIn;
    if (next.memberId) auth.memberId = next.memberId;
    for (const callback of resetCallbacks) callback();
    if (next.resetOnly) return; // the announcement of the new identity never arrives (for example the network fails)
    const state = next.signedIn ? { status: "authenticated", gamingMemberId: auth.memberId } : { status: "unauthenticated" };
    for (const callback of changeCallbacks) await callback(state);
    await settle(60);
  };
  return { win, doc, calls, q, qa, text, settle, actions, action, click, type, choose, posts, until, session, changeIdentity, matchesLoads: () => matchesLoads, close: () => dom.window.close() };
}
type Score = Awaited<ReturnType<typeof loadScore>>;

// Helpers that fill the levels the way a person would.
const home = (p: Score) => p.q("#ladder-home-m1") as HTMLInputElement;
const away = (p: Score) => p.q("#ladder-away-m1") as HTMLInputElement;
async function answerScoreline(p: Score, h = "2", a = "1") { await p.type(home(p), h); await p.type(away(p), a); }
async function answerFirst(p: Score, value: "HOME" | "AWAY" | "NONE") { await p.click(p.q(`.team-toggle[data-value="${value}"]`)); }
async function answerScorer(p: Score, value: string) { await p.choose(p.q("#ladder-scorer-m1"), value); }
async function answerMinute(p: Score, minute: string, stoppage = "") {
  await p.type(p.q("#ladder-minute-m1"), minute);
  if (stoppage) await p.type(p.q("#ladder-stoppage-m1"), stoppage);
}
async function sendAndConfirm(p: Score, level: number) {
  await p.click(p.action(new RegExp(`(Enviar con nivel|Guardar con nivel|Send with level|Save with level) ${level}`)));
  await p.click(p.action(/Confirmar y enviar|Confirm and send/));
  await p.settle(60);
}

const SPANISH_RULES = "Cada nivel requiere acertar todos los anteriores. Podés enviar al completar un nivel o continuar para intentar uno mayor. Recibís únicamente el premio del nivel más alto que acertés.";
const ENGLISH_RULES = "Each level requires getting every previous level right. You can send when you complete a level or continue to try a higher one. You receive only the prize of the highest level you get right.";

const DRAFT_KEY = "urbano.score.draft.member-1.m1";
const SPANISH_RESTORED = "Recuperamos tus respuestas sin enviar de este navegador. Todavía no están guardadas: enviá tu participación para guardarlas.";
const ENGLISH_RESTORED = "We restored your unsent answers from this browser. They are not saved yet: send your entry to save them.";
const SPANISH_DRAFT_STATUS = "Borrador en este navegador: todavía no está enviado ni guardado.";
const ENGLISH_DRAFT_STATUS = "Draft in this browser: not sent or saved yet.";
const SPANISH_DISCARDED = "No recuperamos tus respuestas sin enviar porque los premios o el lugar cambiaron desde que las escribiste. Revisá la oferta actual y volvé a responder.";
const ENGLISH_DISCARDED = "We did not restore your unsent answers because the prizes or the venue changed since you wrote them. Review the current offer and answer again.";
/** What a tab's session storage holds for a draft; every field a draft may carry, overridable to build tampered ones. */
function draftEntry(over: Record<string, unknown> = {}, answers: Record<string, unknown> = {}) {
  return JSON.stringify({
    v: 1, memberId: "member-1", matchId: "m1", contract: "PROGRESSIVE_LADDER_V1", activationId: "act-1", offerDigest: DIGEST, step: 1, baseUpdatedAt: null,
    a: { home: "2", away: "1", first: "", scorer: "", minuteNone: false, minute: "", stoppage: "", ...answers }, savedAt: "2026-10-24T10:00:00.000Z", ...over,
  });
}

// ---------------------------------------------------------------------------
// What the member is told and what the stepper offers
// ---------------------------------------------------------------------------

describe("the stepper and what it says", () => {
  it("states the rules in Spanish and in English, before anything is answered", async () => {
    const es = await loadScore();
    expect(es.text(es.q(".ladder-rules"))).toBe(SPANISH_RULES);
    const en = await loadScore({ lang: "en" });
    expect(en.text(en.q(".ladder-rules"))).toBe(ENGLISH_RULES);
    es.close();
    en.close();
  });

  it("starts at level 1 with no default answer: both scores are empty, and neither continuing nor sending is possible yet", async () => {
    const p = await loadScore();
    expect(home(p).value).toBe("");
    expect(away(p).value).toBe("");
    expect(home(p).placeholder).toBe("–");
    expect(p.action(/Continuar al nivel 2/)!.disabled).toBe(true);
    expect(p.action(/Enviar con nivel 1/)!.disabled).toBe(true);
    expect(p.text(p.q("[data-ladder-panel]"))).toContain("Respondé el nivel 1");
    p.close();
  });

  it("an empty score is not 0: the first tap of + or − sets 0, and only a tap does", async () => {
    const p = await loadScore();
    const plus = p.qa(".score-stepper button").filter((b) => b.textContent === "+");
    const minus = p.qa(".score-stepper button").filter((b) => b.textContent === "−");
    await p.click(plus[0]);
    expect(home(p).value).toBe("0");
    await p.click(plus[0]);
    await p.click(plus[0]);
    expect(home(p).value).toBe("2");
    await p.click(minus[0]);
    expect(home(p).value).toBe("1");
    await p.click(minus[1]);
    expect(away(p).value).toBe("0");
    await p.click(minus[1]);
    expect(away(p).value).toBe("0"); // never below zero
    p.close();
  });

  it("offers exactly the venue's levels: one step per offered level, and nothing about the levels it does not offer", async () => {
    for (const levels of [[1], [1, 2], [1, 2, 3], [1, 2, 3, 4]]) {
      const p = await loadScore({ levels });
      expect(p.qa(".ladder-step-btn")).toHaveLength(levels.length);
      expect(p.text(p.q("[data-ladder-panel]"))).not.toContain(`Nivel ${levels.length + 1}`);
      expect(p.qa(".ladder-offers li").map((li) => p.text(li))).toEqual(levels.map((l) => `Nivel ${l} · ${["Fácil", "Mediana", "Difícil", "Legendaria"][l - 1]}: Prize L${l}`));
      p.close();
    }
  });

  it("the stepper ends at the highest offered level: no 'continue' there, only 'send'", async () => {
    const p = await loadScore({ levels: [1, 2] });
    await answerScoreline(p);
    await p.click(p.action(/Continuar al nivel 2/));
    await answerFirst(p, "HOME");
    expect(p.action(/Continuar al nivel 3/)).toBeUndefined();
    expect(p.action(/Enviar con nivel 2/)!.disabled).toBe(false);
    p.close();
  });

  it("an activation with no valid offer takes no participation: a message, and no form", async () => {
    for (const levels of [[], [1, 3], [2]]) {
      const p = await loadScore({ levels });
      expect(p.q("form[data-ladder]")).toBeNull();
      expect(p.text(p.q("#content .card"))).toContain("ninguna sede tiene premios configurados");
      p.close();
    }
  });

  it("only offers a venue whose offer is valid when the match has several", async () => {
    const match = ladderMatch({}, [1, 2]);
    const second = { ...(match.venueActivations[0] as any), venueActivationId: "act-2", venue: { venueId: "v2", name: "Gap Bar", latitude: 14.07, longitude: -87.19, radiusMeters: 150, active: true }, offer: ladderOffer([1, 3]) };
    const p = await loadScore({ match: { venueActivations: [...match.venueActivations, second] }, levels: [1, 2] });
    expect(p.qa("select[id^=venue-select] option").map((o) => o.textContent)).toEqual(["Beer Box"]);
    p.close();
  });

  it("never claims a prize was won: the panel says what is possible, conditionally, and that completing a level gives nothing by itself", async () => {
    const p = await loadScore();
    await answerScoreline(p);
    const panel = p.text(p.q("[data-ladder-panel]"));
    expect(panel).toContain("el premio máximo posible en esta sede es: Prize L1. Solo lo recibís si acertás el marcador exacto.");
    expect(panel).toContain("Completar un nivel no da un premio por sí solo");
    expect(panel).not.toMatch(/ganaste|ganado|obtuviste|tu premio es/i);
    await p.click(p.action(/Continuar al nivel 2/));
    await answerFirst(p, "AWAY");
    expect(p.text(p.q("[data-ladder-panel]"))).toContain("Prize L2. Solo lo recibís si acertás el marcador exacto y el primer equipo en anotar.");
    p.close();
  });

  it("describes the prize of the level a step would send with, also when the person went back from a higher completed level", async () => {
    const p = await loadScore({ mine: { prediction: savedView(4), evaluation: null, qualification: null } });
    expect(p.text(p.q("[data-ladder-panel]"))).toContain("es: Prize L4. Solo lo recibís si acertás el marcador exacto, el primer equipo, un goleador y un minuto de gol.");
    await p.click(p.qa(".ladder-step-btn")[1]); // back to level 2 with levels 3 and 4 still answered
    expect(p.text(p.q("[data-ladder-panel]"))).toContain("Nivel actual: Nivel 2 · Mediana");
    expect(p.text(p.q("[data-ladder-panel]"))).toContain("es: Prize L2. Solo lo recibís si acertás el marcador exacto y el primer equipo en anotar.");
    expect(p.text(p.q("[data-ladder-panel]"))).not.toContain("Prize L4.");
    p.close();
  });

  it("shows the prizes actually configured for the selected venue, not a fixed list", async () => {
    const match = ladderMatch({}, [1, 2, 3]);
    const other = { ...(match.venueActivations[0] as any), venueActivationId: "act-2", venue: { venueId: "v2", name: "Other Bar", latitude: 14.07, longitude: -87.19, radiusMeters: 150, active: true }, offer: { ...ladderOffer([1, 2]), levels: [{ level: 1, label: "Other prize 1" }, { level: 2, label: "Other prize 2" }] } };
    const p = await loadScore({ match: { venueActivations: [...match.venueActivations, other] }, levels: [1, 2, 3] });
    expect(p.qa(".ladder-offers li").map((li) => p.text(li))[0]).toContain("Prize L1");
    await p.choose(p.q("select[id^=venue-select]"), "act-2");
    expect(p.qa(".ladder-offers li").map((li) => p.text(li))).toEqual(["Nivel 1 · Fácil: Other prize 1", "Nivel 2 · Mediana: Other prize 2"]);
    expect(p.qa(".ladder-step-btn")).toHaveLength(2);
    p.close();
  });

  it("is in English when the language is English, and the page switches language in place without losing what was typed", async () => {
    const p = await loadScore();
    await answerScoreline(p, "3", "0");
    p.win.UrbanoI18n.setLang("en");
    await p.settle();
    expect(p.text(p.q(".ladder-rules"))).toBe(ENGLISH_RULES);
    expect(p.text(p.q("[data-ladder-panel]"))).toContain("With this level, the highest possible prize at this venue is: Prize L1. You only get it if you get the exact scoreline right.");
    expect(p.action(/Send with level 1/)).toBeTruthy();
    expect(home(p).value).toBe("3");
    expect(away(p).value).toBe("0");
    p.win.UrbanoI18n.setLang("es");
    await p.settle();
    expect(p.text(p.q(".ladder-rules"))).toBe(SPANISH_RULES);
    p.close();
  });

  it("keeps the historical form for a historical match", async () => {
    const p = await loadScore({ match: { predictionContract: "COMPLETE_COUNT_V1", venueActivations: [{ ...(ladderMatch().venueActivations[0] as any), offer: null, prizeTiers: [{ prizeTierId: "t4", correctDimensionCount: 4, ladderLevel: null, prizeLabel: "Jersey" }] }] } });
    expect(p.q("form[data-ladder]")).toBeNull();
    expect(p.q("#home-score-m1")).not.toBeNull();
    expect(p.q("#goalscorer-select-m1")).not.toBeNull();
    p.close();
  });

  it("does not let team, player, venue or prize names reach an HTML parser", async () => {
    const levels = [1, 2, 3];
    const match = ladderMatch({
      homeTeam: { teamId: "a", name: HOSTILE, players: [{ playerId: "p1", name: HOSTILE }] },
      awayTeam: { teamId: "b", name: HOSTILE, players: [] },
    }, levels);
    (match.venueActivations[0] as any).venue.name = HOSTILE;
    (match.venueActivations[0] as any).offer.levels[0].label = HOSTILE;
    const p = await loadScore({ match, levels });
    await answerScoreline(p);
    await p.click(p.action(/Continuar al nivel 2/));
    await answerFirst(p, "HOME");
    await p.click(p.action(/Continuar al nivel 3/));
    expect(p.win.__xss).toBeUndefined();
    expect(p.doc.querySelector("img[src='x']")).toBeNull();
    p.close();
  });
});

// ---------------------------------------------------------------------------
// Answering, continuing, going back, sending
// ---------------------------------------------------------------------------

describe("answering the levels", () => {
  it("cannot skip a level: the next step stays closed until the current one is answered, and later steps stay closed after clearing an earlier one", async () => {
    const p = await loadScore();
    expect(p.qa(".ladder-step-btn").map((b) => (b as HTMLButtonElement).disabled)).toEqual([false, true, true, true]);
    await answerScoreline(p);
    expect(p.qa(".ladder-step-btn").map((b) => (b as HTMLButtonElement).disabled)).toEqual([false, false, true, true]);
    await p.click(p.action(/Continuar al nivel 2/));
    await answerFirst(p, "HOME");
    expect(p.qa(".ladder-step-btn").map((b) => (b as HTMLButtonElement).disabled)).toEqual([false, false, false, true]);
    await p.click(p.qa(".ladder-step-btn")[0]);
    await p.type(home(p), "");
    expect(p.qa(".ladder-step-btn").map((b) => (b as HTMLButtonElement).disabled)).toEqual([false, true, true, true]);
    expect(p.action(/Enviar con nivel 1/)!.disabled).toBe(true);
    p.close();
  });

  it("level 3 needs a player or the explicit 'no player' answer; level 4 a valid minute or the explicit 'no goals' answer", async () => {
    const p = await loadScore();
    await answerScoreline(p);
    await p.click(p.action(/Continuar al nivel 2/));
    await answerFirst(p, "NONE");
    await p.click(p.action(/Continuar al nivel 3/));
    expect(p.action(/Enviar con nivel 3/)!.disabled).toBe(true); // nothing chosen yet: not an answer
    expect(p.action(/Continuar al nivel 4/)!.disabled).toBe(true);
    await answerScorer(p, "NONE");
    expect(p.action(/Continuar al nivel 4/)!.disabled).toBe(false);
    await p.click(p.action(/Continuar al nivel 4/));
    expect(p.action(/Enviar con nivel 4/)!.disabled).toBe(true);
    await answerMinute(p, "91");
    expect(p.action(/Enviar con nivel 4/)!.disabled).toBe(true);
    await answerMinute(p, "30");
    expect(p.action(/Enviar con nivel 4/)!.disabled).toBe(false);
    await p.click(p.q(".ladder-none.team-toggle"));
    expect((p.q("#ladder-minute-m1") as HTMLInputElement).disabled).toBe(true);
    expect(p.action(/Enviar con nivel 4/)!.disabled).toBe(false);
    p.close();
  });

  it("added time is possible only at minute 45 or 90", async () => {
    const p = await loadScore();
    await answerScoreline(p);
    await p.click(p.action(/Continuar al nivel 2/));
    await answerFirst(p, "HOME");
    await p.click(p.action(/Continuar al nivel 3/));
    await answerScorer(p, "p1");
    await p.click(p.action(/Continuar al nivel 4/));
    await answerMinute(p, "30");
    expect((p.q("#ladder-stoppage-m1") as HTMLInputElement).disabled).toBe(true);
    await answerMinute(p, "45");
    expect((p.q("#ladder-stoppage-m1") as HTMLInputElement).disabled).toBe(false);
    await answerMinute(p, "45", "3");
    expect(p.action(/Enviar con nivel 4/)!.disabled).toBe(false);
    p.close();
  });

  it("the explanation says that choosing 'no team / no player / no goals' is an answer and that not answering is different", async () => {
    const p = await loadScore();
    await answerScoreline(p);
    await p.click(p.action(/Continuar al nivel 2/));
    expect(p.text(p.q("[data-ladder-body]"))).toContain("Elegir esta opción es una respuesta: es correcta solo si el partido termina sin goles en tiempo reglamentario. No responder es distinto: ese nivel no se evalúa.");
    p.close();
  });
});

describe("sending", () => {
  it("sends the first level alone: no other category in the request, the fingerprint of the offer, and a review first", async () => {
    const p = await loadScore();
    await answerScoreline(p, "2", "1");
    await p.click(p.action(/Enviar con nivel 1/));
    expect(p.posts()).toHaveLength(0); // a review comes first
    expect(p.text(p.q("[data-ladder-review]"))).toContain("Vas a enviar hasta el nivel 1 (Fácil).");
    expect(p.text(p.q("[data-ladder-review]"))).toContain("Marcador: 2–1");
    expect(p.text(p.q("[data-ladder-review]"))).toContain("Los niveles siguientes no se envían ni se evalúan.");
    await p.click(p.action(/Confirmar y enviar/));
    await p.settle(60);
    expect(p.posts()).toHaveLength(1);
    expect(p.posts()[0].body).toEqual({
      attemptedLevel: 1, scoreline: { home: 2, away: 1 }, venueActivationId: "act-1", offerDigest: DIGEST,
      latitude: 14.07, longitude: -87.19, accuracyMeters: 5,
    });
    expect(p.text(p.q("#submit-msg-m1"))).toContain("Participación guardada hasta el nivel 1 (Fácil).");
    p.close();
  });

  it("sends every level up to the one chosen, with explicit kinds, and a goalless answer as NONE", async () => {
    const p = await loadScore();
    await answerScoreline(p, "0", "0");
    await p.click(p.action(/Continuar al nivel 2/));
    await answerFirst(p, "NONE");
    await p.click(p.action(/Continuar al nivel 3/));
    await answerScorer(p, "NONE");
    await p.click(p.action(/Continuar al nivel 4/));
    await p.click(p.q(".ladder-none.team-toggle"));
    await sendAndConfirm(p, 4);
    expect(p.posts()[0].body).toMatchObject({
      attemptedLevel: 4, scoreline: { home: 0, away: 0 }, firstTeam: { kind: "NONE" }, goalscorer: { kind: "NONE" }, goalMinute: { kind: "NONE" },
    });
    p.close();
  });

  it("sends a picked team, player and minute with added time", async () => {
    const p = await loadScore();
    await answerScoreline(p, "3", "3");
    await p.click(p.action(/Continuar al nivel 2/));
    await answerFirst(p, "AWAY");
    await p.click(p.action(/Continuar al nivel 3/));
    await answerScorer(p, "p3");
    await p.click(p.action(/Continuar al nivel 4/));
    await answerMinute(p, "45", "2");
    await sendAndConfirm(p, 4);
    expect(p.posts()[0].body).toMatchObject({
      attemptedLevel: 4, scoreline: { home: 3, away: 3 }, firstTeam: { kind: "PICKED", team: "AWAY" },
      goalscorer: { kind: "PICKED", playerId: "p3" }, goalMinute: { kind: "PICKED", regulation: 45, stoppage: 2 },
    });
    p.close();
  });

  it("can send after completing any level, and the request holds exactly those levels (never a null category)", async () => {
    for (const level of [1, 2, 3]) {
      const p = await loadScore();
      await answerScoreline(p);
      if (level >= 2) { await p.click(p.action(/Continuar al nivel 2/)); await answerFirst(p, "HOME"); }
      if (level >= 3) { await p.click(p.action(/Continuar al nivel 3/)); await answerScorer(p, "p2"); }
      await sendAndConfirm(p, level);
      const body = p.posts()[0].body;
      expect(body.attemptedLevel).toBe(level);
      expect(Object.keys(body).filter((k) => ["firstTeam", "goalscorer", "goalMinute"].includes(k))).toEqual(["firstTeam", "goalscorer", "goalMinute"].slice(0, level - 1));
      expect(JSON.stringify(body)).not.toContain("null");
      p.close();
    }
  });

  it("going back to edit an earlier level changes what is sent; answers above the chosen level never leave the browser", async () => {
    const p = await loadScore();
    await answerScoreline(p, "2", "1");
    await p.click(p.action(/Continuar al nivel 2/));
    await answerFirst(p, "HOME");
    await p.click(p.action(/Continuar al nivel 3/));
    await answerScorer(p, "p1"); // level 3 answered...
    await p.click(p.action(/Volver/)); // ...back to level 2
    expect(p.text(p.q("[data-ladder-title]"))).toContain("¿Qué equipo anotará primero?");
    await answerFirst(p, "AWAY");
    await sendAndConfirm(p, 2); // ...and send with level 2
    const body = p.posts()[0].body;
    expect(body.attemptedLevel).toBe(2);
    expect(body.firstTeam).toEqual({ kind: "PICKED", team: "AWAY" });
    expect(body).not.toHaveProperty("goalscorer");
    expect(JSON.stringify(body)).not.toContain("p1");
    p.close();
  });

  it("after sending a lower level the answers above it are cleared: going up again finds the level empty", async () => {
    const p = await loadScore();
    await answerScoreline(p);
    await p.click(p.action(/Continuar al nivel 2/));
    await answerFirst(p, "HOME");
    await p.click(p.action(/Continuar al nivel 3/));
    await answerScorer(p, "p1");
    await p.click(p.action(/Volver/));
    await sendAndConfirm(p, 2);
    expect(p.text(p.q("#submit-msg-m1"))).toContain("hasta el nivel 2");
    await p.click(p.action(/Continuar al nivel 3/));
    expect((p.q("#ladder-scorer-m1") as HTMLSelectElement).value).toBe("");
    expect(p.action(/Guardar con nivel 3/)!.disabled).toBe(true);
    p.close();
  });

  it("does not send when no position can be read, and says so", async () => {
    const p = await loadScore({ geolocation: false });
    await answerScoreline(p);
    await p.click(p.action(/Enviar con nivel 1/));
    await p.click(p.action(/Confirmar y enviar/));
    await p.settle(60);
    expect(p.posts()).toHaveLength(0);
    expect(p.text(p.q("#submit-msg-m1"))).toContain("Se requiere tu ubicación");
    expect(p.action(/Confirmar y enviar/)!.disabled).toBe(false);
    p.close();
  });
});

describe("reducing a saved participation", () => {
  it("brings a saved participation back on reload, at its level, with its answers, and the venue locked", async () => {
    const p = await loadScore({ mine: { prediction: savedView(3), evaluation: null, qualification: null } });
    expect(home(p) || p.q("[data-ladder-title]")).toBeTruthy();
    expect(p.text(p.q("[data-ladder-title]"))).toContain("¿Quién marcará un gol?");
    expect((p.q("#ladder-scorer-m1") as HTMLSelectElement).value).toBe("p1");
    expect((p.q("select[id^=venue-select]") as HTMLSelectElement).disabled).toBe(true);
    expect(p.action(/Guardar con nivel 3/)!.disabled).toBe(false);
    p.close();
  });

  it("asks before reducing, says what is deleted, and sends only the lower level", async () => {
    const p = await loadScore({ mine: { prediction: savedView(3), evaluation: null, qualification: null } });
    await p.click(p.action(/Volver/));
    await p.click(p.action(/Guardar con nivel 2/));
    const review = p.text(p.q("[data-ladder-review]"));
    expect(review).toContain("Tu participación guardada llega hasta el nivel 3. Si la enviás con el nivel 2, se borran tus respuestas de los niveles siguientes.");
    expect(p.posts()).toHaveLength(0);
    await p.click(p.action(/Volver a editar/));
    expect(p.posts()).toHaveLength(0); // backing out of the review sends nothing
    await p.click(p.action(/Guardar con nivel 2/));
    await p.click(p.action(/Confirmar y enviar/));
    await p.settle(60);
    expect(p.posts()).toHaveLength(1);
    expect(p.posts()[0].body.attemptedLevel).toBe(2);
    expect(p.posts()[0].body).not.toHaveProperty("goalscorer");
    p.close();
  });

  it("does not warn when the level is kept or raised", async () => {
    const p = await loadScore({ mine: { prediction: savedView(2), evaluation: null, qualification: null } });
    await p.click(p.action(/Guardar con nivel 2/));
    expect(p.text(p.q("[data-ladder-review]"))).not.toContain("se borran");
    p.close();
  });
});

describe("retry, a changed offer, leaving the page", () => {
  it("a send that fails can be retried with the same request, and one tap sends once", async () => {
    let attempts = 0;
    const p = await loadScore({ predict: () => (++attempts === 1 ? "reject" : undefined as never) });
    await answerScoreline(p, "1", "0");
    await p.click(p.action(/Enviar con nivel 1/));
    await p.click(p.action(/Confirmar y enviar/));
    await p.settle(60);
    expect(p.text(p.q("#submit-msg-m1"))).toContain("No se pudo enviar la predicción.");
    expect(p.action(/Confirmar y enviar/)!.disabled).toBe(false);
    // The answers are still there, and the retry sends the very same request.
    (p.action(/Confirmar y enviar/) as HTMLButtonElement).click();
    (p.action(/Confirmar y enviar/) as HTMLButtonElement | undefined)?.click(); // a second tap while the first is in flight does nothing
    await p.settle(80);
    expect(p.posts()).toHaveLength(2);
    expect(p.posts()[1].body).toEqual(p.posts()[0].body);
    p.close();
  });

  it("reports a changed offer in the person's language, reloads the offer, and does not bring back answers given under the old one", async () => {
    let first = true;
    const p = await loadScore({
      predict: () => {
        if (first) {
          first = false;
          return { status: 409, json: { error: "The prizes offered at this venue changed since you loaded the page. Reload to see the current offer." } };
        }
        return undefined as never;
      },
      matchesAfterFirst: () => ({ venueActivations: [{ ...(ladderMatch().venueActivations[0] as any), offer: ladderOffer([1, 2, 3, 4], "cd".repeat(32)) }] }),
    });
    await answerScoreline(p, "4", "2");
    await p.click(p.action(/Enviar con nivel 1/));
    await p.click(p.action(/Confirmar y enviar/));
    await p.settle(120);
    expect(p.matchesLoads()).toBeGreaterThan(1);
    // The list was rebuilt and the person is told, on the new form: the answers were given under the old offer, so they are not put back
    // (nothing is stored for them either), and the next send carries the NEW fingerprint.
    expect(p.text(p.q("#submit-msg-m1"))).toBe("Los premios de esta sede cambiaron desde que cargaste la página. Recargá para ver la oferta actual.");
    expect(p.text(p.q("[data-ladder-discarded]"))).toBe(SPANISH_DISCARDED);
    expect(home(p).value).toBe("");
    expect(away(p).value).toBe("");
    expect(p.session()).toEqual({});
    await answerScoreline(p, "1", "0");
    await sendAndConfirm(p, 1);
    expect(p.posts()[1].body.offerDigest).toBe("cd".repeat(32));
    p.close();
  });

  it("shows the changed-offer message in English too, on the rebuilt form", async () => {
    const p = await loadScore({
      lang: "en",
      predict: () => ({ status: 409, json: { error: "The prizes offered at this venue changed since you loaded the page. Reload to see the current offer." } }),
      matchesAfterFirst: () => ({ venueActivations: [{ ...(ladderMatch().venueActivations[0] as any), offer: ladderOffer([1, 2, 3, 4], "cd".repeat(32)) }] }),
    });
    await answerScoreline(p, "1", "1");
    await p.click(p.action(/Send with level 1/));
    await p.click(p.action(/Confirm and send/));
    await p.settle(80);
    expect(p.matchesLoads()).toBeGreaterThan(1);
    expect(p.text(p.q("#submit-msg-m1"))).toBe("The prizes offered at this venue changed since you loaded the page. Reload to see the current offer.");
    expect(p.text(p.q("[data-ladder-discarded]"))).toBe(ENGLISH_DISCARDED);
    expect(home(p).value).toBe("");
    p.close();
  });

  it("a refusal about the offer that leaves the same offer on screen keeps the answers and does not claim they were discarded", async () => {
    const p = await loadScore({
      predict: () => ({ status: 409, json: { error: "The prizes offered at this venue changed since you loaded the page. Reload to see the current offer." } }),
      matchesAfterFirst: () => ({}),
    });
    await answerScoreline(p, "3", "3");
    await p.click(p.action(/Enviar con nivel 1/));
    await p.click(p.action(/Confirmar y enviar/));
    await p.settle(120);
    expect(p.text(p.q("#submit-msg-m1"))).toContain("Los premios de esta sede cambiaron");
    expect(p.q("[data-ladder-discarded]")).toBeNull();
    expect(home(p).value).toBe("3");
    expect(away(p).value).toBe("3");
    p.close();
  });

  it("shows a known server refusal in the person's language and an unknown one as a generic sentence", async () => {
    const p = await loadScore({ predict: () => ({ status: 409, json: { error: "This match already has a finalized result, so predictions can no longer be created or edited." } }) });
    await answerScoreline(p);
    await p.click(p.action(/Enviar con nivel 1/));
    await p.click(p.action(/Confirmar y enviar/));
    await p.settle(60);
    expect(p.text(p.q("#submit-msg-m1"))).toBe("Este partido ya tiene un resultado finalizado: ya no se pueden crear ni editar predicciones.");
    const q = await loadScore({ predict: () => ({ status: 500, json: { error: "A brand new message nobody mapped." } }) });
    await answerScoreline(q);
    await q.click(q.action(/Enviar con nivel 1/));
    await q.click(q.action(/Confirmar y enviar/));
    await q.settle(60);
    expect(q.text(q.q("#submit-msg-m1"))).toBe("No pudimos guardar tu predicción. Intentá de nuevo.");
    p.close();
    q.close();
  });

  it("with no usable session storage, asks the browser to confirm leaving the page while answers are unsent, and never after they are saved", async () => {
    for (const mode of ["blocked", "full"] as const) {
      const p = await loadScore({ sessionStorage: mode });
      const leave = () => {
        const event = new p.win.Event("beforeunload", { cancelable: true });
        p.win.dispatchEvent(event);
        return event.defaultPrevented;
      };
      expect(leave()).toBe(false);
      await answerScoreline(p);
      expect(leave()).toBe(true);
      await sendAndConfirm(p, 1);
      expect(leave()).toBe(false);
      await p.type(home(p), "9");
      expect(leave()).toBe(true);
      p.close();
    }
  });

  it("with a draft safely in session storage, leaving or reloading the page is not blocked: the answers come back", async () => {
    const p = await loadScore();
    const leave = () => {
      const event = new p.win.Event("beforeunload", { cancelable: true });
      p.win.dispatchEvent(event);
      return event.defaultPrevented;
    };
    await answerScoreline(p);
    expect(Object.keys(p.session())).toEqual([DRAFT_KEY]);
    expect(leave()).toBe(false);
    p.close();
  });
});

// ---------------------------------------------------------------------------
// The unsent draft: it survives a reload of this tab, and nowhere else
// ---------------------------------------------------------------------------

describe("the unsent draft", () => {
  const savedMine = (level: number, over: Record<string, unknown> = {}) => ({ prediction: savedView(level, over), evaluation: null, qualification: null });
  const secondVenue = () => ({
    ...(ladderMatch().venueActivations[0] as any),
    venueActivationId: "act-2",
    venue: { venueId: "v2", name: "Casa Roja", latitude: 14.07, longitude: -87.19, radiusMeters: 150, active: true },
    offer: ladderOffer([1, 2, 3, 4], "ee".repeat(32)),
  });
  const toggled = (p: Score) => p.q('.team-toggle[aria-pressed="true"]')?.getAttribute("data-value");
  const titleLevel = (p: Score) => p.q("[data-ladder-title]")?.getAttribute("data-ladder-title");
  const status = (p: Score) => p.text(p.q("[data-ladder-status]"));
  const message = (p: Score) => p.text(p.q("#submit-msg-m1"));
  const noPostsAtAll = (p: Score) => expect(p.calls.filter((c) => c.method !== "GET")).toEqual([]);

  describe("what is stored", () => {
    it("holds only the person's own answers, bound to the member, match, venue, contract and offer, and only in this tab's session storage", async () => {
      const p = await loadScore();
      expect(p.session()).toEqual({});
      await answerScoreline(p, "2", "1");
      await p.click(p.action(/Continuar al nivel 2/));
      await answerFirst(p, "HOME");
      const raw = p.session()[DRAFT_KEY];
      const stored = JSON.parse(raw);
      expect(Object.keys(stored).sort()).toEqual(["a", "activationId", "baseUpdatedAt", "contract", "matchId", "memberId", "offerDigest", "savedAt", "step", "v"]);
      expect(stored).toMatchObject({
        v: 1, memberId: "member-1", matchId: "m1", contract: "PROGRESSIVE_LADDER_V1", activationId: "act-1", offerDigest: DIGEST, step: 2, baseUpdatedAt: null,
        a: { home: "2", away: "1", first: "HOME", scorer: "", minuteNone: false, minute: "", stoppage: "" },
      });
      // No credential, no address, no name, and nothing outside session storage.
      for (const secret of ["stub-token", "m@example.com", "Member", "Bearer", "access_token", "refresh_token"]) expect(raw).not.toContain(secret);
      expect(Object.keys(p.session())).toEqual([DRAFT_KEY]);
      expect(Array.from({ length: p.win.localStorage.length }, (_, i) => p.win.localStorage.key(i)).filter((k) => /draft/i.test(String(k)))).toEqual([]);
      noPostsAtAll(p);
      p.close();
    });

    it("stores nothing while nothing is answered, and removes the draft when every answer is cleared", async () => {
      const p = await loadScore();
      expect(p.session()).toEqual({});
      await p.type(home(p), "3");
      expect(Object.keys(p.session())).toEqual([DRAFT_KEY]);
      await p.type(home(p), "");
      expect(p.session()).toEqual({});
      p.close();
    });
  });

  describe("restoring it after a reload", () => {
    it("brings back the answers, the step and the choice, says it is a local draft, and sends and saves nothing by itself", async () => {
      const first = await loadScore();
      await answerScoreline(first, "2", "1");
      await first.click(first.action(/Continuar al nivel 2/));
      await answerFirst(first, "AWAY");
      const snapshot = first.session();
      first.close();

      const p = await loadScore({ session: snapshot });
      expect(home(p)).toBeNull(); // the person is on step 2
      expect(titleLevel(p)).toBe("2");
      expect(toggled(p)).toBe("AWAY");
      expect(message(p)).toBe(SPANISH_RESTORED);
      expect(status(p)).toBe(SPANISH_DRAFT_STATUS);
      expect(p.q("[data-ladder-status]")!.hidden).toBe(false);
      // The draft stays in storage exactly as it was (only its "stored at" time is refreshed).
      const withoutTime = (store: Record<string, string>) => Object.fromEntries(Object.entries(store).map(([k, v]) => [k, { ...JSON.parse(v), savedAt: null }]));
      expect(withoutTime(p.session())).toEqual(withoutTime(snapshot));
      noPostsAtAll(p);
      // Going back shows the scoreline that was typed.
      await p.click(p.action(/Volver/));
      expect(home(p).value).toBe("2");
      expect(away(p).value).toBe("1");
      p.close();
    });

    it("what is sent after a restore is exactly the restored answers, once, and the draft is gone afterwards", async () => {
      const first = await loadScore();
      await answerScoreline(first, "2", "1");
      await first.click(first.action(/Continuar al nivel 2/));
      await answerFirst(first, "AWAY");
      const snapshot = first.session();
      first.close();

      const p = await loadScore({ session: snapshot });
      expect(p.posts()).toHaveLength(0);
      await sendAndConfirm(p, 2);
      expect(p.posts()).toHaveLength(1);
      expect(p.posts()[0].body).toMatchObject({ attemptedLevel: 2, scoreline: { home: 2, away: 1 }, firstTeam: { kind: "PICKED", team: "AWAY" }, offerDigest: DIGEST, venueActivationId: "act-1" });
      expect(p.session()).toEqual({});
      expect(status(p)).toBe("Guardado en tu cuenta: participación hasta el nivel 2 (Mediana).");
      p.close();
    });

    it("says so in English too", async () => {
      const first = await loadScore({ lang: "en" });
      await answerScoreline(first, "1", "0");
      const snapshot = first.session();
      first.close();
      const p = await loadScore({ lang: "en", session: snapshot });
      expect(message(p)).toBe(ENGLISH_RESTORED);
      expect(status(p)).toBe(ENGLISH_DRAFT_STATUS);
      p.close();
    });

    it("restores a deliberate 'none' and a 0–0 as answers, and an unanswered score as unanswered, never as 0", async () => {
      const first = await loadScore();
      await answerScoreline(first, "0", "0");
      await first.click(first.action(/Continuar al nivel 2/));
      await answerFirst(first, "NONE");
      await first.click(first.action(/Continuar al nivel 3/));
      await answerScorer(first, "NONE");
      await first.click(first.action(/Continuar al nivel 4/));
      await first.click(first.q(".team-toggle.ladder-none"));
      const snapshot = first.session();
      first.close();

      const p = await loadScore({ session: snapshot });
      expect(titleLevel(p)).toBe("4");
      expect(p.q(".team-toggle.ladder-none")!.getAttribute("aria-pressed")).toBe("true");
      expect(p.action(/Enviar con nivel 4/)!.disabled).toBe(false);
      await p.click(p.action(/Volver/));
      expect((p.q("#ladder-scorer-m1") as HTMLSelectElement).value).toBe("NONE");
      await p.click(p.action(/Volver/));
      expect(toggled(p)).toBe("NONE");
      await p.click(p.action(/Volver/));
      expect([home(p).value, away(p).value]).toEqual(["0", "0"]);
      p.close();

      const half = await loadScore();
      await half.type(home(half), "0");
      const reloaded = await loadScore({ session: half.session() });
      expect([home(reloaded).value, away(reloaded).value]).toEqual(["0", ""]);
      expect(reloaded.action(/Enviar con nivel 1/)!.disabled).toBe(true);
      half.close();
      reloaded.close();
    });

    it("keeps the stored draft current as the person keeps editing after a restore", async () => {
      const p = await loadScore({ session: { [DRAFT_KEY]: draftEntry() } });
      expect(home(p).value).toBe("2");
      await p.type(away(p), "3");
      expect(JSON.parse(p.session()[DRAFT_KEY]).a).toMatchObject({ home: "2", away: "3" });
      p.close();
    });
  });

  describe("when it is not restored", () => {
    const offerChanged = { venueActivations: [{ ...(ladderMatch().venueActivations[0] as any), offer: ladderOffer([1, 2, 3, 4], "cd".repeat(32)) }] };

    it("drops a draft whose prize offer is no longer the one it was answered under, and says so (Spanish and English)", async () => {
      const es = await loadScore({ session: { [DRAFT_KEY]: draftEntry() }, match: offerChanged });
      expect([home(es).value, away(es).value]).toEqual(["", ""]);
      expect(es.text(es.q("[data-ladder-discarded]"))).toBe(SPANISH_DISCARDED);
      expect(es.session()).toEqual({});
      noPostsAtAll(es);
      const en = await loadScore({ lang: "en", session: { [DRAFT_KEY]: draftEntry() }, match: offerChanged });
      expect(en.text(en.q("[data-ladder-discarded]"))).toBe(ENGLISH_DISCARDED);
      expect(home(en).value).toBe("");
      es.close();
      en.close();
    });

    it("drops a draft for a venue that is no longer offered", async () => {
      const p = await loadScore({ session: { [DRAFT_KEY]: draftEntry({ activationId: "act-gone" }) } });
      expect(home(p).value).toBe("");
      expect(p.text(p.q("[data-ladder-discarded]"))).toBe(SPANISH_DISCARDED);
      expect(p.session()).toEqual({});
      p.close();
    });

    it("drops a draft when the venue no longer offers anything", async () => {
      const p = await loadScore({ levels: [], session: { [DRAFT_KEY]: draftEntry() } });
      expect(p.q("form[data-ladder]")).toBeNull();
      expect(p.session()).toEqual({});
      p.close();
    });

    it("drops a draft once kick-off has passed", async () => {
      const p = await loadScore({ match: { kickoffAt: new Date(Date.now() - 60_000).toISOString() }, session: { [DRAFT_KEY]: draftEntry() } });
      expect(p.q("form[data-ladder]")).toBeNull();
      expect(p.session()).toEqual({});
      p.close();
    });

    it("drops a draft once a result is finalized, even if the kick-off was moved later", async () => {
      const p = await loadScore({ match: { finalized: true, finalResult: { homeScore: 1, awayScore: 0 }, kickoffAt: new Date(Date.now() + 86_400_000).toISOString() }, session: { [DRAFT_KEY]: draftEntry() } });
      expect(p.q("form[data-ladder]")).toBeNull();
      expect(p.session()).toEqual({});
      p.close();
    });

    it("removes drafts of matches that are not open, and drafts that are not this member's", async () => {
      const p = await loadScore({
        session: {
          [DRAFT_KEY]: draftEntry(),
          "urbano.score.draft.member-1.m-gone": draftEntry({ matchId: "m-gone" }),
          "urbano.score.draft.member-2.m1": draftEntry({ memberId: "member-2" }),
          "unrelated.key": "kept",
        },
      });
      expect(Object.keys(p.session()).sort()).toEqual([DRAFT_KEY, "unrelated.key"].sort());
      expect(home(p).value).toBe("2");
      p.close();
    });

    it("never shows another person's draft: it is removed, and the form starts empty", async () => {
      const p = await loadScore({ memberId: "member-2", session: { [DRAFT_KEY]: draftEntry() } });
      expect([home(p).value, away(p).value]).toEqual(["", ""]);
      expect(p.session()).toEqual({});
      p.close();
    });

    it("a draft stored under one member's key that claims another member or match is not trusted", async () => {
      for (const over of [{ memberId: "member-2" }, { matchId: "m2" }, { contract: "COMPLETE_COUNT_V1" }]) {
        const p = await loadScore({ session: { [DRAFT_KEY]: draftEntry(over) } });
        expect(home(p).value).toBe("");
        expect(p.session()).toEqual({});
        p.close();
      }
    });

    it("a signed-out visitor keeps no draft, and sees only the sign-in prompt", async () => {
      const p = await loadScore({ authenticated: false, session: { [DRAFT_KEY]: draftEntry() } });
      expect(p.q("form[data-ladder]")).toBeNull();
      expect(p.session()).toEqual({});
      p.close();
    });

    it("ignores storage that is corrupt, tampered with or the wrong shape, removes it, and the page works", async () => {
      const bad: string[] = [
        "not json", "null", "[]", '"text"', "42", "{}",
        draftEntry({ v: 2 }), draftEntry({ step: 7 }), draftEntry({ step: 0 }), draftEntry({ step: "2" }), draftEntry({ step: 1.5 }),
        draftEntry({ offerDigest: "short" }), draftEntry({ offerDigest: "AB".repeat(32) }), draftEntry({ activationId: "" }), draftEntry({ activationId: 5 }),
        draftEntry({ baseUpdatedAt: 5 }), draftEntry({ a: null }), draftEntry({ a: [] }),
        draftEntry({}, { home: "abc" }), draftEntry({}, { home: "-1" }), draftEntry({}, { home: "1".repeat(12) }), draftEntry({}, { away: 4 }),
        draftEntry({}, { first: "MAYBE" }), draftEntry({}, { scorer: HOSTILE }), draftEntry({}, { minuteNone: "yes" }), draftEntry({}, { minute: "9x" }),
        "x".repeat(5000),
      ];
      for (const raw of bad) {
        const p = await loadScore({ session: { [DRAFT_KEY]: raw } });
        expect(home(p).value, raw.slice(0, 60)).toBe("");
        expect(p.q("[data-ladder-discarded]")).toBeNull();
        expect(p.session(), raw.slice(0, 60)).toEqual({});
        await answerScoreline(p, "1", "1");
        expect(p.action(/Enviar con nivel 1/)!.disabled).toBe(false);
        p.close();
      }
      expect((globalThis as any).__xss).toBeUndefined();
    });

    it("never carries back answers above the highest level a venue offers", async () => {
      const full = draftEntry({ step: 4 }, { first: "HOME", scorer: "p1", minute: "30" });
      const p = await loadScore({ levels: [1, 2], session: { [DRAFT_KEY]: full } });
      expect(p.qa(".ladder-step-btn")).toHaveLength(2);
      const stored = JSON.parse(p.session()[DRAFT_KEY]);
      expect(stored.a).toMatchObject({ first: "HOME", scorer: "", minute: "", minuteNone: false });
      await sendAndConfirm(p, 2);
      expect(p.posts()[0].body.goalscorer).toBeUndefined();
      expect(p.posts()[0].body.goalMinute).toBeUndefined();
      p.close();
    });
  });

  describe("signing out and changing person", () => {
    it("signing out removes every draft, including another person's, and signing in again finds an empty form", async () => {
      const p = await loadScore();
      await answerScoreline(p, "2", "2");
      p.win.sessionStorage.setItem("urbano.score.draft.member-9.m1", draftEntry({ memberId: "member-9" }));
      p.win.sessionStorage.setItem("unrelated.key", "kept");
      expect(Object.keys(p.session()).sort()).toEqual([DRAFT_KEY, "unrelated.key", "urbano.score.draft.member-9.m1"].sort());
      await p.changeIdentity({ signedIn: false });
      expect(Object.keys(p.session())).toEqual(["unrelated.key"]);
      expect(p.q("form[data-ladder]")).toBeNull();
      await p.changeIdentity({ signedIn: true, memberId: "member-1" });
      expect([home(p).value, away(p).value]).toEqual(["", ""]);
      p.close();
    });

    it("the reset itself removes every draft: it does not depend on the list being rebuilt afterwards", async () => {
      const p = await loadScore();
      await answerScoreline(p, "2", "2");
      expect(Object.keys(p.session())).toEqual([DRAFT_KEY]);
      await p.changeIdentity({ signedIn: false, resetOnly: true });
      expect(p.session()).toEqual({});
      p.close();
    });

    it("a different person signing in finds neither the previous person's form nor their draft", async () => {
      const p = await loadScore();
      await answerScoreline(p, "4", "4");
      await p.changeIdentity({ signedIn: true, memberId: "member-2" });
      expect([home(p).value, away(p).value]).toEqual(["", ""]);
      expect(p.session()).toEqual({});
      await answerScoreline(p, "1", "0");
      expect(Object.keys(p.session())).toEqual(["urbano.score.draft.member-2.m1"]);
      p.close();
    });
  });

  describe("beside a saved participation", () => {
    it("unsent changes come back over the saved entry, shown as both, and the saved entry is untouched", async () => {
      const draft = draftEntry({ step: 2, baseUpdatedAt: "y" }, { home: "5", away: "0", first: "HOME" });
      const p = await loadScore({ mine: savedMine(2), session: { [DRAFT_KEY]: draft } });
      expect(message(p)).toBe("Recuperamos cambios sin enviar de este navegador sobre tu participación guardada. Lo guardado no cambia hasta que la envíes.");
      expect(status(p)).toBe("Guardado en tu cuenta: hasta el nivel 2 (Mediana). Tenés cambios sin enviar en este navegador: todavía no están guardados.");
      expect((p.q("select") as HTMLSelectElement).disabled).toBe(true);
      await p.click(p.action(/Volver/));
      expect([home(p).value, away(p).value]).toEqual(["5", "0"]);
      noPostsAtAll(p);
      expect(JSON.parse(p.session()[DRAFT_KEY]).baseUpdatedAt).toBe("y");
      p.close();
    });

    it("a draft identical to what is saved is not a draft: nothing is kept and the status shows only the saved entry", async () => {
      const same = draftEntry({ step: 2, baseUpdatedAt: "y" }, { home: "2", away: "1", first: "HOME" });
      const p = await loadScore({ mine: savedMine(2), session: { [DRAFT_KEY]: same } });
      expect(status(p)).toBe("Guardado en tu cuenta: participación hasta el nivel 2 (Mediana).");
      expect(p.session()).toEqual({});
      p.close();
    });

    it("never overwrites an entry that was saved elsewhere: asks first, applies nothing, and sends nothing", async () => {
      const draft = draftEntry({ baseUpdatedAt: "y" }, { home: "5", away: "5" });
      const p = await loadScore({ mine: savedMine(3, { updatedAt: "z" }), session: { [DRAFT_KEY]: draft } });
      expect(p.q("form[data-ladder]")).toBeNull();
      expect(p.q("[data-ladder-conflict]")).not.toBeNull();
      const lines = p.qa("[data-ladder-conflict] li").map((li) => p.text(li));
      expect(lines).toEqual(["Guardado en tu cuenta: hasta el nivel 3 (Difícil), marcador 2–1.", "Borrador de este navegador, sin enviar: hasta el nivel 1 (Fácil), marcador 5–5."]);
      noPostsAtAll(p);
      expect(Object.keys(p.session())).toEqual([DRAFT_KEY]); // nothing decided yet

      // Keep what is saved: the draft is discarded, the form shows the saved answers, nothing was sent.
      await p.click(p.q("[data-conflict-keep]"));
      expect(p.q("[data-ladder-conflict]")).toBeNull();
      expect(p.session()).toEqual({});
      expect(status(p)).toBe("Guardado en tu cuenta: participación hasta el nivel 3 (Difícil).");
      await p.click(p.action(/Volver/));
      await p.click(p.action(/Volver/));
      expect([home(p).value, away(p).value]).toEqual(["2", "1"]);
      noPostsAtAll(p);
      p.close();
    });

    it("on a conflict the person can choose to continue from the draft, which stays unsent until they confirm", async () => {
      const draft = draftEntry({ baseUpdatedAt: "y" }, { home: "5", away: "5" });
      const p = await loadScore({ mine: savedMine(3, { updatedAt: "z" }), session: { [DRAFT_KEY]: draft } });
      await p.click(p.q("[data-conflict-use]"));
      expect([home(p).value, away(p).value]).toEqual(["5", "5"]);
      expect(status(p)).toBe("Guardado en tu cuenta: hasta el nivel 3 (Difícil). Tenés cambios sin enviar en este navegador: todavía no están guardados.");
      noPostsAtAll(p);
      expect(JSON.parse(p.session()[DRAFT_KEY]).baseUpdatedAt).toBe("z"); // now starts from what is saved
      p.close();
    });

    it("a draft that never started from a saved entry is also a conflict when one exists now, and shows in English", async () => {
      const p = await loadScore({ lang: "en", mine: savedMine(1, { updatedAt: "z" }), session: { [DRAFT_KEY]: draftEntry() } });
      expect(p.text(p.q("[data-ladder-conflict] h3"))).toBe("Your saved entry does not match this draft");
      expect(p.text(p.q("[data-conflict-keep]"))).toBe("Keep what is saved and discard the draft");
      expect(p.text(p.q("[data-conflict-use]"))).toBe("Continue with the draft (still not sent)");
      expect(p.qa("[data-ladder-conflict] li").map((li) => p.text(li))).toEqual([
        "Saved to your account: up to level 1 (Easy), scoreline 2–1.",
        "Draft in this browser, not sent: up to level 1 (Easy), scoreline 2–1.",
      ]);
      noPostsAtAll(p);
      p.close();
    });

    it("a draft that claims to start from a saved entry that does not exist is dropped", async () => {
      const p = await loadScore({ session: { [DRAFT_KEY]: draftEntry({ baseUpdatedAt: "y" }) } });
      expect(home(p).value).toBe("");
      expect(p.session()).toEqual({});
      p.close();
    });

    it("a draft answered at another venue than the one the entry is saved at is not applied", async () => {
      const draft = draftEntry({ activationId: "act-2", offerDigest: "ee".repeat(32), baseUpdatedAt: "y" });
      const p = await loadScore({ match: { venueActivations: [ladderMatch().venueActivations[0], secondVenue()] }, mine: savedMine(1), session: { [DRAFT_KEY]: draft } });
      expect(p.q("[data-ladder-conflict]")).toBeNull();
      expect(p.text(p.q("[data-ladder-discarded]"))).toBe(SPANISH_DISCARDED);
      expect(p.session()).toEqual({});
      p.close();
    });
  });

  describe("sending and reducing", () => {
    it("a failed send keeps the draft, and a successful retry removes it", async () => {
      let attempt = 0;
      const p = await loadScore({ predict: () => (attempt++ === 0 ? { status: 500, json: { error: "A brand new message nobody mapped." } } : (undefined as never)) });
      await answerScoreline(p);
      await sendAndConfirm(p, 1);
      expect(Object.keys(p.session())).toEqual([DRAFT_KEY]);
      await p.click(p.action(/Confirmar y enviar/));
      await p.settle(60);
      expect(p.posts()).toHaveLength(2);
      expect(p.session()).toEqual({});
      p.close();
    });

    it("sending a lower level than was answered leaves no answer above it in the draft: after the send, nothing is stored, and a reload brings back only what was saved", async () => {
      const p = await loadScore();
      await answerScoreline(p, "2", "1");
      await p.click(p.action(/Continuar al nivel 2/));
      await answerFirst(p, "HOME");
      await p.click(p.action(/Continuar al nivel 3/));
      await answerScorer(p, "p1");
      expect(JSON.parse(p.session()[DRAFT_KEY]).a.scorer).toBe("p1");
      await p.click(p.action(/Volver/));
      await p.click(p.action(/Volver/));
      await sendAndConfirm(p, 1);
      expect(p.posts()[0].body).toMatchObject({ attemptedLevel: 1 });
      expect(p.posts()[0].body.firstTeam).toBeUndefined();
      expect(p.session()).toEqual({});

      const reloaded = await loadScore({ mine: savedMine(1) });
      expect(reloaded.session()).toEqual({});
      expect(reloaded.qa(".ladder-step-btn").filter((b) => b.classList.contains("is-done"))).toHaveLength(1);
      p.close();
      reloaded.close();
    });

    it("reducing a saved entry in a draft asks to confirm as before, and the reduced draft is not kept after the send", async () => {
      const p = await loadScore({ mine: savedMine(3) });
      await p.click(p.action(/Volver/));
      await p.click(p.action(/Volver/));
      await p.type(home(p), "7");
      expect(JSON.parse(p.session()[DRAFT_KEY]).baseUpdatedAt).toBe("y");
      await p.click(p.action(/Guardar con nivel 1/));
      expect(p.text(p.q("[data-ladder-review]"))).toContain("se borran tus respuestas de los niveles siguientes");
      await p.click(p.action(/Confirmar y enviar/));
      await p.settle(60);
      expect(p.posts()).toHaveLength(1);
      expect(p.posts()[0].body.attemptedLevel).toBe(1);
      expect(p.session()).toEqual({});
      p.close();
    });
  });

  describe("when the browser will not store anything", () => {
    it("the whole journey still works, nothing throws, and nothing is claimed to be kept", async () => {
      for (const mode of ["blocked", "full"] as const) {
        const errors: unknown[] = [];
        const p = await loadScore({ sessionStorage: mode, session: mode === "full" ? { [DRAFT_KEY]: draftEntry({}, { home: "6", away: "6" }) } : undefined });
        p.win.addEventListener("error", (event: ErrorEvent) => errors.push(event.error));
        if (mode === "full") expect(home(p).value).toBe("6"); // reading still works, so a draft that was already there is honoured
        else expect(home(p).value).toBe("");
        await answerScoreline(p, "1", "2");
        await p.click(p.action(/Continuar al nivel 2/));
        await answerFirst(p, "AWAY");
        await sendAndConfirm(p, 2);
        expect(p.posts()).toHaveLength(1);
        expect(p.posts()[0].body).toMatchObject({ attemptedLevel: 2, scoreline: { home: 1, away: 2 } });
        expect(status(p)).toBe("Guardado en tu cuenta: participación hasta el nivel 2 (Mediana).");
        expect(errors).toEqual([]);
        p.close();
      }
    });
  });
});

// ---------------------------------------------------------------------------
// Closed states and the result
// ---------------------------------------------------------------------------

describe("after the match closes", () => {
  const evaluation = (over: Record<string, unknown>) => ({
    evaluationId: "e1", predictionContract: "PROGRESSIVE_LADDER_V1", attemptedLevel: 2, ladderLevel: 1,
    scorelineCorrect: true, firstTeamToScoreCorrect: false, goalscorerCorrect: null, goalMinuteCorrect: null, correctDimensionCount: 1, ...over,
  });
  const qualification = { prizeQualificationId: "q1", evaluationId: "e1", gamingMemberId: "member-1", venueActivationId: "act-1", prizeTierId: "tier-1", redeemedAt: null, supersededAt: null, alreadyDelivered: false, underReview: false };

  it("shows the level attempted, the level won, one outcome per category (a level not reached is not a miss), and the single prize", async () => {
    const p = await loadScore({
      match: { finalized: true, finalResult: { homeScore: 2, awayScore: 1 } },
      mine: { prediction: savedView(2), evaluation: evaluation({}), qualification },
    });
    expect(p.text(p.q("#content .card"))).toContain("Nivel intentado: Nivel 2 · Mediana. Nivel ganado: Nivel 1 · Fácil.");
    const cells = p.qa(".dimension-cell").map((c) => ({ cls: c.className, text: p.text(c) }));
    expect(cells).toEqual([
      { cls: "dimension-cell correct", text: "Marcador exacto✓Acertó" },
      { cls: "dimension-cell incorrect", text: "Primer equipo en anotar✗Falló" },
      { cls: "dimension-cell not-attempted", text: "Cualquier goleador–No intentada" },
      { cls: "dimension-cell not-attempted", text: "Cualquier minuto de gol–No intentada" },
    ]);
    expect(p.qa("[data-prize-slot] p")).toHaveLength(1);
    expect(p.text(p.q("[data-prize-slot]"))).toContain("Prize L1");
    expect(p.text(p.q("#content .card"))).not.toContain("de 4 correctas");
    p.close();
  });

  it("says no level was won when the scoreline missed, in English too", async () => {
    const p = await loadScore({
      lang: "en",
      match: { finalized: true, finalResult: { homeScore: 2, awayScore: 1 } },
      mine: { prediction: savedView(4), evaluation: evaluation({ attemptedLevel: 4, ladderLevel: 0, scorelineCorrect: false, firstTeamToScoreCorrect: true, goalscorerCorrect: true, goalMinuteCorrect: true, correctDimensionCount: 3 }), qualification: null },
    });
    expect(p.text(p.q("#content .card"))).toContain("Level attempted: Level 4 · Legendary. You did not win any level.");
    expect(p.qa(".dimension-cell.correct")).toHaveLength(3);
    expect(p.qa("[data-prize-slot] p")).toHaveLength(0);
    p.close();
  });

  it("lists what the member answered up to the attempted level, including a deliberate none", async () => {
    const view = savedView(3, { firstTeam: { kind: "NONE" }, goalscorer: { kind: "NONE" }, scoreline: { home: 0, away: 0 } });
    const p = await loadScore({
      match: { finalized: true, finalResult: { homeScore: 0, awayScore: 0 } },
      mine: { prediction: view, evaluation: evaluation({ attemptedLevel: 3, ladderLevel: 3, scorelineCorrect: true, firstTeamToScoreCorrect: true, goalscorerCorrect: true, correctDimensionCount: 3 }), qualification: null },
    });
    const lines = p.qa("ul.ladder-offers li").map((li) => p.text(li));
    expect(lines).toEqual(["Marcador: 0–0", "Primer equipo: Ningún equipo anotará", "Goleador: Ningún jugador marcará"]);
    p.close();
  });

  it("past kickoff: a participation is waited on, a missing one is reported, and no form is offered either way", async () => {
    const past = new Date(Date.now() - 3600_000).toISOString();
    const waiting = await loadScore({ match: { kickoffAt: past }, mine: { prediction: savedView(2), evaluation: null, qualification: null } });
    expect(waiting.text(waiting.q("#content .card"))).toContain("Tu participación llega hasta el nivel 2 (Mediana). Esperando el resultado oficial.");
    expect(waiting.q("form[data-ladder]")).toBeNull();
    const missed = await loadScore({ match: { kickoffAt: past } });
    expect(missed.text(missed.q("#content .card"))).toContain("No enviaste una predicción antes del inicio del partido.");
    expect(missed.q("form[data-ladder]")).toBeNull();
    waiting.close();
    missed.close();
  });

  it("a finalized match offers no form even if its kickoff was moved later", async () => {
    const p = await loadScore({ match: { finalized: true, finalResult: { homeScore: 1, awayScore: 0 } } });
    expect(p.q("form[data-ladder]")).toBeNull();
    expect(p.text(p.q("#content .card"))).toContain("No enviaste una predicción antes del inicio del partido.");
    p.close();
  });

  it("asks a signed-out visitor to sign in, with no stepper", async () => {
    const p = await loadScore({ authenticated: false });
    expect(p.q("form[data-ladder]")).toBeNull();
    expect(p.q("[data-login-cta]")).not.toBeNull();
    p.close();
  });
});

// ---------------------------------------------------------------------------
// The administrator's controls
// ---------------------------------------------------------------------------

describe("administration: prizes by ladder level", () => {
  const MATCHES = [
    { matchId: "m1", homeTeamId: "team-a", awayTeamId: "team-b", competition: "Liga", kickoffAt: "2026-10-24T20:00:00.000Z", cancelledAt: null, activityClassification: null, xpEligible: null, predictionContract: "PROGRESSIVE_LADDER_V1" },
    { matchId: "m2", homeTeamId: "team-b", awayTeamId: "team-a", competition: "Copa", kickoffAt: "2026-10-25T20:00:00.000Z", cancelledAt: null, activityClassification: null, xpEligible: null, predictionContract: "COMPLETE_COUNT_V1" },
    { matchId: "m3", homeTeamId: "team-a", awayTeamId: "team-b", competition: "Friendly", kickoffAt: "2026-10-26T20:00:00.000Z", cancelledAt: null, activityClassification: null, xpEligible: null, predictionContract: "PROGRESSIVE_LADDER_V1" },
    { matchId: "m4", homeTeamId: "team-a", awayTeamId: "team-b", competition: "Cup", kickoffAt: "2026-10-27T20:00:00.000Z", cancelledAt: null, activityClassification: null, xpEligible: null, predictionContract: "PROGRESSIVE_LADDER_V1" },
  ];
  const venue = { venueId: "v1", name: "Beer Box" };
  const tier = (id: string, level: number, label: string) => ({ prizeTierId: id, correctDimensionCount: null, ladderLevel: level, prizeLabel: label });
  const ACTIVATIONS = [
    { matchId: "m1", predictionContract: "PROGRESSIVE_LADDER_V1", venueActivationId: "act-ok", enabled: true, venue, prizeTiers: [tier("t1", 1, "Easy prize"), tier("t2", 2, "Medium prize")], offer: ladderOffer([1, 2]) },
    { matchId: "m2", predictionContract: "COMPLETE_COUNT_V1", venueActivationId: "act-old", enabled: true, venue, prizeTiers: [{ prizeTierId: "t9", correctDimensionCount: 4, ladderLevel: null, prizeLabel: "Jersey" }], offer: null },
    { matchId: "m3", predictionContract: "PROGRESSIVE_LADDER_V1", venueActivationId: "act-gap", enabled: true, venue, prizeTiers: [tier("g1", 1, "One"), tier("g3", 3, "Three")], offer: ladderOffer([1, 3]) },
    { matchId: "m4", predictionContract: "PROGRESSIVE_LADDER_V1", venueActivationId: "act-none", enabled: true, venue, prizeTiers: [{ prizeTierId: "old", correctDimensionCount: 4, ladderLevel: null, prizeLabel: "Old count tier" }], offer: ladderOffer([]) },
  ];

  async function loadAdmin(tierReply: { status: number; json?: unknown } = { status: 201, json: { tier: {} } }) {
    const calls: Call[] = [];
    const dom = new JSDOM(ADMIN_HTML, {
      url: "http://localhost/predictions-admin.html",
      runScripts: "dangerously",
      pretendToBeVisual: true,
      beforeParse(window) {
        const w = window as unknown as Record<string, any>;
        w.confirm = () => true;
        w.UrbanoAuth = {
          attachSignInButton: () => {},
          getState: async () => ({ status: "authenticated", email: "staff@example.com", gamingMemberId: "staff-1", displayName: "Staff" }),
          getAccessToken: async () => "stub-token",
          onAuthStateChange: async () => () => {},
        };
        w.fetch = async (url: string, init: Record<string, any> = {}) => {
          const call: Call = { url: String(url), method: (init.method || "GET").toUpperCase(), body: typeof init.body === "string" ? JSON.parse(init.body) : undefined };
          calls.push(call);
          const reply = (status: number, json: unknown) => ({ status, json: async () => JSON.parse(JSON.stringify(json)) });
          if (call.method === "GET" && call.url === `${API}/admin/teams`) return reply(200, { teams: [{ teamId: "team-a", name: "Alpha FC" }, { teamId: "team-b", name: "Beta FC" }] });
          if (call.method === "GET" && call.url === `${API}/admin/matches`) return reply(200, { matches: MATCHES, teams: [{ teamId: "team-a", name: "Alpha FC" }, { teamId: "team-b", name: "Beta FC" }] });
          if (call.method === "GET" && call.url === `${API}/admin/venues`) return reply(200, { venues: [{ venueId: "v1", name: "Beer Box", latitude: 14, longitude: -87, radiusMeters: 150, active: true }] });
          if (call.method === "GET" && call.url === `${API}/admin/activations`) return reply(200, { activations: ACTIVATIONS });
          if (call.method === "POST" && call.url.endsWith("/prize-tiers")) return reply(tierReply.status, tierReply.json ?? {});
          return reply(200, { teams: [], players: [], qualifications: [] });
        };
      },
    });
    const win = dom.window as unknown as Window & Record<string, any>;
    const doc = win.document;
    const deadline = Date.now() + 3000;
    while (doc.querySelectorAll("#table-activations tbody tr").length < ACTIVATIONS.length) {
      await new Promise((r) => setTimeout(r, 0));
      if (Date.now() > deadline) throw new Error("the activations did not load");
    }
    const text = (sel: string) => (doc.querySelector(sel)?.textContent ?? "").replace(/\s+/g, " ").trim();
    const select = async (id: string, value: string) => {
      const el = doc.getElementById(id) as HTMLSelectElement;
      el.value = value;
      el.dispatchEvent(new win.Event("change", { bubbles: true }));
      await new Promise((r) => setTimeout(r, 10));
    };
    return { win, doc, calls, text, select, close: () => dom.window.close() };
  }

  it("shows what each venue offers: the levels set, up to which level it takes participations, and why it does not", async () => {
    const page = await loadAdmin();
    const cell = (matchId: string) => (page.doc.querySelector(`#table-activations td[data-match-id="${matchId}"]`)!.parentElement!.children[3].textContent ?? "").replace(/\s+/g, " ").trim();
    expect(cell("m1")).toBe("L1 Easy: Easy prize, L2 Medium: Medium prize — takes participations up to level 2");
    expect(cell("m2")).toBe("4/4: Jersey"); // a historical match reads as before
    expect(cell("m3")).toBe("L1 Easy: One, L3 Hard: Three — NOT OFFERED: the levels have a gap, so it takes no participations");
    expect(cell("m4")).toBe("none — NOT OFFERED: no prizes set, so it takes no participations (1 old count tier ignored)");
    page.close();
  });

  it("keys the tier by ladder level for a progressive match and by count for a historical one", async () => {
    const page = await loadAdmin();
    const level = page.doc.getElementById("pt-level") as HTMLSelectElement;
    const count = page.doc.getElementById("pt-count") as HTMLSelectElement;
    await page.select("pt-activation", "act-ok");
    expect(level.hidden).toBe(false);
    expect(count.hidden).toBe(true);
    expect(page.text("#note-tier")).toContain("a consecutive set of levels starting at Level 1");
    expect(page.text("#note-tier")).toContain("can no longer change");
    level.value = "3";
    (page.doc.getElementById("pt-label") as HTMLInputElement).value = "Hard prize";
    (page.doc.getElementById("btn-create-tier") as HTMLButtonElement).click();
    await new Promise((r) => setTimeout(r, 40));
    const progressivePost = page.calls.filter((c) => c.method === "POST" && c.url.endsWith("/act-ok/prize-tiers"));
    expect(progressivePost).toHaveLength(1);
    expect(progressivePost[0].body).toEqual({ ladderLevel: 3, prizeLabel: "Hard prize" });

    await page.select("pt-activation", "act-old");
    expect(level.hidden).toBe(true);
    expect(count.hidden).toBe(false);
    expect(page.text("#note-tier")).toBe(page.text("#note-tier")); // hidden
    expect((page.doc.getElementById("note-tier") as HTMLElement).hidden).toBe(true);
    count.value = "2";
    (page.doc.getElementById("pt-label") as HTMLInputElement).value = "Cap";
    (page.doc.getElementById("btn-create-tier") as HTMLButtonElement).click();
    await new Promise((r) => setTimeout(r, 40));
    const historicalPost = page.calls.filter((c) => c.method === "POST" && c.url.endsWith("/act-old/prize-tiers"));
    expect(historicalPost[0].body).toEqual({ correctDimensionCount: 2, prizeLabel: "Cap" });
    page.close();
  });

  it("shows the refusal when a venue's prizes are frozen", async () => {
    const page = await loadAdmin({ status: 409, json: { error: "This venue's prizes can no longer change: participants have already accepted this offer." } });
    await page.select("pt-activation", "act-ok");
    (page.doc.getElementById("pt-label") as HTMLInputElement).value = "Late prize";
    (page.doc.getElementById("btn-create-tier") as HTMLButtonElement).click();
    await new Promise((r) => setTimeout(r, 40));
    expect(page.text("#msg-tier")).toBe("This venue's prizes can no longer change: participants have already accepted this offer.");
    page.close();
  });
});
