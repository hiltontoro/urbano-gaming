import { readFileSync } from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { describe, expect, it } from "vitest";
import { JSDOM } from "jsdom";

import { hashDocument } from "../lib/gaming/legal/documents";
import { fixtureEntry, fixtureRegistryWithNewVersion } from "./helpers/legalFixtures";

/**
 * THE PAGE THAT SHOWS THE TEXTS (public/legal.html), parsed and run whole in jsdom as shipped, with a stubbed fetch and a stubbed UrbanoAuth.
 * It must read well with no account, say plainly that nothing is published while nothing is, put every word of a text on the page as text
 * (never as markup), show an older version by its number, and — for a signed-in member — list what that member accepted and when.
 */

const REPO = process.cwd();
const read = (file: string) => readFileSync(path.join(REPO, file), "utf8");
const LEGAL_HTML = read("public/legal.html");
const I18N_SOURCE = read("public/urbanoI18n.js");
const KICKOFF = "2026-10-25T20:00:00.000Z";

interface Options {
  lang?: "es" | "en";
  documents?: any[]; // what GET /api/gaming/legal/documents lists
  texts?: Record<string, any>; // path+query of /documents/[key] -> the document
  signedIn?: boolean;
  acceptances?: any[] | "fail";
  listFails?: boolean;
  search?: string;
}

async function loadLegal(opts: Options = {}) {
  const calls: Array<{ url: string; auth: string | null }> = [];
  const dom = new JSDOM(LEGAL_HTML, {
    url: "http://localhost/legal.html" + (opts.search ?? ""),
    runScripts: "dangerously",
    pretendToBeVisual: true,
    beforeParse(window) {
      const w = window as unknown as Record<string, any>;
      if (opts.lang === "en") window.localStorage.setItem("urbano.lang", "en");
      window.eval(I18N_SOURCE);
      w.UrbanoAuth = {
        attachSignInButton: () => {},
        getAccessToken: async () => (opts.signedIn ? "stub-token" : null),
      };
      w.fetch = async (url: string, init: Record<string, any> = {}) => {
        const auth = (init.headers && (init.headers as Record<string, string>).authorization) || null;
        calls.push({ url: String(url), auth });
        const reply = (status: number, json: unknown) => ({ status, ok: status >= 200 && status < 300, json: async () => JSON.parse(JSON.stringify(json)) });
        if (String(url) === "/api/gaming/legal/documents") {
          if (opts.listFails) return reply(500, { error: "x" });
          const documents = opts.documents ?? [];
          return reply(200, { published: documents.length > 0, documents });
        }
        if (String(url).startsWith("/api/gaming/legal/documents/")) {
          const found = opts.texts?.[String(url)];
          return found ? reply(200, { document: found }) : reply(404, { error: "That text is not published." });
        }
        if (String(url) === "/api/gaming/legal/acceptances") {
          if (!auth) return reply(401, { error: "A valid Authorization header for an authenticated Gaming Member is required." });
          if (opts.acceptances === "fail") return reply(500, { error: "x" });
          return reply(200, { acceptances: opts.acceptances ?? [] });
        }
        return reply(404, { error: "unexpected request" });
      };
    },
  });
  const doc = dom.window.document;
  const settle = (ms = 40) => new Promise((r) => setTimeout(r, ms));
  await settle(80);
  const text = (el: Element | null) => (el?.textContent ?? "").replace(/\s+/g, " ").trim();
  return { win: dom.window as any, doc, calls, settle, text, q: (s: string) => doc.querySelector(s) as HTMLElement | null, qa: (s: string) => [...doc.querySelectorAll(s)] as HTMLElement[], close: () => dom.window.close() };
}

const listEntry = (e: { key: string; version: string; locale: string; scope: unknown; current: boolean; content: { title: string }; sha256: string }) => ({
  key: e.key, version: e.version, locale: e.locale, scope: e.scope, current: e.current, title: e.content.title, sha256: e.sha256,
});
const fullText = (e: ReturnType<typeof fixtureEntry>) => ({ key: e.key, version: e.version, locale: e.locale, scope: e.scope, current: e.current, sha256: e.sha256, title: e.content.title, blocks: e.content.blocks });

