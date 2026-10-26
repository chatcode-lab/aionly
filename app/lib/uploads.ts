/** What an upload can be, shared by the form and the server. */
export type MediaType = "image" | "video" | "audio";

const MB = 1024 * 1024;

/** The largest file of each kind. Request bodies through Cloudflare stop at 100 MB. */
export const UPLOAD_LIMITS: Record<MediaType, number> = {
  image: 10 * MB,
  video: 50 * MB,
  audio: 20 * MB,
};

/** Types every current browser shows or plays; the server checks the bytes. */
export const UPLOAD_ACCEPT = [
  "image/jpeg",
  "image/png",
  "image/webp",
  "image/gif",
  "image/avif",
  "video/mp4",
  "video/webm",
  "video/quicktime",
  "audio/mpeg",
  "audio/mp4",
  "audio/x-m4a",
  "audio/ogg",
  "audio/wav",
  "audio/x-wav",
  "audio/flac",
].join(",");

/** The kind a browser-reported type points to, before the server checks. */
export function mediaTypeOf(type: string): MediaType | null {
  if (type.startsWith("image/")) return "image";
  if (type.startsWith("video/")) return "video";
  if (type.startsWith("audio/")) return "audio";
  return null;
}

export function sizeLabel(bytes: number): string {
  return `${Math.round(bytes / MB)} MB`;
}

/**
 * What a file is, read from its first bytes. Only types every current
 * browser shows or plays are kept.
 */
export interface Sniffed {
  media: MediaType;
  contentType: string;
  extension: string;
}

const ascii = (bytes: Uint8Array, offset: number, length: number) =>
  String.fromCharCode(...bytes.subarray(offset, offset + length));

export function sniffMedia(bytes: Uint8Array): Sniffed | null {
  const at = (offset: number, ...values: number[]) => values.every((value, index) => bytes[offset + index] === value);
  if (at(0, 0xff, 0xd8, 0xff)) return { media: "image", contentType: "image/jpeg", extension: "jpg" };
  if (at(0, 0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a)) return { media: "image", contentType: "image/png", extension: "png" };
  if (ascii(bytes, 0, 6) === "GIF87a" || ascii(bytes, 0, 6) === "GIF89a") return { media: "image", contentType: "image/gif", extension: "gif" };
  if (ascii(bytes, 0, 4) === "RIFF") {
    const form = ascii(bytes, 8, 4);
    if (form === "WEBP") return { media: "image", contentType: "image/webp", extension: "webp" };
    if (form === "WAVE") return { media: "audio", contentType: "audio/wav", extension: "wav" };
    return null;
  }
  if (ascii(bytes, 0, 4) === "OggS") return { media: "audio", contentType: "audio/ogg", extension: "ogg" };
  if (ascii(bytes, 0, 4) === "fLaC") return { media: "audio", contentType: "audio/flac", extension: "flac" };
  if (ascii(bytes, 0, 3) === "ID3" || (bytes[0] === 0xff && ((bytes[1] ?? 0) & 0xe6) === 0xe2)) {
    // An ID3 tag, or an MPEG audio frame of layer III.
    return { media: "audio", contentType: "audio/mpeg", extension: "mp3" };
  }
  if (at(0, 0x1a, 0x45, 0xdf, 0xa3)) return { media: "video", contentType: "video/webm", extension: "webm" };
  if (ascii(bytes, 4, 4) === "ftyp") {
    const brand = ascii(bytes, 8, 4);
    if (brand === "avif" || brand === "avis") return { media: "image", contentType: "image/avif", extension: "avif" };
    // HEIF pictures are not shown by every browser.
    if (["heic", "heix", "hevc", "mif1", "msf1"].includes(brand)) return null;
    if (brand === "M4A " || brand === "M4B ") return { media: "audio", contentType: "audio/mp4", extension: "m4a" };
    if (brand === "qt  ") return { media: "video", contentType: "video/quicktime", extension: "mov" };
    return { media: "video", contentType: "video/mp4", extension: "mp4" };
  }
  return null;
}

/**
 * A JPEG without its metadata segments: EXIF, which can carry where a photo
 * was taken, XMP, and comments. The picture itself is untouched.
 */
