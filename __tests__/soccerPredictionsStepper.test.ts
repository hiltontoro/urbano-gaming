import { describe, expect, it } from "vitest";
import { JSDOM } from "jsdom";
import { readFileSync } from "node:fs";
import path from "node:path";

import { CLASICO_ROSTER_SNAPSHOT } from "../lib/gaming/predictions/rosters/clasicoRosterSnapshot";

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
const CRESTS_SOURCE = readFileSync(path.join(process.cwd(), "public/urbanoClubCrests.js"), "utf8");
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
  /** Evaluate the club crests module, as the page's script tag would (jsdom does not load external scripts). Off by default. */
  crests?: boolean;
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
  /** false: do not press "Edit participation" when the page opens on the summary. */
  openEdit?: boolean;
  /** How the browser answers a location request: a position (default), or one of the three errors it reports. */
  location?: "denied" | "timeout" | "unavailable";
  /** The browser has not been answered yet: the permission is "prompt" and no position arrives. */
  pendingPermission?: boolean;
  /**
   * The conditions (legal texts) as the server reports them for this match. Default "accepted": every required text already accepted, so the
   * journeys that are not about the conditions are not asked for them. "pending": published and nothing accepted yet. "unpublished": the
   * registry has no approved text (how it ships). "failed": the check itself fails.
   */
  legal?: "accepted" | "pending" | "unpublished" | "failed";
  /** Replaces the title of the event rules in the server's answer (to prove a text from the server is only ever text). */
  legalTitle?: string;
  /** Overrides the answer to the acceptance POST (for example a stale text). */
  legalPost?: (call: Call) => { status: number; json?: unknown } | undefined;
  predict?: (call: Call, index: number) => { status: number; json?: unknown } | "reject" | Promise<{ status: number; json?: unknown } | "reject">;
  matchesAfterFirst?: () => Record<string, unknown>;
}

