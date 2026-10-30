import { readFileSync } from "node:fs";

import { describe, expect, it, vi } from "vitest";

/**
 * Two-round pilot — the pure logic behind the voter page and the operator tablet, executed from the EXACT deployed source text (the
 * technique competitionsLifecycle.test.ts uses). No DOM, no network, no timers: the clock, the storage, the location sensor and the
 * server are all injected, which is what makes the rules that matter provable here:
 *   - the preliminary never asks the browser for a position; the final asks once per vote;
 *   - a vote is confirmed only on the server's 200, and a lost response is retried with the SAME intent;
 *   - a session is never replaced, and a sign-in / profile detour comes back to the chosen contestant without voting for it.
 */

function load<T>(file: string, name: string): T {
  const source = readFileSync(`public/${file}`, "utf-8");
  // eslint-disable-next-line @typescript-eslint/no-implied-eval
  return new Function(`${source}\nreturn ${name};`)() as T;
}

type Json = Record<string, any>;
type Reply = { status: number; json: Json | null };

interface RoundApi {
  bind(): Promise<Reply>;
  intent(): Promise<Reply>;
  vote(body: Json): Promise<Reply>;
}
interface Round {
  describeError(code: string | undefined | null): string;
  identityStep(status: string): "SIGN_IN" | "PROFILE" | "READY";
  stepForError(code: string): "SIGN_IN" | "PROFILE" | null;
  PROFILE_NOTICE: string;
  SIGN_IN_NOTICE: string;
  createPendingSelection(storage: Pick<Storage, "getItem" | "setItem" | "removeItem">, instanceId: string, now?: () => number): { get(): string | null; set(alias: string): boolean; clear(): void };
  resumeSelection(pending: string | null, items: Json[], phase: string, myCandidateId: string | null): Json | null;
  createCountdown(initialMs: number | null, now?: () => number): { remaining(): number | null; resync(ms: number | null): void; expired(): boolean };
  formatCountdown(ms: number): string;
  deadlineRemainingText(info: Json): string | null;
  formatEventTime(iso: string | null): string;
  EVENT_TIME_ZONE: string;
  phaseNotice(info: Json): string;
  computeVirtualWindow(o: { total: number; columns: number; rowHeight: number; scrollTop: number; viewportHeight: number; overscanRows?: number }): {
    firstRow: number; lastRow: number; firstIndex: number; lastIndex: number; topPadding: number; bottomPadding: number; totalRows: number; totalHeight: number;
  };
  deckNavigate(index: number, delta: number, total: number): number;
  swipeIntent(o: { dx: number; dy: number; minDistance?: number }): "next" | "prev" | null;
  locationRequired(info: Json | null): boolean;
  readPosition(geo: unknown, opts?: { timeoutMs?: number }): Promise<{ latitude: number; longitude: number; accuracyMeters: number }>;
  castFavorite(deps: { api: RoundApi; geolocation: unknown; info: Json; candidateId: string; interactionInstanceId: string; retry?: Json | null }): Promise<Json>;
  buildApi(fetchImpl: (url: string, init: Json) => Promise<{ status: number; json: () => Promise<Json> }>, getToken: () => Promise<string | null>, instanceId: string): Record<string, (...a: any[]) => Promise<Reply>>;
}
interface Operator {
  entryNextStep(entry: Json): string;
  roundReadiness(overview: Json): { ready: boolean; activeCount: number; blockers: Array<{ entryId: string; label: string; reason: string }> };
  nextSteps(overview: Json): Array<{ key: string; label: string; done: boolean; enabled: boolean; reason: string | null }>;
  deadlineLabel(overview: Json, elapsed?: number): string | null;
  promoLabel(state: string): string;
  describeError(code: string): string;
  planResize(w: number, h: number, maxLongSide: number): { width: number; height: number; scale: number };
  formatClaimCode(code: string): string;
  POLICY_INFO: Record<string, { value: string; title: string; applies: string; ifRecorded: string; whilePending: string }>;
  POLICY_ORDER: string[];
  POLICY_STATUS_PENDING: string;
  POLICY_STATUS_RECORDED: string;
  POLICY_ACTION_LABEL: string;
  POLICY_OPERATOR_NOTICE: string;
  POLICY_ACK_TEXT: string;
  POLICY_RECORDED_NOTICE: string;
  POLICY_MISSING_ACK: string;
  POLICY_MISSING_REFERENCE: string;
  buildOperatorApi(fetchImpl: (url: string, init: Json) => Promise<{ status: number; json: () => Promise<Json> }>, getToken: () => Promise<string | null>, getHost: () => string, instanceId: string): Record<string, (...a: any[]) => Promise<Reply>>;
}

const R = load<Round>("communityVotingRound.js", "CommunityVotingRound");
const O = load<Operator>("communityVotingRoundOperator.js", "CommunityVotingRoundOperator");
interface Slideshow {
  createRotation(random?: () => number): {
    load(items: Array<{ alias: string; imageUrl: string }>): void;
    next(): { alias: string; imageUrl: string } | null;
    needsRefresh(): boolean;
    passSize(): number;
    peek(): { alias: string; imageUrl: string } | null;
  };
}
const Slideshow = load<Slideshow>("communityVotingSlideshow.js", "CommunityVotingSlideshow");
const ids = (n: number, from = 1) => Array.from({ length: n }, (_, i) => `id-${String(from + i).padStart(4, "0")}`);
void ids;

const ID = "11111111-2222-4333-8444-555555555555";
const CAND = "aaaaaaaa-bbbb-4ccc-8ddd-000000000001";
const INTERACTION = "bbbbbbbb-bbbb-4ccc-8ddd-000000000002";
const BINDING = "cccccccc-bbbb-4ccc-8ddd-000000000003";

// ---------------------------------------------------------------- messages

describe("messages", () => {
  const CODES = [
    "AUTHENTICATION_REQUIRED", "VERIFIED_EMAIL_REQUIRED", "PROFILE_INCOMPLETE", "INSTANCE_NOT_FOUND", "NOT_BOUND", "ADMISSION_CLOSED", "VOTING_NOT_OPEN",
    "VOTING_WINDOW_ELAPSED", "CANDIDATE_NOT_AVAILABLE", "SELF_VOTE_NOT_ALLOWED", "STALE_INTENT", "INVALID_LOCATION_READING", "LOCATION_ACCURACY_EXCESSIVE",
    "LOCATION_OUTSIDE", "LOCATION_AMBIGUOUS", "LOCATION_DENIED", "LOCATION_UNAVAILABLE", "LOCATION_TIMEOUT", "LOCATION_UNSUPPORTED", "NETWORK", "INTERNAL_ERROR",
  ];

  it("has a specific Spanish message for every code the pilot can produce, and a safe generic one for anything else", () => {
    for (const code of CODES) expect(R.describeError(code), code).not.toBe(R.describeError("SOMETHING_NEW"));
    expect(R.describeError(undefined)).toMatch(/No pudimos completar/);
    expect(R.describeError("__proto__")).toMatch(/No pudimos completar/);
  });

  it("never speaks of a telephone, WhatsApp, SMS or Instagram: the pilot has no such step", () => {
    const all = [...CODES.map((c) => R.describeError(c)), R.PROFILE_NOTICE, R.SIGN_IN_NOTICE, R.phaseNotice({ phase: "OPEN", roundRole: "FINAL" }), R.phaseNotice({ phase: "NOT_OPEN" })].join(" ");
    // "teléfono" may only appear as the device that reads a location, or as the sentence that says none is needed
    expect(all).not.toMatch(/whatsapp|sms|celular|instagram|n[úu]mero de tel[eé]fono|verifica(r)? tu (n[úu]mero|tel[eé]fono)/i);
    expect(all.match(/tel[eé]fono/gi)?.length).toBe(2);
    expect(R.SIGN_IN_NOTICE).toMatch(/correo/);
    expect(R.SIGN_IN_NOTICE).toMatch(/No hace falta tel[eé]fono/);
  });

  it("tells the person plainly that the profile must be completed before voting", () => {
    expect(R.PROFILE_NOTICE).toMatch(/completar tu perfil/);
    expect(R.PROFILE_NOTICE).toMatch(/Para votar/);
    expect(R.describeError("PROFILE_INCOMPLETE")).toMatch(/completa tu perfil/i);
  });

  it("describes the phase of each round, and flags a tentative schedule", () => {
    expect(R.phaseNotice({ phase: "OPEN", roundRole: "PRELIMINARY" })).toMatch(/cambiar tu voto hasta que cierre/);
    expect(R.phaseNotice({ phase: "OPEN", roundRole: "FINAL" })).toMatch(/finalistas/);
    expect(R.phaseNotice({ phase: "NOT_OPEN", tentative: true })).toMatch(/tentativos/);
    expect(R.phaseNotice({ phase: "NOT_OPEN", tentative: false })).not.toMatch(/tentativos/);
    expect(R.phaseNotice({ phase: "CLOSED" })).toMatch(/cerrada/);
    expect(R.phaseNotice({ phase: "ENDED" })).toMatch(/terminó/);
  });
});

