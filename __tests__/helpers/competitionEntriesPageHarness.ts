import { JSDOM, VirtualConsole } from "jsdom";
import { readFileSync } from "node:fs";
import path from "node:path";

/**
 * UG-CR-GATE-CFM-016 — test harness for the invite-only pilot's team-entry surfaces: the SHIPPED /competitions.html (a member's team invitations, teams, entry and roster
 * proposal) and /competitions-admin.html (the organizer's team-entries section), parsed and run whole in jsdom with the shipped public/competitionsEntries.js.
 *
 * Everything here is a DOUBLE of the server and of authentication. The evidence it gives is about what the shipped browser code does with the answers it is given — which
 * controls it builds, what it sends, what it says, what it forgets when the session changes — never that the real backend gives those answers. The real backend is exercised
 * separately, in a real browser against the real local routes and a disposable loopback database.
 *
 * Like the harness of the plan-amendment surfaces it records how every request was made (the bearer token the page attached, the cache mode, whether an abort signal was
 * attached and whether it fired), honors an abort signal like a real fetch, and lets a test answer a request later or never. It adds what a session change needs: the token
 * the page attaches belongs to the CURRENT session, and `switchSession` changes both the session and the token and then fires the page's authentication callbacks exactly as
 * the real authentication seam does on a sign-in, a sign-out or a refresh.
 */

const ROOT = process.cwd();
const ADMIN_HTML = readFileSync(path.join(ROOT, "public/competitions-admin.html"), "utf8");
const MEMBER_HTML = readFileSync(path.join(ROOT, "public/competitions.html"), "utf8");
const LIFECYCLE_SOURCE = readFileSync(path.join(ROOT, "public/competitionsLifecycle.js"), "utf8");
const INTENT_SOURCE = readFileSync(path.join(ROOT, "public/competitionsIntent.js"), "utf8");
export const ENTRIES_SOURCE = readFileSync(path.join(ROOT, "public/competitionsEntries.js"), "utf8");
export { ADMIN_HTML, MEMBER_HTML };

export interface EntriesRequest {
  url: string;
  method: string;
  headers: Record<string, string>;
  body?: string;
  cache?: string;
  hasSignal: boolean;
  aborted: () => boolean;
  /** The JSON body the page sent, parsed (null when there was none). */
  json: () => any;
  /** The bearer token the page attached (null when none). */
  token: () => string | null;
}
export interface EntriesReply { status: number; json?: unknown }
/** A transport answers now, later (a promise), or never (a promise that does not settle). */
export type EntriesTransport = (request: EntriesRequest) => EntriesReply | Promise<EntriesReply>;

export interface Deferred<T> { promise: Promise<T>; resolve: (value: T) => void; reject: (reason?: unknown) => void }
export function defer<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}
export const never = (): Promise<never> => new Promise<never>(() => {});

export interface EntriesPage {
  win: Window & Record<string, any>;
  doc: Document;
  requests: EntriesRequest[];
  settle(predicate: () => boolean, label?: string): Promise<void>;
  idle(ms?: number): Promise<void>;
  controls(): string[];
  text(): string;
  visible(el: Element | null): boolean;
  $(selector: string): any;
  $$(selector: string): any[];
  setValue(el: any, value: string): void;
  click(el: any): void;
  run(code: string): unknown;
  /** Changes the session AND the token the page will attach, then fires every authentication callback the page registered (a sign-in, a sign-out or a refresh). */
  switchSession(auth: unknown, token?: string): Promise<void>;
  /** Changes the session and the token WITHOUT firing any callback: the moment between a session change and the event that announces it. */
  changeSessionSilently(auth: unknown, token?: string): void;
  /** Changes the session and fires the callbacks, returning at once with what they are still doing — so a test can read the document in the very turn the event fired. */
  startSessionChange(auth: unknown, token?: string): Promise<void>;
  close(): void;
}

interface OpenOptions {
  auth: unknown;
  token?: string;
  transport: EntriesTransport;
  search?: string;
  /** Load the shipped public/competitionsEntries.js (default true). False is a page whose script did not load. */
  script?: boolean;
}

