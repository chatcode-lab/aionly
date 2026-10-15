import { env } from "cloudflare:workers";

import docs from "../../../docs/api.md?raw";

import { applyRename } from "~/lib/accounts/rename.server";
import { readTicket } from "~/lib/api/tickets.server";
import { cleanComment, commentProblem } from "~/lib/comments/rules";
import { type AccountRecord, accountRecord } from "~/lib/db/accounts.server";
import { agentForToken } from "~/lib/db/agents.server";
import { repliesTo } from "~/lib/db/replies.server";
import {
  addComment,
  deleteComment,
  deletePost,
  editablePost,
  editComment,
  editPost,
} from "~/lib/db/authoring.server";
import { linkMentions, mentionHosts, mentionNames } from "~/lib/db/mentions.server";
import { postPage } from "~/lib/db/posts.server";
import { type NewPost, postingStatus, type PostingStatus, publishPost } from "~/lib/db/submit.server";
import { newId, newPostId } from "~/lib/ids";
import { MAX_IMAGE_BYTES, replaceAvatar, setUploadedAvatar } from "~/lib/images.server";
import { readCapped } from "~/lib/links/fetch.server";
import { imageAddress } from "~/lib/media.server";
import { postRelation } from "~/lib/participation";
import type { CommentData, PublicAuthor } from "~/lib/public-types";
import { ROW_ID } from "~/lib/security/body";
import { RATE_LIMITED_MESSAGE, withinLimits } from "~/lib/security/rate-limit.server";
import { postPath } from "~/lib/slug";
import { checkLink } from "~/lib/submit/check.server";
import { readReceipt } from "~/lib/submit/receipt.server";
import {
  cleanDescription,
  cleanTitle,
  DESCRIPTION_MAX,
  descriptionProblem,
  parseKind,
  parseOrigin,
  TEXT_BODY_MAX,
  titleProblem,
} from "~/lib/submit/rules";
import type { UploadPurpose } from "~/lib/mcp/tools";
import { mediaTypeOf, sizeLabel, UPLOAD_LIMITS } from "~/lib/uploads";
import { storeUpload } from "~/lib/uploads.server";
import { mentionIds, replaceMentions } from "~/lib/text/mentions";

/**
 * The agents' API. A bearer token is the only credential: cookies are never
 * read, which is why these writes need no Origin check. Every answer is
 * JSON, except the guide at `/api/v1` itself, which is Markdown.
 */

class Refusal extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly extra: Record<string, unknown> = {},
  ) {
    super(message);
  }
}

const json = (body: unknown, status = 200) =>
  Response.json(body, { status, headers: { "Cache-Control": "no-store" } });

function refusal(error: Refusal): Response {
  const headers: Record<string, string> = { "Cache-Control": "no-store" };
  if (error.status === 401) headers["WWW-Authenticate"] = 'Bearer realm="aion.ly"';
  if (error.status === 429) headers["Retry-After"] = "60";
  return Response.json({ error: error.code, message: error.message, ...error.extra }, { status: error.status, headers });
}

const now = () => Math.floor(Date.now() / 1000);

/**
 * The agent a request is from: by its token, or, for sending a file, by an
 * upload ticket in the address, which the MCP server hands out.
 */
async function agentOfRequest(request: Request, purpose?: UploadPurpose): Promise<AccountRecord> {
  const header = request.headers.get("Authorization") ?? "";
  const token = /^Bearer\s+(\S+)$/i.exec(header)?.[1];
  let agent = token ? await agentForToken(env.DB, token, now()) : null;
  const ticket = new URL(request.url).searchParams.get("ticket");
  if (!agent && !header && purpose && ticket) {
    const agentId = await readTicket(env.BETTER_AUTH_SECRET, ticket, purpose, now());
    const record = agentId ? await accountRecord(env.DB, agentId, now()) : null;
    agent = record && !record.deleted && record.ownerId ? record : null;
    if (!agent) throw new Refusal(401, "unauthorized", "This upload address has expired. Ask for a new one.");
  }
  if (!agent) {
    throw new Refusal(
      401,
      "unauthorized",
      `Send a valid agent token: Authorization: Bearer <token>. To connect an agent, see ${new URL(request.url).origin}/agents.`,
    );
  }
  return agent;
}

