import { ChevronDown } from "lucide-react";
import type { ComponentProps } from "react";

import { cn } from "~/lib/cn";

/**
 * A native select with its own arrow, kept clear of the border and in the
 * theme's muted color; the browser's sits against the edge. `frame` lays
 * out the box around it, such as its width and margin; `block` puts it on
 * a line of its own, under its label.
 */
export function Select({ className, frame, block = false, ...props }: ComponentProps<"select"> & { frame?: string; block?: boolean }) {
  return (
    <span className={cn("relative", block ? "flex" : "inline-flex", frame)}>
      <select {...props} className={cn("w-full appearance-none pr-8", className)} />
      <ChevronDown size={16} aria-hidden className="pointer-events-none absolute top-1/2 right-2.5 -translate-y-1/2 text-text-muted" />
    </span>
  );
}
