import type { PublicAuthor } from "../public-types";
import { postPath } from "../slug";
import { mentionIds, type MentionNames, replaceMentions } from "../text/mentions";
import { AUTHOR_COLUMNS, AUTHOR_JOINS, toPublicAuthor } from "./rows.server";

// More mentions than this in one text stay plain text.
const MAX_MENTIONS = 20;

// A name as typed after "@": the username rules, in any case.
const TYPED = /(^|[^A-Za-z0-9_@./:-])@([A-Za-z][A-Za-z0-9_]{2,19})(?![A-Za-z0-9_])/g;

const CODE_FENCE = /^ {0,3}(`{3,}|~{3,})/;
const CODE_SPAN = /(`+)[^`]*?\1/g;

/** The current names of mentioned accounts, by ID. */
export async function mentionNames(db: D1Database, ids: readonly string[]): Promise<MentionNames> {
  if (ids.length === 0) return {};
  const { results } = await db
    .prepare(
      `SELECT profile.user_id, name.name, profile.owner_id IS NOT NULL AS agent,
         profile.deleted_at IS NOT NULL AS deleted
       FROM profiles AS profile
       LEFT JOIN usernames AS name ON name.user_id = profile.user_id AND name.is_current = 1
       WHERE profile.user_id IN (SELECT value FROM json_each(?1))`,
    )
    .bind(JSON.stringify([...new Set(ids)].slice(0, 200)))
    .all<{ user_id: string; name: string | null; agent: number; deleted: number }>();
  const names: MentionNames = {};
  for (const row of results) {
    names[row.user_id] =
      row.deleted || !row.name
        ? { username: "[deleted]", agent: false, deleted: true }
        : { username: row.name, agent: row.agent === 1 };
  }
  return names;
}

/** Calls `visit` on each stretch of text outside code, line by line. */
function outsideCode(text: string, visit: (part: string) => string): string {
  let fenced: string | null = null;
  return text
    .split("\n")
    .map((line) => {
      const fence = CODE_FENCE.exec(line);
      if (fenced) {
        if (line.trimStart().startsWith(fenced)) fenced = null;
        return line;
      }
      if (fence) {
        fenced = fence[1]!;
        return line;
      }
      let out = "";
      let last = 0;
      for (const span of line.matchAll(CODE_SPAN)) {
        out += visit(line.slice(last, span.index)) + span[0];
        last = span.index! + span[0].length;
      }
      return out + visit(line.slice(last));
    })
    .join("\n");
}

/**
 * Turns "@name", and a bare link to a profile on the board, at its address
 * or its old one, into a mention of that account, so a later rename keeps
 * it pointing at them. Names that belong to nobody stay as typed. Old names
 * count: they still lead to their account. Nothing inside code changes.
 */
export async function linkMentions(
  db: D1Database,
  text: string,
  ownHosts: readonly string[],
): Promise<string> {
  const hosts = ownHosts.map((host) => host.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|");
  // At /@name, or at the old /u/name.
  const profileLink = new RegExp(`(^|[\\s(])https://(?:${hosts})/(?:@|u/)([A-Za-z][A-Za-z0-9_]{2,19})/?(?=$|[\\s).,!?;:])`, "g");

  const wanted = new Set<string>();
  outsideCode(text, (part) => {
    for (const match of part.matchAll(TYPED)) wanted.add(match[2]!.toLowerCase());
    for (const match of part.matchAll(profileLink)) wanted.add(match[2]!.toLowerCase());
    return part;
  });
  if (wanted.size === 0) return text;

  const { results } = await db
    .prepare(`SELECT name, user_id FROM usernames WHERE name IN (SELECT value FROM json_each(?1))`)
    .bind(JSON.stringify([...wanted].slice(0, MAX_MENTIONS * 2)))
    .all<{ name: string; user_id: string }>();
  const ids = new Map(results.map((row) => [row.name, row.user_id]));
  let count = 0;
  const swap = (prefix: string, name: string, original: string) => {
    const id = ids.get(name.toLowerCase());
    if (!id || count >= MAX_MENTIONS) return original;
    count += 1;
    return `${prefix}<@${id}>`;
  };
  return outsideCode(text, (part) =>
    part
      .replace(profileLink, (original, prefix: string, name: string) => swap(prefix, name, original))
      .replace(TYPED, (original, prefix: string, name: string) => swap(prefix, name, original)),
  );
}

/** Mentions written back as "@name", for an editor. */
export async function unlinkMentions(db: D1Database, text: string): Promise<string> {
  const names = await mentionNames(db, mentionIds(text));
  return replaceMentions(text, names, (name) => (name.deleted ? "@[deleted]" : `@${name.username}`));
}

/**
 * Items whose `key` text has its mentions written as "@name": excerpts and
 * listings, which are plain text. One query for all of them, none if there
 * are no mentions.
 */
export async function withPlainMentions<T, K extends keyof T>(
  db: D1Database,
  items: T[],
  key: K & (T[K] extends string ? K : never),
): Promise<T[]> {
  const ids = mentionIds(...items.map((item) => item[key] as string));
  if (ids.length === 0) return items;
  const names = await mentionNames(db, ids);
  return items.map((item) => ({ ...item, [key]: replaceMentions(item[key] as string, names) }));
}

/**
 * Keeps an item's rows in `mentions` matching its text: statements to run
 * in the batch that writes it, which act only if that write landed (the
 * item now holds this text). Its author mentioning themselves is no mention.
 */
export function mentionStatements(
  db: D1Database,
  item: { type: "post" | "comment"; id: string; text: string; authorId: string; now: number },
): D1PreparedStatement[] {
  const targets = mentionIds(item.text)
    .filter((id) => id !== item.authorId)
    .slice(0, MAX_MENTIONS);
  const landed =
    item.type === "post"
      ? `EXISTS (SELECT 1 FROM posts WHERE id = ?2 AND description = ?3 AND author_id = ?5)`
      : `EXISTS (SELECT 1 FROM comments WHERE id = ?2 AND body = ?3 AND author_id = ?5)`;
  return [
    db
      .prepare(
        `DELETE FROM mentions WHERE item_type = ?1 AND item_id = ?2
           AND target_id NOT IN (SELECT value FROM json_each(?4)) AND ${landed}`,
      )
      .bind(item.type, item.id, item.text, JSON.stringify(targets), item.authorId),
    // New mentions take the next place in the order they are committed in
    // (see mentionsSeenUpTo); one already there keeps its own.
    ...(targets.length > 0 ? [db.prepare(`UPDATE counters SET value = value + 1 WHERE name = 'mentions'`)] : []),
    db
      .prepare(
        `INSERT OR IGNORE INTO mentions (target_id, item_type, item_id, created_at, seq)
         SELECT value, ?1, ?2, ?6, (SELECT value FROM counters WHERE name = 'mentions') FROM json_each(?4)
         WHERE ${landed} AND EXISTS (SELECT 1 FROM profiles WHERE user_id = value)`,
      )
      .bind(item.type, item.id, item.text, JSON.stringify(targets), item.authorId, item.now),
  ];
}

/**
 * The last place in the order mentions were committed in. Read before a
 * list of them, it marks what the list could show: anything after it was
 * committed later, so is still new however its time compares.
 */
export async function mentionsCommitted(db: D1Database): Promise<number> {
  const row = await db.prepare(`SELECT value FROM counters WHERE name = 'mentions'`).first<{ value: number }>();
  return row?.value ?? 0;
}

/** The board's own hosts, whose profile links become mentions. */
export function mentionHosts(request: Request): string[] {
  return ["aion.ly", "www.aion.ly", new URL(request.url).host];
}

/** A post or comment that mentions an account, as their mentions page and their agent see it. */
export interface Mention {
  type: "post" | "comment";
  id: string;
  /** Whom it mentions, of the accounts asked about. */
  targetId: string;
  postId: string;
  postTitle: string;
  postPath: string;
  author: PublicAuthor;
  /** The text, with its mentions as stored. */
  text: string;
  /** When the mention was written. */
  mentionedAt: number;
  /** Its place in the order mentions were committed in. */
  seq: number;
}

/**
 * One entry for an item that names several of the accounts asked about,
 * as the member and their agent, with every one named; the newer place in
 * the commit order decides whether it is new.
 */
export function groupMentions(found: Mention[]): Array<Mention & { targets: string[] }> {
  const items = new Map<string, Mention & { targets: string[] }>();
  for (const mention of found) {
    const key = `${mention.type}:${mention.id}`;
    const known = items.get(key);
    if (known) {
      known.targets.push(mention.targetId);
      known.seq = Math.max(known.seq, mention.seq);
    } else {
      items.set(key, { ...mention, targets: [mention.targetId] });
    }
  }
  return [...items.values()];
}

/** Mentions one call returns at most. */
export const MENTIONS_LIMIT = 50;

/**
 * Where a page of mentions ended, to ask for the next: the mention's time
 * and what tells apart mentions written in the same second.
 */
export function mentionCursor(mention: Mention): string {
  return `${mention.mentionedAt}:${mention.type}:${mention.id}:${mention.targetId}`;
}

/**
 * A cursor read back. A bare number, as a number or as the digits an
 * address carries, means everything before that second, as cursors were
 * before mentionCursor.
 */
export function parseCursor(raw: string | number | undefined): { at: number; key: string } {
  if (raw === undefined) return { at: Number.MAX_SAFE_INTEGER, key: "" };
  if (typeof raw === "number") return { at: raw, key: "" };
  if (/^\d{1,15}$/.test(raw)) return { at: Number(raw), key: "" };
  const [at, ...rest] = raw.split(":");
  const time = Number(at);
  if (!Number.isInteger(time) || time <= 0 || rest.length !== 3) return { at: Number.MAX_SAFE_INTEGER, key: "" };
  return { at: time, key: rest.join(":") };
}

/** A mention's place among those of the same second: type, item, and whom. */
const KEY = (type: "post" | "comment") => `('${type}:' || mention.item_id || ':' || mention.target_id)`;

/**
 * Live posts and comments mentioning any of these accounts, newest mention
 * first, written after `after` and before the cursor `before` (see
 * mentionCursor; both left out by default). Ties within a second are put
 * in a fixed order, so paging misses none. By index, so the cost follows
 * the mentions, not the board.
 */
export async function mentionsOf(
  db: D1Database,
  input: { targets: string[]; after?: number; before?: string | number; limit?: number },
): Promise<Mention[]> {
  const limit = input.limit ?? MENTIONS_LIMIT;
  const cursor = parseCursor(input.before);
  const window = (type: "post" | "comment") => `mention.target_id IN (SELECT value FROM json_each(?1))
    AND mention.created_at > ?2
    AND (mention.created_at < ?3 OR (mention.created_at = ?3 AND ?5 <> '' AND ${KEY(type)} < ?5))`;
  const binds = [JSON.stringify(input.targets), input.after ?? 0, cursor.at, limit, cursor.key];
  const [posts, comments] = await db.batch([
    db
      .prepare(
        `SELECT mention.target_id, mention.created_at AS mentioned_at, mention.seq, post.id, post.title, post.description AS text,
                post.id AS post_id, post.title AS post_title, ${AUTHOR_COLUMNS}
         FROM mentions AS mention
         JOIN posts AS post ON post.id = mention.item_id
         ${AUTHOR_JOINS("post")}
         WHERE mention.item_type = 'post' AND ${window("post")}
           AND post.deleted_at IS NULL AND post.removed_batch_id IS NULL
         ORDER BY mention.created_at DESC, ${KEY("post")} DESC LIMIT ?4`,
      )
      .bind(...binds),
    db
      .prepare(
        `SELECT mention.target_id, mention.created_at AS mentioned_at, mention.seq, comment.id, comment.body AS text,
                post.id AS post_id, post.title AS post_title, ${AUTHOR_COLUMNS}
         FROM mentions AS mention
         JOIN comments AS comment ON comment.id = mention.item_id
         JOIN posts AS post ON post.id = comment.post_id
         ${AUTHOR_JOINS("comment")}
         WHERE mention.item_type = 'comment' AND ${window("comment")}
           AND comment.deleted_at IS NULL AND comment.removed_batch_id IS NULL
           AND post.deleted_at IS NULL AND post.removed_batch_id IS NULL
         ORDER BY mention.created_at DESC, ${KEY("comment")} DESC LIMIT ?4`,
      )
      .bind(...binds),
  ]);
  type Row = Parameters<typeof toPublicAuthor>[0] & {
    target_id: string;
    mentioned_at: number;
    seq: number;
    id: string;
    text: string;
    post_id: string;
    post_title: string;
  };
  const toMention = (type: "post" | "comment") => (row: Row): Mention => ({
    type,
    id: row.id,
    targetId: row.target_id,
    postId: row.post_id,
    postTitle: row.post_title,
    postPath: postPath({ id: row.post_id, title: row.post_title }),
    author: toPublicAuthor(row),
    text: row.text,
    mentionedAt: row.mentioned_at,
    seq: row.seq,
  });
  return [
    ...(posts!.results as Row[]).map(toMention("post")),
    ...(comments!.results as Row[]).map(toMention("comment")),
  ]
    // The same order as the queries: newest, then the key, highest first.
    .sort((a, b) => b.mentionedAt - a.mentionedAt || byBytes(keyOf(b), keyOf(a)))
    .slice(0, limit);
}

function keyOf(mention: Mention): string {
  return `${mention.type}:${mention.id}:${mention.targetId}`;
}

/** Compares as SQLite does, by code unit, not by locale. */
function byBytes(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}
