import { afterEach, describe, expect, it, vi } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { JSDOM } from "jsdom";

import { InMemoryPredictionsRepository } from "../lib/gaming/predictions/db/inMemoryPredictionsRepository";
import { KickoffPassedError, VenueActivationDisabledError } from "../lib/gaming/predictions/types";
import { buildLadderWorld, submitAs, type LadderEnv } from "./helpers/progressiveLadderScenarios";

/**
 * THE PARTICIPATION WINDOW OF EL CLÁSICO — what the system can and cannot impose.
 *
 * Approved window: 25 October 2026, 12:30 p. m. to 2:00 p. m. Honduras time — it opens 90 minutes before the planned start and closes when the match
 * starts. That match is finished and lives in the Score history; the Home no longer announces it. Its card, "Próximos partidos", lists the coming matches from an
 * editorial list that carries NO window at all: a window hour appears there only when the server reports an approved one for a match it can tie to an
 * announced match (the Home card is pinned at the end of this file). The database closes a match at its start (a participation is refused from the instant of kickoff) and has
 * no opening time: a match accepts participations from the moment it is classified, has a valid prize offer and its venue activation is enabled — and a new
 * activation is enabled by default. The opening restriction is added where members' requests arrive, in the API route (rule and tests in
 * participationWindowServer.test.ts): before 12:30 the server refuses with 409 "not yet"; from 12:30 the window alone opens nothing, because the activation
 * must be enabled by a person; and the start closes it. This file pins the layers underneath — the database function and the application's submission
 * function have no opening time — and that the page enforces nothing: a button hidden by a page would restrict nothing.
 */

const ROOT = process.cwd();
const read = (rel: string) => readFileSync(path.join(ROOT, rel), "utf8");
const KICKOFF = "2026-10-25T20:00:00.000Z"; // 2:00 p. m. in Honduras (UTC−6)
const kickoffMs = new Date(KICKOFF).getTime();
const MIN = 60_000;

