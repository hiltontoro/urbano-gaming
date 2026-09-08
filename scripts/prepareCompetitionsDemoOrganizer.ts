/**
 * URBANO Gaming Competitions — local-only demo organizer preparation
 * (UG-CR-RPT-041/042 §13). Prepares the ONE prerequisite that is not
 * itself part of the live presentation script: an organizer identity
 * already holding platform OPERATIONAL authority, so the presentation
 * can begin at "organizer creates a tournament" without a live detour
 * through platform-authority bootstrapping, which no accepted decision
 * asks to demonstrate. Every step the presentation DOES demonstrate
 * (tournament creation, opening registration, member team proposal,
 * organizer acceptance, invitation sharing, invited-member registration/
 * request, captain approval) is left to the real UI, live — this script
 * never performs any of them.
 *
 * This is a plain CLI script, run directly with `tsx` — it is never an
 * HTTP route, is unreachable from any deployed environment, and defines
 * no standing seed endpoint of any kind. It refuses to run against
 * anything but a loopback Supabase URL, exactly like this repository's
 * own real-local-Postgres contract-test suites already refuse to run
 * against a non-local SUPABASE_URL. It reads only the same environment
 * variables every other part of this repository already requires
 * (SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY) — no credential is embedded
 * in this file, and none is invented here. It creates one clearly
 * synthetic auth user (an @example.invalid address — a reserved,
 * guaranteed-non-deliverable domain per RFC 2606) and one clearly
 * synthetic Gaming Member ("Demo Organizer") — never a real identity —
 * and contacts no email/SMS/push provider.
 *
 * Usage (from the repository root, local Supabase stack already running):
 *   SUPABASE_URL=http://127.0.0.1:54421 \
 *   SUPABASE_SERVICE_ROLE_KEY=<local service role key> \
 *   npx tsx scripts/prepareCompetitionsDemoOrganizer.ts
 */
import { randomUUID } from "node:crypto";
import { createClient } from "@supabase/supabase-js";

import { SupabaseGamingRepository } from "../lib/gaming/db/supabaseGamingRepository";
import { createGamingMember } from "../lib/gaming/createGamingMember";
import { SupabaseAuthorityRepository } from "../lib/gaming/authority/db/supabaseAuthorityRepository";
import { bootstrapGovernanceAuthority } from "../lib/gaming/authority/bootstrapGovernanceAuthority";
import { grantPlatformAuthority } from "../lib/gaming/authority/grantPlatformAuthority";

async function main(): Promise<void> {
  const supabaseUrl = process.env.SUPABASE_URL;
  const supabaseServiceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!supabaseUrl || !supabaseServiceKey) {
    throw new Error(
      "SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required. This script never infers, defaults, or embeds either."
    );
  }
  // The one hard safety gate: this script must be structurally incapable
  // of ever touching a non-local database, regardless of what the
  // caller's shell happens to have exported — matching the identical
  // guard already used by __tests__/competitionsSupabaseRepository
  // .contract.test.ts and __tests__/raceSupabaseRepository.contract
  // .test.ts.
  if (!/127\.0\.0\.1|localhost/.test(supabaseUrl)) {
    throw new Error(
      `Refusing to run against a non-local SUPABASE_URL (${supabaseUrl}). This script only ever operates against a loopback Supabase instance.`
    );
  }

  const adminClient = createClient(supabaseUrl, supabaseServiceKey);
  const gamingRepo = new SupabaseGamingRepository(supabaseUrl, supabaseServiceKey);
  const authorityRepo = new SupabaseAuthorityRepository(supabaseUrl, supabaseServiceKey);

  const syntheticEmail = `competitions-demo-organizer-${randomUUID()}@example.invalid`;
  const { data: created, error: createErr } = await adminClient.auth.admin.createUser({
    email: syntheticEmail,
    email_confirm: true,
  });
  if (createErr || !created.user) {
    throw createErr ?? new Error("Failed to create the synthetic demo-organizer auth user.");
  }

  const gamingMember = await createGamingMember(gamingRepo, created.user.id, "Demo Organizer");

  // Reuse an already-active PRODUCT_GOVERNANCE holder if this local
  // stack already has one (e.g. from an earlier demo-prep run or
  // another domain's own local setup); otherwise this organizer becomes
  // the one-time root bootstrap. Either path ends with this organizer
  // holding OPERATIONAL, and only OPERATIONAL — governance itself is
  // never claimed as a step this organizer needs going forward.
  const { data: existingGovernance } = await adminClient
    .from("authority_grants")
    .select("gaming_member_id")
    .eq("authority_class", "PRODUCT_GOVERNANCE")
    .is("revoked_at", null)
    .limit(1)
    .maybeSingle();

  const governanceHolderId = existingGovernance
    ? (existingGovernance.gaming_member_id as string)
    : (
        await bootstrapGovernanceAuthority(
          authorityRepo,
          gamingMember.gamingMemberId,
          "Local Competitions demo-organizer preparation (UG-CR-RPT-041/042 §13) — no production path exists to this script."
        )
      ).gamingMemberId;

  await grantPlatformAuthority(
    authorityRepo,
    governanceHolderId,
    gamingMember.gamingMemberId,
    "OPERATIONAL",
    "Local Competitions demo-organizer preparation (UG-CR-RPT-041/042 §13)."
  );

  console.log("URBANO Gaming Competitions — local demo organizer ready.");
  console.log(`  Auth user id:      ${created.user.id}`);
  console.log(`  Gaming Member id:  ${gamingMember.gamingMemberId}`);
  console.log(`  Display name:      ${gamingMember.displayName}`);
  console.log(`  Sign-in email:     ${syntheticEmail}`);
  console.log("  Platform authority: OPERATIONAL (active)");
  console.log("");
  console.log("To use: open /competitions-admin.html, sign in with the email above,");
  console.log("and retrieve the one-time code from local Mailpit (http://127.0.0.1:54424).");
  console.log("Everything from here — creating a tournament, opening team registration,");
  console.log("accepting proposed teams, and publishing — happens live, through the real UI.");
}

main().catch((err) => {
  console.error("Failed to prepare the local Competitions demo organizer:", err);
  process.exitCode = 1;
});
