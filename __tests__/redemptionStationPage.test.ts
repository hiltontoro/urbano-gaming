import { describe, expect, it } from "vitest";
import { JSDOM } from "jsdom";
import { readFileSync } from "node:fs";
import path from "node:path";

/**
 * THE REDEMPTION STATION PAGE (public/canje-the-pub.html + public/canjeStation.js), run whole in jsdom as shipped, against a stand-in for the
 * station's server: what the staff sees, in what order, what the warnings say, and what is never in the page.
 */

const HTML = readFileSync(path.join(process.cwd(), "public/canje-the-pub.html"), "utf8");
const SCRIPT = readFileSync(path.join(process.cwd(), "public/canjeStation.js"), "utf8");
const BASE = "/api/gaming/canje/clasico-the-pub-2026-10-25";

interface Prize { code: string; displayName: string; prizeLabel: string; status: "PENDING" | "REDEEMED" | "UNAVAILABLE"; redeemedAt: string | null }
const prizes = (): Prize[] => [
  { code: "CL-3F7K9Q", displayName: "Ana", prizeLabel: "Una orden de tequeños por ganador", status: "PENDING", redeemedAt: null },
  { code: "CL-8M2N4P", displayName: "Ana", prizeLabel: "Una orden de tequeños por ganador", status: "PENDING", redeemedAt: null },
  { code: "CL-0A1B2C", displayName: "Bruno", prizeLabel: "Un bono de consumo de L500 por ganador", status: "REDEEMED", redeemedAt: "2026-10-29T20:05:00.000Z" },
  { code: "CL-5D6E7F", displayName: "Carlos", prizeLabel: "Un bono de consumo de L250 por ganador", status: "UNAVAILABLE", redeemedAt: null },
];

interface Opts {
  signedIn?: boolean;
  loginStatus?: number;
  loginJson?: unknown;
  redeemStatus?: number;
  redeemJson?: unknown;
  listStatus?: number;
  list?: Prize[];
  redeemDelayMs?: number;
  throwOnRedeem?: boolean;
}

