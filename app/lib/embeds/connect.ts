import type { Provider } from "../links/types";
import { FRAME_ORIGINS } from "./frames";
import {
  decodeInstagram,
  decodeShell,
  decodeTikTok,
  decodeX,
  decodeYouTube,
  type EmbedEvent,
  type PlayerCommand,
  tiktokCommand,
  youtubeCommand,
  youtubeListening,
} from "./messages";

export type EmbedSource = Provider | "shell";

export interface EmbedConnection {
  /** Sends a playback command. A no-op for uncontrolled embeds. */
  send(command: PlayerCommand): void;
  disconnect(): void;
}

const DECODERS: Record<EmbedSource, (data: unknown) => EmbedEvent[]> = {
  youtube: decodeYouTube,
  tiktok: decodeTikTok,
  suno: () => [],
  instagram: decodeInstagram,
  x: decodeX,
  shell: decodeShell,
};

const HANDSHAKE_INTERVAL_MS = 250;
const HANDSHAKE_ATTEMPTS = 40;

/**
 * Connects the page to one embed frame. Messages are accepted only from that
 * frame's own window and, for provider frames, only from the provider's
 * origin. The embed shell runs at an opaque origin, which serializes as
 * "null", so it is matched by source window alone.
 */
export function connectEmbed(
  source: EmbedSource,
  frame: HTMLIFrameElement,
  handlers: {
    onEvent: (event: EmbedEvent) => void;
    /** Every accepted message, decoded or not. Used by the embed spike. */
    onMessage?: (data: unknown) => void;
  },
): EmbedConnection {
  const expectedOrigin = source === "shell" ? "null" : FRAME_ORIGINS[source];
  let replied = false;
  let handshake: ReturnType<typeof setInterval> | undefined;

  const post = (message: unknown) => {
    if (source === "shell") return;
    frame.contentWindow?.postMessage(message, expectedOrigin);
  };

  const onWindowMessage = (event: MessageEvent) => {
    if (event.source !== frame.contentWindow) return;
    if (event.origin !== expectedOrigin) return;
    replied = true;
    handlers.onMessage?.(event.data);
    for (const decoded of DECODERS[source](event.data)) {
      handlers.onEvent(decoded);
    }
  };

  const stopHandshake = () => {
    if (handshake !== undefined) clearInterval(handshake);
    handshake = undefined;
  };

  // YouTube stays silent until asked, and may not be ready when the frame's
  // load event fires, so keep asking for a few seconds.
  const startHandshake = () => {
    if (source !== "youtube") return;
    stopHandshake();
    let attempts = 0;
    handshake = setInterval(() => {
      attempts += 1;
      if (replied || attempts > HANDSHAKE_ATTEMPTS) return stopHandshake();
      post(youtubeListening());
    }, HANDSHAKE_INTERVAL_MS);
  };

  window.addEventListener("message", onWindowMessage);
  frame.addEventListener("load", startHandshake);
  startHandshake();

  return {
    send(command) {
      if (source === "youtube") post(youtubeCommand(command));
      if (source === "tiktok") post(tiktokCommand(command));
    },
    disconnect() {
      stopHandshake();
      window.removeEventListener("message", onWindowMessage);
      frame.removeEventListener("load", startHandshake);
    },
  };
}
