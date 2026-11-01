import { readFileSync } from "node:fs";
import path from "node:path";

import { JSDOM } from "jsdom";
import { vi } from "vitest";

/**
 * UG-IV-GATE-018 — the harness of the contest's page tests: the ACTUAL shipped pages (voter, operator station, venue display), parsed and run whole in
 * jsdom with the real logic modules, a stubbed identity seam and a scripted fake server. No network, no provider, no canvas, no position sensor.
 *
 * Real layout, touch behaviour and the real camera pipeline are verified in a real browser (see the implementation record); jsdom has no layout engine.
 * What these tests pin is behaviour: which view a person sees, what is (and is not) sent to the server, and that nothing is shown as accepted before
 * the server says so.
 */

const ROOT = process.cwd();
const read = (f: string) => readFileSync(path.join(ROOT, "public", f), "utf8");
export const FILES: Record<string, string> = {
  "featuredContest.js": read("featuredContest.js"),
  "communityVotingRound.js": read("communityVotingRound.js"),
  "communityVotingShareCard.js": read("communityVotingShareCard.js"),
  "communityVotingRoundOperator.js": read("communityVotingRoundOperator.js"),
  "communityVotingSlideshow.js": read("communityVotingSlideshow.js"),
  "urbanoAuth.js": "/* the identity seam is stubbed by the test */",
};
export const PAGES = {
  voter: read("community-voting-round.html"),
  operator: read("community-voting-round-operator.html"),
  display: read("community-voting-round-display.html"),
};

export const CONTEST = "c0c0c0c0-2222-4333-8444-555555555555";
export const KEYS = ["MOST_ELABORATE", "SEXIEST", "BEST_GROUP", "FUNNIEST"] as const;
export type Key = (typeof KEYS)[number];
export const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
export const INST: Record<Key, string> = { MOST_ELABORATE: uuid(1), SEXIEST: uuid(2), BEST_GROUP: uuid(3), FUNNIEST: uuid(4) };
export const ROUNDS = "/api/gaming/community-voting/rounds";
export const CONTESTS = "/api/gaming/community-voting/contests";

export const REG_OPENS = "2026-11-01T02:00:00.000Z";
export const REG_CLOSES = "2026-11-01T05:00:00.000Z";
export const VOTE_OPENS = "2026-11-01T05:00:00.000Z";
export const VOTE_CLOSES = "2026-11-01T06:00:00.000Z";

export type Json = Record<string, any>;
export interface Call { url: string; method: string; body: any; headers: Record<string, string> }
export type Reply = { status: number; json?: unknown; text?: string };
export type Responder = (call: Call) => Reply | Promise<Reply>;
export type AuthState = { status: "unauthenticated" | "profile_incomplete" | "authenticated"; email?: string };

/** jsdom does not load external scripts: inline the real files so their top-level bindings are global, exactly as /file.js would make them. */
function inlineScripts(html: string): string {
  return html.replace(/<script src="\/([^"]+)"><\/script>/g, (_m, name: string) => `<script>${FILES[name] ?? ""}</script>`);
}

export interface PageOpts {
  html: string;
  query?: string;
  auth?: AuthState;
  respond: Responder;
  session?: Record<string, string>;
  local?: Record<string, string>;
  /** a change to the page's own world before its scripts run (a stubbed clipboard, a file reader, …) */
  prepare?: (w: Record<string, any>) => void;
}

