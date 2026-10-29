import { InvalidStationRequestError } from "./types";

/**
 * The declared name (or initials) of the person who delivers the prize. A shared PIN cannot prove who it was, so this is a declaration: it
 * is kept clean and short, because it is written into the audit reason and shown back.
 */
const NAME_PATTERN = /^[\p{L}\p{N}][\p{L}\p{N} .'’-]{1,39}$/u;

export function cleanOperatorName(value: unknown): string {
  if (typeof value !== "string") throw new InvalidStationRequestError("Write your name or initials.");
  // a control or format character in a name field is not something a person types: refuse it rather than quietly rewrite it
  if (/[\p{Cc}\p{Cf}]/u.test(value)) throw new InvalidStationRequestError("Write your name or initials (2 to 40 letters or numbers).");
  const cleaned = value.normalize("NFC").replace(/\s+/g, " ").trim();
  if (!NAME_PATTERN.test(cleaned)) throw new InvalidStationRequestError("Write your name or initials (2 to 40 letters or numbers).");
  return cleaned;
}
