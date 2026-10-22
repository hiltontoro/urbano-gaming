#!/usr/bin/env node
// Builds the URBANO Gaming authentication email templates from one skeleton, so the
// two messages can only differ in their words (same code, same link, same layout).
//
//   node supabase/email-templates/build.mjs            write the committed files here
//   node supabase/email-templates/build.mjs --check    fail if the committed files are stale
//   node supabase/email-templates/build.mjs --register=tu --out=<dir>
//                                                      write the tú variant elsewhere (the default is voseo)
//
// Output per template: <name>.html (the Supabase template body), <name>.txt (plain-text
// equivalent), and subjects.json. Supabase Go-template variables are left in place:
//   {{ .Token }}            the one-time code, any length the project issues
//   {{ .ConfirmationURL }}  the alternate access link (same token as the code)
//   {{ .SiteURL }}          the project's Auth site URL, used to address the logo
//   {{ .Email }}            the recipient address
// No code length is written anywhere: the project decides it (8 digits in Production).

import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));

// Brandbook v2.0 palette (carbón / marfil / dorado) plus the app's card tokens. Gold is
// used for the single accent rule only, never for letters. Purple appears only on the
// small GAMING context tag, as the live app header does (#B57CFF text, #7C3AED border).
const C = {
  carbon: "#0A0A0A",
  card: "#161616",
  line: "#2A2A2A",
  ivory: "#F5F1E8",
  muted: "#BDB7AC",
  faint: "#9B9689",
  gold: "#D4AF37",
  purple: "#7C3AED",
  purpleSoft: "#B57CFF",
  purpleTint: "#1B1530",
};
const FONT = "Montserrat,'Segoe UI','Helvetica Neue',Helvetica,Arial,sans-serif";

// Where the logo is expected. {{ .SiteURL }} resolves per environment (the rehearsal's
// local site in the rehearsal, the Production site URL in Production). The PNG must be
// published at this path by a deployment; it is NOT published by this change.
export const LOGO_PATH = "/email/urbano-lockup-email.png";
const LOGO_SRC = "{{ .SiteURL }}" + LOGO_PATH;

// Spanish. The controlling Brandbook (v2.0, "premium, corto, en voseo") sets the voice, so the
// default register is voseo, used throughout (the Founder confirmed that an earlier example
// sentence in tú was not an override of the brand voice). A tú variant stays available
// (--register=tu) for comparison only. Pairs are [tu, voseo]; where a form is the same in both
// (preterite, infinitive, possessive "tu", object pronoun "te") one string is used.
const REGISTERS = ["tu", "voseo"];
export const DEFAULT_REGISTER = "voseo";
const pick = (reg, pair) => (typeof pair === "string" ? pair : pair[reg === "voseo" ? 1 : 0]);

const SHARED = {
  linkIntro: ["¿Prefieres usar un enlace?", "¿Preferís usar un enlace?"],
  expiry: [
    "El código y el enlace vencen en 1 hora y solo se pueden usar una vez. Si pides otro código, el anterior deja de funcionar.",
    "El código y el enlace vencen en 1 hora y solo se pueden usar una vez. Si pedís otro código, el anterior deja de funcionar.",
  ],
  share: [
    "Nunca compartas este código con nadie. El equipo de URBANO no te lo pedirá.",
    "Nunca compartás este código con nadie. El equipo de URBANO no te lo pedirá.",
  ],
  ignore: ["Si no lo solicitaste, puedes ignorar este correo.", "Si no lo solicitaste, podés ignorar este correo."],
  footerBrand: "URBANO Gaming · Una experiencia URBANO",
  tagline: "ACCESS | EXPERIENCES | COMMUNITY",
  powered: "Powered by TecnoMovi",
  sentTo: ["Enviado a {{ .Email }}. Mensaje automático de seguridad: no respondas a este correo.", "Enviado a {{ .Email }}. Mensaje automático de seguridad: no respondás a este correo."],
  logoAlt: "URBANO",
  tag: "GAMING",
};

export const TEMPLATES = {
  // Supabase "Confirm sign up": a NEW address starting registration.
  confirmation: {
    supabaseName: "Confirm sign up",
    subject: "Tu código de verificación · URBANO Gaming",
    preheader: ["Gracias por iniciar tu registro. Usa este código para verificar tu correo.", "Gracias por iniciar tu registro. Usá este código para verificar tu correo."],
    eyebrow: "Verificación de correo",
    heading: "Te damos la bienvenida a URBANO Gaming",
    lead: "Gracias por iniciar tu registro. Tu correo aún no está verificado: quedará verificado al ingresar el código o usar el enlace.",
    codeLabel: "Código de verificación",
    instruction: ["Ingresa este código en la pantalla de URBANO Gaming donde iniciaste tu registro.", "Ingresá este código en la pantalla de URBANO Gaming donde iniciaste tu registro."],
    button: "Verificar con este enlace",
  },
  // Supabase "Magic Link": an address that already has an account asking for a code.
  magic_link: {
    supabaseName: "Magic Link",
    subject: "Tu código de acceso · URBANO Gaming",
    preheader: ["Usa este código para entrar a tu cuenta de URBANO Gaming.", "Usá este código para entrar a tu cuenta de URBANO Gaming."],
    eyebrow: "Acceso a tu cuenta",
    heading: "Tu código de acceso",
    lead: "Se solicitó un código para entrar a tu cuenta de URBANO Gaming.",
    codeLabel: "Código de acceso",
    instruction: ["Ingresa este código en la pantalla donde pediste el acceso.", "Ingresá este código en la pantalla donde pediste el acceso."],
    button: "Entrar con este enlace",
  },
};

