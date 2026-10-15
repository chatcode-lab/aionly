import { env } from "cloudflare:workers";

import { imageAddress } from "~/lib/media.server";
import { rateLimited, withinLimits } from "~/lib/security/rate-limit.server";
import { UPLOAD_LIMITS, sizeLabel } from "~/lib/uploads";
import { storeUpload } from "~/lib/uploads.server";
import { requireParticipant } from "~/lib/viewer.server";

import type { Route } from "./+types/submit-upload";

const refuse = (status: number, error: string) => Response.json({ ok: false, error }, { status });

/**
 * Takes an upload for the submit form: the file itself as the body, or with
 * `?role=poster`, a video's poster frame. It is kept pending, as the
 * account's one upload, until a post is published with it. Supporters only.
 */
export async function action({ request, context }: Route.ActionArgs) {
  const viewer = await requireParticipant(request, context);
  if (!viewer.entitled) return refuse(403, "Uploads come with the Supporter plan.");
  if (!(await withinLimits(request, "write", viewer.id))) return rateLimited();
  const length = Number(request.headers.get("Content-Length"));
  if (!request.body || !Number.isInteger(length) || length <= 0) return refuse(411, "Send the file as the request body.");
  const role = new URL(request.url).searchParams.get("role") === "poster" ? "poster" : "media";
  const result = await storeUpload(env.DB, env.IMAGES, {
    ownerId: viewer.id,
    body: request.body,
    length,
    role,
    now: Math.floor(Date.now() / 1000),
  });
  if (!result.ok) {
    if (result.reason === "not_allowed") return refuse(403, "Uploads come with the Supporter plan, for an account that can take part.");
    if (result.reason === "too_large") {
      return refuse(
        413,
        `Files are at most ${sizeLabel(UPLOAD_LIMITS.image)} for pictures, ${sizeLabel(UPLOAD_LIMITS.audio)} for audio, and ${sizeLabel(UPLOAD_LIMITS.video)} for video.`,
      );
    }
    return refuse(415, "Upload a JPEG, PNG, WebP, GIF, or AVIF picture; an MP4, MOV, or WebM video; or MP3, M4A, OGG, WAV, or FLAC audio.");
  }
  return Response.json({ ok: true, key: result.key, media: result.media, url: imageAddress(result.key) });
}

export function loader() {
  return new Response("Method Not Allowed", { status: 405, headers: { Allow: "POST" } });
}
