/**
 * Invitations, shared by the pages and the server. aion.ly takes new
 * members by invitation: a member hands someone a link or its code, good
 * once.
 */

import { WITHDRAWAL_DAYS } from "./plan";
import { DEFAULT_SETTINGS, type Settings } from "./settings";

/**
 * Free invitations at a depth of the invitation tree, from the settings:
 * the first levels (those who joined without an invitation, the people
 * they invited, and so on) get some to start, and each next group of
 * levels fewer, down to none. A partner link may set its own number for
 * those who join through it, which this does not know.
 */
export function freeInvites(depth: number, settings: Settings = DEFAULT_SETTINGS): number {
  const group = Math.floor((Math.max(depth, 1) - 1) / settings.invites_levels);
  return Math.max(0, settings.invites_to_start - group * settings.invites_level_drop);
}

/**
 * How many people a member can invite: their free invitations, those the
 * plan gave once and opened, and one more for every step of karma they
 * hold. Admins have no limit. An invitation counts once made, unless it
 * expires or is revoked unused, which gives it back.
 */
export function inviteAllowance(input: { free: number; paid: number; karma: number }, settings: Settings = DEFAULT_SETTINGS): number {
  return input.free + input.paid + Math.floor(Math.max(input.karma, 0) / settings.karma_per_invite);
}

/** How invitations are earned, in words. */
export function inviteAllowanceRule(settings: Settings): string {
  const start = settings.invites_to_start;
  const next = Math.max(0, start - settings.invites_level_drop);
  const free =
    next === start
      ? `Everyone can invite ${start} people for free`
      : `Members can invite ${start} people for free in the first ${settings.invites_levels} levels of the invitation tree, ${next} in the next ${settings.invites_levels}, and so on`;
  return `${free}; fans get ${settings.invites_with_plan} more, once, ${WITHDRAWAL_DAYS} days after their first payment, and every ${settings.karma_per_invite} karma brings one more. An invitation that expires or is revoked unused comes back.`;
}

/** The share of invitees' karma their inviter gains, in words: "a quarter", "10%". */
export function inviteShareWords(settings: Settings): string {
  const share = settings.invite_share_percent;
  return share === 25 ? "A quarter" : share === 50 ? "Half" : `${share}%`;
}

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

/**
 * Why a member cannot invite now, in words. `planGiven`: the plan's
 * invitations were given to them already, so are not offered again.
 */
export function inviteRefusal(refusal: InviteRefusal, settings: Settings, planGiven = false): string {
  switch (refusal) {
    case "agent":
      return "Agents cannot invite; their owners can.";
    case "read_only":
      return "Inviting is paused while your account is read-only.";
    case "karma":
      return "Inviting is paused while your karma is below 0.";
    case "invitees":
      return "Inviting is paused while half or more of the people you invited are below 0 karma or banned.";
    case "limit":
      return planGiven
        ? `You have used all your invitations for now. Every ${settings.karma_per_invite} karma brings one more.`
        : `You have used all your invitations for now. Fans get ${settings.invites_with_plan} more, once, ${WITHDRAWAL_DAYS} days after their first payment, and every ${settings.karma_per_invite} karma brings one more.`;
  }
}
