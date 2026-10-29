import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextResponse } from "next/server";

import { PIN, SLUG, fixture, type Fixture } from "./helpers/redemptionStationFixtures";

// The routes talk to storage through these modules only; behind them are the real in-memory implementations.
vi.mock("@/lib/gaming/redemption-station/http", async () => {
  const actual = await vi.importActual<typeof import("../lib/gaming/redemption-station/http")>("../lib/gaming/redemption-station/http");
  return { ...actual, buildStationDeps: vi.fn() };
});
vi.mock("@/lib/gaming/predictions/httpAuth", async () => {
  const actual = await vi.importActual<typeof import("../lib/gaming/predictions/httpAuth")>("../lib/gaming/predictions/httpAuth");
  return { ...actual, getSupabaseCredentials: vi.fn(), requirePlatformAuthorityHttp: vi.fn() };
});
import * as http from "../lib/gaming/redemption-station/http";
import * as httpAuth from "../lib/gaming/predictions/httpAuth";
import { POST as sessionPOST, DELETE as sessionDELETE } from "../app/api/gaming/canje/[slug]/session/route";
import { GET as prizesGET } from "../app/api/gaming/canje/[slug]/prizes/route";
import { POST as redeemPOST } from "../app/api/gaming/canje/[slug]/redeem/route";
import { POST as revokePOST } from "../app/api/gaming/canje/[slug]/revoke/route";
import { GET as pinGET, POST as pinPOST } from "../app/api/gaming/canje/[slug]/pin/route";
import * as sessionRoute from "../app/api/gaming/canje/[slug]/session/route";
import * as prizesRoute from "../app/api/gaming/canje/[slug]/prizes/route";
import * as redeemRoute from "../app/api/gaming/canje/[slug]/redeem/route";
import * as revokeRoute from "../app/api/gaming/canje/[slug]/revoke/route";
import * as pinRoute from "../app/api/gaming/canje/[slug]/pin/route";

/**
 * The station's HTTP surface: the cookie, the headers, the same-origin rule, the shapes of every refusal, and the revocation and the PIN
 * that only an administrator can ask for.
 */

const params = { params: { slug: SLUG } };
const URL_BASE = "https://gaming.urbanohn.com/api/gaming/canje/" + SLUG;
let f: Fixture;

beforeEach(async () => {
  f = await fixture();
  vi.mocked(http.buildStationDeps).mockReturnValue(f.deps);
  vi.mocked(httpAuth.getSupabaseCredentials).mockReturnValue({ url: "http://127.0.0.1:1", serviceKey: "x" });
});

const post = (url: string, body: unknown, headers: Record<string, string> = {}) =>
  new Request(url, { method: "POST", headers: { "content-type": "application/json", host: "gaming.urbanohn.com", ...headers }, body: typeof body === "string" ? body : JSON.stringify(body) });
const get = (url: string, headers: Record<string, string> = {}) => new Request(url, { headers: { host: "gaming.urbanohn.com", ...headers } });

async function openSession(ip = "10.0.0.1") {
  const res = await sessionPOST(post(URL_BASE + "/session", { pin: PIN }, { "x-forwarded-for": ip }), params);
  const cookie = res.headers.get("set-cookie")!;
  return { res, cookie: cookie.split(";")[0]! };
}

