import { newId } from "../ids";
import { DEFAULT_SETTINGS, isSettingKey, type SettingKey, type Settings, settingsProblems } from "../settings";
import { recountAllKarma } from "./votes.server";

export { settingSql } from "./setting-sql.server";

/** How long a page's copy of the settings is kept, per Worker instance. */
const CACHE_MS = 30_000;

// A copy of a board-wide table, not of any request's state: pages may show
// a value a few seconds old, while every write reads the one in force.
let cached: { values: Settings; at: number } | null = null;

/** Every setting in force now, read afresh: for the settings page and for saving. */
export async function settingsInForce(db: D1Database): Promise<Settings> {
  const { results } = await db.prepare(`SELECT key, value FROM settings`).all<{ key: string; value: number }>();
  const values = { ...DEFAULT_SETTINGS };
  for (const row of results) if (isSettingKey(row.key)) values[row.key] = row.value;
  return values;
}

/** Every setting in force, for pages and their words: a copy at most CACHE_MS old. */
export async function loadSettings(db: D1Database, now = Date.now()): Promise<Settings> {
  if (cached && now - cached.at < CACHE_MS) return cached.values;
  const values = await settingsInForce(db);
  cached = { values, at: now };
  return values;
}

/** Forgets this instance's copy, after a change. */
export function forgetSettings(): void {
  cached = null;
}

export type SettingsResult =
  | { ok: true; changed: SettingKey[] }
  | { ok: false; problems: Partial<Record<SettingKey, string>> }
  | { ok: false; reason: "not_allowed" };

/** Whether these settings' change moves stored karma or floors, which are recounted with it. */
const RECOUNTED: ReadonlySet<SettingKey> = new Set(["invite_share_percent", "karma_floor", "fresh_start_room"]);

/**
 * Changes settings, by an admin. The values in force with the change
 * applied are checked as a whole first (`settingsProblems`). One batch
 * writes the changed values, logs each (set_setting, "old → new"), and
 * recounts what is stored from them: everyone's karma, when the share of
 * invitees' karma changed, and fresh starts' floors, when it, the floor,
 * or the room changed. Every statement repeats that the actor is an admin.
 */
export async function saveSettings(
  db: D1Database,
  input: { actorId: string; values: Partial<Settings>; now: number },
): Promise<SettingsResult> {
  const current = await settingsInForce(db);
  const next = { ...current, ...input.values };
  const problems = settingsProblems(next);
  if (Object.keys(problems).length > 0) return { ok: false, problems };
  const changed = (Object.keys(input.values) as SettingKey[]).filter((key) => isSettingKey(key) && next[key] !== current[key]);
  if (changed.length === 0) return { ok: true, changed };

  const now = Math.floor(input.now);
  const admin = `EXISTS (SELECT 1 FROM profiles WHERE user_id = ?1 AND role = 'admin' AND deleted_at IS NULL
    AND (banned_at IS NULL OR (banned_until IS NOT NULL AND banned_until <= ${now})))`;
  const batchId = newId();
  const statements: D1PreparedStatement[] = [];
  for (const key of changed) {
    statements.push(
      db
        .prepare(
          `INSERT INTO settings (key, value, updated_at, updated_by) SELECT ?2, ?3, ?4, ?1 WHERE ${admin}
           ON CONFLICT (key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at, updated_by = excluded.updated_by`,
        )
        .bind(input.actorId, key, next[key], now),
      db
        .prepare(
          `INSERT INTO mod_actions (id, batch_id, actor_id, action, target_type, target_id, reason, created_at)
           SELECT ?2, ?3, ?1, 'set_setting', 'setting', ?4, ?5, ?6 WHERE ${admin}`,
        )
        .bind(input.actorId, newId(), batchId, key, `${current[key]} → ${next[key]}`, now),
    );
  }
  if (changed.some((key) => RECOUNTED.has(key))) {
    statements.push(...recountAllKarma(db, { karma: changed.includes("invite_share_percent") }));
  }
  const [first] = await db.batch(statements);
  forgetSettings();
  if (first!.meta.changes === 0) return { ok: false, reason: "not_allowed" };
  return { ok: true, changed };
}

/** A setting's changes, newest first, from the moderation log. */
export async function settingHistory(db: D1Database, limit = 30): Promise<Array<{ key: string; change: string; actor: string; at: number }>> {
  const { results } = await db
    .prepare(
      `SELECT action.target_id AS key, action.reason AS change, actor.name AS actor, action.created_at AS at
       FROM mod_actions AS action
       LEFT JOIN usernames AS actor ON actor.user_id = action.actor_id AND actor.is_current = 1
       WHERE action.action = 'set_setting'
       -- In the order written, several in one second included.
       ORDER BY action.rowid DESC LIMIT ?1`,
    )
    .bind(limit)
    .all<{ key: string; change: string; actor: string | null; at: number }>();
  return results.map((row) => ({ ...row, actor: row.actor ?? "[deleted]" }));
}
