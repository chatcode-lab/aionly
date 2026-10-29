import { participantCondition } from "../db/accounts.server";
import { postsByIds } from "../db/feed.server";
import { LIVE } from "../db/rows.server";
import { settingsInForce } from "../db/settings.server";
import { founderPhoto } from "../mail/founder.server";
import type { Mailer } from "../mail/mailers.server";
import { forReader, type Reader } from "../mail/layout";
import { readerColumns, readerOf, recipientOf } from "../mail/recipient.server";
import { digestSender, SENDERS } from "../mail/senders";
import { imageAddress } from "../media.server";
import { sourceName } from "../links/source";
import { displayHost } from "../links/url";
import { coverPicture, type CoverPictureRow } from "../og/cover-picture";
import type { PostCardData } from "../public-types";
import { emailPicture, type EmailPicture, resized } from "../resize";
import { linkAddresses, plainText } from "../text/markdown";
import {
  CHOSEN_WITH,
  composeDigest,
  type DigestPost,
  type Frequency,
  FREQUENCIES,
  issueName,
  LIST_SIZE,
  MEDIA_BOX,
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

/** Who gets a digest, and how they read it: their text size and tint. */
export interface Recipient extends Reader {
  userId: string;
  email: string;
  /** The digest they turned on, which brings this one. */
  chosen: Frequency;
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
      `SELECT profile.user_id, account."email", profile.digest, ${readerColumns("profile", now)} FROM profiles AS profile
       JOIN "user" AS account ON account."id" = profile.user_id
       WHERE profile.digest IN (SELECT value FROM json_each(?1)) AND (${sentAt} IS NULL OR ${sentAt} < ?2)
         AND ${LAST_DIGEST("profile.")} <= ?4
         AND profile.deleted_at IS NULL AND profile.owner_id IS NULL
       LIMIT ?3`,
    )
    .bind(chosenWith(frequency), periodStart(frequency, now), limit, now - APART)
    .all<{ user_id: string; email: string; digest: Frequency; text_size: number | null; tint: string | null }>();
  return results.map((row) => ({ userId: row.user_id, email: row.email, chosen: row.digest, ...readerOf(row) }));
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

/** What a post the board hosts is, and holds, for naming it: its kind, and its text. */
interface Hosted {
  kind: string;
  description: string;
}

/** The first address a text links to off the board, as a URL, if any. */
function outsideLink(text: string, origin: string): URL | null {
  const board = new URL(origin).hostname;
  for (const address of linkAddresses(text)) {
    if (!URL.canParse(address)) continue;
    const url = new URL(address);
    if (!["http:", "https:"].includes(url.protocol)) continue;
    if (url.hostname === board || url.hostname.endsWith(`.${board}`)) continue;
    return url;
  }
  return null;
}

/**
 * What the digest names before a post's points (owner's request,
 * 2026-10-27). A link post, its source. A post the board hosts never by
 * the board's own words for it, text post and upload, but by where it
 * leads: a text post's card's link, or an upload's first link off the
 * board, mostly the project it shows; or else by what it is: "Article", or
 * the upload's "Video", "Audio", "Picture", or "Gallery". Nothing for an
 * upload whose file is gone.
 */
function sourceOf(card: PostCardData, hosted: Hosted | undefined, origin: string): Pick<DigestPost, "source" | "sourceUrl"> {
  if (card.host) return { source: sourceName(card.host), sourceUrl: card.url };
  const article = hosted?.kind === "text";
  const link = article ? (card.preview?.url ? new URL(card.preview.url) : null) : outsideLink(hosted?.description ?? "", origin);
  if (link) return { source: sourceName(displayHost(link)), sourceUrl: link.href };
  const named = (source: string | null) => ({ source, sourceUrl: null });
  if (article) return named("Article");
  switch (card.media.kind) {
    case "video":
      return named("Video");
    case "audio":
      return named("Audio");
    case "image":
      return named((card.media.pictures?.length ?? 0) > 1 ? "Gallery" : "Picture");
    default:
      return named(null);
  }
}

export interface DigestLists {
  voted: DigestPost[];
  discussed: DigestPost[];
}

/**
 * The pictures posts show in a digest, by post (owner's request,
 * 2026-10-29): each one's cover picture, framed as its cover frames it, or
 * none when it has none a cover could show. A picture that cannot be read
 * leaves its post without one, never the digest unsent.
 */
async function digestPictures(db: D1Database, bucket: R2Bucket, ids: string[]): Promise<Map<string, EmailPicture>> {
  const { results } = await db
    .prepare(`SELECT id, kind, media_type, media_key, thumb_key, inline_media, card_preview FROM posts WHERE id IN (SELECT value FROM json_each(?1))`)
    .bind(JSON.stringify(ids))
    .all<CoverPictureRow & { id: string }>();
  const pictures = new Map<string, EmailPicture>();
  for (const row of results) {
    const key = coverPicture(row);
    // Only a picture the media domain can cut and resize, as an email needs it.
    if (!key || !resized(imageAddress(key), 1)) continue;
    try {
      // Loaded only to draw a picture, so the digest runs where its
      // WebAssembly cannot be loaded, as in the data layer's tests.
      const { postPictureFrom } = await import("../og/render.server");
      const picture = await postPictureFrom(bucket, key);
      const shown = picture && emailPicture(imageAddress(key), picture, MEDIA_BOX);
      if (shown) pictures.set(row.id, shown);
    } catch (error) {
      console.error("digest picture", row.id, error);
    }
  }
  return pictures;
}

/**
 * The posts made in a period that clear the bar: the most voted, then the
 * most discussed of the rest, so a post is listed once. Both may be empty.
 * The first of each shows its picture, prepared here once for everyone the
 * digest goes to.
 */
export async function digestLists(
  db: D1Database,
  bucket: R2Bucket,
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
  // What the posts the board hosts hold, which their cards leave out.
  const { results: hosted } = await db
    .prepare(`SELECT id, kind, description FROM posts WHERE id IN (SELECT value FROM json_each(?1)) AND kind <> 'link'`)
    .bind(JSON.stringify([...voted, ...discussed].map((row) => row.id)))
    .all<Hosted & { id: string }>();
  const held = new Map(hosted.map((row) => [row.id, row]));
  const pictures = await digestPictures(db, bucket, [voted[0], discussed[0]].flatMap((row) => (row ? [row.id] : [])));
  const cards = async (rows: Array<{ id: string }>) =>
    (await postsByIds(db, rows.map((row) => row.id))).map((card) => ({
      title: card.title,
      url: `${input.origin}${card.path}`,
      ...sourceOf(card, held.get(card.id), input.origin),
      score: card.score,
      comments: card.commentCount,
      author: card.author.username,
      authorId: card.author.id,
      authorPhoto: card.author.photoUrl ? new URL(card.author.photoUrl, input.origin).href : null,
      excerpt: plainText(card.excerpt),
      ...(card.excerptCut ? { excerptCut: true } : {}),
      ...(pictures.has(card.id) ? { media: pictures.get(card.id)! } : {}),
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
  bucket: R2Bucket,
  mailer: Mailer,
  input: { origin: string; secret: string; from: string; now: number },
): Promise<number> {
  let sent = 0;
  let bar: Bar | null = null;
  let photo: string | null | undefined;
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
    const lists = await digestLists(db, bucket, { ...window, bar, origin: input.origin });
    if (lists.voted.length === 0 && lists.discussed.length === 0) continue;
    photo ??= await founderPhoto(db, input.origin);
    const failed: string[] = [];
    for (const recipient of recipients) {
      const unsubscribeUrl = `${input.origin}/digest/unsubscribe?token=${encodeURIComponent(await unsubscribeToken(input.secret, recipient.userId))}`;
      const email = forReader(
        composeDigest({
          frequency,
          chosen: recipient.chosen,
          period: periodName(frequency, window),
          issue: issueName(frequency, window.to),
          ...lists,
          origin: input.origin,
          unsubscribeUrl,
          founderPhoto: photo,
        }),
        recipient,
      );
      try {
        await mailer.send({
          from: { name: digestSender(frequency), email: input.from },
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
  bucket: R2Bucket,
  mailer: Mailer,
  input: { userId: string; origin: string; secret: string; from: string; now: number },
): Promise<string | null> {
  const account = await recipientOf(db, input.userId, input.now);
  if (!account) return "Your account has no sign-in email.";
  const bar = await digestBar(db);
  const past = (days: number) => ({ from: input.now - days * 24 * 3600, to: input.now + 1, origin: input.origin });
  let frequency: Frequency = "weekly";
  let lists = await digestLists(db, bucket, { ...past(7), bar });
  let below = false;
  if (lists.voted.length === 0 && lists.discussed.length === 0) {
    frequency = "monthly";
    lists = await digestLists(db, bucket, { ...past(31), bar });
  }
  if (lists.voted.length === 0 && lists.discussed.length === 0) {
    below = true;
    lists = await digestLists(db, bucket, { ...past(31), bar: { points: Number.MIN_SAFE_INTEGER, least: Number.MIN_SAFE_INTEGER, comments: 1 } });
  }
  // A digest of the most discussed alone is a digest too (review F82).
  if (lists.voted.length === 0 && lists.discussed.length === 0) return "No posts this month to list.";
  const unsubscribeUrl = `${input.origin}/digest/unsubscribe?token=${encodeURIComponent(await unsubscribeToken(input.secret, input.userId))}`;
  const email = forReader(
    composeDigest({
      frequency,
      chosen: frequency,
      period: periodName(frequency),
      issue: issueName(frequency, input.now),
      ...lists,
      origin: input.origin,
      unsubscribeUrl,
      founderPhoto: await founderPhoto(db, input.origin),
    }),
    account,
  );
  try {
    await mailer.send({
      from: { name: digestSender(frequency), email: input.from },
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
