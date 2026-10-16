import { newId } from "../ids";
import type { PostCardData } from "../public-types";
import { withPlainMentions } from "./mentions.server";
import { AUTHOR_JOINS, POST_COLUMNS, type PostRow, toPublicPost } from "./rows.server";

/**
 * Guest editors: a member an admin names to lead the board for a term.
 * While it runs, the editor sets the term's focus in a note and picks
 * posts: each pick keeps an Editor's pick mark for good, and the latest is
 * pinned above the feed with the editor's note while the term runs. Picks
 * never change the feed's order, and editors do not moderate. Terms never
 * overlap, so there is one editor at a time at most.
 */

export { FOCUS_MAX, PICK_NOTE_MAX } from "../editors";

export interface EditorTerm {
  id: string;
  userId: string;
  username: string;
  startsAt: number;
  endsAt: number;
  focus: string | null;
}

/** The term `as` (an alias of editor_terms) runs at `now`, and its editor may edit (SQL). */
function runningSql(as: string, now: string): string {
  return `(${as}.starts_at <= ${now} AND ${as}.ends_at > ${now}
    AND EXISTS (SELECT 1 FROM profiles AS editor WHERE editor.user_id = ${as}.user_id AND editor.deleted_at IS NULL
                AND (editor.banned_at IS NULL OR (editor.banned_until IS NOT NULL AND editor.banned_until <= ${now}))))`;
}

const TERM_COLUMNS = `term.id, term.user_id, name.name AS username, term.starts_at, term.ends_at, term.focus`;
const TERM_JOIN = `JOIN usernames AS name ON name.user_id = term.user_id AND name.is_current = 1`;

type TermRow = { id: string; user_id: string; username: string; starts_at: number; ends_at: number; focus: string | null };

const toTerm = (row: TermRow): EditorTerm => ({
  id: row.id,
  userId: row.user_id,
  username: row.username,
  startsAt: row.starts_at,
  endsAt: row.ends_at,
  focus: row.focus,
});

/** The editor whose term runs now, or null. */
export async function currentEditor(db: D1Database, now: number): Promise<EditorTerm | null> {
  if (cached && now - cached.at < CACHE_SECONDS) return cached.term;
  const term = await runningTerm(db, now);
  cached = { term, at: now };
  return term;
}

/** Kept a few seconds per instance: every page asks, and terms change rarely. */
const CACHE_SECONDS = 15;
let cached: { term: EditorTerm | null; at: number } | null = null;

/** Forgets this instance's copy, after a change. */
export function forgetEditor(): void {
  cached = null;
}

async function runningTerm(db: D1Database, now: number): Promise<EditorTerm | null> {
  const row = await db
    .prepare(`SELECT ${TERM_COLUMNS} FROM editor_terms AS term ${TERM_JOIN} WHERE term.ends_at > ?1 AND ${runningSql("term", "?1")} LIMIT 1`)
    .bind(now)
    .first<TermRow>();
  return row ? toTerm(row) : null;
}

/** The editor's latest pick of the running term, pinned above the feed, with the term. */
export interface EditorPick {
  term: EditorTerm;
  post: PostCardData | null;
  note: string | null;
}

/**
 * What the feed shows of the editor: the running term, with its focus, and
 * its latest pick while that post is live. Null with no term running.
 */
export async function editorPick(db: D1Database, now: number): Promise<EditorPick | null> {
  const term = await runningTerm(db, now);
  if (!term) return null;
  const row = await db
    .prepare(
      `SELECT ${POST_COLUMNS}, pick.note AS pick_note
       FROM pins AS pin
       JOIN picks AS pick ON pick.post_id = pin.post_id AND pick.term_id = ?1
       JOIN posts AS post ON post.id = pin.post_id ${AUTHOR_JOINS("post")}
       WHERE pin.slot = 'pick' AND post.deleted_at IS NULL AND post.removed_batch_id IS NULL`,
    )
    .bind(term.id)
    .first<PostRow & { pick_note: string | null }>();
  if (!row) return { term, post: null, note: null };
  const { description: _description, ...card } = toPublicPost(row);
  const [post] = await withPlainMentions(db, [card], "excerpt");
  return { term, post: post!, note: row.pick_note };
}

