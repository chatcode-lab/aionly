import { env, waitUntil } from "cloudflare:workers";

import { bulkMailer } from "../mail/mailers.server";
import { sendOfferEmails } from "./offers.server";

/**
 * Sends a member any offer email now due, once the response is on its way:
 * right after the welcome step, or after they turned offers back on.
 * Nothing where Amazon SES, which carries offers, is not set up; the
 * hourly run does the rest.
 */
export function sendOffersSoon(userId: string, origin: string): void {
  const mailer = bulkMailer();
  if (!mailer) return;
  const input = { origin: env.SITE_ORIGIN ?? origin, secret: env.BETTER_AUTH_SECRET, now: Math.floor(Date.now() / 1000), userId };
  waitUntil(sendOfferEmails(env.DB, mailer, input).catch((error) => console.error("offer email", error)));
}
