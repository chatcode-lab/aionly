import { env } from "cloudflare:workers";
import { redirect, type RouterContextProvider } from "react-router";

import { viewerContext } from "../context";
import { authFor } from "./auth.server";
import { accountRecord, type AccountRecord, createProfile } from "./db/accounts.server";

// Better Auth's session cookie, with or without the `__Secure-` prefix.
const SESSION_COOKIE = /(?:^|;\s*)(?:__Secure-)?better-auth\.session_token=/;

/**
 * Looks up the signed-in account from the session cookie, reading the
 * session from D1 every time. Signed-out requests skip the database.
 */
export async function loadViewer(request: Request): Promise<AccountRecord | null> {
  if (!SESSION_COOKIE.test(request.headers.get("Cookie") ?? "")) return null;

  const session = await authFor(request).api.getSession({
    headers: request.headers,
    query: { disableCookieCache: true },
  });
  if (!session) return null;

  const userId = session.user.id;
  const record = await accountRecord(env.DB, userId);
  if (record) return record.deleted ? null : record;

  // The profile is made as the account is created; if that step failed,
  // make it now.
  await createProfile(env.DB, userId);
  return accountRecord(env.DB, userId);
}

export function viewerOf(
  context: Readonly<RouterContextProvider>,
): Promise<AccountRecord | null> {
  return context.get(viewerContext)();
}

/** Where a signed-out visitor goes to sign in, and comes back from. */
export function signInPath(request: Request): string {
  const url = new URL(request.url);
  const next = `${url.pathname}${url.search}`;
  return `/signin?${new URLSearchParams({ next })}`;
}

function isDataRequest(request: Request): boolean {
  return request.method !== "GET" && request.method !== "HEAD";
}

function refuse(status: 401 | 403, error: string, message: string): Response {
  return Response.json({ error, message }, { status });
}

/**
 * The signed-in account, for actions on the account itself: settings,
 * signing out, deleting it. A banned account passes. Pages redirect a
 * signed-out visitor to sign in; writes answer 401.
 */
export async function requireAccount(
  request: Request,
  context: Readonly<RouterContextProvider>,
): Promise<AccountRecord> {
  const viewer = await viewerOf(context);
  if (viewer) return viewer;
  if (isDataRequest(request)) {
    throw refuse(401, "sign_in", "Sign in to continue.");
  }
  throw redirect(signInPath(request));
}

/**
 * The signed-in account, for taking part: posting, commenting, voting,
 * reporting, saving, and changing the profile. A ban refuses all of these
 * until it ends. Writes repeat the condition in SQL as well.
 */
export async function requireParticipant(
  request: Request,
  context: Readonly<RouterContextProvider>,
): Promise<AccountRecord> {
  const viewer = await requireAccount(request, context);
  if (viewer.ban) {
    throw refuse(403, "banned", "Your account is read-only while the ban lasts.");
  }
  return viewer;
}
