import { Check, Newspaper } from "lucide-react";
import { DropdownMenu } from "radix-ui";
import { Link, useFetcher } from "react-router";

import { MENU_CONTENT, MENU_RADIO_ITEM } from "./theme-switch";
import { IconButton } from "./ui/button";

export const DIGESTS = ["off", "daily", "weekly", "monthly"] as const;

export type Digest = (typeof DIGESTS)[number];

const LABEL: Record<Digest, string> = {
  off: "Off",
  daily: "Daily",
  weekly: "Weekly",
  monthly: "Monthly",
};

/**
 * The top-bar menu for the email digest of top posts, a Supporter feature.
 * A supporter picks how often it comes; anyone else sees what it is and the
 * way to the plan, and can still turn off a digest they had.
 */
export function DigestMenu({
  value,
  entitled,
}: {
  value: Digest;
  /** Has the plan, so the digest can be turned on. */
  entitled: boolean;
}) {
  const fetcher = useFetcher();
  const pending = fetcher.formData?.get("digest");
  const current = (typeof pending === "string" ? pending : value) as Digest;
  const choose = (next: Digest) => fetcher.submit({ digest: next }, { method: "post", action: "/api/digest" });

  return (
    <DropdownMenu.Root>
      <DropdownMenu.Trigger asChild>
        <IconButton aria-label={`Email digest: ${LABEL[current]}`}>
          <Newspaper size={18} aria-hidden />
        </IconButton>
      </DropdownMenu.Trigger>
      <DropdownMenu.Portal>
        <DropdownMenu.Content align="end" sideOffset={4} className={`${MENU_CONTENT} w-64`}>
          <div className="px-2.5 pt-2 pb-1.5">
            <p className="text-body font-semibold">Email digest</p>
            <p className="mt-0.5 text-meta text-text-muted">
              {entitled
                ? "The top posts, sent to your sign-in email."
                : "The top posts by email, for supporters."}
            </p>
          </div>
          <DropdownMenu.RadioGroup value={current} onValueChange={(next) => choose(next as Digest)}>
            {DIGESTS.map((option) => (
              <DropdownMenu.RadioItem
                key={option}
                value={option}
                // Without the plan, only Off can be picked.
                disabled={!entitled && option !== "off"}
                className={MENU_RADIO_ITEM}
              >
                {LABEL[option]}
                <DropdownMenu.ItemIndicator className="ml-auto">
                  <Check size={16} aria-hidden />
                </DropdownMenu.ItemIndicator>
              </DropdownMenu.RadioItem>
            ))}
          </DropdownMenu.RadioGroup>
          {entitled ? null : (
            <DropdownMenu.Item asChild className={MENU_RADIO_ITEM}>
              <Link to="/supporter?for=digest" className="font-medium text-accent">
                Become a supporter
              </Link>
            </DropdownMenu.Item>
          )}
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  );
}
