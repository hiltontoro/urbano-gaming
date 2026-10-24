import { afterEach, describe, expect, it, vi } from "vitest";
import { JSDOM } from "jsdom";
import { readFileSync } from "node:fs";
import path from "node:path";

/**
 * The read-only member profile (public/profile.html), parsed and run whole in jsdom with the REAL shipped language module and a stubbed
 * sign-in component. No network, no credentials.
 *
 * Proves: what the profile shows (name, email, the explicit verification state, the join date when the member route returns one, the link to
 * "Mis predicciones"); that email verification is never inferred from having a session; that nothing is shown without a session, after
 * signing out, or for a previous person while a new one loads (including a slow answer that arrives late); that the future features are
 * "Próximamente" with NO form, input or button; that no XP, points or prize appears; that stored text is never parsed as HTML; and that the
 * page follows the language in place.
 */

const ROOT = process.cwd();
const HTML = readFileSync(path.join(ROOT, "public/profile.html"), "utf8");
const I18N_SOURCE = readFileSync(path.join(ROOT, "public/urbanoI18n.js"), "utf8");
const HOSTILE = '<img src=x onerror="window.__xss=(window.__xss||0)+1">';

const tick = (ms = 20) => new Promise((r) => setTimeout(r, ms));
const closers: Array<() => void> = [];
afterEach(() => { while (closers.length) closers.pop()!(); vi.restoreAllMocks(); });

type Profile = Record<string, unknown>;
const ANA: Profile = { status: "authenticated", email: "ana@example.com", emailVerified: true, displayName: "Ana", gamingMemberId: "gm-ana", memberSince: "2026-09-02T15:30:00.000Z" };

async function loadProfile(first: Profile | Promise<Profile> | (() => Promise<Profile>), opts: { lang?: "es" | "en" } = {}) {
  const calls = { getProfile: 0, openSignIn: [] as unknown[], attach: [] as Array<{ button: any; status: any; options: any }> };
  const identity: { callbacks: Array<(s: unknown) => void> } = { callbacks: [] };
  const queue: Array<Profile | Promise<Profile> | (() => Promise<Profile>)> = [first];
  let lookups = 0; // the Nth lookup gets the Nth queued answer (the last one repeats)
  const dom = new JSDOM(HTML, {
    url: "http://localhost/profile.html", runScripts: "dangerously", pretendToBeVisual: true,
    beforeParse(window) {
      const w = window as any;
      if (opts.lang) window.localStorage.setItem("urbano.lang", opts.lang);
      w.eval(I18N_SOURCE);
      w.UrbanoAuth = {
        attachSignInButton: (button: any, status: any, options: any) => { calls.attach.push({ button, status, options }); },
        getProfile: () => {
          calls.getProfile += 1;
          const next = queue[Math.min(lookups, queue.length - 1)];
          lookups += 1;
          return typeof next === "function" ? next() : Promise.resolve(next);
        },
        onIdentityChange: async (cb: (s: unknown) => void) => { identity.callbacks.push(cb); return () => {}; },
        openSignIn: (o?: unknown) => { calls.openSignIn.push(o ?? null); return true; },
      };
    },
  });
  closers.push(() => dom.window.close());
  const win = dom.window as any;
  const doc = win.document as Document;
  await tick();
  const body = () => doc.getElementById("profile-body")!;
  const text = () => (body().textContent ?? "").replace(/\s+/g, " ").trim();
  return {
    win, doc, calls, identity, body, text,
    next: (p: Profile | Promise<Profile> | (() => Promise<Profile>)) => { queue.push(p); },
    changeIdentity: async (state: unknown = {}) => { identity.callbacks.forEach((cb) => cb(state)); await tick(); },
    en: () => (doc.querySelector('[data-lang="en"]') as HTMLElement).click(),
  };
}

