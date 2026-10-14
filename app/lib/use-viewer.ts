import { useRouteLoaderData } from "react-router";

import type { ViewerSummary } from "./public-types";

/** The signed-in account, on any page; null when signed out. */
export function useViewer(): ViewerSummary | null {
  const root = useRouteLoaderData("root") as { viewer?: ViewerSummary | null } | undefined;
  return root?.viewer ?? null;
}