describe("opening a session", () => {
  it("a correct PIN sets a cookie that JavaScript cannot read, that is not sent to other sites, scoped to the station's routes, with an end — and the answer carries no token", async () => {
    const { res, cookie } = await openSession();
    expect(res.status).toBe(200);
    const raw = res.headers.get("set-cookie")!;
    expect(raw).toMatch(/^urbano_canje=[A-Za-z0-9_-]{40,}/);
    expect(raw).toContain("HttpOnly");
    expect(raw).toContain("SameSite=Strict");
    expect(raw).toContain("Path=/api/gaming/canje");
    expect(raw).toMatch(/Max-Age=\d+/);
    expect(raw).toContain("Secure"); // the request came in on https
    const body = await res.json();
    expect(Object.keys(body).sort()).toEqual(["expiresAt", "ok"]);
    expect(JSON.stringify(body)).not.toContain(cookie.split("=")[1]!);
    expect(JSON.stringify(body)).not.toContain(PIN);
    // over plain http (local) there is no Secure flag, so the page can be tried locally
    const local = await sessionPOST(new Request("http://127.0.0.1:3000/api/gaming/canje/" + SLUG + "/session", { method: "POST", headers: { "content-type": "application/json", host: "127.0.0.1:3000" }, body: JSON.stringify({ pin: PIN }) }), params);
    expect(local.headers.get("set-cookie")).not.toContain("Secure");
  });

  it("every answer is never cached, never indexed and keeps the page's address to itself", async () => {
    const { res } = await openSession();
    for (const [name, value] of Object.entries({ "cache-control": "no-store, max-age=0", "x-robots-tag": "noindex, nofollow", "referrer-policy": "no-referrer", "x-content-type-options": "nosniff" })) expect(res.headers.get(name)).toBe(value);
  });

  it("a wrong PIN is 401 with no cookie and no hint; the lock answers 429 with the time to wait", async () => {
    const wrong = await sessionPOST(post(URL_BASE + "/session", { pin: "00000000" }, { "x-forwarded-for": "10.0.0.50" }), params);
    expect(wrong.status).toBe(401);
    expect(wrong.headers.get("set-cookie")).toBeNull();
    expect(await wrong.json()).toMatchObject({ code: "INVALID_PIN" });
    for (let i = 0; i < 4; i++) await sessionPOST(post(URL_BASE + "/session", { pin: "00000000" }, { "x-forwarded-for": "10.0.0.50" }), params);
    const locked = await sessionPOST(post(URL_BASE + "/session", { pin: PIN }, { "x-forwarded-for": "10.0.0.50" }), params);
    expect(locked.status).toBe(429);
    expect(Number(locked.headers.get("retry-after"))).toBeGreaterThan(0);
    expect(locked.headers.get("set-cookie")).toBeNull();
  });

  it("refuses a request from another site, a body that is not JSON, and any field besides the PIN", async () => {
    expect((await sessionPOST(post(URL_BASE + "/session", { pin: PIN }, { origin: "https://evil.example" }), params)).status).toBe(403);
    expect((await sessionPOST(post(URL_BASE + "/session", { pin: PIN }, { "sec-fetch-site": "cross-site" }), params)).status).toBe(403);
    expect((await sessionPOST(post(URL_BASE + "/session", "pin=12345678", { "content-type": "text/plain" }), params)).status).toBe(400);
    expect((await sessionPOST(post(URL_BASE + "/session", "{not json"), params)).status).toBe(400);
    expect((await sessionPOST(post(URL_BASE + "/session", { pin: PIN, station: "otro" }), params)).status).toBe(400);
    expect((await sessionPOST(post(URL_BASE + "/session", [PIN]), params)).status).toBe(400);
    expect((await sessionPOST(post(URL_BASE + "/session", { pin: PIN }, { origin: "https://gaming.urbanohn.com" }), params)).status).toBe(200);
  });

  it("an unknown station is 404; a closed one is 410 and clears the cookie", async () => {
    expect((await sessionPOST(post(URL_BASE + "/session", { pin: PIN }), { params: { slug: "otro-puesto" } })).status).toBe(404);
    await f.stations.revokeStation(f.station.stationId);
    const closed = await sessionPOST(post(URL_BASE + "/session", { pin: PIN }), params);
    expect(closed.status).toBe(410);
    expect(closed.headers.get("set-cookie")).toContain("Max-Age=0");
  });

  it("closing the session ends it; the cookie is cleared", async () => {
    const { cookie } = await openSession();
    const out = await sessionDELETE(new Request(URL_BASE + "/session", { method: "DELETE", headers: { cookie, host: "gaming.urbanohn.com" } }), params);
    expect(out.status).toBe(200);
    expect(out.headers.get("set-cookie")).toContain("Max-Age=0");
    expect((await prizesGET(get(URL_BASE + "/prizes", { cookie }), params)).status).toBe(401);
    expect((await sessionDELETE(new Request(URL_BASE + "/session", { method: "DELETE", headers: { host: "gaming.urbanohn.com", origin: "https://evil.example" } }), params)).status).toBe(403);
  });
});

