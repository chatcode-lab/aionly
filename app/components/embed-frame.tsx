import { type Ref, useEffect, useRef, useState } from "react";

import { cn } from "~/lib/cn";
import { FRAME_ALLOW, FRAME_LAYOUT, FRAME_SANDBOX } from "~/lib/embeds/frames";
import { type MediaLink, PROVIDER_LABEL } from "~/lib/links/types";

/** The width of an element's content box, kept current as it resizes. */
function useWidth(ref: { current: HTMLElement | null }): number | null {
  const [width, setWidth] = useState<number | null>(null);
  useEffect(() => {
    const element = ref.current;
    if (!element) return;
    const observer = new ResizeObserver(([entry]) => {
      setWidth(entry.contentRect.width);
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, [ref]);
  return width;
}

/**
 * The one way an embed reaches the page: a sandboxed frame that can never
 * navigate the top window. `src` must come from `frameUrl`. Videos keep a
 * fixed shape, and a vertical one is centered at its own width; posts and
 * songs take the height the embed reports.
 */
export function EmbedFrame({
  link,
  src,
  height,
  ref,
}: {
  link: MediaLink;
  src: string;
  /** A height reported by the embed, for posts that size themselves. */
  height?: number;
  ref?: Ref<HTMLIFrameElement>;
}) {
  const layout = FRAME_LAYOUT[link.provider];
  const video = link.aspect === "16:9" || link.aspect === "9:16";
  const frameHeight = video ? undefined : (height ?? layout.initialHeight);

  // Some providers refuse to lay out below a minimum width and would be
  // cropped in a narrower column. Their frame keeps that width and is scaled
  // down to fit, so the whole post stays visible.
  const wrapper = useRef<HTMLDivElement>(null);
  const available = useWidth(wrapper);
  const scale =
    layout.minWidth && available !== null && available < layout.minWidth
      ? available / layout.minWidth
      : 1;
  const scaled = scale < 1;

  return (
    <div
      ref={wrapper}
      className={cn("flex", scaled ? "overflow-hidden" : "justify-center")}
      style={
        scaled && frameHeight ? { height: frameHeight * scale } : undefined
      }
    >
      <iframe
        ref={ref}
        src={src}
        title={`${PROVIDER_LABEL[link.provider]} embed`}
        sandbox={FRAME_SANDBOX}
        allow={FRAME_ALLOW}
        allowFullScreen
        scrolling={layout.selfSizing ? "no" : undefined}
        // Providers such as YouTube refuse to play without knowing the
        // embedding site; this sends our origin and nothing more.
        referrerPolicy="strict-origin-when-cross-origin"
        style={{
          maxWidth: scaled ? undefined : layout.maxWidth,
          width: scaled ? layout.minWidth : undefined,
          height: frameHeight,
          colorScheme: layout.lightScheme ? "light" : undefined,
          transform: scaled ? `scale(${scale})` : undefined,
          transformOrigin: scaled ? "top left" : undefined,
        }}
        // The frame is exactly the media: rounded corners, no surrounding box.
        className={cn(
          "block border-0",
          !layout.ownOutline && "overflow-hidden rounded-xl",
          link.aspect === "16:9" && "aspect-video w-full bg-surface-2",
          // As wide as the column allows, up to 320 px; the height follows.
          link.aspect === "9:16" && "aspect-[9/16] w-full max-w-80 bg-surface-2",
          !video && (scaled ? "shrink-0" : "w-full"),
        )}
      />
    </div>
  );
}