function open(html: string, pathname: string, opts: OpenOptions, extraScripts: string[]): EntriesPage {
  const requests: EntriesRequest[] = [];
  const authCallbacks: Array<() => unknown> = [];
  let auth = opts.auth;
  let token = opts.token ?? "token-1";
  // Set CE_DEBUG=1 to see what the page itself logs (errors in its scripts) while a test runs.
  const virtualConsole = new VirtualConsole();
  if (process.env.CE_DEBUG) {
    for (const name of ["log", "warn", "error"] as const) virtualConsole.on(name, (...args: unknown[]) => console.log(`[page ${name}]`, ...args));
    virtualConsole.on("jsdomError", (error: Error) => console.log("[page jsdomError]", error.stack ?? error.message));
  }
  const dom = new JSDOM(html, {
    virtualConsole,
    url: `http://localhost${pathname}${opts.search ?? ""}`,
    runScripts: "dangerously",
    pretendToBeVisual: true,
    beforeParse(window) {
      const w = window as unknown as Record<string, any>;
      w.UrbanoAuth = {
        attachSignInButton: () => {},
        getState: async () => auth,
        getAccessToken: async () => token,
        onAuthStateChange: async (callback: () => unknown) => { authCallbacks.push(callback); return () => {}; },
      };
      w.fetch = (url: string, init: any = {}) => {
        const signal: AbortSignal | undefined = init.signal;
        const headers: Record<string, string> = init.headers ?? {};
        const record: EntriesRequest = {
          url: String(url), method: init.method ?? "GET", headers, body: init.body, cache: init.cache,
          hasSignal: !!signal, aborted: () => !!signal && signal.aborted,
          json: () => (init.body === undefined ? null : JSON.parse(init.body)),
          token: () => { const header = headers.authorization ?? headers.Authorization; return typeof header === "string" ? header.replace(/^Bearer /, "") : null; },
        };
        requests.push(record);
        return new Promise((resolve, reject) => {
          if (signal) signal.addEventListener("abort", () => reject(Object.assign(new Error("The operation was aborted."), { name: "AbortError" })));
          Promise.resolve(opts.transport(record)).then((out) => {
            if (signal && signal.aborted) return;
            resolve({ status: out.status, json: async () => { if (out.json === undefined) throw new Error("no body"); return out.json; } });
          }, reject);
        });
      };
      for (const source of extraScripts) window.eval(source);
      if (opts.script !== false) window.eval(ENTRIES_SOURCE);
    },
  });
  const win = dom.window as unknown as Window & Record<string, any>;
  const doc = win.document;

  const visible = (el: Element | null): boolean => {
    if (!el) return false;
    for (let node: Element | null = el; node; node = node.parentElement) {
      const e = node as HTMLElement;
      if (e.hidden) return false;
      if (e.style && (e.style.display === "none" || e.style.visibility === "hidden")) return false;
    }
    return true;
  };
  const describe = (el: Element): string => {
    const tag = el.tagName.toLowerCase();
    if (el.id) return `${tag}#${el.id}`;
    const label = (el.textContent ?? "").trim().replace(/\s+/g, " ") || el.getAttribute("placeholder") || el.getAttribute("aria-label") || el.getAttribute("class") || "";
    return `${tag}[${label}]`;
  };
  const fire = async () => { for (const callback of authCallbacks) await callback(); };

  return {
    win, doc, requests, visible,
    async settle(predicate, label = "condition") {
      for (let i = 0; i < 600; i++) {
        if (predicate()) return;
        await new Promise((r) => setTimeout(r, 5));
      }
      throw new Error(`timed out waiting for ${label}`);
    },
    idle: (ms = 40) => new Promise((r) => setTimeout(r, ms)),
    controls() {
      const found = Array.from(doc.querySelectorAll("button, a[href], input:not([type=hidden]), select, textarea, summary"));
      return found.filter((el) => !el.closest(".back-link") && el.id !== "btn-signin" && visible(el)).map(describe);
    },
    text: () => {
      const clone = doc.body.cloneNode(true) as HTMLElement;
      clone.querySelectorAll("script, style").forEach((n) => n.remove());
      return clone.textContent ?? "";
    },
    $: (selector) => doc.querySelector(selector),
    $$: (selector) => Array.from(doc.querySelectorAll(selector)),
    setValue(el, value) {
      el.value = value;
      el.dispatchEvent(new win.Event("input", { bubbles: true }));
      el.dispatchEvent(new win.Event("change", { bubbles: true }));
    },
    click: (el) => el.click(),
    run: (code) => win.eval(code),
    async switchSession(next, nextToken) { auth = next; if (nextToken !== undefined) token = nextToken; await fire(); },
    changeSessionSilently(next, nextToken) { auth = next; if (nextToken !== undefined) token = nextToken; },
    startSessionChange(next, nextToken) {
      auth = next; if (nextToken !== undefined) token = nextToken;
      const pending = authCallbacks.map((callback) => callback());
      return Promise.all(pending).then(() => undefined);
    },
    close: () => win.close(),
  };
}

