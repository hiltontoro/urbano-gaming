# Score Predictions — Account Entry, Phone OTP Readiness and Profile Direction

Status: **candidate, local only, uncommitted.** Nothing here was deployed or staged. No real SMS or email was sent, no
provider or Production setting was changed, and no account was purchased or created. The only Production access was the
read-only inspection recorded in `SCORE_PREDICTIONS_PRODUCTION_INSPECTION.md` (Production configuration and catalog were
read, nothing was written; its section 0 discloses one CLI side effect). Written for Code Review.

Sections 1–2 describe code that exists in this candidate. Sections 3–5 are **research and proposals only**: nothing in
them is implemented, and nothing in them is authorized until the Founder or Canon says so.

## 1. What changed (account entry)

Accepted direction: `Enter URBANO → Log in / Create account → Email / Phone → Verify → Continue the intended action.`
Email and phone are alternatives; neither journey requires both.

| Behavior | Where |
| --- | --- |
| Explicit **Log in** and **Create account** choices, then an **Email** or **Phone** choice | `public/urbanoAuth.js` (`createSignInPanel`) |
| Login never creates an account (`shouldCreateUser:false`) and **does not reveal whether one exists**: a known and an unknown address get the same code screen, "If X has an account, a code is on its way…", which does not claim a delivery. That screen offers **Create an account instead**, keeping what was typed | `urbanoAuth.js` (`requestCode`, `renderCode`) |
| Create account verifies control of the address **before** the Gaming Member exists; the display-name step comes after verification | `urbanoAuth.js` (`verifyCode`, `completeProfile`) |
| Registering with an address that already has an account becomes a visible **Welcome back** login — no second Gaming Member | `urbanoAuth.js` |
| Code-delivery instructions that never state a code length (Production issues 8 digits, local 6), **Resend** (60 s cooldown, matching the Production per-user window; server `retry after` honored), **Change address/number**, wrong/expired code, rate-limit, network and unavailable states | `urbanoAuth.js` |
| Double-click and slow-reply safety: busy lock on send/verify/continue, flow id drops answers from an abandoned attempt | `urbanoAuth.js` |
| **Phone is offered only when the deployment declares it.** Client reads `/api/gaming/auth-methods` and fails closed; phone requests are refused client-side when unavailable (nothing is sent, no success is simulated). The flag is a declaration, not evidence of delivery (see "Declared versus delivered") | `app/api/gaming/auth-methods/route.ts`, `urbanoAuth.js` |
| E.164 normalization with no country guessing (`00` → `+`; `^\+[1-9]\d{6,14}$`) | `urbanoAuth.js` (`normalizePhone`) |
| `onIdentityChange(cb)`: fires only when status / auth user / Gaming Member actually changes (not on token refresh or tab refocus) | `urbanoAuth.js` |
| Intent preserved across the flow (`{kind:"predict", matchId}`, sessionStorage, 30 min expiry, cleared on sign-out) | `urbanoAuth.js`, `soccer-predictions.html` |
| Participant page updates itself right after verification (no manual reload), clears the previous member's data on sign-out or identity switch, drops stale slow renders, resumes the intended match | `public/soccer-predictions.html` |

Root cause of the "refresh needed" report: the page rendered once and never listened for authentication changes. That
was baseline behavior, not something introduced by earlier gates.

Availability switch: `URBANO_PHONE_OTP_ENABLED` must be exactly the string `true`. Default is off. It is a **display
and request gate only**. It does not configure Supabase; turning it on without a configured provider would fail at the
backend with an honest "unavailable" error, but it must not be set before section 3's steps are done.

**Declared versus delivered.** Three different things must not be confused:

