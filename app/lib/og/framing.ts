/**
 * How a cover frames a post's picture (owner's request, 2026-10-28): without
 * the margins around what it shows, a screenshot's transparent edge or a
 * video thumbnail's black bars, and not at all when it shows nothing, as an
 * animation's blank first frame, the one a cover draws.
 */

/** The part of a picture a cover shows, as fractions of its width and height. */
export interface Frame {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

/** Below this alpha a pixel is transparent. */
const CLEAR = 128;
/** How far a black bar's pixel may stray from black, per channel, as compression leaves it. */
const BLACK = 16;
/** The share of a margin's line that may be something else: noise, or a logo in a bar. */
const STRAY = 0.02;
/** Bars on opposite sides, as letterboxing puts them, differ by at most this share of the side. */
const PAIRED = 0.02;
/** A picture whose colors vary less than this, as a standard deviation, shows nothing. */
const PLAIN = 6;

type Margin = "clear" | "black";

/**
 * The part of a picture inside its margins, from its RGBA pixels drawn
 * `width` by `height`, or null when it shows nothing. Transparent margins
 * go wherever they are; black ones only as bars, on opposite sides at once
 * and of one size, since a dark picture may well have black at one edge.
 */
export function pictureFrame(pixels: Uint8Array, width: number, height: number): Frame | null {
  const kind = (x: number, y: number): Margin | null => {
    const at = (y * width + x) * 4;
    if (pixels[at + 3]! < CLEAR) return "clear";
    return pixels[at]! <= BLACK && pixels[at + 1]! <= BLACK && pixels[at + 2]! <= BLACK ? "black" : null;
  };
  // How many lines from one side are a margin of one kind, the first line's.
  const margin = (lines: number, length: number, pixel: (line: number, along: number) => Margin | null) => {
    let first: Margin | null = null;
    let count = 0;
    for (; count < lines; count += 1) {
      const tally = { clear: 0, black: 0 };
      for (let along = 0; along < length; along += 1) {
        const found = pixel(count, along);
        if (found) tally[found] += 1;
      }
      const most: Margin = tally.clear >= tally.black ? "clear" : "black";
      if (tally[most] < length * (1 - STRAY) || (first && most !== first)) break;
      first = most;
    }
    return { kind: first, count };
  };

  const top = margin(height, width, (line, along) => kind(along, line));
  if (top.count === height) return null;
  const bottom = margin(height - top.count, width, (line, along) => kind(along, height - 1 - line));
  let [up, down] = [top.count, bottom.count];
  if (!bars(top, bottom, height)) {
    if (top.kind === "black") up = 0;
    if (bottom.kind === "black") down = 0;
  }
  const rows = height - up - down;
  const left = margin(width, rows, (line, along) => kind(line, up + along));
  const right = margin(width - left.count, rows, (line, along) => kind(width - 1 - line, up + along));
  let [start, end] = [left.count, right.count];
  if (!bars(left, right, width)) {
    if (left.kind === "black") start = 0;
    if (right.kind === "black") end = 0;
  }

  if (plain(pixels, width, { x: start, y: up, width: width - start - end, height: rows })) return null;
  return { left: start / width, top: up / height, right: (width - end) / width, bottom: (height - down) / height };
}

/** Whether two opposite margins are black bars: both black, and of one size. */
function bars(one: { kind: Margin | null; count: number }, other: { kind: Margin | null; count: number }, side: number) {
  return one.kind === "black" && other.kind === "black" && Math.abs(one.count - other.count) <= side * PAIRED;
}

/** Whether a part of the picture is one color throughout, near enough. */
function plain(pixels: Uint8Array, width: number, part: { x: number; y: number; width: number; height: number }): boolean {
  if (part.width <= 0 || part.height <= 0) return true;
  const sum = [0, 0, 0, 0];
  const squares = [0, 0, 0, 0];
  for (let y = part.y; y < part.y + part.height; y += 1) {
    for (let x = part.x; x < part.x + part.width; x += 1) {
      const at = (y * width + x) * 4;
      for (let channel = 0; channel < 4; channel += 1) {
        const value = pixels[at + channel]!;
        sum[channel]! += value;
        squares[channel]! += value * value;
      }
    }
  }
  const count = part.width * part.height;
  return sum.every((total, channel) => Math.sqrt(Math.max(0, squares[channel]! / count - (total / count) ** 2)) < PLAIN);
}
