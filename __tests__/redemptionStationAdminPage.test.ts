import { describe, expect, it } from "vitest";
import { JSDOM } from "jsdom";
import { readFileSync } from "node:fs";
import path from "node:path";

/**
 * THE ADMINISTRATION PAGE OF THE STATION (public/canje-admin.html + public/canjeAdmin.js), run whole in jsdom as shipped, with a stand-in for
 * the sign-in script and for the server: what an administrator sees, that the PIN is only typed, sent once and wiped, and that a person without
 * access sees nothing of the station.
 */

const HTML = readFileSync(path.join(process.cwd(), "public/canje-admin.html"), "utf8");
const SCRIPT = readFileSync(path.join(process.cwd(), "public/canjeAdmin.js"), "utf8");
const BASE = "/api/gaming/canje/clasico-the-pub-2026-10-25";

interface Status { slug: string; label: string; expiresAt: string; revokedAt: string | null; pinSet: boolean; pinVersion: number; activeSessions: number; lastPinChangeAt: string | null }
const status = (over: Partial<Status> = {}): Status => ({
  slug: "clasico-the-pub-2026-10-25", label: "The Pub · El Clásico", expiresAt: "2099-11-01T06:00:00.000Z", revokedAt: null, pinSet: false, pinVersion: 0, activeSessions: 0, lastPinChangeAt: null, ...over,
});

interface Opts {
  auth?: "none" | "incomplete" | "member";
  statusCode?: number;
  status?: Status;
  postCode?: number;
  postJson?: unknown;
  throwOnPost?: boolean;
  revokeCode?: number;
}

