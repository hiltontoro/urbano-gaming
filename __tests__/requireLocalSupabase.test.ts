import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

import { requireLocalSupabase } from "./helpers/requireLocalSupabase";

/**
 * UG-CR-GATE-079. Ordinary behavioral/meta test for the shared
 * fail-closed contract-test Supabase target guard — runs without
 * credentials, a local stack, or network access. Covers the helper's
 * own allow/reject behavior, and statically proves every registered
 * contract-test entry file adopts the shared guard ahead of any
 * client, repository, Auth call, or hook registration, with no
 * leftover duplicated inline guard.
 */

const REPO_ROOT = path.resolve(__dirname, "..");

describe("requireLocalSupabase — allowed local targets", () => {
  const ALLOWED = [
    "http://localhost",
    "http://localhost:54321",
    "http://localhost/some/local/path",
    "http://localhost:54321/some/local/path",
    "http://127.0.0.1",
    "http://127.0.0.1:54321",
    "http://127.0.0.1/some/local/path",
    "https://localhost",
    "https://localhost:54321",
    "https://127.0.0.1",
    "https://127.0.0.1:54321",
  ];

  it.each(ALLOWED)("does not throw for %s", (candidate) => {
    expect(() => requireLocalSupabase(candidate)).not.toThrow();
  });
});

describe("requireLocalSupabase — rejected targets", () => {
  const REJECTED: Array<[string, unknown]> = [
    ["undefined", undefined],
    ["null", null],
    ["empty string", ""],
    ["whitespace only", "   "],
    ["malformed string", "not a url"],
    ["malformed scheme-only string", "http://"],
    ["ftp protocol", "ftp://localhost"],
    ["file protocol", "file:///etc/passwd"],
    ["ordinary remote URL", "https://example.com"],
    ["synthetic environment-style remote URL", "https://xxxxxxxxxxxxxxxxxxxx.supabase.co"],
    ["synthetic Preview-style remote URL", "https://urbano-gaming-git-preview-xxxxxx.vercel.app"],
    ["localhost lookalike subdomain", "http://localhost.example.com"],
    ["127.0.0.1 lookalike subdomain", "http://127.0.0.1.example.com"],
    ["deceptive userinfo form", "http://localhost@remote.example"],
    ["deceptive userinfo form with port", "http://127.0.0.1@remote.example:443"],
    ["non-string number", 12345],
    ["non-string object", { url: "http://localhost" }],
  ];

  it.each(REJECTED)("throws for %s", (_label, candidate) => {
    expect(() => requireLocalSupabase(candidate)).toThrow();
  });

  it("every rejection uses the same fixed message, and that message never includes the supplied value", () => {
    const messages = REJECTED.map(([, candidate]) => {
      try {
        requireLocalSupabase(candidate);
        throw new Error("expected requireLocalSupabase to throw");
      } catch (err) {
        return (err as Error).message;
      }
    });

    for (const message of messages) {
      expect(message).toBe(messages[0]);
    }

    const leakCandidates = [
      "example.com",
      "xxxxxxxxxxxxxxxxxxxx",
      "supabase.co",
      "vercel.app",
      "remote.example",
      "/etc/passwd",
      "12345",
    ];
    for (const message of messages) {
      for (const leak of leakCandidates) {
        expect(message).not.toContain(leak);
      }
    }
  });

  it("the fixed message names no rejected URL, hostname, project reference, key, token, or credential", () => {
    // The message is allowed to describe the ALLOWED shape (it legitimately
    // says "http://localhost" / "http://127.0.0.1" as guidance); it must
    // never echo the REJECTED candidate's own host or value.
    try {
      requireLocalSupabase("https://a-real-looking-project-ref.supabase.co");
      throw new Error("expected requireLocalSupabase to throw");
    } catch (err) {
      const message = (err as Error).message;
      expect(message).not.toContain("a-real-looking-project-ref");
      expect(message).not.toContain("supabase.co");
    }
  });
});

describe("contract-test registry and guard placement (static inventory)", () => {
  const packageJson = JSON.parse(readFileSync(path.join(REPO_ROOT, "package.json"), "utf8")) as {
    scripts: Record<string, string>;
  };

  function extractEntryFiles(script: string): string[] {
    const matches = script.match(/__tests__\/[A-Za-z0-9]+\.contract\.test\.ts/g) ?? [];
    return matches;
  }

  const registered = extractEntryFiles(packageJson.scripts["test:contract"]);

  it("package.json registers exactly nineteen unique contract entry files", () => {
    expect(registered.length).toBe(19);
    expect(new Set(registered).size).toBe(19);
  });

  it("the new behavioral/meta test is registered in the ordinary npm test script, not test:contract", () => {
    const testScript = packageJson.scripts.test;
    expect(testScript).toContain("__tests__/requireLocalSupabase.test.ts");
    expect(packageJson.scripts["test:contract"]).not.toContain("requireLocalSupabase.test.ts");
  });

  const CONSTRUCTION_PATTERNS: Array<[string, RegExp]> = [
    ["createClient(", /createClient\s*\(/],
    ["new Supabase...Repository(", /new\s+Supabase\w*\s*\(/],
    ["beforeAll(", /\bbeforeAll\s*\(/],
    ["beforeEach(", /\bbeforeEach\s*\(/],
    ["afterAll(", /\bafterAll\s*\(/],
    ["afterEach(", /\bafterEach\s*\(/],
  ];

  describe.each(registered)("%s", (relativePath) => {
    const content = readFileSync(path.join(REPO_ROOT, relativePath), "utf8");

    it("imports the shared guard from ./helpers/requireLocalSupabase", () => {
      expect(content).toMatch(
        /import\s*\{\s*requireLocalSupabase\s*\}\s*from\s*["']\.\/helpers\/requireLocalSupabase["'];/
      );
    });

    it("invokes requireLocalSupabase(supabaseUrl) exactly once", () => {
      const occurrences = content.match(/requireLocalSupabase\(supabaseUrl\)/g) ?? [];
      expect(occurrences.length).toBe(1);
    });

    it("calls the guard before any client/repository construction or test-hook registration", () => {
      const guardIndex = content.indexOf("requireLocalSupabase(supabaseUrl)");
      expect(guardIndex).toBeGreaterThan(-1);

      for (const [label, pattern] of CONSTRUCTION_PATTERNS) {
        const match = pattern.exec(content);
        if (match) {
          expect(match.index, `${relativePath}: first "${label}" must occur after the guard call`).toBeGreaterThan(
            guardIndex
          );
        }
      }
    });

    it("retains no independent local-target regex or guard error that interpolates SUPABASE_URL", () => {
      // The four previously duplicated ad hoc guards (Pulse, Race, both
      // Competitions files) each used a `.test(supabaseUrl)` regex check
      // and a rejection message containing the literal phrase
      // "non-local SUPABASE_URL" with the value interpolated in. Both
      // signatures must be fully gone now that the shared guard replaces
      // them. This intentionally does not forbid SUPABASE_URL from
      // appearing in unrelated, pre-existing, out-of-scope code (such as
      // a reachability probe's own error message) — only in a
      // guard-shaped rejection.
      expect(content).not.toContain(".test(supabaseUrl)");
      expect(content).not.toMatch(/non-local SUPABASE_URL/i);
    });
  });
});
