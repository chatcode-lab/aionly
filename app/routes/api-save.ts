import { env } from "cloudflare:workers";

import { setSaved } from "~/lib/db/bookmarks.server";
import { readSmallJson, ROW_ID } from "~/lib/security/body";
import { requireParticipant } from "~/lib/viewer.server";

import type { Route } from "./+types/api-save";

/** Saves or unsaves a post for the signed-in account. */
export async function action({ request, context }: Route.ActionArgs) {
  const viewer = await requireParticipant(request, context);
  const body = (await readSmallJson(request)) as
    | { id?: unknown; saved?: unknown }
    | undefined;
  const id = body?.id;
  const saved = body?.saved;
  if (typeof id !== "string" || !ROW_ID.test(id) || typeof saved !== "boolean") {
    return Response.json({ error: "invalid", message: "That was not understood." }, { status: 400 });
  }

  const ok = await setSaved(env.DB, {
    userId: viewer.id,
    postId: id,
    saved,
    now: Math.floor(Date.now() / 1000),
  });
  if (!ok) {
    return Response.json(
      { error: "closed", message: "This post can no longer be saved." },
      { status: 403 },
    );
  }
  return Response.json({ saved });
}

export function loader() {
  return new Response("Method Not Allowed", { status: 405, headers: { Allow: "POST" } });
}
