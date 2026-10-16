import type { EmbedConnection } from "../embeds/connect";
import type { EmbedEvent, PlayerState } from "../embeds/messages";
import {
  focusCandidate,
  onScreen,
  planMounts,
  RULES,
  type SlotBox,
  type SlotKind,
} from "./plan";

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

export interface PlaybackSettings {
  /** The viewer's choice, remembered in this browser. On unless turned off. */
  autoplay: boolean;
  /** Why autoplay is off whatever that choice says. */
  blockedBy: "reduced-motion" | "data-saver" | null;
}

export const DEFAULT_SETTINGS: PlaybackSettings = {
  autoplay: true,
  blockedBy: null,
};

const CONTROLLED: ReadonlySet<SlotKind> = new Set(["video", "tiktok"]);

/**
 * How long a frame has to say anything, ready or its height, before it
 * counts as failed and the card shows its preview: a provider that is
 * blocked, or never answers, would otherwise hold an empty frame. Suno's
 * player says nothing at all, so it has no deadline.
 */
export const READY_DEADLINE_MS = 20_000;
const STORAGE_KEY = "autoplay";
/** A command is not repeated within this time while the player catches up. */
const COMMAND_GRACE_MS = 1000;
/** A player that stops this soon after an unmuted play was refused sound. */
const SOUND_REFUSAL_MS = 1500;
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
  /** The muted state the player last reported. */
  muted: boolean | null;
  /** The muted state the page expects: its own last command, or the first report. */
  expectMuted: boolean | null;
  /** True once the player has reported the expected muted state. */
  mutedConfirmed: boolean;
  /** The last play or pause the page sent. */
  sent: { play: boolean; sound: boolean; at: number } | null;
  /** TikTok starts by itself as it loads; later starts come from the viewer. */
  started: boolean;
  /** True once the embed has reported its own height. */
  sized: boolean;
  /** The provider reported an error: the frame goes and never comes back. */
  failed: boolean;
}

interface Owner {
  key: string;
  /** "focus" for autoplay, "viewer" for anything the viewer started. */
  by: "focus" | "viewer";
}

function isPlaying(state: PlayerState | null): boolean {
  return state === "playing" || state === "buffering";
}

/**
 * Decides which media frames are loaded and which one plays, for the whole
 * page. Cards register their media slot; the controller measures them as the
 * page scrolls, loads frames near the screen, plays the focused video, and
 * keeps a single playback owner. See "Media and text" in the plan.
 */
export class PlaybackController {
  private readonly slots = new Map<string, Slot>();
  private readonly states = new Map<string, SlotState>();
  private readonly listeners = new Map<string, Set<() => void>>();
  private readonly settingsListeners = new Set<() => void>();
  private readonly resizeObserver: ResizeObserver;
  private readonly reducedMotion: MediaQueryList;
  /** A touch screen, where focus never moves into a frame on a tap (see songsWaitForTap). */
  private readonly touch: MediaQueryList;

  private settings: PlaybackSettings;
  private owner: Owner | null = null;
  private candidate: string | null = null;
  private dwell: ReturnType<typeof setTimeout> | undefined;
  private dwellDone = false;
  /** Videos the viewer paused while focused, left alone until focus moves on. */
  private readonly suppressed = new Set<string>();
  /** Once the viewer unmutes a player, later autoplay keeps sound on. */
  private soundOn = false;
  private scheduled = 0;
  private framePoll: ReturnType<typeof setInterval> | undefined;
  /** Each attached frame's readiness deadline. */
  private readonly deadlines = new Map<string, ReturnType<typeof setTimeout>>();

  /** Heights that keep a post embed's box steady when it is released. */
  private readonly posterHeights = new Map<string, number>();
  private readonly frameHeights = new Map<string, number>();

  constructor() {
    this.reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)");
    this.touch = window.matchMedia("(pointer: coarse)");
    this.settings = this.readSettings();
    // A card's media changing size moves everything after it.
    this.resizeObserver = new ResizeObserver(this.schedule);

