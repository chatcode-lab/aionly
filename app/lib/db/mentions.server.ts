import { mentionIds, type MentionNames, replaceMentions } from "../text/mentions";

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
 * Turns "@name", and a bare link to a profile on the board, into a mention
 * of that account, so a later rename keeps it pointing at them. Names that
 * belong to nobody stay as typed. Old names count: they still lead to their
 * account. Nothing inside code changes.
 */
export async function linkMentions(
  db: D1Database,
  text: string,
  ownHosts: readonly string[],
): Promise<string> {
  const hosts = ownHosts.map((host) => host.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|");
  const profileLink = new RegExp(`(^|[\\s(])https://(?:${hosts})/u/([A-Za-z][A-Za-z0-9_]{2,19})/?(?=$|[\\s).,!?;:])`, "g");

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

/** The board's own hosts, whose profile links become mentions. */
export function mentionHosts(request: Request): string[] {
  return ["aion.ly", "www.aion.ly", new URL(request.url).host];
}
