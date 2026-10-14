import type { MediaLink, Provider } from "../links/types";

/**
 * The only origins an embed frame may load from. The Content Security Policy
 * and the frame URL builder both read this table, so they cannot drift apart.
 */
export const FRAME_ORIGINS: Record<Provider, string> = {
  youtube: "https://www.youtube-nocookie.com",
  tiktok: "https://www.tiktok.com",
  suno: "https://suno.com",
  x: "https://platform.twitter.com",
  reddit: "https://embed.reddit.com",
  telegram: "https://t.me",
};

// The only shape `resolveLink` produces for a Reddit post.
const REDDIT_EMBED_PATH =
  /^(?:r|user)\/[A-Za-z0-9_-]{1,32}\/comments\/[a-z0-9]{1,12}$/;

const TELEGRAM_POST_ID = /^[a-z][a-z0-9_]{3,31}\/\d{1,10}$/;

export interface FrameOptions {
  /** The embedding page's origin, which YouTube requires for `postMessage`. */
  siteOrigin: string;
  /** The site's color scheme in effect, passed on where a provider has themes. */
  theme: "light" | "dark";
  /**
   * Start playing as the frame loads: "muted" for the card in focus, "sound"
   * after a tap on the poster. Controlled players only.
   */
  autoplay?: "muted" | "sound";
}

/**
 * Builds the frame URL for a media link from its validated provider ID. Each
 * provider gets its most minimal presentation and, where it has one, the
 * theme matching the site. IDs are checked against strict patterns when the
 * link is resolved, and are encoded again here so this stays safe if a caller
 * constructs one by hand.
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
        iv_load_policy: "3",
      });
      if (options.autoplay) params.set("autoplay", "1");
      if (options.autoplay === "muted") params.set("mute", "1");
      return `${origin}/embed/${id}?${params}`;
    }
    case "tiktok": {
      // The player sends nothing and ignores commands unless it is mounted
      // playing, so it always autoplays. It starts muted by itself. Its
      // `muted` parameter is left out on purpose: that one also locks the
      // volume, so the viewer could never turn the sound on.
      const params = new URLSearchParams({
        autoplay: "1",
        controls: "1",
        rel: "0",
        music_info: "0",
        description: "0",
      });
      return `${origin}/player/v1/${id}?${params}`;
    }
    case "suno":
      return `${origin}/embed/${id}?theme=${options.theme}`;
    case "x": {
      const params = new URLSearchParams({
        id: link.id,
        theme: options.theme,
        dnt: "true",
        hideThread: "true",
      });
      return `${origin}/embed/Tweet.html?${params}`;
    }
    case "reddit": {
      // "subreddit-first" is Reddit's compact layout. Light is its default;
      // "dark" is the only theme value it accepts.
      const params = new URLSearchParams({
        embed: "true",
        style: "subreddit-first",
      });
      if (options.theme === "dark") params.set("theme", "dark");
      // Anything but a well-formed path, such as one with dot segments, is
      // replaced by the post ID alone rather than passed through.
      const path =
        link.embedPath && REDDIT_EMBED_PATH.test(link.embedPath)
          ? link.embedPath
          : `comments/${id}`;
      return `${origin}/${path}/?${params}`;
    }
    case "telegram": {
      // The ID is `<channel>/<post>`. Without the author picture the post is
      // one compact bubble. Light is the default; `dark=1` switches it.
      const params = new URLSearchParams({ embed: "1", userpic: "false" });
      if (options.theme === "dark") params.set("dark", "1");
      const path = TELEGRAM_POST_ID.test(link.id) ? link.id : id;
      return `${origin}/${path}?${params}`;
    }
  }
}

/** How a provider's frame sits in the column. */
export interface FrameLayout {
  /** Post embeds stop growing at the provider's own width and are centered. */
  maxWidth?: number;
  /**
   * The narrowest width the provider lays out for. In a narrower column the
   * frame keeps this width and is scaled down to fit, rather than cropped.
   */
  minWidth?: number;
  /** The height to reserve until the embed reports its own. */
  initialHeight?: number;
  /**
   * True when the embed draws its own outline right up to the frame's edge.
   * Rounding the frame would clip it, as it did the tail of Telegram's bubble.
   */
  ownOutline?: boolean;
  /**
   * True when the embed reports its height. Its frame then never scrolls
   * inside: the provider's own script does the same, since the report can
   * fall a few pixels short of the document.
   */
  selfSizing?: boolean;
  /**
   * True when the provider's document is transparent and never declares a
   * dark color scheme. A browser paints an opaque white backdrop behind such
   * a frame on a dark page unless the frame element is itself marked light.
   */
  lightScheme?: boolean;
}

export const FRAME_LAYOUT: Record<Provider, FrameLayout> = {
  youtube: {},
  tiktok: {},
  suno: { initialHeight: 240 },
  x: { maxWidth: 550, initialHeight: 320, selfSizing: true, lightScheme: true },
  reddit: { maxWidth: 640, initialHeight: 420, selfSizing: true },
  telegram: {
    maxWidth: 500,
    minWidth: 320,
    initialHeight: 300,
    selfSizing: true,
    ownOutline: true,
  },
};

/**
 * Sandbox for provider frames. `allow-same-origin` keeps the provider's own
 * origin inside its frame, which players need for storage and playback; it
 * grants nothing on ours. `allow-top-navigation` is left out so an embed can
 * never redirect the page.
 */
export const FRAME_SANDBOX =
  "allow-scripts allow-same-origin allow-popups allow-popups-to-escape-sandbox allow-presentation";

export const FRAME_ALLOW =
  "autoplay; encrypted-media; fullscreen; picture-in-picture";
