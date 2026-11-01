/*
 * Participant-owned Community Voting downloads. The server decides whether a candidacy is public and returns only the
 * public photo URL, code and public name. This module composes the approved photo into a 1080 x 1920 story locally in
 * the participant's browser; it uploads nothing and receives no private identity fields.
 */
const CommunityVotingShareCard = (() => {
  "use strict";

  const WIDTH = 1080;
  const HEIGHT = 1920;
  const PHOTO_PATH = /^\/api\/gaming\/community-voting\/rounds\/[0-9a-f-]{36}\/photos\/[A-Za-z0-9_-]+$/i;
  const COPY = Object.freeze({
    eyebrow: "CONCURSO DE DISFRACES",
    title: "ENTRÁ Y VOTÁ POR MÍ",
    instruction: "Buscá mi código en URBANO Gaming",
    code: "MI CÓDIGO",
    cta: "ENTRÁ A URBANO GAMING",
    url: "gaming.urbanohn.com",
    event: "LA ÚLTIMA NOCHE · THE PUB",
  });

  function safeCode(raw) {
    const code = typeof raw === "string" ? raw.trim().toUpperCase() : "";
    return /^[A-Z0-9]+(?:-[A-Z0-9]+){1,3}$/.test(code) && code.length <= 24 ? code : "";
  }

  function approvedPhotoUrl(raw, locationLike) {
    if (typeof raw !== "string" || !locationLike || !locationLike.origin) return "";
    try {
      const parsed = new URL(raw, locationLike.origin);
      if (parsed.origin !== locationLike.origin || !PHOTO_PATH.test(parsed.pathname) || parsed.search !== "?v=full" || parsed.hash) return "";
      return parsed.href;
    } catch (_) {
      return "";
    }
  }

  function filename(kind, code, contentType) {
    const safe = safeCode(code) || "participante";
    if (kind === "story") return `urbano-gaming-${safe}-story.png`;
    const ext = /png/i.test(contentType || "") ? "png" : /webp/i.test(contentType || "") ? "webp" : "jpg";
    return `urbano-gaming-${safe}-foto.${ext}`;
  }

  function saveBlob(blob, name, doc, urlApi) {
    const href = urlApi.createObjectURL(blob);
    const a = doc.createElement("a");
    a.href = href;
    a.download = name;
    a.rel = "noopener";
    a.style.display = "none";
    doc.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => urlApi.revokeObjectURL(href), 1000);
  }

  async function downloadPhoto(opts) {
    const code = safeCode(opts && opts.code);
    const url = approvedPhotoUrl(opts && opts.imageUrl, opts && opts.location);
    if (!code || !url) throw new Error("PHOTO_NOT_AVAILABLE");
    const response = await opts.fetch(url, { method: "GET", credentials: "same-origin" });
    if (!response.ok) throw new Error("PHOTO_DOWNLOAD_FAILED");
    const blob = await response.blob();
    if (!/^image\//i.test(blob.type || "")) throw new Error("PHOTO_DOWNLOAD_FAILED");
    saveBlob(blob, filename("photo", code, blob.type), opts.document, opts.urlApi);
  }

  function loadImage(src, ImageCtor) {
    return new Promise((resolve, reject) => {
      const img = new ImageCtor();
      img.decoding = "async";
      img.onload = () => resolve(img);
      img.onerror = () => reject(new Error("IMAGE_LOAD_FAILED"));
      img.src = src;
    });
  }

  function cover(ctx, img, x, y, w, h) {
    const scale = Math.max(w / img.width, h / img.height);
    const sw = w / scale;
    const sh = h / scale;
    const sx = (img.width - sw) / 2;
    const sy = (img.height - sh) / 2;
    ctx.drawImage(img, sx, sy, sw, sh, x, y, w, h);
  }

  function contain(ctx, img, x, y, w, h) {
    const scale = Math.min(w / img.width, h / img.height);
    const dw = img.width * scale;
    const dh = img.height * scale;
    ctx.drawImage(img, x + (w - dw) / 2, y + (h - dh) / 2, dw, dh);
  }

  function roundedRect(ctx, x, y, w, h, radius) {
    const r = Math.min(radius, w / 2, h / 2);
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.arcTo(x + w, y, x + w, y + h, r);
    ctx.arcTo(x + w, y + h, x, y + h, r);
    ctx.arcTo(x, y + h, x, y, r);
    ctx.arcTo(x, y, x + w, y, r);
    ctx.closePath();
  }

  function centeredText(ctx, text, y, size, weight, color) {
    ctx.font = `${weight} ${size}px Montserrat, Arial, sans-serif`;
    ctx.fillStyle = color;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText(text, WIDTH / 2, y);
  }

  async function renderStory(opts) {
    const code = safeCode(opts && opts.code);
    const photoUrl = approvedPhotoUrl(opts && opts.imageUrl, opts && opts.location);
    if (!code || !photoUrl) throw new Error("PHOTO_NOT_AVAILABLE");
    if (opts.document.fonts && opts.document.fonts.ready) await opts.document.fonts.ready;

    const [photo, gaming, pub] = await Promise.all([
      loadImage(photoUrl, opts.Image),
      loadImage("/community-voting-urbano-gaming-lockup.png", opts.Image),
      loadImage("/community-voting-the-pub-logo.jpg", opts.Image),
    ]);

    const canvas = opts.document.createElement("canvas");
    canvas.width = WIDTH;
    canvas.height = HEIGHT;
    const ctx = canvas.getContext("2d", { alpha: false });
    if (!ctx) throw new Error("CANVAS_UNAVAILABLE");

    ctx.fillStyle = "#08070a";
    ctx.fillRect(0, 0, WIDTH, HEIGHT);
    cover(ctx, photo, 0, 0, WIDTH, HEIGHT);

    const shade = ctx.createLinearGradient(0, 0, 0, HEIGHT);
    shade.addColorStop(0, "rgba(8,7,10,.72)");
    shade.addColorStop(.24, "rgba(8,7,10,.22)");
    shade.addColorStop(.60, "rgba(8,7,10,.12)");
    shade.addColorStop(1, "rgba(8,7,10,.94)");
    ctx.fillStyle = shade;
    ctx.fillRect(0, 0, WIDTH, HEIGHT);

    const purple = ctx.createRadialGradient(140, 1480, 20, 140, 1480, 680);
    purple.addColorStop(0, "rgba(124,58,237,.52)");
    purple.addColorStop(1, "rgba(124,58,237,0)");
    ctx.fillStyle = purple;
    ctx.fillRect(0, 850, WIDTH, 1070);

    // Brand row. The source assets are fixed, approved files shipped with the application.
    contain(ctx, gaming, 58, 58, 150, 212);
    ctx.save();
    ctx.beginPath();
    ctx.arc(930, 139, 66, 0, Math.PI * 2);
    ctx.clip();
    cover(ctx, pub, 864, 73, 132, 132);
    ctx.restore();
    ctx.strokeStyle = "rgba(232,185,50,.9)";
    ctx.lineWidth = 3;
    ctx.beginPath();
    ctx.arc(930, 139, 68, 0, Math.PI * 2);
    ctx.stroke();

    centeredText(ctx, COPY.eyebrow, 350, 30, 700, "#e8b932");
    centeredText(ctx, "ENTRÁ Y VOTÁ", 455, 70, 800, "#f4f0e8");
    centeredText(ctx, "POR MÍ", 565, 112, 800, "#e8b932");
    centeredText(ctx, COPY.instruction, 655, 27, 600, "#f4f0e8");

    roundedRect(ctx, 130, 1390, 820, 260, 46);
    ctx.fillStyle = "rgba(8,7,10,.88)";
    ctx.fill();
    ctx.strokeStyle = "#e8b932";
    ctx.lineWidth = 4;
    ctx.stroke();
    centeredText(ctx, COPY.code, 1450, 25, 700, "#e8b932");
    centeredText(ctx, code, 1535, 69, 800, "#f4f0e8");

    roundedRect(ctx, 170, 1695, 740, 104, 52);
    ctx.fillStyle = "#e8b932";
    ctx.fill();
    centeredText(ctx, COPY.cta, 1747, 31, 800, "#08070a");
    centeredText(ctx, COPY.url, 1840, 24, 600, "#f4f0e8");
    centeredText(ctx, COPY.event, 1882, 19, 700, "#e8b932");

    return canvas;
  }

  async function downloadStory(opts) {
    const code = safeCode(opts && opts.code);
    const canvas = await renderStory(opts);
    const blob = await new Promise((resolve, reject) => canvas.toBlob((value) => value ? resolve(value) : reject(new Error("STORY_EXPORT_FAILED")), "image/png"));
    saveBlob(blob, filename("story", code), opts.document, opts.urlApi);
  }

  return Object.freeze({ WIDTH, HEIGHT, COPY, safeCode, approvedPhotoUrl, filename, renderStory, downloadPhoto, downloadStory });
})();
