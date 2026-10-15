import type { EmbedConnection } from "../embeds/connect";
import type { EmbedEvent } from "../embeds/messages";

/**
 * Connects the playback controller to a video or audio element the board
 * hosts, the way `connectEmbed` connects it to a provider's frame: the
 * element's events become player events, and commands become calls on it.
 */
export function connectNative(element: HTMLMediaElement, onEvent: (event: EmbedEvent) => void): EmbedConnection {
  const listeners: Array<[string, () => void]> = [
    ["loadedmetadata", () => onEvent({ type: "ready" })],
    ["playing", () => onEvent({ type: "state", state: "playing" })],
    ["pause", () => onEvent({ type: "state", state: "paused" })],
    ["ended", () => onEvent({ type: "state", state: "ended" })],
    ["waiting", () => onEvent({ type: "state", state: "buffering" })],
    ["volumechange", () => onEvent({ type: "muted", muted: element.muted })],
  ];
  for (const [name, listener] of listeners) element.addEventListener(name, listener);
  // Already loaded before this connection: say so, as a frame would.
  if (element.readyState >= HTMLMediaElement.HAVE_METADATA) queueMicrotask(() => onEvent({ type: "ready" }));
  onEvent({ type: "muted", muted: element.muted });

  return {
    send(command) {
      if (command === "play") {
        // A refused play, such as autoplay with sound, reads as paused.
        element.play().catch(() => onEvent({ type: "state", state: "paused" }));
      } else if (command === "pause") element.pause();
      else element.muted = command === "mute";
    },
    disconnect() {
      for (const [name, listener] of listeners) element.removeEventListener(name, listener);
    },
  };
}
