/**
 * The header logo's moves (`~/components/site-logo`), worked out apart from
 * the page so they can be tested: how far the name covers the eyes as the
 * cursor comes and goes, and where the pupils look (owner's request,
 * 2026-10-26).
 */

/** How near the cursor starts to bring the name down, in CSS pixels. */
export const LOGO_REACH = 140;

/** How far the name comes down over the eyes before the cursor is over the logo. */
export const LOGO_CREEP = 0.45;

/** How far the pupils move, in the eyes' own units (their drawing is 48 by 24). */
export const LOOK_RANGE = 2.4;

/** The eyes blink and look around after this long without input, then again after each repeat. */
export const LOGO_IDLE_MS = 6000;
export const LOGO_IDLE_REPEAT_MS = 15_000;

/** On a touch screen, how far a finger moves before it is a swipe, in CSS pixels. */
export const TOUCH_SWIPE = 10;

/** On a touch screen, how long the eyes stay out after the last swipe or scroll. */
export const TOUCH_AWAKE_MS = 1200;

export interface LogoCover {
  /** How far the name covers the eyes: 0 lifted, 1 covering them. */
  cover: number;
  /** Lifted as the cursor left, and kept up until it is out of reach. */
  lifted: boolean;
  /** Moved in one go, covering or lifting, rather than following the cursor. */
  snap: boolean;
}

export const UNCOVERED: LogoCover = { cover: 0, lifted: false, snap: false };

/** The distance from a point to a box, 0 inside it. */
export function distanceToBox(
  x: number,
  y: number,
  box: { left: number; top: number; right: number; bottom: number },
): number {
  return Math.hypot(Math.max(box.left - x, 0, x - box.right), Math.max(box.top - y, 0, y - box.bottom));
}

/**
 * The name's cover for a cursor this far from the logo (null when there is
 * none, as after a tap), following the last one. Over the logo it covers the
 * eyes; as the cursor nears, it creeps down part way. Once the cursor leaves,
 * it lifts in one move and stays up until the cursor is out of reach, so it
 * does not creep back down while the cursor moves away.
 */
export function nextCover(distance: number | null, last: LogoCover): LogoCover {
  if (distance === 0) return { cover: 1, lifted: false, snap: true };
  if (distance === null) return { cover: 0, lifted: false, snap: true };
  if (last.cover === 1 || last.lifted) return { cover: 0, lifted: distance < LOGO_REACH, snap: true };
  return { cover: Math.max(0, 1 - distance / LOGO_REACH) * LOGO_CREEP, lifted: false, snap: false };
}

/** Whether a finger has moved far enough from where it touched down to be a swipe, not a tap. */
export function swiped(from: { x: number; y: number }, to: { x: number; y: number }): boolean {
  return Math.hypot(to.x - from.x, to.y - from.y) >= TOUCH_SWIPE;
}

/**
 * Where the pupils look for a cursor dx, dy CSS pixels from the eyes' center:
 * toward it, less the closer it is, and never past LOOK_RANGE.
 */
export function lookToward(dx: number, dy: number): [number, number] {
  const scale = LOOK_RANGE / (Math.hypot(dx, dy) + 40);
  return [dx * scale, dy * scale];
}
