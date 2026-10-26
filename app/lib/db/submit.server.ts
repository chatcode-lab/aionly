import { type Picture, storedGallery } from "../gallery";
import type { PostReplies } from "../replies";
import { nextTier, type Origin, postsPerDayFor, REPOST_SECONDS } from "../submit/rules";
import type { AccountRecord } from "./accounts.server";
import { entitledCondition, participantCondition } from "./accounts.server";
import { inlineKeys, inlineMediaFor, inlineMediaHolds } from "./article-media.server";
import { releasedKeys, releaseUnusedDraftFiles } from "./draft-files.server";
import { mentionStatements } from "./mentions.server";

const DAY = 24 * 3600;

export type PostingStatus =
  | { allowed: true }
  /** Banned, read-only by karma at or below the floor, or karma below 0. */
  | { allowed: false; reason: "banned" | "read_only" | "karma" }
  | {
      allowed: false;
      reason: "wait";
      nextAt: number;
      /** What the account may post a day now, and at the next karma tier. */
      perDay: number;
      next: { karma: number; postsPerDay: number } | null;
    };

/**
 * Publications allowed per rolling 24 hours: by karma tier, unless an admin
 * set another number or lifted the limit (null) for this account.
 */
function dailyLimit(account: AccountRecord): number | null {
  const set = account.limits.postsPerDay;
  return set === undefined ? postsPerDayFor(Math.max(account.karma, 0)) : set;
}

/**
 * Whether the account may publish now, and if not, why and until when.
 * Deleted and removed posts still count: removing a post never resets the
 * allowance. Admins are exempt.
 */
export async function postingStatus(
  db: D1Database,
  account: AccountRecord,
  now: number,
): Promise<PostingStatus> {
  if (account.ban) return { allowed: false, reason: account.ban.kind === "karma" ? "read_only" : "banned" };
  if (account.role === "admin") return { allowed: true };
  if (account.karma < 0) return { allowed: false, reason: "karma" };
  const limit = dailyLimit(account);
  if (limit === null) return { allowed: true };
  // Tiers apply only where an admin has not set the account's limit.
  const next = account.limits.postsPerDay === undefined ? nextTier(account.karma) : null;
  if (limit === 0) return { allowed: false, reason: "wait", nextAt: now + DAY, perDay: 0, next };

  // The publication that, once it is a day old, frees the next one.
  const row = await db
    .prepare(
      `SELECT created_at FROM posts
       WHERE author_id = ?1 AND created_at > ?2
       ORDER BY created_at DESC LIMIT 1 OFFSET ?3`,
    )
    .bind(account.id, now - DAY, limit - 1)
    .first<{ created_at: number }>();
  return row
    ? { allowed: false, reason: "wait", nextAt: row.created_at + DAY, perDay: limit, next }
    : { allowed: true };
}

export type Existing = { id: string; state: "live" | "removed" };

/**
 * The SQL condition that the posts row `post` keeps link ?{key} from going
 * up again as origin ?{origin} at ?{now}. A link a moderator removed stays
 * blocked for good. Otherwise a live post holds its link for a month, and
 * while the link stands there only as a discovery, its maker may post it
 * once more as their own work. With no origin yet, only what blocks either
 * one counts: checking a link gives no hint that "made" would pass.
 */
function holdsLink(post: string, key: number, origin: number, now: number): string {
  return `${post}.canonical_key = ?${key} AND (
    ${post}.removed_batch_id IS NOT NULL
    OR (${post}.deleted_at IS NULL AND ${post}.created_at > ?${now} - ${REPOST_SECONDS}
      AND (${post}.origin = 'made' OR ?${origin} = 'found')))`;
}

/**
 * The post that keeps a link from being posted again, if any: a removed
 * one first, then the newest. See holdsLink for the rule.
 */
export async function findDuplicate(
  db: D1Database,
  canonicalKey: string,
  at: { origin: Origin | null; now: number },
): Promise<Existing | null> {
  const row = await db
    .prepare(
      `SELECT id, removed_batch_id FROM posts AS held WHERE ${holdsLink("held", 1, 2, 3)}
       ORDER BY removed_batch_id IS NULL, created_at DESC LIMIT 1`,
    )
    .bind(canonicalKey, at.origin, at.now)
    .first<{ id: string; removed_batch_id: string | null }>();
  if (!row) return null;
  return { id: row.id, state: row.removed_batch_id === null ? "live" : "removed" };
}

