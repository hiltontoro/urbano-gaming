# URBANO Gaming — branded authentication emails (Spanish, voseo)

Status: **prepared for review. Nothing here is installed in Production, and no asset is published.** The templates run only in the
isolated local rehearsal. Publishing the logo and installing the templates in Production are one proposed release package
(section 3), and each of its steps needs its own approval.

| File | What it is |
| --- | --- |
| `confirmation.html` / `.txt` | Supabase **Confirm sign up**: a NEW address starting registration |
| `magic_link.html` / `.txt` | Supabase **Magic Link**: an address that already has an account asking for a code |
| `subjects.json` | The two subject lines, keyed by Supabase template name |
| `build.mjs` | Generates all of the above from one skeleton: `node supabase/email-templates/build.mjs`, `--check`, `--register=tu --out=<dir>` |
| `assets/urbano-lockup-email.png` | Email-sized PNG of the official lockup (520×133, 20,147 bytes, transparent, SHA-256 `072982b3fd0051557fb87b0e7e0826bd86c5ed1975d8982ac178bf7b7b2d95b5`). Kept here; **not** under `public/` |

Do not edit the generated files by hand: `__tests__/authEmailTemplates.test.ts` runs `build.mjs --check` and fails on drift. The same
test pins the contract in section 2.

## 1. Which brand source controls (reconciled, not assumed)

| Source | Status found | Used for |
| --- | --- | --- |
| **Brandbook v2.0**, file `Constitutional Docs/Brandbook/Brandbook v2.pdf` (its cover reads "Brandbook v2.0") | **Controlling doctrine.** Frozen in the constitutional baseline v1.0 (`9fa0e23`, 2026-08-06) | Palette (carbón `#0A0A0A`, marfil `#F5F1E8`, dorado `#D4AF37`; "la letra nunca es dorada"), Montserrat, the horizontal lockup, the lexicon (no "cupón / oferta / descuento"), "premium, corto, **en voseo**" |
| `MANUAL-DE-MARCA.pdf` (v1.0, 2026-07-10) | Predecessor, same rules. It names the horizontal lockup as the primary variant for headers, footers and "firma de correo" | Confirms the lockup is the right asset for an email header |
| `URBANO_Brandbook_v2.0_Constitutional_Library.pdf`, `…v2.1_Constitutional_Library.pdf`, `…v2.1_Editorial_Body.pdf` (2026-08-24) | **Distribution editions**, not new doctrine. The v2.1 build script takes `Brandbook v2.pdf` as its source, the Editorial Body says it "preserves the authority and principles of v2.0", and `Urbano/README.md` says editions "do not supersede source doctrine". The higher filename (v2.1) is not a newer rule set | Not used as a rule source |
| `Urbano Gaming/Product/Brandbook/URBANO Gaming Brandbook v1.0.pdf` (2026-10-19) | **Product-lane application identity, untracked in git.** It says it is subordinate to Brandbook v2.0 and cites a Founder decision I could not verify; `Product/README.md` says that folder "cannot create an independent URBANO Gaming Brandbook". Treat its authority as **unconfirmed** until Canon ratifies it | Only where it agrees with the live app header: the GAMING context tag colors (`#B57CFF` text, `#7C3AED` border), and the hierarchy (parent dominates, Gaming identifies, "Powered by TecnoMovi" small). Its pixel Gaming lockups are **not** used: the Founder asked for the parent identity with Gaming context |

Logo: `Logos/urbano-logo.svg` and `urbano-mark.svg` are the **symbol** (U with the gold dot; one transparent, one on black). The horizontal
lockup master `urbano-lockup-horizontal.svg` that the Brandbook names is **not in the repository**. The header image is the official
lockup artwork on the Brandbook v2.0 cover, rasterized at 300 dpi and separated from its flat carbón background into a transparent PNG
(two-color fit, mean residual 0.5%). That is a technical export, not a redraw. The brand owner should replace it with an export from
the master when one is available.

**Voice: voseo, used consistently.** Brandbook v2.0 sets the voice ("premium, corto, en voseo") and the Founder confirmed that the
earlier example sentence in *tú* was not an override of it. All copy is therefore voseo: *Ingresá, Usá, Preferís, compartás, pedís,
podés, respondás*; verbs that are the same in both registers (preterite, infinitive) and possessive "tu" are unchanged. The required
sentence reads "Si no lo solicitaste, **podés** ignorar este correo." A *tú* variant remains available for comparison only
(`build.mjs --register=tu --out=<dir>`); the contract test fails if any *tú* form reaches the committed files.

## 2. What the messages do

- **One mechanism, both messages.** `{{ .Token }}` is large, ivory-on-carbón text in a single box (selectable, `user-select:all`, readable
  at 6 to 10 digits, no length written anywhere; Production issues 8). `{{ .ConfirmationURL }}` is the one alternate action (an outlined
  button). Same layout, same security lines; the test compares the two skeletons.
