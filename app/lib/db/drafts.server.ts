import { newId, newPostId } from "../ids";
import { cleanDraft, DRAFT_BYTES, DRAFT_LIMIT, type DraftFields, draftProblems } from "../draft-rules";
import { type PostChoice, parsePostChoice, type PostReplies } from "../replies";
import { checkLink } from "../submit/check.server";
import { readReceipt } from "../submit/receipt.server";
import { cleanDescription, cleanTitle, DESCRIPTION_MAX, descriptionProblem, type Origin, type PostKind, TEXT_BODY_MAX, titleProblem } from "../submit/rules";
import { mediaTypeOf } from "../uploads";
import { accountRecord } from "./accounts.server";
import { linkMentions } from "./mentions.server";
import { type Existing, type NewPost, postingStatus, type PostingStatus, publishPost } from "./submit.server";

/**
 * Saved drafts: posts not yet published, private to their author and, for
 * an agent's, its owner. Members and agents keep them whatever their plan
 * or standing; publishing one checks everything a new post would. An
 * owner may publish, decline, or remove their agent's drafts, but never
 * edit them: the agent's work stays the agent's. Every rule that matters
 * is part of the final write, so two hands at once cannot get around it.
 */

/** The key an upload or snapshot is stored under. */
const FILE_KEY = /^[0-9A-Za-z]{24}\.[a-z0-9]{3,4}$/;

/** Published drafts are kept this long, so a repeated publication finds its post. */
const PUBLISHED_KEEP_SECONDS = 30 * 24 * 3600;

export interface Draft {
  id: string;
  authorId: string;
  kind: PostKind;
  url: string | null;
  origin: Origin | null;
  title: string;
  description: string;
  replies: PostChoice | null;
  media: { key: string; type: "image" | "video" | "audio"; width: number | null; height: number | null; duration: number | null } | null;
  posterKey: string | null;
  revision: number;
  createdAt: number;
  updatedAt: number;
  declinedAt: number | null;
  /** The post it became, once published. */
  postId: string | null;
}

interface DraftRow {
  id: string;
  author_id: string;
  kind: PostKind;
  url: string | null;
  origin: Origin | null;
  title: string;
  description: string;
  replies: string | null;
  media_key: string | null;
  media_type: "image" | "video" | "audio" | null;
  media_width: number | null;
  media_height: number | null;
  media_duration: number | null;
  poster_key: string | null;
  revision: number;
  created_at: number;
  updated_at: number;
  declined_at: number | null;
  post_id: string | null;
}

function toDraft(row: DraftRow): Draft {
  return {
    id: row.id,
    authorId: row.author_id,
    kind: row.kind,
    url: row.url,
    origin: row.origin,
    title: row.title,
    description: row.description,
    replies: parsePostChoice(row.replies),
    media:
      row.media_key && row.media_type
        ? { key: row.media_key, type: row.media_type, width: row.media_width, height: row.media_height, duration: row.media_duration }
        : null,
    posterKey: row.poster_key,
    revision: row.revision,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    declinedAt: row.declined_at,
    postId: row.post_id,
  };
}

export async function draftById(db: D1Database, id: string): Promise<Draft | null> {
  const row = await db.prepare(`SELECT * FROM drafts WHERE id = ?1`).bind(id).first<DraftRow>();
  return row ? toDraft(row) : null;
}

/** An account's drafts not yet published, the latest change first. */
export async function draftsOf(db: D1Database, authorId: string): Promise<Draft[]> {
  const { results } = await db
    .prepare(`SELECT * FROM drafts WHERE author_id = ?1 AND post_id IS NULL ORDER BY updated_at DESC, id DESC LIMIT ${DRAFT_LIMIT * 2}`)
    .bind(authorId)
    .all<DraftRow>();
  return results.map(toDraft);
}

/** The agent an owner runs, if any: whose drafts they review. */
export async function agentIdOf(db: D1Database, ownerId: string): Promise<string | null> {
  const row = await db
    .prepare(`SELECT user_id FROM profiles WHERE owner_id = ?1 AND deleted_at IS NULL`)
    .bind(ownerId)
    .first<{ user_id: string }>();
  return row?.user_id ?? null;
}

