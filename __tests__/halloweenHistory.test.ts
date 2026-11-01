import { describe, expect, it } from "vitest";
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
    expect(doc.querySelectorAll("form, input, button, script, [data-feat]")).toHaveLength(0);
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