export async function loadPage(opts: PageOpts) {
  const calls: Call[] = [];
  const timers: Array<{ id: number; fn: () => void; ms: number }> = [];
  let timerSeq = 0;
  let auth: AuthState = opts.auth ?? { status: "unauthenticated" };
  const identity = { requested: [] as string[], verified: [] as string[][], profiles: [] as string[], signOuts: 0 };
  const geo = { getCurrentPosition: vi.fn(), watchPosition: vi.fn() };
  const clipboard: string[] = [];
  const dom = new JSDOM(inlineScripts(opts.html), {
    url: `http://localhost/page.html${opts.query ?? `?c=${CONTEST}`}`,
    runScripts: "dangerously",
    pretendToBeVisual: true,
    beforeParse(window) {
      const w = window as unknown as Record<string, any>;
      for (const [k, v] of Object.entries(opts.session ?? {})) window.sessionStorage.setItem(k, v);
      for (const [k, v] of Object.entries(opts.local ?? {})) window.localStorage.setItem(k, v);
      Object.defineProperty(window.navigator, "geolocation", { value: geo, configurable: true });
      Object.defineProperty(window.navigator, "clipboard", { value: { writeText: async (t: string) => { clipboard.push(t); } }, configurable: true });
      w.UrbanoAuth = {
        getState: async () => (auth.status === "unauthenticated" ? auth : { authUserId: "stub-user", ...auth }),
        getAccessToken: async () => (auth.status === "unauthenticated" ? null : "stub-access-token"),
        onAuthStateChange: async () => () => {},
        onIdentityChange: async () => () => {},
        onIdentityReset: async () => () => {},
        attachSignInButton: () => {},
        requestOtp: async (email: string) => { identity.requested.push(email); return { status: "sent" }; },
        verifyOtp: async (email: string, code: string) => { identity.verified.push([email, code]); auth = { status: "profile_incomplete", email }; return { status: "profile_incomplete", email }; },
        completeProfile: async (name: string) => { identity.profiles.push(name); auth = { status: "authenticated", email: auth.email }; return { status: "authenticated", email: auth.email, displayName: name }; },
        signOut: async () => { identity.signOuts++; auth = { status: "unauthenticated" }; return { status: "unauthenticated" }; },
      };
      w.fetch = async (url: string, init: any = {}) => {
        const call: Call = { url: String(url), method: init.method ?? "GET", body: init.body ? JSON.parse(init.body) : undefined, headers: init.headers ?? {} };
        calls.push(call);
        const out = await opts.respond(call);
        return {
          status: out.status, ok: out.status >= 200 && out.status < 300,
          json: async () => { if (out.json === undefined) throw new Error("no body"); return out.json; },
          text: async () => out.text ?? "",
          blob: async () => new window.Blob([out.text ?? ""]),
        };
      };
      w.Image = class { onload: (() => void) | null = null; onerror: (() => void) | null = null; set src(_v: string) { setTimeout(() => this.onload?.(), 0); } };
      w.setTimeout = (fn: () => void, ms: number) => { const id = ++timerSeq; timers.push({ id, fn, ms }); return id; };
      w.clearTimeout = (id: number) => { const i = timers.findIndex((t) => t.id === id); if (i >= 0) timers.splice(i, 1); };
      w.setInterval = () => 0;
      w.scrollTo = () => {};
      w.URL.createObjectURL = () => "blob:stub";
      w.URL.revokeObjectURL = () => {};
      opts.prepare?.(w);
    },
  });
  const win = dom.window as unknown as Window & Record<string, any>;
  const doc = win.document;
  const settle = async (ms = 40) => { for (let i = 0; i < 8; i++) await new Promise((r) => setTimeout(r, ms / 8)); };
  await settle();
  const api = {
    win, doc, calls, identity, geo, clipboard, timers,
    $: (sel: string) => doc.querySelector(sel) as HTMLElement | null,
    $$: (sel: string) => Array.from(doc.querySelectorAll(sel)) as HTMLElement[],
    text: (sel = "#app") => (doc.querySelector(sel)?.textContent ?? "").replace(/\s+/g, " ").trim(),
    /** the text as a person reads it: every text node separated by a space, so neighbouring blocks never run together */
    spaced: (sel = "#app") => {
      const root = doc.querySelector(sel);
      if (!root) return "";
      const out: string[] = [];
      const walker = doc.createTreeWalker(root, 4 /* SHOW_TEXT */);
      for (let n = walker.nextNode(); n; n = walker.nextNode()) { const t = (n.nodeValue ?? "").replace(/\s+/g, " ").trim(); if (t) out.push(t); }
      return out.join(" ");
    },
    modal: () => (doc.getElementById("modalRoot")?.textContent ?? "").replace(/\s+/g, " ").trim(),
    settle,
    setAuth(next: AuthState) { auth = next; },
    click: async (el: Element | null) => { if (!el) throw new Error("element not found"); (el as HTMLElement).click(); await settle(); },
    clickSel: async (sel: string) => { const el = doc.querySelector(sel); if (!el) throw new Error(`element not found: ${sel}`); (el as HTMLElement).click(); await settle(); },
    type: async (el: Element | null, value: string) => { if (!el) throw new Error("element not found"); const i = el as HTMLInputElement; i.value = value; i.dispatchEvent(new win.Event("input", { bubbles: true })); i.dispatchEvent(new win.Event("change", { bubbles: true })); },
    check: async (el: Element | null, on = true) => { if (!el) throw new Error("element not found"); const i = el as HTMLInputElement; i.checked = on; i.dispatchEvent(new win.Event("change", { bubbles: true })); },
    markup: () => doc.documentElement.outerHTML.replace(/<script[\s\S]*?<\/script>/g, ""),
    page: () => doc.documentElement.outerHTML,
    authed: () => calls.filter((c) => c.headers.Authorization),
    posts: () => calls.filter((c) => c.method !== "GET"),
    /** every request whose path starts with `prefix` */
    to: (prefix: string) => calls.filter((c) => c.url.startsWith(prefix)),
    /** runs, once each, the timers that were set (the poller, deferred repaints); returns how many ran */
    async runTimers() { const due = timers.splice(0, timers.length); for (const t of due) t.fn(); await settle(); return due.length; },
  };
  return api;
}
export type Page = Awaited<ReturnType<typeof loadPage>>;

