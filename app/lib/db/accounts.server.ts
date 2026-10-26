import { AGENT_ALLOWANCE_USERNAME_MIN, generateUsername, SHORT_USERNAME_MIN, USERNAME_MIN, YEARLY_USERNAME_MIN } from "../accounts/usernames";
import type { Restriction } from "../public-types";
import { type CommentReplies, parsePostChoice, type PostChoice } from "../replies";
import { NEW_MENTIONS_MAX } from "../text/mentions";
import { DEFAULT_TEXT_SIZE, storedTextSize, type TextSize } from "../text-size";
import { DEFAULT_TINT, storedTint, type Tint } from "../tint";
import { paymentStatements } from "./payments.server";
import { settingSql } from "./setting-sql.server";

const DAY = 24 * 3600;

function nowSeconds(): number {
  return Math.floor(Date.now() / 1000);
}

/**
 * Gives an account its public profile and a generated name. Safe to call
 * again: an existing profile or current name is kept. A new member starts
 * with the digest they chose on the way in, kept with the account
 * (`"user"."signupDigest"`), or else the daily one (owner's requests,
 * 2026-10-21 and 2026-10-26), whether at sign-up or in a later repair
 * (review F135); each kind it brings is counted as sent, as turning it on
 * does, so the first comes with the next period.
 */
