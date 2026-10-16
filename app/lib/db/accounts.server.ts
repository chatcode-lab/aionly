import { generateUsername, USERNAME_MIN } from "../accounts/usernames";
import type { Restriction } from "../public-types";
import type { CommentReplies } from "../replies";
import { NEW_MENTIONS_MAX } from "../text/mentions";
import { settingSql } from "./setting-sql.server";

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
  /**
   * Set while the account is read-only: a ban in force (a timed ban past its
   * end is not one), or karma at or below the floor.
   */
  ban: Restriction | null;
  /** The karma at or below which the account is read-only. */
  karmaFloor: number;
  deleted: boolean;
  /** The member who runs this account, when it is an agent. */
  ownerId: string | null;
  limits: AccountLimits;
  /** The end of the account's own Fan plan, past or future, or null. */
  planUntil: number | null;
  /** The account's own plan is in force. */
  fan: boolean;
  /** Names of 4 or 5 characters are open to it: an admin, or a member with the yearly plan in force. */
  shortNames: boolean;
  /**
   * The account may use the plan's features: an admin, a fan, or the
   * agent of either. Admins need no plan.
   */
  entitled: boolean;
  /** A fan shows the fan mark beside their name. */
  showMark: boolean;
  /** How often the digest is sent, or null when it is off. */
  digest: "daily" | "weekly" | "monthly" | null;
  /** Who may reply to the account's comments, its choice while it has the plan. */
  replyPolicy: CommentReplies;
  /** Up to which place in the order mentions were committed in the member has seen theirs. */
  mentionsSeenSeq: number;
  /** Items mentioning the member or their agent since then, up to NEW_MENTIONS_MAX. */
  newMentions: number;
  /** An invitation claimed for this account at sign-up has yet to attach. */
  invitePending: boolean;
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
              profile.limits, profile.plan_until, profile.show_mark, profile.digest, profile.reply_policy,
              profile.karma_floor, username.name, profile.mentions_seen_seq,
              COALESCE(profile.karma_floor, ${settingSql("karma_floor")}) AS floor_in_force,
              -- Mentions of the member or their agent since they last looked, up to 99.
              (SELECT COUNT(*) FROM (
                 SELECT DISTINCT item_type, item_id FROM mentions
                 WHERE target_id IN (profile.user_id,
                         (SELECT agent.user_id FROM profiles AS agent WHERE agent.owner_id = profile.user_id AND agent.deleted_at IS NULL))
                   AND seq > profile.mentions_seen_seq
                 LIMIT ${NEW_MENTIONS_MAX})) AS new_mentions,
              -- A sign-up whose invitation did not attach.
              EXISTS (SELECT 1 FROM invites WHERE claimed_by = profile.user_id AND used_by IS NULL) AS invite_pending,
              owner.banned_at AS owner_banned_at, owner.banned_until AS owner_banned_until,
              owner.ban_reason AS owner_ban_reason, owner.role AS owner_role,
              owner.plan_until AS owner_plan_until,
              (SELECT interval FROM subscriptions WHERE user_id = profile.user_id) AS plan_interval
       FROM profiles AS profile
       JOIN usernames AS username
         ON username.user_id = profile.user_id AND username.is_current = 1
       LEFT JOIN profiles AS owner ON owner.user_id = profile.owner_id
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
      plan_until: number | null;
      show_mark: number;
      digest: "daily" | "weekly" | "monthly" | null;
      reply_policy: Exclude<CommentReplies, "all"> | null;
      karma_floor: number | null;
      name: string;
      mentions_seen_seq: number;
      new_mentions: number;
      invite_pending: number;
      owner_banned_at: number | null;
      owner_banned_until: number | null;
      owner_ban_reason: string | null;
      owner_role: "user" | "admin" | null;
      owner_plan_until: number | null;
      plan_interval: "month" | "year" | null;
      floor_in_force: number;
    }>();
  if (!row) return null;

  const inForce = (at: number | null, until: number | null) => at !== null && (until === null || until > now);
  // Admins and their agent are never held by karma.
  const exempt = row.role === "admin" || row.owner_role === "admin";
  const floor = row.floor_in_force;
  // An agent is read-only while the member who runs it is banned.
  const ban: Restriction | null = inForce(row.banned_at, row.banned_until)
    ? { kind: "ban", reason: row.ban_reason, until: row.banned_until }
    : inForce(row.owner_banned_at, row.owner_banned_until)
      ? { kind: "ban", reason: row.owner_ban_reason, until: row.owner_banned_until }
      : !exempt && row.karma <= floor
        ? { kind: "karma", reason: null, until: null, floor }
        : null;

  const fan = row.plan_until !== null && row.plan_until > now;
  // An agent has the plan its owner has.
  const entitled = row.owner_id
    ? row.owner_role === "admin" || (row.owner_plan_until !== null && row.owner_plan_until > now)
    : row.role === "admin" || fan;

  return {
    id: row.user_id,
    username: row.name,
    karma: row.karma,
    role: row.role,
    avatarKey: row.avatar_key,
    createdAt: row.created_at,
    ban,
    karmaFloor: floor,
    deleted: row.deleted_at !== null,
    ownerId: row.owner_id,
    limits: parseLimits(row.limits),
    planUntil: row.plan_until,
    fan,
    shortNames: !row.owner_id && (row.role === "admin" || (fan && row.plan_interval === "year")),
    entitled,
    showMark: row.show_mark === 1,
    digest: row.digest,
    replyPolicy: row.reply_policy ?? "all",
    mentionsSeenSeq: row.mentions_seen_seq,
    newMentions: row.new_mentions,
    invitePending: row.invite_pending === 1,
  };
}