describe("the window, in numbers", () => {
  it("12:30 p. m. is exactly 90 minutes before the 2:00 p. m. start, in Honduras; the Home no longer announces that match (its card lists the coming ones)", () => {
    const honduras = (ms: number) => new Intl.DateTimeFormat("en-GB", { timeZone: "America/Tegucigalpa", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(new Date(ms));
    expect(honduras(kickoffMs)).toBe("14:00");
    expect(honduras(kickoffMs - 90 * MIN)).toBe("12:30");
    expect(new Intl.DateTimeFormat("en-GB", { timeZone: "America/Tegucigalpa", day: "numeric", month: "long", year: "numeric" }).format(new Date(kickoffMs - 90 * MIN))).toBe("25 October 2026");
    expect(read("public/index.html")).not.toMatch(/2026-10-25T20:00:00Z/);
    expect(read("public/homeUpcomingData.js")).not.toMatch(/2026-10-25T20:00:00/);
  });
});

describe("the server closes at the start and has no opening time", () => {
  afterEach(() => { vi.useRealTimers(); });

  async function openWorld() {
    const repo = new InMemoryPredictionsRepository();
    const env: LadderEnv = { repo, newMember: async (label) => label, finalizerId: "finalizer", operatorId: "finalizer" };
    repo.authorityRepository.seedAuthority("finalizer", "CONSEQUENTIAL_FINALIZER");
    const w = await buildLadderWorld(env, { offeredLevels: [1, 2, 3, 4], kickoffAt: KICKOFF });
    return { env, repo, w };
  }
  const answer = { attemptedLevel: 1, scoreline: { home: 1, away: 0 } };

  it("accepts a participation hours before 12:30 — there is no opening time — as long as the venue activation is enabled", async () => {
    const { env, w } = await openWorld();
    for (const minutesBefore of [6 * 60, 3 * 60, 91, 90, 30, 1]) {
      vi.useFakeTimers(); vi.setSystemTime(kickoffMs - minutesBefore * MIN);
      const member = `member-${minutesBefore}`;
      const saved = await submitAs(env, w, member, answer);
      expect(saved.attemptedLevel, `${minutesBefore} min before`).toBe(1); // accepted, 6 hours before as well as 30 minutes before
      vi.useRealTimers();
    }
  });

  it("refuses from the instant of kickoff, exactly: one millisecond before is accepted, the start itself and after are not", async () => {
    const { env, w } = await openWorld();
    vi.useFakeTimers(); vi.setSystemTime(kickoffMs - 1);
    await expect(submitAs(env, w, "last-moment", answer)).resolves.toMatchObject({ attemptedLevel: 1 });
    vi.setSystemTime(kickoffMs);
    await expect(submitAs(env, w, "at-start", answer)).rejects.toBeInstanceOf(KickoffPassedError);
    vi.setSystemTime(kickoffMs + 30 * MIN);
    await expect(submitAs(env, w, "after-start", answer)).rejects.toBeInstanceOf(KickoffPassedError);
  });

  it("is closed only by the operational switch before the opening: a disabled activation refuses at any hour, and enabling it is what opens", async () => {
    const { env, repo, w } = await openWorld();
    vi.useFakeTimers(); vi.setSystemTime(kickoffMs - 3 * 60 * MIN);
    await repo.setVenueActivationEnabled(w.activationId, false);
    await expect(submitAs(env, w, "before-opening", answer)).rejects.toBeInstanceOf(VenueActivationDisabledError);
    vi.setSystemTime(kickoffMs - 90 * MIN); // 12:30 — the clock alone opens nothing
    await expect(submitAs(env, w, "at-12-30-still-disabled", answer)).rejects.toBeInstanceOf(VenueActivationDisabledError);
    await repo.setVenueActivationEnabled(w.activationId, true); // the operational act
    await expect(submitAs(env, w, "after-enabling", answer)).resolves.toMatchObject({ attemptedLevel: 1 });
  });

  it("the database function says the same: it closes at kickoff and gates on the activation and the classification, with no opening time anywhere", () => {
    const sql = read("supabase/migrations/20261023180000_add_progressive_prediction_contract.sql");
    expect(sql).toMatch(/if now\(\) >= v_kickoff_at then\s+raise exception 'KICKOFF_PASSED/);
    expect(sql).toMatch(/if not v_activation_enabled then\s+raise exception 'VENUE_ACTIVATION_DISABLED/);
    expect(sql).toMatch(/MATCH_NOT_CLASSIFIED/);
    const predictionSchema = readdirSync(path.join(ROOT, "supabase/migrations")).filter((f) => /match|venue_activation|prediction|progressive/i.test(f)).map((f) => read(`supabase/migrations/${f}`)).join("\n");
    expect(predictionSchema).not.toMatch(/\b(opens_at|open_at|opening_at|participation_opens|accepting_from|window_start)\b/i);
  });

  it("a NEW activation is enabled by default — it opens at once — which is why the opening must be done by hand, not left to the clock", () => {
    expect(read("supabase/migrations/0054_create_venue_activations.sql")).toMatch(/enabled boolean not null default true/);
  });
});

describe("the page does not pretend to enforce it", () => {
  it("no page and no client script keeps a clock for the opening: the Score page only SHOWS the opening time the server sends and never computes one, its only time rule is the closing at the start, and the Home card reads the opening hour only from the server and keeps no hour of its own", () => {
    const score = read("public/soccer-predictions.html");
    const code = score.replace(/\/\*[\s\S]*?\*\//g, "").replace(/<!--[\s\S]*?-->/g, "").replace(/^\s*\/\/.*$/gm, "");
    expect(code).not.toMatch(/opens_at|12:30|windowOpens|90 \* 60|5400000|kickoffAt[^;\n]*[-+]\s*\d+\s*\*/); // no arithmetic on the start, no hard-coded hour
    expect(code).toMatch(/match\.participationOpensAt/); // what it shows is what the server says
    expect(code).toMatch(/new Date\(\) >= new Date\(match\.kickoffAt\)/); // closing: the one time rule
    const home = read("public/index.html");
    expect(home).toMatch(/<p class="featured-note" id="featured-note" data-i18n="home\.upcoming\.note">/); // the note on the card is a static line
    expect(home).not.toMatch(/featured-window/); // the old class (and its markup) is gone
    const homeCode = home.replace(/\/\*[\s\S]*?\*\//g, "").replace(/<!--[\s\S]*?-->/g, "");
    expect(homeCode).not.toMatch(/featured-(note|window)[^;{}]*\.(hidden|disabled)|\.disabled\s*=|setTimeout\(|setInterval\(/);
    // the one thing the page does with the note is hide it when the list has no rows: never a clock or an hour
    expect(homeCode).toMatch(/note\.hidden = items\.length === 0/);
    const card = read("public/homeUpcoming.js").replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
    expect(card).not.toMatch(/opens_at|12:30|90 \* 60|5400000|kickoffAt[^;\n]*[-+]\s*\d+\s*\*/); // no hard-coded hour, no arithmetic on the start to find an opening
    // the opening it shows is the one the server sends: the only reader of an opening is windowOpensMs, it reads the SERVER match's participationOpensAt, and it is only ever asked about a server match
    expect(card).toMatch(/function windowOpensMs\(match\) \{\s*return match && match\.participationOpensAt \? Date\.parse\(match\.participationOpensAt\) : NaN;\s*\}/);
    expect(card.replace(/match\.participationOpensAt/g, "")).not.toMatch(/participationOpensAt/); // no other way to read an opening
    const asked = Array.from(card.matchAll(/windowOpensMs\((\w+)\)/g)).map((m) => m[1]).filter((arg) => arg !== "match"); // "match" is the helper's own parameter
    expect(asked.length).toBeGreaterThan(0);
    for (const arg of asked) expect(["server", "m"], `windowOpensMs is asked about "${arg}", which is not a server match`).toContain(arg);
  });
});

describe("the Home card keeps no window of its own: an opening hour appears only when the server reports an approved one", () => {
  const NOW = "2026-11-03T15:00:00Z"; // before every announced match
  const DATA = read("public/homeUpcomingData.js");
  const MODULE = read("public/homeUpcoming.js");
  const I18N = read("public/urbanoI18n.js");

  /** The editorial list and the card's module, run as the page runs them, and drawn in a real document at the fixed instant `NOW`. */
  function card(server: unknown[], nowIso: string = NOW) {
    const dom = new JSDOM('<!doctype html><ul id="list"></ul><p id="status" hidden></p>', { url: "http://localhost/", runScripts: "outside-only" });
    const w = dom.window as any;
    w.eval(I18N);
    w.eval(DATA);
    w.eval(MODULE);
    const painted: any[][] = [];
    const handle = w.UrbanoHomeUpcoming.init({ host: w.document.getElementById("list"), statusHost: w.document.getElementById("status"), serverMatches: server, now: () => Date.parse(nowIso), refreshMs: 0, onPaint: (items: any[]) => painted.push(items) });
    return {
      items: JSON.parse(JSON.stringify(painted[painted.length - 1])) as Array<{ entry: { id: string }; state: string; opensAt: number | null; hasTime: boolean }>,
      rows: Array.from(w.document.querySelectorAll("#list .upcoming-item")) as HTMLElement[],
      opens: Array.from(w.document.querySelectorAll("#list .upcoming-opens")).map((e: any) => e.textContent as string),
      text: (w.document.getElementById("list").textContent as string).replace(/\s+/g, " "),
      data: JSON.parse(JSON.stringify(w.UrbanoUpcomingData)) as { matches: Array<Record<string, unknown>> },
      stop: () => { handle.stop(); dom.window.close(); },
    };
  }
  const listed = (over: Record<string, unknown>) => ({
    matchId: "s1", competition: "LaLiga", cancelledAt: null, finalized: false, participationOpensAt: null,
    homeTeam: { name: "Valencia" }, awayTeam: { name: "Real Madrid" }, kickoffAt: "2026-11-07T20:00:00.000Z",
    venueActivations: [{ enabled: true, venue: { active: true }, offer: { available: true } }], ...over,
  });

  it("the editorial list carries no window of any kind: each entry has its teams, its competition and EXACTLY ONE timing (an instant, or a Honduras date with no hour)", () => {
    const view = card([]);
    try {
      expect(view.data.matches).toHaveLength(5);
      const allowed = ["id", "home", "away", "competition", "kickoffAt", "date", "source", "sourceUrl", "verifiedAt"]; // the last three say where the hour was read and when: nothing about participation
      for (const entry of view.data.matches) {
        expect(Object.keys(entry).filter((k) => !allowed.includes(k)), String(entry.id)).toEqual([]);
        expect(["kickoffAt", "date"].filter((k) => k in entry), String(entry.id)).toHaveLength(1);
      }
      const code = DATA.replace(/\/\*[\s\S]*?\*\//g, "");
      expect(code).not.toMatch(/opensAt|participationOpens|opens_at|windowOpens|window[A-Z]|12:30|\b90\b/);
    } finally { view.stop(); }
  });

  it("with nothing from the server no row shows an opening hour, and every match is only announced", () => {
    const view = card([]);
    try {
      expect(view.items.map((i) => [i.entry.id, i.state, i.opensAt])).toEqual([["N26-26", "next", null], ["N26-27", "next", null], ["N26-46", "next", null], ["N26-22", "next", null], ["N26-24", "next", null]]);
      expect(view.opens).toEqual([]);
      expect(view.text).not.toMatch(/Participación desde|Participation from/);
    } finally { view.stop(); }
  });

  it("an approved window the server reports is shown as the SERVER said it (an hour no rule of ours could produce), only for the match it belongs to", () => {
    // 11:07 a. m. in Honduras: not 90 minutes before the 2:00 p. m. start, not any hour the card could compute from the kickoff
    const view = card([listed({ participationOpensAt: "2026-11-07T17:07:00.000Z" })]);
    try {
      expect(view.items.map((i) => [i.entry.id, i.state, i.opensAt])).toEqual([["N26-26", "scheduled", Date.parse("2026-11-07T17:07:00.000Z")], ["N26-27", "next", null], ["N26-46", "next", null], ["N26-22", "next", null], ["N26-24", "next", null]]);
      expect(view.opens).toEqual(["Participación desde las 11:07 a. m. (hora de Honduras)"]);
    } finally { view.stop(); }
    // the same match with NO window reported: no opening hour is invented for it, whatever the kickoff
    const none = card([listed({})]);
    try {
      expect(none.opens).toEqual([]);
      expect(none.items.map((i) => i.opensAt)).toEqual([null, null, null, null, null]);
    } finally { none.stop(); }
  });

  it("a match without a confirmed hour can never show a window, even if the database lists a match between the same two teams with an approved window", () => {
    const tbc = listed({ matchId: "s2", competition: "Liga Nacional", homeTeam: { name: "Motagua" }, awayTeam: { name: "Olimpia" }, kickoffAt: "2026-11-19T23:00:00.000Z", participationOpensAt: "2026-11-19T21:30:00.000Z" });
    const view = card([tbc]);
    try {
      const row = view.items.find((i) => i.entry.id === "N26-46")!;
      expect([row.hasTime, row.state, row.opensAt]).toEqual([false, "next", null]);
      expect(view.opens).toEqual([]);
      expect(view.rows.find((r) => r.getAttribute("data-match") === "N26-46")!.querySelector(".upcoming-time")!.textContent).toBe("jue 19 nov · Horario por confirmar");
    } finally { view.stop(); }
  });

  it("the opening hour is written with the key the SERVER's hour selects: one o'clock takes the singular article in Spanish (upcoming.opensAtOne), every other hour the plural; English reads the same for both; the hour is exactly the one the server sent", () => {
    const opensTexts = (opensAt: string, lang: "es" | "en") => {
      const dom = new JSDOM('<!doctype html><ul id="list"></ul><p id="status" hidden></p>', { url: "http://localhost/", runScripts: "outside-only" });
      const w = dom.window as any;
      w.eval(I18N); w.eval(DATA); w.eval(MODULE);
      const handle = w.UrbanoHomeUpcoming.init({ host: w.document.getElementById("list"), statusHost: w.document.getElementById("status"), serverMatches: [listed({ participationOpensAt: opensAt })], now: () => Date.parse(NOW), refreshMs: 0 });
      if (lang === "en") w.UrbanoI18n.setLang("en"); // the change of language redraws the list
      const out = Array.from(w.document.querySelectorAll("#list .upcoming-opens")).map((e: any) => e.textContent as string);
      handle.stop(); dom.window.close();
      return out;
    };
    const I = JSON.parse(JSON.stringify(new JSDOM("", { runScripts: "outside-only" }).window.eval(I18N + ";UrbanoI18n.dictionary()"))) as { es: Record<string, string>; en: Record<string, string> };
    expect(I.es["upcoming.opensAtOne"]).toBe("Participación desde la {time} (hora de Honduras)");
    expect(I.es["upcoming.opensAt"]).toBe("Participación desde las {time} (hora de Honduras)");
    expect(I.en["upcoming.opensAtOne"]).toBe(I.en["upcoming.opensAt"]);
    // Honduras is UTC-6: 19:15Z is 1:15 p. m., 07:15Z is 1:15 a. m., 18:30Z is 12:30 p. m., 17:07Z is 11:07 a. m.
    expect(opensTexts("2026-11-07T19:15:00.000Z", "es")).toEqual(["Participación desde la 1:15 p. m. (hora de Honduras)"]);
    expect(opensTexts("2026-11-07T07:15:00.000Z", "es")).toEqual(["Participación desde la 1:15 a. m. (hora de Honduras)"]);
    expect(opensTexts("2026-11-07T18:30:00.000Z", "es")).toEqual(["Participación desde las 12:30 p. m. (hora de Honduras)"]); // twelve is plural
    expect(opensTexts("2026-11-07T17:07:00.000Z", "es")).toEqual(["Participación desde las 11:07 a. m. (hora de Honduras)"]);
    expect(opensTexts("2026-11-07T19:15:00.000Z", "en")).toEqual(["Participation from 1:15 p.m. (Honduras time)"]);
    expect(opensTexts("2026-11-07T18:30:00.000Z", "en")).toEqual(["Participation from 12:30 p.m. (Honduras time)"]);
  });

  it("the status sentence under the list never carries an hour: it follows the server's list (a window that has not opened is not an open match) and says nothing about a window", () => {
    const text = (server: unknown[]) => {
      const dom = new JSDOM('<!doctype html><ul id="list"></ul><p id="status" hidden></p>', { url: "http://localhost/", runScripts: "outside-only" });
      const w = dom.window as any;
      w.eval(I18N); w.eval(DATA); w.eval(MODULE);
      const handle = w.UrbanoHomeUpcoming.init({ host: w.document.getElementById("list"), statusHost: w.document.getElementById("status"), serverMatches: server, now: () => Date.parse(NOW), refreshMs: 0 });
      const status = w.document.getElementById("status");
      const out = { shown: !status.hidden, text: status.textContent as string };
      handle.stop(); dom.window.close();
      return out;
    };
    // the window has not opened: the server's match does not accept participation yet, so the card still says that none is open, with no hour
    expect(text([listed({ participationOpensAt: "2026-11-07T17:07:00.000Z" })])).toEqual({ shown: true, text: "Todavía no hay partidos abiertos para participar." });
    expect(text([])).toEqual({ shown: true, text: "Todavía no hay partidos abiertos para participar." });
    // an open match without a window: the sentence points to the Score fixtures; still no hour
    const open = text([listed({})]);
    expect(open).toEqual({ shown: true, text: "Hay partidos abiertos para participar. Los ves en la cartelera de Score." });
    expect(open.text).not.toMatch(/\d:\d\d/);
  });

  it("once the match has started the window is no longer shown (the start closes it): the row says Cerrado and carries no hour", () => {
    const view = card([listed({ participationOpensAt: "2026-11-07T17:07:00.000Z" })], "2026-11-07T20:30:00Z");
    try {
      const row = view.items.find((i) => i.entry.id === "N26-26")!;
      expect([row.state, row.opensAt]).toEqual(["closed", null]);
      expect(view.opens).toEqual([]);
    } finally { view.stop(); }
  });
});