describe("the prizes and the delivery need the session", () => {
  it("without a session, with a made-up one or an expired one: 401 and the cookie is cleared", async () => {
    for (const cookie of [undefined, "urbano_canje=" + "a".repeat(43), "otra=cosa"]) {
      const res = await prizesGET(get(URL_BASE + "/prizes", cookie ? { cookie } : {}), params);
      expect(res.status).toBe(401);
      expect(res.headers.get("set-cookie")).toContain("Max-Age=0");
      expect(JSON.stringify(await res.json())).not.toMatch(/Ana|Bruno|CL-/);
    }
    const { cookie } = await openSession();
    f.clock.now += 5 * 3600_000;
    expect((await prizesGET(get(URL_BASE + "/prizes", { cookie }), params)).status).toBe(401);
  });

  it("with a session: the station's label and the prizes as name, code, prize and state", async () => {
    const { cookie } = await openSession();
    const res = await prizesGET(get(URL_BASE + "/prizes", { cookie }), params);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(Object.keys(body).sort()).toEqual(["prizes", "station"]);
    expect(Object.keys(body.station).sort()).toEqual(["expiresAt", "label", "sessionExpiresAt"]);
    expect(body.prizes).toHaveLength(3);
    expect(JSON.stringify(body)).not.toMatch(/Carla|Perdedor|@|actor|pin|salt|hash/i);
  });

  it("delivers a prize once, tells a repeat it was already delivered, and refuses what is not a real request", async () => {
    const { cookie } = await openSession();
    const code = (await (await prizesGET(get(URL_BASE + "/prizes", { cookie }), params)).json()).prizes.find((p: { displayName: string }) => p.displayName === "Bruno").code;
    const mk = (body: unknown, headers: Record<string, string> = {}) => post(URL_BASE + "/redeem", body, { cookie, ...headers });
    expect((await redeemPOST(mk({ code, operatorName: "Josué D", confirm: false }), params)).status).toBe(400);
    expect((await redeemPOST(mk({ code, operatorName: "Josué D" }), params)).status).toBe(400);
    expect((await redeemPOST(mk({ code, operatorName: "J", confirm: true }), params)).status).toBe(400);
    expect((await redeemPOST(mk({ code, operatorName: "Josué D", confirm: true, price: 5 }), params)).status).toBe(400);
    expect((await redeemPOST(mk({ code: "CL-AAAAAA", operatorName: "Josué D", confirm: true }), params)).status).toBe(404);
    expect((await redeemPOST(mk({ code, operatorName: "Josué D", confirm: true }, { origin: "https://evil.example" }), params)).status).toBe(403);
    expect((await redeemPOST(post(URL_BASE + "/redeem", { code, operatorName: "Josué D", confirm: true }), params)).status).toBe(401); // no cookie
    const first = await redeemPOST(mk({ code, operatorName: "Josué D", confirm: true }), params);
    expect(first.status).toBe(200);
    expect(await first.json()).toMatchObject({ outcome: "REDEEMED", prize: { code, status: "REDEEMED", displayName: "Bruno" } });
    const second = await redeemPOST(mk({ code, operatorName: "Otra Persona", confirm: true }), params);
    expect(second.status).toBe(200);
    expect(await second.json()).toMatchObject({ outcome: "ALREADY_REDEEMED" });
  });

  it("a prize that cannot be delivered from here is 409", async () => {
    const { cookie } = await openSession();
    const list = (await (await prizesGET(get(URL_BASE + "/prizes", { cookie }), params)).json()).prizes;
    for (const [id, q] of f.qualifications) if (q.venueActivationId === f.world.activationId) f.qualifications.set(id, { ...q, supersededAt: new Date().toISOString() });
    const res = await redeemPOST(post(URL_BASE + "/redeem", { code: list[0].code, operatorName: "Josué D", confirm: true }, { cookie }), params);
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ code: "PRIZE_NOT_AVAILABLE" });
  });

  it("a code that belongs to ANOTHER event is 404 and nothing of it is touched", async () => {
    const { cookie } = await openSession();
    const { prizePublicCode } = await import("../lib/gaming/redemption-station/publicCode");
    const res = await redeemPOST(post(URL_BASE + "/redeem", { code: prizePublicCode(f.otherPrizeId), operatorName: "Josué D", confirm: true }, { cookie }), params);
    expect(res.status).toBe(404);
    expect(f.qualifications.get(f.otherPrizeId)!.redeemedAt).toBeNull();
  });
});

