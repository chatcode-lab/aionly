import { redirect } from "react-router";

import { SignInPanel, type SignInTab, tabForError } from "~/components/sign-in";
import { authFor, googleSignIn, startSignIn, xConfigured } from "~/lib/auth.server";
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
  // Better Auth's names for a refused or abandoned Google sign-in.
  access_denied: "Sign-in was cancelled. Try again when you are ready.",
  email_not_found: "Your Google account did not share an email address, which an account here needs.",
  email_not_verified: "Google has not verified this account's email. Verify it with Google, then try again.",
  // Another Google account already signed up with the same email.
  account_not_linked: "That email already belongs to an account here, made with a different Google account.",
  rate_limited: "Too many sign-ins from this network just now. Wait a minute, then try again.",
  // A Google account whose board account was deleted: lately, or while banned.
  identity_deleted: "The account this Google account made here was deleted in the last 30 days. A new one can be made after that.",
  identity_banned: "This Google account cannot make a new account here.",
  // A new account without an invitation, or with one that no longer works.
  invite_required: "That Google account has no account here yet, and a new one needs an invitation. Enter its code below, or open the link you were given.",
  invite_invalid: "That invitation no longer works: it was used, revoked, or expired, or its sender cannot invite now. Ask for a new one.",
  invalid_code: "The sign-in was not accepted. Try again.",
  // X signs in only to an account it was linked to in Settings.
  signup_disabled: "No account here has this X account linked. Sign in with Google or by email, then link X in Settings.",
  x_unavailable: "Signing in with X is not available here.",
  // A sign-in link: used, expired, or for no account.
  INVALID_TOKEN: "That sign-in link was used already or has expired. Ask for a new one below.",
  new_user_signup_disabled: "That email has no account here. A new one needs an invitation: see New member.",
  email_invalid: "That does not look like an email address. Check it and try again.",
  state_mismatch: "The sign-in started in another tab or expired. Try again from here.",
  please_restart_the_process: "The sign-in started in another tab or expired. Try again from here.",
};

export async function loader({ request, context }: Route.LoaderArgs) {
  const url = new URL(request.url);
  const next = safeReturnPath(url.searchParams.get("next"), url.origin);
  if (await viewerOf(context)) throw redirect(next);

  const code = url.searchParams.get("error");
  const asked = url.searchParams.get("tab");
  return {
    next,
    // The tab asked for, or New member, unless a sign-in was refused for
    // something other than a missing invitation.
    tab: (asked === "member" || asked === "join" ? asked : tabForError(code)) as SignInTab,
    // A sign-in link was asked for: whether one went is not said.
    sent: url.searchParams.has("sent"),
    inAppBrowser: detectInAppBrowser(request.headers.get("User-Agent") ?? ""),
    error: code
      ? (ERRORS[code] ?? `Sign-in did not finish (${code.replace(/[^\w.-]/g, "").slice(0, 60) || "unknown"}). Try again in a moment.`)
      : undefined,
  };
}

/** The sign-in screen's Sign in tab, with what to show there. */
function memberTab(next: string, extra: Record<string, string> = {}): string {
  return `/signin?${new URLSearchParams({ tab: "member", next, ...extra })}`;
}

/**
 * Starts a sign-in: with Google, which makes the account too where it may,
 * and new accounts come back through the welcome step; with X, for an
 * account it is linked to; or by a link sent to the account's email. Every
 * one returns to where the member was.
 */
export async function action({ request }: Route.ActionArgs) {
  const origin = new URL(request.url).origin;
  const form = await request.formData();
  const next = safeReturnPath(String(form.get("next") ?? ""), origin);
  const intent = form.get("intent");
  if (!(await withinLimits(request, "signin", null))) {
    throw redirect(intent === "email" || intent === "x" ? memberTab(next, { error: "rate_limited" }) : `/signin?${new URLSearchParams({ next, error: "rate_limited" })}`);
  }

  if (intent === "email") {
    const email = String(form.get("email") ?? "").trim().toLowerCase();
    if (email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw redirect(memberTab(next, { error: "email_invalid" }));
    const sent = await authFor(request).api.signInMagicLink({
      body: { email, callbackURL: next, errorCallbackURL: memberTab(next) },
      headers: request.headers,
      asResponse: true,
    });
    throw redirect(memberTab(next, sent.ok ? { sent: "" } : { error: "start" }));
  }

  if (intent === "x" && !xConfigured()) throw redirect(memberTab(next, { error: "x_unavailable" }));
  const started =
    intent === "x"
      ? await startSignIn(request, { provider: "twitter", callbackURL: next, errorCallbackURL: memberTab(next) })
      : await googleSignIn(request, next);
  if (!started) throw redirect(`/signin?${new URLSearchParams({ next, error: "start" })}`);
  return started;
}

export default function SignIn({ loaderData }: Route.ComponentProps) {
  const { next } = loaderData;
  return (
    <main className="mx-auto max-w-md px-(--gutter) py-10">
      <h1 className="mb-6 text-display font-semibold">Join or sign in</h1>
      <SignInPanel
        next={next}
        inAppBrowser={loaderData.inAppBrowser}
        error={loaderData.error}
        sent={loaderData.sent}
        tab={loaderData.tab}
        tabHref={(tab) => `/signin?${new URLSearchParams(tab === "join" ? { next } : { next, tab })}`}
      />
    </main>
  );
}
