import { createContext, type ReactNode, useCallback, useContext, useState } from "react";

import { Toast } from "./ui/toast";

type ToastAction = { label: string; onAction: () => void };
type Notify = (message: string, action?: ToastAction) => void;

const NotifyContext = createContext<Notify>(() => {});

/**
 * Shows a short message in the toast area, with an optional action such as
 * Undo. One at a time is enough.
 */
export function useNotify(): Notify {
  return useContext(NotifyContext);
}

export function NotifyProvider({ children }: { children: ReactNode }) {
  const [toast, setToast] = useState<{ message: string; action?: ToastAction; key: number } | null>(null);
  const [open, setOpen] = useState(false);

  const notify = useCallback<Notify>((message, action) => {
    setToast((current) => ({ message, action, key: (current?.key ?? 0) + 1 }));
    setOpen(true);
  }, []);

  return (
    <NotifyContext value={notify}>
      {children}
      <Toast
        key={toast?.key}
        open={open}
        onOpenChange={setOpen}
        message={toast?.message ?? ""}
        action={toast?.action}
      />
    </NotifyContext>
  );
}
