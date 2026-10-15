import { type Aspect, PROVIDERS, type Provider } from "../links/types";
import { displayHost } from "../links/url";
import { imageAddress } from "../media.server";
import { postPath } from "../slug";
import { plainText } from "../text/markdown";
import type {
  CommentData,
  PostDetail,
  PostMedia,
  PublicAuthor,
} from "../public-types";

/** A post counts as live while it is neither deleted nor removed. */
export const LIVE = "deleted_at IS NULL AND removed_batch_id IS NULL";

// Marks a description or comment as edited once it changed this long after
// posting. Quick fixes right after posting stay unmarked.
const EDIT_GRACE_SECONDS = 5 * 60;

const EXCERPT_LENGTH = 280;

const ASPECTS: readonly Aspect[] = ["16:9", "9:16", "post", "audio"];

/**
 * The author columns every listing selects, and the joins they need. The
 * plan columns decide the Supporter mark and whether outside links are
 * followed; an agent has its owner's plan.
 */
export const AUTHOR_COLUMNS = `
  profile.user_id AS author_id,
  username.name AS author_name,
  profile.avatar_key AS author_avatar,
  profile.deleted_at AS author_deleted_at,
  profile.owner_id AS author_owner_id,
  profile.role AS author_role,
  profile.plan_until AS author_plan_until,
  profile.show_mark AS author_show_mark,
  profile.x_handle AS author_x_handle,
  author_owner.role AS author_owner_role,
  author_owner.plan_until AS author_owner_plan_until`;

export const AUTHOR_JOINS = (owner: string) => `
  JOIN profiles AS profile ON profile.user_id = ${owner}.author_id
  LEFT JOIN usernames AS username
    ON username.user_id = profile.user_id AND username.is_current = 1
  LEFT JOIN profiles AS author_owner ON author_owner.user_id = profile.owner_id`;

interface AuthorRow {
  author_id: string;
  author_name: string | null;
  author_avatar: string | null;
  author_deleted_at: number | null;
  author_owner_id: string | null;
  author_role: "user" | "admin";
  author_plan_until: number | null;
  author_show_mark: number;
  author_x_handle: string | null;
  author_owner_role: "user" | "admin" | null;
  author_owner_plan_until: number | null;
}

export function toPublicAuthor(row: AuthorRow, now = Math.floor(Date.now() / 1000)): PublicAuthor {
  // A deleted account keeps its row as a tombstone, with nothing personal.
  if (row.author_deleted_at !== null || row.author_name === null) {
    return { id: row.author_id, username: "[deleted]" };
  }
  const supporter = row.author_plan_until !== null && row.author_plan_until > now;
  const plan = row.author_owner_id
    ? row.author_owner_role === "admin" || (row.author_owner_plan_until !== null && row.author_owner_plan_until > now)
    : row.author_role === "admin" || supporter;
  return {
    id: row.author_id,
    username: row.author_name,
    photoUrl: row.author_avatar ? imageAddress(row.author_avatar) : undefined,
    ...(row.author_owner_id ? { agent: true, ownerId: row.author_owner_id } : {}),
    ...(supporter && row.author_show_mark === 1 ? { supporter: true } : {}),
    ...(row.author_x_handle ? { x: row.author_x_handle } : {}),
    ...(plan ? { outsideLinks: true } : {}),
  };
}

export const POST_COLUMNS = `
  post.id, post.kind, post.url, post.provider, post.origin, post.title, post.description,
  post.page_title, post.thumb_key, post.aspect, post.score, post.comment_count,
  post.created_at, post.edited_at, post.media_key, post.media_type, post.media_width,
  post.media_height, post.media_duration,${AUTHOR_COLUMNS}`;

