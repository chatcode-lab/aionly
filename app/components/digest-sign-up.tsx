import { type ReactNode, useState } from "react";
import { Form } from "react-router";

import { CADENCE, FREQUENCIES, type Frequency } from "~/lib/digest/frequency";

import { CopyButton, GoogleMark } from "./sign-in";
import { Button } from "./ui/button";

const LABELS: Record<Frequency, string> = { daily: "Daily", weekly: "Weekly", monthly: "Monthly" };

/** The partner link's page with the digest chosen, where the visitor returns to `next`. */
export function digestJoinPath(code: string, digest: Frequency, next: string): string {
  return `/join/${code}?${new URLSearchParams(next === "/" ? { digest } : { digest, next })}`;
}

/**
 * Joining for the email digest: how often it comes, then Continue with
 * Google through the partner link `code`, which keeps both for the account
 * the sign-up makes. Radio buttons, so the choice goes with the form without
 * scripts too. Inside an app's own browser, where Google refuses to sign
 * anyone in, the link to the same choice, to open in a real browser.
 */
export function DigestSignUp({
  code,
  next,
  chosen = "daily",
  inAppBrowser,
  onLeave,
  aside,
}: {
  code: string;
  /** Where the visitor returns afterwards. */
  next: string;
  chosen?: Frequency;
  /** The app whose browser this is, or null in a regular browser. */
  inAppBrowser: string | null;
  /** Called as the browser leaves for Google. */
  onLeave?: () => void;
  /** Beside Continue with Google, such as a way to say not now. */
  aside?: ReactNode;
}) {
  const [digest, setDigest] = useState<Frequency>(chosen);
  const choice = (
    <fieldset>
      <legend className="sr-only">How often</legend>
      <div className="grid grid-cols-3 gap-0.5 rounded-lg bg-surface-2 p-0.5">
        {FREQUENCIES.map((frequency) => (
          <label
            key={frequency}
            className="inline-flex h-8 cursor-pointer items-center justify-center rounded-md px-2 text-body whitespace-nowrap text-text-muted transition-colors duration-150 hover:text-text has-checked:bg-surface has-checked:font-medium has-checked:text-text has-checked:shadow-sm has-focus-visible:outline-2 has-focus-visible:outline-offset-2 has-focus-visible:outline-accent pointer-coarse:h-10"
          >
            <input
              type="radio"
              name="digest"
              value={frequency}
              checked={digest === frequency}
              onChange={() => setDigest(frequency)}
              className="sr-only"
            />
            {LABELS[frequency]}
          </label>
        ))}
      </div>
      <p aria-live="polite" className="mt-1.5 text-meta text-text-muted">
        {CADENCE[digest]}
      </p>
    </fieldset>
  );

  if (inAppBrowser) {
    const path = digestJoinPath(code, digest, next);
    const link = typeof window === "undefined" ? path : new URL(path, window.location.origin).href;
    return (
      <div className="space-y-3">
        {choice}
        <p className="text-body">
          Google sign-in does not work inside {inAppBrowser}&apos;s browser. Copy the link and open it in your browser
          to join.
        </p>
        <div className="flex flex-wrap gap-2">
          <CopyButton text={link} label="Copy link" done="Link copied" className="flex-1" />
          {aside}
        </div>
      </div>
    );
  }

  return (
    // A full page load: the browser leaves for Google from here.
    <Form method="post" action={`/join/${code}`} reloadDocument onSubmit={onLeave} className="space-y-3">
      <input type="hidden" name="next" value={next} />
      {choice}
      <div className="flex flex-wrap gap-2">
        <Button type="submit" className="flex-1">
          <GoogleMark />
          Continue with Google
        </Button>
        {aside}
      </div>
    </Form>
  );
}
