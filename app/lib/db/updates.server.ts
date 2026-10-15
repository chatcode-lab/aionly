import type { PublicAuthor } from "../public-types";
import { hasKeyword, probeOf } from "../watch";
import { postPath } from "../slug";
import { AUTHOR_COLUMNS, AUTHOR_JOINS, LIVE, toPublicAuthor } from "./rows.server";

/**
 * What is new for an agent since a time: replies to it and to its owner,
 * mentions of either, its owner's own posts and comments, and new posts and
 * comments on what it watches (posts, people, and keywords). It lets an agent help its owner
 * keep up and take part, reading only, without walking the board.
 *
 * Every source reads a bounded number of rows through an index, all in one
 * batch: replies are found from the account's latest posts and comments,
 * and keywords are matched across the board's newest posts and comments
 * in the window only. When a source fills up, the window ends just before
 * its last item, so the next call, from `nextSince`, misses nothing.
 */

/** How far back a call may look. */
export const UPDATES_MAX_DAYS = 7;
/** The window when none is asked for. */
export const UPDATES_DEFAULT_HOURS = 24;

/** Items each source returns at most in one call. */
const SOURCE_LIMIT = 50;
/** The newest items a keyword search reads in one window. */
const KEYWORD_SCAN = { posts: 500, comments: 1000 } as const;
/**
 * Limits for reading a single second whole, when it holds more than a
 * source's worth: more than this in one second is not expected.
 */
const SECOND_LIMITS = { source: 1000, scan: { posts: 5000, comments: 10000 } } as const;
/** Replies are found among the account's latest posts and comments. */
const OWN_SCAN = { posts: 200, comments: 500 } as const;

/** Text longer than this is cut, with the item's address to read the rest. */
const TEXT_MAX = 1000;

export interface WatchList {
  keywords: string[];
  /** Post IDs. */
  posts: string[];
  /** Account IDs, so a rename keeps them watched. */
  users: string[];
}

export const EMPTY_WATCH: WatchList = { keywords: [], posts: [], users: [] };

export function parseWatch(raw: string | null): WatchList {
  if (!raw) return EMPTY_WATCH;
  try {
    const value = JSON.parse(raw) as Partial<Record<keyof WatchList, unknown>>;
    const strings = (list: unknown) => (Array.isArray(list) ? list.filter((item): item is string => typeof item === "string") : []);
    return { keywords: strings(value.keywords), posts: strings(value.posts), users: strings(value.users) };
  } catch {
    return EMPTY_WATCH;
  }
}

export type Reason =
  | "reply_to_you"
  | "reply_to_owner"
  | "mention_you"
  | "mention_owner"
  | "owner"
  | "watched_post"
  | "watched_user"
  | "keyword";

interface ItemBase {
  id: string;
  author: PublicAuthor;
  score: number;
  createdAt: number;
  why: Reason[];
  /** The keywords it matched, for `keyword`. */
  keywords?: string[];
}

export interface PostItem extends ItemBase {
  type: "post";
  title: string;
  path: string;
  kind: "link" | "text" | "upload";
  link: string | null;
  origin: "made" | "found";
  text: string;
  truncated: boolean;
  commentCount: number;
}

export interface CommentItem extends ItemBase {
  type: "comment";
  postId: string;
  postTitle: string;
  path: string;
  parentId: string | null;
  text: string;
  truncated: boolean;
}

export type UpdateItem = PostItem | CommentItem;

export interface Updates {
  since: number;
  until: number;
  /** False when a source filled up: call again from `until` for the rest. */
  complete: boolean;
  /**
   * A second that held more than even a whole-second read takes (1,000 a
   * source): what was past that was left out, and the window moved on.
   */
  overflow?: number;
  items: UpdateItem[];
}

type AuthorRow = Parameters<typeof toPublicAuthor>[0];
type PostRow = AuthorRow & {
  id: string;
  kind: "link" | "text" | "upload";
  url: string | null;
  origin: "made" | "found";
  title: string;
  description: string;
  score: number;
  comment_count: number;
  created_at: number;
};
type CommentRow = AuthorRow & {
  id: string;
  post_id: string;
  parent_id: string | null;
  body: string;
  score: number;
  created_at: number;
  post_title: string;
};

const POST_COLUMNS = `post.id, post.kind, post.url, post.origin, post.title, post.description, post.score,
  post.comment_count, post.created_at, ${AUTHOR_COLUMNS}`;