- **Registration** says "Gracias por iniciar tu registro" and "Tu correo **aún no está verificado**: quedará verificado al ingresar el
  código o usar el enlace". **Login** says "Se solicitó un código para entrar a tu cuenta" and never uses registration or verification
  wording.
- **Both messages:** "Si no lo solicitaste, podés ignorar este correo." / "El código y el enlace vencen en 1 hora y solo se pueden usar
  una vez. Si pedís otro código, el anterior deja de funcionar." / "Nunca compartás este código con nadie. El equipo de URBANO no te lo
  pedirá." The "1 hora" is Production's `otp_expiry = 3600 s` (read 2026-10-22); if that setting changes, change the sentence. "Si pedís
  otro código, el anterior deja de funcionar" was checked on the real local Auth.
- **Transactional only:** no benefits, points, prizes, discounts or marketing consent; the test rejects those words.
- **Images blocked:** the logo is the only image; its alt text ("URBANO") is styled to read as a wordmark, and the GAMING tag, headline,
  code and button are all text.
- **Subjects:** `Tu código de verificación · URBANO Gaming` (registration), `Tu código de acceso · URBANO Gaming` (login). Neither contains
  the code.
- **Plain text:** `.txt` files are provided and tested, but **Supabase's template field takes one HTML body and sends HTML only**
  (confirmed on the local Auth). The text versions are for accessibility review and a future custom sender; they are not delivered.
- **Fonts and dark mode:** Montserrat first, then Segoe UI / Helvetica / Arial; no web font is loaded. The design is already dark
  (`color-scheme: dark`) and every text/background pair is tested at 4.5:1 or better.

## 3. Proposed release package (NOT performed)

One package, two parts that depend on each other. Nothing in it is authorized yet. Part A is a deployment, Part B is a Production Auth
configuration change; they need separate approvals and must happen in this order, because the templates point at a file Part A creates.

### Part A: logo hosting (a one-file change to the app, shipped by a deployment)

| | |
| --- | --- |
| **File to add** | `public/email/urbano-lockup-email.png`, byte-identical to `supabase/email-templates/assets/urbano-lockup-email.png` (20,147 bytes, SHA-256 above) |
| **How** | `mkdir -p public/email && cp supabase/email-templates/assets/urbano-lockup-email.png public/email/urbano-lockup-email.png`, committed and deployed through the project's normal release gate. No code, route, header or config change. |
| **Test change that ships with it** | `__tests__/authEmailTemplates.test.ts`, last test: today it asserts `public/email` does **not** exist (the publication guard). In the release commit, replace that assertion with one that `public/email/urbano-lockup-email.png` exists and is byte-identical to the asset. |
| **Resulting public URL** | `https://urbano-gaming-playtest.vercel.app/email/urbano-lockup-email.png`. Production's Auth site URL is `https://urbano-gaming-playtest.vercel.app` (read 2026-10-22), and the templates address the logo as `{{ .SiteURL }}/email/urbano-lockup-email.png`. |
| **Today** | HTTP 404 (checked 2026-10-22). The only logo served now is `/urbano-mark.svg`, which Gmail and Outlook do not render. |
| **Verify after deploy** | `curl -sI https://urbano-gaming-playtest.vercel.app/email/urbano-lockup-email.png` returns `200` and `content-type: image/png`, and the PNG opens. |
| **Preview deployments** | Previews use the same Supabase project, so any email they trigger also addresses the logo at the Production site URL; they never serve it themselves. |
| **Alternative** | A different host is a one-line change (`LOGO_SRC` in `build.mjs`, regenerate, update the test). Decide before Part B. |

If the logo is not yet public, the messages still work (the lockup falls back to the word "URBANO", and the GAMING tag, code and button
are text). That is a valid fallback for a test, not for the final release.

### Part B: Production templates (a manual Auth configuration change by the account owner)

Prerequisite: Part A deployed and verified, or an explicit decision to test without the logo.

1. **Save the current Production templates and subjects** (copy them out of the dashboard) so they can be restored.
2. Dashboard, project **URBANO Gaming** → **Authentication → Emails → Templates**:

   | Template | Subject | Body |
   | --- | --- | --- |
   | **Confirm sign up** | `Tu código de verificación · URBANO Gaming` | the whole of `confirmation.html` |
   | **Magic Link** | `Tu código de acceso · URBANO Gaming` | the whole of `magic_link.html` |

   Save each. (Subjects are also in `subjects.json`.)
3. Equivalent API fields, for the account owner only: `mailer_subjects_confirmation`, `mailer_templates_confirmation_content`,
   `mailer_subjects_magic_link`, `mailer_templates_magic_link_content` (Management API `PATCH …/config/auth`). Do **not** use
   `supabase config push`: it sends the whole configuration and could overwrite unrelated Production settings.