export function stripJpegMetadata(bytes: Uint8Array<ArrayBuffer>): Uint8Array<ArrayBuffer> {
  const kept: Uint8Array[] = [bytes.subarray(0, 2)];
  let offset = 2;
  while (offset + 4 <= bytes.length && bytes[offset] === 0xff) {
    const marker = bytes[offset + 1]!;
    // Start of scan: the picture data follows, to the end.
    if (marker === 0xda) break;
    const length = (bytes[offset + 2]! << 8) | bytes[offset + 3]!;
    if (length < 2 || offset + 2 + length > bytes.length) return bytes;
    // EXIF and XMP (APP1), IPTC (APP13), and comments. The color profile
    // (APP2) and Adobe's color marker (APP14) stay, or colors would shift.
    const metadata = marker === 0xe1 || marker === 0xed || marker === 0xfe;
    if (!metadata) kept.push(bytes.subarray(offset, offset + 2 + length));
    offset += 2 + length;
  }
  kept.push(bytes.subarray(offset));
  const total = kept.reduce((sum, part) => sum + part.length, 0);
  const out = new Uint8Array(total);
  let at = 0;
  for (const part of kept) {
    out.set(part, at);
    at += part.length;
  }
  return out;
}


/** A picture's size in pixels, which lays a page out before it loads. */
export interface PictureSize {
  width: number;
  height: number;
}

const sized = (width: number, height: number): PictureSize | null =>
  width > 0 && height > 0 && width <= 100000 && height <= 100000 ? { width, height } : null;

/**
 * A picture's size, read from its own bytes as its header states it: JPEG,
 * PNG, GIF, WebP, and AVIF. Null when the header cannot be read. A JPEG's
 * orientation tag is ignored, as the board drops it with the rest of EXIF.
 */
export function pictureSize(bytes: Uint8Array): PictureSize | null {
  const u16be = (at: number) => ((bytes[at] ?? 0) << 8) | (bytes[at + 1] ?? 0);
  const u16le = (at: number) => (bytes[at] ?? 0) | ((bytes[at + 1] ?? 0) << 8);
  const u24le = (at: number) => u16le(at) | ((bytes[at + 2] ?? 0) << 16);
  const u32be = (at: number) => u16be(at) * 0x10000 + u16be(at + 2);
  const sniffed = sniffMedia(bytes.subarray(0, 16));
  if (!sniffed || sniffed.media !== "image") return null;
  switch (sniffed.contentType) {
    case "image/png":
      // The header chunk comes first: width and height after its name.
      return ascii(bytes, 12, 4) === "IHDR" ? sized(u32be(16), u32be(20)) : null;
    case "image/gif":
      return sized(u16le(6), u16le(8));
    case "image/webp": {
      const chunk = ascii(bytes, 12, 4);
      if (chunk === "VP8 ") return sized(u16le(26) & 0x3fff, u16le(28) & 0x3fff);
      if (chunk === "VP8L") {
        const bits = (bytes[21] ?? 0) | ((bytes[22] ?? 0) << 8) | ((bytes[23] ?? 0) << 16) | ((bytes[24] ?? 0) << 24);
        return sized((bits & 0x3fff) + 1, ((bits >>> 14) & 0x3fff) + 1);
      }
      if (chunk === "VP8X") return sized(u24le(24) + 1, u24le(27) + 1);
      return null;
    }
    case "image/jpeg": {
      // Segments follow one another to a start-of-frame, which holds the size.
      let at = 2;
      while (at + 9 < bytes.length && bytes[at] === 0xff) {
        const marker = bytes[at + 1]!;
        if (marker === 0xd8 || (marker >= 0xd0 && marker <= 0xd7) || marker === 0x01 || marker === 0xff) {
          at += marker === 0xff ? 1 : 2;
          continue;
        }
        const frame = marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
        if (frame) return sized(u16be(at + 7), u16be(at + 5));
        if (marker === 0xda) return null;
        at += 2 + u16be(at + 2);
      }
      return null;
    }
    case "image/avif": {
      // The first image spatial extent property: version and flags, then width and height.
      for (let at = 12; at + 16 <= Math.min(bytes.length, 65536); at += 1) {
        if (bytes[at] === 0x69 && ascii(bytes, at, 4) === "ispe") return sized(u32be(at + 8), u32be(at + 12));
      }
      return null;
    }
    default:
      return null;
  }
}
