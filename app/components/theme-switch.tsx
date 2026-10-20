import { Check, Monitor, Moon, Play, Sun } from "lucide-react";
import { DropdownMenu } from "radix-ui";
import { useFetcher } from "react-router";

import { cn } from "~/lib/cn";
import { type PlaybackSettings, playbackController } from "~/lib/playback/controller";
import { usePlaybackSettings } from "~/lib/playback/hooks";
import { parseTextSize, TEXT_SIZE_FIELD, TEXT_SIZES, type TextSize } from "~/lib/text-size";
import { parseTheme, type Theme, THEMES } from "~/lib/theme";

import { IconButton } from "./ui/button";
import { MenuSeparator, useMenuFocus } from "./ui/menu";

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

/** The member's text size in effect, counting a change still being saved. */
export function useTextSize(saved: TextSize | undefined): TextSize {
  const fetcher = useFetcher<{ textSizeError?: string }>({ key: TEXT_SIZE_FIELD });
  return parseTextSize(fetcher.formData?.get(TEXT_SIZE_FIELD)) ?? saved ?? 100;
}

/** The three theme choices, in the header's theme switch for visitors. */
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

const CHOICE =
  "flex h-9 cursor-pointer items-center gap-2 rounded-lg border border-border-strong px-3 text-body has-checked:border-accent has-checked:bg-accent-soft has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-accent pointer-coarse:h-(--touch)";

/**
 * The theme, text size, and autoplay as a section of Settings, where a
 * signed-in member finds them: radio buttons for the theme, kept in a
 * cookie; for the text size, kept on the account; and a checkbox for
 * autoplay, kept in this browser.
 */
export function DisplaySettings({ theme, textSize }: { theme: Theme; textSize: TextSize }) {
  const fetcher = useFetcher({ key: THEME_FETCHER_KEY });
  const sizeFetcher = useFetcher<{ textSizeError?: string }>({ key: TEXT_SIZE_FIELD });
  const { autoplay, blockedBy } = usePlaybackSettings();
  return (
    <div className="space-y-4">
      <fieldset>
        <legend className="text-body font-medium">Theme</legend>
        <div className="mt-1.5 flex flex-wrap gap-2">
          {THEMES.map((option) => {
            const { label, Icon } = OPTIONS[option];
            return (
              <label key={option} className={CHOICE}>
                <input
                  type="radio"
                  name="theme"
                  value={option}
                  checked={theme === option}
                  onChange={() => void fetcher.submit({ theme: option }, { method: "post", action: "/theme" })}
                  className="sr-only"
                />
                <Icon size={16} aria-hidden className="text-text-muted" />
                {label}
              </label>
            );
          })}
        </div>
      </fieldset>
      <fieldset>
        <legend className="text-body font-medium">Text size</legend>
        <div className="mt-1.5 flex flex-wrap gap-2">
          {TEXT_SIZES.map((option) => (
            <label key={option} className={CHOICE}>
              <input
                type="radio"
                name={TEXT_SIZE_FIELD}
                value={option}
                checked={textSize === option}
                onChange={() =>
                  void sizeFetcher.submit({ intent: TEXT_SIZE_FIELD, [TEXT_SIZE_FIELD]: option }, { method: "post", action: "/settings" })
                }
                className="sr-only"
              />
              {option}%
            </label>
          ))}
        </div>
        <p className="mt-1.5 text-meta text-text-muted">
          {sizeFetcher.data?.textSizeError ?? "For your account, on every device, and in the board's emails to you."}
        </p>
      </fieldset>
      <label className="flex items-start gap-2.5 text-body">
        <input
          type="checkbox"
          checked={autoplay && blockedBy === null}
          disabled={blockedBy !== null}
          onChange={(event) => playbackController()?.setAutoplay(event.target.checked)}
          className="mt-1 size-4 shrink-0 accent-(--accent)"
        />
        <span>
          Autoplay videos as they come into view, muted until you turn the sound on.
          {blockedBy ? <span className="block text-meta text-text-muted">{AUTOPLAY_BLOCKED[blockedBy]}.</span> : null}
          <span className="block text-meta text-text-muted">Kept in this browser.</span>
        </span>
      </label>
    </div>
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
 * The autoplay switch, remembered in this browser. It sits with the theme
 * in the header's theme menu, for visitors; members find both in Settings.
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
  const focus = useMenuFocus();
  const { Icon } = OPTIONS[theme];

  return (
    <DropdownMenu.Root>
      <DropdownMenu.Trigger asChild {...focus.trigger}>
        <IconButton aria-label={`Theme: ${OPTIONS[theme].label}`}>
          <Icon size={18} aria-hidden />
        </IconButton>
      </DropdownMenu.Trigger>
      <DropdownMenu.Portal>
        <DropdownMenu.Content
          {...focus.content}
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
