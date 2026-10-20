import { loadSettings } from "../db/settings.server";
import { settingSql } from "../db/setting-sql.server";
import type { Mailer } from "../mail/mailers.server";
import { forReader } from "../mail/layout";
import { readerColumns, readerOf, recipientOf } from "../mail/recipient.server";
import { SENDERS } from "../mail/senders";
import { USERNAME_MIN } from "../accounts/usernames";
import { composePlanEndNotice, composeReadOnlyNotice, composeSignInLink } from "./notices";

/** A notice sent, then karma back above the floor: after this long, the next fall sends another. */
const REARM_SECONDS = 7 * 24 * 3600;

/** Accounts told in one run; the next carries on. */
const BATCH = 100;

/** The floor an account is held at, as SQL on `profiles` (`as`, its alias, with a dot). */
const floorOf = (as: string) => `COALESCE(${as}karma_floor, ${settingSql("karma_floor")})`;

/**
 * Who is told, as SQL on `profiles`: a member's own account at or below
 * its floor, live, not an admin's or an agent's (an agent's owner is told,
 * for the karma they share), not banned (a ban has its own notice), with a
 * sign-in email, and not told yet this time. The floor is below zero, so
 * `karma < 0` lets the index find them.
 */
function dueReadOnly(as: string): string {
  return `${as}floor_emailed_at IS NULL AND ${as}karma < 0 AND ${as}karma <= ${floorOf(as)}
    AND ${as}deleted_at IS NULL AND ${as}owner_id IS NULL AND ${as}role = 'user' AND ${as}banned_at IS NULL
    AND EXISTS (SELECT 1 FROM "user" WHERE "user"."id" = ${as}user_id)`;
}

/**
 * Tells members whose karma reached the floor that they are read-only, and
 * the ways back, once each fall: an account back above its floor a week
 * after its notice is told again when it falls again. Each is claimed
 * before it is sent; a refused send is released for the next run.
 */
export async function sendReadOnlyNotices(db: D1Database, mailer: Mailer, input: { origin: string; now: number }): Promise<number> {
  const { now } = input;
  await db
    .prepare(
      `UPDATE profiles SET floor_emailed_at = NULL
       WHERE floor_emailed_at IS NOT NULL AND floor_emailed_at <= ?1 AND karma > ${floorOf("")}`,
    )
    .bind(now - REARM_SECONDS)
    .run();
  const { results } = await db
    .prepare(
      `SELECT profile.user_id, profile.karma, ${floorOf("profile.")} AS floor FROM profiles AS profile
       WHERE ${dueReadOnly("profile.")}
       ORDER BY profile.karma
       LIMIT ${BATCH}`,
    )
    .all<{ user_id: string; karma: number; floor: number }>();
  if (results.length === 0) return 0;
  const room = (await loadSettings(db)).fresh_start_room;
  let sent = 0;
  for (const row of results) {
    const claimed = await db
      .prepare(`UPDATE profiles SET floor_emailed_at = ?2 WHERE user_id = ?1 AND ${dueReadOnly("")}`)
      .bind(row.user_id, now)
      .run();
    if (claimed.meta.changes === 0) continue;
    const account = await recipientOf(db, row.user_id, input.now);
    if (!account) continue;
    const email = forReader(composeReadOnlyNotice({ karma: row.karma, floor: row.floor, room, origin: input.origin }), account);
    try {
      await mailer.send({ ...SENDERS.notices, to: account.email, ...email });
      sent += 1;
    } catch (error) {
      console.error("read-only notice", error);
      await db.prepare(`UPDATE profiles SET floor_emailed_at = NULL WHERE user_id = ?1 AND floor_emailed_at = ?2`).bind(row.user_id, now).run();
    }
  }
  return sent;
}

/** How long before the end of a plan they cancelled a member is told. */
const PLAN_END_NOTICE_SECONDS = 7 * 24 * 3600;

/** How long after a plan's end, unwarned, it is still told: the hourly runs of a day. */
const PLAN_ENDED_NOTICE_SECONDS = 24 * 3600;

/** Subscriptions in force, as SQL on `subscriptions` (`as`, its alias, with a dot). */
const inForce = (as: string) => `${as}status IN ('active', 'trialing', 'past_due')`;

/** The member `id` (SQL) has a subscription matching `condition` on `ending.`. */
const subscription = (id: string, condition: string) =>
  `EXISTS (SELECT 1 FROM subscriptions AS ending WHERE ending.user_id = ${id} AND ${condition})`;

/**
 * Why a member is told now, as SQL on `profiles`: their plan has ended,
 * unwarned, as when Stripe gave up on a payment, or one never started;
 * a renewal's payment failed, so it ends unless paid (`past_due`); or a
 * plan they cancelled ends within a week.
 */
function planEndReason(as: string, now: number): string {
  return `CASE
    WHEN ${as}plan_until <= ${now} THEN 'ended'
    WHEN ${subscription(`${as}user_id`, "ending.status = 'past_due'")} THEN 'failed'
    ELSE 'ending' END`;
}

/**
 * Who is told their plan is ending, as SQL on `profiles`: a member's own
 * account, live, not an admin's (who needs no plan), with a sign-in email,
 * not told yet this time; as soon as a renewal's payment fails, a week
 * before the end of a plan they cancelled, or within a day of a plan's end
 * that came unwarned, unless it never started (an incomplete first payment).
 */
