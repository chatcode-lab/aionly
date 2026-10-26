import { newId } from "../ids";
import type { PostCardData } from "../public-types";
import { withPlainMentions } from "./mentions.server";
import { AUTHOR_JOINS, POST_COLUMNS, type PostRow, toPublicCard } from "./rows.server";

/** The announcement pinned above the feed, while its post is live. */
export interface Pin {
  post: PostCardData;
  note: string | null;
  pinnedAt: number;
}

export const PIN_NOTE_MAX = 140;

export async function announcement(db: D1Database): Promise<Pin | null> {
  const row = await db
    .prepare(
      `SELECT ${POST_COLUMNS}, pin.note AS pin_note, pin.pinned_at
       FROM pins AS pin
       JOIN posts AS post ON post.id = pin.post_id ${AUTHOR_JOINS("post")}
       WHERE pin.slot = 'announcement'
         AND post.deleted_at IS NULL AND post.removed_batch_id IS NULL`,
    )
    .first<PostRow & { pin_note: string | null; pinned_at: number }>();
  if (!row) return null;
  const [post] = await withPlainMentions(db, [toPublicCard(row)], "excerpt");
  return { post: post!, note: row.pin_note, pinnedAt: row.pinned_at };
}

/** Pins a live post as the announcement, replacing any earlier one. */
export async function pinAnnouncement(
  db: D1Database,
  input: { postId: string; actorId: string; note: string | null; now: number },
): Promise<boolean> {
  const [pinned] = await db.batch([
    db
      .prepare(
        `INSERT INTO pins (slot, post_id, note, pinned_by, pinned_at)
         SELECT 'announcement', ?1, ?2, ?3, ?4
         WHERE EXISTS (SELECT 1 FROM posts WHERE id = ?1 AND deleted_at IS NULL AND removed_batch_id IS NULL)
         ON CONFLICT (slot) DO UPDATE SET post_id = excluded.post_id, note = excluded.note,
           pinned_by = excluded.pinned_by, pinned_at = excluded.pinned_at`,
      )
      .bind(input.postId, input.note, input.actorId, input.now),
    db
      .prepare(
        `INSERT INTO mod_actions (id, batch_id, actor_id, action, target_type, target_id, reason, created_at)
         SELECT ?1, ?2, ?3, 'pin', 'post', ?4, ?5, ?6
         WHERE EXISTS (SELECT 1 FROM pins WHERE slot = 'announcement' AND post_id = ?4 AND pinned_at = ?6)`,
      )
      .bind(newId(), newId(), input.actorId, input.postId, input.note, input.now),
  ]);
  return pinned.meta.changes > 0;
}

export async function unpinAnnouncement(db: D1Database, input: { actorId: string; now: number }): Promise<boolean> {
  const current = await db.prepare(`SELECT post_id FROM pins WHERE slot = 'announcement'`).first<{ post_id: string }>();
  if (!current) return false;
  await db.batch([
    db.prepare(`DELETE FROM pins WHERE slot = 'announcement'`),
    db
      .prepare(
        `INSERT INTO mod_actions (id, batch_id, actor_id, action, target_type, target_id, reason, created_at)
         VALUES (?1, ?2, ?3, 'unpin', 'post', ?4, NULL, ?5)`,
      )
      .bind(newId(), newId(), input.actorId, current.post_id, input.now),
  ]);
  return true;
}
