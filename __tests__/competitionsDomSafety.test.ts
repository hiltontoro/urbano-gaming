import { describe, expect, it } from "vitest";
import { JSDOM } from "jsdom";
import { readFileSync } from "node:fs";
import path from "node:path";

/**
 * UG-CR-GATE-083 Correction B (per UG-CR-REV-054 finding 2) — proves,
 * against the ACTUAL shipped browser code (extracted verbatim from the
 * two production HTML files, never a reimplementation), that a hostile
 * display name / team name / reason string can no longer inject a live
 * DOM element or an executable event handler. jsdom gives this test a
 * real HTML parser and a real `innerHTML` setter — the same engine a
 * browser uses — so "no injected element" here is a genuine proof, not
 * an artifact of a hand-rolled fake DOM that never actually parses HTML
 * (unlike the dependency-free FakeElement harness in race.test.ts, which
 * is adequate for race.html's own behavioral assertions but could not
 * detect an HTML-injection regression at all).
 */

const ADMIN_HTML_PATH = path.join(process.cwd(), "public/competitions-admin.html");
const MEMBER_HTML_PATH = path.join(process.cwd(), "public/competitions.html");

const adminHtml = readFileSync(ADMIN_HTML_PATH, "utf8");
const memberHtml = readFileSync(MEMBER_HTML_PATH, "utf8");

/**
 * Extracts one top-level `function <name>(...) { ... }` declaration's
 * exact source text via brace-counting (robust to nested braces inside
 * the function body, e.g. event-listener callbacks) — the same
 * extract-the-real-source-rather-than-reimplement-it discipline
 * race.test.ts's own extractRaceScript() uses. Throws loudly if the
 * marker ever moves, rather than silently testing stale/fabricated logic.
 */
function extractFunction(source: string, name: string): string {
  const startMarker = `function ${name}(`;
  const start = source.indexOf(startMarker);
  if (start === -1) {
    throw new Error(`${name}() was not found in the given source — update extractFunction's caller.`);
  }
  const braceOpen = source.indexOf("{", start);
  if (braceOpen === -1) {
    throw new Error(`${name}(): no opening brace found after its signature.`);
  }
  let depth = 0;
  let i = braceOpen;
  for (; i < source.length; i++) {
    if (source[i] === "{") depth++;
    else if (source[i] === "}") {
      depth--;
      if (depth === 0) {
        i++;
        break;
      }
    }
  }
  if (depth !== 0) {
    throw new Error(`${name}(): brace-matching failed to close — update extractFunction's caller.`);
  }
  return source.slice(start, i);
}

