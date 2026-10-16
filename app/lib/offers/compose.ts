/**
 * The emails about a new member's offer: the welcome, sent as the account
 * is made, and the reminder a few hours before the new member's price
 * ends. Plain HTML that mail clients render alike, with a text version
 * beside it. Pure, so it is unit-tested.
 */

import { INTRO_PERCENT_OFF, INTRO_PRICES, PLAN_PRICES, type PlanInterval } from "../plan";
import { OPERATOR, TAGLINE } from "../site";

export type OfferEmailKind = "welcome" | "reminder";

function escape(text: string): string {
  return text.replace(/[&<>"']/g, (char) => `&#${char.charCodeAt(0)};`);
}

/** Whole hours left, at least one: "24 hours", "1 hour". */
export function hoursWords(seconds: number): string {
  const hours = Math.max(1, Math.round(seconds / 3600));
  return `${hours} ${hours === 1 ? "hour" : "hours"}`;
}

const INTERVALS: PlanInterval[] = ["year", "month"];

export function composeOfferEmail(input: {
  kind: OfferEmailKind;
  /** Seconds left of the new member's price. */
  left: number;
  origin: string;
  unsubscribeUrl: string;
}): { subject: string; html: string; text: string } {
  const { kind, left, origin, unsubscribeUrl } = input;
  const hours = hoursWords(left);
  const off = `${INTRO_PERCENT_OFF}% off`;
  const plan = `${origin}/fan`;
  const settings = `${origin}/settings#email`;

  const subject =
    kind === "welcome" ? `Welcome to aion.ly: ${off} the Fan plan for ${hours}` : `Your ${off} ends in about ${hours}`;
  const heading = kind === "welcome" ? "Welcome to aion.ly" : "Your new-member price ends soon";
  const lead =
    kind === "welcome"
      ? `You're in. ${TAGLINE.long}`
      : `In about ${hours}, the Fan plan goes back to ${PLAN_PRICES.month.label} a month or ${PLAN_PRICES.year.label} a year. Start it now and keep your price for as long as the plan runs.`;
  const when = kind === "welcome" ? `for your first ${hours}` : `ends in about ${hours}`;
  const benefits =
    "Fans post text and uploads, connect an AI agent of their own, share clickable links, get the fan mark, and with the yearly plan a short username. And they keep aion.ly free of ads for everyone.";
  const why = "You get this because you joined aion.ly.";

  const price = (interval: PlanInterval) =>
    `<span style="display:inline-block;white-space:nowrap;margin-right:18px"><s style="color:#8a857c">${PLAN_PRICES[interval].label}</s> <strong style="color:#1f1d1a">${INTRO_PRICES[interval].label}</strong> a ${interval}</span>`;

  // The line inboxes show after the subject.
  const preview =
    kind === "welcome"
      ? `${off} for your first ${hours}: ${INTRO_PRICES.year.label} a year or ${INTRO_PRICES.month.label} a month, kept while your plan runs.`
      : `About ${hours} left: ${INTRO_PRICES.year.label} a year or ${INTRO_PRICES.month.label} a month, kept while your plan runs.`;

  const html = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${escape(subject)}</title></head>
<body style="margin:0;background:#f7f6f3">
<div style="display:none;max-height:0;overflow:hidden">${escape(preview)}</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f7f6f3"><tr><td align="center" style="padding:24px 16px">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;background:#ffffff;border-radius:12px;padding:8px 20px 20px;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;color:#1f1d1a">
<tr><td style="padding:16px 0 4px"><a href="${escape(origin)}" style="color:#1f1d1a;font-size:20px;font-weight:700;text-decoration:none">aion<span style="color:#c2410c">.</span>ly</a></td></tr>
<tr><td style="padding:12px 0 0"><div style="font-size:22px;line-height:28px;font-weight:700">${escape(heading)}</div>
<div style="color:#55524c;font-size:15px;line-height:22px;margin-top:8px">${escape(lead)}</div></td></tr>
<tr><td style="padding:18px 0 0"><div style="background:#fff1e8;border-radius:10px;padding:14px 16px">
<div><span style="display:inline-block;background:#c2410c;color:#ffffff;border-radius:999px;padding:3px 10px;font-size:13px;font-weight:700">${off}</span> <span style="color:#6f6b64;font-size:14px">${escape(when)}</span></div>
<div style="font-size:18px;line-height:26px;margin-top:8px">${INTERVALS.map(price).join(" ")}</div>
<div style="color:#6f6b64;font-size:13px;margin-top:4px">Your price stays for as long as your plan runs. Plus VAT where it applies.</div>
</div></td></tr>
<tr><td style="padding:18px 0 0"><a href="${escape(plan)}" style="display:inline-block;background:#c2410c;color:#ffffff;border-radius:8px;padding:11px 18px;font-size:15px;font-weight:600;text-decoration:none">Become a fan</a></td></tr>
<tr><td style="padding:16px 0 0;color:#55524c;font-size:14px;line-height:21px">${escape(benefits)}</td></tr>
<tr><td style="padding-top:20px"><div style="border-top:1px solid #e7e5e0;padding-top:14px;color:#6f6b64;font-size:12px;line-height:18px">
${escape(why)} <a href="${escape(unsubscribeUrl)}" style="color:#6f6b64">Unsubscribe from offers</a> or <a href="${escape(settings)}" style="color:#6f6b64">choose your emails</a>.<br>
${escape(OPERATOR.name)}, ${escape(OPERATOR.address)}
</div></td></tr>
</table></td></tr></table>
</body></html>`;

  const text = [
    heading,
    "",
    lead,
    "",
    kind === "welcome" ? `${off} ${when}:` : `${off}, ${when}:`,
    ...INTERVALS.map((interval) => `${INTRO_PRICES[interval].label} a ${interval} instead of ${PLAN_PRICES[interval].label}`),
    "Your price stays for as long as your plan runs. Plus VAT where it applies.",
    "",
    `Become a fan: ${plan}`,
    "",
    benefits,
    "",
    why,
    `Unsubscribe from offers: ${unsubscribeUrl}`,
    `Choose your emails: ${settings}`,
    `${OPERATOR.name}, ${OPERATOR.address}`,
  ].join("\n");

  return { subject, html, text };
}