describe("while nothing is approved (how it ships)", () => {
  it("says that no text is published and shows no draft, no list, and no promise", async () => {
    const p = await loadLegal({ documents: [] });
    expect(p.text(p.q("#legal-list"))).toBe("Todavía no hay textos publicados. Cuando se publiquen, los vas a poder leer completos acá, sin necesidad de cuenta.");
    expect(p.qa("#legal-list a")).toEqual([]);
    expect(p.q("#legal-doc")!.hidden).toBe(true);
    p.close();
  });

  it("a signed-out visitor is told to sign in to see their own record; nothing about anyone's record is requested with no session", async () => {
    const p = await loadLegal({ documents: [] });
    expect(p.text(p.q("#legal-mine"))).toContain("Iniciá sesión para ver qué aceptaste y cuándo.");
    expect(p.calls.find((c) => c.url === "/api/gaming/legal/acceptances")!.auth).toBeNull();
    p.close();
  });

  it("a signed-in member with nothing accepted sees an empty record, honestly", async () => {
    const p = await loadLegal({ documents: [], signedIn: true, acceptances: [] });
    expect(p.text(p.q("#legal-mine"))).toContain("Todavía no registraste ninguna aceptación.");
    expect(p.calls.find((c) => c.url === "/api/gaming/legal/acceptances")!.auth).toBe("Bearer stub-token");
    p.close();
  });
});

