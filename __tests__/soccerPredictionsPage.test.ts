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
  const mine = { prediction: PREDICTION, evaluation: EVALUATION, qualification: over.qualification === undefined ? qualification() : over.qualification };
  const calls: string[] = [];
  const signIns: Array<Record<string, any>> = [];
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
