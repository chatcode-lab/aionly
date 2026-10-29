import type { EmbedConnection } from "../embeds/connect";
import type { EmbedEvent, PlayerState } from "../embeds/messages";
import { onScreen, planMounts, RULES, type SlotBox, type SlotKind } from "./plan";

/**
 * What a media card renders. Replaced rather than changed, so React notices.
 */
export interface SlotState {
  /** True while the frame is loaded; otherwise the poster shows. */
  mounted: boolean;
  /** True when a tap loaded the frame, which then starts with sound. */
  sound: boolean;
  /** Changes to rebuild the frame: the only way to stop an uncontrolled embed. */
  generation: number;
  /** The provider said it cannot play here, so the card shows a preview instead. */
  failed: boolean;
}

export const UNMOUNTED: SlotState = {
  mounted: false,
  sound: false,
  generation: 0,
  failed: false,
};

const CONTROLLED: ReadonlySet<SlotKind> = new Set(["video", "tiktok", "native"]);

/**
 * How long a frame has to say anything, ready or its height, before it
 * counts as failed and the card shows its preview: a provider that is
 * blocked, or never answers, would otherwise hold an empty frame. Suno's
 * player says nothing at all, so it has no deadline.
 */
export const READY_DEADLINE_MS = 20_000;
/** A pause is not repeated within this time while the player catches up. */
const COMMAND_GRACE_MS = 1000;
/** How often to check which frame holds keyboard focus while one does. */
const FRAME_FOCUS_POLL_MS = 500;

interface Slot {
  key: string;
  postId: string;
  kind: SlotKind;
  element: HTMLElement;
  /** Loaded by a tap, so it stays loaded while it plays. */
  tapped: boolean;
  connection: EmbedConnection | null;
  ready: boolean;
  player: PlayerState | null;
  /** When the page last paused it. */
  pausedAt: number | null;
  /** TikTok starts by itself as it loads; later starts come from the viewer. */
  started: boolean;
  /** True once the embed has reported its own height. */
  sized: boolean;
  /** The provider reported an error: the frame goes and never comes back. */
  failed: boolean;
}

/**
 * Decides which media frames are loaded, for the whole page, and keeps a
 * single playback owner: whatever the viewer started, as nothing plays by
 * itself where the page can stop it (owner's request, 2026-10-29). Cards
 * register their media slot; the controller measures them as the page
 * scrolls and loads frames near the screen. See "Media and text" in the plan.
 */
export class PlaybackController {
  private readonly slots = new Map<string, Slot>();
  private readonly states = new Map<string, SlotState>();
  private readonly listeners = new Map<string, Set<() => void>>();
  private readonly resizeObserver: ResizeObserver;
  /** A touch screen, where focus never moves into a frame on a tap (see songsWaitForTap). */
  private readonly touch: MediaQueryList;
  /** False under data saver, where nothing loads ahead of a tap. */
  private readonly loadAhead: boolean;

  /** The slot playing what the viewer started. */
  private owner: string | null = null;
  private scheduled = 0;
  private framePoll: ReturnType<typeof setInterval> | undefined;
  /** Each attached frame's readiness deadline. */
  private readonly deadlines = new Map<string, ReturnType<typeof setTimeout>>();

  /** Heights that keep a post embed's box steady when it is released. */
  private readonly posterHeights = new Map<string, number>();
  private readonly frameHeights = new Map<string, number>();

  constructor() {
    this.touch = window.matchMedia("(pointer: coarse)");
    const connection = (
      navigator as Navigator & { connection?: { saveData?: boolean } }
    ).connection;
    this.loadAhead = !connection?.saveData;
    // A card's media changing size moves everything after it.
    this.resizeObserver = new ResizeObserver(this.schedule);

    window.addEventListener("scroll", this.schedule, { passive: true });
    window.addEventListener("resize", this.schedule);
    window.addEventListener("blur", this.onWindowBlur);
    document.addEventListener("visibilitychange", this.evaluate);
  }

  // Slots

  register(
    key: string,
    postId: string,
    kind: SlotKind,
    element: HTMLElement,
  ): () => void {
    const slot: Slot = {
      key,
      postId,
      kind,
      element,
      tapped: false,
      connection: null,
      ready: false,
      player: null,
      pausedAt: null,
      started: false,
      sized: false,
      failed: false,
    };
    this.slots.set(key, slot);
    this.resizeObserver.observe(element);
    this.schedule();

    return () => {
      if (this.owner === key) this.owner = null;
      this.clearDeadline(key);
      this.slots.delete(key);
      this.resizeObserver.unobserve(element);
      this.publish(key, UNMOUNTED);
      this.schedule();
    };
  }

