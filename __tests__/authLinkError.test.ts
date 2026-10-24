import { afterEach, describe, expect, it, vi } from "vitest";
import { JSDOM } from "jsdom";
import { readFileSync } from "node:fs";
import path from "node:path";

/**
 * The shared sign-in component (public/urbanoAuth.js), the REAL file, evaluated in jsdom against a fake Supabase browser client and this
 * app's own config/member routes: no network, no credentials, no real mail.
 *
 * Covers the work of the Spanish-and-shell delivery that lives in this component:
 *  - a sign-in link that did not work (invalid, used or expired): a plain message in the chosen language, ONE explicit action to request a new
 *    code, nothing sent automatically, the Auth return data removed from the address bar, the person's other address parts untouched, only a
 *    sanitized error code ever kept and no token ever read, stored or logged;
 *  - the success return: the tokens are removed from the address bar only AFTER the client has read them, and the session flow is untouched;
 *  - the optional account link (name as a real link to the profile, replacing the button while signed in), the language of every label, and
 *    redrawing the panel in the other language without losing what was typed, closing the panel or sending anything;
 *  - getProfile: what Auth explicitly says about the email, and nothing inferred;
 *  - the additive `messageKey` on results, with the English `message` meaning kept for every existing consumer.
 */

const ROOT = process.cwd();
const SOURCE = readFileSync(path.join(ROOT, "public/urbanoAuth.js"), "utf8");
const I18N_SOURCE = readFileSync(path.join(ROOT, "public/urbanoI18n.js"), "utf8");
const CODE = "123456";
const SECRET_ACCESS = "SECRET-ACCESS-TOKEN-VALUE";
const SECRET_REFRESH = "SECRET-REFRESH-TOKEN-VALUE";

const closers: Array<() => void> = [];
afterEach(() => { while (closers.length) closers.pop()!(); vi.restoreAllMocks(); });

interface Options {
  url?: string;
  i18n?: boolean; // load the language module first (the page's own order)
  lang?: "es" | "en";
  accountLink?: boolean;
  statusLine?: boolean;
  session?: { email: string; emailConfirmedAt?: string | null | undefined; member?: { gamingMemberId: string; displayName: string; createdAt?: string } | null } | null;
  existingUsers?: string[];
  clientFails?: boolean; // the Supabase library cannot be loaded (the CDN is down)
}

