import { env } from "cloudflare:workers";
import { data, Link, redirect } from "react-router";

import { InviteCodeForm, SignInPanel } from "~/components/sign-in";
import { Button } from "~/components/ui/button";
import { Notice } from "~/components/ui/states";
import { inviteByCode, type InviteState } from "~/lib/db/invites.server";
import { detectInAppBrowser } from "~/lib/in-app-browser";
import { INVITE_COOKIE, normalizeInviteCode } from "~/lib/invites";
import { privatePageMeta } from "~/lib/meta";
import { withinLimits } from "~/lib/security/rate-limit.server";
import { TAGLINE } from "~/lib/site";
import { viewerOf } from "~/lib/viewer.server";

import type { Route } from "./+types/invite";

export function meta({ matches, location }: Route.MetaArgs) {
  return privatePageMeta(matches, "An invitation", location.pathname);
}

/**
 * An invitation's link, or its code typed in (`?code=`), in any case. An
 * open one is kept in a cookie for the sign-in that follows, which claims
 * it as the account is made. Looking codes up is rate-limited, so they
 * cannot be guessed.
 */
export async function loader({ params, request, context }: Route.LoaderArgs) {
  const url = new URL(request.url);
  const typed = params.code ?? url.searchParams.get("code");
  const viewer = await viewerOf(context);
  const base = {
    inviter: null as string | null,
    signedIn: viewer !== null,
    inAppBrowser: detectInAppBrowser(request.headers.get("User-Agent") ?? ""),
    typed: params.code ? null : typed,
  };
  // Nothing to look up yet: a place to type the code.
  if (typed === null || typed.trim() === "") return { ...base, state: "ask" as const };
  const code = normalizeInviteCode(typed);
  // A typed code goes to the invitation's own address.
  if (code && code !== params.code) throw redirect(`/invite/${code}`);
  if (!code) return data({ ...base, state: "missing" as const }, { status: 404 });
  if (!(await withinLimits(request, "signin", null))) return data({ ...base, state: "limited" as const }, { status: 429 });

  const found = await inviteByCode(env.DB, code, Math.floor(Date.now() / 1000));
  const body = { ...base, state: (found?.state ?? "missing") as InviteState | "missing", inviter: found?.inviter.username ?? null };
  if (found?.state !== "open" || viewer) return data(body, { status: found ? 200 : 404 });
  const secure = url.protocol === "https:";
  // Kept for as long as the invitation works.
  const left = Math.max(found.expiresAt - Math.floor(Date.now() / 1000), 60);
  const cookie = `${INVITE_COOKIE}=${code}; Path=/; Max-Age=${left}; HttpOnly; SameSite=Lax${secure ? "; Secure" : ""}`;
  return data(body, { headers: { "Set-Cookie": cookie } });
}

const CLOSED: Record<Exclude<InviteState, "open"> | "missing" | "limited", string> = {
  used: "This invitation has been used. Each one makes one account.",
  revoked: "This invitation was revoked by the member who made it.",
  expired: "This invitation has expired. Ask the member who sent it for a new one.",
  paused: "This invitation cannot be used now: the member who made it cannot invite at the moment.",
  missing: "There is no invitation with this code. Check the code or link you were given.",
  limited: "Too many codes tried from this network just now. Wait a minute, then try again.",
};

export default function Invite({ loaderData }: Route.ComponentProps) {
  const { state, inviter, signedIn, inAppBrowser, typed } = loaderData;
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
      {state === "ask" ? (
        signedIn ? (
          <Notice>You already have an account here, so invitations are for others.</Notice>
        ) : (
          <InviteCodeForm label="Enter the code you were given." />
        )
      ) : state !== "open" ? (
        <div className="space-y-3">
          <Notice tone="danger">{CLOSED[state]}</Notice>
          {signedIn ? null : <InviteCodeForm label="Try the code again, or another one." typed={typed} />}
        </div>
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
            Sign in to make your account. This invitation is good for one account, and {inviter ?? "the member"} will be
            shown as the one who invited you.
          </p>
          <SignInPanel next="/" inAppBrowser={inAppBrowser} invited />
        </div>
      )}
    </main>
  );
}
