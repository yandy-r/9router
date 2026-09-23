/**
 * Resolve OpenAI image_url parts into validated inline image bytes for the
 * Cursor AgentService SelectedImage encoder.
 *
 * Fail-closed: any malformed, oversized, mismatched, or unfetchable image
 * throws instead of being silently dropped — dropping would change the
 * request the model sees without telling the caller.
 */
import crypto from "node:crypto";
import { parseDataUri, detectImageMime, fetchImageAsBase64 } from "../translator/concerns/image.js";
import { MAX_IMAGE_BYTES, CURSOR_MAX_TOTAL_IMAGE_BYTES } from "../config/mediaConfig.js";
import { OPENAI_BLOCK } from "../translator/schema/index.js";

// ponytail: stdlib-only header parsers for the four signed formats we accept.
// Others (bmp) are still valid images but carry no dimension — omitted field.
function imageDimensions(buf) {
  // PNG: 8B sig + 4B len + "IHDR" + u32 w + u32 h
  if (buf.length >= 24 && buf[0] === 0x89 && buf[12] === 0x49 && buf[13] === 0x48) {
    return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
  }
  // GIF: "GIF8" + u16le w + u16le h
  if (buf.length >= 10 && buf[0] === 0x47 && buf[1] === 0x49 && buf[2] === 0x46) {
    return { width: buf.readUInt16LE(6), height: buf.readUInt16LE(8) };
  }
  // WebP: RIFF....WEBP + VP8X(10B header) / VP8L(5B) / VP8 (10B)
  if (buf.length >= 30 && buf[0] === 0x52 && buf[8] === 0x57) {
    const fourcc = buf.toString("latin1", 12, 16);
    if (fourcc === "VP8X") return { width: 1 + buf.readUIntLE(24, 3), height: 1 + buf.readUIntLE(27, 3) };
    if (fourcc === "VP8L" && buf[20] === 0x2f) {
      const b = buf.readUInt32LE(21);
      return { width: (b & 0x3fff) + 1, height: ((b >> 14) & 0x3fff) + 1 };
    }
    if (fourcc === "VP8 " && buf.length >= 30) {
      return { width: buf.readUInt16LE(26) & 0x3fff, height: buf.readUInt16LE(28) & 0x3fff };
    }
  }
  // JPEG: scan SOF0-SOF15 (except DHT/DAC/extend) segments
  if (buf.length >= 4 && buf[0] === 0xff && buf[1] === 0xd8) {
    let off = 2;
    while (off + 9 <= buf.length) {
      if (buf[off] !== 0xff) { off++; continue; }
      const marker = buf[off + 1];
      if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
        return { width: buf.readUInt16BE(off + 7), height: buf.readUInt16BE(off + 5) };
      }
      if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd9)) { off += 2; continue; }
      off += 2 + buf.readUInt16BE(off + 2);
    }
  }
  return null;
}

export class CursorImageError extends Error {}

function bad(part, why) {
  return new CursorImageError(`Cursor AgentService: image part ${part} ${why}`);
}

// One image_url part → { uuid, data, mimeType, width?, height? }. Throws on any failure.
export async function resolveCursorImage(part, index, { signal } = {}) {
  const raw = part?.[OPENAI_BLOCK.IMAGE_URL];
  const url = typeof raw === "string" ? raw : raw?.url;
  if (typeof url !== "string" || !url) throw bad(index, "is missing a URL");

  let dataUri = url;
  if (url.startsWith("http://") || url.startsWith("https://")) {
    const fetched = await fetchImageAsBase64(url, { signal });
    if (!fetched) throw bad(index, `could not be fetched securely (${url.slice(0, 120)})`);
    dataUri = fetched.url;
  }

  const parsed = parseDataUri(dataUri);
  if (!parsed) throw bad(index, "must be a base64 data: URI or an https:// image URL");
  if (!/^image\//i.test(parsed.mimeType)) {
    throw bad(index, `has non-image media type "${parsed.mimeType}"`);
  }
  const estimated = Math.floor(parsed.base64.length * 3 / 4);
  if (estimated > MAX_IMAGE_BYTES + 3) throw bad(index, `exceeds ${MAX_IMAGE_BYTES} bytes`);
  const data = Buffer.from(parsed.base64.replace(/\s+/g, ""), "base64");
  // Node's decoder silently skips junk; re-encode must round-trip exactly.
  if (data.toString("base64").replace(/=+$/, "") !== parsed.base64.replace(/\s+/g, "").replace(/=+$/, "")) {
    throw bad(index, "is not valid base64");
  }
  if (!data.length) throw bad(index, "decodes to zero bytes");
  if (data.length > MAX_IMAGE_BYTES) {
    throw bad(index, `exceeds ${MAX_IMAGE_BYTES} bytes (${data.length})`);
  }
  const mime = detectImageMime(data);
  if (!mime) throw bad(index, "bytes are not a recognized image format");
  if (mime !== parsed.mimeType.toLowerCase().replace("image/jpg", "image/jpeg")) {
    throw bad(index, `declared "${parsed.mimeType}" but bytes are "${mime}"`);
  }
  return { uuid: crypto.randomUUID(), data, mimeType: mime, ...imageDimensions(data) };
}

// Resolve every image_url part across all messages, enforcing the per-turn cap.
export async function resolveCursorImages(messages, { signal } = {}) {
  const refs = [];
  (messages || []).forEach((message, messageIndex) => {
    if (!Array.isArray(message?.content)) return;
    message.content.forEach((part) => {
      if (part?.type === OPENAI_BLOCK.IMAGE_URL) refs.push({ part, messageIndex });
    });
  });

  const images = [];
  let totalBytes = 0;
  for (let i = 0; i < refs.length; i++) {
    const image = await resolveCursorImage(refs[i].part, i, { signal });
    totalBytes += image.data.length;
    if (totalBytes > CURSOR_MAX_TOTAL_IMAGE_BYTES) {
      throw bad(i, `would exceed the ${CURSOR_MAX_TOTAL_IMAGE_BYTES} byte per-turn image budget`);
    }
    images.push({ ...image, messageIndex: refs[i].messageIndex });
  }
  return images;
}