/**
 * Who may act on a draft: its author, for everything, or the owner of the
 * agent that wrote it, for everything but editing. Null for anyone else,
 * to whom it does not exist.
 */
export async function draftFor(db: D1Database, id: string, viewerId: string): Promise<{ draft: Draft; as: "author" | "owner" } | null> {
  const row = await db
    .prepare(
      `SELECT draft.*, author.owner_id AS owner FROM drafts AS draft
       JOIN profiles AS author ON author.user_id = draft.author_id
       WHERE draft.id = ?1 AND (draft.author_id = ?2 OR author.owner_id = ?2)`,
    )
    .bind(id, viewerId)
    .first<DraftRow & { owner: string | null }>();
  if (!row) return null;
  return { draft: toDraft(row), as: row.author_id === viewerId ? "author" : "owner" };
}

export type SaveResult =
  | { ok: true; draft: Draft; freed: string[] }
  | { ok: false; reason: "invalid"; fields: Record<string, string> }
  | { ok: false; reason: "not_found" | "published" | "too_many" | "too_large" | "file" }
  | { ok: false; reason: "conflict"; revision: number };

/**
 * Saves a draft: a new one, or a change to the author's own, at the
 * revision they last saw when they name one. Files the author sent are
 * kept with it, safe from later uploads and the pending sweep; files it no
 * longer uses are deleted, and their keys come back for the bucket.
 * Sizes are checked; whether it is complete waits for publishing.
 */