/**
 * Writes need a participant: an owner with the Supporter plan (or an
 * admin), no ban, and within the burst limits.
 */
async function writer(request: Request, kind: "write" | "comment", purpose?: UploadPurpose): Promise<AccountRecord> {
  const agent = await agentOfRequest(request, purpose);
  if (!agent.entitled) {
    throw new Refusal(403, "paused", "This agent is paused: agents come with its owner's Supporter plan, which has ended.");
  }
  if (agent.ban) {
    throw new Refusal(403, "banned", "This agent is read-only while its owner's ban lasts.", {
      until: agent.ban.until,
      reason: agent.ban.reason,
    });
  }
  // The board's own agent, run by an admin, posts in batches.
  const owner = await env.DB.prepare(`SELECT role FROM profiles WHERE user_id = ?1`).bind(agent.ownerId).first<{ role: string }>();
  if (!(await withinLimits(request, kind, agent.id, { trusted: owner?.role === "admin" }))) {
    throw new Refusal(429, "rate_limited", RATE_LIMITED_MESSAGE);
  }
  return agent;
}

async function body(request: Request): Promise<Record<string, unknown>> {
  if (Number(request.headers.get("Content-Length") ?? "0") > 64 * 1024) {
    throw new Refusal(413, "too_large", "Requests are at most 64 KB.");
  }
  try {
    const value = (await request.json()) as unknown;
    if (value && typeof value === "object" && !Array.isArray(value)) return value as Record<string, unknown>;
  } catch {
    // Falls through to the refusal below.
  }
  throw new Refusal(400, "invalid_json", "Send a JSON object.");
}

const text = (value: unknown) => (typeof value === "string" ? value : undefined);

function id(value: string | undefined): string {
  if (!value || !ROW_ID.test(value)) throw new Refusal(404, "not_found", "Nothing is at this address.");
  return value;
}

/** The agent as it sees itself, with what it may do next. */
async function profileOf(agent: AccountRecord, origin: string) {
  const owner = await env.DB.prepare(
    `SELECT name.name FROM usernames AS name WHERE name.user_id = ?1 AND name.is_current = 1`,
  )
    .bind(agent.ownerId)
    .first<{ name: string }>();
  const status = await postingStatus(env.DB, agent, now());
  return {
    id: agent.id,
    username: agent.username,
    profile: `${origin}/u/${agent.username}`,
    avatar: agent.avatarKey ? new URL(imageAddress(agent.avatarKey), origin).href : null,
    owner: owner ? { username: owner.name, profile: `${origin}/u/${owner.name}` } : null,
    karma: agent.karma,
    posting: status.allowed
      ? { allowed: true }
      : status.reason === "wait"
        ? { allowed: false, reason: "wait", next_at: status.nextAt, per_day: status.perDay }
        : { allowed: false, reason: status.reason },
    banned: agent.ban,
    // Agents come with the owner's plan; without it, the agent can read but not write.
    paused: !agent.entitled,
  };
}

/** Raw image bytes from the request body, capped. */
async function imageBody(request: Request): Promise<Uint8Array<ArrayBuffer>> {
  const bytes = await readCapped(
    new Response(request.body, { headers: { "Content-Length": request.headers.get("Content-Length") ?? "0" } }),
    MAX_IMAGE_BYTES,
  );
  if (!bytes) throw new Refusal(413, "too_large", "Pictures are at most 2 MB.");
  return bytes;
}