    window.addEventListener("scroll", this.schedule, { passive: true });
    window.addEventListener("resize", this.schedule);
    window.addEventListener("blur", this.onWindowBlur);
    document.addEventListener("visibilitychange", this.evaluate);
    this.reducedMotion.addEventListener("change", this.refreshSettings);
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
      muted: null,
      expectMuted: null,
      mutedConfirmed: false,
      sent: null,
      started: false,
      sized: false,
      failed: false,
    };
    this.slots.set(key, slot);
    this.resizeObserver.observe(element);
    this.schedule();

    return () => {
      if (this.owner?.key === key) this.owner = null;
      this.suppressed.delete(key);
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
    this.takeOwnership(key, "viewer");
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
      muted: null,
      expectMuted: null,
      mutedConfirmed: false,
      sent: null,
      started: false,
      sized: false,
      failed: false,
    });
    this.clearDeadline(key);
    if (slot.kind !== "song") {
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
        this.onMuted(slot, event.muted);
        break;
      case "state":
        slot.ready = true;
        this.onState(slot, event.state);
        break;
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

  private onMuted(slot: Slot, muted: boolean): void {
    slot.muted = muted;
    if (slot.expectMuted === null || muted === slot.expectMuted) {
      slot.expectMuted = muted;
      slot.mutedConfirmed = true;
    } else if (slot.mutedConfirmed) {
      // The player had done as asked, so this change is the viewer's, made
      // in its own controls. A report before that is merely out of date.
      slot.expectMuted = muted;
      this.soundOn = !muted;
    }
  }

  private onState(slot: Slot, state: PlayerState): void {
    slot.player = state;
    const owner = this.owner?.key === slot.key ? this.owner : null;

    if (state === "playing") {
      const ownStart = slot.kind === "tiktok" && !slot.started;
      slot.started = true;
      if (owner) return;
      if (ownStart) {
        // TikTok plays as it loads. It keeps playing only if it has focus.
        if (
          slot.key === this.candidate &&
          this.autoplayAllowed() &&
          this.owner?.by !== "viewer"
        ) {
          this.takeOwnership(slot.key, "focus");
        }
      } else if (!slot.sent?.play) {
        // Started from the player's own controls.
        this.takeOwnership(slot.key, "viewer");
      }
      return;
    }

    if ((state === "paused" || state === "ended") && owner) {
      const sent = slot.sent;
      if (
        state === "paused" &&
        sent?.play &&
        sent.sound &&
        performance.now() - sent.at < SOUND_REFUSAL_MS
      ) {
        // The browser refused to play with sound; carry on muted.
        this.soundOn = false;
        slot.sent = null;
        return;
      }
      // Paused by the viewer, or finished. A focused video is left alone
      // until focus moves on.
      if (owner.by === "focus") this.suppressed.add(slot.key);
      this.owner = null;
      slot.sent = { play: false, sound: false, at: performance.now() };
      this.schedule();
    }
  }

  // Settings

  getSettings = (): PlaybackSettings => this.settings;

  subscribeSettings = (listener: () => void): (() => void) => {
    this.settingsListeners.add(listener);
    return () => this.settingsListeners.delete(listener);
  };

  setAutoplay(on: boolean): void {
    try {
      if (on) window.localStorage.removeItem(STORAGE_KEY);
      else window.localStorage.setItem(STORAGE_KEY, "off");
    } catch {
      // Storage can be unavailable; the choice then lasts for this page.
    }
    this.refreshSettings(on);
  }

  private readSettings(choice?: boolean): PlaybackSettings {
    let autoplay = choice;
    if (autoplay === undefined) {
      try {
        autoplay = window.localStorage.getItem(STORAGE_KEY) !== "off";
      } catch {
        autoplay = this.settings?.autoplay ?? true;
      }
    }
    const connection = (
      navigator as Navigator & { connection?: { saveData?: boolean } }
    ).connection;
    const blockedBy = connection?.saveData
      ? "data-saver"
      : this.reducedMotion.matches
        ? "reduced-motion"
        : null;
    return { autoplay, blockedBy };
  }

  private refreshSettings = (choice?: boolean | Event): void => {
    this.settings = this.readSettings(
      typeof choice === "boolean" ? choice : undefined,
    );
    for (const listener of this.settingsListeners) listener();
    this.evaluate();
  };

  private autoplayAllowed(): boolean {
    return this.settings.autoplay && this.settings.blockedBy === null;
  }

  private wantSound(): boolean {
    const activation = (
      navigator as Navigator & { userActivation?: { hasBeenActive: boolean } }
    ).userActivation;
    return this.soundOn && (activation?.hasBeenActive ?? true);
  }

  // Ownership

  private takeOwnership(key: string, by: Owner["by"]): void {
    const previous = this.owner;
    this.owner = { key, by };
    this.suppressed.delete(key);
    if (previous && previous.key !== key) this.stop(previous.key);
    const slot = this.slots.get(key);
    if (slot) this.reconcile(slot);
    this.schedule();
  }

  private release(key: string): void {
    if (this.owner?.key === key) this.owner = null;
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

  /** Sends whatever commands bring a controlled player in line. */
  private reconcile(slot: Slot): void {
    if (!CONTROLLED.has(slot.kind) || !slot.connection || !slot.ready) return;
    const owner = this.owner?.key === slot.key ? this.owner : null;
    // What the viewer started is theirs to control.
    if (owner?.by === "viewer") return;

    const now = performance.now();
    const recent = (play: boolean) =>
      slot.sent?.play === play && now - slot.sent.at < COMMAND_GRACE_MS;

    if (owner) {
      const sound = slot.kind === "video" && this.wantSound();
      // TikTok undoes mute commands, so only YouTube is told.
      if (slot.kind === "video" && slot.expectMuted !== !sound) {
        slot.connection.send(sound ? "unmute" : "mute");
        slot.expectMuted = !sound;
        slot.mutedConfirmed = false;
      }
      if (!isPlaying(slot.player) && !recent(true)) {
        slot.connection.send("play");
        slot.sent = { play: true, sound, at: now };
      }
    } else if (isPlaying(slot.player) && !recent(false)) {
      slot.connection.send("pause");
      slot.sent = { play: false, sound: false, at: now };
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

    // Playback stops when it leaves focus or the tab is hidden.
    if (this.owner) {
      const box = byKey.get(this.owner.key);
      if (
        !box ||
        hidden ||
        (this.owner.by === "viewer" &&
          onScreen(box, viewportHeight) < RULES.viewerVisible)
      ) {
        this.release(this.owner.key);
      }
    }

    const raw =
      hidden || !this.autoplayAllowed()
        ? null
        : focusCandidate(boxes, viewportHeight);
    for (const key of this.suppressed) {
      if (key !== raw) this.suppressed.delete(key);
    }
    const candidate = raw !== null && !this.suppressed.has(raw) ? raw : null;

    if (this.owner?.by === "focus" && this.owner.key !== candidate) {
      this.release(this.owner.key);
    }
    if (candidate !== this.candidate) {
      this.candidate = candidate;
      this.dwellDone = false;
      clearTimeout(this.dwell);
      this.dwell = candidate
        ? setTimeout(() => {
            this.dwellDone = true;
            this.evaluate();
          }, RULES.dwellMs)
        : undefined;
    }
    if (candidate && this.dwellDone && !this.owner) {
      this.takeOwnership(candidate, "focus");
    }

    const held = new Set<string>();
    if (this.owner) held.add(this.owner.key);
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
      candidate,
      loadAhead: this.settings.blockedBy !== "data-saver",
      autoplay: this.autoplayAllowed(),
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
      if (!CONTROLLED.has(slot.kind) && this.owner?.key !== slot.key) {
        this.takeOwnership(slot.key, "viewer");
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
