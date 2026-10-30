import { afterEach, describe, expect, it, vi } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";

import { InMemoryPredictionsRepository } from "../lib/gaming/predictions/db/inMemoryPredictionsRepository";
import { KickoffPassedError, VenueActivationDisabledError } from "../lib/gaming/predictions/types";
import { buildLadderWorld, submitAs, type LadderEnv } from "./helpers/progressiveLadderScenarios";

/**
 * THE PARTICIPATION WINDOW OF EL CLÁSICO — what the system can and cannot impose.
 *
 * Approved window: 25 October 2026, 12:30 p. m. to 2:00 p. m. Honduras time — it opens 90 minutes before the planned start and closes when the match
 * starts. The Home announced it as INFORMATION while the match was ahead; the match is past and the Home no longer carries the window, the date or
 * the time (Founder's Home correction of 2026-10-29: the Score entry is now a neutral link). The database closes a match at its start (a participation is refused from the instant of kickoff) and has
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
  it("12:30 p. m. is exactly 90 minutes before the 2:00 p. m. start, in Honduras, and 2:00 p. m. is the start the rule is written for", () => {
    const honduras = (ms: number) => new Intl.DateTimeFormat("en-GB", { timeZone: "America/Tegucigalpa", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(new Date(ms));
    expect(honduras(kickoffMs)).toBe("14:00");
    expect(honduras(kickoffMs - 90 * MIN)).toBe("12:30");
    expect(new Intl.DateTimeFormat("en-GB", { timeZone: "America/Tegucigalpa", day: "numeric", month: "long", year: "numeric" }).format(new Date(kickoffMs - 90 * MIN))).toBe("25 October 2026");
    expect(read("public/index.html")).not.toMatch(/<time\b|2026-10-25/); // the Home no longer states that moment anywhere
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
  it("no page and no client script keeps a clock for the opening: the Score page only SHOWS the opening time the server sends and never computes one, its only time rule is the closing at the start, and the Home carries no window at all", () => {
    const score = read("public/soccer-predictions.html");
    const code = score.replace(/\/\*[\s\S]*?\*\//g, "").replace(/<!--[\s\S]*?-->/g, "").replace(/^\s*\/\/.*$/gm, "");
    expect(code).not.toMatch(/opens_at|12:30|windowOpens|90 \* 60|5400000|kickoffAt[^;\n]*[-+]\s*\d+\s*\*/); // no arithmetic on the start, no hard-coded hour
    expect(code).toMatch(/match\.participationOpensAt/); // what it shows is what the server says
    expect(code).toMatch(/new Date\(\) >= new Date\(match\.kickoffAt\)/); // closing: the one time rule
    const home = read("public/index.html");
    expect(home).not.toMatch(/featured-window|home\.score\.window|12:30|Ventana de participación|participation window/i); // no window on the Home, in markup, language table or fallback
    const homeCode = home.replace(/\/\*[\s\S]*?\*\//g, "").replace(/<!--[\s\S]*?-->/g, "");
    expect(homeCode).not.toMatch(/\.disabled\s*=|setTimeout\(|setInterval\(/); // and the Home keeps no clock and disables nothing
    expect(read("public/urbanoI18n.js")).not.toMatch(/"home\.score\.window"|Ventana de participación prevista|Planned participation window/);
  });
});
