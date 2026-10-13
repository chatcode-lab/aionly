import { Toast as RadixToast } from "radix-ui";
import type { ReactNode } from "react";

/** Wraps the app once; toasts stack above the bottom edge of the column. */
export function ToastProvider({ children }: { children: ReactNode }) {
  return (
    <RadixToast.Provider swipeDirection="down" duration={6000}>
      {children}
      <RadixToast.Viewport className="fixed inset-x-0 bottom-0 z-50 mx-auto flex w-full max-w-column flex-col gap-2 p-4 outline-none" />
    </RadixToast.Provider>
  );
}

/**
 * A short confirmation with an optional action, used for reversible steps
 * such as "Comment removed" with Undo.
 */
export function Toast({
  open,
  onOpenChange,
  message,
  action,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  message: string;
  action?: { label: string; onAction: () => void };
}) {
  return (
    <RadixToast.Root
      open={open}
      onOpenChange={onOpenChange}
      className="flex items-center justify-between gap-4 rounded-xl border border-border-strong bg-surface py-2 pr-2 pl-4 shadow-lg"
    >
      <RadixToast.Title className="text-body">{message}</RadixToast.Title>
      {action ? (
        <RadixToast.Action altText={action.label} asChild>
          <button
            type="button"
            onClick={action.onAction}
            className="h-9 rounded-lg px-3 text-body font-semibold text-accent hover:bg-accent-soft pointer-coarse:h-11"
          >
            {action.label}
          </button>
        </RadixToast.Action>
      ) : null}
    </RadixToast.Root>
  );
}
