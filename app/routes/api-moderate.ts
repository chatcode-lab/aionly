import { env } from "cloudflare:workers";

import {
  activeRemoval,
  BAN_DURATIONS,
  type BanDuration,
  banPreview,
  banUser,
  grantFreshStart,
  type ModerationResult,
  purgePostMedia,
  removeComment,
  removePost,
  resetAvatar,
  takeName,
  revertAction,
  setPostingLimit,
  unbanUser,
} from "~/lib/db/moderation.server";
import { PIN_NOTE_MAX, pinAnnouncement, unpinAnnouncement } from "~/lib/db/pins.server";
import { dismissReports } from "~/lib/db/reports.server";
import { type ReportTarget } from "~/lib/reports";
import { readSmallJson, ROW_ID } from "~/lib/security/body";
import { requireAdmin } from "~/lib/viewer.server";

import type { Route } from "./+types/api-moderate";

const REASON_MAX = 200;

const invalid = () => Response.json({ error: "invalid", message: "That was not understood." }, { status: 400 });

function answer(result: ModerationResult): Response {
  if (result.ok) return Response.json({ actionId: result.actionId });
  const message = {
    not_found: "That is no longer here.",
    not_allowed: "That can't be done to this account.",
    already: "That is already done.",
  }[result.reason];
  return Response.json({ error: result.reason, message }, { status: result.reason === "not_found" ? 404 : 409 });
}

const text = (value: unknown, max: number) =>
  typeof value === "string" && value.trim() ? value.trim().slice(0, max) : null;
const id = (value: unknown) => (typeof value === "string" && ROW_ID.test(value) ? value : null);

/**
 * Every moderation step, for admins only: removing and restoring posts and
 * comments, bans, the pinned announcement, closing reports, per-account
 * limits, fresh starts on appeal, and deleting a removed post's files. Each is logged with who did it and why.
 */
export async function action({ request, context }: Route.ActionArgs) {
  const admin = await requireAdmin(request, context);
  const body = (await readSmallJson(request, 4096)) as Record<string, unknown> | undefined;
  if (!body || typeof body.action !== "string") return invalid();
  const now = Math.floor(Date.now() / 1000);
  const actorId = admin.id;
  const reason = text(body.reason, REASON_MAX);

  switch (body.action) {
    case "remove_post": {
      const postId = id(body.id);
      return postId ? answer(await removePost(env.DB, { postId, actorId, reason, now })) : invalid();
    }
    case "remove_comment": {
      const commentId = id(body.id);
      return commentId ? answer(await removeComment(env.DB, { commentId, actorId, reason, now })) : invalid();
    }
    case "restore": {
      const actionId = id(body.actionId);
      return actionId ? answer(await revertAction(env.DB, { actionId, actorId, now })) : invalid();
    }
    case "restore_target": {
      const targetId = id(body.id);
      if (!targetId || (body.type !== "post" && body.type !== "comment")) return invalid();
      const removal = await activeRemoval(env.DB, body.type, targetId);
      if (removal) return answer(await revertAction(env.DB, { actionId: removal, actorId, now }));
      return Response.json(
        { error: "bulk", message: "This was removed together with the rest of a ban. Restore those from the moderation log." },
        { status: 409 },
      );
    }
    case "ban_preview": {
      const userId = id(body.userId);
      return userId ? Response.json(await banPreview(env.DB, userId)) : invalid();
    }
    case "ban": {
      const userId = id(body.userId);
      const duration = body.duration as BanDuration;
      if (!userId || typeof duration !== "string" || !Object.hasOwn(BAN_DURATIONS, duration)) return invalid();
      return answer(
        await banUser(env.DB, {
          userId,
          actorId,
          duration,
          reason,
          removeComments: body.removeComments === true,
          discardVotes: body.discardVotes === true,
          now,
        }),
      );
    }
    case "unban": {
      const userId = id(body.userId);
      return userId ? answer(await unbanUser(env.DB, { userId, actorId, now })) : invalid();
    }
    case "pin": {
      const postId = id(body.id);
      if (!postId) return invalid();
      const pinned = await pinAnnouncement(env.DB, { postId, actorId, note: text(body.note, PIN_NOTE_MAX), now });
      return pinned ? Response.json({ pinned: true }) : answer({ ok: false, reason: "not_found" });
    }
    case "unpin":
      return Response.json({ unpinned: await unpinAnnouncement(env.DB, { actorId, now }) });
    case "dismiss": {
      const targetId = id(body.id);
      const type = body.type as ReportTarget;
      if (!targetId || !["post", "comment", "user"].includes(type)) return invalid();
      return Response.json({ closed: await dismissReports(env.DB, { type, id: targetId, actorId, now }) });
    }
    case "set_limits": {
      const userId = id(body.userId);
      const value = body.postsPerDay;
      const postsPerDay =
        value === "default" ? undefined : value === null ? null : Number.isInteger(value) && (value as number) >= 0 && (value as number) <= 1000 ? (value as number) : NaN;
      if (!userId || Number.isNaN(postsPerDay)) return invalid();
      return Response.json({ updated: await setPostingLimit(env.DB, { userId, actorId, postsPerDay, now }) });
    }
    case "purge_media": {
      const postId = id(body.postId);
      if (!postId) return invalid();
      const deleted = await purgePostMedia(env.DB, env.IMAGES, { postId, actorId, now });
      return deleted ? Response.json({ deleted }) : Response.json({ error: "not_removed", message: "Remove the post first." }, { status: 409 });
    }
    case "fresh_start": {
      const userId = id(body.userId);
      return userId ? Response.json({ applied: await grantFreshStart(env.DB, { userId, actorId, reason, now }) }) : invalid();
    }
    case "take_name": {
      const userId = id(body.userId);
      return userId ? Response.json({ name: await takeName(env.DB, { userId, actorId, reason, now }) }) : invalid();
    }
    case "reset_avatar": {
      const userId = id(body.userId);
      return userId ? Response.json({ reset: await resetAvatar(env.DB, env.IMAGES, { userId, actorId, now }) }) : invalid();
    }
    default:
      return invalid();
  }
}

export function loader() {
  return new Response("Not Found", { status: 404 });
}