describe("an authenticated member sees exactly what the identity already provides", () => {
  it("name, email with its explicit verification state, the join date, and the link to Mis predicciones — in Spanish", async () => {
    const page = await loadProfile(ANA);
    const rows = Array.from(page.doc.querySelectorAll(".profile-fields .row")).map((r) => [r.querySelector("dt")!.textContent, (r.querySelector("dd")!.textContent ?? "").replace(/\s+/g, " ").trim()]);
    expect(rows).toEqual([
      ["Nombre", "Ana"],
      ["Correo", "ana@example.com Verificado"], // the address, a real space, then the explicit state
      ["Miembro desde", new Date("2026-09-02T15:30:00.000Z").toLocaleDateString("es-HN", { year: "numeric", month: "long", day: "numeric", timeZone: "America/Tegucigalpa" })],
    ]);
    const link = page.doc.querySelector("a.link-out") as HTMLAnchorElement;
    expect(link.textContent).toBe("Mis predicciones en URBANO Score →");
    expect(link.getAttribute("href")).toBe("/soccer-predictions.html");
    expect(page.doc.querySelector("h1")!.textContent).toBe("Mi perfil");
    expect(page.doc.documentElement.lang).toBe("es");
  });

  it("email verification comes ONLY from Auth's explicit answer: verified, explicitly not verified, or 'No disponible' — never guessed from the session", async () => {
    const verified = await loadProfile({ ...ANA, emailVerified: true });
    expect(verified.doc.querySelector("[data-profile-email-status]")!.textContent).toBe("Verificado");
    expect(verified.doc.querySelector("[data-profile-email-status]")!.className).toContain("good");
    const notVerified = await loadProfile({ ...ANA, emailVerified: false });
    expect(notVerified.doc.querySelector("[data-profile-email-status]")!.textContent).toBe("Sin verificar");
    expect(notVerified.doc.querySelector("[data-profile-email-status]")!.className).not.toContain("good");
    const unknown = await loadProfile({ ...ANA, emailVerified: null });
    expect(unknown.doc.querySelector("[data-profile-email-status]")!.textContent).toBe("No disponible");
    expect(unknown.doc.querySelector("[data-profile-email-status]")!.className).not.toContain("good");
    // The state is never conveyed by colour alone: every state has its own word.
    expect(new Set([verified, notVerified, unknown].map((p) => p.doc.querySelector("[data-profile-email-status]")!.textContent)).size).toBe(3);
  });

  it("the join date is shown only when the member route returned it; otherwise 'No disponible' (never taken from somewhere else)", async () => {
    const page = await loadProfile({ ...ANA, memberSince: null });
    const since = Array.from(page.doc.querySelectorAll(".profile-fields .row")).find((r) => r.querySelector("dt")!.textContent === "Miembro desde")!;
    expect(since.querySelector("dd")!.textContent).toBe("No disponible");
  });

  it("follows the language in place (same nodes), date included", async () => {
    const page = await loadProfile(ANA);
    const dd = page.doc.querySelector("[data-since]")!;
    page.en();
    expect(page.doc.querySelector("[data-since]")).toBe(dd);
    expect(dd.textContent).toBe(new Date("2026-09-02T15:30:00.000Z").toLocaleDateString("en-US", { year: "numeric", month: "long", day: "numeric", timeZone: "America/Tegucigalpa" }));
    expect(page.doc.querySelector("h1")!.textContent).toBe("My profile");
    expect(page.doc.querySelector("a.link-out")!.textContent).toBe("My predictions in URBANO Score →");
    expect(page.doc.querySelector("[data-profile-email-status]")!.textContent).toBe("Verified");
  });

  it("stored text is inserted as text, never parsed: a hostile name and email create no element and run nothing", async () => {
    const page = await loadProfile({ ...ANA, displayName: HOSTILE, email: HOSTILE });
    expect(page.doc.querySelector("img")?.getAttribute("src")).not.toBe("x");
    expect(page.doc.querySelectorAll("#profile-body img")).toHaveLength(0);
    expect(page.text()).toContain(HOSTILE);
    expect(page.win.__xss).toBeUndefined();
  });

  it("an extremely long name stays inside its row (it wraps; the page never gets wider)", async () => {
    const page = await loadProfile({ ...ANA, displayName: "W".repeat(40) });
    const css = HTML.slice(HTML.indexOf("<style>"), HTML.indexOf("</style>"));
    expect(css).toMatch(/\.profile-fields dd\s*\{[^}]*overflow-wrap:\s*anywhere/);
    expect(css).toMatch(/\.profile-fields\s*\{[^}]*minmax\(0,\s*1fr\)/);
    expect(page.text()).toContain("W".repeat(40));
  });
});