/** Whether the account already has a sign-in of this provider linked. */
export async function linkedWith(db: D1Database, userId: string, providerId: string): Promise<boolean> {
  const row = await db
    .prepare(`SELECT 1 FROM "account" WHERE "userId" = ?1 AND "providerId" = ?2`)
    .bind(userId, providerId)
    .first();
  return row !== null;
}

/**
 * Marks the member's mentions up to `upTo`, a place in the order mentions
 * were committed in (see mentionsCommitted), as seen, so the new-mentions
 * mark clears; never moves back, nor past what has been committed.
 */
export async function markMentionsSeen(db: D1Database, userId: string, upTo: number): Promise<void> {
  await db
    .prepare(
      `UPDATE profiles SET mentions_seen_seq = MIN(?2, (SELECT value FROM counters WHERE name = 'mentions'))
       WHERE user_id = ?1 AND mentions_seen_seq < ?2`,
    )
    .bind(userId, Math.floor(upTo))
    .run();
}

/**
 * The SQL condition, for an account bound as `?{index}`, that holds only
 * while it may take part: not banned, not deleted, karma above its floor
 * (which an agent shares with its owner; admins and their agent are exempt),
 * and, for an agent, run by a member who is neither banned nor deleted and
 * has the plan (or is an admin).
 * Participation writes repeat it so a ban landing mid-request still wins.
 */
export function participantCondition(index: number, now: number): string {
  const free = (alias: string) => `(${alias}.banned_at IS NULL
           OR (${alias}.banned_until IS NOT NULL AND ${alias}.banned_until <= ${Math.floor(now)}))`;
  return `EXISTS (
    SELECT 1 FROM profiles AS participant
    LEFT JOIN profiles AS participant_owner ON participant_owner.user_id = participant.owner_id
    WHERE participant.user_id = ?${index}
      AND participant.deleted_at IS NULL
      AND ${free("participant")}
      AND (participant.owner_id IS NULL
           OR (participant_owner.deleted_at IS NULL AND ${free("participant_owner")}
               -- An agent takes part only while its owner's plan holds.
               AND (participant_owner.role = 'admin' OR COALESCE(participant_owner.plan_until, 0) > ${Math.floor(now)})))
      AND (participant.karma > COALESCE(participant.karma_floor, ${settingSql("karma_floor")})
           OR participant.role = 'admin' OR participant_owner.role = 'admin')
  )`;
}

