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
 * index keeps one X account to one board account. `shown` sets whether
 * the profile shows it; left out, that stays as it was.
 */
export async function rememberXAccount(db: D1Database, userId: string, x: XProfile, options: { shown?: boolean } = {}): Promise<void> {
  await db
    .prepare(
      `UPDATE profiles SET x_id = ?2, x_handle = ?3, x_photo_url = ?4, x_shown = COALESCE(?5, x_shown)
       WHERE user_id = ?1 AND owner_id IS NULL`,
    )
    .bind(userId, x.id, x.handle, largerXPhoto(x.photoUrl), options.shown === undefined ? null : options.shown ? 1 : 0)
    .run();
}

/** Shows the member's linked X account on their profile and beside their name, or hides it. */
export async function setXShown(db: D1Database, userId: string, shown: boolean): Promise<void> {
  await db.prepare(`UPDATE profiles SET x_shown = ?2 WHERE user_id = ?1 AND x_id IS NOT NULL`).bind(userId, shown ? 1 : 0).run();
}

/**
 * Unlinks an account the member linked, X, while another way in (Google)
 * remains, so nobody is locked out; the profile forgets it too. Whether it
 * was unlinked.
 */
export async function unlinkMethod(db: D1Database, userId: string, provider: "google" | "twitter"): Promise<boolean> {
  const [unlinked] = await db.batch([
    db
      .prepare(
        `DELETE FROM "account" WHERE "userId" = ?1 AND "providerId" = ?2
           AND EXISTS (SELECT 1 FROM "account" AS other WHERE other."userId" = ?1 AND other."providerId" <> ?2)`,
      )
      .bind(userId, provider),
    db
      .prepare(
        `UPDATE profiles SET x_id = NULL, x_handle = NULL, x_photo_url = NULL, x_shown = 0
         WHERE user_id = ?1 AND ?2 = 'twitter'
           AND NOT EXISTS (SELECT 1 FROM "account" WHERE "userId" = ?1 AND "providerId" = 'twitter')`,
      )
      .bind(userId, provider),
  ]);
  return unlinked!.meta.changes > 0;
}

export interface LinkedX {
  id: string;
  handle: string;
  photoUrl: string | null;
  /** Shown on the profile and beside the name. */
  shown: boolean;
}

export async function linkedX(db: D1Database, userId: string): Promise<LinkedX | null> {
  const row = await db
    .prepare(`SELECT x_id, x_handle, x_photo_url, x_shown FROM profiles WHERE user_id = ?1 AND x_id IS NOT NULL`)
    .bind(userId)
    .first<{ x_id: string; x_handle: string; x_photo_url: string | null; x_shown: number }>();
  return row ? { id: row.x_id, handle: row.x_handle, photoUrl: row.x_photo_url, shown: row.x_shown === 1 } : null;
}
