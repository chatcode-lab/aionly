import { unsubscribeToken } from "../digest/digest.server";
import type { Mailer } from "../mail/mailers.server";
import { atTextSize } from "../mail/layout";
import { recipientOf } from "../mail/recipient.server";
import { SENDERS } from "../mail/senders";
import { INTRO_HOURS, introEndsAt } from "../plan";
import { composeOfferEmail, type OfferEmailKind } from "./compose";

/** The reminder goes once this little of a new member's price is left. */
export const REMINDER_HOURS = 4;

/** Closer to the end than this, no reminder goes: it might arrive too late. */
const LAST_CALL_SECONDS = 30 * 60;

/** Accounts sent to in one run; the next carries on. */
const BATCH = 100;

/** Where an offer email's unsubscribe link leads: no sign-in needed. */
export async function offersUnsubscribeUrl(origin: string, secret: string, userId: string): Promise<string> {
  return `${origin}/unsubscribe?${new URLSearchParams({ list: "offers", token: await unsubscribeToken(secret, userId) })}`;
}

/** Which email is due for an account at this stage, with this much of its offer left, if any. */
export function offerDue(stage: number, left: number): { kind: OfferEmailKind; next: number } | null {
  if (left <= LAST_CALL_SECONDS || stage >= 2) return null;
  if (left <= REMINDER_HOURS * 3600) return { kind: "reminder", next: 2 };
  return stage === 0 ? { kind: "welcome", next: 1 } : null;
}

/**
 * Offers by email: on for a member unless they turn them off, at the
 * welcome step, in Settings, or from an offer email. When they turned them
 * off is kept.
 */
export async function setOffers(db: D1Database, userId: string, on: boolean, now: number): Promise<void> {
  await db
    .prepare(`UPDATE profiles SET offers_off_at = CASE WHEN ?2 THEN NULL ELSE COALESCE(offers_off_at, ?3) END WHERE user_id = ?1`)
    .bind(userId, on ? 1 : 0, now)
    .run();
}

/**
 * Marks the welcome step done, where a new member is told about offers by
 * email and can turn them down at once (`offersOff`). Offers wait for it.
 */
export async function markWelcomed(db: D1Database, userId: string, input: { offersOff: boolean; now: number }): Promise<void> {
  await db
    .prepare(
      `UPDATE profiles SET welcomed_at = COALESCE(welcomed_at, ?2),
         offers_off_at = CASE WHEN ?3 THEN COALESCE(offers_off_at, ?2) ELSE offers_off_at END
       WHERE user_id = ?1`,
    )
    .bind(userId, input.now, input.offersOff ? 1 : 0)
    .run();
}

/**
 * Who an offer may go to, as SQL on `profiles` (`as`, its alias, with a
 * dot), with the time as ?1: a member's own account, not an admin's or an
 * agent's, past the welcome step (which tells them, and lets them refuse),
 * with offers on, live and not banned, with a sign-in email, and no plan.
 */
function mayGetOffers(as: string): string {
  return `${as}offers_off_at IS NULL AND ${as}welcomed_at IS NOT NULL AND ${as}deleted_at IS NULL AND ${as}owner_id IS NULL
    AND ${as}role = 'user' AND ${as}banned_at IS NULL AND COALESCE(${as}plan_until, 0) <= ?1
    AND EXISTS (SELECT 1 FROM "user" WHERE "user"."id" = ${as}user_id)`;
}

/**
 * Sends the offer emails that are due: the welcome to a new member, and the
 * reminder once a few hours of their new-member price are left, to members
 * with offers on. The batch holds only accounts with one due, the
 * nearest deadline first. Each is claimed before it is sent, inside a write
 * that checks again that the account may get it, so an opt-out, a plan, or
 * a deletion that landed meanwhile stops it; a refused send is released and
 * tried again on the next run. With `userId`, only that account's.
 */