function createHarness(options: Options = {}) {
  const dom = new JSDOM(
    `<!doctype html><html lang="es"><body><header id="hdr"><div id="group" class="account-group"><a id="account-link" href="/profile.html" hidden></a><button id="btn-signin">x</button></div><div id="lang"><button data-lang="es">ES</button><button data-lang="en">EN</button></div></header>${options.statusLine === false ? "" : '<p id="signin-status" style="display:none"></p>'}</body></html>`,
    { url: options.url ?? "http://localhost/", runScripts: "outside-only", pretendToBeVisual: true }
  );
  const win = dom.window as unknown as Window & Record<string, any>;
  closers.push(() => dom.window.close());
  const users = new Set(options.existingUsers ?? []);
  const state = {
    session: options.session
      ? { access_token: "token-" + options.session.email, user: { id: "uid-" + options.session.email, email: options.session.email, created_at: "2025-01-01T00:00:00Z", ...(options.session.emailConfirmedAt !== undefined ? { email_confirmed_at: options.session.emailConfirmedAt } : {}) } }
      : (null as null | { access_token: string; user: Record<string, any> }),
    otpCalls: [] as Array<Record<string, any>>,
    verifyCalls: [] as Array<Record<string, any>>,
    hashAtClientCreation: null as null | string,
    getSessionCalls: 0,
    memberGets: 0,
  };
  const listeners: Array<(event: string, session: unknown) => void> = [];
  const emit = (event: string) => listeners.slice().forEach((l) => l(event, state.session));
  const client = {
    auth: {
      onAuthStateChange(cb: (event: string, session: unknown) => void) { listeners.push(cb); return { data: { subscription: { unsubscribe() {} } } }; },
      async getSession() { state.getSessionCalls += 1; return { data: { session: state.session } }; },
      async signInWithOtp(payload: Record<string, any>) {
        state.otpCalls.push(JSON.parse(JSON.stringify(payload)));
        users.add(payload.email);
        return { data: {}, error: null };
      },
      async verifyOtp(payload: Record<string, any>) {
        state.verifyCalls.push(JSON.parse(JSON.stringify(payload)));
        if (payload.token !== CODE) return { data: { session: null, user: null }, error: { status: 403, code: "otp_expired", message: "Token has expired or is invalid" } };
        state.session = { access_token: "token-" + payload.email, user: { id: "uid-" + payload.email, email: payload.email, email_confirmed_at: "2026-10-01T00:00:00Z" } };
        emit("SIGNED_IN");
        return { data: { session: state.session, user: state.session.user }, error: null };
      },
      async signOut() { state.session = null; emit("SIGNED_OUT"); return { error: null }; },
    },
  };
  if (options.clientFails) {
    // No library on the page, and the script tag the component adds can never load.
    win.document.head.appendChild = ((node: any) => { setTimeout(() => node.onerror && node.onerror(new win.Event("error")), 0); return node; }) as any;
  } else {
    win.supabase = { createClient: () => { state.hashAtClientCreation = win.location.hash; return client; } };
  }
  win.fetch = (async (url: string, init?: Record<string, any>) => {
    const target = String(url);
    if (target === "/api/gaming/config") return { ok: true, status: 200, json: async () => ({ supabaseUrl: "http://stack.local", supabaseAnonKey: "anon-key" }) };
    if (target === "/api/gaming/auth-methods") return { ok: true, status: 200, json: async () => ({ email: true, phone: false }) };
    if (target === "/api/gaming/member") {
      if (init?.method === "POST") {
        const name = JSON.parse(init.body).displayName as string;
        return { ok: true, status: 200, json: async () => ({ gamingMember: { gamingMemberId: "gm-new", displayName: name } }) };
      }
      state.memberGets += 1;
      return { ok: true, status: 200, json: async () => ({ gamingMember: state.session ? (options.session?.member === undefined ? { gamingMemberId: "gm-1", displayName: "Ana" } : options.session.member) : null }) };
    }
    return { ok: false, status: 404, json: async () => ({}) };
  }) as unknown as typeof fetch;

  if (options.i18n) {
    if (options.lang) win.localStorage.setItem("urbano.lang", options.lang);
    win.eval(I18N_SOURCE);
  }
  win.eval(`${SOURCE}\nwindow.UrbanoAuth = UrbanoAuth;`);

  const doc = win.document;
  const auth = win.UrbanoAuth as Record<string, any>;
  const header = () => doc.getElementById("btn-signin") as HTMLButtonElement;
  const accountLink = () => doc.getElementById("account-link") as HTMLAnchorElement;
  const status = () => doc.getElementById("signin-status") as HTMLElement | null;
  const panel = () => doc.querySelector("[data-urbano-signin-panel]") as HTMLElement;
  const q = (selector: string) => panel().querySelector(selector) as HTMLElement | null;
  const flush = async (n = 12) => { for (let i = 0; i < n; i += 1) await new Promise((r) => setTimeout(r, 0)); };
  const type = (selector: string, value: string) => { const el = q(selector) as HTMLInputElement; el.value = value; el.dispatchEvent(new win.Event("input", { bubbles: true })); };
  const click = async (selector: string) => { const el = q(selector); if (!el) throw new Error(`no ${selector}: ${panel().textContent}`); el.click(); await flush(); };
  const lang = async (code: "es" | "en") => { (doc.querySelector(`[data-lang="${code}"]`) as HTMLElement).click(); await flush(); };

  auth.attachSignInButton(header(), status(), options.accountLink ? { accountLink: accountLink() } : undefined);
  return { win, doc, auth, state, header, accountLink, status, panel, q, flush, type, click, lang };
}

