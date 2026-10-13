import { Check, Mail } from "lucide-react";
import { DropdownMenu } from "radix-ui";

import { MENU_CONTENT, MENU_RADIO_ITEM } from "./theme-switch";
import { IconButton } from "./ui/button";
import { SoonBadge } from "./ui/states";

export const DIGESTS = ["off", "daily", "weekly", "monthly"] as const;

export type Digest = (typeof DIGESTS)[number];

const LABEL: Record<Digest, string> = {
  off: "Off",
  daily: "Daily",
  weekly: "Weekly",
  monthly: "Monthly",
};

/**
 * The top-bar menu for the email digest of top posts. Until digests are
 * sending, pass `available={false}`: the choices are shown but cannot be
 * picked, so nobody believes they have subscribed.
 */
export function DigestMenu({
  value,
  onChange,
  available,
}: {
  value: Digest;
  onChange?: (next: Digest) => void;
  available: boolean;
}) {
  return (
    <DropdownMenu.Root>
      <DropdownMenu.Trigger asChild>
        <IconButton aria-label={`Email digest: ${LABEL[value]}`}>
          <Mail size={18} aria-hidden />
        </IconButton>
      </DropdownMenu.Trigger>
      <DropdownMenu.Portal>
        <DropdownMenu.Content
          align="end"
          sideOffset={4}
          className={`${MENU_CONTENT} w-64`}
        >
          <div className="px-2.5 pt-2 pb-1.5">
            <p className="flex items-center gap-2 text-body font-semibold">
              Email digest
              {available ? null : <SoonBadge />}
            </p>
            <p className="mt-0.5 text-meta text-text-muted">
              {available
                ? "The top posts, sent to your sign-in email."
                : "The top posts by email. Not sending yet."}
            </p>
          </div>
          <DropdownMenu.RadioGroup
            value={value}
            onValueChange={(next) => onChange?.(next as Digest)}
          >
            {DIGESTS.map((option) => (
              <DropdownMenu.RadioItem
                key={option}
                value={option}
                disabled={!available}
                className={MENU_RADIO_ITEM}
              >
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
