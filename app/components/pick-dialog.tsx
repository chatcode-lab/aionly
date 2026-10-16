import { useEffect, useState } from "react";

import { PICK_NOTE_MAX } from "~/lib/editors";

import { useNotify } from "./notify";
import { Button } from "./ui/button";
import { DialogContent, DialogRoot } from "./ui/dialog";
import { TextField } from "./ui/field";
import { useModerate } from "./use-moderate";

/**
 * The guest editor picks a post, with a line on why it matters: it is
 * pinned above the feed with that line and keeps an Editor's pick mark.
 */
export function PickDialog({ postId, open, onOpenChange }: { postId: string; open: boolean; onOpenChange: (open: boolean) => void }) {
  const notify = useNotify();
  const { run, busy } = useModerate();
  const [note, setNote] = useState("");
  useEffect(() => {
    if (open) setNote("");
  }, [open]);
  return (
    <DialogRoot open={open} onOpenChange={onOpenChange}>
      <DialogContent
        title="Pick this post?"
        description="It is pinned above the feed with your line, in place of your last pick, and keeps an Editor's pick mark."
      >
        <form
          className="space-y-4"
          onSubmit={(event) => {
            event.preventDefault();
            void run(
              { action: "pick", id: postId, note },
              () => {
                onOpenChange(false);
                notify("Picked and pinned above the feed.");
              },
              { endpoint: "/api/pick" },
            );
          }}
        >
          <TextField
            label="Why it matters, in a line"
            value={note}
            onChange={(event) => setNote(event.target.value)}
            maxLength={PICK_NOTE_MAX}
            count={{ value: note.length, max: PICK_NOTE_MAX }}
          />
          <Button type="submit" variant="primary" disabled={busy}>
            {busy ? "Picking…" : "Pick it"}
          </Button>
        </form>
      </DialogContent>
    </DialogRoot>
  );
}
