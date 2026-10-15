import { redirect } from "react-router";

import { SignInPanel } from "~/components/sign-in";
import { authFor, xConfigured } from "~/lib/auth.server";
import { detectInAppBrowser } from "~/lib/in-app-browser";
import { withinLimits } from "~/lib/security/rate-limit.server";
import { safeReturnPath } from "~/lib/security/request";
import { viewerOf } from "~/lib/viewer.server";
import { privatePageMeta } from "~/lib/meta";

import type { Route } from "./+types/signin";

export function meta({ matches, location }: Route.MetaArgs) {
  return privatePageMeta(matches, "Sign in", location.pathname);
}

const ERRORS: Record<string, string> = {
  // Better Auth's names for a refused or abandoned sign-in.
  access_denied: "Sign-in was cancelled. Try again when you are ready.",
  email_not_found: "Your account there did not share an email address, which an account here needs.",
  email_not_verified:
    "Your account there has no verified email, which a new account here needs. On X, add and confirm an email in its settings; or continue with Google.",
  // Another account here already has the email this sign-in brought.
  account_not_linked:
    "That email already belongs to an account here. Sign in the way you made it, then link this one in Settings.",
  rate_limited: "Too many sign-ins from this network just now. Wait a minute, then try again.",
  // A Google or X account whose board account was deleted: lately, or while banned.
  identity_deleted: "The account this sign-in made here was deleted in the last 30 days. A new one can be made after that.",
  identity_banned: "This account cannot make a new account here.",
  // A new account without an invitation, or with one that no longer works.
  invite_required: "aion.ly takes new members by invitation. Enter the code you were given below, or open the link, then sign in.",
  invite_invalid: "That invitation no longer works: it was used, revoked, or expired, or its sender cannot invite now. Ask for a new one.",
  unable_to_get_user_info: "X did not share the account's details. Try again later, or continue with Google.",
  invalid_code: "The sign-in was not accepted. Try again.",
  state_mismatch: "The sign-in started in another tab or expired. Try again from here.",
  please_restart_the_process: "The sign-in started in another tab or expired. Try again from here.",
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
      ? (ERRORS[code] ?? `Sign-in did not finish (${code.replace(/[^\w.-]/g, "").slice(0, 60) || "unknown"}). Try again in a moment.`)
      : undefined,
  };
}

/**
 * Starts Google or X sign-in. New accounts come back through the welcome
 * step; everyone else returns to where they were.
 */
export async function action({ request }: Route.ActionArgs) {
  const origin = new URL(request.url).origin;
  const form = await request.formData();
  const next = safeReturnPath(String(form.get("next") ?? ""), origin);
  if (!(await withinLimits(request, "signin", null))) {
    throw redirect(`/signin?${new URLSearchParams({ next, error: "rate_limited" })}`);
  }

  // Either makes a new account, with an invitation, or signs in one that has it linked.
  const provider = form.get("provider") === "x" && xConfigured() ? "twitter" : "google";
  const response = await authFor(request).api.signInSocial({
    body: {
      provider,
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
