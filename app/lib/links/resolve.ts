import type { MediaLink, PageLink, Provider, ResolvedLink } from "./types";
import { canonicalizePageUrl, displayHost, normalizeHost } from "./url";

const YOUTUBE_ID = /^[A-Za-z0-9_-]{11}$/;
const TIKTOK_ID = /^\d{8,25}$/;
const SUNO_ID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const X_ID = /^\d{1,20}$/;
const REDDIT_ID = /^[a-z0-9]{2,10}$/;
const REDDIT_COMMUNITY = /^[A-Za-z0-9_]{2,21}$/;
const REDDIT_USER = /^[A-Za-z0-9_-]{3,20}$/;
const TELEGRAM_CHANNEL = /^[A-Za-z][A-Za-z0-9_]{3,31}$/;
const TELEGRAM_POST = /^\d{1,10}$/;

function segments(url: URL): string[] {
  return url.pathname.split("/").filter(Boolean);
}

function media(
  provider: Provider,
  id: string,
  rest: Pick<MediaLink, "aspect" | "controlled" | "embedPath">,
): MediaLink {
  return {
    kind: "media",
    provider,
    id,
    canonicalKey: `${provider}:${id}`,
    ...rest,
  };
}

function youtube(url: URL, host: string): ResolvedLink | null {
  const parts = segments(url);
  let id: string | undefined;
  let short = false;

  if (host === "youtu.be") {
    id = parts[0];
  } else if (parts[0] === "watch") {
    id = url.searchParams.get("v") ?? undefined;
  } else if (parts[0] === "shorts") {
    id = parts[1];
    short = true;
  } else if (parts[0] === "embed" || parts[0] === "live" || parts[0] === "v") {
    id = parts[1];
  }

  if (!id || !YOUTUBE_ID.test(id)) return null;
  return media("youtube", id, {
    aspect: short ? "9:16" : "16:9",
    controlled: true,
  });
}

function tiktok(url: URL, host: string): ResolvedLink | null {
  const parts = segments(url);

  if (host === "vm.tiktok.com" || host === "vt.tiktok.com" || parts[0] === "t") {
    return parts.length > 0
      ? { kind: "short", provider: "tiktok", url: url.href }
      : null;
  }

  let id: string | undefined;
  if (parts[0]?.startsWith("@") && (parts[1] === "video" || parts[1] === "photo")) {
    id = parts[2];
  } else if (parts[0] === "v") {
    id = parts[1]?.replace(/\.html$/, "");
  } else if (parts[0] === "embed" || parts[0] === "player") {
    id = parts[2];
  }

  if (!id || !TIKTOK_ID.test(id)) return null;
  return media("tiktok", id, {
    aspect: "9:16",
    controlled: true,
  });
}

function suno(url: URL): ResolvedLink | null {
  const parts = segments(url);

  if (parts[0] === "s" && parts[1]) {
    return { kind: "short", provider: "suno", url: url.href };
  }

  const id = parts[0] === "song" || parts[0] === "embed" ? parts[1] : undefined;
  if (!id || !SUNO_ID.test(id)) return null;
  const normalized = id.toLowerCase();
  return media("suno", normalized, {
    aspect: "audio",
    controlled: false,
  });
}

function x(url: URL): ResolvedLink | null {
  const parts = segments(url);
  const statusAt = parts.findIndex(
    (part) => part === "status" || part === "statuses",
  );
  // /<handle>/status/<id>, /i/status/<id>, or /i/web/status/<id>
  if (statusAt < 1 || statusAt > 2) return null;

  const id = parts[statusAt + 1];
  if (!id || !X_ID.test(id)) return null;
  return media("x", id, {
    aspect: "post",
    controlled: false,
  });
}

