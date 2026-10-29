import { randomBytes, scryptSync, timingSafeEqual } from "node:crypto";

/**
 * The PIN of a station is never stored: only a salted scrypt hash. The PIN is chosen privately by the Founder in the administration page
 * and travels once, in the body of a request, to be hashed; it is not written to a log, a file, a URL, a QR or a document.
 */

export const PIN_PATTERN = /^[0-9]{8,12}$/;
const KEY_LENGTH = 64;
const COST = { N: 16384, r: 8, p: 1 } as const;

export function generateSalt(): string {
  return randomBytes(32).toString("hex");
}

export function hashPin(pin: string, saltHex: string): string {
  return scryptSync(Buffer.from(pin, "utf8"), Buffer.from(saltHex, "hex"), KEY_LENGTH, COST).toString("hex");
}

/**
 * Why a PIN is not acceptable as a NEW PIN, or null when it is: 8 to 12 digits, and nothing obvious (all the same digit, a run of
 * consecutive digits, or a short block repeated).
 */
export function newPinProblem(pin: unknown): string | null {
  if (typeof pin !== "string" || !PIN_PATTERN.test(pin)) return "El PIN debe tener de 8 a 12 dígitos, solo números.";
  if (/^(\d)\1+$/.test(pin)) return "Ese PIN es demasiado obvio (todos los dígitos iguales): elige otro.";
  const digits = [...pin].map(Number);
  const step = (d: number) => digits.every((x, i) => i === 0 || x - digits[i - 1]! === d);
  if (step(1) || step(-1)) return "Ese PIN es demasiado obvio (dígitos consecutivos): elige otro.";
  if (/^(\d{2,4})\1+$/.test(pin)) return "Ese PIN es demasiado obvio (un bloque repetido): elige otro.";
  return null;
}

/**
 * Checks a PIN against the stored hash in constant time. A PIN that is not even shaped like one is still run through the same work, so
 * the answer does not tell a malformed PIN from a wrong one by how long it took.
 */
export function verifyPin(pin: unknown, saltHex: string, expectedHashHex: string): boolean {
  const shaped = typeof pin === "string" && PIN_PATTERN.test(pin);
  const candidate = shaped ? (pin as string) : "0".repeat(8);
  const given = Buffer.from(hashPin(candidate, saltHex), "hex");
  const expected = Buffer.from(expectedHashHex, "hex");
  const equal = given.length === expected.length && timingSafeEqual(given, expected);
  return equal && shaped;
}
