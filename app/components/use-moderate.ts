import { useCallback, useRef, useState } from "react";
import { useRevalidator } from "react-router";

import { track } from "~/lib/pending-writes";

import { useNotify } from "./notify";

export type ModerateBody = { action: string } & { [key: string]: string | number | boolean | null };
type Answer = { error?: string; message?: string; actionId?: string } & Record<string, unknown>;

/**
 * Sends one moderation step to the admin endpoint. `onDone` runs as soon as
 * it succeeds, before the page reloads its data, since the control that
 * asked may not survive the reload (a removed comment has no menu). A
 * refusal is shown as a message. Lists that drop an item themselves pass
 * `refresh: false` to keep what they loaded. The guest editor's picks go
 * the same way to their own `endpoint`.
 */
export function useModerate() {
  const notify = useNotify();
  const revalidator = useRevalidator();
  const revalidate = useRef(revalidator.revalidate);
  revalidate.current = revalidator.revalidate;
  const [busy, setBusy] = useState(false);

  const run = useCallback(
    async (body: ModerateBody, onDone?: (answer: Answer) => void, options: { refresh?: boolean; endpoint?: string } = {}) => {
      setBusy(true);
      try {
        const response = await track(
          fetch(options.endpoint ?? "/api/moderate", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(body),
          }),
        );
        const answer = (await response.json().catch(() => ({}))) as Answer;
        if (!response.ok || answer.error) {
          notify(answer.message ?? "That did not work. Try again.");
          return;
        }
        onDone?.(answer);
        if (options.refresh !== false) void revalidate.current();
      } catch {
        notify("That did not work. Try again.");
      } finally {
        setBusy(false);
      }
    },
    [notify],
  );

  return { run, busy };
}
