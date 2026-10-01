const REJECTION_MESSAGE =
  "Refusing to run against a non-local Supabase target. SUPABASE_URL must be exactly http://localhost, http://127.0.0.1, or their https equivalents (an optional port and path are allowed) for contract tests — never a remote, Preview, staging, or Production project.";

/**
 * Fail-closed contract-test Supabase target guard (UG-CR-GATE-079). Narrows
 * an unknown candidate SUPABASE_URL to string only when it is a
 * syntactically valid http(s) URL whose parsed hostname is exactly
 * "localhost" or "127.0.0.1" — exact hostname comparison, never substring
 * matching, so a deceptive remote host such as "localhost.example.com",
 * "127.0.0.1.example.com", or "http://localhost@remote.example" (whose
 * parsed hostname is "remote.example", not "localhost") is rejected. The
 * single fixed message never echoes the rejected value or any environment
 * value.
 */
export function requireLocalSupabase(candidate: unknown): asserts candidate is string {
  if (typeof candidate !== "string" || candidate.trim().length === 0) {
    throw new Error(REJECTION_MESSAGE);
  }

  let parsed: URL;
  try {
    parsed = new URL(candidate);
  } catch {
    throw new Error(REJECTION_MESSAGE);
  }

  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error(REJECTION_MESSAGE);
  }

  if (parsed.hostname !== "localhost" && parsed.hostname !== "127.0.0.1") {
    throw new Error(REJECTION_MESSAGE);
  }
}