describe("with texts published", () => {
  const registry = fixtureRegistryWithNewVersion(KICKOFF, "fixture-1", "fixture-2");
  const documents = registry.map(listEntry);

  it("lists each document with its versions — the current one first, an older one still readable — each a link to the full text", async () => {
    const p = await loadLegal({ documents });
    const groups = p.qa(".legal-group");
    expect(groups.map((g) => p.text(g.querySelector("h3")))).toEqual(["Términos de cuenta", "Aviso de privacidad", "Reglas del evento y canje"]);
    const terms = groups[0];
    expect(p.qa(".legal-group:first-child .legal-versions li").map((li) => p.text(li))).toEqual(["Versión fixture-2Vigente", "Versión fixture-1Anterior"]);
    expect((terms.querySelectorAll("a")[0] as HTMLAnchorElement).getAttribute("href")).toBe("/legal.html?doc=ACCOUNT_TERMS&version=fixture-2");
    expect((terms.querySelectorAll("a")[1] as HTMLAnchorElement).getAttribute("href")).toBe("/legal.html?doc=ACCOUNT_TERMS&version=fixture-1");
    const rules = groups[2].querySelector("a") as HTMLAnchorElement;
    expect(rules.getAttribute("href")).toBe("/legal.html?doc=EVENT_RULES&version=fixture-2&kickoffAt=2026-10-25T20%3A00%3A00.000Z");
    p.close();
  });

  it("opens one full text from a link: title, version, state, its hash, and every block as text; asks for exactly that version", async () => {
    const entry = registry.find((e) => e.key === "ACCOUNT_TERMS" && e.version === "fixture-1")!;
    const url = "/api/gaming/legal/documents/ACCOUNT_TERMS?version=fixture-1";
    const p = await loadLegal({ documents, search: "?doc=ACCOUNT_TERMS&version=fixture-1", texts: { [url]: fullText(entry) } });
    const article = p.q("#legal-doc")!;
    expect(article.hidden).toBe(false);
    expect(p.text(article.querySelector("h1"))).toBe("Fixture ACCOUNT_TERMS");
    expect(p.text(article.querySelector(".legal-meta"))).toBe(`Versión fixture-1 · Anterior · SHA-256 ${entry.sha256}`);
    expect(entry.sha256).toBe(hashDocument(entry.content)); // the hash on the page is the hash of the text
    expect(article.querySelector("h2")!.textContent).toBe("Fixture ACCOUNT_TERMS (fixture-1)");
    expect([...article.querySelectorAll("li")].map((li) => li.textContent)).toEqual(["one", "two"]);
    expect([...article.querySelectorAll("th")].map((th) => th.textContent)).toEqual(["a", "b"]);
    expect([...article.querySelectorAll("td")].map((td) => td.textContent)).toEqual(["1", "2"]);
    expect(p.calls.some((c) => c.url === url)).toBe(true);
    expect(p.doc.activeElement).toBe(article); // keyboard users land on the text
    expect((article.querySelector(".legal-back") as HTMLAnchorElement).getAttribute("href")).toBe("/legal.html");
    p.close();
  });

  it("the rules of an event are asked for with the instant their event starts", async () => {
    const entry = registry.find((e) => e.key === "EVENT_RULES" && e.current)!;
    const url = `/api/gaming/legal/documents/EVENT_RULES?version=fixture-2&kickoffAt=${encodeURIComponent(KICKOFF)}`;
    const p = await loadLegal({ documents, search: `?doc=EVENT_RULES&version=fixture-2&kickoffAt=${encodeURIComponent(KICKOFF)}`, texts: { [url]: fullText(entry) } });
    expect(p.text(p.q("#legal-doc h1"))).toBe("Fixture EVENT_RULES");
    expect(p.text(p.q("#legal-doc .legal-meta"))).toContain("Vigente");
    p.close();
  });

  it("puts every word of a text on the page as text, never as markup: a text that tries to be HTML is shown as typed", async () => {
    const hostile = fixtureEntry("ACCOUNT_TERMS", "hostile", { kind: "GLOBAL" });
    hostile.content = {
      title: '<img src=x onerror="window.__pwned=1">',
      blocks: [
        { kind: "heading", text: "<script>window.__pwned=2</script>" },
        { kind: "paragraph", text: '<a href="javascript:alert(1)">x</a>' },
        { kind: "list", items: ["<b>bold</b>"] },
        { kind: "table", header: ["<i>h</i>"], rows: [["<u>c</u>"]] },
      ],
    };
    const url = "/api/gaming/legal/documents/ACCOUNT_TERMS?version=hostile";
    const p = await loadLegal({ documents: [], search: "?doc=ACCOUNT_TERMS&version=hostile", texts: { [url]: fullText(hostile) } });
    const article = p.q("#legal-doc")!;
    expect(article.querySelector("img, script, b, i, u")).toBeNull();
    expect(article.querySelectorAll("a").length).toBe(1); // only the back link
    expect(p.text(article)).toContain('<img src=x onerror="window.__pwned=1">');
    expect(p.text(article)).toContain("<script>window.__pwned=2</script>");
    expect(p.win.__pwned).toBeUndefined();
    p.close();
  });

  it("says that a text is not published when the server does not have it, and still offers the way back", async () => {
    const p = await loadLegal({ documents, search: "?doc=ACCOUNT_TERMS&version=nope", texts: {} });
    expect(p.text(p.q("#legal-doc"))).toContain("Ese texto no está publicado.");
    expect(p.q("#legal-doc .legal-back")).not.toBeNull();
    p.close();
  });

  it("shows a member's own record with the version and the kind of act (accepted or read) and the time", async () => {
    const p = await loadLegal({
      documents,
      signedIn: true,
      acceptances: [
        { documentKey: "ACCOUNT_TERMS", documentVersion: "fixture-1", actType: "ACCEPTANCE", scopeMatchId: null, locale: "es", acceptedAt: "2026-10-25T17:00:00.000Z" },
        { documentKey: "PRIVACY_NOTICE", documentVersion: "fixture-1", actType: "READ_ACKNOWLEDGMENT", scopeMatchId: null, locale: "es", acceptedAt: "2026-10-25T17:00:01.000Z" },
      ],
    });
    const rows = p.qa("#legal-mine li").map((li) => p.text(li));
    expect(rows[0]).toMatch(/^Términos de cuenta — Versión fixture-1 — Aceptado el /);
    expect(rows[1]).toMatch(/^Aviso de privacidad — Versión fixture-1 — Leído el /);
    p.close();
  });

  it("says so when the record cannot be loaded, and when the list cannot be loaded offers a retry", async () => {
    const a = await loadLegal({ documents, signedIn: true, acceptances: "fail" });
    expect(a.text(a.q("#legal-mine"))).toContain("No pudimos cargar los textos. Probá de nuevo.");
    a.close();
    const b = await loadLegal({ listFails: true });
    expect(b.text(b.q("#legal-list"))).toContain("No pudimos cargar los textos. Probá de nuevo.");
    expect(b.qa("#legal-list button").map((x) => b.text(x))).toEqual(["Reintentar"]);
    b.close();
  });

  it("follows the language: the same page in English", async () => {
    const p = await loadLegal({ documents, lang: "en", signedIn: true, acceptances: [] });
    expect(p.text(p.q("h1"))).toBe("Terms, privacy and rules");
    expect(p.qa(".legal-group h3").map((h) => p.text(h))).toEqual(["Account terms", "Privacy notice", "Event and redemption rules"]);
    expect(p.text(p.q("#legal-mine"))).toContain("You have not recorded any acceptance yet.");
    p.close();
  });
});

