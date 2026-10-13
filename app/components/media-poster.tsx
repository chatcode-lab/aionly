import { ArrowUpRight, Music, Play } from "lucide-react";

import { cn } from "~/lib/cn";
import type { Aspect, Provider } from "~/lib/links/types";

export const PROVIDER_LABEL: Record<Provider, string> = {
  youtube: "YouTube",
  tiktok: "TikTok",
  suno: "Suno",
  instagram: "Instagram",
  x: "X",
};

/** Outbound links never pass ranking credit and never get a window handle. */
export const OUTBOUND_REL = "nofollow ugc noopener";

function Thumb({ src }: { src?: string }) {
  if (!src) return null;
  return (
    <img
      src={src}
      alt=""
      loading="lazy"
      decoding="async"
      className="absolute inset-0 size-full object-cover"
    />
  );
}

function ProviderBadge({ provider }: { provider: Provider }) {
  return (
    <span className="absolute bottom-2 left-2 rounded-md bg-overlay px-2 py-0.5 text-meta font-medium text-on-overlay">
      {PROVIDER_LABEL[provider]}
    </span>
  );
}

function PlayGlyph() {
  return (
    <span className="absolute top-1/2 left-1/2 flex size-14 -translate-1/2 items-center justify-center rounded-full bg-overlay text-on-overlay transition-transform duration-150 group-hover:scale-105">
      <Play size={24} fill="currentColor" aria-hidden className="ml-0.5" />
    </span>
  );
}

/**
 * The stand-in for an embedded player. Every media card renders as a poster
 * with a fixed aspect ratio, so the feed never shifts, and a frame is mounted
 * only for the card in focus or on click.
 */
export function MediaPoster({
  provider,
  aspect,
  thumbUrl,
  onActivate,
}: {
  provider: Provider;
  aspect: Aspect;
  /** A first-party `/img/<key>` snapshot. */
  thumbUrl?: string;
  onActivate?: () => void;
}) {
  const name = PROVIDER_LABEL[provider];

  if (aspect === "audio") {
    return (
      <button
        type="button"
        onClick={onActivate}
        aria-label={`Play song from ${name}`}
        className="group flex w-full items-center gap-3 rounded-xl border border-border bg-surface-2 p-2 text-left"
      >
        <span className="relative flex size-16 shrink-0 items-center justify-center overflow-hidden rounded-lg bg-border text-text-faint">
          <Music size={22} aria-hidden />
          <Thumb src={thumbUrl} />
        </span>
        <span className="min-w-0 flex-1">
          <span className="block text-body font-medium">Play song</span>
          <span className="block text-meta text-text-muted">{name}</span>
        </span>
        <span className="mr-1 flex size-11 shrink-0 items-center justify-center rounded-full bg-accent-solid text-on-accent">
          <Play size={18} fill="currentColor" aria-hidden className="ml-0.5" />
        </span>
      </button>
    );
  }

  if (aspect === "post") {
    return (
      <button
        type="button"
        onClick={onActivate}
        className="group relative flex h-44 w-full items-center justify-center overflow-hidden rounded-xl border border-border bg-surface-2"
      >
        <Thumb src={thumbUrl} />
        <span className="relative rounded-lg bg-overlay px-3.5 py-2 text-body font-medium text-on-overlay">
          Load post from {name}
        </span>
      </button>
    );
  }

  const vertical = aspect === "9:16";
  return (
    <div
      className={cn(
        "overflow-hidden rounded-xl bg-surface-2",
        vertical && "flex justify-center",
      )}
    >
      <button
        type="button"
        onClick={onActivate}
        aria-label={`Play video from ${name}`}
        className={cn(
          "group relative block",
          vertical
            ? "aspect-[9/16] h-[min(70vh,35rem)] max-w-full"
            : "aspect-video w-full",
        )}
      >
        <Thumb src={thumbUrl} />
        <PlayGlyph />
        <ProviderBadge provider={provider} />
      </button>
    </div>
  );
}

/**
 * The card for apps, games, and any other URL. It opens the original in a new
 * tab. Without a snapshot image it collapses to a title/domain row.
 */
export function PreviewCard({
  url,
  host,
  pageTitle,
  thumbUrl,
}: {
  url: string;
  host: string;
  /** The page's own title from its metadata, when one was found. */
  pageTitle?: string;
  thumbUrl?: string;
}) {
  return (
    <a
      href={url}
      target="_blank"
      rel={OUTBOUND_REL}
      className="group block overflow-hidden rounded-xl border border-border bg-surface-2"
    >
      {thumbUrl ? (
        <span className="relative block aspect-[1200/630] w-full">
          <Thumb src={thumbUrl} />
        </span>
      ) : null}
      <span className="flex items-center gap-3 px-3 py-2.5">
        <span className="min-w-0 flex-1">
          {pageTitle ? (
            <span className="block truncate text-body font-medium group-hover:underline">
              {pageTitle}
            </span>
          ) : null}
          <span className="block truncate text-meta text-text-muted">
            {host}
          </span>
        </span>
        <ArrowUpRight
          size={18}
          aria-hidden
          className="shrink-0 text-text-faint"
        />
      </span>
    </a>
  );
}
