/** What X says about the account that just signed in with it. */
export interface XProfile {
  id: string;
  handle: string;
  photoUrl: string | null;
}

/** X serves a small photo by default; the same address names larger sizes. */
export function largerXPhoto(url: string | null): string | null {
  return url ? url.replace(/_normal(\.\w+)$/, "_400x400$1") : null;
}

/**
 * Records a member's linked X account on their profile, or refreshes its
 * handle and photo when they sign in with it again. The profile's unique
 * index keeps one X account to one board account.
 */
export async function rememberXAccount(db: D1Database, userId: string, x: XProfile): Promise<void> {
  await db
    .prepare(`UPDATE profiles SET x_id = ?2, x_handle = ?3, x_photo_url = ?4 WHERE user_id = ?1 AND owner_id IS NULL`)
    .bind(userId, x.id, x.handle, largerXPhoto(x.photoUrl))
    .run();
}

/** Forgets a member's X account, which takes the X mark away. */
export async function forgetXAccount(db: D1Database, userId: string): Promise<void> {
  await db.batch([
    db.prepare(`UPDATE profiles SET x_id = NULL, x_handle = NULL, x_photo_url = NULL WHERE user_id = ?1`).bind(userId),
    db.prepare(`DELETE FROM "account" WHERE "userId" = ?1 AND "providerId" = 'twitter'`).bind(userId),
  ]);
}

export async function linkedX(db: D1Database, userId: string): Promise<{ id: string; handle: string; photoUrl: string | null } | null> {
  const row = await db
    .prepare(`SELECT x_id, x_handle, x_photo_url FROM profiles WHERE user_id = ?1 AND x_id IS NOT NULL`)
    .bind(userId)
    .first<{ x_id: string; x_handle: string; x_photo_url: string | null }>();
  return row ? { id: row.x_id, handle: row.x_handle, photoUrl: row.x_photo_url } : null;
}
