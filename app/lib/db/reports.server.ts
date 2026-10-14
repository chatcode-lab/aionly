import { REPORTS_PER_DAY, type ReportReason, type ReportTarget } from "../reports";
import { postPath } from "../slug";
import { participantCondition } from "./accounts.server";

const DAY = 24 * 3600;

export type ReportResult =
  | { ok: true; existing: boolean }
  | { ok: false; reason: "not_found" | "own" | "limit" | "not_allowed" };

/** The reported thing as it is now: its author and the text to keep. */
async function targetOf(
  db: D1Database,
  type: ReportTarget,
  id: string,
): Promise<{ authorId: string; snapshot: string } | null> {
  if (type === "post") {
    const row = await db
      .prepare(
        `SELECT author_id, title, url, description FROM posts
         WHERE id = ?1 AND deleted_at IS NULL AND removed_batch_id IS NULL`,
      )
      .bind(id)
      .first<{ author_id: string; title: string; url: string | null; description: string }>();
    return row ? { authorId: row.author_id, snapshot: [row.title, row.url ?? "", "", row.description].join("\n") } : null;
  }
  if (type === "comment") {
    const row = await db
      .prepare(
        `SELECT author_id, body FROM comments
         WHERE id = ?1 AND deleted_at IS NULL AND removed_batch_id IS NULL`,
      )
      .bind(id)
      .first<{ author_id: string; body: string }>();
    return row ? { authorId: row.author_id, snapshot: row.body } : null;
  }
  const row = await db
    .prepare(
      `SELECT profile.user_id, name.name FROM profiles AS profile
       JOIN usernames AS name ON name.user_id = profile.user_id AND name.is_current = 1
       WHERE profile.user_id = ?1 AND profile.deleted_at IS NULL`,
    )
    .bind(id)
    .first<{ user_id: string; name: string }>();
  return row ? { authorId: row.user_id, snapshot: row.name } : null;
}

/**
 * Files a report, keeping a copy of the reported text as it is now. One
 * open report per reporter and target: reporting again returns the one
 * already open. Nobody reports themselves or their own content, a ban
 * refuses it inside the write, and there is a daily ceiling.
 */
export async function fileReport(
  db: D1Database,
  input: {
    id: string;
    reporterId: string;
    type: ReportTarget;
    targetId: string;
    reason: ReportReason;
    note: string | null;
    now: number;
  },
): Promise<ReportResult> {
  const target = await targetOf(db, input.type, input.targetId);
  if (!target) return { ok: false, reason: "not_found" };
  if (target.authorId === input.reporterId) return { ok: false, reason: "own" };

  const inserted = await db
    .prepare(
      `INSERT INTO reports (id, reporter_id, target_type, target_id, reason, note, snapshot, created_at)
       SELECT ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8
       WHERE ${participantCondition(2, input.now)}
         AND (SELECT COUNT(*) FROM reports WHERE reporter_id = ?2 AND created_at > ?8 - ${DAY}) < ${REPORTS_PER_DAY}
       ON CONFLICT (reporter_id, target_type, target_id) WHERE status = 'open' DO NOTHING`,
    )
    .bind(input.id, input.reporterId, input.type, input.targetId, input.reason, input.note, target.snapshot, input.now)
    .run();
  if (inserted.meta.changes > 0) return { ok: true, existing: false };

  const open = await db
    .prepare(
      `SELECT 1 FROM reports WHERE reporter_id = ?1 AND target_type = ?2 AND target_id = ?3 AND status = 'open'`,
    )
    .bind(input.reporterId, input.type, input.targetId)
    .first();
  if (open) return { ok: true, existing: true };
  const count = await db
    .prepare(`SELECT COUNT(*) AS n FROM reports WHERE reporter_id = ?1 AND created_at > ?2`)
    .bind(input.reporterId, input.now - DAY)
    .first<{ n: number }>();
  return { ok: false, reason: (count?.n ?? 0) >= REPORTS_PER_DAY ? "limit" : "not_allowed" };
}

/** How many reports wait in the queue, for the admin navigation. */
export async function openReportCount(db: D1Database): Promise<number> {
  const row = await db.prepare(`SELECT COUNT(*) AS n FROM reports WHERE status = 'open'`).first<{ n: number }>();
  return row?.n ?? 0;
}

/** One reported target in the queue, with everything said about it. */
export interface QueueItem {
  type: ReportTarget;
  id: string;
  count: number;
  reasons: Partial<Record<ReportReason, number>>;
  notes: string[];
  /** The reported text as it was at the latest report. */
  snapshot: string;
  lastAt: number;
  /** Where to see it, and whose it is. */
  link: string | null;
  author: { id: string; username: string } | null;
  /** The target now: still there, or already removed or deleted. */
  state: "live" | "removed" | "deleted";
}

