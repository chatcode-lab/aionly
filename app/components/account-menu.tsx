import { AtSign, Bookmark, LogOut, Settings, Shield, User } from "lucide-react";
import { DropdownMenu } from "radix-ui";
import { Link, useSubmit } from "react-router";

import type { Theme } from "~/lib/theme";
import { useModeration } from "~/lib/use-moderation";

import { Avatar } from "./avatar";
import type { PublicAuthor } from "~/lib/public-types";
import { AutoplayItem, MENU_CONTENT, ThemeRadioGroup } from "./theme-switch";
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
  const submit = useSubmit();
  const moderation = useModeration();
  const waiting = moderation?.openReports ?? 0;
  return (
    <DropdownMenu.Root>
      <DropdownMenu.Trigger asChild>
        <button
          type="button"
          aria-label={`Account: ${user.username}${waiting > 0 ? `, ${waiting} open reports` : ""}`}
          className="relative inline-flex size-9 items-center justify-center rounded-lg hover:bg-surface-2 pointer-coarse:size-(--touch)"
        >
          <Avatar
            userId={user.id}
            username={user.username}
            photoUrl={user.photoUrl}
            size={26}
          />
          {waiting > 0 ? (
            <span aria-hidden className="absolute top-1 right-1 size-2.5 rounded-full border-2 border-surface bg-accent" />
          ) : null}
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
            <Link to="/mentions">
              <AtSign size={16} aria-hidden className="text-text-muted" />
              Mentions
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
          {moderation ? (
            <MenuItem asChild>
              <Link to="/admin">
                <Shield size={16} aria-hidden className="text-text-muted" />
                Moderation
                {waiting > 0 ? (
                  <span className="ml-auto rounded-full bg-accent px-1.5 text-meta font-semibold text-on-accent tabular-nums">
                    {waiting}
                  </span>
                ) : null}
              </Link>
            </MenuItem>
          ) : null}
          <MenuSeparator />
          <DropdownMenu.Label className="px-2.5 pt-1.5 pb-1 text-meta text-text-muted">
            Theme
          </DropdownMenu.Label>
          <ThemeRadioGroup theme={theme} />
          <AutoplayItem />
          <MenuSeparator />
          <MenuItem
            onSelect={() => {
              void submit(null, { method: "post", action: "/signout" });
            }}
          >
            <LogOut size={16} aria-hidden className="text-text-muted" />
            Sign out
          </MenuItem>
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  );
}
