import { afterEach, describe, expect, it } from "vitest";

import { GET } from "../app/api/gaming/auth-methods/route";

/**
 * GET /api/gaming/auth-methods tells the shared sign-in panel which entry
 * methods this deployment DECLARES. Email is declared; phone is declared
 * ONLY when URBANO_PHONE_OTP_ENABLED is exactly "true" — it must never turn
 * on by accident (a stray value, a different case, a truthy-looking string),
 * and the response can carry nothing but those two booleans.
 *
 * The flags are declarations, not evidence of delivery: the route reads one
 * environment value and probes nothing, so it can say nothing about whether a
 * mail provider or SMS provider will deliver. The last test pins that.
 */

const ORIGINAL_ENV = { ...process.env };

afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
});

async function read() {
  const response = await GET();
  return { status: response.status, cache: response.headers.get("cache-control"), body: (await response.json()) as Record<string, unknown> };
}

describe("GET /api/gaming/auth-methods", () => {
  it("phone is NOT available by default; email is", async () => {
    delete process.env.URBANO_PHONE_OTP_ENABLED;
    const { status, body } = await read();
    expect(status).toBe(200);
    expect(body).toEqual({ email: true, phone: false });
  });

  it("phone turns on only for exactly \"true\"", async () => {
    for (const notEnabled of ["", "false", "TRUE", "True", "1", "yes", " true", "true ", "enabled"]) {
      process.env.URBANO_PHONE_OTP_ENABLED = notEnabled;
      expect((await read()).body.phone, `value "${notEnabled}"`).toBe(false);
    }
    process.env.URBANO_PHONE_OTP_ENABLED = "true";
    expect((await read()).body).toEqual({ email: true, phone: true });
  });

  it("carries nothing but the two booleans, never a secret from the same process, and is not cached", async () => {
    process.env.URBANO_PHONE_OTP_ENABLED = "true";
    process.env.SUPABASE_SERVICE_ROLE_KEY = "SENTINEL_SERVICE_ROLE_VALUE_MUST_NEVER_LEAK";
    process.env.TWILIO_AUTH_TOKEN = "SENTINEL_PROVIDER_SECRET_MUST_NEVER_LEAK";
    const { body, cache } = await read();
    expect(Object.keys(body).sort()).toEqual(["email", "phone"]);
    expect(JSON.stringify(body)).not.toContain("SENTINEL");
    expect(cache).toBe("no-store");
  });

  it("is a declaration, not a delivery check: it probes nothing, so a broken or missing provider setup does not change it", async () => {
    const realFetch = globalThis.fetch;
    let calls = 0;
    globalThis.fetch = (async () => {
      calls += 1;
      throw new Error("the auth-methods route must not call out");
    }) as unknown as typeof fetch;
    try {
      delete process.env.SUPABASE_URL;
      delete process.env.SUPABASE_SERVICE_ROLE_KEY;
      delete process.env.SUPABASE_ANON_KEY;
      delete process.env.URBANO_PHONE_OTP_ENABLED;
      expect((await read()).body).toEqual({ email: true, phone: false });
      process.env.SUPABASE_URL = "http://127.0.0.1:1"; // nothing listens here
      process.env.URBANO_PHONE_OTP_ENABLED = "true"; // declared on, with no provider behind it
      expect((await read()).body).toEqual({ email: true, phone: true });
      expect(calls).toBe(0);
    } finally {
      globalThis.fetch = realFetch;
    }
  });
});
