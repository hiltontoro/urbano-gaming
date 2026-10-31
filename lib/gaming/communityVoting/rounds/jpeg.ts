/**
 * Photograph sanitizing for contestant photos.
 *
 * Photos are taken on a tablet at a bar and published to a crowd. A phone camera embeds an EXIF block that can
 * carry a GPS position, a device name, a timestamp and a thumbnail of the unedited picture, and a JPEG can carry a
 * free-text comment. None of that may reach a public page. The browser re-encodes the picture before upload, but
 * the server never trusts the browser: this module walks the JPEG's segment structure and rebuilds the file
 * WITHOUT any application-metadata (APP1..APP15) or comment (COM) segment, keeping only what the image needs.
 *
 * It is a structural filter, not a decoder: it does not decompress pixels. It rejects anything that is not a
 * well-formed baseline or progressive JPEG, and enforces size and dimension limits. It never throws.
 */

export interface JpegLimits {
  maxBytes: number;
  maxLongSide: number;
}

export type SanitizeJpegResult =
  | { ok: true; bytes: Uint8Array; width: number; height: number; removedSegments: number }
  | { ok: false; reason: "NOT_JPEG" | "TRUNCATED" | "TOO_LARGE" | "DIMENSIONS_EXCEEDED" | "UNSUPPORTED_ENCODING" };

const SUPPORTED_SOF = new Set([0xc0, 0xc1, 0xc2]); // baseline, extended sequential, progressive (Huffman)
const UNSUPPORTED_SOF = new Set([0xc3, 0xc5, 0xc6, 0xc7, 0xc8, 0xc9, 0xca, 0xcb, 0xcc, 0xcd, 0xce, 0xcf]);

export function sanitizeJpeg(input: Uint8Array, limits: JpegLimits): SanitizeJpegResult {
  try {
    return sanitize(input, limits);
  } catch {
    return { ok: false, reason: "NOT_JPEG" };
  }
}

function sanitize(input: Uint8Array, limits: JpegLimits): SanitizeJpegResult {
  if (input.length > limits.maxBytes) return { ok: false, reason: "TOO_LARGE" };
  if (input.length < 4 || input[0] !== 0xff || input[1] !== 0xd8) return { ok: false, reason: "NOT_JPEG" };

  const out: number[] = [0xff, 0xd8];
  let pos = 2;
  let removed = 0;
  let width = 0;
  let height = 0;
  let sawFrame = false;

  for (;;) {
    // find the next marker: 0xFF, then any number of 0xFF fill bytes, then the marker code
    if (pos >= input.length) return { ok: false, reason: "TRUNCATED" };
    if (input[pos] !== 0xff) return { ok: false, reason: "NOT_JPEG" };
    while (pos < input.length && input[pos] === 0xff) pos++;
    if (pos >= input.length) return { ok: false, reason: "TRUNCATED" };
    const marker = input[pos++];

    if (marker === 0xd9) {
      // EOI before any scan: there is no image
      return { ok: false, reason: "NOT_JPEG" };
    }
    if (marker === 0x00 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd8)) {
      return { ok: false, reason: "NOT_JPEG" };
    }

    if (pos + 2 > input.length) return { ok: false, reason: "TRUNCATED" };
    const length = (input[pos] << 8) | input[pos + 1];
    if (length < 2) return { ok: false, reason: "NOT_JPEG" };
    if (pos + length > input.length) return { ok: false, reason: "TRUNCATED" };
    const payload = input.subarray(pos + 2, pos + length);
    const segment = input.subarray(pos - 2, pos + length); // FF, marker, length, payload

    if (marker >= 0xe1 && marker <= 0xef) {
      removed++; // APP1..APP15: EXIF, XMP, ICC, Photoshop, vendor blocks
    } else if (marker === 0xfe) {
      removed++; // COM: free text
    } else if (marker === 0xe0) {
      const isPlainJfif = payload.length === 14 && payload[0] === 0x4a && payload[1] === 0x46 && payload[2] === 0x49 && payload[3] === 0x46 && payload[4] === 0x00;
      if (isPlainJfif) {
        for (const b of segment) out.push(b);
      } else {
        removed++; // an APP0 that is not a bare JFIF header (e.g. one carrying an embedded thumbnail)
      }
    } else if (UNSUPPORTED_SOF.has(marker)) {
      return { ok: false, reason: "UNSUPPORTED_ENCODING" };
    } else {
      if (SUPPORTED_SOF.has(marker)) {
        if (payload.length < 6) return { ok: false, reason: "NOT_JPEG" };
        height = (payload[1] << 8) | payload[2];
        width = (payload[3] << 8) | payload[4];
        if (width < 1 || height < 1) return { ok: false, reason: "NOT_JPEG" };
        if (Math.max(width, height) > limits.maxLongSide) return { ok: false, reason: "DIMENSIONS_EXCEEDED" };
        sawFrame = true;
      }
      for (const b of segment) out.push(b);
    }
    pos += length;

    if (marker === 0xda) {
      if (!sawFrame) return { ok: false, reason: "NOT_JPEG" };
      // entropy-coded scan data: copy until a marker that is neither byte stuffing (FF00) nor a restart (FFD0..D7)
      for (;;) {
        if (pos >= input.length) return { ok: false, reason: "TRUNCATED" };
        const byte = input[pos];
        if (byte !== 0xff) {
          out.push(byte);
          pos++;
          continue;
        }
        let next = pos + 1;
        while (next < input.length && input[next] === 0xff) next++; // fill bytes
        if (next >= input.length) return { ok: false, reason: "TRUNCATED" };
        const code = input[next];
        if (code === 0x00 || (code >= 0xd0 && code <= 0xd7)) {
          out.push(0xff, code);
          pos = next + 1;
          continue;
        }
        if (code === 0xd9) {
          out.push(0xff, 0xd9);
          return { ok: true, bytes: Uint8Array.from(out), width, height, removedSegments: removed };
        }
        pos = next - 1; // a real marker (e.g. the next scan's DHT/SOS of a progressive JPEG): hand back to the segment loop
        break;
      }
    }
  }
}
