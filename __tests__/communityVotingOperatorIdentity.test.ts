import { readFileSync } from "node:fs";
import path from "node:path";

import { JSDOM } from "jsdom";
import { afterEach, describe, expect, it, vi } from "vitest";

/**
 * UG-IV-GATE-009 (finding F1 of GATE-008A) — the operator tablet and the destination's accepted identity contract.
 *
 * The page under test is the ACTUAL operator page; the shared sign-in client is the REAL public/urbanoAuth.js, evaluated in jsdom against a
 * fake Supabase browser client (the same five methods the real file calls) and a fake server. Nothing here touches a network or a provider;
 * the people are synthetic. The contract the page must follow is the destination's own: a first-time member finishing the profile is
 * announced ONLY to onIdentityChange listeners, and a change of person or a sign-out is announced synchronously, before anything is looked
 * up, to onIdentityReset listeners (onAuthStateChange keeps its original meaning: raw Auth events).
 *
 * What is pinned: completing the profile updates the page without a reload; a sign-out and a change of person remove the previous
 * person's operator content and authority (the round and its host token) at once; repeated notifications neither duplicate handlers nor
 * requests; an answer that arrives after the person changed can restore nothing; and an obsolete error message goes away when the
 * operation it was about succeeds.
 */

vi.setConfig({ testTimeout: 60_000 });

const ROOT = process.cwd();
const read = (f: string) => readFileSync(path.join(ROOT, "public", f), "utf8");
const OPERATOR_HTML = read("community-voting-round-operator.html");
const AUTH_SOURCE = read("urbanoAuth.js");
const LOGIC_SOURCE = read("communityVotingRoundOperator.js");

const INSTANCE = "11111111-2222-4333-8444-555555555555";
const PREFIX = `/api/gaming/community-voting/rounds/${INSTANCE}`;
type Who = "A" | "B";
const PEOPLE: Record<Who, { id: string; email: string; token: string; memberId: string; name: string }> = {
  A: { id: "uid-A", email: "a@example.invalid", token: "token-A", memberId: "gm-A", name: "Operadora A" },
  B: { id: "uid-B", email: "b@example.invalid", token: "token-B", memberId: "gm-B", name: "Operador B" },
};
const HOST_TOKEN = "host-token-of-A";

const OVERVIEW = {
  roundRole: "PRELIMINARY", sessionState: "LOBBY_LOCKED", interactionState: null, opened: false, closed: false, published: false, serverNow: "2026-10-31T21:00:00.000Z",
  windowSeconds: null, deadlineAt: null, schedule: { registrationOpensAt: null, contestantCutoffAt: null, votingOpensAt: null, votingClosesAt: "2026-10-31T22:00:00.000Z", status: "TENTATIVE" },
  counters: { boundVoters: 0, votes: 0, entries: 0, withdrawn: 0 }, finalistsSelected: false,
  policies: [
    { key: "ZERO_VALID_VOTES_PRELIMINARY", approved: false, value: null, approvalReference: null },
    { key: "ZERO_VOTE_ENTRIES_AT_CUTOFF", approved: false, value: null, approvalReference: null },
    { key: "FINALIST_WITHDRAWAL_AFTER_SELECTION", approved: false, value: null, approvalReference: null },
  ], pendingResolutions: [], review: null, tasks: [], publishedAffected: [], entries: [],
};

interface Deferred { promise: Promise<void>; release: () => void }
const deferred = (): Deferred => { let release!: () => void; const promise = new Promise<void>((r) => { release = r; }); return { promise, release }; };
const tick = async (n = 12) => { for (let i = 0; i < n; i += 1) await new Promise((r) => setTimeout(r, 0)); };

const closers: Array<() => void> = [];
afterEach(() => { while (closers.length) closers.pop()!(); });

interface Req { url: string; method: string; bearer: string; host: string; body: any }
interface Options {
  /** who is signed in when the page loads (null = nobody) */
  initial?: Who | null;
  /** who already has a Gaming Member (a person without one is a first-time member) */
  members?: Partial<Record<Who, boolean>>;
  /** what the tab's sessionStorage holds when the page loads */
  stored?: Record<string, unknown>;
  /** hold the FIRST overview answer from before the page starts (it asks for it while it loads) */
  holdFirstOverview?: boolean;
  /** answers of the registration route, in order (default: 201) */
  registerReplies?: Array<{ status: number; json: unknown }>;
}