// ---------------------------------------------------------------- a scripted contest server

export interface World {
  registration?: "OPEN" | "NOT_OPEN" | "CLOSED" | "NOT_SCHEDULED";
  /** whether the operator has chosen to show the contest on Home (default: yes) */
  listed?: boolean;
  phases?: Partial<Record<Key, "NOT_OPEN" | "OPEN" | "CLOSED">>;
  published?: Partial<Record<Key, boolean>>;
  /** the caller's own candidacy (as /mine answers it); a function so a test can change it after a registration */
  mine?: () => Json | null;
  /** what POST …/registration answers */
  registerReply?: (call: Call) => Reply | Promise<Reply>;
  ficha?: Record<string, Reply>;
  gallery?: Partial<Record<Key, Json[]>>;
  myCandidateId?: Partial<Record<Key, string | null>>;
  voteReply?: Reply | (() => Promise<Reply>);
  results?: Partial<Record<Key, Json>>;
  /** the e-mail the server reports (so the page shows a person) */
  extra?: (call: Call) => Reply | Promise<Reply> | undefined;
}

export const TEXTS = {
  requirements: { version: "halloween-2026-v1-requirements-draft", text: "Texto de los requisitos (borrador de prueba)." },
  whatsappDelivery: { version: "halloween-2026-v1-whatsapp-delivery-draft", text: "Texto de la autorización de envío (borrador de prueba)." },
  galleryConsent: { version: "halloween-2026-v3-gallery", text: "Texto del consentimiento de la foto (de prueba)." },
};
export const NAMES: Record<Key, { es: string; en: string; kind: "INDIVIDUAL" | "GROUP" }> = {
  MOST_ELABORATE: { es: "Más Elaborado", en: "Most Elaborate", kind: "INDIVIDUAL" },
  SEXIEST: { es: "Más Sexy", en: "Sexiest", kind: "INDIVIDUAL" },
  BEST_GROUP: { es: "Dúo o Grupo", en: "Duo or Group", kind: "GROUP" },
  FUNNIEST: { es: "Más Divertido", en: "Funniest", kind: "INDIVIDUAL" },
};

export function contestBody(w: World = {}): Json {
  const reg = w.registration ?? "OPEN";
  const phases = w.phases ?? {};
  const categories = KEYS.map((k) => {
    const phase = phases[k] ?? "NOT_OPEN";
    return {
      key: k, instanceId: INST[k], kind: NAMES[k].kind, name: { es: NAMES[k].es, en: NAMES[k].en }, prompt: { es: `Elegí: ${NAMES[k].es}.`, en: "Pick." },
      phase, published: w.published?.[k] === true, deadlineAt: VOTE_CLOSES, deadlineRemainingMs: phase === "OPEN" ? 30 * 60_000 : null, serverNow: "2026-11-01T05:30:00.000Z",
      registrationOpensAt: reg === "NOT_SCHEDULED" ? null : REG_OPENS, contestantCutoffAt: reg === "NOT_SCHEDULED" ? null : REG_CLOSES, votingOpensAt: VOTE_OPENS, votingClosesAt: VOTE_CLOSES,
      tentative: true, approvedCandidacies: 3,
    };
  });
  const anyOpen = categories.some((c) => c.phase === "OPEN");
  return {
    contestId: CONTEST, listed: w.listed ?? true, timeZone: "America/Tegucigalpa", serverNow: "2026-11-01T05:30:00.000Z", prizePromise: { es: "Habrá premios en cada categoría", en: "There will be prizes in every category" },
    phase: anyOpen ? "OPEN" : categories.every((c) => c.phase === "CLOSED") ? "CLOSED" : "NOT_OPEN",
    registration: { phase: reg, opensAt: reg === "NOT_SCHEDULED" ? null : REG_OPENS, closesAt: reg === "NOT_SCHEDULED" ? null : REG_CLOSES },
    texts: TEXTS, categories,
  };
}