/**
 * The SQL condition, for an account bound as `?{index}`, that holds while it
 * may use the Fan plan's features: an admin, a member whose plan is in
 * force, or the agent of either. Writes of those features repeat it.
 */
export function entitledCondition(index: number, now: number): string {
  const at = Math.floor(now);
  return `EXISTS (
    SELECT 1 FROM profiles AS member
    LEFT JOIN profiles AS member_owner ON member_owner.user_id = member.owner_id
    WHERE member.user_id = ?${index}
      AND CASE WHEN member.owner_id IS NULL
        THEN member.role = 'admin' OR member.plan_until > ${at}
        ELSE member_owner.role = 'admin' OR member_owner.plan_until > ${at}
      END
  )`;
}

export interface RenameStatus {
  /** True until the first change, which can be made at once. */
  firstChange: boolean;
  /** When the next change is allowed, or null when it is allowed now. */
  nextChangeAt: number | null;
  /**
   * The plan's one early change is what allows the next change now: the
   * wait is not over, and the member has the plan and has not used it.
   */
  planChange: boolean;
  /** The member has yet to use the plan's early change. */
  planChangeLeft: boolean;
}

export async function renameStatus(
  db: D1Database,
  userId: string,
  now = nowSeconds(),
): Promise<RenameStatus> {
  // A name the board gave, in place of a short one, is not the member's change.
  const row = await db
    .prepare(
      `SELECT COUNT(*) AS names, MAX(created_at) AS latest,
              (SELECT plan_rename_at IS NULL AND owner_id IS NULL FROM profiles WHERE user_id = ?1) AS left_,
              ${PLAN_IN_FORCE("?1", "?2")} AS plan, ${settingSql("rename_interval_days")} AS wait_days
       FROM usernames WHERE user_id = ?1 AND given = 0`,
    )
    .bind(userId, Math.floor(now))
    .first<{ names: number; latest: number | null; left_: number | null; plan: number; wait_days: number }>();
  const names = row?.names ?? 0;
  const planChangeLeft = row?.left_ === 1;
  if (names <= 1) return { firstChange: true, nextChangeAt: null, planChange: false, planChangeLeft };
  const next = (row?.latest ?? 0) + (row?.wait_days ?? 0) * DAY;
  if (next <= now) return { firstChange: false, nextChangeAt: null, planChange: false, planChangeLeft };
  const planChange = planChangeLeft && row?.plan === 1;
  return { firstChange: false, nextChangeAt: planChange ? null : next, planChange, planChangeLeft };
}

/** The member's own plan is in force, or they are an admin. */
const PLAN_IN_FORCE = (account: string, now: string) =>
  `EXISTS (SELECT 1 FROM profiles WHERE user_id = ${account} AND owner_id IS NULL
     AND (role = 'admin' OR COALESCE(plan_until, 0) > ${now}))`;

/**
 * Whether the account could take this name: nobody has it, or it is the
 * account's own earlier short name, which the plan returns. Checked again
 * when the name is written.
 */
export async function nameFreeFor(db: D1Database, name: string, userId: string): Promise<boolean> {
  const holder = await db
    .prepare(`SELECT user_id, is_current FROM usernames WHERE name = ?1`)
    .bind(name)
    .first<{ user_id: string; is_current: number }>();
  return !holder || (holder.user_id === userId && holder.is_current === 0 && name.length < USERNAME_MIN);
}

export type RenameResult =
  | { ok: true }
  | { ok: false; reason: "taken" | "too_soon" | "same" | "plan" };