// ---------------------------------------------------------------- identity steps

describe("identity steps", () => {
  it("maps the identity seam's state to the step to show", () => {
    expect(R.identityStep("unauthenticated")).toBe("SIGN_IN");
    expect(R.identityStep("profile_incomplete")).toBe("PROFILE");
    expect(R.identityStep("authenticated")).toBe("READY");
    expect(R.identityStep("something-else")).toBe("SIGN_IN");
    expect(R.identityStep(undefined as never)).toBe("SIGN_IN");
  });

  it("sends an identity refusal from the server back to the right step, and nothing else", () => {
    expect(R.stepForError("PROFILE_INCOMPLETE")).toBe("PROFILE");
    expect(R.stepForError("AUTHENTICATION_REQUIRED")).toBe("SIGN_IN");
    expect(R.stepForError("VERIFIED_EMAIL_REQUIRED")).toBe("SIGN_IN");
    expect(R.stepForError("VOTING_NOT_OPEN")).toBeNull();
    expect(R.stepForError("LOCATION_OUTSIDE")).toBeNull();
  });
});

// ---------------------------------------------------------------- resuming after a sign-in / profile detour

function memoryStorage() {
  const data = new Map<string, string>();
  return {
    data,
    getItem: (k: string) => data.get(k) ?? null,
    setItem: (k: string, v: string) => void data.set(k, v),
    removeItem: (k: string) => void data.delete(k),
  };
}

describe("resuming the chosen contestant", () => {
  it("remembers the contestant's public number only, per round, and forgets after two hours", () => {
    const storage = memoryStorage();
    let now = 1_000_000;
    const pending = R.createPendingSelection(storage, ID, () => now);
    expect(pending.get()).toBeNull();
    expect(pending.set("4827")).toBe(true);
    expect(pending.get()).toBe("4827");
    expect([...storage.data.keys()]).toEqual([`cv:round:pending:${ID}`]);
    expect([...storage.data.values()].join("")).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}/); // no candidate id, no user id, no token
    expect(R.createPendingSelection(storage, "another-round", () => now).get()).toBeNull();
    now += 2 * 60 * 60 * 1000 + 1;
    expect(pending.get()).toBeNull();
    pending.set("4827");
    pending.clear();
    expect(pending.get()).toBeNull();
  });

  it("refuses anything that is not a four-digit number and survives corrupt or unavailable storage", () => {
    const storage = memoryStorage();
    const pending = R.createPendingSelection(storage, ID);
    for (const bad of ["", "12", "12345", "abcd", "<script>", null as never, undefined as never, 4827 as never]) expect(pending.set(bad)).toBe(false);
    storage.data.set(`cv:round:pending:${ID}`, "{not json");
    expect(pending.get()).toBeNull();
    storage.data.set(`cv:round:pending:${ID}`, JSON.stringify({ alias: "<img>", at: Date.now() }));
    expect(pending.get()).toBeNull();
    const broken = { getItem: () => { throw new Error("blocked"); }, setItem: () => { throw new Error("blocked"); }, removeItem: () => { throw new Error("blocked"); } };
    const p2 = R.createPendingSelection(broken, ID);
    expect(p2.set("4827")).toBe(false);
    expect(p2.get()).toBeNull();
    expect(() => p2.clear()).not.toThrow();
  });

  const items = [
    { alias: "1111", candidateId: "c1", mine: false },
    { alias: "2222", candidateId: "c2", mine: true },
    { alias: "3333", candidateId: null, mine: false },
  ];

  it("resumes only when it is safe: the round is open, the contestant is shown, is not the person's own and is not already their vote", () => {
    expect(R.resumeSelection("1111", items, "OPEN", null)).toMatchObject({ alias: "1111" });
    expect(R.resumeSelection("1111", items, "NOT_OPEN", null)).toBeNull();
    expect(R.resumeSelection("1111", items, "CLOSED", null)).toBeNull();
    expect(R.resumeSelection("2222", items, "OPEN", null)).toBeNull(); // their own costume
    expect(R.resumeSelection("3333", items, "OPEN", null)).toBeNull(); // not yet a candidate
    expect(R.resumeSelection("9999", items, "OPEN", null)).toBeNull(); // no longer shown (withdrawn)
    expect(R.resumeSelection("1111", items, "OPEN", "c1")).toBeNull(); // already their vote
    expect(R.resumeSelection(null, items, "OPEN", null)).toBeNull();
    expect(R.resumeSelection("1111", null as never, "OPEN", null)).toBeNull();
  });
});

// ---------------------------------------------------------------- time

describe("countdown", () => {
  it("starts from the SERVER's remaining time and advances with a monotonic clock — not the wall clock", () => {
    const dateSpy = vi.spyOn(Date, "now").mockReturnValue(0);
    let mono = 5_000;
    const countdown = R.createCountdown(300_000, () => mono);
    expect(countdown.remaining()).toBe(300_000);
    mono += 120_000;
    dateSpy.mockReturnValue(9_999_999_999_999); // a phone whose clock jumps changes nothing
    expect(countdown.remaining()).toBe(180_000);
    expect(countdown.expired()).toBe(false);
    mono += 200_000;
    expect(countdown.remaining()).toBe(0);
    expect(countdown.expired()).toBe(true);
    dateSpy.mockRestore();
  });

  it("re-synchronizes to a fresher server answer, handles a round without a window, and never goes negative", () => {
    let mono = 0;
    const countdown = R.createCountdown(null, () => mono);
    expect(countdown.remaining()).toBeNull();
    expect(countdown.expired()).toBe(false);
    countdown.resync(60_000);
    mono += 10_000;
    expect(countdown.remaining()).toBe(50_000);
    countdown.resync(-5);
    expect(countdown.remaining()).toBe(0);
    countdown.resync(Number.NaN);
    expect(countdown.remaining()).toBeNull();
  });

  it("formats minutes and seconds, rounding the remaining time up so 0:00 means over", () => {
    expect(R.formatCountdown(300_000)).toBe("5:00");
    expect(R.formatCountdown(65_000)).toBe("1:05");
    expect(R.formatCountdown(59_001)).toBe("1:00");
    expect(R.formatCountdown(1)).toBe("0:01");
    expect(R.formatCountdown(0)).toBe("0:00");
    expect(R.formatCountdown(-5)).toBe("0:00");
    expect(R.formatCountdown(Number.NaN)).toBe("0:00");
  });
});

// ---------------------------------------------------------------- location (final only)