const text = (reg, v) => pick(reg, v);

function renderHtml(name, reg) {
  const t = TEMPLATES[name];
  const s = (k) => text(reg, SHARED[k]);
  const p = (k) => text(reg, t[k]);
  const para = (content, extra = "") =>
    `<p style="margin:0 0 14px 0;font-family:${FONT};font-size:16px;line-height:24px;color:${C.ivory};${extra}">${content}</p>`;
  const small = (content) =>
    `<p style="margin:0 0 8px 0;font-family:${FONT};font-size:14px;line-height:21px;color:${C.muted};">${content}</p>`;

  return `<!DOCTYPE html>
<html lang="es">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="X-UA-Compatible" content="IE=edge">
<meta name="x-apple-disable-message-reformatting">
<meta name="format-detection" content="telephone=no, date=no, address=no, email=no, url=no">
<meta name="color-scheme" content="dark">
<meta name="supported-color-schemes" content="dark">
<title>${t.subject}</title>
<style type="text/css">
  body, table, td, a { -webkit-text-size-adjust:100%; -ms-text-size-adjust:100%; }
  table, td { mso-table-lspace:0pt; mso-table-rspace:0pt; }
  img { -ms-interpolation-mode:bicubic; border:0; outline:none; text-decoration:none; }
  a[x-apple-data-detectors] { color:inherit !important; text-decoration:none !important; font-size:inherit !important; font-family:inherit !important; font-weight:inherit !important; line-height:inherit !important; }
  u + #body a { color:inherit; text-decoration:none; font-size:inherit; font-family:inherit; font-weight:inherit; line-height:inherit; }
  .code { -webkit-user-select:all; -moz-user-select:all; user-select:all; }
  @media only screen and (max-width: 480px) {
    .px { padding-left:20px !important; padding-right:20px !important; }
    .h1 { font-size:24px !important; line-height:30px !important; }
    .code { font-size:28px !important; letter-spacing:4px !important; }
  }
</style>
</head>
<body id="body" style="margin:0;padding:0;width:100%;background-color:${C.carbon};">
<div style="display:none;max-height:0;overflow:hidden;mso-hide:all;font-size:1px;line-height:1px;color:${C.carbon};opacity:0;">${p("preheader")}&#847;&zwnj;&nbsp;&#847;&zwnj;&nbsp;&#847;&zwnj;&nbsp;&#847;&zwnj;&nbsp;&#847;&zwnj;&nbsp;</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" bgcolor="${C.carbon}" style="background-color:${C.carbon};">
<tr><td align="center" style="padding:24px 12px;">
  <table role="presentation" width="560" cellpadding="0" cellspacing="0" border="0" bgcolor="${C.card}" style="width:100%;max-width:560px;background-color:${C.card};border:1px solid ${C.line};border-radius:14px;">
    <tr><td class="px" style="padding:28px 32px 8px 32px;">
      <img src="${LOGO_SRC}" width="200" height="51" alt="${s("logoAlt")}" style="display:block;width:200px;height:auto;border:0;font-family:${FONT};font-size:24px;line-height:30px;font-weight:700;letter-spacing:3px;color:${C.ivory};">
      <table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin-top:12px;"><tr>
        <td bgcolor="${C.purpleTint}" style="background-color:${C.purpleTint};border:1px solid ${C.purple};border-radius:999px;padding:4px 10px;font-family:${FONT};font-size:11px;line-height:14px;font-weight:700;letter-spacing:1.5px;color:${C.purpleSoft};">${s("tag")}</td>
      </tr></table>
    </td></tr>
    <tr><td class="px" style="padding:20px 32px 0 32px;">
      <table role="presentation" width="40" cellpadding="0" cellspacing="0" border="0"><tr><td height="2" bgcolor="${C.gold}" style="height:2px;line-height:2px;font-size:2px;background-color:${C.gold};">&nbsp;</td></tr></table>
    </td></tr>
    <tr><td class="px" style="padding:20px 32px 0 32px;">
      <p style="margin:0 0 8px 0;font-family:${FONT};font-size:12px;line-height:16px;font-weight:700;letter-spacing:2px;text-transform:uppercase;color:${C.muted};">${p("eyebrow")}</p>
      <h1 class="h1" style="margin:0 0 14px 0;font-family:${FONT};font-size:26px;line-height:32px;font-weight:700;color:${C.ivory};">${p("heading")}</h1>
      ${para(p("lead"))}
    </td></tr>
    <tr><td class="px" style="padding:6px 32px 0 32px;">
      <p style="margin:0 0 8px 0;font-family:${FONT};font-size:12px;line-height:16px;font-weight:700;letter-spacing:2px;text-transform:uppercase;color:${C.muted};">${p("codeLabel")}</p>
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"><tr>
        <td align="center" bgcolor="${C.ivory}" style="background-color:${C.ivory};border-radius:10px;padding:16px 12px;">
          <div class="code" style="font-family:${FONT};font-size:32px;line-height:40px;font-weight:700;letter-spacing:6px;color:${C.carbon};white-space:nowrap;">{{ .Token }}</div>
        </td>
      </tr></table>
      <p style="margin:14px 0 0 0;font-family:${FONT};font-size:16px;line-height:24px;color:${C.ivory};">${p("instruction")}</p>
    </td></tr>
    <tr><td class="px" style="padding:24px 32px 0 32px;">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"><tr><td height="1" bgcolor="${C.line}" style="height:1px;line-height:1px;font-size:1px;background-color:${C.line};">&nbsp;</td></tr></table>
    </td></tr>
    <tr><td class="px" style="padding:20px 32px 0 32px;">
      ${para(s("linkIntro"), "margin-bottom:10px;")}
      <table role="presentation" cellpadding="0" cellspacing="0" border="0"><tr>
        <td align="center" style="border:1px solid ${C.ivory};border-radius:8px;">
          <a href="{{ .ConfirmationURL }}" style="display:inline-block;padding:12px 22px;font-family:${FONT};font-size:14px;line-height:20px;font-weight:700;color:${C.ivory};text-decoration:none;">${p("button")}</a>
        </td>
      </tr></table>
    </td></tr>
    <tr><td class="px" style="padding:24px 32px 0 32px;">
      ${small(s("expiry"))}
      ${small(s("share"))}
      ${small(s("ignore"))}
    </td></tr>
    <tr><td class="px" style="padding:20px 32px 28px 32px;">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"><tr><td height="1" bgcolor="${C.line}" style="height:1px;line-height:1px;font-size:1px;background-color:${C.line};">&nbsp;</td></tr></table>
      <p style="margin:16px 0 4px 0;font-family:${FONT};font-size:12px;line-height:18px;color:${C.faint};">${s("footerBrand")}</p>
      <p style="margin:0 0 4px 0;font-family:${FONT};font-size:11px;line-height:16px;letter-spacing:1.5px;color:${C.faint};">${s("tagline")}</p>
      <p style="margin:0 0 10px 0;font-family:${FONT};font-size:11px;line-height:16px;color:${C.faint};">${s("powered")}</p>
      <p style="margin:0;font-family:${FONT};font-size:11px;line-height:16px;color:${C.faint};">${s("sentTo")}</p>
    </td></tr>
  </table>
</td></tr>
</table>
</body>
</html>
`;
}

