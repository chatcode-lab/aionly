import { newId } from "../ids";
import { INVITE_DAYS, type InviteRefusal, OPEN_INVITES } from "../invites";
import type { PublicAuthor } from "../public-types";
import { KARMA_FLOOR } from "../moderation";
import { AUTHOR_COLUMNS, AUTHOR_JOINS, toPublicAuthor } from "./rows.server";
import { settleKarma } from "./votes.server";

const DAY = 24 * 3600;

/**
 * The SQL condition that the account `account` (SQL for its ID) may invite
 * at `now`: a member, never an agent, with no ban in force and above the
 * karma floor; with karma of 0 or more; and with fewer than half of those
 * they invited below 0 karma or banned. Admins need only be free of a ban.
 * An invitation works only while its inviter may invite, so this is checked
 * again when it is used.
 */
export function mayInviteSql(account: string, now: number): string {
  const at = Math.floor(now);
  const banned = (alias: string) =>
    `(${alias}.banned_at IS NOT NULL AND (${alias}.banned_until IS NULL OR ${alias}.banned_until > ${at}))`;
  const invitees = `FROM profiles AS invitee WHERE invitee.invited_by = inviter.user_id AND invitee.deleted_at IS NULL`;
  return `EXISTS (
    SELECT 1 FROM profiles AS inviter
    WHERE inviter.user_id = ${account} AND inviter.owner_id IS NULL AND inviter.deleted_at IS NULL
      AND NOT ${banned("inviter")}
      AND (inviter.role = 'admin' OR (
        inviter.karma > COALESCE(inviter.karma_floor, ${KARMA_FLOOR}) AND inviter.karma >= 0
        AND 2 * (SELECT COUNT(*) ${invitees} AND (invitee.vote_karma < 0 OR ${banned("invitee")}))
          < MAX(1, (SELECT COUNT(*) ${invitees})))))`;
}

export interface InviteStanding {
  /** Null when the member may invite now. */
  refusal: InviteRefusal | null;
  /** Unused invitations still open. */
  open: Array<{ code: string; createdAt: number; expiresAt: number }>;
  /** Everyone who joined through the member's invitations, newest first. */
  invited: PublicAuthor[];
  admin: boolean;
}

/** Where a member stands with invitations, for Settings. */
export async function inviteStanding(db: D1Database, userId: string, now: number): Promise<InviteStanding> {
  const [account, open, invited] = await db.batch([
    db
      .prepare(
        `SELECT profile.owner_id, profile.role, profile.karma, ${mayInviteSql("?1", now)} AS may,
                (profile.banned_at IS NULL OR profile.banned_until <= ?2)
                  AND (profile.role = 'admin' OR profile.karma > COALESCE(profile.karma_floor, ${KARMA_FLOOR})) AS participant
         FROM profiles AS profile WHERE profile.user_id = ?1`,
      )
      .bind(userId, now),
    db
      .prepare(
        `SELECT code, created_at, expires_at FROM invites
         WHERE inviter_id = ?1 AND used_by IS NULL AND claimed_at IS NULL AND revoked_at IS NULL AND expires_at > ?2
         ORDER BY created_at DESC`,
      )
      .bind(userId, now),
    db
      .prepare(
        `SELECT ${AUTHOR_COLUMNS}
         FROM (SELECT user_id AS author_id, created_at FROM profiles WHERE invited_by = ?1 AND deleted_at IS NULL) AS invitee
         ${AUTHOR_JOINS("invitee")}
         ORDER BY invitee.created_at DESC LIMIT 200`,
      )
      .bind(userId),
  ]);
  const row = account!.results[0] as
    | { owner_id: string | null; role: string; karma: number; may: number; participant: number }
    | undefined;
  const openRows = open!.results as Array<{ code: string; created_at: number; expires_at: number }>;
  const admin = row?.role === "admin";
  let refusal: InviteRefusal | null = null;
  if (!row || row.owner_id) refusal = "agent";
  else if (!row.participant) refusal = "read_only";
  else if (!row.may) refusal = row.karma < 0 ? "karma" : "invitees";
  else if (!admin && openRows.length >= OPEN_INVITES) refusal = "limit";
  return {
    refusal,
    open: openRows.map((invite) => ({ code: invite.code, createdAt: invite.created_at, expiresAt: invite.expires_at })),
    invited: (invited!.results as Array<Parameters<typeof toPublicAuthor>[0]>).map(toPublicAuthor),
    admin,
  };
}

/**
 * Makes an invitation, inside the write: only while the member may invite
 * and holds fewer than the open limit (admins have none). Its code, or null.
 */
