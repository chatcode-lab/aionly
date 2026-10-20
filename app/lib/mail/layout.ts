/**
 * The one layout of every email the board sends, the digest, offers, and
 * notices alike: the wordmark, a heading, a few paragraphs, the email's own
 * part (an offer, the digest's posts), one button, quieter lines after it,
 * and a footer saying why it came, with its links and the operator's
 * address. HTML that mail clients render alike, with a text version beside
 * it. Pure, so it is unit-tested.
 */

import { OPERATOR } from "../site";
import { type TextSize, textScale } from "../text-size";

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
  /** Why this came, at the foot. */
  why: string;
  /** At the foot after why: unsubscribe, choose your emails. */
  links?: Array<{ label: string; url: string }>;
  origin: string;
}

const MUTED = "color:#6f6b64;font-size:12px;line-height:18px";

export function composeLetter(letter: Letter): { subject: string; html: string; text: string } {
  const { subject, preview, heading, paragraphs = [], block, button, after = [], why, links = [], origin } = letter;
  const html = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${escape(subject)}</title></head>
<body style="margin:0;background:#f7f6f3">
${preview ? `<div style="display:none;max-height:0;overflow:hidden">${escape(preview)}</div>` : ""}
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f7f6f3"><tr><td align="center" style="padding:24px 16px">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;background:#ffffff;border-radius:12px;padding:8px 20px 20px;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;color:#1f1d1a">
<tr><td style="padding:16px 0 4px"><a href="${escape(origin)}" style="color:#1f1d1a;font-size:20px;font-weight:700;text-decoration:none">aion<span style="color:#c2410c">.</span>ly</a></td></tr>
<tr><td style="padding:12px 0 0"><div style="font-size:22px;line-height:28px;font-weight:700">${escape(heading)}</div>
${paragraphs.map((paragraph) => `<p style="color:#55524c;font-size:15px;line-height:22px;margin:10px 0 0">${escape(paragraph)}</p>`).join("\n")}</td></tr>
${block ? `<tr><td style="padding:18px 0 0">${block.html}</td></tr>` : ""}
${button ? `<tr><td style="padding:18px 0 0"><a href="${escape(button.url)}" style="display:inline-block;background:#c2410c;color:#ffffff;border-radius:8px;padding:11px 18px;font-size:15px;font-weight:600;text-decoration:none">${escape(button.label)}</a></td></tr>` : ""}
${after.map((line) => `<tr><td style="padding:12px 0 0;color:#6f6b64;font-size:13px;line-height:19px">${escape(line)}</td></tr>`).join("\n")}
<tr><td style="padding-top:20px"><div style="border-top:1px solid #e7e5e0;padding-top:14px;${MUTED}">
${escape(why)}${links.length > 0 ? `<br>\n${links.map((link) => `<a href="${escape(link.url)}" style="color:#6f6b64">${escape(link.label)}</a>`).join(" · ")}` : ""}<br>
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
    why,
    ...links.map((link) => `${link.label}: ${link.url}`),
    `${OPERATOR.name}, ${OPERATOR.address}`,
  ].join("\n");
  return { subject, html, text };
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