| Level | Meaning | Evidence today |
| --- | --- | --- |
| **Declared** | The deployment says a method exists. `/api/gaming/auth-methods` returns `email: true` (a constant) and `phone` from the flag above. The route probes nothing, and a test pins that. Supabase's own settings can also declare a provider on. | Email: declared. Production has custom SMTP configured (see `SCORE_PREDICTIONS_PRODUCTION_INSPECTION.md`). Phone: not declared; the Production SMS provider is off. |
| **Accepted** | The backend answered a code request with success. That means the request was accepted, not that anything arrived. The panel's wording after a send is therefore conditional or says "sent", never "delivered". | Exercised locally only. |
| **Delivered** | A real message reached a real mailbox or handset, and the code verified. Only a recorded test on a real device establishes this. | **None for either method.** Local email reached the local inbox, which is not evidence about Production or a real provider. |

Neither flag in `/api/gaming/auth-methods` is delivery evidence, and no screen may be read as promising delivery.

Why a new route and not `/api/gaming/config`: that route's contract (URL and anon key only) is pinned by
`__tests__/competitions.test.ts` and `__tests__/gamingConfigRoute.test.ts`, which belong to another lane. A first
attempt that extended it broke the Competitions test and was **reverted**; availability moved to its own route.

**Account existence (corrected).** An earlier version of this document said that revealing whether an address has an account
was an unavoidable consequence of keeping Log in and Create account separate. That was wrong. Separate screens do not require
a different answer: the component asks Supabase not to create a user, treats the backend's "no such user" reply as if the request
had been accepted, and shows the same code screen either way (a test compares the two screens, control for control, and a
negative control showed the test fails if the old behavior returns; the real local Auth was checked too: an unknown address
created no user and sent no email, a known one sent one and showed the identical screen).
What this does **not** cover: Supabase Auth itself. A caller who skips this component and asks Supabase to log in without
creating a user still receives different replies for a known and an unknown address (the unknown one is HTTP 422
`otp_disabled`, observed on the local stack), and a repeated request for a known address inside the 60 s window returns a rate-limit
reply an unknown one never does. Hiding that needs a server-side route in front of Auth with a uniform reply and its own
rate limit. It is **not** built, and would be a shared-auth change beyond this gate; Canon can decide whether it is needed.

Shared-consumer exposure: `public/urbanoAuth.js` is loaded by 13 pages (`index`, `participant`, `trivia-playtest`,
`quiz-playtest`, `poker-table`, `rewards`, `leaderboards`, `competitions`, `competitions-admin`,
`host-applications-admin`, `become-a-host`, `predictions-admin`, `soccer-predictions`) plus `competitionsIntent.js`.
The old API (`requestOtp`, `verifyOtp`, `onAuthStateChange`, `attachSignInButton`, `getState`, `completeProfile`,
`signOut`, `getAccessToken`) is preserved with its old semantics and has a backward-compatibility test. Two visible
differences for every consumer: the button now opens the Log in / Create account panel, and **a signed-in user clicking
their own name no longer reopens the login panel** (it is now a no-op until a profile panel exists, section 4).

## 2. Local validation (all against real local Supabase Auth and the local inbox)

See the chat return for the run log. Short form: returning-member login, new registration, no unintended account
creation on login, invalid/expired code, resend and cooldown, verification unlocking the prediction inputs without a
reload, intent preservation, sign-out and Ana→Bruno identity switch were exercised through the real screens. Email codes
came from the local inbox, not a stub. Location in the rehearsal is
**simulated**; real SMS delivery and on-site GPS are **not** tested.

Automated: `__tests__/urbanoAuthAccountEntry.test.ts` (33), `__tests__/gamingAuthMethodsRoute.test.ts` (4),
`__tests__/soccerPredictionsPage.test.ts` (account-entry block), plus the existing suite.

## 3. Phone OTP readiness (research only)

### 3.1 What the repository already has

- No SMS or phone code existed before this gate. `gaming_members.auth_user_id` is `unique not null references
  auth.users(id)` (migration `0045`): **one Gaming Member per Auth user**, and `display_name` is the only profile column.
  There is no phone or email column on the member; contact data lives only in `auth.users`.
