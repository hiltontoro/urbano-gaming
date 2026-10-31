import { createHash } from "node:crypto";

/**
 * Two-round pilot — fixed facts. These are literal transcriptions of the pilot's authority (UG-IV-GATE-004A and
 * UG-IV-GATE-005 / 005A); a test pins every one. Nothing here is a production schedule: the times of the pilot are configuration entered
 * by the operator and stored as information (see the schedule operations), never a default in this file.
 */

/** The preliminary advances this many contestants — plus every contestant tied with the last one. */
export const FINALIST_CUTOFF = 10;

/** The final lasts five minutes from its authoritative opening. The database enforces it with its own clock; a counter on a screen is never the authority. */
export const FINAL_WINDOW_SECONDS = 300;

/**
 * How long a browser or an edge cache may reuse a public contestant photograph. A copy fetched before a photograph is hidden or a
 * candidature withdrawn can outlive it by up to this long; the gallery stops listing the contestant immediately. Lower it (0 = never
 * cache) to trade load for strictness. This is a cache bound, not a retention period.
 */
export const PUBLIC_PHOTO_CACHE_SECONDS = 60;

/**
 * The GALLERY-AND-CONTEST consent: what a contestant needs in order to compete. It is a different decision from the promotional one
 * below and the contestant can refuse that one and still compete. DRAFT TEXT for local tests: the final wording is reviewed and approved
 * by the Founder and counsel BEFORE launch, and that review blocks the launch. It states no retention period on purpose — none has been
 * approved. The database stores the version and the SHA-256 of whatever text was shown, so approving different wording is a new
 * version, not an edit.
 */
export const GALLERY_CONSENT_VERSION = "halloween-2026-v3-gallery";
export const GALLERY_CONSENT_TEXT =
  "Confirmo que soy mayor de edad y que esta fotografía me representa. Autorizo que se muestre en la galería pública y en las pantallas de la votación del concurso de disfraces, durante el concurso. Entiendo que puedo retirarme en cualquier momento y que, si lo pido, mi fotografía dejará de mostrarse. Puedo competir sin autorizar ningún uso promocional.";

/** The PROMOTIONAL consent: optional, separate, never a condition to compete. DRAFT TEXT for local tests, reviewed before launch (see above). */
export const PROMO_CONSENT_VERSION = "halloween-2026-v2-promo";
export const PROMO_CONSENT_TEXT =
  "De forma opcional, autorizo a URBANO, URBANO Gaming, TecnoMovi y The Pub a usar esta fotografía en comunicaciones promocionales fuera del concurso, por ejemplo una selección editorial. Puedo negarme sin que eso afecte mi participación, y puedo retirar esta autorización más adelante.";

export const sha256Hex = (text: string): string => createHash("sha256").update(text, "utf8").digest("hex");
export const GALLERY_CONSENT_SHA256 = sha256Hex(GALLERY_CONSENT_TEXT);
export const PROMO_CONSENT_SHA256 = sha256Hex(PROMO_CONSENT_TEXT);

/** What the voter is asked in each round (neutral: it never names or ranks a contestant). */
export const PRELIMINARY_PROMPT = "Elegí tu disfraz favorito. Podés cambiar tu voto hasta que cierre la votación.";
export const FINAL_PROMPT = "Elegí tu favorito entre los finalistas. Podés cambiar tu voto mientras dure la ventana.";