export async function saveDraft(
  db: D1Database,
  input: { authorId: string; id?: string; revision?: number | null; fields: DraftFields; now: number },
): Promise<SaveResult> {
  const fields = cleanDraft(input.fields);
  const problems = draftProblems(fields);
  if (Object.keys(problems).length > 0) return { ok: false, reason: "invalid", fields: problems };
  for (const key of [fields.mediaKey, fields.posterKey]) if (key !== null && !FILE_KEY.test(key)) return { ok: false, reason: "file" };

  const id = input.id ?? newId();
  const current = input.id ? await draftById(db, input.id) : null;
  if (input.id && (!current || current.authorId !== input.authorId)) return { ok: false, reason: "not_found" };
  if (current?.postId) return { ok: false, reason: "published" };

  // Each file must be the author's: one sent and not yet used, or one this
  // draft already keeps in the same place.
  const files = [
    { key: fields.mediaKey, kind: "media", kept: current?.media?.key ?? null },
    { key: fields.posterKey, kind: "post", kept: current?.posterKey ?? null },
  ] as const;
  let mediaType: "image" | "video" | "audio" | null = null;
  for (const file of files) {
    if (file.key === null) continue;
    const row = await db
      .prepare(`SELECT state, content_type, bytes FROM images WHERE key = ?1 AND owner_id = ?2 AND kind = ?3`)
      .bind(file.key, input.authorId, file.kind)
      .first<{ state: string; content_type: string; bytes: number }>();
    const usable = row && (row.state === "pending" || (row.state === "draft" && file.key === file.kept));
    if (!usable) return { ok: false, reason: "file" };
    if (file.kind === "media") mediaType = mediaTypeOf(row.content_type);
  }
  // The author's draft files once this save lands, those it replaces left
  // out; checked again inside the write, so two saves at once cannot pass it together.
  const sizeAfter = () =>
    db
      .prepare(`SELECT ${bytesAfterSql(1, 2, 3, 4)} AS bytes`)
      .bind(id, input.authorId, fields.mediaKey, fields.posterKey)
      .first<{ bytes: number }>();
  if (((await sizeAfter())?.bytes ?? 0) > DRAFT_BYTES) return { ok: false, reason: "too_large" };

  // The files' rule again, inside the write: a file displaced or used since
  // the check above leaves the draft as it was.
  const fileHolds = (keyIndex: number, kind: "media" | "post", keptColumn: string) =>
    `(?${keyIndex} IS NULL OR EXISTS (SELECT 1 FROM images WHERE key = ?${keyIndex} AND owner_id = ?2 AND kind = '${kind}'
       AND (state = 'pending' OR (state = 'draft' AND key IN (SELECT ${keptColumn} FROM drafts WHERE id = ?1)))))`;
  const values = [
    id,
    input.authorId,
    fields.kind,
    fields.url,
    fields.origin,
    fields.title,
    fields.description,
    fields.replies,
    fields.mediaKey,
    mediaType,
    fields.width,
    fields.height,
    fields.duration,
    fields.posterKey,
    input.now,
    input.revision ?? null,
  ];
  const write = current
    ? db
        .prepare(
          `UPDATE drafts SET kind = ?3, url = ?4, origin = ?5, title = ?6, description = ?7, replies = ?8,
             media_key = ?9, media_type = ?10, media_width = ?11, media_height = ?12, media_duration = ?13,
             poster_key = ?14, updated_at = ?15, revision = revision + 1
           WHERE id = ?1 AND author_id = ?2 AND post_id IS NULL AND (?16 IS NULL OR revision = ?16)
             AND ${fileHolds(9, "media", "media_key")} AND ${fileHolds(14, "post", "poster_key")}
             AND ${bytesAfterSql(1, 2, 9, 14)} <= ${DRAFT_BYTES} AND ${LIVE_AUTHOR}`,
        )
        .bind(...values)
    : db
        .prepare(
          `INSERT INTO drafts (id, author_id, kind, url, origin, title, description, replies,
             media_key, media_type, media_width, media_height, media_duration, poster_key, created_at, updated_at)
           SELECT ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?15
           WHERE (SELECT COUNT(*) FROM drafts WHERE author_id = ?2 AND post_id IS NULL) < ${DRAFT_LIMIT}
             AND ${fileHolds(9, "media", "media_key")} AND ${fileHolds(14, "post", "poster_key")}
             AND ${bytesAfterSql(1, 2, 9, 14)} <= ${DRAFT_BYTES} AND ${LIVE_AUTHOR}`,
        )
        // A new draft has no revision to match.
        .bind(...values.slice(0, 15));
  const [written, , freed] = await db.batch([
    write,
    // Files it now uses are kept with it, out of reach of the pending sweep.
    db
      .prepare(
        `UPDATE images SET state = 'draft'
         WHERE key IN (?1, ?2) AND owner_id = ?3 AND state = 'pending'
           AND EXISTS (SELECT 1 FROM drafts WHERE id = ?4 AND post_id IS NULL AND (media_key = images.key OR poster_key = images.key))`,
      )
      .bind(fields.mediaKey ?? "", fields.posterKey ?? "", input.authorId, id),
    unusedDraftFiles(db, input.authorId),
  ]);
  const keys = ((freed!.results ?? []) as Array<{ key: string }>).map((row) => row.key);
  if (written!.meta.changes === 0) {
    const live = await db.prepare(`SELECT ${LIVE_AUTHOR} AS live`).bind(null, input.authorId).first<{ live: number }>();
    if (!live?.live) return { ok: false, reason: "not_found" };
    if (((await sizeAfter())?.bytes ?? 0) > DRAFT_BYTES) return { ok: false, reason: "too_large" };
    if (!current) {
      const count = await db
        .prepare(`SELECT COUNT(*) AS n FROM drafts WHERE author_id = ?1 AND post_id IS NULL`)
        .bind(input.authorId)
        .first<{ n: number }>();
      return { ok: false, reason: (count?.n ?? 0) >= DRAFT_LIMIT ? "too_many" : "file" };
    }
    const now = await draftById(db, id);
    if (!now) return { ok: false, reason: "not_found" };
    if (now.postId) return { ok: false, reason: "published" };
    if (input.revision !== undefined && input.revision !== null && now.revision !== input.revision) {
      return { ok: false, reason: "conflict", revision: now.revision };
    }
    return { ok: false, reason: "file" };
  }
  const saved = await draftById(db, id);
  return saved ? { ok: true, draft: saved, freed: keys } : { ok: false, reason: "not_found" };
}

/**
 * The author bound as `?{author}` is live, and so is the owner of an agent:
 * a save that began before its account's deletion writes nothing after it
 * (review F79). Banned accounts and those at the floor still keep drafts.
 */
const LIVE_AUTHOR = `EXISTS (SELECT 1 FROM profiles AS writer LEFT JOIN profiles AS writer_owner ON writer_owner.user_id = writer.owner_id
  WHERE writer.user_id = ?2 AND writer.deleted_at IS NULL AND (writer.owner_id IS NULL OR writer_owner.deleted_at IS NULL))`;

