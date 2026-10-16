import { env } from "cloudflare:workers";

import type { Check } from "../billing/check.server";
import { settingsInForce } from "../db/settings.server";
import { sendTestDigest } from "../digest/digest.server";
import { composeReadOnlyNotice, composeSignInLink } from "../notices/notices";
import { sendTestOfferEmails } from "../offers/offers.server";
import { bulkMailer, type Carrier, transactionalMailer } from "./mailers.server";
import { SENDERS } from "./senders";

const message = (error: unknown) => (error instanceof Error ? error.message : String(error));

const NO_SES = "Amazon SES is not set up here (AWS_ACCESS_KEY_ID and AWS_SECRET_ACCESS_KEY), so none is sent.";

/**
 * Every email the board sends, as samples marked as tests, to an admin's
 * own sign-in email, each kind with the service that carried it: the
 * notices (a sign-in link, to the sign-in page rather than a working one,
 * and the read-only notice), through SES or Cloudflare as the backup; the
 * offer emails; and a digest, through SES alone.
 */
export async function sendTestEmails(input: { userId: string; origin: string; now: number }): Promise<Check[]> {
  const { userId, origin, now } = input;
  const account = await env.DB.prepare(`SELECT "email" FROM "user" WHERE "id" = ?1`).bind(userId).first<{ email: string }>();
  if (!account) return [{ label: "Emails", ok: false, detail: "Your account has no sign-in email." }];
  const checks: Check[] = [];

  const settings = await settingsInForce(env.DB);
  const refusals: string[] = [];
  const transactional = transactionalMailer(env.EMAIL, (error) => refusals.push(message(error)));
  const samples = [
    { ...SENDERS.signIn, ...composeSignInLink({ url: `${origin}/signin`, origin }) },
    {
      ...SENDERS.notices,
      ...composeReadOnlyNotice({ karma: settings.karma_floor - 3, floor: settings.karma_floor, room: settings.fresh_start_room, origin }),
    },
  ];
  try {
    const carriers = new Set<Carrier | null | void>();
    for (const sample of samples) carriers.add(await transactional.send({ ...sample, to: account.email, subject: `[Test] ${sample.subject}` }));
    const ses = carriers.size === 1 && carriers.has("ses");
    checks.push({
      label: "Sign-in link and read-only notice",
      ok: ses,
      detail: ses
        ? "Sent through Amazon SES."
        : `Sent through Cloudflare, the backup: ${refusals.length > 0 ? `SES refused them. ${refusals[0]}` : "SES is not set up here."}`,
    });
  } catch (error) {
    console.error("test notices", error);
    checks.push({ label: "Sign-in link and read-only notice", ok: false, detail: `Not sent: ${message(error)}` });
  }

  const bulk = bulkMailer();
  const offers = bulk ? await sendTestOfferEmails(env.DB, bulk, { userId, origin, secret: env.BETTER_AUTH_SECRET }) : NO_SES;
  checks.push({ label: "Offer emails", ok: offers === null, detail: offers === null ? "Both sent through Amazon SES." : `Not sent: ${offers}` });

  const digest = bulk
    ? await sendTestDigest(env.DB, bulk, { userId, origin, secret: env.BETTER_AUTH_SECRET, from: env.DIGEST_FROM ?? SENDERS.digest.from.email, now })
    : NO_SES;
  checks.push({ label: "Digest", ok: digest === null, detail: digest === null ? "Sent through Amazon SES." : `Not sent: ${digest}` });
  return checks;
}
