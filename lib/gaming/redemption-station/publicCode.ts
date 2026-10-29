import { createHash } from "node:crypto";

import { PublicCodeCollisionError } from "./types";

/**
 * The public code of a prize: short enough to read aloud (CL-7K3M9Q), derived from the identifier of the prize so that nothing has to be
 * stored and the same prize always has the same code. It identifies; it never redeems: a code does nothing without a session.
 */

// Crockford's base32: no I, L, O or U, so a code cannot be misread.
const ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
export const PUBLIC_CODE_PATTERN = /^CL-[0-9A-HJKMNP-TV-Z]{6}$/;

export function prizePublicCode(prizeQualificationId: string): string {
  const digest = createHash("sha256").update("canje-the-pub:" + prizeQualificationId.toLowerCase(), "utf8").digest();
  let value = 0n;
  for (let i = 0; i < 5; i++) value = (value << 8n) | BigInt(digest[i]!);
  // 40 bits -> the first 30 give six symbols
  let code = "";
  for (let i = 0; i < 6; i++) code = ALPHABET[Number((value >> BigInt(10 + i * 5)) & 31n)]! + code;
  return "CL-" + code;
}

/** The codes of a set of prizes. Fails closed if two prizes would share one. */
export function assignPublicCodes(prizeQualificationIds: readonly string[]): Map<string, string> {
  const byCode = new Map<string, string>();
  const byPrize = new Map<string, string>();
  for (const id of prizeQualificationIds) {
    const code = prizePublicCode(id);
    if (byCode.has(code) && byCode.get(code) !== id) throw new PublicCodeCollisionError();
    byCode.set(code, id);
    byPrize.set(id, code);
  }
  return byPrize;
}