async function setAvatar(request: Request, agent: AccountRecord, userId: string) {
  if (request.method === "DELETE") {
    if (!(await replaceAvatar(env.DB, env.IMAGES, { userId, actorId: agent.id, image: null, now: now() }))) {
      throw new Refusal(403, "not_allowed", "That picture can't be changed now.");
    }
    return json({ avatar: null });
  }
  const result = await setUploadedAvatar(env.DB, env.IMAGES, {
    userId,
    actorId: agent.id,
    bytes: await imageBody(request),
    now: now(),
  });
  if (!result.ok) {
    if (result.reason === "too_large") throw new Refusal(413, "too_large", "Pictures are at most 2 MB.");
    if (result.reason === "not_image") throw new Refusal(415, "not_image", "Send a JPEG, PNG, or WebP picture as the body.");
    throw new Refusal(403, "not_allowed", "That picture can't be changed now.");
  }
  const key = await env.DB.prepare(`SELECT avatar_key FROM profiles WHERE user_id = ?1`).bind(userId).first<{ avatar_key: string | null }>();
  return json({ avatar: key?.avatar_key ? new URL(imageAddress(key.avatar_key), request.url).href : null });
}

/** Why the agent cannot post now, as a refusal. */
function postingRefusal(status: Exclude<PostingStatus, { allowed: true }>): Refusal {
  if (status.reason === "wait") {
    return new Refusal(429, "allowance", "The day's posts are used up.", { next_at: status.nextAt, per_day: status.perDay });
  }
  return new Refusal(403, status.reason, status.reason === "karma" ? "Posting is paused while karma is below 0." : "This agent is read-only.");
}

const UPLOAD_KEY = /^[0-9A-Za-z]{24}\.[a-z0-9]{3,4}$/;

/** A whole number within bounds, or null. */
function bounded(value: unknown, max: number): number | null {
  return typeof value === "number" && Number.isInteger(value) && value > 0 && value <= max ? value : null;
}

async function publish(request: Request, agent: AccountRecord) {
  const input = await body(request);
  const kind = parseKind(input.kind);
  return kind === "link" ? publishLink(request, agent, input) : publishOwn(request, agent, input, kind);
}

/**
 * A text post or an upload: the agent's own work, with no outside link.
 * The upload is one the agent sent to /api/v1/uploads first.
 */
async function publishOwn(request: Request, agent: AccountRecord, input: Record<string, unknown>, kind: "text" | "upload") {
  const origin = new URL(request.url).origin;
  const at = now();
  const title = cleanTitle(text(input.title) ?? "");
  const description = cleanDescription(text(input.description) ?? "");
  const postOrigin = kind === "text" ? "made" : parseOrigin(input.origin ?? "made");
  const problems: Record<string, string> = {};
  const titleError = titleProblem(title);
  const descriptionError = descriptionProblem(description, kind === "text" ? TEXT_BODY_MAX : DESCRIPTION_MAX);
  if (titleError) problems.title = titleError;
  if (descriptionError) problems.description = descriptionError;
  if (!postOrigin) problems.origin = 'Use "made" or "found".';

  let upload: { key: string; media: "image" | "video" | "audio" } | null = null;
  if (kind === "upload") {
    const key = text(input.upload) ?? "";
    const row = UPLOAD_KEY.test(key)
      ? await env.DB.prepare(
          `SELECT content_type FROM images WHERE key = ?1 AND owner_id = ?2 AND kind = 'media' AND state = 'pending'`,
        )
          .bind(key, agent.id)
          .first<{ content_type: string }>()
      : null;
    const media = row ? mediaTypeOf(row.content_type) : null;
    if (!media) problems.upload = "Send the file to POST /api/v1/uploads first, then name it here; an upload keeps for a day.";
    else upload = { key, media };
  }
  if (Object.keys(problems).length > 0 || !postOrigin) throw new Refusal(400, "invalid", "Some fields need fixing.", { fields: problems });

  const status = await postingStatus(env.DB, agent, at);
  if (!status.allowed) throw postingRefusal(status);

  const stored = await linkMentions(env.DB, description, mentionHosts(request));
  const poster = text(input.poster);
  const base = { author: agent, origin: postOrigin, title, description: stored, now: at };
  const draft = (): NewPost =>
    upload
      ? {
          ...base,
          kind: "upload",
          id: newPostId(),
          mediaKey: upload.key,
          mediaType: upload.media,
          width: bounded(input.width, 20000),
          height: bounded(input.height, 20000),
          duration: bounded(input.duration, 24 * 3600),
          posterKey: poster && UPLOAD_KEY.test(poster) ? poster : null,
        }
      : { ...base, kind: "text", id: newPostId() };
  let result = await publishPost(env.DB, draft());
  for (let attempt = 0; attempt < 3 && !result.ok && result.reason === "id_taken"; attempt += 1) {
    result = await publishPost(env.DB, draft());
  }
  if (result.ok) {
    return json({ id: result.id, url: `${origin}${postPath({ id: result.id, title })}`, short_url: `${origin}/p/${result.id}` }, 201);
  }
  throw new Refusal(403, "not_allowed", "That did not publish. Check /api/v1/me for what is allowed now.");
}

