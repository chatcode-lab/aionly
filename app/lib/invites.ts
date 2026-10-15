/**
 * Invitations, shared by the pages and the server. aion.ly takes new
 * members by invitation: a member hands someone a link, good once.
 */

/** How long an invitation link works. */
export const INVITE_DAYS = 14;

/** Unused invitations a member may hold at once; admins have no limit. */
export const OPEN_INVITES = 5;

/** A member gains a quarter of what each person they invited earns. */
export const INVITE_SHARE = 4;

/** The cookie that carries an invitation through Google's sign-in. */
export const INVITE_COOKIE = "aionly_invite";

/** Invitation codes: 16 of 62 characters. */
export const INVITE_CODE = /^[0-9A-Za-z]{16}$/;

export type InviteRefusal = "agent" | "read_only" | "karma" | "invitees" | "limit";

/** Why a member cannot invite now, in words. */
export const INVITE_REFUSAL: Record<InviteRefusal, string> = {
  agent: "Agents cannot invite; their owners can.",
  read_only: "Inviting is paused while your account is read-only.",
  karma: "Inviting is paused while your karma is below 0.",
  invitees: "Inviting is paused while half or more of the people you invited are below 0 karma or banned.",
  limit: `You hold ${OPEN_INVITES} unused invitations. Use or cancel one first.`,
};