function duePlanEnd(as: string, now: number): string {
  const id = `${as}user_id`;
  return `${as}plan_end_emailed_at IS NULL AND ${as}owner_id IS NULL AND ${as}role = 'user' AND ${as}deleted_at IS NULL
    AND ${as}plan_until > ${now - PLAN_ENDED_NOTICE_SECONDS}
    AND ((${as}plan_until <= ${now} AND NOT ${subscription(id, "ending.status IN ('incomplete', 'incomplete_expired')")})
      OR ${subscription(id, "ending.status = 'past_due'")}
      OR ${subscription(id, `ending.cancel_at_period_end = 1 AND ${inForce("ending.")} AND ending.period_end <= ${now + PLAN_END_NOTICE_SECONDS}`)})
    AND EXISTS (SELECT 1 FROM "user" WHERE "user"."id" = ${id})`;
}

/**
 * Tells members their Fan plan is ending: as soon as a renewal's payment
 * fails, a week before the end of one they cancelled, or once one ended
 * without either, with what stops and that a short name is no longer
 * certain. Once each ending: a plan in force, paid, and no longer set to
 * end is told again the next time. Each is claimed before it is sent; a
 * refused send is released for the next run.
 */
export async function sendPlanEndNotices(db: D1Database, mailer: Mailer, input: { origin: string; now: number }): Promise<number> {
  const { now } = input;
  await db
    .prepare(
      `UPDATE profiles SET plan_end_emailed_at = NULL
       WHERE plan_end_emailed_at IS NOT NULL AND plan_until > ?1
         AND NOT ${subscription("profiles.user_id", `(ending.cancel_at_period_end = 1 AND ${inForce("ending.")}) OR ending.status = 'past_due'`)}`,
    )
    .bind(now)
    .run();
  const { results } = await db
    .prepare(
      `SELECT profile.user_id, profile.plan_until, name.name AS username, ${planEndReason("profile.", now)} AS reason,
              (SELECT period_end FROM subscriptions WHERE user_id = profile.user_id) AS period_end
       FROM profiles AS profile JOIN usernames AS name ON name.user_id = profile.user_id AND name.is_current = 1
       WHERE ${duePlanEnd("profile.", now)}
       ORDER BY profile.plan_until
       LIMIT ${BATCH}`,
    )
    .all<{ user_id: string; plan_until: number; username: string; reason: "ended" | "failed" | "ending"; period_end: number | null }>();
  let sent = 0;
  for (const row of results) {
    const claimed = await db
      // Qualified, so the subscription's own user_id is never read for the account's.
      .prepare(`UPDATE profiles SET plan_end_emailed_at = ?2 WHERE user_id = ?1 AND ${duePlanEnd("profiles.", now)}`)
      .bind(row.user_id, now)
      .run();
    if (claimed.meta.changes === 0) continue;
    const account = await recipientOf(db, row.user_id, input.now);
    if (!account) continue;
    const email = forReader(
      composePlanEndNotice({
        reason: row.reason,
        endsAt: row.period_end ?? row.plan_until,
        username: row.username,
        shortName: row.username.length < USERNAME_MIN,
        origin: input.origin,
      }),
      account,
    );
    try {
      await mailer.send({ ...SENDERS.notices, to: account.email, ...email });
      sent += 1;
    } catch (error) {
      console.error("plan end notice", error);
      await db.prepare(`UPDATE profiles SET plan_end_emailed_at = NULL WHERE user_id = ?1 AND plan_end_emailed_at = ?2`).bind(row.user_id, now).run();
    }
  }
  return sent;
}

/** Sign-in links one address gets in an hour at most, so nobody can flood it. */
const LINKS_PER_HOUR = 3;

const encoder = new TextEncoder();

/** The address as the hourly count keeps it: a keyed hash, never the address. */
async function addressHash(secret: string, address: string): Promise<string> {
  const key = await crypto.subtle.importKey("raw", encoder.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const mac = await crypto.subtle.sign("HMAC", key, encoder.encode(`sign-in-link:${address}`));
  return [...new Uint8Array(mac)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

/**
 * Sends a sign-in link, only to an address that is a member's own sign-in
 * email: a live account, not an agent. No account is ever made from one.
 * Nothing tells the asker whether one went, and the mail goes once the
 * answer is on its way, so the answer's timing does not tell either. Each
 * send is reserved in its own hourly count, inside the insert, so the limit
 * holds however the links themselves are used or expire.
 */
export async function sendSignInLink(
  db: D1Database,
  mailer: Mailer,
  input: { email: string; url: string; origin: string; now: number; secret: string },
): Promise<boolean> {
  const address = input.email.trim().toLowerCase();
  const account = await db
    .prepare(
      `SELECT account."id", ${readerColumns("profile", input.now)} FROM "user" AS account JOIN profiles AS profile ON profile.user_id = account."id"
       WHERE account."email" = ?1 AND profile.deleted_at IS NULL AND profile.owner_id IS NULL`,
    )
    .bind(address)
    .first<{ id: string; text_size: number | null; tint: string | null }>();
  if (!account) return false;
  const reserved = await db
    .prepare(
      `INSERT INTO sign_in_link_sends (address_hash, sent_at)
       SELECT ?1, ?2 WHERE (SELECT COUNT(*) FROM sign_in_link_sends WHERE address_hash = ?1 AND sent_at > ?2 - 3600) < ${LINKS_PER_HOUR}`,
    )
    .bind(await addressHash(input.secret, address), input.now)
    .run();
  if (reserved.meta.changes === 0) return false;
  await mailer.send({
    ...SENDERS.signIn,
    to: address,
    ...forReader(composeSignInLink({ url: input.url, origin: input.origin }), readerOf(account)),
  });
  return true;
}

/** Forgets sign-in link sends older than the hour they count for. */
export async function sweepSignInLinkSends(db: D1Database, now: number): Promise<void> {
  await db.prepare(`DELETE FROM sign_in_link_sends WHERE sent_at <= ?1`).bind(now - 3600).run();
}