function reddit(url: URL, host: string): ResolvedLink | null {
  const parts = segments(url);
  const short: ResolvedLink = { kind: "short", provider: "reddit", url: url.href };

  // redd.it/<id> names a post without its community.
  if (host === "redd.it") return parts.length === 1 ? short : null;
  // So do /comments/<id>, /gallery/<id>, and /r/<name>/s/<code> share links.
  if (parts[0] === "comments" || parts[0] === "gallery") {
    return parts[1] ? short : null;
  }
  if (parts[0] === "r" && parts[2] === "s") return parts[3] ? short : null;

  const [kind, name, section, rawId] = parts;
  if (section !== "comments" || !name || !rawId) return null;

  const id = rawId.toLowerCase();
  if (!REDDIT_ID.test(id)) return null;

  let scope: string;
  if (kind === "r" && REDDIT_COMMUNITY.test(name)) {
    scope = `r/${name}`;
  } else if ((kind === "user" || kind === "u") && REDDIT_USER.test(name)) {
    scope = `user/${name}`;
  } else {
    return null;
  }

  // A comment permalink resolves to its post: the board links to posts.
  return media("reddit", id, {
    aspect: "post",
    controlled: false,
    embedPath: `${scope}/comments/${id}`,
  });
}

function telegram(url: URL): ResolvedLink | null {
  const parts = segments(url);
  // t.me/s/<channel>/<post> is the same post on the web preview page.
  const [channel, post, ...rest] = parts[0] === "s" ? parts.slice(1) : parts;

  // Only posts in public channels can be embedded. Private channels
  // (/c/<id>/<post>), group topics, and invite links stay ordinary pages.
  if (rest.length > 0 || !channel || !post) return null;
  if (!TELEGRAM_CHANNEL.test(channel) || !TELEGRAM_POST.test(post)) return null;

  // Channel names are case-insensitive.
  return media("telegram", `${channel.toLowerCase()}/${post}`, {
    aspect: "post",
    controlled: false,
  });
}

const HOSTS: Record<string, (url: URL, host: string) => ResolvedLink | null> = {
  "youtube.com": youtube,
  "m.youtube.com": youtube,
  "music.youtube.com": youtube,
  "youtube-nocookie.com": youtube,
  "youtu.be": youtube,
  "tiktok.com": tiktok,
  "m.tiktok.com": tiktok,
  "vm.tiktok.com": tiktok,
  "vt.tiktok.com": tiktok,
  "suno.com": suno,
  "suno.ai": suno,
  "app.suno.ai": suno,
  "x.com": x,
  "mobile.x.com": x,
  "twitter.com": x,
  "mobile.twitter.com": x,
  "reddit.com": reddit,
  "old.reddit.com": reddit,
  "new.reddit.com": reddit,
  "np.reddit.com": reddit,
  "m.reddit.com": reddit,
  "sh.reddit.com": reddit,
  "redd.it": reddit,
  "t.me": telegram,
  "telegram.me": telegram,
};

function page(url: URL): PageLink {
  const clean = new URL(url.href);
  clean.hash = "";
  return {
    kind: "page",
    canonicalKey: `url:${canonicalizePageUrl(url)}`,
    url: clean.href,
    host: displayHost(url),
  };
}

/**
 * Classifies a validated URL. Supported providers resolve to their own ID, so
 * every spelling of the same video or post shares one canonical key. Provider
 * URLs that are not a single piece of media, such as channels and profiles,
 * fall through to an ordinary page link.
 */
export function resolveLink(url: URL): ResolvedLink {
  const host = normalizeHost(url.hostname).replace(/^www\./, "");
  const handler = HOSTS[host];
  return handler?.(url, host) ?? page(url);
}

/**
 * The address to store for a provider's media: the provider's plain address
 * for it, without share codes or tracking. Every spelling of a link stores
 * the same address.
 */
export function mediaUrl(link: MediaLink, url: URL): string {
  switch (link.provider) {
    case "youtube":
      return link.aspect === "9:16"
        ? `https://www.youtube.com/shorts/${link.id}`
        : `https://www.youtube.com/watch?v=${link.id}`;
    case "suno":
      return `https://suno.com/song/${link.id}`;
    case "reddit":
      return `https://www.reddit.com/${link.embedPath}/`;
    case "telegram":
      return `https://t.me/${link.id}`;
    case "tiktok":
    case "x": {
      // The path names the account as well as the ID; keep it, minus the query.
      const clean = new URL(url.href);
      clean.search = "";
      clean.hash = "";
      return clean.href;
    }
  }
}
