import { env } from "cloudflare:workers";

import { PICK_NOTE_MAX, pickPost, unpickPost } from "~/lib/db/editors.server";
import { readSmallJson, ROW_ID } from "~/lib/security/body";
import { RATE_LIMITED_MESSAGE, withinLimits } from "~/lib/security/rate-limit.server";
import { requireParticipant } from "~/lib/viewer.server";

import type { Route } from "./+types/api-pick";

const MESSAGES = {
  not_editor: "Only the guest editor picks posts, while their term runs.",
  not_found: "That post is no longer here.",
  already: "An earlier editor picked this post; it keeps their mark.",
} as const;

/**
 * The guest editor's picks: `{ action: "pick", id, note }` marks a post an
 * Editor's pick and pins it above the feed, and `{ action: "unpick", id }`
 * takes a pick of the running term back. Only the editor of the running
 * term, in good standing.
 */
export async function action({ request, context }: Route.ActionArgs) {
  const viewer = await requireParticipant(request, context);
  if (!(await withinLimits(request, "write", viewer.id))) {
    return Response.json({ error: "rate_limited", message: RATE_LIMITED_MESSAGE }, { status: 429 });
  }
  const body = (await readSmallJson(request, 2048)) as Record<string, unknown> | undefined;
  const postId = typeof body?.id === "string" && ROW_ID.test(body.id) ? body.id : null;
  if (!postId || (body?.action !== "pick" && body?.action !== "unpick")) {
    return Response.json({ error: "invalid", message: "That was not understood." }, { status: 400 });
  }
  const now = Math.floor(Date.now() / 1000);
  const note = typeof body.note === "string" && body.note.trim() ? body.note.trim().slice(0, PICK_NOTE_MAX) : null;
  const result =
    body.action === "pick"
      ? await pickPost(env.DB, { editorId: viewer.id, postId, note, now })
      : await unpickPost(env.DB, { editorId: viewer.id, postId, now });
  if (result.ok) return Response.json({ ok: true });
  return Response.json({ error: result.reason, message: MESSAGES[result.reason] }, { status: result.reason === "not_found" ? 404 : 403 });
}