describe("a station without a PIN yet", () => {
  it("answers 409 STATION_NOT_ACTIVATED, sets no cookie and counts no attempt", async () => {
    f = await fixture({ withPin: false });
    vi.mocked(http.buildStationDeps).mockReturnValue(f.deps);
    const res = await sessionPOST(post(URL_BASE + "/session", { pin: PIN }, { "x-forwarded-for": "10.0.0.40" }), params);
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ code: "STATION_NOT_ACTIVATED" });
    expect(res.headers.get("set-cookie")).toBeNull();
    expect(f.stations.attemptRows()).toHaveLength(0);
  });
});

describe("the PIN of the station (administration)", () => {
  const asAdmin = () => vi.mocked(httpAuth.requirePlatformAuthorityHttp).mockResolvedValue({ gamingMemberId: "admin-operator" } as never);
  const asNobody = (status: number) => vi.mocked(httpAuth.requirePlatformAuthorityHttp).mockResolvedValue({ errorResponse: NextResponse.json({ error: "no" }, { status }) } as never);

  it("needs OPERATIONAL authority to read the state and to set the PIN: without it nothing changes and the answer is never cached", async () => {
    const { cookie } = await openSession();
    for (const status of [401, 403]) {
      asNobody(status);
      const read = await pinGET(get(URL_BASE + "/pin"), params);
      const write = await pinPOST(post(URL_BASE + "/pin", { pin: "73920461", confirmPin: "73920461" }), params);
      expect([read.status, write.status]).toEqual([status, status]);
      expect(read.headers.get("cache-control")).toBe("no-store");
      expect(write.headers.get("cache-control")).toBe("no-store");
    }
    expect((await prizesGET(get(URL_BASE + "/prizes", { cookie }), params)).status).toBe(200); // the session was not touched
    expect((await f.stations.getStationBySlug(SLUG))!.pinVersion).toBe(1);
    expect(vi.mocked(httpAuth.requirePlatformAuthorityHttp).mock.calls.every((call) => call[2] === "OPERATIONAL")).toBe(true);
  });

  it("the state shows the PIN version and the open sessions — never the PIN, its hash or its salt", async () => {
    await openSession("10.0.0.1"); await openSession("10.0.0.2");
    asAdmin();
    const res = await pinGET(get(URL_BASE + "/pin"), params);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({ slug: SLUG, pinSet: true, pinVersion: 1, activeSessions: 2, lastPinChangeAt: null });
    expect(JSON.stringify(body)).not.toMatch(/salt|hash|"pin"|actor|48151623/i);
  });

  it("setting the PIN answers only the new version and the sessions it closed; the old cookie stops working, the new PIN opens a session", async () => {
    const { cookie } = await openSession();
    asAdmin();
    const res = await pinPOST(post(URL_BASE + "/pin", { pin: "73920461", confirmPin: "73920461" }), params);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({ ok: true, pinVersion: 2, sessionsRevoked: 1 });
    expect(JSON.stringify(body)).not.toContain("73920461");
    expect(res.headers.get("set-cookie")).toBeNull();
    expect((await prizesGET(get(URL_BASE + "/prizes", { cookie }), params)).status).toBe(401);
    expect((await sessionPOST(post(URL_BASE + "/session", { pin: PIN }, { "x-forwarded-for": "10.0.0.3" }), params)).status).toBe(401);
    const fresh = await sessionPOST(post(URL_BASE + "/session", { pin: "73920461" }, { "x-forwarded-for": "10.0.0.4" }), params);
    expect(fresh.status).toBe(200);
    expect((await prizesGET(get(URL_BASE + "/prizes", { cookie: fresh.headers.get("set-cookie")!.split(";")[0]! }), params)).status).toBe(200);
    expect((await f.stations.listPinChanges(f.station.stationId))[0]).toMatchObject({ changedByGamingMemberId: "admin-operator", newPinVersion: 2, sessionsRevoked: 1 });
  });

  it("refuses a mismatch, an obvious or malformed PIN, extra fields, a body that is not JSON and another site — and changes nothing", async () => {
    asAdmin();
    const attempts: Array<[unknown, Record<string, string>?, number?]> = [
      [{ pin: "73920461", confirmPin: "73920462" }, undefined, 400],
      [{ pin: "73920461" }, undefined, 400],
      [{ pin: "11111111", confirmPin: "11111111" }, undefined, 400],
      [{ pin: "12345678", confirmPin: "12345678" }, undefined, 400],
      [{ pin: "1234567", confirmPin: "1234567" }, undefined, 400],
      [{ pin: 73920461, confirmPin: 73920461 }, undefined, 400],
      [{ pin: "73920461", confirmPin: "73920461", extra: 1 }, undefined, 400],
      ["pin=73920461", { "content-type": "text/plain" }, 400],
      [{ pin: "73920461", confirmPin: "73920461" }, { origin: "https://evil.example" }, 403],
      [{ pin: "73920461", confirmPin: "73920461" }, { "sec-fetch-site": "cross-site" }, 403],
    ];
    for (const [body, headers, status] of attempts) expect((await pinPOST(post(URL_BASE + "/pin", body, headers), params)).status, JSON.stringify(body)).toBe(status);
    expect((await f.stations.getStationBySlug(SLUG))!.pinVersion).toBe(1);
    expect(await f.stations.listPinChanges(f.station.stationId)).toHaveLength(0);
  });

  it("an unknown station is 404; a closed one is 410 and keeps its PIN", async () => {
    asAdmin();
    expect((await pinPOST(post(URL_BASE + "/pin", { pin: "73920461", confirmPin: "73920461" }), { params: { slug: "otro-puesto" } })).status).toBe(404);
    expect((await pinGET(get(URL_BASE + "/pin"), { params: { slug: "otro-puesto" } })).status).toBe(404);
    await f.stations.revokeStation(f.station.stationId);
    expect((await pinPOST(post(URL_BASE + "/pin", { pin: "73920461", confirmPin: "73920461" }), params)).status).toBe(410);
    expect((await f.stations.getStationBySlug(SLUG))!.pinVersion).toBe(1);
  });

  it("the PIN is not written to the server log, even when the database fails", async () => {
    asAdmin();
    vi.spyOn(f.stations, "setPin").mockRejectedValue(Object.assign(new Error("boom 73920461"), { name: "PgError" }));
    const logged: string[] = [];
    const spy = vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => { logged.push(args.map((a) => (a instanceof Error ? a.message + a.name : String(a))).join(" ")); });
    const res = await pinPOST(post(URL_BASE + "/pin", { pin: "73920461", confirmPin: "73920461" }), params);
    expect(res.status).toBe(500);
    expect(JSON.stringify(await res.json())).not.toContain("73920461");
    expect(logged.join("\n")).not.toContain("73920461");
    spy.mockRestore();
  });
});