async function createStack(options: Options = {}) {
  const members: Record<Who, { gamingMemberId: string; displayName: string; createdAt: string } | null> = {
    A: options.members?.A === false ? null : { gamingMemberId: PEOPLE.A.memberId, displayName: PEOPLE.A.name, createdAt: "2026-02-01T00:00:00.000Z" },
    B: options.members?.B === false ? null : { gamingMemberId: PEOPLE.B.memberId, displayName: PEOPLE.B.name, createdAt: "2026-03-01T00:00:00.000Z" },
  };
  const sessionOf = (who: Who) => ({ access_token: PEOPLE[who].token, user: { id: PEOPLE[who].id, email: PEOPLE[who].email, email_confirmed_at: "2026-01-01T00:00:00Z" } });
  const state = { session: (options.initial ? sessionOf(options.initial) : null) as null | ReturnType<typeof sessionOf>, listeners: [] as Array<(e: string, s: unknown) => void>, requests: [] as Req[] };
  const holds: Deferred[] = [];
  const firstHold = options.holdFirstOverview ? deferred() : null;
  if (firstHold) holds.push(firstHold);
  const registerReplies = [...(options.registerReplies ?? [])];

  const client = {
    auth: {
      onAuthStateChange(cb: (e: string, s: unknown) => void) { state.listeners.push(cb); return { data: { subscription: { unsubscribe() {} } } }; },
      async getSession() { return { data: { session: state.session } }; },
      async signOut() { emit(null, "SIGNED_OUT"); return { error: null }; },
      async signInWithOtp() { return { data: {}, error: null }; },
      async verifyOtp() { return { data: { session: state.session, user: state.session?.user }, error: null }; },
    },
  };
  /** Delivers an Auth event, synchronously, exactly as the Supabase client does. */
  function emit(who: Who | null, event = who ? "SIGNED_IN" : "SIGNED_OUT") {
    state.session = who ? sessionOf(who) : null;
    state.listeners.slice().forEach((l) => l(event, state.session));
  }

  const whoOf = (bearer: string): Who | null => (bearer === PEOPLE.A.token ? "A" : bearer === PEOPLE.B.token ? "B" : null);
  const reply = (status: number, json: unknown) => ({ ok: status >= 200 && status < 300, status, json: async () => json, text: async () => JSON.stringify(json) });
  async function fetchFake(url: string, init: Record<string, any> = {}) {
    const target = String(url);
    const headers = (init.headers ?? {}) as Record<string, string>;
    const bearer = String(headers.Authorization ?? headers.authorization ?? "").replace("Bearer ", "");
    if (target === "/api/gaming/config") return reply(200, { supabaseUrl: "http://stack.local", supabaseAnonKey: "anon-key" });
    if (target === "/api/gaming/auth-methods") return reply(200, { email: true, phone: false });
    if (target === "/api/gaming/member") {
      const who = whoOf(bearer);
      if (!who) return reply(401, {});
      if (init.method === "POST") {
        const displayName = JSON.parse(init.body).displayName as string;
        members[who] = { gamingMemberId: PEOPLE[who].memberId, displayName, createdAt: "2026-10-01T00:00:00.000Z" };
        return reply(201, { gamingMember: members[who] });
      }
      return reply(200, { gamingMember: members[who] });
    }
    state.requests.push({ url: target, method: init.method ?? "GET", bearer, host: headers["x-host-token"] ?? "", body: init.body ? JSON.parse(init.body) : undefined });
    if (target === "/api/gaming/community-voting/rounds" && init.method === "POST") return registerReplies.length ? ((r) => reply(r.status, r.json))(registerReplies.shift()!) : reply(201, { instance: { instanceId: INSTANCE } });
    const route = target.replace(PREFIX, "").split("?")[0];
    if (route === "/operator/overview") {
      const gate = holds.shift();
      if (gate) await gate.promise;
      return reply(200, OVERVIEW);
    }
    if (route === "/info") return reply(200, { info: {}, texts: { galleryConsent: { version: "v", text: "t" }, promoConsent: { version: "v", text: "t" } } });
    if (route === "/operator/results") return reply(409, { code: "RESULTS_NOT_AVAILABLE" });
    return reply(200, {});
  }

  // The REAL shared client, with registrations counted (the wrapper only counts; it changes nothing).
  const counted = `${AUTH_SOURCE}
;(function () {
  window.__registered = { identityChange: 0, identityReset: 0, authStateChange: 0 };
  ["onIdentityChange", "onIdentityReset", "onAuthStateChange"].forEach(function (name) {
    var original = UrbanoAuth[name]; var key = name === "onIdentityChange" ? "identityChange" : name === "onIdentityReset" ? "identityReset" : "authStateChange";
    UrbanoAuth[name] = function () { window.__registered[key] += 1; return original.apply(UrbanoAuth, arguments); };
  });
})();`;
  const html = OPERATOR_HTML
    .replace('<script src="/urbanoAuth.js"></script>', () => `<script>${counted}</script>`)
    .replace('<script src="/communityVotingRoundOperator.js"></script>', () => `<script>${LOGIC_SOURCE}</script>`);

  const dom = new JSDOM(html, {
    url: "http://localhost/community-voting-round-operator.html",
    runScripts: "dangerously",
    pretendToBeVisual: true,
    beforeParse(window) {
      const w = window as unknown as Record<string, any>;
      Object.defineProperty(window.navigator, "language", { value: "es-HN", configurable: true });
      for (const [k, v] of Object.entries(options.stored ?? {})) window.sessionStorage.setItem(k, typeof v === "string" ? v : JSON.stringify(v));
      w.supabase = { createClient: () => client };
      w.fetch = fetchFake;
      w.setInterval = () => 0;
    },
  });
  closers.push(() => dom.window.close());
  const win = dom.window as unknown as Window & Record<string, any>;
  const doc = win.document;
  await tick(30);
  return {
    win, doc, state, emit, members, holds, firstHold,
    hold: () => { const d = deferred(); holds.push(d); return d; },
    $: (sel: string) => doc.querySelector(sel) as HTMLElement | null,
    text: () => doc.getElementById("app")?.textContent ?? "",
    stored: () => win.sessionStorage.getItem("cvop2:round"),
    allStorage: () => JSON.stringify(Object.fromEntries(Array.from({ length: win.sessionStorage.length }, (_, i) => [win.sessionStorage.key(i), win.sessionStorage.getItem(win.sessionStorage.key(i) as string)]))),
    registered: () => ({ ...(win.__registered as Record<string, number>) }),
    overviewRequests: () => state.requests.filter((r) => r.url.endsWith("/operator/overview")),
    auth: win.eval("UrbanoAuth") as Record<string, any>,
    click: async (el: Element | null) => { if (!el) throw new Error("element not found"); (el as HTMLElement).click(); await tick(); },
    type: async (el: Element | null, value: string) => { const i = el as HTMLInputElement; i.value = value; i.dispatchEvent(new win.Event("input", { bubbles: true })); },
  };
}

