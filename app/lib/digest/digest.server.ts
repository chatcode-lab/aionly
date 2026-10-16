import { participantCondition } from "../db/accounts.server";
import type { Mailer } from "../mail/mailers.server";
import { SENDERS } from "../mail/senders";
import { postsByIds, topSnapshot } from "../db/feed.server";
import type { Range } from "../feed";
import { plainText } from "../text/markdown";
import { composeDigest, DIGEST_SIZE, type DigestPost, type Frequency, FREQUENCIES, periodStart } from "./compose";

/** Accounts sent to in one hourly run, per frequency; the next run carries on. */
const BATCH = 100;

const RANGE: Record<Frequency, Range> = { daily: "day", weekly: "week", monthly: "month" };

const encoder = new TextEncoder();

async function unsubscribeKey(secret: string): Promise<CryptoKey> {
  const base = await crypto.subtle.importKey("raw", encoder.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const derived = await crypto.subtle.sign("HMAC", base, encoder.encode("aionly digest unsubscribe v1"));
  return crypto.subtle.importKey("raw", derived, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
}

/**
 * The unsubscribe token for an account: its ID and a keyed signature, so the
 * link works without signing in and cannot be made for anyone else.
 */
export async function unsubscribeToken(secret: string, userId: string): Promise<string> {
  const mac = new Uint8Array(await crypto.subtle.sign("HMAC", await unsubscribeKey(secret), encoder.encode(userId)));
  const signature = btoa(String.fromCharCode(...mac.subarray(0, 18))).replace(/\+/g, "-").replace(/\//g, "_");
  return `${userId}.${signature}`;
}

/** The account an unsubscribe token belongs to, if its signature holds. */
export async function readUnsubscribeToken(secret: string, token: string): Promise<string | null> {
  const userId = token.split(".")[0] ?? "";
  if (!/^[A-Za-z0-9_-]{1,40}$/.test(userId)) return null;
  const expected = await unsubscribeToken(secret, userId);
  if (expected.length !== token.length) return null;
  let difference = 0;
  for (let index = 0; index < token.length; index += 1) difference |= token.charCodeAt(index) ^ expected.charCodeAt(index);
  return difference === 0 ? userId : null;
}

/**
 * Turns the digest on, at a frequency, or off: free for every member.
 * Turning it on counts as sent now, so the first one comes when the next
 * period begins.
 */
export async function setDigest(db: D1Database, userId: string, digest: Frequency | null, now: number): Promise<void> {
  await db
    .prepare(
      `UPDATE profiles SET digest = ?2,
         digest_sent_at = CASE WHEN ?2 IS NULL OR digest IS ?2 THEN digest_sent_at ELSE ?3 END
       WHERE user_id = ?1
         -- Turning it on is a participant's, checked here too; turning it off
         -- is always allowed.
         AND (?2 IS NULL OR ${participantCondition(1, now)})`,
    )
    .bind(userId, digest, now)
    .run();
}

export interface Recipient {
  userId: string;
  email: string;
}

/**
 * Accounts due this period's digest: turned on, with a sign-in email, and
 * nothing sent since the period began.
 */
export async function dueRecipients(db: D1Database, frequency: Frequency, now: number, limit = BATCH): Promise<Recipient[]> {
  const { results } = await db
    .prepare(
      `SELECT profile.user_id, account."email" FROM profiles AS profile
       JOIN "user" AS account ON account."id" = profile.user_id
       WHERE profile.digest = ?1 AND (profile.digest_sent_at IS NULL OR profile.digest_sent_at < ?2)
         AND profile.deleted_at IS NULL AND profile.owner_id IS NULL
       LIMIT ?3`,
    )
    .bind(frequency, periodStart(frequency, now), limit)
    .all<{ user_id: string; email: string }>();
  return results.map((row) => ({ userId: row.user_id, email: row.email }));
}

/** The period's top posts, as the digest lists them. */
export async function digestPosts(db: D1Database, frequency: Frequency, origin: string, now: number): Promise<DigestPost[]> {
  const ids = (await topSnapshot(db, RANGE[frequency], now)).slice(0, DIGEST_SIZE);
  const cards = await postsByIds(db, ids);
  return cards.map((card) => ({
    title: card.title,
    url: `${origin}${card.path}`,
    source: card.host ?? (card.media.kind === "text" ? "Text post" : "Upload"),
    score: card.score,
    comments: card.commentCount,
    author: card.author.username,
    excerpt: plainText(card.excerpt).slice(0, 200),
  }));
}

/**
 * Sends every digest that is due, a batch per frequency per run. A quiet
 * period with no posts sends nothing, and still counts as sent. Each
 * address gets its own message, with its own unsubscribe link. Recipients
 * are claimed before anything is sent, so two runs at once never send one
 * twice; a refused send is released and tried again next run, and a run
 * cut short after its claim sends nothing more that period rather than risk
 * sending twice.
 */
export async function sendDigests(
  db: D1Database,
  mailer: Mailer,
  input: { origin: string; secret: string; from: string; now: number },
): Promise<number> {
  let sent = 0;
  for (const frequency of FREQUENCIES) {
    const due = await dueRecipients(db, frequency, input.now);
    if (due.length === 0) continue;
    const { results: claimed } = await db
      .prepare(
        `UPDATE profiles SET digest_sent_at = ?3
         WHERE user_id IN (SELECT value FROM json_each(?1)) AND digest = ?4
           AND (digest_sent_at IS NULL OR digest_sent_at < ?2)
         RETURNING user_id`,
      )
      .bind(JSON.stringify(due.map((recipient) => recipient.userId)), periodStart(frequency, input.now), input.now, frequency)
      .all<{ user_id: string }>();
    const mine = new Set(claimed.map((row) => row.user_id));
    const recipients = due.filter((recipient) => mine.has(recipient.userId));
    if (recipients.length === 0) continue;
    const posts = await digestPosts(db, frequency, input.origin, input.now);
    const failed: string[] = [];
    for (const recipient of recipients) {
      if (posts.length > 0) {
        const unsubscribeUrl = `${input.origin}/digest/unsubscribe?token=${encodeURIComponent(await unsubscribeToken(input.secret, recipient.userId))}`;
        const email = composeDigest({ frequency, posts, origin: input.origin, unsubscribeUrl });
        try {
          await mailer.send({
            from: { name: "aion.ly", email: input.from },
            replyTo: SENDERS.digest.replyTo,
            to: recipient.email,
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
          console.error("digest send", frequency, error);
          failed.push(recipient.userId);
        }
      }
    }
    if (failed.length > 0) {
      await db
        .prepare(`UPDATE profiles SET digest_sent_at = NULL WHERE user_id IN (SELECT value FROM json_each(?1)) AND digest_sent_at = ?2`)
        .bind(JSON.stringify(failed), input.now)
        .run();
    }
  }
  return sent;
}

/**
 * A digest as a member would get it, marked as a test, to an admin's own
 * sign-in email: this week's top posts, or this month's when the week has
 * none. Answers what went wrong, or null.
 */
export async function sendTestDigest(
  db: D1Database,
  mailer: Mailer,
  input: { userId: string; origin: string; secret: string; from: string; now: number },
): Promise<string | null> {
  const account = await db.prepare(`SELECT "email" FROM "user" WHERE "id" = ?1`).bind(input.userId).first<{ email: string }>();
  if (!account) return "Your account has no sign-in email.";
  let frequency: Frequency = "weekly";
  let posts = await digestPosts(db, frequency, input.origin, input.now);
  if (posts.length === 0) {
    frequency = "monthly";
    posts = await digestPosts(db, frequency, input.origin, input.now);
  }
  if (posts.length === 0) return "No posts this month to list.";
  const unsubscribeUrl = `${input.origin}/digest/unsubscribe?token=${encodeURIComponent(await unsubscribeToken(input.secret, input.userId))}`;
  const email = composeDigest({ frequency, posts, origin: input.origin, unsubscribeUrl });
  try {
    await mailer.send({
      from: { name: "aion.ly", email: input.from },
      replyTo: SENDERS.digest.replyTo,
      to: account.email,
      subject: `[Test] ${email.subject}`,
      html: email.html,
      text: email.text,
      headers: { "List-Unsubscribe": `<${unsubscribeUrl}>`, "List-Unsubscribe-Post": "List-Unsubscribe=One-Click" },
    });
    return null;
  } catch (error) {
    console.error("test digest", error);
    return error instanceof Error ? error.message : String(error);
  }
}