export async function sendOfferEmails(
  db: D1Database,
  mailer: Mailer,
  input: { origin: string; secret: string; now: number; userId?: string },
): Promise<number> {
  const { now } = input;
  const opened = now - INTRO_HOURS * 3600;
  // Accounts past their day, or that no offer is for, leave the small index.
  await db
    .prepare(
      `UPDATE profiles SET offer_emails = 2
       WHERE offer_emails < 2
         AND (created_at <= ?1 OR owner_id IS NOT NULL OR role <> 'user' OR deleted_at IS NOT NULL
              OR COALESCE(plan_until, 0) > ?2)`,
    )
    .bind(opened, now)
    .run();
  // A welcome is due with more than the reminder's hours left; the
  // reminder, within them, until the last half hour.
  const welcomeFrom = now - (INTRO_HOURS - REMINDER_HOURS) * 3600;
  const lastCall = opened + LAST_CALL_SECONDS;
  const { results } = await db
    .prepare(
      `SELECT profile.user_id, profile.created_at, profile.offer_emails FROM profiles AS profile
       WHERE profile.offer_emails < 2 AND profile.created_at > ?2
         AND ((profile.offer_emails = 0 AND profile.created_at > ?3) OR profile.created_at <= ?3)
         AND ${mayGetOffers("profile.")}
         AND (?4 IS NULL OR profile.user_id = ?4)
       ORDER BY profile.created_at
       LIMIT ${BATCH}`,
    )
    .bind(now, lastCall, welcomeFrom, input.userId ?? null)
    .all<{ user_id: string; created_at: number; offer_emails: number }>();

  let sent = 0;
  for (const row of results) {
    const left = introEndsAt(row.created_at) - now;
    const due = offerDue(row.offer_emails, left);
    if (!due) continue;
    const claimed = await db
      .prepare(`UPDATE profiles SET offer_emails = ?4 WHERE user_id = ?2 AND offer_emails = ?3 AND ${mayGetOffers("")}`)
      .bind(now, row.user_id, row.offer_emails, due.next)
      .run();
    if (claimed.meta.changes === 0) continue;
    const account = await recipientOf(db, row.user_id);
    if (!account) continue;
    const unsubscribeUrl = await offersUnsubscribeUrl(input.origin, input.secret, row.user_id);
    const email = atTextSize(composeOfferEmail({ kind: due.kind, left, origin: input.origin, unsubscribeUrl }), account.textSize);
    try {
      await mailer.send({
        ...SENDERS.offers,
        to: account.email,
        subject: email.subject,
        html: email.html,
        text: email.text,
        headers: {
          "List-Unsubscribe": `<${unsubscribeUrl}>`,
          "List-Unsubscribe-Post": "List-Unsubscribe=One-Click",
        },
      });
      sent += 1;
    } catch (error) {
      console.error("offer email", due.kind, error);
      await db
        .prepare(`UPDATE profiles SET offer_emails = ?2 WHERE user_id = ?1 AND offer_emails = ?3`)
        .bind(row.user_id, row.offer_emails, due.next)
        .run();
    }
  }
  return sent;
}

/**
 * Both offer emails, as a new member would get them, to an admin's own
 * sign-in email, marked as tests: to see them, and to check that the
 * offers' mail service takes them. Answers what went wrong, or null.
 */
export async function sendTestOfferEmails(
  db: D1Database,
  mailer: Mailer | null,
  input: { userId: string; origin: string; secret: string },
): Promise<string | null> {
  if (!mailer) return "Amazon SES is not set up here (AWS_ACCESS_KEY_ID and AWS_SECRET_ACCESS_KEY), so no offer is sent.";
  const account = await recipientOf(db, input.userId);
  if (!account) return "Your account has no sign-in email.";
  const unsubscribeUrl = await offersUnsubscribeUrl(input.origin, input.secret, input.userId);
  const samples: Array<[OfferEmailKind, number]> = [
    ["welcome", INTRO_HOURS * 3600],
    ["reminder", REMINDER_HOURS * 3600],
  ];
  try {
    for (const [kind, left] of samples) {
      const email = atTextSize(composeOfferEmail({ kind, left, origin: input.origin, unsubscribeUrl }), account.textSize);
      await mailer.send({
        ...SENDERS.offers,
        to: account.email,
        subject: `[Test] ${email.subject}`,
        html: email.html,
        text: email.text,
        headers: {
          "List-Unsubscribe": `<${unsubscribeUrl}>`,
          "List-Unsubscribe-Post": "List-Unsubscribe=One-Click",
        },
      });
    }
    return null;
  } catch (error) {
    console.error("test offer email", error);
    return error instanceof Error ? error.message : String(error);
  }
}