/**
 * Changes an account's name. The old name stays reserved and redirects. The
 * first change is allowed at once, later ones once per interval, and the
 * plan gives one more change at once, ever; the rule is checked inside the
 * write, so two quick changes cannot both pass.
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
  if (holder && holder.user_id !== userId) return { ok: false, reason: "taken" };
  if (holder?.is_current === 1) return { ok: false, reason: "same" };
  // An account's own earlier names stay retired, except a short one, which
  // the plan's end took back and the plan returns.
  if (holder && name.length >= USERNAME_MIN) return { ok: false, reason: "taken" };

  const at = Math.floor(now);
  const short = name.length < USERNAME_MIN;
  // Names the board gave count toward neither the first free change nor
  // the wait.
  const due = `(
    (SELECT COUNT(*) FROM usernames WHERE user_id = ?1 AND given = 0) <= 1
    OR (SELECT MAX(created_at) FROM usernames WHERE user_id = ?1 AND given = 0) <= ${at} - ${settingSql("rename_interval_days")} * ${DAY}
  )`;
  // A short name needs the yearly plan as the write lands.
  const shortRule = short ? ` AND ${shortNameAllowed("?1", String(at))}` : "";
  // Otherwise the plan's early change, which the batch's first statement
  // marks used for this very name (?2), now.
  const allowed = `(${due} OR EXISTS (SELECT 1 FROM profiles WHERE user_id = ?1 AND plan_rename_at = ${at} AND plan_rename = ?2))${shortRule}`;
  const usePlanChange = db
    .prepare(
      `UPDATE profiles SET plan_rename_at = ?3, plan_rename = ?2
       WHERE user_id = ?1 AND plan_rename_at IS NULL AND NOT ${due} AND ${PLAN_IN_FORCE("?1", "?3")}${shortRule}
         AND ${participantCondition(1, now)}`,
    )
    .bind(userId, name, at);
  const refused = async (): Promise<RenameResult> =>
    short && !(await db.prepare(`SELECT ${shortNameAllowed("?1", "?2")} AS may`).bind(userId, now).first<{ may: number }>())?.may
      ? { ok: false, reason: "plan" }
      : { ok: false, reason: "too_soon" };
  if (holder) {
    // The account's own earlier short name: current again, dated now, as a change.
    const [, retired] = await db.batch([
      usePlanChange,
      db
        .prepare(
          `UPDATE usernames SET is_current = 0
           WHERE user_id = ?1 AND is_current = 1 AND ${allowed} AND ${participantCondition(1, now)}`,
        )
        .bind(userId, name),
      db
        .prepare(
          `UPDATE usernames SET is_current = 1, created_at = ?3, given = 0
           WHERE name = ?2 AND user_id = ?1 AND NOT EXISTS (SELECT 1 FROM usernames WHERE user_id = ?1 AND is_current = 1)`,
        )
        .bind(userId, name, now),
    ]);
    return retired!.meta.changes === 0 ? refused() : { ok: true };
  }
  try {
    const [, retired] = await db.batch([
      usePlanChange,
      db
        .prepare(
          `UPDATE usernames SET is_current = 0
           WHERE user_id = ?1 AND is_current = 1 AND ${allowed}
             AND ${participantCondition(1, now)}`,
        )
        .bind(userId, name),
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
    if (retired.meta.changes === 0) return refused();
    return { ok: true };
  } catch (error) {
    // Someone took the name between the check and the write.
    if (String(error).includes("UNIQUE")) return { ok: false, reason: "taken" };
    throw error;
  }
}

/**
 * Deletes sign-in states that expired unused, such as a Google sign-in
 * started and abandoned. Better Auth leaves them; the hourly sweep clears
 * them so starting sign-ins over and over cannot grow the table.
 */
export async function sweepExpiredVerifications(db: D1Database, now: Date): Promise<number> {
  const result = await db.prepare(`DELETE FROM "verification" WHERE "expiresAt" < ?1`).bind(now.toISOString()).run();
  return result.meta.changes;
}

/**
 * Gives an account a fresh generated name in place of its current one, as
 * the board does, not the member: when the plan behind a 4- or 5-character
 * name ends (`short`: only such a name is replaced, and it stays the
 * account's, to take back with the plan), or when an admin takes a name
 * away (`release`: the name is freed for whoever it belongs to and no
 * longer leads to this account). The given name counts toward neither the
 * free first change nor the wait between changes. The new name, or null
 * when there was nothing to replace.
 */
