import { useEffect, useState } from "react";

import { track } from "~/lib/pending-writes";
import { NOTE_MAX, REASON_LABEL, REASONS, type ReportReason, type ReportTarget } from "~/lib/reports";
import { length } from "~/lib/submit/rules";

import { useNotify } from "./notify";
import { Button } from "./ui/button";
import { DialogClose, DialogContent, DialogRoot } from "./ui/dialog";
import { TextArea } from "./ui/field";

const TITLE: Record<ReportTarget, string> = {
  post: "Report post",
  comment: "Report comment",
  user: "Report user",
};

/**
 * Asks why something is reported, with an optional note, and files it.
 * Reports go to moderators; nothing is removed automatically.
 */
export function ReportDialog({
  type,
  id,
  open,
  onOpenChange,
}: {
  type: ReportTarget;
  id: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const notify = useNotify();
  const [reason, setReason] = useState<ReportReason>(REASONS[type][0]!);
  const [note, setNote] = useState("");
  const [error, setError] = useState<string>();
  const [sending, setSending] = useState(false);

  useEffect(() => {
    if (!open) return;
    setReason(REASONS[type][0]!);
    setNote("");
    setError(undefined);
  }, [open, type]);

  const send = async () => {
    setSending(true);
    setError(undefined);
    try {
      const response = await track(
        fetch("/api/report", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ type, id, reason, note }),
        }),
      );
      const data = (await response.json().catch(() => ({}))) as { existing?: boolean; message?: string };
      if (!response.ok) {
        setError(data.message ?? "The report did not go through. Try again.");
        return;
      }
      onOpenChange(false);
      notify(data.existing ? "You reported this already; it is still waiting for a moderator." : "Report sent. A moderator will look at it.");
    } catch {
      setError("The report did not go through. Try again.");
    } finally {
      setSending(false);
    }
  };

  const tooLong = length(note) > NOTE_MAX;
  return (
    <DialogRoot open={open} onOpenChange={onOpenChange}>
      <DialogContent title={TITLE[type]} description="Reports go to a moderator. Nothing is removed automatically.">
        <form
          className="space-y-4"
          onSubmit={(event) => {
            event.preventDefault();
            if (!tooLong) void send();
          }}
        >
          <fieldset>
            <legend className="text-body font-medium">Reason</legend>
            <div className="mt-1">
              {REASONS[type].map((option) => (
                <label key={option} className="flex h-9 items-center gap-2.5 text-body pointer-coarse:h-(--touch)">
                  <input
                    type="radio"
                    name="reason"
                    value={option}
                    checked={reason === option}
                    onChange={() => setReason(option)}
                    className="size-4 accent-(--accent)"
                  />
                  {REASON_LABEL[option]}
                </label>
              ))}
            </div>
          </fieldset>
          <TextArea
            label="Anything to add?"
            hint="Optional. Moderators see it; the author does not."
            rows={3}
            value={note}
            onChange={(event) => setNote(event.target.value)}
            count={{ value: length(note), max: NOTE_MAX }}
            error={tooLong ? `Keep it to ${NOTE_MAX} characters.` : error}
          />
          <div className="flex justify-end gap-2">
            <DialogClose asChild>
              <Button variant="ghost">Cancel</Button>
            </DialogClose>
            <Button variant="primary" type="submit" disabled={sending || tooLong}>
              {sending ? "Sending…" : "Send report"}
            </Button>
          </div>
        </form>
      </DialogContent>
    </DialogRoot>
  );
}