/** The member competition page, /competitions.html, with the shipped team-entries script. */
export function openMemberPage(opts: OpenOptions): EntriesPage {
  return open(MEMBER_HTML, "/competitions.html", opts, [INTENT_SOURCE]);
}

/** The organizer page, /competitions-admin.html, with the shipped team-entries script. */
export function openAdminPage(opts: OpenOptions): EntriesPage {
  return open(ADMIN_HTML, "/competitions-admin.html", opts, [LIFECYCLE_SOURCE]);
}

// ---------------------------------------------------------------------------------------------------------------------------------------------
// Server-shaped fixtures (the exact shapes the accepted routes return)
// ---------------------------------------------------------------------------------------------------------------------------------------------

export const API = "/api/gaming/competitions";
export const CID = "11111111-1111-4111-8111-111111111111";
export const OTHER_CID = "22222222-2222-4222-8222-222222222222";
export const CODE = "AbCdEfGhIjKlMnOpQrStUv";

export const PAT = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
export const SAM = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
export const LEE = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
export const ORG = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";

export const TEAM_A = "a1a1a1a1-a1a1-4a1a-8a1a-a1a1a1a1a1a1";
export const TEAM_B = "b2b2b2b2-b2b2-4b2b-8b2b-b2b2b2b2b2b2";
export const ENTRY_A = "e1e1e1e1-e1e1-4e1e-8e1e-e1e1e1e1e1e1";
export const ENTRY_B = "e2e2e2e2-e2e2-4e2e-8e2e-e2e2e2e2e2e2";
export const CLAIM_1 = "c1c1c1c1-c1c1-4c1c-8c1c-c1c1c1c1c1c1";
export const CLAIM_2 = "c2c2c2c2-c2c2-4c2c-8c2c-c2c2c2c2c2c2";
export const OFFER_1 = "f1f1f1f1-f1f1-4f1f-8f1f-f1f1f1f1f1f1";
export const OFFER_2 = "f2f2f2f2-f2f2-4f2f-8f2f-f2f2f2f2f2f2";

/** CFM-016A: a team code exactly as a join link carries it (22 characters). */
export const JOIN_CODE = "JoinCodeForTeamAaaaaaa";

export const HOSTILE = '<img src=x onerror="window.__xss=(window.__xss||0)+1">';
export const HOSTILE_BREAKOUT = '"><script>window.__xss=(window.__xss||0)+1</script>';

export const signedIn = (gamingMemberId: string, displayName = "Pat") => ({ status: "authenticated", email: "someone@example.com", gamingMemberId, displayName });
export const SIGNED_OUT = { status: "unauthenticated" };

export const team = (over: Record<string, unknown> = {}) => ({
  lifetimeTeamId: TEAM_A, publicCode: "TEAMCODE_A_aaaaaaaaaaaa", name: "Los Halcones", status: "ACTIVE", joinedAt: "2026-11-20T10:00:00+00:00", isLegacy: false, role: "CAPTAIN", ...over,
});
export const offer = (over: Record<string, unknown> = {}) => ({
  kind: "MEMBERSHIP", offerId: OFFER_1, direction: "INCOMING", team: { lifetimeTeamId: TEAM_A, publicCode: "TEAMCODE_A_aaaaaaaaaaaa", name: "Los Halcones" },
  counterparty: { gamingMemberId: SAM, displayName: "Sam" }, expiresAt: "2026-12-01T10:00:00+00:00", ...over,
});
export const ledClaim = (over: Record<string, unknown> = {}) => ({ claimId: CLAIM_1, gamingMemberId: LEE, displayName: "Lee", status: "PROPOSED", expiresAt: "2026-12-01T10:00:00+00:00", ...over });
export const ledEntry = (over: Record<string, unknown> = {}) => ({
  competitionTeamId: ENTRY_A, competitionId: CID, lifetimeTeamId: TEAM_A, publicCode: "ENTRYCODE_A_aaaaaaaaaaa", name: "Los Halcones", status: "PENDING_ORGANIZER_APPROVAL",
  createdAt: "2026-11-24T10:00:00+00:00", claims: [], ...over,
});
export const ownClaim = (over: Record<string, unknown> = {}) => ({
  claimId: CLAIM_1, competitionId: CID, status: "PROPOSED", expiresAt: "2026-12-01T10:00:00+00:00", team: { lifetimeTeamId: TEAM_A, publicCode: "TEAMCODE_A_aaaaaaaaaaaa", name: "Los Halcones" }, ...over,
});
export const organizerEntry = (over: Record<string, unknown> = {}) => ({
  competitionTeamId: ENTRY_A, publicCode: "ENTRYCODE_A_aaaaaaaaaaa", name: "Los Halcones", status: "PENDING_ORGANIZER_APPROVAL", createdAt: "2026-11-24T10:00:00+00:00",
  acceptedPlayers: 0, proposedPlayers: 0, ...over,
});

