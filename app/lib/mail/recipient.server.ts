import { storedTextSize } from "../text-size";
import { storedTint } from "../tint";
import type { Reader } from "./layout";

/**
 * SQL for the columns that say how the member `{profile}` reads emails: the
 * text size, and the tint while the plan is in force at `now`, as
 * `text_size` and `tint`.
 */
export function readerColumns(profile: string, now: number): string {
  return `${profile}.text_size, CASE WHEN ${profile}.role = 'admin' OR ${profile}.plan_until > ${Math.floor(now)} THEN ${profile}.tint END AS tint`;
}

/** A row's reader, from the columns `readerColumns` names. */
export function readerOf(row: { text_size: number | null; tint: string | null }): Reader {
  return { textSize: storedTextSize(row.text_size), tint: storedTint(row.tint) };
}

/** Where a member's emails go, their sign-in email, and how they read them; null without one. */
export async function recipientOf(db: D1Database, userId: string, now: number): Promise<({ email: string } & Reader) | null> {
  const row = await db
    .prepare(
      `SELECT account."email", ${readerColumns("profile", now)} FROM "user" AS account
       LEFT JOIN profiles AS profile ON profile.user_id = account."id"
       WHERE account."id" = ?1`,
    )
    .bind(userId)
    .first<{ email: string; text_size: number | null; tint: string | null }>();
  return row ? { email: row.email, ...readerOf(row) } : null;
}
