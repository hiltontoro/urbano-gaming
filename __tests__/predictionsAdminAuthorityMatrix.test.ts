/// <reference types="vite/client" />
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";

/**
 * Every Predictions admin operation against the REAL authority chain.
 *
 * Nothing in lib/gaming/predictions/httpAuth.ts or in any route is replaced. Only the four classes that talk to Supabase are
 * stood in for by in-memory equivalents: Auth token verification, the Gaming Member lookup, the grants lookup and the
 * predictions repository. Every route therefore runs its own, real, per-call check against the grants it is given.
 *
 * The predictions repository stand-in answers every call by recording it and throwing: a request that is DENIED must never reach
 * it (no data was read or written for someone without authority), and a request that is ALLOWED reaches it or ends in a 4xx/5xx of
 * its own — but never in a 401 or 403.
 */

const world = vi.hoisted(() => {
  type Member = { gamingMemberId: string; displayName: string };
  return {
    tokens: new Map<string, { authUserId: string }>(),
    members: new Map<string, Member>(), // authUserId -> member (absent = verified identity without a finished profile)
    grants: new Map<string, Set<string>>(), // gamingMemberId -> active classes
    repoCalls: [] as string[],
  };
});

vi.mock("@/lib/gaming/db/supabaseGamingRepository", () => ({
  SupabaseGamingRepository: class {
    async resolveGamingMemberByAuthUserId(authUserId: string) {
      return world.members.get(authUserId) ?? null;
    }
  },
}));

vi.mock("@/lib/gaming/auth", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/gaming/auth")>();
  return {
    ...actual,
    SupabaseAuthUserVerifier: class {
      async verifyAccessToken(token: string) {
        return world.tokens.get(token) ?? null;
      }
    },
  };
});

vi.mock("@/lib/gaming/authority/db/supabaseAuthorityRepository", () => ({
  SupabaseAuthorityRepository: class {
    async hasActiveAuthority(memberId: string, authorityClass: string) {
      return world.grants.get(memberId)?.has(authorityClass) ?? false;
    }
    async listActiveAuthorityClasses(memberId: string) {
      return [...(world.grants.get(memberId) ?? [])];
    }
  },
}));

vi.mock("@/lib/gaming/predictions/db/supabasePredictionsRepository", () => ({
  SupabasePredictionsRepository: class {
    constructor() {
      return new Proxy(
        {},
        {
          get: (_target, property) => async () => {
            world.repoCalls.push(String(property));
            throw new Error("gate-passed: the predictions repository was reached");
          },
        }
      );
    }
  },
}));

type Needs = "OPERATIONAL" | "CONSEQUENTIAL_FINALIZER" | "ANY";
interface Operation {
  file: string; // relative to app/api/gaming/predictions/admin
  method: "GET" | "POST" | "PATCH" | "DELETE";
  needs: Needs;
}

const ADMIN_ROOT = "app/api/gaming/predictions/admin";

// All 24 handlers of the 17 admin route files, with the class each one must demand.
const OPERATIONS: Operation[] = [
  { file: "activations/[activationId]/prize-tiers", method: "POST", needs: "OPERATIONAL" },
  { file: "activations/[activationId]", method: "PATCH", needs: "OPERATIONAL" },
  { file: "activations", method: "GET", needs: "ANY" },
  { file: "activations", method: "POST", needs: "OPERATIONAL" },
  { file: "matches/[matchId]/activity-classification", method: "PATCH", needs: "CONSEQUENTIAL_FINALIZER" },
  { file: "matches/[matchId]/result/finalize", method: "POST", needs: "CONSEQUENTIAL_FINALIZER" },
  { file: "matches/[matchId]/result", method: "GET", needs: "ANY" },
  { file: "matches/[matchId]/result", method: "POST", needs: "OPERATIONAL" },
  { file: "matches/[matchId]", method: "PATCH", needs: "OPERATIONAL" },
  { file: "matches/[matchId]", method: "DELETE", needs: "OPERATIONAL" },
  { file: "matches/[matchId]/xp-eligibility", method: "PATCH", needs: "CONSEQUENTIAL_FINALIZER" },
  { file: "matches", method: "GET", needs: "ANY" },
  { file: "matches", method: "POST", needs: "OPERATIONAL" },
  { file: "players/[playerId]", method: "PATCH", needs: "OPERATIONAL" },
  { file: "qualifications/[qualificationId]/redeem", method: "POST", needs: "CONSEQUENTIAL_FINALIZER" },
  { file: "qualifications/[qualificationId]/release-hold", method: "POST", needs: "CONSEQUENTIAL_FINALIZER" },
  { file: "qualifications", method: "GET", needs: "ANY" },
  { file: "teams/[teamId]/players", method: "GET", needs: "ANY" },
  { file: "teams/[teamId]/players", method: "POST", needs: "OPERATIONAL" },
  { file: "teams", method: "GET", needs: "ANY" },
  { file: "teams", method: "POST", needs: "OPERATIONAL" },
  { file: "venues/[venueId]", method: "PATCH", needs: "OPERATIONAL" },
  { file: "venues", method: "GET", needs: "ANY" },
  { file: "venues", method: "POST", needs: "OPERATIONAL" },
];

