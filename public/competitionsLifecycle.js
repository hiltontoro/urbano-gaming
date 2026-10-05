/**
 * URBANO Gaming Competitions — organizer lifecycle progress (UG-CR-
 * GATE-081 Phase 3C). Pure logic, factored out of competitions-
 * admin.html for the same reason competitionsIntent.js is factored out
 * of competitions.html (see that file's own header comment): public/
 * *.html pages have no bundler/import support, so a test imports this
 * exact source text and executes it directly. No `window`, no `fetch`,
 * no mutation — this module only ever turns a competition's own
 * (state, acceptedTeamCount) into a plain, participant-facing
 * presentation description; it never performs or authorizes anything.
 * Every actual authority/state check this describes is independently,
 * redundantly enforced server-side inside the atomic RPC the
 * corresponding action calls — this module can be wrong about what to
 * *show* without ever being able to let an unauthorized action through,
 * since it never gates anything itself.
 */
(function (root) {
  var TEAM_CAPACITY = 4;

  var STEP_DEFS = [
    { key: "DRAFT", label: "Draft" },
    { key: "TEAM_REGISTRATION_OPEN", label: "Team registration open" },
    { key: "TEAMS_ACCEPTED", label: "Four teams accepted" },
    { key: "READY_TO_PUBLISH", label: "Ready to publish" },
    { key: "PUBLISHED", label: "Published" },
  ];

  var STATE_STEP_INDEX = {
    DRAFT: 0,
    TEAM_REGISTRATION_OPEN: 1,
    READY_TO_PUBLISH: 3,
    PUBLISHED: 4,
    COMPLETE: 4,
  };

  /**
   * Describes the organizer-facing lifecycle for one competition.
   * Returns:
   *   - cancelled: boolean — true for CANCELLED_WITHOUT_CHAMPION; every
   *     other field below is still populated (frozen at the step last
   *     reached) but the caller should present the cancelled banner as
   *     primary and suppress the step rail and dominant action entirely.
   *   - steps: [{ key, label, status }], status one of "complete" |
   *     "current" | "upcoming". The TEAMS_ACCEPTED step is marked
   *     "complete" purely from acceptedTeamCount reaching capacity,
   *     independent of state — it can be reached while still
   *     TEAM_REGISTRATION_OPEN (before the organizer closes
   *     registration) just as validly as after.
   *   - acceptedTeamCount, teamCapacity.
   *   - blocker: a plain-language reason the organizer cannot yet take
   *     the next step, or null when nothing is blocking.
   *   - dominantActionKey: "OPEN_REGISTRATION" | "CLOSE_REGISTRATION" |
   *     "PUBLISH" | null — the ONE action this gate calls for; the
   *     caller maps this to its own existing button, never a new
   *     control this module invents. null means no organizer action is
   *     currently the right one to emphasize (e.g. waiting on members
   *     to register/propose teams, or the competition already reached
   *     a terminal state).
   */
  function getOrganizerLifecycle(state, acceptedTeamCount) {
    var count = typeof acceptedTeamCount === "number" && acceptedTeamCount >= 0 ? acceptedTeamCount : 0;
    var capacityReached = count >= TEAM_CAPACITY;
    var cancelled = state === "CANCELLED_WITHOUT_CHAMPION";

    var currentIndex = STATE_STEP_INDEX.hasOwnProperty(state) ? STATE_STEP_INDEX[state] : 0;
    // Reaching capacity while still TEAM_REGISTRATION_OPEN visually
    // advances past the TEAMS_ACCEPTED step even though the state enum
    // itself hasn't moved yet — the organizer's own next action (close
    // registration) is what actually transitions state, so the step
    // rail reflects readiness for that action, not just the raw enum.
    if (state === "TEAM_REGISTRATION_OPEN" && capacityReached) currentIndex = 2;

    var steps = STEP_DEFS.map(function (def, i) {
      var status;
      if (def.key === "TEAMS_ACCEPTED") {
        status = capacityReached ? "complete" : (i === currentIndex ? "current" : (i < currentIndex ? "complete" : "upcoming"));
      } else if (i < currentIndex) {
        status = "complete";
      } else if (i === currentIndex) {
        status = "current";
      } else {
        status = "upcoming";
      }
      return { key: def.key, label: def.label, status: status };
    });

    var blocker = null;
    var dominantActionKey = null;

    if (!cancelled) {
      if (state === "DRAFT") {
        dominantActionKey = "OPEN_REGISTRATION";
      } else if (state === "TEAM_REGISTRATION_OPEN") {
        if (capacityReached) {
          dominantActionKey = "CLOSE_REGISTRATION";
        } else {
          var remaining = TEAM_CAPACITY - count;
          blocker = remaining === 1
            ? "Waiting for 1 more team to be accepted before registration can close."
            : "Waiting for " + remaining + " more teams to be accepted before registration can close.";
        }
      } else if (state === "READY_TO_PUBLISH") {
        dominantActionKey = "PUBLISH";
      }
      // PUBLISHED/COMPLETE: no dominant organizer action from this
      // panel — fixture-day actions take over, deliberately out of this
      // lifecycle summary's scope (see competitions-admin.html's own
      // "do not redesign unrelated organizer functionality" boundary).
    }

    return {
      cancelled: cancelled,
      steps: steps,
      acceptedTeamCount: count,
      teamCapacity: TEAM_CAPACITY,
      blocker: blocker,
      dominantActionKey: dominantActionKey,
    };
  }

  /**
   * Whether cancellation should be offered at all for a competition in
   * this state (UG-CR-GATE-081 Phase 3E) — DRAFT, TEAM_REGISTRATION_OPEN,
   * or READY_TO_PUBLISH only, matching cancel_incomplete_competition_
   * atomically's own server-side guard exactly. This is a presentation
   * convenience only; the RPC re-checks the same condition
   * independently and is the sole authority on whether a given call
   * actually succeeds.
   */
  function isCancellable(state) {
    return state === "DRAFT" || state === "TEAM_REGISTRATION_OPEN" || state === "READY_TO_PUBLISH";
  }

  root.CompetitionsLifecycle = {
    getOrganizerLifecycle: getOrganizerLifecycle,
    isCancellable: isCancellable,
  };
})(typeof window !== "undefined" ? window : globalThis);
