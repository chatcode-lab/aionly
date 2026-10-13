import { useSyncExternalStore } from "react";

export type ResolvedTheme = "light" | "dark";

function subscribe(onChange: () => void): () => void {
  const media = window.matchMedia("(prefers-color-scheme: dark)");
  media.addEventListener("change", onChange);
  const observer = new MutationObserver(onChange);
  observer.observe(document.documentElement, {
    attributes: true,
    attributeFilter: ["data-theme"],
  });
  return () => {
    media.removeEventListener("change", onChange);
    observer.disconnect();
  };
}

function snapshot(): ResolvedTheme {
  const chosen = document.documentElement.dataset.theme;
  if (chosen === "light" || chosen === "dark") return chosen;
  return window.matchMedia("(prefers-color-scheme: dark)").matches
    ? "dark"
    : "light";
}

/**
 * The color scheme actually on screen, with "system" resolved against the
 * device. Embeds are themed from this, so a frame built with it follows a
 * theme change. It is null during server rendering, when only the browser
 * knows the answer.
 */
export function useResolvedTheme(): ResolvedTheme | null {
  return useSyncExternalStore(subscribe, snapshot, () => null);
}
