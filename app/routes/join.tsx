import { env } from "cloudflare:workers";
import { data, Link, redirect } from "react-router";

import { DigestSignUp } from "~/components/digest-sign-up";
import { SignInPanel } from "~/components/sign-in";
import { Button } from "~/components/ui/button";
import { Notice } from "~/components/ui/states";
import { googleSignIn } from "~/lib/auth.server";
import { partnerLinkByCode, type PartnerLinkState } from "~/lib/db/partners.server";
import { DIGEST_COOKIE, frequencyOf } from "~/lib/digest/frequency";
import { detectInAppBrowser } from "~/lib/in-app-browser";
import { privatePageMeta } from "~/lib/meta";
import { normalizePartnerCode, PARTNER_COOKIE, PARTNER_COOKIE_DAYS } from "~/lib/partners";
import { withinLimits } from "~/lib/security/rate-limit.server";
import { safeReturnPath } from "~/lib/security/request";
import { TAGLINE } from "~/lib/site";
import { viewerOf } from "~/lib/viewer.server";

import type { Route } from "./+types/join";

export function meta({ matches, location }: Route.MetaArgs) {
  return privatePageMeta(matches, "Join aion.ly", location.pathname);
}

/** A cookie kept as long as a partner link's, for the sign-in that follows. */
function keptCookie(request: Request, name: string, value: string): string {
  const secure = new URL(request.url).protocol === "https:";
  return `${name}=${value}; Path=/; Max-Age=${PARTNER_COOKIE_DAYS * 24 * 3600}; HttpOnly; SameSite=Lax${secure ? "; Secure" : ""}`;
}

/**
 * A partner's link, good for many accounts. An open one is kept in a cookie
 * for the sign-in that follows, a few days at most, which claims it as the
 * account is made. Looking links up is rate-limited, like invitations.
 * `?digest` makes it the way in to the email digest, with the frequency
 * given picked, or daily (owner's request, 2026-10-26).
 */
export async function loader({ params, request, context }: Route.LoaderArgs) {
  const viewer = await viewerOf(context);
  const url = new URL(request.url);
  const code = normalizePartnerCode(params.code ?? "");
  const base = {
    code,
    partner: null as string | null,
    signedIn: viewer !== null,
    inAppBrowser: detectInAppBrowser(request.headers.get("User-Agent") ?? ""),
    digest: url.searchParams.has("digest") ? (frequencyOf(url.searchParams.get("digest")) ?? "daily") : null,
    next: safeReturnPath(url.searchParams.get("next"), url.origin),
  };
  if (!code) return data({ ...base, state: "missing" as const }, { status: 404 });
  if (!(await withinLimits(request, "signin", null))) return data({ ...base, state: "limited" as const }, { status: 429 });
  const found = await partnerLinkByCode(env.DB, code, Math.floor(Date.now() / 1000));
  const body = { ...base, state: (found?.state ?? "missing") as PartnerLinkState | "missing", partner: found?.partner.username ?? null };
  if (found?.state !== "open" || viewer) return data(body, { status: found ? 200 : 404 });
  return data(body, { headers: { "Set-Cookie": keptCookie(request, PARTNER_COOKIE, code) } });
}

/**
 * Continue with Google through the link, from its page or the invitation
 * to the digest: keeps the link, and the digest chosen, for the account the
 * sign-up makes. A link that no longer works leads back to its page, which
 * says why.
 */
export async function action({ params, request, context }: Route.ActionArgs) {
  const url = new URL(request.url);
  const form = await request.formData();
  const next = safeReturnPath(String(form.get("next") ?? ""), url.origin);
  if (await viewerOf(context)) throw redirect(next);
  const code = normalizePartnerCode(params.code ?? "");
  if (!code) throw redirect("/signin");
  if (!(await withinLimits(request, "signin", null))) throw redirect(`/signin?${new URLSearchParams({ next, error: "rate_limited" })}`);
  const found = await partnerLinkByCode(env.DB, code, Math.floor(Date.now() / 1000));
  if (found?.state !== "open") throw redirect(`/join/${code}`);
  const digest = frequencyOf(form.get("digest"));
  const cookies = [keptCookie(request, PARTNER_COOKIE, code), ...(digest ? [keptCookie(request, DIGEST_COOKIE, digest)] : [])];
  const started = await googleSignIn(request, next, cookies);
  if (!started) throw redirect(`/signin?${new URLSearchParams({ next, error: "start" })}`);
  return started;
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
  const { code, state, partner, signedIn, inAppBrowser, digest, next } = loaderData;
  const open = state === "open" && code;
  return (
    <main className="mx-auto max-w-md space-y-4 px-(--gutter) py-10">
      <h1 className="text-display font-semibold">
        {digest ? "The best of aion.ly, by email" : open && partner ? `${partner} invites you to aion.ly` : "Join aion.ly"}
      </h1>
      {digest ? (
        <p className="text-body text-text-muted">
          Join with your Google account, and get the posts members voted up and discussed most, at its email. Free;
          stop it from any email in one click.
        </p>
      ) : (
        <p className="text-body text-text-muted">
          {TAGLINE.long}{" "}
          <Link to="/manifesto" className="underline underline-offset-4">
            Read the manifesto
          </Link>
          .
        </p>
      )}
      {!open ? (
        <Notice tone="danger">{CLOSED[state === "open" ? "missing" : state]}</Notice>
      ) : signedIn ? (
        <div className="space-y-3">
          <Notice>
            {digest
              ? "You already have an account here: choose how often the digest comes from the top bar."
              : "You already have an account here, so this link is for others."}
          </Notice>
          <Button asChild variant="primary">
            <Link to="/">Go to the board</Link>
          </Button>
        </div>
      ) : (
        <div className="space-y-3">
          <p className="text-body text-text-muted">{partner ?? "The member"} will show as the one who invited you.</p>
          {digest ? (
            <DigestSignUp code={code} next={next} chosen={digest} inAppBrowser={inAppBrowser} />
          ) : (
            <SignInPanel next={next} inAppBrowser={inAppBrowser} invited />
          )}
        </div>
      )}
    </main>
  );
}
