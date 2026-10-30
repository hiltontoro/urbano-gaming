import { describe, expect, it } from "vitest";
import { JSDOM } from "jsdom";
import { readFileSync } from "node:fs";
import path from "node:path";

/**
 * Soccer Predictions member page (public/soccer-predictions.html), parsed and run whole in jsdom as shipped, with a stubbed fetch and a
 * stubbed UrbanoAuth: no network, no credentials. Proves the "Prize qualified" line names WHICH prize the member qualified for (resolved
 * client-side from the match's venue activations), keeps the superseded / already redeemed / not yet redeemed wording, falls back cleanly
 * when the prize cannot be resolved, and that admin-entered strings (team, player, competition, prize label) never reach an HTML parser.
 */

const HTML = readFileSync(path.join(process.cwd(), "public/soccer-predictions.html"), "utf8");
// The shared language module the page loads. This file asserts the English wording, so the page is loaded in English; Spanish by default, the
// language switch and the Spanish journey are covered by __tests__/shellPublic.test.ts.
const I18N_SOURCE = readFileSync(path.join(process.cwd(), "public/urbanoI18n.js"), "utf8");
const API = "/api/gaming/predictions";
const HOSTILE = '<img src=x onerror="window.__xss=(window.__xss||0)+1">';

interface Overrides {
  match?: Record<string, unknown>;
  qualification?: Record<string, unknown> | null;
  authenticated?: boolean;
  /** What getState reports when authenticated is false: "unauthenticated" (default) or "profile_incomplete". */
  authStatus?: string;
  /** What the member's own route answers (default: a saved prediction with its evaluation and qualification). */
  mine?: Record<string, unknown>;
  /** The page language (default English; this file asserts English wording). */
  lang?: "en" | "es";
}

function buildMatch(over: Record<string, unknown> = {}) {
  return {
    matchId: "m1",
    homeTeam: { teamId: "team-a", name: "Alpha FC", players: [{ playerId: "p1", name: "Ana Díaz" }, { playerId: "p2", name: "Bob Stone" }] },
    awayTeam: { teamId: "team-b", name: "Beta FC", players: [{ playerId: "p3", name: "Cleo Park" }] },
    competition: "Liga Nacional",
    kickoffAt: "2026-10-24T20:00:00.000Z",
    cancelledAt: null,
    finalized: true,
    finalResult: { homeScore: 2, awayScore: 1 },
    venueActivations: [
      {
        venueActivationId: "act-1",
        enabled: true,
        venue: { venueId: "v1", name: "Beer Box", latitude: 14.07, longitude: -87.19, radiusMeters: 150, active: true },
        prizeTiers: [
          { prizeTierId: "tier-2", correctDimensionCount: 2, prizeLabel: "Free pitcher" },
          { prizeTierId: "tier-4", correctDimensionCount: 4, prizeLabel: "Dinner for two" },
        ],
      },
      {
        venueActivationId: "act-2",
        enabled: true,
        venue: { venueId: "v2", name: "Other Bar", latitude: 14.1, longitude: -87.2, radiusMeters: 100, active: true },
        prizeTiers: [{ prizeTierId: "tier-other", correctDimensionCount: 3, prizeLabel: "Other bar prize" }],
      },
    ],
    ...over,
  };
}

function qualification(over: Record<string, unknown> = {}) {
  return {
    prizeQualificationId: "q1", evaluationId: "e1", gamingMemberId: "member-1", venueActivationId: "act-1", prizeTierId: "tier-2",
    // The member route returns a member-safe view: no staff identity, no internal hold or release reasons.
    redeemedAt: null, supersededAt: null, alreadyDelivered: false, underReview: false, createdAt: "2026-10-24T22:00:00.000Z", ...over,
  };
}

const PREDICTION = {
  predictionId: "pr1", predictedHomeScore: 2, predictedAwayScore: 1, predictedGoalscorerPlayerId: "p1",
  predictedGoalMinuteRegulation: 30, predictedGoalMinuteStoppage: null, predictedFirstTeamToScore: "HOME", venueActivationId: "act-1",
};
const EVALUATION = { evaluationId: "e1", scorelineCorrect: true, goalscorerCorrect: true, goalMinuteCorrect: false, firstTeamToScoreCorrect: false, correctDimensionCount: 2 };

async function loadPage(over: Overrides = {}) {
  const match = buildMatch(over.match);
  const mine = over.mine ?? { prediction: PREDICTION, evaluation: EVALUATION, qualification: over.qualification === undefined ? qualification() : over.qualification };
  const calls: string[] = [];
  const signIns: Array<Record<string, any>> = [];
  const dom = new JSDOM(HTML, {
    url: "http://localhost/soccer-predictions.html",
    runScripts: "dangerously",
    pretendToBeVisual: true,
    beforeParse(window) {
      const w = window as unknown as Record<string, any>;
      window.localStorage.setItem("urbano.lang", over.lang ?? "en");
      window.eval(I18N_SOURCE); // jsdom does not load external scripts: the REAL shipped module is evaluated, as the script tag would
      w.UrbanoAuth = {
        attachSignInButton: () => {},
        getState: async () => (over.authenticated === false ? { status: over.authStatus ?? "unauthenticated" } : { status: "authenticated", email: "m@example.com", gamingMemberId: "member-1", displayName: "Member" }),
        // The panel is not run here: what the page ASKS for is recorded, and the stored intent is what a test hands back.
        openSignIn: (options: Record<string, any>) => { signIns.push(options); w.__intent = options && options.intent ? options.intent : null; return true; },
        consumeIntent: () => { const intent = w.__intent || null; w.__intent = null; return intent; },
        getAccessToken: async () => "stub-token",
        onAuthStateChange: async () => () => {},
      };
      w.fetch = async (url: string) => {
        calls.push(String(url));
        const body = String(url) === `${API}/matches` ? { matches: [match] } : String(url) === `${API}/matches/m1/mine` ? mine : { error: "unexpected" };
        return { status: 200, json: async () => JSON.parse(JSON.stringify(body)) };
      };
    },
  });
  const win = dom.window as unknown as Window & Record<string, any>;
  const doc = win.document;
  const deadline = Date.now() + 3000;
  // a card is appended only after renderMatch has finished, including the member's own-prediction request
  while (!doc.querySelector("#content .card")) {
    await new Promise((r) => setTimeout(r, 0));
    if (Date.now() > deadline) throw new Error("page did not render");
  }
  const prizeLine = () => [...doc.querySelectorAll("p.msg")].find((p) => (p.textContent ?? "").startsWith("Prize qualified"));
  return { win, doc, calls, signIns, prizeLine, card: () => doc.querySelector("#content .card") as HTMLElement | null, close: () => dom.window.close() };
}

describe("D. Prize qualified line names the prize", () => {
  it("pending: shows the prize label resolved from the member's venue activation and the not-yet-redeemed instruction", async () => {
    const page = await loadPage();
    expect(page.prizeLine()!.textContent).toBe("Prize qualified: Free pitcher — not yet redeemed — see an URBANO host.");
    expect(page.prizeLine()!.querySelector("strong")!.textContent).toBe("Free pitcher");
    expect(page.doc.body.textContent).toContain("2 of 4 correct.");
    page.close();
  });

  it("already redeemed: keeps the already redeemed wording and still names the prize", async () => {
    const page = await loadPage({ qualification: qualification({ redeemedAt: "2026-10-24T23:00:00.000Z" }) });
    expect(page.prizeLine()!.textContent).toBe("Prize qualified: Free pitcher — already redeemed.");
    expect(page.prizeLine()!.textContent).not.toContain("not yet redeemed");
    page.close();
  });

  it("a prize an earlier handover already satisfies says so and is not offered for collection again", async () => {
    const page = await loadPage({ qualification: qualification({ alreadyDelivered: true }) });
    expect(page.prizeLine()!.textContent).toBe("Prize qualified: Free pitcher — already handed over earlier — the corrected result does not change it.");
    expect(page.prizeLine()!.textContent).not.toContain("see an URBANO host");
    page.close();
  });

  it("a prize the venue is reviewing after a correction is not shown as ready to collect, and is not styled as success", async () => {
    const page = await loadPage({ qualification: qualification({ underReview: true }) });
    expect(page.prizeLine()!.textContent).toBe("Prize qualified: Free pitcher — being reviewed by the venue after a result correction — ask an URBANO host before collecting.");
    expect(page.prizeLine()!.textContent).not.toContain("not yet redeemed");
    expect(page.prizeLine()!.className).not.toContain("success");
    page.close();
  });

  it("superseded and redeemed still win over the review and already-delivered notes", async () => {
    const superseded = await loadPage({ qualification: qualification({ underReview: true, alreadyDelivered: true, supersededAt: "x" }) });
    expect(superseded.prizeLine()!.textContent).toBe("Prize qualified: Free pitcher (superseded by a result correction).");
    const redeemed = await loadPage({ qualification: qualification({ underReview: true, alreadyDelivered: true, redeemedAt: "y" }) });
    expect(redeemed.prizeLine()!.textContent).toBe("Prize qualified: Free pitcher — already redeemed.");
    superseded.close();
    redeemed.close();
  });

  it("superseded by a correction: keeps the superseded wording (it wins over redeemed) and still names the prize", async () => {
    const page = await loadPage({ qualification: qualification({ supersededAt: "2026-10-25T01:00:00.000Z" }) });
    expect(page.prizeLine()!.textContent).toBe("Prize qualified: Free pitcher (superseded by a result correction).");

    const both = await loadPage({ qualification: qualification({ supersededAt: "x", redeemedAt: "y" }) });
    expect(both.prizeLine()!.textContent).toBe("Prize qualified: Free pitcher (superseded by a result correction).");
    page.close();
    both.close();
  });

  it("resolves the label by the qualification's own activation and tier, not by dimension count or position", async () => {
    const page = await loadPage({ qualification: qualification({ venueActivationId: "act-2", prizeTierId: "tier-other" }) });
    expect(page.prizeLine()!.textContent).toBe("Prize qualified: Other bar prize — not yet redeemed — see an URBANO host.");

    const fourOfFour = await loadPage({ qualification: qualification({ prizeTierId: "tier-4" }) });
    expect(fourOfFour.prizeLine()!.textContent).toContain("Dinner for two");
    page.close();
    fourOfFour.close();
  });

  it("falls back to the tier id across the match's activations when the activation id is not known", async () => {
    const page = await loadPage({ qualification: qualification({ venueActivationId: "act-gone", prizeTierId: "tier-4" }) });
    expect(page.prizeLine()!.textContent).toBe("Prize qualified: Dinner for two — not yet redeemed — see an URBANO host.");
    page.close();
  });

  it("label fallback: an unknown tier, a blank label or a match without activations falls back to the original wording, never a raw id", async () => {
    const unknownTier = await loadPage({ qualification: qualification({ prizeTierId: "tier-unknown" }) });
    expect(unknownTier.prizeLine()!.textContent).toBe("Prize qualified: not yet redeemed — see an URBANO host.");
    expect(unknownTier.prizeLine()!.querySelector("strong")).toBeNull();

    const redeemedUnknown = await loadPage({ qualification: qualification({ prizeTierId: "tier-unknown", redeemedAt: "x" }) });
    expect(redeemedUnknown.prizeLine()!.textContent).toBe("Prize qualified: already redeemed.");

    const supersededUnknown = await loadPage({ qualification: qualification({ prizeTierId: "tier-unknown", supersededAt: "x" }) });
    expect(supersededUnknown.prizeLine()!.textContent).toBe("Prize qualified: (superseded by a result correction).");

    const blankLabel = await loadPage({ match: { venueActivations: [{ venueActivationId: "act-1", enabled: true, venue: null, prizeTiers: [{ prizeTierId: "tier-2", correctDimensionCount: 2, prizeLabel: "   " }] }] } });
    expect(blankLabel.prizeLine()!.textContent).toBe("Prize qualified: not yet redeemed — see an URBANO host.");

    const noActivations = await loadPage({ match: { venueActivations: [] } });
    expect(noActivations.prizeLine()!.textContent).toBe("Prize qualified: not yet redeemed — see an URBANO host.");
    expect(`${unknownTier.prizeLine()!.textContent}${blankLabel.prizeLine()!.textContent}`).not.toMatch(/tier-/);
    for (const p of [unknownTier, redeemedUnknown, supersededUnknown, blankLabel, noActivations]) p.close();
  });

  it("shows no prize line when the member did not qualify, and none when signed out", async () => {
    const none = await loadPage({ qualification: null });
    expect(none.prizeLine()).toBeUndefined();
    expect(none.doc.body.textContent).toContain("2 of 4 correct.");

    const signedOut = await loadPage({ authenticated: false });
    expect(signedOut.prizeLine()).toBeUndefined();
    // This match is finalized: signing in offers the results, never a prediction (see section H).
    expect(signedOut.doc.body.textContent).toContain("Log in to see your results for this match.");
    expect(signedOut.doc.body.textContent).not.toContain("make your prediction");
    none.close();
    signedOut.close();
  });

  it("the prize label is inserted as text: a hostile label creates no element and fires nothing", async () => {
    const hostileTiers = [{ venueActivationId: "act-1", enabled: true, venue: { venueId: "v1", name: "Beer Box", latitude: 1, longitude: 2, radiusMeters: 3, active: true }, prizeTiers: [{ prizeTierId: "tier-2", correctDimensionCount: 2, prizeLabel: HOSTILE }] }];
    const page = await loadPage({ match: { venueActivations: hostileTiers } });
    const line = page.prizeLine()!;
    expect(line.querySelector("img, svg, script")).toBeNull();
    expect(line.querySelector("strong")!.textContent).toBe(HOSTILE);
    expect(page.doc.querySelector("#content img")).toBeNull();
    expect((page.win as any).__xss).toBeUndefined();
    page.close();
  });
});

