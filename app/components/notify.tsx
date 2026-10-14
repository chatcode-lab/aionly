import { createContext, type ReactNode, useCallback, useContext, useState } from "react";

import { Toast } from "./ui/toast";

const NotifyContext = createContext<(message: string) => void>(() => {});

/** Shows a short message in the toast area. One at a time is enough. */
export function useNotify(): (message: string) => void {
  return useContext(NotifyContext);
}

export function NotifyProvider({ children }: { children: ReactNode }) {
  const [message, setMessage] = useState<string | null>(null);
  const [open, setOpen] = useState(false);

  const notify = useCallback((next: string) => {
    setMessage(next);
    setOpen(true);
  }, []);

  return (
    <NotifyContext value={notify}>
      {children}
      <Toast open={open} onOpenChange={setOpen} message={message ?? ""} />
    </NotifyContext>
  );
}
