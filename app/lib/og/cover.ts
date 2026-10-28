import type { Frame } from "./framing";
import type { FontMetrics } from "./metrics";

/**
 * The covers shown when a page of the board is shared: 1200 by 630, the
 * board's own colors on a soft ground, the logo, a large title, a short description, and
 * a line saying whose it is, or a post's picture beside its title. Drawn
 * as SVG here and rendered to PNG by resvg (see render.server.ts). Plain
 * text and soft color, so a cover renders in a few milliseconds and reads
 * at thumbnail size.
 */

export const WIDTH = 1200;
export const HEIGHT = 630;

const COLORS = {
  ground: "#f7f6f3",
  groundDeep: "#ebe7e1",
  text: "#1b1a18",
  muted: "#55524c",
  faint: "#6f6b64",
  accent: "#c2410c",
  line: "#e4e2dd",
} as const;

export const FAMILY = { regular: "Inter", semibold: "Inter Display SemiBold" } as const;

export interface Fonts {
  regular: FontMetrics;
  semibold: FontMetrics;
}

/** A picture to show beside the text, as a data address of its bytes. */
export interface Picture {
  href: string;
}

/** A post's picture: its size in pixels, and the part of it a cover shows (see ./framing.ts). */
export interface FramedPicture extends Picture {
  width: number;
  height: number;
  frame: Frame;
}

export type Cover =
  | { kind: "site"; tagline: string; promise: string }
  | { kind: "page"; title: string; description: string; address: string }
  | { kind: "post"; title: string; description: string; byline: string; picture?: FramedPicture }
  | {
      kind: "profile";
      name: string;
      subtitle: string;
      address: string;
      avatar: { color: string; letter: string } | Picture;
    };

const MARGIN = 72;
/** A post's picture is at most this wide, and as tall as the margins allow. */
const CARD_WIDTH = 520;
const CARD_HEIGHT = HEIGHT - MARGIN * 2;
/** Between the text and the picture. */
const GAP = 56;
const FOOTER_BASELINE = HEIGHT - 64;
/** Text stops this far above the footer. */
const BODY_BOTTOM = FOOTER_BASELINE - 72;

/**
 * The ground: warm off-white, a little deeper toward the bottom right, where
 * a faint glow of the accent rises, so a cover sits softly in light and dark
 * feeds alike (owner's choice, 2026-10-28).
 */
const GROUND = [
  `<defs><linearGradient id="ground" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="${COLORS.ground}"/><stop offset="1" stop-color="${COLORS.groundDeep}"/></linearGradient>`,
  `<radialGradient id="ember" cx="1" cy="1" r="0.8"><stop offset="0" stop-color="${COLORS.accent}" stop-opacity="0.16"/><stop offset="1" stop-color="${COLORS.accent}" stop-opacity="0"/></radialGradient></defs>`,
  `<rect width="${WIDTH}" height="${HEIGHT}" fill="url(#ground)"/><rect width="${WIDTH}" height="${HEIGHT}" fill="url(#ember)"/>`,
].join("");

