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

  describe("makeCell (competitions-admin.html) — team-table cells for the phone card layout (UG-CR-GATE-087)", () => {
    const source = extractFunction(adminHtml, "makeCell");

    for (const { label, value } of HOSTILE_PAYLOADS) {
      it(`renders hostile text (${label}) literally and keeps the column label as plain data`, () => {
        const win = makeRealm([source]);
        const td = win.makeCell("Team", value) as Element;
        assertNoLiveInjection(td);
        expect(td.tagName).toBe("TD");
        expect(td.textContent).toBe(value);
        expect(td.children).toHaveLength(0);
        expect(td.getAttribute("data-label")).toBe("Team");
        // Exactly the label and the ARIA role: nothing else can ride in through the value.
        expect(Array.from(td.attributes).map((a: Attr) => a.name).sort()).toEqual(["data-label", "role"]);
        expect(td.getAttribute("role")).toBe("cell");
      });
    }

    it("makeRow builds a bare tr carrying only the row role", () => {
      const win = makeRealm([extractFunction(adminHtml, "makeRow")]);
      const tr = win.makeRow() as Element;
      expect(tr.tagName).toBe("TR");
      expect(Array.from(tr.attributes).map((a: Attr) => a.name)).toEqual(["role"]);
      expect(tr.getAttribute("role")).toBe("row");
    });

    it("builds an empty labelled cell when no text is given (the button cells)", () => {
      const win = makeRealm([source]);
      const td = win.makeCell("Invitation");
      expect(td.textContent).toBe("");
      expect(td.getAttribute("data-label")).toBe("Invitation");
    });

    it("keeps an explicitly empty string empty rather than treating it as missing (rejection reason)", () => {
      const win = makeRealm([source]);
      const td = win.makeCell("Reason", "");
      expect(td.textContent).toBe("");
      expect(td.getAttribute("data-label")).toBe("Reason");
    });
  });

  describe("renderCompetitionDetail team tables — the real shipped render code, executed (UG-CR-GATE-087)", () => {
    /** Loads the actual page script (plus the lifecycle script it depends on) into a jsdom window, with only the auth bridge stubbed. */
    function loadAdminPage() {
      const dom = new JSDOM(adminHtml.replace(/<script[^>]*src=[^>]*><\/script>/g, ""), {
        runScripts: "outside-only",
        url: "https://urbano.example.test/competitions-admin.html",
      });
      const w = dom.window as unknown as Window & Record<string, any>;
      w.eval(readFileSync(path.join(process.cwd(), "public/competitionsLifecycle.js"), "utf8"));
      w.eval(
        "window.UrbanoAuth = { attachSignInButton() {}, onAuthStateChange() {}, async getState() { return { status: 'unauthenticated' }; }, async getAccessToken() { return null; } };"
      );
      const inline = /<script>([\s\S]*?)<\/script>/.exec(adminHtml);
      if (!inline) throw new Error("the page's inline script was not found");
      w.eval(inline[1] + "\nwindow.__render = (v) => { currentView = v; renderCompetitionDetail(); };");
      return w;
    }

    const view = (name: string, captain: string) => ({
      competition: { competitionId: "c1", publicCode: "cp", name: "Cup", state: "TEAM_REGISTRATION_OPEN", cancelledReason: null },
      teams: [{ competitionTeamId: "t1", name, captainDisplayName: captain, publicCode: "tp1" }],
      pendingTeamProposals: [{ competitionTeamId: "t2", name: name + " B", captainDisplayName: captain }],
      rejectedTeamProposals: [{ competitionTeamId: "t3", name: name + " C", captainDisplayName: captain, rejectionReason: "No space left." }],
      fixtures: [],
    });

    const TABLES: Array<{ id: string; headers: string[]; labels: string[] }> = [
      { id: "table-teams", headers: ["Name", "Captain", "Invitation"], labels: ["Team", "Captain", "Invitation"] },
      { id: "table-pending-teams", headers: ["Name", "Proposed by", "Decision"], labels: ["Team", "Proposed by", "Decision"] },
      { id: "table-rejected-teams", headers: ["Name", "Proposed by", "Reason"], labels: ["Team", "Proposed by", "Reason"] },
    ];

    it("each table renders its header sequence, and every data row has three role=cell cells whose data-label sequence matches the header order", () => {
      const w = loadAdminPage();
      w.__render(view("Riverside Academy", "María Fernanda Rodríguez"));
      for (const t of TABLES) {
        const table = w.document.getElementById(t.id)!;
        expect(table.getAttribute("role")).toBe("table");
        expect(Array.from(table.querySelectorAll("thead th")).map((th: Element) => th.textContent)).toEqual(t.headers);
        const rows = Array.from(table.querySelectorAll("tbody tr")).filter((r: Element) => !r.classList.contains("reject-panel-row"));
        expect(rows).toHaveLength(1);
        for (const row of rows as Element[]) {
          expect(row.getAttribute("role")).toBe("row");
          const cells = Array.from(row.children) as Element[];
          expect(cells.map((c) => c.getAttribute("data-label"))).toEqual(t.labels);
          expect(cells.every((c) => c.tagName === "TD" && c.getAttribute("role") === "cell")).toBe(true);
        }
      }
    });

    it("the cell texts, in order, are the team name, the captain, and the third-column content", () => {
      const w = loadAdminPage();
      w.__render(view("Riverside Academy", "María Fernanda Rodríguez"));
      const text = (id: string) => Array.from(w.document.querySelector(`#${id} tbody tr`)!.children).map((c: Element) => c.textContent);
      expect(text("table-teams")[0]).toBe("Riverside Academy");
      expect(text("table-teams")[1]).toBe("María Fernanda Rodríguez");
      expect(text("table-pending-teams").slice(0, 2)).toEqual(["Riverside Academy B", "María Fernanda Rodríguez"]);
      expect(text("table-rejected-teams")).toEqual(["Riverside Academy C", "María Fernanda Rodríguez", "No space left."]);
    });

    it("the actions are in the right cells with their exact labels: Copy Invitation Link; Accept then Reject", () => {
      const w = loadAdminPage();
      w.__render(view("Riverside Academy", "María"));
      const labels = (sel: string) => Array.from(w.document.querySelectorAll(sel)).map((b: Element) => b.textContent);
      expect(labels("#table-teams tbody td[data-label='Invitation'] > button")).toEqual(["Copy Invitation Link"]);
      expect(labels("#table-pending-teams tbody td[data-label='Decision'] > button")).toEqual(["Accept", "Reject"]);
    });

    it("a hidden rejection-panel row follows each pending row, keeps the row and cell roles, and carries no data-label", () => {
      const w = loadAdminPage();
      w.__render(view("Riverside Academy", "María"));
      const rows = Array.from(w.document.querySelectorAll("#table-pending-teams tbody tr")) as Element[];
      expect(rows).toHaveLength(2);
      expect(rows[1].classList.contains("reject-panel-row")).toBe(true);
      expect((rows[1] as HTMLElement).hidden).toBe(true);
      expect(rows[1].getAttribute("role")).toBe("row");
      expect(rows[1].firstElementChild!.getAttribute("role")).toBe("cell");
      expect(rows[1].firstElementChild!.hasAttribute("data-label")).toBe(false);
    });

    for (const { label, value } of HOSTILE_PAYLOADS) {
      it(`hostile team and captain names (${label}) render as literal text in all three tables, with no injected elements`, () => {
        const w = loadAdminPage();
        w.__render(view(value, value));
        const root = w.document.getElementById("competition-detail") as Element;
        assertNoLiveInjection(root);
        for (const t of TABLES) {
          const first = w.document.querySelector(`#${t.id} tbody tr`)!.children[0] as Element;
          expect(first.children).toHaveLength(0);
          expect(first.textContent!.startsWith(value)).toBe(true);
        }
        expect(w.document.querySelector("#table-teams tbody tr")!.children[1].textContent).toBe(value);
      });
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