async function load(opts: Opts = {}) {
  const calls: Array<{ url: string; method: string; body: any }> = [];
  const state = { signedIn: opts.signedIn ?? false, list: opts.list ?? prizes() };
  const dom = new JSDOM(HTML.replace(/<script src="[^"]*"><\/script>/, ""), { url: "http://localhost/canje-the-pub.html", runScripts: "dangerously", pretendToBeVisual: true });
  const w = dom.window as unknown as Record<string, any>;
  w.fetch = async (url: string, init: any = {}) => {
    const method = (init.method ?? "GET").toUpperCase();
    calls.push({ url: String(url), method, body: init.body ? JSON.parse(init.body) : null });
    const reply = (status: number, json: unknown) => ({ status, json: async () => JSON.parse(JSON.stringify(json)) });
    const u = String(url);
    if (u === BASE + "/prizes") {
      if (opts.listStatus && opts.listStatus !== 200) return reply(opts.listStatus, { error: "x" });
      return state.signedIn
        ? reply(200, { station: { label: "The Pub · El Clásico", expiresAt: "2026-11-01T06:00:00.000Z", sessionExpiresAt: "2026-10-29T23:00:00.000Z" }, prizes: state.list })
        : reply(401, { error: "x", code: "SESSION_INVALID" });
    }
    if (u === BASE + "/session" && method === "POST") {
      const status = opts.loginStatus ?? 200;
      if (status === 200) state.signedIn = true;
      return reply(status, opts.loginJson ?? (status === 200 ? { ok: true } : { error: "x" }));
    }
    if (u === BASE + "/session" && method === "DELETE") { state.signedIn = false; return reply(200, { ok: true }); }
    if (u === BASE + "/redeem") {
      if (opts.throwOnRedeem) throw new Error("offline");
      if (opts.redeemDelayMs) await new Promise((r) => setTimeout(r, opts.redeemDelayMs));
      const status = opts.redeemStatus ?? 200;
      if (status === 200) {
        const code = JSON.parse(init.body).code;
        const prize = state.list.find((p) => p.code === code)!;
        const again = prize.status === "REDEEMED";
        prize.status = "REDEEMED"; prize.redeemedAt = "2026-10-29T21:00:00.000Z";
        return reply(200, opts.redeemJson ?? { outcome: again ? "ALREADY_REDEEMED" : "REDEEMED", prize });
      }
      return reply(status, opts.redeemJson ?? { error: "x" });
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
  const click = async (el: any) => { el.click(); await settle(); };
  const type = (id: string, value: string) => { $(id).value = value; $(id).dispatchEvent(new dom.window.Event("input", { bubbles: true })); };
  const visible = () => ["login", "closed", "list", "confirm"].filter((id) => !$(id).hidden);
  return { dom, doc, calls, state, $, click, type, settle, visible, close: () => dom.window.close() };
}

async function signIn(p: Awaited<ReturnType<typeof load>>) {
  p.$("pin").value = "48151623";
  p.$("login-form").dispatchEvent(new p.dom.window.Event("submit", { bubbles: true, cancelable: true }));
  await p.settle();
}

describe("a station that has no PIN yet and what the page says about the data", () => {
  it("when the session ends (or the station closes) the names and codes are removed from the page, not just hidden", async () => {
    const p = await load({ signedIn: true });
    expect(p.doc.querySelectorAll("#prizes .prize").length).toBe(4);
    await p.click(p.$("btn-logout"));
    expect(p.visible()).toEqual(["login"]);
    expect(p.doc.querySelectorAll("#prizes .prize").length).toBe(0);
    expect(p.doc.documentElement.outerHTML).not.toMatch(/CL-3F7K9Q|Ana|Bruno|Carlos/);
    const closed = await load({ signedIn: true });
    closed.state.signedIn = true;
    (closed.dom.window as any).fetch = async () => ({ status: 410, json: async () => ({ error: "x", code: "STATION_CLOSED" }) });
    await closed.click(closed.$("btn-refresh"));
    expect(closed.visible()).toEqual(["closed"]);
    expect(closed.doc.querySelectorAll("#prizes .prize").length).toBe(0);
    expect(closed.doc.documentElement.outerHTML).not.toMatch(/CL-3F7K9Q|Ana|Bruno|Carlos/);
    p.close(); closed.close();
  });

  it("a station without a PIN says it is not activated yet, keeps the list hidden and asks the staff to tell URBANO", async () => {
    const p = await load({ loginStatus: 409, loginJson: { error: "x", code: "STATION_NOT_ACTIVATED" } });
    await signIn(p);
    expect(p.$("login-msg").textContent).toBe("Este puesto todavía no está activado. Avisa a URBANO.");
    expect(p.$("login-msg").className).toContain("error");
    expect(p.$("pin").value).toBe("");
    expect(p.visible()).toEqual(["login"]);
    p.close();
  });

  it("before confirming, the page says the declared name is kept only as a record of this delivery, with the date and time, and for nothing else", async () => {
    const p = await load({ signedIn: true });
    await p.click(p.doc.querySelector("#prizes button.primary"));
    expect(p.$("confirm").textContent).toContain("PIN compartido");
    expect(p.$("confirm").textContent).toContain("queda registrado solo como declaración tuya, con la fecha y la hora");
    expect(p.$("confirm").textContent).toContain("para dejar constancia de esta entrega; no se usa para nada más");
    p.close();
  });
});

describe("entering", () => {
  it("without a session the only thing shown is the PIN field: numeric keypad, hidden characters, nothing remembered", async () => {
    const p = await load();
    expect(p.visible()).toEqual(["login"]);
    const pin = p.$("pin");
    expect(pin.type).toBe("password");
    expect(pin.getAttribute("inputmode")).toBe("numeric");
    expect(pin.getAttribute("autocomplete")).toBe("off");
    expect(p.$("login").textContent).not.toMatch(/Ana|Bruno|CL-/);
    p.close();
  });

  it("with a session already open the list is shown at once, without asking for the PIN again", async () => {
    const p = await load({ signedIn: true });
    expect(p.visible()).toEqual(["list"]);
    expect(p.$("station-label").textContent).toBe("The Pub · El Clásico");
    p.close();
  });

  it("a wrong PIN says so, keeps the list hidden and the PIN field empty; the PIN is never stored anywhere in the page", async () => {
    const p = await load({ loginStatus: 401 });
    await signIn(p);
    expect(p.$("login-msg").textContent).toBe("El PIN no es correcto.");
    expect(p.$("login-msg").className).toContain("error");
    expect(p.$("pin").value).toBe("");
    expect(p.visible()).toEqual(["login"]);
    const w = p.dom.window as any;
    expect(JSON.stringify(Object.entries(w.localStorage))).not.toContain("48151623");
    expect(JSON.stringify(Object.entries(w.sessionStorage))).not.toContain("48151623");
    expect(p.doc.cookie).not.toContain("48151623");
    expect(p.doc.documentElement.outerHTML).not.toContain("48151623");
    // the PIN went to the server once, in the body of the request and nowhere else
    const logins = p.calls.filter((c) => c.url === BASE + "/session" && c.method === "POST");
    expect(logins).toHaveLength(1);
    expect(logins[0]!.body).toEqual({ pin: "48151623" });
    p.close();
  });

  it("too many attempts: it says how long to wait and shows nothing else; a closed station says it is closed", async () => {
    const locked = await load({ loginStatus: 429, loginJson: { retryAfterSeconds: 540 } });
    await signIn(locked);
    expect(locked.$("login-msg").textContent).toBe("Demasiados intentos. Espera 9 min y vuelve a intentar.");
    expect(locked.visible()).toEqual(["login"]);
    locked.close();
    const closed = await load({ loginStatus: 410 });
    await signIn(closed);
    expect(closed.visible()).toEqual(["closed"]);
    expect(closed.$("closed").textContent).toContain("cerrado");
    closed.close();
  });

  it("a double tap on «Entrar» is one request", async () => {
    const p = await load({ loginStatus: 401 });
    p.$("pin").value = "48151623";
    const submit = () => p.$("login-form").dispatchEvent(new p.dom.window.Event("submit", { bubbles: true, cancelable: true }));
    submit(); submit();
    await p.settle();
    expect(p.calls.filter((c) => c.url === BASE + "/session" && c.method === "POST")).toHaveLength(1);
    p.close();
  });
});

describe("the list", () => {
  it("shows each prize as name, code, prize and state — and nothing else — with «Entregar» only on the pending ones", async () => {
    const p = await load();
    await signIn(p);
    expect(p.visible()).toEqual(["list"]);
    const cards = [...p.doc.querySelectorAll("#prizes .prize")] as any[];
    expect(cards).toHaveLength(4);
    expect(cards.map((c) => c.querySelector(".name").textContent)).toEqual(["Ana", "Ana", "Bruno", "Carlos"]);
    expect(cards.map((c) => c.querySelector(".code").textContent)).toEqual(["CL-3F7K9Q", "CL-8M2N4P", "CL-0A1B2C", "CL-5D6E7F"]); // two Ana, told apart by the code
    expect(cards.map((c) => c.querySelector(".chip").textContent)).toEqual(["Pendiente", "Pendiente", "Canjeado · 29/10 2:05 p. m.", "No disponible · consulta con URBANO"]);
    expect(cards.map((c) => c.querySelectorAll("button").length)).toEqual([1, 1, 0, 0]);
    expect(p.$("prizes").textContent).not.toMatch(/@|\+504|tel/i);
    p.close();
  });

  it("text that came from the server is only ever text: a name that looks like markup is not markup", async () => {
    const p = await load({ signedIn: true, list: [{ code: "CL-3F7K9Q", displayName: "<img src=x onerror=alert(1)>", prizeLabel: "<b>L500</b>", status: "PENDING", redeemedAt: null }] });
    expect(p.doc.querySelectorAll("#prizes img, #prizes b").length).toBe(0);
    expect(p.$("prizes").textContent).toContain("<img src=x onerror=alert(1)>");
    p.close();
  });

  it("the page explains the check before delivering, and a session note says when the access ends", async () => {
    const p = await load({ signedIn: true });
    expect(p.$("list").textContent).toContain("Mi participación");
    expect(p.$("list").textContent).toContain("solo entonces regístralo aquí");
    expect(p.$("session-note").textContent).toMatch(/^La sesión termina a las \d+:\d\d (a\. m\.|p\. m\.) \(hora de Honduras\)\.$/);
    p.close();
  });

  it("«Salir» closes the session on the server and goes back to the PIN", async () => {
    const p = await load({ signedIn: true });
    await p.click(p.$("btn-logout"));
    expect(p.calls.some((c) => c.method === "DELETE" && c.url === BASE + "/session")).toBe(true);
    expect(p.visible()).toEqual(["login"]);
    p.close();
  });

  it("when the session ended while the page was open, the next refresh goes back to the PIN", async () => {
    const p = await load({ signedIn: true });
    p.state.signedIn = false;
    await p.click(p.$("btn-refresh"));
    expect(p.visible()).toEqual(["login"]);
    p.close();
  });
});

describe("delivering a prize", () => {
  async function toConfirm(opts: Opts = {}) {
    const p = await load({ signedIn: true, ...opts });
    await p.click(p.doc.querySelector("#prizes .prize button") as any);
    return p;
  }

  it("shows who and what, warns not to confirm before delivering, and cannot be confirmed without a name and the tick", async () => {
    const p = await toConfirm();
    expect(p.visible()).toEqual(["confirm"]);
    expect(p.$("c-name").textContent).toBe("Ana");
    expect(p.$("c-code").textContent).toBe("CL-3F7K9Q");
    expect(p.$("c-prize").textContent).toBe("Una orden de tequeños por ganador");
    expect(p.$("confirm").textContent).toContain("No confirmes antes de entregar");
    expect(p.$("confirm").textContent).toContain("no se puede deshacer");
    expect(p.$("confirm").textContent).toContain("PIN compartido");
    expect(p.$("confirm").textContent).toContain("solo como declaración");
    expect(p.$("btn-confirm").disabled).toBe(true);
    p.type("operator", "Josué D");
    expect(p.$("btn-confirm").disabled).toBe(true); // still no tick
    p.$("delivered").checked = true; p.$("delivered").dispatchEvent(new p.dom.window.Event("change", { bubbles: true }));
    expect(p.$("btn-confirm").disabled).toBe(false);
    for (const bad of ["", "J", "<b>", "x".repeat(41), "  "]) { p.type("operator", bad); expect(p.$("btn-confirm").disabled, JSON.stringify(bad)).toBe(true); }
    p.type("operator", "JD"); expect(p.$("btn-confirm").disabled).toBe(false);
    expect(p.calls.filter((c) => c.url.endsWith("/redeem"))).toHaveLength(0);
    p.close();
  });

  it("cancelling goes back to the list without sending anything", async () => {
    const p = await toConfirm();
    await p.click(p.$("btn-cancel"));
    expect(p.visible()).toEqual(["list"]);
    expect(p.calls.filter((c) => c.url.endsWith("/redeem"))).toHaveLength(0);
    p.close();
  });

  it("confirming sends the code, the declared name and the confirmation — once — and the list comes back with the prize marked delivered", async () => {
    const p = await toConfirm();
    p.type("operator", "  Josué   D ");
    p.$("delivered").checked = true; p.$("delivered").dispatchEvent(new p.dom.window.Event("change", { bubbles: true }));
    await p.click(p.$("btn-confirm"));
    const sent = p.calls.filter((c) => c.url === BASE + "/redeem");
    expect(sent).toHaveLength(1);
    expect(sent[0]!.body).toEqual({ code: "CL-3F7K9Q", operatorName: "Josué D", confirm: true });
    expect(p.visible()).toEqual(["list"]);
    expect(p.$("list-msg").textContent).toBe("Canje registrado.");
    expect(p.$("list-msg").className).toContain("success");
    const chips = [...p.doc.querySelectorAll("#prizes .chip")].map((c) => c.textContent);
    expect(chips[0]).toMatch(/^Canjeado/);
    expect(chips[1]).toBe("Pendiente");
    expect(p.doc.querySelectorAll("#prizes .prize")[0]!.querySelectorAll("button").length).toBe(0);
    p.close();
  });

  it("hammering «Confirmar» is ONE request: a second tap is not a second delivery", async () => {
    const p = await toConfirm({ redeemDelayMs: 80 });
    p.type("operator", "Josué D");
    p.$("delivered").checked = true; p.$("delivered").dispatchEvent(new p.dom.window.Event("change", { bubbles: true }));
    p.$("btn-confirm").click(); p.$("btn-confirm").click(); p.$("btn-confirm").click();
    await p.settle(200);
    expect(p.calls.filter((c) => c.url === BASE + "/redeem")).toHaveLength(1);
    p.close();
  });

  it("if someone else already delivered it, it says so plainly and records nothing new", async () => {
    const p = await toConfirm({ redeemJson: { outcome: "ALREADY_REDEEMED", prize: { ...prizes()[0], status: "REDEEMED", redeemedAt: "2026-10-29T20:00:00.000Z" } } });
    p.type("operator", "Josué D");
    p.$("delivered").checked = true; p.$("delivered").dispatchEvent(new p.dom.window.Event("change", { bubbles: true }));
    await p.click(p.$("btn-confirm"));
    expect(p.$("list-msg").textContent).toBe("Este premio ya estaba canjeado. No se registró un segundo canje.");
    expect(p.$("list-msg").className).toContain("warn");
    p.close();
  });

  it("session ended: back to the PIN with the reason; not deliverable: the list with the reason; no connection: it does NOT claim anything", async () => {
    const fill = async (p: Awaited<ReturnType<typeof load>>) => { p.type("operator", "Josué D"); p.$("delivered").checked = true; p.$("delivered").dispatchEvent(new p.dom.window.Event("change", { bubbles: true })); await p.click(p.$("btn-confirm")); };
    const expired = await toConfirm({ redeemStatus: 401 }); await fill(expired);
    expect(expired.visible()).toEqual(["login"]);
    expect(expired.$("login-msg").textContent).toBe("La sesión terminó. Entra de nuevo con el PIN.");
    expired.close();
    const refused = await toConfirm({ redeemStatus: 409 }); await fill(refused);
    expect(refused.visible()).toEqual(["list"]);
    expect(refused.$("list-msg").textContent).toBe("Este premio no se puede entregar desde aquí. Consulta con URBANO.");
    refused.close();
    const closed = await toConfirm({ redeemStatus: 410 }); await fill(closed);
    expect(closed.visible()).toEqual(["closed"]);
    closed.close();
    const offline = await toConfirm({ throwOnRedeem: true }); await fill(offline);
    expect(offline.visible()).toEqual(["confirm"]);
    expect(offline.$("confirm-msg").textContent).toContain("No sabemos si se registró: actualiza la lista antes de intentar de nuevo.");
    expect(offline.$("btn-confirm").disabled).toBe(false);
    offline.close();
  });
});

describe("what the page is", () => {
  it("is made for a phone, is not indexed and loads nothing from outside", () => {
    expect(HTML).toContain('name="viewport" content="width=device-width, initial-scale=1"');
    expect(HTML).toContain('name="robots" content="noindex, nofollow"');
    expect(HTML).toContain('name="referrer" content="no-referrer"');
    const sources = [...HTML.matchAll(/(?:src|href)="([^"#]+)"/g)].map((m) => m[1]);
    expect(sources.sort()).toEqual(["/canjeStation.js", "/email/urbano-lockup-email.png"]);
    expect(HTML).not.toMatch(/<script(?![^>]*src=)[^>]*>/); // no inline script (the policy forbids it)
    expect(HTML).not.toMatch(/\son\w+=/i);
  });

  it("every button and field is big enough to tap, and keyboard focus is visible", () => {
    expect(HTML).toMatch(/button \{[^}]*min-height: 52px/);
    expect(HTML).toMatch(/input\[type="password"\], input\[type="text"\] \{[^}]*min-height: 52px/);
    expect(HTML).toContain(".check input { width: 26px; height: 26px;");
    expect(HTML).toContain(":focus-visible");
  });

  it("the script never builds markup from server text, never uses storage and never evaluates anything", () => {
    expect(SCRIPT).not.toMatch(/innerHTML|outerHTML|insertAdjacentHTML|document\.write|eval\(|new Function/);
    expect(SCRIPT).not.toMatch(/localStorage|sessionStorage|document\.cookie|indexedDB/);
    expect(SCRIPT).not.toMatch(/https?:\/\//);
  });

  it("has no e-mail, phone, PIN or credential in the page or its script", () => {
    for (const text of [HTML, SCRIPT]) {
      expect(text).not.toMatch(/[\w.+-]+@[\w-]+\.[\w.]+/);
      expect(text).not.toMatch(/\+?504[ -]?\d{4}[ -]?\d{4}/);
      expect(text).not.toMatch(/service[_ -]?role|api[_-]?key|secret|password\s*[:=]/i);
    }
  });
});