export async function createInvite(db: D1Database, input: { inviterId: string; now: number }): Promise<string | null> {
  const code = newId(16);
  const made = await db
    .prepare(
      `INSERT INTO invites (code, inviter_id, created_at, expires_at)
       SELECT ?1, ?2, ?3, ?4
       WHERE ${mayInviteSql("?2", input.now)}
         AND (EXISTS (SELECT 1 FROM profiles WHERE user_id = ?2 AND role = 'admin')
           OR (SELECT COUNT(*) FROM invites WHERE inviter_id = ?2 AND used_by IS NULL AND claimed_at IS NULL
                 AND revoked_at IS NULL AND expires_at > ?3) < ${OPEN_INVITES})`,
    )
    .bind(code, input.inviterId, input.now, input.now + INVITE_DAYS * DAY)
    .run();
  return made.meta.changes > 0 ? code : null;
}

/** Cancels one of the member's unused invitations. */
export async function revokeInvite(db: D1Database, input: { inviterId: string; code: string; now: number }): Promise<boolean> {
  const revoked = await db
    .prepare(
      `UPDATE invites SET revoked_at = ?3
       WHERE code = ?1 AND inviter_id = ?2 AND used_by IS NULL AND claimed_at IS NULL AND revoked_at IS NULL`,
    )
    .bind(input.code, input.inviterId, input.now)
    .run();
  return revoked.meta.changes > 0;
}

export type InviteState = "open" | "used" | "expired" | "revoked" | "paused";

/** An invitation as its link's page shows it, or null when there is none. */
export async function inviteByCode(
  db: D1Database,
  code: string,
  now: number,
): Promise<{ state: InviteState; inviter: PublicAuthor } | null> {
  const row = await db
    .prepare(
      `SELECT invite.expires_at, invite.used_by, invite.claimed_at, invite.revoked_at,
              ${mayInviteSql("invite.author_id", now)} AS may, ${AUTHOR_COLUMNS}
       FROM (SELECT *, inviter_id AS author_id FROM invites WHERE code = ?1) AS invite
       ${AUTHOR_JOINS("invite")}`,
    )
    .bind(code)
    .first<Parameters<typeof toPublicAuthor>[0] & {
      expires_at: number;
      used_by: string | null;
      claimed_at: number | null;
      revoked_at: number | null;
      may: number;
    }>();
  if (!row) return null;
  const state: InviteState =
    row.used_by !== null || row.claimed_at !== null
      ? "used"
      : row.revoked_at !== null
        ? "revoked"
        : row.expires_at <= now
          ? "expired"
          : row.may
            ? "open"
            : "paused";
  return { state, inviter: toPublicAuthor(row) };
}

/**
 * Claims an invitation for a Google sign-up, before its account exists:
 * the code must be open and its inviter still able to invite, all inside
 * the write, so one invitation makes one account.
 */
export async function claimInvite(db: D1Database, input: { code: string; email: string; now: number }): Promise<boolean> {
  const claimed = await db
    .prepare(
      `UPDATE invites SET claimed_email = lower(?2), claimed_at = ?3
       WHERE code = ?1 AND used_by IS NULL AND claimed_at IS NULL AND revoked_at IS NULL AND expires_at > ?3
         AND ${mayInviteSql("invites.inviter_id", input.now)}`,
    )
    .bind(input.code, input.email, input.now)
    .run();
  return claimed.meta.changes > 0;
}

/**
 * Gives the new account the invitation its email claimed: who invited it,
 * and the invitation marked used. The inviter's karma settles, since their
 * invitees' share may now include this one.
 */
export async function attachInvite(db: D1Database, input: { userId: string; email: string }): Promise<void> {
  const claim = `SELECT inviter_id FROM invites WHERE claimed_email = lower(?2) AND used_by IS NULL`;
  await db.batch([
    db
      .prepare(`UPDATE profiles SET invited_by = (${claim}) WHERE user_id = ?1 AND invited_by IS NULL AND EXISTS (${claim})`)
      .bind(input.userId, input.email),
    db
      .prepare(`UPDATE invites SET used_by = ?1, claimed_email = NULL WHERE claimed_email = lower(?2) AND used_by IS NULL`)
      .bind(input.userId, input.email),
    ...settleKarma(db, `(SELECT invited_by FROM profiles WHERE user_id = ?1)`, input.userId),
  ]);
}

/** Frees claims whose sign-up never finished, so their invitations work again. */
export async function sweepInviteClaims(db: D1Database, now: number): Promise<number> {
  const freed = await db
    .prepare(`UPDATE invites SET claimed_email = NULL, claimed_at = NULL WHERE used_by IS NULL AND claimed_at < ?1`)
    .bind(now - 3600)
    .run();
  return freed.meta.changes;
}
