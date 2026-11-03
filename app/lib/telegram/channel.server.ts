/**
 * The board's Telegram channel (owner's request, 2026-11-03): every six
 * hours the top post of the past week not yet on it goes out. Each post goes
 * once, whatever comes of it, and one that leaves the board leaves the
 * channel. The hourly schedule calls `tendChannel`; ./compose.ts writes what
 * is sent. Never log an address of the Bot API, which holds the token.
 */

import { type InlineMedia, storedInlineMedia } from "../article";
import { mentionNames } from "../db/mentions.server";
import { AUTHOR_JOINS, POST_COLUMNS, type PostRow, toPublicPost } from "../db/rows.server";
import { sourceOf } from "../digest/digest.server";
import type { PostDetail } from "../public-types";
import { channelPicture } from "../resize";
import { parseArticle, parseBlocks } from "../text/markdown";
import { mentionIds } from "../text/mentions";
import { type ChannelMedia, type ChannelMessage, type ChannelPost, channelMessages, RETRACTED, UPLOAD_FIELD } from "./compose";

const HOUR = 3600;
const MB = 1024 * 1024;

/**
 * How often a post goes out. The hourly schedule asks, so a run that sends
 * nothing tries again an hour later rather than a whole turn; the half hour
 * forgives a run that starts a moment early.
 */
const SPACING = 6 * HOUR - HOUR / 2;

/**
 * How old a post must be. A channel post keeps the words it went out with,
 * so its author has this long to fix them, and its readers to vote.
 */
const SETTLED = 6 * HOUR;

/** How far back posts count, so the channel stays news rather than a backlog. */
const WINDOW = 7 * 24 * HOUR;

/** The most Telegram fetches from an address; a larger video is sent with the message. */
const BY_ADDRESS = 20 * MB;

/** The most posts one run takes off the channel, which any left wait for the next. */
const RETRACT_BATCH = 20;

/** How long Telegram gets to answer, fetching a video included; and to take a file sent with a message. */
const TIMEOUT = 60_000;
const UPLOAD_TIMEOUT = 5 * 60_000;

interface Bot {
  token: string;
  /** The channel, as its bare ID, its ID with the -100 before it, or its @username. */
  chat: string;
}

interface Answer {
  ok: boolean;
  result?: { message_id?: number };
  error_code?: number;
  description?: string;
}

/** A channel's ID as the Bot API wants it: Telegram's apps show it without the -100. */
const chatOf = (channel: string) => (/^\d+$/.test(channel) ? `-100${channel}` : channel);

const method = (bot: Bot, name: string) => `https://api.telegram.org/bot${bot.token}/${name}`;

/** Asks the Bot API. No answer, of any kind, comes back as an error code of 0. */
async function ask(bot: Bot, request: () => Promise<Response>): Promise<Answer> {
  try {
    return (await (await request()).json()) as Answer;
  } catch (error) {
    // A failed request can name its address.
    return { ok: false, error_code: 0, description: String(error).split(bot.token).join("<token>") };
  }
}

const call = (bot: Bot, name: string, params: Record<string, unknown>) =>
  ask(bot, () =>
    fetch(method(bot, name), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: bot.chat, ...params }),
      signal: AbortSignal.timeout(TIMEOUT),
    }),
  );

/** Sends a message with a stored file, as a form, for what Telegram will not fetch. */
async function callWithFile(bot: Bot, bucket: R2Bucket, message: ChannelMessage): Promise<Answer> {
  const object = await bucket.get(message.upload!);
  if (!object) return { ok: false, error_code: 400, description: "The file is gone." };
  const form = new FormData();
  form.append("chat_id", bot.chat);
  for (const [name, value] of Object.entries(message.params)) form.append(name, typeof value === "string" ? value : JSON.stringify(value));
  form.append(UPLOAD_FIELD, new File([await object.arrayBuffer()], "video.mp4", { type: "video/mp4" }));
  return ask(bot, () => fetch(method(bot, message.method), { method: "POST", body: form, signal: AbortSignal.timeout(UPLOAD_TIMEOUT) }));
}

/**
 * Whether a refusal is about this message, so another may do, rather than
 * about the bot or the channel, which no post gets past. Telegram answers
 * 400 for both, and names a chat in the second.
 */
const aboutMessage = (answer: Answer) => (answer.error_code === 400 && !/chat/i.test(answer.description ?? "")) || answer.error_code === 413;

/** What a post's own uploads hold, found by key, for the size a video needs. */
const fileOf = (row: PostRow, key: string): InlineMedia | undefined => storedInlineMedia(row.inline_media).find((file) => file.key === key);