function fakeGeo(result: { coords?: Json; error?: { code: number } }) {
  return {
    getCurrentPosition: vi.fn((ok: (p: Json) => void, err: (e: Json) => void, options: Json) => {
      void options;
      if (result.error) err(result.error);
      else ok({ coords: result.coords });
    }),
  };
}
const GOOD_COORDS = { latitude: 15.5, longitude: -88, accuracy: 12 };

describe("location", () => {
  it("is required only when the server says so", () => {
    expect(R.locationRequired({ locationRequired: true })).toBe(true);
    for (const info of [{ locationRequired: false }, {}, null, { locationRequired: "true" }, { roundRole: "FINAL" }]) expect(R.locationRequired(info as never)).toBe(false);
  });

  it("reads one FRESH, high-accuracy position, bounded in time, and returns only the three fields", async () => {
    const geo = fakeGeo({ coords: { ...GOOD_COORDS, altitude: 9, speed: 3 } });
    await expect(R.readPosition(geo, { timeoutMs: 5000 })).resolves.toEqual({ latitude: 15.5, longitude: -88, accuracyMeters: 12 });
    expect(geo.getCurrentPosition).toHaveBeenCalledTimes(1);
    expect(geo.getCurrentPosition.mock.calls[0][2]).toEqual({ enableHighAccuracy: true, timeout: 5000, maximumAge: 0 });
  });

  it("turns the browser's failures into the page's codes", async () => {
    await expect(R.readPosition(fakeGeo({ error: { code: 1 } }))).rejects.toEqual({ code: "LOCATION_DENIED" });
    await expect(R.readPosition(fakeGeo({ error: { code: 2 } }))).rejects.toEqual({ code: "LOCATION_UNAVAILABLE" });
    await expect(R.readPosition(fakeGeo({ error: { code: 3 } }))).rejects.toEqual({ code: "LOCATION_TIMEOUT" });
    await expect(R.readPosition(undefined)).rejects.toEqual({ code: "LOCATION_UNSUPPORTED" });
    await expect(R.readPosition({})).rejects.toEqual({ code: "LOCATION_UNSUPPORTED" });
    await expect(R.readPosition(fakeGeo({ coords: { latitude: 1, longitude: 2 } }))).rejects.toEqual({ code: "LOCATION_UNAVAILABLE" });
    await expect(R.readPosition(fakeGeo({ coords: { latitude: Number.NaN, longitude: 2, accuracy: 3 } }))).rejects.toEqual({ code: "LOCATION_UNAVAILABLE" });
  });
});

// ---------------------------------------------------------------- one vote, start to finish

function fakeApi(opts: { vote?: Reply | Reply[]; bind?: Reply; intent?: Reply } = {}) {
  const votes = Array.isArray(opts.vote) ? [...opts.vote] : [opts.vote ?? { status: 200, json: { outcome: "APPLIED", candidateId: CAND } }];
  return {
    bind: vi.fn(async () => opts.bind ?? { status: 200, json: { bindingId: BINDING, created: false } }),
    intent: vi.fn(async () => opts.intent ?? { status: 201, json: { bindingId: BINDING, intentNo: 3 } }),
    vote: vi.fn(async (body: Json) => {
      void body;
      return votes.length > 1 ? (votes.shift() as Reply) : votes[0];
    }),
  };
}
const PRELIMINARY = { roundRole: "PRELIMINARY", locationRequired: false };
const FINAL = { roundRole: "FINAL", locationRequired: true };

describe("casting a favorite", () => {
  it("in the PRELIMINARY never touches the location sensor and never sends a location", async () => {
    const api = fakeApi();
    const geo = fakeGeo({ coords: GOOD_COORDS });
    const result = await R.castFavorite({ api, geolocation: geo, info: PRELIMINARY, candidateId: CAND, interactionInstanceId: INTERACTION });
    expect(result).toMatchObject({ ok: true, outcome: "APPLIED", candidateId: CAND });
    expect(geo.getCurrentPosition).not.toHaveBeenCalled();
    const body = api.vote.mock.calls[0][0];
    expect(body).toEqual({ bindingId: BINDING, intentNo: 3, interactionInstanceId: INTERACTION, candidateId: CAND });
    expect(Object.keys(body)).not.toContain("location");
  });

  it("in the PRELIMINARY works on a device with no location at all", async () => {
    const api = fakeApi();
    const result = await R.castFavorite({ api, geolocation: undefined, info: PRELIMINARY, candidateId: CAND, interactionInstanceId: INTERACTION });
    expect(result.ok).toBe(true);
  });

  it("in the FINAL reads one position per vote and sends it in the vote's body", async () => {
    const api = fakeApi();
    const geo = fakeGeo({ coords: GOOD_COORDS });
    const result = await R.castFavorite({ api, geolocation: geo, info: FINAL, candidateId: CAND, interactionInstanceId: INTERACTION });
    expect(result.ok).toBe(true);
    expect(geo.getCurrentPosition).toHaveBeenCalledTimes(1);
    expect(api.vote.mock.calls[0][0].location).toEqual({ latitude: 15.5, longitude: -88, accuracyMeters: 12 });
    // a revision is another vote: another reading
    await R.castFavorite({ api, geolocation: geo, info: FINAL, candidateId: "other", interactionInstanceId: INTERACTION });
    expect(geo.getCurrentPosition).toHaveBeenCalledTimes(2);
  });

  it("in the FINAL does not consume an intent or contact the vote route when the position cannot be read", async () => {
    for (const [error, code] of [[{ code: 1 }, "LOCATION_DENIED"], [{ code: 3 }, "LOCATION_TIMEOUT"]] as const) {
      const api = fakeApi();
      const result = await R.castFavorite({ api, geolocation: fakeGeo({ error }), info: FINAL, candidateId: CAND, interactionInstanceId: INTERACTION });
      expect(result).toMatchObject({ ok: false, code });
      expect(api.bind).not.toHaveBeenCalled();
      expect(api.intent).not.toHaveBeenCalled();
      expect(api.vote).not.toHaveBeenCalled();
    }
  });

  it("confirms a vote ONLY when the server answered 200 with an accepted outcome", async () => {
    for (const outcome of ["APPLIED", "UNCHANGED", "REPLAYED"]) {
      const r = await R.castFavorite({ api: fakeApi({ vote: { status: 200, json: { outcome, candidateId: CAND } } }), geolocation: undefined, info: PRELIMINARY, candidateId: CAND, interactionInstanceId: INTERACTION });
      expect(r.ok, outcome).toBe(true);
    }
    for (const reply of [
      { status: 200, json: { outcome: "MAYBE" } },
      { status: 200, json: null },
      { status: 403, json: { code: "LOCATION_OUTSIDE" } },
      { status: 409, json: { code: "VOTING_WINDOW_ELAPSED" } },
      { status: 500, json: { code: "INTERNAL_ERROR" } },
    ]) {
      const r = await R.castFavorite({ api: fakeApi({ vote: reply }), geolocation: fakeGeo({ coords: GOOD_COORDS }), info: FINAL, candidateId: CAND, interactionInstanceId: INTERACTION });
      expect(r.ok, JSON.stringify(reply)).toBe(false);
    }
  });

  it("reports a refusal's code (and the caller's own current state for a conflict) rather than a success", async () => {
    const api = fakeApi({ vote: { status: 409, json: { code: "STALE_INTENT", current: { myCandidateId: "x" } } } });
    const r = await R.castFavorite({ api, geolocation: undefined, info: PRELIMINARY, candidateId: CAND, interactionInstanceId: INTERACTION });
    expect(r).toMatchObject({ ok: false, code: "STALE_INTENT", status: 409, current: { myCandidateId: "x" } });
  });

  it("stops at the identity: a profile that is incomplete or a session that is gone never gets as far as an intent", async () => {
    const profile = fakeApi({ bind: { status: 403, json: { code: "PROFILE_INCOMPLETE" } } });
    expect(await R.castFavorite({ api: profile, geolocation: undefined, info: PRELIMINARY, candidateId: CAND, interactionInstanceId: INTERACTION })).toMatchObject({ ok: false, code: "PROFILE_INCOMPLETE" });
    expect(profile.intent).not.toHaveBeenCalled();
    const signedOut = fakeApi({ bind: { status: 401, json: { code: "AUTHENTICATION_REQUIRED" } } });
    expect(await R.castFavorite({ api: signedOut, geolocation: undefined, info: PRELIMINARY, candidateId: CAND, interactionInstanceId: INTERACTION })).toMatchObject({ ok: false, code: "AUTHENTICATION_REQUIRED" });
    const noIntent = fakeApi({ intent: { status: 409, json: { code: "VOTING_NOT_OPEN" } } });
    expect(await R.castFavorite({ api: noIntent, geolocation: undefined, info: PRELIMINARY, candidateId: CAND, interactionInstanceId: INTERACTION })).toMatchObject({ ok: false, code: "VOTING_NOT_OPEN" });
    expect(noIntent.vote).not.toHaveBeenCalled();
  });

  it("a lost response is neither a success nor a failure: the SAME intent is retried, with no new bind or intent, and counted once", async () => {
    const api = fakeApi({ vote: [{ status: 0, json: { code: "NETWORK" } }, { status: 200, json: { outcome: "REPLAYED", candidateId: CAND } }] });
    const first = await R.castFavorite({ api, geolocation: undefined, info: PRELIMINARY, candidateId: CAND, interactionInstanceId: INTERACTION });
    expect(first).toMatchObject({ ok: false, code: "NETWORK", retry: { bindingId: BINDING, intentNo: 3, candidateId: CAND, interactionInstanceId: INTERACTION } });
    const second = await R.castFavorite({ api, geolocation: undefined, info: PRELIMINARY, candidateId: CAND, interactionInstanceId: INTERACTION, retry: first.retry });
    expect(second).toMatchObject({ ok: true, outcome: "REPLAYED" });
    expect(api.bind).toHaveBeenCalledTimes(1);
    expect(api.intent).toHaveBeenCalledTimes(1);
    expect(api.vote.mock.calls[0][0]).toEqual(api.vote.mock.calls[1][0]);
  });

  it("a retry for a DIFFERENT contestant takes a new intent instead of reusing the old one", async () => {
    const api = fakeApi();
    await R.castFavorite({ api, geolocation: undefined, info: PRELIMINARY, candidateId: "other", interactionInstanceId: INTERACTION, retry: { bindingId: "old", intentNo: 1, candidateId: CAND, interactionInstanceId: INTERACTION } });
    expect(api.intent).toHaveBeenCalledTimes(1);
    expect(api.vote.mock.calls[0][0].intentNo).toBe(3);
  });
});

