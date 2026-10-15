import { env } from "cloudflare:workers";

export const db = env.DB;
export const NOW = 1_800_000_000;
export const DAY = 24 * 3600;

const TABLES = [
  "oauth_codes",
  "oauth_clients",
  "subscriptions",
  "agent_tokens",
  "pins",
  "mod_actions",
  "reports",
  "images",
  "bookmarks",
  "votes",
  "comments",
  "posts",
  "usernames",
  "profiles",
];

export async function reset(): Promise<void> {
  await db.batch(TABLES.map((table) => db.prepare(`DELETE FROM ${table}`)));
}

export async function user(
  id: string,
  name: string,
  fields: { karma?: number; deletedAt?: number; banReason?: string; role?: string } = {},
): Promise<void> {
  await db.batch([
    db
      .prepare(
        `INSERT INTO profiles (user_id, karma, role, ban_reason, banned_at, created_at, deleted_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)`,
      )
      .bind(
        id,
        fields.karma ?? 0,
        fields.role ?? "user",
        fields.banReason ?? null,
        fields.banReason ? NOW : null,
        NOW - 100 * DAY,
        fields.deletedAt ?? null,
      ),
    db
      .prepare(
        `INSERT INTO usernames (name, user_id, is_current, created_at) VALUES (?1, ?2, 1, ?3)`,
      )
      .bind(name, id, NOW - 100 * DAY),
  ]);
}

export interface PostFields {
  author?: string;
  url?: string;
  key?: string;
  title?: string;
  description?: string;
  score?: number;
  age?: number;
  provider?: string;
  aspect?: string;
  deleted?: boolean;
  removed?: boolean;
  editedAfter?: number;
}

export async function post(id: string, fields: PostFields = {}): Promise<void> {
  const createdAt = NOW - (fields.age ?? 3600);
  await db
    .prepare(
      `INSERT INTO posts (id, author_id, url, canonical_key, provider, origin, title,
         description, aspect, score, created_at, edited_at, deleted_at, removed_batch_id)
       VALUES (?1, ?2, ?3, ?4, ?5, 'found', ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13)`,
    )
    .bind(
      id,
      fields.author ?? "u1",
      fields.url ?? `https://example.com/${id}`,
      fields.key ?? `url:example.com/${id}`,
      fields.provider ?? null,
      fields.title ?? `Title of ${id}`,
      fields.description ?? `Description of ${id}`,
      fields.aspect ?? null,
      fields.score ?? 0,
      createdAt,
      fields.editedAfter === undefined ? null : createdAt + fields.editedAfter,
      fields.deleted ? createdAt + 60 : null,
      fields.removed ? `batch-${id}` : null,
    )
    .run();
}

export interface CommentFields {
  post?: string;
  parent?: string;
  author?: string;
  body?: string;
  score?: number;
  age?: number;
  deleted?: boolean;
  removed?: boolean;
  depth?: number;
}

export async function comment(id: string, fields: CommentFields = {}): Promise<void> {
  const createdAt = NOW - (fields.age ?? 600);
  await db
    .prepare(
      `INSERT INTO comments (id, post_id, parent_id, author_id, body, score, created_at,
         deleted_at, removed_batch_id, depth)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)`,
    )
    .bind(
      id,
      fields.post ?? "p1",
      fields.parent ?? null,
      fields.author ?? "u1",
      fields.body ?? `Body of ${id}`,
      fields.score ?? 0,
      createdAt,
      fields.deleted ? createdAt + 60 : null,
      fields.removed ? `batch-${id}` : null,
      fields.depth ?? 0,
    )
    .run();
}
