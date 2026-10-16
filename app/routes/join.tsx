import { env } from "cloudflare:workers";
import { data, Link } from "react-router";

import { SignInPanel } from "~/components/sign-in";
import { Button } from "~/components/ui/button";
import { Notice } from "~/components/ui/states";
import { partnerLinkByCode, type PartnerLinkState } from "~/lib/db/partners.server";
import { detectInAppBrowser } from "~/lib/in-app-browser";
import { privatePageMeta } from "~/lib/meta";
import { normalizePartnerCode, PARTNER_COOKIE, PARTNER_COOKIE_DAYS } from "~/lib/partners";
import { withinLimits } from "~/lib/security/rate-limit.server";
import { TAGLINE } from "~/lib/site";
import { viewerOf } from "~/lib/viewer.server";

import type { Route } from "./+types/join";

export function meta({ matches, location }: Route.MetaArgs) {
  return privatePageMeta(matches, "Join aion.ly", location.pathname);
}

/**
 * A partner's link, good for many accounts. An open one is kept in a cookie
 * for the sign-in that follows, a few days at most, which claims it as the
 * account is made. Looking links up is rate-limited, like invitations.
 */
export async function loader({ params, request, context }: Route.LoaderArgs) {
  const viewer = await viewerOf(context);
  const base = {
    partner: null as string | null,
    signedIn: viewer !== null,
    inAppBrowser: detectInAppBrowser(request.headers.get("User-Agent") ?? ""),
  };
  const code = normalizePartnerCode(params.code ?? "");
  if (!code) return data({ ...base, state: "missing" as const }, { status: 404 });
  if (!(await withinLimits(request, "signin", null))) return data({ ...base, state: "limited" as const }, { status: 429 });
  const found = await partnerLinkByCode(env.DB, code, Math.floor(Date.now() / 1000));
  const body = { ...base, state: (found?.state ?? "missing") as PartnerLinkState | "missing", partner: found?.partner.username ?? null };
  if (found?.state !== "open" || viewer) return data(body, { status: found ? 200 : 404 });
  const secure = new URL(request.url).protocol === "https:";
  const cookie = `${PARTNER_COOKIE}=${code}; Path=/; Max-Age=${PARTNER_COOKIE_DAYS * 24 * 3600}; HttpOnly; SameSite=Lax${secure ? "; Secure" : ""}`;
  return data(body, { headers: { "Set-Cookie": cookie } });
}

const CLOSED: Record<Exclude<PartnerLinkState, "open"> | "missing" | "limited", string> = {
  full: "This link has made all the accounts it was for.",
  ended: "This link has ended.",
  revoked: "This link no longer works.",
  paused: "This link cannot be used now.",
  missing: "There is no link like this. Check the address you were given.",
  limited: "Too many links tried from this network just now. Wait a minute, then try again.",
};

export default function Join({ loaderData }: Route.ComponentProps) {
  const { state, partner, signedIn, inAppBrowser } = loaderData;
  return (
    <main className="mx-auto max-w-md space-y-4 px-(--gutter) py-10">
      <h1 className="text-display font-semibold">{state === "open" && partner ? `${partner} invites you to aion.ly` : "Join aion.ly"}</h1>
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
          <Notice>You already have an account here, so this link is for others.</Notice>
          <Button asChild variant="primary">
            <Link to="/">Go to the board</Link>
          </Button>
        </div>
      ) : (
        <div className="space-y-3">
          <p className="text-body">
            Sign in to make your account. {partner ?? "The member"} will be shown as the one who invited you.
          </p>
          <SignInPanel next="/" inAppBrowser={inAppBrowser} invited />
        </div>
      )}
    </main>
  );
}
