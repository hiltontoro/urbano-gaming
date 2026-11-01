import { sha256Hex } from "../rounds/constants";

/**
 * Self-registration of a contestant (UG-IV-GATE-018, addendum) — the facts the TypeScript layer owns: the two statements a person accepts, how a
 * WhatsApp number and a public name are normalized, and how a public code is typed. The database re-validates the SHAPE of everything here; it
 * stores the version and the SHA-256 of the statement that was shown, so approving different wording later is a NEW version, not an edit.
 *
 * Founder approved seven-day retention for all contest photos (including winners) and registration WhatsApps.
 * This product decision is not independent legal review. External copies require separate operational removal.
 */

/** What a person accepts to register as a contestant: legal age, the rules of taking part and when their candidacy becomes public. */
export const REQUIREMENTS_VERSION = "halloween-2026-v2-requirements-7days";
export const REQUIREMENTS_TEXT =
  "Confirmo que soy mayor de edad y que quiero participar como concursante en el concurso de disfraces de The Pub by Beer Box. Participo una sola vez y en una sola categoría. Mi candidatura se hará pública solo después de que el equipo del concurso verifique en la estación mi nombre y mi categoría, tome mi fotografía y yo autorice que se muestre. Entiendo que no puedo votar por mi propia candidatura ni, si participo en un grupo, por mi grupo. Si registro un grupo, soy su representante y todas las personas que aparecen en la fotografía deben aceptar participar. URBANO Gaming y The Pub administran las fotos y los WhatsApps del concurso. El plazo de conservación es de 7 días desde el cierre del concurso, también para las fotos de ganadores. El uso promocional es opcional y no amplía ese plazo. The Pub define y entrega los premios.";
export const REQUIREMENTS_SHA256 = sha256Hex(REQUIREMENTS_TEXT);

/**
 * The authorization to receive the delivery by WhatsApp. Its own decision: it is not the photograph's consent (given at the station) and it is
 * not a marketing permission. The delivery is made BY HAND from the team's own WhatsApp; the number is private and is used for nothing else.
 */
export const DELIVERY_VERSION = "halloween-2026-v1-whatsapp-delivery-draft";
export const DELIVERY_TEXT =
  "Autorizo que el equipo del concurso me escriba a este número de WhatsApp, de forma manual y desde su propio WhatsApp, para enviarme mi fotografía, mi código y el enlace de mi candidatura. Esto no es una autorización de publicidad ni de marketing, y tampoco autoriza el uso de mi imagen: eso lo decido aparte, en la estación. Entiendo que este número no se usa para votar ni para identificarme.";
export const DELIVERY_SHA256 = sha256Hex(DELIVERY_TEXT);

export const PUBLIC_NAME_MIN = 2;
export const PUBLIC_NAME_MAX = 40;

/** The name a person chose to be shown with their photograph: trimmed, 2–40 characters, no control characters. Null when it is not acceptable. */
export function normalizePublicName(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const name = raw.trim();
  if (name.length < PUBLIC_NAME_MIN || [...name].length > PUBLIC_NAME_MAX) return null;
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f-\u009f]/.test(name)) return null;
  return name;
}

/**
 * A WhatsApp number as E.164, or null. The person gives the country code and the number; spaces, hyphens, dots and parentheses are noise; "00" is
 * a "+". A number WITHOUT a country code is refused here and by the database: the country code is part of what the person confirms.
 */
export function normalizeWhatsapp(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const trimmed = raw.trim();
  if (trimmed.length === 0 || trimmed.length > 40 || !/^[+0-9\s().-]+$/.test(trimmed)) return null;
  let s = trimmed.replace(/[\s().-]/g, "");
  if (s.startsWith("00")) s = `+${s.slice(2)}`;
  return /^\+[1-9][0-9]{7,14}$/.test(s) ? s : null;
}

// ---------------------------------------------------------------- the public code

/** 30 symbols without 0, 1, I, L, O or U: a code survives being read aloud. Mirrors the database's alphabet; a test pins both. */
export const PUBLIC_CODE_ALPHABET = "23456789ABCDEFGHJKMNPQRSTVWXYZ";
export const PUBLIC_CODE_PATTERN = /^HAL-[2-9A-HJKMNP-TV-Z]{5}$/;

/**
 * The code as a person types it: any case, with or without the hyphen, with spaces. Null when it cannot be a code (it contains a look-alike or has the
 * wrong length) — the same normalization the database applies, so a page and a search agree on what was meant.
 */
export function normalizePublicCode(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const compact = raw.replace(/[^0-9A-Za-z]/g, "").toUpperCase();
  return /^HAL[2-9A-HJKMNP-TV-Z]{5}$/.test(compact) ? `HAL-${compact.slice(3)}` : null;
}

// ---------------------------------------------------------------- the delivery message (composed for the operator to send BY HAND)

/**
 * The message the operator may copy or open in WhatsApp. It names the code and the link; it NEVER says that a picture is attached, because a
 * WhatsApp link cannot attach one — the operator attaches the downloaded photograph themself.
 */
export function deliveryMessage(input: { publicName: string | null; publicCode: string; ficheUrl: string }): string {
  const greeting = input.publicName ? `Hola ${input.publicName}` : "Hola";
  return `${greeting}, te escribimos del concurso de disfraces de The Pub by Beer Box. Tu código de candidatura es ${input.publicCode}. Aquí está tu ficha: ${input.ficheUrl}`;
}

/** The wa.me link that opens WhatsApp with that message addressed to the number. Opening it records nothing: "delivered" exists only by the operator's explicit act. */
export function whatsappLink(e164: string, message: string): string {
  return `https://wa.me/${e164.replace(/\D/g, "")}?text=${encodeURIComponent(message)}`;
}