const LINK_ERROR_HASH = "#error=access_denied&error_code=otp_expired&error_description=Email+link+is+invalid+or+has+expired";
const ES_MESSAGE = "Este enlace de acceso no es válido, ya se usó o venció. Pedí uno nuevo para iniciar sesión.";
const EN_MESSAGE = "This sign-in link isn't valid, was already used, or has expired. Request a new one to sign in.";

describe("a sign-in link that did not work (invalid, already used or expired)", () => {
  it("shows a plain Spanish message and ONE explicit action; sends nothing; the Auth error data leaves the address bar", async () => {
    const h = createHarness({ url: `http://localhost/${LINK_ERROR_HASH}`, i18n: true });
    await h.flush();
    const line = h.status()!;
    expect(line.style.display).toBe("block");
    expect(line.getAttribute("role")).toBe("alert");
    expect(line.querySelector("[data-link-error-text]")!.textContent).toBe(ES_MESSAGE);
    const retry = line.querySelector("[data-link-error-retry]") as HTMLButtonElement;
    expect(retry.textContent).toBe("Pedir un código nuevo");
    expect(retry.type).toBe("button");
    expect(h.win.location.href).toBe("http://localhost/"); // nothing of the Auth return is left in the address bar
    expect(h.win.location.hash).toBe("");
    expect(h.state.otpCalls).toHaveLength(0); // nothing was requested for the person
    expect(h.state.verifyCalls).toHaveLength(0);
  });

  it("the action only OPENS the log-in panel at the email step; a code is requested only when the person asks for it", async () => {
    const h = createHarness({ url: `http://localhost/${LINK_ERROR_HASH}`, i18n: true });
    await h.flush();
    (h.status()!.querySelector("[data-link-error-retry]") as HTMLElement).click();
    await h.flush();
    expect(h.panel().style.display).toBe("block");
    expect(h.q("[data-contact]")).not.toBeNull();
    expect(h.q("[data-send]")!.textContent).toBe("Enviar código de acceso"); // the log-in path, never creating an account
    expect(h.state.otpCalls).toHaveLength(0);
    h.type("[data-contact]", "ana@example.com");
    await h.click("[data-send]");
    expect(h.state.otpCalls).toEqual([{ email: "ana@example.com", options: { shouldCreateUser: false } }]);
  });

  it("without the language module the same message and action appear in English (every existing consumer keeps working)", async () => {
    const h = createHarness({ url: `http://localhost/${LINK_ERROR_HASH}`, i18n: false });
    await h.flush();
    expect(h.status()!.querySelector("[data-link-error-text]")!.textContent).toBe(EN_MESSAGE);
    expect(h.status()!.querySelector("[data-link-error-retry]")!.textContent).toBe("Request a new code");
  });

  it("changing language re-translates the message and the action in place", async () => {
    const h = createHarness({ url: `http://localhost/${LINK_ERROR_HASH}`, i18n: true });
    await h.flush();
    await h.lang("en");
    expect(h.status()!.querySelector("[data-link-error-text]")!.textContent).toBe(EN_MESSAGE);
    expect(h.status()!.querySelector("[data-link-error-retry]")!.textContent).toBe("Request a new code");
    await h.lang("es");
    expect(h.status()!.querySelector("[data-link-error-text]")!.textContent).toBe(ES_MESSAGE);
  });

  it("even when the Auth client cannot be loaded at all, the message still appears and the error data still leaves the address bar", async () => {
    const h = createHarness({ url: `http://localhost/?tab=1${LINK_ERROR_HASH}`, i18n: true, clientFails: true });
    await h.flush(30);
    expect(h.win.location.href).toBe("http://localhost/?tab=1");
    expect(h.status()!.querySelector("[data-link-error-text]")!.textContent).toBe(ES_MESSAGE);
    expect(h.state.otpCalls).toHaveLength(0);
  });

  it("only a sanitized error code is ever kept: Auth's own description is never shown, whatever it says", async () => {
    const hostile = "<img src=x onerror=alert(1)>";
    const h = createHarness({ url: `http://localhost/#error=access_denied&error_code=${encodeURIComponent("<script>")}&error_description=${encodeURIComponent(hostile)}`, i18n: true });
    await h.flush();
    expect(h.status()!.textContent).not.toContain("onerror");
    expect(h.status()!.textContent).not.toContain(hostile);
    expect(h.status()!.querySelector("img")).toBeNull();
    expect(h.status()!.querySelector("[data-link-error-text]")!.textContent).toBe(ES_MESSAGE); // an unrecognised code still gets the same plain message
  });

  it("other parts of the address survive: an in-page anchor, the path and other query values", async () => {
    const a = createHarness({ url: "http://localhost/soccer-predictions.html?match=m1#play&error=access_denied&error_code=otp_expired", i18n: true });
    await a.flush();
    expect(a.win.location.href).toBe("http://localhost/soccer-predictions.html?match=m1#play");
    const b = createHarness({ url: "http://localhost/?error_code=otp_expired&error=access_denied&tab=1", i18n: true });
    await b.flush();
    expect(b.win.location.href).toBe("http://localhost/?tab=1");
    expect(b.status()!.querySelector("[data-link-error-text]")).not.toBeNull();
  });

  it("an address that is not an Auth error is left alone, and shows no message", async () => {
    for (const url of ["http://localhost/#play", "http://localhost/?tab=1#error_description=only-a-description", "http://localhost/"]) {
      const h = createHarness({ url, i18n: true });
      await h.flush();
      expect(h.win.location.href, url).toBe(url);
      expect(h.status()!.style.display, url).toBe("none");
      expect(h.status()!.querySelector("[data-link-error-text]"), url).toBeNull();
    }
  });

  it("a page with no status line still shows the message (at the top of the page)", async () => {
    const h = createHarness({ url: `http://localhost/${LINK_ERROR_HASH}`, i18n: true, statusLine: false });
    await h.flush();
    const line = h.doc.querySelector("[data-urbano-link-error]") as HTMLElement;
    expect(line.getAttribute("role")).toBe("alert");
    expect(line.querySelector("[data-link-error-text]")!.textContent).toBe(ES_MESSAGE);
    expect(h.doc.body.firstElementChild).toBe(line);
  });

  it("a person who is already signed in is not shown a message about a link, and nothing is requested", async () => {
    const h = createHarness({ url: `http://localhost/${LINK_ERROR_HASH}`, i18n: true, session: { email: "ana@example.com", emailConfirmedAt: "2026-09-01T00:00:00Z" } });
    await h.flush();
    expect(h.status()!.style.display).toBe("none");
    expect(h.state.otpCalls).toHaveLength(0);
  });

  it("the message goes away once the person signs in with a code", async () => {
    const h = createHarness({ url: `http://localhost/${LINK_ERROR_HASH}`, i18n: true, existingUsers: ["ana@example.com"] });
    await h.flush();
    (h.status()!.querySelector("[data-link-error-retry]") as HTMLElement).click();
    await h.flush();
    h.type("[data-contact]", "ana@example.com");
    await h.click("[data-send]");
    h.type("[data-code]", CODE);
    await h.click("[data-verify]");
    await h.flush();
    expect(h.status()!.style.display).toBe("none");
  });

  it("no token and no Auth return data is ever logged", async () => {
    const spies = (["log", "info", "warn", "error", "debug"] as const).map((m) => vi.spyOn(console, m).mockImplementation(() => {}));
    const h = createHarness({ url: `http://localhost/${LINK_ERROR_HASH}`, i18n: true });
    await h.flush();
    const logged = JSON.stringify(spies.flatMap((s) => s.mock.calls));
    expect(logged).not.toMatch(/otp_expired|access_denied|Email\+link|error_description/);
  });
});

