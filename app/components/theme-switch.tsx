import { Check, Heart, Monitor, Moon, Sun } from "lucide-react";
import { DropdownMenu } from "radix-ui";
import { Link, useFetcher } from "react-router";

import { cn } from "~/lib/cn";
import { DEFAULT_TEXT_SIZE, parseTextSize, TEXT_SIZE_FIELD, TEXT_SIZE_LABEL, TEXT_SIZES, type TextSize } from "~/lib/text-size";
import { parseTheme, type Theme, THEMES } from "~/lib/theme";
import { DEFAULT_TINT, parseTint, TINT_COLORS, TINT_FIELD, TINT_LABEL, TINTS, type Tint } from "~/lib/tint";

import { IconButton } from "./ui/button";
import { useMenuFocus } from "./ui/menu";

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

/** The fan's tint in effect, counting a change still being saved. */
export function useTint(saved: Tint | undefined): Tint {
  const fetcher = useFetcher<{ tintError?: string }>({ key: TINT_FIELD });
  return parseTint(fetcher.formData?.get(TINT_FIELD)) ?? saved ?? DEFAULT_TINT;
}

/** The member's text size in effect, counting a change still being saved. */
export function useTextSize(saved: TextSize | undefined): TextSize {
  const fetcher = useFetcher<{ textSizeError?: string }>({ key: TEXT_SIZE_FIELD });
  return parseTextSize(fetcher.formData?.get(TEXT_SIZE_FIELD)) ?? saved ?? DEFAULT_TEXT_SIZE;
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
 * The theme and text size as a section of Settings, where a signed-in
 * member finds them: radio buttons for the theme, kept in a cookie, and for
 * the text size, kept on the account.
 */
export function DisplaySettings({
  theme,
  textSize,
  tint,
  fan,
}: {
  theme: Theme;
  textSize: TextSize;
  tint: Tint;
  /** Has the plan, which brings the tints. */
  fan: boolean;
}) {
  const fetcher = useFetcher({ key: THEME_FETCHER_KEY });
  const sizeFetcher = useFetcher<{ textSizeError?: string }>({ key: TEXT_SIZE_FIELD });
  const tintFetcher = useFetcher<{ tintError?: string }>({ key: TINT_FIELD });
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
              {TEXT_SIZE_LABEL[option]}
            </label>
          ))}
        </div>
        <p className="mt-1.5 text-meta text-text-muted">
          {sizeFetcher.data?.textSizeError ?? "For your account, on every device, and in the board's emails to you."}
        </p>
      </fieldset>
      <fieldset disabled={!fan}>
        <legend className="flex items-center gap-2 text-body font-medium">
          Tint
          <span className="inline-flex items-center gap-1 text-meta font-medium text-accent">
            <Heart size={12} aria-hidden className="fill-current" />
            Fan<span className="sr-only"> plan feature</span>
          </span>
        </legend>
        <div className="mt-1.5 flex flex-wrap gap-2">
          {TINTS.map((option) => (
            <label key={option} className={cn(CHOICE, !fan && "opacity-60")}>
              <input
                type="radio"
                name={TINT_FIELD}
                value={option}
                checked={tint === option}
                onChange={() => void tintFetcher.submit({ intent: TINT_FIELD, [TINT_FIELD]: option }, { method: "post", action: "/settings" })}
                className="sr-only"
              />
              {/* The color as it shows in the scheme in force. */}
              <span
                aria-hidden
                className="size-3.5 shrink-0 rounded-full"
                style={{ backgroundColor: `light-dark(${TINT_COLORS[option].light.accent}, ${TINT_COLORS[option].dark.accent})` }}
              />
              {TINT_LABEL[option]}
            </label>
          ))}
        </div>
        <p className="mt-1.5 text-meta text-text-muted">
          {tintFetcher.data?.tintError ??
            (fan ? (
              "In place of orange, everywhere you look: on every device, in fan marks, and in the board's emails to you."
            ) : (
              <>
                Your own color in place of orange.{" "}
                <Link to="/fan" className="underline underline-offset-4 hover:text-text">
                  Choosing one comes with the Fan plan
                </Link>
                .
              </>
            ))}
        </p>
      </fieldset>
    </div>
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
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  );
}