describe("admin-entered strings never reach an HTML parser on the member page", () => {
  it("team, competition and player names in the finalized recap", async () => {
    const page = await loadPage({
      match: {
        homeTeam: { teamId: "team-a", name: HOSTILE, players: [{ playerId: "p1", name: HOSTILE }] },
        awayTeam: { teamId: "team-b", name: `"><svg onload="window.__xss=1">`, players: [] },
        competition: HOSTILE,
      },
    });
    const card = page.card()!;
    expect(card.querySelector("img, svg, script")).toBeNull();
    expect(card.querySelector(".match-teams span")!.textContent).toBe(HOSTILE);
    expect(card.querySelector(".match-meta span")!.textContent).toBe(HOSTILE);
    // the recap line names the predicted goalscorer (hostile) as text
    expect(card.textContent).toContain(`Your prediction: 2–1, ${HOSTILE}`);
    expect((page.win as any).__xss).toBeUndefined();
    page.close();
  });

  it("team and player names in the open prediction form (goalscorer groups and options, first-scorer buttons)", async () => {
    const page = await loadPage({
      match: {
        finalized: false,
        finalResult: null,
        kickoffAt: "2099-01-01T00:00:00.000Z",
        homeTeam: { teamId: "team-a", name: HOSTILE, players: [{ playerId: "p1", name: HOSTILE }] },
        awayTeam: { teamId: "team-b", name: "Beta FC", players: [{ playerId: "p3", name: `"><svg onload="window.__xss=1">` }] },
        competition: HOSTILE,
      },
      qualification: null,
    });
    await new Promise((r) => setTimeout(r, 30));
    const card = page.card()!;
    expect(card.querySelector("#goalscorer-select-m1")).toBeTruthy();
    expect(card.querySelector("img, svg, script")).toBeNull();
    const options = [...card.querySelectorAll("#goalscorer-select-m1 option")].map((o) => o.textContent);
    expect(options).toContain(HOSTILE);
    expect(options).toContain(`"><svg onload="window.__xss=1">`);
    expect([...card.querySelectorAll("#goalscorer-select-m1 optgroup")][0].getAttribute("label")).toBe(HOSTILE);
    expect(card.querySelector('.team-toggle[data-value="HOME"]')!.textContent).toBe(HOSTILE);
    expect((page.win as any).__xss).toBeUndefined();
    page.close();
  });

  it("the existing finalized recap still renders: result pill, four dimensions, and the member's own prediction", async () => {
    const page = await loadPage();
    expect(page.doc.querySelector(".status-pill")!.textContent).toBe("Result: 2–1");
    expect(page.doc.querySelectorAll(".dimension-cell")).toHaveLength(4);
    expect(page.doc.querySelectorAll(".dimension-cell.correct")).toHaveLength(2);
    expect(page.card()!.textContent).toContain("Your prediction: 2–1, Ana Díaz, 30', first: Alpha FC");
    page.close();
  });
});


// ---------------------------------------------------------------------------------------------------------------------------------
// Account entry on the member page: the page rebuilds itself when who is signed in changes (no manual reload), remembers the intended
// match, and never shows one person's data to the next.
// ---------------------------------------------------------------------------------------------------------------------------------

type Identity = { status: "unauthenticated" } | { status: "profile_incomplete" } | { status: "authenticated"; token: string; name: string };

async function loadInteractive(mineByToken: Record<string, Record<string, unknown>>) {
  const match = buildMatch({ finalized: false, finalResult: null, kickoffAt: "2099-01-01T00:00:00.000Z", venueActivations: [{ venueActivationId: "act-1", enabled: true, venue: { venueId: "v1", name: "Beer Box", latitude: 14.07, longitude: -87.19, radiusMeters: 150, active: true }, prizeTiers: [] }] });
  const auth = {
    identity: { status: "unauthenticated" } as Identity,
    callbacks: [] as Array<(state: unknown) => unknown>,
    openSignIn: [] as unknown[],
    intent: null as null | Record<string, unknown>,
    consumed: 0,
    gates: new Map<string, Promise<void>>(),
    matchFetches: 0,
  };
  const dom = new JSDOM(HTML, {
    url: "http://localhost/soccer-predictions.html",
    runScripts: "dangerously",
    pretendToBeVisual: true,
    beforeParse(window) {
      const w = window as unknown as Record<string, any>;
      window.localStorage.setItem("urbano.lang", "en");
      window.eval(I18N_SOURCE); // jsdom does not load external scripts: the REAL shipped module is evaluated, as the script tag would
      w.UrbanoAuth = {
        attachSignInButton: () => {},
        getState: async () => (auth.identity.status === "authenticated" ? { status: "authenticated", gamingMemberId: "gm", displayName: auth.identity.name } : { status: auth.identity.status }),
        getAccessToken: async () => (auth.identity.status === "authenticated" ? auth.identity.token : null),
        onAuthStateChange: async () => () => {},
        onIdentityChange: async (cb: (state: unknown) => unknown) => { auth.callbacks.push(cb); return () => {}; },
        openSignIn: (options: unknown) => { auth.openSignIn.push(options); return true; },
        consumeIntent: () => { auth.consumed += 1; const i = auth.intent; auth.intent = null; return i; },
      };
      w.fetch = async (url: string, init?: { headers?: Record<string, string> }) => {
        const target = String(url);
        if (target === `${API}/matches`) { auth.matchFetches += 1; return { status: 200, json: async () => JSON.parse(JSON.stringify({ matches: [match] })) }; }
        if (target === `${API}/matches/m1/mine`) {
          const token = String(init?.headers?.authorization ?? "").replace("Bearer ", "");
          const gate = auth.gates.get(token);
          if (gate) await gate;
          return { status: 200, json: async () => JSON.parse(JSON.stringify(mineByToken[token] ?? {})) };
        }
        return { status: 404, json: async () => ({ error: "unexpected" }) };
      };
    },
  });
  const win = dom.window as unknown as Window & Record<string, any>;
  const doc = win.document;
  const flush = async (n = 10) => { for (let i = 0; i < n; i += 1) await new Promise((r) => setTimeout(r, 0)); };
  const waitFor = async (predicate: () => boolean, label: string) => {
    const deadline = Date.now() + 3000;
    while (!predicate()) { await new Promise((r) => setTimeout(r, 0)); if (Date.now() > deadline) throw new Error(`timed out waiting for: ${label}`); }
  };
  await waitFor(() => !!doc.querySelector("#content .card"), "first render");
  const changeTo = async (identity: Identity, settleMs = 0) => {
    auth.identity = identity;
    const state = identity.status === "authenticated" ? { status: "authenticated", displayName: identity.name } : { status: identity.status };
    const pending = Promise.all(auth.callbacks.map((cb) => cb(state)));
    if (settleMs >= 0) await pending;
    return pending;
  };
  const card = () => doc.querySelector("#content .card") as HTMLElement | null;
  return { win, doc, auth, flush, waitFor, changeTo, card, close: () => dom.window.close() };
}

const ANA = { prediction: { ...PREDICTION, predictedHomeScore: 2, predictedAwayScore: 1, venueActivationId: "act-1" }, evaluation: null, qualification: null };
const BRUNO = { prediction: { ...PREDICTION, predictedHomeScore: 0, predictedAwayScore: 3, venueActivationId: "act-1" }, evaluation: null, qualification: null };
const scores = (doc: Document) => [(doc.querySelector("#home-score-m1") as HTMLInputElement | null)?.value, (doc.querySelector("#away-score-m1") as HTMLInputElement | null)?.value];

describe("Account entry on the member page", () => {
  it("signed out: one clear Log in / Create account action that remembers THIS match, and no prediction inputs", async () => {
    const page = await loadInteractive({});
    expect(page.card()!.getAttribute("data-match-id")).toBe("m1");
    expect(page.doc.body.textContent).toContain("Log in or create an account to make your prediction.");
    expect(page.doc.querySelector("#home-score-m1")).toBeNull();
    (page.doc.querySelector("[data-login-cta]") as HTMLElement).click();
    expect(page.auth.openSignIn).toEqual([{ intent: { kind: "predict", matchId: "m1" } }]);
    page.close();
  });

  it("verification unlocks the prediction inputs WITHOUT a page reload (same document, list rebuilt for the new identity)", async () => {
    const page = await loadInteractive({ "token-ana": ANA });
    (page.win as any).__sameDocument = "yes";
    const before = page.auth.matchFetches;
    await page.changeTo({ status: "authenticated", token: "token-ana", name: "Ana" });
    await page.waitFor(() => !!page.doc.querySelector("#home-score-m1"), "inputs after sign-in");
    expect(scores(page.doc)).toEqual(["2", "1"]); // Ana's own saved prediction
    expect((page.win as any).__sameDocument).toBe("yes");
    expect(page.auth.matchFetches).toBe(before + 1);
    expect(page.doc.querySelector("[data-login-cta]")).toBeNull();
    page.close();
  });

  it("the intended match is resumed after sign-in: scrolled to, first input focused, and the person told they are signed in", async () => {
    const page = await loadInteractive({ "token-ana": ANA });
    page.auth.intent = { kind: "predict", matchId: "m1" };
    await page.changeTo({ status: "authenticated", token: "token-ana", name: "Ana" });
    await page.waitFor(() => !!page.doc.querySelector("#home-score-m1"), "inputs");
    expect(page.doc.activeElement?.id).toBe("home-score-m1");
    expect(page.doc.querySelector("#submit-msg-m1")!.textContent).toBe("You're signed in. Make your prediction below.");
    expect(page.auth.consumed).toBe(1);
    expect(page.auth.intent).toBeNull();
    page.close();
  });

  it("an intent is not consumed for a state that is not yet signed in (profile incomplete), only once the account is finished", async () => {
    const page = await loadInteractive({ "token-new": { prediction: null, evaluation: null, qualification: null } });
    page.auth.intent = { kind: "predict", matchId: "m1" };
    await page.changeTo({ status: "profile_incomplete" });
    await page.waitFor(() => (page.doc.body.textContent ?? "").includes("Finish creating your account"), "finish prompt");
    expect(page.doc.querySelector("#home-score-m1")).toBeNull();
    expect(page.auth.consumed).toBe(0);
    await page.changeTo({ status: "authenticated", token: "token-new", name: "New" });
    await page.waitFor(() => !!page.doc.querySelector("#home-score-m1"), "inputs after finishing");
    expect(page.auth.consumed).toBe(1);
    page.close();
  });

  it("sign-out removes everything that belonged to the person: the form, their saved values, and the identity of the next visitor starts clean", async () => {
    const page = await loadInteractive({ "token-ana": ANA, "token-bruno": BRUNO });
    await page.changeTo({ status: "authenticated", token: "token-ana", name: "Ana" });
    await page.waitFor(() => !!page.doc.querySelector("#home-score-m1"), "inputs");
    (page.doc.querySelector("#home-score-m1") as HTMLInputElement).value = "7"; // something typed, never submitted
    const consumedBefore = page.auth.consumed;
    await page.changeTo({ status: "unauthenticated" });
    await page.waitFor(() => !!page.doc.querySelector("[data-login-cta]"), "signed-out state");
    expect(page.doc.querySelector("#home-score-m1")).toBeNull();
    expect(page.doc.querySelector("#content")!.textContent).not.toContain("Update Prediction");
    expect(page.auth.consumed).toBe(consumedBefore); // signing out never resumes an intent
    await page.changeTo({ status: "authenticated", token: "token-bruno", name: "Bruno" });
    await page.waitFor(() => !!page.doc.querySelector("#home-score-m1"), "next person's inputs");
    expect(scores(page.doc)).toEqual(["0", "3"]); // Bruno sees Bruno's, never Ana's typed 7 or saved 2-1
    page.close();
  });

  it("switching straight from one person to another shows only the new person's data", async () => {
    const page = await loadInteractive({ "token-ana": ANA, "token-bruno": BRUNO });
    await page.changeTo({ status: "authenticated", token: "token-ana", name: "Ana" });
    await page.waitFor(() => scores(page.doc)[0] === "2", "Ana's values");
    await page.changeTo({ status: "authenticated", token: "token-bruno", name: "Bruno" });
    await page.waitFor(() => scores(page.doc)[0] === "0", "Bruno's values");
    expect(scores(page.doc)).toEqual(["0", "3"]);
    page.close();
  });

  it("a slow answer for the previous identity that arrives late is dropped; the newest identity's list stands", async () => {
    const page = await loadInteractive({ "token-ana": ANA, "token-bruno": BRUNO });
    let releaseAna!: () => void;
    page.auth.gates.set("token-ana", new Promise<void>((resolve) => { releaseAna = resolve; }));
    const anaChange = page.changeTo({ status: "authenticated", token: "token-ana", name: "Ana" }); // stuck waiting on Ana's own-prediction request
    await page.flush();
    await page.changeTo({ status: "authenticated", token: "token-bruno", name: "Bruno" });
    await page.waitFor(() => scores(page.doc)[0] === "0", "Bruno's values");
    releaseAna();
    await anaChange;
    await page.flush();
    expect(scores(page.doc)).toEqual(["0", "3"]);
    expect(page.doc.querySelectorAll("#content .card")).toHaveLength(1);
    page.close();
  });

  it("the page still renders with an older auth object that has no identity or intent methods (other consumers keep working)", async () => {
    const page = await loadPage({ authenticated: false });
    expect(page.card()).not.toBeNull();
    (page.doc.querySelector("[data-login-cta]") as HTMLElement).click(); // falls back to the header button; must not throw
    page.close();
  });
});


// ---------------------------------------------------------------------------------------------------------------------------------
// H. The words of the sign-in prompt follow the state of the match. Only an OPEN match invites a prediction. These texts decide nothing:
//    the server still refuses a prediction on a closed or finalized match, and nothing here is sent.
// ---------------------------------------------------------------------------------------------------------------------------------