describe("a link that worked: the session flow is untouched and the tokens do not stay in the address bar", () => {
  const OK_URL = `http://localhost/#play&access_token=${SECRET_ACCESS}&refresh_token=${SECRET_REFRESH}&expires_in=3600&token_type=bearer&type=magiclink`;

  it("the client reads the return data FIRST (the address still holds it when the client is created); only afterwards is it removed", async () => {
    const h = createHarness({ url: OK_URL, i18n: true, session: { email: "ana@example.com", emailConfirmedAt: "2026-09-01T00:00:00Z" } });
    await h.flush();
    expect(h.state.hashAtClientCreation).toContain(`access_token=${SECRET_ACCESS}`);
    expect(h.state.getSessionCalls).toBeGreaterThan(0);
    expect(h.win.location.href).toBe("http://localhost/#play");
    expect(h.win.location.href).not.toContain(SECRET_ACCESS);
    expect(h.win.location.href).not.toContain(SECRET_REFRESH);
  });

  it("no token is logged, shown or stored by this component", async () => {
    const spies = (["log", "info", "warn", "error", "debug"] as const).map((m) => vi.spyOn(console, m).mockImplementation(() => {}));
    const h = createHarness({ url: OK_URL, i18n: true, session: { email: "ana@example.com", emailConfirmedAt: "2026-09-01T00:00:00Z" } });
    await h.flush();
    expect(JSON.stringify(spies.flatMap((s) => s.mock.calls))).not.toContain("SECRET-");
    expect(h.doc.body.textContent).not.toContain("SECRET-");
    expect(JSON.stringify(Object.entries(h.win.localStorage))).not.toContain("SECRET-");
    expect(JSON.stringify(Object.entries(h.win.sessionStorage))).not.toContain("SECRET-");
    expect(h.header().textContent).toBe("Hola, Ana"); // the member resolved, the person is signed in
  });

  it("an address with no Auth return data is never rewritten", async () => {
    const replace = vi.fn();
    const h = createHarness({ url: "http://localhost/?x=1#play", i18n: true, session: { email: "ana@example.com" } });
    h.win.history.replaceState = replace;
    await h.flush();
    expect(h.win.location.href).toBe("http://localhost/?x=1#play");
  });
});