  subscribe(key: string, listener: () => void): () => void {
    let set = this.listeners.get(key);
    if (!set) {
      set = new Set();
      this.listeners.set(key, set);
    }
    set.add(listener);
    return () => {
      set.delete(listener);
      if (set.size === 0) this.listeners.delete(key);
    };
  }

  state(key: string): SlotState {
    return this.states.get(key) ?? UNMOUNTED;
  }

  /** The height a post embed last showed at, for its poster. */
  posterHeight(postId: string): number | undefined {
    return this.posterHeights.get(postId);
  }

  /** The height a post embed last reported, for its next frame. */
  frameHeight(postId: string): number | undefined {
    return this.frameHeights.get(postId);
  }

  /** The viewer tapped a poster: load its frame with sound and play it. */
  tap(key: string): void {
    const slot = this.slots.get(key);
    if (!slot) return;
    slot.tapped = true;
    this.takeOwnership(key);
    this.evaluate();
  }

  // Players

  attach(key: string, connection: EmbedConnection): void {
    const slot = this.slots.get(key);
    if (!slot) return;
    Object.assign(slot, {
      connection,
      ready: false,
      player: null,
      pausedAt: null,
      started: false,
      sized: false,
      failed: false,
    });
    this.clearDeadline(key);
    // A song reports nothing, and an article's file loads nothing until it is played.
    if (slot.kind !== "song" && slot.kind !== "native") {
      this.deadlines.set(
        key,
        setTimeout(() => {
          this.deadlines.delete(key);
          const current = this.slots.get(key);
          if (!current || current.connection !== connection || current.ready || current.sized || current.failed) return;
          this.report(key, { type: "error", detail: "no answer" });
        }, READY_DEADLINE_MS),
      );
    }
  }

  private clearDeadline(key: string): void {
    const deadline = this.deadlines.get(key);
    if (deadline !== undefined) clearTimeout(deadline);
    this.deadlines.delete(key);
  }

  detach(key: string): void {
    const slot = this.slots.get(key);
    if (!slot) return;
    this.clearDeadline(key);
    slot.connection = null;
    slot.ready = false;
    slot.player = null;
  }

  report(key: string, event: EmbedEvent): void {
    const slot = this.slots.get(key);
    if (!slot) return;

    switch (event.type) {
      case "ready":
        slot.ready = true;
        break;
      case "height":
        slot.sized = true;
        this.frameHeights.set(slot.postId, event.height);
        return;
      case "muted":
        // Sound is the viewer's, in the player's own controls.
        return;
      case "state":
        slot.ready = true;
        this.onState(slot, event.state);
        break;
      case "refused": {
        // The browser would not start it by itself. The frame stays, its own
        // play button for the viewer, whose tap then counts as theirs.
        slot.ready = true;
        slot.started = true;
        slot.player = "paused";
        this.schedule();
        return;
      }
      case "error": {
        // Unavailable, private, or not to be embedded: the card falls back
        // to its preview, with the way to the original.
        slot.failed = true;
        this.release(slot.key);
        const state = this.state(slot.key);
        this.publish(slot.key, { mounted: false, sound: false, generation: state.generation, failed: true });
        this.schedule();
        return;
      }
    }
    this.reconcile(slot);
  }

  private onState(slot: Slot, state: PlayerState): void {
    slot.player = state;
    // Caught up with the page's pause, so the next one goes out at once.
    if (state === "paused" || state === "ended") slot.pausedAt = null;
    const owner = this.owner === slot.key;

    if (state === "playing") {
      // TikTok plays as it loads, a start that is paused at once (reconcile).
      const ownStart = slot.kind === "tiktok" && !slot.started;
      slot.started = true;
      // Otherwise started from the player's own controls.
      if (!owner && !ownStart) this.takeOwnership(slot.key);
      return;
    }

    if ((state === "paused" || state === "ended") && owner) {
      // Paused by the viewer, or finished.
      this.owner = null;
      this.schedule();
    }
  }

  // Ownership

  private takeOwnership(key: string): void {
    const previous = this.owner;
    this.owner = key;
    if (previous && previous !== key) this.stop(previous);
    this.schedule();
  }

  private release(key: string): void {
    if (this.owner === key) this.owner = null;
    this.stop(key);
  }

