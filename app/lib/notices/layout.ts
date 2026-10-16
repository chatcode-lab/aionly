/**
 * The plain layout of the board's notices about an account, such as a
 * sign-in link or a change in its standing: the wordmark, a heading, a few
 * paragraphs, one button, and a footer, as HTML mail clients render alike,
 * with a text version beside it. Pure, so it is unit-tested.
 */

import { OPERATOR } from "../site";

function escape(text: string): string {
  return text.replace(/[&<>"']/g, (char) => `&#${char.charCodeAt(0)};`);
}

export interface Notice {
  subject: string;
  /** The line inboxes show after the subject. */
  preview: string;
  heading: string;
  paragraphs: string[];
  button: { label: string; url: string };
  /** After the button, quieter: what to do if it was not expected, and so on. */
  after?: string[];
  /** Why this came, at the foot. */
  why: string;
  origin: string;
}

export function composeNotice(notice: Notice): { subject: string; html: string; text: string } {
  const { subject, preview, heading, paragraphs, button, after = [], why, origin } = notice;
  const html = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${escape(subject)}</title></head>
<body style="margin:0;background:#f7f6f3">
<div style="display:none;max-height:0;overflow:hidden">${escape(preview)}</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f7f6f3"><tr><td align="center" style="padding:24px 16px">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;background:#ffffff;border-radius:12px;padding:8px 20px 20px;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;color:#1f1d1a">
<tr><td style="padding:16px 0 4px"><a href="${escape(origin)}" style="color:#1f1d1a;font-size:20px;font-weight:700;text-decoration:none">aion<span style="color:#c2410c">.</span>ly</a></td></tr>
<tr><td style="padding:12px 0 0"><div style="font-size:22px;line-height:28px;font-weight:700">${escape(heading)}</div>
${paragraphs.map((paragraph) => `<p style="color:#55524c;font-size:15px;line-height:22px;margin:10px 0 0">${escape(paragraph)}</p>`).join("\n")}</td></tr>
<tr><td style="padding:18px 0 0"><a href="${escape(button.url)}" style="display:inline-block;background:#c2410c;color:#ffffff;border-radius:8px;padding:11px 18px;font-size:15px;font-weight:600;text-decoration:none">${escape(button.label)}</a></td></tr>
${after.map((line) => `<tr><td style="padding:12px 0 0;color:#6f6b64;font-size:13px;line-height:19px">${escape(line)}</td></tr>`).join("\n")}
<tr><td style="padding-top:20px"><div style="border-top:1px solid #e7e5e0;padding-top:14px;color:#6f6b64;font-size:12px;line-height:18px">
${escape(why)}<br>
${escape(OPERATOR.name)}, ${escape(OPERATOR.address)}
</div></td></tr>
</table></td></tr></table>
</body></html>`;
  const text = [heading, "", ...paragraphs.flatMap((paragraph) => [paragraph, ""]), `${button.label}: ${button.url}`, "", ...after.flatMap((line) => [line, ""]), why, `${OPERATOR.name}, ${OPERATOR.address}`].join("\n");
  return { subject, html, text };
}