describe("the account link: the name is a real link to the profile while someone is signed in", () => {
  const SIGNED_IN: Options = { i18n: true, accountLink: true, session: { email: "ana@example.com", emailConfirmedAt: "2026-09-01T00:00:00Z" } };

  it("signed in: 'Hola, Ana' as a link (the button is hidden), with Cerrar sesión beside it, in one group", async () => {
    const h = createHarness(SIGNED_IN);
    await h.flush();
    const link = h.accountLink();
    expect(link.hidden).toBe(false);
    expect(link.textContent).toBe("Hola, Ana");
    expect(link.getAttribute("href")).toBe("/profile.html"); // the page's own address, untouched
    expect(link.getAttribute("title")).toBe("Ver mi perfil");
    expect(h.header().style.display).toBe("none");
    const signOut = h.doc.querySelector("[data-urbano-signout]") as HTMLElement;
    expect(signOut.textContent).toBe("Cerrar sesión");
    expect(signOut.style.display).toBe("inline");
    expect(Array.from(h.doc.getElementById("group")!.children).map((c) => c.id || c.tagName.toLowerCase())).toEqual(["account-link", "btn-signin", "a", "div"]);
  });

  it("changing language relabels the link and Sign out", async () => {
    const h = createHarness(SIGNED_IN);
    await h.flush();
    await h.lang("en");
    expect(h.accountLink().textContent).toBe("Hi, Ana");
    expect(h.accountLink().getAttribute("title")).toBe("View my profile");
    expect(h.doc.querySelector("[data-urbano-signout]")!.textContent).toBe("Sign out");
  });

  it("signing out hides the link and brings the log-in button back, in the chosen language", async () => {
    const h = createHarness(SIGNED_IN);
    await h.flush();
    (h.doc.querySelector("[data-urbano-signout]") as HTMLElement).click();
    await h.flush();
    expect(h.accountLink().hidden).toBe(true);
    expect(h.header().style.display).toBe("");
    expect(h.header().textContent).toBe("Iniciar sesión / Crear cuenta");
    expect(h.doc.querySelector<HTMLElement>("[data-urbano-signout]")!.style.display).toBe("none");
  });

  it("the name is text: a hostile display name creates no element", async () => {
    const h = createHarness({ ...SIGNED_IN, session: { email: "ana@example.com", member: { gamingMemberId: "gm-1", displayName: "<img src=x onerror=alert(1)>" } } });
    await h.flush();
    expect(h.accountLink().querySelector("img")).toBeNull();
    expect(h.accountLink().textContent).toContain("<img");
  });

  it("without the option nothing changes: the button itself says 'Hola, Ana' and there is no link", async () => {
    const h = createHarness({ i18n: true, accountLink: false, session: { email: "ana@example.com" } });
    await h.flush();
    expect(h.header().textContent).toBe("Hola, Ana");
    expect(h.header().style.display).not.toBe("none");
    expect(h.accountLink().hidden).toBe(true);
  });

  it("without the language module the English labels are exactly as before", async () => {
    const h = createHarness({ i18n: false, accountLink: false, session: { email: "ana@example.com" } });
    await h.flush();
    expect(h.header().textContent).toBe("Hi, Ana");
    expect(h.doc.querySelector("[data-urbano-signout]")!.textContent).toBe("Sign out");
  });
});

