import { type Aspect, PROVIDERS, type Provider } from "../links/types";
import { displayHost } from "../links/url";
import { imageAddress } from "../media.server";
import { postPath } from "../slug";
import { plainText } from "../text/markdown";
import type {
  CommentData,
  PostDetail,
  PublicAuthor,
} from "../public-types";

/** A post counts as live while it is neither deleted nor removed. */
export const LIVE = "deleted_at IS NULL AND removed_batch_id IS NULL";

// Marks a description or comment as edited once it changed this long after
// posting. Quick fixes right after posting stay unmarked.
const EDIT_GRACE_SECONDS = 5 * 60;

const EXCERPT_LENGTH = 280;

const ASPECTS: readonly Aspect[] = ["16:9", "9:16", "post", "audio"];

/** The author columns every listing selects, and the joins they need. */
export const AUTHOR_COLUMNS = `
  profile.user_id AS author_id,
  username.name AS author_name,
  profile.avatar_key AS author_avatar,
  profile.deleted_at AS author_deleted_at`;

export const AUTHOR_JOINS = (owner: string) => `
  JOIN profiles AS profile ON profile.user_id = ${owner}.author_id
  LEFT JOIN usernames AS username
    ON username.user_id = profile.user_id AND username.is_current = 1`;

interface AuthorRow {
  author_id: string;
  author_name: string | null;
  author_avatar: string | null;
  author_deleted_at: number | null;
}

export function toPublicAuthor(row: AuthorRow): PublicAuthor {
  // A deleted account keeps its row as a tombstone, with nothing personal.
  if (row.author_deleted_at !== null || row.author_name === null) {
    return { id: row.author_id, username: "[deleted]" };
  }
  return {
    id: row.author_id,
    username: row.author_name,
    photoUrl: row.author_avatar ? imageAddress(row.author_avatar) : undefined,
  };
}

export const POST_COLUMNS = `
  post.id, post.url, post.provider, post.origin, post.title, post.description,
  post.page_title, post.thumb_key, post.aspect, post.score, post.comment_count,
  post.created_at, post.edited_at,${AUTHOR_COLUMNS}`;

export interface PostRow extends AuthorRow {
  id: string;
  url: string;
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

/** The only way a post row becomes something a page can show. */
export function toPublicPost(row: PostRow): PostDetail {
  const thumbUrl = row.thumb_key ? imageAddress(row.thumb_key) : undefined;
  const provider = PROVIDERS.find((known) => known === row.provider) as
    | Provider
    | undefined;
  const aspect = ASPECTS.find((known) => known === row.aspect);

  return {
    id: row.id,
    path: postPath(row),
    title: row.title,
    url: row.url,
    host: displayHost(new URL(row.url)),
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
    media:
      provider && aspect
        ? { kind: "media", provider, aspect, thumbUrl }
        : { kind: "page", pageTitle: row.page_title ?? undefined, thumbUrl },
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
