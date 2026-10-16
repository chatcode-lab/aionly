import { participantCondition } from "./accounts.server";

/** What X says about the account that just signed in with it. */
export interface XProfile {
  id: string;
  handle: string;
  photoUrl: string | null;
}

/** X serves a small photo by default; the same address names larger sizes. */
export function largerXPhoto(url: string | null): string | null {
  // X's own picture for an account without a photo is no one's photo.
  if (!url || url.includes("/default_profile_images/")) return null;
  return url.replace(/_normal(\.\w+)$/, "_400x400$1");
}

/**
 * Records a member's linked X account on their profile, from the sign-in
 * record (`credential`) that linking it made. The profile's unique index
 * keeps one X account to one board account. `shown` sets whether the
 * profile shows it; left out, that stays as it was.
 */
export async function rememberXAccount(
  db: D1Database,
  credential: { id: string; userId: string },
  x: XProfile,
  options: { shown?: boolean; now?: number } = {},
): Promise<void> {
  const now = Math.floor(options.now ?? Date.now() / 1000);
  await db
    .prepare(
      `UPDATE profiles SET x_id = ?2, x_handle = ?3, x_photo_url = ?4, x_shown = COALESCE(?5, x_shown)
       WHERE user_id = ?1 AND owner_id IS NULL
         -- Only while the very sign-in record this link made remains, for
         -- this X account: an unlink, or a later link, even of the same X
         -- account, that landed first wins over a late write.
         AND EXISTS (SELECT 1 FROM "account" WHERE "id" = ?6 AND "userId" = ?1 AND "providerId" = 'twitter' AND "accountId" = ?2)
         -- And while the member may take part and has the plan, as linking needs.
         AND ${participantCondition(1, now)}
         AND (role = 'admin' OR COALESCE(plan_until, 0) > ${now})`,
    )
    .bind(credential.userId, x.id, x.handle, largerXPhoto(x.photoUrl), options.shown === undefined ? null : options.shown ? 1 : 0, credential.id)
    .run();
}

/** Forgets X details a profile still holds without the linked account they came from. */
export async function clearStaleX(db: D1Database, userId: string): Promise<void> {
  await db
    .prepare(
      `UPDATE profiles SET x_id = NULL, x_handle = NULL, x_photo_url = NULL, x_shown = 0
       WHERE user_id = ?1 AND x_id IS NOT NULL
         AND NOT EXISTS (SELECT 1 FROM "account" WHERE "userId" = ?1 AND "providerId" = 'twitter' AND "accountId" = profiles.x_id)`,
    )
    .bind(userId)
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
  /** Null when the link landed but X's details for the profile did not. */
  handle: string | null;
  photoUrl: string | null;
  /** Shown on the profile and beside the name. */
  shown: boolean;
}

/**
 * The member's linked X account, by its sign-in record, which is what
 * linking writes first and unlinking removes; the profile's copy of the
 * handle and photo comes with it when it was written.
 */
export async function linkedX(db: D1Database, userId: string): Promise<LinkedX | null> {
  const row = await db
    .prepare(
      `SELECT account."accountId" AS account_id, profile.x_id, profile.x_handle, profile.x_photo_url, profile.x_shown
       FROM "account" AS account LEFT JOIN profiles AS profile ON profile.user_id = account."userId"
       WHERE account."userId" = ?1 AND account."providerId" = 'twitter'`,
    )
    .bind(userId)
    .first<{ account_id: string; x_id: string | null; x_handle: string | null; x_photo_url: string | null; x_shown: number | null }>();
  if (!row) return null;
  const details = row.x_id === row.account_id;
  return {
    id: row.account_id,
    handle: details ? row.x_handle : null,
    photoUrl: details ? row.x_photo_url : null,
    shown: details && row.x_shown === 1,
  };
}