describe("H. Access wording follows the state of the match", () => {
  const OPEN = { finalized: false, finalResult: null, kickoffAt: "2099-01-01T00:00:00.000Z" };
  const CLOSED = { finalized: false, finalResult: null, kickoffAt: "2026-08-25T18:00:00.000Z" };
  const FINAL = { finalized: true, kickoffAt: "2026-08-25T18:00:00.000Z" };
  const body = (page: { doc: Document }) => (page.doc.querySelector("#content .card")?.textContent ?? "").replace(/\s+/g, " ");
  const cta = (page: { doc: Document }) => page.doc.querySelector("[data-login-cta]") as HTMLButtonElement;

  it("open: access to participate, with the original prompt and button", async () => {
    const page = await loadPage({ authenticated: false, match: OPEN });
    expect(body(page)).toContain("Log in or create an account to make your prediction.");
    expect(cta(page).textContent).toBe("Log in or create account");
    cta(page).click();
    expect(page.signIns).toEqual([{ intent: { kind: "predict", matchId: "m1" } }]);
    page.close();
  });

  it("closed (kick-off passed, no result yet): access to consult an existing participation, and no invitation to predict or to create an account", async () => {
    const page = await loadPage({ authenticated: false, match: CLOSED });
    expect(body(page)).toContain("Log in to view your participation in this match.");
    expect(body(page)).not.toMatch(/make your prediction|create an account|create account|Create account/i);
    expect(cta(page).textContent).toBe("Log in");
    cta(page).click();
    expect(page.signIns).toEqual([{ intent: { kind: "view", matchId: "m1" }, mode: "login" }]);
    page.close();
  });

  it("finalized: access to consult results, and no invitation to predict or to create an account", async () => {
    const page = await loadPage({ authenticated: false, match: FINAL });
    expect(body(page)).toContain("Log in to see your results for this match.");
    expect(body(page)).not.toMatch(/make your prediction|create an account|create account|Create account/i);
    expect(cta(page).textContent).toBe("Log in");
    cta(page).click();
    expect(page.signIns).toEqual([{ intent: { kind: "view", matchId: "m1" }, mode: "login" }]);
    page.close();
  });

  it("an unfinished account: open keeps its invitation; closed and finalized only ask to finish the account, never to predict", async () => {
    const open = await loadPage({ authenticated: false, authStatus: "profile_incomplete", match: OPEN });
    expect(body(open)).toContain("make your prediction");
    expect(cta(open).textContent).toBe("Finish creating your account");
    for (const state of [CLOSED, FINAL]) {
      const page = await loadPage({ authenticated: false, authStatus: "profile_incomplete", match: state });
      expect(body(page)).toContain("One more step: choose a display name to finish creating your account.");
      expect(body(page)).not.toContain("make your prediction");
      expect(cta(page).textContent).toBe("Finish creating your account");
      page.close();
    }
    open.close();
  });

  it("the wording changes nothing the server decides: no prediction request is made by any prompt", async () => {
    for (const state of [OPEN, CLOSED, FINAL]) {
      const page = await loadPage({ authenticated: false, match: state });
      cta(page).click();
      expect(page.calls.filter((url) => url.endsWith("/predict"))).toEqual([]);
      expect(page.calls).toEqual([`${API}/matches`]);
      page.close();
    }
  });

  it("coming back after logging in to VIEW only brings the card into view: no signed-in invitation, no form focus", async () => {
    const page = await loadPage({ authenticated: false, match: CLOSED });
    let scrolled = 0;
    (page.win as any).Element.prototype.scrollIntoView = function () { scrolled += 1; };
    cta(page).click(); // stores the intent to view
    // a stand-in for the place where the signed-in note is written on an open match: a view must leave it empty
    const holder = page.doc.createElement("div");
    holder.id = "submit-msg-m1";
    page.doc.querySelector("#content .card")!.appendChild(holder);
    (page.win as any).eval("resumeIntent({ status: 'authenticated' })");
    expect(scrolled).toBe(1);
    expect(holder.textContent).toBe("");
    expect(page.doc.body.textContent).not.toContain("You're signed in. Make your prediction below.");
    page.close();
  });

  it("while the predict intent from an open match still brings the signed-in note, as before", async () => {
    const page = await loadPage({ authenticated: false, match: OPEN });
    (page.win as any).Element.prototype.scrollIntoView = function () {};
    cta(page).click();
    // an open match has the form once signed in; here only the note is checked, so a stand-in container is given to the card
    const card = page.doc.querySelector("#content .card")!;
    const holder = page.doc.createElement("div");
    holder.id = "submit-msg-m1";
    card.appendChild(holder);
    (page.win as any).eval("resumeIntent({ status: 'authenticated' })");
    expect(page.doc.body.textContent).toContain("You're signed in. Make your prediction below.");
    page.close();
  });
});

// ---- the REAL card before its venue is enabled: a disabled action, never opened by the clock ----------------------------------------
describe("E. A match with an approved participation window and no enabled venue shows its real card with a disabled action", () => {
  const OFFER = {
    maxLevel: 4, digest: "d", available: true, problem: null,
    levels: [
      { level: 1, label: "Una orden de tequeños" },
      { level: 2, label: "Bono de consumo de L250" },
      { level: 3, label: "Bono de consumo de L500" },
      { level: 4, label: "Paquete de cuatro entradas para Halloween de The Pub (valor L1,200)" },
    ],
  };
  const venue = { venueId: "v1", name: "The Pub by Beer Box", latitude: 14.099309, longitude: -87.180864, radiusMeters: 30.48, active: true };
  const activation = (over: Record<string, unknown> = {}) => ({ venueActivationId: "act-1", enabled: false, venue, prizeTiers: [], offer: OFFER, ...over });
  const FUTURE_KICKOFF = "2099-01-01T20:00:00.000Z";
  const FUTURE_OPENS = "2099-01-01T18:30:00.000Z"; // 12:30 p. m. in Honduras
  const PAST_OPENS = "2020-01-01T18:30:00.000Z";
  const closedMatch = (over: Record<string, unknown> = {}) => ({
    finalized: false, finalResult: null, kickoffAt: FUTURE_KICKOFF, participationOpensAt: FUTURE_OPENS, predictionContract: "PROGRESSIVE_LADDER_V1",
    homeTeam: { teamId: "t1", name: "FC Barcelona", players: [] }, awayTeam: { teamId: "t2", name: "Real Madrid CF", players: [] },
    competition: "El Clásico", venueActivations: [activation()], ...over,
  });
  const action = (page: { doc: Document }) => page.doc.querySelector("[data-not-open-action]") as HTMLButtonElement | null;

  it("signed out: the disabled action says when it opens, there is no login prompt and no form, and the prizes are listed as they are", async () => {
    const page = await loadPage({ authenticated: false, match: closedMatch() });
    expect(action(page)!.textContent).toBe("Take part — opening expected 12:30 p.m.");
    expect(action(page)!.disabled).toBe(true);
    expect(action(page)!.getAttribute("aria-disabled")).toBe("true");
    expect(page.doc.querySelector("[data-login-cta]")).toBeNull();
    expect(page.doc.querySelector("form")).toBeNull();
    const rows = [...page.doc.querySelectorAll("[data-not-open-offer] li")].map((li) => li.textContent);
    expect(rows).toHaveLength(4);
    for (const label of OFFER.levels.map((l) => l.label)) expect(rows.join("\n")).toContain(label);
    expect(page.calls).toEqual([`${API}/matches`]); // nothing else was asked for
    page.close();
  });

  it("in Spanish the action is exactly «Participar — apertura prevista 12:30 p. m.»", async () => {
    const page = await loadPage({ authenticated: false, lang: "es", match: closedMatch() });
    expect(action(page)!.textContent).toBe("Participar — apertura prevista 12:30 p. m.");
    expect(action(page)!.disabled).toBe(true);
    page.close();
  });

  it("the hour of Honduras is the instant minus six hours, written the same on every device: noon, midnight and the minutes", async () => {
    const cases: Array<[string, string]> = [["2099-01-01T18:00:00.000Z", "12:00 p. m."], ["2099-01-01T06:00:00.000Z", "12:00 a. m."], ["2099-01-01T06:05:00.000Z", "12:05 a. m."], ["2099-01-01T05:59:00.000Z", "11:59 p. m."], ["2099-01-01T19:45:00.000Z", "1:45 p. m."]];
    for (const [opens, written] of cases) {
      const page = await loadPage({ authenticated: false, lang: "es", match: closedMatch({ participationOpensAt: opens }) });
      expect(action(page)!.textContent, opens).toBe(`Participar — apertura prevista ${written}`);
      page.close();
    }
  });

  it("once the hour has passed and it is still closed, it says «Opening pending» / «Apertura pendiente» — still disabled", async () => {
    const en = await loadPage({ authenticated: false, match: closedMatch({ participationOpensAt: PAST_OPENS }) });
    expect(action(en)!.textContent).toBe("Opening pending");
    expect(action(en)!.disabled).toBe(true);
    expect(en.doc.querySelector("form")).toBeNull();
    en.close();
    const es = await loadPage({ authenticated: false, lang: "es", match: closedMatch({ participationOpensAt: PAST_OPENS }) });
    expect(action(es)!.textContent).toBe("Apertura pendiente");
    es.close();
  });

  it("the passing of the hour only changes the sentence: it never enables the button or shows a form", async () => {
    const opens = new Date(Date.now() + 1200).toISOString();
    const page = await loadPage({ authenticated: false, match: closedMatch({ participationOpensAt: opens }) });
    expect(action(page)!.getAttribute("data-state")).toBe("expected");
    await new Promise((r) => setTimeout(r, 1700));
    expect(action(page)!.getAttribute("data-state")).toBe("pending");
    expect(action(page)!.textContent).toBe("Opening pending");
    expect(action(page)!.disabled).toBe(true);
    expect(page.doc.querySelector("form")).toBeNull();
    expect(page.doc.querySelector("[data-login-cta]")).toBeNull();
    expect(page.calls).toEqual([`${API}/matches`]);
    page.close();
  });

  it("signed in with nothing saved: the same disabled action (and no form)", async () => {
    const page = await loadPage({ authenticated: true, mine: {}, match: closedMatch() });
    expect(action(page)!.textContent).toBe("Take part — opening expected 12:30 p.m.");
    expect(page.doc.querySelector("form")).toBeNull();
    page.close();
  });

  it("signed in with something already saved: the saved participation is still shown, not the disabled action", async () => {
    const page = await loadPage({
      authenticated: true,
      mine: { prediction: { ...PREDICTION, predictionContract: "COMPLETE_COUNT_V1" } },
      match: closedMatch({ predictionContract: "COMPLETE_COUNT_V1" }),
    });
    expect(page.doc.querySelector("[data-not-open]")).toBeNull();
    expect(page.doc.body.textContent).toContain("No venue is currently active for this match.");
    page.close();
  });

  it("once a venue is ENABLED with a valid offer the card is the normal one: login prompt for a visitor, no disabled action — the clock plays no part", async () => {
    for (const opens of [FUTURE_OPENS, PAST_OPENS]) {
      const page = await loadPage({ authenticated: false, match: closedMatch({ participationOpensAt: opens, venueActivations: [activation({ enabled: true })] }) });
      expect(page.doc.querySelector("[data-not-open]")).toBeNull();
      expect(page.doc.querySelector("[data-login-cta]")).not.toBeNull();
      page.close();
    }
  });

  it("a match WITHOUT an approved window is untouched: no disabled action is added to it", async () => {
    const page = await loadPage({ authenticated: false, match: closedMatch({ participationOpensAt: null }) });
    expect(page.doc.querySelector("[data-not-open]")).toBeNull();
    expect(page.doc.querySelector("[data-login-cta]")).not.toBeNull();
    page.close();
  });

  it("after the match has started the usual closed wording applies, not this action", async () => {
    const started = await loadPage({ authenticated: false, match: closedMatch({ kickoffAt: "2020-01-01T20:00:00.000Z", participationOpensAt: PAST_OPENS }) });
    expect(started.doc.querySelector("[data-not-open]")).toBeNull();
    started.close();
  });

  it("with no valid offer yet (no prizes loaded) the action is still there, and no empty prize list is drawn", async () => {
    const page = await loadPage({ authenticated: false, match: closedMatch({ venueActivations: [activation({ offer: { maxLevel: 0, levels: [], digest: null, available: false, problem: "NO_LEVELS" } })] }) });
    expect(action(page)!.disabled).toBe(true);
    expect(page.doc.querySelector("[data-not-open-offer]")).toBeNull();
    page.close();
  });
});


// ---------------------------------------------------------------------------------------------------------------------------------
// I. Lineup and history (Founder's decision of 2026-10-29). A finished match — the Clásico of 25 October is one — is found ONLY in the
//    history, with its result, the person's own participation and the prize line exactly as before. The way into the history is a separate,
//    always visible link under the heading, so nobody has to look for it below the upcoming matches. Nothing here changes what the server
//    accepts, what a prize says or when it can be redeemed: these are the page's words and order.
// ---------------------------------------------------------------------------------------------------------------------------------

const CRESTS_SOURCE = readFileSync(path.join(process.cwd(), "public/urbanoClubCrests.js"), "utf8");
const UPCOMING_DATA_SOURCE = readFileSync(path.join(process.cwd(), "public/homeUpcomingData.js"), "utf8");
const UPCOMING_SOURCE = readFileSync(path.join(process.cwd(), "public/homeUpcoming.js"), "utf8");
const HOUR = 3600_000;
const inHours = (h: number) => new Date(Date.now() + h * HOUR).toISOString();
/** Where an hour was read and when it was last compared with that source: the preselection shows an hour only with both. */
const SRC = { source: "Fuente de ensayo", verifiedAt: "2020-01-01" };

interface ScoreOptions {
  matches: Array<Record<string, unknown>>;
  mine?: Record<string, Record<string, unknown>>;
  authenticated?: boolean;
  lang?: "en" | "es";
  hash?: string;
  /** The editorial list the page's preselection reads (omitted: the two modules are not loaded at all, as when they fail to arrive). */
  entries?: Array<Record<string, unknown>>;
  /** What the public matches list answers on its n-th request (1 = the first load, 2 = the redraw after an identity change, ...). `undefined` is the good list of `matches`. A promise delays the answer. */
  list?: (request: number) => ListAnswer | undefined | Promise<ListAnswer | undefined>;
  /** What the helper waits for before it returns (default: the history section is drawn). */
  ready?: (doc: Document) => boolean;
  /** Runs once the two modules are loaded and before the page's own script: to make the data or the module malformed. */
  afterModules?: (window: Record<string, any>) => void;
  /** What the person's own route answers for a match on its n-th request (1 = the first time the page asks): `undefined` is the good `mine` of the match. */
  mineAnswer?: (matchId: string, request: number) => ListAnswer | undefined;
  /** The browser's scrollIntoView throws from the start (and `breakScroll()` makes it throw later): a redrawing that fails AFTER the preselection started. */
  scrollThrows?: boolean;
}

/** One answer of the matches list: the whole response is described, so an error status, a body without the list or a body that is not JSON can be sent. */
type ListAnswer = "reject" | { status?: number; ok?: boolean; body?: unknown; jsonThrows?: boolean };

const clone = (value: unknown) => (value === undefined ? undefined : JSON.parse(JSON.stringify(value)));
type Who = { status: "unauthenticated" } | { status: "authenticated"; email: string; gamingMemberId: string; displayName: string };
const MEMBER: Who = { status: "authenticated", email: "m@example.com", gamingMemberId: "member-1", displayName: "Member" };
const OTHER_MEMBER: Who = { status: "authenticated", email: "o@example.com", gamingMemberId: "member-2", displayName: "Other" };

