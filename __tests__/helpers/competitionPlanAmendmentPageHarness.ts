import { JSDOM } from "jsdom";
import { readFileSync } from "node:fs";
import path from "node:path";

/**
 * UG-CR-GATE-SSS-014 — test harness for the post-freeze plan-amendment surfaces: the SHIPPED /competitions-admin.html (organizer) and /competitions.html
 * (addressed competition, captain), parsed and run whole in jsdom. Only the auth bridge and the network are supplied by the test, so a test can say, for
 * a given caller and a given set of server answers, exactly which controls a page shows.
 *
 * Everything here is a DOUBLE of the server (and of authentication): the evidence it gives is about what the page does with the answers it is given,
 * never about the real backend. The real backend is exercised separately, in a real browser against the real local routes.
 *
 * Unlike the older shared harness, this one records how each request was made (cache mode, whether an abort signal was attached and whether it fired),
 * honors the abort signal like a real fetch, lets a test answer a request later (or never), and can apply a page-level setting from inside the page.
 */

const ADMIN_HTML = readFileSync(path.join(process.cwd(), "public/competitions-admin.html"), "utf8");
const MEMBER_HTML = readFileSync(path.join(process.cwd(), "public/competitions.html"), "utf8");
const LIFECYCLE_SOURCE = readFileSync(path.join(process.cwd(), "public/competitionsLifecycle.js"), "utf8");
const INTENT_SOURCE = readFileSync(path.join(process.cwd(), "public/competitionsIntent.js"), "utf8");

export interface AmendRequest {
  url: string;
  method: string;
  headers: Record<string, string>;
  body?: string;
  cache?: string;
  hasSignal: boolean;
  aborted: () => boolean;
  /** The JSON body the page sent, parsed (null when there was none). */
  json: () => any;
}
export interface AmendReply { status: number; json?: unknown }
/** A transport answers now, later (a promise), or never (a promise that does not settle). */
export type AmendTransport = (request: AmendRequest) => AmendReply | Promise<AmendReply>;

export interface Deferred<T> { promise: Promise<T>; resolve: (value: T) => void; reject: (reason?: unknown) => void }
export function defer<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}
/** A request nobody ever answers: a silent network. */
export const never = (): Promise<never> => new Promise<never>(() => {});

export interface AmendPage {
  win: Window & Record<string, any>;
  doc: Document;
  requests: AmendRequest[];
  /** Waits for a condition, polling every few milliseconds, and fails loudly (with the label) when it does not come true. */
  settle(predicate: () => boolean, label?: string): Promise<void>;
  /** A short pause, for asserting that something does NOT happen. */
  idle(ms?: number): Promise<void>;
  /** Every actionable control currently visible, in document order, excluding the shared header chrome. */
  controls(): string[];
  /** The page's own words, as a reader sees them (scripts and styles excluded). */
  text(): string;
  visible(el: Element | null): boolean;
  $(selector: string): any;
  $$(selector: string): any[];
  /** Sets a form control's value the way typing does. */
  setValue(el: any, value: string): void;
  /** Clicks an element and waits for the page's own event loop to turn. */
  click(el: any): void;
  /** Runs a statement inside the page (for example to shorten a timeout the page declares with `let`). */
  run(code: string): unknown;
  fireAuthChange(): Promise<void>;
  setAuth(next: unknown): void;
  close(): void;
}

interface OpenOptions {
  auth: unknown;
  accessToken?: string;
  transport: AmendTransport;
  search?: string;
}