// ---------------------------------------------------------------------------------------------------------------------------------
// People. Each is a verified Auth identity with its own token; only the grants differ.
// ---------------------------------------------------------------------------------------------------------------------------------

type Person = { token: string; memberId: string | null };
const people: Record<string, Person> = {};

function addPerson(name: string, options: { member: boolean; classes?: string[]; revoked?: string[] }): Person {
  const authUserId = `auth-${name}`;
  const token = `token-${name}`;
  world.tokens.set(token, { authUserId });
  let memberId: string | null = null;
  if (options.member) {
    memberId = `member-${name}`;
    world.members.set(authUserId, { gamingMemberId: memberId, displayName: name });
    world.grants.set(memberId, new Set(options.classes ?? []));
  }
  const person = { token, memberId };
  people[name] = person;
  return person;
}

beforeEach(() => {
  world.tokens.clear();
  world.members.clear();
  world.grants.clear();
  world.repoCalls.length = 0;
  for (const key of Object.keys(people)) delete people[key];
  process.env.SUPABASE_URL = "http://127.0.0.1:1";
  process.env.SUPABASE_SERVICE_ROLE_KEY = "stand-in";
  vi.spyOn(console, "error").mockImplementation(() => {});

  addPerson("noProfile", { member: false });
  addPerson("participant", { member: true, classes: [] });
  addPerson("operator", { member: true, classes: ["OPERATIONAL"] });
  addPerson("finalizer", { member: true, classes: ["CONSEQUENTIAL_FINALIZER"] });
  addPerson("governance", { member: true, classes: ["PRODUCT_GOVERNANCE"] });
  addPerson("founder", { member: true, classes: ["OPERATIONAL", "CONSEQUENTIAL_FINALIZER", "PRODUCT_GOVERNANCE"] });
  addPerson("formerOperator", { member: true, classes: ["OPERATIONAL"] });
  world.grants.get("member-formerOperator")!.delete("OPERATIONAL"); // a revoked grant is simply no longer active
});

afterEach(() => {
  vi.restoreAllMocks();
});

const routeModules = import.meta.glob("../app/api/gaming/predictions/admin/**/route.ts") as Record<string, () => Promise<Record<string, any>>>;

async function call(op: Operation, authorization: string | null): Promise<{ status: number; body: unknown }> {
  const loader = routeModules[`../${ADMIN_ROOT}/${op.file}/route.ts`];
  expect(loader, `route module for ${label(op)}`).toBeTypeOf("function");
  const mod = await loader!();
  const handler = mod[op.method];
  expect(typeof handler, `${op.method} ${op.file} exists`).toBe("function");
  const params: Record<string, string> = {
    activationId: "act-1",
    matchId: "m-1",
    playerId: "p-1",
    qualificationId: "q-1",
    teamId: "t-1",
    venueId: "v-1",
  };
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (authorization !== null) headers.authorization = authorization;
  const request = new Request(`http://localhost/${op.file}`, {
    method: op.method,
    headers,
    body: op.method === "GET" || op.method === "DELETE" ? undefined : "{}",
  });
  try {
    const response = await handler(request, { params });
    let body: unknown = null;
    try {
      body = await response.json();
    } catch {
      body = null;
    }
    return { status: response.status, body };
  } catch {
    // an error past the authority gate (for example the repository stand-in) is not an authority answer
    return { status: 599, body: null };
  }
}

