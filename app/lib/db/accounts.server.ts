import {
  generateUsername,
  RENAME_INTERVAL_DAYS,
} from "../accounts/usernames";

const DAY = 24 * 3600;

function nowSeconds(): number {
  return Math.floor(Date.now() / 1000);
}

/**
 * Gives an account its public profile and a generated name. Safe to call
 * again: an existing profile or current name is kept.
 */
export async function createProfile(
  db: D1Database,
  userId: string,
  now = nowSeconds(),
): Promise<void> {
  await db
    .prepare(
      `INSERT INTO profiles (user_id, created_at) VALUES (?1, ?2)
       ON CONFLICT (user_id) DO NOTHING`,
    )
    .bind(userId, now)
    .run();

  // A generated name can collide with a taken one; another draw almost
  // always succeeds.
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const result = await db
      .prepare(
        `INSERT INTO usernames (name, user_id, is_current, created_at)
         SELECT ?1, ?2, 1, ?3
         WHERE NOT EXISTS (
           SELECT 1 FROM usernames WHERE user_id = ?2 AND is_current = 1
         )
         ON CONFLICT DO NOTHING`,
      )
      .bind(generateUsername(), userId, now)
      .run();
    if (result.meta.changes > 0) return;

    const current = await db
      .prepare(`SELECT 1 FROM usernames WHERE user_id = ?1 AND is_current = 1`)
      .bind(userId)
      .first();
    if (current) return;
  }
  throw new Error("could not find a free username");
}

/** Per-account overrides an admin can set. */
export interface AccountLimits {
  /** Publications per rolling 24 hours, or null for no limit. */
  postsPerDay?: number | null;
}

/** Everything the server knows about the signed-in account's standing. */
export interface AccountRecord {
  id: string;
  username: string;
  karma: number;
  role: "user" | "admin";
  avatarKey: string | null;
  createdAt: number;
  /** Set while a ban is in force; a timed ban past its end is not one. */
  ban: { reason: string | null; until: number | null } | null;
  deleted: boolean;
  /** The member who runs this account, when it is an agent. */
  ownerId: string | null;
  limits: AccountLimits;
}

function parseLimits(raw: string | null): AccountLimits {
  if (!raw) return {};
  try {
    const value = JSON.parse(raw) as unknown;
    if (!value || typeof value !== "object") return {};
    const posts = (value as { postsPerDay?: unknown }).postsPerDay;
    return {
      postsPerDay:
        posts === null
          ? null
          : typeof posts === "number" && Number.isInteger(posts) && posts >= 0
            ? posts
            : undefined,
    };
  } catch {
    return {};
  }
}

/** The account behind a session, or null when it has no profile yet. */
export async function accountRecord(
  db: D1Database,
  userId: string,
  now = nowSeconds(),
): Promise<AccountRecord | null> {
  const row = await db
    .prepare(
      `SELECT profile.user_id, profile.karma, profile.role, profile.avatar_key,
              profile.created_at, profile.banned_at, profile.banned_until,
              profile.ban_reason, profile.deleted_at, profile.owner_id,
              profile.limits, username.name
       FROM profiles AS profile
       JOIN usernames AS username
         ON username.user_id = profile.user_id AND username.is_current = 1
       WHERE profile.user_id = ?1`,
    )
    .bind(userId)
    .first<{
      user_id: string;
      karma: number;
      role: "user" | "admin";
      avatar_key: string | null;
      created_at: number;
      banned_at: number | null;
      banned_until: number | null;
      ban_reason: string | null;
      deleted_at: number | null;
      owner_id: string | null;
      limits: string | null;
      name: string;
    }>();
  if (!row) return null;

  const banned =
    row.banned_at !== null &&
    (row.banned_until === null || row.banned_until > now);

  return {
    id: row.user_id,
    username: row.name,
    karma: row.karma,
    role: row.role,
    avatarKey: row.avatar_key,
    createdAt: row.created_at,
    ban: banned ? { reason: row.ban_reason, until: row.banned_until } : null,
    deleted: row.deleted_at !== null,
    ownerId: row.owner_id,
    limits: parseLimits(row.limits),
  };
}

/**
 * The SQL condition, for an account bound as `?{index}`, that holds only
 * while it may take part: not banned, not deleted. Participation writes
 * repeat it so a ban landing mid-request still wins.
 */
export function participantCondition(index: number, now: number): string {
  return `EXISTS (
    SELECT 1 FROM profiles AS participant
    WHERE participant.user_id = ?${index}
      AND participant.deleted_at IS NULL
      AND (participant.banned_at IS NULL
           OR (participant.banned_until IS NOT NULL
               AND participant.banned_until <= ${Math.floor(now)}))
  )`;
}

export interface RenameStatus {
  /** True until the first change, which can be made at once. */
  firstChange: boolean;
  /** When the next change is allowed, or null when it is allowed now. */
  nextChangeAt: number | null;
}

export async function renameStatus(
  db: D1Database,
  userId: string,
  now = nowSeconds(),
): Promise<RenameStatus> {
  const row = await db
    .prepare(
      `SELECT COUNT(*) AS names, MAX(created_at) AS latest
       FROM usernames WHERE user_id = ?1`,
    )
    .bind(userId)
    .first<{ names: number; latest: number | null }>();
  const names = row?.names ?? 0;
  if (names <= 1) return { firstChange: true, nextChangeAt: null };
  const next = (row?.latest ?? 0) + RENAME_INTERVAL_DAYS * DAY;
  return { firstChange: false, nextChangeAt: next > now ? next : null };
}

export type RenameResult =
  | { ok: true }
  | { ok: false; reason: "taken" | "too_soon" | "same" };

/**
 * Changes an account's name. The old name stays reserved and redirects. The
 * first change is allowed at once, later ones once per interval; the rule is
 * checked inside the write, so two quick changes cannot both pass.
 */
export async function renameUser(
  db: D1Database,
  userId: string,
  name: string,
  now = nowSeconds(),
): Promise<RenameResult> {
  const holder = await db
    .prepare(`SELECT user_id, is_current FROM usernames WHERE name = ?1`)
    .bind(name)
    .first<{ user_id: string; is_current: number }>();
  if (holder) {
    return {
      ok: false,
      reason: holder.user_id === userId && holder.is_current === 1 ? "same" : "taken",
    };
  }

  const earliest = now - RENAME_INTERVAL_DAYS * DAY;
  const allowed = `(
    (SELECT COUNT(*) FROM usernames WHERE user_id = ?1) <= 1
    OR (SELECT MAX(created_at) FROM usernames WHERE user_id = ?1) <= ?2
  )`;
  try {
    const [retired] = await db.batch([
      db
        .prepare(
          `UPDATE usernames SET is_current = 0
           WHERE user_id = ?1 AND is_current = 1 AND ${allowed}
             AND ${participantCondition(1, now)}`,
        )
        .bind(userId, earliest),
      // Inserts only when the old name was just retired; otherwise the
      // account would hold two current names, which the index refuses.
      db
        .prepare(
          `INSERT INTO usernames (name, user_id, is_current, created_at)
           SELECT ?2, ?1, 1, ?3
           WHERE NOT EXISTS (
             SELECT 1 FROM usernames WHERE user_id = ?1 AND is_current = 1
           )`,
        )
        .bind(userId, name, now),
    ]);
    if (retired.meta.changes === 0) return { ok: false, reason: "too_soon" };
    return { ok: true };
  } catch (error) {
    // Someone took the name between the check and the write.
    if (String(error).includes("UNIQUE")) return { ok: false, reason: "taken" };
    throw error;
  }
}
