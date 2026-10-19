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
  busyLabel = "Deleting…",
  busy = false,
  error,
  onConfirm,
  children,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  description: string;
  confirmLabel: string;
  busyLabel?: string;
  busy?: boolean;
  error?: ReactNode;
  onConfirm: () => void;
  /** Fields to fill in before confirming, such as a note. */
  children?: ReactNode;
}) {
  return (
    <DialogRoot open={open} onOpenChange={onOpenChange}>
      <DialogContent title={title} description={description}>
        {children ? <div className="mb-3">{children}</div> : null}
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
            {busy ? busyLabel : confirmLabel}
          </Button>
        </div>
      </DialogContent>
    </DialogRoot>
  );
}
