import type { PokerRepository } from "./db/pokerRepository";
import type { CloseTableResult } from "./types";
import { PokerTableNotFoundError } from "./types";

/**
 * CLOSE_TABLE command handler — Poker End Table Lifecycle Slice. Makes
 * closed_at (present since the Poker Foundation's own 0067, deliberately
 * deferred) reachable. Host-only; the API route resolves and checks the
 * host token before calling this, exactly as startHand.ts's own caller
 * does. Legality (no Hand ever dealt, or the most recent Hand's
 * street = 'COMPLETE') and idempotency are both enforced by the
 * repository's own atomic implementation (close_poker_table_atomically,
 * 0155) — this handler adds no logic beyond existence validation, same
 * shape as startHand.ts.
 */
export async function closeTable(
  repo: PokerRepository,
  pokerTableId: string
): Promise<CloseTableResult> {
  const table = await repo.getTableById(pokerTableId);
  if (!table) {
    throw new PokerTableNotFoundError();
  }

  const { closedAt, alreadyClosed } = await repo.closeTable(pokerTableId);

  return { pokerTableId, closedAt, alreadyClosed };
}