/** What the tab remembers once A has connected to a round (the current page format stores who the round belongs to). */
const STORED_FOR_A = { "cvop2:round": { instanceId: INSTANCE, hostToken: HOST_TOKEN, ownerUserId: PEOPLE.A.id } };
const roundOnScreen = (s: { $: (q: string) => HTMLElement | null }) => !!(s.$("#roundHeader") || s.$("#checklist"));

describe("completing the profile (a first-time operator)", () => {
  it("updates the page without a reload: the notice asking for a profile is replaced by the connect and register cards", async () => {
    const s = await createStack({ initial: "A", members: { A: false } });
    expect(s.$("#needSignIn")?.textContent).toMatch(/Completa tu perfil/);
    expect(s.$("#connectCard")).toBeNull();

    const done = await s.auth.completeProfile("Operadora A"); // exactly what the shared sign-in dialog calls
    expect(done.status).toBe("authenticated");
    await tick();

    expect(s.$("#needSignIn")).toBeNull();
    expect(s.text()).not.toMatch(/Completa tu perfil/);
    expect(s.$("#connectCard")).toBeTruthy();
    expect(s.$("#registerCard")).toBeTruthy();
  });
});

describe("signing out", () => {
  it("removes the operator content, the round and the host token at once — before any lookup could answer", async () => {
    const s = await createStack({ initial: "A", stored: STORED_FOR_A });
    expect(roundOnScreen(s)).toBe(true);
    expect(s.overviewRequests()).toHaveLength(1);

    s.emit(null); // the SIGNED_OUT event, delivered synchronously; no await before the checks
    expect(roundOnScreen(s)).toBe(false);
    expect(s.text()).not.toMatch(/Pasos de la ronda|Participantes|Políticas/);
    expect(s.allStorage()).not.toContain(HOST_TOKEN);
    expect(s.text()).toMatch(/Inicia sesión/);
  });
});