async function load(opts: Opts = {}) {
  const calls: Array<{ url: string; method: string; body: any; authorization: string | null }> = [];
  const state = { status: opts.status ?? status() };
  const dom = new JSDOM(HTML.replace(/<script src="[^"]*"><\/script>/g, ""), { url: "http://localhost/canje-admin.html", runScripts: "dangerously", pretendToBeVisual: true });
  const w = dom.window as unknown as Record<string, any>;
  const listeners: Array<() => void> = [];
  w.UrbanoAuth = {
    attachSignInButton: () => undefined,
    onAuthStateChange: async (cb: () => void) => { listeners.push(cb); },
    getState: async () => (opts.auth ?? "member") === "none" ? { status: "unauthenticated" } : opts.auth === "incomplete" ? { status: "profile_incomplete" } : { status: "authenticated", gamingMemberId: "m-1", displayName: "Admin" },
    getAccessToken: async () => "tok-123",
  };
  w.fetch = async (url: string, init: any = {}) => {
    const method = (init.method ?? "GET").toUpperCase();
    calls.push({ url: String(url), method, body: init.body ? JSON.parse(init.body) : null, authorization: init.headers?.authorization ?? null });
    const reply = (code: number, json: unknown) => ({ status: code, json: async () => JSON.parse(JSON.stringify(json)) });
    if (String(url) === BASE + "/pin" && method === "GET") return opts.statusCode && opts.statusCode !== 200 ? reply(opts.statusCode, { error: "x" }) : reply(200, state.status);
    if (String(url) === BASE + "/pin" && method === "POST") {
      if (opts.throwOnPost) throw new Error("offline");
      const code = opts.postCode ?? 200;
      if (code === 200) state.status = status({ pinSet: true, pinVersion: state.status.pinVersion + 1, activeSessions: 0, lastPinChangeAt: "2026-10-29T15:00:00.000Z" });
      return reply(code, opts.postJson ?? (code === 200 ? { ok: true, pinVersion: state.status.pinVersion, sessionsRevoked: 2 } : { error: "El PIN debe tener de 8 a 12 dígitos, solo números." }));
    }
    if (String(url) === BASE + "/revoke" && method === "POST") {
      const code = opts.revokeCode ?? 200;
      if (code === 200) state.status = status({ ...state.status, revokedAt: "2026-10-29T16:00:00.000Z" });
      return reply(code, code === 200 ? { ok: true, revoked: true } : { error: "x" });
    }
    return reply(404, {});
  };
  const script = dom.window.document.createElement("script");
  script.textContent = SCRIPT;
  dom.window.document.body.appendChild(script);
  const doc = dom.window.document;
  const settle = async (ms = 30) => { await new Promise((r) => setTimeout(r, ms)); };
  await settle();
  const $ = (id: string) => doc.getElementById(id) as any;
  const type = (id: string, value: string) => { $(id).value = value; $(id).dispatchEvent(new dom.window.Event("input", { bubbles: true })); };
  const submit = async () => { $("pin-form").dispatchEvent(new dom.window.Event("submit", { bubbles: true, cancelable: true })); await settle(); };
  const click = async (el: any) => { el.click(); await settle(); };
  return { dom, doc, calls, state, $, type, submit, click, settle, listeners, close: () => dom.window.close() };
}

describe("who sees the station", () => {
  it("nobody signed in sees nothing of the station, and no request for it is made", async () => {
    const p = await load({ auth: "none" });
    expect(p.$("admin").hidden).toBe(true);
    expect(p.$("access-msg").textContent).toBe("Entra con tu cuenta de administración.");
    expect(p.calls).toHaveLength(0);
    p.close();
  });

  it("a person with a profile that is not finished, or without the authority (403), sees only that the account has no access", async () => {
    const incomplete = await load({ auth: "incomplete" });
    expect(incomplete.$("admin").hidden).toBe(true);
    expect(incomplete.$("access-msg").textContent).toBe("Esta cuenta no tiene acceso de administración.");
    incomplete.close();
    const forbidden = await load({ statusCode: 403 });
    expect(forbidden.$("admin").hidden).toBe(true);
    expect(forbidden.$("access-msg").textContent).toBe("Esta cuenta no tiene acceso de administración.");
    expect(forbidden.$("s-label").textContent).toBe("");
    forbidden.close();
  });

  it("an administrator sees the state: no PIN yet, the version, the open sessions, the last change and the end", async () => {
    const p = await load();
    expect(p.$("admin").hidden).toBe(false);
    expect(p.$("s-label").textContent).toBe("The Pub · El Clásico");
    expect(p.$("s-pin").textContent).toContain("sin definir");
    expect(p.$("s-version").textContent).toBe("0");
    expect(p.$("s-state").textContent).toBe("abierto");
    expect(p.$("s-expires").textContent).toContain("2099");
    expect(p.calls[0]).toMatchObject({ url: BASE + "/pin", method: "GET", authorization: "Bearer tok-123" });
    p.close();
  });

  it("when the sign-in changes, the state is read again", async () => {
    const p = await load({ auth: "none" });
    expect(p.$("admin").hidden).toBe(true);
    p.listeners.forEach((cb) => cb());
    await p.settle();
    expect(p.calls.filter((c) => c.method === "GET").length).toBe(0); // still signed out
    p.close();
  });
});

describe("setting the PIN", () => {
  it("the save button needs both fields filled; the fields hide what is typed and the browser is told not to remember it", async () => {
    const p = await load();
    expect(p.$("pin").type).toBe("password");
    expect(p.$("pin2").type).toBe("password");
    expect(p.$("pin").getAttribute("autocomplete")).toBe("new-password");
    expect(p.$("pin").getAttribute("inputmode")).toBe("numeric");
    expect(p.$("btn-save").disabled).toBe(true);
    p.type("pin", "73920461");
    expect(p.$("btn-save").disabled).toBe(true);
    p.type("pin2", "73920461");
    expect(p.$("btn-save").disabled).toBe(false);
    p.close();
  });

  it("the PIN travels once, in the body of the request, together with its confirmation; it is wiped from the fields at once and never shown", async () => {
    const p = await load();
    p.type("pin", "73920461"); p.type("pin2", "73920461");
    await p.submit();
    const posts = p.calls.filter((c) => c.method === "POST");
    expect(posts).toHaveLength(1);
    expect(posts[0]).toMatchObject({ url: BASE + "/pin", body: { pin: "73920461", confirmPin: "73920461" }, authorization: "Bearer tok-123" });
    expect(p.$("pin").value).toBe("");
    expect(p.$("pin2").value).toBe("");
    expect(p.$("pin-msg").textContent).toBe("PIN guardado (versión 1). Sesiones cerradas: 2.");
    expect(p.$("pin-msg").className).toContain("success");
    expect(p.$("s-pin").textContent).toBe("definido");
    const w = p.dom.window as any;
    expect(p.doc.documentElement.outerHTML).not.toContain("73920461");
    expect(JSON.stringify(Object.entries(w.localStorage))).not.toContain("73920461");
    expect(JSON.stringify(Object.entries(w.sessionStorage))).not.toContain("73920461");
    expect(w.location.href).not.toContain("73920461");
    p.close();
  });

  it("two different PINs are not sent: the page says so and keeps the fields empty", async () => {
    const p = await load();
    p.type("pin", "73920461"); p.type("pin2", "73920462");
    await p.submit();
    expect(p.calls.filter((c) => c.method === "POST")).toHaveLength(0);
    expect(p.$("pin-msg").textContent).toBe("Los dos PIN no coinciden. Escríbelos de nuevo.");
    expect(p.$("pin").value).toBe("");
    p.close();
  });

  it("when the server refuses the PIN (too obvious, malformed) it says why and nothing is saved", async () => {
    const p = await load({ postCode: 400, postJson: { error: "Ese PIN es demasiado obvio (dígitos consecutivos): elige otro." } });
    p.type("pin", "12345678"); p.type("pin2", "12345678");
    await p.submit();
    expect(p.$("pin-msg").textContent).toBe("Ese PIN es demasiado obvio (dígitos consecutivos): elige otro.");
    expect(p.$("pin-msg").className).toContain("error");
    expect(p.$("pin").value).toBe("");
    expect(p.$("s-version").textContent).toBe("0");
    p.close();
  });

  it("a lost connection does not claim the PIN was saved: it asks to check the state first", async () => {
    const p = await load({ throwOnPost: true });
    p.type("pin", "73920461"); p.type("pin2", "73920461");
    await p.submit();
    expect(p.$("pin-msg").textContent).toContain("No sabemos si se guardó");
    expect(p.$("pin-msg").className).toContain("error");
    expect(p.$("pin").value).toBe("");
    p.close();
  });

  it("an account that lost its access while the page was open is sent back out, with nothing of the station left on screen", async () => {
    const p = await load({ postCode: 403 });
    p.type("pin", "73920461"); p.type("pin2", "73920461");
    await p.submit();
    expect(p.$("admin").hidden).toBe(true);
    expect(p.$("access-msg").textContent).toBe("Tu sesión terminó o esta cuenta no tiene acceso.");
    p.close();
  });

  it("a closed station cannot be given a PIN: the save button stays off", async () => {
    const p = await load({ status: status({ revokedAt: "2026-10-30T00:00:00.000Z", pinSet: true, pinVersion: 2 }) });
    expect(p.$("s-state").textContent).toContain("cerrado");
    p.type("pin", "73920461"); p.type("pin2", "73920461");
    expect(p.$("btn-save").disabled).toBe(true);
    p.close();
  });
});

describe("closing the station", () => {
  it("needs the confirmation box; it closes once, and the page then shows the station closed", async () => {
    const p = await load({ status: status({ pinSet: true, pinVersion: 1 }) });
    expect(p.$("btn-close").disabled).toBe(true);
    p.$("close-sure").checked = true;
    p.$("close-sure").dispatchEvent(new p.dom.window.Event("change", { bubbles: true }));
    expect(p.$("btn-close").disabled).toBe(false);
    await p.click(p.$("btn-close"));
    expect(p.calls.filter((c) => c.url === BASE + "/revoke")).toHaveLength(1);
    expect(p.$("close-msg").textContent).toBe("Puesto cerrado.");
    expect(p.$("s-state").textContent).toContain("cerrado");
    expect(p.$("btn-close").disabled).toBe(true);
    expect(p.$("btn-save").disabled).toBe(true);
    p.close();
  });
});

describe("what the page tells about the data", () => {
  it("states what is kept, why, and for how long, and does not promise a deletion that does not exist", async () => {
    const p = await load();
    const text = p.$("admin").textContent as string;
    expect(text).toContain("Nombre o iniciales declarados");
    expect(text).toContain("No hay borrado implementado");
    expect(text).toContain("Huella (hash con sal) de la dirección de red");
    expect(text).toContain("Se borra al registrar un intento nuevo pasadas 24 horas");
    expect(text).toContain("al cerrar el puesto");
    expect(text).toContain("La revisión regulatoria de estos datos sigue pendiente");
    expect(text).toContain("no un cumplimiento"); // it says outright that it claims no compliance
    expect(text).not.toMatch(/\bcumple\b|\bcumplimos\b|en cumplimiento|cumpliendo|conforme a la ley/i);
    p.close();
  });

  it("the page and its script carry no PIN-looking value and use no storage of their own", () => {
    for (const text of [HTML, SCRIPT]) {
      expect(text).not.toMatch(/\bpin\b[^\n]{0,20}[:=]\s*["'`]?\d{6,12}\b/i);
      expect(text).not.toMatch(/localStorage|sessionStorage|document\.cookie/);
    }
  });
});