// ---------------------------------------------------------------- the API client

describe("API client", () => {
  function recorder() {
    const calls: Array<{ url: string; init: Json }> = [];
    const fetchImpl = async (url: string, init: Json) => {
      calls.push({ url, init });
      return { status: 200, json: async () => ({ ok: true }) };
    };
    return { calls, fetchImpl };
  }

  it("calls only the pilot's routes, with the bearer on the authenticated ones and never on the public ones", async () => {
    const { calls, fetchImpl } = recorder();
    const api = R.buildApi(fetchImpl, async () => "tok", ID);
    await api.info(); await api.results(); await api.bind(); await api.status(); await api.gallery(); await api.intent(); await api.vote({ a: 1 }); await api.claim("ABCD");
    expect(calls.map((c) => c.url)).toEqual([
      `/api/gaming/community-voting/rounds/${ID}/info`, `/api/gaming/community-voting/rounds/${ID}/results`, `/api/gaming/community-voting/rounds/${ID}/binding`,
      `/api/gaming/community-voting/rounds/${ID}/status`, `/api/gaming/community-voting/rounds/${ID}/gallery`, `/api/gaming/community-voting/rounds/${ID}/intents`,
      `/api/gaming/community-voting/rounds/${ID}/votes`, `/api/gaming/community-voting/rounds/${ID}/claims`,
    ]);
    const authed = calls.map((c) => Boolean(c.init.headers.Authorization));
    expect(authed).toEqual([false, false, true, true, true, true, true, true]);
    for (const c of calls) expect(c.url).not.toMatch(/phone|whatsapp|ballot|ranked|instagram/i);
  });

  it("never throws on an HTTP or network failure", async () => {
    const api = R.buildApi(async () => { throw new Error("offline"); }, async () => "tok", ID);
    expect(await api.vote({})).toEqual({ status: 0, json: { code: "NETWORK" } });
    const broken = R.buildApi(async () => ({ status: 502, json: async () => { throw new Error("not json"); } }), async () => null, ID);
    expect(await broken.status()).toEqual({ status: 502, json: null });
  });
});

// =====================================================================================================================
// The operator tablet
// =====================================================================================================================

const entry = (over: Json = {}) => ({ entryId: "e1", label: "#1111", association: "CONFIRMED", media: "APPROVED", photoId: "p", promotional: "NOT_ASKED", withdrawn: false, carried: false, claimable: false, ...over });
const overviewOf = (over: Json = {}) => ({ roundRole: "PRELIMINARY", opened: false, closed: false, published: false, finalistsSelected: false, windowSeconds: null, deadlineAt: null, serverNow: "2026-10-31T21:00:00.000Z", schedule: { registrationOpensAt: null, contestantCutoffAt: null, votingOpensAt: null, votingClosesAt: "2026-10-31T22:00:00.000Z", status: "CONFIRMED" }, pendingResolutions: [], review: null, policies: [], tasks: [], publishedAffected: [], entries: [entry(), entry({ entryId: "e2", label: "#2222" })], counters: { boundVoters: 0, votes: 0, entries: 2, withdrawn: 0 }, ...over });
const stepOf = (steps: ReturnType<Operator["nextSteps"]>, key: string) => steps.find((s) => s.key === key)!;

describe("operator: what each entry still needs", () => {
  it("walks the order the process requires", () => {
    expect(O.entryNextStep(entry({ media: "NONE" }))).toBe("PHOTO");
    expect(O.entryNextStep(entry({ media: "REJECTED" }))).toBe("PHOTO");
    expect(O.entryNextStep(entry({ media: "PENDING_CONSENT" }))).toBe("CONSENT");
    expect(O.entryNextStep(entry({ media: "PENDING_REVIEW" }))).toBe("REVIEW");
    expect(O.entryNextStep(entry({ association: "PENDING_CONFIRMATION" }))).toBe("ASSOCIATION");
    expect(O.entryNextStep(entry({ association: "UNCLAIMED" }))).toBe("ASSOCIATION");
    expect(O.entryNextStep(entry())).toBe("READY");
    expect(O.entryNextStep(entry({ withdrawn: true }))).toBe("WITHDRAWN");
  });

  it("a photograph hidden at the person's request is not a missing photograph: the contestant keeps their place", () => {
    expect(O.entryNextStep(entry({ media: "HIDDEN" }))).toBe("READY");
    expect(O.entryNextStep(entry({ media: "HIDDEN", association: "UNCLAIMED" }))).toBe("ASSOCIATION");
    expect(O.roundReadiness(overviewOf({ entries: [entry({ media: "HIDDEN" }), entry({ entryId: "e2", label: "#2222" })] })).ready).toBe(true);
  });

  it("is ready to open with two complete entries, names the blockers otherwise, and ignores withdrawn entries", () => {
    expect(O.roundReadiness(overviewOf()).ready).toBe(true);
    const blocked = O.roundReadiness(overviewOf({ entries: [entry(), entry({ entryId: "e2", label: "#2222", media: "PENDING_CONSENT" })] }));
    expect(blocked.ready).toBe(false);
    expect(blocked.blockers).toEqual([{ entryId: "e2", label: "#2222", reason: expect.stringMatching(/consentimiento de galería y concurso/) }]);
    expect(O.roundReadiness(overviewOf({ entries: [entry()] })).ready).toBe(false);
    expect(O.roundReadiness(overviewOf({ entries: [entry(), entry({ entryId: "e2" }), entry({ entryId: "e3", withdrawn: true, media: "NONE" })] })).ready).toBe(true);
    expect(O.roundReadiness(null as never)).toEqual({ ready: false, activeCount: 0, blockers: [] });
  });

  it("labels the promotional decision, which is never a condition", () => {
    expect(O.promoLabel("NOT_ASKED")).toMatch(/No se le ha preguntado/);
    expect(O.promoLabel("DECLINED")).toMatch(/No autorizó/);
    expect(O.promoLabel("ACCEPTED")).toMatch(/Autorizó/);
    expect(O.promoLabel("WITHDRAWN")).toMatch(/Retiró/);
    expect(O.promoLabel("???")).toBe(O.promoLabel("NOT_ASKED"));
    expect(O.roundReadiness(overviewOf({ entries: [entry({ promotional: "DECLINED" }), entry({ entryId: "e2", promotional: "DECLINED" })] })).ready).toBe(true);
  });
});