  /** Stops a slot that no longer owns playback. */
  private stop(key: string): void {
    const slot = this.slots.get(key);
    if (!slot) return;
    // A tapped frame is no longer held, and unloads once far away.
    slot.tapped = false;
    if (CONTROLLED.has(slot.kind)) {
      this.reconcile(slot);
    } else if (this.state(key).mounted) {
      // Rebuilding the frame is the only way to stop an uncontrolled embed.
      const state = this.state(key);
      this.publish(key, { ...state, generation: state.generation + 1 });
    }
    this.schedule();
  }

  /** Pauses a controlled player that plays without owning playback. */
  private reconcile(slot: Slot): void {
    if (!CONTROLLED.has(slot.kind) || !slot.connection || !slot.ready) return;
    // What the viewer started is theirs to control.
    if (this.owner === slot.key) return;

    // Only once it plays: a start of the viewer's own reports buffering
    // first, and pausing that stopped it before it loaded. Playing, it is
    // then theirs (onState), and never paused here.
    const now = performance.now();
    const recent = slot.pausedAt !== null && now - slot.pausedAt < COMMAND_GRACE_MS;
    if (slot.player === "playing" && !recent) {
      slot.connection.send("pause");
      slot.pausedAt = now;
    }
  }

  // Measuring

  schedule = (): void => {
    if (this.scheduled) return;
    this.scheduled = window.requestAnimationFrame(this.evaluate);
  };

  private evaluate = (): void => {
    if (this.scheduled) window.cancelAnimationFrame(this.scheduled);
    this.scheduled = 0;

    const viewportHeight = window.innerHeight;
    const hidden = document.visibilityState === "hidden";
    const boxes: SlotBox[] = [];
    for (const slot of this.slots.values()) {
      // A frame that failed is never loaded again.
      if (slot.failed) continue;
      const rect = slot.element.getBoundingClientRect();
      boxes.push({
        key: slot.key,
        kind: slot.kind,
        top: rect.top,
        bottom: rect.bottom,
      });
    }
    const byKey = new Map(boxes.map((box) => [box.key, box]));

    // Playback stops once it is scrolled almost out of view, or the tab is hidden.
    if (this.owner) {
      const box = byKey.get(this.owner);
      if (!box || hidden || onScreen(box, viewportHeight) < RULES.viewerVisible) {
        this.release(this.owner);
      }
    }

    const held = new Set<string>();
    if (this.owner) held.add(this.owner);
    const mounted = new Set<string>();
    for (const slot of this.slots.values()) {
      if (slot.tapped) held.add(slot.key);
      if (this.state(slot.key).mounted) mounted.add(slot.key);
    }
    const next = planMounts({
      boxes,
      viewportHeight,
      mounted,
      held,
      loadAhead: this.loadAhead,
      songsWaitForTap: this.touch.matches,
    });
    for (const slot of this.slots.values()) {
      if (slot.failed) continue;
      const mount = next.has(slot.key);
      const state = this.state(slot.key);
      if (mount === state.mounted) continue;
      const box = byKey.get(slot.key);
      if (!mount && slot.sized && box) {
        // The poster takes the height the embed is leaving at.
        this.posterHeights.set(slot.postId, box.bottom - box.top);
      }
      this.publish(slot.key, {
        mounted: mount,
        sound: mount && slot.tapped,
        generation: state.generation,
        failed: false,
      });
    }
  };

  private publish(key: string, next: SlotState): void {
    const current = this.state(key);
    if (
      current.mounted === next.mounted &&
      current.sound === next.sound &&
      current.generation === next.generation &&
      current.failed === next.failed
    ) {
      return;
    }
    this.states.set(key, next);
    for (const listener of this.listeners.get(key) ?? []) listener();
  }

  // Uncontrolled embeds report nothing, so focus moving into one is the only
  // sign the viewer is using it.

  private onWindowBlur = (): void => {
    setTimeout(this.checkFocusedFrame, 0);
  };

  private checkFocusedFrame = (): void => {
    const active = document.activeElement;
    if (!(active instanceof HTMLIFrameElement)) {
      clearInterval(this.framePoll);
      this.framePoll = undefined;
      return;
    }
    for (const slot of this.slots.values()) {
      if (!slot.element.contains(active)) continue;
      if (!CONTROLLED.has(slot.kind) && this.owner !== slot.key) {
        this.takeOwnership(slot.key);
      }
      break;
    }
    // Focus can move from one frame to another without the page hearing.
    this.framePoll ??= setInterval(this.checkFocusedFrame, FRAME_FOCUS_POLL_MS);
  };
}

let controller: PlaybackController | null = null;

/** The page's playback controller, or null while rendering on the server. */
export function playbackController(): PlaybackController | null {
  if (typeof window === "undefined") return null;
  controller ??= new PlaybackController();
  return controller;
}
