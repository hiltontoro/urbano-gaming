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
const CRESTS_SOURCE = readFileSync(path.join(ROOT, "public/urbanoClubCrests.js"), "utf8");
const HOSTILE = '<img src=x onerror="window.__xss=(window.__xss||0)+1">';

const tick = (ms = 20) => new Promise((r) => setTimeout(r, ms));
const closers: Array<() => void> = [];
afterEach(() => { while (closers.length) closers.pop()!(); vi.restoreAllMocks(); });

type Profile = Record<string, unknown>;
const ANA: Profile = { status: "authenticated", email: "ana@example.com", emailVerified: true, displayName: "Ana", gamingMemberId: "gm-ana", memberSince: "2026-09-02T15:30:00.000Z" };

interface FetchCall { url: string; init: Record<string, any> }
/** What the participations route answers: a list, a status, or a function of the call (to answer differently per person or time). */
type ParticipationsReply = { status?: number; participations?: unknown[]; reject?: boolean; delayMs?: number; limit?: number | null; truncated?: boolean | null };

async function loadProfile(first: Profile | Promise<Profile> | (() => Promise<Profile>), opts: { lang?: "es" | "en"; crests?: boolean; participations?: ParticipationsReply | ((call: FetchCall, index: number) => ParticipationsReply) } = {}) {
  const calls = { getProfile: 0, openSignIn: [] as unknown[], attach: [] as Array<{ button: any; status: any; options: any }> };
  const fetches: FetchCall[] = [];
  const identity: { callbacks: Array<(s: unknown) => void> } = { callbacks: [] };
  const queue: Array<Profile | Promise<Profile> | (() => Promise<Profile>)> = [first];
  let lookups = 0; // the Nth lookup gets the Nth queued answer (the last one repeats)
  const dom = new JSDOM(HTML, {
    url: "http://localhost/profile.html", runScripts: "dangerously", pretendToBeVisual: true,
    beforeParse(window) {
      const w = window as any;
      if (opts.lang) window.localStorage.setItem("urbano.lang", opts.lang);
      w.eval(I18N_SOURCE);
      if (opts.crests) w.eval(CRESTS_SOURCE); // jsdom does not load external scripts: the real module, as the script tag would
      w.UrbanoAuth = {
        attachSignInButton: (button: any, status: any, options: any) => { calls.attach.push({ button, status, options }); },
        getProfile: () => {
          calls.getProfile += 1;
          const next = queue[Math.min(lookups, queue.length - 1)];
          lookups += 1;
          return typeof next === "function" ? next() : Promise.resolve(next);
        },
        getAccessToken: async () => "stub-token",
        onIdentityChange: async (cb: (s: unknown) => void) => { identity.callbacks.push(cb); return () => {}; },
        openSignIn: (o?: unknown) => { calls.openSignIn.push(o ?? null); return true; },
      };
      w.fetch = async (url: string, init: Record<string, any> = {}) => {
        const call: FetchCall = { url: String(url), init };
        const index = fetches.push(call) - 1;
        const reply = typeof opts.participations === "function" ? opts.participations(call, index) : (opts.participations ?? { participations: [] });
        if (reply.delayMs) await new Promise((r) => setTimeout(r, reply.delayMs));
        if (reply.reject) throw new TypeError("network failure");
        const status = reply.status ?? 200;
        // limit / truncated are part of the real answer; null leaves them out (an answer from before they existed)
        const body: Record<string, unknown> = { participations: reply.participations ?? [] };
        if (reply.limit !== null) body.limit = reply.limit ?? 50;
        if (reply.truncated !== null) body.truncated = reply.truncated ?? false;
        return { ok: status >= 200 && status < 300, status, json: async () => JSON.parse(JSON.stringify(body)) };
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
    win, doc, calls, fetches, identity, body, text,
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
    // Outside "My participations" nothing mentions levels or prizes at all; inside it, the only word about a prize is the sentence that says
    // a level sent is NOT a prize won. XP, points and rankings appear nowhere.
    const history = page.doc.querySelector("[data-participations]")!;
    const outside = Array.from(page.body().children).filter((node) => node !== history).map((node) => node.textContent).join(" ");
    expect(outside).not.toMatch(/\bXP\b|puntos|points|premio|prize|ranking|rango|nivel|level/i);
    expect(page.text()).not.toMatch(/\bXP\b|puntos|points|ranking|rango/i);
    expect((history.textContent ?? "").match(/premio/gi)).toHaveLength(1);
    expect(history.textContent).toContain("Un nivel enviado no es un premio ganado");
    const script = HTML.slice(HTML.lastIndexOf("<script>"));
    expect(script).not.toMatch(/XMLHttpRequest|localStorage|sessionStorage|completeProfile|signOut|requestCode|verifyCode/);
    // The one request the page makes of its own: the member's own participations, a plain GET with the session and nothing else.
    expect(script.match(/fetch\(/g)).toHaveLength(1);
    expect(script).toContain('fetch("/api/gaming/predictions/participations"');
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
    expect(page.doc.querySelector('footer a[href^="https://"]')!.getAttribute("href")).toBe("https://www.tecnomovi.com/");
    expect(page.doc.querySelector('footer a[href="/legal.html"]')).not.toBeNull();
    expect(Array.from(page.doc.querySelectorAll(".primary-nav a")).map((a) => a.textContent)).toEqual(["Inicio", "Jugar", "Experiencias", "Clasificaciones", "Premios"]);
    expect(page.doc.title).toBe("Mi perfil — URBANO Gaming");
  });
});

// ---------------------------------------------------------------------------------------------------------------------------------
// My participations
// ---------------------------------------------------------------------------------------------------------------------------------

describe("My participations: the member's own history", () => {
  const SENT = "2026-10-24T20:00:00.000Z";
  const part = (over: Record<string, unknown> = {}) => ({
    matchId: "m1",
    match: { competition: "Liga Nacional", homeTeam: "Alpha FC", awayTeam: "Beta FC", kickoffAt: "2031-10-25T20:00:00.000Z", cancelled: false },
    venueName: "Beer Box", contract: "PROGRESSIVE_LADDER_V1", attemptedLevel: 3,
    answers: { scoreline: { home: 2, away: 1 }, firstTeam: { kind: "PICKED", team: "HOME" }, goalscorer: { kind: "PICKED", playerName: "Ana Díaz" } },
    sentAt: SENT, lastChangedAt: null, state: "OPEN", editable: true, editBlockedReason: null, evaluation: { evaluated: false }, ...over,
  });
  const items = (page: Awaited<ReturnType<typeof loadProfile>>) => Array.from(page.doc.querySelectorAll("[data-participation]")) as HTMLElement[];
  const textOf = (el: Element) => (el.textContent ?? "").replace(/\s+/g, " ").trim();
  const when = (locale: string, iso: string) => new Intl.DateTimeFormat(locale, { year: "numeric", month: "short", day: "numeric", hour: "2-digit", minute: "2-digit", second: "2-digit", timeZoneName: "short" }).format(new Date(iso));

  it("asks for the member's own history with the session only: one GET, no query, no body, no identifier of anyone", async () => {
    const page = await loadProfile(ANA, { participations: { participations: [part()] } });
    expect(page.fetches).toHaveLength(1);
    expect(page.fetches[0].url).toBe("/api/gaming/predictions/participations");
    expect(page.fetches[0].init.method).toBeUndefined(); // a plain GET
    expect(page.fetches[0].init.body).toBeUndefined();
    expect(Object.keys(page.fetches[0].init.headers)).toEqual(["authorization"]);
    expect(page.fetches[0].init.headers.authorization).toBe("Bearer stub-token");
    expect(JSON.stringify(page.fetches[0])).not.toContain("gm-ana");
  });

  it("shows what was SENT: teams, competition, venue, the level sent, when, and the answers — in Spanish", async () => {
    const page = await loadProfile(ANA, { participations: { participations: [part()] } });
    const [item] = items(page);
    const text = textOf(item);
    expect(text).toContain("Alpha FC vs. Beta FC");
    expect(text).toContain("Liga Nacional");
    expect(text).toContain("Sede: Beer Box");
    expect(text).toContain(`Inicio del partido: ${when("es-HN", "2031-10-25T20:00:00.000Z")}`);
    expect(text).toContain("Nivel enviado: Nivel 3 · Difícil");
    expect(text).toContain(`Enviada: ${when("es-HN", SENT)}`);
    expect(Array.from(item.querySelectorAll("ul li")).map(textOf)).toEqual(["Marcador: 2–1", "Primer equipo: Alpha FC", "Goleador: Ana Díaz"]);
    expect(text).toContain("Estado: abierta. Podés editarla hasta el inicio del partido.");
    expect((item.querySelector("a.part-edit") as HTMLAnchorElement).getAttribute("href")).toBe("/soccer-predictions.html");
  });

  it("keeps the level SENT, the state and the level REACHED apart: a level sent is never shown as won", async () => {
    const page = await loadProfile(ANA, { participations: { participations: [
      part({ matchId: "open" }),
      part({ matchId: "closed", state: "CLOSED", editable: false }),
      part({ matchId: "reached", state: "CLOSED", editable: false, attemptedLevel: 4, evaluation: { evaluated: true, evaluatedAt: SENT, reachedLevel: 2 } }),
      part({ matchId: "none", state: "CLOSED", editable: false, attemptedLevel: 3, evaluation: { evaluated: true, evaluatedAt: SENT, reachedLevel: 0 } }),
      part({ matchId: "cancelled", state: "CANCELLED", editable: false, match: { competition: "Copa", homeTeam: "A", awayTeam: "B", kickoffAt: "2031-10-25T20:00:00.000Z", cancelled: true } }),
    ] } });
    const byId = (id: string) => textOf(page.doc.querySelector(`[data-participation="${id}"]`)!);
    expect(byId("closed")).toContain("Estado: cerrada, esperando el resultado oficial.");
    expect(byId("closed")).not.toContain("Nivel alcanzado");
    expect(byId("closed")).not.toContain("Editar");
    expect(byId("reached")).toContain("Nivel enviado: Nivel 4 · Legendaria");
    expect(byId("reached")).toContain("Estado: evaluada.");
    expect(byId("reached")).toContain("Nivel alcanzado: Nivel 2 · Mediana");
    expect(byId("none")).toContain("Nivel enviado: Nivel 3 · Difícil");
    expect(byId("none")).toContain("No alcanzó ningún nivel.");
    expect(byId("cancelled")).toContain("Estado: el partido fue cancelado.");
    expect(byId("cancelled")).not.toContain("Editar");
    for (const id of ["open", "closed", "reached", "none", "cancelled"]) expect(byId(id), id).not.toMatch(/ganaste|ganado|ganó|premio|prize|won/i);
  });

  it("shows a deliberate 'none' as an answer, a stoppage-time minute, and a participation under the earlier format without levels", async () => {
    const page = await loadProfile(ANA, { participations: { participations: [
      part({ matchId: "none", attemptedLevel: 4, answers: { scoreline: { home: 0, away: 0 }, firstTeam: { kind: "NONE" }, goalscorer: { kind: "NONE" }, goalMinute: { kind: "NONE" } } }),
      part({ matchId: "min", attemptedLevel: 4, answers: { scoreline: { home: 1, away: 1 }, firstTeam: { kind: "PICKED", team: "AWAY" }, goalscorer: { kind: "PICKED", playerName: null }, goalMinute: { kind: "PICKED", regulation: 45, stoppage: 2 } } }),
      part({ matchId: "old", contract: "COMPLETE_COUNT_V1", attemptedLevel: null, answers: { scoreline: { home: 3, away: 0 } } }),
    ] } });
    const lines = (id: string) => Array.from(page.doc.querySelectorAll(`[data-participation="${id}"] ul li`)).map(textOf);
    expect(lines("none")).toEqual(["Marcador: 0–0", "Primer equipo: Ningún equipo anotará", "Goleador: Ningún jugador marcará", "Minuto: No habrá goles en tiempo reglamentario"]);
    expect(lines("min")).toEqual(["Marcador: 1–1", "Primer equipo: Beta FC", "Goleador: jugador no disponible", "Minuto: 45+2'"]);
    expect(textOf(page.doc.querySelector('[data-participation="old"]')!)).toContain("Nivel enviado: formato anterior, sin niveles");
    expect(lines("old")).toEqual(["Marcador: 3–0"]);
  });

  it("an empty history says so; a failed one says so and shows nothing else; neither is an empty page", async () => {
    const empty = await loadProfile(ANA, { participations: { participations: [] } });
    expect(textOf(empty.doc.querySelector("[data-participations]")!)).toContain("Todavía no enviaste ninguna participación en URBANO Score.");
    vi.spyOn(console, "error").mockImplementation(() => {});
    for (const reply of [{ status: 500 }, { status: 401 }, { reject: true }] as ParticipationsReply[]) {
      const failed = await loadProfile(ANA, { participations: reply });
      expect(textOf(failed.doc.querySelector("[data-participations]")!)).toContain("No pudimos cargar tus participaciones. Recargá la página para intentar de nuevo.");
      expect(items(failed)).toHaveLength(0);
      expect(failed.doc.querySelector(".profile-fields")).not.toBeNull(); // the profile itself still shows
    }
  });

  it("without a session or with an unfinished account nothing is requested and no history is shown", async () => {
    const out = await loadProfile({ status: "unauthenticated" });
    expect(out.fetches).toEqual([]);
    expect(out.doc.querySelector("[data-participations]")).toBeNull();
    const incomplete = await loadProfile({ status: "profile_incomplete" });
    expect(incomplete.fetches).toEqual([]);
    expect(incomplete.doc.querySelector("[data-participations]")).toBeNull();
  });

  it("another person signing in never sees the previous person's history, not even while it loads, and a late answer for the previous person is dropped", async () => {
    const page = await loadProfile(ANA, {
      participations: (call, index) => (index === 0 ? { participations: [part({ matchId: "ana-only", venueName: "Sede de Ana" })], delayMs: 80 } : { participations: [part({ matchId: "beto-only", venueName: "Sede de Beto" })] }),
    });
    // Ana's answer is still on its way when the person changes.
    const staleCard = page.doc.querySelector("[data-participations]")!;
    page.next({ ...ANA, displayName: "Beto", gamingMemberId: "gm-beto", email: "beto@example.com" });
    await page.changeIdentity();
    await tick(160);
    expect(items(page).map((item) => item.getAttribute("data-participation"))).toEqual(["beto-only"]);
    // defense in depth: the late answer was not even painted into the card that belonged to the previous person
    expect(staleCard.querySelector("[data-participation]")).toBeNull();
    expect(page.text()).not.toContain("Sede de Ana");
    expect(page.text()).toContain("Sede de Beto");
  });

  it("shows no coordinate, distance, accuracy, fingerprint or identifier, whatever else the answer carried", async () => {
    const hostile = { ...part(), latitude: 14.0723, longitude: -87.1921, measuredDistanceMeters: 12, reportedAccuracyMeters: 5, acceptedOfferDigest: "ab".repeat(32), gamingMemberId: "gm-ana", predictionId: "pr-1" };
    const page = await loadProfile(ANA, { participations: { participations: [hostile] } });
    const text = textOf(page.body());
    for (const secret of ["14.0723", "-87.1921", "abab", "gm-ana", "pr-1", "12 m", "Precisión"]) expect(text, secret).not.toContain(secret);
    expect(page.body().innerHTML).not.toMatch(/14\.0723|87\.1921|gm-ana|pr-1|abab/);
  });

  it("team, venue, competition and player names are data: never parsed as HTML", async () => {
    const page = await loadProfile(ANA, { participations: { participations: [part({
      match: { competition: HOSTILE, homeTeam: HOSTILE, awayTeam: HOSTILE, kickoffAt: "2031-10-25T20:00:00.000Z", cancelled: false },
      venueName: HOSTILE, answers: { scoreline: { home: 1, away: 0 }, firstTeam: { kind: "PICKED", team: "HOME" }, goalscorer: { kind: "PICKED", playerName: HOSTILE } },
    })] } });
    expect((page.win as any).__xss).toBeUndefined();
    expect(page.doc.querySelector("img[src='x']")).toBeNull();
    expect(textOf(items(page)[0])).toContain(HOSTILE);
  });

  it("shows the goalscorer as 'number · name' when the roster has the squad number, and just the name when it does not; never a position or a source", async () => {
    const withNumber = await loadProfile(ANA, { participations: { participations: [part({ answers: { scoreline: { home: 2, away: 1 }, firstTeam: { kind: "PICKED", team: "HOME" }, goalscorer: { kind: "PICKED", playerName: "Lamine Yamal", jerseyNumber: 10 } } })] } });
    const li = Array.from(items(withNumber)[0].querySelectorAll("li")).map(textOf).find((line) => /Goleador|Goalscorer/.test(line));
    expect(li).toBe("Goleador: 10 · Lamine Yamal");
    const withoutNumber = await loadProfile(ANA, { participations: { participations: [part({ answers: { scoreline: { home: 2, away: 1 }, firstTeam: { kind: "PICKED", team: "HOME" }, goalscorer: { kind: "PICKED", playerName: "Ana Díaz", jerseyNumber: null } } })] } });
    expect(textOf(items(withoutNumber)[0])).toContain("Goleador: Ana Díaz");
    expect(textOf(items(withNumber)[0])).not.toMatch(/\b(POR|DEF|MED|DEL)\b/);
  });

  it("draws the two crests (home team first, decoration only) above a title that names both teams in text; without the module, only the title", async () => {
    const withCrests = await loadProfile(ANA, { crests: true, participations: { participations: [part({ match: { competition: "LaLiga", homeTeam: "FC Barcelona", awayTeam: "Real Madrid CF", kickoffAt: "2031-10-25T20:00:00.000Z", cancelled: false } })] } });
    const item = items(withCrests)[0];
    expect(Array.from(item.querySelectorAll(".part-crests img")).map((img) => img.getAttribute("data-crest"))).toEqual(["fc-barcelona", "real-madrid-cf"]);
    expect(item.querySelector(".part-crests")!.getAttribute("aria-hidden")).toBe("true");
    expect(textOf(item.querySelector("h3")!)).toBe("FC Barcelona vs. Real Madrid CF");
    const plain = await loadProfile(ANA, { participations: { participations: [part({ match: { competition: "LaLiga", homeTeam: "FC Barcelona", awayTeam: "Real Madrid CF", kickoffAt: "2031-10-25T20:00:00.000Z", cancelled: false } })] } });
    expect(items(plain)[0].querySelector("img")).toBeNull();
    expect(textOf(items(plain)[0].querySelector("h3")!)).toBe("FC Barcelona vs. Real Madrid CF");
    const unknownTeams = await loadProfile(ANA, { crests: true, participations: { participations: [part()] } });
    expect(items(unknownTeams)[0].querySelector("img")).toBeNull(); // a team with no crest: nothing drawn
  });

  it("follows the language in place, times included, without asking again", async () => {
    const page = await loadProfile(ANA, { participations: { participations: [part({ lastChangedAt: "2026-10-24T20:30:00.000Z" })] } });
    expect(textOf(items(page)[0])).toContain(`Enviada: ${when("es-HN", SENT)}`);
    page.en();
    await tick();
    const text = textOf(items(page)[0]);
    expect(text).toContain(`Sent: ${when("en-US", SENT)}`);
    expect(text).toContain(`Last updated: ${when("en-US", "2026-10-24T20:30:00.000Z")}`);
    expect(text).toContain("Level sent: Level 3 · Hard");
    expect(text).toContain("Status: open. You can edit it until the match starts.");
    expect(text).toContain("Goalscorer: Ana Díaz");
    expect(page.fetches).toHaveLength(1);
  });

  it("is readable at 375 px: long names wrap, nothing has a fixed width, and the edit link is a 44 px target", () => {
    const css = HTML.slice(HTML.indexOf("<style>"), HTML.indexOf("</style>"));
    expect(css).toMatch(/\.part-item\s*\{[^}]*min-width:\s*0/);
    expect(css).toMatch(/\.part-item h3\s*\{[^}]*overflow-wrap:\s*anywhere/);
    expect(css).toMatch(/\.part-edit\s*\{[^}]*min-height:\s*44px/);
    expect(css.slice(css.indexOf(".part-list"), css.indexOf(".part-edit:focus-visible"))).not.toMatch(/[^-]width:\s*\d+px/);
  });
});

describe("My participations: the limit of the history, and why a saved participation cannot be changed", () => {
  const SENT = "2026-10-24T20:00:00.000Z";
  const part = (over: Record<string, unknown> = {}) => ({
    matchId: "m1", match: { competition: "Liga", homeTeam: "A", awayTeam: "B", kickoffAt: "2031-10-25T20:00:00.000Z", cancelled: false },
    venueName: "Beer Box", contract: "PROGRESSIVE_LADDER_V1", attemptedLevel: 2, answers: { scoreline: { home: 1, away: 0 } },
    sentAt: SENT, lastChangedAt: null, state: "OPEN", editable: true, editBlockedReason: null, evaluation: { evaluated: false }, ...over,
  });
  const card = (page: Awaited<ReturnType<typeof loadProfile>>) => (page.doc.querySelector("[data-participations]")!.textContent ?? "").replace(/\s+/g, " ").trim();
  const state = (page: Awaited<ReturnType<typeof loadProfile>>, id = "m1") => (page.doc.querySelector(`[data-participation="${id}"] .part-state`)!.textContent ?? "").trim();

  it("always says that the list is limited: 'up to the latest 50', in both languages", async () => {
    const page = await loadProfile(ANA, { participations: { participations: [part()], limit: 50, truncated: false } });
    expect(page.doc.querySelector(".part-limit")!.textContent).toBe("Se muestran hasta las últimas 50 participaciones.");
    expect(page.doc.querySelector(".part-truncated")).toBeNull(); // nothing older: no warning
    page.en();
    await tick();
    expect(page.doc.querySelector(".part-limit")!.textContent).toBe("Up to your latest 50 participations are shown.");
  });

  it("when there are older participations it says so, prominently, as a status: 'Últimas 50 participaciones' and that earlier ones are not shown", async () => {
    const many = Array.from({ length: 50 }, (_, i) => part({ matchId: `m${i}` }));
    const page = await loadProfile(ANA, { participations: { participations: many, limit: 50, truncated: true } });
    const notice = page.doc.querySelector(".part-truncated")!;
    expect(notice.textContent).toBe("Últimas 50 participaciones. Hay participaciones anteriores que no se muestran aquí.");
    expect(notice.getAttribute("role")).toBe("status");
    expect(page.doc.querySelectorAll("[data-participation]")).toHaveLength(50);
    expect(page.doc.querySelectorAll(".part-limit")).toHaveLength(1); // the warning replaces the plain note, it does not stack on it
    page.en();
    await tick();
    expect(page.doc.querySelector(".part-truncated")!.textContent).toBe("Latest 50 participations. There are earlier participations that are not shown here.");
  });

  it("an answer that predates the limit fields shows no claim either way (it neither invents a limit nor says the list is complete)", async () => {
    const page = await loadProfile(ANA, { participations: { participations: [part()], limit: null, truncated: null } });
    expect(page.doc.querySelector(".part-limit")).toBeNull();
    expect(card(page)).not.toMatch(/últimas|hasta las|anteriores/i);
    const onlyTruncated = await loadProfile(ANA, { participations: { participations: [part(), part({ matchId: "m2" })], limit: null, truncated: true } });
    expect(onlyTruncated.doc.querySelector(".part-truncated")!.textContent).toBe("Últimas 2 participaciones. Hay participaciones anteriores que no se muestran aquí.");
  });

  it("no notice at all for an empty history or a failed one", async () => {
    const empty = await loadProfile(ANA, { participations: { participations: [], limit: 50, truncated: false } });
    expect(empty.doc.querySelector(".part-limit")).toBeNull();
    vi.spyOn(console, "error").mockImplementation(() => {});
    const failed = await loadProfile(ANA, { participations: { status: 500 } });
    expect(failed.doc.querySelector(".part-limit")).toBeNull();
  });

  it("an open participation that cannot be changed says why, never 'you can edit it', and has no edit link — in both languages", async () => {
    const cases: Array<[string, string, string]> = [
      ["ACTIVATION_DISABLED", "Estado: guardada. Esta sede ya no recibe cambios.", "Status: saved. This venue no longer takes changes."],
      ["VENUE_UNAVAILABLE", "Estado: guardada. Esta sede no está disponible por ahora, así que no se pueden hacer cambios.", "Status: saved. This venue is not available for now, so changes cannot be made."],
      ["OFFER_UNAVAILABLE", "Estado: guardada. Esta sede no tiene un premio válido configurado, así que no recibe cambios.", "Status: saved. This venue has no valid prize configured, so it takes no changes."],
      ["SOMETHING_NEW", "Estado: guardada. Por ahora no se puede cambiar.", "Status: saved. It cannot be changed for now."], // a reason this page does not know yet
    ];
    for (const [reason, es, en] of cases) {
      const page = await loadProfile(ANA, { participations: { participations: [part({ editable: false, editBlockedReason: reason })] } });
      expect(state(page), reason).toBe(es);
      expect(page.doc.querySelector("[data-participation] a.part-edit"), reason).toBeNull();
      expect(card(page), reason).not.toContain("Podés editarla");
      page.en();
      await tick();
      expect(state(page), reason).toBe(en);
    }
  });

  it("an editable participation keeps its promise and its link; closed, cancelled and evaluated keep their own wording", async () => {
    const page = await loadProfile(ANA, { participations: { participations: [
      part({ matchId: "open" }),
      part({ matchId: "closed", state: "CLOSED", editable: false, editBlockedReason: "MATCH_STARTED" }),
      part({ matchId: "cancelled", state: "CANCELLED", editable: false, editBlockedReason: "MATCH_CANCELLED" }),
      part({ matchId: "evaluated", state: "CLOSED", editable: false, editBlockedReason: "EVALUATED", evaluation: { evaluated: true, evaluatedAt: SENT, reachedLevel: 1 } }),
    ] } });
    expect(state(page, "open")).toBe("Estado: abierta. Podés editarla hasta el inicio del partido.");
    expect(page.doc.querySelector('[data-participation="open"] a.part-edit')).not.toBeNull();
    expect(state(page, "closed")).toBe("Estado: cerrada, esperando el resultado oficial.");
    expect(state(page, "cancelled")).toBe("Estado: el partido fue cancelado.");
    expect(state(page, "evaluated")).toBe("Estado: evaluada.");
    expect(page.doc.querySelectorAll("a.part-edit")).toHaveLength(1);
  });
});