const escape = (text: string) =>
  text.replace(/[<>&'"]/g, (char) => `&${{ "<": "lt", ">": "gt", "&": "amp", "'": "apos", '"': "quot" }[char]};`);

/**
 * Text as the fonts can draw it: one line, control characters and anything
 * the font lacks (emoji, scripts it does not cover) left out, spaces
 * collapsed.
 */
export function drawable(text: string, font: FontMetrics): string {
  let out = "";
  for (const char of text.replace(/\s+/g, " ")) {
    const code = char.codePointAt(0)!;
    if (char === " " || (code >= 0x20 && font.advance(code) !== null)) out += char;
  }
  return out.replace(/ {2,}/g, " ").trim();
}

/** A line's width in pixels at a size. */
export function measure(text: string, font: FontMetrics, size: number): number {
  let width = 0;
  for (const char of text) width += font.advance(char.codePointAt(0)!) ?? 0.6;
  return width * size;
}

/**
 * Breaks text into at most `maxLines` lines that fit `width`, at spaces, or
 * inside a word too long for a line. Text left over ends the last line with
 * an ellipsis.
 */
export function wrap(
  text: string,
  font: FontMetrics,
  size: number,
  width: number,
  maxLines: number,
): { lines: string[]; complete: boolean } {
  const fits = (line: string) => measure(line, font, size) <= width;
  const words = text.split(" ").filter(Boolean);
  const lines: string[] = [];
  let line = "";
  let index = 0;
  while (index < words.length && lines.length < maxLines) {
    const word = words[index]!;
    const candidate = line ? `${line} ${word}` : word;
    if (fits(candidate)) {
      line = candidate;
      index += 1;
      continue;
    }
    if (line) {
      lines.push(line);
      line = "";
      continue;
    }
    // A word wider than a whole line is cut where it stops fitting.
    let cut = 1;
    const chars = [...word];
    while (cut < chars.length && fits(chars.slice(0, cut + 1).join(""))) cut += 1;
    lines.push(chars.slice(0, cut).join(""));
    words[index] = chars.slice(cut).join("");
  }
  if (line && lines.length < maxLines) lines.push(line);
  const complete = index >= words.length;
  if (!complete && lines.length > 0) {
    let last = lines[lines.length - 1]!;
    while (last && !fits(`${last}…`)) last = [...last].slice(0, -1).join("").trimEnd();
    lines[lines.length - 1] = `${last.replace(/[\s,;:.–—-]+$/, "")}…`;
  }
  return { lines, complete };
}

interface TextBlock {
  lines: string[];
  size: number;
  lineHeight: number;
  family: string;
  color: string;
}

/** The largest size, of those given, at which the text fits; else the smallest, cut short. */
function fitTitle(text: string, font: FontMetrics, sizes: number[], width: number, maxLines: number): TextBlock {
  for (const size of sizes) {
    const wrapped = wrap(text, font, size, width, maxLines);
    if (wrapped.complete) return block(wrapped.lines, size, 1.12, FAMILY.semibold, COLORS.text);
  }
  const size = sizes[sizes.length - 1]!;
  return block(wrap(text, font, size, width, maxLines).lines, size, 1.12, FAMILY.semibold, COLORS.text);
}

function block(lines: string[], size: number, leading: number, family: string, color: string): TextBlock {
  return { lines, size, lineHeight: Math.round(size * leading), family, color };
}

/** Lines of text whose capitals start at `top`; returns the SVG and where the block ends. */
function textAt(text: TextBlock, x: number, top: number): { svg: string; bottom: number } {
  const first = top + Math.round(text.size * 0.73);
  const spans = text.lines
    .map((line, index) => `<tspan x="${x}" y="${first + index * text.lineHeight}">${escape(line)}</tspan>`)
    .join("");
  const svg = `<text font-family="${text.family}" font-size="${text.size}" fill="${text.color}">${spans}</text>`;
  return { svg, bottom: first + (text.lines.length - 1) * text.lineHeight + Math.round(text.size * 0.24) };
}

/** The wordmark, its "ai" in the accent, as the site header's name shows it. */
function wordmark(x: number, baseline: number, size: number): string {
  return `<text x="${x}" y="${baseline}" font-family="${FAMILY.semibold}" font-size="${size}" fill="${COLORS.text}"><tspan fill="${COLORS.accent}">ai</tspan>on.ly</text>`;
}

/**
 * The header's eyes (see ~/components/site-logo), `width` across and half
 * as tall, looking down at the name, from x, y at their top left.
 */
function eyes(x: number, y: number, width: number): string {
  return [
    `<g transform="translate(${x} ${y}) scale(${width / 48})" fill="none" stroke-width="4">`,
    `<circle cx="12" cy="12" r="8.5" stroke="${COLORS.text}"/><rect x="27" y="3.5" width="17" height="17" rx="3.5" stroke="${COLORS.accent}"/>`,
    `<g transform="translate(0 2.4)"><circle cx="12" cy="12" r="3.6" fill="${COLORS.text}"/><rect x="32" y="8.5" width="7" height="7" rx="1" fill="${COLORS.accent}"/></g>`,
    "</g>",
  ].join("");
}

/** The logo stacked: the eyes at the top margin, the wordmark under them (owner's request, 2026-10-28). */
function logo(eyesWidth: number, baseline: number, size: number): string {
  return eyes(MARGIN, MARGIN, eyesWidth) + wordmark(MARGIN, baseline, size);
}

/** Where the footer's capitals begin. */
const FOOTER_TOP = FOOTER_BASELINE - 21;

function footer(text: string, font: FontMetrics, width: number): string {
  const line = wrap(drawable(text, font), font, 28, width, 1).lines[0] ?? "";
  return `<text x="${MARGIN}" y="${FOOTER_BASELINE}" font-family="${FAMILY.regular}" font-size="28" fill="${COLORS.faint}">${escape(line)}</text>`;
}

/**
 * A post's picture whole, as far as its frame goes, at the right margin and
 * centered between the top and bottom ones: a card with round corners and a
 * soft shadow. Returns the SVG, where the card begins, and where it ends below.
 */
function pictureCard(picture: FramedPicture): { svg: string; x: number; bottom: number } {
  const { frame } = picture;
  const shown = { width: picture.width * (frame.right - frame.left), height: picture.height * (frame.bottom - frame.top) };
  const scale = Math.min(CARD_WIDTH / shown.width, CARD_HEIGHT / shown.height);
  const width = Math.round(shown.width * scale);
  const height = Math.round(shown.height * scale);
  const x = WIDTH - MARGIN - width;
  const y = Math.round((HEIGHT - height) / 2);
  // The whole picture, placed so that its frame fills the card.
  const whole = { width: width / (frame.right - frame.left), height: height / (frame.bottom - frame.top) };
  const box = `x="${x}" y="${y}" width="${width}" height="${height}" rx="16"`;
  return {
    x,
    bottom: y + height,
    svg: [
      `<defs><filter id="lift" x="-20%" y="-20%" width="140%" height="140%"><feDropShadow dx="0" dy="10" stdDeviation="18" flood-color="${COLORS.text}" flood-opacity="0.16"/></filter>`,
      `<clipPath id="card"><rect ${box}/></clipPath></defs>`,
      `<rect ${box} fill="${COLORS.ground}" filter="url(#lift)"/>`,
      `<image x="${(x - frame.left * whole.width).toFixed(2)}" y="${(y - frame.top * whole.height).toFixed(2)}" width="${whole.width.toFixed(2)}" height="${whole.height.toFixed(2)}" preserveAspectRatio="none" clip-path="url(#card)" href="${escape(picture.href)}"/>`,
      `<rect ${box} fill="none" stroke="${COLORS.text}" stroke-opacity="0.08" stroke-width="1"/>`,
    ].join(""),
  };
}

/**
 * A description in the space left under the title: whole, or at least two
 * lines of it, never a single line cut short (owner's request, 2026-10-28).
 */
function description(text: string, fonts: Fonts, width: number, top: number, size: number): string {
  const lineHeight = Math.round(size * 1.38);
  const room = Math.floor((BODY_BOTTOM - top - Math.round(size * 0.97)) / lineHeight) + 1;
  const clean = drawable(text, fonts.regular);
  if (room < 1 || !clean) return "";
  const wrapped = wrap(clean, fonts.regular, size, width, Math.min(room, 3));
  if (wrapped.lines.length < 2 && !wrapped.complete) return "";
  return textAt({ lines: wrapped.lines, size, lineHeight, family: FAMILY.regular, color: COLORS.muted }, MARGIN, top).svg;
}

export function coverSvg(cover: Cover, fonts: Fonts): string {
  const parts: string[] = [GROUND];
  const fullWidth = WIDTH - MARGIN * 2;

  switch (cover.kind) {
    case "site": {
      parts.push(logo(128, 265, 132));
      const tagline = wrap(drawable(cover.tagline, fonts.semibold), fonts.semibold, 52, fullWidth, 3).lines;
      parts.push(textAt(block(tagline, 52, 1.2, FAMILY.semibold, COLORS.text), MARGIN, 345).svg);
      parts.push(footer(cover.promise, fonts.regular, fullWidth));
      break;
    }
    case "page": {
      parts.push(logo(64, 152, 44));
      const title = fitTitle(drawable(cover.title, fonts.semibold), fonts.semibold, [96, 80, 64], fullWidth, 2);
      const placed = textAt(title, MARGIN, 230);
      parts.push(placed.svg, description(cover.description, fonts, fullWidth, placed.bottom + 36, 36));
      parts.push(footer(cover.address, fonts.regular, fullWidth));
      break;
    }
    case "post": {
      const card = cover.picture ? pictureCard(cover.picture) : null;
      const width = card ? card.x - GAP - MARGIN : fullWidth;
      if (card) parts.push(card.svg);
      parts.push(logo(64, 152, 44));
      const text = drawable(cover.title, fonts.semibold) || "A post on aion.ly";
      const title = card ? fitTitle(text, fonts.semibold, [56, 48, 44], width, 4) : fitTitle(text, fonts.semibold, [72, 64, 56], width, 3);
      const placed = textAt(title, MARGIN, 220);
      parts.push(placed.svg);
      // Beside a picture, the title alone, to keep the cover simple (owner's request, 2026-10-28).
      if (!card) parts.push(description(cover.description, fonts, width, placed.bottom + 28, 30));
      // The byline runs under the picture when it ends above it.
      parts.push(footer(cover.byline, fonts.regular, card && card.bottom + 24 > FOOTER_TOP ? width : fullWidth));
      break;
    }
    case "profile": {
      parts.push(logo(64, 152, 44));
      const size = 176;
      const top = 220;
      if ("href" in cover.avatar) {
        parts.push(
          `<clipPath id="avatar"><circle cx="${MARGIN + size / 2}" cy="${top + size / 2}" r="${size / 2}"/></clipPath>`,
          `<image x="${MARGIN}" y="${top}" width="${size}" height="${size}" preserveAspectRatio="xMidYMid slice" clip-path="url(#avatar)" href="${escape(cover.avatar.href)}"/>`,
        );
      } else {
        parts.push(
          `<circle cx="${MARGIN + size / 2}" cy="${top + size / 2}" r="${size / 2}" fill="${cover.avatar.color}"/>`,
          `<text x="${MARGIN + size / 2}" y="${top + size / 2 + 30}" text-anchor="middle" font-family="${FAMILY.semibold}" font-size="84" fill="#ffffff">${escape(drawable(cover.avatar.letter, fonts.semibold) || "?")}</text>`,
        );
      }
      const x = MARGIN + size + 48;
      const width = WIDTH - MARGIN - x;
      const name = fitTitle(drawable(cover.name, fonts.semibold), fonts.semibold, [80, 64, 52], width, 1);
      const placed = textAt(name, x, top + 28);
      parts.push(placed.svg);
      const subtitle = wrap(drawable(cover.subtitle, fonts.regular), fonts.regular, 36, width, 2).lines;
      parts.push(textAt(block(subtitle, 36, 1.3, FAMILY.regular, COLORS.muted), x, placed.bottom + 24).svg);
      parts.push(footer(cover.address, fonts.regular, fullWidth));
      break;
    }
  }

  return `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="${WIDTH}" height="${HEIGHT}" viewBox="0 0 ${WIDTH} ${HEIGHT}">${parts.join("")}</svg>`;
}
