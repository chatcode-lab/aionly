import { ArrowUpRight, ChevronLeft, ChevronRight, Music, Play, X } from "lucide-react";
import { Dialog } from "radix-ui";
import { useRef, useState } from "react";

import { cn } from "~/lib/cn";
import { formatDuration } from "~/lib/format";
import { type PictureView, pictureAlt } from "~/lib/gallery";
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

/** How tall a post's picture or gallery may stand: the frame keeps its shape below this. */
const PICTURE_CAP = "min(70vh, 35rem)";

/**
 * A picture the board hosts, in its own shape, capped in height, or a
 * gallery of them (`pictures`): one frame in its cover's shape, swiped or
 * stepped through, with a count in a corner. A tap opens the picture as
 * large as the screen allows, a gallery to step through there too; a tap
 * anywhere else, Escape, or Close shuts it.
 */
export function UploadedImage({
  src,
  width,
  height,
  alt,
  pictures,
}: {
  src: string;
  width: number;
  height: number;
  alt: string;
  pictures?: PictureView[];
}) {
  const all = pictures && pictures.length > 1 ? pictures : [{ src, width, height }];
  const [open, setOpen] = useState<number | null>(null);
  return (
    <Dialog.Root open={open !== null} onOpenChange={(next) => setOpen(next ? 0 : null)}>
      {all.length > 1 ? (
        <GalleryFrame pictures={all} alt={alt} onOpen={setOpen} />
      ) : (
        <div className="flex justify-center overflow-hidden rounded-xl bg-surface-2">
          <button type="button" aria-label={`See the picture full size: ${alt}`} className="block cursor-zoom-in" onClick={() => setOpen(0)}>
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
        </div>
      )}
      {open !== null ? <FullSize pictures={all} alt={alt} index={open} onStep={setOpen} onClose={() => setOpen(null)} /> : null}
    </Dialog.Root>
  );
}

/**
 * A gallery in the feed or on its post: the pictures side by side in a
 * frame of the cover's shape, each fitted inside it, snapping into place as
 * they are swiped, with previous and next where a pointer can hover.
 */
function GalleryFrame({ pictures, alt, onOpen }: { pictures: PictureView[]; alt: string; onOpen: (index: number) => void }) {
  const strip = useRef<HTMLDivElement>(null);
  const [current, setCurrent] = useState(0);
  // The furthest picture seen: it and the one after it load, the rest wait (review F90).
  const [reached, setReached] = useState(0);
  const cover = pictures[0]!;
  const step = (by: -1 | 1) => {
    const element = strip.current;
    if (element) element.scrollTo({ left: (current + by) * element.clientWidth, behavior: "smooth" });
  };
  return (
    <div
      role="group"
      aria-roledescription="gallery"
      aria-label={alt}
      className="relative mx-auto w-full overflow-hidden rounded-xl bg-surface-2"
      // The cover's shape, never taller than a picture may stand.
      style={{ aspectRatio: `${cover.width} / ${cover.height}`, maxWidth: `calc(${PICTURE_CAP} * ${cover.width / cover.height})` }}
    >
      <div
        ref={strip}
        onScroll={(event) => {
          const element = event.currentTarget;
          const at = Math.round(element.scrollLeft / Math.max(element.clientWidth, 1));
          setCurrent(at);
          setReached((was) => Math.max(was, at));
        }}
        className="flex size-full snap-x snap-mandatory overflow-x-auto overscroll-x-contain [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
      >
        {pictures.map((picture, index) => (
          <button
            key={picture.src}
            type="button"
            aria-label={`See the picture full size: ${pictureAlt(alt, index, pictures.length)}`}
            onClick={() => onOpen(index)}
            className="size-full shrink-0 cursor-zoom-in snap-center"
          >
            {index <= reached + 1 ? (
              <img
                src={picture.src}
                width={picture.width}
                height={picture.height}
                alt={pictureAlt(alt, index, pictures.length)}
                // The first loads with the page; the next as it comes near.
                loading={index === 0 ? undefined : "lazy"}
                decoding="async"
                className="size-full object-contain"
              />
            ) : null}
          </button>
        ))}
      </div>
      <span
        aria-live="polite"
        className="pointer-events-none absolute top-2 right-2 rounded-full bg-overlay px-2 py-0.5 text-meta font-medium text-on-overlay tabular-nums"
      >
        {current + 1} / {pictures.length}
      </span>
      {current > 0 ? (
        <StepButton side="left" label="Previous picture" onClick={() => step(-1)} />
      ) : null}
      {current < pictures.length - 1 ? (
        <StepButton side="right" label="Next picture" onClick={() => step(1)} />
      ) : null}
    </div>
  );
}

