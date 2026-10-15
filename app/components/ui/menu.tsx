import { Ellipsis } from "lucide-react";
import { DropdownMenu } from "radix-ui";
import { type ComponentProps, type ReactNode, useRef } from "react";

import { cn } from "~/lib/cn";

import { IconButton } from "./button";

/**
 * Where focus goes as a menu closes. Opened from the keyboard, it returns
 * to the button, as it should; opened with a pointer, it is not put back,
 * so a click leaves no focus ring behind. Spread `trigger` on the
 * menu's Trigger and `content` on its Content.
 */
export function useMenuFocus() {
  const pointer = useRef(false);
  return {
    trigger: {
      onPointerDown: () => {
        pointer.current = true;
      },
      onKeyDown: () => {
        pointer.current = false;
      },
    },
    content: {
      onCloseAutoFocus: (event: Event) => {
        if (pointer.current) event.preventDefault();
      },
    },
  };
}

/** The ⋯ menu attached to posts, comments, and profiles. */
export function Menu({
  label,
  children,
}: {
  /** Names what the menu acts on, such as "Comment actions". */
  label: string;
  children: ReactNode;
}) {
  const focus = useMenuFocus();
  return (
    <DropdownMenu.Root>
      <DropdownMenu.Trigger asChild {...focus.trigger}>
        <IconButton aria-label={label}>
          <Ellipsis size={18} aria-hidden />
        </IconButton>
      </DropdownMenu.Trigger>
      <DropdownMenu.Portal>
        <DropdownMenu.Content
          align="end"
          sideOffset={4}
          className="z-50 min-w-44 rounded-xl border border-border bg-surface p-1 shadow-lg"
          {...focus.content}
        >
          {children}
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  );
}

export function MenuItem({
  danger = false,
  className,
  ...props
}: ComponentProps<typeof DropdownMenu.Item> & { danger?: boolean }) {
  return (
    <DropdownMenu.Item
      className={cn(
        "flex h-9 cursor-default items-center gap-2.5 rounded-lg px-2.5 text-body outline-none select-none pointer-coarse:h-(--touch)",
        danger
          ? "text-danger data-highlighted:bg-danger-soft"
          : "text-text data-highlighted:bg-surface-2",
        className,
      )}
      {...props}
    />
  );
}

export function MenuSeparator() {
  return <DropdownMenu.Separator className="my-1 h-px bg-border" />;
}