async function loadScore(opts: ScoreOptions) {
  const calls: string[] = [];
  const scrolled: string[] = [];
  let scrollBroken = opts.scrollThrows === true;
  const errors: unknown[][] = []; // what the page sent to console.error
  const intervals = new Map<unknown, number>(); // setInterval handles alive, with their period
  const subscriptions = new Set<Function>(); // UrbanoI18n.onChange callbacks alive
  let matchRequests = 0;
  const mineRequests: Record<string, number> = {};
  const respond = (answer: Exclude<ListAnswer, "reject">) => ({
    ...(answer.ok === undefined ? {} : { ok: answer.ok }),
    status: "status" in answer ? answer.status : 200,
    json: async () => { if (answer.jsonThrows) throw new SyntaxError("Unexpected token < in JSON"); return clone(answer.body); },
  });
  const auth = { who: (opts.authenticated === false ? { status: "unauthenticated" } : MEMBER) as Who, callbacks: [] as Array<(state: unknown) => unknown>, resets: [] as Array<() => unknown> };
  const dom = new JSDOM(HTML, {
    url: `http://localhost/soccer-predictions.html${opts.hash ?? ""}`,
    runScripts: "dangerously",
    pretendToBeVisual: true,
    beforeParse(window) {
      const w = window as unknown as Record<string, any>;
      window.localStorage.setItem("urbano.lang", opts.lang ?? "es");
      window.eval(I18N_SOURCE);
      // Counting stubs: what the preselection starts (a 60 s interval and a language subscription) must be stopped whenever it is replaced.
      const realSet = window.setInterval.bind(window), realClear = window.clearInterval.bind(window);
      w.setInterval = (fn: TimerHandler, ms?: number, ...args: unknown[]) => { const id = realSet(fn, ms, ...args); intervals.set(id, ms ?? 0); return id; };
      w.clearInterval = (id: number) => { intervals.delete(id); realClear(id); };
      const realOnChange = w.UrbanoI18n.onChange;
      w.UrbanoI18n.onChange = (callback: Function) => { const off = realOnChange(callback); subscriptions.add(callback); return () => { subscriptions.delete(callback); off(); }; };
      w.console.error = (...args: unknown[]) => { errors.push(args); };
      if (opts.entries) {
        window.eval(CRESTS_SOURCE);
        window.eval(UPCOMING_DATA_SOURCE);
        w.UrbanoUpcomingData = { lastVerified: "test", matches: opts.entries };
        window.eval(UPCOMING_SOURCE);
      }
      if (opts.afterModules) opts.afterModules(w);
      (window as any).HTMLElement.prototype.scrollIntoView = function (this: HTMLElement) {
        if (scrollBroken) throw new Error("scrollIntoView failed");
        scrolled.push(this.id);
      };
      w.UrbanoAuth = {
        attachSignInButton: () => {},
        getState: async () => (auth.who.status === "authenticated" ? { status: "authenticated", email: "m@example.com", gamingMemberId: (auth.who as any).gamingMemberId, displayName: (auth.who as any).displayName } : { status: "unauthenticated" }),
        openSignIn: () => true,
        consumeIntent: () => null,
        getAccessToken: async () => "stub-token",
        onAuthStateChange: async () => () => {},
        // the shared account module tells the page that who is signed in changed: the page redraws itself (see "Account entry" above)
        onIdentityChange: async (callback: (state: unknown) => unknown) => { auth.callbacks.push(callback); return () => {}; },
        onIdentityReset: async (callback: () => unknown) => { auth.resets.push(callback); return () => {}; },
      };
      w.fetch = async (url: string) => {
        calls.push(String(url));
        const u = String(url);
        let body: unknown = { error: "unexpected" };
        if (u === `${API}/matches`) {
          matchRequests += 1;
          const answer = opts.list ? await opts.list(matchRequests) : undefined;
          if (answer === "reject") throw new TypeError("fetch failed");
          if (answer) return respond(answer);
          body = { matches: opts.matches };
        } else {
          const m = u.match(/\/matches\/([^/]+)\/mine$/);
          if (m) {
            mineRequests[m[1]] = (mineRequests[m[1]] ?? 0) + 1;
            const answer = opts.mineAnswer?.(m[1], mineRequests[m[1]]);
            if (answer === "reject") throw new TypeError("fetch failed");
            if (answer) return respond(answer);
            body = opts.mine?.[m[1]] ?? {};
          }
        }
        return { status: 200, json: async () => JSON.parse(JSON.stringify(body)) };
      };
    },
  });
  const win = dom.window as unknown as Window & Record<string, any>;
  const doc = win.document;
  const deadline = Date.now() + 3000;
  const ready = opts.ready ?? ((d: Document) => !!d.getElementById("historial"));
  while (!ready(doc)) {
    await new Promise((r) => setTimeout(r, 0));
    if (Date.now() > deadline) throw new Error("page did not render");
  }
  const flush = () => new Promise((r) => setTimeout(r, 20));
  await flush();
  const text = (node: Element | null) => (node?.textContent ?? "").replace(/\s+/g, " ").trim();
  /** Who is signed in changes (a different person, or the same one coming back): the account module calls the page, which redraws itself. Resolves when the redraw is over. */
  const changeTo = async (who: Who) => {
    auth.who = who;
    await Promise.all(auth.callbacks.map((callback) => callback({ status: who.status })));
    await flush();
  };
  /** The account module resets the page (who is signed in changed): the page empties itself while the new list is waited for. */
  const reset = async () => { await Promise.all(auth.resets.map((callback) => callback())); };
  /** The preselection's own footprint: its 60 s redraw timer and its subscription to the language. */
  const running = () => ({
    intervals: [...intervals.values()].filter((ms) => ms === 60_000).length,
    subscriptions: [...subscriptions].filter((callback) => /paint\(true\)/.test(String(callback))).length,
  });
  const content = () => doc.getElementById("content")!;
  return {
    win, doc, calls, scrolled, errors, flush, text, changeTo, reset, running, content, auth, requests: () => matchRequests, mineRequestsOf: (id: string) => mineRequests[id] ?? 0, breakScroll: () => { scrollBroken = true; },
    lineup: () => doc.getElementById("cartelera")!, history: () => doc.getElementById("historial")!, close: () => dom.window.close(),
  };
}

const CLASICO = buildMatch({
  matchId: "clasico", competition: "LaLiga", kickoffAt: "2026-10-25T20:00:00.000Z",
  homeTeam: { teamId: "t-fcb", name: "FC Barcelona", players: [{ playerId: "p1", name: "Ana Díaz" }] },
  awayTeam: { teamId: "t-rm", name: "Real Madrid CF", players: [{ playerId: "p3", name: "Cleo Park" }] },
  finalResult: { homeScore: 1, awayScore: 2 },
});
const MINE_CLASICO = { prediction: PREDICTION, evaluation: EVALUATION, qualification: qualification() };
const FUTURE_OPEN = buildMatch({ matchId: "open1", finalized: false, finalResult: null, kickoffAt: "2099-01-01T00:00:00.000Z" });
const CLOSED_NOT_FINAL = buildMatch({ matchId: "closed1", finalized: false, finalResult: null, kickoffAt: "2020-01-01T20:00:00.000Z" });

