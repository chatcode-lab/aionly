import { ArrowUpRight, Music, Play, X } from "lucide-react";
import { Dialog } from "radix-ui";
import { useState } from "react";

import { cn } from "~/lib/cn";
import { formatDuration } from "~/lib/format";
import { type Aspect, PROVIDER_LABEL, type Provider } from "~/lib/links/types";

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

function Badge({
  side,
  children,
}: {
  side: "left" | "right";
  children: string;
}) {
  return (
    <span
      className={cn(
        "absolute bottom-2 rounded-md bg-overlay px-2 py-0.5 text-meta font-medium text-on-overlay tabular-nums",
        side === "left" ? "left-2" : "right-2",
      )}
    >
      {children}
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
 * The stand-in for a player. Every media card renders as a poster with a
 * fixed shape, so the feed never shifts when a frame loads in its place near
 * the screen or on a tap. With a provider it stands in for that provider's
 * embed; without one it stands in for media hosted by the board.
 */
export function MediaPoster({
  provider,
  aspect,
  thumbUrl,
  duration,
  height,
  onActivate,
}: {
  provider?: Provider;
  aspect: Aspect;
  /** A first-party `/img/<key>` snapshot. */
  thumbUrl?: string;
  /** Length in seconds, when known. */
  duration?: number;
  /** For a post embed or a song player, the height to reserve: the embed's own. */
  height?: number;
  onActivate?: () => void;
}) {
  const name = provider ? PROVIDER_LABEL[provider] : undefined;
  const length = duration === undefined ? undefined : formatDuration(duration);

  if (aspect === "audio") {
    // A provider's song player has a fixed height, which its poster keeps,
    // with the cover filling it the way the player shows it.
    const tall = height !== undefined;
    return (
      <button
        type="button"
        onClick={onActivate}
        aria-label={name ? `Play song from ${name}` : "Play audio"}
        style={tall ? { height } : undefined}
        className={cn(
          "group flex w-full items-center rounded-xl border border-border bg-surface-2 text-left",
          tall ? "@container gap-4 p-4" : "gap-3 p-2",
        )}
      >
        <span
          className={cn(
            "relative flex shrink-0 items-center justify-center overflow-hidden rounded-lg bg-border text-text-faint",
            // Like the player, the cover gives way in a narrow column.
            tall ? "aspect-square h-full @max-[20rem]:hidden" : "size-16",
          )}
        >
          <Music size={22} aria-hidden />
          <Thumb src={thumbUrl} />
        </span>
        <span className="min-w-0 flex-1">
          <span className="block text-body font-medium">
            {name ? "Play song" : "Play audio"}
          </span>
          <span className="block text-meta text-text-muted tabular-nums">
            {[name, length].filter(Boolean).join(" · ")}
          </span>
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
        style={{ height: height ?? 176 }}
        className="group relative flex w-full items-center justify-center overflow-hidden rounded-xl border border-border bg-surface-2"
      >
        <Thumb src={thumbUrl} />
        <span className="relative rounded-lg bg-overlay px-3.5 py-2 text-body font-medium text-on-overlay">
          Load post{name ? ` from ${name}` : ""}
        </span>
      </button>
    );
  }

  const vertical = aspect === "9:16";
  return (
    // A vertical poster is centered at its own width, exactly where the
    // player will be, with no box around it.
    <div className="flex justify-center">
      <button
        type="button"
        onClick={onActivate}
        aria-label={name ? `Play video from ${name}` : "Play video"}
        className={cn(
          "group relative block overflow-hidden rounded-xl bg-surface-2",
          vertical ? "aspect-[9/16] w-full max-w-80" : "aspect-video w-full",
        )}
      >
        <Thumb src={thumbUrl} />
        <PlayGlyph />
        {name ? <Badge side="left">{name}</Badge> : null}
        {length ? <Badge side="right">{length}</Badge> : null}
      </button>
    </div>
  );
}

/**
 * A picture the board hosts, in its own shape, capped in height. A tap
 * opens it as large as the screen allows, on its own, and a tap anywhere,
 * Escape, or Close shuts it.
 */
export function UploadedImage({
  src,
  width,
  height,
  alt,
}: {
  src: string;
  width: number;
  height: number;
  alt: string;
}) {
  const [open, setOpen] = useState(false);
  return (
    <Dialog.Root open={open} onOpenChange={setOpen}>
      <div className="flex justify-center overflow-hidden rounded-xl bg-surface-2">
        <Dialog.Trigger asChild>
          <button type="button" aria-label={`See the picture full size: ${alt}`} className="block cursor-zoom-in">
            <img
              src={src}
              width={width}
              height={height}
              alt={alt}
              loading="lazy"
              decoding="async"
              className="h-auto max-h-[min(70vh,35rem)] w-auto max-w-full object-contain"
            />
          </button>
        </Dialog.Trigger>
      </div>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-50 bg-black/90" />
        <Dialog.Content
          aria-describedby={undefined}
          onClick={() => setOpen(false)}
          className="fixed inset-0 z-50 flex cursor-zoom-out items-center justify-center p-2 sm:p-6"
        >
          <Dialog.Title className="sr-only">{alt}</Dialog.Title>
          <img src={src} width={width} height={height} alt={alt} className="max-h-full max-w-full object-contain" />
          <Dialog.Close
            aria-label="Close"
            className="absolute top-3 right-3 inline-flex size-10 items-center justify-center rounded-full bg-black/50 text-white hover:bg-black/70"
          >
            <X size={20} aria-hidden />
          </Dialog.Close>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
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