describe("operator: the checklist of a preliminary", () => {
  it("offers only the open while it is in preparation, and says why it cannot yet", () => {
    const steps = O.nextSteps(overviewOf());
    expect(steps.map((s) => s.key)).toEqual(["OPEN", "CLOSE", "FINALISTS", "REVIEW", "PUBLISH"]);
    expect(stepOf(steps, "OPEN")).toMatchObject({ enabled: true, done: false });
    for (const key of ["CLOSE", "FINALISTS", "REVIEW", "PUBLISH"]) expect(stepOf(steps, key).enabled, key).toBe(false);
    const blocked = O.nextSteps(overviewOf({ entries: [entry()] }));
    expect(stepOf(blocked, "OPEN")).toMatchObject({ enabled: false, reason: expect.stringMatching(/al menos dos/) });
    const incomplete = O.nextSteps(overviewOf({ entries: [entry(), entry({ entryId: "e2", association: "UNCLAIMED" })] }));
    expect(stepOf(incomplete, "OPEN")).toMatchObject({ enabled: false, reason: expect.stringMatching(/sin completar/) });
  });

  it("cannot open without a closing time in the future: that time is the deadline for voting", () => {
    const none = O.nextSteps(overviewOf({ schedule: { registrationOpensAt: null, contestantCutoffAt: null, votingOpensAt: null, votingClosesAt: null, status: "TENTATIVE" } }));
    expect(stepOf(none, "OPEN")).toMatchObject({ enabled: false, reason: expect.stringMatching(/hora de cierre/) });
    const past = O.nextSteps(overviewOf({ schedule: { registrationOpensAt: null, contestantCutoffAt: null, votingOpensAt: null, votingClosesAt: "2026-10-31T20:00:00.000Z", status: "CONFIRMED" } }));
    expect(stepOf(past, "OPEN").enabled).toBe(false);
    expect(stepOf(O.nextSteps(overviewOf()), "OPEN").enabled).toBe(true);
  });

  it("offers only the close while it is open", () => {
    const steps = O.nextSteps(overviewOf({ opened: true }));
    expect(stepOf(steps, "OPEN")).toMatchObject({ done: true, enabled: false });
    expect(stepOf(steps, "CLOSE")).toMatchObject({ enabled: true });
    expect(stepOf(steps, "FINALISTS").enabled).toBe(false);
  });

  it("after the close: the cut first, then the review, then the publication — each only when the previous is done", () => {
    let steps = O.nextSteps(overviewOf({ opened: true, closed: true }));
    expect(stepOf(steps, "FINALISTS").enabled).toBe(true);
    expect(stepOf(steps, "REVIEW").enabled).toBe(false);
    expect(stepOf(steps, "PUBLISH").enabled).toBe(false);
    steps = O.nextSteps(overviewOf({ opened: true, closed: true, finalistsSelected: true }));
    expect(stepOf(steps, "FINALISTS")).toMatchObject({ done: true, enabled: false });
    expect(stepOf(steps, "REVIEW").enabled).toBe(true);
    expect(stepOf(steps, "PUBLISH")).toMatchObject({ enabled: false, reason: expect.stringMatching(/revisión/) });
    steps = O.nextSteps(overviewOf({ opened: true, closed: true, finalistsSelected: true, review: { reviewedAt: "2026-10-31T21:40:00.000Z", digest: "d", current: true } }));
    expect(stepOf(steps, "PUBLISH")).toMatchObject({ enabled: true, reason: null });
    steps = O.nextSteps(overviewOf({ opened: true, closed: true, finalistsSelected: true, published: true }));
    expect(stepOf(steps, "PUBLISH")).toMatchObject({ done: true, enabled: false });
    expect(stepOf(steps, "REVIEW").enabled).toBe(false);
  });

  it("a stale review does not allow the publication and asks for a new one", () => {
    const steps = O.nextSteps(overviewOf({ opened: true, closed: true, finalistsSelected: true, review: { reviewedAt: "2026-10-31T21:40:00.000Z", digest: "d", current: false } }));
    expect(stepOf(steps, "PUBLISH")).toMatchObject({ enabled: false, reason: expect.stringMatching(/revisión/) });
    expect(stepOf(steps, "REVIEW")).toMatchObject({ enabled: true, reason: expect.stringMatching(/quedó vieja/) });
  });

  it("holds the cut and says which Product decision it waits for, then releases it once the decision is no longer pending", () => {
    const held = O.nextSteps(overviewOf({ opened: true, closed: true, pendingResolutions: [{ key: "ZERO_VOTE_ENTRIES_AT_CUTOFF" }] }));
    expect(stepOf(held, "FINALISTS")).toMatchObject({ enabled: false, reason: expect.stringContaining(O.POLICY_INFO.ZERO_VOTE_ENTRIES_AT_CUTOFF.title) });
    const nobody = O.nextSteps(overviewOf({ opened: true, closed: true, pendingResolutions: [{ key: "ZERO_VALID_VOTES_PRELIMINARY" }] }));
    expect(stepOf(nobody, "FINALISTS").enabled).toBe(false);
    expect(stepOf(O.nextSteps(overviewOf({ opened: true, closed: true })), "FINALISTS").enabled).toBe(true);
  });

  it("holds the publication while a finalist's withdrawal awaits a decision, even with a current review", () => {
    const steps = O.nextSteps(overviewOf({ opened: true, closed: true, finalistsSelected: true, pendingResolutions: [{ key: "FINALIST_WITHDRAWAL_AFTER_SELECTION" }], review: { reviewedAt: "x", digest: "d", current: true } }));
    expect(stepOf(steps, "PUBLISH")).toMatchObject({ enabled: false, reason: expect.stringContaining(O.POLICY_INFO.FINALIST_WITHDRAWAL_AFTER_SELECTION.title) });
  });

  it("returns nothing without an overview", () => {
    expect(O.nextSteps(null as never)).toEqual([]);
  });
});

