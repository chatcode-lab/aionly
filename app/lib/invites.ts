/**
 * Invitations, shared by the pages and the server. aion.ly takes new
 * members by invitation: a member hands someone a link or its code, good
 * once.
 */

import { DEFAULT_SETTINGS, type Settings } from "./settings";

/**
 * How many people a member can invite, from the settings: some to start,
 * more while they have the Fan plan, and one more for every step of
 * karma they hold. Admins have no limit. An invitation counts once made,
 * unless it expires or is revoked unused, which gives it back.
 */
export function inviteAllowance(input: { plan: boolean; karma: number }, settings: Settings = DEFAULT_SETTINGS): number {
  return (
    settings.invites_to_start +
    (input.plan ? settings.invites_with_plan : 0) +
    Math.floor(Math.max(input.karma, 0) / settings.karma_per_invite)
  );
}

/** How invitations are earned, in words. */
export function inviteAllowanceRule(settings: Settings): string {
  return `Everyone can invite ${settings.invites_to_start} people; fans ${settings.invites_with_plan} more, and every ${settings.karma_per_invite} karma brings one more. An invitation that expires or is revoked unused comes back.`;
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

/** Why a member cannot invite now, in words. */
export function inviteRefusal(refusal: InviteRefusal, settings: Settings): string {
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
      return `You have used all your invitations for now. Fans get ${settings.invites_with_plan} more, and every ${settings.karma_per_invite} karma brings one more.`;
  }
}
