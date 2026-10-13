import { Bookmark, LogOut, Settings, User } from "lucide-react";
import { DropdownMenu } from "radix-ui";
import { Link } from "react-router";

import type { Theme } from "~/lib/theme";

import { Avatar } from "./avatar";
import type { PublicAuthor } from "./post-card";
import { MENU_CONTENT, ThemeRadioGroup } from "./theme-switch";
import { MenuItem, MenuSeparator } from "./ui/menu";

/**
 * The signed-in user's menu, opened from their avatar. It also holds the
 * theme, which keeps the top bar to four controls on a narrow phone.
 */
export function AccountMenu({
  user,
  theme,
}: {
  user: PublicAuthor;
  theme: Theme;
}) {
  return (
    <DropdownMenu.Root>
      <DropdownMenu.Trigger asChild>
        <button
          type="button"
          aria-label={`Account: ${user.username}`}
          className="inline-flex size-9 items-center justify-center rounded-lg hover:bg-surface-2 pointer-coarse:size-11"
        >
          <Avatar
            userId={user.id}
            username={user.username}
            photoUrl={user.photoUrl}
            size={26}
          />
        </button>
      </DropdownMenu.Trigger>
      <DropdownMenu.Portal>
        <DropdownMenu.Content
          align="end"
          sideOffset={4}
          className={`${MENU_CONTENT} min-w-52`}
        >
          <p className="truncate px-2.5 pt-2 pb-1.5 text-body font-semibold">
            {user.username}
          </p>
          <MenuItem asChild>
            <Link to={`/u/${user.username}`}>
              <User size={16} aria-hidden className="text-text-muted" />
              Profile
            </Link>
          </MenuItem>
          <MenuItem asChild>
            <Link to="/saved">
              <Bookmark size={16} aria-hidden className="text-text-muted" />
              Saved posts
            </Link>
          </MenuItem>
          <MenuItem asChild>
            <Link to="/settings">
              <Settings size={16} aria-hidden className="text-text-muted" />
              Settings
            </Link>
          </MenuItem>
          <MenuSeparator />
          <DropdownMenu.Label className="px-2.5 pt-1.5 pb-1 text-meta text-text-muted">
            Theme
          </DropdownMenu.Label>
          <ThemeRadioGroup theme={theme} />
          <MenuSeparator />
          <MenuItem>
            <LogOut size={16} aria-hidden className="text-text-muted" />
            Sign out
          </MenuItem>
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  );
}