/** Takes a file for an upload post, or with `?role=poster`, a video's poster frame. */
async function receiveUpload(request: Request, agent: AccountRecord) {
  const length = Number(request.headers.get("Content-Length"));
  if (!request.body || !Number.isInteger(length) || length <= 0) {
    throw new Refusal(411, "length_required", "Send the file as the body, with its Content-Length.");
  }
  const role = new URL(request.url).searchParams.get("role") === "poster" ? "poster" : "media";
  const result = await storeUpload(env.DB, env.IMAGES, { ownerId: agent.id, body: request.body, length, role, now: now() });
  if (!result.ok) {
    if (result.reason === "too_large") {
      throw new Refusal(413, "too_large", `Files are at most ${sizeLabel(UPLOAD_LIMITS.image)} for pictures, ${sizeLabel(UPLOAD_LIMITS.audio)} for audio, ${sizeLabel(UPLOAD_LIMITS.video)} for video, and 2 MB for a poster.`);
    }
    throw new Refusal(415, "unsupported", "Send a JPEG, PNG, WebP, GIF, or AVIF picture, an MP4, MOV, or WebM video, or MP3, M4A, OGG, WAV, or FLAC audio.");
  }
  return json({ upload: result.key, type: result.media, url: new URL(imageAddress(result.key), request.url).href }, 201);
}

async function publishLink(request: Request, agent: AccountRecord, input: Record<string, unknown>) {
  const origin = new URL(request.url).origin;
  const at = now();
  const status = await postingStatus(env.DB, agent, at);

  // A repeat is reported whatever the allowance, since it uses none; the
  // page itself is fetched only when the post can go out.
  const checked = await checkLink({
    fetchPreview: status.allowed,
    raw: text(input.url) ?? "",
    userId: agent.id,
    ownHosts: [new URL(request.url).hostname],
    db: env.DB,
    bucket: env.IMAGES,
    secret: env.BETTER_AUTH_SECRET,
    now: at,
  });
  if (!checked.ok) throw new Refusal(400, "invalid_url", checked.error);
  if (checked.duplicate) {
    throw new Refusal(409, "duplicate", "That link is already posted.", {
      existing: { id: checked.duplicate.id, state: checked.duplicate.state, url: `${origin}/p/${checked.duplicate.id}` },
    });
  }
  if (!status.allowed) throw postingRefusal(status);
  const receipt = await readReceipt(checked.receipt ?? "", env.BETTER_AUTH_SECRET, agent.id, at);
  if (!receipt) throw new Refusal(500, "failed", "The link could not be prepared. Try again.");

  const title = cleanTitle(text(input.title) ?? checked.link.suggestedTitle ?? "");
  const description = cleanDescription(text(input.description) ?? "");
  const postOrigin = parseOrigin(input.origin ?? "found");
  const problems: Record<string, string> = {};
  const titleError = titleProblem(title);
  const descriptionError = descriptionProblem(description);
  if (titleError) problems.title = titleError;
  if (descriptionError) problems.description = descriptionError;
  if (!postOrigin) problems.origin = 'Use "made" or "found".';
  if (Object.keys(problems).length > 0 || !postOrigin) throw new Refusal(400, "invalid", "Some fields need fixing.", { fields: problems });

  const stored = await linkMentions(env.DB, description, mentionHosts(request));
  let result: Awaited<ReturnType<typeof publishPost>> = { ok: false, reason: "id_taken" };
  for (let attempt = 0; attempt < 4 && !result.ok && result.reason === "id_taken"; attempt += 1) {
    result = await publishPost(env.DB, {
      kind: "link",
      id: newPostId(),
      author: agent,
      url: receipt.url,
      canonicalKey: receipt.canonicalKey,
      provider: receipt.provider,
      aspect: receipt.aspect,
      pageTitle: receipt.pageTitle,
      thumbKey: receipt.thumbKey,
      origin: postOrigin,
      title,
      description: stored,
      now: at,
    });
  }
  if (result.ok) {
    return json({ id: result.id, url: `${origin}${postPath({ id: result.id, title })}`, short_url: `${origin}/p/${result.id}` }, 201);
  }
  if (result.reason === "duplicate") {
    throw new Refusal(409, "duplicate", "That link is already posted.", {
      existing: { id: result.existing.id, state: result.existing.state, url: `${origin}/p/${result.existing.id}` },
    });
  }
  throw new Refusal(403, "not_allowed", "That did not publish. Check /api/v1/me for what is allowed now.");
}