export type PickResult = { ok: true } | { ok: false; reason: "not_editor" | "not_found" | "already" };

/**
 * Picks a live post, by the editor of the running term, with their note:
 * it is marked an Editor's pick and pinned above the feed, replacing the
 * last pick there. Picking it again changes the note.
 */
export async function pickPost(db: D1Database, input: { editorId: string; postId: string; note: string | null; now: number }): Promise<PickResult> {
  const term = await runningTerm(db, input.now);
  if (!term || term.userId !== input.editorId) return { ok: false, reason: "not_editor" };
  const live = `EXISTS (SELECT 1 FROM posts WHERE id = ?1 AND deleted_at IS NULL AND removed_batch_id IS NULL)`;
  const [picked] = await db.batch([
    db
      .prepare(
        `INSERT INTO picks (post_id, editor_id, term_id, note, picked_at) SELECT ?1, ?2, ?3, ?4, ?5 WHERE ${live}
         ON CONFLICT (post_id) DO UPDATE SET note = excluded.note, picked_at = excluded.picked_at
         WHERE picks.term_id = excluded.term_id`,
      )
      .bind(input.postId, input.editorId, term.id, input.note, input.now),
    db
      .prepare(
        `INSERT INTO pins (slot, post_id, note, pinned_by, pinned_at)
         SELECT 'pick', ?1, ?3, ?2, ?4 WHERE ${live} AND EXISTS (SELECT 1 FROM picks WHERE post_id = ?1 AND term_id = ?5)
         ON CONFLICT (slot) DO UPDATE SET post_id = excluded.post_id, note = excluded.note,
           pinned_by = excluded.pinned_by, pinned_at = excluded.pinned_at`,
      )
      .bind(input.postId, input.editorId, input.note, input.now, term.id),
  ]);
  if (picked!.meta.changes > 0) return { ok: true };
  // Picked in an earlier term: it keeps that editor's mark and note.
  const earlier = await db.prepare(`SELECT 1 FROM picks WHERE post_id = ?1`).bind(input.postId).first();
  return { ok: false, reason: earlier ? "already" : "not_found" };
}

/**
 * Takes back a pick of the running term, by its editor: the mark goes, and
 * if it was pinned, the editor's previous pick of the term takes its place.
 */
export async function unpickPost(db: D1Database, input: { editorId: string; postId: string; now: number }): Promise<PickResult> {
  const term = await runningTerm(db, input.now);
  if (!term || term.userId !== input.editorId) return { ok: false, reason: "not_editor" };
  const [removed] = await db.batch([
    db.prepare(`DELETE FROM picks WHERE post_id = ?1 AND term_id = ?2`).bind(input.postId, term.id),
    db
      .prepare(
        `UPDATE pins SET (post_id, note, pinned_at) = (
           SELECT pick.post_id, pick.note, pick.picked_at FROM picks AS pick WHERE pick.term_id = ?2 ORDER BY pick.picked_at DESC LIMIT 1)
         WHERE slot = 'pick' AND post_id = ?1 AND EXISTS (SELECT 1 FROM picks WHERE term_id = ?2)`,
      )
      .bind(input.postId, term.id),
    db
      .prepare(`DELETE FROM pins WHERE slot = 'pick' AND post_id = ?1 AND NOT EXISTS (SELECT 1 FROM picks WHERE post_id = ?1)`)
      .bind(input.postId),
  ]);
  return removed!.meta.changes > 0 ? { ok: true } : { ok: false, reason: "not_found" };
}

/** Sets the running term's focus, by its editor. */
export async function setFocus(db: D1Database, input: { editorId: string; focus: string | null; now: number }): Promise<boolean> {
  const updated = await db
    .prepare(`UPDATE editor_terms AS term SET focus = ?2 WHERE term.user_id = ?1 AND ${runningSql("term", "?3")}`)
    .bind(input.editorId, input.focus, input.now)
    .run();
  return updated.meta.changes > 0;
}

export type NameResult = { ok: true } | { ok: false; reason: "no_member" | "overlaps" };