/**
 * SQL for the bytes of the author's draft files once the draft `?{id}`
 * holds the files `?{media}` and `?{poster}`: those, and every file the
 * author's other unpublished drafts hold. A file this save replaces is
 * left out, as it is deleted with the save (review F83).
 */
function bytesAfterSql(id: number, author: number, media: number, poster: number): string {
  return `(SELECT COALESCE(SUM(file.bytes), 0) FROM images AS file WHERE file.owner_id = ?${author}
    AND (file.key IN (?${media}, ?${poster})
      OR (file.state = 'draft' AND EXISTS (SELECT 1 FROM drafts AS other
        WHERE other.author_id = ?${author} AND other.post_id IS NULL AND other.id <> ?${id}
          AND (other.media_key = file.key OR other.poster_key = file.key)))))`;
}

/**
 * Deletes an account's draft files no unpublished draft uses any more,
 * returning their keys for the bucket.
 */
function unusedDraftFiles(db: D1Database, ownerId: string): D1PreparedStatement {
  return db
    .prepare(
      `DELETE FROM images WHERE owner_id = ?1 AND state = 'draft'
         AND NOT EXISTS (SELECT 1 FROM drafts WHERE author_id = ?1 AND post_id IS NULL
                           AND (media_key = images.key OR poster_key = images.key))
       RETURNING key`,
    )
    .bind(ownerId);
}

/** Deletes the author's own unpublished draft, and its files: their keys come back for the bucket. */
export async function deleteDraft(db: D1Database, input: { id: string; authorId: string }): Promise<{ ok: boolean; freed: string[] }> {
  const [deleted, freed] = await db.batch([
    db.prepare(`DELETE FROM drafts WHERE id = ?1 AND author_id = ?2 AND post_id IS NULL`).bind(input.id, input.authorId),
    unusedDraftFiles(db, input.authorId),
  ]);
  return { ok: deleted!.meta.changes > 0, freed: ((freed!.results ?? []) as Array<{ key: string }>).map((row) => row.key) };
}

export type PublishDraftResult =
  | { ok: true; postId: string; title: string; already: boolean }
  | { ok: false; reason: "not_found" | "not_allowed" }
  | { ok: false; reason: "conflict"; revision: number }
  | { ok: false; reason: "invalid"; fields: Record<string, string> }
  | { ok: false; reason: "invalid_url"; message: string }
  | { ok: false; reason: "duplicate"; existing: Existing }
  | { ok: false; reason: "posting"; status: Exclude<PostingStatus, { allowed: true }> };

/** A draft's choice of who may comment, as a post stores it. */
function repliesOf(choice: PostChoice | null): { replies: PostReplies; closed: boolean } {
  if (choice === "closed") return { replies: "all", closed: true };
  return { replies: choice ?? "all", closed: false };
}

/**
 * Publishes a draft as its author's post: by the author, or by the owner of
 * the agent that wrote it, who authorizes it so; either way the post is the
 * author's, under its plan, standing, and allowance. `as` names which the
 * caller acts as, and a draft the actor is not that to is not found: the
 * site's Drafts page publishes an agent's draft for its owner, never a
 * member's own, which goes through Submit and its human check. The publisher names
 * the revision they saw, unless the author publishes their own latest. A
 * link is checked and fetched again, as a new post's is. The draft is used
 * up in the same write as the post; asking again finds that post, and any
 * refusal leaves the draft as it was.
 */