describe("the page itself", () => {
  const dictionary = (() => {
    const sandbox: any = { window: {}, document: undefined };
    sandbox.window = sandbox;
    vm.runInNewContext(I18N_SOURCE, sandbox);
    return sandbox.UrbanoI18n.dictionary() as { es: Record<string, string>; en: Record<string, string> };
  })();

  it("opens in Spanish; every translated node has its key, and its first-paint text equals the Spanish table", () => {
    const doc = new JSDOM(LEGAL_HTML, { url: "http://localhost/legal.html" }).window.document;
    expect(doc.documentElement.getAttribute("lang")).toBe("es");
    for (const node of Array.from(doc.querySelectorAll("[data-i18n]"))) {
      const key = node.getAttribute("data-i18n")!;
      expect(dictionary.es[key], key).toBeDefined();
      expect(dictionary.en[key], key).toBeDefined();
      if (!node.hasAttribute("data-i18n-vars")) expect((node.textContent ?? "").replace(/\s+/g, " ").trim(), key).toBe(dictionary.es[key].replace(/\s+/g, " ").trim());
    }
    expect(Array.from(doc.querySelectorAll("[data-lang]")).map((b) => `${b.getAttribute("data-lang")}:${b.getAttribute("aria-pressed")}`)).toEqual(["es:true", "en:false"]);
  });

  it("its generated Spanish fallback block has exactly the Spanish keys of its prefixes, with exactly the module's words", () => {
    const block = LEGAL_HTML.match(/<script id="i18n-fallback">([\s\S]*?)<\/script>/)!;
    const sandbox: any = { document: { querySelectorAll: () => [] } };
    sandbox.window = sandbox;
    vm.runInNewContext(block[1], sandbox);
    const expected = Object.fromEntries(Object.entries(dictionary.es).filter(([key]) => ["shell.", "legalpage.", "auth."].some((p) => key.startsWith(p))));
    expect(sandbox.UrbanoI18n.dictionary().es).toEqual(expected);
  });

  it("every dictionary key its own script uses is in the block", () => {
    const block = LEGAL_HTML.match(/<script id="i18n-fallback">([\s\S]*?)<\/script>/)!;
    const sandbox: any = { document: { querySelectorAll: () => [] } };
    sandbox.window = sandbox;
    vm.runInNewContext(block[1], sandbox);
    const html = LEGAL_HTML.replace(/<script id="i18n-fallback">[\s\S]*?<\/script>/, "");
    const used = new Set(Array.from(html.matchAll(/["'`](?:shell|legalpage|auth)\.[A-Za-z0-9]+(?:\.[A-Za-z0-9]+)*["'`]/g)).map((m) => m[0].slice(1, -1)));
    for (const key of used) expect(sandbox.UrbanoI18n.has(key), key).toBe(true);
  });

  it("never builds markup from a text: no innerHTML, no document.write, no inline event handler", () => {
    expect(LEGAL_HTML).not.toMatch(/innerHTML|outerHTML|insertAdjacentHTML|document\.write|eval\(/);
    expect(LEGAL_HTML).not.toMatch(/\son[a-z]+\s*=\s*["']/);
  });

  it("the link to the texts is in the footer of the Score pages — and of no other game: the shared sign-in and the other games' pages are untouched", () => {
    for (const file of ["public/index.html", "public/soccer-predictions.html", "public/profile.html", "public/legal.html"]) {
      expect(read(file), file).toContain('<a href="/legal.html" data-i18n="shell.footer.legal">Términos, privacidad y reglas</a>');
    }
    for (const file of ["public/host.html", "public/participant.html", "public/poker-host.html", "public/urbanoAuth.js"]) {
      expect(read(file), file).not.toContain("legal.html");
    }
  });
});