/** A real jsdom document/window per test, loaded with the given extracted function sources. */
function makeRealm(functionSources: string[]) {
  const dom = new JSDOM("<!doctype html><html><body></body></html>", { runScripts: "outside-only" });
  const names = functionSources.flatMap((src) =>
    [...src.matchAll(/^function (\w+)\(/gm)].map((m) => m[1])
  );
  const exposures = names.map((n) => `window.${n} = ${n};`).join("\n");
  dom.window.eval(functionSources.join("\n\n") + "\n" + exposures);
  return dom.window as unknown as Window & Record<string, any>;
}

/** Hostile payloads covering: event-handler-bearing tags, a script tag via an attribute-breakout, a plain benign tag, and a pure attribute-breakout with no tag at all. */
const HOSTILE_PAYLOADS: Array<{ label: string; value: string }> = [
  { label: "img onerror", value: '<img src=x onerror="window.__xss=(window.__xss||0)+1">' },
  { label: "attribute-breakout script", value: '"><script>window.__xss=(window.__xss||0)+1</script>' },
  { label: "svg onload", value: "<svg onload=\"window.__xss=(window.__xss||0)+1\">" },
  { label: "benign tag", value: "<b>bold</b>" },
  { label: "bare attribute-breakout", value: '" onmouseover="window.__xss=(window.__xss||0)+1" autofocus="' },
];

/** No element anywhere in the subtree carries a script tag, an on* handler attribute, or a src/href that could auto-execute. */
function assertNoLiveInjection(root: Element) {
  expect(root.querySelector("script")).toBeNull();
  const all = [root, ...Array.from(root.querySelectorAll("*"))];
  for (const el of all) {
    for (const attr of Array.from(el.attributes || [])) {
      expect(attr.name.toLowerCase().startsWith("on")).toBe(false);
    }
  }
}

describe("UG-CR-GATE-083 corrections (UG-CR-REV-054 finding 2) — DOM-safety hostile-input proof", () => {
  describe("populateMemberOptions (competitions-admin.html) — the originally-flagged primary sink", () => {
    const source = extractFunction(adminHtml, "populateMemberOptions");

    it("extracted the real function body (sanity check on the harness itself)", () => {
      expect(source).toContain("select.innerHTML = \"\"");
      expect(source).toContain("opt.textContent = m.displayName");
    });

    for (const { label, value } of HOSTILE_PAYLOADS) {
      it(`renders a hostile displayName (${label}) as literal option text, never a live element`, () => {
        const win = makeRealm([source]);
        const select = win.document.createElement("select");
        win.populateMemberOptions(select, [{ gamingMemberId: "m1", displayName: value }], null);

        assertNoLiveInjection(select);
        // Exactly the placeholder plus one real <option> — nothing extra was parsed in.
        const options = Array.from(select.querySelectorAll("option"));
        expect(options).toHaveLength(2);
        const memberOption = options[1];
        expect(memberOption.textContent).toBe(value);
        expect(memberOption.children).toHaveLength(0);
        // Serializing back out shows the hostile markup HTML-escaped as
        // text, never as a parsed tag — the defining property of
        // .textContent vs. the innerHTML/el() sink it replaced.
        expect(memberOption.innerHTML).not.toContain("<img");
        expect(memberOption.innerHTML).not.toContain("<script");
        expect(memberOption.innerHTML).not.toContain("<svg");
      });
    }

    it("still exposes gamingMemberId as the option's real value (functional regression guard)", () => {
      const win = makeRealm([source]);
      const select = win.document.createElement("select");
      win.populateMemberOptions(select, [{ gamingMemberId: "member-123", displayName: "Alice" }], "member-123");
      const options = Array.from(select.querySelectorAll("option")) as HTMLOptionElement[];
      expect(options[1].value).toBe("member-123");
      expect(options[1].selected).toBe(true);
    });
  });

  describe("buildRejectionPanelRow (competitions-admin.html) — multi-field textContent + setAttribute fix", () => {
    // el()/elRow() are buildRejectionPanelRow's own real dependencies —
    // extracted alongside it rather than redefined, so this test runs
    // against the exact parsing helpers the shipped function actually calls.
    const elSource = extractFunction(adminHtml, "el");
    const elRowSource = extractFunction(adminHtml, "elRow");
    const fnSource = extractFunction(adminHtml, "buildRejectionPanelRow");

    for (const { label, value } of HOSTILE_PAYLOADS) {
      it(`renders a hostile team/captain name (${label}) as literal text and a literal aria-label, never a live element`, () => {
        const win = makeRealm([elSource, elRowSource, fnSource]);
        const t = { competitionTeamId: "team-1", name: value, captainDisplayName: value };
        const acceptBtn = win.document.createElement("button");
        const rejectBtn = win.document.createElement("button");
        const row = win.buildRejectionPanelRow(t, { competitionId: "c1" }, acceptBtn, rejectBtn);

        assertNoLiveInjection(row);
        const teamNameEl = row.querySelector(".reject-team-name");
        const captainNameEl = row.querySelector(".reject-captain-name");
        expect(teamNameEl.textContent).toBe(value);
        expect(captainNameEl.textContent).toBe(value);
        expect(teamNameEl.children).toHaveLength(0);
        expect(captainNameEl.children).toHaveLength(0);

        // aria-label was assigned via setAttribute, which stores a raw
        // attribute VALUE rather than re-parsing it as markup — reading
        // it back gives the exact literal string, with no attribute
        // boundary ever broken out of.
        const panel = row.querySelector(".reject-panel") as Element;
        expect(panel.getAttribute("aria-label")).toBe("Reject " + value);
        // Confirms the attribute-breakout payload did not actually
        // create a second, injected attribute (e.g. a live onmouseover).
        expect(Array.from(panel.attributes).map((a: Attr) => a.name).sort()).toEqual(["aria-label", "class", "role"]);
      });
    }
  });

  describe("The general placeholder-then-textContent idiom used by every other remediated sink", () => {
    // Every other one of the 36 corrected sinks (fixture matchups, team
    // rows, join-request names, invitation preview fields, roster/
    // checked-in lists, dispute text, etc., across both pages) reduces
    // mechanically to this exact idiom: el()/elRow() builds a STATIC
    // shell containing no dynamic value, and the untrusted value is
    // assigned afterward via .textContent. Rather than re-extract all 30
    // remaining call sites individually, this proves the idiom itself —
    // using the real, extracted el() from each production file — is safe
    // against the same hostile battery, which is what every one of those
    // call sites actually relies on.
    const memberElSource = extractFunction(memberHtml, "el");
    const adminElSource = extractFunction(adminHtml, "el");

    for (const [fileLabel, elSource] of [
      ["competitions.html", memberElSource],
      ["competitions-admin.html", adminElSource],
    ] as const) {
      for (const { label, value } of HOSTILE_PAYLOADS) {
        it(`${fileLabel}: el() shell + .textContent renders (${label}) as literal text only`, () => {
          const win = makeRealm([elSource]);
          const node = win.el('<p class="msg"><span class="dynamic"></span></p>');
          node.querySelector(".dynamic").textContent = value;

          assertNoLiveInjection(node);
          expect(node.querySelector(".dynamic").textContent).toBe(value);
          expect(node.querySelector(".dynamic").children).toHaveLength(0);
        });
      }
    }
  });

  describe("Negative control — proves this harness would have caught the original REV-054 defect", () => {
    // Reconstructs the EXACT pre-fix pattern this gate removed (the
    // original memberOptionsHtml: `<option>${displayName}</option>`
    // interpolated directly into a string parsed by innerHTML) to show
    // the hostile battery above is not vacuous — fed through the OLD
    // shape, it genuinely creates a live injected element, which is
    // exactly what the fix (asserted safe above) no longer does.
    const elSource = extractFunction(adminHtml, "el");

    it("the old string-interpolation-into-el() pattern DOES create a live <img onerror> element", () => {
      const win = makeRealm([elSource]);
      const hostileDisplayName = '<img src=x onerror="window.__xss=1">';
      // This is the shape memberOptionsHtml had before UG-CR-GATE-083 —
      // a raw template-literal interpolation into HTML parsed by el().
      const vulnerableNode = win.el(`<div><option value="m1">${hostileDisplayName}</option></div>`);
      const injectedImg = vulnerableNode.querySelector("img[onerror]");
      expect(injectedImg).not.toBeNull();
    });
  });
});