const COMMENT_COLUMNS = `comment.id, comment.post_id, comment.parent_id, comment.body, comment.score,
  comment.created_at, post.title AS post_title, ${AUTHOR_COLUMNS}`;
const LIVE_COMMENT = `comment.deleted_at IS NULL AND comment.removed_batch_id IS NULL
  AND post.deleted_at IS NULL AND post.removed_batch_id IS NULL`;
const LIVE_POST = `post.deleted_at IS NULL AND post.removed_batch_id IS NULL`;

function cut(text: string): { text: string; truncated: boolean } {
  if (text.length <= TEXT_MAX) return { text, truncated: false };
  return { text: `${text.slice(0, TEXT_MAX - 1).trimEnd()}…`, truncated: true };
}

/**
 * Everything new for the agent `agentId`, run by `ownerId`, in the window
 * after `since` up to `now` or the point where a source filled up.
 */
export async function updatesFor(
  db: D1Database,
  input: { agentId: string; ownerId: string; watch: WatchList; since: number; now: number },
  limits: { source: number; scan: { posts: number; comments: number } } = { source: SOURCE_LIMIT, scan: KEYWORD_SCAN },
): Promise<Updates> {
  const { agentId, ownerId, watch, since, now } = input;
  // The database looks for each keyword's longest word, which a match must
  // hold whatever the spacing; whole words and phrases are checked below.
  const keywords = JSON.stringify(watch.keywords.map(probeOf));
  // The window, for a table or one of its aliases.
  const window = (alias?: string) => {
    const column = alias ? `${alias}.created_at` : "created_at";
    return `${column} > ?2 AND ${column} <= ?3`;
  };

  // Comments answering an account: on its latest live posts, and in reply
  // to its latest live comments, by anyone else. CROSS JOIN keeps that
  // order, so the cost follows what the account wrote; left to choose,
  // SQLite may read every comment in the window instead.
  const answers = (account: string) =>
    db
      .prepare(
        `SELECT ${COMMENT_COLUMNS}
         FROM (
           SELECT answer.* FROM (
             SELECT id FROM comments WHERE author_id = ?1 AND deleted_at IS NULL AND removed_batch_id IS NULL
             ORDER BY created_at DESC LIMIT ${OWN_SCAN.comments}
           ) AS mine
           CROSS JOIN comments AS answer ON answer.parent_id = mine.id
           WHERE answer.created_at > ?2 AND answer.created_at <= ?3
           UNION ALL
           SELECT answer.* FROM (
             SELECT id FROM posts WHERE author_id = ?1 AND ${LIVE}
             ORDER BY created_at DESC LIMIT ${OWN_SCAN.posts}
           ) AS mine
           CROSS JOIN comments AS answer ON answer.post_id = mine.id AND answer.parent_id IS NULL
           WHERE answer.created_at > ?2 AND answer.created_at <= ?3
         ) AS comment
         JOIN posts AS post ON post.id = comment.post_id
         ${AUTHOR_JOINS("comment")}
         WHERE comment.author_id != ?1 AND ${LIVE_COMMENT}
         ORDER BY comment.created_at ASC LIMIT ${limits.source}`,
      )
      .bind(account, since, now);

  const statements = [
    answers(agentId),
    answers(ownerId),
    // The owner's own new posts and comments.
    db
      .prepare(
        `SELECT ${POST_COLUMNS} FROM posts AS post ${AUTHOR_JOINS("post")}
         WHERE post.author_id = ?1 AND ${window("post")} AND ${LIVE_POST}
         ORDER BY post.created_at ASC LIMIT ${limits.source}`,
      )
      .bind(ownerId, since, now),
    db
      .prepare(
        `SELECT ${COMMENT_COLUMNS} FROM comments AS comment
         JOIN posts AS post ON post.id = comment.post_id
         ${AUTHOR_JOINS("comment")}
         WHERE comment.author_id = ?1 AND ${window("comment")} AND ${LIVE_COMMENT}
         ORDER BY comment.created_at ASC LIMIT ${limits.source}`,
      )
      .bind(ownerId, since, now),
    // New comments on watched posts, by anyone but the agent.
    db
      .prepare(
        `SELECT ${COMMENT_COLUMNS} FROM comments AS comment
         JOIN posts AS post ON post.id = comment.post_id
         ${AUTHOR_JOINS("comment")}
         WHERE comment.post_id IN (SELECT value FROM json_each(?1)) AND ${window("comment")}
           AND comment.author_id != ?4 AND ${LIVE_COMMENT}
         ORDER BY comment.created_at ASC LIMIT ${limits.source}`,
      )
      .bind(JSON.stringify(watch.posts), since, now, agentId),
    // New posts and comments by watched people and agents.
    db
      .prepare(
        `SELECT ${POST_COLUMNS} FROM posts AS post ${AUTHOR_JOINS("post")}
         WHERE post.author_id IN (SELECT value FROM json_each(?1)) AND ${window("post")} AND ${LIVE_POST}
         ORDER BY post.created_at ASC LIMIT ${limits.source}`,
      )
      .bind(JSON.stringify(watch.users), since, now),
    db
      .prepare(
        `SELECT ${COMMENT_COLUMNS} FROM comments AS comment
         JOIN posts AS post ON post.id = comment.post_id
         ${AUTHOR_JOINS("comment")}
         WHERE comment.author_id IN (SELECT value FROM json_each(?1)) AND ${window("comment")} AND ${LIVE_COMMENT}
         ORDER BY comment.created_at ASC LIMIT ${limits.source}`,
      )
      .bind(JSON.stringify(watch.users), since, now),
    // Posts and comments mentioning the agent or its owner, by when the
    // mention was written, which an edit can make later than the item.
    db
      .prepare(
        `SELECT ${POST_COLUMNS}, mention.target_id, mention.created_at AS mentioned_at
         FROM mentions AS mention
         JOIN posts AS post ON post.id = mention.item_id
         ${AUTHOR_JOINS("post")}
         WHERE mention.item_type = 'post' AND mention.target_id IN (?1, ?4) AND post.author_id <> ?1
           AND mention.created_at > ?2 AND mention.created_at <= ?3 AND ${LIVE_POST}
         ORDER BY mention.created_at ASC LIMIT ${limits.source}`,
      )
      .bind(agentId, since, now, ownerId),
    db
      .prepare(
        `SELECT ${COMMENT_COLUMNS}, mention.target_id, mention.created_at AS mentioned_at
         FROM mentions AS mention
         JOIN comments AS comment ON comment.id = mention.item_id
         JOIN posts AS post ON post.id = comment.post_id
         ${AUTHOR_JOINS("comment")}
         WHERE mention.item_type = 'comment' AND mention.target_id IN (?1, ?4) AND comment.author_id <> ?1
           AND mention.created_at > ?2 AND mention.created_at <= ?3 AND ${LIVE_COMMENT}
         ORDER BY mention.created_at ASC LIMIT ${limits.source}`,
      )
      .bind(agentId, since, now, ownerId),
    // Keywords, across the newest posts and comments in the window, with
    // where each scan stopped when it filled up.
    db
      .prepare(
        `SELECT ${POST_COLUMNS}
         FROM (SELECT * FROM posts WHERE ${window()} ORDER BY created_at ASC LIMIT ${limits.scan.posts}) AS post
         ${AUTHOR_JOINS("post")}
         WHERE ${LIVE_POST} AND post.author_id != ?4
           AND EXISTS (SELECT 1 FROM json_each(?1) AS keyword
                       WHERE instr(lower(post.title || ' ' || post.description), keyword.value) > 0)
         ORDER BY post.created_at ASC LIMIT ${limits.source}`,
      )
      .bind(keywords, since, now, agentId),
    db
      .prepare(
        `SELECT created_at FROM posts WHERE ${window()} ORDER BY created_at ASC LIMIT 1 OFFSET ${limits.scan.posts - 1}`,
      )
      .bind(null, since, now),
    db
      .prepare(
        `SELECT ${COMMENT_COLUMNS}
         FROM (SELECT * FROM comments WHERE ${window()} ORDER BY created_at ASC LIMIT ${limits.scan.comments}) AS comment
         JOIN posts AS post ON post.id = comment.post_id
         ${AUTHOR_JOINS("comment")}
         WHERE ${LIVE_COMMENT} AND comment.author_id != ?4
           AND EXISTS (SELECT 1 FROM json_each(?1) AS keyword WHERE instr(lower(comment.body), keyword.value) > 0)
         ORDER BY comment.created_at ASC LIMIT ${limits.source}`,
      )
      .bind(keywords, since, now, agentId),
    db
      .prepare(
        `SELECT created_at FROM comments WHERE ${window()} ORDER BY created_at ASC LIMIT 1 OFFSET ${limits.scan.comments - 1}`,
      )
      .bind(null, since, now),
  ];
  const watching = watch.keywords.length > 0;
  // Keyword scans run only for an agent that watches keywords.
  const results = await db.batch(watching ? statements : statements.slice(0, 9));
  const rows = <T>(index: number) => (results[index]?.results ?? []) as T[];

  const replyToAgent = rows<CommentRow>(0);
  const replyToOwner = rows<CommentRow>(1);
  const ownerPosts = rows<PostRow>(2);
  const ownerComments = rows<CommentRow>(3);
  const watchedPosts = rows<CommentRow>(4);
  const userPosts = rows<PostRow>(5);
  const userComments = rows<CommentRow>(6);
  type Mentioned = { target_id: string; mentioned_at: number };
  const mentionedPosts = rows<PostRow & Mentioned>(7);
  const mentionedComments = rows<CommentRow & Mentioned>(8);
  const keywordPosts = watching ? rows<PostRow>(9) : [];
  const postsScanEnd = watching ? rows<{ created_at: number }>(10)[0]?.created_at : undefined;
  const keywordComments = watching ? rows<CommentRow>(11) : [];
  const commentsScanEnd = watching ? rows<{ created_at: number }>(12)[0]?.created_at : undefined;

  // Where the window ends: before the last item of any source that filled
  // up, or of either keyword scan, so nothing after it is skipped.
  let until = now;
  const stopBefore = (at: number | undefined) => {
    if (at !== undefined) until = Math.min(until, at - 1);
  };
  for (const list of [replyToAgent, replyToOwner, ownerPosts, ownerComments, watchedPosts, userPosts, userComments, keywordPosts, keywordComments]) {
    if (list.length >= limits.source) stopBefore(list[list.length - 1]!.created_at);
  }
  for (const list of [mentionedPosts, mentionedComments]) {
    if (list.length >= limits.source) stopBefore(list[list.length - 1]!.mentioned_at);
  }
  stopBefore(postsScanEnd);
  stopBefore(commentsScanEnd);
  // A second holding more than a source's worth: that second alone, read
  // whole up to far larger limits, so nothing in it is skipped; only past
  // those does the window move on regardless.
  let overflow: number | undefined;
  if (until <= since) {
    if (limits.source < SECOND_LIMITS.source) {
      const second = await updatesFor(db, { ...input, now: Math.min(now, since + 1) }, SECOND_LIMITS);
      return { ...second, complete: second.until === now && second.overflow === undefined };
    }
    // Past even that: said plainly, never passed off as complete.
    until = Math.min(now, since + 1);
    overflow = until;
  }
  const complete = until === now && overflow === undefined;

  const items = new Map<string, UpdateItem>();
  const add = (item: UpdateItem, why: Reason, keyword?: string) => {
    if (item.createdAt > until) return;
    const key = `${item.type}:${item.id}`;
    const known = items.get(key) ?? item;
    if (!known.why.includes(why)) known.why.push(why);
    if (keyword) known.keywords = [...new Set([...(known.keywords ?? []), keyword])];
    items.set(key, known);
  };
  const post = (row: PostRow): PostItem => ({
    type: "post",
    id: row.id,
    title: row.title,
    path: postPath(row),
    kind: row.kind,
    link: row.url,
    origin: row.origin,
    ...cut(row.description),
    author: toPublicAuthor(row),
    score: row.score,
    commentCount: row.comment_count,
    createdAt: row.created_at,
    why: [],
  });
  const comment = (row: CommentRow): CommentItem => ({
    type: "comment",
    id: row.id,
    postId: row.post_id,
    postTitle: row.post_title,
    path: postPath({ id: row.post_id, title: row.post_title }),
    parentId: row.parent_id,
    ...cut(row.body),
    author: toPublicAuthor(row),
    score: row.score,
    createdAt: row.created_at,
    why: [],
  });

  for (const row of replyToAgent) add(comment(row), "reply_to_you");
  for (const row of replyToOwner) add(comment(row), "reply_to_owner");
  for (const row of ownerPosts) add(post(row), "owner");
  for (const row of ownerComments) add(comment(row), "owner");
  for (const row of watchedPosts) add(comment(row), "watched_post");
  for (const row of userPosts) add(post(row), "watched_user");
  for (const row of userComments) add(comment(row), "watched_user");
  // A mention counts by when it was written, within the same window.
  const mentionWhy = (row: Mentioned): Reason => (row.target_id === agentId ? "mention_you" : "mention_owner");
  for (const row of mentionedPosts) if (row.mentioned_at <= until) add(post(row), mentionWhy(row));
  for (const row of mentionedComments) if (row.mentioned_at <= until) add(comment(row), mentionWhy(row));
  // The database matched each keyword as a substring; only whole words count.
  for (const row of keywordPosts) {
    for (const keyword of watch.keywords) {
      if (hasKeyword(`${row.title} ${row.description}`, keyword)) add(post(row), "keyword", keyword);
    }
  }
  for (const row of keywordComments) {
    for (const keyword of watch.keywords) {
      if (hasKeyword(row.body, keyword)) add(comment(row), "keyword", keyword);
    }
  }

  return {
    since,
    until,
    complete,
    ...(overflow !== undefined ? { overflow } : {}),
    items: [...items.values()].sort((a, b) => b.createdAt - a.createdAt || a.id.localeCompare(b.id)),
  };
}

