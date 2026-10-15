import { type CommentOrder, defaultOrder, orderThread } from "../comments/rules";
import type { CommentData, PostDetail } from "../public-types";
import type { PostReplies } from "../replies";
import {
  AUTHOR_JOINS,
  COMMENT_COLUMNS,
  type CommentRow,
  POST_COLUMNS,
  type PostRow,
  toPublicComment,
  toPublicPost,
} from "./rows.server";

/** Top-level comments one page of a discussion shows, each with all its replies. */
export const ROOTS_PER_PAGE = 50;

/**
 * The most comments one page loads, against a top-level comment with
 * thousands of replies: every top-level comment on the page, and replies
 * up to the rest, shared out in turns (see thread); past it, the latest
 * replies of the busiest are left out.
 */
export const PAGE_COMMENTS_MAX = 1000;
const REPLIES_PER_PAGE = PAGE_COMMENTS_MAX - ROOTS_PER_PAGE;

/** Which page of a discussion shows, and what it holds. */
export interface ThreadPage {
  comments: CommentData[];
  order: CommentOrder;
  /** This page, from 1, and how many there are. */
  page: number;
  pages: number;
  /** Every comment in the discussion, on all its pages, tombstones included. */
  total: number;
  /** The page held more replies than it loads (see PAGE_COMMENTS_MAX). */
  clipped: boolean;
}

export type PostPage =
  | ({ state: "live"; post: PostDetail } & ThreadPage)
  // A tombstone. The post's title, URL, description, and media are not
  // loaded at all, so they cannot leak into the response.
  | ({ state: "removed" | "deleted" } & ThreadPage);

/** Top-level comments in each order: as orderThread puts them, ties by ID. */
const ROOT_ORDER: Record<CommentOrder, string> = {
  old: "created_at, id",
  best: "score DESC, created_at, id",
  new: "created_at DESC, id DESC",
};

/** SQL: the top-level comment `other` comes before `target` in this order. */
const ROOT_BEFORE: Record<CommentOrder, string> = {
  old: "(other.created_at < target.created_at OR (other.created_at = target.created_at AND other.id < target.id))",
  best: `(other.score > target.score OR (other.score = target.score AND
    (other.created_at < target.created_at OR (other.created_at = target.created_at AND other.id < target.id))))`,
  new: "(other.created_at > target.created_at OR (other.created_at = target.created_at AND other.id > target.id))",
};

/**
 * Builds the reply tree in the order given. A reply whose parent is
 * missing from the loaded set is shown at the top level rather than dropped.
 */
function buildThread(rows: CommentRow[], order: CommentOrder): CommentData[] {
  const nodes = new Map(rows.map((row) => [row.id, toPublicComment(row)]));
  const roots: CommentData[] = [];

  for (const row of rows) {
    const node = nodes.get(row.id)!;
    const parent = row.parent_id ? nodes.get(row.parent_id) : undefined;
    (parent ? parent.replies : roots).push(node);
  }
  return orderThread(roots, order);
}

/**
 * One page of a post's discussion: `ROOTS_PER_PAGE` top-level comments in
 * the order asked for, or else the discussion's own (oldest first, or best
 * first once it is busy; see defaultOrder), each with all its replies. The
 * page is the one asked for, or the one holding the comment `focus`.
 */
