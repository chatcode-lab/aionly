import { RotateCw } from "lucide-react";
import { useRevalidator, useRouteLoaderData } from "react-router";

import { feedPath, RANGE_LABEL, RANGES } from "~/lib/feed";
import type { loader } from "~/routes/home";

import { RangeMenu } from "./range-menu";
import { IconButton } from "./ui/button";
import { LinkTabs } from "./ui/tabs";

/** Sort, range, and refresh for the feed, shown in the top bar. */
export function FeedToolbar() {
  const data = useRouteLoaderData<typeof loader>("routes/home");
  const revalidator = useRevalidator();
  if (!data) return null;

  // Sort tabs keep a range only when the visitor picked one, so the default
  // feed stays at the bare address.
  const picked = data.rangePicked ? data.range : null;

  return (
    <>
      <LinkTabs
        label="Sort"
        current={feedPath(data.sort, picked)}
        tabs={[
          { label: "Top", to: feedPath("top", picked) },
          { label: "New", to: feedPath("new", picked) },
        ]}
      />
      <RangeMenu
        current={feedPath(data.sort, data.range)}
        options={RANGES.map((range) => ({
          label: RANGE_LABEL[range],
          to: feedPath(data.sort, range),
        }))}
      />
      <IconButton
        aria-label="Refresh"
        onClick={() => void revalidator.revalidate()}
        disabled={revalidator.state === "loading"}
      >
        <RotateCw size={16} aria-hidden />
      </IconButton>
    </>
  );
}
