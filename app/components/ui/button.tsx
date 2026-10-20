import { Slot } from "radix-ui";
import type { ComponentProps } from "react";

import { cn } from "~/lib/cn";

type Variant = "primary" | "secondary" | "ghost" | "danger";

const BASE =
  "inline-flex items-center justify-center gap-2 rounded-lg text-body font-medium select-none transition-colors duration-150 disabled:pointer-events-none disabled:opacity-50";

// One line, 36 px high with a pointer; on touch screens, the touch-target size token.
const ONE_LINE = "shrink-0 whitespace-nowrap h-9 pointer-coarse:h-(--touch)";

// A label that may take two lines on a narrow screen at a larger text size
// (review F91): at least that height, and never wider than its column.
const WRAPPING = "max-w-full min-h-9 py-1 text-center pointer-coarse:min-h-(--touch)";

const VARIANTS: Record<Variant, string> = {
  primary: "bg-accent-solid text-on-accent hover:opacity-90 active:opacity-80",
  // The others draw the focus ring just inside their edge, so it never
  // crowds a neighbor; on the filled button it would not show.
  secondary:
    "border border-border-strong bg-surface text-text hover:bg-surface-2 focus-visible:-outline-offset-2",
  ghost: "text-text-muted hover:bg-surface-2 hover:text-text focus-visible:-outline-offset-2",
  danger: "border border-danger text-danger hover:bg-danger-soft focus-visible:-outline-offset-2",
};

export interface ButtonProps extends ComponentProps<"button"> {
  variant?: Variant;
  /** Render the child element, such as a link, with button styling. */
  asChild?: boolean;
  /** Lets a long label wrap, the button growing to fit, rather than run past a narrow column. */
  wrap?: boolean;
}

export function Button({
  variant = "secondary",
  asChild = false,
  wrap = false,
  className,
  type,
  ...props
}: ButtonProps) {
  const Component = asChild ? Slot.Root : "button";
  return (
    <Component
      type={asChild ? undefined : (type ?? "button")}
      className={cn(BASE, wrap ? WRAPPING : ONE_LINE, "px-3.5", VARIANTS[variant], className)}
      {...props}
    />
  );
}

export interface IconButtonProps extends ComponentProps<"button"> {
  /** Icon-only buttons have no visible text, so a label is required. */
  "aria-label": string;
  variant?: Extract<Variant, "ghost" | "secondary">;
  /** Render the child element, such as a link, with button styling. */
  asChild?: boolean;
}

export function IconButton({
  variant = "ghost",
  asChild = false,
  className,
  type = "button",
  ...props
}: IconButtonProps) {
  const Component = asChild ? Slot.Root : "button";
  return (
    <Component
      type={asChild ? undefined : type}
      className={cn(
        BASE,
        ONE_LINE,
        "w-9 pointer-coarse:w-(--touch)",
        VARIANTS[variant],
        className,
      )}
      {...props}
    />
  );
}
