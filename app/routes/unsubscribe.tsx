import { env } from "cloudflare:workers";
import { Form, Link } from "react-router";

import { Button } from "~/components/ui/button";
import { readUnsubscribeToken, setDigest } from "~/lib/digest/digest.server";
import { privatePageMeta } from "~/lib/meta";
import { setOffersConsent } from "~/lib/offers/offers.server";

import type { Route } from "./+types/unsubscribe";

export function meta({ matches, location }: Route.MetaArgs) {
  return privatePageMeta(matches, "Unsubscribe", location.pathname);
}

/** The emails one can leave: the digest, or offers (`?list=offers`). */
type List = "digest" | "offers";

const WORDS: Record<List, { title: string; ask: string; done: string }> = {
  digest: {
    title: "Email digest",
    ask: "Stop sending the digest of top posts to this address?",
    done: "You are unsubscribed. No more digests will be sent.",
  },
  offers: {
    title: "Offer emails",
    ask: "Stop sending emails about offers and the Fan plan to this address?",
    done: "You are unsubscribed. No more offers will be sent.",
  },
};

function listOf(request: Request, form?: FormData): List {
  return (form?.get("list") ?? new URL(request.url).searchParams.get("list")) === "offers" ? "offers" : "digest";
}

async function tokenOwner(request: Request, form?: FormData): Promise<string | null> {
  const token = String(form?.get("token") ?? new URL(request.url).searchParams.get("token") ?? "");
  return token ? readUnsubscribeToken(env.BETTER_AUTH_SECRET, token) : null;
}

export async function loader({ request }: Route.LoaderArgs) {
  const token = new URL(request.url).searchParams.get("token") ?? "";
  return { token, list: listOf(request), valid: (await tokenOwner(request)) !== null };
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
  const list = listOf(request, form);
  if (!userId) return { done: false, list };
  if (list === "offers") await setOffersConsent(env.DB, userId, false, Math.floor(Date.now() / 1000));
  else await setDigest(env.DB, userId, null, Math.floor(Date.now() / 1000));
  return { done: true, list };
}

export default function Unsubscribe({ loaderData, actionData }: Route.ComponentProps) {
  const words = WORDS[actionData?.list ?? loaderData.list];
  return (
    <main className="mx-auto max-w-column space-y-3 px-(--gutter) py-10">
      <h1 className="text-display font-semibold">{words.title}</h1>
      {actionData?.done ? (
        <p className="text-body text-text-muted">{words.done}</p>
      ) : loaderData.valid ? (
        <Form method="post" className="space-y-3">
          <p className="text-body text-text-muted">{words.ask}</p>
          <input type="hidden" name="token" value={loaderData.token} />
          <input type="hidden" name="list" value={loaderData.list} />
          <Button type="submit" variant="primary">
            Unsubscribe
          </Button>
        </Form>
      ) : (
        <p className="text-body text-text-muted">
          This unsubscribe link is not valid. Choose your emails in{" "}
          <Link to="/settings#email" className="underline underline-offset-4">
            Settings
          </Link>
          .
        </p>
      )}
    </main>
  );
}
