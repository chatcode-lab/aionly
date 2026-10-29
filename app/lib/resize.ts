/**
 * Smaller copies of stored pictures, made by Cloudflare's image resizing on
 * the media domain (owner's decision, 2026-10-28). A copy is made on its
 * first request and then kept in Cloudflare's cache with the picture's own
 * lifetime; each picture at each width counts once a month toward the
 * zone's transformations. `format=auto` sends AVIF or WebP to browsers that
 * take them, and `onerror=redirect` falls back to the picture itself
 * whenever a copy cannot be made.
 */

import type { Frame } from "./og/framing";

/** A stored picture on its public domain: a 24-character key and its type's extension. */
const STORED = /^(https:\/\/[^/]+)\/([0-9A-Za-z]{24}\.(?:jpg|png|webp))$/;

/** The widths a picture in the column is offered at, as far as its own goes. */
const COLUMN_WIDTHS = [400, 800, 1200, 1600];

/** The widths an avatar is offered at, below its stored 320 px. */
const AVATAR_WIDTHS = [64, 128];

/** How wide a picture in the column is drawn: the column's width, or the screen's below it. */
export const COLUMN_SIZES = "(min-width: 42.5rem) 42.5rem, 100vw";

/** A picture's sources for `<img>`; none for an address that cannot be resized. */
type Sources = { srcSet?: string; sizes?: string };

/**
 * A stored picture at a width, never enlarged, or null for any other
 * address, such as the Worker's own `/img/<key>` in local development and
 * tests, where there is nothing to resize it.
 */
export function resized(src: string, width: number): string | null {
  const match = STORED.exec(src);
  if (!match) return null;
  return `${match[1]}/cdn-cgi/image/width=${width},fit=scale-down,format=auto,onerror=redirect/${match[2]}`;
}

/**
 * A picture in the column, `sizes` saying how wide it is drawn when it is
 * narrower than the column. Its own width, when known, is the largest
 * offered; otherwise every width is, and a copy never grows past the
 * picture.
 */
export function columnSources(src: string, own?: number, sizes = COLUMN_SIZES): Sources {
  if (!resized(src, 1)) return {};
  const widest = Math.min(own ?? Infinity, COLUMN_WIDTHS.at(-1)!);
  const widths = [...COLUMN_WIDTHS.filter((width) => width < widest), widest];
  return { srcSet: widths.map((width) => `${resized(src, width)} ${width}w`).join(", "), sizes };
}

/** An avatar drawn `size` pixels wide: a small copy, or the stored 320 px one on a dense screen. */
export function avatarSources(src: string, size: number): Sources {
  if (!resized(src, 1)) return {};
  return { srcSet: [...AVATAR_WIDTHS.map((width) => `${resized(src, width)} ${width}w`), `${src} 320w`].join(", "), sizes: `${size}px` };
}

/** A picture as an email shows it: its copy's address, and the size it is drawn at. */
export interface EmailPicture {
  src: string;
  width: number;
  height: number;
}

/**
 * A stored picture as an email shows it (owner's request, 2026-10-29): cut
 * to its frame, as a cover shows it (see ./og/framing.ts), and drawn as
 * large as `box` allows; its copy twice that for dense screens, never
 * enlarged, in baseline JPEG, which every mail app shows whatever its image
 * proxy asks for. Null for an address that cannot be resized.
 */
export function emailPicture(src: string, picture: { width: number; height: number; frame: Frame }, box: { width: number; height: number }): EmailPicture | null {
  const match = STORED.exec(src);
  if (!match) return null;
  const { width, height, frame } = picture;
  // In pixels of the picture itself, top, right, bottom, and left, as `trim` takes them.
  const cut = [frame.top * height, (1 - frame.right) * width, (1 - frame.bottom) * height, frame.left * width].map(Math.round);
  const shown = { width: width - cut[1]! - cut[3]!, height: height - cut[0]! - cut[2]! };
  const scale = Math.min(box.width / shown.width, box.height / shown.height);
  const drawn = { width: Math.round(shown.width * scale), height: Math.round(shown.height * scale) };
  const trim = cut.some(Boolean) ? `trim=${cut.join(";")},` : "";
  return { src: `${match[1]}/cdn-cgi/image/${trim}width=${drawn.width * 2},fit=scale-down,format=baseline-jpeg,onerror=redirect/${match[2]}`, ...drawn };
}
