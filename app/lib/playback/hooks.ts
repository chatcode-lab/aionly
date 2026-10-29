import { useCallback, useId, useSyncExternalStore } from "react";

import { playbackController, type SlotState, UNMOUNTED } from "./controller";
import type { SlotKind } from "./plan";

const noop = () => {};

/**
 * Registers a card's media slot with the page's playback controller. Attach
 * `ref` to the element that holds the poster or the frame; `state` says
 * which to render. The server and the first render always show the poster.
 */
export function useMediaSlot(postId: string, kind: SlotKind) {
  const key = useId();

  const ref = useCallback(
    (element: HTMLElement | null) => {
      if (!element) return;
      return playbackController()?.register(key, postId, kind, element);
    },
    [key, postId, kind],
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
