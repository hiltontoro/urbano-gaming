import { describe, expect, it, vi } from "vitest";

import {
  CONTEST, CONTESTS, INST, KEYS, ROUNDS, TEXTS, PAGES, REG_OPENS, VOTE_CLOSES,
  contestServer, galleryItem, loadPage, myCandidacy, uuid,
} from "./helpers/contestPageHarness";
import type { Json, Page, World } from "./helpers/contestPageHarness";

/**
 * UG-IV-GATE-018 — the contest's VOTER page and VENUE display, the ACTUAL shipped pages parsed and run whole in jsdom, with the real logic modules, a
 * stubbed identity seam and a scripted fake server. What these tests pin is behaviour: which view a person sees, what is (and is not) sent, that
 * nothing is shown as accepted before the server says so, that no position is ever read, and that no number or identity is ever on the page.
 */

vi.setConfig({ testTimeout: 60_000 });

const voter = (world: World = {}, extra: { auth?: Parameters<typeof loadPage>[0]["auth"]; query?: string; session?: Record<string, string> } = {}) =>
  loadPage({ html: PAGES.voter, respond: contestServer(world), auth: extra.auth, query: extra.query, session: extra.session });
const signedIn = { status: "authenticated", email: "persona@ensayo.invalid" } as const;

describe("public pre-opening entry without a configured contest", () => {
  for (const query of ["?participar=1", ""]) {
    it(`shows a read-only journey, never captures data or votes (${query || "vote"})`, async () => {
      const p = await loadPage({ html: PAGES.voter, query, respond: () => ({ status: 200, json: { featured: null } }) });
      expect(p.$("#preopenEntry")).toBeTruthy();
      expect(p.text()).toContain("The Pub by Beer Box");
      expect(p.text()).toContain("8:00–11:00 p. m.");
      expect(p.text()).toContain("11:00 p. m.–medianoche");
      expect(p.posts()).toEqual([]);
      expect(p.authed()).toEqual([]);
      expect(p.geo.getCurrentPosition).not.toHaveBeenCalled();
      expect(p.$("#regSubmit")).toBeNull();
      if (query) {
        expect(p.$("#previewName")).toBeTruthy();
        expect(p.$("#previewWhatsapp")).toBeTruthy();
        expect(p.$("#previewCategory")!.querySelectorAll("option")).toHaveLength(5);
        expect(p.$("#previewFields")!.hasAttribute("disabled")).toBe(true);
        expect(p.$$("#previewFields input[type=checkbox]")).toHaveLength(3);
        expect(p.$$("#previewFields input[type=checkbox]").every(el => !(el as HTMLInputElement).checked)).toBe(true);
      }
    });
  }
  it("keeps the pre-opening entry usable if the provider fails", async () => {
    const p = await loadPage({ html: PAGES.voter, query: "?participar=1", respond: () => ({ status: 503, json: {} }) });
    expect(p.$("#preopenEntry")).toBeTruthy();
    expect(p.posts()).toEqual([]);
  });
  for (const external of [false, true]) {
    it(`only offers a validated local continuation (${external ? "reject external" : "accept local"})`, async () => {
      const voteUrl = `/community-voting-round.html?c=${CONTEST}`;
      const p = await loadPage({ html: PAGES.voter, query: "?participar=1", respond: () => ({ status: 200, json: { featured: {
        voteUrl: external ? `https://evil.example${voteUrl}` : voteUrl,
        registerUrl: `${voteUrl}&participar=1`, phase: "NOT_OPEN", categories: [{ name: { es: "Categoría", en: "Category" } }],
      } } }) });
      expect(p.$("#continueContest")?.getAttribute("href") ?? null).toBe(external ? null : `${voteUrl}&participar=1`);
      expect(p.posts()).toEqual([]);
      expect(p.authed()).toEqual([]);
    });
  }
});

// ---------------------------------------------------------------- the front door

describe("the contest's front door: public, truthful, and it asks nothing of anyone", () => {
  it("explains replacement votes per category without adding voter privacy interruptions", async () => {
    const p=await voter();
    await p.clickSel("#entryVote");
    expect(p.text("#oneVotePerCategory")).toContain("hasta cuatro votos, uno en cada categoría");
    expect(p.text("#oneVotePerCategory")).toContain("reemplaza al anterior, no suma otro");
    expect(p.$("#contestPrivacy")).toBeNull();
  });
  it("shows the approved public information in the Founder's words, and the two entries", async () => {
    const p = await voter();
    const t = p.text();
    expect(t).toContain("Habrá premios en cada categoría");
    expect(t).toContain("Concurso de disfraces · The Pub by Beer Box");
    expect(t).toContain("Sábado 31 de octubre de 2026");
    expect(t).toContain("Inscripciones y fotos: 8:00–11:00 p. m.");
    expect(t).toContain("Votación: 11:00 p. m.–medianoche, entrando al domingo 1 de noviembre");
    expect(t).toContain("Hora de Honduras · horario tentativo");
    expect(p.$("#entryVote")!.textContent).toBe("Votar por tu disfraz favorito");
    expect(p.$("#entryRegister")!.textContent).toBe("Participar como concursante");
    expect(p.$("#howTo")).toBeTruthy();
    expect(p.$("#codeSearch")).toBeTruthy();
  });

  it("makes no authenticated request, asks for no position and opens no sign-in: a person can look around without a session", async () => {
    const p = await voter();
    expect(p.authed()).toEqual([]);
    expect(p.posts()).toEqual([]);
    expect(p.geo.getCurrentPosition).not.toHaveBeenCalled();
    expect(p.geo.watchPosition).not.toHaveBeenCalled();
    expect(p.$("#stepIdentity")).toBeNull();
    expect(p.calls.map((c) => c.url.replace("http://localhost", ""))).toEqual([`${CONTESTS}/${CONTEST}`]);
  });

  it("says what registration is doing by the server's phase — open, not open yet, ended, not scheduled — and never invents a time", async () => {
    const say = async (registration: World["registration"]) => (await voter({ registration })).text("#registrationNotice");
    expect(await say("OPEN")).toBe("La inscripción de concursantes está abierta hasta las 11:00 p. m. (hora de Honduras).");
    expect(await say("NOT_OPEN")).toBe("La inscripción de concursantes abre a las 8:00 p. m. (hora de Honduras).");
    expect(await say("CLOSED")).toBe("La inscripción de concursantes terminó. Ya no se aceptan nuevas candidaturas.");
    expect(await say("NOT_SCHEDULED")).toBe("Pronto anunciaremos el horario de inscripción.");
    const unscheduled = await voter({ registration: "NOT_SCHEDULED" });
    expect(unscheduled.$("#factRegistration")).toBeNull(); // no configured hours: no hours on the page
  });

  it("«Cómo participar» keeps every essential condition under a short heading, and the page itself stays short", async () => {
    const p = await voter();
    const how = p.text("#howTo");
    for (const must of ["mayores de edad", "una sola candidatura por persona", "no pedimos tu ubicación", "un voto por categoría", "No podés votar por tu propio disfraz", "Habrá premios en cada categoría"]) expect(how).toContain(must);
    expect(p.$$("#app > *").length).toBeLessThan(10);
  });

  it("a search by a code that cannot be a code says so without asking the server; a good one opens the ficha", async () => {
    const p = await voter({ ficha: { "HAL-K7M2Q": { status: 200, json: { candidacy: { code: "HAL-K7M2Q", name: "Drácula", category: { key: "MOST_ELABORATE", name: { es: "Más Elaborado" }, instanceId: INST.MOST_ELABORATE }, imageUrl: `${ROUNDS}/${INST.MOST_ELABORATE}/photos/1001?v=full`, thumbUrl: "", ficheUrl: "/x" }, voting: { phase: "NOT_OPEN", votingOpensAt: "2026-11-01T05:00:00.000Z" } } } } });
    await p.type(p.$("#codeSearch"), "HAL-0OIL1");
    await p.clickSel("#searchGo");
    expect(p.text()).toContain("Ese código no es válido");
    expect(p.to(`${CONTESTS}/${CONTEST}/candidacies`)).toHaveLength(0);
    await p.type(p.$("#codeSearch"), " hal k7m2q ");
    await p.clickSel("#searchGo");
    expect(p.to(`${CONTESTS}/${CONTEST}/candidacies`).map((c) => c.url.split("/").pop())).toEqual(["HAL-K7M2Q"]);
    expect(p.text("#fichaName")).toBe("Drácula");
  });
});