describe("switching to another person", () => {
  it("shows nothing of the previous person's round and sends nothing for it with the new person's token", async () => {
    const s = await createStack({ initial: "A", stored: STORED_FOR_A });
    expect(roundOnScreen(s)).toBe(true);

    s.emit("B"); // B signs in on the same tab
    expect(roundOnScreen(s)).toBe(false); // synchronously: the reset ran before B was even looked up
    await tick(30);

    expect(s.$("#connectCard")).toBeTruthy(); // B is offered the connect and register cards, not A's round
    expect(roundOnScreen(s)).toBe(false);
    expect(s.allStorage()).not.toContain(HOST_TOKEN);
    expect(s.state.requests.filter((r) => r.bearer === PEOPLE.B.token)).toEqual([]); // B's token never travelled to A's round
    expect(s.state.requests.filter((r) => r.host === HOST_TOKEN && r.bearer !== PEOPLE.A.token)).toEqual([]);
  });

  it("does not inherit a round that a previous person left in the tab's storage", async () => {
    const s = await createStack({ initial: "B", stored: STORED_FOR_A });
    expect(roundOnScreen(s)).toBe(false);
    expect(s.$("#connectCard")).toBeTruthy();
    expect(s.overviewRequests()).toHaveLength(0);
    expect(s.allStorage()).not.toContain(HOST_TOKEN);
  });

  it("keeps the round of the SAME person across a reload", async () => {
    const s = await createStack({ initial: "A", stored: STORED_FOR_A });
    expect(roundOnScreen(s)).toBe(true);
    expect(s.overviewRequests()).toHaveLength(1);
  });
});

describe("repeated notifications", () => {
  it("register one handler of each kind, and neither duplicate the page's requests nor rebuild it", async () => {
    const s = await createStack({ initial: "A", stored: STORED_FOR_A });
    const atBoot = s.registered(); // the shared sign-in component registers its own reset handler too, so the page's share is what is counted below
    expect(atBoot.identityChange).toBe(1);
    expect(OPERATOR_HTML).not.toMatch(/onAuthStateChange/); // the page itself no longer relies on the raw Auth events (the shared component keeps its own registration)
    const before = s.overviewRequests().length;
    expect(before).toBe(1);

    for (let i = 0; i < 4; i += 1) s.emit("A", "SIGNED_IN"); // the same person, repeated events
    for (let i = 0; i < 3; i += 1) s.emit("A", "TOKEN_REFRESHED");
    await tick(30);
    s.emit("B"); // and a full change of person and back, which must not register anything new either
    await tick(10);
    s.emit("A");
    await tick(30);

    expect(s.registered()).toEqual(atBoot); // handlers are registered once, whatever happens afterwards
    expect(s.overviewRequests()).toHaveLength(before); // the same-person events asked for nothing; A's round was dropped on the change to B and is not asked for again
  });
});

describe("an answer that arrives after the person changed", () => {
  it("restores nothing: A's round does not appear for B, and nothing of it is stored again", async () => {
    // A's page load asks for the overview; that answer is held while B signs in
    const s = await createStack({ initial: "A", stored: STORED_FOR_A, holdFirstOverview: true });
    expect(s.overviewRequests()).toHaveLength(1);
    expect(roundOnScreen(s)).toBe(false); // nothing answered yet
    s.emit("B");
    await tick(30);
    s.firstHold!.release(); // A's answer arrives late
    await tick(40);
    expect(roundOnScreen(s)).toBe(false);
    expect(s.$("#connectCard")).toBeTruthy();
    expect(s.allStorage()).not.toContain(HOST_TOKEN);
    expect(s.state.requests.filter((r) => r.bearer === PEOPLE.B.token)).toEqual([]);
  });
});

describe("obsolete messages", () => {
  it("a failed registration's error disappears when the next attempt succeeds", async () => {
    const s = await createStack({
      initial: "A",
      registerReplies: [{ status: 403, json: { code: "NOT_AN_OPERATOR", error: "no" } }, { status: 201, json: { instance: { instanceId: INSTANCE } } }],
    });
    await s.type(s.$("#reg-sessionId"), "22222222-2222-4333-8444-555555555555");
    await s.type(s.$("#reg-hostToken"), "a-host-token");
    await s.click(s.$("#register"));
    expect(s.doc.querySelector(".msg.err")).toBeTruthy();

    await s.click(s.$("#register"));
    await tick(20);
    expect(s.doc.querySelector(".msg.err")).toBeNull();
    expect(s.text()).toMatch(/Ronda registrada/);
  });

  it("a notice about one round is gone once the operator moves to another", async () => {
    const s = await createStack({ initial: "A" });
    await s.type(s.$("#reg-sessionId"), "22222222-2222-4333-8444-555555555555");
    await s.type(s.$("#reg-hostToken"), "a-host-token");
    await s.click(s.$("#register"));
    await tick(20);
    expect(s.text()).toMatch(/Ronda registrada/);
    await s.click(s.$("#disconnect"));
    await tick(10);
    expect(s.text()).not.toMatch(/Ronda registrada/);
  });
});
