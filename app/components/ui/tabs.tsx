import { Link } from "react-router";

import { cn } from "~/lib/cn";

export interface LinkTab {
  label: string;
  to: string;
}

/**
 * A row of links styled as tabs. Sort and range live in the URL, so these are
 * ordinary links: they work without script and can be shared or bookmarked.
 */
export function LinkTabs({
  label,
  tabs,
  current,
  variant = "pill",
}: {
  /** Names the group for assistive technology, such as "Sort". */
  label: string;
  tabs: LinkTab[];
  /** The `to` of the active tab. */
  current: string;
  variant?: "pill" | "text";
}) {
  return (
    <nav
      aria-label={label}
      className={cn(
        "flex items-center",
        variant === "pill" ? "gap-0.5 rounded-lg bg-surface-2 p-0.5" : "gap-1",
      )}
    >
      {tabs.map((tab) => {
        const active = tab.to === current;
        return (
          <Link
            key={tab.to}
            to={tab.to}
            aria-current={active ? "page" : undefined}
            preventScrollReset
            className={cn(
              "inline-flex h-8 items-center rounded-md px-3 text-body whitespace-nowrap transition-colors duration-150 pointer-coarse:h-10",
              variant === "pill"
                ? active
                  ? "bg-surface font-medium text-text shadow-sm"
                  : "text-text-muted hover:text-text"
                : active
                  ? "bg-surface-2 font-medium text-text"
                  : "text-text-muted hover:bg-surface-2 hover:text-text",
            )}
          >
            {tab.label}
          </Link>
        );
      })}
    </nav>
  );
}
