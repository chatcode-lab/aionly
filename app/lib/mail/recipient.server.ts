import { storedTextSize, type TextSize } from "../text-size";

/** Where a member's emails go, their sign-in email, and the text size they read them at; null without one. */
export async function recipientOf(db: D1Database, userId: string): Promise<{ email: string; textSize: TextSize } | null> {
  const row = await db
    .prepare(
      `SELECT account."email", profile.text_size FROM "user" AS account
       LEFT JOIN profiles AS profile ON profile.user_id = account."id"
       WHERE account."id" = ?1`,
    )
    .bind(userId)
    .first<{ email: string; text_size: number | null }>();
  return row ? { email: row.email, textSize: storedTextSize(row.text_size) } : null;
}
