import { readFileSync } from "node:fs";
import path from "node:path";

import { JSDOM } from "jsdom";
import { describe, expect, it, vi } from "vitest";

/**
 * Two-round pilot — the ACTUAL shipped pages (voter, operator tablet, public display), parsed and run whole in jsdom with the real logic
 * modules, a stubbed identity seam, a stubbed location sensor and a scripted fake server. No network, no provider, no canvas.
 *
 * Real layout and touch behavior on a phone and a tablet are verified by a person in a real browser (see the implementation record);
 * jsdom has no layout engine. What these tests pin is behavior: which step a person sees, what is (and is not) sent to the server, when the
 * location sensor is touched, and that nothing is shown as accepted before the server says so.
 */

vi.setConfig({ testTimeout: 60_000 });

const ROOT = process.cwd();
const read = (f: string) => readFileSync(path.join(ROOT, "public", f), "utf8");
const FILES: Record<string, string> = {
  "communityVotingRound.js": read("communityVotingRound.js"),
  "communityVotingRoundOperator.js": read("communityVotingRoundOperator.js"),
  "communityVotingSlideshow.js": read("communityVotingSlideshow.js"),
  "urbanoAuth.js": "/* the identity seam is stubbed by the test */",
};
const INSTANCE = "11111111-2222-4333-8444-555555555555";
const PREFIX = `/api/gaming/community-voting/rounds/${INSTANCE}`;
const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;

/** jsdom does not load external scripts: inline the real files so their top-level bindings are global, exactly as /file.js would make them. */
function inlineScripts(html: string): string {
  return html.replace(/<script src="\/([^"]+)"><\/script>/g, (_m, name: string) => `<script>${FILES[name] ?? ""}</script>`);
}

interface Call { url: string; method: string; body: any; headers: Record<string, string> }
type Reply = { status: number; json?: unknown; text?: string };
type Responder = (call: Call) => Reply | Promise<Reply>;
type AuthState = { status: "unauthenticated" | "profile_incomplete" | "authenticated"; email?: string };

interface PageOpts {
  html: string;
  query?: string;
  auth?: AuthState;
  respond: Responder;
  session?: Record<string, string>;
  geo?: { coords?: { latitude: number; longitude: number; accuracy: number }; errorCode?: number };
  imagePipeline?: (file: unknown) => Promise<unknown>;
}

async function loadPage(opts: PageOpts) {
  const calls: Call[] = [];
  const timers: Array<{ id: number; fn: () => void; ms: number }> = [];
  let timerSeq = 0;
  let auth: AuthState = opts.auth ?? { status: "unauthenticated" };
  const listeners: Array<() => void> = [];
  const identity = { requested: [] as string[], verified: [] as string[][], profiles: [] as string[], signOuts: 0 };
  const geo = { getCurrentPosition: vi.fn((ok: (p: unknown) => void, err: (e: unknown) => void) => {
    if (opts.geo?.errorCode) err({ code: opts.geo.errorCode });
    else if (opts.geo?.coords) ok({ coords: opts.geo.coords });
    else err({ code: 2 });
  }) };
  const dom = new JSDOM(inlineScripts(opts.html), {
    url: `http://localhost/page.html${opts.query ?? `?e=${INSTANCE}`}`,
    runScripts: "dangerously",
    pretendToBeVisual: true,
    beforeParse(window) {
      const w = window as unknown as Record<string, any>;
      for (const [k, v] of Object.entries(opts.session ?? {})) window.sessionStorage.setItem(k, v);
      Object.defineProperty(window.navigator, "geolocation", { value: geo, configurable: true });
      w.UrbanoAuth = {
        getState: async () => (auth.status === "unauthenticated" ? auth : { authUserId: "stub-user", ...auth }),
        getAccessToken: async () => (auth.status === "unauthenticated" ? null : "stub-access-token"),
        onAuthStateChange: async (cb: () => void) => { listeners.push(cb); return () => {}; },
        // the destination's identity contract, as a stub: the page's behavior under the REAL client is pinned by communityVotingOperatorIdentity.test.ts
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
          status: out.status,
          json: async () => { if (out.json === undefined) throw new Error("no body"); return out.json; },
          text: async () => out.text ?? "",
          blob: async () => new window.Blob([out.text ?? ""]),
        };
      };
      if (opts.imagePipeline) w.CV_OPERATOR_IMAGE_PIPELINE = opts.imagePipeline;
      w.Image = class { onload: (() => void) | null = null; onerror: (() => void) | null = null; set src(_v: string) { setTimeout(() => this.onload?.(), 0); } };
      w.setTimeout = (fn: () => void, ms: number) => { const id = ++timerSeq; timers.push({ id, fn, ms }); return id; };
      w.clearTimeout = (id: number) => { const i = timers.findIndex((t) => t.id === id); if (i >= 0) timers.splice(i, 1); };
      w.setInterval = () => 0;
      w.URL.createObjectURL = () => "blob:stub";
      w.URL.revokeObjectURL = () => {};
    },
  });
  const win = dom.window as unknown as Window & Record<string, any>;
  const doc = win.document;
  const settle = async (ms = 30) => { for (let i = 0; i < 6; i++) await new Promise((r) => setTimeout(r, ms / 6)); };
  await settle();
  return {
    win, doc, calls, identity, geo,
    $: (sel: string) => doc.querySelector(sel) as HTMLElement | null,
    $$: (sel: string) => Array.from(doc.querySelectorAll(sel)) as HTMLElement[],
    text: () => doc.getElementById("app")?.textContent ?? doc.body.textContent ?? "",
    modal: () => doc.getElementById("modalRoot")?.textContent ?? "",
    settle,
    setAuth(next: AuthState) { auth = next; },
    fireAuth() { listeners.forEach((l) => l()); },
    click: async (el: Element | null) => { if (!el) throw new Error("element not found"); (el as HTMLElement).click(); await settle(); },
    type: async (el: Element | null, value: string) => { const i = el as HTMLInputElement; i.value = value; i.dispatchEvent(new win.Event("input", { bubbles: true })); i.dispatchEvent(new win.Event("change", { bubbles: true })); },
    markup: () => doc.documentElement.outerHTML.replace(/<script[\s\S]*?<\/script>/g, ""),
    page: () => doc.documentElement.outerHTML,
    authed: () => calls.filter((c) => c.headers.Authorization),
  };
}

// ---------------------------------------------------------------- a scripted pilot server

const ITEMS = [
  { alias: "1111", candidateId: uuid(101), mine: false },
  { alias: "2222", candidateId: uuid(102), mine: false },
  { alias: "3333", candidateId: uuid(103), mine: true },
].map((i) => ({ ...i, thumbUrl: `${PREFIX}/photos/${i.alias}?v=thumb`, fullUrl: `${PREFIX}/photos/${i.alias}?v=full` }));

interface World {
  role?: "PRELIMINARY" | "FINAL";
  phase?: string;
  deadlineRemainingMs?: number | null;
  published?: boolean;
  myCandidateId?: string | null;
  voteReply?: Reply | (() => Promise<Reply>);
  bindReply?: Reply;
  results?: Json;
}
type Json = Record<string, any>;

function server(world: World = {}) {
  const role = world.role ?? "PRELIMINARY";
  const final = role === "FINAL";
  const info = () => ({
    info: {
      roundRole: role, phase: world.phase ?? "OPEN", locationRequired: final, windowSeconds: final ? 300 : null,
      deadlineAt: final ? "2026-11-01T03:05:00.000Z" : "2026-11-01T03:30:00.000Z", serverNow: "2026-11-01T03:03:30.000Z",
      deadlineRemainingMs: world.deadlineRemainingMs === undefined ? (final ? 90_000 : 1_590_000) : world.deadlineRemainingMs,
      registrationOpensAt: null, contestantCutoffAt: null, votingOpensAt: null, votingClosesAt: null, tentative: true, approvedContestants: 3, published: !!world.published,
    },
    texts: { galleryConsent: { version: "v", text: "t" }, promoConsent: { version: "p", text: "t" } },
  });
  const state = { myCandidateId: world.myCandidateId ?? null, intent: 0, applied: 0 };
  const respond: Responder = async (call) => {
    const route = call.url.replace(PREFIX, "").split("?")[0];
    if (route === "/info") return { status: 200, json: info() };
    if (route === "/results") return { status: 200, json: world.results ?? { published: false, kind: null, items: [] } };
    if (route === "/binding") return world.bindReply ?? { status: 200, json: { bindingId: uuid(50), created: false } };
    if (route === "/status") return { status: 200, json: { bound: true, roundRole: role, phase: world.phase ?? "OPEN", myCandidateId: state.myCandidateId, deadlineRemainingMs: info().info.deadlineRemainingMs, interactionInstanceId: uuid(7) } };
    if (route === "/gallery") return { status: 200, json: { phase: world.phase ?? "OPEN", roundRole: role, interactionInstanceId: uuid(7), items: ITEMS } };
    if (route === "/intents") return { status: 201, json: { bindingId: uuid(50), intentNo: ++state.intent } };
    if (route === "/claims") return { status: 201, json: { label: "#1111", confirmationCode: "ABCD1234", confirmExpiresAt: "x" } };
    if (route === "/votes") {
      const reply = typeof world.voteReply === "function" ? await world.voteReply() : world.voteReply ?? { status: 200, json: { outcome: "APPLIED", candidateId: call.body.candidateId } };
      if (reply.status === 200) state.myCandidateId = call.body.candidateId;
      return reply;
    }
    return { status: 404, json: { code: "NOT_FOUND" } };
  };
  return { respond, state };
}

