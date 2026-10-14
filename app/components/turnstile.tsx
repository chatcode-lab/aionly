import { useEffect, useRef } from "react";

import { useResolvedTheme } from "~/lib/use-resolved-theme";

const SCRIPT = "https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit";

interface TurnstileApi {
  render: (element: HTMLElement, options: Record<string, unknown>) => string;
  remove: (widgetId: string) => void;
}

declare global {
  interface Window {
    turnstile?: TurnstileApi;
  }
}

let loading: Promise<TurnstileApi> | null = null;

/** Loads Cloudflare's script once per page; the page's only third-party script. */
function loadTurnstile(): Promise<TurnstileApi> {
  if (window.turnstile) return Promise.resolve(window.turnstile);
  loading ??= new Promise((resolve, reject) => {
    const script = document.createElement("script");
    script.src = SCRIPT;
    script.async = true;
    script.onload = () => (window.turnstile ? resolve(window.turnstile) : reject(new Error("no turnstile")));
    script.onerror = () => {
      loading = null;
      reject(new Error("turnstile did not load"));
    };
    document.head.appendChild(script);
  });
  return loading;
}

/**
 * Cloudflare Turnstile, in the site theme. Calls `onToken` with a token when
 * the check passes and with "" when it expires; an expired check refreshes
 * itself, so a long draft is never lost to it.
 */
export function Turnstile({
  siteKey,
  action,
  onToken,
}: {
  siteKey: string;
  action: string;
  onToken: (token: string) => void;
}) {
  const container = useRef<HTMLDivElement>(null);
  const theme = useResolvedTheme();
  const callback = useRef(onToken);
  callback.current = onToken;

  useEffect(() => {
    const element = container.current;
    if (!element || !theme) return;
    let widget: string | null = null;
    let cancelled = false;
    loadTurnstile()
      .then((api) => {
        if (cancelled) return;
        widget = api.render(element, {
          sitekey: siteKey,
          action,
          theme,
          size: "flexible",
          "refresh-expired": "auto",
          "response-field": false,
          callback: (token: string) => callback.current(token),
          "expired-callback": () => callback.current(""),
          "error-callback": () => callback.current(""),
        });
      })
      .catch(() => callback.current(""));
    return () => {
      cancelled = true;
      if (widget) window.turnstile?.remove(widget);
      callback.current("");
    };
  }, [siteKey, action, theme]);

  // Reserves the widget's height, so the form does not jump as it appears.
  return <div ref={container} className="min-h-[65px]" />;
}