export async function giveName(
  db: D1Database,
  input: { userId: string; now: number; short?: boolean; release?: boolean },
): Promise<string | null> {
  return withGivenName(async (name) => {
    const [replaced] = await db.batch(givenNameStatements(db, { ...input, name }));
    return replaced!.meta.changes > 0 ? name : null;
  });
}

/**
 * Runs `write` with generated names until one is free: a write that finds
 * its name taken has undone itself, as a batch does, and draws again.
 */
export async function withGivenName<T>(write: (name: string) => Promise<T>): Promise<T> {
  for (let attempt = 0; attempt < 8; attempt += 1) {
    try {
      return await write(generateUsername());
    } catch (error) {
      if (!String(error).includes("UNIQUE")) throw error;
    }
  }
  throw new Error("could not find a free name");
}

/**
 * The statements that give an account `name` in place of its current one;
 * see giveName. The first acts only on a name still to replace: with
 * `short`, a 4- or 5-character name whose account has no plan in force
 * when the batch runs, so a renewal that lands first keeps it.
 */
export function givenNameStatements(
  db: D1Database,
  input: { userId: string; now: number; name: string; short?: boolean; release?: boolean },
): D1PreparedStatement[] {
  const which = `user_id = ?1 AND is_current = 1${
    input.short ? ` AND length(name) < ${USERNAME_MIN} AND NOT ${shortNameAllowed("?1", "?2")}` : ""
  }`;
  return [
    db
      .prepare(input.release ? `DELETE FROM usernames WHERE ${which}` : `UPDATE usernames SET is_current = 0 WHERE ${which}`)
      .bind(...(input.short ? [input.userId, input.now] : [input.userId])),
    // Only once the old name stepped aside, so the account never holds two.
    db
      .prepare(
        `INSERT INTO usernames (name, user_id, is_current, created_at, given)
         SELECT ?2, ?1, 1, ?3, 1 WHERE NOT EXISTS (SELECT 1 FROM usernames WHERE user_id = ?1 AND is_current = 1)`,
      )
      .bind(input.userId, input.name, input.now),
  ];
}

/** The account's plan is billed yearly. */
const YEARLY = (account: string) => `EXISTS (SELECT 1 FROM subscriptions WHERE user_id = ${account} AND interval = 'year')`;

/**
 * The SQL condition that the account `account` (SQL for its ID) may hold a
 * 4- or 5-character name at `now`: a member, never an agent, who is an
 * admin or has the yearly plan in force.
 */
export function shortNameAllowed(account: string, now: string): string {
  return `EXISTS (SELECT 1 FROM profiles WHERE user_id = ${account} AND owner_id IS NULL
    AND (role = 'admin' OR (COALESCE(plan_until, 0) > ${now} AND ${YEARLY(account)})))`;
}

/**
 * Takes back 4- and 5-character names whose yearly plan has ended or
 * turned monthly, a batch a run:
 * the account gets a longer name, and its short one waits for the plan.
 * Agents never hold one. Returns how many changed.
 */
export async function revokeShortNames(db: D1Database, now: number, limit = 100): Promise<number> {
  const { results } = await db
    .prepare(
      `SELECT name.user_id FROM usernames AS name
       JOIN profiles AS profile ON profile.user_id = name.user_id
       WHERE name.is_current = 1 AND length(name.name) < 6 AND profile.deleted_at IS NULL
         AND (profile.owner_id IS NOT NULL OR (profile.role <> 'admin'
           AND (COALESCE(profile.plan_until, 0) <= ?1 OR NOT ${YEARLY("profile.user_id")})))
       LIMIT ?2`,
    )
    .bind(now, limit)
    .all<{ user_id: string }>();
  let changed = 0;
  for (const { user_id: userId } of results) {
    if (await giveName(db, { userId, now, short: true })) changed += 1;
  }
  return changed;
}
