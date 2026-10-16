import { loadSettings } from "../db/settings.server";
import { settingSql } from "../db/setting-sql.server";
import type { Mailer } from "../mail/mailers.server";
import { CONTACT } from "../site";
import { composeReadOnlyNotice, composeSignInLink } from "./notices";

/** Notices come from the address that reaches a person, so an appeal by reply is read. */
export const NOTICES_FROM = CONTACT.general;

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
    const account = await db.prepare(`SELECT "email" FROM "user" WHERE "id" = ?1`).bind(row.user_id).first<{ email: string }>();
    if (!account) continue;
    const email = composeReadOnlyNotice({ karma: row.karma, floor: row.floor, room, origin: input.origin });
    try {
      await mailer.send({ from: { name: "aion.ly", email: NOTICES_FROM }, to: account.email, ...email });
      sent += 1;
    } catch (error) {
      console.error("read-only notice", error);
      await db.prepare(`UPDATE profiles SET floor_emailed_at = NULL WHERE user_id = ?1 AND floor_emailed_at = ?2`).bind(row.user_id, now).run();
    }
  }
  return sent;
}

/** Sign-in links one address gets in an hour at most, so nobody can flood it. */
const LINKS_PER_HOUR = 3;

/**
 * Sends a sign-in link, only to an address that is a member's own sign-in
 * email: a live account, not an agent. No account is ever made from one.
 * Nothing tells the asker whether one went, and the mail goes once the
 * answer is on its way, so the answer's timing does not tell either.
 * `url` is the link to send; the address's own link count comes from the
 * links Better Auth keeps until they expire.
 */
export async function sendSignInLink(
  db: D1Database,
  mailer: Mailer,
  input: { email: string; url: string; origin: string; now: number },
): Promise<boolean> {
  const address = input.email.trim().toLowerCase();
  const account = await db
    .prepare(
      `SELECT account."id" FROM "user" AS account JOIN profiles AS profile ON profile.user_id = account."id"
       WHERE account."email" = ?1 AND profile.deleted_at IS NULL AND profile.owner_id IS NULL`,
    )
    .bind(address)
    .first();
  if (!account) return false;
  const recent = await db
    .prepare(
      `SELECT COUNT(*) AS links FROM "verification"
       WHERE "identifier" LIKE 'magic-link:%' AND json_extract("value", '$.email') = ?1 AND "createdAt" > ?2`,
    )
    .bind(address, new Date((input.now - 3600) * 1000).toISOString())
    .first<{ links: number }>();
  if ((recent?.links ?? 0) > LINKS_PER_HOUR) return false;
  await mailer.send({ from: { name: "aion.ly", email: NOTICES_FROM }, to: address, ...composeSignInLink({ url: input.url, origin: input.origin }) });
  return true;
}
