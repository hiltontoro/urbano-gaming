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
  const LAYOUT = Object.freeze({
    photo: Object.freeze({ x: 105, y: 555, width: 870, height: 750, fit: "contain" }),
    code: Object.freeze({ x: 130, y: 1325, width: 820, height: 205 }),
    cta: Object.freeze({ x: 170, y: 1580, width: 740, height: 104 }),
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

    const [participantPhoto, gaming, pub] = await Promise.all([
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

    // The participant remains recognizable without sacrificing the costume: a softened photo supplies depth while
    // the approved image is rendered in full inside the foreground card below.
    ctx.save();
    ctx.filter = "blur(28px)";
    ctx.globalAlpha = .28;
    cover(ctx, participantPhoto, -45, -45, WIDTH + 90, HEIGHT + 90);
    ctx.restore();

    const shade = ctx.createLinearGradient(0, 0, 0, HEIGHT);
    shade.addColorStop(0, "rgba(8,7,10,.72)");
    shade.addColorStop(.35, "rgba(8,7,10,.54)");
    shade.addColorStop(.72, "rgba(8,7,10,.76)");
    shade.addColorStop(1, "rgba(8,7,10,.98)");
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

    centeredText(ctx, COPY.eyebrow, 300, 28, 700, "#e8b932");
    centeredText(ctx, "ENTRÁ Y VOTÁ", 385, 66, 800, "#f4f0e8");
    centeredText(ctx, "POR MÍ", 475, 92, 800, "#e8b932");
    centeredText(ctx, COPY.instruction, 530, 25, 600, "#f4f0e8");

    const photo = LAYOUT.photo;
    ctx.save();
    roundedRect(ctx, photo.x, photo.y, photo.width, photo.height, 38);
    ctx.clip();
    ctx.fillStyle = "#050507";
    ctx.fillRect(photo.x, photo.y, photo.width, photo.height);
    ctx.save();
    ctx.filter = "blur(18px)";
    ctx.globalAlpha = .34;
    cover(ctx, participantPhoto, photo.x - 24, photo.y - 24, photo.width + 48, photo.height + 48);
    ctx.restore();
    if (photo.fit === "contain") contain(ctx, participantPhoto, photo.x, photo.y, photo.width, photo.height);
    ctx.restore();
    roundedRect(ctx, photo.x, photo.y, photo.width, photo.height, 38);
    ctx.strokeStyle = "rgba(232,185,50,.9)";
    ctx.lineWidth = 4;
    ctx.stroke();

    const codeBox = LAYOUT.code;
    roundedRect(ctx, codeBox.x, codeBox.y, codeBox.width, codeBox.height, 42);
    ctx.fillStyle = "rgba(8,7,10,.88)";
    ctx.fill();
    ctx.strokeStyle = "#e8b932";
    ctx.lineWidth = 4;
    ctx.stroke();
    centeredText(ctx, COPY.code, 1372, 24, 700, "#e8b932");
    centeredText(ctx, code, 1450, 65, 800, "#f4f0e8");

    const cta = LAYOUT.cta;
    roundedRect(ctx, cta.x, cta.y, cta.width, cta.height, 52);
    ctx.fillStyle = "#e8b932";
    ctx.fill();
    centeredText(ctx, COPY.cta, 1632, 31, 800, "#08070a");
    centeredText(ctx, COPY.url, 1748, 24, 600, "#f4f0e8");
    centeredText(ctx, COPY.event, 1792, 19, 700, "#e8b932");

    return canvas;
  }

  async function downloadStory(opts) {
    const code = safeCode(opts && opts.code);
    const canvas = await renderStory(opts);
    const blob = await new Promise((resolve, reject) => canvas.toBlob((value) => value ? resolve(value) : reject(new Error("STORY_EXPORT_FAILED")), "image/png"));
    saveBlob(blob, filename("story", code), opts.document, opts.urlApi);
  }

  return Object.freeze({ WIDTH, HEIGHT, COPY, LAYOUT, safeCode, approvedPhotoUrl, filename, renderStory, downloadPhoto, downloadStory });
})();
