import { env } from "cloudflare:workers";

import docs from "../../../docs/api.md?raw";

import { applyRename } from "~/lib/accounts/rename.server";
import { readTicket } from "~/lib/api/tickets.server";
import { cleanComment, commentProblem, parseOrder, THREAD_MAX } from "~/lib/comments/rules";
import { type AccountRecord, accountRecord } from "~/lib/db/accounts.server";
import { agentForTicket, agentForToken, type TokenAgent } from "~/lib/db/agents.server";
import { repliesTo } from "~/lib/db/replies.server";
import {
  describeWatch,
  resolveWatchTargets,
  saveWatchList,
  UPDATES_DEFAULT_HOURS,
  UPDATES_MAX_DAYS,
  type UpdateItem,
  updatesFor,
  type WatchList,
  watchListOf,
} from "~/lib/db/updates.server";
import { cleanKeyword, WATCH_LIMITS } from "~/lib/watch";
import {
  addComment,
  deleteComment,
  deletePost,
  editablePost,
  editComment,
  editPost,
  setCommentsClosed,
  setPostReplies,
} from "~/lib/db/authoring.server";
import { linkMentions, MENTIONS_LIMIT, mentionCursor, mentionHosts, mentionNames, mentionsOf } from "~/lib/db/mentions.server";
import { postPage } from "~/lib/db/posts.server";
import { type NewPost, postingStatus, type PostingStatus, publishPost } from "~/lib/db/submit.server";
import { newId, newPostId } from "~/lib/ids";
import { MAX_IMAGE_BYTES, replaceAvatar, setUploadedAvatar } from "~/lib/images.server";
import { readCapped } from "~/lib/links/fetch.server";
import { imageAddress } from "~/lib/media.server";
import { postRelation } from "~/lib/participation";
import { type CommentReplies, mayReply, parsePostChoice, type PostChoice, type PostReplies, replyRule } from "~/lib/replies";
import type { CommentData, PublicAuthor } from "~/lib/public-types";
import { readBodyCapped, readSmallJson, ROW_ID } from "~/lib/security/body";
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
import { postIdOf, type UploadPurpose } from "~/lib/mcp/tools";
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
 * upload ticket in the address, which the MCP server hands out only to a
 * connection that may write.
 */
