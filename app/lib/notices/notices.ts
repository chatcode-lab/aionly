/**
 * The board's notices about an account: a sign-in link, and word that the
 * account became read-only by its karma, with the ways back. Mail the
 * account needs, so Cloudflare's Email Sending carries it when Amazon SES
 * cannot. Pure, so they are unit-tested.
 */

import { composeLetter } from "../mail/layout";
import { FRESH_START_PRICE } from "../plan";

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
      `There are three ways back. A fresh start, ${FRESH_START_PRICE.label} plus VAT, lets you take part again at once, with ${room} karma of room. If the votes were unfair, reply to this email: a person reads every appeal and can give you a fresh start for free. And what you wrote before still earns karma as people vote on it.`,
    ],
    button: { label: "See the ways back", url: `${origin}/fresh-start` },
    why: "You get this because your aion.ly account became read-only. It comes once each time.",
    origin,
  });
}
