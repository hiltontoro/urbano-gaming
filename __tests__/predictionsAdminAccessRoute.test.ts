import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";

/**
 * GET /api/gaming/predictions/admin/access — the read-only hint the Score administration portal uses to decide what to show.
 *
 * It runs through the real lib/gaming/predictions/httpAuth.ts; only the classes that talk to Supabase are stood in for. The hint is
 * not a boundary: these tests also prove that nothing else consults it and that it creates, grants and reveals nothing.
 */

const world = vi.hoisted(() => ({
  tokens: new Map<string, { authUserId: string }>(),
  members: new Map<string, { gamingMemberId: string; displayName: string }>(),
  grants: new Map<string, string[]>(),
  creates: [] as string[],
  listCalls: 0,
}));

vi.mock("@/lib/gaming/db/supabaseGamingRepository", () => ({
  SupabaseGamingRepository: class {
    async resolveGamingMemberByAuthUserId(authUserId: string) {
      return world.members.get(authUserId) ?? null;
    }
    async createGamingMember() {
      world.creates.push("createGamingMember");
      throw new Error("the access hint must never create a member");
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
      return (world.grants.get(memberId) ?? []).includes(authorityClass);
    }
    async listActiveAuthorityClasses(memberId: string) {
      world.listCalls += 1;
      return [...(world.grants.get(memberId) ?? [])];
    }
    async grantPlatformAuthority() {
      world.creates.push("grantPlatformAuthority");
      throw new Error("the access hint must never grant authority");
    }
  },
}));

import { GET } from "@/app/api/gaming/predictions/admin/access/route";

function person(name: string, classes: string[] | null) {
  const authUserId = `auth-${name}`;
  world.tokens.set(`token-${name}`, { authUserId });
  if (classes !== null) {
    world.members.set(authUserId, { gamingMemberId: `member-${name}`, displayName: name });
    world.grants.set(`member-${name}`, classes);
  }
  return `Bearer token-${name}`;
}

const ask = (authorization?: string) =>
  GET(new Request("http://localhost/api/gaming/predictions/admin/access", { headers: authorization ? { authorization } : {} }));

beforeEach(() => {
  world.tokens.clear();
  world.members.clear();
  world.grants.clear();
  world.creates.length = 0;
  world.listCalls = 0;
  process.env.SUPABASE_URL = "http://127.0.0.1:1";
  process.env.SUPABASE_SERVICE_ROLE_KEY = "stand-in";
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("GET /admin/access", () => {
  it("401 without credentials, with a token Auth does not know, and with an identity that has no finished profile", async () => {
    for (const header of [undefined, "Basic abc", "Bearer unknown", person("noProfile", null)]) {
      const response = await ask(header);
      expect(response.status).toBe(401);
    }
    expect(world.listCalls).toBe(0);
  });

  it("403 for an authenticated member who holds nothing, and for one whose only grant was revoked", async () => {
    const participant = person("participant", []);
    const response = await ask(participant);
    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ error: "This account has no administrative access." });

    const former = person("former", ["OPERATIONAL"]);
    expect((await ask(former)).status).toBe(200);
    world.grants.set("member-former", []); // revoked
    expect((await ask(former)).status).toBe(403);
  });

  it("200 with exactly the active classes, in a stable order, whatever order they were granted in", async () => {
    const founder = person("founder", ["PRODUCT_GOVERNANCE", "CONSEQUENTIAL_FINALIZER", "OPERATIONAL"]);
    const response = await ask(founder);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ access: true, classes: ["OPERATIONAL", "CONSEQUENTIAL_FINALIZER", "PRODUCT_GOVERNANCE"] });
  });

  it("reports only the class a member actually holds", async () => {
    expect(await (await ask(person("operator", ["OPERATIONAL"]))).json()).toEqual({ access: true, classes: ["OPERATIONAL"] });
    expect(await (await ask(person("finalizer", ["CONSEQUENTIAL_FINALIZER"]))).json()).toEqual({ access: true, classes: ["CONSEQUENTIAL_FINALIZER"] });
    expect(await (await ask(person("governance", ["PRODUCT_GOVERNANCE"]))).json()).toEqual({ access: true, classes: ["PRODUCT_GOVERNANCE"] });
  });

  it("ignores values the stand-in could not have granted", async () => {
    const odd = person("odd", ["SUPERUSER", "OPERATIONAL", "ADMIN"]);
    expect(await (await ask(odd)).json()).toEqual({ access: true, classes: ["OPERATIONAL"] });
  });

  it("every answer, including the refusals, is marked no-store", async () => {
    for (const header of [undefined, person("participant2", []), person("operator2", ["OPERATIONAL"])]) {
      const response = await ask(header);
      expect(response.headers.get("cache-control")).toBe("no-store");
    }
  });

  it("is read-only: it never creates a member and never grants anything", async () => {
    await ask(person("noProfile2", null));
    await ask(person("participant3", []));
    await ask(person("operator3", ["OPERATIONAL"]));
    expect(world.creates).toEqual([]);
  });

  it("does not echo the member, the identity or the token", async () => {
    const body = JSON.stringify(await (await ask(person("operator4", ["OPERATIONAL"]))).json());
    expect(body).not.toMatch(/member-operator4|auth-operator4|token-operator4|operator4/);
  });

  it("answers per call: a grant added after a refusal is seen on the next call", async () => {
    const header = person("later", []);
    expect((await ask(header)).status).toBe(403);
    world.grants.set("member-later", ["CONSEQUENTIAL_FINALIZER"]);
    const response = await ask(header);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ access: true, classes: ["CONSEQUENTIAL_FINALIZER"] });
  });

  it("answers 500 without credentials configured, never a guess", async () => {
    delete process.env.SUPABASE_URL;
    const response = await ask(person("operator5", ["OPERATIONAL"]));
    expect(response.status).toBe(500);
  });

  it("only GET exists", async () => {
    const mod = await import("@/app/api/gaming/predictions/admin/access/route");
    expect(Object.keys(mod).filter((key) => ["GET", "POST", "PUT", "PATCH", "DELETE"].includes(key))).toEqual(["GET"]);
  });
});

describe("it is a hint, not a boundary", () => {
  it("no other route or library file consults it or imports its helper", () => {
    const roots = ["app", "lib"];
    const offenders: string[] = [];
    const walk = (dir: string) => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) walk(full);
        else if (/\.(ts|tsx)$/.test(entry.name)) {
          const source = readFileSync(full, "utf8");
          if (/resolveAdminAccessHttp/.test(source) && !/admin\/access\/route\.ts$/.test(full) && !/predictions\/httpAuth\.ts$/.test(full)) offenders.push(full);
        }
      }
    };
    for (const root of roots) walk(path.join(process.cwd(), root));
    expect(offenders).toEqual([]);
  });
});
