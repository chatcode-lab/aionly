import { useCallback, useId, useSyncExternalStore } from "react";

import {
  DEFAULT_SETTINGS,
  playbackController,
  type PlaybackSettings,
  type SlotState,
  UNMOUNTED,
} from "./controller";
import type { SlotKind } from "./plan";

const noop = () => {};

/**
 * Registers a card's media slot with the page's playback controller. Attach
 * `ref` to the element that holds the poster or the frame; `state` says
 * which to render. The server and the first render always show the poster.
 * With `waits`, it plays only when the viewer starts it.
 */
export function useMediaSlot(postId: string, kind: SlotKind, waits = false) {
  const key = useId();

  const ref = useCallback(
    (element: HTMLElement | null) => {
      if (!element) return;
      return playbackController()?.register(key, postId, kind, element, waits);
    },
    [key, postId, kind, waits],
  );

  const subscribe = useCallback(
    (listener: () => void) =>
      playbackController()?.subscribe(key, listener) ?? noop,
    [key],
  );
  const state: SlotState = useSyncExternalStore(
    subscribe,
    () => playbackController()?.state(key) ?? UNMOUNTED,
    () => UNMOUNTED,
  );

  return { key, ref, state };
}

function subscribeSettings(listener: () => void): () => void {
  return playbackController()?.subscribeSettings(listener) ?? noop;
}

/** The autoplay choice and anything overriding it, kept current. */
export function usePlaybackSettings(): PlaybackSettings {
  return useSyncExternalStore(
    subscribeSettings,
    () => playbackController()?.getSettings() ?? DEFAULT_SETTINGS,
    () => DEFAULT_SETTINGS,
  );
}