interface PostBase {
  id: string;
  author: AccountRecord;
  origin: "made" | "found";
  title: string;
  description: string;
  /** Who may comment at the first level, a Fan feature; everyone when left out. */
  replies?: PostReplies;
  /** Published with its discussion closed, a Fan feature. */
  closed?: boolean;
  /**
   * The saved draft this publishes, at the revision its publisher saw: its
   * files are used, and it is used up, in the same write, which refuses if
   * it changed or was published meanwhile. A scheduled publication names
   * the time it was due: it goes in only while the draft is still due then,
   * and an agent's only while the connection that scheduled it may post.
   */
  draft?: { id: string; revision: number; scheduledAt?: number };
  now: number;
}

export interface LinkPost extends PostBase {
  kind: "link";
  url: string;
  canonicalKey: string;
  provider: string | null;
  aspect: string | null;
  pageTitle: string | null;
  thumbKey: string | null;
}

/** A fan's post with no link: a title and a body. */
export interface TextPost extends PostBase {
  kind: "text";
}

/** A fan's uploaded picture, video, or audio, with a video's poster frame. */
export interface UploadPost extends PostBase {
  kind: "upload";
  mediaKey: string;
  mediaType: "image" | "video" | "audio";
  width: number | null;
  height: number | null;
  duration: number | null;
  posterKey: string | null;
  /** A gallery's pictures in order, the first being `mediaKey`; absent for one file. */
  pictures?: Picture[] | null;
}

export type NewPost = LinkPost | TextPost | UploadPost;

export type PublishResult =
  // `freed`: files the published draft held and the post left out, for the bucket.
  | { ok: true; id: string; freed: string[] }
  // Another post already has this ID: publish again with a new one.
  | { ok: false; reason: "id_taken" }
  | { ok: false; reason: "duplicate"; existing: Existing }
  // The link's picture, as checked or previewed, was replaced meanwhile: check, or publish, again.
  | { ok: false; reason: "picture_gone" }
  // The uploads its text places are not its to place: why, in words for its description.
  | { ok: false; reason: "media"; problem: string }
  | { ok: false; reason: "not_allowed" };

/** The keys of the files a draft keeps, any of which its text may place. */
async function draftFileKeys(db: D1Database, draftId: string): Promise<string[]> {
  const row = await db
    .prepare(`SELECT media_key, pictures, inline_media FROM drafts WHERE id = ?1`)
    .bind(draftId)
    .first<{ media_key: string | null; pictures: string | null; inline_media: string | null }>();
  if (!row) return [];
  const gallery = (storedGallery(row.pictures) ?? []).map((picture) => picture.key);
  return [...(row.media_key ? [row.media_key] : []), ...gallery, ...inlineKeys(row.inline_media)];
}

/**
 * Publishes a post and attaches its pending images, in one batch: a link's
 * snapshot, or an upload's file and poster, or the uploads a text post
 * places in its text, which may also be the files of the draft it
 * publishes. The posting rules are part of the insert, so two quick
 * submissions cannot both pass the allowance; text posts and uploads also
 * need the plan, checked the same way, and so is the rule on posting a link
 * again (holdsLink), and the draft's revision.
 */
