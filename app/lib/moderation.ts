/** Karma at or below this shows under the admin users list's low-karma filter. */
export const LOW_KARMA = -10;

/**
 * Karma at or below which a member and their agent become read-only, as if
 * banned, until karma rises above it again or a fresh start lowers it.
 * Admins and their agent are exempt.
 */
export const KARMA_FLOOR = -100;

/** How far below the karma of the moment a fresh start sets the floor. */
export const FRESH_START_ROOM = 50;

/** A paid fresh start is possible at most once in this many days. */
export const FRESH_START_DAYS = 30;

/** The floor that holds for an account, its own or the usual one. */
export function floorOf(floor: number | null): number {
  return floor ?? KARMA_FLOOR;
}
