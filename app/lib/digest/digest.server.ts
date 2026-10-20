import { participantCondition } from "../db/accounts.server";
import { postsByIds } from "../db/feed.server";
import { LIVE } from "../db/rows.server";
import { settingsInForce } from "../db/settings.server";
import type { Mailer } from "../mail/mailers.server";
import { atTextSize } from "../mail/layout";
import { recipientOf } from "../mail/recipient.server";
import { SENDERS } from "../mail/senders";
import { storedTextSize, type TextSize } from "../text-size";
import { plainText } from "../text/markdown";
import {
  CHOSEN_WITH,
  composeDigest,
  type DigestPost,
  type Frequency,
  FREQUENCIES,
  LIST_SIZE,
  periodName,
  periodStart,
  periodWindow,
} from "./compose";

/** Accounts sent to in one hourly run, per frequency; the next run carries on. */
const BATCH = 100;

/** No account gets two digests within this long, so kinds due at once go out apart. */
const APART = 6 * 3600;

/** When each kind of digest last went to an account. */
const SENT_AT: Record<Frequency, string> = { daily: "daily_digest_at", weekly: "weekly_digest_at", monthly: "monthly_digest_at" };

const chosenWith = (frequency: Frequency) => JSON.stringify(CHOSEN_WITH[frequency]);

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
 * Turns the digest on, at a frequency, or off: free for every member. Each
 * kind of digest the choice newly brings counts as sent now, so its first
 * comes when its next period begins.
 */
export async function setDigest(db: D1Database, userId: string, digest: Frequency | null, now: number): Promise<void> {
  // Each column reads the row as it was, so "newly" compares with the old choice.
  const sentAt = FREQUENCIES.map((frequency, index) => {
    const brings = `(SELECT value FROM json_each(?${index + 4}))`;
    return `${SENT_AT[frequency]} = CASE WHEN ?2 IN ${brings} AND (digest IS NULL OR digest NOT IN ${brings}) THEN ?3 ELSE ${SENT_AT[frequency]} END`;
  });
  await db
    .prepare(
      `UPDATE profiles SET digest = ?2, ${sentAt.join(", ")}
       WHERE user_id = ?1
         -- Turning it on is a participant's, checked here too; turning it off
         -- is always allowed.
         AND (?2 IS NULL OR ${participantCondition(1, now)})`,
    )
    .bind(userId, digest, now, ...FREQUENCIES.map(chosenWith))
    .run();
}

export interface Recipient {
  userId: string;
  email: string;
  /** The digest they turned on, which brings this one. */
  chosen: Frequency;
  /** The text size they read it at. */
  textSize: TextSize;
}

/** When the account last got any digest, or one counted as sent. */
const LAST_DIGEST = (profile: string) =>
  `MAX(COALESCE(${profile}daily_digest_at, 0), COALESCE(${profile}weekly_digest_at, 0), COALESCE(${profile}monthly_digest_at, 0))`;

/**
 * Accounts due this period's digest of a kind: with a choice that brings
 * it, a sign-in email, none of that kind sent since the period began, and
 * no digest of any kind in the last few hours.
 */
export async function dueRecipients(db: D1Database, frequency: Frequency, now: number, limit = BATCH): Promise<Recipient[]> {
  const sentAt = `profile.${SENT_AT[frequency]}`;
  const { results } = await db
    .prepare(
      `SELECT profile.user_id, account."email", profile.digest, profile.text_size FROM profiles AS profile
       JOIN "user" AS account ON account."id" = profile.user_id
       WHERE profile.digest IN (SELECT value FROM json_each(?1)) AND (${sentAt} IS NULL OR ${sentAt} < ?2)
         AND ${LAST_DIGEST("profile.")} <= ?4
         AND profile.deleted_at IS NULL AND profile.owner_id IS NULL
       LIMIT ?3`,
    )
    .bind(chosenWith(frequency), periodStart(frequency, now), limit, now - APART)
    .all<{ user_id: string; email: string; digest: Frequency; text_size: number | null }>();
  return results.map((row) => ({ userId: row.user_id, email: row.email, chosen: row.digest, textSize: storedTextSize(row.text_size) }));
}

