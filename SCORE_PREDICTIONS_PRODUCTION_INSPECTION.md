# Score Predictions — Production Read-Only Inspection (launch dependencies)

Date: 2026-10-22. Scope: the two launch dependencies named by Code Review: (1) can Production email real participants a sign-in
code, and (2) can an ordinary signed-in user change authority grants, audit records or other protected shared data.
Nothing in this document authorizes a release, a Production change or a send.

## 0. Method, access used, and the one side effect

- **Project identified.** The Supabase CLI already held a login on this machine. `supabase projects list` shows the project
  `URBANO Gaming` (ref `uyxckhbmcbctsbewnqkb`, `us-west-2`, `ACTIVE_HEALTHY`). It is the same project the Production app's own public
  configuration points at, and its Auth `site_url` is `https://urbano-gaming-playtest.vercel.app`, the canonical Production URL.
  (The second project in the list, `Restaurant OS`, is unrelated and `INACTIVE`; nothing was run against it.)
- **Configuration:** `supabase config pull --dry-run` against that project, in a scratch directory outside the repository. A
  dry run writes nothing, locally or remotely; it reports the remote values that differ from a local file. Values equal to the
  local default do not appear, so I diffed twice (once against defaults, once against flipped values) to read both cases.
  Masked secrets were never returned and no secret was printed or stored.
- **Catalog:** two `SELECT` statements over `pg_class`, `pg_proc`, `pg_policies`, `pg_roles`, `pg_default_acl`, `pg_event_trigger`
  and `pg_get_viewdef` through `supabase db query --linked`, plus `supabase db advisors --type security`. No application table
  was read, and no row of `auth.users` was read.
- **Side effect to disclose.** `supabase db query --linked` and `db advisors --linked` print `Initialising login role...`: the
  CLI asks the platform for a short-lived managed login role in the Production database for the duration of the call. That is
  the CLI's own mechanism, not a statement of mine, and it ran four times (two queries, one trivial count, one advisor run). I
  changed no schema, data, policy, grant or setting. Say so plainly in any review, because "read-only" here means my SQL, not
  that the platform issued nothing.
- **Not done:** no email was sent, no signup or sign-in was attempted, no write probe, no RPC call, no request as an
  authenticated or anonymous user. The built-in browser is not signed in to the Supabase dashboard and I did not start a login.

## 1. Production email

### Verified from configuration (provider-declared, not delivery)