async function loadScore(opts: LoadOptions = {}) {
  const calls: Call[] = [];
  let predictIndex = 0;
  let matchesLoads = 0;
  const initialMatch = ladderMatch(opts.match, opts.levels);
  const legalMode = opts.legal ?? "accepted";
  let legalAccepted = legalMode === "accepted";
  const legalDocs = () => [
    { key: "ACCOUNT_TERMS", actType: "ACCEPTANCE", version: "t-1", locale: "es", title: "Términos de cuenta (texto de prueba)", sha256: "a".repeat(64), scope: { kind: "GLOBAL" }, needsAgeDeclaration: false },
    { key: "PRIVACY_NOTICE", actType: "READ_ACKNOWLEDGMENT", version: "p-1", locale: "es", title: "Aviso de privacidad (texto de prueba)", sha256: "b".repeat(64), scope: { kind: "GLOBAL" }, needsAgeDeclaration: false },
    { key: "EVENT_RULES", actType: "ACCEPTANCE", version: "e-1", locale: "es", title: opts.legalTitle ?? "Reglas del evento (texto de prueba)", sha256: "c".repeat(64), scope: { kind: "EVENT", kickoffAt: "2026-10-25T20:00:00.000Z" }, needsAgeDeclaration: true },
  ].map((d) => ({ ...d, accepted: legalAccepted, acceptedAt: legalAccepted ? "2026-10-25T17:00:00.000Z" : null }));
  const legalStatus = () =>
    legalMode === "unpublished"
      ? { published: false, unpublished: ["ACCOUNT_TERMS", "PRIVACY_NOTICE", "EVENT_RULES"], satisfied: false, documents: [] }
      : { published: true, unpublished: [], satisfied: legalAccepted, documents: legalDocs() };
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
      if (opts.crests) window.eval(CRESTS_SOURCE);
      if (opts.pendingPermission) {
        Object.defineProperty(window.navigator, "permissions", { configurable: true, value: { query: async () => ({ state: "prompt" }) } });
      }
      if (opts.geolocation !== false) {
        Object.defineProperty(window.navigator, "geolocation", {
          configurable: true,
          value: {
            getCurrentPosition: (ok: (p: unknown) => void, fail: (e: { code: number }) => void) => {
              if (opts.pendingPermission) return;
              if (opts.location) fail({ code: opts.location === "denied" ? 1 : opts.location === "unavailable" ? 2 : 3 });
              else ok({ coords: { latitude: 14.07, longitude: -87.19, accuracy: 5 } });
            },
          },
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
        if (call.url === "/api/gaming/legal/acceptances?matchId=m1" && call.method === "GET") {
          return legalMode === "failed" ? reply(500, { error: "Failed to read the acceptances." }) : reply(200, legalStatus());
        }
        if (call.url === "/api/gaming/legal/acceptances" && call.method === "POST") {
          const custom = opts.legalPost ? opts.legalPost(call) : undefined;
          if (custom) return reply(custom.status, custom.json ?? null);
          legalAccepted = true;
          return reply(201, { recorded: 3, alreadyRecorded: 0, ...legalStatus() });
        }
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
  // With something saved the page opens on "My participation"; editing is an explicit action. Most journeys here are about the form,
  // so they press it (openEdit: false stays on the summary, which is what the summary tests do).
  if (opts.openEdit !== false) {
    const editButton = doc.querySelector("[data-mine-edit]") as HTMLElement | null;
    if (editButton) { editButton.click(); await new Promise((r) => setTimeout(r, 30)); }
  }
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

const SPANISH_ESSENTIALS = "Escalera consecutiva: cada nivel exige acertar todos los anteriores. Un solo premio: el del nivel más alto que aciertes en orden. Completar un nivel no significa ganar.";
const ENGLISH_ESSENTIALS = "Consecutive ladder: each level requires getting every earlier level right. One prize only: the one for the highest level you get right in order. Completing a level does not mean winning.";
const SPANISH_RULES = "Cada nivel requiere acertar todos los anteriores. Podés enviar al completar un nivel o continuar para intentar uno mayor. Recibís únicamente el premio del nivel más alto que acertés.";
const ENGLISH_RULES = "Each level requires getting every previous level right. You can send when you complete a level or continue to try a higher one. You receive only the prize of the highest level you get right.";

const DRAFT_KEY = "urbano.score.draft.member-1.m1";
/** "My participation": what is saved, in one place. After a send the page shows it instead of the form. */
const summary = (p: Score) => p.text(p.q("[data-mine-summary]"));
const editAgain = async (p: Score) => { await p.click(p.q("[data-mine-edit]")); };
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
    // What must never be hidden is on screen: a consecutive ladder, a single prize, completing is not winning. The long explanation is
    // in a disclosure that starts closed.
    expect(es.text(es.q(".ladder-rules"))).toBe(SPANISH_ESSENTIALS);
    expect(es.text(es.q("[data-ladder-help-body]"))).toContain(SPANISH_RULES);
    expect((es.q("[data-ladder-help]") as HTMLDetailsElement).open).toBe(false);
    const en = await loadScore({ lang: "en" });
    expect(en.text(en.q(".ladder-rules"))).toBe(ENGLISH_ESSENTIALS);
    expect(en.text(en.q("[data-ladder-help-body]"))).toContain(ENGLISH_RULES);
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
    expect(panel).toContain("Premio máximo posible con el nivel 1: Prize L1. Solo lo recibís si acertás el marcador exacto.");
    expect(p.text(p.q("[data-ladder-help-body]"))).toContain("Completar un nivel no da un premio por sí solo");
    expect(p.text(p.q("form[data-ladder]"))).not.toMatch(/ganaste|ganado|obtuviste|tu premio es/i);
    await p.click(p.action(/Continuar al nivel 2/));
    await answerFirst(p, "HOME");
    expect(p.text(p.q("[data-ladder-panel]"))).toContain("Prize L2. Solo lo recibís si acertás el marcador exacto y el primer equipo en anotar.");
    p.close();
  });

  it("describes the prize of the level a step would send with, also when the person went back from a higher completed level", async () => {
    const p = await loadScore({ mine: { prediction: savedView(4), evaluation: null, qualification: null } });
    expect(p.text(p.q("[data-ladder-panel]"))).toContain("con el nivel 4: Prize L4. Solo lo recibís si acertás el marcador exacto, el primer equipo, un goleador y un minuto de gol.");
    await p.click(p.qa(".ladder-step-btn")[1]); // back to level 2 with levels 3 and 4 still answered
    expect(p.text(p.q("[data-ladder-panel]"))).toContain("Paso actual: Nivel 2 · Mediana");
    expect(p.text(p.q("[data-ladder-panel]"))).toContain("Listo para enviar: Nivel 2 · Mediana"); // the same level the main button names
    expect(p.action(/Guardar con nivel 2/)).toBeTruthy();
    expect(p.text(p.q("[data-ladder-panel]"))).toContain("con el nivel 2: Prize L2. Solo lo recibís si acertás el marcador exacto y el primer equipo en anotar.");
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
    expect(p.text(p.q(".ladder-rules"))).toBe(ENGLISH_ESSENTIALS);
    expect(p.text(p.q("[data-ladder-help-body]"))).toContain(ENGLISH_RULES);
    expect(p.text(p.q("[data-ladder-panel]"))).toContain("Highest possible prize with level 1: Prize L1. You only get it if you get the exact scoreline right.");
    expect(p.action(/Send with level 1/)).toBeTruthy();
    expect(home(p).value).toBe("3");
    expect(away(p).value).toBe("0");
    p.win.UrbanoI18n.setLang("es");
    await p.settle();
    expect(p.text(p.q(".ladder-rules"))).toBe(SPANISH_ESSENTIALS);
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

  it("level 3 needs a player and level 4 a valid minute; with goals 'none' is not an answer, and the last complete level can be sent from an unanswered step", async () => {
    const p = await loadScore();
    await answerScoreline(p, "2", "1");
    await p.click(p.action(/Continuar al nivel 2/));
    await answerFirst(p, "HOME");
    await p.click(p.action(/Continuar al nivel 3/));
    expect(p.action(/Continuar al nivel 4/)!.disabled).toBe(true); // nothing chosen yet: not an answer
    expect(p.action(/Enviar con nivel 2/)!.disabled).toBe(false); // ...but level 2 is complete and can be sent from here
    expect(p.action(/Enviar con nivel 3/)).toBeUndefined();
    expect((p.q("#ladder-scorer-m1 option[value=NONE]") as HTMLOptionElement).disabled).toBe(true); // goals: "no player" is not an answer
    await answerScorer(p, "p1");
    expect(p.action(/Continuar al nivel 4/)!.disabled).toBe(false);
    await p.click(p.action(/Continuar al nivel 4/));
    expect(p.action(/Enviar con nivel 3/)!.disabled).toBe(false); // level 4 is empty: what is ready is level 3
    await answerMinute(p, "91");
    expect(p.action(/Enviar con nivel 4/)).toBeUndefined();
    await answerMinute(p, "30");
    expect(p.action(/Enviar con nivel 4/)!.disabled).toBe(false);
    await p.click(p.q(".ladder-none.team-toggle")); // "no goals" with goals in the scoreline: refused, nothing changes
    expect(p.q(".ladder-none.team-toggle")!.getAttribute("aria-pressed")).toBe("false");
    expect((p.q("#ladder-minute-m1") as HTMLInputElement).disabled).toBe(false);
    expect((p.q("#ladder-minute-m1") as HTMLInputElement).value).toBe("30");
    expect(p.text(p.q("[data-ladder-body] .ladder-fix"))).toContain("el marcador tiene que ser 0–0");
    expect(p.action(/Enviar con nivel 4/)!.disabled).toBe(false);
    p.close();
  });

  it("with a 0-0 scoreline the only answers are the explicit 'none' ones: the teams, the players and the minute are not choices", async () => {
    const p = await loadScore();
    await answerScoreline(p, "0", "0");
    await p.click(p.action(/Continuar al nivel 2/));
    for (const side of ["HOME", "AWAY"]) expect(p.q(`.team-toggle[data-value="${side}"]`)!.getAttribute("aria-disabled")).toBe("true");
    expect(p.q('.team-toggle[data-value="NONE"]')!.getAttribute("aria-disabled")).toBeNull();
    expect(p.text(p.q("[data-ladder-body] .ladder-fix"))).toContain("Con un marcador 0–0 solo podés responder «ninguno»");
    await answerFirst(p, "HOME"); // not a choice
    expect(p.action(/Continuar al nivel 3/)!.disabled).toBe(true);
    await answerFirst(p, "NONE");
    await p.click(p.action(/Continuar al nivel 3/));
    expect(p.qa("#ladder-scorer-m1 optgroup option").every((o) => (o as HTMLOptionElement).disabled)).toBe(true);
    expect((p.q("#ladder-scorer-m1 option[value=NONE]") as HTMLOptionElement).disabled).toBe(false);
    await answerScorer(p, "NONE");
    await p.click(p.action(/Continuar al nivel 4/));
    expect((p.q("#ladder-minute-m1") as HTMLInputElement).disabled).toBe(true);
    expect(p.action(/Enviar con nivel 3/)!.disabled).toBe(false);
    expect(p.action(/Enviar con nivel 4/)).toBeUndefined();
    await p.click(p.q(".ladder-none.team-toggle"));
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

  it("the explanation says that choosing 'no team / no player / no goals' is an answer and that not answering is different: only where it is pertinent", async () => {
    const goals = await loadScore();
    await answerScoreline(goals, "2", "1");
    await goals.click(goals.action(/Continuar al nivel 2/));
    expect(goals.text(goals.q("[data-ladder-body]"))).not.toContain("Elegir esta opción es una respuesta"); // with goals "none" is not a choice
    goals.close();
    const none = await loadScore();
    await answerScoreline(none, "0", "0");
    await none.click(none.action(/Continuar al nivel 2/));
    expect(none.text(none.q("[data-ladder-body]"))).toContain("Elegir esta opción es una respuesta: es correcta solo si el partido termina sin goles en tiempo reglamentario. No responder es distinto: ese nivel no se evalúa.");
    none.close();
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
    // After the send the page shows "My participation" (not the form), with the confirmation and what was sent.
    expect(p.q("form[data-ladder]")).toBeNull();
    expect(p.text(p.q("[data-mine-notice]"))).toContain("Participación guardada hasta el nivel 1 (Fácil).");
    expect(summary(p)).toContain("Nivel enviado: Nivel 1 · Fácil");
    expect(summary(p)).toContain("Sede: Beer Box");
    expect(summary(p)).toContain("Marcador: 2–1");
    expect(p.q("[data-mine-edit]")).not.toBeNull();
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
    await p.click(p.action(/^Volver$/)); // ...back to level 2
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
    await p.click(p.action(/^Volver$/));
    await sendAndConfirm(p, 2);
    expect(p.text(p.q("[data-mine-notice]"))).toContain("hasta el nivel 2");
    await editAgain(p);
    await p.click(p.action(/Continuar al nivel 3/));
    expect((p.q("#ladder-scorer-m1") as HTMLSelectElement).value).toBe("");
    expect(p.action(/Guardar con nivel 3/)).toBeUndefined(); // level 3 is empty: it cannot be what is sent...
    expect(p.action(/Guardar con nivel 2/)!.disabled).toBe(false); // ...the last complete level can
    p.close();
  });

  it("does not send when no position can be read, and says WHY: no location in the browser, permission denied, too slow, or unavailable", async () => {
    const cases: Array<[LoadOptions, string]> = [
      [{ geolocation: false }, "Tu navegador no ofrece ubicación."],
      [{ location: "denied" }, "El permiso de ubicación está denegado. Activalo en los ajustes de tu navegador para poder enviar."],
      [{ location: "timeout" }, "La ubicación tardó demasiado en responder. Volvé a intentarlo."],
      [{ location: "unavailable" }, "No se pudo determinar tu ubicación en este momento."],
    ];
    for (const [options, expected] of cases) {
      const p = await loadScore(options);
      await answerScoreline(p);
      await p.click(p.action(/Enviar con nivel 1/));
      await p.click(p.action(/Confirmar y enviar/));
      await p.settle(60);
      expect(p.posts()).toHaveLength(0);
      expect(p.text(p.q("#submit-msg-m1"))).toBe(expected);
      expect(p.text(p.q(`#geo-status-m1`))).toBe(expected);
      expect(p.text(p.q("#geo-status-m1"))).not.toContain("fuera del alcance"); // no measurement is never "outside the venue"
      expect(p.action(/Confirmar y enviar/)!.disabled).toBe(false);
      p.close();
    }
  });

  it("tells apart the browser's measurement from the server's decision: within or outside what the BROWSER reports, then the server decides", async () => {
    const within = await loadScore();
    await within.settle();
    expect(within.text(within.q("#geo-status-m1"))).toBe("Tu navegador indica que estás dentro del alcance de esta sede. El servidor lo confirma al enviar.");
    within.close();
    const outside = await loadScore({ match: { venueActivations: [{ ...(ladderMatch().venueActivations[0] as any), venue: { venueId: "v1", name: "Far Bar", latitude: 15.5, longitude: -88.5, radiusMeters: 50, active: true } }] } });
    await outside.settle();
    expect(outside.text(outside.q("#geo-status-m1"))).toBe("Tu navegador indica que estás fuera del alcance de esta sede; al enviar, el servidor decide.");
    outside.close();
    // the server's own refusal is shown as the server words it
    const refused = await loadScore({ predict: () => ({ status: 403, json: { error: "Submission failed geolocation eligibility." } }) });
    await answerScoreline(refused);
    await sendAndConfirm(refused, 1);
    expect(refused.text(refused.q("#submit-msg-m1"))).toBe("El envío no cumplió los requisitos de ubicación.");
    refused.close();
  });

  it("while the permission is pending the page says it is waiting for the person, not that they are outside", async () => {
    const p = await loadScore({ pendingPermission: true });
    expect(p.text(p.q("#geo-status-m1"))).toBe("Esperando tu permiso de ubicación…");
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
    await p.click(p.action(/^Volver$/));
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
      await editAgain(p);
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
      await p.click(p.action(/^Volver$/));
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
      expect(summary(p)).toContain("Nivel enviado: Nivel 2 · Mediana");
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
      await p.click(p.action(/^Volver$/));
      expect((p.q("#ladder-scorer-m1") as HTMLSelectElement).value).toBe("NONE");
      await p.click(p.action(/^Volver$/));
      expect(toggled(p)).toBe("NONE");
      await p.click(p.action(/^Volver$/));
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
      await p.click(p.action(/^Volver$/));
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
      await p.click(p.action(/^Volver$/));
      await p.click(p.action(/^Volver$/));
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
      await p.click(p.action(/^Volver$/));
      await p.click(p.action(/^Volver$/));
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
      await p.click(p.action(/^Volver$/));
      await p.click(p.action(/^Volver$/));
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
        expect(summary(p)).toContain("Nivel enviado: Nivel 2 · Mediana");
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
    expect(waiting.text(waiting.q("#content .card"))).toContain("Estado: cerrada, el partido ya empezó. Esperando el resultado oficial.");
    expect(summary(waiting)).toContain("Nivel enviado: Nivel 2 · Mediana");
    expect(waiting.q("form[data-ladder]")).toBeNull();
    expect(waiting.q("[data-mine-edit]")).toBeNull(); // closed: nothing to edit
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
          if (call.method === "GET" && call.url === `${API}/admin/access`) return reply(200, { access: true, classes: ["OPERATIONAL", "CONSEQUENTIAL_FINALIZER", "PRODUCT_GOVERNANCE"] });
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

// ---------------------------------------------------------------------------
// Coherence between answers, as the form shows it (the server judges the same rules again: progressiveCoherence.test.ts)
// ---------------------------------------------------------------------------

describe("coherence between answers in the form", () => {
  const titleLevel = (p: Score) => p.q("[data-ladder-title]")?.getAttribute("data-ladder-title");
  const fixText = (p: Score) => p.text(p.q("[data-ladder-body] .ladder-fix"));
  const removed = (p: Score) => p.text(p.q("[data-ladder-removed]"));
  const blockedTeams = (p: Score) => p.qa(".team-toggle[aria-disabled='true']").map((b) => b.getAttribute("data-value"));

  async function answerUpToMinute(p: Score, h = "2", a = "1") {
    await answerScoreline(p, h, a);
    await p.click(p.action(/Continuar al nivel 2/));
    await answerFirst(p, "HOME");
    await p.click(p.action(/Continuar al nivel 3/));
    await answerScorer(p, "p1");
    await p.click(p.action(/Continuar al nivel 4/));
    await answerMinute(p, "30");
  }

  it("the first team needs a goal in the scoreline: a team with none is not a choice, and tapping it says why and changes nothing", async () => {
    const p = await loadScore();
    await answerScoreline(p, "0", "2");
    await p.click(p.action(/Continuar al nivel 2/));
    expect(blockedTeams(p)).toEqual(["HOME", "NONE"]);
    expect(fixText(p)).toContain("Ese equipo no tiene goles en tu marcador");
    expect(fixText(p)).not.toContain("0–0"); // the "none needs 0–0" reason is given when "none" is tapped, not on every step
    await answerFirst(p, "HOME");
    expect(p.q('.team-toggle[data-value="HOME"]')!.getAttribute("aria-pressed")).toBe("false");
    expect(p.action(/Continuar al nivel 3/)!.disabled).toBe(true);
    await answerFirst(p, "NONE");
    expect(fixText(p)).toContain("el marcador tiene que ser 0–0");
    expect(p.action(/Continuar al nivel 3/)!.disabled).toBe(true);
    await answerFirst(p, "AWAY");
    expect(p.action(/Continuar al nivel 3/)!.disabled).toBe(false);
    p.close();
  });

  it("the goalscorer must belong to a team with goals: the players of a team without goals cannot be picked", async () => {
    const p = await loadScore();
    await answerScoreline(p, "2", "0");
    await p.click(p.action(/Continuar al nivel 2/));
    await answerFirst(p, "HOME");
    await p.click(p.action(/Continuar al nivel 3/));
    const state = Object.fromEntries(p.qa("#ladder-scorer-m1 option[value]").map((o) => [(o as HTMLOptionElement).value, (o as HTMLOptionElement).disabled]));
    expect(state).toEqual({ "": false, NONE: true, p1: false, p2: false, p3: true });
    expect(fixText(p)).toContain("Los jugadores de un equipo sin goles en tu marcador no se pueden elegir");
    await answerScorer(p, "p3");
    expect(p.action(/Continuar al nivel 4/)!.disabled).toBe(true); // a disabled option is not an answer, even if forced
    p.close();
  });

  it("the goalscorer and the minute need not be the same goal: any scorer of a team with goals, any minute", async () => {
    const p = await loadScore();
    await answerUpToMinute(p, "1", "3");
    expect(p.action(/Enviar con nivel 4/)!.disabled).toBe(false);
    p.close();
  });

  it("changing the scoreline takes out the later answers that no longer fit, says which, keeps the ones that still fit, and sends nothing", async () => {
    const p = await loadScore();
    await answerUpToMinute(p, "2", "1");
    await p.click(p.qa(".ladder-step-btn")[0]);
    await p.type(home(p), "0"); // 0-1: the home team has no goal any more
    expect(removed(p)).toContain("Cambiaste una respuesta anterior y quitamos las siguientes, que ya no son compatibles. Revisalas antes de guardar:");
    expect(p.qa("[data-ladder-removed] li").map((li) => p.text(li))).toEqual(["Primer equipo en anotar", "Cualquier goleador"]);
    // the minute still fits a 0-1: it is kept; the removed levels are empty again and block what is above them
    expect(p.qa(".ladder-step-btn").map((b) => (b as HTMLButtonElement).disabled)).toEqual([false, false, true, true]);
    await p.click(p.action(/Continuar al nivel 2/));
    expect(p.qa(".team-toggle[aria-pressed='true']")).toHaveLength(0); // never completed for the person
    await answerFirst(p, "AWAY");
    await p.click(p.action(/Continuar al nivel 3/));
    expect((p.q("#ladder-scorer-m1") as HTMLSelectElement).value).toBe("");
    await answerScorer(p, "p3");
    await p.click(p.action(/Continuar al nivel 4/));
    expect((p.q("#ladder-minute-m1") as HTMLInputElement).value).toBe("30");
    expect(p.posts()).toHaveLength(0);
    p.close();
  });

  it("a scoreline that still fits everything takes nothing out and says nothing", async () => {
    const p = await loadScore();
    await answerUpToMinute(p, "2", "1");
    await p.click(p.qa(".ladder-step-btn")[0]);
    await p.type(home(p), "3");
    expect(p.q("[data-ladder-removed]")!.hidden).toBe(true);
    expect(p.qa(".ladder-step-btn").map((b) => (b as HTMLButtonElement).disabled)).toEqual([false, false, false, false]);
    p.close();
  });

  it("a 0-0 takes out every later answer except none-type ones, and never fills them in or raises the level", async () => {
    const p = await loadScore();
    await answerUpToMinute(p, "2", "1");
    await p.click(p.qa(".ladder-step-btn")[0]);
    await p.type(home(p), "0");
    await p.type(away(p), "0");
    expect(p.qa("[data-ladder-removed] li").map((li) => p.text(li))).toEqual(["Primer equipo en anotar", "Cualquier goleador", "Cualquier minuto de gol"]);
    expect(p.text(p.q("[data-ladder-panel]"))).toContain("Listo para enviar: Nivel 1 · Fácil"); // the level goes down, never up
    expect(p.action(/Enviar con nivel 1/)!.disabled).toBe(false);
    p.close();
  });

  it("the removed answers' notice goes away when the person answers those levels again", async () => {
    const p = await loadScore();
    await answerUpToMinute(p, "2", "1");
    await p.click(p.qa(".ladder-step-btn")[0]);
    await p.type(home(p), "0");
    expect(p.qa("[data-ladder-removed] li")).toHaveLength(2);
    await p.click(p.action(/Continuar al nivel 2/));
    await answerFirst(p, "AWAY");
    expect(p.qa("[data-ladder-removed] li").map((li) => p.text(li))).toEqual(["Cualquier goleador"]);
    p.close();
  });

  it("an unsent draft written before these rules is restored without its contradictions, and says so", async () => {
    const draft = draftEntry({ step: 3 }, { home: "0", away: "0", first: "HOME", scorer: "p1", minute: "30" });
    const p = await loadScore({ session: { [DRAFT_KEY]: draft } });
    expect(p.qa("[data-ladder-removed] li").map((li) => p.text(li))).toEqual(["Primer equipo en anotar", "Cualquier goleador", "Cualquier minuto de gol"]);
    expect(p.posts()).toHaveLength(0);
    p.close();
  });

  it("the form states what blocks, in English too, and a blocked option points at its explanation", async () => {
    const p = await loadScore({ lang: "en" });
    await answerScoreline(p, "0", "0");
    await p.click(p.action(/Continue to level 2/));
    expect(fixText(p)).toBe("With a 0–0 scoreline you can only answer “none”. Choose it, or change the scoreline in level 1.");
    const home1 = p.q('.team-toggle[data-value="HOME"]')!;
    expect(home1.getAttribute("aria-describedby")).toBe(p.q("[data-ladder-body] .ladder-fix")!.id);
    expect(p.q("[data-ladder-body] .ladder-fix")!.getAttribute("aria-live")).toBe("polite");
    p.close();
  });

  describe("a participation saved before these rules", () => {
    const legacy = () => ({ prediction: savedView(3, { firstTeam: { kind: "NONE" } }), evaluation: null, qualification: null }); // 2-1 with "no team" first

    it("stays exactly as saved, is shown as it is, and says what to correct to change it", async () => {
      const p = await loadScore({ mine: legacy(), openEdit: false });
      expect(summary(p)).toContain("Nivel enviado: Nivel 3 · Difícil");
      expect(summary(p)).toContain("Primer equipo: Ningún equipo anotará");
      expect(p.text(p.q("[data-mine-summary] .ladder-fix"))).toContain("Tu participación guardada combina respuestas que ya no son compatibles entre sí.");
      expect(p.qa("[data-mine-summary] .ladder-fix li").map((li) => p.text(li))).toEqual(["Primer equipo en anotar"]);
      expect(p.posts()).toHaveLength(0);
      p.close();
    });

    it("cannot be sent again as it is; fixing the one answer lets it be saved at the same level, and nothing else changes", async () => {
      const p = await loadScore({ mine: legacy() });
      expect(p.text(p.q("[data-ladder-legacy]"))).toContain("Para cambiarla, corregí:");
      expect(titleLevel(p)).toBe("2"); // the form opens where the contradiction is
      expect(p.q('.team-toggle[data-value="NONE"]')!.getAttribute("aria-pressed")).toBe("true");
      expect(p.q('.team-toggle[data-value="NONE"]')!.getAttribute("aria-disabled")).toBe("true");
      expect(fixText(p)).toContain("el marcador tiene que ser 0–0");
      expect(p.action(/Guardar con nivel 1/)).toBeTruthy(); // only the part that is coherent could be sent
      expect(p.action(/Guardar con nivel 3/)).toBeUndefined();
      await answerFirst(p, "HOME");
      expect(p.q("[data-ladder-legacy]")!.hidden).toBe(true);
      expect(p.action(/Guardar con nivel 2/)).toBeTruthy(); // from step 2 the button names step 2, as it always did...
      await p.click(p.action(/Continuar al nivel 3/)); // ...so the person goes on to level 3 to save at the level that was saved
      expect(p.action(/Guardar con nivel 3/)!.disabled).toBe(false);
      await sendAndConfirm(p, 3);
      expect(p.posts()[0].body).toMatchObject({ attemptedLevel: 3, scoreline: { home: 2, away: 1 }, firstTeam: { kind: "PICKED", team: "HOME" }, goalscorer: { kind: "PICKED", playerId: "p1" } });
      p.close();
    });
  });
});

// ---------------------------------------------------------------------------
// "My participation": what is saved, in one place, and editing as an explicit act
// ---------------------------------------------------------------------------

describe("My participation", () => {
  const SENT = "2026-10-24T20:00:00.000Z";
  const mineAt = (level: number, over: Record<string, unknown> = {}) => ({ prediction: savedView(level, { createdAt: SENT, updatedAt: SENT, ...over }), evaluation: null, qualification: null });

  it("a member with something saved sees the summary first, not the form: venue, level sent, state, date, answers — and no automatic reopening", async () => {
    const p = await loadScore({ mine: mineAt(3), openEdit: false });
    expect(p.q("form[data-ladder]")).toBeNull();
    const text = summary(p);
    expect(text).toContain("Mi participación");
    expect(text).toContain("Sede: Beer Box");
    expect(text).toContain("Nivel enviado: Nivel 3 · Difícil");
    expect(text).toContain("Enviada:");
    expect(text).toContain("Estado: guardada. Podés editarla hasta");
    expect(text).toContain("Marcador: 2–1");
    expect(text).toContain("Primer equipo: Alpha FC");
    expect(text).toContain("Goleador: Ana Díaz");
    expect(text).not.toContain("Minuto:"); // level 4 was not sent
    expect(text).not.toMatch(/ganaste|ganado|premio/i); // it says what was sent, never that something was won
    expect(p.q("[data-mine-edit]")!.textContent).toBe("Editar participación");
    expect(p.posts()).toHaveLength(0);
    p.close();
  });

  it("the date of the last change is shown only when it differs from the first send", async () => {
    const same = await loadScore({ mine: mineAt(2), openEdit: false });
    expect(summary(same)).not.toContain("Última actualización");
    const later = await loadScore({ mine: mineAt(2, { updatedAt: "2026-10-24T20:30:00.000Z" }), openEdit: false });
    expect(summary(later)).toContain("Última actualización:");
    same.close();
    later.close();
  });

  it("times are written with their zone, in the page's language, and follow a change of language", async () => {
    const p = await loadScore({ mine: mineAt(1), openEdit: false });
    const when = (locale: string) => new Intl.DateTimeFormat(locale, { year: "numeric", month: "short", day: "numeric", hour: "2-digit", minute: "2-digit", second: "2-digit", timeZoneName: "short" }).format(new Date(SENT));
    expect(summary(p)).toContain(`Enviada: ${when("es-HN")}`);
    p.win.UrbanoI18n.setLang("en");
    await p.settle();
    expect(summary(p)).toContain(`Sent: ${when("en-US")}`);
    expect(summary(p)).toContain("Status: saved. You can edit it until");
    p.close();
  });

  it("editing is explicit: the button opens the form with the saved answers, and 'back to the summary' keeps what was typed without saving it", async () => {
    const p = await loadScore({ mine: mineAt(2), openEdit: false });
    await p.click(p.q("[data-mine-edit]"));
    expect(p.q("form[data-ladder]")).not.toBeNull();
    expect(p.q("[data-mine-summary]")).toBeNull();
    expect(p.q('.team-toggle[data-value="HOME"]')!.getAttribute("aria-pressed")).toBe("true");
    await p.click(p.q('.team-toggle[data-value="AWAY"]'));
    await p.click(p.action(/Volver al resumen/));
    expect(p.q("form[data-ladder]")).toBeNull();
    expect(summary(p)).toContain("Primer equipo: Alpha FC"); // what is SAVED, untouched
    expect(summary(p)).toContain("Tenés cambios sin enviar en este navegador. Todavía no están guardados.");
    expect(p.q("[data-mine-edit]")!.textContent).toBe("Continuar edición");
    await p.click(p.q("[data-mine-edit]"));
    expect(p.q('.team-toggle[data-value="AWAY"]')!.getAttribute("aria-pressed")).toBe("true"); // the same form, with what was typed
    expect(p.posts()).toHaveLength(0);
    p.close();
  });

  it("a new send replaces the summary, and a retry of the same answers is a plain send of the same request", async () => {
    const p = await loadScore({ mine: mineAt(1), openEdit: false });
    await p.click(p.q("[data-mine-edit]"));
    await p.type(home(p), "3");
    await sendAndConfirm(p, 1);
    expect(summary(p)).toContain("Marcador: 3–1");
    expect(p.text(p.q("[data-mine-notice]"))).toContain("Participación guardada hasta el nivel 1 (Fácil).");
    expect(p.posts()).toHaveLength(1);
    p.close();
  });

  it("a closed match shows the summary without any way to edit; a missed one says so", async () => {
    const past = new Date(Date.now() - 3600_000).toISOString();
    const closed = await loadScore({ match: { kickoffAt: past }, mine: mineAt(3) });
    expect(summary(closed)).toContain("Estado: cerrada, el partido ya empezó. Esperando el resultado oficial.");
    expect(closed.q("[data-mine-edit]")).toBeNull();
    expect(closed.q("form[data-ladder]")).toBeNull();
    closed.close();
  });

  it("when the venue has no valid offer the saved entry is still shown, with no edit button and a state line that says why (never 'you can edit it')", async () => {
    const p = await loadScore({ levels: [], mine: mineAt(2) });
    expect(summary(p)).toContain("Sede: Beer Box");
    expect(summary(p)).toContain("Nivel enviado: Nivel 2 · Mediana");
    expect(p.q("[data-mine-edit]")).toBeNull();
    expect(summary(p)).toContain("Estado: guardada. Esta sede no tiene un premio válido configurado, así que no recibe cambios.");
    expect(summary(p)).not.toContain("Podés editarla");
    expect(summary(p)).not.toContain("ninguna sede tiene premios configurados"); // that sentence is about a match with nothing to take part in, not about this entry
    p.close();
  });

  it("a DISABLED venue activation: the saved entry is shown, the state line says the venue no longer takes changes, and there is no edit button", async () => {
    const base = ladderMatch().venueActivations[0] as any;
    const p = await loadScore({ match: { venueActivations: [{ ...base, enabled: false }] }, mine: mineAt(2) });
    expect(summary(p)).toContain("Estado: guardada. Esta sede ya no recibe cambios.");
    expect(summary(p)).not.toContain("Podés editarla");
    expect(p.q("[data-mine-edit]")).toBeNull();
    expect(p.q("form[data-ladder]")).toBeNull();
    expect(summary(p)).toContain("Marcador: 2–1"); // what was saved is still shown
    p.win.UrbanoI18n.setLang("en");
    await p.settle();
    expect(summary(p)).toContain("Status: saved. This venue no longer takes changes.");
    p.close();
  });

  it("a venue that is not available says so, in both languages, and offers no edit", async () => {
    const base = ladderMatch().venueActivations[0] as any;
    const p = await loadScore({ match: { venueActivations: [{ ...base, venue: { ...base.venue, active: false } }] }, mine: mineAt(1) });
    expect(summary(p)).toContain("Estado: guardada. Esta sede no está disponible por ahora, así que no se pueden hacer cambios.");
    expect(p.q("[data-mine-edit]")).toBeNull();
    p.win.UrbanoI18n.setLang("en");
    await p.settle();
    expect(summary(p)).toContain("Status: saved. This venue is not available for now, so changes cannot be made.");
    p.close();
  });

  it("an enabled, available venue still says 'you can edit it until' and keeps the edit button (the reason texts are not shown)", async () => {
    const p = await loadScore({ mine: mineAt(2), openEdit: false });
    expect(summary(p)).toContain("Estado: guardada. Podés editarla hasta");
    expect(summary(p)).not.toMatch(/ya no recibe cambios|no está disponible por ahora|premio válido/);
    expect(p.q("[data-mine-edit]")).not.toBeNull();
    p.close();
  });

  it("the labels of the card say what the time is: the start of the match and the close of participation are one instant", async () => {
    const p = await loadScore({ mine: mineAt(1), openEdit: false });
    const lines = p.qa("[data-match-times] p").map((n) => p.text(n));
    expect(lines).toHaveLength(2);
    expect(lines[0]).toMatch(/^Inicio del partido: /);
    expect(lines[1]).toMatch(/^Cierre de participación: .* \(al inicio del partido\)$/);
    expect(lines[0].split(": ")[1]).toBe(lines[1].split(": ")[1].replace(" (al inicio del partido)", ""));
    p.close();
  });
});

// ---------------------------------------------------------------------------
// El Clásico: the home team first, rosters shown by squad number and name, search, and crests
// ---------------------------------------------------------------------------

/** The two real rosters as the public matches route would return them: id, name and squad number, in the database's order (by name). */
function clasicoTeams() {
  const team = (index: number, teamId: string, prefix: string) => ({
    teamId,
    name: CLASICO_ROSTER_SNAPSHOT.teams[index].teamName,
    players: CLASICO_ROSTER_SNAPSHOT.teams[index].players
      .map((player) => ({ playerId: `${prefix}-${player.jerseyNumber}`, name: player.name, jerseyNumber: player.jerseyNumber }))
      .sort((a, b) => a.name.localeCompare(b.name)),
  });
  return { homeTeam: team(0, "t-fcb", "fcb"), awayTeam: team(1, "t-rm", "rm") };
}
const sortedLabels = (index: number) =>
  CLASICO_ROSTER_SNAPSHOT.teams[index].players.slice().sort((a, b) => a.jerseyNumber - b.jerseyNumber).map((player) => `${player.jerseyNumber} · ${player.name}`);
const continueTo = async (p: Score, level: number) => { await p.click(p.action(new RegExp(`(Continuar al nivel|Continue to level) ${level}`))); };
const searchBox = (p: Score) => p.q("#ladder-scorer-search-m1");
const scorerOptions = (p: Score) => p.qa("#ladder-scorer-m1 option").filter((o) => (o as HTMLOptionElement).value !== "" && (o as HTMLOptionElement).value !== "NONE").map((o) => p.text(o));
const scorerGroup = (p: Score, team: string) => p.qa("#ladder-scorer-m1 optgroup").find((g) => g.getAttribute("label") === team);
/** Takes the stepper to the scorer step with the given scoreline, the first team being whoever scores. */
async function toScorerStep(p: Score, h: string, a: string) {
  await answerScoreline(p, h, a);
  await continueTo(p, 2);
  await answerFirst(p, Number(h) > 0 ? "HOME" : "AWAY");
  await continueTo(p, 3);
}

describe("El Clásico: FC Barcelona is the home team, and what belongs to each team stays with it", () => {
  it("shows FC Barcelona first and Real Madrid CF second, and the HOME side of every answer is Barcelona's", async () => {
    const p = await loadScore({ match: clasicoTeams() });
    expect(p.qa(".match-teams .team-label").map((n) => p.text(n))).toEqual(["FC Barcelona", "Real Madrid CF"]);
    expect(p.qa(".score-stepper .team-name").map((n) => p.text(n))).toEqual(["FC Barcelona", "Real Madrid CF"]);
    expect(home(p).getAttribute("aria-label")).toBe("Goles de FC Barcelona");
    expect(away(p).getAttribute("aria-label")).toBe("Goles de Real Madrid CF");
    await answerScoreline(p, "2", "1");
    await continueTo(p, 2);
    expect(p.text(p.q('.team-toggle[data-value="HOME"]'))).toBe("FC Barcelona");
    expect(p.text(p.q('.team-toggle[data-value="AWAY"]'))).toBe("Real Madrid CF");
    await answerFirst(p, "HOME");
    await continueTo(p, 3);
    await answerScorer(p, "fcb-10");
    await sendAndConfirm(p, 3);
    // what leaves the browser says HOME / home goals for Barcelona, and the scorer is Barcelona's player
    expect(p.posts()[0].body).toMatchObject({ scoreline: { home: 2, away: 1 }, firstTeam: { kind: "PICKED", team: "HOME" }, goalscorer: { kind: "PICKED", playerId: "fcb-10" } });
    expect(summary(p)).toContain("10 · Lamine Yamal");
    p.close();
  });

  it("a team with no goals in the scoreline has neither its side as first team nor its players as scorers — whichever team that is", async () => {
    const barcelonaOnly = await loadScore({ match: clasicoTeams() });
    await answerScoreline(barcelonaOnly, "1", "0");
    await continueTo(barcelonaOnly, 2);
    expect(barcelonaOnly.q('.team-toggle[data-value="AWAY"]')!.getAttribute("aria-disabled")).toBe("true"); // Real Madrid has no goal
    expect(barcelonaOnly.q('.team-toggle[data-value="HOME"]')!.getAttribute("aria-disabled")).toBeNull();
    await answerFirst(barcelonaOnly, "HOME");
    await continueTo(barcelonaOnly, 3);
    const disabledOf = (p: Score, team: string) => [...scorerGroup(p, team)!.querySelectorAll("option")].every((o) => (o as HTMLOptionElement).disabled);
    const enabledOf = (p: Score, team: string) => [...scorerGroup(p, team)!.querySelectorAll("option")].every((o) => !(o as HTMLOptionElement).disabled);
    expect(disabledOf(barcelonaOnly, "Real Madrid CF")).toBe(true);
    expect(enabledOf(barcelonaOnly, "FC Barcelona")).toBe(true);
    barcelonaOnly.close();

    const madridOnly = await loadScore({ match: clasicoTeams() });
    await toScorerStep(madridOnly, "0", "2");
    expect(disabledOf(madridOnly, "FC Barcelona")).toBe(true);
    expect(enabledOf(madridOnly, "Real Madrid CF")).toBe(true);
    await answerScorer(madridOnly, "rm-10");
    await sendAndConfirm(madridOnly, 3);
    expect(madridOnly.posts()[0].body).toMatchObject({ scoreline: { home: 0, away: 2 }, firstTeam: { kind: "PICKED", team: "AWAY" }, goalscorer: { kind: "PICKED", playerId: "rm-10" } });
    expect(summary(madridOnly)).toContain("10 · Mbappé");
    madridOnly.close();
  });
});

describe("the scorer is chosen by squad number and name", () => {
  it("lists each team's own roster as 'number · name', in number order, and nothing else about a player", async () => {
    const p = await loadScore({ match: clasicoTeams() });
    await toScorerStep(p, "2", "1");
    expect([...scorerGroup(p, "FC Barcelona")!.querySelectorAll("option")].map((o) => p.text(o))).toEqual(sortedLabels(0));
    expect([...scorerGroup(p, "Real Madrid CF")!.querySelectorAll("option")].map((o) => p.text(o))).toEqual(sortedLabels(1));
    expect(scorerOptions(p)).toHaveLength(53);
    for (const label of scorerOptions(p)) expect(label).toMatch(/^\d{1,2} · \S/);
    expect(scorerOptions(p).join(" ")).not.toMatch(/\b(POR|DEF|MED|DEL)\b|fcbarcelona|realmadrid|2026/); // no position, source or date
    p.close();
  });

  it("finds a player by part of the name, ignoring accents and case, and by squad number — a number matches that number only", async () => {
    const p = await loadScore({ match: clasicoTeams() });
    await toScorerStep(p, "2", "1");
    const search = async (query: string) => { await p.type(searchBox(p), query); return scorerOptions(p); };
    expect(await search("yam")).toEqual(["10 · Lamine Yamal"]);
    expect(await search("YAMAL")).toEqual(["10 · Lamine Yamal"]);
    expect(await search("garcia")).toEqual(["1 · Joan García", "24 · Eric García"]); // accent-insensitive; both Garcías, Barcelona's only
    expect(await search("tchoua")).toEqual(["14 · Tchouaméni"]);
    expect(await search("vini")).toEqual(["7 · Vini Jr."]);
    expect(await search("10")).toEqual(["10 · Lamine Yamal", "10 · Mbappé"]); // one per team, never 100 or 110
    expect(await search("#1")).toEqual(["1 · Joan García", "1 · Courtois"]); // not 10, 11, 12, 13…
    expect(await search("1")).toEqual(["1 · Joan García", "1 · Courtois"]);
    expect(await search("jesus")).toEqual(["9 · Gabriel Jesus"]);
    expect(await search("selim")).toEqual(["29 · Hamza Mohamed Abdelkarim Elsayed Selim"]); // the longest name, whole
    expect(await search("")).toHaveLength(53); // clearing the search brings everyone back
    p.close();
  });

  it("says so, in the member's language, when nothing matches — and never changes what is selected or blocked", async () => {
    const es = await loadScore({ match: clasicoTeams() });
    await toScorerStep(es, "2", "1");
    await es.type(searchBox(es), "zzz");
    expect(scorerOptions(es)).toEqual([]);
    expect(es.text(es.q(".scorer-search-status"))).toBe("Ningún jugador coincide con «zzz». Probá con otra parte del nombre o con el dorsal.");
    expect(es.text(es.q('label[for="ladder-scorer-search-m1"]'))).toBe("Buscar jugador por nombre o dorsal");
    es.close();
    const en = await loadScore({ match: clasicoTeams(), lang: "en" });
    await toScorerStep(en, "2", "1");
    await en.type(searchBox(en), "zzz");
    expect(en.text(en.q(".scorer-search-status"))).toBe("No player matches “zzz”. Try another part of the name or the squad number.");
    expect(en.text(en.q('label[for="ladder-scorer-search-m1"]'))).toBe("Search a player by name or number");
    await en.type(searchBox(en), "");
    expect(en.text(en.q(".scorer-search-status"))).toBe("");
    en.close();
  });

  it("keeps the selected player in the list while a search hides everybody else, and the selection is what is sent", async () => {
    const p = await loadScore({ match: clasicoTeams() });
    await toScorerStep(p, "2", "1");
    await answerScorer(p, "fcb-10");
    await p.type(searchBox(p), "courtois");
    expect(scorerOptions(p)).toEqual(["10 · Lamine Yamal", "1 · Courtois"]); // the choice stays visible; Courtois (away) is listed but blocked below
    expect((p.q("#ladder-scorer-m1") as HTMLSelectElement).value).toBe("fcb-10");
    await sendAndConfirm(p, 3);
    expect(p.posts()[0].body.goalscorer).toEqual({ kind: "PICKED", playerId: "fcb-10" });
    p.close();
  });

  it("shows the longest name whole, wrapping instead of being cut, in the summary", async () => {
    const p = await loadScore({ match: clasicoTeams() });
    await toScorerStep(p, "2", "1");
    await answerScorer(p, "fcb-29");
    await sendAndConfirm(p, 3);
    expect(summary(p)).toContain("29 · Hamza Mohamed Abdelkarim Elsayed Selim");
    expect(SCORE_HTML).toMatch(/\.mine-summary\s*\{[^}]*overflow-wrap:\s*anywhere/);
    p.close();
  });
});

describe("a saved participation follows the player's id, not the number or the spelling shown", () => {
  const saved = (playerId: string) => savedView(3, { goalscorer: { kind: "PICKED", playerId }, scoreline: { home: 2, away: 1 } });
  it("shows the same player under a changed squad number or published spelling, because the id did not change", async () => {
    const before = await loadScore({ match: clasicoTeams(), mine: { prediction: saved("fcb-10"), evaluation: null, qualification: null }, openEdit: false });
    expect(summary(before)).toContain("Goleador: 10 · Lamine Yamal");
    before.close();
    const teams = clasicoTeams();
    teams.homeTeam.players = teams.homeTeam.players.map((player) => (player.playerId === "fcb-10" ? { ...player, jerseyNumber: 19, name: "Lamine Yamal Nasraoui" } : player));
    const after = await loadScore({ match: teams, mine: { prediction: saved("fcb-10"), evaluation: null, qualification: null }, openEdit: false });
    expect(summary(after)).toContain("Goleador: 19 · Lamine Yamal Nasraoui");
    after.close();
  });

  it("a team whose roster has no numbers (a player added by hand) shows just the name", async () => {
    const p = await loadScore({ openEdit: false, mine: { prediction: savedView(3, { goalscorer: { kind: "PICKED", playerId: "p1" } }), evaluation: null, qualification: null } });
    expect(summary(p)).toContain("Goleador: Ana Díaz");
    p.close();
  });
});

describe("club crests on the Score page", () => {
  it("draws each team's crest in front of its name — match header, scoreline steppers, first-team buttons — home team first, as decoration beside the written name", async () => {
    const p = await loadScore({ match: clasicoTeams(), crests: true });
    const headerKeys = p.qa(".match-teams .club-crest").map((img) => img.getAttribute("data-crest"));
    expect(headerKeys).toEqual(["fc-barcelona", "real-madrid-cf"]);
    expect(p.qa(".match-teams img").every((img) => img.getAttribute("alt") === "" && img.getAttribute("aria-hidden") === "true")).toBe(true);
    expect(p.qa(".match-teams .team-label").map((n) => p.text(n))).toEqual(["FC Barcelona", "Real Madrid CF"]); // the names are text; crests add no words
    expect(p.qa(".score-stepper .team-name .club-crest").map((img) => img.getAttribute("data-crest"))).toEqual(["fc-barcelona", "real-madrid-cf"]);
    await answerScoreline(p, "2", "1");
    await continueTo(p, 2);
    expect(p.qa(".team-toggle .club-crest").map((img) => img.getAttribute("data-crest"))).toEqual(["fc-barcelona", "real-madrid-cf"]);
    expect(p.text(p.q('.team-toggle[data-value="HOME"]'))).toBe("FC Barcelona");
    p.close();
  });

  it("without the crests module the page is the same, in text: no image anywhere and every name still shown", async () => {
    const p = await loadScore({ match: clasicoTeams() });
    expect(p.qa("img.club-crest")).toHaveLength(0);
    expect(p.qa(".score-stepper .team-name").map((n) => p.text(n))).toEqual(["FC Barcelona", "Real Madrid CF"]);
    expect(p.qa(".match-teams .team-label").map((n) => p.text(n))).toEqual(["FC Barcelona", "Real Madrid CF"]);
    p.close();
  });

  it("a team without a crest (any other match) is drawn exactly as before", async () => {
    const p = await loadScore({ crests: true });
    expect(p.qa("img.club-crest")).toHaveLength(0);
    expect(p.qa(".match-teams .team-label").map((n) => p.text(n))).toEqual(["Alpha FC", "Beta FC"]);
    p.close();
  });
});

// ---------------------------------------------------------------------------
// The proposed prizes of The Pub: a notice where the prizes are listed and before anything is sent — and only where the server flags the match
// ---------------------------------------------------------------------------

const THE_PUB_PRIZES = [
  { level: 1, label: "Tequeños de queso" },
  { level: 2, label: "Cheese Burger con papas" },
  { level: 3, label: "Cubetazo de 5 cervezas" },
  { level: 4, label: "L3,000 en productos de The Pub, no efectivo, por cada ganador" },
];
const NOTICE_ES = "Premios propuestos, pendientes de confirmación por The Pub el día del partido. Esta demostración no genera derecho a premio.";
const NOTICE_EN = "Proposed prizes, pending confirmation by The Pub on match day. This demonstration does not create any right to a prize.";
/** A match of the public answer whose offer carries The Pub's proposed prizes; `provisionalPrizes` is what the server says about it. */
function pubMatch(provisionalPrizes: boolean | undefined) {
  const base = ladderMatch();
  const activation = base.venueActivations[0];
  return {
    ...(provisionalPrizes === undefined ? {} : { provisionalPrizes }),
    venueActivations: [{
      ...activation,
      prizeTiers: THE_PUB_TIERS(),
      offer: { available: true, maxLevel: 4, levels: THE_PUB_PRIZES, digest: DIGEST, problem: null },
    }],
  };
}
function THE_PUB_TIERS() {
  return THE_PUB_PRIZES.map((p) => ({ prizeTierId: `tier-${p.level}`, correctDimensionCount: null, ladderLevel: p.level, prizeLabel: p.label }));
}
const provisionalBlock = (p: Score) => p.q("[data-ladder-provisional]") as HTMLElement;
const reviewAfterSendClick = async (p: Score) => { await answerScoreline(p, "2", "1"); await p.click(p.action(/(Enviar|Send) con nivel 1|Send with level 1/)); };

describe("proposed prizes: the notice and the list", () => {
  it("the list of prizes is visible, level by level, with the notice above it — not hidden inside the closed explanation", async () => {
    const p = await loadScore({ match: pubMatch(true) });
    const block = provisionalBlock(p);
    expect(block.hidden).toBe(false);
    expect(p.text(block.querySelector(".provisional-notice"))).toBe(NOTICE_ES);
    expect([...block.querySelectorAll(".ladder-offers li")].map((li) => p.text(li))).toEqual([
      "Nivel 1 · Fácil: Tequeños de queso",
      "Nivel 2 · Mediana: Cheese Burger con papas",
      "Nivel 3 · Difícil: Cubetazo de 5 cervezas",
      "Nivel 4 · Legendaria: L3,000 en productos de The Pub, no efectivo, por cada ganador",
    ]);
    expect(block.closest("details")).toBeNull();
    expect(block.firstElementChild!.classList.contains("provisional-notice")).toBe(true); // the notice comes first
    // the same notice also opens the explanation that lists the prizes inside the disclosure
    expect(p.text(p.q("[data-ladder-help-body] .provisional-notice"))).toBe(NOTICE_ES);
    p.close();
  });

  it("the notice is in the summary shown BEFORE sending, ahead of the prize line, and the review still names the one prize of the level sent", async () => {
    const p = await loadScore({ match: pubMatch(true) });
    await reviewAfterSendClick(p);
    const review = p.q("[data-ladder-review]") as HTMLElement;
    expect(review.hidden).toBe(false);
    const notice = review.querySelector(".provisional-notice") as HTMLElement;
    expect(p.text(notice)).toBe(NOTICE_ES);
    const prizeLine = [...review.querySelectorAll("p")].find((node) => /Premio máximo posible/.test(p.text(node)))!;
    expect(p.text(prizeLine)).toContain("Tequeños de queso");
    // the notice precedes the prize line in the page
    expect(notice.compareDocumentPosition(prizeLine) & p.win.Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    // and the way to send is untouched: one confirmation, the same request
    await p.click(p.action(/Confirmar y enviar/));
    await p.settle(60);
    expect(p.posts()).toHaveLength(1);
    expect(p.posts()[0].body).toMatchObject({ attemptedLevel: 1, scoreline: { home: 2, away: 1 } });
    const keysFlagged = Object.keys(p.posts()[0].body).sort();
    p.close();
    // the very same request goes out when the match is not flagged: the notice adds nothing to what is sent
    const plain = await loadScore({ match: pubMatch(false) });
    await reviewAfterSendClick(plain);
    await plain.click(plain.action(/Confirmar y enviar/));
    await plain.settle(60);
    expect(Object.keys(plain.posts()[0].body).sort()).toEqual(keysFlagged);
    expect(JSON.stringify(Object.keys(plain.posts()[0].body))).not.toMatch(/provisional/i);
    plain.close();
  });

  it("in English the notice and the list read the same way, and a change of language redraws them in place", async () => {
    const p = await loadScore({ match: pubMatch(true) });
    expect(p.text(provisionalBlock(p).querySelector(".provisional-notice"))).toBe(NOTICE_ES);
    p.win.UrbanoI18n.setLang("en");
    await p.settle(60);
    expect(p.text(provisionalBlock(p).querySelector(".provisional-notice"))).toBe(NOTICE_EN);
    expect(p.text(provisionalBlock(p).querySelector(".ladder-offers li"))).toBe("Level 1 · Easy: Tequeños de queso"); // the prize names are the venue's own words, as entered
    expect(p.qa(".provisional-notice")).toHaveLength(2); // the list and the explanation: redrawn, not duplicated
    await reviewAfterSendClick(p);
    expect(p.text(p.q("[data-ladder-review] .provisional-notice"))).toBe(NOTICE_EN);
    p.close();
  });

  it("does not turn a proposal into a promise, a single winner, a quota or a draw: nothing in the block says so, and the one-prize rule is still the page's", async () => {
    const p = await loadScore({ match: pubMatch(true) });
    // The words of the PAGE (the notice, the headings) must not promise anything; the prize names are the venue's own words, as entered (the
    // Legendary proposal says "por cada ganador" itself), so they are taken out before looking.
    let blockText = p.text(provisionalBlock(p));
    for (const prize of THE_PUB_PRIZES) blockText = blockText.replace(prize.label, "");
    expect(blockText).not.toMatch(/ganador|winner|cupo|quota|sorteo|draw|raffle|primeros|first come|únic[oa] |agotar|while supplies|limit/i);
    expect(blockText).toContain("no genera derecho a premio");
    expect(p.text(p.q(".ladder-rules"))).toBe(SPANISH_ESSENTIALS); // "Un solo premio: el del nivel más alto que aciertes en orden." is unchanged
    p.close();
  });

  it("is absent unless the server says the match is provisional: no flag, or false, and neither the list block nor any notice exists, anywhere", async () => {
    for (const flag of [undefined, false]) {
      const p = await loadScore({ match: pubMatch(flag) });
      expect(provisionalBlock(p).hidden).toBe(true);
      expect(provisionalBlock(p).childElementCount).toBe(0);
      expect(p.qa(".provisional-notice")).toHaveLength(0);
      await reviewAfterSendClick(p);
      expect(p.qa(".provisional-notice")).toHaveLength(0);
      expect(p.text(p.q("[data-ladder-review]"))).toContain("Tequeños de queso"); // the prizes are shown as before, as the venue entered them
      p.close();
    }
  });

  it("only a literal true counts: the strings 'true' and '1' or any object do not switch the notice on", async () => {
    for (const bogus of ["true", "1", { a: 1 }] as unknown[]) {
      const p = await loadScore({ match: { ...pubMatch(undefined), provisionalPrizes: bogus } });
      expect(p.qa(".provisional-notice"), JSON.stringify(bogus)).toHaveLength(0);
      p.close();
    }
  });
});

// ---------------------------------------------------------------------------
// The approved participation window: the page shows when it opens and passes the server's "not yet" on; the server is what refuses
// ---------------------------------------------------------------------------

describe("the participation window on the Score page", () => {
  const OPENS_ISO = "2026-10-25T18:30:00.000Z"; // 12:30 p. m., Honduras
  const NOT_OPEN = "Participation for this match has not opened yet.";
  const timesText = (p: Score) => p.qa("[data-match-times] p").map((n) => p.text(n));

  it("shows the opening time among the match's times when the server sends one — before the start and the closing — in both languages", async () => {
    const es = await loadScore({ match: { participationOpensAt: OPENS_ISO } });
    const esLines = timesText(es);
    expect(esLines).toHaveLength(3);
    expect(esLines[0]).toMatch(/^Apertura de participación: /);
    expect(esLines[1]).toMatch(/^Inicio del partido: /);
    expect(esLines[2]).toMatch(/^Cierre de participación: /);
    es.close();
    const en = await loadScore({ lang: "en", match: { participationOpensAt: OPENS_ISO } });
    expect(timesText(en)[0]).toMatch(/^Participation opens: /);
    en.win.UrbanoI18n.setLang("es");
    await en.settle(60);
    expect(timesText(en)[0]).toMatch(/^Apertura de participación: /); // redrawn in place
    en.close();
  });

  it("shows nothing about an opening for a match without a window: the two usual lines, exactly as before", async () => {
    for (const match of [{}, { participationOpensAt: null }, { participationOpensAt: "not a date" }]) {
      const p = await loadScore({ match });
      expect(timesText(p).map((line) => line.split(":")[0])).toEqual(["Inicio del partido", "Cierre de participación"]);
      p.close();
    }
  });

  it("does not pretend to enforce it: the send button is not hidden or switched off by the clock — the server's refusal is what stops a request, and the page says it in the member's language", async () => {
    for (const lang of ["es", "en"] as const) {
      const p = await loadScore({ lang, match: { participationOpensAt: new Date(Date.now() + 3 * 3600_000).toISOString() }, predict: () => ({ status: 409, json: { error: NOT_OPEN } }) });
      await answerScoreline(p, "1", "0");
      const send = p.action(/(Enviar|Send) con nivel 1|Send with level 1/) as HTMLButtonElement;
      expect(send.disabled).toBe(false); // nothing on the page decides that it is too early
      await p.click(send);
      await p.click(p.action(/Confirmar y enviar|Confirm and send/));
      await p.settle(60);
      expect(p.posts()).toHaveLength(1); // the request did go to the server...
      const message = p.text(p.q(`#submit-msg-m1`));
      expect(message).toBe(lang === "es" ? "La participación de este partido todavía no está abierta." : NOT_OPEN); // ...which refused it
      p.close();
    }
  });
});

// ---------------------------------------------------------------------------
// The conditions (legal texts), before the first send
// ---------------------------------------------------------------------------

describe("the conditions before the first send", () => {
  const ACCEPT_URL = "/api/gaming/legal/acceptances";
  async function toReview(p: Score) {
    await answerScoreline(p, "2", "1");
    await p.click(p.action(/Enviar con nivel 1|Send with level 1/));
  }
  const panel = (p: Score) => p.q("[data-ladder-conditions]")!;
  const confirm = (p: Score) => p.action(/Confirmar y enviar|Confirm and send/)!;
  const ticks = (p: Score) => p.qa("[data-legal-tick]") as HTMLInputElement[];
  const ageBox = (p: Score) => p.q("[data-legal-age]") as HTMLInputElement;
  const tick = async (p: Score, box: HTMLInputElement) => { box.checked = true; box.dispatchEvent(new p.win.Event("change", { bubbles: true })); await p.settle(); };
  const legalCalls = (p: Score) => p.calls.filter((c) => c.url.startsWith(ACCEPT_URL));

  it("when nothing is accepted yet, shows the three texts with a link to each in full, and sends nothing until every box is ticked", async () => {
    const p = await loadScore({ legal: "pending" });
    await toReview(p);
    expect(p.text(panel(p))).toContain("Condiciones para participar");
    expect(p.qa("[data-legal-doc]").map((n) => n.getAttribute("data-legal-doc"))).toEqual(["ACCOUNT_TERMS", "PRIVACY_NOTICE", "EVENT_RULES"]);
    const links = p.qa("[data-ladder-conditions] a.legal-read") as HTMLAnchorElement[];
    expect(links.map((a) => a.getAttribute("href"))).toEqual([
      "/legal.html?doc=ACCOUNT_TERMS&version=t-1",
      "/legal.html?doc=PRIVACY_NOTICE&version=p-1",
      "/legal.html?doc=EVENT_RULES&version=e-1&kickoffAt=2026-10-25T20%3A00%3A00.000Z",
    ]);
    for (const a of links) { expect(a.target).toBe("_blank"); expect(a.rel).toContain("noopener"); expect(p.text(a)).toBe("Leer el texto completo (se abre en otra pestaña)"); }
    expect(confirm(p).disabled).toBe(true);
    expect(p.text(p.q("[data-legal-need]"))).toBe("Marcá todas las casillas para poder enviar.");
    await p.click(confirm(p)); // a disabled button does nothing
    expect(legalCalls(p).filter((c) => c.method === "POST")).toEqual([]);
    expect(p.posts()).toEqual([]);
    p.close();
  });

  it("the terms and the rules are ACCEPTED; the privacy notice is only READ, and says so: it is never worded as a consent", async () => {
    const p = await loadScore({ legal: "pending" });
    await toReview(p);
    const labels = p.qa("[data-ladder-conditions] label.legal-tick").map((l) => p.text(l));
    expect(labels).toEqual([
      "Acepto: Términos de cuenta (texto de prueba)",
      "Leí: Aviso de privacidad (texto de prueba)",
      "Acepto: Reglas del evento (texto de prueba)",
      "Declaro que tengo 18 años cumplidos o más.",
    ]);
    const privacy = p.q('[data-legal-doc="PRIVACY_NOTICE"]')!;
    expect(p.text(privacy)).toContain("Esto confirma que leíste el aviso. No es un permiso para ningún otro uso de tus datos.");
    expect(p.text(privacy)).not.toMatch(/Acepto|consent/i);
    expect(p.q('[data-legal-doc="ACCOUNT_TERMS"] .ladder-hint')).toBeNull();
    p.close();
  });

  it("needs every box, the age declaration included; then records the acts BEFORE the prediction is sent, each with the version and the hash it showed", async () => {
    const p = await loadScore({ legal: "pending" });
    await toReview(p);
    const [terms, privacy, rules] = ticks(p);
    await tick(p, terms);
    await tick(p, privacy);
    await tick(p, rules);
    expect(confirm(p).disabled).toBe(true); // the declaration of being 18 or older is still to do
    await tick(p, ageBox(p));
    expect(confirm(p).disabled).toBe(false);
    expect(p.text(p.q("[data-legal-need]"))).toBe("");
    await p.click(confirm(p));
    await p.settle(60);
    const order = p.calls.filter((c) => c.method === "POST").map((c) => c.url);
    expect(order).toEqual([ACCEPT_URL, `${API}/matches/m1/predict`]);
    expect(legalCalls(p).find((c) => c.method === "POST")!.body).toEqual({
      matchId: "m1",
      acceptances: [
        { documentKey: "ACCOUNT_TERMS", documentVersion: "t-1", contentSha256: "a".repeat(64) },
        { documentKey: "PRIVACY_NOTICE", documentVersion: "p-1", contentSha256: "b".repeat(64) },
        { documentKey: "EVENT_RULES", documentVersion: "e-1", contentSha256: "c".repeat(64), ageDeclared18: true },
      ],
    });
    expect(p.posts()).toHaveLength(1);
    expect(p.q("form[data-ladder]")).toBeNull(); // saved: the page shows "My participation"
    p.close();
  });

  it("with the texts already accepted it asks for nothing: it shows when, and sends straight away, without another acceptance request", async () => {
    const p = await loadScore({ legal: "accepted" });
    await toReview(p);
    expect(ticks(p)).toEqual([]);
    expect(p.qa("[data-legal-done]")).toHaveLength(3);
    expect(p.text(p.q('[data-legal-done="PRIVACY_NOTICE"]'))).toMatch(/^Leído el /);
    expect(p.text(p.q('[data-legal-done="ACCOUNT_TERMS"]'))).toMatch(/^Aceptado el /);
    expect(confirm(p).disabled).toBe(false);
    await p.click(confirm(p));
    await p.settle(60);
    expect(legalCalls(p).filter((c) => c.method === "POST")).toEqual([]);
    expect(p.posts()).toHaveLength(1);
    p.close();
  });

  it("with no approved text (how it ships) says so, offers no box, and neither records nor sends anything", async () => {
    const p = await loadScore({ legal: "unpublished" });
    await toReview(p);
    expect(p.text(p.q("[data-legal-unpublished]"))).toBe("Las condiciones de este evento todavía no están publicadas, así que por ahora no se puede enviar el pronóstico.");
    expect(ticks(p)).toEqual([]);
    expect(confirm(p).disabled).toBe(true);
    await p.click(confirm(p));
    expect(p.calls.filter((c) => c.method === "POST")).toEqual([]);
    p.close();
  });

  it("when the check itself fails it says so, keeps the send disabled, and a retry asks again", async () => {
    const p = await loadScore({ legal: "failed" });
    await toReview(p);
    expect(p.text(panel(p))).toContain("No pudimos comprobar las condiciones. Probá de nuevo.");
    expect(confirm(p).disabled).toBe(true);
    const before = legalCalls(p).filter((c) => c.method === "GET").length;
    await p.click(p.qa("[data-ladder-conditions] button").find((b) => /Reintentar/.test(p.text(b))));
    await p.settle(40);
    expect(legalCalls(p).filter((c) => c.method === "GET").length).toBe(before + 1);
    expect(p.posts()).toEqual([]);
    p.close();
  });

  it("when the text changed under the person, says so, sends nothing, forgets the ticks and shows the current texts again", async () => {
    const p = await loadScore({
      legal: "pending",
      legalPost: () => ({ status: 409, json: { error: "The text you were shown is no longer the current one.", code: "LEGAL_DOCUMENT_STALE", missing: [] } }),
    });
    await toReview(p);
    const [terms, privacy, rules] = ticks(p);
    for (const box of [terms, privacy, rules, ageBox(p)]) await tick(p, box);
    await p.click(confirm(p));
    await p.settle(60);
    expect(p.text(p.q("#submit-msg-m1"))).toBe("El texto cambió mientras lo leías. Leelo de nuevo y volvé a marcar.");
    expect(p.posts()).toEqual([]);
    expect(ticks(p).every((box) => !box.checked)).toBe(true);
    expect(confirm(p).disabled).toBe(true);
    p.close();
  });

  it("a refusal about the conditions from the send itself is shown in the person's language and the conditions are asked for again", async () => {
    const p = await loadScore({
      legal: "accepted",
      predict: () => ({ status: 409, json: { error: "The current conditions must be accepted before taking part.", code: "LEGAL_CONDITIONS_REQUIRED", missing: [{ documentKey: "ACCOUNT_TERMS", documentVersion: "t-2" }] } }),
    });
    await toReview(p);
    const before = legalCalls(p).filter((c) => c.method === "GET").length;
    await p.click(confirm(p));
    await p.settle(80);
    expect(p.text(p.q("#submit-msg-m1"))).toBe("Tenés que aceptar las condiciones vigentes antes de participar.");
    expect(legalCalls(p).filter((c) => c.method === "GET").length).toBe(before + 1);
    p.close();
  });

  it("speaks English when the page is in English, with the same structure", async () => {
    const p = await loadScore({ legal: "pending", lang: "en" });
    await toReview(p);
    expect(p.qa("[data-ladder-conditions] label.legal-tick").map((l) => p.text(l))).toEqual([
      "I accept: Términos de cuenta (texto de prueba)",
      "I have read: Aviso de privacidad (texto de prueba)",
      "I accept: Reglas del evento (texto de prueba)",
      "I declare that I am 18 years old or older.",
    ]);
    expect(p.text(p.q('[data-legal-doc="PRIVACY_NOTICE"]'))).toContain("This confirms that you read the notice. It is not a permission for any other use of your data.");
    p.close();
  });

  it("puts the title that comes from the server on the page as text, never as markup", async () => {
    const p = await loadScore({ legal: "pending", legalTitle: '<img src=x onerror="window.__pwned=1"><b>x</b>' });
    await toReview(p);
    expect(p.q("[data-ladder-conditions] img")).toBeNull();
    expect(p.q("[data-ladder-conditions] b")).toBeNull();
    expect(p.text(p.q('[data-legal-doc="EVENT_RULES"]'))).toContain('<img src=x onerror="window.__pwned=1"><b>x</b>');
    expect((p.win as any).__pwned).toBeUndefined();
    p.close();
  });

  it("leaving the review and coming back asks the server again (the texts may have changed in between)", async () => {
    const p = await loadScore({ legal: "pending" });
    await toReview(p);
    const first = legalCalls(p).filter((c) => c.method === "GET").length;
    await p.click(p.action(/Volver a editar|Edit/) ?? p.qa(".ladder-actions button").find((b) => /editar|Edit/i.test(p.text(b))));
    expect(p.q("[data-ladder-conditions]")!.hidden).toBe(true);
    await p.click(p.action(/Enviar con nivel 1|Send with level 1/));
    await p.settle(40);
    expect(legalCalls(p).filter((c) => c.method === "GET").length).toBe(first + 1);
    p.close();
  });
});
