import { Check, Monitor, Moon, Play, Sun } from "lucide-react";
import { DropdownMenu } from "radix-ui";
import { useFetcher } from "react-router";

import { cn } from "~/lib/cn";
import { type PlaybackSettings, playbackController } from "~/lib/playback/controller";
import { usePlaybackSettings } from "~/lib/playback/hooks";
import { parseTheme, type Theme, THEMES } from "~/lib/theme";

import { IconButton } from "./ui/button";
import { MenuSeparator } from "./ui/menu";

/** Shared so the document can apply the choice before the server confirms. */
export const THEME_FETCHER_KEY = "theme";

const OPTIONS: Record<Theme, { label: string; Icon: typeof Sun }> = {
  system: { label: "System", Icon: Monitor },
  light: { label: "Light", Icon: Sun },
  dark: { label: "Dark", Icon: Moon },
};

export const MENU_CONTENT =
  "z-50 rounded-xl border border-border bg-surface p-1 shadow-lg";

export const MENU_RADIO_ITEM =
  "flex h-9 cursor-default items-center gap-2.5 rounded-lg px-2.5 text-body outline-none select-none data-disabled:opacity-50 data-highlighted:bg-surface-2 pointer-coarse:h-(--touch)";

/** The theme currently in effect, counting a change still being saved. */
export function useTheme(saved: Theme | undefined): Theme {
  const fetcher = useFetcher({ key: THEME_FETCHER_KEY });
  return parseTheme(fetcher.formData?.get("theme") ?? saved);
}

/**
 * The three theme choices, for use inside any dropdown menu: the header's
 * theme switch when signed out, the account menu when signed in.
 */
export function ThemeRadioGroup({ theme }: { theme: Theme }) {
  const fetcher = useFetcher({ key: THEME_FETCHER_KEY });

  return (
    <DropdownMenu.RadioGroup
      value={theme}
      onValueChange={(next) => {
        void fetcher.submit(
          { theme: next },
          { method: "post", action: "/theme" },
        );
      }}
    >
      {THEMES.map((option) => {
        const { label, Icon } = OPTIONS[option];
        return (
          <DropdownMenu.RadioItem
            key={option}
            value={option}
            className={MENU_RADIO_ITEM}
          >
            <Icon size={16} aria-hidden className="text-text-muted" />
            {label}
            <DropdownMenu.ItemIndicator className="ml-auto">
              <Check size={16} aria-hidden />
            </DropdownMenu.ItemIndicator>
          </DropdownMenu.RadioItem>
        );
      })}
    </DropdownMenu.RadioGroup>
  );
}

const AUTOPLAY_BLOCKED: Record<
  NonNullable<PlaybackSettings["blockedBy"]>,
  string
> = {
  "reduced-motion": "Off while reduced motion is on",
  "data-saver": "Off while data saver is on",
};

/**
 * The autoplay switch, remembered in this browser. It sits with the theme,
 * in the header's theme menu or the account menu.
 */
export function AutoplayItem() {
  const { autoplay, blockedBy } = usePlaybackSettings();
  return (
    <DropdownMenu.CheckboxItem
      checked={autoplay && blockedBy === null}
      disabled={blockedBy !== null}
      onCheckedChange={(checked) => playbackController()?.setAutoplay(checked)}
      className={cn(MENU_RADIO_ITEM, blockedBy && "h-auto py-1.5")}
    >
      <Play size={16} aria-hidden className="text-text-muted" />
      <span className="min-w-0">
        Autoplay videos
        {blockedBy ? (
          <span className="block text-meta text-text-muted">
            {AUTOPLAY_BLOCKED[blockedBy]}
          </span>
        ) : null}
      </span>
      <DropdownMenu.ItemIndicator className="ml-auto">
        <Check size={16} aria-hidden />
      </DropdownMenu.ItemIndicator>
    </DropdownMenu.CheckboxItem>
  );
}

export function ThemeSwitch({ theme }: { theme: Theme }) {
  const { Icon } = OPTIONS[theme];

  return (
    <DropdownMenu.Root>
      <DropdownMenu.Trigger asChild>
        <IconButton aria-label={`Theme: ${OPTIONS[theme].label}`}>
          <Icon size={18} aria-hidden />
        </IconButton>
      </DropdownMenu.Trigger>
      <DropdownMenu.Portal>
        <DropdownMenu.Content
          align="end"
          sideOffset={4}
          className={`${MENU_CONTENT} min-w-48`}
        >
          <ThemeRadioGroup theme={theme} />
          <MenuSeparator />
          <AutoplayItem />
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  );
}
