import { NextResponse } from "next/server";

import { SupabaseLegalAcceptanceRepository } from "./db/supabaseLegalAcceptanceRepository";
import { legalRegistry } from "./documents";
import {
  InvalidLegalSubmissionError,
  LegalAcceptanceHashConflictError,
  LegalAgeDeclarationRequiredError,
  LegalConditionsError,
} from "./types";

/** The repository the legal routes and the admission gate use. Routes take it from here so a test can stand its own in. */
export function buildLegalRepo(credentials: { url: string; serviceKey: string }) {
  return new SupabaseLegalAcceptanceRepository(credentials.url, credentials.serviceKey);
}

/** The registry the server answers from. The real one is empty until the Founder approves a text. */
export function currentLegalRegistry() {
  return legalRegistry();
}

/**
 * The answer for an error of the legal module, or null if it is not one. The conditions errors answer 409 with a code and the documents
 * that are missing, which the page uses to show what is left; the shape errors answer 400.
 */
export function legalErrorResponse(err: unknown): NextResponse | null {
  if (err instanceof LegalConditionsError) {
    return NextResponse.json({ error: err.message, code: err.code, missing: err.missing }, { status: 409 });
  }
  if (err instanceof LegalAgeDeclarationRequiredError || err instanceof InvalidLegalSubmissionError) {
    return NextResponse.json({ error: err.message }, { status: 400 });
  }
  if (err instanceof LegalAcceptanceHashConflictError) {
    return NextResponse.json({ error: err.message }, { status: 409 });
  }
  return null;
}
