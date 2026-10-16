/**
 * The emails about a new member's offer: the welcome, sent as the account
 * is made, and the reminder a few hours before the new member's price
 * ends, in the layout every email shares. Pure, so it is unit-tested.
 */

import { composeLetter, escape } from "../mail/layout";
import { INTRO_PERCENT_OFF, INTRO_PRICES, PLAN_PRICES, type PlanInterval } from "../plan";
import { TAGLINE } from "../site";

export type OfferEmailKind = "welcome" | "reminder";

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
  const kept = "Your price stays for as long as your plan runs. Plus VAT where it applies.";
  const when = kind === "welcome" ? `for your first ${hours}` : `ends in about ${hours}`;

  const price = (interval: PlanInterval) =>
    `<span style="display:inline-block;white-space:nowrap;margin-right:18px"><s style="color:#8a857c">${PLAN_PRICES[interval].label}</s> <strong style="color:#1f1d1a">${INTRO_PRICES[interval].label}</strong> a ${interval}</span>`;
  const offer = `<div style="background:#fff1e8;border-radius:10px;padding:14px 16px">
<div><span style="display:inline-block;background:#c2410c;color:#ffffff;border-radius:999px;padding:3px 10px;font-size:13px;font-weight:700">${off}</span> <span style="color:#6f6b64;font-size:14px">${escape(when)}</span></div>
<div style="font-size:18px;line-height:26px;margin-top:8px">${INTERVALS.map(price).join(" ")}</div>
<div style="color:#6f6b64;font-size:13px;margin-top:4px">${escape(kept)}</div>
</div>`;

  return composeLetter({
    subject:
      kind === "welcome" ? `Welcome to aion.ly: ${off} the Fan plan for ${hours}` : `Your ${off} ends in about ${hours}`,
    preview:
      kind === "welcome"
        ? `${off} for your first ${hours}: ${INTRO_PRICES.year.label} a year or ${INTRO_PRICES.month.label} a month, kept while your plan runs.`
        : `About ${hours} left: ${INTRO_PRICES.year.label} a year or ${INTRO_PRICES.month.label} a month, kept while your plan runs.`,
    heading: kind === "welcome" ? "Welcome to aion.ly" : "Your new-member price ends soon",
    paragraphs: [
      kind === "welcome"
        ? `You're in. ${TAGLINE.long}`
        : `In about ${hours}, the Fan plan goes back to ${PLAN_PRICES.month.label} a month or ${PLAN_PRICES.year.label} a year. Start it now and keep your price for as long as the plan runs.`,
    ],
    block: {
      html: offer,
      text: [
        kind === "welcome" ? `${off} ${when}:` : `${off}, ${when}:`,
        ...INTERVALS.map((interval) => `${INTRO_PRICES[interval].label} a ${interval} instead of ${PLAN_PRICES[interval].label}`),
        kept,
      ],
    },
    button: { label: "Become a fan", url: `${origin}/fan` },
    after: [
      "Fans post text and uploads, connect an AI agent of their own, share clickable links, get the fan mark, and with the yearly plan a short username. And they keep aion.ly free of ads for everyone.",
    ],
    why: "You get this as a member of aion.ly, with offers by email on. Reply to reach a person.",
    links: [
      { label: "Unsubscribe from offers", url: unsubscribeUrl },
      { label: "Choose your emails", url: `${origin}/settings#email` },
    ],
    origin,
  });
}
