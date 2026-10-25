import { beforeEach, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { NextResponse } from "next/server";

import { InMemoryPredictionsRepository } from "../lib/gaming/predictions/db/inMemoryPredictionsRepository";
import { InMemoryLegalAcceptanceRepository } from "../lib/gaming/legal/db/inMemoryLegalAcceptanceRepository";
import { fixtureEntry, fixtureRegistry, fixtureRegistryWithNewVersion } from "./helpers/legalFixtures";

/**
 * THE LEGAL ROUTES, with the real handlers: the public texts, and the caller's own acceptances. Authentication, isolation between members,
 * the shape of what is accepted, the versions and hashes, idempotence, and an empty registry.
 */

vi.mock("@/lib/gaming/predictions/httpAuth", async () => {
  const actual = await vi.importActual<typeof import("../lib/gaming/predictions/httpAuth")>("../lib/gaming/predictions/httpAuth");
  return { ...actual, getSupabaseCredentials: vi.fn(), buildPredictionsRepo: vi.fn(), requireGamingMember: vi.fn() };
});
vi.mock("@/lib/gaming/legal/httpLegal", async () => {
  const actual = await vi.importActual<typeof import("../lib/gaming/legal/httpLegal")>("../lib/gaming/legal/httpLegal");
  return { ...actual, buildLegalRepo: vi.fn(), currentLegalRegistry: vi.fn() };
});
import * as httpAuth from "../lib/gaming/predictions/httpAuth";
import * as httpLegal from "../lib/gaming/legal/httpLegal";
import { GET as documentsGET } from "../app/api/gaming/legal/documents/route";
import { GET as documentGET } from "../app/api/gaming/legal/documents/[key]/route";
import { GET as acceptancesGET, POST as acceptancesPOST } from "../app/api/gaming/legal/acceptances/route";

const KICKOFF = "2026-10-25T20:00:00.000Z";

interface World { predictions: InMemoryPredictionsRepository; legal: InMemoryLegalAcceptanceRepository; matchId: string; registry: ReturnType<typeof fixtureRegistry> }

async function world(): Promise<World> {
  const predictions = new InMemoryPredictionsRepository();
  const home = await predictions.createTeam({ name: "Home " + randomUUID().slice(0, 4) });
  const away = await predictions.createTeam({ name: "Away " + randomUUID().slice(0, 4) });
  const match = await predictions.createMatch({ homeTeamId: home.teamId, awayTeamId: away.teamId, competition: "Fixture", kickoffAt: KICKOFF });
  const legal = new InMemoryLegalAcceptanceRepository();
  const registry = fixtureRegistry(KICKOFF);
  vi.mocked(httpAuth.getSupabaseCredentials).mockReturnValue({ url: "http://127.0.0.1:1", serviceKey: "x" });
  vi.mocked(httpAuth.buildPredictionsRepo).mockReturnValue(predictions as never);
  vi.mocked(httpLegal.buildLegalRepo).mockReturnValue(legal as never);
  vi.mocked(httpLegal.currentLegalRegistry).mockReturnValue(registry);
  return { predictions, legal, matchId: match.matchId, registry };
}

const as = (memberId: string) => vi.mocked(httpAuth.requireGamingMember).mockResolvedValue({ gamingMemberId: memberId } as never);
const withoutSession = () =>
  vi.mocked(httpAuth.requireGamingMember).mockResolvedValue({ errorResponse: NextResponse.json({ error: "A valid Authorization header for an authenticated Gaming Member is required." }, { status: 401 }) } as never);

const postReq = (body: unknown) => new Request("http://localhost/api/gaming/legal/acceptances", { method: "POST", headers: { authorization: "Bearer t", "content-type": "application/json" }, body: typeof body === "string" ? body : JSON.stringify(body) });
const getReq = (query = "") => new Request(`http://localhost/api/gaming/legal/acceptances${query}`, { headers: { authorization: "Bearer t" } });

function allOf(registry: ReturnType<typeof fixtureRegistry>, overrides: Record<string, Record<string, unknown>> = {}) {
  return registry.map((entry) => ({
    documentKey: entry.key,
    documentVersion: entry.version,
    contentSha256: entry.sha256,
    ...(entry.key === "EVENT_RULES" ? { ageDeclared18: true } : {}),
    ...(overrides[entry.key] ?? {}),
  }));
}

beforeEach(() => { vi.clearAllMocks(); });

describe("the public texts", () => {
  it("with the registry as it ships (empty) say that nothing is published, and the full text of nothing is available", async () => {
    await world();
    vi.mocked(httpLegal.currentLegalRegistry).mockReturnValue([]);
    const list = await documentsGET();
    expect(await list.json()).toEqual({ published: false, documents: [] });
    expect(list.headers.get("cache-control")).toBe("no-store");
    const one = await documentGET(new Request("http://localhost/api/gaming/legal/documents/ACCOUNT_TERMS"), { params: { key: "ACCOUNT_TERMS" } });
    expect(one.status).toBe(404);
  });

  it("list what is published with the hash, never the text; and serve the full text, readable without an account", async () => {
    const w = await world();
    const body = await (await documentsGET()).json();
    expect(body.published).toBe(true);
    expect(body.documents).toHaveLength(3);
    for (const d of body.documents) {
      expect(Object.keys(d).sort()).toEqual(["current", "key", "locale", "scope", "sha256", "title", "version"]);
    }
    const terms = await documentGET(new Request("http://localhost/x"), { params: { key: "ACCOUNT_TERMS" } });
    expect(terms.status).toBe(200);
    const doc = (await terms.json()).document;
    expect(doc).toMatchObject({ key: "ACCOUNT_TERMS", version: "fixture-1", sha256: w.registry[0].sha256 });
    expect(doc.blocks.map((b: any) => b.kind)).toEqual(["heading", "paragraph", "list", "table"]);
    expect(httpAuth.requireGamingMember).not.toHaveBeenCalled(); // no account involved
  });

  it("serve the event rules only for the exact instant their event starts, and an older version by its number", async () => {
    await world();
    vi.mocked(httpLegal.currentLegalRegistry).mockReturnValue(fixtureRegistryWithNewVersion(KICKOFF));
    const rules = (query: string) => documentGET(new Request(`http://localhost/x${query}`), { params: { key: "EVENT_RULES" } });
    expect((await rules("")).status).toBe(400);
    expect((await rules(`?kickoffAt=${encodeURIComponent("2026-10-25T20:00:00.001Z")}`)).status).toBe(404);
    const current = (await (await rules(`?kickoffAt=${encodeURIComponent(KICKOFF)}`)).json()).document;
    expect(current).toMatchObject({ version: "fixture-2", current: true });
    const older = (await (await rules(`?kickoffAt=${encodeURIComponent(KICKOFF)}&version=fixture-1`)).json()).document;
    expect(older).toMatchObject({ version: "fixture-1", current: false });
    expect((await rules(`?kickoffAt=${encodeURIComponent(KICKOFF)}&version=nope`)).status).toBe(404);
  });

  it("are answered on every request, never prerendered at build time", () => {
    const { readFileSync } = require("node:fs") as typeof import("node:fs");
    expect(readFileSync("app/api/gaming/legal/documents/route.ts", "utf8")).toContain('export const dynamic = "force-dynamic";');
  });

  it("do not serve an unknown document or a text that was changed after its hash was pinned", async () => {
    await world();
    const bad = await documentGET(new Request("http://localhost/x"), { params: { key: "MARKETING" } });
    expect(bad.status).toBe(404);
    const tampered = fixtureRegistry(KICKOFF).map((e) => (e.key === "ACCOUNT_TERMS" ? { ...e, content: { ...e.content, title: "edited" } } : e));
    vi.mocked(httpLegal.currentLegalRegistry).mockReturnValue(tampered);
    expect((await documentGET(new Request("http://localhost/x"), { params: { key: "ACCOUNT_TERMS" } })).status).toBe(404);
    expect((await (await documentsGET()).json()).documents.map((d: any) => d.key)).not.toContain("ACCOUNT_TERMS");
  });
});

describe("authentication", () => {
  it("both methods answer 401 without a session, and touch nothing", async () => {
    const w = await world();
    withoutSession();
    expect((await acceptancesGET(getReq(`?matchId=${w.matchId}`))).status).toBe(401);
    expect((await acceptancesPOST(postReq({ matchId: w.matchId, acceptances: allOf(w.registry) }))).status).toBe(401);
    expect(w.legal.count()).toBe(0);
  });

  it("a server without credentials is a 500, not an open door", async () => {
    await world();
    vi.mocked(httpAuth.getSupabaseCredentials).mockReturnValue(null);
    expect((await acceptancesGET(getReq())).status).toBe(500);
    expect((await acceptancesPOST(postReq({}))).status).toBe(500);
  });
});

describe("recording an acceptance", () => {
  it("records the three acts for the caller and says so; asking again records nothing and says so", async () => {
    const w = await world();
    as("ana");
    const first = await acceptancesPOST(postReq({ matchId: w.matchId, acceptances: allOf(w.registry) }));
    expect(first.status).toBe(201);
    const body = await first.json();
    expect(body).toMatchObject({ recorded: 3, alreadyRecorded: 0, published: true, satisfied: true });
    expect(first.headers.get("cache-control")).toBe("no-store");
    const again = await acceptancesPOST(postReq({ matchId: w.matchId, acceptances: allOf(w.registry) }));
    expect(again.status).toBe(200);
    expect(await again.json()).toMatchObject({ recorded: 0, alreadyRecorded: 3, satisfied: true });
    expect(w.legal.count()).toBe(3);
  });

  it("the acts are the caller's: the only member rows are hers, and a body that tries to name another member is refused", async () => {
    const w = await world();
    as("ana");
    expect((await acceptancesPOST(postReq({ matchId: w.matchId, gamingMemberId: "beto", acceptances: allOf(w.registry) }))).status).toBe(400);
    expect((await acceptancesPOST(postReq({ matchId: w.matchId, acceptances: allOf(w.registry).map((a) => ({ ...a, gamingMemberId: "beto" })) }))).status).toBe(400);
    expect(w.legal.count()).toBe(0);
    await acceptancesPOST(postReq({ matchId: w.matchId, acceptances: allOf(w.registry) }));
    expect(await w.legal.listForMember("beto")).toEqual([]);
    expect((await w.legal.listForMember("ana")).length).toBe(3);
  });

  it("refuses a stale version, a different hash, a missing age declaration, and writes nothing", async () => {
    const w = await world();
    as("ana");
    const stale = await acceptancesPOST(postReq({ matchId: w.matchId, acceptances: allOf(w.registry, { ACCOUNT_TERMS: { documentVersion: "fixture-0" } }) }));
    expect(stale.status).toBe(409);
    expect((await stale.json()).code).toBe("LEGAL_DOCUMENT_STALE");
    const hash = await acceptancesPOST(postReq({ matchId: w.matchId, acceptances: allOf(w.registry, { PRIVACY_NOTICE: { contentSha256: "0".repeat(64) } }) }));
    expect(hash.status).toBe(409);
    const age = await acceptancesPOST(postReq({ matchId: w.matchId, acceptances: allOf(w.registry, { EVENT_RULES: { ageDeclared18: false } }) }));
    expect(age.status).toBe(400);
    expect((await age.json()).error).toBe("The declaration of being 18 or older is required.");
    const noAge = await acceptancesPOST(postReq({ matchId: w.matchId, acceptances: allOf(w.registry).map(({ ageDeclared18, ...rest }) => rest) }));
    expect(noAge.status).toBe(400);
    expect(w.legal.count()).toBe(0);
  });

  it("refuses a malformed request: not JSON, not an object, unknown fields, a bad or unknown match, none or too many documents, wrong types", async () => {
    const w = await world();
    as("ana");
    const ok = allOf(w.registry);
    const cases: Array<[string, unknown, number]> = [
      ["not json", "{nope", 400],
      ["an array", [], 400],
      ["no match", { acceptances: ok }, 400],
      ["a match that is not an id", { matchId: "../x", acceptances: ok }, 400],
      ["an unknown match", { matchId: randomUUID(), acceptances: ok }, 404],
      ["no documents", { matchId: w.matchId, acceptances: [] }, 400],
      ["acceptances not a list", { matchId: w.matchId, acceptances: "all" }, 400],
      ["four documents", { matchId: w.matchId, acceptances: [...ok, ok[0]] }, 400],
      ["an extra top-level field", { matchId: w.matchId, acceptances: ok, marketing: true }, 400],
      ["an extra field in an item", { matchId: w.matchId, acceptances: ok.map((a) => ({ ...a, marketing: true })) }, 400],
      ["a version that is not text", { matchId: w.matchId, acceptances: ok.map((a) => ({ ...a, documentVersion: 1 })) }, 400],
      ["an age that is not a boolean", { matchId: w.matchId, acceptances: allOf(w.registry, { EVENT_RULES: { ageDeclared18: "yes" } }) }, 400],
      ["an item that is not an object", { matchId: w.matchId, acceptances: ["ACCOUNT_TERMS"] }, 400],
      ["an unknown document", { matchId: w.matchId, acceptances: [{ documentKey: "MARKETING", documentVersion: "v", contentSha256: "x" }] }, 400],
      ["the same document twice", { matchId: w.matchId, acceptances: [ok[0], ok[0]] }, 400],
    ];
    for (const [label, body, status] of cases) {
      expect((await acceptancesPOST(postReq(body))).status, label).toBe(status);
    }
    expect(w.legal.count()).toBe(0);
  });

  it("cannot accept what is not published: with the registry empty the answer is 409 'not published' and nothing is written", async () => {
    const w = await world();
    as("ana");
    vi.mocked(httpLegal.currentLegalRegistry).mockReturnValue([]);
    const res = await acceptancesPOST(postReq({ matchId: w.matchId, acceptances: allOf(w.registry) }));
    expect(res.status).toBe(409);
    expect((await res.json()).code).toBe("LEGAL_DOCUMENTS_NOT_PUBLISHED");
    expect(w.legal.count()).toBe(0);
  });

  it("concurrent identical requests write each act once: one answer says 201, the rest 200, and the count is three", async () => {
    const w = await world();
    as("ana");
    const answers = await Promise.all(Array.from({ length: 25 }, () => acceptancesPOST(postReq({ matchId: w.matchId, acceptances: allOf(w.registry) }))));
    const bodies = await Promise.all(answers.map((a) => a.json()));
    expect(answers.every((a) => a.status === 200 || a.status === 201)).toBe(true);
    expect(bodies.reduce((n, b) => n + b.recorded, 0)).toBe(3);
    expect(w.legal.count()).toBe(3);
    expect(bodies.every((b) => b.satisfied === true)).toBe(true);
  });
});

describe("reading my own record", () => {
  it("for a match: what it needs and what I have done, in the registry's current version; for another member, none of it", async () => {
    const w = await world();
    as("ana");
    await acceptancesPOST(postReq({ matchId: w.matchId, acceptances: allOf(w.registry).slice(0, 2) }));
    const mine = await (await acceptancesGET(getReq(`?matchId=${w.matchId}`))).json();
    expect(mine).toMatchObject({ published: true, satisfied: false });
    expect(mine.documents.map((d: any) => [d.key, d.accepted])).toEqual([["ACCOUNT_TERMS", true], ["PRIVACY_NOTICE", true], ["EVENT_RULES", false]]);
    expect(mine.documents.find((d: any) => d.key === "PRIVACY_NOTICE").actType).toBe("READ_ACKNOWLEDGMENT");
    expect(mine.documents.find((d: any) => d.key === "EVENT_RULES").needsAgeDeclaration).toBe(true);
    as("beto");
    const theirs = await (await acceptancesGET(getReq(`?matchId=${w.matchId}`))).json();
    expect(theirs.documents.map((d: any) => d.accepted)).toEqual([false, false, false]);
    expect((await (await acceptancesGET(getReq())).json()).acceptances).toEqual([]);
  });

  it("without a match: my own record only, with no hash and no member id", async () => {
    const w = await world();
    as("ana");
    await acceptancesPOST(postReq({ matchId: w.matchId, acceptances: allOf(w.registry) }));
    as("beto");
    await acceptancesPOST(postReq({ matchId: w.matchId, acceptances: allOf(w.registry) }));
    as("ana");
    const rows = (await (await acceptancesGET(getReq())).json()).acceptances;
    expect(rows).toHaveLength(3);
    for (const row of rows) expect(Object.keys(row).sort()).toEqual(["acceptedAt", "actType", "documentKey", "documentVersion", "locale", "scopeMatchId"]);
  });

  it("refuses a match that is not an id (404 for an unknown one), and shows an unpublished state honestly", async () => {
    const w = await world();
    as("ana");
    expect((await acceptancesGET(getReq("?matchId=not-an-id"))).status).toBe(400);
    expect((await acceptancesGET(getReq(`?matchId=${randomUUID()}`))).status).toBe(404);
    vi.mocked(httpLegal.currentLegalRegistry).mockReturnValue([fixtureEntry("ACCOUNT_TERMS", "v", { kind: "GLOBAL" })]);
    const status = await (await acceptancesGET(getReq(`?matchId=${w.matchId}`))).json();
    expect(status).toMatchObject({ published: false, satisfied: false, unpublished: ["PRIVACY_NOTICE", "EVENT_RULES"] });
  });
});