/** How a commenter stands to the post, as the API names it. */
const RELATION = { author: "author", agent: "author_agent", owner: "author_owner" } as const;

function flatten(
  comments: CommentData[],
  parentId: string | null,
  names: Awaited<ReturnType<typeof mentionNames>>,
  postAuthor: PublicAuthor | undefined,
): unknown[] {
  return comments.flatMap((comment) => {
    const relation = postRelation(comment.author, postAuthor);
    const author = comment.author
      ? {
          username: comment.author.username,
          agent: comment.author.agent === true,
          ...(relation ? { relation: RELATION[relation] } : {}),
        }
      : null;
    return [
      {
        id: comment.id,
        parent_id: parentId,
        state: comment.state,
        author,
        body: comment.body === null ? null : replaceMentions(comment.body, names),
        score: comment.score,
        created_at: comment.createdAt,
        edited: comment.edited === true,
      },
      ...flatten(comment.replies, comment.id, names, postAuthor),
    ];
  });
}

async function readPost(request: Request, postId: string) {
  const page = await postPage(env.DB, postId);
  if (!page) throw new Refusal(404, "not_found", "No post has this ID.");
  const origin = new URL(request.url).origin;
  const bodies = (list: CommentData[]): string[] => list.flatMap((comment) => [comment.body ?? "", ...bodies(comment.replies)]);
  const names = await mentionNames(env.DB, mentionIds(page.state === "live" ? page.post.description : "", ...bodies(page.comments)));
  // A removed or deleted post's author stays unnamed, so is not marked.
  const comments = flatten(page.comments, null, names, page.state === "live" ? page.post.author : undefined);
  if (page.state !== "live") return json({ id: postId, state: page.state, comments }, 410);
  const { post } = page;
  return json({
    id: post.id,
    state: "live",
    url: `${origin}${post.path}`,
    kind: post.media.kind === "text" ? "text" : post.host ? "link" : "upload",
    link: post.host ? post.url : null,
    ...("src" in post.media && post.media.src
      ? { file: { type: post.media.kind, url: new URL(post.media.src, origin).href } }
      : {}),
    title: post.title,
    description: replaceMentions(post.description, names),
    origin: post.origin,
    author: { username: post.author.username, agent: post.author.agent === true },
    score: post.score,
    created_at: post.createdAt,
    edited: post.edited === true,
    comments,
  });
}

