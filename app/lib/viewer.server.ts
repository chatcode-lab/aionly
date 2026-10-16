import { env } from "cloudflare:workers";
import { redirect, type RouterContextProvider } from "react-router";

import { viewerContext } from "../context";
import { authFor } from "./auth.server";
import { accountRecord, type AccountRecord, createProfile } from "./db/accounts.server";
import { attachInvite } from "./db/invites.server";
import { attachPartner } from "./db/partners.server";

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
  if (record?.deleted) return null;
  if (record && !record.invitePending) return record;

  // The profile and its invitation or partner are set up as the account is
  // created; if a step failed, finish it now.
  if (!record) await createProfile(env.DB, userId);
  await attachInvite(env.DB, { userId });
  await attachPartner(env.DB, { userId });
  return accountRecord(env.DB, userId);
}

export function viewerOf(
  context: Readonly<RouterContextProvider>,
): Promise<AccountRecord | null> {
  return context.get(viewerContext)();
}

/**
 * The page a request is for. A navigation inside the app asks for the page's
 * data at `<path>.data`, or `/_root.data` for the home page, with the routes
 * it needs in `_routes`; this is the address the visitor sees.
 */
export function pagePath(request: Request): string {
  const url = new URL(request.url);
  let path = url.pathname;
  if (path.endsWith(".data")) path = path.slice(0, -".data".length);
  if (path === "/_root") path = "/";
  url.searchParams.delete("_routes");
  return `${path}${url.search}`;
}

/** Where a signed-out visitor goes to sign in, and comes back from. */
export function signInPath(request: Request): string {
  return `/signin?${new URLSearchParams({ next: pagePath(request) })}`;
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
 * until it ends, and so does karma at or below the floor. Writes repeat the
 * condition in SQL as well.
 */
export async function requireParticipant(
  request: Request,
  context: Readonly<RouterContextProvider>,
): Promise<AccountRecord> {
  const viewer = await requireAccount(request, context);
  if (viewer.ban?.kind === "karma") {
    throw refuse(403, "read_only", "Your account is read-only while your karma is at or below its floor.");
  }
  if (viewer.ban) {
    throw refuse(403, "banned", "Your account is read-only while the ban lasts.");
  }
  return viewer;
}

/**
 * The signed-in admin, for moderation. Everyone else, signed in or not, is
 * told there is nothing here, so admin pages and actions stay unseen.
 */
export async function requireAdmin(
  request: Request,
  context: Readonly<RouterContextProvider>,
): Promise<AccountRecord> {
  const viewer = await viewerOf(context);
  if (viewer?.role === "admin" && !viewer.ban) return viewer;
  if (isDataRequest(request)) throw Response.json({ error: "not_found" }, { status: 404 });
  throw new Response("Not Found", { status: 404 });
}
