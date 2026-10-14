/**
 * Which media frames to load and which video has focus, decided from where
 * the cards sit on screen. Pure, so the rules are unit-tested; the playback
 * controller measures the page and applies the result.
 */

export type SlotKind =
  /** A player the page controls and can hold paused: YouTube. */
  | "video"
  /** TikTok: controlled, but it starts playing the moment it loads. */
  | "tiktok"
  /** A post embed that sizes itself: X, Reddit, and Telegram. */
  | "post"
  /** A song player the page cannot control: Suno. */
  | "song";

export interface SlotBox {
  key: string;
  kind: SlotKind;
  /** Edges relative to the top of the viewport, in CSS pixels. */
  top: number;
  bottom: number;
}

export const RULES = {
  /** A video needs this share on screen to take focus. */
  focusVisible: 0.6,
  /** How long focus must hold before the video plays, in milliseconds. */
  dwellMs: 300,
  /** Frames load this many screens above the viewport... */
  loadAbove: 0.5,
  /** ...and this many below, where scrolling usually goes. */
  loadBelow: 1,
  /** A loaded frame is released once it is further away than this. */
  releaseBeyond: 2,
  /** A TikTok frame, which plays as it loads, is released sooner. */
  releaseTikTokBeyond: 0.5,
  /** At most this many frames are loaded, nearest the center first. */
  maxFrames: 3,
  /** Something the viewer started stops below this share on screen. */
  viewerVisible: 0.25,
} as const;

/**
 * The share of a box on screen. A box taller than the screen counts as fully
 * on screen when it fills it.
 */
export function onScreen(box: SlotBox, viewportHeight: number): number {
  const height = box.bottom - box.top;
  if (height <= 0 || viewportHeight <= 0) return 0;
  const visible =
    Math.min(box.bottom, viewportHeight) - Math.max(box.top, 0);
  return Math.max(0, visible) / Math.min(height, viewportHeight);
}

/** How far a box is from the screen, in screen heights; 0 when on it. */
export function screensAway(box: SlotBox, viewportHeight: number): number {
  if (box.bottom <= 0) return -box.bottom / viewportHeight;
  if (box.top >= viewportHeight) return (box.top - viewportHeight) / viewportHeight;
  return 0;
}

function distanceFromCenter(box: SlotBox, viewportHeight: number): number {
  return Math.abs((box.top + box.bottom) / 2 - viewportHeight / 2);
}

/**
 * The video that should have focus: the one nearest the viewport center
 * among those at least 60% on screen.
 */
export function focusCandidate(
  boxes: readonly SlotBox[],
  viewportHeight: number,
): string | null {
  let best: string | null = null;
  let bestDistance = Infinity;
  for (const box of boxes) {
    if (box.kind !== "video" && box.kind !== "tiktok") continue;
    if (onScreen(box, viewportHeight) < RULES.focusVisible) continue;
    const distance = distanceFromCenter(box, viewportHeight);
    if (distance < bestDistance) {
      best = box.key;
      bestDistance = distance;
    }
  }
  return best;
}

export interface MountInput {
  boxes: readonly SlotBox[];
  viewportHeight: number;
  /** Frames loaded now, which stay until they are far away. */
  mounted: ReadonlySet<string>;
  /** Frames that stay regardless: the playback owner, or one loaded by a tap. */
  held: ReadonlySet<string>;
  /** The video that has focus, or is about to. */
  candidate: string | null;
  /** False under data saver, where nothing loads ahead of a tap. */
  loadAhead: boolean;
  /** False when autoplay is off; TikTok, which plays as it loads, then waits for a tap. */
  autoplay: boolean;
}

function wanted(box: SlotBox, input: MountInput): boolean {
  if (input.held.has(box.key)) return true;
  if (!input.loadAhead) return false;

  const away = screensAway(box, input.viewportHeight);
  const loaded = input.mounted.has(box.key);
  switch (box.kind) {
    case "video":
    case "post":
    case "song": {
      if (loaded) return away <= RULES.releaseBeyond;
      const above = box.bottom <= 0;
      return away <= (above ? RULES.loadAbove : RULES.loadBelow);
    }
    case "tiktok":
      // Loaded only as it takes focus, since loading starts it playing.
      if (!input.autoplay) return false;
      if (loaded) return away <= RULES.releaseTikTokBeyond;
      return box.key === input.candidate;
  }
}

/**
 * The frames that should be loaded: held ones always, then those near the
 * screen, nearest the center first, up to the cap.
 */
export function planMounts(input: MountInput): Set<string> {
  const chosen = input.boxes
    .filter((box) => wanted(box, input))
    .map((box) => ({
      key: box.key,
      held: input.held.has(box.key),
      distance: distanceFromCenter(box, input.viewportHeight),
    }))
    .sort((a, b) => Number(b.held) - Number(a.held) || a.distance - b.distance);

  const heldCount = chosen.filter((entry) => entry.held).length;
  const limit = Math.max(RULES.maxFrames, heldCount);
  return new Set(chosen.slice(0, limit).map((entry) => entry.key));
}