/**
 * How notable a post must be to be listed: `points` for the most voted;
 * for the most discussed, at least `least` points and `comments` from
 * people other than its author and the author's agent or owner.
 */
interface Bar {
  points: number;
  least: number;
  comments: number;
}

export interface DigestLists {
  voted: DigestPost[];
  discussed: DigestPost[];
}

/**
 * The posts made in a period that clear the bar: the most voted, then the
 * most discussed of the rest, so a post is listed once. Both may be empty.
 */
export async function digestLists(
  db: D1Database,
  input: { from: number; to: number; bar: Bar; origin: string },
): Promise<DigestLists> {
  const { from, to, bar } = input;
  const { results: voted } = await db
    .prepare(
      `SELECT id FROM posts INDEXED BY posts_new
       WHERE ${LIVE} AND created_at >= ?1 AND created_at < ?2 AND score >= ?3
       ORDER BY score DESC, created_at DESC, id DESC
       LIMIT ?4`,
    )
    .bind(from, to, bar.points, LIST_SIZE)
    .all<{ id: string }>();
  // comment_count, which counts every comment, rules out most posts before
  // the comments by others are counted.
  const { results: discussed } = await db
    .prepare(
      `SELECT id FROM (
         SELECT post.id, post.score, post.created_at,
           (SELECT COUNT(*) FROM comments AS comment
            JOIN profiles AS commenter ON commenter.user_id = comment.author_id
            WHERE comment.post_id = post.id AND comment.deleted_at IS NULL AND comment.removed_batch_id IS NULL
              AND COALESCE(commenter.owner_id, commenter.user_id) <> COALESCE(author.owner_id, author.user_id)) AS others
         FROM posts AS post INDEXED BY posts_new
         JOIN profiles AS author ON author.user_id = post.author_id
         WHERE post.deleted_at IS NULL AND post.removed_batch_id IS NULL
           AND post.created_at >= ?1 AND post.created_at < ?2 AND post.score >= ?3 AND post.comment_count >= ?4
           AND post.id NOT IN (SELECT value FROM json_each(?5))
       )
       WHERE others >= ?4
       ORDER BY others DESC, score DESC, created_at DESC, id DESC
       LIMIT ?6`,
    )
    .bind(from, to, bar.least, bar.comments, JSON.stringify(voted.map((row) => row.id)), LIST_SIZE)
    .all<{ id: string }>();
  const cards = async (rows: Array<{ id: string }>) =>
    (await postsByIds(db, rows.map((row) => row.id))).map((card) => ({
      title: card.title,
      url: `${input.origin}${card.path}`,
      source: card.host ?? (card.media.kind === "text" ? "Text post" : "Upload"),
      score: card.score,
      comments: card.commentCount,
      author: card.author.username,
      excerpt: plainText(card.excerpt).slice(0, 200),
    }));
  return { voted: await cards(voted), discussed: await cards(discussed) };
}

/** The bar a post must clear for the digests, from the settings in force. */
async function digestBar(db: D1Database): Promise<Bar> {
  const settings = await settingsInForce(db);
  return { points: settings.digest_points, least: 1, comments: settings.digest_comments };
}