function renderText(name, reg) {
  const t = TEMPLATES[name];
  const s = (k) => text(reg, SHARED[k]);
  const p = (k) => text(reg, t[k]);
  return `URBANO GAMING

${p("heading")}

${p("lead")}

${p("codeLabel").toUpperCase()}: {{ .Token }}

${p("instruction")}

${s("linkIntro")}
${p("button")}: {{ .ConfirmationURL }}

- ${s("expiry")}
- ${s("share")}
- ${s("ignore")}

--
${s("footerBrand")}
${s("tagline")}
${s("powered")}
${s("sentTo")}
`;
}

export function render(name, register = DEFAULT_REGISTER) {
  if (!TEMPLATES[name]) throw new Error(`unknown template ${name}`);
  if (!REGISTERS.includes(register)) throw new Error(`unknown register ${register}`);
  return { html: renderHtml(name, register), text: renderText(name, register), subject: TEMPLATES[name].subject };
}

export function renderAll(register = DEFAULT_REGISTER) {
  const files = {};
  const subjects = {};
  for (const name of Object.keys(TEMPLATES)) {
    const out = render(name, register);
    files[`${name}.html`] = out.html;
    files[`${name}.txt`] = out.text;
    subjects[TEMPLATES[name].supabaseName] = out.subject;
  }
  files["subjects.json"] = JSON.stringify(subjects, null, 2) + "\n";
  return files;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const args = Object.fromEntries(
    process.argv.slice(2).map((a) => {
      const [key, value] = a.replace(/^--/, "").split("=");
      return [key, value === undefined ? true : value];
    })
  );
  const register = args.register || DEFAULT_REGISTER;
  const files = renderAll(register);
  if (args.check) {
    const stale = Object.entries(files).filter(([f, body]) => !existsSync(join(HERE, f)) || readFileSync(join(HERE, f), "utf8") !== body).map(([f]) => f);
    if (stale.length) {
      console.error("stale or missing: " + stale.join(", ") + "  (run: node supabase/email-templates/build.mjs)");
      process.exit(1);
    }
    console.log("email templates are up to date");
  } else {
    const out = args.out ? String(args.out) : HERE;
    mkdirSync(out, { recursive: true });
    for (const [f, body] of Object.entries(files)) writeFileSync(join(out, f), body);
    console.log(`wrote ${Object.keys(files).length} files (${register}) to ${out}`);
  }
}
