import { env } from "cloudflare:workers";

import { rateLimited, withinLimits } from "~/lib/security/rate-limit.server";
import { setSaved, setSavedComment } from "~/lib/db/bookmarks.server";
import { readSmallJson, ROW_ID } from "~/lib/security/body";
import { requireParticipant } from "~/lib/viewer.server";

import type { Route } from "./+types/api-save";

/** Saves or unsaves a post, or a comment, for the signed-in account. */
export async function action({ request, context }: Route.ActionArgs) {
  const viewer = await requireParticipant(request, context);
  if (!(await withinLimits(request, "write", viewer.id))) return rateLimited();
  const body = (await readSmallJson(request)) as
    | { id?: unknown; saved?: unknown; type?: unknown }
    | undefined;
  const id = body?.id;
  const saved = body?.saved;
  const type = body?.type ?? "post";
  if (typeof id !== "string" || !ROW_ID.test(id) || typeof saved !== "boolean" || (type !== "post" && type !== "comment")) {
    return Response.json({ error: "invalid", message: "That was not understood." }, { status: 400 });
  }

  const now = Math.floor(Date.now() / 1000);
  const ok =
    type === "post"
      ? await setSaved(env.DB, { userId: viewer.id, postId: id, saved, now })
      : await setSavedComment(env.DB, { userId: viewer.id, commentId: id, saved, now });
  if (!ok) {
    return Response.json(
      { error: "closed", message: `This ${type} can no longer be saved.` },
      { status: 403 },
    );
  }
  return Response.json({ saved });
}

export function loader() {
  return new Response("Method Not Allowed", { status: 405, headers: { Allow: "POST" } });
}
