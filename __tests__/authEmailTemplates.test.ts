import { describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

/**
 * The branded Spanish authentication emails (supabase/email-templates). They are
 * installed by hand in the Supabase dashboard, so this suite pins the contract
 * that a person pasting them in cannot see: the one-time code and the alternate
 * link are present and used the same way in both messages, no code length is
 * promised, the required sentences are there, nothing is claimed before
 * verification, nothing is promised that this product has not authorized, and the
 * markup is email-safe and survives blocked images.
 */

const ROOT = join(__dirname, "..");
const DIR = join(ROOT, "supabase", "email-templates");
const NAMES = ["confirmation", "magic_link"] as const;

const read = (file: string) => readFileSync(join(DIR, file), "utf8");
const html = (n: (typeof NAMES)[number]) => read(`${n}.html`);
const txt = (n: (typeof NAMES)[number]) => read(`${n}.txt`);
const subjects = JSON.parse(read("subjects.json")) as Record<string, string>;

const ALLOWED_VARIABLES = new Set(["{{ .Token }}", "{{ .ConfirmationURL }}", "{{ .SiteURL }}", "{{ .Email }}"]);
const LOGO_URL = "{{ .SiteURL }}/email/urbano-lockup-email.png";
const APPROVED_LOGO_SHA256 = "072982b3fd0051557fb87b0e7e0826bd86c5ed1975d8982ac178bf7b7b2d95b5";

function luminance(hex: string): number {
  const channel = (i: number) => {
    const v = parseInt(hex.slice(1 + i * 2, 3 + i * 2), 16) / 255;
    return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
  };
  return 0.2126 * channel(0) + 0.7152 * channel(1) + 0.0722 * channel(2);
}
function contrast(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

describe("the committed templates are exactly what the generator produces", () => {
  it("node supabase/email-templates/build.mjs --check passes (a hand edit of a generated file fails here)", () => {
    expect(() => execFileSync(process.execPath, [join(DIR, "build.mjs"), "--check"], { stdio: "pipe" })).not.toThrow();
  });
});

describe.each(NAMES)("%s: the verification mechanism", (name) => {
  it("shows the one-time code once, as selectable text, in the HTML and the plain text", () => {
    const h = html(name);
    expect(h.split("{{ .Token }}")).toHaveLength(2);
    expect(txt(name).split("{{ .Token }}")).toHaveLength(2);
    expect(h).toMatch(/<div class="code"[^>]*>\{\{ \.Token \}\}<\/div>/); // a text node, never an image
    expect(h).toMatch(/\.code \{[^}]*user-select:all/);
  });

  it("keeps the confirmation link as the alternate action, as one real link", () => {
    const h = html(name);
    const hrefs = [...h.matchAll(/href="([^"]*)"/g)].map((m) => m[1]);
    expect(hrefs).toEqual(["{{ .ConfirmationURL }}"]);
    expect(txt(name).split("{{ .ConfirmationURL }}")).toHaveLength(2);
  });

  it("uses only the Supabase variables it is meant to use", () => {
    for (const body of [html(name), txt(name)]) {
      for (const variable of body.match(/\{\{[^}]*\}\}/g) ?? []) expect(ALLOWED_VARIABLES.has(variable), variable).toBe(true);
    }
  });

  it("never states or limits the code length (the project decides it: 8 digits in Production)", () => {
    for (const body of [html(name), txt(name), subjects["Confirm sign up"], subjects["Magic Link"]]) {
      expect(body).not.toMatch(/\b\d+\s*[- ]?\s*(d[ií]gitos?|digits?|caracteres)\b/i);
      expect(body).not.toMatch(/\b(cuatro|cinco|seis|siete|ocho|nueve|diez)\s+(d[ií]gitos?|n[uú]meros)\b/i);
      expect(body).not.toMatch(/maxlength|pattern=/i);
    }
  });
});

describe.each(NAMES)("%s: the required wording", (name) => {
  it("includes the required ignore sentence verbatim, the expiry, and the never-share warning", () => {
    for (const body of [html(name), txt(name)]) {
      expect(body).toContain("Si no lo solicitaste, podés ignorar este correo.");
      expect(body).toContain("vencen en 1 hora");
      expect(body).toContain("solo se pueden usar una vez");
      expect(body).toContain("Nunca compartás este código con nadie");
    }
  });

  it("is transactional: nothing promised that this product has not authorized, no marketing", () => {
    const forbidden = /cup[oó]n|oferta|descuento|gratis|premio|puntos|\bxp\b|recompensa|ganar|ganaste|promoci[oó]n|beneficio|suscr[ií]b|bolet[ií]n|newsletter|consentimiento|marketing|publicidad|sorteo|regalo/i;
    for (const body of [html(name), txt(name), subjects["Confirm sign up"], subjects["Magic Link"]]) {
      expect(body.replace(/<style[\s\S]*?<\/style>/g, "")).not.toMatch(forbidden);
    }
  });

  it("is Spanish and names URBANO Gaming", () => {
    expect(html(name)).toContain('<html lang="es"');
    expect(html(name)).toContain("URBANO Gaming");
  });

  it("speaks in voseo throughout, as Brandbook v2.0 requires, with no tú forms left", () => {
    for (const body of [html(name), txt(name), subjects["Confirm sign up"], subjects["Magic Link"]]) {
      expect(body).not.toMatch(/\b(ingresa|usa|prefieres|puedes|compartas|pides|respondas|copia|pega|escribe|verifica|confirma|entra|solicita)\b/i);
      expect(body).not.toMatch(/\b(ingreses|uses|pidas)\b/i); // tú subjunctives
    }
    for (const body of [html(name), txt(name)]) {
      for (const form of ["Ingresá", "Preferís", "podés", "compartás", "pedís", "respondás"]) expect(body, form).toContain(form);
    }
  });
});

describe("registration versus returning-user wording", () => {
  it("the confirm sign-up message thanks for starting registration and says the address is NOT yet verified", () => {
    for (const body of [html("confirmation"), txt("confirmation")]) {
      expect(body).toContain("Gracias por iniciar tu registro");
      expect(body).toContain("Tu correo aún no está verificado");
      expect(body).not.toMatch(/ya est[aá] verificad|fue verificad|verificaste|cuenta (ha sido )?creada|cuenta (ya )?est[aá] lista/i);
    }
  });

  it("the login message does not imply a new registration or a verification", () => {
    for (const body of [html("magic_link"), txt("magic_link"), subjects["Magic Link"]]) {
      expect(body).not.toMatch(/bienvenid|registro|registr|verific|nueva cuenta|cuenta nueva|crear/i);
    }
    expect(html("magic_link")).toContain("entrar a tu cuenta");
  });

  it("subjects are distinct, short enough for a phone, carry the brand, and map to the two Supabase templates", () => {
    expect(Object.keys(subjects).sort()).toEqual(["Confirm sign up", "Magic Link"]);
    expect(subjects["Confirm sign up"]).not.toBe(subjects["Magic Link"]);
    for (const s of Object.values(subjects)) {
      expect(s.length).toBeLessThanOrEqual(48);
      expect(s).toContain("URBANO Gaming");
      expect(s).not.toMatch(/\{\{|\d{4,}/); // never carries the code
    }
  });

  it("both messages share one skeleton: only the words differ", () => {
    const skeleton = (s: string) => s.replace(/>[^<]+</g, "><").replace(/\s+/g, " ").replace(/<title>.*?<\/title>/, "");
    expect(skeleton(html("confirmation"))).toBe(skeleton(html("magic_link")));
  });
});

describe.each(NAMES)("%s: email-safe markup and blocked images", (name) => {
  const h = () => html(name);

  it("is table-based with inline styles and no script, form, external stylesheet, web font or CSS layout that mail clients drop", () => {
    expect(h()).toMatch(/<table role="presentation"/);
    expect(h()).not.toMatch(/<script|<link |<form|<iframe|@import|@font-face|url\(|position:|display:flex|display:grid|float:/i);
    expect(h()).toMatch(/<meta name="viewport"/);
    expect(h()).toMatch(/<meta name="color-scheme" content="dark">/);
  });

  it("the only image is the logo: absolute HTTPS-by-site-url, with alt text, explicit width, and no local or insecure address", () => {
    const imgs = [...h().matchAll(/<img\b[^>]*>/g)].map((m) => m[0]);
    expect(imgs).toHaveLength(1);
    expect(imgs[0]).toContain(`src="${LOGO_URL}"`);
    expect(imgs[0]).toMatch(/alt="URBANO"/);
    expect(imgs[0]).toMatch(/width="200"/);
    expect(h()).not.toMatch(/file:|localhost|127\.0\.0\.1|http:\/\/|data:/i);
  });

  it("stays usable with images blocked: the Gaming context, headline, code and link are all text, and the logo's alt text is styled to read", () => {
    const withoutImages = h().replace(/<img\b[^>]*>/g, "");
    expect(withoutImages).toContain(">GAMING<");
    expect(withoutImages).toContain("{{ .Token }}");
    expect(withoutImages).toContain("{{ .ConfirmationURL }}");
    expect(h()).toMatch(/<img[^>]*alt="URBANO"[^>]*color:#F5F1E8/);
  });

  it("keeps readable contrast on every text and background pair it uses (WCAG AA, 4.5:1)", () => {
    const pairs: Array<[string, string]> = [
      ["#F5F1E8", "#161616"], // body text on the card
      ["#BDB7AC", "#161616"], // secondary text
      ["#9B9689", "#161616"], // footer text
      ["#0A0A0A", "#F5F1E8"], // the code on its ivory box
      ["#B57CFF", "#1B1530"], // the GAMING context tag
    ];
    for (const [fg, bg] of pairs) {
      expect(h().toUpperCase()).toContain(fg.toUpperCase());
      expect(contrast(fg, bg), `${fg} on ${bg}`).toBeGreaterThanOrEqual(4.5);
    }
  });

  it("uses gold as an accent rule only, never as text (Brandbook: the letter is never gold)", () => {
    expect(h()).not.toMatch(/[^-]color:\s*#D4AF37/i);
    expect(h()).toMatch(/bgcolor="#D4AF37"/);
  });

  it("is small enough that no mail client clips it", () => {
    expect(Buffer.byteLength(h())).toBeLessThan(40_000);
  });
});

describe.each(NAMES)("%s: plain-text equivalent", (name) => {
  it("carries the same facts without markup", () => {
    expect(txt(name)).not.toMatch(/<[a-z!/]/i);
    expect(txt(name)).toContain("URBANO GAMING");
    expect(txt(name)).toContain("{{ .Token }}");
  });
});

describe("the logo asset and its publication in source", () => {
  const asset = join(DIR, "assets", "urbano-lockup-email.png");

  it("keeps an email-sized PNG export next to the templates", () => {
    expect(existsSync(asset)).toBe(true);
    const bytes = readFileSync(asset);
    expect(bytes.subarray(0, 8).toString("hex")).toBe("89504e470d0a1a0a"); // PNG signature
    expect(bytes.readUInt32BE(16)).toBeLessThanOrEqual(1000); // width in px
    expect(statSync(asset).size).toBeLessThan(100_000);
  });

  it("publishes it from source: public/email holds the approved PNG, byte-identical to the asset, and nothing else", () => {
    const published = join(ROOT, "public", "email", "urbano-lockup-email.png");
    expect(existsSync(published)).toBe(true);
    const bytes = readFileSync(published);
    expect(bytes.equals(readFileSync(asset))).toBe(true);
    expect(createHash("sha256").update(bytes).digest("hex")).toBe(APPROVED_LOGO_SHA256);
    expect(readdirSync(join(ROOT, "public", "email"))).toEqual(["urbano-lockup-email.png"]);
  });

  it("sits exactly where the templates ask for it: {{ .SiteURL }} plus the logo path resolves to a file under public/", () => {
    const requested = LOGO_URL.replace("{{ .SiteURL }}", "");
    expect(requested).toBe("/email/urbano-lockup-email.png");
    expect(existsSync(join(ROOT, "public", requested))).toBe(true);
  });
});