// ---------------------------------------------------------------- the registration

describe("registration: a person registers THEMSELVES, through their own account", () => {
  const fillGood = async (p: Page, over: { name?: string; category?: string; number?: string } = {}) => {
    await p.clickSel(`#cat_${over.category ?? "MOST_ELABORATE"}`);
    await p.type(p.$("#regName"), over.name ?? "Drácula de Tegucigalpa");
    await p.type(p.$("#regNumber"), over.number ?? "9988 7766");
    await p.check(p.$("#regWaConfirmed"));
    await p.check(p.$("#regRequirements"));
    await p.check(p.$("#regDelivery"));
  };

  it("signed out, the registration view offers the sign-in steps and never the form", async () => {
    const p = await voter({}, { query: `?c=${CONTEST}&participar=1` });
    expect(p.$("#registerForm")).toBeNull();
    expect(p.$("#stepIdentity")).toBeTruthy();
    expect(p.text()).toContain("Para inscribirte entrás con tu correo y tu perfil de URBANO Gaming.");
    expect(p.text("#stepIdentity")).not.toMatch(/SMS|WhatsApp|ubicaci/i);
  });

  it("after the cutoff there is NO form: it says registrations ended and accepts no new candidacies — even for someone signed in", async () => {
    const p = await voter({ registration: "CLOSED" }, { query: `?c=${CONTEST}&participar=1`, auth: signedIn });
    expect(p.$("#registerForm")).toBeNull();
    expect(p.$("#regSubmit")).toBeNull();
    expect(p.text()).toContain("La inscripción de concursantes terminó. Ya no se aceptan nuevas candidaturas.");
    expect(p.$("#registrationClosed")).toBeTruthy();
    expect(p.posts().filter((c) => /registration/.test(c.url))).toHaveLength(0);
  });

  it("before it opens, or with no schedule, there is no form either — only the truth about when", async () => {
    const early = await voter({ registration: "NOT_OPEN" }, { query: `?c=${CONTEST}&participar=1`, auth: signedIn });
    expect(early.$("#registerForm")).toBeNull();
    expect(early.text()).toContain("abre a las 8:00 p. m.");
    const none = await voter({ registration: "NOT_SCHEDULED" }, { query: `?c=${CONTEST}&participar=1`, auth: signedIn });
    expect(none.$("#registerForm")).toBeNull();
    expect(none.text()).toContain("Pronto anunciaremos el horario de inscripción.");
  });

  it("shows the four categories, the name field, the WhatsApp with its country, and the two confirmations — and the texts come from the SERVER", async () => {
    const p = await voter({}, { query: `?c=${CONTEST}&participar=1`, auth: signedIn });
    expect(p.$("#registerForm")).toBeTruthy();
    expect(p.$("#contestPrivacy")!.hasAttribute("open")).toBe(false);
    expect(p.text("#contestPrivacy")).toContain("7 días desde el cierre del concurso");
    expect(p.text("#contestPrivacy")).toContain("ni borra automáticamente copias");
    expect(p.text("#contestPrivacy")).not.toContain("info@urbanohn.com");
    expect(p.$$('input[name="category"]').map((i) => (i as HTMLInputElement).value)).toEqual([...KEYS]);
    expect(p.$("#regCountry")).toBeTruthy();
    expect((p.$("#regCountry") as HTMLSelectElement).value).toBe("504");
    expect(p.text("#requirementsText")).toBe(TEXTS.requirements.text);
    expect(p.text("#deliveryAuthText")).toBe(TEXTS.whatsappDelivery.text);
    expect(p.text("#waConfirmText")).toMatch(/Confirmo que este es mi número de WhatsApp/);
    await p.type(p.$("#regNumber"), "9988 7766");
    expect(p.text("#waConfirmText")).toBe("Confirmo que +504 9988-7766 es mi número de WhatsApp.");
  });

  it("an empty form sends NOTHING and names each missing piece; each message goes away as the person corrects what it is about", async () => {
    const p = await voter({}, { query: `?c=${CONTEST}&participar=1`, auth: signedIn });
    await p.clickSel("#regSubmit");
    expect(p.posts().filter((c) => /registration/.test(c.url))).toHaveLength(0);
    expect(p.$$(".bad").map((e) => e.id).sort()).toEqual(["err_category", "err_delivery", "err_name", "err_requirements", "err_whatsapp"]);
    await p.type(p.$("#regName"), "Drácula");
    expect(p.$("#err_name")).toBeNull();
    await p.type(p.$("#regNumber"), "9988 7766");
    expect(p.$("#err_whatsapp")).toBeNull();
    await p.check(p.$("#regRequirements"));
    expect(p.$("#err_requirements")).toBeNull();
    await p.check(p.$("#regDelivery"));
    expect(p.$("#err_delivery")).toBeNull();
    expect(p.$("#err_category")).toBeTruthy(); // the one thing still missing
  });

  it("an unconfirmed number is refused with its own message, and the number is never sent without the person's confirmation", async () => {
    const p = await voter({}, { query: `?c=${CONTEST}&participar=1`, auth: signedIn });
    await p.clickSel("#cat_SEXIEST");
    await p.type(p.$("#regName"), "Vampiresa");
    await p.type(p.$("#regNumber"), "9988 7766");
    await p.check(p.$("#regRequirements"));
    await p.check(p.$("#regDelivery"));
    await p.clickSel("#regSubmit");
    expect(p.text("#err_whatsappConfirmed")).toBe("Confirmá que este número es tuyo.");
    expect(p.posts().filter((c) => /registration/.test(c.url))).toHaveLength(0);
  });

  it("sends exactly what the person chose and confirmed — the SERVER's text versions, an E.164 number — with their bearer, to their category's own route, and no position", async () => {
    const p = await voter({}, { query: `?c=${CONTEST}&participar=1`, auth: signedIn });
    await fillGood(p, { category: "SEXIEST", name: "  Vampiresa de Olancho  " });
    await p.clickSel("#regSubmit");
    const sent = p.posts().filter((c) => /registration/.test(c.url));
    expect(sent).toHaveLength(1);
    expect(sent[0].url).toBe(`${ROUNDS}/${INST.SEXIEST}/registration`);
    expect(sent[0].headers.Authorization).toBe("Bearer stub-access-token");
    expect(sent[0].body).toEqual({
      publicName: "Vampiresa de Olancho", adultConfirmed: true, requirementsAccepted: true, requirementsVersion: TEXTS.requirements.version,
      whatsapp: "+50499887766", whatsappConfirmed: true, deliveryAuthorized: true, deliveryVersion: TEXTS.whatsappDelivery.version,
    });
    expect(JSON.stringify(sent[0].body)).not.toMatch(/location|latitude|longitude|accuracy|category|authUser|member/i);
    expect(p.geo.getCurrentPosition).not.toHaveBeenCalled();
  });

  it("shows the person's own candidacy only after the server's 201: the code, the name, the category, what happens next — and the number is nowhere on the page", async () => {
    let registered = false;
    const p = await voter({ mine: () => (registered ? myCandidacy() : null), registerReply: async () => { registered = true; return { status: 201, json: { candidacy: { entryId: uuid(5), publicCode: "HAL-K7M2Q" } } }; } }, { query: `?c=${CONTEST}&participar=1`, auth: signedIn });
    expect(p.$("#myCandidacy")).toBeNull();
    await fillGood(p);
    await p.clickSel("#regSubmit");
    expect(p.$("#registerForm")).toBeNull();
    expect(p.text("#myCode")).toBe("HAL-K7M2Q");
    expect(p.text("#myCandidacy")).toContain("Drácula");
    expect(p.text("#myCandidacy")).toContain("Más Elaborado");
    expect(p.text("#myCandidacyText")).toContain("Pasá por la estación del concurso con tu código");
    expect(p.text("#deliveryText")).toContain("Te enviaremos tu foto y tu código por WhatsApp");
    expect(p.text(".msg.ok")).toContain("Tu candidatura quedó inscrita");
    expect(p.markup()).not.toMatch(/9988|99887766|50499887766/); // the person's number is on no part of what they see once registered
    expect(p.$("#copyCode")).toBeTruthy();
    expect(p.$("#copyLink")).toBeTruthy();
    await p.clickSel("#copyCode");
    expect(p.clipboard).toEqual(["HAL-K7M2Q"]);
    await p.clickSel("#copyLink");
    expect(p.clipboard[1]).toBe(`http://localhost/community-voting-round.html?c=${CONTEST}&codigo=HAL-K7M2Q`);
  });

  it("keeps what the person typed across a refresh — but never a confirmation, and nothing once they are registered", async () => {
    const first = await voter({}, { query: `?c=${CONTEST}&participar=1`, auth: signedIn });
    await first.clickSel("#cat_FUNNIEST");
    await first.type(first.$("#regName"), "Momia");
    await first.type(first.$("#regNumber"), "9988 7766");
    await first.check(first.$("#regRequirements"));
    const stored = Object.fromEntries(Array.from({ length: first.win.sessionStorage.length }, (_, i) => [first.win.sessionStorage.key(i)!, first.win.sessionStorage.getItem(first.win.sessionStorage.key(i)!)!]));
    const draft = JSON.parse(stored[`cv:contest:draft:${CONTEST}`]);
    expect(draft.v).toEqual({ name: "Momia", category: "FUNNIEST", country: "504", otherCountry: "", number: "9988 7766" });
    expect(JSON.stringify(draft)).not.toMatch(/requirements|delivery|confirmed|accepted/i);
    const again = await voter({}, { query: `?c=${CONTEST}&participar=1`, auth: signedIn, session: stored });
    expect((again.$("#regName") as HTMLInputElement).value).toBe("Momia");
    expect((again.$("#regNumber") as HTMLInputElement).value).toBe("9988 7766");
    expect((again.$("#cat_FUNNIEST") as HTMLInputElement).checked).toBe(true);
    expect((again.$("#regRequirements") as HTMLInputElement).checked).toBe(false); // consents are given again, every time
    expect(again.win.sessionStorage.getItem(`cv:contest:draft:${CONTEST}`)).not.toBeNull();
    // once registered the draft is gone
    let registered = false;
    const done = await voter({ mine: () => (registered ? myCandidacy() : null), registerReply: async () => { registered = true; return { status: 201, json: {} }; } }, { query: `?c=${CONTEST}&participar=1`, auth: signedIn, session: stored });
    await fillGood(done);
    await done.clickSel("#regSubmit");
    expect(done.win.sessionStorage.getItem(`cv:contest:draft:${CONTEST}`)).toBeNull();
  });

  it("a lost answer is not a failure: if the registration went through, the person sees their candidacy and nothing is sent twice", async () => {
    let registered = false;
    const p = await voter({
      mine: () => (registered ? myCandidacy() : null),
      registerReply: async () => { registered = true; return { status: 0, json: { code: "NETWORK" } }; }, // it arrived; the answer did not
    }, { query: `?c=${CONTEST}&participar=1`, auth: signedIn });
    await fillGood(p);
    await p.clickSel("#regSubmit");
    expect(p.posts().filter((c) => /registration/.test(c.url))).toHaveLength(1);
    expect(p.text("#myCode")).toBe("HAL-K7M2Q");
    expect(p.text(".msg.ok")).toBe("Tu candidatura ya estaba inscrita. Esta es.");
    expect(p.$("#registerForm")).toBeNull();
  });

  it("a refusal says why in plain words and keeps what the person typed: a second candidacy, the cutoff, a stale text", async () => {
    for (const [code, status, text] of [
      ["ALREADY_CANDIDATE", 409, "Ya tenés una candidatura en el concurso. Cada persona participa una sola vez, en una sola categoría."],
      ["CUTOFF_PASSED", 409, "La inscripción terminó. Ya no se aceptan nuevas candidaturas."],
      ["INVALID_REQUEST", 400, "Algo en lo que escribiste no es válido. Revisalo e intentalo de nuevo."],
    ] as const) {
      const p = await voter({ registerReply: async () => ({ status, json: { code } }) }, { query: `?c=${CONTEST}&participar=1`, auth: signedIn });
      await fillGood(p);
      await p.clickSel("#regSubmit");
      expect(p.text(".msg.err"), code).toBe(text);
      expect((p.$("#regName") as HTMLInputElement).value, code).toBe("Drácula de Tegucigalpa");
      expect(p.text("#app"), code).not.toMatch(/CV_|HTTP \d|stack trace|undefined|\[object|NaN/);
    }
  });

  it("the person who already registered sees their candidacy — never the form again — whatever phase registration is in", async () => {
    for (const registration of ["OPEN", "CLOSED", "NOT_OPEN"] as const) {
      const p = await voter({ registration, mine: () => myCandidacy({
        state: "PUBLIC",
        deliveryStatus: "DELIVERED",
        share: { code: "HAL-K7M2Q", imageUrl: `${ROUNDS}/${INST.MOST_ELABORATE}/photos/4821?v=full` },
      }) }, { query: `?c=${CONTEST}&participar=1`, auth: signedIn });
      expect(p.$("#registerForm"), registration).toBeNull();
      expect(p.text("#myCandidacy"), registration).toContain("HAL-K7M2Q");
      expect(p.text("#myCandidacyText"), registration).toBe("Tu candidatura ya es pública: aparece en la galería con tu foto.");
      expect(p.text("#deliveryText"), registration).toBe("Tu foto y tu código ya te los enviaron por WhatsApp.");
      expect(p.$("#openMyFicha"), registration).toBeTruthy();
      expect(p.$("#downloadMyPhoto"), registration).toBeTruthy();
      expect(p.$("#downloadMyStory"), registration).toBeTruthy();
    }
  });

  it("keeps participant downloads closed while the photo is not public", async () => {
    const p = await voter({ mine: () => myCandidacy() }, { query: `?c=${CONTEST}&participar=1`, auth: signedIn });
    expect(p.$("#downloadMyPhoto")).toBeNull();
    expect(p.$("#downloadMyStory")).toBeNull();
  });

  it("a member of a group sees the group's candidacy and never the representative's delivery", async () => {
    const p = await voter({ mine: () => myCandidacy({ role: "MEMBER", kind: "GROUP", deliveryStatus: null, categoryKey: "BEST_GROUP" }) }, { query: `?c=${CONTEST}&participar=1`, auth: signedIn });
    expect(p.text("#myCandidacyText")).toContain("candidatura de grupo");
    expect(p.$("#deliveryText")).toBeNull();
  });
});

// ---------------------------------------------------------------- the ficha

describe("a candidacy's ficha: public, no session, casts nothing", () => {
  const ficha = (phase: string, over: Json = {}) => ({
    status: 200,
    json: {
      contestId: CONTEST,
      candidacy: { code: "HAL-K7M2Q", name: "Drácula de Tegucigalpa", category: { key: "MOST_ELABORATE", name: { es: "Más Elaborado" }, kind: "INDIVIDUAL", instanceId: INST.MOST_ELABORATE }, thumbUrl: `${ROUNDS}/${INST.MOST_ELABORATE}/photos/4821?v=thumb`, imageUrl: `${ROUNDS}/${INST.MOST_ELABORATE}/photos/4821?v=full`, ficheUrl: `/community-voting-round.html?c=${CONTEST}&codigo=HAL-K7M2Q` },
      voting: { phase, published: false, votingOpensAt: "2026-11-01T05:00:00.000Z", votingClosesAt: VOTE_CLOSES, deadlineAt: VOTE_CLOSES, ...over },
    },
  });

  it("opens the right candidacy from its link — photo, name, category and code — with a plain GET and no credentials", async () => {
    const p = await voter({ ficha: { "HAL-K7M2Q": ficha("NOT_OPEN") } }, { query: `?c=${CONTEST}&codigo=hal-k7m2q` });
    expect(p.text("#fichaName")).toBe("Drácula de Tegucigalpa");
    expect(p.text("#fichaCode")).toBe("HAL-K7M2Q");
    expect(p.text("#fichaCategory")).toBe("Más Elaborado");
    expect(p.$("#fichaCard img.ficha-photo")!.getAttribute("src")).toBe(`${ROUNDS}/${INST.MOST_ELABORATE}/photos/4821?v=full`);
    expect(p.authed()).toEqual([]);
    expect(p.posts()).toEqual([]);
    expect(p.to(`${CONTESTS}/${CONTEST}/candidacies`).map((c) => c.url.split("/").pop())).toEqual(["HAL-K7M2Q"]);
  });

  it("says the truth about time: before 11:00 p. m. there is no voting (and no vote button); while open, until midnight; after it, closed", async () => {
    const before = await voter({ ficha: { "HAL-K7M2Q": ficha("NOT_OPEN") } }, { query: `?c=${CONTEST}&codigo=HAL-K7M2Q` });
    expect(before.text("#fichaStatus")).toBe("La votación de esta categoría todavía no abre: está prevista a las 11:00 p. m. (hora de Honduras).");
    expect(before.$("#fichaVote")).toBeNull();
    const open = await voter({ ficha: { "HAL-K7M2Q": ficha("OPEN") } }, { query: `?c=${CONTEST}&codigo=HAL-K7M2Q` });
    expect(open.text("#fichaStatus")).toBe("La votación de esta categoría está abierta hasta medianoche (hora de Honduras).");
    expect(open.$("#fichaVote")!.textContent).toBe("Ir a votar en esta categoría");
    const closed = await voter({ ficha: { "HAL-K7M2Q": ficha("CLOSED") } }, { query: `?c=${CONTEST}&codigo=HAL-K7M2Q` });
    expect(closed.text("#fichaStatus")).toBe("La votación de esta categoría ya cerró.");
    expect(closed.$("#fichaVote")).toBeNull();
    const results = await voter({ ficha: { "HAL-K7M2Q": ficha("CLOSED", { published: true }) } }, { query: `?c=${CONTEST}&codigo=HAL-K7M2Q` });
    expect(results.text("#fichaStatus")).toBe("La votación de esta categoría ya cerró y los resultados están publicados.");
  });

  it("the link never votes and never skips the sign-in: «Ir a votar» leads to the sign-in steps, and only then to the ballot", async () => {
    const p = await voter({ ficha: { "HAL-K7M2Q": ficha("OPEN") } }, { query: `?c=${CONTEST}&codigo=HAL-K7M2Q` });
    await p.clickSel("#fichaVote");
    expect(p.$("#stepIdentity")).toBeTruthy();
    expect(p.posts()).toEqual([]);
    expect(p.authed()).toEqual([]);
  });

  it("an unknown code, one that is not public yet and one that is not a code at all say the same thing — and the last never asks the server", async () => {
    const unknown = await voter({}, { query: `?c=${CONTEST}&codigo=HAL-22222` });
    expect(unknown.text("#fichaMissing")).toContain("No encontramos esa candidatura. Puede que todavía no sea pública.");
    const bad = await voter({}, { query: `?c=${CONTEST}&codigo=HAL-0OIL1` });
    expect(bad.text("#fichaMissing")).toBe(unknown.text("#fichaMissing"));
    expect(bad.to(`${CONTESTS}/${CONTEST}/candidacies`)).toHaveLength(0);
    const down = await voter({ extra: (c) => (/candidacies/.test(c.url) ? { status: 503, json: {} } : undefined) }, { query: `?c=${CONTEST}&codigo=HAL-22222` });
    expect(down.$("#fichaError")).toBeTruthy();
    expect(down.$("#retryFicha")).toBeTruthy();
  });

  it("offers to copy the code and the link, and shares neutrally", async () => {
    const p = await voter({ ficha: { "HAL-K7M2Q": ficha("OPEN") } }, { query: `?c=${CONTEST}&codigo=HAL-K7M2Q` });
    await p.clickSel("#copyCode");
    await p.clickSel("#copyLink");
    expect(p.clipboard).toEqual(["HAL-K7M2Q", `http://localhost/community-voting-round.html?c=${CONTEST}&codigo=HAL-K7M2Q`]);
    expect(p.$("#shareFicha")).toBeNull(); // no Web Share here: the button exists only where the browser can share
  });
});

// ---------------------------------------------------------------- voting

describe("voting: names and codes, a search, one vote per category — and no position, ever", () => {
  const open = (extra: Partial<World> = {}): World => ({
    phases: { MOST_ELABORATE: "OPEN", SEXIEST: "OPEN", FUNNIEST: "OPEN" },
    gallery: { MOST_ELABORATE: [1, 2, 3].map((n) => galleryItem("MOST_ELABORATE", n)), SEXIEST: [1, 2].map((n) => galleryItem("SEXIEST", n)), FUNNIEST: [1, 2].map((n) => galleryItem("FUNNIEST", n)) },
    ...extra,
  });
  const into = async (world: World, key = "MOST_ELABORATE") => {
    const p = await voter(world, { auth: signedIn });
    await p.clickSel("#entryVote");
    await p.clickSel(`#cat-${key}`);
    return p;
  };

  it("lists the four categories with the state each is really in, and the times of the event", async () => {
    const p = await voter(open(), { auth: signedIn });
    await p.clickSel("#entryVote");
    expect(p.text("#voteHeadline")).toBe("La votación está abierta. Elegí una categoría.");
    expect(p.text("#cat-MOST_ELABORATE")).toContain("Votación abierta · todavía no votaste");
    expect(p.text("#cat-MOST_ELABORATE")).toContain("Cierra a medianoche (hora de Honduras)");
    expect(p.text("#cat-BEST_GROUP")).toContain("La votación todavía no abre");
    expect(p.text("#cat-BEST_GROUP")).toContain("Votación prevista a las 11:00 p. m. (hora de Honduras)");
  });

  it("before anything opens, the voting entry shows the schedule and the closed state — and there is nothing to vote with", async () => {
    const p = await voter({ phases: {} }, { auth: signedIn });
    await p.clickSel("#entryVote");
    expect(p.text("#voteHeadline")).toBe("La votación todavía no está abierta.");
    expect(p.text("#voteIntro")).toContain("Votación: 11:00 p. m.–medianoche, entrando al domingo 1 de noviembre");
    await p.clickSel("#cat-SEXIEST");
    expect(p.text(".banner")).toContain("La votación todavía no está abierta: está prevista a las 11:00 p. m. (hora de Honduras)");
    expect(p.$("#choose")).toBeNull();
    expect(p.$("#confirmVote")).toBeNull();
    expect(p.posts().filter((c) => /votes|intents/.test(c.url))).toHaveLength(0);
  });

  it("shows each candidacy by the name its person chose and by its code, in the deck", async () => {
    const p = await into(open());
    expect(p.text("#deckName")).toBe("Frankenstein");
    expect(p.text("#deckCode")).toBe("HAL-22222");
    expect(p.text(".meter")).toBe("1 de 3");
    await p.clickSel("#next");
    expect(p.text("#deckName")).toBe("La Catrina");
  });

  it("searches by name or by code and says so when nothing matches; the order of the voter's own sequence never changes", async () => {
    const p = await into(open());
    await p.type(p.$("#gallerySearch"), "catri");
    expect(p.text("#deckName")).toBe("La Catrina");
    expect(p.text(".meter")).toBe("1 de 1");
    await p.type(p.$("#gallerySearch"), "hal 44444");
    expect(p.text("#deckName")).toBe("Calabaza");
    await p.type(p.$("#gallerySearch"), "zzz");
    expect(p.text("#emptyGallery")).toBe("No encontramos disfraces con eso. Probá con otro nombre o código.");
    await p.type(p.$("#gallerySearch"), "");
    expect(p.text(".meter")).toBe("1 de 3");
  });

  it("asks for confirmation naming the candidate, then binds, takes an intent and votes — with no position — and confirms only on the server's 200", async () => {
    const p = await into(open());
    await p.clickSel("#choose");
    expect(p.modal()).toContain("¿Votar por Frankenstein en «Más Elaborado»?");
    expect(p.modal()).toContain("Código HAL-22222");
    expect(p.posts().filter((c) => /votes/.test(c.url))).toHaveLength(0); // nothing is sent before the person confirms
    await p.clickSel("#confirmVote");
    const votes = p.posts().filter((c) => /votes$/.test(c.url));
    expect(votes).toHaveLength(1);
    expect(votes[0].url).toBe(`${ROUNDS}/${INST.MOST_ELABORATE}/votes`);
    expect(votes[0].body).toEqual({ bindingId: uuid(900), intentNo: 5, interactionInstanceId: uuid(700), candidateId: galleryItem("MOST_ELABORATE", 1).candidateId });
    expect(JSON.stringify(votes[0].body)).not.toMatch(/location|latitude|longitude|accuracy/i);
    expect(p.text(".msg.ok")).toBe("Tu voto por Frankenstein en «Más Elaborado» quedó registrado. Podés cambiarlo hasta que cierre la votación.");
    expect(p.geo.getCurrentPosition).not.toHaveBeenCalled();
  });

  it("shows nothing as accepted when the server refuses: it says why, and the vote is not shown as theirs", async () => {
    const p = await into(open({ voteReply: { status: 409, json: { code: "VOTING_WINDOW_ELAPSED" } } }));
    await p.clickSel("#choose");
    await p.clickSel("#confirmVote");
    expect(p.text(".msg.err")).toBe("El tiempo de la votación terminó. Tu voto no se pudo registrar ni cambiar.");
    expect(p.$(".msg.ok")).toBeNull();
    expect(p.$(".flag.voted")).toBeNull();
  });

  it("a lost response offers a retry with the SAME intent: nothing is voted twice", async () => {
    let n = 0;
    const p = await into(open({ voteReply: async () => (++n === 1 ? { status: 0, json: { code: "NETWORK" } } : { status: 200, json: { outcome: "REPLAYED", candidateId: galleryItem("MOST_ELABORATE", 1).candidateId } }) }));
    await p.clickSel("#choose");
    await p.clickSel("#confirmVote");
    expect(p.text(".msg.err")).toContain("No pudimos confirmar tu voto en «Más Elaborado». Si ya había llegado, no se duplica.");
    await p.clickSel("#retryVote");
    const votes = p.posts().filter((c) => /votes$/.test(c.url));
    expect(votes).toHaveLength(2);
    expect(votes[1].body.intentNo).toBe(votes[0].body.intentNo);
    expect(p.posts().filter((c) => /intents$/.test(c.url))).toHaveLength(1); // no second intent
    expect(p.text(".msg.ok")).toContain("quedó registrado");
  });

  it("the person's own costume carries its flag and offers no way to vote for it", async () => {
    const mine = galleryItem("MOST_ELABORATE", 1, { mine: true });
    const p = await into(open({ gallery: { MOST_ELABORATE: [mine, galleryItem("MOST_ELABORATE", 2)] } }));
    expect(p.text(".flag.mine")).toBe("Tu disfraz");
    expect(p.$("#choose")).toBeNull();
    expect(p.text("#voteStatus")).toBe("Este es tu disfraz: no podés votar por él.");
  });

  it("lists «Mis votos» with the name voted for in each category and a way to change it while it is open", async () => {
    const voted = galleryItem("MOST_ELABORATE", 2);
    const p = await voter(open({ myCandidateId: { MOST_ELABORATE: voted.candidateId } }), { auth: signedIn });
    await p.clickSel("#entryVote");
    await p.clickSel("#reviewVotes");
    expect(p.text('#reviewCard [data-category="MOST_ELABORATE"]')).toContain("Tu voto: La Catrina");
    expect(p.text('#reviewCard [data-category="SEXIEST"]')).toContain("Todavía no votaste en esta categoría.");
    expect(p.text('#reviewCard [data-category="BEST_GROUP"]')).toContain("La votación todavía no abre.");
    expect(p.$('#reviewCard [data-change="MOST_ELABORATE"]')!.textContent).toBe("Cambiar");
  });

  it("after the close it says so, keeps the person's vote and offers no vote; once published it announces the winner by name and code, never a count", async () => {
    const world: World = {
      phases: { MOST_ELABORATE: "CLOSED" }, published: { MOST_ELABORATE: true }, gallery: { MOST_ELABORATE: [galleryItem("MOST_ELABORATE", 1)] },
      results: { MOST_ELABORATE: { published: true, kind: "WINNERS", items: [{ alias: "1001", name: "Frankenstein", code: "HAL-22222" }] } },
    };
    const p = await voter(world, { auth: signedIn });
    await p.clickSel("#entryVote");
    expect(p.text("#announcement-MOST_ELABORATE")).toContain("¡Tenemos ganador!");
    expect(p.text("#announcement-MOST_ELABORATE")).toContain("Frankenstein");
    expect(p.text("#announcement-MOST_ELABORATE")).toContain("HAL-22222");
    expect(p.text("#announcement-MOST_ELABORATE")).not.toMatch(/\d+ votos?|\bvotos\b/i);
    await p.clickSel("#cat-MOST_ELABORATE");
    expect(p.$("#choose")).toBeNull();
    const none = await voter({ phases: { SEXIEST: "CLOSED" }, published: { SEXIEST: true }, results: { SEXIEST: { published: true, kind: "WINNERS", items: [] } } }, { auth: signedIn });
    await none.clickSel("#entryVote");
    expect(none.text("#announcement-SEXIEST")).toContain("Sin resultado ganador");
    expect(none.text("#announcement-SEXIEST")).toContain("nadie recibió un voto válido");
  });

  it("every request the page makes goes to the contest's own routes: no geofence, no final, no finalists, no policies", async () => {
    const p = await into(open());
    await p.clickSel("#choose");
    await p.clickSel("#confirmVote");
    for (const c of p.calls) expect(c.url.replace("http://localhost", ""), c.url).toMatch(new RegExp(`^(${CONTESTS}/${CONTEST}|${ROUNDS}/[0-9a-f-]{36}/(binding|status|gallery|intents|votes|results|registration|claims))(/|$)`));
  });
});

describe("the voter page, in every state, carries no trace of the retired format", () => {
  it("no word of geofences, finals, cuts or positions in the markup it renders in any view", async () => {
    const FORBIDDEN = /geofence|geovalla|finalista|preliminar|\bla final\b|segunda ronda|ubicaci[oó]n exacta|GPS|latitud|longitud/i;
    for (const [world, query, auth] of [
      [{}, `?c=${CONTEST}`, undefined],
      [{}, `?c=${CONTEST}&participar=1`, signedIn],
      [{ phases: { MOST_ELABORATE: "OPEN" }, gallery: { MOST_ELABORATE: [galleryItem("MOST_ELABORATE", 1)] } } as World, `?c=${CONTEST}`, signedIn],
    ] as const) {
      const p = await voter(world as World, { query, auth: auth as never });
      if (query.includes("participar") === false && auth) { await p.clickSel("#entryVote"); await p.clickSel("#cat-MOST_ELABORATE"); }
      expect(p.markup(), query).not.toMatch(FORBIDDEN);
    }
  });
});

// ---------------------------------------------------------------- the venue display

describe("the venue display: exposure only, truthful about the moment", () => {
  const display = (world: World) => loadPage({
    html: PAGES.display, query: `?c=${CONTEST}`,
    respond: async (call) => {
      const u = call.url.replace("http://localhost", "");
      const s = u.match(new RegExp(`^${ROUNDS}/([0-9a-f-]{36})/slideshow$`));
      if (s) {
        const key = KEYS.find((k) => INST[k] === s[1])!;
        return { status: 200, json: { prompt: "x", rotationSeconds: 8, items: (world.gallery?.[key] ?? []).map((g) => ({ alias: g.alias, imageUrl: `${ROUNDS}/${s[1]}/photos/${g.alias}?v=full`, name: g.name, code: g.code })) } };
      }
      return contestServer(world)(call);
    },
  });

  it("before voting: says when it opens in Honduras time, and shows the costumes without any standing", async () => {
    const world: World = { gallery: { MOST_ELABORATE: [galleryItem("MOST_ELABORATE", 1)] } };
    const p = await display(world);
    const when = p.text("#when");
    expect(when).toContain("La inscripción de concursantes está abierta hasta las 11:00 p. m. (hora de Honduras).");
    expect(when).toContain("La votación abre a las 11:00 p. m. (hora de Honduras).");
    expect(p.page()).not.toMatch(/latitude|geofence|finalista|preliminar/i);
    expect(p.calls.filter((c) => c.url.includes("/slideshow")).length).toBe(4);
  });

  it("while voting is open: the countdown comes from the server, the way in is this site, and nothing says who is ahead", async () => {
    const p = await display({ phases: { MOST_ELABORATE: "OPEN", SEXIEST: "OPEN" }, gallery: { MOST_ELABORATE: [galleryItem("MOST_ELABORATE", 1)] } });
    expect(p.text("#when")).toMatch(/^Votación abierta · quedan 30:00 · Votá desde tu teléfono en localhost$/);
    expect(p.text("#when")).not.toMatch(/votos|líder|ventaja|ranking/i);
  });

  it("after the close and before the results it thanks and says the winners follow the review; after publication it says who won — or that nobody did", async () => {
    const closed = await display({ phases: { MOST_ELABORATE: "CLOSED", SEXIEST: "CLOSED", BEST_GROUP: "CLOSED", FUNNIEST: "CLOSED" } });
    expect(closed.text("#when")).toBe("La votación cerró. ¡Gracias por participar! Los ganadores se anuncian después de revisar los resultados.");
    const done = await display({ phases: { MOST_ELABORATE: "CLOSED", SEXIEST: "CLOSED" }, published: { MOST_ELABORATE: true, SEXIEST: true }, results: { MOST_ELABORATE: { published: true, kind: "WINNERS", items: [{ alias: "1001", name: "Frankenstein", code: "HAL-22222" }] }, SEXIEST: { published: true, kind: "WINNERS", items: [] } } });
    expect(done.text("#when")).toBe("Sin ganador: Más Sexy.");
  });
});

// ---------------------------------------------------------------- identity: the platform's one seam, never replaced behind a person's back

describe("identity: a verified e-mail and a complete profile — through the platform's own seam, and a session is never replaced", () => {
  it("signs in with an e-mailed code and completes the profile in the page, then continues to the form — no telephone, no other identity", async () => {
    const p = await voter({}, { query: `?c=${CONTEST}&participar=1` });
    await p.type(p.$("#email"), "  persona@ensayo.invalid ");
    await p.clickSel("#sendEmail");
    expect(p.identity.requested).toEqual(["persona@ensayo.invalid"]);
    expect(p.text("#stepIdentity")).toContain("Código enviado a persona@ensayo.invalid");
    await p.type(p.$("#authCode"), " 12345678 ");
    await p.clickSel("#verifyEmail");
    expect(p.identity.verified).toEqual([["persona@ensayo.invalid", "12345678"]]);
    expect(p.$("#stepProfile")).toBeTruthy(); // the e-mail is verified: the profile is next
    expect(p.text("#profileNotice")).toBe("Para participar necesitás completar tu perfil de URBANO Gaming. Solo te pedimos el nombre con el que querés aparecer.");
    await p.type(p.$("#displayName"), "  Marta ");
    await p.clickSel("#saveProfile");
    expect(p.identity.profiles).toEqual(["Marta"]);
    expect(p.$("#registerForm")).toBeTruthy();
    expect(p.markup()).not.toMatch(/\bSMS\b|tel[eé]fono de contacto/i);
  });

  it("a session that appears while the sign-in is open (another tab) is kept: the code is NOT verified over it", async () => {
    const p = await voter({}, { query: `?c=${CONTEST}&participar=1` });
    await p.type(p.$("#email"), "persona@ensayo.invalid");
    await p.clickSel("#sendEmail");
    p.setAuth({ status: "authenticated", email: "otra@ensayo.invalid" }); // someone signed in, in another tab, meanwhile
    await p.type(p.$("#authCode"), "12345678");
    await p.clickSel("#verifyEmail");
    expect(p.identity.verified).toEqual([]);
    expect(p.text(".msg.ok")).toContain("Ya hay una sesión abierta en este navegador");
    expect(p.$("#registerForm")).toBeTruthy(); // the page carries on with the account that is signed in
  });

  it("a signed-in page never asks for a code, and changing account is the person's explicit, confirmed act", async () => {
    const p = await voter({}, { auth: signedIn });
    expect(p.$("#email")).toBeNull();
    expect(p.identity.requested).toEqual([]);
    expect(p.text("#who")).toBe("persona@ensayo.invalid");
    await p.clickSel("#switchAccount");
    expect(p.modal()).toContain("¿Cambiar de cuenta?");
    expect(p.modal()).toContain("Tus votos y tu candidatura, si ya los hiciste, se conservan.");
    expect(p.identity.signOuts).toBe(0);
    await p.clickSel("#switchCancel");
    expect(p.identity.signOuts).toBe(0);
    await p.clickSel("#switchAccount");
    await p.clickSel("#switchConfirm");
    expect(p.identity.signOuts).toBe(1);
    expect(p.$("#entryRegister")).toBeTruthy(); // back at the front door, signed out
    expect(p.text("#who")).toBe("");
  });

  it("a refusal about the person sends them back to the right step instead of showing a dead end", async () => {
    const p = await voter({ registerReply: async () => ({ status: 403, json: { code: "PROFILE_INCOMPLETE" } }) }, { query: `?c=${CONTEST}&participar=1`, auth: signedIn });
    await p.clickSel("#cat_SEXIEST");
    await p.type(p.$("#regName"), "Ana");
    await p.type(p.$("#regNumber"), "9988 7766");
    for (const id of ["#regWaConfirmed", "#regRequirements", "#regDelivery"]) await p.check(p.$(id));
    await p.clickSel("#regSubmit");
    expect(p.text(".msg.err")).toBe("Antes de continuar, completá tu perfil de URBANO Gaming.");
  });
});

// ---------------------------------------------------------------- live state: how soon a page learns what the server decided

describe("live state: the page learns of the opening, the close and the cutoff without a reload — and only from the server's answer", () => {
  it("asks the server again by itself (one request at a time), and shows a category as open the moment the server says so", async () => {
    const world: World = { gallery: { MOST_ELABORATE: [galleryItem("MOST_ELABORATE", 1)] } };
    const p = await voter(world, { auth: signedIn });
    await p.clickSel("#entryVote");
    expect(p.text("#voteHeadline")).toBe("La votación todavía no está abierta.");
    expect(p.timers.length).toBeGreaterThan(0); // the poll is scheduled
    const before = p.calls.filter((c) => c.url === `${CONTESTS}/${CONTEST}`).length;
    world.phases = { MOST_ELABORATE: "OPEN" }; // the operator opened it
    await p.runTimers();
    expect(p.calls.filter((c) => c.url === `${CONTESTS}/${CONTEST}`).length).toBe(before + 1);
    expect(p.text("#voteHeadline")).toBe("La votación está abierta. Elegí una categoría.");
    expect(p.text("#cat-MOST_ELABORATE")).toContain("Votación abierta · todavía no votaste");
  });

  it("learns that registration ended: the form is replaced by the plain statement, with nothing sent for it", async () => {
    const world: World = { registration: "OPEN" };
    const p = await voter(world, { query: `?c=${CONTEST}&participar=1`, auth: signedIn });
    expect(p.$("#registerForm")).toBeTruthy();
    world.registration = "CLOSED";
    await p.runTimers();
    expect(p.$("#registerForm")).toBeNull();
    expect(p.text("#registrationNotice")).toBe("La inscripción de concursantes terminó. Ya no se aceptan nuevas candidaturas.");
    expect(p.posts().filter((c) => /registration/.test(c.url))).toHaveLength(0);
  });

  it("learns the results are published and shows the announcement — a refresh never rebuilds the page under a hand that is typing", async () => {
    const world: World = { registration: "OPEN", phases: { MOST_ELABORATE: "CLOSED" }, results: { MOST_ELABORATE: { published: true, kind: "WINNERS", items: [{ alias: "1001", name: "Frankenstein", code: "HAL-22222" }] } } };
    const typing = await voter(world, { query: `?c=${CONTEST}&participar=1`, auth: signedIn });
    const input = typing.$("#regName") as HTMLInputElement;
    input.focus();
    await typing.type(input, "Escribiendo…");
    world.registration = "CLOSED";
    await typing.runTimers();
    expect((typing.$("#regName") as HTMLInputElement).value).toBe("Escribiendo…"); // the form stays while a hand is on it
    const watching = await voter(world, { auth: signedIn });
    world.published = { MOST_ELABORATE: true };
    await watching.runTimers();
    expect(watching.text("#announcement-MOST_ELABORATE")).toContain("Frankenstein");
  });
});

void REG_OPENS; void VOTE_CLOSES; void TEXTS;
