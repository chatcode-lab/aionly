import { redirect } from "react-router";

import { SignInPanel } from "~/components/sign-in";
import { authFor } from "~/lib/auth.server";
import { detectInAppBrowser } from "~/lib/in-app-browser";
import { withinLimits } from "~/lib/security/rate-limit.server";
import { safeReturnPath } from "~/lib/security/request";
import { viewerOf } from "~/lib/viewer.server";

import type { Route } from "./+types/signin";

export function meta(_: Route.MetaArgs) {
  return [{ title: "Sign in · aion.ly" }];
}

const ERRORS: Record<string, string> = {
  // Better Auth's names for a refused or abandoned Google sign-in.
  access_denied: "Sign-in was cancelled. Try again when you are ready.",
  email_not_found: "Your Google account did not share an email address, which an account here needs.",
  email_not_verified: "Google has not verified this account's email. Verify it with Google, then try again.",
  // Another Google account already signed up with the same email.
  account_not_linked: "That email already belongs to an account here, made with a different Google account.",
  rate_limited: "Too many sign-ins from this network just now. Wait a minute, then try again.",
};

export async function loader({ request, context }: Route.LoaderArgs) {
  const url = new URL(request.url);
  const next = safeReturnPath(url.searchParams.get("next"), url.origin);
  if (await viewerOf(context)) throw redirect(next);

  const code = url.searchParams.get("error");
  return {
    next,
    inAppBrowser: detectInAppBrowser(request.headers.get("User-Agent") ?? ""),
    error: code
      ? (ERRORS[code] ?? "Sign-in did not finish. Try again in a moment.")
      : undefined,
  };
}

/**
 * Starts Google sign-in. New accounts come back through the welcome step;
 * everyone else returns to where they were.
 */
export async function action({ request }: Route.ActionArgs) {
  const origin = new URL(request.url).origin;
  const form = await request.formData();
  const next = safeReturnPath(String(form.get("next") ?? ""), origin);
  if (!(await withinLimits(request, "signin", null))) {
    throw redirect(`/signin?${new URLSearchParams({ next, error: "rate_limited" })}`);
  }

  const response = await authFor(request).api.signInSocial({
    body: {
      provider: "google",
      callbackURL: next,
      newUserCallbackURL: `/welcome?${new URLSearchParams({ next })}`,
      errorCallbackURL: `/signin?${new URLSearchParams({ next })}`,
      disableRedirect: true,
    },
    headers: request.headers,
    asResponse: true,
  });
  if (!response.ok) throw redirect(`/signin?${new URLSearchParams({ next, error: "start" })}`);

  // Better Auth answers with Google's address and a cookie that ties the
  // callback to this browser; send the browser on with both.
  const { url } = (await response.json()) as { url: string };
  const headers = new Headers({ Location: url });
  for (const cookie of response.headers.getSetCookie()) {
    headers.append("Set-Cookie", cookie);
  }
  return new Response(null, { status: 302, headers });
}

export default function SignIn({ loaderData }: Route.ComponentProps) {
  return (
    <main className="mx-auto max-w-md px-(--gutter) py-10">
      <h1 className="text-display font-semibold">Sign in</h1>
      <p className="mt-1 mb-6 text-body text-text-muted">
        To vote, save posts, and share what you made or found.
      </p>
      <SignInPanel
        next={loaderData.next}
        inAppBrowser={loaderData.inAppBrowser}
        error={loaderData.error}
      />
    </main>
  );
}