export const REGISTRATION_OPEN = {
  deadlineUtc: "2026-12-05T00:00:00.000Z", timeZone: "America/Costa_Rica", deadlineLocal: "2026-12-04T18:00", deadlinePassed: false, acceptingNewWrites: true, frozen: false,
};

/** An addressed-competition view as GET /api/gaming/competitions/[id] returns it, for a plain registered (or unregistered) member. */
export function competitionView(options: { state?: string; registered?: boolean; name?: string; organizer?: boolean; v1Teams?: boolean; extra?: Record<string, unknown> } = {}) {
  const registered = options.registered ?? true;
  return {
    view: {
      competition: { competitionId: CID, publicCode: CODE, activityKey: "SOCCER_5V5", name: options.name ?? "Pilot Cup", organizerGamingMemberId: ORG, state: options.state ?? "TEAM_REGISTRATION_OPEN", cancelledReason: null, createdAt: "x", publishedAt: null },
      teams: options.v1Teams ? [{ competitionTeamId: "t1", name: "Legacy FC", captainDisplayName: "Cap", publicCode: "t1-code", captainGamingMemberId: ORG }] : [],
      pendingTeamProposals: [], rejectedTeamProposals: [], myTeamProposals: [], fixtures: [],
      myRegistration: registered ? { registeredAt: "2026-11-24T10:00:00+00:00" } : null, myTeamMembership: null, myTeamMemberships: [], myPendingJoinRequest: null, myPersistentRecords: [],
      isOrganizer: !!options.organizer, registration: REGISTRATION_OPEN, ...(options.extra ?? {}),
    },
  };
}

// ---------------------------------------------------------------------------------------------------------------------------------------------
// A small stateful server double for the lifetime routes
// ---------------------------------------------------------------------------------------------------------------------------------------------

export interface World {
  /** The four member reads (and the organizer read) answer from these lists unless `read` overrides one of them. */
  offers: unknown[]; teams: unknown[]; ledEntries: unknown[]; claims: unknown[]; organizerEntries: unknown[];
  /** CFM-016A: the team a join link names (null: the link is not valid) and the people the roster picker is offered. */
  joinTeam: unknown; candidates: unknown[];
  /** Replaces the answer of one read: "offers" | "teams" | "ledEntries" | "claims" | "organizerEntries" | "join" | "candidates". */
  read: Record<string, EntriesReply | (() => EntriesReply | Promise<EntriesReply>)>;
  /** Replaces the answer of one write, by its key (see `writeKey`). When the key is absent the write succeeds with the exact shape the route returns. */
  write: Record<string, (request: EntriesRequest) => EntriesReply | Promise<EntriesReply>>;
  /** Runs after a successful canned write (so a test can change what the next read answers). */
  after: Record<string, (request: EntriesRequest) => void>;
  /** Everything outside the lifetime routes (the competitions list, the addressed view, resolve, the administrative source …). */
  base: EntriesTransport;
}

export function newWorld(base: EntriesTransport = () => ({ status: 404, json: { error: "unexpected request" } })): World {
  return { offers: [], teams: [], ledEntries: [], claims: [], organizerEntries: [], joinTeam: { lifetimeTeamId: TEAM_A, name: "Los Halcones" }, candidates: [], read: {}, write: {}, after: {}, base };
}

const path1 = (url: string) => url.replace(/\?.*$/, "");

