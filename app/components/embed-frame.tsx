import type { Ref } from "react";

import { cn } from "~/lib/cn";
import {
  FRAME_ALLOW,
  FRAME_SANDBOX,
  SHELL_SANDBOX,
} from "~/lib/embeds/frames";

/**
 * The one way an embed reaches the page: a sandboxed frame that can never
 * navigate the top window. `src` must come from `frameUrl` or `shellPath`.
 */
export function EmbedFrame({
  src,
  title,
  shell = false,
  className,
  height,
  ref,
}: {
  src: string;
  title: string;
  /** True for the first-party embed shell, which stays at an opaque origin. */
  shell?: boolean;
  className?: string;
  /** A height reported by the embed, for posts that size themselves. */
  height?: number;
  ref?: Ref<HTMLIFrameElement>;
}) {
  return (
    <iframe
      ref={ref}
      src={src}
      title={title}
      sandbox={shell ? SHELL_SANDBOX : FRAME_SANDBOX}
      allow={FRAME_ALLOW}
      allowFullScreen
      // Providers such as YouTube refuse to play without knowing the
      // embedding site; this sends our origin and nothing more.
      referrerPolicy="strict-origin-when-cross-origin"
      style={height ? { height } : undefined}
      className={cn("block border-0", className)}
    />
  );
}
