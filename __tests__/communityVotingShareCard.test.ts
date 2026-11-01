import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

interface ShareCard {
  WIDTH: number;
  HEIGHT: number;
  COPY: Record<string, string>;
  LAYOUT: {
    photo: { x: number; y: number; width: number; height: number; fit: string };
    code: { x: number; y: number; width: number; height: number };
  };
  safeCode(raw: unknown): string;
  approvedPhotoUrl(raw: unknown, location: { origin: string }): string;
  filename(kind: "photo" | "story", code: string, contentType?: string): string;
}

function load(): ShareCard {
  const source = readFileSync("public/communityVotingShareCard.js", "utf8");
  // eslint-disable-next-line @typescript-eslint/no-implied-eval
  return new Function(`${source}\nreturn CommunityVotingShareCard;`)() as ShareCard;
}

const S = load();
const ORIGIN = { origin: "https://gaming.urbanohn.com" };
const PHOTO = "/api/gaming/community-voting/rounds/00000000-0000-4000-8000-000000000001/photos/4821?v=full";

describe("participant share assets", () => {
  it("pins the Instagram story dimensions and the approved participant-first copy", () => {
    expect([S.WIDTH, S.HEIGHT]).toEqual([1080, 1920]);
    expect(S.COPY).toMatchObject({
      title: "ENTRÁ Y VOTÁ POR MÍ",
      instruction: "Buscá mi código en URBANO Gaming",
      cta: "ENTRÁ A URBANO GAMING",
      url: "gaming.urbanohn.com",
      event: "LA ÚLTIMA NOCHE · THE PUB",
    });
  });

  it("preserves the full costume in a large portrait card with the code directly below", () => {
    expect(S.LAYOUT.photo).toMatchObject({ fit: "contain" });
    expect(S.LAYOUT.photo.width).toBeGreaterThanOrEqual(760);
    expect(S.LAYOUT.photo.height).toBeGreaterThanOrEqual(680);
    expect(S.LAYOUT.code.y).toBeGreaterThanOrEqual(S.LAYOUT.photo.y + S.LAYOUT.photo.height);
    expect(S.LAYOUT.code.y - (S.LAYOUT.photo.y + S.LAYOUT.photo.height)).toBeLessThanOrEqual(40);
  });

  it("accepts only the public full-photo route on the current origin", () => {
    expect(S.approvedPhotoUrl(PHOTO, ORIGIN)).toBe(`https://gaming.urbanohn.com${PHOTO}`);
    expect(S.approvedPhotoUrl(PHOTO.replace("v=full", "v=thumb"), ORIGIN)).toBe("");
    expect(S.approvedPhotoUrl(`https://evil.example${PHOTO}`, ORIGIN)).toBe("");
    expect(S.approvedPhotoUrl("data:image/png;base64,no", ORIGIN)).toBe("");
  });

  it("uses only the public code in safe, predictable download filenames", () => {
    expect(S.safeCode(" hal-k7m2q ")).toBe("HAL-K7M2Q");
    expect(S.safeCode("../../private@email.com")).toBe("");
    expect(S.filename("story", "HAL-K7M2Q")).toBe("urbano-gaming-HAL-K7M2Q-story.png");
    expect(S.filename("photo", "HAL-K7M2Q", "image/webp")).toBe("urbano-gaming-HAL-K7M2Q-foto.webp");
  });

  it("contains no private identity fields or upload action", () => {
    const source = readFileSync("public/communityVotingShareCard.js", "utf8");
    expect(source).not.toMatch(/phone|whatsapp|authUserId|memberId|entryId|candidateId/i);
    expect(source).not.toMatch(/method:\s*["'](?:POST|PUT|PATCH|DELETE)/i);
  });
});