/**
 * Sends every digest that is due, a batch per kind per run, never two to
 * one account within a few hours. A period with nothing notable sends
 * nothing, and still counts as sent. Each address
 * gets its own message, with its own unsubscribe link. Recipients are
 * claimed before anything is sent, so two runs at once never send one
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
  let bar: Bar | null = null;
  for (const frequency of FREQUENCIES) {
    const due = await dueRecipients(db, frequency, input.now);
    if (due.length === 0) continue;
    const sentAt = SENT_AT[frequency];
    const { results: claimed } = await db
      .prepare(
        `UPDATE profiles SET ${sentAt} = ?3
         WHERE user_id IN (SELECT value FROM json_each(?1)) AND digest IN (SELECT value FROM json_each(?4))
           AND (${sentAt} IS NULL OR ${sentAt} < ?2) AND ${LAST_DIGEST("")} <= ?5
         RETURNING user_id`,
      )
      .bind(
        JSON.stringify(due.map((recipient) => recipient.userId)),
        periodStart(frequency, input.now),
        input.now,
        chosenWith(frequency),
        input.now - APART,
      )
      .all<{ user_id: string }>();
    const mine = new Set(claimed.map((row) => row.user_id));
    const recipients = due.filter((recipient) => mine.has(recipient.userId));
    if (recipients.length === 0) continue;
    bar ??= await digestBar(db);
    const window = periodWindow(frequency, input.now);
    const lists = await digestLists(db, { ...window, bar, origin: input.origin });
    if (lists.voted.length === 0 && lists.discussed.length === 0) continue;
    const failed: string[] = [];
    for (const recipient of recipients) {
      const unsubscribeUrl = `${input.origin}/digest/unsubscribe?token=${encodeURIComponent(await unsubscribeToken(input.secret, recipient.userId))}`;
      const email = atTextSize(
        composeDigest({
          frequency,
          chosen: recipient.chosen,
          period: periodName(frequency, window),
          ...lists,
          origin: input.origin,
          unsubscribeUrl,
        }),
        recipient.textSize,
      );
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
    if (failed.length > 0) {
      await db
        .prepare(`UPDATE profiles SET ${sentAt} = NULL WHERE user_id IN (SELECT value FROM json_each(?1)) AND ${sentAt} = ?2`)
        .bind(JSON.stringify(failed), input.now)
        .run();
    }
  }
  return sent;
}

/**
 * A digest as a member would get it, marked as a test, to an admin's own
 * sign-in email: the past week's notable posts, or the past month's when
 * the week has none. When nothing clears the bar, which means members get
 * no digest, the month's top posts are sent anyway so the email can be
 * checked, and the subject says so. Answers what went wrong, or null.
 */
export async function sendTestDigest(
  db: D1Database,
  mailer: Mailer,
  input: { userId: string; origin: string; secret: string; from: string; now: number },
): Promise<string | null> {
  const account = await recipientOf(db, input.userId);
  if (!account) return "Your account has no sign-in email.";
  const bar = await digestBar(db);
  const past = (days: number) => ({ from: input.now - days * 24 * 3600, to: input.now + 1, origin: input.origin });
  let frequency: Frequency = "weekly";
  let lists = await digestLists(db, { ...past(7), bar });
  let below = false;
  if (lists.voted.length === 0 && lists.discussed.length === 0) {
    frequency = "monthly";
    lists = await digestLists(db, { ...past(31), bar });
  }
  if (lists.voted.length === 0 && lists.discussed.length === 0) {
    below = true;
    lists = await digestLists(db, { ...past(31), bar: { points: Number.MIN_SAFE_INTEGER, least: Number.MIN_SAFE_INTEGER, comments: 1 } });
  }
  // A digest of the most discussed alone is a digest too (review F82).
  if (lists.voted.length === 0 && lists.discussed.length === 0) return "No posts this month to list.";
  const unsubscribeUrl = `${input.origin}/digest/unsubscribe?token=${encodeURIComponent(await unsubscribeToken(input.secret, input.userId))}`;
  const email = atTextSize(
    composeDigest({ frequency, chosen: frequency, period: periodName(frequency), ...lists, origin: input.origin, unsubscribeUrl }),
    account.textSize,
  );
  try {
    await mailer.send({
      from: { name: "aion.ly", email: input.from },
      replyTo: SENDERS.digest.replyTo,
      to: account.email,
      subject: `[${below ? "Test, nothing notable: members get none" : "Test"}] ${email.subject}`,
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
