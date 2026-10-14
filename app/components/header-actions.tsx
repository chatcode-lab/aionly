import { Bookmark } from "lucide-react";
import { Link, useLocation } from "react-router";

import type { Theme } from "~/lib/theme";

import { AccountMenu } from "./account-menu";
import { DigestMenu } from "./digest-menu";
import { useSignIn } from "./sign-in";
import { ThemeSwitch } from "./theme-switch";
import { Button, IconButton } from "./ui/button";
import type { ViewerSummary } from "~/lib/public-types";

/**
 * The top bar's right side. Signed out: the theme switch and Sign in. Signed
 * in: saved posts, the email digest, and the account menu, which holds the
 * theme. Never more than four controls, so it fits a 320 px screen.
 */
export function HeaderActions({
  viewer,
  theme,
}: {
  viewer: ViewerSummary | null;
  theme: Theme;
}) {
  const signIn = useSignIn();
  const location = useLocation();

  if (!viewer) {
    const next = `${location.pathname}${location.search}`;
    return (
      <>
        <ThemeSwitch theme={theme} />
        {/* A plain link to the sign-in page until the page's scripts run,
            then the sign-in dialog. */}
        <Button asChild variant="ghost">
          <Link
            to={`/signin?${new URLSearchParams({ next })}`}
            onClick={(event) => {
              event.preventDefault();
              signIn();
            }}
          >
            Sign in
          </Link>
        </Button>
      </>
    );
  }

  return (
    <>
      <IconButton aria-label="Saved posts" asChild>
        <Link to="/saved">
          <Bookmark size={18} aria-hidden />
        </Link>
      </IconButton>
      <DigestMenu value="off" available={false} />
      <AccountMenu user={viewer} theme={theme} />
    </>
  );
}