/** Names a guest editor for a term, by an admin: never over another term. */
export async function nameEditor(
  db: D1Database,
  input: { username: string; startsAt: number; endsAt: number; actorId: string; now: number },
): Promise<NameResult> {
  const member = await db
    .prepare(
      `SELECT profile.user_id FROM usernames AS name JOIN profiles AS profile ON profile.user_id = name.user_id
       WHERE name.name = ?1 AND name.is_current = 1 AND profile.deleted_at IS NULL AND profile.owner_id IS NULL`,
    )
    .bind(input.username.trim().replace(/^@/, "").toLowerCase())
    .first<{ user_id: string }>();
  if (!member) return { ok: false, reason: "no_member" };
  const made = await db
    .prepare(
      `INSERT INTO editor_terms (id, user_id, starts_at, ends_at, created_by, created_at)
       SELECT ?1, ?2, ?3, ?4, ?5, ?6
       WHERE NOT EXISTS (SELECT 1 FROM editor_terms WHERE starts_at < ?4 AND ends_at > ?3)`,
    )
    .bind(newId(), member.user_id, input.startsAt, input.endsAt, input.actorId, input.now)
    .run();
  return made.meta.changes > 0 ? { ok: true } : { ok: false, reason: "overlaps" };
}

/**
 * Ends a term now, by an admin, or drops one that has not begun. Its picks
 * keep their marks; its pin leaves the feed with it.
 */
export async function endTerm(db: D1Database, input: { termId: string; now: number }): Promise<boolean> {
  const [dropped, ended] = await db.batch([
    db
      .prepare(`DELETE FROM editor_terms WHERE id = ?1 AND starts_at > ?2 AND NOT EXISTS (SELECT 1 FROM picks WHERE term_id = ?1)`)
      .bind(input.termId, input.now),
    // A term ended in its first second still runs that second.
    db
      .prepare(`UPDATE editor_terms SET ends_at = MAX(?2, starts_at + 1) WHERE id = ?1 AND starts_at <= ?2 AND ends_at > ?2`)
      .bind(input.termId, input.now),
  ]);
  return dropped!.meta.changes + ended!.meta.changes > 0;
}

/** Terms for admins: those to come, the running one, and the latest past, with how many picks each made. */
export async function editorTerms(db: D1Database): Promise<Array<EditorTerm & { picks: number }>> {
  const { results } = await db
    .prepare(
      `SELECT ${TERM_COLUMNS}, (SELECT COUNT(*) FROM picks WHERE picks.term_id = term.id) AS picks
       FROM editor_terms AS term ${TERM_JOIN}
       ORDER BY term.starts_at DESC LIMIT 50`,
    )
    .all<TermRow & { picks: number }>();
  return results.map((row) => ({ ...toTerm(row), picks: row.picks }));
}

/** A member's terms as guest editor, latest first, for their profile. */
export async function termsOf(db: D1Database, userId: string, now: number): Promise<Array<{ startsAt: number; endsAt: number }>> {
  const { results } = await db
    .prepare(`SELECT starts_at, ends_at FROM editor_terms WHERE user_id = ?1 AND starts_at <= ?2 ORDER BY starts_at DESC LIMIT 5`)
    .bind(userId, now)
    .all<{ starts_at: number; ends_at: number }>();
  return results.map((row) => ({ startsAt: row.starts_at, endsAt: row.ends_at }));
}

/** The running term's picks, latest first, for its editor. */
export async function picksOfTerm(db: D1Database, termId: string): Promise<Array<{ postId: string; title: string; note: string | null; pickedAt: number }>> {
  const { results } = await db
    .prepare(
      `SELECT pick.post_id, post.title, pick.note, pick.picked_at FROM picks AS pick JOIN posts AS post ON post.id = pick.post_id
       WHERE pick.term_id = ?1 ORDER BY pick.picked_at DESC LIMIT 100`,
    )
    .bind(termId)
    .all<{ post_id: string; title: string; note: string | null; picked_at: number }>();
  return results.map((row) => ({ postId: row.post_id, title: row.title, note: row.note, pickedAt: row.picked_at }));
}
