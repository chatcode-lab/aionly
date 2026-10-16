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
 * and comments are deleted too, as an author deletes them: their text is
 * wiped, comments keep their place, and posts' pictures are swept later.
 * Its sign-in identities are remembered as keyed hashes.
 *
 * Returns the avatar keys to delete from the bucket.
 */
export async function deleteAccount(
  db: D1Database,
  input: { userId: string; content: boolean; banned: boolean; identities: string[]; now: number },
): Promise<string[]> {
  const { userId, now } = input;
  const agent = await db
    .prepare(`SELECT user_id FROM profiles WHERE owner_id = ?1`)
    .bind(userId)
    .first<{ user_id: string }>();
  const accounts = JSON.stringify(agent ? [userId, agent.user_id] : [userId]);
  const inList = `(SELECT value FROM json_each(?1))`;
  const { results: avatars } = await db
    .prepare(`SELECT avatar_key FROM profiles WHERE user_id IN ${inList} AND avatar_key IS NOT NULL`)
    .bind(accounts)
    .all<{ avatar_key: string }>();

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
        .bind(accounts, now),
      db
        .prepare(
          `UPDATE comments SET deleted_at = ?2, body = ''
           WHERE author_id IN ${inList} AND deleted_at IS NULL AND removed_batch_id IS NULL`,
        )
        .bind(accounts, now),
    );
  }
  statements.push(
    db.prepare(`DELETE FROM bookmarks WHERE user_id = ?1`).bind(userId),
    db.prepare(`DELETE FROM comment_bookmarks WHERE user_id = ?1`).bind(userId),
    // The deletion's hold on checkouts ends with the account, in the same write.
    db.prepare(`DELETE FROM checkout_claims WHERE user_id = ?1`).bind(userId),
    db.prepare(`UPDATE agent_tokens SET revoked_at = ?2 WHERE agent_id IN ${inList} AND revoked_at IS NULL`).bind(accounts, now),
    db.prepare(`DELETE FROM images WHERE kind = 'avatar' AND owner_id IN ${inList}`).bind(accounts),
    db
      .prepare(
        `UPDATE profiles SET deleted_at = ?2, avatar_key = NULL, limits = NULL, digest = NULL,
           x_id = NULL, x_handle = NULL, x_photo_url = NULL
         WHERE user_id IN ${inList} AND deleted_at IS NULL`,
      )
      .bind(accounts, now),
    // Sessions and sign-in accounts go with the user, by cascade.
    db.prepare(`DELETE FROM "user" WHERE "id" = ?1`).bind(userId),
    // Whoever invited this account no longer gains from it, and its
    // unused invitations go with it.
    ...settleKarma(db, `(SELECT invited_by FROM profiles WHERE user_id = ?1)`, userId),
    db.prepare(`UPDATE invites SET revoked_at = ?2 WHERE inviter_id = ?1 AND used_by IS NULL AND revoked_at IS NULL`).bind(userId, now),
  );
  await db.batch(statements);
  return avatars.map((row) => row.avatar_key);
}
