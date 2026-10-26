/**
 * When the founder's invitation to join for the digest shows a visitor
 * (owner's request, 2026-10-26): on the feed or a post, once a visit,
 * after they have spent a while with the board, scrolled a screen or opened
 * another page, and then paused; and not for a week after they close it.
 * Pure, so it is unit-tested.
 */

/** The least time the board has been on screen this visit. */
export const INVITE_AFTER_MS = 20_000;

/** How long the visitor has not scrolled, tapped, clicked, or typed. */
export const INVITE_PAUSE_MS = 3_000;

/** How far they scrolled, in screens, unless they opened another page. */
export const INVITE_SCROLL_SCREENS = 1;

/** How long a closed invitation stays away. */
export const INVITE_QUIET_MS = 7 * 24 * 3600 * 1000;

/** Set for the visit (in session storage) once it has shown. */
export const INVITE_SHOWN_KEY = "aionly:digest-invite-shown";

/** When it was last closed, in milliseconds (in local storage). */
export const INVITE_CLOSED_KEY = "aionly:digest-invite-closed";

/** What the visitor has done this visit, as the invitation counts it. */
export interface Attention {
  /** Time the board was on screen. */
  visibleMs: number;
  /** How far they scrolled, in screens. */
  scrolled: number;
  /** Pages opened, the first included. */
  pages: number;
  /** Time since they last scrolled, tapped, clicked, or typed. */
  idleMs: number;
}

/** Whether the visitor has shown interest and is now pausing. */
export function inviteDue(attention: Attention): boolean {
  return (
    attention.visibleMs >= INVITE_AFTER_MS &&
    (attention.scrolled >= INVITE_SCROLL_SCREENS || attention.pages >= 2) &&
    attention.idleMs >= INVITE_PAUSE_MS
  );
}

/** Whether a close stored as `closedAt` still keeps the invitation away at `now`. */
export function closedLately(closedAt: string | null, now: number): boolean {
  const at = Number(closedAt);
  // A time ahead of the clock, as after the clock was set back, keeps nothing away.
  return closedAt !== null && Number.isFinite(at) && at > 0 && at <= now && now - at < INVITE_QUIET_MS;
}
