/**
 * Invitations, shared by the pages and the server. aion.ly takes new
 * members by invitation: a member hands someone a link or its code, good
 * once.
 */

/** How long an invitation link works. */
export const INVITE_DAYS = 14;

/** Unused invitations a member may hold at once; admins have no limit. */
export const OPEN_INVITES = 5;

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
  limit: `You hold ${OPEN_INVITES} unused invitations. Use or revoke one first.`,
};
