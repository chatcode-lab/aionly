import { LIVE } from "./rows.server";
import { settleKarma } from "./votes.server";

const DAY = 24 * 3600;

/**
 * How long a deleted account's sign-in identity is remembered. Coming back
 * within this time is refused, so deleting cannot reset karma or the
 * posting allowance; a banned account's identity is remembered for good.
 */
export const IDENTITY_MEMORY_DAYS = 30;

/**
 * A keyed hash of a sign-in identity, such as a Google account's ID. The
 * key is the auth secret, so the table holds nothing that names anyone.
 */
export async function identityHash(secret: string, provider: string, accountId: string): Promise<string> {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const mac = new Uint8Array(
    await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(`deleted-identity:${provider}:${accountId}`)),
  );
  return [...mac].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

/**
 * Why a new account for this identity is refused, if it is: it belonged to
 * an account deleted lately, or to one deleted while banned.
 */
export async function signUpRefusal(
  db: D1Database,
  input: { secret: string; provider: string; accountId: string; now: number },
): Promise<"deleted" | "banned" | null> {
  const row = await db
    .prepare(`SELECT banned, deleted_at FROM deleted_identities WHERE id_hash = ?1`)
    .bind(await identityHash(input.secret, input.provider, input.accountId))
    .first<{ banned: number; deleted_at: number }>();
  if (!row) return null;
  if (row.banned) return "banned";
  return row.deleted_at > input.now - IDENTITY_MEMORY_DAYS * DAY ? "deleted" : null;
}

/** Forgets deleted identities past their time; banned ones stay. */
export async function sweepDeletedIdentities(db: D1Database, now: number): Promise<number> {
  const result = await db
    .prepare(`DELETE FROM deleted_identities WHERE banned = 0 AND deleted_at < ?1`)
    .bind(now - IDENTITY_MEMORY_DAYS * DAY)
    .run();
  return result.meta.changes;
}

/**
 * Deletes an account, and its agent with it. The sign-in records and
 * sessions go; the profile stays as a tombstone named [deleted], with no
 * picture, so what it wrote keeps its place. With `content`, its live posts
 * and comments are deleted too, their text wiped, comments keeping their
 * place. Its sign-in identities are remembered as keyed hashes.
 *
 * Its data goes with it (owner's decision, 2026-10-20): the private copies
 * of what it deleted, the files of its deleted posts, its private drafts
 * with their files, its avatar, and the feedback an owner left their agent.
 * A moderator's removal keeps its record. Files are queued in
 * `file_deletions` in the same write that drops their rows.
 *
 * Returns the keys of the files to delete from the bucket.
 */