describe("I. Lineup and history", () => {
  it("the access to participations and prizes is static markup under the heading, before the list of matches and before any script or request", () => {
    expect(HTML).toMatch(/<nav class="score-access"[^>]*>\s*<a class="score-access-link" id="score-access-history" href="#historial" data-i18n="pred\.access\.history">Mis participaciones y premios<\/a>/);
    expect(HTML.indexOf('id="score-access-history"')).toBeGreaterThan(HTML.indexOf('id="score-title"'));
    expect(HTML.indexOf('id="score-access-history"')).toBeLessThan(HTML.indexOf('id="content"'));
  });

  it("a finished match appears ONLY in the history; the lineup says nothing is open and the history holds the card", async () => {
    const page = await loadScore({ matches: [CLASICO], mine: { clasico: MINE_CLASICO } });
    expect(page.lineup().querySelector(".card")).toBeNull();
    expect(page.text(page.lineup().querySelector(".empty-state"))).toBe("Todavía no hay partidos abiertos para predicciones — volvé pronto.");
    expect(page.history().querySelectorAll(".card")).toHaveLength(1);
    expect(page.history().querySelector('[data-match-id="clasico"]')).not.toBeNull();
    expect(page.doc.querySelectorAll('[data-match-id="clasico"]')).toHaveLength(1); // nowhere else on the page
    expect(page.doc.querySelectorAll("#content .card")).toHaveLength(1);
    expect(page.lineup().compareDocumentPosition(page.history()) & page.win.Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy(); // lineup first, history second
    expect(page.text(page.doc.getElementById("historial-title"))).toBe("Historial");
    expect(page.text(page.doc.getElementById("cartelera-title"))).toBe("Cartelera");
    page.close();
  });

  it("the Clásico card keeps its result, the person's participation and the prize line, unchanged, inside the history (English wording)", async () => {
    const page = await loadScore({ matches: [CLASICO], mine: { clasico: MINE_CLASICO }, lang: "en" });
    const card = page.history().querySelector('[data-match-id="clasico"]')!;
    expect(page.text(card.querySelector(".status-pill"))).toBe("Result: 1–2");
    expect(page.text(card)).toContain("2 of 4 correct.");
    expect(page.text(card)).toContain("Prize qualified: Free pitcher — not yet redeemed — see an URBANO host.");
    expect(page.text(card.querySelector(".match-teams"))).toContain("FC Barcelona");
    expect(page.text(card.querySelector(".match-teams"))).toContain("Real Madrid CF");
    page.close();
  });

  it("signed out, the finished match is still in the history with its result and the way to log in and consult", async () => {
    const page = await loadScore({ matches: [CLASICO], authenticated: false });
    const card = page.history().querySelector('[data-match-id="clasico"]')!;
    expect(page.text(card.querySelector(".status-pill"))).toBe("Resultado: 1–2");
    expect(page.text(card)).toContain("Iniciá sesión para consultar tus resultados en este partido.");
    expect(card.querySelector("[data-login-cta]")).not.toBeNull();
    expect(page.calls.filter((c) => c.endsWith("/mine"))).toEqual([]); // nothing of anyone's own is requested without a session
    page.close();
  });

  it("an open match and a closed one still waiting for its result are in the lineup, not in the history; a cancelled one is nowhere", async () => {
    const cancelled = buildMatch({ matchId: "gone", finalized: false, finalResult: null, kickoffAt: "2099-02-01T00:00:00.000Z", cancelledAt: "2026-10-30T00:00:00.000Z" });
    const page = await loadScore({ matches: [FUTURE_OPEN, CLOSED_NOT_FINAL, CLASICO, cancelled], mine: { clasico: MINE_CLASICO }, authenticated: false });
    expect([...page.lineup().querySelectorAll(".card")].map((c) => c.getAttribute("data-match-id"))).toEqual(["open1", "closed1"]);
    expect([...page.history().querySelectorAll(".card")].map((c) => c.getAttribute("data-match-id"))).toEqual(["clasico"]);
    expect(page.doc.querySelector('[data-match-id="gone"]')).toBeNull();
    expect(page.lineup().querySelector(".empty-state")).toBeNull();
    page.close();
  });

  it("both parts exist when there are no matches at all, each with its own honest empty message (the access always has somewhere to go)", async () => {
    const page = await loadScore({ matches: [] });
    expect(page.doc.getElementById("cartelera")).not.toBeNull();
    expect(page.doc.getElementById("historial")).not.toBeNull();
    expect(page.text(page.lineup().querySelector(".empty-state"))).toBe("Todavía no hay partidos abiertos para predicciones — volvé pronto.");
    expect(page.text(page.history().querySelector(".empty-state"))).toBe("Todavía no hay partidos finalizados.");
    expect(page.doc.getElementById("score-access-history")!.getAttribute("href")).toBe("#historial");
    page.close();
  });

  it("the history heading and the lineup heading can take focus (the access moves a keyboard or screen-reader user to it)", async () => {
    const page = await loadScore({ matches: [] });
    expect(page.doc.getElementById("historial-title")!.getAttribute("tabindex")).toBe("-1");
    expect(page.doc.getElementById("cartelera-title")!.getAttribute("tabindex")).toBe("-1");
    expect(page.doc.getElementById("historial")!.getAttribute("aria-labelledby")).toBe("historial-title");
    page.close();
  });

  it("arriving on #historial (from Home) takes the person to the history once the list is drawn, and a redrawing (a sign-in) takes them there AGAIN until they move the page themselves (section K)", async () => {
    const page = await loadScore({ matches: [CLASICO], mine: { clasico: MINE_CLASICO }, hash: "#historial" });
    expect(page.scrolled).toEqual(["historial"]);
    expect(page.doc.activeElement?.id).toBe("historial-title");
    await page.changeTo(OTHER_MEMBER); // another person signs in: the sections are rebuilt, and the history is where the person was heading
    expect(page.scrolled).toEqual(["historial", "historial"]);
    expect(page.doc.activeElement?.id).toBe("historial-title");
    page.close();
    const plain = await loadScore({ matches: [CLASICO], mine: { clasico: MINE_CLASICO } });
    expect(plain.scrolled).toEqual([]); // no fragment: the page does not scroll by itself
    await plain.changeTo(OTHER_MEMBER);
    expect(plain.scrolled).toEqual([]); // ... nor after a redrawing
    plain.close();
  });

  it("the preselection is hidden when the two modules are not there (the page is the same without them)", async () => {
    const page = await loadScore({ matches: [CLASICO], mine: { clasico: MINE_CLASICO } });
    expect(page.doc.getElementById("lineup-upcoming")!.hidden).toBe(true);
    expect(page.doc.querySelectorAll("#score-upcoming li")).toHaveLength(0);
    page.close();
  });

  it("the preselection lists the announced matches in the lineup, with the hour or 'Horario por confirmar', each 'Preselección' (it never says a match is NOT open), and never as a card", async () => {
    const entries = [
      { ...SRC, id: "E1", kickoffAt: inHours(30), home: "Valencia", away: "Real Madrid", competition: "LaLiga" },
      { id: "E2", date: new Date(Date.now() + 72 * HOUR - 6 * HOUR).toISOString().slice(0, 10), home: "Motagua", away: "Olimpia", competition: "Liga Nacional" },
    ];
    const page = await loadScore({ matches: [CLASICO], mine: { clasico: MINE_CLASICO }, entries });
    const block = page.doc.getElementById("lineup-upcoming")!;
    expect(block.hidden).toBe(false);
    expect(block.closest("#cartelera")).not.toBeNull();
    expect(page.doc.getElementById("historial")!.contains(block)).toBe(false);
    const rows = [...page.doc.querySelectorAll("#score-upcoming li.upcoming-item")];
    expect(rows.map((r) => r.getAttribute("data-match"))).toEqual(["E1", "E2"]);
    expect(rows.map((r) => page.text(r.querySelector(".upcoming-chip")))).toEqual(["Preselección", "Preselección"]);
    expect(rows.map((r) => page.text(r.querySelector(".upcoming-vs")))).toEqual(["vs", "vs"]);
    expect(page.text(page.content())).not.toMatch(/Aún no abierto|Not open yet/);
    expect(rows[0].getAttribute("data-time")).toBe("set");
    expect(rows[1].getAttribute("data-time")).toBe("tbc");
    expect(page.text(rows[1].querySelector("time"))).toMatch(/Horario por confirmar$/);
    expect(page.text(block)).toContain("Por ahora no están abiertos para participar. Fechas y horarios informativos: pueden cambiar. Hora de Honduras.");
    expect(page.doc.getElementById("score-upcoming")!.getAttribute("role")).toBe("list");
    expect(page.doc.querySelectorAll("#cartelera .card")).toHaveLength(0);
    page.close();
  });

  it("a match the SERVER has open is a card of the lineup and is NOT repeated in the preselection (only announced matches are listed there)", async () => {
    const kick = inHours(30);
    const openServer = buildMatch({ matchId: "srv", finalized: false, finalResult: null, kickoffAt: kick, homeTeam: { teamId: "a", name: "Valencia", players: [] }, awayTeam: { teamId: "b", name: "Real Madrid", players: [] },
      predictionContract: "PROGRESSIVE_LADDER_V1", venueActivations: [{ venueActivationId: "a1", enabled: true, venue: { venueId: "v1", name: "Beer Box", latitude: 0, longitude: 0, radiusMeters: 100, active: true }, prizeTiers: [], offer: { available: true, maxLevel: 2, levels: [], digest: "x", problem: null } }] });
    const entries = [
      { ...SRC, id: "E1", kickoffAt: kick, home: "Valencia", away: "Real Madrid", competition: "LaLiga" },
      { ...SRC, id: "E3", kickoffAt: inHours(60), home: "Liverpool", away: "Manchester United", competition: "Premier League" },
    ];
    const page = await loadScore({ matches: [openServer], authenticated: false, entries });
    expect(page.lineup().querySelector('[data-match-id="srv"]')).not.toBeNull();
    expect([...page.doc.querySelectorAll("#score-upcoming li.upcoming-item")].map((r) => r.getAttribute("data-match"))).toEqual(["E3"]);
    page.close();
  });

  it("a listed match that has already started and that the server does not have is NOT in the preselection: «Cerrado» is a state of a card, never of an announcement", async () => {
    const entries = [
      { ...SRC, id: "STARTED", kickoffAt: inHours(-1), home: "Valencia", away: "Real Madrid", competition: "LaLiga" }, // started an hour ago: the list would still keep it for two more hours
      { ...SRC, id: "E3", kickoffAt: inHours(60), home: "Liverpool", away: "Manchester United", competition: "Premier League" },
    ];
    const page = await loadScore({ matches: [CLASICO], mine: { clasico: MINE_CLASICO }, entries });
    expect([...page.doc.querySelectorAll("#score-upcoming li.upcoming-item")].map((r) => r.getAttribute("data-match"))).toEqual(["E3"]);
    expect(page.text(page.doc.getElementById("score-upcoming"))).not.toMatch(/Cerrado|Closed/);
    page.close();
  });

  it("the page reads the public matches list once: the preselection is handed what the page already has and makes no request of its own", async () => {
    const entries = [{ ...SRC, id: "E1", kickoffAt: inHours(30), home: "Valencia", away: "Real Madrid", competition: "LaLiga" }];
    const page = await loadScore({ matches: [CLASICO], mine: { clasico: MINE_CLASICO }, entries });
    expect(page.calls.filter((c) => c === `${API}/matches`)).toHaveLength(1);
    page.close();
  });

  it("with every announced match gone the preselection hides itself again instead of showing an empty box", async () => {
    const entries = [{ ...SRC, id: "OLD", kickoffAt: inHours(-30), home: "Valencia", away: "Real Madrid", competition: "LaLiga" }];
    const page = await loadScore({ matches: [CLASICO], mine: { clasico: MINE_CLASICO }, entries });
    expect(page.doc.getElementById("lineup-upcoming")!.hidden).toBe(true);
    page.close();
  });

  it("the words follow the language: English headings (Fixtures, History), access, intro, the shortlist title and note, its chips, and the note about the crests", async () => {
    const entries = [{ id: "E2", date: new Date(Date.now() + 72 * HOUR - 6 * HOUR).toISOString().slice(0, 10), home: "Motagua", away: "Olimpia", competition: "Liga Nacional" }];
    const page = await loadScore({ matches: [CLASICO], mine: { clasico: MINE_CLASICO }, lang: "en", entries });
    expect(page.text(page.doc.getElementById("score-access-history"))).toBe("My participations and prizes");
    expect(page.text(page.doc.getElementById("cartelera-title"))).toBe("Fixtures");
    expect(page.text(page.doc.getElementById("historial-title"))).toBe("History");
    expect(page.text(page.history().querySelector(".score-section-intro"))).toBe("Finished matches, with your participation and your prizes.");
    expect(page.text(page.doc.querySelector("#lineup-upcoming h3"))).toBe("Upcoming matches (shortlist)");
    expect(page.text(page.doc.querySelector("#lineup-upcoming .score-section-intro"))).toBe("They are not open for participation for now. Dates and times are informational and may change. Honduras time.");
    expect(page.text(page.doc.querySelector("#score-upcoming .upcoming-chip"))).toBe("Shortlisted");
    expect(page.text(page.doc.querySelector("#score-upcoming .upcoming-vs"))).toBe("vs");
    expect(page.text(page.doc.querySelector("#score-upcoming time"))).toMatch(/Time to be confirmed$/);
    expect(page.text(page.content())).not.toMatch(/Not open yet|Aún no abierto|Lineup/); // (the page's script text is not what a person reads: only #content is looked at)
    expect(page.text(page.doc.querySelector(".score-crests-note"))).toBe("Crests only identify the teams. URBANO is not affiliated with, sponsored by or endorsed by these clubs or by the leagues and competitions named here.");
    page.close();
  });

  it("a hostile team name in the history never reaches an HTML parser", async () => {
    const hostile = buildMatch({ matchId: "evil", homeTeam: { teamId: "x", name: HOSTILE, players: [] }, awayTeam: { teamId: "y", name: "Beta FC", players: [] } });
    const page = await loadScore({ matches: [hostile], mine: { evil: { prediction: PREDICTION, evaluation: EVALUATION, qualification: null } } });
    expect(page.history().querySelector("img[onerror]")).toBeNull();
    expect((page.win as any).__xss).toBeUndefined();
    page.close();
  });
});

// ---------------------------------------------------------------------------------------------------------------------------------
// J. A list that cannot be READ is a load failure, never "no matches". The person looking for their prize must not be told that nothing is
//    finished (or that nothing is open) because the server failed: the usual error is shown, and nothing is drawn from an unread list.
// ---------------------------------------------------------------------------------------------------------------------------------

const LOAD_ERROR = "No pudimos cargar los partidos. Intentá de nuevo.";
const REFRESH_ERROR = "No pudimos actualizar los partidos. Intentá de nuevo.";
const HISTORY_ERROR = "No pudimos cargar tu historial de participaciones y premios. Intentá de nuevo.";
const MINE_ERROR = "No pudimos cargar tu participación en este partido. Intentá de nuevo.";
const loadMessage = (page: { doc: Document; text: (n: Element | null) => string }) => page.text(page.doc.querySelector("#cartelera .load-error .msg"));
const errorShown = (doc: Document) => /No pudimos/.test(doc.getElementById("content")?.textContent ?? "");
const hnDate = (hours: number) => new Date(Date.now() + hours * HOUR - 6 * HOUR).toISOString().slice(0, 10); // the Honduras calendar date `hours` from now
const PRESELECTION = [{ ...SRC, id: "E1", kickoffAt: inHours(30), home: "Valencia", away: "Real Madrid", competition: "LaLiga" }];
const MINE_BY_MATCH = { clasico: MINE_CLASICO };

const UNREADABLE: Array<[string, ListAnswer]> = [
  ["HTTP 500 {error}", { status: 500, ok: false, body: { error: "x" } }],
  ["HTTP 500 {error} from a response that carries no ok flag (the status decides)", { status: 500, body: { error: "x" } }],
  ["HTTP 429", { status: 429, body: { error: "Too many requests" } }],
  ["HTTP 503 whose body happens to carry a list", { status: 503, ok: false, body: { matches: [] } }],
  ["200 {matches:null}", { status: 200, body: { matches: null } }],
  ["200 {matches:'x'} (not an array)", { status: 200, body: { matches: "x" } }],
  ["200 {}", { status: 200, body: {} }],
  ["200 with no body", { status: 200, body: null }],
  ["200 that is not JSON", { status: 200, jsonThrows: true }],
  ["the request itself fails", "reject"],
];

/** What must be true of the page whenever the list could not be read (first load, or the redraw after an identity change): the two parts the list
 *  has, each as a RECOVERABLE error (its message and its own «Reintentar»), so the access under the heading still has somewhere to go — and nothing
 *  drawn from an unread list, and nothing that says the history is empty. */
function expectLoadError(page: Awaited<ReturnType<typeof loadScore>>, message: string, label: string) {
  expect([...page.content().children].map((node) => node.id), label).toEqual(["cartelera", "historial"]); // the error shells of the two parts, nothing else
  expect(page.text(page.doc.querySelector("#cartelera .load-error .msg")), label).toBe(message);
  expect(page.text(page.doc.querySelector("#historial .load-error .msg")), label).toBe(HISTORY_ERROR);
  expect(page.doc.querySelector("#cartelera .load-error")!.getAttribute("role"), `${label}: announced once, by the first part`).toBe("alert");
  expect(page.doc.querySelector("#historial .load-error")!.getAttribute("role"), label).toBeNull();
  for (const id of ["cartelera", "historial"]) {
    const retry = page.doc.querySelectorAll(`#${id} [data-retry]`);
    expect(retry, `${label}: #${id} has its own way to try again`).toHaveLength(1);
    expect(page.text(retry[0]!), label).toBe("Reintentar");
    expect((retry[0] as HTMLButtonElement).disabled, label).toBe(false);
    expect(page.text(page.doc.getElementById(`${id}-title`)), label).toBe(id === "cartelera" ? "Cartelera" : "Historial");
  }
  for (const id of ["lineup-upcoming", "score-upcoming"]) expect(page.doc.getElementById(id), `${label}: #${id}`).toBeNull();
  expect(page.doc.querySelector(".card, .upcoming-item, .score-crests-note, [data-match-id], [data-login-cta], .empty-state"), label).toBeNull();
  expect(page.text(page.content()), label).not.toMatch(/Todavía no hay partidos|Cargando|Actualizando|no ten[ée]s|no existe|sin participaciones/i); // neither «no open matches» nor «no finished matches» nor «you have none»
  expect(page.running(), `${label}: nothing of the preselection is left running`).toEqual({ intervals: 0, subscriptions: 0 });
}

describe("J. A list that cannot be read is a load failure, never «no matches»", () => {
  for (const [label, answer] of UNREADABLE) {
    for (const withModules of [true, false]) {
      it(`first load, ${label}, ${withModules ? "with" : "without"} the preselection modules: a recoverable error in both parts, with «Reintentar»; no empty-history message, no shortlist`, async () => {
        const page = await loadScore({ matches: [CLASICO], mine: MINE_BY_MATCH, ...(withModules ? { entries: PRESELECTION } : {}), list: () => answer, ready: errorShown });
        expectLoadError(page, LOAD_ERROR, label);
        expect(page.requests()).toBe(1);
        expect(page.calls.filter((c) => c.endsWith("/mine")), "nothing of the person's own is asked for on top of a list that was not read").toEqual([]);
        expect(page.errors.length, "the failure is logged for whoever has to find it").toBeGreaterThan(0);
        // the access to the history is still on the page (it is static) and has somewhere to go: the Historial part exists, with the error and the way to try again
        page.doc.getElementById("score-access-history")!.click();
        await page.flush();
        expect(page.scrolled).toEqual([]); // the section exists: the browser's own jump to the fragment takes the person there, the page adds none
        expectLoadError(page, LOAD_ERROR, label);
        page.close();
      });
    }

    it(`after an identity change, a redraw whose list cannot be read (${label}) shows the REFRESH error, recoverable — not the load error, not an empty history — and leaves no timer or subscription of the preselection alive`, async () => {
      const page = await loadScore({ matches: [CLASICO], mine: MINE_BY_MATCH, entries: PRESELECTION, list: (n) => (n === 1 ? undefined : answer) });
      expect(page.history().querySelector('[data-match-id="clasico"]')).not.toBeNull();
      expect(page.running(), "the preselection is running before the change").toEqual({ intervals: 1, subscriptions: 1 });
      await page.changeTo(OTHER_MEMBER);
      expectLoadError(page, REFRESH_ERROR, label);
      expect(page.requests()).toBe(2);
      page.close();
    });
  }

  it("an empty list that WAS read is still «no matches»: both sections, each with its honest empty message (the contrast with an unread one)", async () => {
    const page = await loadScore({ matches: [], list: () => ({ status: 200, body: { matches: [] } }) });
    expect(page.text(page.lineup().querySelector(".empty-state"))).toBe("Todavía no hay partidos abiertos para predicciones — volvé pronto.");
    expect(page.text(page.history().querySelector(".empty-state"))).toBe("Todavía no hay partidos finalizados.");
    expect(page.content().lastElementChild?.className).toBe("score-crests-note");
    page.close();
  });

  it("a response is readable when its ok flag is true or its status is 2xx, whichever the response carries", async () => {
    for (const answer of [{ ok: true, status: undefined, body: { matches: [CLASICO] } }, { status: 200, body: { matches: [CLASICO] } }, { status: 299, body: { matches: [CLASICO] } }] satisfies ListAnswer[]) {
      const page = await loadScore({ matches: [], mine: MINE_BY_MATCH, list: () => answer });
      expect(page.history().querySelector('[data-match-id="clasico"]'), JSON.stringify(answer)).not.toBeNull();
      page.close();
    }
  });
});

// ---------------------------------------------------------------------------------------------------------------------------------
// Recovering from a failure. The person looking for their prize is never told that there is nothing: the page says it could not load, and offers
// to try again — for the whole list, and for the one card whose own participation could not be read.
// ---------------------------------------------------------------------------------------------------------------------------------

describe("N. «Reintentar»: a failed load can be tried again, and nothing says that the history is empty", () => {
  const FAIL_ONCE: ScoreOptions["list"] = (n) => (n === 1 ? { status: 500, body: { error: "x" } } : undefined);
  const retryIn = (page: Awaited<ReturnType<typeof loadScore>>, id: "cartelera" | "historial") => page.doc.querySelector(`#${id} [data-retry]`) as HTMLButtonElement;

  it("«Reintentar» in the Historial asks again: the history appears with the Clásico, its result and its prize, the error is gone, the preselection runs again, and the focus is on the Historial heading", async () => {
    const page = await loadScore({ matches: [CLASICO], mine: MINE_BY_MATCH, entries: PRESELECTION, list: FAIL_ONCE, ready: errorShown });
    expectLoadError(page, LOAD_ERROR, "before");
    expect(page.requests()).toBe(1);
    retryIn(page, "historial").click();
    await page.flush();
    expect(page.requests()).toBe(2);
    expect(page.doc.querySelector(".load-error, [data-retry]")).toBeNull();
    expect(page.text(page.history().querySelector('[data-match-id="clasico"] .status-pill'))).toBe("Resultado: 1–2");
    expect(page.text(page.history().querySelector('[data-match-id="clasico"]'))).toContain("Premio obtenido: Free pitcher");
    expect(page.doc.activeElement?.id).toBe("historial-title");
    expect(page.scrolled, "the person is taken back to the part they were in (the page was redrawn under them)").toEqual(["historial"]);
    expect(page.running()).toEqual({ intervals: 1, subscriptions: 1 });
    page.close();
  });

  it("«Reintentar» in the Cartelera does the same and leaves the focus on the Cartelera heading", async () => {
    const page = await loadScore({ matches: [CLASICO], mine: MINE_BY_MATCH, list: FAIL_ONCE, ready: errorShown });
    retryIn(page, "cartelera").click();
    await page.flush();
    expect(page.doc.querySelector(".load-error")).toBeNull();
    expect(page.doc.activeElement?.id).toBe("cartelera-title");
    expect(page.scrolled).toEqual(["cartelera"]);
    page.close();
  });

  it("if the jump back to the part fails once the page IS drawn, the page stays drawn: the failure is logged, and it is not shown as a load failure", async () => {
    const page = await loadScore({ matches: [CLASICO], mine: MINE_BY_MATCH, list: FAIL_ONCE, scrollThrows: true, ready: errorShown });
    const logged = page.errors.length;
    retryIn(page, "historial").click();
    await page.flush();
    expect(page.doc.querySelector(".load-error")).toBeNull();
    expect(page.history().querySelector('[data-match-id="clasico"]')).not.toBeNull();
    expect(page.errors.length).toBeGreaterThan(logged);
    page.close();
  });

  it("while it is trying, every «Reintentar» is busy (disabled, «Reintentando…»), and a second click makes no second request", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const page = await loadScore({ matches: [CLASICO], mine: MINE_BY_MATCH, list: (n) => (n === 1 ? { status: 500, body: { error: "x" } } : gate.then(() => undefined)), ready: errorShown });
    retryIn(page, "historial").click();
    const buttons = [...page.doc.querySelectorAll("[data-retry]")] as HTMLButtonElement[];
    expect(buttons.map((b) => b.disabled)).toEqual([true, true]);
    expect(buttons.map((b) => page.text(b))).toEqual(["Reintentando…", "Reintentando…"]);
    buttons[0]!.click(); buttons[1]!.click();
    await page.flush();
    expect(page.requests(), "one request for the retry, whatever the clicks").toBe(2);
    release();
    await page.flush();
    expect(page.requests()).toBe(2);
    expect(page.history().querySelector('[data-match-id="clasico"]')).not.toBeNull();
    page.close();
  });

  it("a retry that fails again shows the error again, with «Reintentar» enabled and focused, logs it, and leaves nothing running; the next retry can still succeed", async () => {
    const page = await loadScore({ matches: [CLASICO], mine: MINE_BY_MATCH, entries: PRESELECTION, list: (n) => (n === 1 || n === 2 ? (n === 1 ? { status: 500, body: { error: "x" } } : "reject") : undefined), ready: errorShown });
    const logged = page.errors.length;
    retryIn(page, "historial").click();
    await page.flush();
    expect(page.requests()).toBe(2);
    expectLoadError(page, LOAD_ERROR, "after a failed retry");
    expect(page.doc.activeElement?.hasAttribute("data-retry")).toBe(true);
    expect(page.errors.length).toBeGreaterThan(logged);
    retryIn(page, "historial").click();
    await page.flush();
    expect(page.requests()).toBe(3);
    expect(page.doc.querySelector(".load-error")).toBeNull();
    expect(page.history().querySelector('[data-match-id="clasico"]')).not.toBeNull();
    page.close();
  });

  it("the error after an identity change is recoverable too: «Reintentar» redraws the page for the person who is signed in now", async () => {
    const page = await loadScore({ matches: [CLASICO], mine: MINE_BY_MATCH, list: (n) => (n === 2 ? "reject" : undefined) });
    await page.changeTo(OTHER_MEMBER);
    expectLoadError(page, REFRESH_ERROR, "refresh");
    retryIn(page, "historial").click();
    await page.flush();
    expect(page.requests()).toBe(3);
    expect(page.history().querySelector('[data-match-id="clasico"]')).not.toBeNull();
    expect(page.doc.querySelector(".load-error")).toBeNull();
    page.close();
  });

  const UNREADABLE_MINE: Array<[string, ListAnswer]> = [
    ["HTTP 500 {error}", { status: 500, body: { error: "x" } }],
    ["HTTP 401 {error}", { status: 401, body: { error: "Unauthorized" } }],
    ["HTTP 503", { status: 503, body: { error: "later" } }],
    ["200 with no body", { status: 200, body: null }],
    ["200 that is not JSON", { status: 200, jsonThrows: true }],
  ];
  for (const [label, answer] of UNREADABLE_MINE) {
    it(`the person's own participation in a FINISHED match cannot be read (${label}): the card keeps its result, says it could not load their participation and offers to try again — it never says «No enviaste una predicción» and shows no prize line it cannot know`, async () => {
      const page = await loadScore({ matches: [CLASICO], mine: MINE_BY_MATCH, mineAnswer: (_id, n) => (n === 1 ? answer : undefined) });
      const card = () => page.history().querySelector('[data-match-id="clasico"]')!;
      expect(page.text(card().querySelector(".status-pill"))).toBe("Resultado: 1–2");
      expect(page.text(card().querySelector(".load-error .msg"))).toBe(MINE_ERROR);
      expect(page.text(card())).not.toMatch(/No enviaste|Premio obtenido|correctas|Tu predicción/);
      expect(page.text(card().querySelector("[data-retry]")!)).toBe("Reintentar");
      expect(page.doc.querySelector("#content > .load-error, #cartelera > .load-error, #historial > .load-error"), "the list itself was read: no page-level error").toBeNull();
      (card().querySelector("[data-retry]") as HTMLButtonElement).click();
      await page.flush();
      expect(page.mineRequestsOf("clasico")).toBe(2);
      expect(page.requests()).toBe(2);
      expect(page.doc.querySelector(".load-error")).toBeNull();
      expect(page.text(card())).toContain("2 de 4 correctas");
      expect(page.text(card())).toContain("Premio obtenido: Free pitcher");
      page.close();
    });
  }

  it("the same for a match that has started and is waiting for its result: «No enviaste una predicción» is said only when the answer was read and says there is none", async () => {
    const unread = await loadScore({ matches: [CLOSED_NOT_FINAL], mineAnswer: () => ({ status: 500, body: { error: "x" } }), ready: (d) => !!d.getElementById("cartelera") });
    expect(unread.text(unread.lineup().querySelector(".load-error .msg"))).toBe(MINE_ERROR);
    expect(unread.text(unread.lineup())).not.toMatch(/No enviaste/);
    unread.close();
    const read = await loadScore({ matches: [CLOSED_NOT_FINAL], mine: { closed1: { prediction: null, evaluation: null, qualification: null } }, ready: (d) => !!d.getElementById("cartelera") });
    expect(read.text(read.lineup())).toContain("No enviaste una predicción antes del inicio del partido.");
    expect(read.doc.querySelector(".load-error")).toBeNull();
    read.close();
  });

  it("a person who is not signed in is not asked anything (nothing can fail) and still sees the login prompt on a finished match", async () => {
    const page = await loadScore({ matches: [CLASICO], authenticated: false, mineAnswer: () => ({ status: 500, body: null }) });
    expect(page.calls.filter((c) => c.endsWith("/mine"))).toEqual([]);
    expect(page.history().querySelector("[data-login-cta]")).not.toBeNull();
    expect(page.doc.querySelector(".load-error")).toBeNull();
    page.close();
  });

  it("the request for the person's own participation that itself fails (no answer at all) is a failure of the whole page, and it is recoverable", async () => {
    const page = await loadScore({ matches: [CLASICO], mine: MINE_BY_MATCH, mineAnswer: (_id, n) => (n === 1 ? "reject" : undefined), ready: errorShown });
    expectLoadError(page, LOAD_ERROR, "no answer");
    retryIn(page, "historial").click();
    await page.flush();
    expect(page.text(page.history().querySelector('[data-match-id="clasico"]'))).toContain("Premio obtenido: Free pitcher");
    page.close();
  });

  it("the words are in English too, and a change of language translates the error in place (the buttons stay)", async () => {
    const page = await loadScore({ matches: [CLASICO], mine: MINE_BY_MATCH, lang: "en", list: FAIL_ONCE, ready: (d) => /Couldn't/.test(d.getElementById("content")?.textContent ?? "") });
    expect(page.text(page.doc.querySelector("#cartelera .load-error .msg"))).toBe("Couldn't load the matches. Try again.");
    expect(page.text(page.doc.querySelector("#historial .load-error .msg"))).toBe("Couldn't load your history of participations and prizes. Try again.");
    expect(page.text(retryIn(page, "historial"))).toBe("Try again");
    const button = retryIn(page, "historial");
    page.win.UrbanoI18n.setLang("es");
    expect(page.text(page.doc.querySelector("#historial .load-error .msg"))).toBe(HISTORY_ERROR);
    expect(retryIn(page, "historial")).toBe(button);
    expect(page.text(button)).toBe("Reintentar");
    page.close();
  });
});

// ---------------------------------------------------------------------------------------------------------------------------------
// The preselection is information and fails ALONE: whatever goes wrong inside it, the lineup and the history (the person's prizes) stay drawn.
// ---------------------------------------------------------------------------------------------------------------------------------

describe("The preselection fails alone", () => {
  const PRIZE_ES = "Premio obtenido: Free pitcher — todavía sin canjear — consultá con un anfitrión de URBANO.";
  const expectPageIntact = (page: Awaited<ReturnType<typeof loadScore>>, running = { intervals: 0, subscriptions: 0 }) => {
    expect(page.doc.getElementById("cartelera")).not.toBeNull();
    expect(page.history().querySelector('[data-match-id="clasico"]')).not.toBeNull();
    expect(page.text(page.history().querySelector('[data-match-id="clasico"] .status-pill'))).toBe("Resultado: 1–2");
    expect(page.text(page.history().querySelector('[data-match-id="clasico"]'))).toContain(PRIZE_ES);
    expect(page.doc.getElementById("lineup-upcoming")!.hidden).toBe(true);
    expect(page.doc.querySelectorAll("#score-upcoming li.upcoming-item")).toHaveLength(0); // (the hidden block may hold its «preparing» line; no row)
    expect(page.text(page.content())).not.toMatch(/No pudimos/); // no error state: the failure of the shortlist is not a failure of the page
    expect(page.content().lastElementChild?.className).toBe("score-crests-note");
    expect(page.running()).toEqual(running);
  };

  it("an editorial container that is not a list (matches = {}) lists nothing: the lineup, the history and the prize line are drawn, the block stays hidden, and nothing throws", async () => {
    const page = await loadScore({ matches: [CLASICO], mine: MINE_BY_MATCH, entries: PRESELECTION, afterModules: (w) => { w.UrbanoUpcomingData = { lastVerified: "test", matches: {} }; } });
    expectPageIntact(page, { intervals: 1, subscriptions: 1 }); // the module started normally: it just has nothing to list (and is stopped like any other when the page redraws)
    expect(page.errors).toEqual([]); // tolerated, not an error: there is simply nothing to list
    page.close();
  });

  it("when the module itself throws while starting (a throwing data getter; init throwing), console.error says so and the lineup and the history stay drawn, the block hidden, nothing running", async () => {
    const breakers: Array<[string, (w: Record<string, any>) => void]> = [
      ["the data's matches getter throws", (w) => { Object.defineProperty(w.UrbanoUpcomingData, "matches", { get() { throw new Error("the data is broken"); } }); }],
      ["init throws", (w) => { w.UrbanoHomeUpcoming.init = () => { throw new Error("the list exploded"); }; }],
    ];
    for (const [label, afterModules] of breakers) {
      const page = await loadScore({ matches: [CLASICO], mine: MINE_BY_MATCH, entries: PRESELECTION, afterModules });
      expectPageIntact(page);
      expect(page.errors.some((args) => String(args[0]).includes("the preselection did not start")), `${label}: reported`).toBe(true);
      // and the page is not left broken for what comes next: the redraw after an identity change is drawn the same way
      await page.changeTo(OTHER_MEMBER);
      expectPageIntact(page);
      page.close();
    }
  });

  it("a module that starts but returns no handle (it declined to start) leaves the block hidden and the rest drawn", async () => {
    const page = await loadScore({ matches: [CLASICO], mine: MINE_BY_MATCH, entries: PRESELECTION, afterModules: (w) => { w.UrbanoHomeUpcoming.init = () => null; } });
    expectPageIntact(page);
    page.close();
  });
});

// ---------------------------------------------------------------------------------------------------------------------------------
// Twins. A server match that is, beyond reasonable doubt, the same fixture as an editorial row is already a card in the lineup (or in the
// history): a row that says «Preselección» beside it would contradict the card, so the row is left out. The strict tie (exact instant AND both
// clubs) is unchanged and is what the Home card uses; the Score page only HIDES.
// ---------------------------------------------------------------------------------------------------------------------------------

describe("Twins: the server's own card replaces the row of the same fixture", () => {
  const OFFER = { available: true, maxLevel: 2, levels: [], digest: "x", problem: null };
  const serverMatch = (over: Record<string, unknown>) => buildMatch({
    matchId: "srv", finalized: false, finalResult: null, predictionContract: "PROGRESSIVE_LADDER_V1", kickoffAt: inHours(30),
    homeTeam: { teamId: "a", name: "Valencia", players: [] }, awayTeam: { teamId: "b", name: "Real Madrid", players: [] },
    venueActivations: [{ venueActivationId: "a1", enabled: true, venue: { venueId: "v1", name: "Beer Box", latitude: 0, longitude: 0, radiusMeters: 100, active: true }, prizeTiers: [], offer: OFFER }],
    ...over,
  });
  const team = (name: string) => ({ teamId: `t-${name}`, name, players: [] });
  const cards = (page: Awaited<ReturnType<typeof loadScore>>) => [...page.lineup().querySelectorAll(".card")].map((c) => c.getAttribute("data-match-id"));
  const rows = (page: Awaited<ReturnType<typeof loadScore>>) => [...page.doc.querySelectorAll("#score-upcoming li.upcoming-item")].map((r) => r.getAttribute("data-match"));
  // in this order of start, whatever the time of day: E1 (+30 h), E2 (+54 h), E3 (00:00 Honduras of a date 76–100 h from now), E4 (+130 h)
  const KICK_1 = inHours(30), KICK_2 = inHours(54), KICK_4 = inHours(130), DATE_3 = hnDate(100);
  const entries = () => [
    { ...SRC, id: "E1", kickoffAt: KICK_1, home: "Valencia", away: "Real Madrid", competition: "LaLiga" },
    { ...SRC, id: "E2", kickoffAt: KICK_2, home: "Atlético de Madrid", away: "FC Barcelona", competition: "LaLiga" },
    { id: "E3", date: DATE_3, home: "Motagua", away: "Olimpia", competition: "Liga Nacional" },
    { ...SRC, id: "E4", kickoffAt: KICK_4, home: "Liverpool", away: "Manchester United", competition: "Premier League" },
  ];
  const run = (matches: Array<Record<string, unknown>>) => loadScore({ matches, authenticated: false, entries: entries() });

  it("with no server match at all every row of the editorial list is listed, in order of start", async () => {
    const page = await run([]);
    expect(rows(page)).toEqual(["E1", "E2", "E3", "E4"]);
    page.close();
  });

  it("the announced fixture under another spelling ('Valencia CF' v 'Real Madrid CF', at the editorial instant) is a card in the lineup, and its row is NOT in the preselection", async () => {
    const page = await run([serverMatch({ homeTeam: team("Valencia CF"), awayTeam: team("Real Madrid CF"), kickoffAt: KICK_1 })]);
    expect(cards(page)).toEqual(["srv"]);
    expect(rows(page)).toEqual(["E2", "E3", "E4"]);
    page.close();
  });

  it("'Atlético Madrid' v 'FC Barcelona' at the editorial instant: the same fixture under another spelling of the home team", async () => {
    const page = await run([serverMatch({ matchId: "atm", homeTeam: team("Atlético Madrid"), awayTeam: team("FC Barcelona"), kickoffAt: KICK_2 })]);
    expect(cards(page)).toEqual(["atm"]);
    expect(rows(page)).toEqual(["E1", "E3", "E4"]);
    page.close();
  });

  it("the same two clubs (home first) on ANOTHER day also hide the row: the server already lists that fixture", async () => {
    const page = await run([serverMatch({ matchId: "moved", kickoffAt: inHours(31 + 24) })]);
    expect(cards(page)).toEqual(["moved"]);
    expect(rows(page)).toEqual(["E2", "E3", "E4"]);
    page.close();
  });

  it("an entry with only a date is hidden when the server already has a match on that Honduras date with one of its clubs; on another date, or with no club in common, the row stays", async () => {
    const onThatDate = Date.parse(`${DATE_3}T06:00:00Z`) + 14 * HOUR; // 2:00 p. m. in Honduras on DATE_3
    const same = await run([serverMatch({ matchId: "d1", homeTeam: team("Motagua"), awayTeam: team("Real España"), kickoffAt: new Date(onThatDate).toISOString() })]);
    expect(cards(same)).toEqual(["d1"]);
    expect(rows(same)).toEqual(["E1", "E2", "E4"]);
    same.close();
    const nextDay = await run([serverMatch({ matchId: "d2", homeTeam: team("Motagua"), awayTeam: team("Real España"), kickoffAt: new Date(onThatDate + 24 * HOUR).toISOString() })]);
    expect(rows(nextDay)).toEqual(["E1", "E2", "E3", "E4"]);
    nextDay.close();
    const strangers = await run([serverMatch({ matchId: "d3", homeTeam: team("Alpha FC"), awayTeam: team("Beta FC"), kickoffAt: new Date(onThatDate).toISOString() })]);
    expect(cards(strangers)).toEqual(["d3"]);
    expect(rows(strangers)).toEqual(["E1", "E2", "E3", "E4"]);
    strangers.close();
  });

  it("a server match with nothing in common leaves the row, even at the very same instant: it is another fixture", async () => {
    const page = await run([serverMatch({ matchId: "other", homeTeam: team("Alpha FC"), awayTeam: team("Beta FC"), kickoffAt: KICK_1 })]);
    expect(cards(page)).toEqual(["other"]);
    expect(rows(page)).toEqual(["E1", "E2", "E3", "E4"]);
    page.close();
  });

  it("a CANCELLED server match is no card, and the row of that very fixture LEAVES the preselection: a match the server says is cancelled is not an upcoming one (an entry with a date only leaves too)", async () => {
    const page = await run([serverMatch({ cancelledAt: "2026-10-28T00:00:00.000Z", kickoffAt: KICK_1 }), serverMatch({ matchId: "srv2", cancelledAt: "2026-10-28T00:00:00.000Z", homeTeam: team("Motagua"), awayTeam: team("Olimpia"), kickoffAt: new Date(Date.parse(`${DATE_3}T06:00:00Z`) + 14 * HOUR).toISOString() })]);
    expect(cards(page)).toEqual([]);
    expect(rows(page)).toEqual(["E2", "E4"]);
    expect(page.text(page.doc.getElementById("score-upcoming"))).not.toMatch(/Valencia|Motagua|Cancelad|Cancelled/);
    page.close();
  });

  it("the cancellation reaches the row only when it is the same fixture: the same two clubs, home first, on the same Honduras day (at any hour); another day, one club, or the clubs the other way round leave the row", async () => {
    const cancelled = (over: Record<string, unknown>) => serverMatch({ cancelledAt: "2026-10-28T00:00:00.000Z", ...over });
    const movedSameDay = await run([cancelled({ kickoffAt: new Date(Date.parse(KICK_1) + 2 * HOUR).toISOString() })]); // its hour moved by two hours before it was cancelled
    const sameDay = (ms: number) => new Date(ms).toISOString().slice(0, 10);
    // E1 is +30 h: the +32 h instant is on the same Honduras day unless the day changes in those two hours; compare in Honduras time
    const hnDay = (iso: string) => new Date(Date.parse(iso) - 6 * HOUR).toISOString().slice(0, 10);
    const sameHnDay = hnDay(KICK_1) === hnDay(new Date(Date.parse(KICK_1) + 2 * HOUR).toISOString());
    expect(rows(movedSameDay)).toEqual(sameHnDay ? ["E2", "E3", "E4"] : ["E1", "E2", "E3", "E4"]);
    expect(sameDay(0)).toBe("1970-01-01"); // (the helper only formats)
    movedSameDay.close();
    const anotherDay = await run([cancelled({ kickoffAt: inHours(30 + 24 * 3) })]);
    expect(rows(anotherDay)).toEqual(["E1", "E2", "E3", "E4"]);
    anotherDay.close();
    const oneClub = await run([cancelled({ homeTeam: team("Valencia"), awayTeam: team("Alpha FC"), kickoffAt: KICK_1 })]);
    expect(rows(oneClub)).toEqual(["E1", "E2", "E3", "E4"]);
    oneClub.close();
    const swapped = await run([cancelled({ homeTeam: team("Real Madrid"), awayTeam: team("Valencia"), kickoffAt: KICK_1 })]);
    expect(rows(swapped)).toEqual(["E1", "E2", "E3", "E4"]);
    swapped.close();
  });

  it("a LIVE match of the same pairing on the same day keeps the fixture: the cancelled one is gone, the new one is its card, and the row stays out as a twin (nothing is announced twice)", async () => {
    const page = await run([serverMatch({ matchId: "old", cancelledAt: "2026-10-28T00:00:00.000Z", kickoffAt: KICK_1 }), serverMatch({ matchId: "new", kickoffAt: KICK_1 })]);
    expect(cards(page)).toEqual(["new"]);
    expect(rows(page)).toEqual(["E2", "E3", "E4"]);
    page.close();
  });

  it("when every row is cancelled the shortlist hides itself (no empty box, no «cancelled» label)", async () => {
    const day3 = new Date(Date.parse(`${DATE_3}T06:00:00Z`) + 14 * HOUR).toISOString();
    const gone = [["Valencia", "Real Madrid", KICK_1], ["Atlético de Madrid", "FC Barcelona", KICK_2], ["Motagua", "Olimpia", day3], ["Liverpool", "Manchester United", KICK_4]] as const;
    const page = await run(gone.map(([home, away, at], i) => serverMatch({ matchId: `c${i}`, cancelledAt: "2026-10-28T00:00:00.000Z", homeTeam: team(home), awayTeam: team(away), kickoffAt: at })));
    expect(rows(page)).toEqual([]);
    expect(page.doc.getElementById("lineup-upcoming")!.hidden).toBe(true);
    expect(cards(page)).toEqual([]);
    page.close();
  });

  it("an hour that cannot be traced (no source, or no verification date) is not shown in the preselection: the row keeps its Honduras date with «Horario por confirmar» and is never tied to a server match", async () => {
    const untraceable = [{ id: "U1", kickoffAt: KICK_1, home: "Valencia", away: "Real Madrid", competition: "LaLiga" }, { ...SRC, source: "", id: "U2", kickoffAt: KICK_2, home: "Atlético de Madrid", away: "FC Barcelona", competition: "LaLiga" }];
    const page = await loadScore({ matches: [], authenticated: false, entries: untraceable });
    const items = [...page.doc.querySelectorAll("#score-upcoming li.upcoming-item")];
    expect(items.map((r) => [r.getAttribute("data-match"), r.getAttribute("data-time")])).toEqual([["U1", "tbc"], ["U2", "tbc"]]);
    for (const row of items) {
      expect(page.text(row.querySelector("time"))).toContain("Horario por confirmar");
      expect(page.text(row.querySelector("time"))).not.toMatch(/\d:\d\d/);
    }
    page.close();
  });

  it("a FINISHED server match of the same fixture hides the row too (its result is in the history; the row would announce a match that was played)", async () => {
    const page = await run([serverMatch({ matchId: "played", finalized: true, finalResult: { homeScore: 1, awayScore: 0 }, kickoffAt: KICK_1 })]);
    expect(page.history().querySelector('[data-match-id="played"]')).not.toBeNull();
    expect(rows(page)).toEqual(["E2", "E3", "E4"]);
    page.close();
  });

  it("the block hides itself when every row has a twin (no empty box)", async () => {
    const page = await loadScore({ matches: [serverMatch({ homeTeam: team("Valencia CF"), awayTeam: team("Real Madrid CF"), kickoffAt: KICK_1 })], authenticated: false, entries: [entries()[0]] });
    expect(page.doc.getElementById("lineup-upcoming")!.hidden).toBe(true);
    expect(rows(page)).toEqual([]);
    page.close();
  });
});

// ---------------------------------------------------------------------------------------------------------------------------------
// K. Arriving on a fragment. The sections exist only once the list has been drawn, so the browser's own jump cannot find them: the page makes
//    the jump after EVERY successful drawing, until the person moves the page themselves.
// ---------------------------------------------------------------------------------------------------------------------------------

describe("K. The jump to a section of the page", () => {
  const MOVES: Array<[string, (page: Awaited<ReturnType<typeof loadScore>>) => void]> = [
    ["a wheel scroll (on the window)", (page) => { page.win.dispatchEvent(new page.win.Event("wheel")); }],
    ["a touch (on the window)", (page) => { page.win.dispatchEvent(new page.win.Event("touchstart")); }],
    ["a key press (from the body, bubbling up to the window)", (page) => { page.doc.body.dispatchEvent(new page.win.KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true })); }],
    ["a click on the page (the mouse going down, bubbling up to the window)", (page) => { page.doc.body.dispatchEvent(new page.win.MouseEvent("mousedown", { bubbles: true })); }],
  ];

  it("opened on #historial: the jump happens at the first drawing (scrolled to the section, its heading focused) and AGAIN after each redrawing caused by an identity change", async () => {
    const page = await loadScore({ matches: [CLASICO], mine: MINE_BY_MATCH, hash: "#historial" });
    expect(page.scrolled).toEqual(["historial"]);
    expect(page.doc.activeElement?.id).toBe("historial-title");
    (page.doc.activeElement as HTMLElement).blur();
    await page.changeTo(OTHER_MEMBER);
    expect(page.scrolled).toEqual(["historial", "historial"]);
    expect(page.doc.activeElement?.id, "the new heading takes the focus again").toBe("historial-title");
    await page.changeTo({ status: "unauthenticated" });
    expect(page.scrolled).toEqual(["historial", "historial", "historial"]);
    page.close();
  });

  it("opened on #cartelera: the same jump, to the lineup", async () => {
    const page = await loadScore({ matches: [CLASICO], mine: MINE_BY_MATCH, hash: "#cartelera" });
    expect(page.scrolled).toEqual(["cartelera"]);
    expect(page.doc.activeElement?.id).toBe("cartelera-title");
    await page.changeTo(OTHER_MEMBER);
    expect(page.scrolled).toEqual(["cartelera", "cartelera"]);
    page.close();
  });

  it("any other fragment, or none, is left to the browser: the page makes no jump of its own, before or after a redrawing", async () => {
    for (const hash of ["", "#", "#content", "#score-access-history", "#nothing", "#Historial"]) {
      const page = await loadScore({ matches: [CLASICO], mine: MINE_BY_MATCH, hash });
      await page.changeTo(OTHER_MEMBER);
      expect(page.scrolled, `hash «${hash}»`).toEqual([]);
      page.close();
    }
  });

  for (const [label, move] of MOVES) {
    it(`after ${label} the redrawing no longer pulls the person back to the section`, async () => {
      const page = await loadScore({ matches: [CLASICO], mine: MINE_BY_MATCH, hash: "#historial" });
      expect(page.scrolled).toEqual(["historial"]);
      move(page);
      await page.changeTo(OTHER_MEMBER);
      await page.changeTo({ status: "unauthenticated" });
      expect(page.scrolled).toEqual(["historial"]); // the first drawing only
      page.close();
    });

    it(`and ${label} BEFORE the first drawing (the list is slow) cancels the jump altogether`, async () => {
      let release!: () => void;
      const gate = new Promise<void>((resolve) => { release = resolve; });
      const page = await loadScore({ matches: [CLASICO], mine: MINE_BY_MATCH, hash: "#historial", list: async () => { await gate; return undefined; }, ready: () => true });
      expect(page.text(page.content())).toContain("Cargando");
      move(page);
      release();
      await page.flush();
      expect(page.doc.getElementById("historial")).not.toBeNull();
      expect(page.scrolled).toEqual([]);
      page.close();
    });
  }

  it("with no fragment, choosing «Mis participaciones y premios» BEFORE the list is drawn makes the jump happen when it is drawn (once the person has done so, the redrawings keep it until they move the page)", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const page = await loadScore({ matches: [CLASICO], mine: MINE_BY_MATCH, list: async () => { await gate; return undefined; }, ready: () => true });
    expect(page.doc.getElementById("historial")).toBeNull();
    // a real click is the mouse going down and then the click itself
    page.doc.body.dispatchEvent(new page.win.MouseEvent("mousedown", { bubbles: true }));
    page.doc.getElementById("score-access-history")!.click();
    expect(page.scrolled).toEqual([]); // nothing to scroll to yet
    release();
    await page.flush();
    expect(page.scrolled).toEqual(["historial"]);
    expect(page.doc.activeElement?.id).toBe("historial-title");
    await page.changeTo(OTHER_MEMBER);
    expect(page.scrolled).toEqual(["historial", "historial"]);
    page.close();
  });

  it("choosing it while a redrawing is waiting for its list (the sections do not exist then) also makes the jump happen when the redrawing is drawn", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const page = await loadScore({ matches: [CLASICO], mine: MINE_BY_MATCH, list: (n) => (n === 1 ? undefined : gate.then(() => undefined)) });
    const pending = page.changeTo(OTHER_MEMBER);
    await page.flush();
    expect(page.text(page.content())).toBe("Actualizando…");
    expect(page.doc.getElementById("historial")).toBeNull();
    page.doc.getElementById("score-access-history")!.click();
    release();
    await pending;
    expect(page.scrolled).toEqual(["historial"]);
    page.close();
  });

  it("choosing it when the sections already exist does nothing special: the page makes no jump of its own (the browser handles the fragment), neither then nor on a later redrawing", async () => {
    const page = await loadScore({ matches: [CLASICO], mine: MINE_BY_MATCH });
    expect(page.doc.getElementById("historial")).not.toBeNull();
    page.doc.getElementById("score-access-history")!.click();
    await page.flush();
    expect(page.scrolled).toEqual([]);
    await page.changeTo(OTHER_MEMBER);
    expect(page.scrolled).toEqual([]);
    page.close();
  });

  it("when the list cannot be read the Historial part is still there, as an error with «Reintentar»: opened on #historial the jump goes to it (never to an empty history)", async () => {
    const page = await loadScore({ matches: [], hash: "#historial", list: () => ({ status: 500, body: { error: "x" } }), ready: errorShown });
    expectLoadError(page, LOAD_ERROR, "failed");
    expect(page.scrolled).toEqual(["historial"]);
    expect(page.doc.activeElement?.id).toBe("historial-title");
    page.close();
  });
});

