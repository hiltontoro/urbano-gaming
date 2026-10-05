/**
 * Opaque public-code generation for Competitions (UG-CR-GATE-081 Phase
 * 3A). Same shape as lib/session/hostToken.ts's generateHostToken: a
 * plain, high-entropy, cryptographically random identifier, carrying no
 * embedded claims and no expiry, distinct in every way from a resource's
 * own uuid primary key. Unlike hostToken (a security-bearing
 * credential), a Competitions public_code is deliberately NOT a
 * capability — it exists only so a browser URL or invitation view never
 * has to carry the real competition_id/competition_team_id; every
 * consequential action is still independently re-authorized exactly as
 * before, regardless of whether a given public_code is ever guessed.
 * 16 bytes (128 bits) is generous for non-enumerability at this pilot's
 * scale while keeping the resulting base64url string (22 characters, no
 * padding) short enough to sit comfortably in a shared link.
 */

import { randomBytes } from "crypto";

const PUBLIC_CODE_BYTES = 16; // 128 bits of entropy

export function generatePublicCode(): string {
  return randomBytes(PUBLIC_CODE_BYTES).toString("base64url");
}