export async function publishDraft(
  db: D1Database,
  input: {
    id: string;
    actorId: string;
    /** The actor's relation to the draft: its author, or its agent's owner. */
    as: "author" | "owner";
    revision: number | null;
    bucket: R2Bucket;
    secret: string;
    /** This site's hosts: links to them cannot be posted, and profile links among them become mentions. */
    ownHosts: string[];
    mentionHosts: string[];
    now: number;
  },
): Promise<PublishDraftResult> {
  const found = await draftFor(db, input.id, input.actorId);
  if (!found || found.as !== input.as) return { ok: false, reason: "not_found" };
  const { draft } = found;
  if (draft.postId) return { ok: true, postId: draft.postId, title: draft.title, already: true };
  // An owner publishes only the version they reviewed.
  if (found.as === "owner" && input.revision === null) return { ok: false, reason: "conflict", revision: draft.revision };
  if (input.revision !== null && draft.revision !== input.revision) return { ok: false, reason: "conflict", revision: draft.revision };

  const author = await accountRecord(db, draft.authorId, input.now);
  if (!author || author.deleted) return { ok: false, reason: "not_found" };
  const title = cleanTitle(draft.title);
  const description = cleanDescription(draft.description);
  const problems: Record<string, string> = {};
  const titleError = titleProblem(title);
  const descriptionError = descriptionProblem(description, draft.kind === "text" ? TEXT_BODY_MAX : DESCRIPTION_MAX);
  if (titleError) problems.title = titleError;
  if (descriptionError) problems.description = descriptionError;
  if (draft.kind === "link" && !draft.url) problems.url = "Add the link first.";
  if (draft.kind === "upload" && !draft.media) problems.upload = "Add the file first.";
  if (draft.kind !== "text" && !draft.origin) problems.origin = 'Choose "made" or "found".';
  if (Object.keys(problems).length > 0) return { ok: false, reason: "invalid", fields: problems };
  const origin: Origin = draft.kind === "text" ? "made" : draft.origin!;

  const status = await postingStatus(db, author, input.now);
  const base = {
    author,
    origin,
    title,
    description: await linkMentions(db, description, input.mentionHosts),
    // Choosing who may comment is the plan's; without it, everyone may.
    ...repliesOf(author.entitled ? draft.replies : null),
    draft: { id: draft.id, revision: draft.revision },
    now: input.now,
  };

  let post: () => NewPost;
  if (draft.kind === "link") {
    const checked = await checkLink({
      raw: draft.url ?? "",
      userId: author.id,
      origin,
      fetchPreview: status.allowed,
      ownHosts: input.ownHosts,
      db,
      bucket: input.bucket,
      secret: input.secret,
      now: input.now,
    });
    if (!checked.ok) return { ok: false, reason: "invalid_url", message: checked.error };
    if (checked.duplicate) return { ok: false, reason: "duplicate", existing: checked.duplicate };
    if (!status.allowed) return { ok: false, reason: "posting", status };
    const receipt = await readReceipt(checked.receipt ?? "", input.secret, author.id, input.now);
    if (!receipt) return { ok: false, reason: "invalid_url", message: "The link could not be prepared. Try again." };
    post = () => ({
      ...base,
      kind: "link",
      id: newPostId(),
      url: receipt.url,
      canonicalKey: receipt.canonicalKey,
      provider: receipt.provider,
      aspect: receipt.aspect,
      pageTitle: receipt.pageTitle,
      thumbKey: receipt.thumbKey,
    });
  } else {
    if (!status.allowed) return { ok: false, reason: "posting", status };
    const media = draft.media;
    post = () =>
      media
        ? {
            ...base,
            kind: "upload",
            id: newPostId(),
            mediaKey: media.key,
            mediaType: media.type,
            width: media.width,
            height: media.height,
            duration: media.duration,
            posterKey: draft.posterKey,
          }
        : { ...base, kind: "text", id: newPostId() };
  }

  let result = await publishPost(db, post());
  for (let attempt = 0; attempt < 3 && !result.ok && result.reason === "id_taken"; attempt += 1) result = await publishPost(db, post());
  if (result.ok) return { ok: true, postId: result.id, title, already: false };
  if (result.reason === "duplicate") return { ok: false, reason: "duplicate", existing: result.existing };
  // Changed or published by another hand meanwhile: say which.
  const now = await draftById(db, draft.id);
  if (now?.postId) return { ok: true, postId: now.postId, title: now.title, already: true };
  if (now && now.revision !== draft.revision) return { ok: false, reason: "conflict", revision: now.revision };
  return { ok: false, reason: "not_allowed" };
}

/** What an owner did to their agent's work, and why, as the agent and owner read it. */
export interface Feedback {
  id: string;
  action: "declined" | "removed";
  target: { type: "draft" | "post" | "comment"; id: string; revision: number | null; postId: string | null };
  explanation: string | null;
  /** The text exactly as it stood. */
  title: string | null;
  body: string;
  link: string | null;
  createdAt: number;
}