4. **Nothing else changes:** not the sender, SMTP, domains, rate limits, code length (8), expiry (1 hour), site URL or redirect list.

### Verification, in order

1. After Part A: the logo URL check above.
2. After Part B, in the dashboard, confirm both templates saved (open each and compare the first and last lines).
3. **Returning-user login (the Founder-authorized Hotmail address: an existing, confirmed account with a Gaming Member):** one request on
   the Production sign-in; the **Magic Link** message arrives branded; the code is accepted. Logging in creates nothing. The Founder
   enters the code; it is never pasted into chat.
4. **Registration:** needs a different, unused Founder-owned address (a registration request for an existing address is answered with the
   Magic Link message, not Confirm sign up). The address is requested only when this step is reached. Registration creates one confirmed
   `auth.users` row and **no Gaming Member** provided the display-name step is not completed.
5. For each message record (never the code, never the link): request time and arrival time; **inbox or junk (recorded as an observation, not a
   pass criterion: see section 5)**; the From shown; the subject;
   whether the lockup, GAMING tag, code box and button render; the code length (expect 8) and that it is accepted; and once, that the
   button signs the person in and lands on the Home page. Check Resend's log (delivered, no bounce) and Supabase's Auth log (no SMTP
   error).
6. **Pass** means: it arrives, the lockup/tag/code/button render as previewed, the 8-digit code is accepted, and nothing is mislabelled. It does
   not mean "lands in the Inbox"; whether the filtering outcome differs from the unbranded message is something to measure, not assume.
7. The button link can be used once per message, and using it spends the code too, so test the code first and use a second request for
   the link. Production allows one request per address per 60 s and 30 emails per hour; do not retry in a loop.

### Rollback

**Templates (Part B).** Restore both templates from the copies saved in step B1: Authentication → Emails → Templates, **Confirm sign up** and
**Magic Link**, re-paste each saved subject and body, Save. Either template can be rolled back independently, and rollback takes effect for
the next message sent (a message already sent keeps the template it was sent with). Nothing else was changed by Part B, so nothing else
needs restoring.

- **Magic Link:** the delivered 2026-10-22 message reads exactly like the plain template kept untracked in the original checkout
  (`supabase/templates/magic_link.html`, 302 bytes, SHA-256 `bdcc31ae…05f8cc`; subject `Your URBANO Gaming sign-in code`). That makes it a
  probable copy of what is installed. It is **not** the rollback source: the copy saved from the dashboard is. Use the repository file
  only to cross-check what was saved.
- **Confirm sign up:** the installed content has not been read by anyone. It must be saved from the dashboard before it is replaced; there
  is no other copy.

**Logo (Part A).** The PNG is inert once the templates are reverted: with the old templates nothing requests it. It can stay deployed or be
removed in a later release. If it is removed while the branded templates are still installed, those messages fall back to the "URBANO" text
and the GAMING tag (they remain usable).

**Order for a rollback:** revert the templates first, then, only if wanted, remove the file.

### Approvals this package needs (none given)

(1) The commit of this package's files (see the commit scope kept with the review materials; nothing is staged or committed), (2) Part A
deployment, (3) Part B installation by the account owner, (4) the registration-test address and any further send. Authorization given so
far covers one existing-account login send with the templates **currently installed** (done; code acceptance unconfirmed), not this package.

## 4. Local rehearsal (done)

Only the isolated rehearsal was configured: `stack/supabase/config.toml` has both templates and subjects, and was set to Production-like
email settings (`enable_confirmations = true`, `otp_length = 8`) so the Confirm sign up path is exercised. The logo PNG is served by the
rehearsal app only. The source checkout's untracked `supabase/templates/` and `supabase/config.toml` were not touched.

## 5. Known limits

- **Inbox placement is not promised.** The one Production message observed so far (the installed, unbranded login template, 2026-10-22) reached a Hotmail mailbox in the same minute but was filed as **Junk** with SPF, DKIM and DMARC all passing and Microsoft SCL 5; the filtering cause is unknown (`SCORE_PREDICTIONS_PRODUCTION_INSPECTION.md`). These templates change the message, not the sender; they are not evidence of improved placement, and the post-install test records placement as an observation, not a pass criterion.
- The link opens the **Home** page signed in, not the match or action the person came from (the sign-in screen carries that intent; the
  emailed link does not). Changing it means passing an `emailRedirectTo` from the shared sign-in code, which this change does not do.
- Mail-security scanners that fetch links can spend a single-use link before the person does. That is why the code leads and the link is
  the alternate.
- Montserrat is used only where installed; most mail clients will show the fallback (Helvetica/Arial).
- Outlook for Windows ignores rounded corners; the layout stays intact.