// ---------------------------------------------------------------------------------------------------------------------------------
// L. Nothing of the preselection outlives its drawing: a timer and a language subscription are started with it and must be stopped whenever
//    it is replaced — including when the redrawing that was meant to replace it fails.
// ---------------------------------------------------------------------------------------------------------------------------------

describe("L. The preselection leaves nothing running when it is replaced", () => {
  const withPreselection = (extra: Partial<ScoreOptions> = {}) => loadScore({ matches: [CLASICO], mine: MINE_BY_MATCH, entries: PRESELECTION, ...extra });

  it("one drawing runs exactly one timer and one subscription, and any number of redrawings never accumulate more", async () => {
    const page = await withPreselection();
    expect(page.running()).toEqual({ intervals: 1, subscriptions: 1 });
    for (const who of [OTHER_MEMBER, { status: "unauthenticated" } as Who, MEMBER]) {
      await page.changeTo(who);
      expect(page.running()).toEqual({ intervals: 1, subscriptions: 1 });
    }
    page.close();
  });

  it("a redrawing the page makes ON ITS OWN (the form calls refresh() when the server says the offer changed) replaces the preselection too: nothing accumulates", async () => {
    const page = await withPreselection();
    expect(page.running()).toEqual({ intervals: 1, subscriptions: 1 });
    for (let i = 0; i < 3; i++) {
      await (page.win as any).refresh(); // not an identity change: nothing else stops the previous preselection before this redrawing replaces it
      await page.flush();
      expect(page.running()).toEqual({ intervals: 1, subscriptions: 1 });
    }
    expect(page.doc.querySelectorAll("#content > section")).toHaveLength(2);
    page.close();
  });

  it("a FIRST load that fails AFTER its preselection started (the jump to the section throws) leaves nothing running and says the list could not be loaded", async () => {
    const page = await withPreselection({ hash: "#historial", scrollThrows: true, ready: errorShown });
    expect(loadMessage(page)).toBe(LOAD_ERROR);
    expect(page.running()).toEqual({ intervals: 0, subscriptions: 0 });
    page.close();
  });

  it("an identity change whose redrawing fails AFTER the new preselection started (the jump to the section throws) stops that one as well", async () => {
    const page = await withPreselection({ hash: "#historial" });
    expect(page.running()).toEqual({ intervals: 1, subscriptions: 1 });
    page.breakScroll();
    await page.changeTo(OTHER_MEMBER);
    expect(loadMessage(page)).toBe(REFRESH_ERROR);
    expect(page.running()).toEqual({ intervals: 0, subscriptions: 0 });
    page.close();
  });

  it("an identity change whose redrawing FAILS (the request rejects) leaves no timer and no subscription alive, and the page says the refresh failed", async () => {
    const page = await withPreselection({ list: (n) => (n === 1 ? undefined : "reject") });
    expect(page.running()).toEqual({ intervals: 1, subscriptions: 1 });
    await page.changeTo(OTHER_MEMBER);
    expect(loadMessage(page)).toBe(REFRESH_ERROR);
    expect(page.running()).toEqual({ intervals: 0, subscriptions: 0 });
    page.close();
  });

  it("while a redrawing is waiting for its list the old preselection is already stopped (nothing of the previous person keeps repainting under «Actualizando…»)", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const page = await withPreselection({ list: (n) => (n === 1 ? undefined : gate.then(() => undefined)) });
    const pending = page.changeTo(OTHER_MEMBER);
    await page.flush();
    expect(page.text(page.content())).toBe("Actualizando…");
    expect(page.running()).toEqual({ intervals: 0, subscriptions: 0 });
    release();
    await pending;
    expect(page.running()).toEqual({ intervals: 1, subscriptions: 1 });
    page.close();
  });

  it("the account module's reset (who is signed in changed) stops it as well, and a redraw that fails after a reset leaves it stopped", async () => {
    const page = await withPreselection({ list: (n) => (n === 1 ? undefined : "reject") });
    expect(page.running()).toEqual({ intervals: 1, subscriptions: 1 });
    await page.reset();
    expect(page.text(page.content())).toBe("Actualizando…");
    expect(page.running()).toEqual({ intervals: 0, subscriptions: 0 });
    page.close();
  });

  it("a first load that fails starts nothing at all, and the page that stops it again later stays stopped", async () => {
    const page = await loadScore({ matches: [], entries: PRESELECTION, list: () => "reject", ready: errorShown });
    expect(page.running()).toEqual({ intervals: 0, subscriptions: 0 });
    await page.changeTo(OTHER_MEMBER);
    expect(loadMessage(page)).toBe(REFRESH_ERROR);
    expect(page.running()).toEqual({ intervals: 0, subscriptions: 0 });
    page.close();
  });

  it("a stale answer (an older redrawing that finishes after a newer one) starts no second preselection", async () => {
    let releaseOld!: () => void;
    const gate = new Promise<void>((resolve) => { releaseOld = resolve; });
    const page = await withPreselection({ list: (n) => (n === 2 ? gate.then(() => undefined) : undefined) });
    const older = page.changeTo(OTHER_MEMBER); // waits on the gate
    await page.flush();
    await page.changeTo(MEMBER); // the newer one is drawn
    expect(page.running()).toEqual({ intervals: 1, subscriptions: 1 });
    releaseOld();
    await older;
    expect(page.running()).toEqual({ intervals: 1, subscriptions: 1 });
    expect(page.doc.querySelectorAll("#content > section")).toHaveLength(2);
    page.close();
  });
});