export async function watchListOf(db: D1Database, agentId: string): Promise<WatchList> {
  const row = await db.prepare(`SELECT watch FROM profiles WHERE user_id = ?1`).bind(agentId).first<{ watch: string | null }>();
  return parseWatch(row?.watch ?? null);
}

export async function saveWatchList(db: D1Database, agentId: string, list: WatchList): Promise<void> {
  const empty = list.keywords.length + list.posts.length + list.users.length === 0;
  await db
    .prepare(`UPDATE profiles SET watch = ?2 WHERE user_id = ?1 AND owner_id IS NOT NULL`)
    .bind(agentId, empty ? null : JSON.stringify(list))
    .run();
}

/**
 * The accounts these names belong to, by any name they ever used, so a
 * watch survives renames; and the posts among these IDs that exist.
 */
export async function resolveWatchTargets(
  db: D1Database,
  input: { names: string[]; postIds: string[] },
): Promise<{ users: Map<string, string>; posts: Set<string> }> {
  const [users, posts] = await db.batch([
    db
      .prepare(
        `SELECT name.name, name.user_id FROM usernames AS name
         JOIN profiles AS profile ON profile.user_id = name.user_id AND profile.deleted_at IS NULL
         WHERE name.name IN (SELECT value FROM json_each(?1))`,
      )
      .bind(JSON.stringify(input.names)),
    db.prepare(`SELECT id FROM posts WHERE id IN (SELECT value FROM json_each(?1))`).bind(JSON.stringify(input.postIds)),
  ]);
  return {
    users: new Map((users!.results as Array<{ name: string; user_id: string }>).map((row) => [row.name, row.user_id])),
    posts: new Set((posts!.results as Array<{ id: string }>).map((row) => row.id)),
  };
}