export interface PostRow extends AuthorRow {
  id: string;
  kind: "link" | "text" | "upload";
  /** Null for text posts and uploads, which have no outside link. */
  url: string | null;
  media_key: string | null;
  media_type: "image" | "video" | "audio" | null;
  media_width: number | null;
  media_height: number | null;
  media_duration: number | null;
  provider: string | null;
  origin: "made" | "found";
  title: string;
  description: string;
  page_title: string | null;
  thumb_key: string | null;
  aspect: string | null;
  score: number;
  comment_count: number;
  created_at: number;
  edited_at: number | null;
}

function excerptOf(description: string): string {
  const flat = plainText(description);
  // A cut never splits a mention token, which is written in as a name later.
  return flat.length > EXCERPT_LENGTH
    ? `${flat.slice(0, EXCERPT_LENGTH - 1).replace(/<@[A-Za-z0-9_-]*$/, "").trimEnd()}…`
    : flat;
}

/** What a post shows above its description. */
function mediaOf(row: PostRow, thumbUrl: string | undefined): PostMedia {
  if (row.kind === "text") return { kind: "text" };
  if (row.kind === "upload") {
    // An upload whose file is gone shows as its text alone.
    if (!row.media_key) return { kind: "text" };
    const src = imageAddress(row.media_key);
    const duration = row.media_duration ?? undefined;
    switch (row.media_type) {
      case "image":
        return { kind: "image", src, width: row.media_width ?? 1200, height: row.media_height ?? 900 };
      case "video": {
        const tall = (row.media_height ?? 0) > (row.media_width ?? 0);
        return { kind: "video", aspect: tall ? "9:16" : "16:9", src, thumbUrl, duration };
      }
      case "audio":
        return { kind: "audio", aspect: "audio", src, thumbUrl, duration };
      default:
        return { kind: "text" };
    }
  }
  const provider = PROVIDERS.find((known) => known === row.provider) as Provider | undefined;
  const aspect = ASPECTS.find((known) => known === row.aspect);
  return provider && aspect
    ? { kind: "media", provider, aspect, thumbUrl }
    : { kind: "page", pageTitle: row.page_title ?? undefined, thumbUrl };
}

/** The only way a post row becomes something a page can show. */
export function toPublicPost(row: PostRow): PostDetail {
  const thumbUrl = row.thumb_key ? imageAddress(row.thumb_key) : undefined;
  const path = postPath(row);

  return {
    id: row.id,
    path,
    title: row.title,
    // A post with no outside link leads to its own page.
    url: row.url ?? path,
    ...(row.url ? { host: displayHost(new URL(row.url)) } : {}),
    origin: row.origin,
    author: toPublicAuthor(row),
    createdAt: row.created_at,
    edited:
      row.edited_at !== null &&
      row.edited_at - row.created_at > EDIT_GRACE_SECONDS,
    score: row.score,
    commentCount: row.comment_count,
    excerpt: excerptOf(row.description),
    description: row.description,
    media: mediaOf(row, thumbUrl),
  };
}

export const COMMENT_COLUMNS = `
  comment.id, comment.parent_id, comment.body, comment.score,
  comment.created_at, comment.edited_at, comment.deleted_at,
  comment.removed_batch_id,${AUTHOR_COLUMNS}`;

export interface CommentRow extends AuthorRow {
  id: string;
  parent_id: string | null;
  body: string;
  score: number;
  created_at: number;
  edited_at: number | null;
  deleted_at: number | null;
  removed_batch_id: string | null;
}

/**
 * The only way a comment row becomes something a page can show. A removed or
 * deleted comment keeps its place in the thread but loses its text and its
 * author here, so neither can reach a response.
 */
export function toPublicComment(row: CommentRow): CommentData {
  const state =
    row.removed_batch_id !== null
      ? "removed"
      : row.deleted_at !== null
        ? "deleted"
        : "visible";

  return {
    id: row.id,
    author: state === "visible" ? toPublicAuthor(row) : null,
    createdAt: row.created_at,
    edited:
      state === "visible" &&
      row.edited_at !== null &&
      row.edited_at - row.created_at > EDIT_GRACE_SECONDS,
    score: row.score,
    body: state === "visible" ? row.body : null,
    state,
    replies: [],
  };
}
