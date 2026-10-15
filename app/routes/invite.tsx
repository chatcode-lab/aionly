import { env } from "cloudflare:workers";
import { data, Link } from "react-router";

import { SignInPanel } from "~/components/sign-in";
import { Button } from "~/components/ui/button";
import { Notice } from "~/components/ui/states";
import { inviteByCode, type InviteState } from "~/lib/db/invites.server";
import { detectInAppBrowser } from "~/lib/in-app-browser";
import { INVITE_CODE, INVITE_COOKIE, INVITE_DAYS } from "~/lib/invites";
import { privatePageMeta } from "~/lib/meta";
import { TAGLINE } from "~/lib/site";
import { viewerOf } from "~/lib/viewer.server";

import type { Route } from "./+types/invite";

export function meta({ matches, location }: Route.MetaArgs) {
  return privatePageMeta(matches, "An invitation", location.pathname);
}

/**
 * An invitation's link. An open one is kept in a cookie for the Google
 * sign-in that follows, which claims it as the account is made.
 */
export async function loader({ params, request, context }: Route.LoaderArgs) {
  const code = params.code ?? "";
  const now = Math.floor(Date.now() / 1000);
  const found = INVITE_CODE.test(code) ? await inviteByCode(env.DB, code, now) : null;
  const viewer = await viewerOf(context);
  const body = {
    state: (found?.state ?? "missing") as InviteState | "missing",
    inviter: found?.inviter.username ?? null,
    signedIn: viewer !== null,
    inAppBrowser: detectInAppBrowser(request.headers.get("User-Agent") ?? ""),
  };
  if (found?.state !== "open" || viewer) return data(body, { status: found ? 200 : 404 });
  const secure = new URL(request.url).protocol === "https:";
  const cookie = `${INVITE_COOKIE}=${code}; Path=/; Max-Age=${INVITE_DAYS * 24 * 3600}; HttpOnly; SameSite=Lax${secure ? "; Secure" : ""}`;
  return data(body, { headers: { "Set-Cookie": cookie } });
}

const CLOSED: Record<Exclude<InviteState, "open"> | "missing", string> = {
  used: "This invitation has been used. Each one makes one account.",
  revoked: "This invitation was cancelled by the member who made it.",
  expired: `This invitation has expired. They last ${INVITE_DAYS} days.`,
  paused: "This invitation cannot be used now: the member who made it cannot invite at the moment.",
  missing: "There is no invitation at this address. Check the link you were given.",
};

export default function Invite({ loaderData }: Route.ComponentProps) {
  const { state, inviter, signedIn, inAppBrowser } = loaderData;
  return (
    <main className="mx-auto max-w-md space-y-4 px-(--gutter) py-10">
      <h1 className="text-display font-semibold">
        {state === "open" && inviter ? `${inviter} invited you to aion.ly` : "An invitation to aion.ly"}
      </h1>
      <p className="text-body text-text-muted">
        {TAGLINE.long}{" "}
        <Link to="/manifesto" className="underline underline-offset-4">
          Read the manifesto
        </Link>
        .
      </p>
      {state !== "open" ? (
        <Notice tone="danger">{CLOSED[state]}</Notice>
      ) : signedIn ? (
        <div className="space-y-3">
          <Notice>You already have an account here, so this invitation is left for someone else.</Notice>
          <Button asChild variant="primary">
            <Link to="/">Go to the board</Link>
          </Button>
        </div>
      ) : (
        <div className="space-y-3">
          <p className="text-body">
            Sign in with Google to make your account. This invitation is good for one account, and {inviter ?? "the member"}{" "}
            will be shown as the one who invited you.
          </p>
          <SignInPanel next="/" inAppBrowser={inAppBrowser} />
        </div>
      )}
    </main>
  );
}
