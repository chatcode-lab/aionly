import type { Provider } from "../links/types";

/**
 * Message formats for talking to embed frames. Only TikTok's is documented by
 * the provider. The YouTube, X, Reddit, and Telegram formats are the ones
 * their own scripts use on the wire, confirmed against the live frames in
 * the embed spike. Every decoder ignores anything it does not recognize.
 */

export type PlayerState =
  | "unstarted"
  | "playing"
  | "paused"
  | "buffering"
  | "ended";

export type EmbedEvent =
  | { type: "ready" }
  | { type: "state"; state: PlayerState }
  | { type: "muted"; muted: boolean }
  | { type: "error"; detail: string }
  /** The browser would not start it without a tap inside it; its own play button stays. */
  | { type: "refused" }
  | { type: "height"; height: number };

export type PlayerCommand = "play" | "pause" | "mute" | "unmute";

/**
 * The commands each provider's player obeys. TikTok's accepts mute and unmute
 * messages but then restores its own state, so sound there is left to the
 * player's own volume button. Uncontrolled embeds take no commands.
 */
export const PLAYER_COMMANDS: Record<Provider, readonly PlayerCommand[]> = {
  youtube: ["play", "pause", "mute", "unmute"],
  tiktok: ["play", "pause"],
  suno: [],
  soundcloud: [],
  x: [],
  reddit: [],
  telegram: [],
};

const MAX_FRAME_HEIGHT = 5000;

function parseObject(data: unknown): Record<string, unknown> | null {
  let value = data;
  if (typeof value === "string") {
    try {
      value = JSON.parse(value);
    } catch {
      return null;
    }
  }
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function heightEvent(value: unknown): EmbedEvent[] {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    return [];
  }
  return [{ type: "height", height: Math.min(Math.ceil(value), MAX_FRAME_HEIGHT) }];
}

const PLAYER_STATES: Record<number, PlayerState> = {
  [-1]: "unstarted",
  0: "ended",
  1: "playing",
  2: "paused",
  3: "buffering",
};

function stateEvent(value: unknown): EmbedEvent[] {
  const state = typeof value === "number" ? PLAYER_STATES[value] : undefined;
  return state ? [{ type: "state", state }] : [];
}

// YouTube

/** Asks the player to start sending events. Sent until it first replies. */
export function youtubeListening(): string {
  return JSON.stringify({ event: "listening", id: 1, channel: "widget" });
}

const YOUTUBE_FUNCTIONS: Record<PlayerCommand, string> = {
  play: "playVideo",
  pause: "pauseVideo",
  mute: "mute",
  unmute: "unMute",
};

export function youtubeCommand(command: PlayerCommand): string {
  return JSON.stringify({
    event: "command",
    func: YOUTUBE_FUNCTIONS[command],
    args: [],
    id: 1,
    channel: "widget",
  });
}

export function decodeYouTube(data: unknown): EmbedEvent[] {
  const message = parseObject(data);
  if (!message) return [];

  switch (message.event) {
    case "onReady":
    case "initialDelivery":
      return [{ type: "ready" }];
    case "onStateChange":
      return stateEvent(message.info);
    case "onError":
      return [{ type: "error", detail: String(message.info) }];
    case "infoDelivery": {
      const info = parseObject(message.info);
      if (!info) return [];
      return [
        ...stateEvent(info.playerState),
        ...(typeof info.muted === "boolean"
          ? [{ type: "muted", muted: info.muted } as const]
          : []),
      ];
    }
    default:
      return [];
  }
}

// TikTok, per https://developers.tiktok.com/doc/embed-player

const TIKTOK_TYPES: Record<PlayerCommand, string> = {
  play: "play",
  pause: "pause",
  mute: "mute",
  unmute: "unMute",
};

export function tiktokCommand(command: PlayerCommand): Record<string, unknown> {
  return { "x-tiktok-player": true, type: TIKTOK_TYPES[command], value: undefined };
}

export function decodeTikTok(data: unknown): EmbedEvent[] {
  const message = parseObject(data);
  if (!message || message["x-tiktok-player"] !== true) return [];

  switch (message.type) {
    case "onPlayerReady":
      return [{ type: "ready" }];
    case "onStateChange":
      return stateEvent(message.value);
    case "onMute":
      return typeof message.value === "boolean"
        ? [{ type: "muted", muted: message.value }]
        : [];
    case "onPlayerError": {
      const error = parseObject(message.value);
      // Autoplay refused, as on an iPhone in Low Power Mode: the player shows
      // its poster and play button, and plays from a tap on it.
      if (error?.errorCode === 3002 || error?.errorType === "AUTOPLAY_ERROR") return [{ type: "refused" }];
      return [
        {
          type: "error",
          detail: error
            ? `${String(error.errorCode)} ${String(error.errorType)}`
            : "unknown",
        },
      ];
    }
    default:
      return [];
  }
}

// X: the post frame reports its height so the parent can size it.

export function decodeX(data: unknown): EmbedEvent[] {
  const embed = parseObject(parseObject(data)?.["twttr.embed"]);
  if (!embed || embed.method !== "twttr.private.resize") return [];
  const params = Array.isArray(embed.params) ? embed.params : [];
  return heightEvent(parseObject(params[0])?.height);
}

// Reddit: the post frame reports its height the same way.

export function decodeReddit(data: unknown): EmbedEvent[] {
  const message = parseObject(data);
  if (!message || message.type !== "resize.embed") return [];
  return heightEvent(message.data);
}

// Telegram: the post frame reports its height too. It also asks its host to
// scroll the page or report coordinates; those requests are never honored.

export function decodeTelegram(data: unknown): EmbedEvent[] {
  const message = parseObject(data);
  if (!message || message.event !== "resize") return [];
  return heightEvent(message.height);
}