describe("revoking the access", () => {
  it("needs OPERATIONAL authority: without it nothing changes; with it the station and every session are closed", async () => {
    const { cookie } = await openSession();
    vi.mocked(httpAuth.requirePlatformAuthorityHttp).mockResolvedValue({ errorResponse: NextResponse.json({ error: "no" }, { status: 403 }) } as never);
    const refused = await revokePOST(post(URL_BASE + "/revoke", {}), params);
    expect(refused.status).toBe(403);
    expect(refused.headers.get("cache-control")).toBe("no-store");
    expect((await prizesGET(get(URL_BASE + "/prizes", { cookie }), params)).status).toBe(200);

    vi.mocked(httpAuth.requirePlatformAuthorityHttp).mockResolvedValue({ gamingMemberId: "admin" } as never);
    const done = await revokePOST(post(URL_BASE + "/revoke", {}), params);
    expect(done.status).toBe(200);
    expect(await done.json()).toEqual({ ok: true, revoked: true });
    expect((await revokePOST(post(URL_BASE + "/revoke", {}), params)).status).toBe(200); // idempotent
    expect((await prizesGET(get(URL_BASE + "/prizes", { cookie }), params)).status).toBe(401);
    expect((await sessionPOST(post(URL_BASE + "/session", { pin: PIN }), params)).status).toBe(410);
    expect((await revokePOST(post(URL_BASE + "/revoke", {}), { params: { slug: "otro-puesto" } })).status).toBe(404);
    expect(vi.mocked(httpAuth.requirePlatformAuthorityHttp).mock.calls.every((call) => call[2] === "OPERATIONAL")).toBe(true);
  });
});

