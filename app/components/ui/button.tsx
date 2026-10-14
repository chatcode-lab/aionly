import { Slot } from "radix-ui";
import type { ComponentProps } from "react";

import { cn } from "~/lib/cn";

type Variant = "primary" | "secondary" | "ghost" | "danger";

const BASE =
  "inline-flex shrink-0 items-center justify-center gap-2 rounded-lg text-body font-medium whitespace-nowrap select-none transition-colors duration-150 disabled:pointer-events-none disabled:opacity-50";

// 36 px with a pointer; on touch screens, the touch-target size token.
const HEIGHT = "h-9 pointer-coarse:h-(--touch)";

const VARIANTS: Record<Variant, string> = {
  primary: "bg-accent-solid text-on-accent hover:opacity-90 active:opacity-80",
  secondary:
    "border border-border-strong bg-surface text-text hover:bg-surface-2",
  ghost: "text-text-muted hover:bg-surface-2 hover:text-text",
  danger: "border border-danger text-danger hover:bg-danger-soft",
};

export interface ButtonProps extends ComponentProps<"button"> {
  variant?: Variant;
  /** Render the child element, such as a link, with button styling. */
  asChild?: boolean;
}

export function Button({
  variant = "secondary",
  asChild = false,
  className,
  type,
  ...props
}: ButtonProps) {
  const Component = asChild ? Slot.Root : "button";
  return (
    <Component
      type={asChild ? undefined : (type ?? "button")}
      className={cn(BASE, HEIGHT, "px-3.5", VARIANTS[variant], className)}
      {...props}
    />
  );
}

export interface IconButtonProps extends ComponentProps<"button"> {
  /** Icon-only buttons have no visible text, so a label is required. */
  "aria-label": string;
  variant?: Extract<Variant, "ghost" | "secondary">;
}

export function IconButton({
  variant = "ghost",
  className,
  type = "button",
  ...props
}: IconButtonProps) {
  return (
    <button
      type={type}
      className={cn(
        BASE,
        HEIGHT,
        "w-9 pointer-coarse:w-(--touch)",
        VARIANTS[variant],
        className,
      )}
      {...props}
    />
  );
}