const bearer = (person: Person) => `Bearer ${person.token}`;
const label = (op: Operation) => `${op.method} ${op.file}`;
const passesGate = (status: number) => status !== 401 && status !== 403;

describe("the matrix covers every admin operation, and says what the code says", () => {
  function routeFiles(dir: string): string[] {
    const out: string[] = [];
    for (const entry of readdirSync(dir)) {
      const full = path.join(dir, entry);
      if (statSync(full).isDirectory()) out.push(...routeFiles(full));
      else if (entry === "route.ts") out.push(full);
    }
    return out;
  }

  const onDisk = routeFiles(path.join(process.cwd(), ADMIN_ROOT)).flatMap((full) => {
    const rel = path.relative(path.join(process.cwd(), ADMIN_ROOT), path.dirname(full)).split(path.sep).join("/");
    const source = readFileSync(full, "utf8");
    return [...source.matchAll(/export async function (GET|POST|PATCH|DELETE)\b/g)].map((m) => `${m[1]} ${rel}`);
  });

  // The one admin-folder handler that is NOT a guarded operation: the read-only access hint (see predictionsAdminAccessRoute.test.ts).
  const HINT_ONLY = ["GET access"];

  it("lists exactly the handlers that exist: a new admin route cannot be added without a row here", () => {
    expect(OPERATIONS.map(label).sort()).toEqual(onDisk.filter((entry) => !HINT_ONLY.includes(entry)).sort());
    expect(onDisk.filter((entry) => HINT_ONLY.includes(entry))).toEqual(HINT_ONLY);
    expect(OPERATIONS).toHaveLength(24);
    expect(new Set(OPERATIONS.map(label)).size).toBe(24);
  });

  it("each handler's source demands the class this table expects (or any administrative class for the reads)", () => {
    for (const op of OPERATIONS) {
      const source = readFileSync(path.join(process.cwd(), ADMIN_ROOT, op.file, "route.ts"), "utf8");
      const handler = source.split(new RegExp(`export async function ${op.method}\\b`))[1]!.split(/export async function /)[0]!;
      if (op.needs === "ANY") {
        expect(handler, label(op)).toContain("requireAnyAdminAuthority(request, credentials)");
        expect(handler, label(op)).not.toContain("requirePlatformAuthorityHttp");
      } else {
        expect(handler, label(op)).toContain(`requirePlatformAuthorityHttp(request, credentials, "${op.needs}")`);
      }
    }
  });
});

describe("no credentials, or credentials that are not an identity: 401 on all 24 operations, and nothing is read or written", () => {
  const cases: Array<[string, string | null]> = [
    ["no Authorization header", null],
    ["a header that is not a bearer token", "Basic dXNlcjpwYXNz"],
    ["a bearer token Supabase Auth does not know", "Bearer not-a-real-token"],
    ["an empty bearer token", "Bearer "],
  ];
  for (const [name, header] of cases) {
    it(name, async () => {
      for (const op of OPERATIONS) {
        const out = await call(op, header);
        expect(out.status, `${label(op)} — ${name}`).toBe(401);
      }
      expect(world.repoCalls).toEqual([]);
    });
  }

  it("a verified identity that never finished its profile is not a Gaming Member: 401, and no member is created", async () => {
    for (const op of OPERATIONS) {
      const out = await call(op, bearer(people.noProfile!));
      expect(out.status, label(op)).toBe(401);
    }
    expect(world.repoCalls).toEqual([]);
    expect(world.members.has("auth-noProfile")).toBe(false);
  });
});

describe("an authenticated participant with no grants: 403 on all 24 operations, nothing is read or written", () => {
  it("is refused everywhere", async () => {
    for (const op of OPERATIONS) {
      const out = await call(op, bearer(people.participant!));
      expect(out.status, label(op)).toBe(403);
    }
    expect(world.repoCalls).toEqual([]);
  });

  it("a grant that was revoked no longer counts: the very next call is 403 everywhere", async () => {
    for (const op of OPERATIONS) {
      const out = await call(op, bearer(people.formerOperator!));
      expect(out.status, label(op)).toBe(403);
    }
    expect(world.repoCalls).toEqual([]);
  });

  it("the denial carries no data and says what is missing without naming anyone", async () => {
    const out = await call({ file: "venues", method: "GET", needs: "ANY" }, bearer(people.participant!));
    expect(out.status).toBe(403);
    expect(JSON.stringify(out.body)).not.toMatch(/member-participant|auth-participant|participant/);
  });
});

