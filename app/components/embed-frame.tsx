import type { Ref } from "react";

import { cn } from "~/lib/cn";
import { FRAME_ALLOW, FRAME_LAYOUT, FRAME_SANDBOX } from "~/lib/embeds/frames";
import { type MediaLink, PROVIDER_LABEL } from "~/lib/links/types";

/**
 * The one way an embed reaches the page: a sandboxed frame that can never
 * navigate the top window. `src` must come from `frameUrl`. Videos keep a
 * fixed shape; posts and songs take the height the embed reports.
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

  return (
    <div
      className={cn(
        "flex justify-center",
        video && "overflow-hidden rounded-xl bg-surface-2",
      )}
    >
      <iframe
        ref={ref}
        src={src}
        title={`${PROVIDER_LABEL[link.provider]} embed`}
        sandbox={FRAME_SANDBOX}
        allow={FRAME_ALLOW}
        allowFullScreen
        // Providers such as YouTube refuse to play without knowing the
        // embedding site; this sends our origin and nothing more.
        referrerPolicy="strict-origin-when-cross-origin"
        style={{
          maxWidth: layout.maxWidth,
          height: video ? undefined : (height ?? layout.initialHeight),
          colorScheme: layout.lightScheme ? "light" : undefined,
        }}
        className={cn(
          "block border-0",
          link.aspect === "16:9" && "aspect-video w-full",
          link.aspect === "9:16" &&
            "aspect-[9/16] h-[min(70vh,35rem)] max-w-full",
          !video && "w-full rounded-xl",
        )}
      />
    </div>
  );
}
