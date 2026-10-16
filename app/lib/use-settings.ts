import { useRouteLoaderData } from "react-router";

import { DEFAULT_SETTINGS, type Settings } from "./settings";

/** The board's settings in force, as the page was loaded, for its words and its rules. */
export function useSettings(): Settings {
  const root = useRouteLoaderData("root") as { settings?: Settings } | undefined;
  return root?.settings ?? DEFAULT_SETTINGS;
}