interface FeedbackRow {
  id: string;
  action: "declined" | "removed";
  target_type: "draft" | "post" | "comment";
  target_id: string;
  revision: number | null;
  explanation: string | null;
  title: string | null;
  body: string;
  link: string | null;
  post_id: string | null;
  created_at: number;
}

const toFeedback = (row: FeedbackRow): Feedback => ({
  id: row.id,
  action: row.action,
  target: { type: row.target_type, id: row.target_id, revision: row.revision, postId: row.post_id },
  explanation: row.explanation,
  title: row.title,
  body: row.body,
  link: row.link,
  createdAt: row.created_at,
});

export const FEEDBACK_PAGE = 20;

/** A place in the feedback, newest first: before this time and ID. */
export function feedbackCursor(item: Feedback): string {
  return `${item.createdAt}:${item.id}`;
}

function parseFeedbackCursor(value: string | null): { at: number; id: string } | null {
  const match = /^(\d{1,12}):([A-Za-z0-9_-]{1,40})$/.exec(value ?? "");
  return match ? { at: Number(match[1]), id: match[2]! } : null;
}

/** A page of the feedback an agent's owner left, newest first; `since` keeps only what came after. */
export async function feedbackOf(
  db: D1Database,
  agentId: string,
  options: { before?: string | null; since?: number; limit?: number } = {},
): Promise<Feedback[]> {
  const before = parseFeedbackCursor(options.before ?? null);
  const { results } = await db
    .prepare(
      `SELECT * FROM agent_feedback
       WHERE agent_id = ?1 AND created_at >= ?2
         AND (?3 IS NULL OR created_at < ?3 OR (created_at = ?3 AND id < ?4))
       ORDER BY created_at DESC, id DESC LIMIT ?5`,
    )
    .bind(agentId, options.since ?? 0, before?.at ?? null, before?.id ?? "", options.limit ?? FEEDBACK_PAGE)
    .all<FeedbackRow>();
  return results.map(toFeedback);
}

/**
 * Declines an agent's draft as its owner, at the revision they read: a
 * note for the agent, kept with the text as it stood. The draft stays as it
 * was, to edit or publish as before; declining is never a gate.
 */
export async function declineDraft(
  db: D1Database,
  input: { id: string; ownerId: string; revision: number; explanation: string | null; now: number },
): Promise<{ ok: true } | { ok: false; reason: "not_found" } | { ok: false; reason: "conflict"; revision: number }> {
  const feedbackId = newId();
  const [noted] = await db.batch([
    db
      .prepare(
        `INSERT INTO agent_feedback (id, agent_id, action, target_type, target_id, revision, explanation, title, body, link, created_at)
         SELECT ?1, draft.author_id, 'declined', 'draft', draft.id, draft.revision, ?5, draft.title, draft.description, draft.url, ?6
         FROM drafts AS draft JOIN profiles AS author ON author.user_id = draft.author_id
         WHERE draft.id = ?2 AND author.owner_id = ?3 AND draft.post_id IS NULL AND draft.revision = ?4`,
      )
      .bind(feedbackId, input.id, input.ownerId, input.revision, input.explanation, input.now),
    db
      .prepare(`UPDATE drafts SET declined_at = ?2 WHERE id = ?1 AND EXISTS (SELECT 1 FROM agent_feedback WHERE id = ?3)`)
      .bind(input.id, input.now, feedbackId),
  ]);
  if (noted!.meta.changes > 0) return { ok: true };
  return refusedReview(db, input.id, input.ownerId);
}

async function refusedReview(db: D1Database, id: string, ownerId: string): Promise<{ ok: false; reason: "not_found" } | { ok: false; reason: "conflict"; revision: number }> {
  const found = await draftFor(db, id, ownerId);
  if (!found || found.as !== "owner" || found.draft.postId) return { ok: false, reason: "not_found" };
  return { ok: false, reason: "conflict", revision: found.draft.revision };
}

/**
 * Removes an agent's draft as its owner, at the revision they read, with
 * the text kept as feedback in the same write. Its files go too: their
 * keys come back for the bucket.
 */