describe("operator: the checklist of a final", () => {
  const final = (over: Json = {}) => overviewOf({ roundRole: "FINAL", entries: [], windowSeconds: 300, schedule: { registrationOpensAt: null, contestantCutoffAt: null, votingOpensAt: null, votingClosesAt: null, status: "TENTATIVE" }, ...over });

  it("starts by preparing the finalists, and there is no cut in a final", () => {
    const steps = O.nextSteps(final());
    expect(steps.map((s) => s.key)).toEqual(["PREPARE", "OPEN", "CLOSE", "REVIEW", "PUBLISH"]);
    expect(stepOf(steps, "PREPARE")).toMatchObject({ enabled: true, done: false });
    expect(stepOf(steps, "OPEN").enabled).toBe(false);
  });

  it("opens only after the finalists are carried in, and says that the time starts", () => {
    const prepared = O.nextSteps(final({ entries: [entry({ carried: true }), entry({ entryId: "e2", carried: true })] }));
    expect(stepOf(prepared, "PREPARE")).toMatchObject({ done: true, enabled: false });
    expect(stepOf(prepared, "OPEN")).toMatchObject({ enabled: true, label: expect.stringMatching(/empieza el tiempo/) });
  });

  it("after the close the review needs no cut and the publication announces the winner(s)", () => {
    const steps = O.nextSteps(final({ entries: [entry({ carried: true }), entry({ entryId: "e2", carried: true })], opened: true, closed: true }));
    expect(stepOf(steps, "REVIEW").enabled).toBe(true);
    expect(stepOf(steps, "PUBLISH").label).toMatch(/ganador/);
  });

  it("does not open while a finalist's withdrawal awaits Product's decision", () => {
    const steps = O.nextSteps(final({ entries: [entry({ carried: true }), entry({ entryId: "e2", carried: true })], pendingResolutions: [{ key: "FINALIST_WITHDRAWAL_AFTER_SELECTION" }] }));
    expect(stepOf(steps, "OPEN")).toMatchObject({ enabled: false, reason: expect.stringContaining(O.POLICY_INFO.FINALIST_WITHDRAWAL_AFTER_SELECTION.title) });
    expect(stepOf(O.nextSteps(final({ pendingResolutions: [{ key: "FINALIST_WITHDRAWAL_AFTER_SELECTION" }] })), "PREPARE").enabled).toBe(false);
  });

  it("shows the clock from the SERVER's answer plus elapsed monotonic time, for either round, and nothing before it opens or once it closed", () => {
    const live = final({ opened: true, deadlineAt: "2026-10-31T21:05:00.000Z", serverNow: "2026-10-31T21:01:00.000Z" });
    expect(O.deadlineLabel(live, 0)).toBe("4:00");
    expect(O.deadlineLabel(live, 30_000)).toBe("3:30");
    expect(O.deadlineLabel(live, 999_999)).toBe("0:00");
    const preliminary = overviewOf({ opened: true, deadlineAt: "2026-10-31T22:30:00.000Z", serverNow: "2026-10-31T21:00:00.000Z" });
    expect(O.deadlineLabel(preliminary, 0)).toBe("1:30:00");
    expect(O.deadlineLabel(overviewOf(), 0)).toBeNull();
    expect(O.deadlineLabel(final({ opened: false }), 0)).toBeNull();
    expect(O.deadlineLabel({ ...preliminary, closed: true }, 0)).toBeNull();
    expect(O.deadlineLabel(null as never)).toBeNull();
  });
});

describe("operator: messages and API", () => {
  it("explains the pilot's operator refusals, falling back to the base messages", () => {
    expect(O.describeError("REVIEW_REQUIRED")).toMatch(/revisión/);
    expect(O.describeError("REVIEW_STALE")).toMatch(/de nuevo/);
    expect(O.describeError("FINALISTS_NOT_SELECTED")).toMatch(/corte/);
    expect(O.describeError("RESULTS_NOT_AVAILABLE")).toMatch(/cerrada/);
    expect(O.describeError("OPERATOR_REQUIRED")).toMatch(/operador designado/);
    expect(O.describeError("POLICY_REQUIRED")).toMatch(/decisión aprobada por el Founder/);
    expect(O.describeError("SCHEDULE_REQUIRED")).toMatch(/hora de cierre/);
    expect(O.describeError("PHOTO_HIDDEN")).toMatch(/ocultar/);
    expect(O.describeError("WHATEVER")).toMatch(/No se pudo completar/);
  });

  it("states no retention period and offers no purge of photographs", () => {
    for (const code of ["PHOTO_INVALID", "CUTOFF_PASSED", "ALREADY_CLOSED", "RESULTS_NOT_AVAILABLE"]) expect(O.describeError(code)).not.toMatch(/72|retención/i);
    expect(Object.keys(O.buildOperatorApi(async () => ({ status: 200, json: async () => ({}) }), async () => null, () => "", ID))).not.toContain("purge");
  });

  it("names the three pending Product decisions, each with the one value the system can execute", () => {
    expect(O.POLICY_ORDER).toEqual(["ZERO_VALID_VOTES_PRELIMINARY", "ZERO_VOTE_ENTRIES_AT_CUTOFF", "FINALIST_WITHDRAWAL_AFTER_SELECTION"]);
    expect(Object.fromEntries(Object.entries(O.POLICY_INFO).map(([k, v]) => [k, v.value]))).toEqual({
      ZERO_VALID_VOTES_PRELIMINARY: "ALL_ENTRIES_ADVANCE",
      ZERO_VOTE_ENTRIES_AT_CUTOFF: "TIED_ZERO_VOTE_ENTRIES_ADVANCE",
      FINALIST_WITHDRAWAL_AFTER_SELECTION: "EXCLUDE_WITHOUT_REFILL",
    });
  });

  it("calls only the pilot's operator routes with the bearer AND the host token", async () => {
    const calls: Array<{ url: string; init: Json }> = [];
    const api = O.buildOperatorApi(async (url, init) => { calls.push({ url, init }); return { status: 200, json: async () => ({}) }; }, async () => "tok", () => "host-token", ID);
    await api.overview(); await api.results(); await api.open("Mejor"); await api.close(); await api.finalists(); await api.prepareFinal(); await api.review("ok"); await api.publish();
    await api.promo("e1", "v", "DECLINED"); await api.withdraw("e1", "motivo", true); await api.photo("e1", "AAAA", "BBBB"); await api.consent("e1", "p1", "v");
    await api.hidePhoto("e1", "privacidad"); await api.policy("ZERO_VALID_VOTES_PRELIMINARY", "DEC-1"); await api.resolveTask("t1", "hecho"); await api.schedule({ status: "TENTATIVE" });
    for (const c of calls) {
      expect(c.url.startsWith(`/api/gaming/community-voting/rounds/${ID}/`)).toBe(true);
      expect(c.url).not.toMatch(/phone|whatsapp|ballot|ranked|instagram/i);
      expect(c.init.headers.Authorization).toBe("Bearer tok");
      expect(c.init.headers["x-host-token"]).toBe("host-token");
    }
    expect(calls.map((c) => `${c.init.method} ${c.url.replace(`/api/gaming/community-voting/rounds/${ID}`, "")}`)).toEqual([
      "GET /operator/overview", "GET /operator/results", "POST /operator/open", "POST /operator/close", "POST /operator/finalists", "POST /operator/prepare-final",
      "POST /operator/review", "POST /operator/publish", "POST /operator/entries/e1/promo-consent", "POST /operator/entries/e1/withdrawal",
      "POST /operator/entries/e1/photo", "POST /operator/entries/e1/consent",
      "POST /operator/entries/e1/photo-hide", "POST /operator/policies", "POST /operator/tasks/t1", "PUT /schedule",
    ]);
    expect(JSON.parse(calls[9].init.body)).toEqual({ reason: "motivo", hidePhoto: true });
    expect(JSON.parse(calls[12].init.body)).toEqual({ reason: "privacidad" });
    expect(JSON.parse(calls[13].init.body)).toEqual({ policyKey: "ZERO_VALID_VOTES_PRELIMINARY", policyValue: "ALL_ENTRIES_ADVANCE", approvalReference: "DEC-1" });
    expect(JSON.parse(calls[14].init.body)).toEqual({ note: "hecho" });
    expect(JSON.parse(calls[10].init.body)).toEqual({ fullImage: "AAAA", thumbImage: "BBBB" });
    expect(JSON.parse(calls[11].init.body)).toEqual({ photoId: "p1", consentVersion: "v", accepted: true, ageConfirmed: true });
  });
});

