import { env } from "cloudflare:workers";
import { Form, Link } from "react-router";

import { Button } from "~/components/ui/button";
import { readUnsubscribeToken, setDigest } from "~/lib/digest/digest.server";

import type { Route } from "./+types/digest-unsubscribe";

export function meta(_: Route.MetaArgs) {
  return [{ title: "Unsubscribe · aion.ly" }, { name: "robots", content: "noindex" }];
}

async function tokenOwner(request: Request, form?: FormData): Promise<string | null> {
  const token = String(form?.get("token") ?? new URL(request.url).searchParams.get("token") ?? "");
  return token ? readUnsubscribeToken(env.BETTER_AUTH_SECRET, token) : null;
}

export async function loader({ request }: Route.LoaderArgs) {
  const token = new URL(request.url).searchParams.get("token") ?? "";
  return { token, valid: (await tokenOwner(request)) !== null };
}

/**
 * Unsubscribes without signing in. Mail clients post here for one-click
 * unsubscribe (RFC 8058) with no Origin, which the Worker allows for this
 * path: the signed token is the proof. The page's own button posts too, so
 * a link scanner opening the address unsubscribes no one.
 */
export async function action({ request }: Route.ActionArgs) {
  const form = await request.formData().catch(() => undefined);
  const userId = await tokenOwner(request, form);
  if (!userId) return { done: false };
  await setDigest(env.DB, userId, null, Math.floor(Date.now() / 1000));
  return { done: true };
}

export default function Unsubscribe({ loaderData, actionData }: Route.ComponentProps) {
  return (
    <main className="mx-auto max-w-column space-y-3 px-(--gutter) py-10">
      <h1 className="text-display font-semibold">Email digest</h1>
      {actionData?.done ? (
        <p className="text-body text-text-muted">You are unsubscribed. No more digests will be sent.</p>
      ) : loaderData.valid ? (
        <Form method="post" className="space-y-3">
          <p className="text-body text-text-muted">Stop sending the digest of top posts to this address?</p>
          <input type="hidden" name="token" value={loaderData.token} />
          <Button type="submit" variant="primary">
            Unsubscribe
          </Button>
        </Form>
      ) : (
        <p className="text-body text-text-muted">
          This unsubscribe link is not valid. Turn the digest off from the menu in the top bar, or in{" "}
          <Link to="/settings" className="underline underline-offset-4">
            Settings
          </Link>
          .
        </p>
      )}
    </main>
  );
}