// ---------------------------------------------------------------------------------------------------------------------------------
// M. The note about the crests, the list semantics, the arrow of the access, and the words of the shortlist.
// ---------------------------------------------------------------------------------------------------------------------------------

describe("M. The note about the crests, list semantics and the words of the shortlist", () => {
  const NOTE_ES = "Los escudos solo identifican a los equipos. URBANO no está afiliado a estos clubes ni a las ligas o competiciones que se nombran, ni cuenta con su patrocinio o respaldo.";
  const NOTE_EN = "Crests only identify the teams. URBANO is not affiliated with, sponsored by or endorsed by these clubs or by the leagues and competitions named here.";

  it("p.score-crests-note is the LAST child of #content after a successful drawing, with the Spanish words — whether there are matches, no matches, or a shortlist", async () => {
    for (const options of [{ matches: [CLASICO], mine: MINE_BY_MATCH, entries: PRESELECTION }, { matches: [] }, { matches: [CLASICO], mine: MINE_BY_MATCH }]) {
      const page = await loadScore(options);
      const note = page.content().lastElementChild as HTMLElement;
      expect(note.tagName).toBe("P");
      expect(note.className).toBe("score-crests-note");
      expect(page.text(note)).toBe(NOTE_ES);
      expect(note.getAttribute("data-i18n")).toBe("upcoming.disclaimer");
      expect(page.doc.querySelectorAll(".score-crests-note")).toHaveLength(1);
      expect([...page.content().children].map((c) => c.id || c.className)).toEqual(["cartelera", "historial", "score-crests-note"]);
      page.close();
    }
  });

  it("in English it says the English words, and a change of language while the page is open translates it in place", async () => {
    const page = await loadScore({ matches: [CLASICO], mine: MINE_BY_MATCH, lang: "en", entries: PRESELECTION });
    expect(page.text(page.content().lastElementChild)).toBe(NOTE_EN);
    page.win.UrbanoI18n.setLang("es");
    await page.flush();
    expect(page.text(page.content().lastElementChild)).toBe(NOTE_ES);
    expect(page.text(page.doc.querySelector("#score-upcoming .upcoming-chip"))).toBe("Preselección");
    page.close();
  });

  it("it is there after every successful redrawing (and only one), and absent while loading, while updating and in the error states", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const page = await loadScore({ matches: [CLASICO], mine: MINE_BY_MATCH, list: (n) => (n === 1 ? gate.then(() => undefined) : n === 3 ? "reject" : undefined), ready: () => true });
    expect(page.text(page.content())).toContain("Cargando"); // loading
    expect(page.doc.querySelector(".score-crests-note")).toBeNull();
    release();
    await page.flush();
    expect(page.content().lastElementChild?.className).toBe("score-crests-note");
    await page.changeTo(OTHER_MEMBER); // second request: fine
    expect(page.content().lastElementChild?.className).toBe("score-crests-note");
    expect(page.doc.querySelectorAll(".score-crests-note")).toHaveLength(1);
    await page.changeTo(MEMBER); // third request: fails
    expect(loadMessage(page)).toBe(REFRESH_ERROR);
    expect(page.doc.querySelector(".score-crests-note")).toBeNull();
    page.close();
  });

  it("ul#score-upcoming is a list for assistive technology (role=list on a list whose markers the page removes), labelled in both languages", async () => {
    for (const [lang, label] of [["es", "Lista de próximos partidos"], ["en", "List of upcoming matches"]] as const) {
      const page = await loadScore({ matches: [CLASICO], mine: MINE_BY_MATCH, lang, entries: PRESELECTION });
      const list = page.doc.getElementById("score-upcoming")!;
      expect(list.tagName).toBe("UL");
      expect(list.getAttribute("role")).toBe("list");
      expect(list.getAttribute("aria-label")).toBe(label);
      page.close();
    }
  });

  it("the arrow after «Mis participaciones y premios» is decoration: the CSS gives it empty alternative text, and the link's own text has no arrow", () => {
    const css = HTML.slice(HTML.indexOf("<style>"), HTML.indexOf("</style>"));
    const rule = /\.score-access-link::after\s*\{([^}]*)\}/.exec(css);
    expect(rule).not.toBeNull();
    expect(rule![1]).toMatch(/content:\s*"→";/); // the fallback for engines that do not read the alternative text
    expect(rule![1]).toMatch(/content:\s*"→"\s*\/\s*"";/); // «content: "→" / ""»: nothing for a screen reader to say
    expect(HTML).toMatch(/<a class="score-access-link" id="score-access-history" href="#historial" data-i18n="pred\.access\.history">Mis participaciones y premios<\/a>/);
  });

  it("the note's text is as readable as the rest of the small print (12 px or more, the muted colour, a bounded width)", () => {
    const css = HTML.slice(HTML.indexOf("<style>"), HTML.indexOf("</style>"));
    const rule = /\.score-crests-note\s*\{([^}]*)\}/.exec(css)!;
    expect(Number(/font-size:\s*(\d+(?:\.\d+)?)px/.exec(rule[1])![1])).toBeGreaterThanOrEqual(12);
    expect(rule[1]).toMatch(/color:\s*var\(--muted\)/);
    expect(rule[1]).toMatch(/max-width:\s*60ch/);
  });

  it("the shortlist chips say «Preselección» in Spanish and «Shortlisted» in English — never that a match is not open — and the section titles in English are «Fixtures» and «Upcoming matches (shortlist)»", async () => {
    const entries = [{ ...SRC, id: "E1", kickoffAt: inHours(30), home: "Valencia", away: "Real Madrid", competition: "LaLiga" }, { id: "E2", date: hnDate(72), home: "Motagua", away: "Olimpia", competition: "Liga Nacional" }];
    const es = await loadScore({ matches: [CLASICO], mine: MINE_BY_MATCH, entries });
    expect([...es.doc.querySelectorAll("#score-upcoming .upcoming-chip")].map((c) => es.text(c))).toEqual(["Preselección", "Preselección"]);
    expect(es.text(es.doc.querySelector("#lineup-upcoming h3"))).toBe("Próximos partidos (preselección)");
    expect(es.text(es.doc.getElementById("cartelera-title"))).toBe("Cartelera");
    es.close();
    const en = await loadScore({ matches: [CLASICO], mine: MINE_BY_MATCH, entries, lang: "en" });
    expect([...en.doc.querySelectorAll("#score-upcoming .upcoming-chip")].map((c) => en.text(c))).toEqual(["Shortlisted", "Shortlisted"]);
    expect(en.text(en.doc.querySelector("#lineup-upcoming h3"))).toBe("Upcoming matches (shortlist)");
    expect(en.text(en.doc.getElementById("cartelera-title"))).toBe("Fixtures");
    expect(en.text(en.doc.querySelector("#lineup-upcoming .score-section-intro"))).toBe("They are not open for participation for now. Dates and times are informational and may change. Honduras time.");
    en.close();
  });
});