| Item | Production value |
| --- | --- |
| Email sign-in enabled | yes (`auth.email.enable_signup = true`; global signup enabled; anonymous sign-ins off) |
| Sign-up confirmation required | yes (`enable_confirmations = true`) |
| **Custom SMTP** | **enabled** (so the built-in sender's team-members-only, 2-per-hour limits do not apply) |
| SMTP host and port | `smtp.resend.com`, `465` |
| Configured sender | `noreply@gaming.urbanohn.com`, display name `URBANO Gaming` |
| Emails per hour (project-wide) | **30** (`rate_limit.email_sent`) |
| Per-user minimum interval | **60 s** (`max_frequency = 1m0s`) |
| Sign-in/sign-up burst limit | 30 (`rate_limit.sign_in_sign_ups`) |
| Code lifetime | 3600 s |
| **Code length** | **8 digits** (`otp_length = 8`). The local rehearsal issues 6. |
| Recipient restriction | none from Supabase now that custom SMTP is on; whatever Resend itself enforces is not visible here |
| Redirect allow-list | `https://urbano-gaming-playtest.vercel.app` |

### Domain records (public DNS; consistent with a verified Resend domain, not proof of it)

For `gaming.urbanohn.com`: a DKIM record is published at the Resend selector; the `send.` subdomain has the expected return-path
(MX to Amazon SES feedback, SPF `include:amazonses.com`); DMARC is published on the parent `urbanohn.com` as `p=quarantine`.
That matches what a completed Resend domain setup publishes. It does **not** show Resend's verification state, that the SMTP
password is present and valid (the API masks it), or that mail reaches inboxes.

### Not readable with the access that exists, and why it matters

- **The email templates.** They are outside the scope the CLI reads, and the dashboard is not signed in here. With confirmations
  on, a **new** address is sent the **Confirm sign up** template and a **returning** address the **Magic Link** template. The
  sign-in screen asks for a code, so **both templates must show `{{ .Token }}`** (the 8-digit code). If either shows only a
  link, that journey cannot work. Production's custom templates are unknown to me; the local rehearsal's differ (it only has the
  Magic Link template customized, and confirmations are off locally), so it cannot stand in for Production.
- **Resend's state:** domain verified, the API key's sending permission, and Resend's delivery log.
- **Delivery to a real mailbox:** one real delivery has since been observed (next subsection): delivered in the same minute, **to Junk**, with SPF, DKIM and DMARC all passing.

### Production delivery observation 1: returning-user login (2026-10-22)

One login code was requested through the existing Production sign-in for the Founder-authorized Hotmail address (an existing, confirmed account
with a Gaming Member, unchanged), using the **currently installed, unbranded** Production Magic Link
template. Evidence comes from the Production sign-in page, the Founder's mailbox screenshot, and the message headers inspected by
Code Review. The code, the token link and the full headers are deliberately not reproduced here.

| Item | Observed |
| --- | --- |
| Request | 14:35:00 Honduras (20:35:00 UTC), one `POST /auth/v1/otp`, HTTP 200 after 2.6 s. No other message was requested. |
| Arrival | The same minute (the mailbox shows 2:35 PM). Delivery confirmed. |
| Message | From `URBANO Gaming <noreply@gaming.urbanohn.com>`; subject `Your URBANO Gaming sign-in code`; a readable plain-text code of 8 digits; unbranded body. |
| **Placement** | **Junk Email, not the Inbox.** Outlook showed its junk banner on the message. **Inbox placement failed.** |
| SPF | PASS for `send.gaming.urbanohn.com` |
| DKIM | PASS, signing domain `gaming.urbanohn.com` |
| DMARC | PASS, `gaming.urbanohn.com` (aligned) |
| Composite authentication | PASS |
| Microsoft spam confidence level | SCL 5 |
| Mailbox destination | Junk |
| Code acceptance | **Unconfirmed.** Verification is reported only if the Founder reports a successful login. |
| Resend log | Not consulted (no access in this session). |

**Conclusion.** An authentication or alignment failure is **closed** as the explanation for this particular message: SPF, DKIM and
DMARC all passed and aligned. Microsoft classified an authenticated message as spam. **The precise filtering cause is unknown.**
Domain reputation and message content are hypotheses, not findings: nothing observed here proves either. An earlier note in this
work leaned toward one of them; that lean is withdrawn. **No DNS, provider or sender change is indicated by this test.** One message
to one mailbox is also too little to say how other recipients or other mailbox providers will be treated.

**Consequences.** (1) The branded templates are a separate proposal and are **not** evidence of improved inbox placement; the
post-installation test records where the message lands as an observation, not as a pass criterion. (2) The sign-in screen already tells
people to check their spam folder; that guidance is now supported by a real case. (3) Participant-facing launch plans should not
assume inbox delivery at Hotmail and Outlook addresses.

### Verdict

**Configuration present and plausible; not verified ready.** Custom SMTP is configured and the sender domain's DNS looks right,
so the earlier fear (built-in sender, team members only) does not apply. What stays open is access-limited: the two templates,
Resend's verification and key, and one real delivery. The sign-in screen also assumed a 6-digit code; that is corrected in this
candidate (it no longer states a length and accepts any length), and the per-user 60 s window is now respected by the resend timer.

### What the Founder retrieves (minimum, non-secret)

1. Supabase dashboard, project **URBANO Gaming** → **Authentication → Emails → Templates**: for **Confirm sign up** and **Magic Link**,
   say whether the body contains `{{ .Token }}` and what the subject is. (Do not paste anything else.)
2. Resend dashboard → **Domains**: is `gaming.urbanohn.com` **Verified**; → **API Keys**: the key used by Supabase has **Sending access**
   for that domain. (Do not paste the key.)
3. Supabase dashboard → **Authentication → Rate Limits**: confirm **Emails sent per hour** is sized for the venue (it is 30 now).

### Proposed bounded delivery test (needs authorization; nothing sent yet)

> **Superseded by `supabase/email-templates/README.md`, section 3 ("Verification, in order")**, written after the Founder authorized a Hotmail address as the
> recipient and accepted branded templates. It records the read-only finding that the address already has a confirmed account with a
> Gaming Member (so the registration test needs a different, unused address) and the installation prerequisite. The steps below are the
> earlier outline.

Two emails, one Founder-owned mailbox, run after items 1–2 are confirmed:

1. On the Production sign-in, **Create account** with a new Founder-owned address (uses the Confirm sign up template). Record: seconds
   to arrive, inbox or spam, the From shown, the subject, whether a code (not only a link) is shown and its length (expect 8),
   and that the code verifies. **Stop before choosing a display name** so no Gaming Member is created.
2. Wait 60 s, then **Log in** with the same address (uses the Magic Link template). Record the same things.
3. Check Resend's log for both messages (delivered, no bounce) and Supabase's Auth log for SMTP errors.
4. Afterwards the account owner may delete the test user in **Authentication → Users**. The test creates one Production `auth.users`
   row (a Production write that the Founder must authorize) and no Gaming Member.

Pass: both arrive within about a minute, show a code that verifies, From reads `URBANO Gaming <noreply@gaming.urbanohn.com>`.
Fail on a link-only template: the fix is a Production Auth configuration change and needs its own authorization. A second mailbox
at a different provider is worthwhile if the Founder has one; a corporate or Hotmail-class mailbox is the more demanding case.

## 2. Shared authority in Production

Question: can an ordinary signed-in user, directly or indirectly, modify authority grants, audit records or other protected
shared data? Answered from the catalog (not from anonymous zero-row responses).

| Check | Production result |
| --- | --- |
| Row-level security on `public` tables | **75 of 75 on** (plus 1 view). Includes `authority_grants`, `admin_audit_events`, `gaming_members`, `experience_summaries`, `gaming_progression_events`, `gaming_xp_events`, `gaming_xp_rules`, and every Predictions table. |
| Policies | **0 in every schema.** With RLS on and no policy, `anon` and `authenticated` see and change no rows. |
| Client roles' attributes | neither has `BYPASSRLS`, neither is superuser, neither can log in directly; neither can create in `public`; every `public` object is owned by `postgres` |
| Table grants held by client roles | the platform default (all privileges on new objects). Inert while RLS is on with no policy. This includes `TRUNCATE` on 49 objects; the Data API has no truncate verb, so it is not reachable from a browser, but it is broader than needed. |
| `SECURITY DEFINER` functions (27) executable by a client role | **1**, `rls_auto_enable()`, which returns `event_trigger` (the platform's RLS helper). Not exercised. |
| `grant_platform_authority_atomically`, `revoke_platform_authority_atomically`, `bootstrap_governance_authority_atomically`, host-application functions | **not executable** by `anon` or `authenticated` |
| The 47 functions a client role can execute | all `SECURITY INVOKER` (include the old 3-argument `finalize` / `correct`, `redeem`, `upsert_prediction`, `record_experience_summary`); they run as the caller, so RLS blocks their writes |
| Why Production is protected | the platform's `ensure_rls` event trigger is on (turns RLS on for new tables). This repository's migrations never enable RLS. |

### Finding that needs remediation (not Predictions, not authority)

`public.duel_math_challenges_reached` (Math Duel) is a simple view with no `security_invoker` option, owned by `postgres`.
A view like this runs as its owner, which bypasses RLS. `anon` and `authenticated` hold `SELECT`, `INSERT`, `UPDATE`, `DELETE` on it.
By those facts it exposes the `correct_answer` of activated challenges and can be used to change or delete them. Supabase's
advisor independently reports it: `ERROR security_definer_view`. **Not exercised** (no write probe is authorized), so this is a
finding from the catalog and the advisor, not a demonstrated exploit. Anyone holding the public anon key can reach it by privilege.
Owner: the Math Duel / Duel lane. Smallest fixes, for that lane to decide: `alter view ... set (security_invoker = true)` and/or
`revoke all on ... from anon, authenticated`. Needs a Knowledge/Evidence Transfer to that owner; it is outside this candidate.

### Other advisor items (context)

`function_search_path_mutable` on `pulse_forms_are_valid` (another lane); `auth_leaked_password_protection` (not relevant to a
passwordless flow); `rls_enabled_no_policy` ×75 (informational: it is the intended deny-all state). The two `rls_auto_enable`
warnings are the helper above.

### Verdict

**Verified posture for authority, audit and Predictions data: protected in Production.** The local escalation (a member inserting an
`OPERATIONAL` grant) is a finding about the local posture; it does not reproduce in Production by catalog evidence.
**Remediation needed:** the Math Duel view. **Hardening recommended (owning lanes):** put RLS and revokes for the shared tables into
migrations, so the protection no longer depends on a platform setting. Preview deployments share this database, so a
Preview build inherits the same posture. The Production build currently deployed has not been identified.

## 3. What this does and does not settle for a real participant sign-in

Settled: the project; that custom SMTP is configured; the limits; the code length; that email OTP is enabled; that authority and
Predictions data are protected from signed-in users. Not settled: template content, Resend verification and key, any real
delivery, and the identity of the deployed build.

Next actions, in order, for the first real participant sign-in test:

1. Founder retrieves the three items in section 1.
2. Founder authorizes the two-email delivery test (and who runs it).
3. If a template is link-only, a Production Auth configuration change is authorized separately and made by the account owner.
4. The release gate (separate) deploys the candidate. Until then Production runs an older sign-in screen; the baseline `a816e40`
   screen states no code length, but what Production actually serves was not verified, so check that the code field accepts
   8 digits before using it for the delivery test.
5. Phone stays unavailable.