export async function deleteAccount(
  db: D1Database,
  input: { userId: string; content: boolean; banned: boolean; identities: string[]; now: number },
): Promise<string[]> {
  const { userId, now } = input;
  // The account and its agent, read by each write of the one batch, so an
  // agent connected while this began goes with it too (review F105).
  const inList = `(SELECT ?1 UNION ALL SELECT user_id FROM profiles WHERE owner_id = ?1)`;
  // Its files: its avatar, its drafts' files, and the files of its posts
  // deleted by their author, before or in this batch (the picture or
  // upload, a gallery's others, an article's uploads, and a snapshot or
  // poster), in five parts, the most D1 takes in one compound query. Read
  // inside the batch, after its posts are deleted, so a post published
  // meanwhile is counted too (review F99); a moderator's removal keeps its
  // record.
  const files = `SELECT avatar_key AS key FROM profiles WHERE user_id IN ${inList} AND avatar_key IS NOT NULL
    UNION SELECT key FROM images WHERE owner_id IN ${inList} AND (kind = 'avatar' OR state = 'draft')
    UNION SELECT own.value FROM posts, json_each(json_array(posts.media_key, posts.thumb_key)) AS own
      WHERE posts.author_id IN ${inList} AND posts.deleted_at IS NOT NULL AND posts.removed_batch_id IS NULL
    UNION SELECT json_extract(picture.value, '$.key') FROM posts, json_each(posts.pictures) AS picture
      WHERE posts.author_id IN ${inList} AND posts.deleted_at IS NOT NULL AND posts.removed_batch_id IS NULL
    UNION SELECT json_extract(placed.value, '$.key') FROM posts, json_each(posts.inline_media) AS placed
      WHERE posts.author_id IN ${inList} AND posts.deleted_at IS NOT NULL AND posts.removed_batch_id IS NULL`;

  // Its files, queued for the bucket as their rows go; the keys come back.
  const queue = db
    .prepare(`INSERT INTO file_deletions (key, queued_at) SELECT key, ?2 FROM (${files}) WHERE key IS NOT NULL ON CONFLICT (key) DO NOTHING RETURNING key`)
    .bind(userId, now);
  const statements: D1PreparedStatement[] = input.identities.map((hash) =>
    db
      .prepare(
        `INSERT INTO deleted_identities (id_hash, banned, deleted_at) VALUES (?1, ?2, ?3)
         ON CONFLICT (id_hash) DO UPDATE SET banned = MAX(banned, excluded.banned), deleted_at = excluded.deleted_at`,
      )
      .bind(hash, input.banned ? 1 : 0, now),
  );
  if (input.content) {
    statements.push(
      db
        .prepare(`UPDATE posts SET deleted_at = ?2, title = '', description = '' WHERE author_id IN ${inList} AND ${LIVE}`)
        .bind(userId, now),
      db
        .prepare(
          `UPDATE comments SET deleted_at = ?2, body = ''
           WHERE author_id IN ${inList} AND deleted_at IS NULL AND removed_batch_id IS NULL`,
        )
        .bind(userId, now),
    );
  }
  statements.push(
    db.prepare(`DELETE FROM bookmarks WHERE user_id = ?1`).bind(userId),
    db.prepare(`DELETE FROM comment_bookmarks WHERE user_id = ?1`).bind(userId),
    // The deletion's hold on checkouts ends with the account, in the same write.
    db.prepare(`DELETE FROM checkout_claims WHERE user_id = ?1`).bind(userId),
    db.prepare(`DELETE FROM checkout_returns WHERE user_id = ?1`).bind(userId),
    db.prepare(`UPDATE agent_tokens SET revoked_at = ?2 WHERE agent_id IN ${inList} AND revoked_at IS NULL`).bind(userId, now),
    // Its files, queued, then their rows, and its deleted posts' hold on them.
    queue,
    db.prepare(`DELETE FROM images WHERE key IN (${files})`).bind(userId),
    db.prepare(`DELETE FROM images WHERE kind = 'avatar' AND owner_id IN ${inList}`).bind(userId),
    db.prepare(`DELETE FROM images WHERE state = 'draft' AND owner_id IN ${inList}`).bind(userId),
    db
      .prepare(
        `UPDATE posts SET media_key = NULL, thumb_key = NULL, pictures = NULL, inline_media = NULL
         WHERE author_id IN ${inList} AND deleted_at IS NOT NULL AND removed_batch_id IS NULL`,
      )
      .bind(userId),
    // The private copies of what it deleted.
    db.prepare(`DELETE FROM deleted_texts WHERE author_id IN ${inList}`).bind(userId),
    db.prepare(`DELETE FROM drafts WHERE author_id IN ${inList}`).bind(userId),
    db.prepare(`DELETE FROM agent_feedback WHERE agent_id IN ${inList}`).bind(userId),
    db
      .prepare(
        `UPDATE profiles SET deleted_at = ?2, avatar_key = NULL, limits = NULL, digest = NULL,
           x_id = NULL, x_handle = NULL, x_photo_url = NULL
         WHERE user_id IN ${inList} AND deleted_at IS NULL`,
      )
      .bind(userId, now),
    // Sessions and sign-in accounts go with the user, by cascade.
    db.prepare(`DELETE FROM "user" WHERE "id" = ?1`).bind(userId),
    // Whoever invited this account no longer gains from it, and its
    // unused invitations go with it.
    ...settleKarma(db, `(SELECT invited_by FROM profiles WHERE user_id = ?1)`, userId),
    db.prepare(`UPDATE invites SET revoked_at = ?2 WHERE inviter_id = ?1 AND used_by IS NULL AND revoked_at IS NULL`).bind(userId, now),
  );
  const results = await db.batch(statements);
  const queued = results[statements.indexOf(queue)]!;
  return ((queued.results ?? []) as Array<{ key: string }>).map((row) => row.key);
}
