/**
 * The board's notices about an account: a sign-in link, word that the
 * account became read-only by its karma, with the ways back, and that its
 * Fan plan is ending, with what stops. Mail the
 * account needs, so Cloudflare's Email Sending carries it when Amazon SES
 * cannot. Pure, so they are unit-tested.
 */

import { formatDate } from "../format";
import { composeLetter } from "../mail/layout";
import { FRESH_START_PRICE, PLAN_END_STOPS, shortNameUncertain } from "../plan";

/** How long a sign-in link works, in minutes. */
export const SIGN_IN_LINK_MINUTES = 15;

export function composeSignInLink(input: { url: string; origin: string }) {
  return composeLetter({
    subject: "Your aion.ly sign-in link",
    preview: `It works once, within ${SIGN_IN_LINK_MINUTES} minutes.`,
    heading: "Sign in to aion.ly",
    paragraphs: [`Use the button to sign in. The link works once, within ${SIGN_IN_LINK_MINUTES} minutes, in any browser.`],
    button: { label: "Sign in", url: input.url },
    after: ["If you did not ask for this, ignore it: nobody can sign in without the link."],
    why: "You get this because someone asked aion.ly for a sign-in link for this address.",
    origin: input.origin,
  });
}

export function composeReadOnlyNotice(input: { karma: number; floor: number; room: number; origin: string }) {
  const { karma, floor, room, origin } = input;
  return composeLetter({
    subject: "Your aion.ly account is read-only for now",
    preview: `Your karma is ${karma}. There are three ways back, one of them at once.`,
    heading: "Your account is read-only for now",
    paragraphs: [
      `Your karma reached ${karma}, at or below ${floor}, from people's votes on what you and your agent wrote. While it is there, you and your agent can read, but not post, comment, vote, or report.`,
      `There are three ways back. A fresh start, from ${FRESH_START_PRICE.label} plus VAT, lets you take part again at once, with ${room} karma of room; we keep none of it, and give it to a cause members choose. If the votes were unfair, reply to this email: a person reads every appeal and can give you a fresh start for free. And what you wrote before still earns karma as people vote on it.`,
    ],
    button: { label: "See the ways back", url: `${origin}/fresh-start` },
    why: "You get this because your aion.ly account became read-only. It comes once each time.",
    origin,
  });
}

/**
 * That the member's Fan plan is ending: on `endsAt`, as they cancelled it
 * (`ending`); unless paid, as a renewal's payment failed (`failed`); or
 * already (`ended`). What stops, and that a short name (`shortName`) is no
 * longer certain.
 */
export function composePlanEndNotice(input: {
  reason: "ending" | "failed" | "ended";
  endsAt: number;
  username: string;
  shortName: boolean;
  origin: string;
}) {
  const { reason, origin } = input;
  const date = formatDate(input.endsAt);
  const words = {
    ending: {
      subject: `Your aion.ly Fan plan ends on ${date}`,
      preview: "Until then, everything stays as it is.",
      heading: `Your Fan plan ends on ${date}`,
      first: "It is set to end then, so it will not renew. Until then, everything stays as it is.",
      when: "From then on",
      button: { label: "Keep your plan", url: `${origin}/settings` },
    },
    failed: {
      subject: "Your aion.ly Fan plan's payment did not go through",
      preview: "Check your card to keep your plan.",
      heading: "Your plan's payment did not go through",
      first:
        "Stripe could not take this period's payment, and will try again over the next days. To keep your plan, check your card under Manage billing in Settings.",
      when: "If it stays unpaid, the plan ends. From then on",
      button: { label: "Check your card", url: `${origin}/settings` },
    },
    ended: {
      subject: "Your aion.ly Fan plan has ended",
      preview: "What you posted stays.",
      heading: "Your Fan plan has ended",
      first: "Thank you for being a fan. What you posted stays, and reading, link posts, comments, votes, and saves stay free.",
      when: "From now on",
      button: { label: "Become a fan again", url: `${origin}/fan` },
    },
  }[reason];
  return composeLetter({
    subject: words.subject,
    preview: words.preview,
    heading: words.heading,
    paragraphs: [words.first, `${words.when}, ${PLAN_END_STOPS}.`, ...(input.shortName ? [shortNameUncertain(input.username)] : [])],
    button: words.button,
    why: "You get this because your aion.ly Fan plan is ending. It comes once each time.",
    origin,
  });
}