describe("classes are not hierarchical: each mutation demands exactly its own class", () => {
  const mutations = OPERATIONS.filter((op) => op.needs !== "ANY");

  it("OPERATIONAL passes the operational mutations and is refused the consequential ones", async () => {
    for (const op of mutations) {
      const out = await call(op, bearer(people.operator!));
      if (op.needs === "OPERATIONAL") expect(passesGate(out.status), `${label(op)} → ${out.status}`).toBe(true);
      else expect(out.status, label(op)).toBe(403);
    }
  });

  it("CONSEQUENTIAL_FINALIZER passes the consequential mutations and is refused the operational ones", async () => {
    for (const op of mutations) {
      const out = await call(op, bearer(people.finalizer!));
      if (op.needs === "CONSEQUENTIAL_FINALIZER") expect(passesGate(out.status), `${label(op)} → ${out.status}`).toBe(true);
      else expect(out.status, label(op)).toBe(403);
    }
  });

  it("PRODUCT_GOVERNANCE alone changes nothing: refused on every mutation, allowed the reads", async () => {
    for (const op of OPERATIONS) {
      const out = await call(op, bearer(people.governance!));
      if (op.needs === "ANY") expect(passesGate(out.status), `${label(op)} → ${out.status}`).toBe(true);
      else expect(out.status, label(op)).toBe(403);
    }
  });

  it("an account holding all three classes passes every one of the 24", async () => {
    for (const op of OPERATIONS) {
      const out = await call(op, bearer(people.founder!));
      expect(passesGate(out.status), `${label(op)} → ${out.status}`).toBe(true);
    }
  });
});

describe("the reads accept any one administrative class, and only those", () => {
  const reads = OPERATIONS.filter((op) => op.needs === "ANY");
  for (const who of ["operator", "finalizer", "governance"]) {
    it(`${who} can read all ${reads.length} surfaces`, async () => {
      for (const op of reads) {
        const out = await call(op, bearer(people[who]!));
        expect(passesGate(out.status), `${label(op)} → ${out.status}`).toBe(true);
      }
    });
  }
});

describe("authority is read fresh on every call", () => {
  it("a grant that is removed between two calls takes effect on the second", async () => {
    const op: Operation = { file: "venues", method: "POST", needs: "OPERATIONAL" };
    const first = await call(op, bearer(people.operator!));
    expect(passesGate(first.status)).toBe(true);
    world.grants.get("member-operator")!.delete("OPERATIONAL");
    const second = await call(op, bearer(people.operator!));
    expect(second.status).toBe(403);
  });

  it("a grant that is added between two calls takes effect on the second", async () => {
    const op: Operation = { file: "qualifications/[qualificationId]/redeem", method: "POST", needs: "CONSEQUENTIAL_FINALIZER" };
    expect((await call(op, bearer(people.participant!))).status).toBe(403);
    world.grants.get("member-participant")!.add("CONSEQUENTIAL_FINALIZER");
    expect(passesGate((await call(op, bearer(people.participant!))).status)).toBe(true);
  });
});

describe("identity is the verified member, never an address", () => {
  it("another person whose address would look like the administrator's is just another member with no grants", async () => {
    // The stand-in verifier does not even expose an address: authority attaches to the resolved member and nothing else.
    addPerson("lookalike", { member: true, classes: [] });
    for (const op of OPERATIONS) {
      const out = await call(op, bearer(people.lookalike!));
      expect(out.status, label(op)).toBe(403);
    }
  });

  it("no admin route, helper or the portal reads or compares an email address or a domain", () => {
    const files = [
      "lib/gaming/predictions/httpAuth.ts",
      "public/predictions-admin.html",
      ...OPERATIONS.map((op) => `${ADMIN_ROOT}/${op.file}/route.ts`),
      `${ADMIN_ROOT}/access/route.ts`,
    ];
    for (const file of new Set(files)) {
      const source = readFileSync(path.join(process.cwd(), file), "utf8");
      expect(source, file).not.toMatch(/tecnomovi|hotmail|@[a-z0-9-]+\.(com|org|net|hn)\b/i);
      expect(source, file).not.toMatch(/\.email\s*(===|==|!==|!=|\.endsWith|\.includes|\.toLowerCase\(\)\s*===)/);
    }
  });
});