/** A picture as a post shows it, a GIF left as it is for Telegram to play. */
const picture = (src: string) => {
  const animated = src.endsWith(".gif");
  return { src: animated ? src : channelPicture(src), animated };
};

const still = (src: string | undefined): ChannelMedia => (src ? { type: "pictures", pictures: [picture(src)] } : { type: "none" });

/**
 * A video as Telegram can take it. Up to 20 MB it fetches an MP4 from its
 * address; larger, to the board's 50 MB, the file goes with the message,
 * which must then say its size. Any other video, which it refuses, and one
 * of unknown size, shows its poster.
 */
async function videoMedia(
  bucket: R2Bucket,
  video: { key: string; src: string; poster?: string; width?: number | null; height?: number | null; duration?: number | null },
): Promise<ChannelMedia> {
  if (!video.key.endsWith(".mp4")) return still(video.poster);
  const stored = await bucket.head(video.key);
  if (!stored) return still(video.poster);
  const upload = stored.size > BY_ADDRESS;
  if (upload && !(video.width && video.height)) return still(video.poster);
  return {
    type: "video",
    src: video.src,
    ...(upload ? { upload: video.key } : {}),
    ...(video.poster ? { poster: channelPicture(video.poster) } : {}),
    ...(video.width ? { width: video.width } : {}),
    ...(video.height ? { height: video.height } : {}),
    ...(video.duration ? { duration: video.duration } : {}),
  };
}

/** What a post shows on the channel, as its card shows it. */
async function mediaOf(row: PostRow, post: PostDetail, bucket: R2Bucket, blocks: ReturnType<typeof parseBlocks>): Promise<ChannelMedia> {
  const { media } = post;
  switch (media.kind) {
    case "media":
    case "page":
      return { type: "link", url: post.url };
    case "image":
      return { type: "pictures", pictures: (media.pictures ?? [media]).map(({ src }) => picture(src)) };
    case "video":
      return videoMedia(bucket, {
        key: row.media_key!,
        src: media.src!,
        poster: media.thumbUrl,
        width: row.media_width,
        height: row.media_height,
        duration: row.media_duration,
      });
    case "audio":
      return /\.(mp3|m4a)$/.test(media.src ?? "") ? { type: "audio", src: media.src! } : { type: "none" };
    case "text":
      break;
  }
  // A text post shows what its card does, unless its author chose to show nothing.
  if (post.showPreview === false) return { type: "none" };
  const { preview } = post;
  if (preview?.url) return { type: "link", url: preview.url };
  if (preview?.media.kind === "video") {
    const file = fileOf(row, preview.upload!);
    return videoMedia(bucket, { key: preview.upload!, src: preview.media.src!, width: file?.width, height: file?.height });
  }
  if (preview?.media.kind === "audio") return /\.(mp3|m4a)$/.test(preview.media.src ?? "") ? { type: "audio", src: preview.media.src! } : { type: "none" };
  const src = preview?.media.kind === "image" ? preview.media.src : post.coverPicture?.src;
  if (!src) return { type: "none" };
  const key = preview?.upload ?? post.coverPicture?.key;
  const placed = blocks.find((block) => block.type === "media" && block.key === key);
  return { type: "pictures", pictures: [picture(src)], caption: placed?.type === "media" ? placed.caption : null };
}

async function channelPost(db: D1Database, bucket: R2Bucket, row: PostRow, origin: string): Promise<ChannelPost> {
  const post = toPublicPost(row);
  const blocks = row.kind === "text" ? parseArticle(row.description) : parseBlocks(row.description);
  const hosted = row.kind === "link" ? undefined : { kind: row.kind, description: row.description };
  const { source, sourceUrl } = sourceOf(post, hosted, origin);
  return {
    title: post.title,
    path: post.path,
    blocks,
    names: await mentionNames(db, mentionIds(row.description)),
    outsideLinks: post.author.outsideLinks === true,
    // A text post that leads nowhere else names the board, as a link to itself (owner's request, 2026-11-02).
    ...(row.kind === "text" && !sourceUrl ? { source: "aion.ly", sourceUrl: `${origin}${post.path}` } : { source, sourceUrl }),
    score: post.score,
    comments: post.commentCount,
    author: post.author.username,
    agent: post.author.agent === true,
    media: await mediaOf(row, post, bucket, blocks),
  };
}

