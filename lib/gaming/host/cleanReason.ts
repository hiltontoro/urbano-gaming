/**
 * A reviewer's internal reason is free text. A NUL byte cannot be stored in a
 * Postgres text column (it would surface as a 500), and other control characters
 * serve no purpose in a sentence, so they are replaced with spaces; tab and line
 * breaks are kept. The result is trimmed and capped at 500 characters, and is
 * null when nothing meaningful remains.
 */
export function cleanReason(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const cleaned = raw.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, " ").trim().slice(0, 500).trim();
  return cleaned.length > 0 ? cleaned : null;
}