const VOTER = read("community-voting-round.html");
const OPERATOR = read("community-voting-round-operator.html");
const DISPLAY = read("community-voting-round-display.html");
const hasWord = (text: string, re: RegExp) => re.test(text);

// ============================================================ the voter page: identity

describe("voter page — who may vote", () => {
  it("shows a signed-out visitor the email step only: no phone, no WhatsApp, and nothing requiring a session is requested", async () => {
    const s = server();
    const p = await loadPage({ html: VOTER, respond: s.respond });
    expect(p.$("#stepIdentity")).toBeTruthy();
    expect(p.$("#email")).toBeTruthy();
    expect(p.$$("input[type=tel]")).toHaveLength(0);
    expect(hasWord(p.markup(), /whatsapp|sms|instagram|n[úu]mero de tel[eé]fono/i)).toBe(false);
    expect(p.text()).toMatch(/Entra con tu correo/);
    expect(p.text()).toMatch(/No hace falta tel[eé]fono/);
    expect(p.text()).toMatch(/perfil de URBANO Gaming/);
    expect(p.calls.map((c) => c.url.replace(PREFIX, ""))).toEqual(["/info"]);
    expect(p.authed()).toHaveLength(0);
    expect(p.$("#deck")).toBeNull();
  });

  it("sends the code, verifies it, and — for a first-time person — shows that the profile must be completed before voting; nothing is bound meanwhile", async () => {
    const s = server();
    const p = await loadPage({ html: VOTER, respond: s.respond });
    await p.type(p.$("#email"), "marta@example.invalid");
    await p.click(p.$("#sendEmail"));
    expect(p.identity.requested).toEqual(["marta@example.invalid"]);
    await p.type(p.$("#authCode"), "123456");
    await p.click(p.$("#verifyEmail"));
    expect(p.identity.verified).toEqual([["marta@example.invalid", "123456"]]);
    expect(p.$("#stepProfile")).toBeTruthy();
    expect(p.$("#profileNotice")?.textContent).toMatch(/Para votar necesitas completar tu perfil de URBANO Gaming/);
    expect(p.$("#deck")).toBeNull();
    expect(p.calls.some((c) => c.url.endsWith("/binding"))).toBe(false);
    expect(p.authed()).toHaveLength(0);
  });

  it("completing the profile lets the person continue on the same page: the round is entered and the contestants appear", async () => {
    const s = server();
    const p = await loadPage({ html: VOTER, respond: s.respond, auth: { status: "profile_incomplete", email: "marta@example.invalid" } });
    expect(p.$("#stepProfile")).toBeTruthy();
    expect(p.calls.some((c) => c.url.endsWith("/binding"))).toBe(false);
    await p.type(p.$("#displayName"), "Marta");
    await p.click(p.$("#saveProfile"));
    await p.settle();
    expect(p.identity.profiles).toEqual(["Marta"]);
    expect(p.$("#stepProfile")).toBeNull();
    expect(p.calls.map((c) => c.url.replace(PREFIX, "")).filter((u) => u !== "/info")).toEqual(["/binding", "/status", "/gallery"]);
    expect(p.$("#deck")).toBeTruthy();
    expect(p.text()).toMatch(/1 de 3/);
  });

  it("comes back to the contestant the person had chosen before the detour — and asks to confirm, never voting by itself", async () => {
    const s = server();
    const p = await loadPage({
      html: VOTER, respond: s.respond, auth: { status: "authenticated", email: "marta@example.invalid" },
      session: { [`cv:round:pending:${INSTANCE}`]: JSON.stringify({ alias: "2222", at: Date.now() }) },
    });
    expect(p.$("[aria-label='Votar por el disfraz número 2222']")).toBeTruthy();
    expect(p.modal()).toMatch(/¿Votar por el disfraz #2222\?/);
    expect(p.calls.some((c) => c.url.endsWith("/votes") || c.url.endsWith("/intents"))).toBe(false);
    expect(p.win.sessionStorage.getItem(`cv:round:pending:${INSTANCE}`)).toBeNull(); // used once
  });

  it("does not resume onto the person's own costume or when the round is not open", async () => {
    const own = await loadPage({ html: VOTER, respond: server().respond, auth: { status: "authenticated" }, session: { [`cv:round:pending:${INSTANCE}`]: JSON.stringify({ alias: "3333", at: Date.now() }) } });
    expect(own.modal()).toBe("");
    const closed = await loadPage({ html: VOTER, respond: server({ phase: "NOT_OPEN" }).respond, auth: { status: "authenticated" }, session: { [`cv:round:pending:${INSTANCE}`]: JSON.stringify({ alias: "2222", at: Date.now() }) } });
    expect(closed.modal()).toBe("");
  });

  it("never replaces an existing session: a signed-in person has no sign-in form, and changing account is their own confirmed act", async () => {
    const p = await loadPage({ html: VOTER, respond: server().respond, auth: { status: "authenticated", email: "marta@example.invalid" } });
    expect(p.$("#email")).toBeNull();
    expect(p.$("#verifyEmail")).toBeNull();
    expect(p.identity.verified).toEqual([]);
    expect(p.doc.getElementById("who")?.textContent).toBe("marta@example.invalid");
    await p.click(p.$("#switchAccount"));
    expect(p.modal()).toMatch(/Vas a cerrar la sesión de marta@example.invalid/);
    await p.click(p.$("#switchCancel"));
    expect(p.identity.signOuts).toBe(0);
    await p.click(p.$("#switchAccount"));
    await p.click(p.$("#switchConfirm"));
    expect(p.identity.signOuts).toBe(1);
    expect(p.$("#email")).toBeTruthy();
  });

  it("does not verify a code over a session that appeared meanwhile (another tab signed in): the existing account is kept", async () => {
    const p = await loadPage({ html: VOTER, respond: server().respond });
    await p.type(p.$("#email"), "marta@example.invalid");
    await p.click(p.$("#sendEmail"));
    await p.type(p.$("#authCode"), "123456");
    p.setAuth({ status: "authenticated", email: "other@example.invalid" }); // another tab signed someone in
    await p.click(p.$("#verifyEmail"));
    expect(p.identity.verified).toEqual([]);
    expect(p.text()).toMatch(/Ya hay una sesión abierta en este navegador/);
    expect(p.doc.getElementById("who")?.textContent).toBe("other@example.invalid");
    expect(p.$("#deck")).toBeTruthy();
  });

  it("sends a person whose session or profile the server refuses back to the right step, remembering what they chose", async () => {
    const s = server({ voteReply: { status: 403, json: { code: "PROFILE_INCOMPLETE" } } });
    const p = await loadPage({ html: VOTER, respond: s.respond, auth: { status: "authenticated", email: "m@example.invalid" } });
    await p.click(p.$("#choose"));
    await p.click(p.$("#confirmVote"));
    expect(p.$("#stepProfile")).toBeTruthy();
    expect(p.text()).toMatch(/completa tu perfil/i);
    expect(JSON.parse(p.win.sessionStorage.getItem(`cv:round:pending:${INSTANCE}`) as string).alias).toBe("1111");
  });
});

// ============================================================ the voter page: voting

describe("voter page — preliminary", () => {
  it("votes WITHOUT touching the location sensor: the confirmation never mentions a location and the request carries none", async () => {
    const s = server();
    const p = await loadPage({ html: VOTER, respond: s.respond, auth: { status: "authenticated", email: "m@example.invalid" }, geo: { coords: { latitude: 15.5, longitude: -88, accuracy: 10 } } });
    expect(p.text()).toMatch(/puedes cambiar tu voto hasta que cierre/);
    // the preliminary has a binding deadline too: its remaining time (the server's) is shown, in the event's own time zone
    expect(p.$("#clock")?.textContent).toMatch(/^26:(2\d|30)$/);
    expect(p.text()).toMatch(/Cierra a las 21:30 \(hora de Honduras\)/);
    await p.click(p.$("#choose"));
    expect(p.modal()).toMatch(/¿Votar por el disfraz #1111\?/);
    expect(p.$("#locationNote")).toBeNull();
    await p.click(p.$("#confirmVote"));
    const vote = p.calls.find((c) => c.url.endsWith("/votes"))!;
    expect(vote.body).toEqual({ bindingId: uuid(50), intentNo: 1, interactionInstanceId: uuid(7), candidateId: uuid(101) });
    expect(p.geo.getCurrentPosition).not.toHaveBeenCalled();
    expect(p.text()).toMatch(/Tu voto por #1111 quedó registrado/);
    expect(p.text()).toMatch(/✓ Tu voto/);
  });

  it("shows nothing as accepted until the server answers — not while the request is in flight, not when it is refused", async () => {
    let release: (r: Reply) => void = () => {};
    const s = server({ voteReply: () => new Promise<Reply>((resolve) => { release = resolve; }) });
    const p = await loadPage({ html: VOTER, respond: s.respond, auth: { status: "authenticated", email: "m@example.invalid" } });
    await p.click(p.$("#choose"));
    await p.click(p.$("#confirmVote"));
    expect(p.calls.some((c) => c.url.endsWith("/votes"))).toBe(true);
    expect(p.text()).not.toMatch(/quedó registrado/);
    expect(p.text()).not.toMatch(/✓ Tu voto/);
    release({ status: 409, json: { code: "VOTING_NOT_OPEN" } });
    await p.settle();
    expect(p.text()).not.toMatch(/quedó registrado/);
    expect(p.text()).toMatch(/La votación no está abierta/);
  });

  it("lets the person change their vote while the round is open, and says so", async () => {
    const s = server({ myCandidateId: uuid(101) });
    const p = await loadPage({ html: VOTER, respond: s.respond, auth: { status: "authenticated", email: "m@example.invalid" } });
    expect(p.text()).toMatch(/✓ Tu voto/);
    await p.click(p.$("#next"));
    expect(p.$("#choose")?.textContent).toBe("Cambiar mi voto a este");
    await p.click(p.$("#choose"));
    expect(p.$("#confirmVote")?.textContent).toBe("Cambiar mi voto");
    await p.click(p.$("#confirmVote"));
    expect(p.calls.filter((c) => c.url.endsWith("/votes")).map((c) => c.body.candidateId)).toEqual([uuid(102)]);
    expect(p.text()).toMatch(/Tu voto por #2222 quedó registrado/);
  });

  it("cannot vote for the person's own costume, and offers no vote button when the round is not open", async () => {
    const own = await loadPage({ html: VOTER, respond: server().respond, auth: { status: "authenticated" } });
    await own.click(own.$("#next")); await own.click(own.$("#next"));
    expect(own.text()).toMatch(/Tu disfraz/);
    expect((own.$("#choose") as HTMLButtonElement).disabled).toBe(true);
    const closed = await loadPage({ html: VOTER, respond: server({ phase: "CLOSED" }).respond, auth: { status: "authenticated" } });
    expect((closed.$("#choose") as HTMLButtonElement).disabled).toBe(true);
    expect(closed.text()).toMatch(/La votación está cerrada/);
  });

  it("recovers from a lost response by retrying the SAME intent, without a new one", async () => {
    let first = true;
    const s = server({ voteReply: async () => (first ? ((first = false), { status: 0, json: { code: "NETWORK" } }) : { status: 200, json: { outcome: "REPLAYED", candidateId: uuid(101) } }) });
    const p = await loadPage({ html: VOTER, respond: async (call) => (call.url.endsWith("/votes") && first ? (first = false, Promise.reject(new Error("offline"))) : s.respond(call)), auth: { status: "authenticated" } });
    await p.click(p.$("#choose"));
    await p.click(p.$("#confirmVote"));
    expect(p.text()).toMatch(/No hay conexión/);
    expect(p.text()).not.toMatch(/quedó registrado/);
    await p.click(p.$("#choose"));
    await p.click(p.$("#confirmVote"));
    expect(p.text()).toMatch(/quedó registrado/);
    expect(p.calls.filter((c) => c.url.endsWith("/intents"))).toHaveLength(1);
    const votes = p.calls.filter((c) => c.url.endsWith("/votes"));
    expect(votes).toHaveLength(2);
    expect(votes[0].body.intentNo).toBe(votes[1].body.intentNo);
  });
});

describe("voter page — final", () => {
  const FINAL_WORLD: World = { role: "FINAL" };

  it("shows the server's countdown, announces that a location is used, reads ONE position per vote and sends it", async () => {
    const s = server(FINAL_WORLD);
    const p = await loadPage({ html: VOTER, respond: s.respond, auth: { status: "authenticated", email: "m@example.invalid" }, geo: { coords: { latitude: 15.5, longitude: -88, accuracy: 10 } } });
    expect(p.text()).toMatch(/La final está abierta/);
    expect(p.$("#clock")?.textContent).toBe("1:30"); // the SERVER said 90 000 ms remain
    await p.click(p.$("#choose"));
    expect(p.$("#locationNote")?.textContent).toMatch(/solo para confirmar que estás en el evento. No la guardamos/);
    expect(p.geo.getCurrentPosition).not.toHaveBeenCalled(); // opening the dialog asks nothing of the browser
    await p.click(p.$("#confirmVote"));
    expect(p.geo.getCurrentPosition).toHaveBeenCalledTimes(1);
    const vote = p.calls.find((c) => c.url.endsWith("/votes"))!;
    expect(vote.body.location).toEqual({ latitude: 15.5, longitude: -88, accuracyMeters: 10 });
    expect(p.text()).toMatch(/Tu voto por #1111 quedó registrado/);
    expect(p.text()).toMatch(/mientras dure el tiempo/);
    // the revision is another vote: another reading
    await p.click(p.$("#next"));
    await p.click(p.$("#choose"));
    await p.click(p.$("#confirmVote"));
    expect(p.geo.getCurrentPosition).toHaveBeenCalledTimes(2);
  });

  it("without a readable location nothing is sent to the server — not even an intent — and the person is told what to do", async () => {
    const p = await loadPage({ html: VOTER, respond: server(FINAL_WORLD).respond, auth: { status: "authenticated" }, geo: { errorCode: 1 } });
    await p.click(p.$("#choose"));
    await p.click(p.$("#confirmVote"));
    expect(p.text()).toMatch(/Para votar en la final necesitamos tu ubicación/);
    expect(p.text()).not.toMatch(/quedó registrado/);
    expect(p.calls.some((c) => c.url.endsWith("/intents") || c.url.endsWith("/votes"))).toBe(false);
  });

  it("shows the server's refusals in plain language and confirms nothing: outside the venue, and the window already over", async () => {
    const outside = await loadPage({ html: VOTER, respond: server({ ...FINAL_WORLD, voteReply: { status: 403, json: { code: "LOCATION_OUTSIDE" } } }).respond, auth: { status: "authenticated" }, geo: { coords: { latitude: 1, longitude: 2, accuracy: 5 } } });
    await outside.click(outside.$("#choose"));
    await outside.click(outside.$("#confirmVote"));
    expect(outside.text()).toMatch(/debes estar en el evento/);
    expect(outside.text()).not.toMatch(/quedó registrado/);

    const late = await loadPage({ html: VOTER, respond: server({ ...FINAL_WORLD, voteReply: { status: 409, json: { code: "VOTING_WINDOW_ELAPSED" } } }).respond, auth: { status: "authenticated" }, geo: { coords: { latitude: 15.5, longitude: -88, accuracy: 5 } } });
    await late.click(late.$("#choose"));
    await late.click(late.$("#confirmVote"));
    expect(late.text()).toMatch(/El tiempo de la votación terminó/);
    expect(late.text()).not.toMatch(/quedó registrado/);
  });

  it("a final whose server window is already over shows as closed, and offers no vote", async () => {
    const p = await loadPage({ html: VOTER, respond: server({ ...FINAL_WORLD, deadlineRemainingMs: 0 }).respond, auth: { status: "authenticated" } });
    expect(p.$("#clock")?.textContent).toBe("0:00");
    const choose = p.$("#choose") as HTMLButtonElement | null;
    expect(choose === null || choose.disabled || /cerrada/i.test(p.text())).toBe(true);
  });
});

describe("voter page — after the close", () => {
  it("announces the winners — a shared win as such — and the finalists, by number and photograph, with no count", async () => {
    const winners = await loadPage({
      html: VOTER, auth: { status: "authenticated" },
      respond: server({ role: "FINAL", phase: "CLOSED", published: true, results: { published: true, kind: "WINNERS", items: [{ alias: "1111" }, { alias: "2222" }] } }).respond,
    });
    expect(winners.$("#announcement")?.textContent).toMatch(/ganadores compartidos/);
    expect(winners.$$("#announcement figure").map((f) => f.getAttribute("data-alias"))).toEqual(["1111", "2222"]);
    expect(winners.$("#announcement img")?.getAttribute("src")).toBe(`${PREFIX}/photos/1111?v=thumb`);
    expect(winners.$("#announcement")?.textContent).not.toMatch(/votos|puntos|total|\b\d+ (votos|puntos)\b/i);

    const finalists = await loadPage({
      html: VOTER, auth: { status: "authenticated" },
      respond: server({ phase: "CLOSED", published: true, results: { published: true, kind: "FINALISTS", items: [{ alias: "1111" }] } }).respond,
    });
    expect(finalists.$("#announcement")?.textContent).toMatch(/Los finalistas/);
  });

  it("shows nothing about results before the publication", async () => {
    const p = await loadPage({ html: VOTER, auth: { status: "authenticated" }, respond: server({ phase: "CLOSED", published: false }).respond });
    expect(p.$("#announcement")).toBeNull();
    expect(p.calls.some((c) => c.url.endsWith("/results"))).toBe(false);
  });
});

describe("voter page — the contestant's own step and the shipped source", () => {
  it("lets a contestant register their participation before the round opens (preliminary), and shows the code to read to the operator", async () => {
    const p = await loadPage({ html: VOTER, respond: server({ phase: "NOT_OPEN" }).respond, auth: { status: "authenticated" } });
    expect(p.$("#claimCard")).toBeTruthy();
    await p.type(p.$("#claimCode"), "ABCD-EFGH-JKMN");
    await p.click(p.$("#claimGo"));
    expect(p.calls.find((c) => c.url.endsWith("/claims"))!.body).toEqual({ claimCode: "ABCD-EFGH-JKMN" });
    expect(p.$("#confirmationCode")?.textContent).toBe("ABCD1234");
    const open = await loadPage({ html: VOTER, respond: server().respond, auth: { status: "authenticated" } });
    expect(open.$("#claimCard")).toBeNull();
    const final = await loadPage({ html: VOTER, respond: server({ role: "FINAL", phase: "NOT_OPEN" }).respond, auth: { status: "authenticated" } });
    expect(final.$("#claimCard")).toBeNull();
  });

  it("rejects a link without a valid round id before asking anything", async () => {
    const p = await loadPage({ html: VOTER, respond: server().respond, query: "?e=not-an-id" });
    expect(p.text()).toMatch(/No encontramos esta votación/);
    expect(p.calls).toHaveLength(0);
  });

  it("builds no markup from server text, mentions no telephone provider or Instagram, and asks the browser for a location nowhere in the page itself", () => {
    expect(VOTER).not.toMatch(/innerHTML|outerHTML|insertAdjacentHTML|document\.write/);
    expect(VOTER).not.toMatch(/whatsapp|sms|twilio|instagram|n[úu]mero de tel[eé]fono|type="tel"/i);
    expect(VOTER).not.toMatch(/getCurrentPosition|watchPosition/); // the only reader is communityVotingRound.js, reached only when the server says a location is required
    expect(VOTER).not.toMatch(/community-voting\/(ranked|instances)\//);
    const round = read("communityVotingRound.js");
    expect(round.match(/geolocation\.getCurrentPosition\(/g)).toHaveLength(1); // one reader, inside readPosition
    const code = round.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, ""); // the comments say what is NOT there
    expect(code).not.toMatch(/whatsapp|sms|twilio|instagram/i);
  });
});

// ============================================================ the operator tablet

const OVERVIEW = (over: Json = {}) => ({
  roundRole: "PRELIMINARY", sessionState: "LOBBY_LOCKED", interactionState: null, opened: false, closed: false, published: false, serverNow: "2026-10-31T21:00:00.000Z",
  windowSeconds: null, deadlineAt: null, schedule: { registrationOpensAt: null, contestantCutoffAt: null, votingOpensAt: null, votingClosesAt: "2026-10-31T22:00:00.000Z", status: "TENTATIVE" },
  counters: { boundVoters: 4, votes: 0, entries: 2, withdrawn: 0 }, finalistsSelected: false,
  policies: [
    { key: "ZERO_VALID_VOTES_PRELIMINARY", approved: false, value: null, approvalReference: null },
    { key: "ZERO_VOTE_ENTRIES_AT_CUTOFF", approved: false, value: null, approvalReference: null },
    { key: "FINALIST_WITHDRAWAL_AFTER_SELECTION", approved: false, value: null, approvalReference: null },
  ], pendingResolutions: [], review: null, tasks: [], publishedAffected: [],
  entries: [
    { entryId: uuid(201), label: "#1111", association: "CONFIRMED", media: "APPROVED", photoId: uuid(301), promotional: "NOT_ASKED", withdrawn: false, carried: false, claimable: false, claimExpiresAt: null },
    { entryId: uuid(202), label: "#2222", association: "CONFIRMED", media: "APPROVED", photoId: uuid(302), promotional: "DECLINED", withdrawn: false, carried: false, claimable: false, claimExpiresAt: null },
  ],
  ...over,
});

function operatorServer(overview: () => Json, extras: { results?: Json } = {}) {
  const seen: Call[] = [];
  const respond: Responder = async (call) => {
    seen.push(call);
    const route = call.url.replace(PREFIX, "").split("?")[0];
    if (route === "/operator/overview") return { status: 200, json: overview() };
    if (route === "/info") return { status: 200, json: { info: {}, texts: { galleryConsent: { version: "halloween-2026-v3-gallery", text: "TEXTO GALERIA" }, promoConsent: { version: "halloween-2026-v2-promo", text: "TEXTO PROMO" } } } };
    if (route === "/operator/results") return extras.results ? { status: 200, json: extras.results } : { status: 409, json: { code: "RESULTS_NOT_AVAILABLE" } };
    if (route === "/operator/open") return { status: 201, json: { started: {} } };
    if (route === "/operator/close") return { status: 200, json: { closure: {} } };
    return { status: 200, json: {} };
  };
  return { respond, seen };
}
// the page remembers a round together with the person it belongs to (the stub signs in as "stub-user")
const ROUND_SESSION = { "cvop2:round": JSON.stringify({ instanceId: INSTANCE, hostToken: "host-token-123", ownerUserId: "stub-user" }) };

describe("operator tablet", () => {
  it("asks a signed-out visitor to sign in and requests nothing", async () => {
    const o = operatorServer(() => OVERVIEW());
    const p = await loadPage({ html: OPERATOR, respond: o.respond, query: "", session: ROUND_SESSION });
    expect(p.$("#needSignIn")?.textContent).toMatch(/Inicia sesión con la cuenta del operador/);
    expect(o.seen).toHaveLength(0);
  });

  it("says that a profile is needed before operating, and asks for nothing else", async () => {
    const p = await loadPage({ html: OPERATOR, respond: operatorServer(() => OVERVIEW()).respond, query: "", auth: { status: "profile_incomplete" } });
    expect(p.$("#needSignIn")?.textContent).toMatch(/Completa tu perfil/);
  });

  it("offers to connect to a round or register one — a preliminary has no venue fields, a final does", async () => {
    const p = await loadPage({ html: OPERATOR, respond: operatorServer(() => OVERVIEW()).respond, query: "", auth: { status: "authenticated" } });
    expect(p.$("#connectCard")).toBeTruthy();
    expect(p.$("#registerCard")).toBeTruthy();
    expect(p.$("#reg-lat")).toBeNull();
    const role = p.$("#reg-role") as HTMLSelectElement;
    role.value = "FINAL";
    role.dispatchEvent(new p.win.Event("change", { bubbles: true }));
    await p.settle();
    for (const id of ["reg-source", "reg-lat", "reg-lon", "reg-radius", "reg-accuracy"]) expect(p.$(`#${id}`), id).toBeTruthy();
    expect(p.text()).toMatch(/cinco minutos desde que la abres/);
  });

  it("connects with the round id and the host token, and every call carries the bearer AND the host token", async () => {
    const o = operatorServer(() => OVERVIEW());
    const p = await loadPage({ html: OPERATOR, respond: o.respond, query: "", auth: { status: "authenticated" } });
    await p.type(p.$("#instanceId"), INSTANCE);
    await p.type(p.$("#hostToken"), "host-token-123");
    await p.click(p.$("#connect"));
    expect(o.seen.length).toBeGreaterThan(0);
    const overviewCall = o.seen.find((c) => c.url.endsWith("/operator/overview"))!;
    expect(overviewCall.headers.Authorization).toBe("Bearer stub-access-token");
    expect(overviewCall.headers["x-host-token"]).toBe("host-token-123");
    expect(p.$("#roundHeader")).toBeTruthy();
    expect(p.$("#checklist")).toBeTruthy();
  });

  it("while the round is in preparation shows the checklist, the counters, the entries — and NO per-contestant figure", async () => {
    const p = await loadPage({ html: OPERATOR, respond: operatorServer(() => OVERVIEW()).respond, query: "", auth: { status: "authenticated" }, session: ROUND_SESSION });
    expect(p.$("#roundHeader")?.textContent).toMatch(/Preliminar/);
    expect(p.$("#roundHeader")?.textContent).toMatch(/En preparación/);
    expect(p.$("#step-OPEN") && !(p.$("#step-OPEN") as HTMLButtonElement).disabled).toBe(true);
    expect((p.$("#step-CLOSE") as HTMLButtonElement).disabled).toBe(true);
    expect(p.$$("[data-entry]")).toHaveLength(2);
    expect(p.$("#results")).toBeNull();
    expect(p.$("#entries")?.textContent).not.toMatch(/votos|puesto|rank/i);
    expect(p.$("#promo-" + uuid(202))?.textContent).toMatch(/No autorizó el uso promocional/);
    expect(p.$("#scheduleCard")?.textContent).toMatch(/hora de Honduras/);
    expect(p.$("#scheduleCard")?.textContent).toMatch(/abrir la ronda siempre lo haces tú/);
  });

  it("opens only after an explicit confirmation, and sends the open to the pilot's route", async () => {
    const o = operatorServer(() => OVERVIEW());
    const p = await loadPage({ html: OPERATOR, respond: o.respond, query: "", auth: { status: "authenticated" }, session: ROUND_SESSION });
    await p.click(p.$("#step-OPEN"));
    expect(p.modal()).toMatch(/Después de abrir ya no se puede cambiar la preparación ni los horarios/);
    expect(o.seen.some((c) => c.url.endsWith("/operator/open"))).toBe(false);
    await p.click(p.$("#dialogCancel"));
    expect(o.seen.some((c) => c.url.endsWith("/operator/open"))).toBe(false);
    await p.click(p.$("#step-OPEN"));
    await p.click(p.$("#dialogConfirm"));
    const open = o.seen.find((c) => c.url.endsWith("/operator/open"))!;
    expect(open.method).toBe("POST");
    expect(open.body.promptText).toMatch(/favorito/);
  });

  it("an open final shows the server's clock and says that the server measures it", async () => {
    const final = OVERVIEW({ roundRole: "FINAL", opened: true, windowSeconds: 300, deadlineAt: "2026-10-31T21:05:00.000Z", serverNow: "2026-10-31T21:01:00.000Z", counters: { boundVoters: 9, votes: 5, entries: 3, withdrawn: 0 }, entries: OVERVIEW().entries.map((e: Json) => ({ ...e, carried: true })) });
    const p = await loadPage({ html: OPERATOR, respond: operatorServer(() => final).respond, query: "", auth: { status: "authenticated" }, session: ROUND_SESSION });
    expect(p.$("#windowClock")?.textContent).toMatch(/^(3:5\d|4:00)$/);
    expect(p.$("#roundHeader")?.textContent).toMatch(/lo mide el servidor/);
    expect(p.$("#roundHeader")?.textContent).toMatch(/5/); // aggregate counter only
    expect(p.$("#addEntry")).toBeNull(); // a final's entries come from its preliminary
    expect((p.$("#step-CLOSE") as HTMLButtonElement).disabled).toBe(false);
  });

  it("after the close shows the totals, ranks and who advances; finalists are marked; the cut is the next step", async () => {
    const closed = OVERVIEW({ opened: true, closed: true });
    const results = { rows: [
      { candidateId: uuid(1), entryId: uuid(201), label: "#1111", ordinal: 1, withdrawn: false, votes: 7, competitionRank: 1, finalist: true, winner: false },
      { candidateId: uuid(2), entryId: uuid(202), label: "#2222", ordinal: 2, withdrawn: false, votes: 3, competitionRank: 2, finalist: true, winner: false },
      { candidateId: uuid(3), entryId: uuid(203), label: "#3333", ordinal: 3, withdrawn: true, votes: 9, competitionRank: null, finalist: false, winner: false },
    ], evidence: {} };
    const p = await loadPage({ html: OPERATOR, respond: operatorServer(() => closed, { results }).respond, query: "", auth: { status: "authenticated" }, session: ROUND_SESSION });
    expect(p.$("#results")).toBeTruthy();
    const rows = p.$$("#results tbody tr").map((tr) => Array.from(tr.querySelectorAll("td")).map((td) => td.textContent));
    expect(rows).toEqual([["#1111", "7", "1", "Sí"], ["#2222", "3", "2", "Sí"], ["#3333 (retirado)", "9", "—", ""]]);
    expect((p.$("#step-FINALISTS") as HTMLButtonElement).disabled).toBe(false);
    expect((p.$("#step-REVIEW") as HTMLButtonElement).disabled).toBe(true);
  });

  describe("schedule, Product decisions, photograph visibility and follow-up tasks", () => {
    const auth = { status: "authenticated" as const };

    it("fills in the initial times of 31 October only when asked, in the event's own time, and saves nothing by itself", async () => {
      const o = operatorServer(() => OVERVIEW());
      const p = await loadPage({ html: OPERATOR, respond: o.respond, query: "", auth, session: ROUND_SESSION });
      expect(o.seen.some((c) => c.method === "PUT")).toBe(false);
      await p.click(p.$("#useTemplate"));
      const val = (id: string) => (p.$(id) as HTMLInputElement).value;
      expect([val("#sched-registration-date"), val("#sched-registration-time"), val("#sched-cutoff-time"), val("#sched-opens-time"), val("#sched-closes-time"), val("#sched-closes-date")]).toEqual(["2026-10-31", "19:00", "20:30", "20:30", "21:30", "2026-10-31"]);
      expect(o.seen.some((c) => c.method === "PUT")).toBe(false);
      await p.click(p.$("#saveSchedule"));
      const put = o.seen.find((c) => c.method === "PUT")!;
      expect(put.url).toBe(`${PREFIX}/schedule`);
      expect(put.body).toEqual({
        registrationOpensAt: "2026-11-01T01:00:00.000Z", contestantCutoffAt: "2026-11-01T02:30:00.000Z",
        votingOpensAt: "2026-11-01T02:30:00.000Z", votingClosesAt: "2026-11-01T03:30:00.000Z", status: "TENTATIVE",
      });
      expect(o.seen.some((c) => /\/operator\/open$/.test(c.url))).toBe(false);
    });

    it("shows the saved times as the event's, and says the schedule can no longer change once the round has opened", async () => {
      const opened = OVERVIEW({ opened: true, deadlineAt: "2026-11-01T03:30:00.000Z", serverNow: "2026-11-01T03:00:00.000Z", schedule: { registrationOpensAt: "2026-11-01T01:00:00.000Z", contestantCutoffAt: "2026-11-01T02:30:00.000Z", votingOpensAt: "2026-11-01T02:30:00.000Z", votingClosesAt: "2026-11-01T03:30:00.000Z", status: "CONFIRMED" } });
      const p = await loadPage({ html: OPERATOR, respond: operatorServer(() => opened).respond, query: "", auth, session: ROUND_SESSION });
      expect(p.$("#saveSchedule")).toBeNull();
      expect(p.$("#scheduleCard")?.textContent).toMatch(/ya no se pueden cambiar/);
      expect(p.$("#scheduleSummary")?.textContent).toMatch(/2026-10-31 19:00 → 2026-10-31 20:30/);
      expect(p.$("#scheduleSummary")?.textContent).toMatch(/2026-10-31 21:30/);
      expect(p.$("#windowClock")?.textContent).toMatch(/^(29:5\d|30:00)$/);
      expect(p.$("#roundHeader")?.textContent).toMatch(/21:30 \(hora de Honduras\)/);
    });

    it("lists the three Product decisions, marks the one that blocks, and records one only with its acknowledgement and reference after a confirmation", async () => {
      const closed = OVERVIEW({ opened: true, closed: true, pendingResolutions: [{ key: "ZERO_VOTE_ENTRIES_AT_CUTOFF" }] });
      const o = operatorServer(() => closed, { results: { rows: [], evidence: {} } });
      const p = await loadPage({ html: OPERATOR, respond: o.respond, query: "", auth, session: ROUND_SESSION });
      expect(p.$$("[data-policy]").map((e) => e.getAttribute("data-policy"))).toEqual(["ZERO_VALID_VOTES_PRELIMINARY", "ZERO_VOTE_ENTRIES_AT_CUTOFF", "FINALIST_WITHDRAWAL_AFTER_SELECTION"]);
      expect(p.$('[data-policy="ZERO_VOTE_ENTRIES_AT_CUTOFF"]')?.textContent).toMatch(/Bloquea ahora/);
      expect((p.$("#step-FINALISTS") as HTMLButtonElement).disabled).toBe(true);
      await p.click(p.$("#policy-ZERO_VOTE_ENTRIES_AT_CUTOFF"));
      expect(p.text()).toMatch(/Confirma que el Founder ya aprobó esta política/);
      expect(o.seen.some((c) => c.url.endsWith("/operator/policies"))).toBe(false);
      await p.type(p.$("#policy-ref-ZERO_VOTE_ENTRIES_AT_CUTOFF"), "ACTA-PRODUCTO-12");
      const ack = p.$("#policy-ack-ZERO_VOTE_ENTRIES_AT_CUTOFF") as HTMLInputElement;
      ack.checked = true;
      ack.dispatchEvent(new p.win.Event("change", { bubbles: true }));
      await p.click(p.$("#policy-ZERO_VOTE_ENTRIES_AT_CUTOFF"));
      expect(p.modal()).toMatch(/Se registra una sola vez y no se puede cambiar/);
      expect(o.seen.some((c) => c.url.endsWith("/operator/policies"))).toBe(false);
      await p.click(p.$("#dialogConfirm"));
      const post = o.seen.find((c) => c.url.endsWith("/operator/policies"))!;
      expect(post.method).toBe("POST");
      expect(post.body).toEqual({ policyKey: "ZERO_VOTE_ENTRIES_AT_CUTOFF", policyValue: "TIED_ZERO_VOTE_ENTRIES_ADVANCE", approvalReference: "ACTA-PRODUCTO-12" });
    });

    it("shows a decision already taken with its reference and offers no way to change it", async () => {
      const decided = OVERVIEW({ policies: [{ key: "ZERO_VALID_VOTES_PRELIMINARY", approved: true, value: "ALL_ENTRIES_ADVANCE", approvalReference: "ACTA-1" }, { key: "ZERO_VOTE_ENTRIES_AT_CUTOFF", approved: false, value: null, approvalReference: null }, { key: "FINALIST_WITHDRAWAL_AFTER_SELECTION", approved: false, value: null, approvalReference: null }] });
      const p = await loadPage({ html: OPERATOR, respond: operatorServer(() => decided).respond, query: "", auth, session: ROUND_SESSION });
      expect(p.$('[data-policy="ZERO_VALID_VOTES_PRELIMINARY"]')?.textContent).toMatch(/Referencia citada por el operador: ACTA-1/);
      expect(p.$("#policy-ZERO_VALID_VOTES_PRELIMINARY")).toBeNull();
    });

    it("keeps hiding a photograph and withdrawing a candidature as two different acts", async () => {
      const o = operatorServer(() => OVERVIEW());
      const p = await loadPage({ html: OPERATOR, respond: o.respond, query: "", auth, session: ROUND_SESSION });
      const id = uuid(201);

      await p.click(p.$(`#hide-${id}`));
      expect(p.modal()).toMatch(/Su participación, sus votos y los resultados no cambian/);
      await p.type(p.$("#hideReason"), "La persona lo pidió");
      await p.click(p.$("#dialogConfirm"));
      const hide = o.seen.find((c) => c.url.endsWith(`/operator/entries/${id}/photo-hide`))!;
      expect(hide.body).toEqual({ reason: "La persona lo pidió" });
      expect(o.seen.some((c) => c.url.endsWith("/withdrawal"))).toBe(false);

      await p.click(p.$(`#withdraw-${id}`));
      expect(p.modal()).toMatch(/Los votos que ya recibió se conservan como evidencia/);
      expect((p.$("#withdrawHidePhoto") as HTMLInputElement).checked).toBe(false);
      await p.type(p.$("#withdrawReason"), "Se retira");
      await p.click(p.$("#dialogConfirm"));
      expect(o.seen.filter((c) => c.url.endsWith(`/operator/entries/${id}/withdrawal`)).map((c) => c.body)).toEqual([{ reason: "Se retira", hidePhoto: false }]);

      await p.click(p.$(`#withdraw-${id}`));
      (p.$("#withdrawHidePhoto") as HTMLInputElement).checked = true;
      await p.type(p.$("#withdrawReason"), "Se retira y borra");
      await p.click(p.$("#dialogConfirm"));
      expect(o.seen.filter((c) => c.url.endsWith(`/operator/entries/${id}/withdrawal`)).map((c) => c.body)).toEqual([{ reason: "Se retira", hidePhoto: false }, { reason: "Se retira y borra", hidePhoto: true }]);
    });

    it("tells a person whose photograph was hidden that it is, and offers no second hiding", async () => {
      const hidden = OVERVIEW({ entries: OVERVIEW().entries.map((e: Json, i: number) => (i === 0 ? { ...e, media: "HIDDEN" } : e)) });
      const p = await loadPage({ html: OPERATOR, respond: operatorServer(() => hidden).respond, query: "", auth, session: ROUND_SESSION });
      expect(p.$(`#hidden-${uuid(201)}`)?.textContent).toMatch(/oculta a petición de la persona/);
      expect(p.$(`#hide-${uuid(201)}`)).toBeNull();
      expect(p.$$("[data-entry]")[0].getAttribute("data-step")).toBe("READY");
    });

    it("shows the pending follow-up task with the system's statement that it deletes nothing outside, and resolves it with a note", async () => {
      const task = { taskId: uuid(401), kind: "EXTERNAL_PROMO_REMOVAL", status: "PENDING", description: "La persona retiró su autorización promocional. El sistema solo registra la solicitud: no elimina publicaciones externas. Alguien del equipo debe retirarlas a mano.", createdAt: "2026-11-01T01:00:00.000Z", resolvedAt: null, resolutionNote: null };
      const o = operatorServer(() => OVERVIEW({ tasks: [task] }));
      const p = await loadPage({ html: OPERATOR, respond: o.respond, query: "", auth, session: ROUND_SESSION });
      expect(p.$("#tasksCard")?.textContent).toMatch(/no elimina publicaciones externas/);
      await p.click(p.$(`#task-done-${task.taskId}`));
      expect(o.seen.some((c) => c.url.includes("/operator/tasks/"))).toBe(false);
      await p.type(p.$(`#task-note-${task.taskId}`), "Se retiró a mano");
      await p.click(p.$(`#task-done-${task.taskId}`));
      const post = o.seen.find((c) => c.url.endsWith(`/operator/tasks/${task.taskId}`))!;
      expect(post.body).toEqual({ note: "Se retiró a mano" });
    });

    it("warns that an announced contestant has withdrawn since, without rewriting what was announced", async () => {
      const affected = OVERVIEW({ opened: true, closed: true, published: true, finalistsSelected: true, publishedAffected: [{ alias: "#1111", ordinal: 1 }] });
      const p = await loadPage({ html: OPERATOR, respond: operatorServer(() => affected, { results: { rows: [], evidence: {} } }).respond, query: "", auth, session: ROUND_SESSION });
      expect(p.$("#publishedAffected")?.textContent).toMatch(/Lo publicado no se modifica.*#1111/);
    });

    it("a closed final with no valid votes says so plainly: no winner, no way to publish, and no control that would cancel, reopen, extend or pick a winner", async () => {
      const entries = OVERVIEW().entries.map((e: Json) => ({ ...e, carried: true }));
      const closed = OVERVIEW({ roundRole: "FINAL", opened: true, closed: true, windowSeconds: 300, noValidResult: true, entries, schedule: null });
      const results = { rows: entries.map((e: Json, i: number) => ({ candidateId: uuid(10 + i), entryId: e.entryId, label: e.label, ordinal: i + 1, withdrawn: false, votes: 0, competitionRank: 1, finalist: false, winner: false })), evidence: {} };
      const o = operatorServer(() => closed, { results });
      const p = await loadPage({ html: OPERATOR, respond: o.respond, query: "", auth, session: ROUND_SESSION });
      const card = p.$("#noValidResult");
      expect(card?.textContent).toMatch(/ningún voto válido/);
      expect(card?.textContent).toMatch(/resolución explícita/);
      expect(card?.textContent).toMatch(/se conservan/);
      expect((p.$("#step-PUBLISH") as HTMLButtonElement).disabled).toBe(true);
      expect((p.$("#step-REVIEW") as HTMLButtonElement).disabled).toBe(true);
      expect(p.$$("#results tbody tr").map((tr) => tr.querySelectorAll("td")[3].textContent)).toEqual(["", ""]); // nobody is marked a winner
      const controls = p.$$("button").map((b) => `${b.id} ${b.textContent}`).join(" | ");
      expect(controls).not.toMatch(/cancel(ar)? (la )?final|reabrir|extender|elegir (al )?ganador|reopen|extend|pick/i);
      expect(o.seen.some((c) => c.url.endsWith("/operator/publish"))).toBe(false);
    });

    it("shows no such notice for a final that has a result", async () => {
      const entries = OVERVIEW().entries.map((e: Json) => ({ ...e, carried: true }));
      const closed = OVERVIEW({ roundRole: "FINAL", opened: true, closed: true, windowSeconds: 300, noValidResult: false, entries, schedule: null });
      const p = await loadPage({ html: OPERATOR, respond: operatorServer(() => closed, { results: { rows: [], evidence: {} } }).respond, query: "", auth, session: ROUND_SESSION });
      expect(p.$("#noValidResult")).toBeNull();
      expect((p.$("#step-REVIEW") as HTMLButtonElement).disabled).toBe(false);
    });

    it("offers no purge of photographs and states no retention period", async () => {
      const closed = OVERVIEW({ opened: true, closed: true });
      const p = await loadPage({ html: OPERATOR, respond: operatorServer(() => closed, { results: { rows: [], evidence: {} } }).respond, query: "", auth, session: ROUND_SESSION });
      expect(p.$("#purge")).toBeNull();
      expect(p.text()).not.toMatch(/72|retención|vencidas/i);
    });
  });

  it("never builds markup from server text and has no telephone, ballot or Instagram step", () => {
    expect(OPERATOR).not.toMatch(/innerHTML|outerHTML|insertAdjacentHTML|document\.write/);
    expect(OPERATOR).not.toMatch(/whatsapp|sms|twilio|instagram|phone|ballot/i);
    expect(OPERATOR).not.toMatch(/community-voting\/(ranked|instances)\//);
  });
});

// ============================================================ the public display

describe("public display", () => {
  function displayServer(over: { role?: "PRELIMINARY" | "FINAL"; phase?: string; remaining?: number | null; opensAt?: string | null; published?: boolean; results?: Json } = {}) {
    const calls: string[] = [];
    const respond: Responder = async (call) => {
      calls.push(call.url);
      const route = call.url.replace(PREFIX, "");
      if (route === "/slideshow") return { status: 200, json: { prompt: "Elige tu disfraz favorito.", rotationSeconds: 8, items: [{ alias: "1111", imageUrl: `${PREFIX}/photos/1111?v=full` }] } };
      if (route === "/info") return { status: 200, json: { info: { roundRole: over.role ?? "PRELIMINARY", phase: over.phase ?? "OPEN", votingOpensAt: over.opensAt ?? null, votingClosesAt: null, tentative: true, deadlineRemainingMs: over.remaining ?? null, published: !!over.published } } };
      if (route === "/results") return { status: 200, json: over.results ?? { published: false, items: [] } };
      return { status: 404, json: {} };
    };
    return { respond, calls };
  }

  it("rotates the shown contestants from the pilot's own routes, with only a number and a picture", async () => {
    const d = displayServer();
    const p = await loadPage({ html: DISPLAY, respond: d.respond });
    expect(d.calls.some((u) => u.startsWith(`${PREFIX}/slideshow`))).toBe(true);
    expect(d.calls.every((u) => u.startsWith(`/api/gaming/community-voting/rounds/${INSTANCE}/`))).toBe(true);
    expect(p.$("#prompt")?.textContent).toBe("Elige tu disfraz favorito.");
    expect(p.$("#when")?.textContent).toBe("Votación abierta");

    const scheduled = await loadPage({ html: DISPLAY, respond: displayServer({ phase: "NOT_OPEN", opensAt: "2026-11-01T02:30:00.000Z" }).respond });
    expect(scheduled.$("#when")?.textContent).toMatch(/programada para las 20:30 \(hora de Honduras\)/);
    expect(scheduled.$("#when")?.textContent).toMatch(/aún no está abierta/);
    expect(scheduled.$("#when")?.textContent).not.toMatch(/Votación abierta/);
    expect(["#number", "#prompt", "#when", "#empty"].map((sel) => p.$(sel)?.textContent ?? "").join(" ")).not.toMatch(/votos|puntos|ranking|total|\d+ voto/i);
  });

  it("shows the final's remaining time from the server, and the announcement after publication", async () => {
    const live = await loadPage({ html: DISPLAY, respond: displayServer({ role: "FINAL", remaining: 125_000 }).respond });
    expect(live.$("#when")?.textContent).toMatch(/Final abierta · quedan 2:0[45]/);
    const preliminary = await loadPage({ html: DISPLAY, respond: displayServer({ remaining: 5_400_000 }).respond });
    expect(preliminary.$("#when")?.textContent).toMatch(/Votación abierta · quedan 1:29:5\d|Votación abierta · quedan 1:30:00/);
    const done = await loadPage({ html: DISPLAY, respond: displayServer({ role: "FINAL", phase: "CLOSED", published: true, results: { published: true, kind: "WINNERS", items: [{ alias: "1111" }, { alias: "2222" }] } }).respond });
    expect(done.$("#when")?.textContent).toBe("Ganadores: #1111 · #2222");
    const finalists = await loadPage({ html: DISPLAY, respond: displayServer({ phase: "CLOSED", published: true, results: { published: true, kind: "FINALISTS", items: [{ alias: "3333" }] } }).respond });
    expect(finalists.$("#when")?.textContent).toBe("Finalistas: #3333");
  });

  it("refuses an invalid link without calling anything", async () => {
    const d = displayServer();
    const p = await loadPage({ html: DISPLAY, respond: d.respond, query: "?e=nope" });
    expect(p.$("#empty")?.textContent).toMatch(/Enlace de pantalla no válido/);
    expect(d.calls).toHaveLength(0);
  });
});

// ============================================================ UG-IV-GATE-007 — the three pending policies, as unapproved options

describe("operator tablet — the three pending policies are unapproved options until the operator records a decision (UG-IV-GATE-007)", () => {
  const auth = { status: "authenticated" as const };
  const POLICIES = [
    { key: "ZERO_VALID_VOTES_PRELIMINARY", value: "ALL_ENTRIES_ADVANCE", ifRecorded: /pasan a la final todas las participaciones que no se retiraron/, whilePending: /el corte de finalistas se rechaza/ },
    { key: "ZERO_VOTE_ENTRIES_AT_CUTOFF", value: "TIED_ZERO_VOTE_ENTRIES_ADVANCE", ifRecorded: /sin votos[\s\S]*avanzan a la final/, whilePending: /el corte de finalistas se rechaza/ },
    { key: "FINALIST_WITHDRAWAL_AFTER_SELECTION", value: "EXCLUDE_WITHOUT_REFILL", ifRecorded: /nadie ocupa su lugar/, whilePending: /no se prepara ni se abre la final/ },
  ] as const;
  type Page = Awaited<ReturnType<typeof loadPage>>;

  /** A server that holds the stored decisions: the overview shows what was recorded, and a POST records it the way the real route does (201). */
  function policyServer(stored: Record<string, { value: string; reference: string }> = {}, opts: { blocking?: string[]; postReply?: Reply } = {}) {
    const recorded: Record<string, { value: string; reference: string }> = { ...stored };
    const posts: Call[] = [];
    const overview = () => OVERVIEW({
      opened: true, closed: true,
      policies: POLICIES.map(({ key }) => (recorded[key] ? { key, approved: true, value: recorded[key].value, approvalReference: recorded[key].reference } : { key, approved: false, value: null, approvalReference: null })),
      pendingResolutions: (opts.blocking ?? []).filter((k) => !recorded[k]).map((key) => ({ key })),
    });
    const base = operatorServer(overview, { results: { rows: [], evidence: {} } });
    const respond: Responder = async (call) => {
      if (call.url.endsWith("/operator/policies")) {
        posts.push(call);
        const reply = opts.postReply ?? { status: 201, json: {} };
        if (reply.status === 201) recorded[call.body.policyKey] = { value: call.body.policyValue, reference: call.body.approvalReference };
        return reply;
      }
      return base.respond(call);
    };
    return { respond, posts, seen: base.seen };
  }
  const open = (s: ReturnType<typeof policyServer>) => loadPage({ html: OPERATOR, respond: s.respond, query: "", auth, session: ROUND_SESSION });
  const card = (p: Page, key: string) => p.$(`[data-policy="${key}"]`) as HTMLElement;
  const field = (el: HTMLElement, name: string) => el.querySelector(`[data-field="${name}"]`);
  const acknowledge = async (p: Page, key: string) => {
    const box = p.$(`#policy-ack-${key}`) as HTMLInputElement;
    box.checked = true;
    box.dispatchEvent(new p.win.Event("change", { bubbles: true }));
    await p.settle();
  };

  it("shows, for every pending policy, the exact key and value, what recording it does and what happens until then, its status, and that operator authority does not approve it", async () => {
    const p = await open(policyServer({}, { blocking: ["ZERO_VOTE_ENTRIES_AT_CUTOFF"] }));
    for (const policy of POLICIES) {
      const c = card(p, policy.key);
      expect(c.getAttribute("data-policy-state")).toBe("pending");
      expect(field(c, "key")?.textContent).toBe(policy.key);
      expect(field(c, "value")?.textContent).toBe(policy.value);
      expect(field(c, "status")?.textContent).toBe("Pendiente de aprobación del Founder");
      expect(field(c, "applies")?.textContent).toMatch(/Aplica solo si/);
      expect(field(c, "ifRecorded")?.textContent).toMatch(/^Si se registra: /);
      expect(field(c, "ifRecorded")?.textContent).toMatch(policy.ifRecorded);
      expect(field(c, "whilePending")?.textContent).toMatch(/^Mientras no se registre: /);
      expect(field(c, "whilePending")?.textContent).toMatch(policy.whilePending);
      const authority = field(c, "authority")?.textContent ?? "";
      expect(authority).toMatch(/no aprueba esta política/);
      expect(authority).toMatch(/la aprueba el Founder/);
      expect(authority).toMatch(/no puede verificar/);
      expect(p.$(`#policy-${policy.key}`)?.textContent).toBe("Registrar decisión aprobada");
      expect(c.textContent).not.toMatch(/[¿?]/); // statements, not a yes/no question
    }
    // only the policy that is holding an operation right now says so; that is separate from its approval status
    expect(field(card(p, "ZERO_VOTE_ENTRIES_AT_CUTOFF"), "blocking")?.textContent).toBe("Bloquea ahora");
    expect(field(card(p, "ZERO_VALID_VOTES_PRELIMINARY"), "blocking")).toBeNull();
    expect(p.$("#policiesCard h2")?.textContent).toBe("Políticas que requieren aprobación del Founder");
    expect(p.$("#policiesCard")?.textContent).toMatch(/no las preselecciona/);
  });

  it("does not preselect, fill in, tick or record anything by itself", async () => {
    const s = policyServer({}, { blocking: POLICIES.map((x) => x.key) });
    const p = await open(s);
    for (const { key } of POLICIES) {
      expect((p.$(`#policy-ack-${key}`) as HTMLInputElement).checked).toBe(false);
      expect((p.$(`#policy-ref-${key}`) as HTMLInputElement).value).toBe("");
    }
    await p.settle(200);
    expect(s.posts).toHaveLength(0);
    expect(p.modal()).toBe("");
    // pressing a step that is held by a policy does not record that policy either
    await p.click(p.$("#step-FINALISTS"));
    expect(s.posts).toHaveLength(0);
  });

  it("records nothing unless BOTH the acknowledgement and the decision reference are given, and says which one is missing", async () => {
    const key = "ZERO_VOTE_ENTRIES_AT_CUTOFF";
    const s = policyServer({}, { blocking: [key] });
    const p = await open(s);

    await p.click(p.$(`#policy-${key}`)); // neither
    expect(p.text()).toMatch(/Confirma que el Founder ya aprobó esta política con este valor exacto/);
    expect(p.modal()).toBe("");

    await p.type(p.$(`#policy-ref-${key}`), "ACTA-FOUNDER-12"); // the reference alone
    await p.click(p.$(`#policy-${key}`));
    expect(p.text()).toMatch(/Confirma que el Founder ya aprobó esta política con este valor exacto/);
    expect(p.modal()).toBe("");

    await p.type(p.$(`#policy-ref-${key}`), ""); // the acknowledgement alone
    await acknowledge(p, key);
    await p.click(p.$(`#policy-${key}`));
    expect(p.text()).toMatch(/Cita dónde consta la aprobación del Founder/);
    expect(p.modal()).toBe("");

    await p.type(p.$(`#policy-ref-${key}`), "ab"); // too short to be a reference
    await p.click(p.$(`#policy-${key}`));
    expect(p.text()).toMatch(/Cita dónde consta la aprobación del Founder/);
    expect(s.posts).toHaveLength(0);
  });

  it("asks for a last confirmation naming the key, the value, the reference and what the record is, sends nothing until it is confirmed, and sends exactly what the server expects", async () => {
    const key = "ZERO_VOTE_ENTRIES_AT_CUTOFF";
    const s = policyServer({}, { blocking: [key] });
    const p = await open(s);
    await p.type(p.$(`#policy-ref-${key}`), "ACTA-FOUNDER-12");
    await acknowledge(p, key);
    await p.click(p.$(`#policy-${key}`));
    const dialog = p.modal();
    expect(dialog).toContain(key);
    expect(dialog).toContain("TIED_ZERO_VOTE_ENTRIES_ADVANCE");
    expect(dialog).toContain("ACTA-FOUNDER-12");
    expect(dialog).toMatch(/constancia/);
    expect(dialog).toMatch(/no verifica/);
    expect(dialog).toMatch(/una sola vez y no se puede cambiar/);
    expect(p.$("#dialogConfirm")?.textContent).toBe("Registrar decisión aprobada");
    expect(s.posts).toHaveLength(0);

    await p.click(p.$("#dialogCancel")); // cancelling records nothing
    expect(s.posts).toHaveLength(0);
    expect(p.modal()).toBe("");

    await p.click(p.$(`#policy-${key}`));
    await p.click(p.$("#dialogConfirm"));
    expect(s.posts).toHaveLength(1);
    expect(s.posts[0].method).toBe("POST");
    expect(s.posts[0].body).toEqual({ policyKey: key, policyValue: "TIED_ZERO_VOTE_ENTRIES_ADVANCE", approvalReference: "ACTA-FOUNDER-12" });
    expect(p.text()).toMatch(/Constancia registrada por el operador/);
    expect(p.text()).toMatch(/revisión de los resultados debe hacerse de nuevo/);
  });

  it("after recording, shows the exact stored value and reference as the OPERATOR's record, and the other policies stay pending", async () => {
    const key = "ZERO_VOTE_ENTRIES_AT_CUTOFF";
    const s = policyServer({}, { blocking: [key] });
    const p = await open(s);
    await p.type(p.$(`#policy-ref-${key}`), "ACTA-FOUNDER-12");
    await acknowledge(p, key);
    await p.click(p.$(`#policy-${key}`));
    await p.click(p.$("#dialogConfirm"));

    const c = card(p, key);
    expect(c.getAttribute("data-policy-state")).toBe("recorded");
    expect(field(c, "status")?.textContent).toBe("Registrada por el operador");
    expect(field(c, "key")?.textContent).toBe(key);
    expect(field(c, "value")?.textContent).toBe("TIED_ZERO_VOTE_ENTRIES_ADVANCE");
    expect(field(c, "reference")?.textContent).toBe("ACTA-FOUNDER-12");
    expect(c.textContent).toMatch(/Referencia citada por el operador/);
    expect(field(c, "recordedNotice")?.textContent).toBe("Constancia registrada por el operador. La aplicación no verificó que el Founder haya aprobado este valor.");
    expect(p.$(`#policy-${key}`)).toBeNull(); // no way to record it again or change it
    expect(p.$(`#policy-ref-${key}`)).toBeNull();
    expect(p.$(`#policy-ack-${key}`)).toBeNull();
    for (const other of POLICIES.filter((x) => x.key !== key)) {
      expect(card(p, other.key).getAttribute("data-policy-state")).toBe("pending");
      expect(p.$(`#policy-${other.key}`)?.textContent).toBe("Registrar decisión aprobada");
    }
  });

  it("never describes a recorded decision as approved or verified by the application", async () => {
    const p = await open(policyServer({ ZERO_VALID_VOTES_PRELIMINARY: { value: "ALL_ENTRIES_ADVANCE", reference: "ACTA-1" } }));
    const c = card(p, "ZERO_VALID_VOTES_PRELIMINARY");
    expect(c.textContent).not.toMatch(/Pendiente de aprobación/);
    // no positive claim of approval or verification: the only "verificó" is the one that says the application did NOT
    expect(c.textContent).not.toMatch(/Decidida|\bAprobada\b|Aprobado por|aprobada por el Founder|(?<!no )verific/i);
    expect(c.textContent).toMatch(/no verificó que el Founder/);
    expect(field(c, "inForce")?.textContent).toMatch(/pasan a la final todas las participaciones que no se retiraron/);
  });

  it("shows whatever value the server holds, verbatim, and claims no effect for a value this page does not recognise", async () => {
    const p = await open(policyServer({ ZERO_VALID_VOTES_PRELIMINARY: { value: "SOME_OTHER_VALUE", reference: "ACTA-9" } }));
    const c = card(p, "ZERO_VALID_VOTES_PRELIMINARY");
    expect(field(c, "value")?.textContent).toBe("SOME_OTHER_VALUE");
    expect(field(c, "inForce")).toBeNull();
    expect(c.textContent).toMatch(/no verificó que el Founder/);
  });

  it("does not show a decision as recorded when the server refuses it", async () => {
    const key = "FINALIST_WITHDRAWAL_AFTER_SELECTION";
    const s = policyServer({}, { blocking: [key], postReply: { status: 403, json: { code: "OPERATOR_REQUIRED" } } });
    const p = await open(s);
    await p.type(p.$(`#policy-ref-${key}`), "ACTA-FOUNDER-30");
    await acknowledge(p, key);
    await p.click(p.$(`#policy-${key}`));
    await p.click(p.$("#dialogConfirm"));
    expect(s.posts).toHaveLength(1);
    expect(p.text()).toMatch(/operador designado/);
    expect(card(p, key).getAttribute("data-policy-state")).toBe("pending");
    expect(field(card(p, key), "status")?.textContent).toBe("Pendiente de aprobación del Founder");
    expect(p.text()).not.toMatch(/Constancia registrada por el operador\. La revisión/);
  });

  it("has exactly one place that records a policy, behind the confirmation, and keeps the old yes/no wording out of the page", () => {
    expect(OPERATOR.match(/\.policy\(/g)).toHaveLength(1);
    const at = OPERATOR.indexOf(".policy(");
    expect(OPERATOR.lastIndexOf("confirmDialog(", at)).toBeGreaterThan(OPERATOR.lastIndexOf("function renderPolicies", at));
    expect(OPERATOR).not.toMatch(/policyAcks\[[^\]]+\]\s*=\s*true/); // nothing sets an acknowledgement for the operator
    expect(OPERATOR).not.toMatch(/Registrar esta decisión/);
    expect(OPERATOR).not.toMatch(/Decisiones de Producto|decisión de Producto/);
  });
});