// =====================================================================================================================
// Helpers carried over from the superseded pages (assertions unchanged, now on the pilot's own modules)
// =====================================================================================================================

describe("Virtualized grid window (100+ contestants without rendering them all)", () => {
  const base = { columns: 3, rowHeight: 140, viewportHeight: 560, overscanRows: 2 };

  it("renders only the visible rows plus a small overscan, whatever the total", () => {
    for (const total of [12, 100, 150, 1000]) {
      const w = R.computeVirtualWindow({ ...base, total, scrollTop: 0 });
      const rendered = w.lastIndex - w.firstIndex;
      expect(rendered, `total ${total}`).toBeLessThanOrEqual(Math.ceil(560 / 140 + 2 + 2) * 3);
      expect(rendered).toBeLessThanOrEqual(total);
    }
    expect(R.computeVirtualWindow({ ...base, total: 150, scrollTop: 0 }).lastIndex).toBeLessThan(30);
  });

  it("keeps the scroll height of the WHOLE list through padding, so the scrollbar is honest", () => {
    for (const scrollTop of [0, 1, 139, 140, 2000, 6999]) {
      const w = R.computeVirtualWindow({ ...base, total: 150, scrollTop });
      expect(w.totalRows).toBe(50);
      expect(w.totalHeight).toBe(50 * 140);
      expect(w.topPadding + (w.lastRow - w.firstRow) * 140 + w.bottomPadding).toBe(w.totalHeight);
    }
  });

  it("slides with the scroll position, never leaving a visible row unrendered", () => {
    for (let scrollTop = 0; scrollTop <= 7000; scrollTop += 37) {
      const w = R.computeVirtualWindow({ ...base, total: 150, scrollTop });
      const firstVisibleRow = Math.floor(scrollTop / 140);
      const lastVisibleRow = Math.min(49, Math.floor((scrollTop + 560 - 1) / 140));
      expect(w.firstRow, `scrollTop ${scrollTop}`).toBeLessThanOrEqual(firstVisibleRow);
      expect(w.lastRow - 1, `scrollTop ${scrollTop}`).toBeGreaterThanOrEqual(lastVisibleRow);
      expect(w.firstIndex).toBe(w.firstRow * 3);
      expect(w.lastIndex).toBe(Math.min(150, w.lastRow * 3));
    }
  });

  it("covers every item exactly once as the window slides, in order", () => {
    const seen = new Set<number>();
    for (let scrollTop = 0; scrollTop <= 7000; scrollTop += 100) {
      const w = R.computeVirtualWindow({ ...base, total: 150, scrollTop });
      for (let i = w.firstIndex; i < w.lastIndex; i++) seen.add(i);
    }
    expect(seen.size).toBe(150);
  });

  it("handles an empty list, a partial last row, an overscroll and nonsense input without throwing", () => {
    expect(R.computeVirtualWindow({ ...base, total: 0, scrollTop: 0 })).toMatchObject({ firstIndex: 0, lastIndex: 0, totalHeight: 0 });
    const last = R.computeVirtualWindow({ ...base, total: 100, scrollTop: 99999 });
    expect(last.lastIndex).toBe(100);
    expect(last.bottomPadding).toBe(0);
    const negative = R.computeVirtualWindow({ ...base, total: 100, scrollTop: -500 });
    expect(negative.firstIndex).toBe(0);
    for (const bad of [{ columns: 0 }, { rowHeight: 0 }, { viewportHeight: Number.NaN }, { total: Number.NaN }]) {
      expect(() => R.computeVirtualWindow({ ...base, total: 10, scrollTop: 0, ...bad } as never)).not.toThrow();
    }
  });
});

describe("Swipeable deck navigation", () => {
  it("wraps around so discovery never dead-ends", () => {
    expect(R.deckNavigate(0, 1, 5)).toBe(1);
    expect(R.deckNavigate(4, 1, 5)).toBe(0);
    expect(R.deckNavigate(0, -1, 5)).toBe(4);
    expect(R.deckNavigate(2, 0, 5)).toBe(2);
    expect(R.deckNavigate(3, 1, 0)).toBe(0);
    expect(R.deckNavigate(7, 0, 3)).toBe(2); // an out-of-range index is clamped first (and not moved)
  });

  it("reads a horizontal drag as a swipe and ignores taps, scrolls and short drags", () => {
    expect(R.swipeIntent({ dx: -120, dy: 10 })).toBe("next");
    expect(R.swipeIntent({ dx: 120, dy: -10 })).toBe("prev");
    expect(R.swipeIntent({ dx: 30, dy: 0 })).toBeNull();
    expect(R.swipeIntent({ dx: -120, dy: 200 })).toBeNull(); // mostly vertical: the page is scrolling
    expect(R.swipeIntent({ dx: 0, dy: 0 })).toBeNull();
  });
});

describe("operator tablet: photograph resize and the claim credential", () => {
  it("plans a resize that never enlarges and keeps the aspect ratio", () => {
    expect(O.planResize(4000, 3000, 1600)).toEqual({ width: 1600, height: 1200, scale: 0.4 });
    expect(O.planResize(3000, 4000, 1600)).toEqual({ width: 1200, height: 1600, scale: 0.4 });
    expect(O.planResize(800, 600, 1600)).toEqual({ width: 800, height: 600, scale: 1 });
    expect(O.planResize(4000, 3000, 320)).toEqual({ width: 320, height: 240, scale: 0.08 });
    expect(O.planResize(0, 0, 320).width).toBeGreaterThanOrEqual(1);
  });

  it("groups the claim credential for reading aloud and typing", () => {
    expect(O.formatClaimCode("ABCDEFGHJKMN")).toBe("ABCD-EFGH-JKMN");
    expect(O.formatClaimCode("short")).toBe("short");
    expect(O.formatClaimCode(undefined as never)).toBe("");
  });
});

describe("Public display rotation: exposure, never standing", () => {
  const items = (n: number) => Array.from({ length: n }, (_, i) => ({ alias: String(1000 + i), imageUrl: `/p/${1000 + i}` }));

  it("shows every contestant exactly once per pass", () => {
    const r = Slideshow.createRotation();
    r.load(items(12));
    expect(r.passSize()).toBe(12);
    const shown: string[] = [];
    for (let i = 0; i < 12; i++) shown.push(r.next()!.alias);
    expect(new Set(shown).size).toBe(12);
    expect(r.needsRefresh()).toBe(true);
  });

  it("starts the next pass from a freshly loaded list, and never repeats the picture just shown at the seam", () => {
    const r = Slideshow.createRotation();
    r.load(items(6));
    let last = "";
    for (let i = 0; i < 6; i++) last = r.next()!.alias;
    r.load(items(6));
    const first = r.next()!.alias;
    expect(first).not.toBe(last);
  });

  it("keeps showing pictures when a refresh fails: it re-cycles the last list rather than going blank", () => {
    const r = Slideshow.createRotation();
    r.load(items(3));
    const shown = Array.from({ length: 9 }, () => r.next()!.alias);
    expect(shown.every(Boolean)).toBe(true);
    expect(new Set(shown)).toEqual(new Set(["1000", "1001", "1002"]));
  });

  it("is quiet when there is nothing to show, and replaces a withdrawn contestant at the next refresh", () => {
    const r = Slideshow.createRotation();
    expect(r.next()).toBeNull();
    r.load([]);
    expect(r.next()).toBeNull();
    r.load(items(4));
    r.next();
    r.load(items(4).filter((i) => i.alias !== "1001")); // withdrawn
    const afterRefresh = new Set<string>();
    for (let i = 0; i < 3; i++) afterRefresh.add(r.next()!.alias);
    expect(afterRefresh.has("1001")).toBe(false);
  });

  it("orders each pass differently (a seeded random is injectable for tests) and carries no standing in its output", () => {
    const orders = new Set<string>();
    for (let seed = 1; seed <= 6; seed++) {
      let s = seed;
      const random = () => { s = (s * 16807) % 2147483647; return (s - 1) / 2147483646; };
      const r = Slideshow.createRotation(random);
      r.load(items(10));
      orders.add(Array.from({ length: 10 }, () => r.next()!.alias).join());
    }
    expect(orders.size).toBeGreaterThan(1);
    const r = Slideshow.createRotation();
    r.load(items(3));
    expect(Object.keys(r.peek()!).sort()).toEqual(["alias", "imageUrl"]);
  });
});