export const galleryItem = (key: Key, n: number, over: Json = {}) => ({
  alias: String(1000 + n), candidateId: uuid(100 * (KEYS.indexOf(key) + 1) + n), mine: false, code: `HAL-${["22222", "33333", "44444", "55555", "66666", "77777"][n - 1] ?? "88888"}`, name: ["Frankenstein", "La Catrina", "Calabaza", "Gato Negro", "Vampiresa", "Momia"][n - 1] ?? `Disfraz ${n}`,
  thumbUrl: `${ROUNDS}/${INST[key]}/photos/${1000 + n}?v=thumb`, fullUrl: `${ROUNDS}/${INST[key]}/photos/${1000 + n}?v=full`, ...over,
});

export function contestServer(w: World = {}): Responder {
  return async (call) => {
    const u = call.url.replace(/^http:\/\/localhost/, "");
    const custom = w.extra ? await w.extra(call) : undefined;
    if (custom) return custom;
    if (u === `${CONTESTS}/${CONTEST}`) return { status: 200, json: contestBody(w) };
    if (u === `${CONTESTS}/${CONTEST}/mine`) { const m = w.mine ? w.mine() : null; return { status: 200, json: { candidacy: m } }; }
    const f = u.match(new RegExp(`^${CONTESTS}/${CONTEST}/candidacies/(.+)$`));
    if (f) return (w.ficha ?? {})[decodeURIComponent(f[1])] ?? { status: 404, json: { code: "ENTRY_NOT_FOUND" } };
    const r = u.match(new RegExp(`^${ROUNDS}/([0-9a-f-]{36})(/.*)?$`));
    if (r) {
      const key = KEYS.find((k) => INST[k] === r[1]);
      const rest = (r[2] ?? "").split("?")[0];
      if (!key) return { status: 404, json: { code: "INSTANCE_NOT_FOUND" } };
      if (rest === "/binding") return { status: 200, json: { bindingId: uuid(900), instanceId: r[1], created: false } };
      if (rest === "/status") return { status: 200, json: { bound: true, instanceId: r[1], myCandidateId: w.myCandidateId?.[key] ?? null, myEntry: null, interactionInstanceId: uuid(700 + KEYS.indexOf(key)) } };
      if (rest === "/gallery") return { status: 200, json: { phase: w.phases?.[key] ?? "NOT_OPEN", interactionInstanceId: uuid(700 + KEYS.indexOf(key)), items: w.gallery?.[key] ?? [] } };
      if (rest === "/intents") return { status: 201, json: { bindingId: uuid(900), intentNo: 5 } };
      if (rest === "/votes") { const v = w.voteReply ?? { status: 200, json: { outcome: "APPLIED", candidateId: call.body?.candidateId } }; return typeof v === "function" ? v() : v; }
      if (rest === "/results") return { status: 200, json: w.results?.[key] ?? { published: false, kind: null, items: [] } };
      if (rest === "/registration") return w.registerReply ? w.registerReply(call) : { status: 201, json: { candidacy: { entryId: uuid(555), categoryKey: key, publicCode: "HAL-K7M2Q", publicName: call.body?.publicName, kind: NAMES[key].kind, state: "REGISTERED", deliveryStatus: "PENDING", ficheUrl: `/community-voting-round.html?c=${CONTEST}&codigo=HAL-K7M2Q` } } };
    }
    return { status: 404, json: { code: "NOT_FOUND" } };
  };
}

export const myCandidacy = (over: Json = {}) => ({
  categoryKey: "MOST_ELABORATE", instanceId: INST.MOST_ELABORATE, role: "INDIVIDUAL", kind: "INDIVIDUAL", publicCode: "HAL-K7M2Q", publicName: "Drácula", state: "REGISTERED", deliveryStatus: "PENDING",
  categoryName: { es: NAMES.MOST_ELABORATE.es, en: NAMES.MOST_ELABORATE.en }, ficheUrl: `/community-voting-round.html?c=${CONTEST}&codigo=HAL-K7M2Q`, ...over,
});
