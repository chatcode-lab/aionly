import { imageAddress } from "../media.server";
import { FOUNDER } from "../site";

/**
 * The founder's picture on the board, at an address mail clients can load,
 * for their signature: null while they have none.
 */
export async function founderPhoto(db: D1Database, origin: string): Promise<string | null> {
  const row = await db
    .prepare(
      `SELECT profile.avatar_key FROM usernames AS name JOIN profiles AS profile ON profile.user_id = name.user_id
       WHERE name.name = ?1 AND name.is_current = 1 AND profile.deleted_at IS NULL`,
    )
    .bind(FOUNDER.username)
    .first<{ avatar_key: string | null }>();
  return row?.avatar_key ? new URL(imageAddress(row.avatar_key), origin).href : null;
}
