import type { Provider } from "../links/types";
import { FRAME_ORIGINS } from "./frames";
import {
  decodeReddit,
  decodeTikTok,
  decodeX,
  decodeYouTube,
  type EmbedEvent,
  PLAYER_COMMANDS,
  type PlayerCommand,
  tiktokCommand,
  youtubeCommand,
  youtubeListening,
} from "./messages";

export interface EmbedConnection {
  /** Sends a playback command. A no-op where the provider does not obey it. */
  send(command: PlayerCommand): void;
  disconnect(): void;
}

const DECODERS: Record<Provider, (data: unknown) => EmbedEvent[]> = {
  youtube: decodeYouTube,
  tiktok: decodeTikTok,
  suno: () => [],
  x: decodeX,
  reddit: decodeReddit,
};

const HANDSHAKE_INTERVAL_MS = 250;
const HANDSHAKE_ATTEMPTS = 40;

/**
 * Connects the page to one embed frame. Messages are accepted only from that
 * frame's own window and only from the provider's origin, and commands are
 * posted to that origin alone.
 */
export function connectEmbed(
  provider: Provider,
  frame: HTMLIFrameElement,
  handlers: {
    onEvent: (event: EmbedEvent) => void;
    /** Every accepted message, decoded or not. Used by the embed spike. */
    onMessage?: (data: unknown) => void;
  },
): EmbedConnection {
  const origin = FRAME_ORIGINS[provider];
  let replied = false;
  let handshake: ReturnType<typeof setInterval> | undefined;

  const post = (message: unknown) => {
    frame.contentWindow?.postMessage(message, origin);
  };

  const onWindowMessage = (event: MessageEvent) => {
    if (event.source !== frame.contentWindow) return;
    if (event.origin !== origin) return;
    replied = true;
    handlers.onMessage?.(event.data);
    for (const decoded of DECODERS[provider](event.data)) {
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
    if (provider !== "youtube") return;
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
      if (!PLAYER_COMMANDS[provider].includes(command)) return;
      if (provider === "youtube") post(youtubeCommand(command));
      if (provider === "tiktok") post(tiktokCommand(command));
    },
    disconnect() {
      stopHandshake();
      window.removeEventListener("message", onWindowMessage);
      frame.removeEventListener("load", startHandshake);
    },
  };
}