export async function createProfile(
  db: D1Database,
  userId: string,
  now = nowSeconds(),
): Promise<void> {
  await db
    .prepare(
      `INSERT INTO profiles (user_id, created_at, digest, daily_digest_at, weekly_digest_at, monthly_digest_at)
       VALUES (?1, ?2, COALESCE((SELECT "signupDigest" FROM "user" WHERE "id" = ?1), 'daily'), ?2, ?2, ?2)
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
  /**
   * The shortest name it may hold now: 4 for an admin and the board's own
   * agent, 4 with the Short username package, 5 with the yearly plan in
   * force, 5 for an agent whose owner has the package, else 6. See
   * shortestNameSql, which the write checks.
   */
  shortestName: number;
  /** The shortest name the Short username package, bought once, allows, or null. */
  nameAllowance: number | null;
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
  /** What its new posts start with for who may comment, set in Settings; each post may change it. */
  postReplies: PostChoice;
  /** The member's text size, for pages and emails (app/lib/text-size.ts). */
  textSize: TextSize;
  /** The fan's tint as chosen, in force while they have the plan (app/lib/tint.ts). */
  tint: Tint;
  /** Up to which place in the order mentions were committed in the member has seen theirs. */
  mentionsSeenSeq: number;
  /** Items mentioning the member or their agent since then, up to NEW_MENTIONS_MAX. */
  newMentions: number;
  /** Unpublished drafts: the account's own, and its agent's waiting for it (not declined at their current revision). */
  drafts: { own: number; fromAgent: number };
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
              profile.limits, profile.plan_until, profile.show_mark, profile.digest, profile.reply_policy, profile.post_replies, profile.text_size, profile.tint,
              profile.karma_floor, username.name, profile.mentions_seen_seq, profile.name_allowance,
              COALESCE(profile.karma_floor, ${settingSql("karma_floor")}) AS floor_in_force,
              -- Mentions of the member or their agent since they last looked, up to 99.
              (SELECT COUNT(*) FROM (
                 SELECT DISTINCT item_type, item_id FROM mentions
                 WHERE target_id IN (profile.user_id,
                         (SELECT agent.user_id FROM profiles AS agent WHERE agent.owner_id = profile.user_id AND agent.deleted_at IS NULL))
                   AND seq > profile.mentions_seen_seq
                 LIMIT ${NEW_MENTIONS_MAX})) AS new_mentions,
              -- Drafts waiting: the member's own, and their agent's not declined at their current revision (review F95).
              (SELECT COUNT(*) FROM drafts WHERE author_id = profile.user_id AND post_id IS NULL) AS own_drafts,
              (SELECT COUNT(*) FROM drafts
               WHERE author_id = (SELECT agent.user_id FROM profiles AS agent WHERE agent.owner_id = profile.user_id AND agent.deleted_at IS NULL)
                 AND post_id IS NULL AND (declined_revision IS NULL OR revision > declined_revision)) AS agent_drafts,
              -- A sign-up whose invitation, or partner, did not attach.
              (EXISTS (SELECT 1 FROM invites WHERE claimed_by = profile.user_id AND used_by IS NULL)
                OR (profile.invited_by IS NULL AND EXISTS (
                  SELECT 1 FROM partner_joins AS joined JOIN partner_links AS link ON link.code = joined.code
                  WHERE joined.user_id = profile.user_id AND link.partner_id <> profile.user_id))) AS invite_pending,
              owner.banned_at AS owner_banned_at, owner.banned_until AS owner_banned_until,
              owner.ban_reason AS owner_ban_reason, owner.role AS owner_role,
              owner.plan_until AS owner_plan_until, owner.name_allowance AS owner_name_allowance,
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
      post_replies: string | null;
      text_size: number | null;
      tint: string | null;
      karma_floor: number | null;
      name: string;
      mentions_seen_seq: number;
      name_allowance: number | null;
      new_mentions: number;
      own_drafts: number;
      agent_drafts: number;
      invite_pending: number;
      owner_banned_at: number | null;
      owner_banned_until: number | null;
      owner_ban_reason: string | null;
      owner_role: "user" | "admin" | null;
      owner_plan_until: number | null;
      owner_name_allowance: number | null;
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
    shortestName: exempt
      ? SHORT_USERNAME_MIN
      : row.owner_id
        ? row.owner_name_allowance !== null
          ? AGENT_ALLOWANCE_USERNAME_MIN
          : USERNAME_MIN
        : Math.min(row.name_allowance ?? USERNAME_MIN, fan && row.plan_interval === "year" ? YEARLY_USERNAME_MIN : USERNAME_MIN),
    nameAllowance: row.name_allowance,
    entitled,
    showMark: row.show_mark === 1,
    digest: row.digest,
    replyPolicy: row.reply_policy ?? "all",
    postReplies: parsePostChoice(row.post_replies) ?? "all",
    textSize: storedTextSize(row.text_size),
    tint: storedTint(row.tint),
    mentionsSeenSeq: row.mentions_seen_seq,
    newMentions: row.new_mentions,
    drafts: { own: row.own_drafts, fromAgent: row.agent_drafts },
    invitePending: row.invite_pending === 1,
  };
}

/** Saves a member's text size, for their pages and emails; the default is kept as null. */
export async function setTextSize(db: D1Database, userId: string, size: TextSize): Promise<void> {
  await db
    .prepare(`UPDATE profiles SET text_size = ?2 WHERE user_id = ?1`)
    .bind(userId, size === DEFAULT_TEXT_SIZE ? null : size)
    .run();
}

/** Chooses a member's tint; orange is stored as none. Anything else needs the plan, checked in the write. */
export async function setTint(db: D1Database, userId: string, tint: Tint, now: number): Promise<boolean> {
  const result = await db
    .prepare(`UPDATE profiles SET tint = ?2 WHERE user_id = ?1 AND owner_id IS NULL AND (?2 IS NULL OR ${entitledCondition(1, now)})`)
    .bind(userId, tint === DEFAULT_TINT ? null : tint)
    .run();
  return result.meta.changes > 0;
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
 * account's own earlier short name, one a plan's end took back before
 * short names stayed with their accounts (19 October 2026). Checked again
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
  // a plan's end took back while it still did, to be taken again.
  if (holder && name.length >= USERNAME_MIN) return { ok: false, reason: "taken" };

  const at = Math.floor(now);
  const short = name.length < USERNAME_MIN;
  // Names the board gave count toward neither the first free change nor
  // the wait.
  const due = `(
    (SELECT COUNT(*) FROM usernames WHERE user_id = ?1 AND given = 0) <= 1
    OR (SELECT MAX(created_at) FROM usernames WHERE user_id = ?1 AND given = 0) <= ${at} - ${settingSql("rename_interval_days")} * ${DAY}
  )`;
  // A short name needs what allows it as the write lands.
  const shortRule = short ? ` AND length(?2) >= ${shortestNameSql("?1", String(at))}` : "";
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
  const refused = async (): Promise<RenameResult> => {
    if (!short) return { ok: false, reason: "too_soon" };
    const allowed = await db.prepare(`SELECT ${shortestNameSql("?1", "?2")} AS shortest`).bind(userId, at).first<{ shortest: number | null }>();
    return name.length < (allowed?.shortest ?? USERNAME_MIN) ? { ok: false, reason: "plan" } : { ok: false, reason: "too_soon" };
  };
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
 * The statements that give an account `name` in place of its current one,
 * as the board does, not the member: when an admin takes a name away
 * (`release`: the name is freed for whoever it belongs to and no longer
 * leads to this account). The given name counts toward neither the free
 * first change nor the wait between changes.
 */
export function givenNameStatements(
  db: D1Database,
  input: { userId: string; now: number; name: string; release?: boolean },
): D1PreparedStatement[] {
  const which = `user_id = ?1 AND is_current = 1`;
  return [
    db
      .prepare(input.release ? `DELETE FROM usernames WHERE ${which}` : `UPDATE usernames SET is_current = 0 WHERE ${which}`)
      .bind(input.userId),
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
 * SQL for the shortest name the account `account` (SQL for its ID) may hold
 * at `now`: SHORT_USERNAME_MIN for an admin and the board's own agent (an
 * admin's); for any other agent, AGENT_ALLOWANCE_USERNAME_MIN while its
 * owner has the Short username package, else USERNAME_MIN; for a member,
 * the shorter of what the package allows, for good, and the yearly plan in
 * force allows. Null when there is no such account.
 */
export function shortestNameSql(account: string, now: string): string {
  return `(SELECT CASE
      WHEN member.role = 'admin' OR member_owner.role = 'admin' THEN ${SHORT_USERNAME_MIN}
      WHEN member.owner_id IS NOT NULL THEN
        CASE WHEN member_owner.name_allowance IS NOT NULL THEN ${AGENT_ALLOWANCE_USERNAME_MIN} ELSE ${USERNAME_MIN} END
      ELSE MIN(COALESCE(member.name_allowance, ${USERNAME_MIN}),
        CASE WHEN COALESCE(member.plan_until, 0) > ${now} AND ${YEARLY("member.user_id")} THEN ${YEARLY_USERNAME_MIN} ELSE ${USERNAME_MIN} END)
    END
    FROM profiles AS member LEFT JOIN profiles AS member_owner ON member_owner.user_id = member.owner_id
    WHERE member.user_id = ${account})`;
}

/**
 * Gives a member the short username they bought, for good, and records
 * the payment, in one batch: the shortest name it allows, never raising
 * one already shorter. Safe to repeat, as both the checkout's return and
 * Stripe's webhook apply it. `granted` is false when no member account
 * matches; `duplicate` when another checkout, paid or given with a code,
 * bought this tier already, so this one is a second payment for the same
 * name, to refund. The first checkout applied is kept as the tier's
 * (`name_allowances`), chosen inside the write, so the answer is the same
 * whatever order checkouts are applied in, and on every replay (review F81).
 */
export async function grantNameAllowance(
  db: D1Database,
  input: {
    userId: string;
    length: number;
    sessionId: string;
    cents: number;
    currency: string;
    paidAt: number;
    paymentIntent: string | null;
    /** The plan's first invoice, when bought with the plan. */
    invoiceId?: string | null;
  },
): Promise<{ granted: boolean; duplicate: boolean }> {
  const member = await db
    .prepare(`SELECT 1 FROM profiles WHERE user_id = ?1 AND owner_id IS NULL`)
    .bind(input.userId)
    .first();
  if (!member) return { granted: false, duplicate: false };
  const results = await db.batch([
    db
      .prepare(
        `INSERT INTO name_allowances (user_id, length, session_id, granted_at) VALUES (?1, ?2, ?3, ?4)
         ON CONFLICT (user_id, length) DO NOTHING`,
      )
      .bind(input.userId, input.length, input.sessionId, input.paidAt),
    db
      .prepare(
        `UPDATE profiles SET name_allowance = MIN(COALESCE(name_allowance, ?2), ?2)
         WHERE user_id = ?1 AND owner_id IS NULL`,
      )
      .bind(input.userId, input.length),
    ...paymentStatements(db, {
      id: input.sessionId,
      userId: input.userId,
      kind: "name",
      amountCents: input.cents,
      currency: input.currency,
      paidAt: input.paidAt,
      paymentIntent: input.paymentIntent,
      invoiceId: input.invoiceId ?? null,
    }),
    // The checkout the tier is kept for.
    db.prepare(`SELECT session_id FROM name_allowances WHERE user_id = ?1 AND length = ?2`).bind(input.userId, input.length),
  ]);
  const winner = (results.at(-1)!.results[0] as { session_id: string } | undefined)?.session_id;
  return { granted: true, duplicate: winner !== input.sessionId };
}
