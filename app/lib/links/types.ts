export const PROVIDERS = ["youtube", "tiktok", "suno", "instagram", "x"] as const;

export type Provider = (typeof PROVIDERS)[number];

export type Aspect = "16:9" | "9:16" | "post" | "audio";

/** A link to media on a supported provider, identified by the provider's own ID. */
export interface MediaLink {
  kind: "media";
  provider: Provider;
  id: string;
  /** `provider:id`, the uniqueness key for duplicate detection. */
  canonicalKey: string;
  aspect: Aspect;
  /** Controlled players accept play, pause, and mute commands from the page. */
  controlled: boolean;
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