describe("the panel in the other language: nothing typed is lost, nothing closes, nothing is sent", () => {
  it("method step: the typed address survives, every label changes, and the language buttons do not count as an outside click", async () => {
    const h = createHarness({ i18n: true });
    await h.flush();
    h.header().click();
    await h.flush();
    expect(h.panel().textContent).toContain("Entrá a URBANO");
    await h.click("[data-choose-login]");
    h.type("[data-contact]", "ana@example.com");
    await h.lang("en");
    expect(h.panel().style.display).toBe("block");
    expect((h.q("[data-contact]") as HTMLInputElement).value).toBe("ana@example.com");
    expect(h.q("[data-send]")!.textContent).toBe("Send login code");
    expect(h.panel().textContent).toContain("Log in");
    expect(h.panel().getAttribute("aria-label")).toBe("Log in or create an account");
    expect(h.header().textContent).toBe("Log in / Create account");
    expect(h.state.otpCalls).toHaveLength(0);
  });

  it("a validation message is redrawn in the new language (it was stored as a key, not as text)", async () => {
    const h = createHarness({ i18n: true });
    await h.flush();
    h.header().click();
    await h.flush();
    await h.click("[data-choose-login]");
    h.type("[data-contact]", "not-an-email");
    await h.click("[data-send]");
    expect(h.q("[data-msg]")!.textContent).toBe("Eso no parece un correo electrónico. Revisalo e intentá de nuevo.");
    await h.lang("en");
    expect(h.q("[data-msg]")!.textContent).toBe("That doesn't look like an email address. Check it and try again.");
  });

  it("code step: the partly typed code survives, the wording changes, and no second code is requested", async () => {
    const h = createHarness({ i18n: true, existingUsers: ["ana@example.com"] });
    await h.flush();
    h.header().click();
    await h.flush();
    await h.click("[data-choose-login]");
    h.type("[data-contact]", "ana@example.com");
    await h.click("[data-send]");
    expect(h.state.otpCalls).toHaveLength(1);
    expect(h.panel().textContent).toContain("Si ana@example.com tiene una cuenta");
    h.type("[data-code]", "12 34");
    await h.lang("en");
    expect((h.q("[data-code]") as HTMLInputElement).value).toBe("12 34");
    expect(h.panel().textContent).toContain("If ana@example.com has an account");
    expect(h.q("[data-verify]")!.textContent).toBe("Verify");
    expect(h.q("[data-resend]")!.textContent).toMatch(/^Resend code in \d+s$/);
    expect(h.state.otpCalls).toHaveLength(1);
    expect(h.panel().style.display).toBe("block");
  });
});

