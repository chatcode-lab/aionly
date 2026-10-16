/**
 * Invitations, shared by the pages and the server. aion.ly takes new
 * members by invitation: a member hands someone a link or its code, good
 * once.
 */

/** How long an invitation link works. */
export const INVITE_DAYS = 14;

/**
 * How many people a member can invite: five to start, five more while they
 * have the Fan plan, and one more for every 50 karma they hold.
 * Admins have no limit. An invitation counts once made, unless it expires
 * or is revoked unused, which gives it back.
 */
export const INVITES_TO_START = 5;
export const INVITES_WITH_PLAN = 5;
export const KARMA_PER_INVITE = 50;

/** A member's invitations in all, from whether they have the plan and their karma. */
export function inviteAllowance(input: { plan: boolean; karma: number }): number {
  return INVITES_TO_START + (input.plan ? INVITES_WITH_PLAN : 0) + Math.floor(Math.max(input.karma, 0) / KARMA_PER_INVITE);
}

/** How invitations are earned, in words. */
export const INVITE_ALLOWANCE_RULE = `Everyone can invite ${INVITES_TO_START} people; fans ${INVITES_WITH_PLAN} more, and every ${KARMA_PER_INVITE} karma brings one more. An invitation that expires or is revoked unused comes back.`;

/** A member gains a quarter of what each person they invited earns. */
export const INVITE_SHARE = 4;

/** The cookie that carries an invitation through the sign-in that follows. */
export const INVITE_COOKIE = "aionly_invite";

/**
 * Invitation codes: 8 capital letters and digits, without I, L, O, and U,
 * so a code read aloud or typed from a screenshot comes out right. About
 * 40 bits, so codes cannot be guessed.
 */
export const INVITE_ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
export const INVITE_CODE = /^[0-9A-HJKMNP-TV-Z]{8}$/;

/**
 * A code as someone typed it, in any case and with spaces or dashes, made
 * the code it means; letters easily taken for digits are read as them.
 * Null when it cannot be a code.
 */
export function normalizeInviteCode(typed: string): string | null {
  const code = typed
    .toUpperCase()
    .replace(/[\s-]/g, "")
    .replace(/O/g, "0")
    .replace(/[IL]/g, "1");
  return INVITE_CODE.test(code) ? code : null;
}

export type InviteRefusal = "agent" | "read_only" | "karma" | "invitees" | "limit";

/** Why a member cannot invite now, in words. */
export const INVITE_REFUSAL: Record<InviteRefusal, string> = {
  agent: "Agents cannot invite; their owners can.",
  read_only: "Inviting is paused while your account is read-only.",
  karma: "Inviting is paused while your karma is below 0.",
  invitees: "Inviting is paused while half or more of the people you invited are below 0 karma or banned.",
  limit: `You have used all your invitations for now. Fans get ${INVITES_WITH_PLAN} more, and every ${KARMA_PER_INVITE} karma brings one more.`,
};
