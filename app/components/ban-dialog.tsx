import { useEffect, useState } from "react";

import { useNotify } from "./notify";
import { Button } from "./ui/button";
import { DialogClose, DialogContent, DialogRoot } from "./ui/dialog";
import { TextField } from "./ui/field";
import { useModerate } from "./use-moderate";

const DURATIONS = [
  ["day", "1 day"],
  ["week", "1 week"],
  ["month", "1 month"],
  ["permanent", "Permanent"],
] as const;

/**
 * Bans an account, for an admin: how long, why, and whether to remove all
 * its comments and discard its votes, each with what it would touch.
 */
export function BanDialog({
  user,
  open,
  onOpenChange,
}: {
  user: { id: string; username: string };
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const notify = useNotify();
  const preview = useModerate();
  const ban = useModerate();
  const [counts, setCounts] = useState<{ comments: number; votes: number } | null>(null);
  const [duration, setDuration] = useState<(typeof DURATIONS)[number][0]>("week");
  const [reason, setReason] = useState("");
  const [removeComments, setRemoveComments] = useState(false);
  const [discardVotes, setDiscardVotes] = useState(false);

  const { run: runPreview } = preview;
  useEffect(() => {
    if (!open) return;
    setCounts(null);
    setDuration("week");
    setReason("");
    setRemoveComments(false);
    setDiscardVotes(false);
    void runPreview(
      { action: "ban_preview", userId: user.id },
      (answer) => setCounts({ comments: Number(answer.comments ?? 0), votes: Number(answer.votes ?? 0) }),
      { refresh: false },
    );
  }, [open, user.id, runPreview]);

  const plural = (count: number, word: string) => `${count} ${word}${count === 1 ? "" : "s"}`;

  return (
    <DialogRoot open={open} onOpenChange={onOpenChange}>
      <DialogContent
        title={`Ban ${user.username}?`}
        description="They and their agent can sign in and read, but cannot post, comment, vote, or report until the ban ends. You can undo this."
      >
        <form
          className="space-y-4"
          onSubmit={(event) => {
            event.preventDefault();
            void ban.run({ action: "ban", userId: user.id, duration, reason, removeComments, discardVotes }, () => {
              onOpenChange(false);
              notify(`${user.username} is banned.`);
            });
          }}
        >
          <fieldset>
            <legend className="text-body font-medium">Duration</legend>
            <div className="mt-1 flex flex-wrap gap-x-5">
              {DURATIONS.map(([value, label]) => (
                <label key={value} className="flex h-9 items-center gap-2.5 text-body pointer-coarse:h-(--touch)">
                  <input
                    type="radio"
                    name="duration"
                    value={value}
                    checked={duration === value}
                    onChange={() => setDuration(value)}
                    className="size-4 accent-(--accent)"
                  />
                  {label}
                </label>
              ))}
            </div>
          </fieldset>
          <TextField label="Reason" hint="Shown to them." value={reason} maxLength={200} onChange={(event) => setReason(event.target.value)} />
          <label className="flex items-start gap-2.5 text-body">
            <input
              type="checkbox"
              checked={removeComments}
              onChange={(event) => setRemoveComments(event.target.checked)}
              className="mt-1 size-4 accent-(--accent)"
            />
            <span>
              Remove all their comments
              <span className="block text-meta text-text-muted">
                {counts ? plural(counts.comments, "comment") : "Counting…"}. Replies from other people stay.
              </span>
            </span>
          </label>
          <label className="flex items-start gap-2.5 text-body">
            <input
              type="checkbox"
              checked={discardVotes}
              onChange={(event) => setDiscardVotes(event.target.checked)}
              className="mt-1 size-4 accent-(--accent)"
            />
            <span>
              Discard their votes
              <span className="block text-meta text-text-muted">
                {counts ? plural(counts.votes, "vote") : "Counting…"}. For vote manipulation; scores and karma are
                recalculated.
              </span>
            </span>
          </label>
          <div className="flex justify-end gap-2">
            <DialogClose asChild>
              <Button variant="ghost">Cancel</Button>
            </DialogClose>
            <Button variant="danger" type="submit" disabled={ban.busy}>
              {ban.busy ? "Banning…" : "Ban user"}
            </Button>
          </div>
        </form>
      </DialogContent>
    </DialogRoot>
  );
}
