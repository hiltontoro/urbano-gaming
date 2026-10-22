import { NextResponse } from "next/server";

/**
 * GET /api/gaming/auth-methods — which account-entry methods this
 * deployment DECLARES, so the shared sign-in panel never offers a method
 * nobody has switched on.
 *
 * These flags are declarations, not evidence of delivery. `email` is a
 * constant: it does not probe Supabase Auth, the mail provider or any
 * inbox, so it says nothing about whether a code will arrive. `phone` is
 * true ONLY when URBANO_PHONE_OTP_ENABLED is exactly the string "true",
 * a decision for a person to make after the SMS provider is configured
 * and a real handset has received and verified a code; the flag itself
 * proves none of that. Off by default. Delivery is evidenced only by a
 * recorded test on a real device or mailbox, never by this response.
 * Booleans only — nothing here is a secret, and this route deliberately
 * lives apart from /api/gaming/config so that route's browser-safe
 * contract (URL and anon key, nothing else) stays exactly as it is.
 */
export async function GET() {
  return NextResponse.json(
    {
      email: true,
      phone: process.env.URBANO_PHONE_OTP_ENABLED === "true",
    },
    { headers: { "cache-control": "no-store" } }
  );
}