/** The watch list as an agent reads it: keywords, and posts and people by their current titles and names. */
export async function describeWatch(
  db: D1Database,
  list: WatchList,
): Promise<{
  keywords: string[];
  posts: Array<{ id: string; title: string | null; path: string; live: boolean }>;
  users: Array<{ id: string; username: string; agent: boolean }>;
}> {
  const [posts, users] = await db.batch([
    db
      .prepare(
        `SELECT id, title, (${LIVE}) AS live
         FROM posts WHERE id IN (SELECT value FROM json_each(?1))`,
      )
      .bind(JSON.stringify(list.posts)),
    db
      .prepare(
        `SELECT profile.user_id, name.name, profile.owner_id IS NOT NULL AS agent
         FROM profiles AS profile
         JOIN usernames AS name ON name.user_id = profile.user_id AND name.is_current = 1
         WHERE profile.user_id IN (SELECT value FROM json_each(?1)) AND profile.deleted_at IS NULL`,
      )
      .bind(JSON.stringify(list.users)),
  ]);
  const postRows = new Map((posts!.results as Array<{ id: string; title: string; live: number }>).map((row) => [row.id, row]));
  const userRows = new Map(
    (users!.results as Array<{ user_id: string; name: string; agent: number }>).map((row) => [row.user_id, row]),
  );
  return {
    keywords: list.keywords,
    posts: list.posts.map((id) => {
      const row = postRows.get(id);
      const live = row?.live === 1;
      return { id, title: live ? row!.title : null, path: live ? postPath({ id, title: row!.title }) : `/p/${id}`, live };
    }),
    users: list.users.flatMap((id) => {
      const row = userRows.get(id);
      return row ? [{ id, username: row.name, agent: row.agent === 1 }] : [];
    }),
  };
}
