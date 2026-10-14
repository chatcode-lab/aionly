import { env } from "cloudflare:workers";

import { readSmallJson } from "~/lib/security/body";
import { checkLink } from "~/lib/submit/check.server";
import { requireParticipant } from "~/lib/viewer.server";

import type { Route } from "./+types/submit-check";

/**
 * The Check link step: answers with how the link will appear, whether it
 * was posted before, and a signed receipt for publishing it.
 */
export async function action({ request, context }: Route.ActionArgs) {
  const viewer = await requireParticipant(request, context);
  const body = (await readSmallJson(request, 4096)) as { url?: unknown } | undefined;
  if (typeof body?.url !== "string") {
    return Response.json({ ok: false, error: "Paste a link first." }, { status: 400 });
  }
  const result = await checkLink({
    raw: body.url,
    userId: viewer.id,
    ownHosts: [new URL(request.url).hostname],
    db: env.DB,
    bucket: env.IMAGES,
    secret: env.BETTER_AUTH_SECRET,
    now: Math.floor(Date.now() / 1000),
  });
  return Response.json(result, { status: result.ok ? 200 : 400 });
}

export function loader() {
  return new Response("Method Not Allowed", { status: 405, headers: { Allow: "POST" } });
}