/** The top post of the window that has never been claimed: Top's order, among posts old enough. */
function nextPost(db: D1Database, now: number): Promise<PostRow | null> {
  return db
    .prepare(
      `SELECT ${POST_COLUMNS}
       FROM posts AS post INDEXED BY posts_new ${AUTHOR_JOINS("post")}
       WHERE post.deleted_at IS NULL AND post.removed_batch_id IS NULL
         AND post.created_at >= ?1 AND post.created_at <= ?2 AND post.score >= 1
         AND NOT EXISTS (SELECT 1 FROM channel_posts WHERE post_id = post.id)
       ORDER BY post.score DESC, post.created_at DESC, post.id DESC
       LIMIT 1`,
    )
    .bind(now - WINDOW, now - SETTLED)
    .first<PostRow>();
}

/**
 * Sends the next post if one is due. Its claim comes first, so a run cut
 * short leaves it unsent rather than risk sending it twice, as a digest does.
 * For the same reason a send with no answer, which may have arrived, counts
 * as refused. A refusal of the bot or channel rather than the post, or
 * Telegram being unwell, gives the claim back for the next run.
 */
async function sendNext(db: D1Database, bucket: R2Bucket, bot: Bot, origin: string, now: number): Promise<void> {
  const latest = await db.prepare(`SELECT MAX(sent_at) AS sent_at FROM channel_posts`).first<{ sent_at: number | null }>();
  if (latest?.sent_at && now - latest.sent_at < SPACING) return;
  const row = await nextPost(db, now);
  if (!row) return;
  const claim = await db.prepare(`INSERT OR IGNORE INTO channel_posts (post_id, claimed_at) VALUES (?1, ?2)`).bind(row.id, now).run();
  if (claim.meta.changes === 0) return;

  let failure = "Nothing to send.";
  for (const message of channelMessages(await channelPost(db, bucket, row, origin), origin)) {
    const answer = message.upload ? await callWithFile(bot, bucket, message) : await call(bot, message.method, message.params);
    if (answer.ok && answer.result?.message_id) {
      await db.prepare(`UPDATE channel_posts SET message_id = ?2, sent_at = ?3, failure = NULL WHERE post_id = ?1`).bind(row.id, answer.result.message_id, now).run();
      return;
    }
    failure = answer.description ?? "No reason given.";
    console.error("channel post", row.id, answer.error_code, failure);
    if (answer.error_code === 0) break;
    if (!aboutMessage(answer)) {
      await db.prepare(`DELETE FROM channel_posts WHERE post_id = ?1`).bind(row.id).run();
      return;
    }
  }
  await db.prepare(`UPDATE channel_posts SET failure = ?2 WHERE post_id = ?1`).bind(row.id, failure.slice(0, 500)).run();
}

/**
 * Takes off the channel what has left the board, however it left: its author
 * deleted it, a moderator removed it, or its account went. A bot can delete
 * a message for 48 hours, so an older one is written over, its media and
 * button gone. Whatever fails is tried again next run.
 */
async function retract(db: D1Database, bot: Bot, now: number): Promise<void> {
  const { results } = await db
    .prepare(
      `SELECT channel.post_id, channel.message_id
       FROM channel_posts AS channel
       JOIN posts AS post ON post.id = channel.post_id
       WHERE channel.message_id IS NOT NULL AND channel.retracted_at IS NULL
         AND (post.deleted_at IS NOT NULL OR post.removed_batch_id IS NOT NULL)
       LIMIT ?1`,
    )
    .bind(RETRACT_BATCH)
    .all<{ post_id: string; message_id: number }>();
  for (const { post_id, message_id } of results) {
    const deleted = await call(bot, "deleteMessage", { message_id });
    // Someone may have deleted it in Telegram already.
    const gone = (answer: Answer) => answer.ok || /not found/i.test(answer.description ?? "");
    let done = gone(deleted);
    if (!done) {
      const edited = await call(bot, "editMessageText", { message_id, ...RETRACTED });
      done = gone(edited) || /not modified/i.test(edited.description ?? "");
      if (!done) console.error("channel retraction", post_id, edited.error_code, edited.description);
    }
    if (done) await db.prepare(`UPDATE channel_posts SET retracted_at = ?2 WHERE post_id = ?1`).bind(post_id, now).run();
  }
}

/** One run of the hourly schedule: what has left the board leaves the channel, and the next post goes out if due. */
export async function tendChannel(
  db: D1Database,
  bucket: R2Bucket,
  input: { token: string; channel: string; origin: string; now: number },
): Promise<void> {
  const bot = { token: input.token, chat: chatOf(input.channel) };
  await retract(db, bot, input.now);
  await sendNext(db, bucket, bot, input.origin, input.now);
}
