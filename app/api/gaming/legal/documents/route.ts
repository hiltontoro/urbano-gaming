import { NextResponse } from "next/server";
import { currentLegalRegistry } from "@/lib/gaming/legal/httpLegal";
import { isIntact } from "@/lib/gaming/legal/documents";

// Answered on every request (never prerendered): what is published is whatever the registry holds in the deployment that serves it.
export const dynamic = "force-dynamic";

/**
 * GET /api/gaming/legal/documents — the texts the site publishes: key, version, language, scope, whether it is the current one, its title
 * and its hash. Public (a text must be readable before an account exists) and never cached. Only the texts the registry holds appear, and
 * only if they are intact; with an empty registry the answer says there is nothing published, which is how this ships.
 */
export async function GET() {
  const documents = currentLegalRegistry()
    .filter(isIntact)
    .map((entry) => ({
      key: entry.key,
      version: entry.version,
      locale: entry.locale,
      scope: entry.scope,
      current: entry.current,
      title: entry.content.title,
      sha256: entry.sha256,
    }));
  return NextResponse.json({ published: documents.length > 0, documents }, { headers: { "cache-control": "no-store" } });
}