/** The key a write is known by in `World.write` / `World.after`. */
export function writeKey(request: EntriesRequest): string | null {
  const url = path1(request.url);
  if (request.method !== "POST") return null;
  let m: RegExpExecArray | null;
  if (url === `${API}/lifetime-teams`) return "create-team";
  if ((m = /^\/api\/gaming\/competitions\/lifetime-teams\/[^/]+\/memberships$/.exec(url))) return "ask-to-join";
  if ((m = /^\/api\/gaming\/competitions\/[^/]+\/lifetime-entries\/[^/]+\/roster-claims$/.exec(url))) return "propose";
  if ((m = /^\/api\/gaming\/competitions\/lifetime-memberships\/[^/]+\/decision$/.exec(url))) return "decide-offer";
  if ((m = /^\/api\/gaming\/competitions\/lifetime-offers\/[^/]+\/withdraw$/.exec(url))) return "withdraw-offer";
  if ((m = /^\/api\/gaming\/competitions\/[^/]+\/lifetime-entries$/.exec(url))) return "enter";
  if ((m = /^\/api\/gaming\/competitions\/[^/]+\/lifetime-entries\/freeze$/.exec(url))) return "freeze";
  if ((m = /^\/api\/gaming\/competitions\/[^/]+\/lifetime-entries\/[^/]+\/withdraw$/.exec(url))) return "withdraw-entry";
  if ((m = /^\/api\/gaming\/competitions\/[^/]+\/lifetime-entries\/[^/]+\/decision$/.exec(url))) return "decide-entry";
  if ((m = /^\/api\/gaming\/competitions\/[^/]+\/lifetime-roster-claims\/[^/]+\/decision$/.exec(url))) return "decide-claim";
  if ((m = /^\/api\/gaming\/competitions\/[^/]+\/lifetime-roster-claims\/[^/]+\/release$/.exec(url))) return "release-claim";
  if ((m = /^\/api\/gaming\/competitions\/[^/]+\/lifetime-entry-flow\/enable$/.exec(url))) return "enable";
  if ((m = /^\/api\/gaming\/competitions\/[^/]+\/lifetime-entry-flow\/disable$/.exec(url))) return "disable";
  void m;
  return null;
}

/** The exact success body each write route returns. */
function canned(key: string, request: EntriesRequest): EntriesReply {
  switch (key) {
    case "create-team": return { status: 201, json: { team: { lifetimeTeamId: TEAM_B, publicCode: "TEAMCODE_B_bbbbbbbbbbbb", createdAt: "2026-11-24T11:00:00+00:00" } } };
    case "ask-to-join": return { status: 201, json: { membership: { lifetimeTeamMembershipId: OFFER_1, status: "PENDING", initiatedBySide: "PERSON", expiresAt: "2026-12-01T10:00:00+00:00" } } };
    case "propose": return { status: 201, json: { claims: request.json().gamingMemberIds.map((gamingMemberId: string) => ({ claimId: CLAIM_1, gamingMemberId, status: "PROPOSED", expiresAt: "2026-12-01T10:00:00+00:00" })) } };
    case "decide-offer": return { status: 200, json: { membership: { lifetimeTeamMembershipId: OFFER_1, status: request.json().decision === "ACCEPT" ? "ACTIVE" : "ENDED", joinedAt: null } } };
    case "withdraw-offer": return { status: 200, json: { offer: { offerId: OFFER_1, status: "WITHDRAWN" } } };
    case "enter": return { status: 201, json: { entry: { competitionTeamId: ENTRY_A, publicCode: "ENTRYCODE_A_aaaaaaaaaaa", createdAt: "2026-11-24T10:00:00+00:00" } } };
    case "withdraw-entry": return { status: 200, json: { entry: { competitionTeamId: ENTRY_A, status: "REJECTED", releasedClaims: 0 } } };
    case "decide-entry": return { status: 200, json: { entry: { competitionTeamId: ENTRY_A, status: "ACCEPTED", decision: request.json().decision, decidedAt: "2026-11-24T12:00:00+00:00", releasedClaims: 0 } } };
    case "decide-claim": return { status: 200, json: { claim: { claimId: CLAIM_1, status: request.json().decision === "ACCEPT" ? "ACCEPTED" : "REJECTED", acceptedAt: null } } };
    case "release-claim": return { status: 200, json: { claim: { claimId: CLAIM_1, status: "WITHDRAWN" } } };
    case "enable": return { status: 200, json: { flow: { competitionId: CID, enabledAt: "2026-11-24T09:00:00+00:00", alreadyEnabled: false } } };
    case "disable": return { status: 200, json: { flow: { competitionId: CID, disabledAt: "2026-11-24T09:30:00+00:00", alreadyDisabled: false } } };
    case "freeze": return { status: 200, json: { freeze: { competitionId: CID, frozenAt: "2026-12-05T00:01:00+00:00", entryCount: 2, claimCount: 10, alreadyFrozen: false } } };
    default: return { status: 500, json: { error: "unexpected write" } };
  }
}