- Identity is resolved server-side from the bearer token (`lib/gaming/auth.ts` → `auth.getUser(token)`), so phone
  support changes nothing about authority checks.
- The local Supabase config has the `phone` provider disabled; the local `/auth/v1/settings` reports
  `external.phone=false`. The app therefore shows "Phone isn't available yet" and sends nothing.

### 3.2 What Supabase documents

Sources: [Phone login](https://supabase.com/docs/guides/auth/phone-login),
[Rate limits](https://supabase.com/docs/guides/auth/rate-limits),
[Send SMS hook](https://supabase.com/docs/guides/auth/auth-hooks/send-sms-hook),
[CAPTCHA](https://supabase.com/docs/guides/auth/auth-captcha),
[Going into production](https://supabase.com/docs/guides/platform/going-into-prod),
[Custom SMTP](https://supabase.com/docs/guides/auth/auth-smtp),
[Identity linking](https://supabase.com/docs/guides/auth/auth-identity-linking).

- Providers: Twilio, Twilio Verify, MessageBird, Vonage, TextLocal (community). WhatsApp is only available through Twilio
  or Twilio Verify. Hosted projects turn the Phone provider on under **Authentication → Providers**; each provider has
  its own fields. Supabase's own Twilio page recommends Twilio Verify for most uses (Verify generates the code, so
  expiry and message text are **not** configurable in Supabase).
- Client calls: `signInWithOtp({ phone })`, `verifyOtp({ phone, token, type: "sms" })`. Changing the number of a signed-in
  user is `updateUser({ phone })` then `verifyOtp({ type: "phone_change" })`.
- Defaults: one OTP request per user every 60 seconds; code lifetime 1 hour (the same page also says "within 60
  seconds"; the two statements disagree and must be checked on the real project).
- **SMS rate limit is per project, not per user: default 30 SMS per hour**, adjustable under **Authentication → Rate Limits**
  or the Management API (`rate_limit_sms_sent`). Excess requests get HTTP 429.
- CAPTCHA: hCaptcha or Cloudflare Turnstile, enabled under **Bot and Abuse Protection**. The page documents the token on
  `signUp`; it states protection covers sign-in, sign-up and password reset, and **does not say** whether the OTP
  endpoint (`/auth/v1/otp`) is covered. That must be confirmed on the real project before relying on it.
- Send SMS hook: replaces Supabase's sender so a different provider or channel (e.g. WhatsApp) can be used and routed by
  country code. Payload carries `user` and `sms.otp`. Needs an HTTPS endpoint we would have to build and secure.
- Test OTPs: self-hosted/local config has `[auth.sms.test_otp]` (number → fixed code, no SMS sent). A third-party guide
  describes a "Test Phone Numbers and OTPs" field in the hosted dashboard; **the hosted field was not confirmed from
  Supabase's own pages**. Test numbers must be removed before production.
- Identity linking: documented for OAuth identities (same verified email links automatically; unverified email is
  explicitly called insecure because of pre-account takeover). The page **does not describe phone identities**. Behavior
  of a phone sign-in for a person who already has an email account is therefore **not documented in what I could read**;
  see 3.8 for the design consequence, and confirm by experiment (local test OTP, no SMS) in the implementation gate.

### 3.3 Provider options

| Option | Fits | Notes |
| --- | --- | --- |
| Twilio **Verify** via Supabase's built-in Twilio Verify provider | Fastest, Supabase's recommendation | Supabase asks for the Verify Service ID; Twilio's own docs also require Account SID and Auth Token (the Supabase page does not list them; confirm on the dashboard form). No message-template control. Adds a per-success fee. Supports SMS and WhatsApp only. |
| Twilio **Programmable Messaging** via the built-in Twilio provider | Cheapest per message, message text controlled by Supabase | Needs a sender. For Honduras Twilio lists **international long codes as supported** (the sender shown to the recipient is not preserved); a pre-registered alphanumeric sender is a branding option, not a requirement (section 3.4a). Credentials: Account SID, Auth Token, Messaging Service SID or number. |
| **Send SMS hook** to any provider | Local carriers, WhatsApp-first routing, fallback | Most flexible and cheapest at scale; also the most work (endpoint, signature verification, retries). Not recommended for a first launch. |

Recommendation: **Twilio Verify**, if phone is wanted at all. It is the least custom code and the best-documented path.

### 3.4 Honduras and other destinations

Source: [Twilio Honduras SMS guidelines](https://www.twilio.com/en-us/guidelines/hn/sms).

- Country code `+504`. Twilio lists **two-way SMS as not supported** (irrelevant for OTP; users cannot reply "STOP").
- Landlines cannot receive SMS: Twilio returns error `21614` and does not charge. The UX must say "use a mobile number".
- **Domestic long codes are not supported; international long codes are, but the sender ID is not preserved** (recipients see a
  random-looking number). **Alphanumeric sender IDs are supported only when pre-registered** through the Twilio Console
  (~2 weeks); dynamic alphanumeric IDs are not fully supported, and on **Claro** alphanumeric works only if pre-registered.
- Twilio account setting: **SMS Geo Permissions** ([docs](https://www.twilio.com/docs/messaging/guides/sms-geo-permissions)) default to the account's
  home country only; sending elsewhere fails with error `21408`. A country must be enabled in the Console
  (Messaging → Settings → Geo Permissions). It **cannot be changed through the API**, so a person has to do it.
- Number format: the app accepts and sends **E.164 only** (`+504 9999 9999` → `+50499999999`). It never guesses a
  country and does not enforce per-country length (only the E.164 bounds, 7–15 digits). A country picker and per-country
  validation would be an improvement for the implementation gate.
- Other destinations: each needs the same geo-permission enablement, has its own price and sender rules, and some
  countries regulate SMS (Supabase cites India's DLT). Launch with a short allow-list rather than "everywhere".

### 3.4a Mandatory setup versus optional sender branding

Nothing below has been started; this only separates what any phone sign-in needs from what is cosmetic.

**Mandatory for any phone OTP** (each is the account owner's action, none is mine):

1. An SMS provider account that can send to unverified numbers (a trial account cannot; section 3.6), with a Verify service or a
   Messaging service and sender, and a funded balance.
2. Every destination country enabled in the provider's geographic permissions (Honduras included; the provider's default is the
   account's home country only).
3. The Supabase **Phone** provider switched on with the provider's credentials, in the Production project (it is off today:
   `auth.sms.twilio.enabled = false`, `auth.sms.enable_signup = false`).
4. The project's SMS-per-hour limit set deliberately (it is 30 today) and CAPTCHA in front of the code request.
5. A real-handset delivery test passed, **then** `URBANO_PHONE_OTP_ENABLED=true`.

**Optional, do not assume it is needed:** a pre-registered alphanumeric sender ID (Twilio lists about 2 weeks of provisioning in
Honduras) so the message shows a brand name instead of a number. Twilio lists international long codes as supported for Honduras
without it. It becomes mandatory only if Product decides the brand name must show, or if a carrier test shows unbranded
messages are filtered. Whether Twilio Verify needs anything extra for Honduras, and how it chooses the sender, was **not
established** from the pages read.

**Evidenced status of phone:** *Phone delivery is not configured or validated; timing depends on provider setup and real-device
delivery.* No claim is made about the calendar, because the only long lead item (alphanumeric registration) is optional.

### 3.5 Expected charges

Sources: [Twilio Honduras SMS pricing](https://www.twilio.com/en-us/sms/pricing/hn), [Verify pricing](https://www.twilio.com/en-us/verify/pricing).

| Item | Amount | Basis |
| --- | --- | --- |
| Outbound SMS to Honduras (international number or alphanumeric sender) | **$0.3296 per segment** | Twilio's page; "additional carrier fees may apply"; failed messages carry $0.001 processing |
| Verify base fee | **$0.05 per successful verification** | Verify pricing page; billed only on success, **SMS attempts are billed whether or not delivered** |
| Verify total, one SMS, success | **≈ $0.38** | $0.3296 + $0.05, carrier fees excluded |
| Programmable Messaging, one SMS | **≈ $0.33** | no Verify fee |
| Alphanumeric sender registration | **unknown** | fee not found; ask Twilio |
| Account upgrade / compliance profile | **unknown** | required to leave trial; amount not established |

Third-party sites quote different numbers; Twilio's own pages are used above. Prices change without notice.

Illustration, not a forecast: 200 members each verifying once ≈ $66 (Messaging) to $76 (Verify). Resends multiply SMS cost.
Worst case at Supabase's default project cap (30 SMS/hour) sustained all day ≈ 30 × $0.3296 × 24 ≈ **$237/day**.
That is the SMS-pumping exposure and it is why the cap and CAPTCHA matter more than the unit price.

### 3.6 Trial restrictions

Source: [Twilio trial docs](https://www.twilio.com/docs/messaging/guides/how-to-use-your-free-trial-account).

A trial account can message **verified numbers only** (up to 5), is capped (one summary says 50 messages/day; trial
expiry 30 days per the same summary — **not confirmed on Twilio's page**), and error `21608` appears for unverified
numbers. A trial can prove the plumbing to five known phones. It **cannot** serve participants. A paid upgrade, and for
sending to unverified numbers an approved compliance profile, is required. A message prefix on trial sends was reported
by a third party and is **unconfirmed**.

### 3.7 Required configuration and secrets (none exist yet)

Held outside source control, entered by the account owner directly into the provider and Supabase dashboards — **never
in chat, never in a repository file**:

1. Twilio: Account SID, Auth Token (or API key), Verify Service SID (or Messaging Service SID / number).
2. Supabase dashboard (Production project): Phone provider on, provider fields, SMS rate limit lowered to a deliberate
   number, CAPTCHA provider + secret, OTP expiry confirmed.
3. Vercel environment: `URBANO_PHONE_OTP_ENABLED=true`, **per environment**. Project memory records that Preview shares the
   Production database; Preview will reach the same Auth project, so the flag and provider must be a conscious choice for
   each environment.
4. Client: a CAPTCHA widget and passing its token with the OTP request (not built; the current client does not send one).

### 3.8 Identity resolution for existing email members (design consequence)

`gaming_members` has exactly one row per Auth user. If phone sign-in for a number not yet attached to anyone created a
new Auth user, the person would become a **second** Gaming Member.

The candidate's rules, in force now for email and carried to phone:

- **Log in** never creates a user (`shouldCreateUser:false`). A phone not attached to an account is refused.
- **Create account** with a contact that already has an account is a login, not a duplicate.
- The remaining gap is **a person who already has an email account and "creates an account" with a different phone
  number**: the system cannot know they are the same person, so it would create a second member. This is inherent and is
  solved only by letting a signed-in member **add** the phone to their existing account (section 4), plus clear copy at
  "Create account": "Already have an account? Log in with your email, then add your phone from your profile."
- Accounts are **never merged automatically**. Merge (two members into one: predictions, qualifications, XP) is a
  separate, audited support process that needs its own gate.

### 3.9 Real-device delivery tests required before release

On a paid Twilio account, a non-production or deliberately gated Supabase project, with the flag on only there:

1. Honduran mobile numbers on each major carrier in use (Claro is named in Twilio's guidance), iPhone and Android: delivery
   time, sender shown, code autofill, a second request inside the cooldown, a wrong code, a code after the expiry.
2. A number from another country that is on the allow-list, and one that is **not** (expect error `21408` surfaced as
   "unavailable", with no charge shown to the user).
3. A landline (expect `21614`), a malformed number, a number with spaces and punctuation.
4. Request 31 codes in an hour to see the project-wide cap and what the user sees (HTTP 429).
5. Add-a-phone from a signed-in email account (section 4) once built, and a phone already attached to another account.
6. Confirm CAPTCHA actually blocks `/auth/v1/otp` when the token is missing (see 3.2).
7. Confirm what appears in Supabase and Twilio logs and in the bill after the test.

### 3.10 What cannot be established without access

There is no SMS provider account or dashboard access, and none was sought. Production's Supabase configuration was later read
through an existing CLI login (`SCORE_PREDICTIONS_PRODUCTION_INSPECTION.md`): there the phone provider is **off**, the SMS limit is 30
per hour, and custom SMTP is on. Still not established: whether CAPTCHA is configured (the CLI's config scope did not return
it), Twilio account state, the alphanumeric registration fee, Verify behavior on Honduran carriers, the hosted test-OTP field,
phone-identity linking behavior. Each is a read-only check for the account owner or a local experiment for the implementation gate.

### 3.11 Email in Production (superseded: now inspected)

An earlier version of this section said Production's email setup was unknown. It was inspected read-only on 2026-10-22; the
full record is `SCORE_PREDICTIONS_PRODUCTION_INSPECTION.md`. Summary: **custom SMTP is configured** (Resend, sender
`noreply@gaming.urbanohn.com`), limit 30 emails per hour, 60 s per user, codes are **8 digits**, confirmations on. Not verified:
the two email templates (a code must be shown, not only a link), Resend's domain verification and key, and any real delivery. So:
**configuration present, not verified ready**. One real delivery has since been observed (2026-10-22, returning-user login to a Hotmail address, unbranded installed template): it arrived within the minute but was **filed as Junk** although SPF, DKIM and DMARC all passed; the filtering cause is unknown and the registration path is still untested. See the "Production delivery observation 1" subsection of that record.

### 3.12 Exact remaining Founder action or authorization

For **email only** (the launch path): custom SMTP is already configured. What remains is the Founder's retrieval of the two
templates and the Resend domain and key state, then authorization of the bounded two-email delivery test (all in
`SCORE_PREDICTIONS_PRODUCTION_INSPECTION.md`, section 1).

For **phone**: decide it is wanted and for which countries, then (each is the account owner's, not mine) work through the
mandatory list in 3.4a: choose Verify vs Messaging and the destination allow-list; create or use the provider account, accept its
terms, upgrade out of trial and fund it with a spend cap; enable the countries; put the credentials into the Supabase dashboard
yourself and set the SMS limit and CAPTCHA; authorize an implementation gate for CAPTCHA, a country picker, add-a-phone and
the real-device test run; set `URBANO_PHONE_OTP_ENABLED` only after that test passes. Until then phone stays unavailable.
**Phone delivery is not configured or validated; timing depends on provider setup and real-device delivery.** Whether it can be
ready for the 24–25 October launch is a question of how fast those steps and the handset test can be done, not something this
research can rule in or out; email is the evidenced path for that launch.

## 4. Profile and contact linking — proposal only (not implemented)

Goal: clicking the signed-in name opens a **Profile** panel: display name, email status, phone status, and add/verify
the missing method. Nothing below is built.

Principles:

1. **One account, one Gaming Member.** Every contact method resolves to the same `auth.users` row and therefore the same
   `gaming_members` row. `gaming_member_id` never changes when a method is added, changed or removed.
2. **Status comes from authoritative Auth evidence**, read server-side from the verified token's user record
   (`email_confirmed_at`, `phone_confirmed_at`), never from `user_metadata`, a client field, or an editable profile value.
   A small read-only route (e.g. `GET /api/gaming/profile`) returns `{ displayName, email: {address, verified}, phone:
   {number, verified} }`.
3. **Adding or changing a method requires an authenticated session and proof of the new method.** Add phone:
   `updateUser({ phone })` → code to the new number → `verifyOtp({ type: "phone_change" })`. Add email: `updateUser({ email })` →
   confirmation (the project's "secure email change" setting decides whether both old and new must confirm — to be read
   from project settings, not assumed).
4. **A method that already belongs to another account is handled explicitly.** The message must not reveal whose account it
   is: "That number is already used by an account. Log in with it instead." Never auto-link, never auto-merge, never
   "take over". Typing matching contact details is not evidence of ownership; only completing the verification code is.
5. **Four different operations, kept separate:**
   - *Add a login method* — authenticated, new method verified (this proposal).
   - *Account recovery* (lost access to every method) — not self-service; needs a support-verified process with its own gate.
   - *Change an existing method* — authenticated, new method verified, the old one notified; a cooldown is advisable.
   - *Remove a method* — blocked if it would leave no verified method.
6. **Honest language.** Both verified: **"Email and phone verified."** It states control of two channels. It does **not**
   claim legal identity or unique personhood, and the UI and any prize or reward copy must not imply it does.
7. Phone cannot be added until the provider exists; until then the panel shows "Phone: coming soon", with no input.

Open decisions (Canon/Founder): whether email-only members may later be required to add a phone for any benefit (this
bears on the rewards proposal below); whether removing the last-used method needs a cooldown; whether the residual
account-existence signal at the Supabase Auth layer (section 1, "Account existence") needs a server-side front door; ownership
of the support-assisted merge process.

Likely scope of the future gate: a profile panel in `urbanoAuth.js`, the read-only profile route, focused tests, and a local
experiment (test OTP, no SMS) for phone-change collision behavior.

## 5. Profile-completion rewards — deferred proposal (not configured, not awarded)

Idea: reward members who complete their profile (for example both methods verified). **This is a future Metagame
proposal.** Nothing was configured: no XP, points, currency or prize exists or is awarded by this candidate.

Decisions required before any build, each owned outside this candidate:

| Decision | Question |
| --- | --- |
| Eligibility | Which steps count (display name, email verified, phone verified, both)? Retroactive for existing members? Members from before the feature? |
| Award value | What is granted, how much, in which currency, and what does it cost in SMS (≈ $0.33–0.38 per phone verification in Honduras) relative to its value? |
| Idempotency | Exactly one award per member per milestone, enforced by a database unique key on (member, milestone), following the pattern of the existing XP event ledger rather than a client-side flag. |
| Abuse prevention | One phone number → one member; throwaway or VoIP numbers; many accounts from one device; SMS-pumping; a reward that costs more to deliver than it is worth. Requires the CAPTCHA and the rate-limit decisions in section 3. |
| Reversal / re-verification | What happens if a method is later removed, changed or found to belong to someone else? Revoke, keep, or require re-verification? Who can reverse, with what audit trail? |
| Authority | Per the repository contract, game rewards here are not authority for the wider URBANO Reward Economy; Canon/Product must set value and policy. |
| Scope | Must be kept apart from Predictions prize qualification and the weekend launch. |

## 6. Review checklist for this document's claims

Verified in this repository and on the local stack: sections 1, 2, 3.1, 3.8 (current-code part). Verified read-only against
Production on 2026-10-22: 3.11 and the Production values quoted in 3.4a (`SCORE_PREDICTIONS_PRODUCTION_INSPECTION.md`). Taken
from Supabase and Twilio pages as read on 2026-10-22 (links above, some pages summarized by a fetch tool and therefore worth
re-reading before spending money): 3.2–3.6. **Not verified by experiment**: hosted test OTP, phone identity linking,
phone-change collision, CAPTCHA coverage of the OTP endpoint, real delivery of email or SMS to anyone.