describe("the routes are never served from a cache", () => {
  it("every route forces dynamic rendering and no fetch cache", () => {
    for (const mod of [sessionRoute, prizesRoute, redeemRoute, revokeRoute, pinRoute]) {
      expect(mod.dynamic).toBe("force-dynamic");
      expect(mod.fetchCache).toBe("force-no-store");
      expect(mod.revalidate).toBe(0);
    }
  });

  it("the pages of the station are served with strict headers: no framing, no indexing, no caching — the public page also with only its own script", async () => {
    // the file Next 14 actually loads is next.config.mjs (next.config.cjs is not read by Next), so that is the one that is checked
    const config = (await import("../next.config.mjs")) as { default: { headers: () => Promise<Array<{ source: string; headers: Array<{ key: string; value: string }> }>> } };
    const headers = await config.default.headers();
    expect(headers.map((h) => h.source)).toEqual(["/canje-the-pub.html", "/canje-admin.html"]);
    const admin = Object.fromEntries(headers[1]!.headers.map((h) => [h.key, h.value]));
    expect(admin["X-Frame-Options"]).toBe("DENY");
    expect(admin["Cache-Control"]).toContain("no-store");
    expect(admin["X-Robots-Tag"]).toContain("noindex");
    expect(admin["Referrer-Policy"]).toBe("no-referrer");
    const byKey = Object.fromEntries(headers[0]!.headers.map((h) => [h.key, h.value]));
    expect(byKey["X-Frame-Options"]).toBe("DENY");
    expect(byKey["Cache-Control"]).toContain("no-store");
    expect(byKey["X-Robots-Tag"]).toContain("noindex");
    expect(byKey["Content-Security-Policy"]).toContain("script-src 'self'");
    expect(byKey["Content-Security-Policy"]).toContain("frame-ancestors 'none'");
    expect(byKey["Content-Security-Policy"]).toContain("connect-src 'self'");
    expect(byKey["Content-Security-Policy"]).not.toContain("unsafe-eval");
    expect(byKey["Content-Security-Policy"]).not.toMatch(/script-src[^;]*unsafe-inline/);
  });
});
