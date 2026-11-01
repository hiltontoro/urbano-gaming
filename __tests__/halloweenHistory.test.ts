import { afterEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import * as jsdomModule from "jsdom";
const { JSDOM } = ((jsdomModule as any).default?.JSDOM ? (jsdomModule as any).default : jsdomModule) as typeof jsdomModule;
const read = (file: string) => readFileSync(path.join(process.cwd(), "public", file), "utf8");
const html = read("halloween-2026.html");
describe("Halloween 2026 is a finalized history, not a voting flow", () => {
  it("uses the shared brand and records date, venue and four categories without participant photos or unpublished results", () => {
    const doc = new JSDOM(html).window.document;
    expect(doc.querySelector('link[href="/experience.css"]')).not.toBeNull();
    expect(doc.querySelectorAll("h1")).toHaveLength(1);
    expect(doc.body.textContent).toContain("Evento finalizado");
    expect(doc.body.textContent).toContain("The Pub by Beer Box");
    expect(doc.body.textContent).toContain("31 de octubre de 2026");
    expect(Array.from(doc.querySelectorAll("#categories-title + ul li"), e => e.textContent)).toEqual(["Más Elaborado", "Más Sexy", "Dúo o Grupo", "Más Divertido"]);
    expect(doc.querySelectorAll("form, input, button, [data-feat]")).toHaveLength(0);
    expect(doc.querySelectorAll('script[src="/halloween-memories.js"]')).toHaveLength(1);
    expect(Array.from(doc.querySelectorAll("a"), a => a.href).join(" ")).not.toMatch(/community-voting-round|participar=/);
    expect(html).not.toMatch(/HAL-|public_name|public_code|@gmail|whatsapp|tel:|Beetlejuice|Anakin|alien|panda|\/photos\/|\d+ votos/i);
    expect(Array.from(doc.querySelectorAll("main img"), img => img.getAttribute("src"))).toEqual(["/assets/home/halloween-community.webp"]);
  });
  it.each(["index.html", "voting.html"])("%s cannot resurrect Halloween's active promotion from an old featured response", file => {
    const doc = new JSDOM(read(file)).window.document;
    expect(doc.querySelector('[src="/featuredContest.js"], [data-feat]')).toBeNull();
    expect(doc.querySelector('a[href="/halloween-2026.html"]')).not.toBeNull();
  });
  it("server redirects the real contest, its old no-ID entry and its screen, but not other contest IDs or APIs", async () => {
    const config = (await import("../next.config.mjs")).default;
    const rules = await config.redirects!();
    expect(rules).toHaveLength(3);
    expect(rules.every((rule: any) => rule.destination === "/halloween-2026.html" && rule.permanent === false)).toBe(true);
    expect(rules.map((rule: any) => rule.source)).toEqual(["/community-voting-round.html", "/community-voting-round.html", "/community-voting-round-display.html"]);
    expect(rules[0].has).toEqual([{ type: "query", key: "c", value: "94297d45-986a-423c-a1e9-9438bf1127c5" }]);
    expect(rules[1].missing).toEqual([{ type: "query", key: "c" }]);
    expect(rules[2].has).toEqual(rules[0].has);
  });
});

describe("temporary Halloween photos selected from the collages", () => {
  const windows: Array<InstanceType<typeof JSDOM>["window"]> = [];
  afterEach(() => { windows.splice(0).forEach(w => w.close()); vi.restoreAllMocks(); });
  function boot(at = "2026-11-01T20:00:00Z", file = "halloween-2026.html") {
    const w = new JSDOM(read(file), { url: "https://example.test/", runScripts: "outside-only" }).window;
    windows.push(w);
    vi.spyOn(w.Date, "now").mockReturnValue(Date.parse(at));
    w.eval(read("halloween-memories.js"));
    return w;
  }
  it("loads six original photos through existing guarded endpoints, not permanent public image copies", () => {
    const w = boot();
    const images = Array.from(w.document.querySelectorAll("[data-halloween-memories] img"));
    expect(images).toHaveLength(6);
    for (const image of images) {
      expect(image.getAttribute("src")).toMatch(/^\/api\/gaming\/community-voting\/rounds\/[0-9a-f-]{36}\/photos\/\d{4}\?v=full$/);
      expect(image.getAttribute("alt")).toBe("");
      image.dispatchEvent(new w.Event("load"));
    }
    expect(w.document.querySelector<HTMLElement>("[data-memories-section]")!.hidden).toBe(false);
    expect(read("halloween-memories.js")).not.toMatch(/localStorage|sessionStorage|fetch\(|POST|innerHTML|HAL-/);
  });
  it("shows three lightweight photos on the top Past events card without vote or registration controls", () => {
    const w = boot("2026-11-01T20:00:00Z", "index.html");
    const images = Array.from(w.document.querySelectorAll("[data-halloween-memories] img"));
    expect(images).toHaveLength(3);
    expect(images.every(i => i.getAttribute("src")!.endsWith("?v=thumb"))).toBe(true);
    expect(w.document.querySelector("#history")!.nextElementSibling!.id).toBe("experiences");
    expect(w.document.querySelector("[data-feat]")).toBeNull();
  });
  it.each(["2026-11-08T06:00:00Z", "2026-11-09T00:00:00Z"])("never loads photos after the seven-day deadline: %s", at => {
    const w = boot(at);
    expect(w.document.querySelectorAll("[data-halloween-memories] img")).toHaveLength(0);
    expect(w.document.querySelector<HTMLElement>("[data-memories-section]")!.hidden).toBe(true);
    expect(w.document.body.textContent).toContain("Evento finalizado");
  });
  it("removes photographs from a tab restored after expiry", () => {
    const w = boot();
    vi.mocked(w.Date.now).mockReturnValue(Date.parse("2026-11-08T06:00:00Z"));
    w.dispatchEvent(new w.Event("pageshow"));
    expect(w.document.querySelectorAll("[data-halloween-memories] img")).toHaveLength(0);
  });
  it("hides failed or withdrawn photographs without showing broken image controls or hiding the history", () => {
    const w = boot();
    for (const image of w.document.querySelectorAll("[data-halloween-memories] img")) image.dispatchEvent(new w.Event("error"));
    expect(w.document.querySelectorAll("[data-halloween-memories] img")).toHaveLength(0);
    expect(w.document.querySelector<HTMLElement>("[data-memories-section]")!.hidden).toBe(true);
    expect(w.document.querySelector("h1")!.textContent).toBe("Halloween 2026");
  });
});
