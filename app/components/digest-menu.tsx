import { Check, Newspaper } from "lucide-react";
import { DropdownMenu } from "radix-ui";
import { useFetcher } from "react-router";

import { MENU_CONTENT, MENU_RADIO_ITEM } from "./theme-switch";
import { IconButton } from "./ui/button";
import { useMenuFocus } from "./ui/menu";

export const DIGESTS = ["off", "daily", "weekly", "monthly"] as const;

export type Digest = (typeof DIGESTS)[number];

const LABEL: Record<Digest, string> = {
  off: "Off",
  daily: "Daily",
  weekly: "Weekly",
  monthly: "Monthly",
};

/**
 * The top-bar menu for the email digest of top posts, free for every
 * member: how often it comes, or off.
 */
export function DigestMenu({ value }: { value: Digest }) {
  const focus = useMenuFocus();
  const fetcher = useFetcher();
  const pending = fetcher.formData?.get("digest");
  const current = (typeof pending === "string" ? pending : value) as Digest;
  const choose = (next: Digest) => fetcher.submit({ digest: next }, { method: "post", action: "/api/digest" });

  return (
    <DropdownMenu.Root>
      <DropdownMenu.Trigger asChild {...focus.trigger}>
        <IconButton aria-label={`Email digest: ${LABEL[current]}`}>
          <Newspaper size={18} aria-hidden />
        </IconButton>
      </DropdownMenu.Trigger>
      <DropdownMenu.Portal>
        <DropdownMenu.Content align="end" sideOffset={4} className={`${MENU_CONTENT} w-64`} {...focus.content}>
          <div className="px-2.5 pt-2 pb-1.5">
            <p className="text-body font-semibold">Email digest</p>
            <p className="mt-0.5 text-meta text-text-muted">The top posts, sent to your sign-in email.</p>
          </div>
          <DropdownMenu.RadioGroup value={current} onValueChange={(next) => choose(next as Digest)}>
            {DIGESTS.map((option) => (
              <DropdownMenu.RadioItem key={option} value={option} className={MENU_RADIO_ITEM}>
                {LABEL[option]}
                <DropdownMenu.ItemIndicator className="ml-auto">
                  <Check size={16} aria-hidden />
                </DropdownMenu.ItemIndicator>
              </DropdownMenu.RadioItem>
            ))}
          </DropdownMenu.RadioGroup>
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  );
}