export async function removeAgentDraft(
  db: D1Database,
  input: { id: string; ownerId: string; revision: number; explanation: string | null; now: number },
): Promise<{ ok: true; freed: string[] } | { ok: false; reason: "not_found" } | { ok: false; reason: "conflict"; revision: number }> {
  const feedbackId = newId();
  const agentId = await agentIdOf(db, input.ownerId);
  if (!agentId) return { ok: false, reason: "not_found" };
  const [noted, , freed] = await db.batch([
    db
      .prepare(
        `INSERT INTO agent_feedback (id, agent_id, action, target_type, target_id, revision, explanation, title, body, link, created_at)
         SELECT ?1, draft.author_id, 'removed', 'draft', draft.id, draft.revision, ?5, draft.title, draft.description, draft.url, ?6
         FROM drafts AS draft
         WHERE draft.id = ?2 AND draft.author_id = ?3 AND draft.post_id IS NULL AND draft.revision = ?4`,
      )
      .bind(feedbackId, input.id, agentId, input.revision, input.explanation, input.now),
    db.prepare(`DELETE FROM drafts WHERE id = ?1 AND EXISTS (SELECT 1 FROM agent_feedback WHERE id = ?2)`).bind(input.id, feedbackId),
    unusedDraftFiles(db, agentId),
  ]);
  const keys = ((freed!.results ?? []) as Array<{ key: string }>).map((row) => row.key);
  if (noted!.meta.changes > 0) return { ok: true, freed: keys };
  return refusedReview(db, input.id, input.ownerId);
}

/**
 * Removes a post or comment the owner's agent wrote, as an owner: deleted as
 * its author would delete it, keeping its place and its replies, with the
 * text kept as feedback for the agent in the same write. It needs neither
 * the plan nor good standing; an owner can always take their agent's work
 * down. A moderator's removal is a different thing, and stays theirs.
 */
export async function removeAgentWork(
  db: D1Database,
  input: { type: "post" | "comment"; id: string; ownerId: string; explanation: string | null; now: number },
): Promise<boolean> {
  const feedbackId = newId();
  const isAgent = (column: string) => `${column} IN (SELECT user_id FROM profiles WHERE owner_id = ?3)`;
  const statements =
    input.type === "post"
      ? [
          db
            .prepare(
              `INSERT INTO agent_feedback (id, agent_id, action, target_type, target_id, explanation, title, body, link, created_at)
               SELECT ?1, author_id, 'removed', 'post', id, ?4, title, description, url, ?5 FROM posts
               WHERE id = ?2 AND ${isAgent("author_id")} AND deleted_at IS NULL AND removed_batch_id IS NULL`,
            )
            .bind(feedbackId, input.id, input.ownerId, input.explanation, input.now),
          db
            .prepare(
              `UPDATE posts SET deleted_at = ?2, title = '', description = ''
               WHERE id = ?1 AND deleted_at IS NULL AND removed_batch_id IS NULL AND EXISTS (SELECT 1 FROM agent_feedback WHERE id = ?3)`,
            )
            .bind(input.id, input.now, feedbackId),
        ]
      : [
          db
            .prepare(
              `INSERT INTO agent_feedback (id, agent_id, action, target_type, target_id, explanation, body, post_id, created_at)
               SELECT ?1, author_id, 'removed', 'comment', id, ?4, body, post_id, ?5 FROM comments
               WHERE id = ?2 AND ${isAgent("author_id")} AND deleted_at IS NULL AND removed_batch_id IS NULL`,
            )
            .bind(feedbackId, input.id, input.ownerId, input.explanation, input.now),
          db
            .prepare(
              `UPDATE comments SET deleted_at = ?2, body = ''
               WHERE id = ?1 AND deleted_at IS NULL AND removed_batch_id IS NULL AND EXISTS (SELECT 1 FROM agent_feedback WHERE id = ?3)`,
            )
            .bind(input.id, input.now, feedbackId),
        ];
  const [, removed] = await db.batch(statements);
  return removed!.meta.changes > 0;
}

/** Forgets drafts published long enough ago that nobody will ask to publish them again. */
export async function sweepPublishedDrafts(db: D1Database, now: number): Promise<void> {
  await db.prepare(`DELETE FROM drafts WHERE post_id IS NOT NULL AND published_at < ?1`).bind(now - PUBLISHED_KEEP_SECONDS).run();
}
