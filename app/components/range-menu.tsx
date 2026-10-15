import { Check, ChevronDown } from "lucide-react";
import { DropdownMenu } from "radix-ui";
import { Link } from "react-router";

import { MENU_CONTENT } from "./theme-switch";
import { MenuItem, useMenuFocus } from "./ui/menu";

export interface RangeOption {
  label: string;
  to: string;
}

/**
 * One button for the feed's time range, showing the range in effect and
 * opening the others. The range lives in the URL, so each choice is a link.
 */
export function RangeMenu({
  options,
  current,
}: {
  options: RangeOption[];
  /** The `to` of the range in effect. */
  current: string;
}) {
  const focus = useMenuFocus();
  const active = options.find((option) => option.to === current) ?? options[0];

  return (
    <DropdownMenu.Root>
      <DropdownMenu.Trigger asChild {...focus.trigger}>
        <button
          type="button"
          aria-label={`Range: ${active.label}`}
          className="inline-flex h-9 items-center gap-1 rounded-lg pr-2 pl-3 text-body whitespace-nowrap text-text-muted hover:bg-surface-2 focus-visible:-outline-offset-2 hover:text-text pointer-coarse:h-(--touch)"
        >
          {active.label}
          <ChevronDown size={16} aria-hidden />
        </button>
      </DropdownMenu.Trigger>
      <DropdownMenu.Portal>
        <DropdownMenu.Content
          {...focus.content}
          align="start"
          sideOffset={4}
          className={`${MENU_CONTENT} min-w-36`}
        >
          {options.map((option) => (
            <MenuItem key={option.to} asChild>
              <Link to={option.to} preventScrollReset>
                {option.label}
                {option.to === active.to ? (
                  <Check size={16} aria-hidden className="ml-auto" />
                ) : null}
              </Link>
            </MenuItem>
          ))}
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  );
}