/** A transport that answers the lifetime reads and writes from a World and everything else from `world.base`. */
export function transportOf(world: World): EntriesTransport {
  const reads: Array<[RegExp, string, () => unknown]> = [
    [/^\/api\/gaming\/competitions\/lifetime-offers$/, "offers", () => ({ offers: world.offers })],
    [/^\/api\/gaming\/competitions\/lifetime-teams$/, "teams", () => ({ teams: world.teams })],
    [/^\/api\/gaming\/competitions\/lifetime-entries$/, "ledEntries", () => ({ entries: world.ledEntries })],
    [/^\/api\/gaming\/competitions\/lifetime-roster-claims$/, "claims", () => ({ claims: world.claims })],
    [/^\/api\/gaming\/competitions\/[^/]+\/lifetime-entries$/, "organizerEntries", () => ({ entries: world.organizerEntries })],
  ];
  return (request) => {
    const url = path1(request.url);
    if (request.method === "GET") {
      if (/^\/api\/gaming\/competitions\/lifetime-teams\/by-code\/[^/]+$/.test(url)) {
        const override = world.read.join;
        if (override) return typeof override === "function" ? override() : override;
        return world.joinTeam === null ? { status: 404, json: { error: "This team link is not valid." } } : { status: 200, json: { team: world.joinTeam } };
      }
      if (/^\/api\/gaming\/competitions\/[^/]+\/lifetime-entries\/[^/]+\/roster-candidates$/.test(url)) {
        const override = world.read.candidates;
        if (override) return typeof override === "function" ? override() : override;
        return { status: 200, json: { members: world.candidates } };
      }
      for (const [pattern, name, body] of reads) {
        if (!pattern.test(url)) continue;
        const override = world.read[name];
        if (override) return typeof override === "function" ? override() : override;
        return { status: 200, json: body() };
      }
      return world.base(request);
    }
    const key = writeKey(request);
    if (key === null) return world.base(request);
    const custom = world.write[key];
    if (custom) return custom(request);
    const reply = canned(key, request);
    if (reply.status < 300 && world.after[key]) world.after[key](request);
    return reply;
  };
}

/** The base transport of a member page: the competitions list, the resolve read and the addressed view. */
export function memberBase(options: { view?: ReturnType<typeof competitionView>; list?: unknown[] } = {}): EntriesTransport {
  const view = options.view ?? competitionView();
  const list = options.list ?? [{ competitionId: CID, publicCode: CODE, name: view.view.competition.name, state: view.view.competition.state }];
  return (r) => {
    const url = path1(r.url);
    if (url === API && r.method === "GET") return { status: 200, json: { competitions: list } };
    if (url === `${API}/resolve`) return { status: 200, json: { competitionId: CID } };
    if (url === `${API}/${CID}` && r.method === "GET") return { status: 200, json: view };
    return { status: 404, json: { error: "unexpected request" } };
  };
}

/** The base transport of the organizer page: the administrative source and the addressed view (as the organizer sees it). */
export function adminBase(options: { view?: ReturnType<typeof competitionView>; state?: string; name?: string } = {}): EntriesTransport {
  const view = options.view ?? competitionView({ state: options.state, organizer: true });
  const entry = { competitionId: CID, name: options.name ?? view.view.competition.name, state: view.view.competition.state, access: "ORGANIZER" };
  return (r) => {
    const url = path1(r.url);
    if (url === `${API}/administration`) return { status: 200, json: { competitions: [entry], operations: { createCompetition: false } } };
    if (url === `${API}/${CID}` && r.method === "GET") return { status: 200, json: view };
    if (url === `${API}/${CID}/planning`) return { status: 404, json: { error: "unexpected request" } };
    return { status: 404, json: { error: "unexpected request" } };
  };
}