// ---------------------------------------------------------------- UG-IV-GATE-007 — the pending policies are unapproved options, not questions and not decisions

describe("operator: the pending policies are unapproved technical options, said as statements and attributed to the Founder (UG-IV-GATE-007)", () => {
  it("gives every policy its situation, what recording it does and what happens while it is pending — as statements, never as a yes/no question", () => {
    for (const key of O.POLICY_ORDER) {
      const info = O.POLICY_INFO[key];
      expect(Object.keys(info).sort()).toEqual(["applies", "ifRecorded", "title", "value", "whilePending"]); // the old `text` (a question) is gone
      for (const part of [info.applies, info.ifRecorded, info.whilePending]) {
        expect(part.length).toBeGreaterThan(40);
        expect(part).not.toMatch(/[¿?]/);
      }
      expect(info.title).not.toMatch(/[¿?]/);
    }
  });

  it("states each consequence as the server enforces it", () => {
    const I = O.POLICY_INFO;
    expect(I.ZERO_VALID_VOTES_PRELIMINARY.applies).toMatch(/sin ningún voto válido/);
    expect(I.ZERO_VALID_VOTES_PRELIMINARY.applies).toMatch(/se retiró no cuenta/);
    expect(I.ZERO_VALID_VOTES_PRELIMINARY.ifRecorded).toMatch(/pasan a la final todas las participaciones que no se retiraron/);
    expect(I.ZERO_VALID_VOTES_PRELIMINARY.whilePending).toMatch(/el corte de finalistas se rechaza/);

    expect(I.ZERO_VOTE_ENTRIES_AT_CUTOFF.applies).toMatch(/una participación sin ningún voto quedaría dentro del corte/);
    expect(I.ZERO_VOTE_ENTRIES_AT_CUTOFF.ifRecorded).toMatch(/sin votos[\s\S]*avanzan a la final/);
    expect(I.ZERO_VOTE_ENTRIES_AT_CUTOFF.whilePending).toMatch(/el corte de finalistas se rechaza/);

    expect(I.FINALIST_WITHDRAWAL_AFTER_SELECTION.applies).toMatch(/se retira después del corte/);
    expect(I.FINALIST_WITHDRAWAL_AFTER_SELECTION.ifRecorded).toMatch(/nadie ocupa su lugar/);
    expect(I.FINALIST_WITHDRAWAL_AFTER_SELECTION.ifRecorded).toMatch(/el corte no se modifica/);
    expect(I.FINALIST_WITHDRAWAL_AFTER_SELECTION.whilePending).toMatch(/no se prepara ni se abre la final/);
    expect(I.FINALIST_WITHDRAWAL_AFTER_SELECTION.whilePending).toMatch(/no se publica ninguna de las dos rondas/);
  });

  it("fixes the status, the action and the notices the page shows", () => {
    expect(O.POLICY_STATUS_PENDING).toBe("Pendiente de aprobación del Founder");
    expect(O.POLICY_ACTION_LABEL).toBe("Registrar decisión aprobada");
    expect(O.POLICY_STATUS_RECORDED).toBe("Registrada por el operador");
    // operator authority does not approve; the application cannot verify the approval
    expect(O.POLICY_OPERATOR_NOTICE).toMatch(/no aprueba esta política/);
    expect(O.POLICY_OPERATOR_NOTICE).toMatch(/Founder/);
    expect(O.POLICY_OPERATOR_NOTICE).toMatch(/no puede verificar/);
    // the acknowledgement is first person and says it is only a record
    expect(O.POLICY_ACK_TEXT).toMatch(/^Confirmo que el Founder ya aprobó esta política con este valor exacto/);
    expect(O.POLICY_ACK_TEXT).toMatch(/constancia/);
    expect(O.POLICY_ACK_TEXT).toMatch(/no verifica/);
    // a recorded decision is the operator's record; it never says the application checked anything
    expect(O.POLICY_RECORDED_NOTICE).toMatch(/registrada por el operador/);
    expect(O.POLICY_RECORDED_NOTICE).toMatch(/no verificó que el Founder/);
    expect(O.POLICY_RECORDED_NOTICE).not.toMatch(/verificada|verificado por/);
    expect(O.POLICY_MISSING_ACK).toMatch(/Founder ya aprobó/);
    expect(O.POLICY_MISSING_REFERENCE).toMatch(/aprobación del Founder/);
  });

  it("names the Founder's approval — never 'Product' — everywhere a held operation or a refused record is explained", () => {
    const held = O.nextSteps(overviewOf({ opened: true, closed: true, pendingResolutions: [{ key: "ZERO_VOTE_ENTRIES_AT_CUTOFF" }] }));
    const reason = stepOf(held, "FINALISTS").reason!;
    expect(reason).toMatch(/^Pendiente de aprobación del Founder: /);
    expect(reason).toContain(O.POLICY_INFO.ZERO_VOTE_ENTRIES_AT_CUTOFF.title);
    const finalHeld = O.nextSteps(overviewOf({ roundRole: "FINAL", opened: false, entries: [], pendingResolutions: [{ key: "FINALIST_WITHDRAWAL_AFTER_SELECTION" }] }));
    expect(stepOf(finalHeld, "PREPARE").reason).toMatch(/^Pendiente de aprobación del Founder: /);
    for (const text of [reason, stepOf(finalHeld, "PREPARE").reason!, O.describeError("POLICY_REQUIRED"), O.describeError("POLICY_ALREADY_RECORDED")]) expect(text).not.toMatch(/Producto/);
    expect(O.describeError("POLICY_REQUIRED")).toMatch(/aprobada por el Founder/);
    expect(O.describeError("POLICY_ALREADY_RECORDED")).toMatch(/no se puede cambiar/);
  });

  it("still sends exactly the key, the one supported value and the reference — the wire format is unchanged", async () => {
    const calls: Array<{ url: string; init: Json }> = [];
    const api = O.buildOperatorApi(async (url, init) => { calls.push({ url, init }); return { status: 201, json: async () => ({}) }; }, async () => "tok", () => "host-token", ID);
    for (const key of O.POLICY_ORDER) await api.policy(key, "REF-1");
    expect(calls.map((c) => JSON.parse(c.init.body))).toEqual([
      { policyKey: "ZERO_VALID_VOTES_PRELIMINARY", policyValue: "ALL_ENTRIES_ADVANCE", approvalReference: "REF-1" },
      { policyKey: "ZERO_VOTE_ENTRIES_AT_CUTOFF", policyValue: "TIED_ZERO_VOTE_ENTRIES_ADVANCE", approvalReference: "REF-1" },
      { policyKey: "FINALIST_WITHDRAWAL_AFTER_SELECTION", policyValue: "EXCLUDE_WITHOUT_REFILL", approvalReference: "REF-1" },
    ]);
  });
});