/**
 * The open reports, one entry per target, most recently reported first.
 * Reports never act by themselves; an admin decides.
 */
export async function reportQueue(db: D1Database, limit = 100): Promise<QueueItem[]> {
  const { results } = await db
    .prepare(
      `SELECT target_type, target_id, COUNT(*) AS count, MAX(created_at) AS last_at,
         json_group_array(reason) AS reasons,
         json_group_array(note) AS notes,
         (SELECT snapshot FROM reports AS latest
          WHERE latest.target_type = report.target_type AND latest.target_id = report.target_id
            AND latest.status = 'open'
          ORDER BY latest.created_at DESC LIMIT 1) AS snapshot
       FROM reports AS report
       WHERE status = 'open'
       GROUP BY target_type, target_id
       ORDER BY last_at DESC
       LIMIT ?1`,
    )
    .bind(limit)
    .all<{ target_type: ReportTarget; target_id: string; count: number; last_at: number; reasons: string; notes: string; snapshot: string | null }>();
  if (results.length === 0) return [];

  const ids = (type: ReportTarget) => JSON.stringify(results.filter((row) => row.target_type === type).map((row) => row.target_id));
  const [posts, comments, users] = await db.batch([
    db
      .prepare(
        `SELECT post.id, post.title, post.author_id, name.name,
           CASE WHEN post.removed_batch_id IS NOT NULL THEN 'removed'
                WHEN post.deleted_at IS NOT NULL THEN 'deleted' ELSE 'live' END AS state
         FROM posts AS post
         LEFT JOIN usernames AS name ON name.user_id = post.author_id AND name.is_current = 1
         WHERE post.id IN (SELECT value FROM json_each(?1))`,
      )
      .bind(ids("post")),
    db
      .prepare(
        `SELECT comment.id, comment.post_id, post.title, comment.author_id, name.name,
           CASE WHEN comment.removed_batch_id IS NOT NULL THEN 'removed'
                WHEN comment.deleted_at IS NOT NULL THEN 'deleted' ELSE 'live' END AS state
         FROM comments AS comment
         JOIN posts AS post ON post.id = comment.post_id
         LEFT JOIN usernames AS name ON name.user_id = comment.author_id AND name.is_current = 1
         WHERE comment.id IN (SELECT value FROM json_each(?1))`,
      )
      .bind(ids("comment")),
    db
      .prepare(
        `SELECT profile.user_id AS id, name.name,
           CASE WHEN profile.deleted_at IS NOT NULL THEN 'deleted' ELSE 'live' END AS state
         FROM profiles AS profile
         LEFT JOIN usernames AS name ON name.user_id = profile.user_id AND name.is_current = 1
         WHERE profile.user_id IN (SELECT value FROM json_each(?1))`,
      )
      .bind(ids("user")),
  ]);
  type Row = { id: string; name: string | null; state: QueueItem["state"]; author_id?: string; title?: string; post_id?: string };
  const byId = new Map<string, Row>();
  for (const row of [...posts.results, ...comments.results, ...users.results] as Row[]) byId.set(row.id, row);

  return results.map((row) => {
    const target = byId.get(row.target_id);
    const reasons: QueueItem["reasons"] = {};
    for (const reason of JSON.parse(row.reasons) as ReportReason[]) reasons[reason] = (reasons[reason] ?? 0) + 1;
    const notes = (JSON.parse(row.notes) as Array<string | null>).filter((note): note is string => Boolean(note)).slice(0, 5);
    let link: string | null = null;
    let author: QueueItem["author"] = null;
    if (target) {
      if (row.target_type === "post") link = postPath({ id: target.id, title: target.title ?? "" });
      if (row.target_type === "comment") link = `${postPath({ id: target.post_id!, title: target.title ?? "" })}#c-${target.id}`;
      if (row.target_type === "user") link = target.name ? `/u/${target.name}` : null;
      const authorId = row.target_type === "user" ? target.id : target.author_id!;
      author = target.name ? { id: authorId, username: target.name } : null;
    }
    return {
      type: row.target_type,
      id: row.target_id,
      count: row.count,
      reasons,
      notes,
      snapshot: row.snapshot ?? "",
      lastAt: row.last_at,
      link,
      author,
      state: target?.state ?? "deleted",
    };
  });
}

/** Closes a target's open reports without acting on it. */
export async function dismissReports(
  db: D1Database,
  input: { type: ReportTarget; id: string; actorId: string; now: number },
): Promise<number> {
  const result = await db
    .prepare(
      `UPDATE reports SET status = 'resolved', resolved_at = ?4, resolved_by = ?3
       WHERE target_type = ?1 AND target_id = ?2 AND status = 'open'`,
    )
    .bind(input.type, input.id, input.actorId, input.now)
    .run();
  return result.meta.changes;
}