function StepButton({ side, label, onClick }: { side: "left" | "right"; label: string; onClick: () => void }) {
  return (
    <button
      type="button"
      aria-label={label}
      onClick={(event) => {
        event.stopPropagation();
        onClick();
      }}
      className={cn(
        "absolute top-1/2 inline-flex size-9 -translate-y-1/2 items-center justify-center rounded-full bg-overlay text-on-overlay hover:bg-scrim pointer-coarse:hidden",
        side === "left" ? "left-2" : "right-2",
      )}
    >
      {side === "left" ? <ChevronLeft size={20} aria-hidden /> : <ChevronRight size={20} aria-hidden />}
    </button>
  );
}

/**
 * The picture as large as the screen allows, on its own. In a gallery the
 * arrows, the keyboard's arrow keys, and a swipe step through it.
 */
function FullSize({
  pictures,
  alt,
  index,
  onStep,
  onClose,
}: {
  pictures: PictureView[];
  alt: string;
  index: number;
  onStep: (index: number) => void;
  onClose: () => void;
}) {
  const picture = pictures[index] ?? pictures[0]!;
  const many = pictures.length > 1;
  const go = (by: -1 | 1) => onStep(Math.min(pictures.length - 1, Math.max(0, index + by)));
  const touch = useRef<number | null>(null);
  const label = pictureAlt(alt, index, pictures.length);
  return (
    <Dialog.Portal>
      <Dialog.Overlay className="fixed inset-0 z-50 bg-scrim" />
      <Dialog.Content
        aria-describedby={undefined}
        onClick={onClose}
        onKeyDown={(event) => {
          if (!many) return;
          if (event.key === "ArrowLeft") go(-1);
          if (event.key === "ArrowRight") go(1);
        }}
        onTouchStart={(event) => {
          touch.current = event.touches[0]?.clientX ?? null;
        }}
        onTouchEnd={(event) => {
          const start = touch.current;
          const end = event.changedTouches[0]?.clientX;
          touch.current = null;
          if (!many || start === null || end === undefined || Math.abs(end - start) < 50) return;
          go(end < start ? 1 : -1);
        }}
        className="fixed inset-0 z-50 flex cursor-zoom-out items-center justify-center p-2 sm:p-6"
      >
        <Dialog.Title className="sr-only">{label}</Dialog.Title>
        <img key={picture.src} src={picture.src} width={picture.width} height={picture.height} alt={label} className="max-h-full max-w-full object-contain" />
        {many ? (
          <>
            <span className="absolute top-4 left-4 rounded-full bg-overlay px-2.5 py-1 text-meta font-medium text-on-overlay tabular-nums">
              {index + 1} / {pictures.length}
            </span>
            {index > 0 ? <StepButton side="left" label="Previous picture" onClick={() => go(-1)} /> : null}
            {index < pictures.length - 1 ? <StepButton side="right" label="Next picture" onClick={() => go(1)} /> : null}
          </>
        ) : null}
        <Dialog.Close
          aria-label="Close"
          className="absolute top-3 right-3 inline-flex size-10 items-center justify-center rounded-full bg-overlay text-on-overlay hover:bg-scrim"
        >
          <X size={20} aria-hidden />
        </Dialog.Close>
      </Dialog.Content>
    </Dialog.Portal>
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
