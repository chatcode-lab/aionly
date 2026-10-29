import { AtSign, Bookmark, FilePen, LogOut, Settings, Shield, User } from "lucide-react";
import { DropdownMenu } from "radix-ui";
import { Link, useSubmit } from "react-router";

import { NEW_MENTIONS_MAX } from "~/lib/text/mentions";
import { useModeration } from "~/lib/use-moderation";

import { Avatar } from "./avatar";
import type { PublicAuthor } from "~/lib/public-types";
import { MENU_CONTENT } from "./theme-switch";
import { MenuItem, MenuSeparator, useMenuFocus } from "./ui/menu";
import { profilePath } from "~/lib/slug";

/** A count beside a menu item, such as new mentions or open reports. */
function Count({ value, label }: { value: number; label: string }) {
  return (
    <span className="ml-auto rounded-full bg-accent px-1.5 text-meta font-semibold text-on-accent tabular-nums">
      {value >= NEW_MENTIONS_MAX ? `${NEW_MENTIONS_MAX}+` : value}
      <span className="sr-only"> {label}</span>
    </span>
  );
}

/**
 * The signed-in user's menu, opened from their avatar. The theme lives in
 * Settings, which keeps the top bar to four controls on a narrow phone.
 */
export function AccountMenu({ user }: { user: PublicAuthor & { newMentions: number; drafts?: { own: number; fromAgent: number } } }) {
  const focus = useMenuFocus();
  const submit = useSubmit();
  const moderation = useModeration();
  const waiting = moderation?.openReports ?? 0;
  const mentions = user.newMentions;
  // The menu counts every draft waiting; only the agent's, for review, light the dot.
  const drafts = (user.drafts?.own ?? 0) + (user.drafts?.fromAgent ?? 0);
  const fromAgent = user.drafts?.fromAgent ?? 0;
  const status = [
    mentions > 0 ? `${mentions >= NEW_MENTIONS_MAX ? `${NEW_MENTIONS_MAX}+` : mentions} new mentions` : null,
    fromAgent > 0 ? `${fromAgent} ${fromAgent === 1 ? "draft" : "drafts"} from your agent` : null,
    waiting > 0 ? `${waiting} open reports` : null,
  ].filter(Boolean);
  return (
    <DropdownMenu.Root>
      <DropdownMenu.Trigger asChild {...focus.trigger}>
        <button
          type="button"
          aria-label={[`Account: ${user.username}`, ...status].join(", ")}
          className="relative inline-flex size-9 items-center justify-center rounded-lg hover:bg-surface-2 focus-visible:-outline-offset-2 pointer-coarse:size-(--touch)"
        >
          <Avatar
            userId={user.id}
            username={user.username}
            photoUrl={user.photoUrl}
            size={26}
          />
          {status.length > 0 ? (
            <span aria-hidden className="absolute top-1 right-1 size-2.5 rounded-full border-2 border-surface bg-accent" />
          ) : null}
        </button>
      </DropdownMenu.Trigger>
      <DropdownMenu.Portal>
        <DropdownMenu.Content
          {...focus.content}
          align="end"
          sideOffset={4}
          className={`${MENU_CONTENT} min-w-52`}
        >
          <p className="truncate px-2.5 pt-2 pb-1.5 text-body font-semibold">
            {user.username}
          </p>
          <MenuItem asChild>
            <Link to={profilePath(user.username)} prefetch="intent">
              <User size={16} aria-hidden className="text-text-muted" />
              Profile
            </Link>
          </MenuItem>
          <MenuItem asChild>
            <Link to="/mentions">
              <AtSign size={16} aria-hidden className="text-text-muted" />
              Mentions
              {mentions > 0 ? <Count value={mentions} label="new" /> : null}
            </Link>
          </MenuItem>
          <MenuItem asChild>
            <Link to="/saved" prefetch="intent">
              <Bookmark size={16} aria-hidden className="text-text-muted" />
              Saved
            </Link>
          </MenuItem>
          <MenuItem asChild>
            {/* Straight to the agent's, when only those wait. */}
            <Link to={fromAgent > 0 && !user.drafts?.own ? "/drafts?view=agent" : "/drafts"} prefetch="intent">
              <FilePen size={16} aria-hidden className="text-text-muted" />
              Drafts
              {drafts > 0 ? <Count value={drafts} label="waiting" /> : null}
            </Link>
          </MenuItem>
          <MenuItem asChild>
            <Link to="/settings" prefetch="intent">
              <Settings size={16} aria-hidden className="text-text-muted" />
              Settings
            </Link>
          </MenuItem>
          {moderation ? (
            <MenuItem asChild>
              <Link to="/admin" prefetch="intent">
                <Shield size={16} aria-hidden className="text-text-muted" />
                Admin
                {waiting > 0 ? <Count value={waiting} label="open" /> : null}
              </Link>
            </MenuItem>
          ) : null}
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
