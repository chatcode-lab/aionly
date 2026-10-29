/**
 * The one layout of every email the board sends, the digest, offers, and
 * notices alike: the wordmark and the eyes, a heading, a few paragraphs, the email's own
 * part (an offer, the digest's posts), one button, centered (owner's request, 2026-10-29), quieter lines after it,
 * a signature on a person's letter, and a footer saying why it came, with its links and the operator's
 * address. HTML that mail clients render alike, with a text version beside
 * it. Pure, so it is unit-tested.
 */

import { OPERATOR, SITE_NAME } from "../site";
import { type TextSize, textScale } from "../text-size";
import { DEFAULT_TINT, type Tint, TINT_COLORS } from "../tint";

export function escape(text: string): string {
  return text.replace(/[&<>"']/g, (char) => `&#${char.charCodeAt(0)};`);
}

export interface Letter {
  subject: string;
  /** The line inboxes show after the subject. */
  preview: string;
  heading: string;
  paragraphs?: string[];
  /** The email's own part, after the paragraphs: HTML, escaped already, and its text lines. */
  block?: { html: string; text: string[] };
  button?: { label: string; url: string };
  /** After the button, quieter: what to do if it was not expected, and so on. */
  after?: string[];
  /** Who signs it, with their picture, a word of theirs, and where to reach them, as a person's letter. */
  signature?: { name: string; photoUrl?: string | null; note?: string; links: Array<{ label: string; url: string }> };
  /** Why this came, at the foot. */
  why: string;
  /** At the foot after why: unsubscribe, choose your emails. */
  links?: Array<{ label: string; url: string }>;
  origin: string;
}

const MUTED = "color:#6f6b64;font-size:12px;line-height:18px";

/**
 * Each light color the emails are drawn in, and the color it takes on a
 * dark screen, from the board's own dark theme (owner's request,
 * 2026-10-27). White is the card, and the text on the accent, which on dark
 * is the card's color too. A tint's own dark accent replaces orange's (`atTint`).
 */
const DARK: Record<string, string> = {
  "#f7f6f3": "#121110", // the page
  "#ffffff": TINT_COLORS[DEFAULT_TINT].dark["on-accent"], // the card, and text on the accent
  "#1f1d1a": "#f2f0ec", // headings, titles, and prices
  "#55524c": "#aba69e", // the text
  "#6f6b64": "#948f87", // quieter lines
  "#8a857c": "#948f87", // a price struck out
  "#e7e5e0": "#2c2a27", // rules
  [TINT_COLORS[DEFAULT_TINT].light.accent]: TINT_COLORS[DEFAULT_TINT].dark.accent,
  [TINT_COLORS[DEFAULT_TINT].light["accent-soft"]]: TINT_COLORS[DEFAULT_TINT].dark["accent-soft"],
};

/** The properties whose colors turn, each by a class of its own letter. */
const TURNS: Record<string, { letter: string; property: string }> = {
  color: { letter: "c", property: "color" },
  background: { letter: "b", property: "background-color" },
  "border-top": { letter: "l", property: "border-top-color" },
  border: { letter: "o", property: "border-color" },
};

/**
 * An email that follows the reader's color scheme, as the board does, in
 * mail apps that let it (Apple Mail among them; Gmail darkens emails its own
 * way). Inline styles stay light; each element drawn in the light colors
 * gets classes, after any it has, and a dark scheme's rules recolor them. An element on a
 * color of its own, as a drawn picture's initial on its color, keeps both.
 */
function darkReady(html: string): string {
  const rules = new Map<string, string>();
  const marked = html.replace(/(?: class="([^"]*)")? style="([^"]*)"/g, (attribute, own: string | undefined, style: string) => {
    const declarations = style.split(";").map((declaration) => {
      const at = declaration.indexOf(":");
      return { name: declaration.slice(0, at).trim(), value: declaration.slice(at + 1).trim().toLowerCase() };
    });
    const ground = declarations.find((declaration) => declaration.name === "background");
    if (ground && !(ground.value in DARK)) return attribute;
    const classes = declarations.flatMap(({ name, value }) => {
      const turn = TURNS[name];
      const light = value.match(/#[0-9a-f]{6}/)?.[0];
      if (!turn || !light || !(light in DARK)) return [];
      const className = `d${turn.letter}-${light.slice(1)}`;
      rules.set(className, `.${className}{${turn.property}:${DARK[light]}!important}`);
      return [className];
    });
    if (classes.length === 0) return attribute;
    return ` style="${style}" class="${[...(own ? [own] : []), ...classes].join(" ")}"`;
  });
  const style = `<style>:root{color-scheme:light dark;supported-color-schemes:light dark}@media (prefers-color-scheme:dark){${[...rules.values()].join("")}}</style>`;
  return marked.replace("</head>", `${style}</head>`);
}

/**
 * The board's eyes, as the site's logo draws them, across from the
 * wordmark and looking down at the email (owner's request, 2026-10-28):
 * a round human eye and a square machine one, each a border with a pupil
 * low and to the left inside it, aligned on its own, since the cell's
 * right alignment would carry the pupil along. Boxes and borders, not a picture, so every
 * mail app shows them and they turn with a dark scheme; the machine eye
 * takes the member's tint as the accent does (`atTint`).
 */
const EYES = [
  `<span style="display:inline-block;width:10px;height:10px;border:3px solid #1f1d1a;border-radius:50%;vertical-align:middle;text-align:left"><span style="display:block;width:6px;height:6px;margin:3.4px 0 0 0.8px;border-radius:50%;background:#1f1d1a"></span></span>`,
  `<span style="display:inline-block;width:10px;height:10px;margin-left:2px;border:3px solid #c2410c;border-radius:4px;vertical-align:middle;text-align:left"><span style="display:block;width:5px;height:5px;margin:3.9px 0 0 1.3px;border-radius:1px;background:#c2410c"></span></span>`,
].join("");

/**
 * On a phone, the card spans the screen edge to edge, without its rounded
 * corners or the page around it at the sides, as the board's cards do
 * there, so its text has the width (owner's request, 2026-10-29). Below the
 * card's own width, where it would fill the screen anyway.
 */
const NARROW = "<style>@media (max-width:560px){.edge{padding-left:0!important;padding-right:0!important}.sheet{border-radius:0!important;padding-left:16px!important;padding-right:16px!important}}</style>";

/** The board's name standing alone, not in an address or a longer name. */
const NAME = new RegExp(`(?<![\\w@./-])(${SITE_NAME.replace(".", "\\.")})(?![\\w/-])`);

/**
 * Text escaped, with the board's name in it a link to the board in the
 * text's own color. Mail apps make a link of whatever reads as an address
 * (Apple Mail, Gmail), and color it their own way; an existing link they
 * leave alone.
 */
function prose(text: string, color: string, origin: string): string {
  return text
    .split(NAME)
    .map((part, index) => (index % 2 === 1 ? `<a href="${escape(origin)}" style="color:${color};text-decoration:none">${escape(part)}</a>` : escape(part)))
    .join("");
}

export function composeLetter(letter: Letter): { subject: string; html: string; text: string } {
  const { subject, preview, heading, paragraphs = [], block, button, after = [], signature, why, links = [], origin } = letter;
  const html = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="color-scheme" content="light dark"><meta name="supported-color-schemes" content="light dark"><title>${escape(subject)}</title>${NARROW}</head>
<body style="margin:0;background:#f7f6f3">
${preview ? `<div style="display:none;max-height:0;overflow:hidden">${escape(preview)}</div>` : ""}
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f7f6f3"><tr><td align="center" class="edge" style="padding:24px 16px">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" class="sheet" style="max-width:560px;background:#ffffff;border-radius:12px;padding:8px 20px 20px;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;color:#1f1d1a">
<tr><td style="padding:16px 0 4px"><table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr><td><a href="${escape(origin)}" style="color:#1f1d1a;font-size:20px;font-weight:700;text-decoration:none"><span style="color:#c2410c">ai</span>on.ly</a></td><td align="right" style="font-size:0;line-height:0">${EYES}</td></tr></table></td></tr>
<tr><td style="padding:12px 0 0"><div style="font-size:22px;line-height:28px;font-weight:700">${prose(heading, "#1f1d1a", origin)}</div>
${paragraphs.map((paragraph) => `<p style="color:#55524c;font-size:15px;line-height:22px;margin:10px 0 0">${prose(paragraph, "#55524c", origin)}</p>`).join("\n")}</td></tr>
${block ? `<tr><td style="padding:18px 0 0">${block.html}</td></tr>` : ""}
${button ? `<tr><td align="center" style="padding:18px 0 0;text-align:center"><a href="${escape(button.url)}" style="display:inline-block;background:#c2410c;color:#ffffff;border-radius:8px;padding:11px 18px;font-size:15px;font-weight:600;text-decoration:none">${escape(button.label)}</a></td></tr>` : ""}
${after.map((line) => `<tr><td style="padding:12px 0 0;color:#6f6b64;font-size:13px;line-height:19px">${prose(line, "#6f6b64", origin)}</td></tr>`).join("\n")}
${signature ? signatureHtml(signature, origin) : ""}
<tr><td style="padding-top:20px"><div style="border-top:1px solid #e7e5e0;padding-top:14px;${MUTED}">
${prose(why, "#6f6b64", origin)}${links.length > 0 ? `<br>\n${links.map((link) => `<a href="${escape(link.url)}" style="color:#6f6b64">${escape(link.label)}</a>`).join(" · ")}` : ""}<br>
${escape(OPERATOR.name)}, ${escape(OPERATOR.address)}
</div></td></tr>
</table></td></tr></table>
</body></html>`;
  const text = [
    heading,
    "",
    ...paragraphs.flatMap((paragraph) => [paragraph, ""]),
    ...(block ? [...block.text, ""] : []),
    ...(button ? [`${button.label}: ${button.url}`, ""] : []),
    ...after.flatMap((line) => [line, ""]),
    ...(signature
      ? [signature.name, ...(signature.note ? [signature.note] : []), signature.links.map((link) => link.url.replace(/^mailto:/, "")).join(" · "), ""]
      : []),
    why,
    ...links.map((link) => `${link.label}: ${link.url}`),
    `${OPERATOR.name}, ${OPERATOR.address}`,
  ].join("\n");
  return { subject, html: darkReady(html), text };
}

/** A signature: the picture, round, beside the name, a word from its writer, and the ways to reach them. */
function signatureHtml(signature: NonNullable<Letter["signature"]>, origin: string): string {
  // Beside a note, the picture stays at the top, by the name.
  const align = signature.note ? "top" : "middle";
  const photo = signature.photoUrl
    ? `<td style="padding-right:12px;vertical-align:${align}"><img src="${escape(signature.photoUrl)}" width="44" height="44" alt="" style="display:block;width:44px;height:44px;border-radius:22px"></td>`
    : "";
  const links = signature.links.map((link) => `<a href="${escape(link.url)}" style="color:#6f6b64">${escape(link.label)}</a>`).join(" · ");
  return `<tr><td style="padding:20px 0 0"><table role="presentation" cellpadding="0" cellspacing="0"><tr>${photo}<td style="vertical-align:${align}">
<div style="color:#1f1d1a;font-size:15px;line-height:20px;font-weight:600">${escape(signature.name)}</div>
${signature.note ? `<div style="color:#55524c;font-size:14px;line-height:20px;margin-top:2px">${prose(signature.note, "#55524c", origin)}</div>\n` : ""}<div style="color:#6f6b64;font-size:13px;line-height:19px${signature.note ? ";margin-top:4px" : ""}">${links}</div>
</td></tr></table></td></tr>`;
}

/**
 * An email at its recipient's text size (Settings, Display): every font
 * size and line height in its styles scaled, its spacing and width kept.
 * Small leaves it as it was drawn; Normal, everyone's default, is 115%.
 */
export function atTextSize<T extends { html: string }>(email: T, size: TextSize): T {
  if (size === 100) return email;
  const scale = textScale(size);
  const html = email.html.replace(
    /style="([^"]*)"/g,
    (_, style: string) =>
      `style="${style.replace(/(font-size|line-height):(\d+(?:\.\d+)?)px/g, (_match, property: string, px: string) => `${property}:${Math.round(Number(px) * scale)}px`)}"`,
  );
  return { ...email, html };
}

/**
 * An email in its recipient's tint (Settings, Display): the board's orange,
 * and its pale ground, swapped for the tint's: its light colors in the
 * styles, and its dark ones in the dark scheme's rules.
 */
export function atTint<T extends { html: string }>(email: T, tint: Tint): T {
  if (tint === DEFAULT_TINT) return email;
  const swap = (text: string, scheme: "light" | "dark") => {
    const from = TINT_COLORS[DEFAULT_TINT][scheme];
    const to = TINT_COLORS[tint][scheme];
    return text.replaceAll(from.accent, to.accent).replaceAll(from["accent-soft"], to["accent-soft"]);
  };
  const html = email.html
    .replace(/style="([^"]*)"/g, (_, style: string) => `style="${swap(style, "light")}"`)
    .replace(/<style>[^<]*<\/style>/g, (rules) => swap(rules, "dark"));
  return { ...email, html };
}

/** How a member reads the board's emails: their text size, and their tint while they have the plan. */
export interface Reader {
  textSize: TextSize;
  tint: Tint;
}

/** An email as its recipient reads it. */
export function forReader<T extends { html: string }>(email: T, reader: Reader): T {
  return atTint(atTextSize(email, reader.textSize), reader.tint);
}