describe("read-only: the future features are Próximamente and nothing pretends to work", () => {
  it("name editing, password, avatar and verified phone are listed as 'Próximamente', with no form, input, select, textarea or button anywhere in the profile", async () => {
    const page = await loadProfile(ANA);
    const items = Array.from(page.doc.querySelectorAll(".soon-list li")).map((li) => [li.firstElementChild!.textContent, li.lastElementChild!.textContent, li.getAttribute("aria-disabled")]);
    expect(items).toEqual([
      ["Nombre editable", "Próximamente", "true"], ["Contraseña", "Próximamente", "true"], ["Avatar", "Próximamente", "true"], ["Teléfono verificado", "Próximamente", "true"],
    ]);
    expect(page.body().querySelectorAll("form, input, select, textarea, button")).toHaveLength(0);
    expect(page.text()).toContain("Por ahora tu perfil es de solo lectura.");
    page.en();
    expect(Array.from(page.doc.querySelectorAll(".soon-list li")).map((li) => li.firstElementChild!.textContent)).toEqual(["Editable name", "Password", "Avatar", "Verified phone"]);
  });

  it("no XP, points, ranking or prize appears on the profile, and no new member system is created (the page only reads)", async () => {
    const page = await loadProfile(ANA);
    expect(page.text()).not.toMatch(/\bXP\b|puntos|points|premio|prize|ranking|rango|nivel|level/i);
    const script = HTML.slice(HTML.lastIndexOf("<script>"));
    expect(script).not.toMatch(/fetch\(|XMLHttpRequest|localStorage|sessionStorage|completeProfile|signOut|requestCode|verifyCode/); // reads through the shared component only
    expect(page.calls.getProfile).toBe(1);
  });
});

describe("without a session, after signing out, and when the person changes", () => {
  it("no session: no personal data, a sign-in prompt, and one explicit action that only OPENS the log-in panel", async () => {
    const page = await loadProfile({ status: "unauthenticated" });
    expect(page.body().querySelector("p.msg")!.textContent).toBe("Iniciá sesión para ver tu perfil.");
    expect(page.body().querySelector("button")!.textContent).toBe("Iniciar sesión");
    expect(page.doc.querySelector(".profile-fields")).toBeNull();
    expect(page.calls.openSignIn).toEqual([]); // nothing opens by itself
    (page.body().querySelector("button") as HTMLButtonElement).click();
    expect(page.calls.openSignIn).toEqual([{ mode: "login" }]);
  });

  it("an unfinished account is told to finish it (and sees no profile data)", async () => {
    const page = await loadProfile({ status: "profile_incomplete", email: "x@example.com", emailVerified: true });
    expect(page.text()).toContain("Terminá de crear tu cuenta para ver tu perfil.");
    expect(page.text()).not.toContain("x@example.com");
    (page.body().querySelector("button") as HTMLButtonElement).click();
    expect(page.calls.openSignIn).toEqual([null]);
  });

  it("signing out clears every trace of the person at once, before anything else is fetched", async () => {
    const page = await loadProfile(ANA);
    expect(page.text()).toContain("ana@example.com");
    let release!: (p: Profile) => void;
    page.next(() => new Promise<Profile>((r) => { release = r; })); // the next lookup is slow
    await page.changeIdentity({ status: "unauthenticated" });
    expect(page.text()).not.toContain("ana@example.com");
    expect(page.text()).not.toContain("Ana");
    expect(page.text()).toBe("Cargando tu perfil…");
    release({ status: "unauthenticated" });
    await tick();
    expect(page.text()).toContain("Iniciá sesión para ver tu perfil.");
    expect(page.text()).not.toContain("ana@example.com");
  });

  it("a different person: nothing of the previous one survives, and a LATE answer for the previous person is dropped, never painted", async () => {
    const page = await loadProfile(ANA);
    let releaseOld!: (p: Profile) => void;
    let releaseNew!: (p: Profile) => void;
    // Two lookups overlap: the first (for Ana, slow) and the second (for Ben).
    page.next(() => new Promise<Profile>((r) => { releaseOld = r; }));
    await page.changeIdentity({ status: "authenticated" });
    page.next(() => new Promise<Profile>((r) => { releaseNew = r; }));
    await page.changeIdentity({ status: "authenticated" });
    expect(page.text()).toBe("Cargando tu perfil…");
    releaseNew({ ...ANA, email: "ben@example.com", displayName: "Ben", memberSince: null });
    await tick();
    expect(page.text()).toContain("ben@example.com");
    releaseOld({ ...ANA, email: "old-ana@example.com", displayName: "Ana (old)" }); // arrives after Ben's
    await tick();
    expect(page.text()).toContain("ben@example.com");
    expect(page.text()).not.toContain("old-ana@example.com");
    expect(page.text()).not.toContain("Ana");
  });

  it("a failed lookup says so in the chosen language and shows nothing personal", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const page = await loadProfile(() => Promise.reject(new Error("boom")));
    expect(page.text()).toBe("No pudimos cargar tu perfil. Recargá la página para intentar de nuevo.");
    page.en();
    expect(page.text()).toBe("We couldn't load your profile. Reload the page to try again.");
  });
});

describe("the profile uses the same shell", () => {
  it("header (logo link, selector, account group with the profile link), navigation and footer; the account link is handed to the shared component", async () => {
    const page = await loadProfile(ANA);
    expect(page.doc.querySelector("a.brand-link")!.getAttribute("href")).toBe("https://urbanohn.com/");
    expect(Array.from(page.doc.querySelectorAll(".account-group > *")).map((e) => e.id)).toEqual(["account-link", "btn-signin"]);
    expect(page.calls.attach).toHaveLength(1);
    expect(page.calls.attach[0].options.accountLink).toBe(page.doc.getElementById("account-link"));
    expect(page.doc.querySelector("footer a")!.getAttribute("href")).toBe("https://www.tecnomovi.com/");
    expect(Array.from(page.doc.querySelectorAll(".primary-nav a")).map((a) => a.textContent)).toEqual(["Inicio", "Jugar", "Experiencias", "Clasificaciones", "Premios"]);
    expect(page.doc.title).toBe("Mi perfil — URBANO Gaming");
  });
});
