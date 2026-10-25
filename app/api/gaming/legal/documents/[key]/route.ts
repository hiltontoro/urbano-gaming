import { NextResponse } from "next/server";
import { currentLegalRegistry } from "@/lib/gaming/legal/httpLegal";
import { entryByVersion, publishedEntry } from "@/lib/gaming/legal/documents";
import { LEGAL_DOCUMENT_KEYS, type LegalDocumentKey, type LegalScope } from "@/lib/gaming/legal/types";

/**
 * GET /api/gaming/legal/documents/[key]?version=...&kickoffAt=... — the full text of one document, as typed blocks the page renders as
 * text. EVENT_RULES are keyed to the instant their event starts (kickoffAt); the other two are global. Without `version` the current
 * published text is returned; with it, that exact version (an older one stays readable). Public, never cached. A text that is not
 * published, not unique or not intact is a 404: it is not shown.
 */
export async function GET(request: Request, { params }: { params: { key: string } }) {
  const key = params.key as LegalDocumentKey;
  if (!LEGAL_DOCUMENT_KEYS.includes(key)) {
    return NextResponse.json({ error: "Unknown document." }, { status: 404 });
  }
  const url = new URL(request.url);
  const version = url.searchParams.get("version");
  const kickoffAt = url.searchParams.get("kickoffAt");
  let scope: LegalScope = { kind: "GLOBAL" };
  if (key === "EVENT_RULES") {
    if (!kickoffAt) return NextResponse.json({ error: "kickoffAt is required for the event rules." }, { status: 400 });
    scope = { kind: "EVENT", kickoffAt };
  }
  const registry = currentLegalRegistry();
  const entry = version ? entryByVersion(registry, key, version, scope) : publishedEntry(registry, key, scope);
  if (!entry) {
    return NextResponse.json({ error: "That text is not published." }, { status: 404, headers: { "cache-control": "no-store" } });
  }
  return NextResponse.json(
    {
      document: {
        key: entry.key,
        version: entry.version,
        locale: entry.locale,
        scope: entry.scope,
        current: entry.current,
        sha256: entry.sha256,
        title: entry.content.title,
        blocks: entry.content.blocks,
      },
    },
    { headers: { "cache-control": "no-store" } }
  );
}
