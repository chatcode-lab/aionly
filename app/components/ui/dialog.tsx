import { X } from "lucide-react";
import { Dialog as RadixDialog } from "radix-ui";
import type { ReactNode } from "react";

import { IconButton } from "./button";

export const DialogRoot = RadixDialog.Root;
export const DialogTrigger = RadixDialog.Trigger;
export const DialogClose = RadixDialog.Close;

/**
 * A modal dialog. On small screens it sits at the bottom edge as a sheet,
 * within thumb reach; on larger ones it is centered.
 */
export function DialogContent({
  title,
  description,
  children,
}: {
  title: string;
  description?: string;
  children: ReactNode;
}) {
  return (
    <RadixDialog.Portal>
      <RadixDialog.Overlay className="fixed inset-0 z-50 bg-overlay" />
      <RadixDialog.Content
        // Radix warns when a dialog has no description; say so explicitly.
        {...(description ? {} : { "aria-describedby": undefined })}
        className="fixed inset-x-0 bottom-0 z-50 max-h-[85dvh] overflow-y-auto rounded-t-2xl border border-border bg-surface p-5 shadow-xl sm:inset-x-auto sm:top-1/2 sm:bottom-auto sm:left-1/2 sm:w-full sm:max-w-md sm:-translate-x-1/2 sm:-translate-y-1/2 sm:rounded-2xl"
      >
        <div className="flex items-start justify-between gap-4">
          <div>
            <RadixDialog.Title className="text-title font-semibold">
              {title}
            </RadixDialog.Title>
            {description ? (
              <RadixDialog.Description className="mt-1 text-body text-text-muted">
                {description}
              </RadixDialog.Description>
            ) : null}
          </div>
          <RadixDialog.Close asChild>
            <IconButton aria-label="Close" className="-mt-1.5 -mr-1.5">
              <X size={18} aria-hidden />
            </IconButton>
          </RadixDialog.Close>
        </div>
        <div className="mt-4">{children}</div>
      </RadixDialog.Content>
    </RadixDialog.Portal>
  );
}