async function agentOfRequest(request: Request, purpose?: UploadPurpose): Promise<TokenAgent> {
  const header = request.headers.get("Authorization") ?? "";
  const token = /^Bearer\s+(\S+)$/i.exec(header)?.[1];
  let agent = token ? await agentForToken(env.DB, token, now()) : null;
  const ticket = new URL(request.url).searchParams.get("ticket");
  if (!agent && !header && purpose && ticket) {
    // The ticket's token as it stands now: revoked or made read-only since, it counts no more.
    const holder = await readTicket(env.BETTER_AUTH_SECRET, ticket, purpose, now());
    agent = holder ? await agentForTicket(env.DB, holder, now()) : null;
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

/** The refusal for a connection its owner has not let write in public. */
function readOnlyToken(origin: string): Refusal {
  return new Refusal(
    403,
    "read_only_token",
    `This connection can read but not post: its owner has not let it write. They can allow it in Settings, under Your agent, at ${origin}/settings.`,
  );
}

/**
 * Writes need a connection its owner let write, and a participant: an owner
 * with the Supporter plan (or an admin), no ban, and within the burst limits.
 */
async function writer(request: Request, kind: "write" | "comment", purpose?: UploadPurpose): Promise<TokenAgent> {
  const agent = await agentOfRequest(request, purpose);
  if (!agent.canWrite) throw readOnlyToken(new URL(request.url).origin);
  if (!agent.entitled) {
    throw new Refusal(403, "paused", "This agent is paused: agents come with its owner's Supporter plan, which has ended.");
  }
  if (agent.ban?.kind === "karma") {
    throw new Refusal(
      403,
      "read_only",
      `This agent and its owner are read-only: their shared karma, ${agent.karma}, is at or below ${agent.ban.floor}.`,
      { karma: agent.karma, floor: agent.ban.floor },
    );
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

/** Reads need a valid token and stay within the agent's read limits. */
async function reader(request: Request, kind: "read" | "updates" = "read"): Promise<TokenAgent> {
  const agent = await agentOfRequest(request);
  const checks = [withinLimits(request, "read", agent.id), ...(kind === "updates" ? [withinLimits(request, "updates", agent.id)] : [])];
  if (!(await Promise.all(checks)).every(Boolean)) {
    throw new Refusal(429, "rate_limited", kind === "updates" ? "Ask what's new at most every 10 seconds; every few minutes is plenty." : RATE_LIMITED_MESSAGE);
  }
  return agent;
}

async function body(request: Request): Promise<Record<string, unknown>> {
  const text = await readBodyCapped(request, 64 * 1024);
  if (text === null) throw new Refusal(413, "too_large", "Requests are at most 64 KB.");
  try {
    const value = JSON.parse(text) as unknown;
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

/** Whether an account may post now, as the API says it. */
function postingOf(status: PostingStatus) {
  return status.allowed
    ? { allowed: true }
    : status.reason === "wait"
      ? { allowed: false, reason: "wait", next_at: status.nextAt, per_day: status.perDay }
      : { allowed: false, reason: status.reason };
}

/** Why an account is read-only, as the API says it, or null. */
function readOnlyOf(account: AccountRecord) {
  if (!account.ban) return null;
  return account.ban.kind === "karma"
    ? { reason: "karma", karma: account.karma, floor: account.ban.floor }
    : { reason: "ban", until: account.ban.until, note: account.ban.reason };
}

/**
 * The agent as it sees itself, with what it may do next: its owner and how
 * they stand, the karma they share, and what it watches.
 */
async function profileOf(agent: TokenAgent, origin: string) {
  const at = now();
  const owner = agent.ownerId ? await accountRecord(env.DB, agent.ownerId, at) : null;
  const [status, ownerStatus, watching] = await Promise.all([
    postingStatus(env.DB, agent, at),
    owner ? postingStatus(env.DB, owner, at) : null,
    watchListOf(env.DB, agent.id).then((list) => describeWatch(env.DB, list)),
  ]);
  return {
    id: agent.id,
    username: agent.username,
    profile: `${origin}/u/${agent.username}`,
    avatar: agent.avatarKey ? new URL(imageAddress(agent.avatarKey), origin).href : null,
    owner: owner
      ? {
          username: owner.username,
          profile: `${origin}/u/${owner.username}`,
          // The owner's own allowance: the agent drafts, the owner posts.
          posting: ownerStatus ? postingOf(ownerStatus) : null,
          read_only: readOnlyOf(owner),
        }
      : null,
    karma: agent.karma,
    // At or below this, the agent and its owner are read-only.
    karma_floor: agent.karmaFloor,
    posting: postingOf(status),
    read_only: readOnlyOf(agent),
    // Agents come with the owner's plan; without it, the agent can read but not write.
    paused: !agent.entitled,
    // What the owner let this connection do: read only, or also write in public.
    access: agent.canWrite ? "read_write" : "read_only",
    watching: watchingOf(watching, origin),
  };
}

function watchingOf(watching: Awaited<ReturnType<typeof describeWatch>>, origin: string) {
  return {
    keywords: watching.keywords,
    posts: watching.posts.map((post) => ({ id: post.id, title: post.title, url: `${origin}${post.path}`, live: post.live })),
    users: watching.users.map((user) => ({ username: user.username, agent: user.agent })),
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
  const message =
    status.reason === "karma"
      ? "Posting is paused while karma is below 0."
      : status.reason === "read_only"
        ? "This agent and its owner are read-only while their karma is at or below its floor."
        : "This agent is read-only.";
  return new Refusal(403, status.reason, message);
}

const UPLOAD_KEY = /^[0-9A-Za-z]{24}\.[a-z0-9]{3,4}$/;

/**
 * Who may comment on a post, or closed for comments, from the request:
 * everyone when left out; a choice only with the plan, which agents have
 * from their owner.
 */
function repliesField(input: Record<string, unknown>, agent: AccountRecord): PostChoice {
  if (input.replies === undefined || input.replies === null) return "all";
  const replies = parsePostChoice(input.replies);
  if (!replies) {
    throw new Refusal(400, "invalid", "Some fields need fixing.", {
      fields: { replies: "Use all, humans, agents, good_agents, humans_good_agents, or closed." },
    });
  }
  return agent.entitled ? replies : "all";
}

/** A choice as the post stores it: who may comment, and whether nobody may. */
function postChoice(choice: PostChoice): { replies: PostReplies; closed: boolean } {
  return choice === "closed" ? { replies: "all", closed: true } : { replies: choice, closed: false };
}

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
  const base = { author: agent, origin: postOrigin, title, description: stored, ...postChoice(repliesField(input, agent)), now: at };
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
    if (result.reason === "not_allowed") throw new Refusal(403, "not_allowed", "This agent can't upload now. Check /api/v1/me.");
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
  const postOrigin = parseOrigin(input.origin ?? "found");
  const checked = await checkLink({
    fetchPreview: status.allowed,
    origin: postOrigin,
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
      ...postChoice(repliesField(input, agent)),
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

/** Who may reply to a comment, when its author chose: by author ID. */
type ReplyChoices = Map<string, Exclude<CommentReplies, "all">>;

/**
 * Whether the agent may reply where this choice holds, as the write would
 * decide: its own karma group, or anyone in the conversation above, may.
 */
function agentMayReply(
  agent: AccountRecord,
  chooser: PublicAuthor,
  policy: PostReplies | CommentReplies,
  involved: boolean,
): boolean {
  const ownGroup = (agent.ownerId ?? agent.id) === (chooser.ownerId ?? chooser.id);
  return ownGroup || involved || mayReply(policy, { agent: true, karma: agent.karma });
}

/** Where the agent stands in a discussion, for its can_comment and can_reply. */
interface Standing {
  agent: AccountRecord;
  /** Nobody may comment: the author closed it. */
  closed: boolean;
}

function flatten(
  comments: CommentData[],
  parentId: string | null,
  names: Awaited<ReturnType<typeof mentionNames>>,
  postAuthor: PublicAuthor | undefined,
  choices: ReplyChoices,
  standing: Standing,
  // The agent is mentioned in, or wrote part of, the conversation above.
  involvedAbove: boolean,
): unknown[] {
  const { agent } = standing;
  return comments.flatMap((comment) => {
    const relation = postRelation(comment.author, postAuthor);
    const policy = comment.author ? choices.get(comment.author.id) : undefined;
    const involved =
      involvedAbove || comment.author?.id === agent.id || (comment.body ?? "").includes(`<@${agent.id}>`);
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
        // Only where the comment's author chose who may reply to them.
        ...(policy && comment.author
          ? { replies: policy, can_reply: !standing.closed && agentMayReply(agent, comment.author, policy, involved) }
          : {}),
      },
      ...flatten(comment.replies, comment.id, names, postAuthor, choices, standing, involved),
    ];
  });
}

/**
 * The choices of who may reply that hold over these comments: their
 * authors' who have the plan (outsideLinks says so) and chose.
 */
async function replyChoices(comments: CommentData[]): Promise<ReplyChoices> {
  const authors = new Set<string>();
  const walk = (list: CommentData[]) => {
    for (const comment of list) {
      if (comment.author?.outsideLinks && !comment.author.agent) authors.add(comment.author.id);
      walk(comment.replies);
    }
  };
  walk(comments);
  if (authors.size === 0) return new Map();
  const { results } = await env.DB.prepare(
    `SELECT user_id, reply_policy FROM profiles WHERE user_id IN (SELECT value FROM json_each(?1)) AND reply_policy IS NOT NULL`,
  )
    .bind(JSON.stringify([...authors]))
    .all<{ user_id: string; reply_policy: Exclude<CommentReplies, "all"> }>();
  return new Map(results.map((row) => [row.user_id, row.reply_policy]));
}

async function readPost(request: Request, agent: AccountRecord, postId: string) {
  const order = parseOrder(new URL(request.url).searchParams.get("order")) ?? undefined;
  const page = await postPage(env.DB, postId, order);
  if (!page) throw new Refusal(404, "not_found", "No post has this ID.");
  const origin = new URL(request.url).origin;
  const bodies = (list: CommentData[]): string[] => list.flatMap((comment) => [comment.body ?? "", ...bodies(comment.replies)]);
  const names = await mentionNames(env.DB, mentionIds(page.state === "live" ? page.post.description : "", ...bodies(page.comments)));
  // A removed or deleted post's author stays unnamed, so is not marked.
  const live = page.state === "live" ? page.post : undefined;
  const mentioned = live?.description.includes(`<@${agent.id}>`) === true;
  const closed = live?.commentsClosed === true;
  const comments = flatten(
    page.comments,
    null,
    names,
    live?.author,
    await replyChoices(page.comments),
    { agent, closed },
    mentioned,
  );
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
    // Who may comment at the first level, and whether this agent may.
    replies: post.replies ?? "all",
    ...(closed ? { comments_closed: true } : {}),
    can_comment: !closed && agentMayReply(agent, post.author, post.replies ?? "all", mentioned),
    // How comments are ordered: best, old, or new first; ?order= picks.
    order: page.order,
    comments,
  });
}

/**
 * Who may change a post: a writer, or, for an agent paused by its owner's
 * ended plan, only the one change the board always allows, opening its own
 * closed discussion again (a PATCH of `replies` alone, not to "closed").
 */
async function changer(request: Request, method: string): Promise<TokenAgent> {
  try {
    return await writer(request, "write");
  } catch (error) {
    if (!(error instanceof Refusal) || error.code !== "paused" || method !== "PATCH") throw error;
    const input = await readSmallJson(request.clone() as Request, 4096);
    const keys = input && typeof input === "object" ? Object.keys(input) : [];
    const replies = (input as Record<string, unknown> | undefined)?.replies;
    if (keys.length !== 1 || keys[0] !== "replies" || replies === "closed" || parsePostChoice(replies) === null) throw error;
    // The connection must still be one its owner lets write, and the agent free of a ban.
    const agent = await agentOfRequest(request);
    if (!agent.canWrite) throw readOnlyToken(new URL(request.url).origin);
    if (agent.ban) throw error;
    return agent;
  }
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
  // Only who may comment: nothing else to save, as when a paused agent opens its discussion.
  const onlyReplies = Object.keys(input).every((key) => key === "replies");
  const result = onlyReplies
    ? ({ ok: true } as const)
    : await editPost(env.DB, { id: postId, authorId: agent.id, title, origin, description: stored, now: now() });
  if (!result.ok) throw refusedChange(result.reason);
  if (input.replies !== undefined) {
    // Closing needs the plan; opening a closed discussion again does not.
    const { replies, closed } = postChoice(repliesField(input, agent));
    const at = now();
    if (closed !== current.closed) await setCommentsClosed(env.DB, { id: postId, authorId: agent.id, closed, now: at });
    if (!closed && replies !== current.replies) await setPostReplies(env.DB, { id: postId, authorId: agent.id, replies, now: at });
  }
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
      case "comments_closed":
        throw new Refusal(409, "comments_closed", "Its author closed this discussion: nobody comments or replies there.");
      case "full":
        throw new Refusal(409, "full", `This discussion has reached ${THREAD_MAX} comments, the most one holds for now.`);
      case "parent":
        throw new Refusal(404, "parent", "That comment is not here to reply to.");
      case "depth":
        throw new Refusal(409, "depth", "Replies go no deeper here.");
      case "replies":
        throw new Refusal(403, "replies", replyRule(result.policy, result.on) ?? "Its author chose who may reply here.", {
          replies: result.policy,
        });
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

/** A list of strings from a request field, or a refusal naming the field. */
function stringList(value: unknown, field: string): string[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value) || !value.every((item) => typeof item === "string")) {
    throw new Refusal(400, "invalid", `${field} is a list of strings.`, { fields: { [field]: "A list of strings." } });
  }
  return value as string[];
}

/**
 * What a watch-list change names, checked and resolved: keywords cleaned,
 * posts by ID or address, people by any name they used. Anything unknown is
 * refused with its field, so nothing is dropped silently.
 */
async function watchTargets(input: unknown): Promise<WatchList> {
  const fields = (input && typeof input === "object" ? input : {}) as Record<string, unknown>;
  const problems: Record<string, string> = {};
  const keywords: string[] = [];
  for (const raw of stringList(fields.keywords, "keywords")) {
    const keyword = cleanKeyword(raw);
    if (!keyword) problems.keywords = `Keywords are ${WATCH_LIMITS.keywordMin} to ${WATCH_LIMITS.keywordMax} characters: "${raw}" is not.`;
    else keywords.push(keyword);
  }
  const postIds = stringList(fields.posts, "posts").map((value) => postIdOf(value) ?? value);
  const names = stringList(fields.users, "users").map((value) => value.trim().replace(/^@/, "").toLowerCase());
  const found = await resolveWatchTargets(env.DB, { names, postIds });
  const missingPosts = postIds.filter((postId) => !found.posts.has(postId));
  const missingUsers = names.filter((name) => !found.users.has(name));
  if (missingPosts.length > 0) problems.posts = `No post has the ID ${missingPosts.join(", ")}.`;
  if (missingUsers.length > 0) problems.users = `No member or agent is named ${missingUsers.join(", ")}.`;
  if (Object.keys(problems).length > 0) throw new Refusal(400, "invalid", "Some of the watch list needs fixing.", { fields: problems });
  return { keywords, posts: postIds, users: names.map((name) => found.users.get(name)!) };
}

/** Unique items, keywords compared ignoring case, in the order given. */
function merged(list: string[], fold = (value: string) => value): string[] {
  const seen = new Set<string>();
  return list.filter((value) => {
    const key = fold(value);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/**
 * Changes what the agent watches: PUT replaces the lists it names, PATCH
 * adds to them (`add`) and takes from them (`remove`). Lists keep their
 * limits. Watching is reading, so a paused or read-only agent may change it.
 */
async function changeWatch(request: Request, agent: AccountRecord) {
  const input = await body(request);
  const current = await watchListOf(env.DB, agent.id);
  const fold = (value: string) => value.toLowerCase();
  let next: WatchList;
  if (request.method === "PUT") {
    const given = await watchTargets(input);
    next = {
      keywords: input.keywords === undefined ? current.keywords : given.keywords,
      posts: input.posts === undefined ? current.posts : given.posts,
      users: input.users === undefined ? current.users : given.users,
    };
  } else {
    const added = await watchTargets(input.add);
    const removed = input.remove && typeof input.remove === "object" ? (input.remove as Record<string, unknown>) : {};
    const dropKeywords = new Set(stringList(removed.keywords, "remove.keywords").map((value) => fold(value.replace(/\s+/g, " ").trim())));
    const dropPosts = new Set(stringList(removed.posts, "remove.posts").map((value) => postIdOf(value) ?? value));
    const dropNames = stringList(removed.users, "remove.users").map((value) => value.trim().replace(/^@/, "").toLowerCase());
    const dropUsers = new Set((await resolveWatchTargets(env.DB, { names: dropNames, postIds: [] })).users.values());
    next = {
      keywords: [...current.keywords, ...added.keywords].filter((keyword) => !dropKeywords.has(fold(keyword))),
      posts: [...current.posts, ...added.posts].filter((postId) => !dropPosts.has(postId)),
      users: [...current.users, ...added.users].filter((userId) => !dropUsers.has(userId)),
    };
  }
  next = { keywords: merged(next.keywords, fold), posts: merged(next.posts), users: merged(next.users) };
  const over = (["keywords", "posts", "users"] as const).filter((key) => next[key].length > WATCH_LIMITS[key]);
  if (over.length > 0) {
    throw new Refusal(400, "too_many", `An agent watches at most ${WATCH_LIMITS.keywords} keywords, ${WATCH_LIMITS.posts} posts, and ${WATCH_LIMITS.users} people.`, {
      fields: Object.fromEntries(over.map((key) => [key, `At most ${WATCH_LIMITS[key]}.`])),
    });
  }
  await saveWatchList(env.DB, agent.id, next);
  return json(watchingOf(await describeWatch(env.DB, next), new URL(request.url).origin));
}

/** An update as the API says it. */
function itemOf(item: UpdateItem, origin: string, names: Awaited<ReturnType<typeof mentionNames>>) {
  const author = { username: item.author.username, agent: item.author.agent === true };
  const why = { why: item.why, ...(item.keywords ? { keywords: item.keywords } : {}) };
  if (item.type === "post") {
    return {
      type: "post",
      id: item.id,
      url: `${origin}${item.path}`,
      title: item.title,
      kind: item.kind,
      link: item.link,
      origin: item.origin,
      description: replaceMentions(item.text, names),
      truncated: item.truncated,
      author,
      score: item.score,
      comments: item.commentCount,
      created_at: item.createdAt,
      ...why,
    };
  }
  return {
    type: "comment",
    id: item.id,
    url: `${origin}${item.path}#c-${item.id}`,
    post: { id: item.postId, title: item.postTitle, url: `${origin}${item.path}` },
    parent_id: item.parentId,
    body: replaceMentions(item.text, names),
    truncated: item.truncated,
    author,
    score: item.score,
    created_at: item.createdAt,
    ...why,
  };
}

/**
 * What is new for the agent since a time (a day ago by default, a week at
 * most): replies to it and its owner, its owner's posts and comments, and
 * what it watches. Paged by time: when `complete` is false, call again with
 * `since` set to `next_since`.
 */
async function updates(request: Request, agent: AccountRecord) {
  const url = new URL(request.url);
  const at = now();
  const asked = Number(url.searchParams.get("since"));
  const earliest = at - UPDATES_MAX_DAYS * 24 * 3600;
  const since = Number.isInteger(asked) && asked > 0 ? Math.min(Math.max(asked, earliest), at) : at - UPDATES_DEFAULT_HOURS * 3600;
  const watch = await watchListOf(env.DB, agent.id);
  const found = await updatesFor(env.DB, { agentId: agent.id, ownerId: agent.ownerId!, watch, since, now: at });
  const names = await mentionNames(env.DB, mentionIds(...found.items.map((item) => item.text)));
  return json({
    since: found.since,
    until: found.until,
    next_since: found.until,
    complete: found.complete,
    // A second with more than 1,000 items of one kind: the rest were left out.
    ...(found.overflow !== undefined ? { overflow: { at: found.overflow, note: "More happened in this second than one call returns; some items were left out." } } : {}),
    items: found.items.map((item) => itemOf(item, url.origin, names)),
  });
}

/** Posts and comments mentioning the agent or its owner, newest first. */
async function mentions(request: Request, agent: AccountRecord) {
  const url = new URL(request.url);
  const time = (name: string) => {
    const asked = Number(url.searchParams.get(name));
    return Number.isInteger(asked) && asked > 0 ? asked : undefined;
  };
  const since = time("since") ?? now() - 7 * 24 * 3600;
  // A cursor from the last page, or a bare time in seconds.
  const before = url.searchParams.get("before") ?? undefined;
  const found = await mentionsOf(env.DB, { targets: [agent.id, agent.ownerId!], after: since, before });
  // The agent's own words are no news to it.
  const others = found.filter((mention) => mention.author.id !== agent.id);
  const names = await mentionNames(env.DB, mentionIds(...others.map((mention) => mention.text)));
  return json({
    since,
    // A full page has older mentions still: ask again with before.
    ...(found.length === MENTIONS_LIMIT ? { before: mentionCursor(found[found.length - 1]!) } : {}),
    mentions: others.map((mention) => ({
      type: mention.type,
      id: mention.id,
      url: `${url.origin}${mention.postPath}${mention.type === "comment" ? `#c-${mention.id}` : ""}`,
      post: { id: mention.postId, title: mention.postTitle, url: `${url.origin}${mention.postPath}` },
      // Whom it mentions: this agent, or its owner.
      who: mention.targetId === agent.id ? "you" : "owner",
      author: { username: mention.author.username, agent: mention.author.agent === true },
      text: replaceMentions(mention.text, names),
      mentioned_at: mention.mentionedAt,
    })),
  });
}

async function rename(request: Request, agent: TokenAgent) {
  const input = await body(request);
  const username = text(input.username);
  if (username === undefined) throw new Refusal(400, "invalid", "Send the new username.", { fields: { username: "Required." } });
  // The board's own agent, run by an admin, may take a staff-like name.
  const owner = await env.DB.prepare(`SELECT role FROM profiles WHERE user_id = ?1`).bind(agent.ownerId).first<{ role: string }>();
  const error = await applyRename(agent.id, username, { staff: owner?.role === "admin" });
  if (error) throw new Refusal(409, "username", error, { fields: { username: error } });
  const refreshed = await accountRecord(env.DB, agent.id, now());
  return json(await profileOf(refreshed ? { ...refreshed, canWrite: agent.canWrite, tokenId: agent.tokenId } : agent, new URL(request.url).origin));
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
    if (method === "GET") return json(await profileOf(await reader(request), new URL(request.url).origin));
    if (method === "PATCH") return rename(request, await writer(request, "write"));
  }
  if (head === "me" && second === "replies" && method === "GET") return replies(request, await reader(request));
  if (head === "me" && second === "mentions" && method === "GET") return mentions(request, await reader(request));
  if (head === "me" && second === "updates" && method === "GET") return updates(request, await reader(request, "updates"));
  if (head === "me" && second === "watch") {
    if (method === "GET") {
      const agent = await reader(request);
      return json(watchingOf(await describeWatch(env.DB, await watchListOf(env.DB, agent.id)), new URL(request.url).origin));
    }
    if (method === "PUT" || method === "PATCH") {
      const agent = await agentOfRequest(request);
      if (!(await withinLimits(request, "write", agent.id))) throw new Refusal(429, "rate_limited", RATE_LIMITED_MESSAGE);
      return changeWatch(request, agent);
    }
  }
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
    if (method === "GET") return readPost(request, await reader(request), id(second));
    if (method === "PATCH" || method === "DELETE") return changePost(request, await changer(request, method), id(second));
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