describe("getProfile: only what Auth and the member route say", () => {
  it("authenticated: name, email, join date, and the verification state exactly as Auth reports it", async () => {
    const make = (emailConfirmedAt: string | null | undefined) => createHarness({ i18n: true, session: { email: "ana@example.com", emailConfirmedAt, member: { gamingMemberId: "gm-1", displayName: "Ana", createdAt: "2026-09-02T15:30:00.000Z" } } });
    const verified = await make("2026-09-01T00:00:00Z").auth.getProfile();
    expect(verified).toEqual({ status: "authenticated", email: "ana@example.com", emailVerified: true, displayName: "Ana", gamingMemberId: "gm-1", memberSince: "2026-09-02T15:30:00.000Z" });
    expect((await make(null).auth.getProfile()).emailVerified).toBe(false);
    expect((await make(undefined).auth.getProfile()).emailVerified).toBeNull(); // Auth did not say: not guessed, not assumed from the session
  });

  it("the join date is null when the member route does not return one (never taken from the Auth account)", async () => {
    const h = createHarness({ i18n: true, session: { email: "ana@example.com", emailConfirmedAt: "2026-09-01T00:00:00Z", member: { gamingMemberId: "gm-1", displayName: "Ana" } } });
    expect((await h.auth.getProfile()).memberSince).toBeNull();
    const junk = createHarness({ i18n: true, session: { email: "ana@example.com", member: { gamingMemberId: "gm-1", displayName: "Ana", createdAt: "not a date" } } });
    expect((await junk.auth.getProfile()).memberSince).toBeNull();
  });

  it("no session and an unfinished account", async () => {
    expect(await createHarness({ i18n: true }).auth.getProfile()).toEqual({ status: "unauthenticated" });
    const incomplete = await createHarness({ i18n: true, session: { email: "x@example.com", emailConfirmedAt: "2026-09-01T00:00:00Z", member: null } }).auth.getProfile();
    expect(incomplete).toEqual({ status: "profile_incomplete", email: "x@example.com", emailVerified: true });
  });

  it("getState keeps its original shape (the profile facts are not added to it)", async () => {
    const h = createHarness({ i18n: true, session: { email: "ana@example.com", emailConfirmedAt: "2026-09-01T00:00:00Z", member: { gamingMemberId: "gm-1", displayName: "Ana", createdAt: "2026-09-02T15:30:00.000Z" } } });
    expect(Object.keys(await h.auth.getState()).sort()).toEqual(["authUserId", "displayName", "email", "gamingMemberId", "status"]);
  });
});

describe("results keep their English `message` meaning and gain an additive `messageKey`", () => {
  it("without the language module: the same English message as before, plus the key", async () => {
    const h = createHarness({ i18n: false });
    expect(h.auth.normalizePhone("")).toMatchObject({ ok: false, messageKey: "auth.msg.phoneEmpty", message: "Enter your phone number with its country code, for example +504 9999 9999." });
    expect(h.auth.classifyAuthError({ code: "otp_expired" }, "verify", "login", "email")).toMatchObject({ kind: "code_invalid", messageKey: "auth.err.codeInvalid", message: "That code isn't valid or has expired. Check the code, or send a new one." });
    expect(h.auth.classifyAuthError({ status: 429, message: "after 30 seconds" }, "request", "login", "email")).toMatchObject({ kind: "rate_limited", retryAfterSeconds: 30, messageKey: "auth.err.rateLimited", messageVars: { seconds: 30 }, message: "Too many requests. Please wait 30 seconds and try again." });
  });

  it("with the language module the message follows the language and the key stays the same", async () => {
    const h = createHarness({ i18n: true });
    const result = h.auth.classifyAuthError({ code: "otp_expired" }, "verify", "login", "email");
    expect(result.messageKey).toBe("auth.err.codeInvalid");
    expect(result.message).toBe("Ese código no es válido o venció. Revisá el código o pedí uno nuevo.");
  });
});
