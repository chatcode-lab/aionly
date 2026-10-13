import { data } from "react-router";

import { parseTheme, themeCookie } from "~/lib/theme";

import type { Route } from "./+types/theme";

/** Remembers the theme choice. Called by the header's theme switch. */
export async function action({ request }: Route.ActionArgs) {
  const form = await request.formData();
  const theme = parseTheme(form.get("theme"));
  const secure = new URL(request.url).protocol === "https:";

  return data(
    { theme },
    { headers: { "Set-Cookie": themeCookie(theme, secure) } },
  );
}