async function thread(
  db: D1Database,
  postId: string,
  asked: CommentOrder | undefined,
  paging: { page?: number; focus?: string },
): Promise<ThreadPage> {
  const counts = await db
    .prepare(
      `SELECT (SELECT COUNT(*) FROM comments WHERE post_id = ?1) AS total,
              (SELECT COUNT(*) FROM comments WHERE post_id = ?1 AND parent_id IS NULL) AS roots`,
    )
    .bind(postId)
    .first<{ total: number; roots: number }>();
  const total = counts?.total ?? 0;
  const order = asked ?? defaultOrder(total);
  const pages = Math.max(1, Math.ceil((counts?.roots ?? 0) / ROOTS_PER_PAGE));

  let page = paging.page ?? 1;
  if (paging.focus) {
    const found = await db
      .prepare(
        `SELECT (SELECT COUNT(*) FROM comments AS other
                 WHERE other.post_id = ?1 AND other.parent_id IS NULL AND ${ROOT_BEFORE[order]}) AS rank
         FROM comments AS focused JOIN comments AS target ON target.id = focused.root_id
         WHERE focused.id = ?2 AND focused.post_id = ?1`,
      )
      .bind(postId, paging.focus)
      .first<{ rank: number }>();
    if (found) page = Math.floor(found.rank / ROOTS_PER_PAGE) + 1;
  }
  page = Math.min(Math.max(1, Math.floor(page)), pages);

  // The page's top-level comments, every one of them.
  const roots = `SELECT id FROM comments WHERE post_id = ?1 AND parent_id IS NULL
    ORDER BY ${ROOT_ORDER[order]} LIMIT ${ROOTS_PER_PAGE} OFFSET ${(page - 1) * ROOTS_PER_PAGE}`;
  const [top, replies, focused] = await db.batch([
    db.prepare(`SELECT ${COMMENT_COLUMNS} FROM comments AS comment ${AUTHOR_JOINS("comment")} WHERE comment.id IN (${roots})`).bind(postId),
    // Their replies, the budget shared in turns: each top-level comment's
    // first reply, then each one's second, and so on, oldest first in each,
    // so a busy one cannot crowd out the rest, and a reply's parent always
    // comes in before it.
    db
      .prepare(
        `SELECT ${COMMENT_COLUMNS}
         FROM (SELECT comments.*, ROW_NUMBER() OVER (PARTITION BY root_id ORDER BY created_at, id) AS turn
               FROM comments WHERE post_id = ?1 AND parent_id IS NOT NULL AND root_id IN (${roots})) AS comment
         ${AUTHOR_JOINS("comment")}
         ORDER BY comment.turn, comment.created_at, comment.id
         LIMIT ?2`,
      )
      .bind(postId, REPLIES_PER_PAGE + 1),
    // A comment the address names, and every comment above it, whatever the budget left out.
    db
      .prepare(
        `WITH RECURSIVE chain(id, parent_id) AS (
           SELECT id, parent_id FROM comments WHERE id = ?2 AND post_id = ?1
           UNION ALL
           SELECT above.id, above.parent_id FROM comments AS above JOIN chain ON above.id = chain.parent_id)
         SELECT ${COMMENT_COLUMNS} FROM comments AS comment ${AUTHOR_JOINS("comment")}
         WHERE comment.id IN (SELECT id FROM chain)`,
      )
      .bind(postId, paging.focus ?? ""),
  ]);
  const replyRows = replies!.results as CommentRow[];
  const clipped = replyRows.length > REPLIES_PER_PAGE;
  const rows = new Map<string, CommentRow>();
  for (const row of [...(top!.results as CommentRow[]), ...replyRows.slice(0, REPLIES_PER_PAGE), ...(focused!.results as CommentRow[])]) {
    rows.set(row.id, row);
  }
  return { comments: buildThread([...rows.values()], order), order, page, pages, total, clipped };
}

/** The page of a discussion an address asks for: `?page=`, or `?c=` for the page holding a comment. */
export function threadPaging(url: URL): { page?: number; focus?: string } {
  const page = Number(url.searchParams.get("page"));
  const focus = url.searchParams.get("c");
  return {
    ...(Number.isInteger(page) && page > 0 ? { page } : {}),
    ...(focus && /^[A-Za-z0-9_-]{1,32}$/.test(focus) ? { focus } : {}),
  };
}

/** Everything a post's own page shows, or null when there is no such post. */
export async function postPage(
  db: D1Database,
  id: string,
  order?: CommentOrder,
  paging: { page?: number; focus?: string } = {},
): Promise<PostPage | null> {
  const status = await db
    .prepare(`SELECT deleted_at, removed_batch_id FROM posts WHERE id = ?1`)
    .bind(id)
    .first<{ deleted_at: number | null; removed_batch_id: string | null }>();
  if (!status) return null;

  const discussion = await thread(db, id, order, paging);
  // Moderator removal takes precedence when a post carries both flags.
  if (status.removed_batch_id !== null) return { state: "removed", ...discussion };
  if (status.deleted_at !== null) return { state: "deleted", ...discussion };

  const row = await db
    .prepare(
      `SELECT ${POST_COLUMNS}, post.reply_policy, post.comments_closed_at
       FROM posts AS post ${AUTHOR_JOINS("post")}
       WHERE post.id = ?1 AND post.deleted_at IS NULL AND post.removed_batch_id IS NULL`,
    )
    .bind(id)
    .first<PostRow & { reply_policy: Exclude<PostReplies, "all"> | null; comments_closed_at: number | null }>();
  if (!row) {
    // Removed or deleted since the first read: its tombstone, never its content.
    const now = await db
      .prepare(`SELECT removed_batch_id IS NOT NULL AS removed FROM posts WHERE id = ?1`)
      .bind(id)
      .first<{ removed: number }>();
    if (!now) return null;
    return { state: now.removed ? "removed" : "deleted", ...discussion };
  }
  const post = toPublicPost(row);
  // Who may comment holds while the author has the plan, as outside links do.
  if (row.reply_policy && post.author.outsideLinks) post.replies = row.reply_policy;
  // A closed discussion stays closed, plan or not, until its author opens it.
  if (row.comments_closed_at !== null) post.commentsClosed = true;
  return { state: "live", post, ...discussion };
}