function open(html: string, pathname: string, opts: OpenOptions, extraScripts: string[]): AmendPage {
  const requests: AmendRequest[] = [];
  const authCallbacks: Array<() => unknown> = [];
  let auth = opts.auth;
  const dom = new JSDOM(html, {
    url: `http://localhost${pathname}${opts.search ?? ""}`,
    runScripts: "dangerously",
    pretendToBeVisual: true,
    beforeParse(window) {
      const w = window as unknown as Record<string, any>;
      w.UrbanoAuth = {
        attachSignInButton: () => {},
        getState: async () => auth,
        getAccessToken: async () => opts.accessToken ?? "stub-token",
        onAuthStateChange: async (callback: () => unknown) => { authCallbacks.push(callback); return () => {}; },
      };
      w.fetch = (url: string, init: any = {}) => {
        const signal: AbortSignal | undefined = init.signal;
        const record: AmendRequest = {
          url: String(url), method: init.method ?? "GET", headers: init.headers ?? {}, body: init.body, cache: init.cache,
          hasSignal: !!signal, aborted: () => !!signal && signal.aborted,
          json: () => (init.body === undefined ? null : JSON.parse(init.body)),
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
    // The page's own words: the text a reader sees, never the source of the scripts and styles that sit inside <body>.
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
    async fireAuthChange() { for (const callback of authCallbacks) await callback(); },
    setAuth(next) { auth = next; },
    close: () => win.close(),
  };
}

/** The organizer page, /competitions-admin.html. */
export function openAmendAdminPage(opts: OpenOptions): AmendPage {
  return open(ADMIN_HTML, "/competitions-admin.html", opts, [LIFECYCLE_SOURCE]);
}

/** The member competition page, /competitions.html (the addressed-competition surface). */
export function openAmendMemberPage(opts: OpenOptions): AmendPage {
  return open(MEMBER_HTML, "/competitions.html", opts, [INTENT_SOURCE]);
}

// ---------------------------------------------------------------------------------------------------------------------------------------------
// Server-shaped fixtures (the exact shapes the accepted routes return)
// ---------------------------------------------------------------------------------------------------------------------------------------------

export const CID = "11111111-1111-4111-8111-111111111111";
export const CODE = "AbCdEfGhIjKlMnOpQrStUv";
export const DIGEST_A = "a".repeat(64);
export const DIGEST_B = "b".repeat(64);
export const ADMIN_SOURCE = "/api/gaming/competitions/administration";
export const VIEW_URL = `/api/gaming/competitions/${CID}`;
export const PLANNING_URL = `/api/gaming/competitions/${CID}/planning`;
export const AMENDMENT_URL = `/api/gaming/competitions/${CID}/plan-amendment`;
export const DECISION_URL = `${AMENDMENT_URL}/decision`;
export const WITHDRAW_URL = `${AMENDMENT_URL}/withdraw`;

export interface Facts {
  venue: { name: string; locationDescription: string; restrictionNotes: string; simultaneousMatchCapacity: number };
  pitches: Array<{ label: string; usable: boolean; supportedFormats: string[]; restrictionNotes: string }>;
  dates: Array<{ date: string; windows: Array<{ start: string; end: string }> }>;
}

export const CURRENT_FACTS: Facts = {
  venue: { name: "Cancha Central", locationDescription: "Calle 5, San José", restrictionNotes: "No metal cleats.", simultaneousMatchCapacity: 2 },
  pitches: [
    { label: "A", usable: true, supportedFormats: ["SOCCER_5V5"], restrictionNotes: "" },
    { label: "B", usable: true, supportedFormats: ["SOCCER_5V5", "SOCCER_6V6"], restrictionNotes: "Lights off after 21:00." },
  ],
  dates: [{ date: "2026-11-07", windows: [{ start: "09:00", end: "13:00" }, { start: "15:00", end: "19:00" }] }],
};

export const PROPOSED_FACTS: Facts = {
  venue: { name: "Cancha Nueva", locationDescription: "Calle 9, Alajuela", restrictionNotes: "No metal cleats.", simultaneousMatchCapacity: 1 },
  pitches: [
    { label: "A", usable: true, supportedFormats: ["SOCCER_5V5"], restrictionNotes: "" },
    { label: "C", usable: false, supportedFormats: ["SOCCER_5V5"], restrictionNotes: "Under repair." },
  ],
  dates: [{ date: "2026-11-08", windows: [{ start: "10:00", end: "14:00" }] }],
};

export const TEAM_NAMES = ["Alpha FC", "Bravo United", "Charlie Town", "Delta Rovers"];

export const CONTEXT = {
  formatKey: "SOCCER_5V5", formatLabel: "Soccer 5v5", playersOnField: 5,
  roster: { defaultMinimum: 5, defaultMaximum: 8, minimumRange: { low: 5, high: 8 }, maximumRange: { low: 5, high: 10 }, absoluteMaximum: 10 },
  timing: { halves: 2, minutesPerHalf: 10, halftimeMinutes: 3, pitchTransitionMinutes: 10, minimumTeamRestMinutes: 30, knockoutShootoutReserveMinutes: 15 },
  limits: { maxDates: 3, maxSpanDays: 14, maxWindowsPerDate: 2, maxPitches: 16 },
};

/** The planning route's current revision, built from the facts (the preserved facts are fixed). */
export function planningBody(facts: Facts = CURRENT_FACTS) {
  return {
    context: CONTEXT,
    revision: {
      revisionNumber: 2, supersedesRevisionNumber: 1, createdAt: "2026-10-23T20:00:00.000Z", formatKey: "SOCCER_5V5",
      venue: { ...facts.venue, timeZone: "America/Costa_Rica" },
      pitches: facts.pitches, dates: facts.dates,
      roster: { minimum: 5, maximum: 8 },
      registrationDeadline: { local: "2026-11-01T18:00", timeZone: "America/Costa_Rica", utcOffset: "-06:00", utc: "2026-11-02T00:00:00.000Z" },
      rules: { version: "draft-1", snapshot: "Rules, version one.", snapshotDigest: "c".repeat(64) },
    },
  };
}

type Decision = "CONFIRMED" | "REJECTED" | null;
export interface ProposalOptions {
  digest?: string; sequenceNumber?: number; status?: string; actionable?: boolean; confirmed?: number; decisions?: Decision[]; myDecision?: Decision;
  expiresAt?: string; resolvedAt?: string | null; proposed?: Facts; current?: Facts;
}
export function proposal(o: ProposalOptions = {}) {
  const decisions = o.decisions ?? [null, null, null, null];
  const confirmed = o.confirmed ?? decisions.filter((d) => d === "CONFIRMED").length;
  return {
    digest: o.digest ?? DIGEST_A, sequenceNumber: o.sequenceNumber ?? 1, status: o.status ?? "PENDING", actionable: o.actionable ?? (o.status === undefined || o.status === "PENDING"),
    createdAt: "2026-10-23T12:00:00.000Z", expiresAt: o.expiresAt ?? "2026-10-24T12:00:00.000Z", resolvedAt: o.resolvedAt ?? null,
    confirmedCount: confirmed, requiredCount: 4,
    teams: TEAM_NAMES.map((teamName, i) => ({ teamName, decision: decisions[i] ?? null })),
    myDecision: o.myDecision ?? null,
    proposed: o.proposed ?? PROPOSED_FACTS, current: o.current ?? CURRENT_FACTS,
  };
}

export interface StatusOptions {
  organizer?: boolean; captain?: boolean; windowOpen?: boolean; myTeamName?: string | null; amendment?: ReturnType<typeof proposal> | null;
  history?: Array<{ sequenceNumber: number; status: string; createdAt: string; resolvedAt: string | null }> | null;
}
/** The GET plan-amendment route's body. */
export function statusBody(o: StatusOptions = {}) {
  const organizer = o.organizer ?? true;
  const captain = o.captain ?? false;
  return {
    amendment: {
      role: { organizer, captain }, windowOpen: o.windowOpen ?? true, myTeamName: o.myTeamName ?? (captain ? TEAM_NAMES[0] : null),
      amendment: o.amendment === undefined ? null : o.amendment,
      history: o.history === undefined ? (organizer ? [] : null) : o.history,
    },
  };
}

export const SIGNED_IN = { status: "authenticated", email: "pat@example.com", gamingMemberId: "m-1", displayName: "Pat" };

/** An addressed-competition view as GET /api/gaming/competitions/[id] returns it, carrying (or not) the one amendment signal. */
export function viewBody(options: { state?: string; signal?: unknown; name?: string; extra?: Record<string, unknown> } = {}) {
  const view: Record<string, unknown> = {
    competition: {
      competitionId: CID, publicCode: CODE, activityKey: "SOCCER_5V5", name: options.name ?? "Frozen Cup", organizerGamingMemberId: "m-1",
      state: options.state ?? "READY_TO_PUBLISH", cancelledReason: null, createdAt: "x", publishedAt: null,
    },
    teams: TEAM_NAMES.map((name, i) => ({ competitionTeamId: `t${i + 1}`, name, captainDisplayName: `Captain ${i + 1}`, publicCode: `t${i + 1}-code` })),
    pendingTeamProposals: [], rejectedTeamProposals: [], myTeamProposals: [], fixtures: [],
    myRegistration: null, myTeamMembership: null, myTeamMemberships: [], myPendingJoinRequest: null, myPersistentRecords: [], isOrganizer: true,
    ...(options.extra ?? {}),
  };
  if (options.signal !== undefined) view.planAmendment = options.signal;
  return { view };
}