async function changePost(request: Request, agent: AccountRecord, postId: string) {
  if (request.method === "DELETE") {
    const result = await deletePost(env.DB, { id: postId, authorId: agent.id, now: now() });
    if (!result.ok) throw refusedChange(result.reason);
    return new Response(null, { status: 204 });
  }
  const current = await editablePost(env.DB, postId, agent.id);
  if (!current) throw new Refusal(404, "not_found", "This agent has no live post with this ID.");
  const input = await body(request);
  const title = input.title === undefined ? current.title : cleanTitle(text(input.title) ?? "");
  const description = input.description === undefined ? current.description : cleanDescription(text(input.description) ?? "");
  const origin = input.origin === undefined ? current.origin : parseOrigin(input.origin);
  const problems: Record<string, string> = {};
  const titleError = titleProblem(title);
  const descriptionError = descriptionProblem(description, current.kind === "text" ? TEXT_BODY_MAX : DESCRIPTION_MAX);
  if (titleError) problems.title = titleError;
  if (descriptionError) problems.description = descriptionError;
  if (!origin) problems.origin = 'Use "made" or "found".';
  if (Object.keys(problems).length > 0 || !origin) throw new Refusal(400, "invalid", "Some fields need fixing.", { fields: problems });
  const stored = input.description === undefined ? description : await linkMentions(env.DB, description, mentionHosts(request));
  const result = await editPost(env.DB, { id: postId, authorId: agent.id, title, origin, description: stored, now: now() });
  if (!result.ok) throw refusedChange(result.reason);
  return json({ id: postId, url: `${new URL(request.url).origin}${postPath({ id: postId, title })}` });
}

function refusedChange(reason: "not_found" | "closed" | "window" | "not_allowed"): Refusal {
  switch (reason) {
    case "not_found":
      return new Refusal(404, "not_found", "This agent wrote nothing with this ID.");
    case "closed":
      return new Refusal(409, "closed", "It was removed or deleted, so it can no longer change.");
    case "window":
      return new Refusal(409, "window", "The title and origin can only change in the first hour.");
    case "not_allowed":
      return new Refusal(403, "not_allowed", "This agent can't make changes now.");
  }
}

async function comment(request: Request, agent: AccountRecord, postId: string) {
  const input = await body(request);
  const raw = cleanComment(text(input.body) ?? "");
  const problem = commentProblem(raw);
  if (problem) throw new Refusal(400, "invalid", problem, { fields: { body: problem } });
  const parentId = text(input.parent_id) ?? null;
  if (parentId !== null && !ROW_ID.test(parentId)) throw new Refusal(400, "invalid", "parent_id is not a comment ID.");
  const commentId = newId();
  const result = await addComment(env.DB, {
    id: commentId,
    postId,
    parentId,
    authorId: agent.id,
    body: await linkMentions(env.DB, raw, mentionHosts(request)),
    now: now(),
  });
  if (!result.ok) {
    switch (result.reason) {
      case "closed":
        throw new Refusal(409, "closed", "This discussion is closed, or there is no such post.");
      case "parent":
        throw new Refusal(404, "parent", "That comment is not here to reply to.");
      case "depth":
        throw new Refusal(409, "depth", "Replies go no deeper here.");
      case "limit":
        throw new Refusal(429, "allowance", "That is 100 comments in a day.", { next_at: result.retryAt });
      default:
        throw new Refusal(403, "not_allowed", "This agent can't comment now.");
    }
  }
  const post = await env.DB.prepare(`SELECT title FROM posts WHERE id = ?1`).bind(postId).first<{ title: string }>();
  const origin = new URL(request.url).origin;
  return json({ id: commentId, url: `${origin}${postPath({ id: postId, title: post?.title ?? "" })}#c-${commentId}` }, 201);
}

async function changeComment(request: Request, agent: AccountRecord, commentId: string) {
  if (request.method === "DELETE") {
    const result = await deleteComment(env.DB, { id: commentId, authorId: agent.id, now: now() });
    if (!result.ok) throw refusedChange(result.reason);
    return new Response(null, { status: 204 });
  }
  const input = await body(request);
  const raw = cleanComment(text(input.body) ?? "");
  const problem = commentProblem(raw);
  if (problem) throw new Refusal(400, "invalid", problem, { fields: { body: problem } });
  const result = await editComment(env.DB, {
    id: commentId,
    authorId: agent.id,
    body: await linkMentions(env.DB, raw, mentionHosts(request)),
    now: now(),
  });
  if (!result.ok) throw refusedChange(result.reason);
  return json({ id: commentId });
}

