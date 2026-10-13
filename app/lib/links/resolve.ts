import type { MediaLink, PageLink, Provider, ResolvedLink } from "./types";
import { canonicalizePageUrl, displayHost, normalizeHost } from "./url";

const YOUTUBE_ID = /^[A-Za-z0-9_-]{11}$/;
const TIKTOK_ID = /^\d{8,25}$/;
const SUNO_ID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const INSTAGRAM_CODE = /^[A-Za-z0-9_-]{1,40}$/;
const X_ID = /^\d{1,20}$/;

function segments(url: URL): string[] {
  return url.pathname.split("/").filter(Boolean);
}

function media(
  provider: Provider,
  id: string,
  rest: Pick<MediaLink, "aspect" | "controlled">,
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

function instagram(url: URL): ResolvedLink | null {
  const parts = segments(url);
  // Share links may carry the author's handle first: /<handle>/p/<code>/.
  const offset = ["p", "reel", "reels", "tv"].includes(parts[0] ?? "") ? 0 : 1;
  const type = parts[offset];
  const code = parts[offset + 1];

  if (!type || !["p", "reel", "reels", "tv"].includes(type)) return null;
  if (!code || !INSTAGRAM_CODE.test(code)) return null;

  const reel = type === "reel" || type === "reels";
  return media("instagram", code, {
    aspect: reel ? "9:16" : "post",
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
  "instagram.com": instagram,
  "m.instagram.com": instagram,
  "x.com": x,
  "mobile.x.com": x,
  "twitter.com": x,
  "mobile.twitter.com": x,
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