export async function publishPost(db: D1Database, post: NewPost): Promise<PublishResult> {
  // An article's files, from its text: its author's, sent for it or kept by its draft.
  const placed = await inlineMediaFor(db, {
    authorId: post.author.id,
    text: post.description,
    kept: post.draft ? await draftFileKeys(db, post.draft.id) : [],
    article: post.kind === "text",
  });
  if (!placed.ok) return { ok: false, reason: "media", problem: placed.problem };
  const inline = placed.json;
  const limit = dailyLimit(post.author);
  const link = post.kind === "link" ? post : null;
  const upload = post.kind === "upload" ? post : null;
  const thumbKey = link?.thumbKey ?? upload?.posterKey ?? "";
  const mediaKey = upload?.mediaKey ?? "";
  // A gallery, as stored: pictures only, the first of them the post's file.
  const gallery =
    upload?.mediaType === "image" && upload.pictures && upload.pictures.length > 1
      ? JSON.stringify(upload.pictures.map(({ key, width, height }) => ({ key, width, height })))
      : null;
  // Pending, or the draft's: any picture its gallery keeps may become the
  // cover, or the one picture left (review F87), and its preview's snapshot
  // is a link's picture.
  const pending = (index: number, kind: "post" | "media") =>
    `(SELECT key FROM images WHERE key = ?${index} AND owner_id = ?2 AND kind = '${kind}' AND (state = 'pending'
       OR (state = 'draft' AND key IN (SELECT media_key FROM drafts WHERE id = ?22 UNION ALL SELECT poster_key FROM drafts WHERE id = ?22
         UNION ALL SELECT preview_thumb_key FROM drafts WHERE id = ?22
         UNION ALL SELECT json_extract(kept.value, '$.key') FROM drafts, json_each(drafts.pictures) AS kept WHERE drafts.id = ?22))))`;
  const allowed = `${participantCondition(2, post.now)} AND (
    EXISTS (SELECT 1 FROM profiles WHERE user_id = ?2 AND role = 'admin')
    OR (
      (SELECT karma FROM profiles WHERE user_id = ?2) >= 0
      AND (?13 < 0 OR (SELECT COUNT(*) FROM posts WHERE author_id = ?2 AND created_at > ?12 - ${DAY}) < ?13)
    )
  )
  AND (?3 = 'link' OR ${entitledCondition(2, post.now)})
  AND (?5 IS NULL OR NOT EXISTS (SELECT 1 FROM posts AS held WHERE ${holdsLink("held", 5, 7, 12)}))
  AND (?3 <> 'upload' OR ${pending(15, "media")} IS NOT NULL)
  -- A link's picture is still there: another check, or a newer preview of
  -- the draft, may have replaced it, and the post then waits to be
  -- published again rather than going out without it (review F109).
  AND (?3 <> 'link' OR ?11 = '' OR ${pending(11, "post")} IS NOT NULL)
  AND (?22 IS NULL OR EXISTS (SELECT 1 FROM drafts WHERE id = ?22 AND author_id = ?2 AND revision = ?23 AND post_id IS NULL
    AND (?25 IS NULL OR (drafts.scheduled_at = ?25 AND (drafts.scheduled_token_id IS NULL OR EXISTS (
      SELECT 1 FROM agent_tokens WHERE id = drafts.scheduled_token_id AND agent_id = ?2 AND revoked_at IS NULL AND permission = 'read_write'))))))
  -- Every picture of a gallery is the author's, a picture, and pending or the
  -- draft's, its first the post's file: all of them go in, or none.
  AND (?24 IS NULL OR (json_extract(?24, '$[0].key') = ?15
    AND (SELECT COUNT(*) FROM json_each(?24) AS picture WHERE EXISTS (
      SELECT 1 FROM images WHERE key = json_extract(picture.value, '$.key') AND owner_id = ?2 AND kind = 'media'
        AND content_type LIKE 'image/%' AND (state = 'pending' OR (state = 'draft' AND key IN (
          SELECT json_extract(kept.value, '$.key') FROM drafts, json_each(drafts.pictures) AS kept WHERE drafts.id = ?22)))))
      = json_array_length(?24)))
  -- An article's files: each the author's, pending or the draft's, all of them or none.
  AND ${inlineMediaHolds(26, 2, `SELECT media_key FROM drafts WHERE id = ?22
    UNION ALL SELECT json_extract(kept.value, '$.key') FROM drafts, json_each(drafts.pictures) AS kept WHERE drafts.id = ?22
    UNION ALL SELECT json_extract(kept.value, '$.key') FROM drafts, json_each(drafts.inline_media) AS kept WHERE drafts.id = ?22`)}`;

  try {
    const results = await db.batch([
      db
        .prepare(
          `INSERT INTO posts (id, author_id, kind, url, canonical_key, provider, origin,
             title, description, page_title, thumb_key, aspect, created_at,
             media_key, media_type, media_width, media_height, media_duration, reply_policy, comments_closed_at, pictures, inline_media)
           SELECT ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ${pending(11, "post")}, ?14, ?12,
             ${pending(15, "media")}, ?16, ?17, ?18, ?19,
             -- Choosing who may comment is the plan's; without it, everyone may.
             CASE WHEN ${entitledCondition(2, post.now)} THEN ?20 ELSE NULL END,
             CASE WHEN ?21 AND ${entitledCondition(2, post.now)} THEN ?12 ELSE NULL END,
             ?24, ?26
           WHERE ${allowed}`,
        )
        .bind(
          post.id,
          post.author.id,
          post.kind,
          link?.url ?? null,
          link?.canonicalKey ?? null,
          link?.provider ?? null,
          post.origin,
          post.title,
          post.description,
          link?.pageTitle ?? null,
          thumbKey,
          post.now,
          limit === null ? -1 : limit,
          link?.aspect ?? null,
          mediaKey,
          upload?.mediaType ?? null,
          upload?.width ?? null,
          upload?.height ?? null,
          upload?.duration ?? null,
          post.replies && post.replies !== "all" ? post.replies : null,
          post.closed ? 1 : 0,
          post.draft?.id ?? null,
          post.draft?.revision ?? null,
          gallery,
          post.draft?.scheduledAt ?? null,
          inline,
        ),
      db
        .prepare(
          `UPDATE images SET state = 'attached'
           WHERE key IN (?1, ?2) AND state IN ('pending', 'draft')
             AND EXISTS (SELECT 1 FROM posts WHERE id = ?3 AND (thumb_key = images.key OR media_key = images.key))`,
        )
        .bind(thumbKey, mediaKey, post.id),
      // A gallery's other pictures, likewise.
      ...(gallery
        ? [
            db
              .prepare(
                `UPDATE images SET state = 'attached'
                 WHERE key IN (SELECT json_extract(value, '$.key') FROM json_each(?2)) AND state IN ('pending', 'draft')
                   AND EXISTS (SELECT 1 FROM posts WHERE id = ?1 AND pictures = ?2)`,
              )
              .bind(post.id, gallery),
          ]
        : []),
      // An article's files, likewise.
      ...(inline
        ? [
            db
              .prepare(
                `UPDATE images SET state = 'attached'
                 WHERE key IN (SELECT json_extract(value, '$.key') FROM json_each(?2)) AND state IN ('pending', 'draft')
                   AND EXISTS (SELECT 1 FROM posts WHERE id = ?1 AND inline_media = ?2)`,
              )
              .bind(post.id, inline),
          ]
        : []),
      // The draft is used up only if the post went in.
      ...(post.draft
        ? [
            db
              .prepare(
                `UPDATE drafts SET post_id = ?2, published_at = ?3
                 WHERE id = ?1 AND post_id IS NULL AND EXISTS (SELECT 1 FROM posts WHERE id = ?2)`,
              )
              .bind(post.draft.id, post.id, post.now),
          ]
        : []),
      ...mentionStatements(db, { type: "post", id: post.id, text: post.description, authorId: post.author.id, now: post.now }),
      // A file the draft held that the post left out goes, once no other
      // draft uses it; refused, the draft is still unpublished and keeps
      // its files (review F92).
      ...(post.draft ? releaseUnusedDraftFiles(db, post.author.id, { draftId: post.draft.id, postId: post.id }) : []),
    ]);
    const inserted = results[0]!;
    const freed = post.draft ? releasedKeys(results) : [];
    if (inserted.meta.changes > 0) return { ok: true, id: post.id, freed };
    const existing = link ? await findDuplicate(db, link.canonicalKey, { origin: post.origin, now: post.now }) : null;
    if (existing) return { ok: false, reason: "duplicate", existing };
    if (link?.thumbKey) {
      const kept = await db
        .prepare(`SELECT 1 FROM images WHERE key = ?1 AND owner_id = ?2 AND state IN ('pending', 'draft')`)
        .bind(link.thumbKey, post.author.id)
        .first();
      if (!kept) return { ok: false, reason: "picture_gone" };
    }
    return { ok: false, reason: "not_allowed" };
  } catch (error) {
    if (String(error).includes("UNIQUE") && String(error).includes("posts.id")) return { ok: false, reason: "id_taken" };
    throw error;
  }
}
