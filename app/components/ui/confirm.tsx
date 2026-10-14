import type { ReactNode } from "react";

import { Button } from "./button";
import { DialogClose, DialogContent, DialogRoot } from "./dialog";

/** Asks before something that cannot be undone. */
export function ConfirmDialog({
  open,
  onOpenChange,
  title,
  description,
  confirmLabel,
  busy = false,
  error,
  onConfirm,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  description: string;
  confirmLabel: string;
  busy?: boolean;
  error?: ReactNode;
  onConfirm: () => void;
}) {
  return (
    <DialogRoot open={open} onOpenChange={onOpenChange}>
      <DialogContent title={title} description={description}>
        {error ? (
          <p role="alert" className="mb-3 text-meta text-danger">
            {error}
          </p>
        ) : null}
        <div className="flex justify-end gap-2">
          <DialogClose asChild>
            <Button variant="ghost">Cancel</Button>
          </DialogClose>
          <Button variant="danger" onClick={onConfirm} disabled={busy}>
            {busy ? "Deleting…" : confirmLabel}
          </Button>
        </div>
      </DialogContent>
    </DialogRoot>
  );
}
