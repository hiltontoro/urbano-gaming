/** An application is addressed in the browser only by its opaque 22-character base64url code. */
const PUBLIC_CODE_PATTERN = /^[A-Za-z0-9_-]{22}$/;

export function isWellFormedPublicCode(value: unknown): value is string {
  return typeof value === "string" && PUBLIC_CODE_PATTERN.test(value);
}
