import type { MediaLink, Provider } from "../links/types";

/**
 * The only origins an embed frame may load from. The Content Security Policy
 * and the frame URL builder both read this table, so they cannot drift apart.
 */
export const FRAME_ORIGINS: Record<Provider, string> = {
  youtube: "https://www.youtube-nocookie.com",
  tiktok: "https://www.tiktok.com",
  suno: "https://suno.com",
  instagram: "https://www.instagram.com",
  x: "https://platform.twitter.com",
};

/** Providers with a script-based fallback that runs inside the embed shell. */
export const SHELL_PROVIDERS = ["x", "instagram"] as const;
export type ShellProvider = (typeof SHELL_PROVIDERS)[number];

export function isShellProvider(value: string): value is ShellProvider {
  return (SHELL_PROVIDERS as readonly string[]).includes(value);
}

export const SHELL_PATH_PREFIX = "/embed/shell/";

export function shellPath(provider: ShellProvider, id: string): string {
  return `${SHELL_PATH_PREFIX}${provider}/${encodeURIComponent(id)}`;
}

export interface FrameOptions {
  /** The embedding page's origin, which YouTube requires for `postMessage`. */
  siteOrigin: string;
  theme: "light" | "dark";
  /**
   * Start playing as the frame loads: "muted" for the card in focus, "sound"
   * after a tap on the poster. Controlled players only. TikTok's player does
   * not answer commands until it has started, so it is always mounted with
   * one of these.
   */
  autoplay?: "muted" | "sound";
}

/**
 * Builds the frame URL for a media link from its validated provider ID. IDs
 * are checked against strict patterns when the link is resolved, and are
 * encoded again here so this stays safe if a caller constructs one by hand.
 */
export function frameUrl(link: MediaLink, options: FrameOptions): string {
  const id = encodeURIComponent(link.id);
  const origin = FRAME_ORIGINS[link.provider];

  switch (link.provider) {
    case "youtube": {
      const params = new URLSearchParams({
        enablejsapi: "1",
        origin: options.siteOrigin,
        playsinline: "1",
        rel: "0",
      });
      if (options.autoplay) params.set("autoplay", "1");
      if (options.autoplay === "muted") params.set("mute", "1");
      return `${origin}/embed/${id}?${params}`;
    }
    case "tiktok": {
      const params = new URLSearchParams({
        controls: "1",
        rel: "0",
        music_info: "0",
        description: "0",
      });
      if (options.autoplay) params.set("autoplay", "1");
      if (options.autoplay === "muted") params.set("muted", "1");
      return `${origin}/player/v1/${id}?${params}`;
    }
    case "suno":
      return `${origin}/embed/${id}`;
    case "instagram":
      return `${origin}/p/${id}/embed/`;
    case "x": {
      const params = new URLSearchParams({
        id: link.id,
        theme: options.theme,
        dnt: "true",
      });
      return `${origin}/embed/Tweet.html?${params}`;
    }
  }
}

/**
 * Sandbox for provider frames. `allow-same-origin` keeps the provider's own
 * origin inside its frame, which players need for storage and playback; it
 * grants nothing on ours. `allow-top-navigation` is left out so an embed can
 * never redirect the page.
 */
export const FRAME_SANDBOX =
  "allow-scripts allow-same-origin allow-popups allow-popups-to-escape-sandbox allow-presentation";

/** Sandbox for the embed shell, which must stay at an opaque origin. */
export const SHELL_SANDBOX =
  "allow-scripts allow-popups allow-popups-to-escape-sandbox";

export const FRAME_ALLOW =
  "autoplay; encrypted-media; fullscreen; picture-in-picture";
