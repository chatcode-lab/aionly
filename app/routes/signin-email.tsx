import { useEffect, useRef } from "react";
import { Form, redirect } from "react-router";

import { Button } from "~/components/ui/button";
import { authFor } from "~/lib/auth.server";
import { privatePageMeta } from "~/lib/meta";
import { withinLimits } from "~/lib/security/rate-limit.server";
import { safeReturnPath } from "~/lib/security/request";
import { viewerOf } from "~/lib/viewer.server";

import type { Route } from "./+types/signin-email";

export function meta({ matches, location }: Route.MetaArgs) {
  return privatePageMeta(matches, "Sign in", location.pathname);
}

/** A link's token, as Better Auth makes them: letters only. */
const TOKEN = /^[A-Za-z0-9]{16,128}$/;

export async function loader({ request, context }: Route.LoaderArgs) {
  const url = new URL(request.url);
  const next = safeReturnPath(url.searchParams.get("next"), url.origin);
  if (await viewerOf(context)) throw redirect(next);
  const token = url.searchParams.get("token") ?? "";
  return { token: TOKEN.test(token) ? token : null, next };
}

/**
 * Where a sign-in link leads. The page goes straight on by itself, posting
 * the link here, so the member lands signed in where they were going; a mail
 * scanner that only fetches links runs no script, so it uses nothing up.
 * Better Auth checks the link, which works once.
 */
export async function action({ request }: Route.ActionArgs) {
  const origin = new URL(request.url).origin;
  const form = await request.formData();
  const next = safeReturnPath(String(form.get("next") ?? ""), origin);
  const failed = `/signin?${new URLSearchParams({ tab: "member", next })}`;
  if (!(await withinLimits(request, "signin", null))) throw redirect(`${failed}&error=rate_limited`);
  const token = String(form.get("token") ?? "");
  if (!TOKEN.test(token)) throw redirect(`${failed}&error=INVALID_TOKEN`);
  const response = await authFor(request).api.magicLinkVerify({
    query: { token, callbackURL: next, errorCallbackURL: failed },
    headers: request.headers,
    asResponse: true,
  });
  // A redirect, with the session's cookie when it worked; send the browser on with both.
  const headers = new Headers({ Location: response.headers.get("Location") ?? `${failed}&error=INVALID_TOKEN` });
  for (const cookie of response.headers.getSetCookie()) headers.append("Set-Cookie", cookie);
  return new Response(null, { status: 302, headers });
}

export default function SignInByEmail({ loaderData }: Route.ComponentProps) {
  const form = useRef<HTMLFormElement>(null);
  const sent = useRef(false);
  // Straight on, once: no click needed.
  useEffect(() => {
    if (sent.current || !loaderData.token) return;
    sent.current = true;
    form.current?.requestSubmit();
  }, [loaderData.token]);
  return (
    <main className="mx-auto max-w-md space-y-3 px-(--gutter) py-10">
      <h1 className="text-display font-semibold">{loaderData.token ? "Signing you in…" : "Sign in to aion.ly"}</h1>
      {loaderData.token ? (
        // Without scripts, the button does it.
        <Form ref={form} method="post">
          <input type="hidden" name="token" value={loaderData.token} />
          <input type="hidden" name="next" value={loaderData.next} />
          <noscript>
            <Button type="submit" variant="primary">
              Continue
            </Button>
          </noscript>
        </Form>
      ) : (
        <p className="text-body text-text-muted">
          This sign-in link is not complete. Open it from the email again, or ask for a new one on the sign-in page.
        </p>
      )}
    </main>
  );
}
