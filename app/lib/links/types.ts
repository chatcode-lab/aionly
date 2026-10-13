export const PROVIDERS = [
  "youtube",
  "tiktok",
  "suno",
  "x",
  "reddit",
  "telegram",
] as const;

export type Provider = (typeof PROVIDERS)[number];

export const PROVIDER_LABEL: Record<Provider, string> = {
  youtube: "YouTube",
  tiktok: "TikTok",
  suno: "Suno",
  x: "X",
  reddit: "Reddit",
  telegram: "Telegram",
};

export type Aspect = "16:9" | "9:16" | "post" | "audio";

/** A link to media on a supported provider, identified by the provider's own ID. */
export interface MediaLink {
  kind: "media";
  provider: Provider;
  id: string;
  /** `provider:id`, the uniqueness key for duplicate detection. */
  canonicalKey: string;
  aspect: Aspect;
  /** Controlled players accept playback commands from the page. */
  controlled: boolean;
  /**
   * The provider path a frame needs when the ID alone is not enough. Reddit
   * addresses a post under its community: `r/<name>/comments/<id>`.
   */
  embedPath?: string;
}

/** Any other public page, shown as a preview card. */
export interface PageLink {
  kind: "page";
  canonicalKey: string;
  url: string;
  host: string;
}

/**
 * A provider short link whose target ID is only known after following its
 * redirect. The Check link step resolves it server-side and parses the result.
 */
export interface ShortLink {
  kind: "short";
  provider: Provider;
  url: string;
}

export type ResolvedLink = MediaLink | PageLink | ShortLink;

export type UrlRejection =
  | "empty"
  | "too_long"
  | "invalid"
  | "not_https"
  | "credentials"
  | "port"
  | "host_not_public"
  | "own_host";

export type ParsedUrl =
  | { ok: true; url: URL }
  | { ok: false; reason: UrlRejection };