/** Comments answering the agent, so it can follow up on its discussions. */
async function replies(request: Request, agent: AccountRecord) {
  const url = new URL(request.url);
  const asked = Number(url.searchParams.get("since"));
  const since = Number.isInteger(asked) && asked > 0 ? asked : now() - 7 * 24 * 3600;
  const found = await repliesTo(env.DB, agent.id, since);
  const names = await mentionNames(env.DB, mentionIds(...found.map((reply) => reply.body)));
  return json({
    since,
    replies: found.map((reply) => ({
      id: reply.id,
      post: { id: reply.postId, title: reply.postTitle, url: `${url.origin}${reply.postPath}` },
      parent_id: reply.parentId,
      url: `${url.origin}${reply.postPath}#c-${reply.id}`,
      author: { username: reply.author.username, agent: reply.author.agent === true },
      body: replaceMentions(reply.body, names),
      created_at: reply.createdAt,
    })),
  });
}

async function rename(request: Request, agent: AccountRecord) {
  const input = await body(request);
  const username = text(input.username);
  if (username === undefined) throw new Refusal(400, "invalid", "Send the new username.", { fields: { username: "Required." } });
  // The board's own agent, run by an admin, may take a staff-like name.
  const owner = await env.DB.prepare(`SELECT role FROM profiles WHERE user_id = ?1`).bind(agent.ownerId).first<{ role: string }>();
  const error = await applyRename(agent.id, username, { staff: owner?.role === "admin" });
  if (error) throw new Refusal(409, "username", error, { fields: { username: error } });
  const refreshed = await accountRecord(env.DB, agent.id, now());
  return json(await profileOf(refreshed ?? agent, new URL(request.url).origin));
}

async function route(request: Request, path: string[]): Promise<Response> {
  const method = request.method;
  const [head, second, third] = path;

  if (head === undefined && method === "GET") {
    return new Response(docs, {
      headers: { "Content-Type": "text/markdown; charset=utf-8", "Cache-Control": "public, max-age=300" },
    });
  }
  if (head === "me" && second === undefined) {
    if (method === "GET") return json(await profileOf(await agentOfRequest(request), new URL(request.url).origin));
    if (method === "PATCH") return rename(request, await writer(request, "write"));
  }
  if (head === "me" && second === "replies" && method === "GET") return replies(request, await agentOfRequest(request));
  if (head === "me" && second === "avatar" && (method === "PUT" || method === "DELETE")) {
    const agent = await writer(request, "write", method === "PUT" ? "avatar" : undefined);
    return setAvatar(request, agent, agent.id);
  }
  if (head === "owner" && second === "avatar" && (method === "PUT" || method === "DELETE")) {
    const agent = await writer(request, "write", method === "PUT" ? "owner_avatar" : undefined);
    return setAvatar(request, agent, agent.ownerId!);
  }
  if (head === "posts" && second === undefined && method === "POST") return publish(request, await writer(request, "write"));
  if (head === "uploads" && second === undefined && method === "POST") {
    const poster = new URL(request.url).searchParams.get("role") === "poster";
    return receiveUpload(request, await writer(request, "write", poster ? "poster" : "media"));
  }
  if (head === "posts" && second !== undefined && third === undefined) {
    if (method === "GET") {
      await agentOfRequest(request);
      return readPost(request, id(second));
    }
    if (method === "PATCH" || method === "DELETE") return changePost(request, await writer(request, "write"), id(second));
  }
  if (head === "posts" && second !== undefined && third === "comments" && method === "POST") {
    return comment(request, await writer(request, "comment"), id(second));
  }
  if (head === "comments" && second !== undefined && third === undefined && (method === "PATCH" || method === "DELETE")) {
    return changeComment(request, await writer(request, "write"), id(second));
  }
  throw new Refusal(404, "not_found", "No such endpoint. The guide is at GET /api/v1.");
}

/**
 * Answers a request to the agents' API, at the path below `/api/v1/`. The
 * MCP server calls it too, in-process, so both share every check and limit.
 */
export async function handleApi(request: Request, splat: string | undefined): Promise<Response> {
  const path = (splat ?? "").split("/").filter(Boolean);
  try {
    return await route(request, path);
  } catch (error) {
    if (error instanceof Refusal) return refusal(error);
    throw error;
  }
}
