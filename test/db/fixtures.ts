import { env } from "cloudflare:workers";

import { forgetSettings } from "../../app/lib/db/settings.server";

export const db = env.DB;
export const NOW = 1_800_000_000;
export const DAY = 24 * 3600;

const TABLES = [
  "file_deletions",
  "deleted_texts",
  "agent_feedback",
  "drafts",
  "picks",
  "editor_terms",
  "partner_payouts",
  "partner_joins",
  "partner_link_steps",
  "partner_links",
  "fund_gifts",
  "fund_causes",
  "fund_votes",
  "name_allowances",
  "payments",
  "refunds",
  "sign_in_link_sends",
  "settings",
  "comment_bookmarks",
  "invites",
  "checkout_claims",
  "checkout_returns",
  "mentions",
  "fresh_starts",
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
  // Every setting back to its default, in this instance's copy too.
  forgetSettings();
}

export async function user(
  id: string,
  name: string,
  fields: { karma?: number; deletedAt?: number; banReason?: string; role?: string; plan?: boolean | "year" } = {},
): Promise<void> {
  await db.batch([
    db
      .prepare(
        `INSERT INTO profiles (user_id, karma, vote_karma, role, ban_reason, banned_at, created_at, deleted_at, plan_until)
         VALUES (?1, ?2, ?2, ?3, ?4, ?5, ?6, ?7, ?8)`,
      )
      .bind(
        id,
        fields.karma ?? 0,
        fields.role ?? "user",
        fields.banReason ?? null,
        fields.banReason ? NOW : null,
        NOW - 100 * DAY,
        fields.deletedAt ?? null,
        // The Fan plan, which an agent needs from its owner to take part.
        fields.plan ? NOW + 30 * DAY : null,
      ),
    db
      .prepare(
        `INSERT INTO usernames (name, user_id, is_current, created_at) VALUES (?1, ?2, 1, ?3)`,
      )
      .bind(name, id, NOW - 100 * DAY),
    // A yearly plan is billed through a subscription the board records.
    ...(fields.plan === "year"
      ? [
          db
            .prepare(`INSERT INTO subscriptions (user_id, customer_id, status, interval, updated_at) VALUES (?1, ?2, 'active', 'year', ?3)`)
            .bind(id, `cus_fixture_${id}`, NOW),
        ]
      : []),
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
  origin?: "made" | "found";
}

export async function post(id: string, fields: PostFields = {}): Promise<void> {
  const createdAt = NOW - (fields.age ?? 3600);
  await db
    .prepare(
      `INSERT INTO posts (id, author_id, url, canonical_key, provider, origin, title,
         description, aspect, score, created_at, edited_at, deleted_at, removed_batch_id)
       VALUES (?1, ?2, ?3, ?4, ?5, ?14, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13)`,
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
      fields.origin ?? "found",
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
