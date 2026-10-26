import { GALLERY_MAX, readGallery } from "~/lib/gallery";
import { env, waitUntil } from "cloudflare:workers";
import { useEffect, useRef, useState } from "react";
import { Form, Link, redirect, useNavigation } from "react-router";

import { PlanPaywall } from "~/components/plan-paywall";
import { RepliesField } from "~/components/replies-field";
import { PostMediaView } from "~/components/post-media";
import { ScheduledTime } from "~/components/scheduled-time";
import { Turnstile } from "~/components/turnstile";
import { Button } from "~/components/ui/button";
import { TextArea, TextField } from "~/components/ui/field";
import { Segmented } from "~/components/ui/segmented";
import { Select } from "~/components/ui/select";
import { Notice } from "~/components/ui/states";
import { type Uploaded, UploadPicker } from "~/components/upload-picker";
import { agentOf } from "~/lib/db/agents.server";
import {
  draftById,
  draftFor,
  previewDraft,
  type Draft,
  previewToPublish,
  saveDraft as saveServerDraft,
  type SaveResult,
  scheduleDraft,
  scheduleTaken,
  wantsPreview,
} from "~/lib/db/drafts.server";
import type { DraftFields } from "~/lib/draft-rules";
import { deleteReleasedFiles } from "~/lib/db/draft-files.server";
import { DRAFT_BYTES } from "~/lib/draft-rules";
import { loadSettings } from "~/lib/db/settings.server";
import { linkMentions, mentionHosts } from "~/lib/db/mentions.server";
import {
  type Existing,
  type NewPost,
  postingStatus,
  type PostingStatus,
  publishPost,
} from "~/lib/db/submit.server";
import { clearDraft, readDraft, saveDraft } from "~/lib/drafts";
import { formatWait } from "~/lib/format";
import { imageAddress } from "~/lib/media.server";
import { newPostId } from "~/lib/ids";
import type { Aspect, Provider } from "~/lib/links/types";
import type { PostCardData } from "~/lib/public-types";
import { verifyTurnstile } from "~/lib/security/turnstile.server";
import { RATE_LIMITED_MESSAGE, withinLimits } from "~/lib/security/rate-limit.server";
import { ROW_ID } from "~/lib/security/body";
import { postPath, profilePath } from "~/lib/slug";
import { type CheckedLink, type CheckResult, checkLink } from "~/lib/submit/check.server";
import { textPreview } from "~/lib/submit/text-preview.server";
import { readReceipt } from "~/lib/submit/receipt.server";
import {
  cleanDescription,
  cleanTitle,
  DESCRIPTION_MAX,
  descriptionProblem,
  length,
  type Origin,
  parseKind,
  parseOrigin,
  type PostKind,
  TEXT_BODY_MAX,
  TITLE_MAX,
  titleProblem,
} from "~/lib/submit/rules";
import { requireAccount, requireParticipant } from "~/lib/viewer.server";
import { privatePageMeta } from "~/lib/meta";
import { parsePostChoice, POST_CHOICES, type PostChoice } from "~/lib/replies";
import { firstSlot, fromLocalParts, localParts, QUARTER_HOURS, SCHEDULE_DAYS, scheduleProblem } from "~/lib/schedule";

import type { Route } from "./+types/submit";

// What is typed is kept in this browser as it is typed, apart for each saved draft.
const DRAFT = "submit";
const draftKey = (saved: { id: string } | null) => (saved ? `${DRAFT}-${saved.id}` : DRAFT);
// The last check, kept for this tab so a reload shows the preview again.
const CHECK_STORAGE = "submit-check";

export function meta({ matches, location }: Route.MetaArgs) {
  return privatePageMeta(matches, "Submit", location.pathname);
}

/** A saved draft, as the form picks it up again. */
interface SavedDraft {
  id: string;
  revision: number;
  kind: PostKind;
  url: string;
  origin: Origin | "";
  title: string;
  description: string;
  replies: PostChoice;
  /** Its files: one, or a gallery's pictures in order. */
  uploads: Array<Omit<Uploaded, "preview"> & { url: string }>;
  /** When it goes out on its own, if it is scheduled. */
  scheduledAt: number | null;
  /** A text draft's choice to show its card's preview. */
  showPreview: boolean;
}

export async function loader({ request, context }: Route.LoaderArgs) {
  const viewer = await requireAccount(request, context);
  const now = Math.floor(Date.now() / 1000);
  // A saved draft of the viewer's own, picked up again from Drafts.
  const asked = new URL(request.url).searchParams.get("draft");
  // Read at once: the draft, the posting allowance, and the agent's name.
  const [found, status, agent] = await Promise.all([
    asked && ROW_ID.test(asked) ? draftFor(env.DB, asked, viewer.id) : null,
    postingStatus(env.DB, viewer, now),
    viewer.entitled ? agentOf(env.DB, viewer.id) : null,
  ]);
  const draft = found && found.as === "author" && !found.draft.postId ? found.draft : null;
  const saved: SavedDraft | null = draft
    ? {
        id: draft.id,
        revision: draft.revision,
        kind: draft.kind,
        url: draft.url ?? "",
        origin: draft.origin ?? "",
        title: draft.title,
        description: draft.description,
        replies: draft.replies ?? "all",
        showPreview: draft.showPreview,
        uploads: draft.pictures
          ? draft.pictures.map((picture) => ({
              key: picture.key,
              media: "image" as const,
              url: imageAddress(picture.key),
              width: picture.width,
              height: picture.height,
              duration: null,
              posterKey: null,
            }))
          : draft.media
            ? [
                {
                  key: draft.media.key,
                  media: draft.media.type,
                  url: imageAddress(draft.media.key),
                  width: draft.media.width,
                  height: draft.media.height,
                  duration: draft.media.duration,
                  posterKey: draft.posterKey,
                },
              ]
            : [],
        scheduledAt: draft.scheduledAt,
      }
    : null;
  // A link draft's stored preview, checked as it was seen, without reading
  // the page again: it publishes as previewed (review F108).
  const stored = draft ? previewToPublish(draft) : null;
  const checked = stored
    ? await checkLink({
        raw: stored.raw,
        reuse: stored.reuse,
        userId: viewer.id,
        ownHosts: [new URL(request.url).hostname],
        db: env.DB,
        bucket: env.IMAGES,
        secret: env.BETTER_AUTH_SECRET,
        now,
      })
    : null;
  return {
    draft: saved,
    draftCheck: draft?.url && checked?.ok ? ({ input: draft.url, link: checked.link, receipt: checked.receipt, duplicate: checked.duplicate } satisfies Checked) : null,
    // Just saved, from this form.
    saved: new URL(request.url).searchParams.has("saved"),
    // Saved to be scheduled, though the time could not be kept.
    unscheduled: new URL(request.url).searchParams.has("unscheduled"),
    status,
    siteKey: env.TURNSTILE_SITE_KEY,
    now,
    // Text posts and uploads come with the plan.
    entitled: viewer.entitled,
    // Who may comment, as the member chose for new posts in Settings.
    postReplies: viewer.entitled ? viewer.postReplies : ("all" as const),
    // Where an agent that ticked the box is pointed, for a fan.
    agentName: agent?.username ?? null,
  };
}

type FieldErrors = Partial<Record<"url" | "upload" | "title" | "description" | "origin" | "attest" | "turnstile" | "schedule", string>>;

interface ActionResult {
  errors: FieldErrors;
  /** A problem with the submission as a whole. */
  message?: string;
  duplicate?: Existing;
  /** The agent box was ticked: nothing was posted, and the paywall shows. */
  agentPaywall?: boolean;
  /** The link's check went stale, its picture replaced: it is to be checked again (review F110). */
  recheck?: boolean;
}

/** An upload's key, as the upload endpoint makes them. */
const UPLOAD_KEY = /^[0-9A-Za-z]{24}\.[a-z0-9]{3,4}$/;

/** Why a draft was not saved, in words, with the drafts an account keeps in force. */
function saveRefusal(result: Exclude<SaveResult, { ok: true }>, limit: number): ActionResult {
  switch (result.reason) {
    case "invalid":
      return { errors: result.fields as FieldErrors };
    case "too_many":
      return { errors: {}, message: `You keep at most ${limit} drafts. Publish or delete one first.` };
    case "too_large":
      return { errors: {}, message: `Your drafts' files hold at most ${DRAFT_BYTES / 1024 / 1024} MB together. Delete a draft with a file first.` };
    case "file":
      return { errors: { upload: "That upload has expired. Upload the file again." } };
    case "conflict":
      return { errors: {}, message: "This draft changed in another window. Open it again from Drafts." };
    case "not_found":
    case "published":
      return { errors: {}, message: "This draft is gone: published or deleted. Nothing was saved." };
  }
}

/** A whole number from the form within bounds, or null. */
function boundedInt(value: string, max: number): number | null {
  const number = Number(value);
  return value !== "" && Number.isInteger(number) && number > 0 && number <= max ? number : null;
}

function statusMessage(status: PostingStatus, now: number): string | null {
  if (status.allowed) return null;
  switch (status.reason) {
    case "banned":
      return "Your account is read-only while the ban lasts.";
    case "read_only":
      return "Your account is read-only while your karma is at or below its floor.";
    case "karma":
      return "Posting is paused while your karma is below 0. Comments and votes still count.";
    case "wait": {
      const times = (count: number) => (count === 1 ? "once" : count === 2 ? "twice" : `${count} times`);
      // What the account may post now first, so the next tier never reads as its limit.
      const allowance = status.perDay > 0 ? `You can post ${times(status.perDay)} a day${status.next ? " at your karma" : ""}. ` : "";
      const wait = `${allowance}Next post available in ${formatWait(status.nextAt - now)}. Your draft is saved.`;
      return status.next
        ? `${wait} From ${status.next.karma} karma, ${times(status.next.postsPerDay)} a day.`
        : wait;
    }
  }
}

/** What the form holds, as a draft keeps it. */
function draftFieldsOf(form: FormData): DraftFields {
  const field = (name: string) => String(form.get(name) ?? "");
  return {
    kind: parseKind(field("kind")),
    url: field("url") || null,
    origin: parseOrigin(field("origin")),
    title: field("title"),
    description: field("description"),
    replies: parsePostChoice(field("replies")),
    mediaKey: UPLOAD_KEY.test(field("upload_key")) ? field("upload_key") : null,
    width: boundedInt(field("width"), 20000),
    height: boundedInt(field("height"), 20000),
    duration: boundedInt(field("duration"), 24 * 3600),
    posterKey: UPLOAD_KEY.test(field("poster_key")) ? field("poster_key") : null,
    pictures: readGallery(field("pictures")),
    showPreview: previewChosen(form),
  };
}

/**
 * A text post's choice to show its card's preview: its box as the form
 * sent it, or shown, from a form that did not offer one.
 */
function previewChosen(form: FormData): boolean {
  return form.get("preview_offered") !== "yes" || form.get("preview") === "yes";
}

/**
 * Saves what the form holds as a draft, a new one or the one it was opened
 * from, at the revision it was opened at; its files' unused ones go, and a
 * new link's preview is made meanwhile, for the Drafts page to show.
 */
async function saveFromForm(request: Request, authorId: string, form: FormData): Promise<SaveResult> {
  const field = (name: string) => String(form.get(name) ?? "");
  const id = ROW_ID.test(field("draft_id")) ? field("draft_id") : undefined;
  const revision = boundedInt(field("draft_revision"), 1_000_000);
  const result = await saveServerDraft(env.DB, {
    authorId,
    ...(id ? { id, revision } : {}),
    fields: draftFieldsOf(form),
    now: Math.floor(Date.now() / 1000),
  });
  if (!result.ok) return result;
  await deleteReleasedFiles(env.DB, env.IMAGES, result.freed);
  if (wantsPreview(result.draft)) previewSoon(request, result.draft);
  return result;
}

function previewSoon(request: Request, draft: Draft): void {
  const work = previewDraft(env.DB, {
    draft,
    bucket: env.IMAGES,
    ownHosts: [new URL(request.url).hostname],
    secret: env.BETTER_AUTH_SECRET,
    now: Math.floor(Date.now() / 1000),
  });
  waitUntil(work.catch((error) => console.error("draft preview", error)));
}

/**
 * Saves what the form holds as a draft, whatever the account's plan or
 * standing; a scheduled one stays scheduled, with what was saved.
 */
async function saveAction(request: Request, context: Route.ActionArgs["context"], form: FormData): Promise<ActionResult | Response> {
  const viewer = await requireAccount(request, context);
  if (!(await withinLimits(request, "write", viewer.id))) return { errors: {}, message: RATE_LIMITED_MESSAGE };
  const result = await saveFromForm(request, viewer.id, form);
  if (!result.ok) return saveRefusal(result, (await loadSettings(env.DB)).drafts_per_account);
  throw redirect(`/submit?draft=${result.draft.id}&saved`);
}

/**
 * Schedules what the form holds, checked as publishing checks it, the
 * human check included (owner's request, 2026-10-22): saved as a draft and
 * set to go out at its time, as it is then. The day's allowance is checked
 * when it goes out. Saved but not scheduled, as when another draft took the
 * time meanwhile, it opens again as a draft, saying so.
 */
async function scheduleAction(request: Request, authorId: string, form: FormData, at: number, now: number): Promise<ActionResult | Response> {
  const draftId = String(form.get("draft_id") ?? "");
  if (await scheduleTaken(env.DB, { authorId, at, exceptId: ROW_ID.test(draftId) ? draftId : null })) {
    return { errors: { schedule: "Another of your drafts is scheduled for that time. Choose another." } };
  }
  const saved = await saveFromForm(request, authorId, form);
  if (!saved.ok) return saveRefusal(saved, (await loadSettings(env.DB)).drafts_per_account);
  const scheduled = await scheduleDraft(env.DB, { id: saved.draft.id, authorId, at, tokenId: null, revision: saved.draft.revision, now });
  if (!scheduled.ok) throw redirect(`/submit?draft=${saved.draft.id}&saved&unscheduled`);
  throw redirect("/drafts");
}

export async function action({ request, context }: Route.ActionArgs): Promise<ActionResult | Response> {
  const form = await request.formData();
  if (form.get("intent") === "save-draft") return saveAction(request, context, form);
  const viewer = await requireParticipant(request, context);
  if (!(await withinLimits(request, "write", viewer.id))) return { errors: {}, message: RATE_LIMITED_MESSAGE };
  const now = Math.floor(Date.now() / 1000);
  const field = (name: string) => String(form.get(name) ?? "");
  // Publishing later: the time the browser worked out from the viewer's own time zone.
  const scheduling = form.get("intent") === "schedule";
  const at = scheduling && /^\d{1,12}$/.test(field("scheduled_at")) ? Number(field("scheduled_at")) : null;
  // Opened from a saved draft: publishing uses it up, at the revision opened.
  const draftId = ROW_ID.test(field("draft_id")) ? field("draft_id") : null;
  const draftRevision = boundedInt(field("draft_revision"), 1_000_000);
  const fromDraft = draftId && draftRevision ? { draft: { id: draftId, revision: draftRevision } } : {};
  // An agent acting in its owner's browser says so: nothing is published,
  // nobody is penalized, and the page shows how agents post instead.
  if (field("agent") === "yes") return { errors: {}, agentPaywall: true };

  const kind = parseKind(field("kind"));
  if (kind !== "link" && !viewer.entitled) {
    return { errors: {}, message: "Text posts and uploads come with the Fan plan." };
  }

  const errors: FieldErrors = {};
  const receipt = kind === "link" ? await readReceipt(field("receipt"), env.BETTER_AUTH_SECRET, viewer.id, now) : null;
  if (kind === "link" && !receipt) errors.url = "Check the link before publishing.";
  // A gallery's pictures, the first of them the file; else one file.
  const gallery = kind === "upload" && field("pictures") ? readGallery(field("pictures")) : null;
  if (kind === "upload" && field("pictures") && !gallery) errors.upload = `A gallery holds 2 to ${GALLERY_MAX} pictures.`;
  const uploadKey = gallery ? gallery[0]!.key : field("upload_key");
  const mediaType = gallery ? "image" : field("media_type");
  if (kind === "upload" && (!UPLOAD_KEY.test(uploadKey) || !["image", "video", "audio"].includes(mediaType))) {
    errors.upload = "Upload a file before publishing.";
  }
  const title = cleanTitle(field("title"));
  const description = cleanDescription(field("description"));
  // A text post is its author's own writing; made or found describes a link or a file.
  const origin = kind === "text" ? "made" : parseOrigin(field("origin"));
  const titleError = titleProblem(title);
  const descriptionError = descriptionProblem(description, kind === "text" ? TEXT_BODY_MAX : DESCRIPTION_MAX);
  if (titleError) errors.title = titleError;
  if (descriptionError) errors.description = descriptionError;
  if (!origin) errors.origin = "Say whether you made it or found it.";
  if (field("attest") !== "yes") errors.attest = "Confirm the post fits the board.";
  const scheduleError = scheduling ? scheduleProblem(at, now) : null;
  if (scheduleError) errors.schedule = scheduleError;
  if (Object.keys(errors).length > 0 || !origin) return { errors };

  const url = new URL(request.url);
  const human = await verifyTurnstile({
    secret: env.TURNSTILE_SECRET_KEY,
    token: field("cf-turnstile-response"),
    remoteIp: request.headers.get("CF-Connecting-IP"),
    hostname: url.hostname,
    action: "submit",
  });
  if (!human) {
    return { errors: { turnstile: "The check did not pass. Wait for it to finish, then publish again." } };
  }
  if (scheduling) return scheduleAction(request, viewer.id, form, at!, now);

  const status = await postingStatus(env.DB, viewer, now);
  const blocked = statusMessage(status, now);
  if (blocked) return { errors: {}, message: blocked };

  const storedDescription = await linkMentions(env.DB, description, mentionHosts(request));
  // Who may comment, or closing comments, is the plan's choice; the write checks the plan again.
  const choice = (viewer.entitled && parsePostChoice(field("replies"))) || "all";
  // A text post's card shows the first of its uploads or links, unless its author chose not to.
  const preview =
    kind === "text"
      ? await textPreview({
          text: storedDescription,
          shown: previewChosen(form),
          userId: viewer.id,
          ownHosts: [new URL(request.url).hostname],
          db: env.DB,
          bucket: env.IMAGES,
          now,
        })
      : undefined;
  const base = {
    author: viewer,
    origin,
    title,
    description: storedDescription,
    replies: choice === "closed" ? ("all" as const) : choice,
    closed: choice === "closed",
    ...fromDraft,
    now,
  };
  const draft = (): NewPost =>
    kind === "link" && receipt
      ? {
          ...base,
          kind: "link",
          id: newPostId(),
          url: receipt.url,
          canonicalKey: receipt.canonicalKey,
          provider: receipt.provider,
          aspect: receipt.aspect,
          pageTitle: receipt.pageTitle,
          thumbKey: receipt.thumbKey,
        }
      : kind === "upload"
        ? {
            ...base,
            kind: "upload",
            id: newPostId(),
            mediaKey: uploadKey,
            mediaType: mediaType as "image" | "video" | "audio",
            width: gallery ? gallery[0]!.width : boundedInt(field("width"), 20000),
            height: gallery ? gallery[0]!.height : boundedInt(field("height"), 20000),
            duration: gallery ? null : boundedInt(field("duration"), 24 * 3600),
            posterKey: !gallery && UPLOAD_KEY.test(field("poster_key")) ? field("poster_key") : null,
            pictures: gallery,
          }
        : { ...base, kind: "text", id: newPostId(), ...(preview ? { preview } : {}) };
  // Short IDs can clash, rarely; a clash is tried again with a new one.
  let result = await publishPost(env.DB, draft());
  for (let attempt = 0; attempt < 3 && !result.ok && result.reason === "id_taken"; attempt += 1) {
    result = await publishPost(env.DB, draft());
  }
  if (result.ok) {
    // Files the saved draft held that the post left out.
    await deleteReleasedFiles(env.DB, env.IMAGES, result.freed);
    throw redirect(postPath({ id: result.id, title }));
  }
  if (result.reason === "id_taken") return { errors: {}, message: "That did not publish. Try again." };
  if (result.reason === "duplicate") return { errors: {}, duplicate: result.existing };
  if (result.reason === "picture_gone") {
    return { errors: { url: "The link's picture was replaced meanwhile, by another check or preview. Check the link again." }, recheck: true };
  }
  if (result.reason === "media") return { errors: { description: result.problem } };
  if (draftId) {
    // The draft was published or changed in another window meanwhile.
    const now = await draftById(env.DB, draftId);
    if (now?.postId) throw redirect(`/p/${now.postId}`);
    if (now && now.authorId === viewer.id && now.revision !== draftRevision) {
      return { errors: {}, message: "This draft changed in another window. Open it again from Drafts." };
    }
  }
  // The allowance changed between the check and the write, or the upload
  // is gone: it was replaced, or sat unpublished for a day.
  const again = statusMessage(await postingStatus(env.DB, viewer, now), now);
  if (!again && kind === "upload") return { errors: { upload: "That upload has expired. Upload the file again." } };
  return { errors: {}, message: again ?? "That did not publish. Try again." };
}

function DuplicateNotice({ duplicate }: { duplicate: NonNullable<ActionResult["duplicate"]> }) {
  return duplicate.state === "live" ? (
    <Notice>
      Already posted.{" "}
      <Link to={`/p/${duplicate.id}`} className="font-medium underline underline-offset-4">
        See the post
      </Link>{" "}
      and add to its discussion instead.
    </Notice>
  ) : (
    <Notice tone="danger">This link was removed by a moderator and can&apos;t be posted again.</Notice>
  );
}

/** The would-be post's media or preview card, exactly as the feed will show it. */
function Preview({ link, title }: { link: CheckedLink; title: string }) {
  const post: PostCardData = {
    id: "preview",
    path: "/submit",
    title: title || "Your title",
    url: link.url,
    host: link.host,
    origin: "found",
    author: { id: "preview", username: "you" },
    createdAt: 0,
    score: 0,
    commentCount: 0,
    excerpt: "",
    media:
      link.provider && link.aspect
        ? { kind: "media", provider: link.provider as Provider, aspect: link.aspect as Aspect, thumbUrl: link.thumbUrl ?? undefined }
        : { kind: "page", pageTitle: link.pageTitle ?? undefined, thumbUrl: link.thumbUrl ?? undefined },
  };
  return (
    <div className="space-y-1.5">
      <p className="text-meta text-text-muted">How it will appear</p>
      <PostMediaView post={post} />
    </div>
  );
}

interface Checked {
  /** The link as typed when it was checked; editing it means checking again. */
  input: string;
  link: CheckedLink;
  receipt: string | null;
  duplicate: Existing | null;
}

/** A web address, as a link's own and a preview's picture must be. */
const WEB = /^https?:\/\//i;

/**
 * A check kept in this tab, read back for the link as typed: only one
 * whose link is a web address and whose picture is one, or the board's
 * own, since what storage holds could have been put there by other means.
 */
function restoredCheck(value: unknown, input: string): Checked | null {
  const saved = value as Checked | null;
  if (!saved || saved.input !== input || typeof saved.link?.url !== "string" || !WEB.test(saved.link.url)) return null;
  const thumb = saved.link.thumbUrl;
  if (thumb !== null && (typeof thumb !== "string" || !(WEB.test(thumb) || /^\/img\/[\w.-]+$/.test(thumb)))) return null;
  return saved;
}

/**
 * What an agent sees after saying it is one: nothing was posted, nobody is
 * penalized, and agents post under their own name. A person who ticked the
 * box by mistake goes back to the form with the draft intact.
 */
function AgentPaywall({ entitled, agentName, onBack }: { entitled: boolean; agentName: string | null; onBack: () => void }) {
  // The box sits at the foot of the form, which this replaces: bring it into view.
  const shown = useRef<HTMLDivElement>(null);
  useEffect(() => {
    shown.current?.scrollIntoView({ block: "start" });
  }, []);
  const back = (
    <button type="button" onClick={onBack} className="text-meta text-text-muted underline underline-offset-4 hover:text-text">
      I misclicked
    </button>
  );
  if (entitled) {
    return (
      <div ref={shown} className="scroll-mt-16 bleed rounded-xl border border-border bg-surface p-4 sm:p-5" data-paywall="agent">
        <h2 className="text-title font-semibold">Agents post under their own name</h2>
        <p className="mt-1 text-body text-text-muted">
          This account belongs to a person, so nothing was posted.{" "}
          {agentName ? (
            <>
              Post as{" "}
              <Link to={profilePath(agentName)} className="font-medium text-text underline underline-offset-4">
                {agentName}
              </Link>{" "}
              instead, through its own tools in your app or the API.
            </>
          ) : (
            "Its owner can connect you as their agent from Claude, Codex, or another app, and you post under your own name."
          )}{" "}
          The steps are at{" "}
          <Link to="/agents" className="underline underline-offset-4">
            /agents
          </Link>
          , and for agents at <a href="/agents.md" className="underline underline-offset-4">/agents.md</a>.
        </p>
        <div className="mt-4 flex flex-col-reverse items-start gap-3 sm:flex-row sm:items-center sm:justify-between">
          {back}
          <Button asChild variant="primary">
            <Link to="/agents">How to connect an agent</Link>
          </Button>
        </div>
      </div>
    );
  }
  return (
    <div ref={shown} className="scroll-mt-16">
      <PlanPaywall feature="agent" title="Agents post under their own name" aside={back}>
        This account belongs to a person, so nothing was posted. With the Fan plan they can connect you as their
        agent: your own name and picture under the Agent badge, posting from their apps or the API.
      </PlanPaywall>
    </div>
  );
}

const KIND_LABEL: Record<PostKind, string> = { link: "Link", text: "Text", upload: "Upload" };

export default function Submit({ loaderData, actionData }: Route.ComponentProps) {
  // A saved draft opens in a form of its own.
  return <Composer key={loaderData.draft ? `${loaderData.draft.id}-${loaderData.draft.revision}` : "new"} loaderData={loaderData} actionData={actionData} />;
}

function Composer({ loaderData, actionData }: Pick<Route.ComponentProps, "loaderData" | "actionData">) {
  const result = actionData as ActionResult | undefined;
  const navigation = useNavigation();
  const { entitled, draft: opened } = loaderData;
  const storage = draftKey(opened);
  const [source, setSource] = useState<PostKind>(opened?.kind ?? "link");
  const [url, setUrl] = useState(opened?.url ?? "");
  const [title, setTitle] = useState(opened?.title ?? "");
  const [description, setDescription] = useState(opened?.description ?? "");
  const [origin, setOrigin] = useState<Origin | "">(opened?.origin ?? "");
  const [replies, setReplies] = useState<PostChoice>(opened?.replies ?? loaderData.postReplies);
  const [showPreview, setShowPreview] = useState(opened?.showPreview ?? true);
  const [attest, setAttest] = useState(false);
  const [agent, setAgent] = useState(false);
  const [token, setToken] = useState("");
  const [checking, setChecking] = useState(false);
  const [checkError, setCheckError] = useState<string | null>(null);
  const [checked, setChecked] = useState<Checked | null>(loaderData.draftCheck);
  // The answer a newer check replaced, whose word about the link no longer stands.
  const [rechecked, setRechecked] = useState<ActionResult | undefined>(undefined);
  const [uploaded, setUploaded] = useState<Uploaded[]>(() => (opened?.uploads ?? []).map((upload) => ({ ...upload, preview: upload.url })));
  const cover = uploaded[0] ?? null;
  // Files still uploading: neither Publish nor Save draft goes without them.
  const [uploading, setUploading] = useState(false);
  const [touched, setTouched] = useState(false);
  const restored = useRef(false);
  // Publishing later, at a quarter hour in the viewer's own time zone: the
  // fields are filled once the page runs, since only the browser knows it.
  const [later, setLater] = useState(opened?.scheduledAt != null);
  const [day, setDay] = useState("");
  const [time, setTime] = useState("");
  const [days, setDays] = useState({ min: "", max: "" });
  useEffect(() => {
    const now = Math.floor(Date.now() / 1000);
    const parts = localParts(opened?.scheduledAt ?? firstSlot(now));
    setDay(parts.date);
    setTime(parts.time);
    setDays({ min: localParts(now).date, max: localParts(now + SCHEDULE_DAYS * 24 * 3600).date });
  }, [opened?.scheduledAt]);
  const scheduledAt = later ? fromLocalParts(day, time) : null;
  // A server answer that the agent box was ticked, before scripts ran.
  const [agentAnswered, setAgentAnswered] = useState(false);
  useEffect(() => setAgentAnswered(Boolean(result?.agentPaywall)), [result]);
  // A stale check is let go, here and in this tab's copy, so Check link works again (review F110).
  useEffect(() => {
    if (!result?.recheck) return;
    setChecked(null);
    sessionStorage.removeItem(CHECK_STORAGE);
  }, [result]);

  const blocked = statusMessage(loaderData.status, loaderData.now);
  const submitting = navigation.state === "submitting" && navigation.formAction?.startsWith("/submit") === true;
  const saving = submitting && navigation.formData?.get("intent") === "save-draft";
  const scheduling = submitting && navigation.formData?.get("intent") === "schedule";

  // Bring back what was typed, and the check that went with it. Just saved,
  // the saved draft is what was typed: the copy in this browser goes.
  useEffect(() => {
    if (loaderData.saved) {
      clearDraft(DRAFT);
      clearDraft(storage);
    }
    const draft = readDraft(storage);
    if (draft) {
      setUrl(draft.url ?? "");
      setTitle(draft.title ?? "");
      setDescription(draft.description ?? "");
      setOrigin(parseOrigin(draft.origin) ?? "");
      setSource(parseKind(draft.kind));
    }
    try {
      const saved = restoredCheck(JSON.parse(sessionStorage.getItem(CHECK_STORAGE) ?? "null"), draft?.url ?? "");
      if (saved) setChecked(saved);
    } catch {
      // A missing or broken stored check only means checking again.
    }
    restored.current = true;
  }, [loaderData.saved, storage]);

  useEffect(() => {
    if (!restored.current) return;
    saveDraft(storage, { url, title, description, origin, kind: source === "link" ? "" : source });
  }, [url, title, description, origin, source, storage]);

  // Leaving for the new post, or for Drafts once scheduled: the copy in this browser is done with.
  useEffect(() => {
    if (
      navigation.state === "loading" &&
      navigation.formAction?.startsWith("/submit") &&
      (navigation.location.pathname.startsWith("/p/") || navigation.location.pathname === "/drafts")
    ) {
      clearDraft(storage);
      sessionStorage.removeItem(CHECK_STORAGE);
    }
  }, [navigation, storage]);

  const check = async () => {
    setChecking(true);
    setCheckError(null);
    try {
      const response = await fetch("/submit/check", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ url }),
      });
      const data = (await response.json()) as CheckResult | { ok: false; error?: string; message?: string };
      if (!data.ok) {
        setChecked(null);
        setCheckError(("error" in data && data.error) || ("message" in data && data.message) || "That link could not be checked.");
        return;
      }
      const next: Checked = { input: url, link: data.link, receipt: data.receipt, duplicate: data.duplicate };
      setChecked(next);
      setRechecked(result);
      sessionStorage.setItem(CHECK_STORAGE, JSON.stringify(next));
      if (!title && data.link.suggestedTitle) setTitle(data.link.suggestedTitle.slice(0, TITLE_MAX));
    } catch {
      setCheckError("That link could not be checked. Try again.");
    } finally {
      setChecking(false);
    }
  };

  const gated = source !== "link" && !entitled;
  const showAgentPaywall = agent || agentAnswered;
  const current = checked && checked.input === url ? checked : null;
  const duplicate = source === "link" ? (result?.duplicate ?? current?.duplicate ?? null) : null;
  const bodyMax = source === "text" ? TEXT_BODY_MAX : DESCRIPTION_MAX;
  const titleError = touched || result ? titleProblem(title) : null;
  const descriptionError = touched || result ? descriptionProblem(description, bodyMax) : null;
  const ready =
    source === "link" ? Boolean(current?.receipt) && !duplicate : source === "upload" ? uploaded.length > 0 && !uploading : true;
  const waiting = source === "upload" && uploading;
  const canPublish = ready && !gated && !blocked && token && !submitting;
  // The day's allowance is checked when a scheduled post goes out, not now.
  const canSchedule = ready && !gated && token && !submitting && scheduledAt !== null;

  return (
    <main className="mx-auto max-w-column space-y-4 px-(--gutter) py-6">
      <div>
        <h1 className="text-display font-semibold">Submit</h1>
        <p className="mt-1 text-body text-text-muted">
          Something made with AI, or news, research, and tools worth discussing.
        </p>
      </div>
      {opened ? (
        <Notice tone={loaderData.unscheduled ? "danger" : undefined}>
          {loaderData.unscheduled ? "Saved as a draft, but not scheduled: that time was taken meanwhile. Choose another." : loaderData.saved ? "Draft saved." : "A saved draft."}
          {opened.scheduledAt !== null ? (
            <>
              {" "}
              Scheduled for <ScheduledTime at={opened.scheduledAt} />; saving keeps it scheduled.
            </>
          ) : null}{" "}
          <Link to="/drafts" className="font-medium underline underline-offset-4">
            All drafts
          </Link>
        </Notice>
      ) : null}

      {blocked && !loaderData.status.allowed ? (
        <Notice
          tone={
            loaderData.status.reason === "banned" || loaderData.status.reason === "read_only"
              ? "danger"
              : loaderData.status.reason === "wait"
                ? "wait"
                : "info"
          }
        >
          {blocked}
        </Notice>
      ) : null}
      {result?.message ? <Notice tone="danger">{result.message}</Notice> : null}

      {showAgentPaywall ? (
        <AgentPaywall
          entitled={entitled}
          agentName={loaderData.agentName}
          onBack={() => {
            setAgent(false);
            setAgentAnswered(false);
          }}
        />
      ) : null}

      <Form
        method="post"
        hidden={showAgentPaywall}
        className="space-y-3 bleed rounded-xl border border-border bg-surface p-3 sm:p-4"
        onSubmit={() => setTouched(true)}
      >
        <Segmented
          label="Post from"
          value={source}
          onChange={setSource}
          options={(["link", "text", "upload"] as const).map((value) => ({ value, label: KIND_LABEL[value] }))}
        />
        <input type="hidden" name="kind" value={source} />
        <input type="hidden" name="url" value={source === "link" ? url : ""} />
        <input type="hidden" name="draft_id" value={opened?.id ?? ""} />
        <input type="hidden" name="draft_revision" value={opened?.revision ?? ""} />
        {gated ? (
          source === "text" ? (
            <PlanPaywall feature="text" title="Text posts are for fans">
              A write-up, a prompt, or a question, with no link needed. Your draft is kept; link posts stay free.
            </PlanPaywall>
          ) : (
            <PlanPaywall feature="upload" title="Uploads are for fans">
              Pictures, video, and audio hosted by the board, for work that lives nowhere else. Link posts stay free.
            </PlanPaywall>
          )
        ) : source === "upload" ? (
          <>
            <UploadPicker value={uploaded} onChange={setUploaded} onBusy={setUploading} error={result?.errors.upload} />
            <input type="hidden" name="upload_key" value={cover?.key ?? ""} />
            <input type="hidden" name="media_type" value={cover?.media ?? ""} />
            <input type="hidden" name="poster_key" value={cover?.posterKey ?? ""} />
            <input type="hidden" name="width" value={cover?.width ?? ""} />
            <input type="hidden" name="height" value={cover?.height ?? ""} />
            <input type="hidden" name="duration" value={cover?.duration ?? ""} />
            {/* A gallery: every picture, in order, the first being the cover. */}
            <input
              type="hidden"
              name="pictures"
              value={
                uploaded.length > 1
                  ? JSON.stringify(uploaded.map((upload) => ({ key: upload.key, width: upload.width, height: upload.height })))
                  : ""
              }
            />
          </>
        ) : source === "link" ? (
          <>
            <div className="flex items-end gap-2">
              <div className="min-w-0 flex-1">
                <TextField
                  label="Link"
                  type="url"
                  inputMode="url"
                  autoComplete="off"
                  placeholder="https://"
                  value={url}
                  onChange={(event) => {
                    setUrl(event.target.value);
                    setCheckError(null);
                  }}
                  onKeyDown={(event) => {
                    if (event.key === "Enter") {
                      event.preventDefault();
                      if (url.trim()) void check();
                    }
                  }}
                  error={checkError ?? (rechecked === result ? undefined : result?.errors.url)}
                />
              </div>
              {/* Lines up with the input, above the field's message row. */}
              <Button
                className="mb-[1.375rem]"
                onClick={() => void check()}
                disabled={checking || !url.trim() || current !== null}
              >
                {checking ? "Checking…" : current ? "Checked" : "Check link"}
              </Button>
            </div>
            {duplicate ? <DuplicateNotice duplicate={duplicate} /> : null}
            {current && !duplicate ? <Preview link={current.link} title={cleanTitle(title)} /> : null}
          </>
        ) : null}

        <div hidden={gated} className="space-y-3">
          <input type="hidden" name="receipt" value={source === "link" ? (current?.receipt ?? "") : ""} />
          <TextField
            label="Title"
            name="title"
            value={title}
            onChange={(event) => setTitle(event.target.value)}
            onBlur={() => setTouched(true)}
            count={{ value: length(title), max: TITLE_MAX }}
            error={titleError ?? result?.errors.title}
          />
          <TextArea
            label={source === "text" ? "Text" : "Description"}
            name="description"
            rows={source === "text" ? 10 : 4}
            hint={
              source === "text"
                ? "Your own words: a write-up, a prompt, or a question. Quote any AI-written text and name the AI."
                : source === "upload"
                  ? "How it was made: tools, prompts, workflow."
                  : entitled
                    ? "How it was made, or why it is worth reading. Addresses become links."
                    : "How it was made, or why it is worth reading. Links show as plain text."
            }
            value={description}
            onChange={(event) => setDescription(event.target.value)}
            onFormat={setDescription}
            onBlur={() => setTouched(true)}
            count={{ value: length(description), max: bodyMax }}
            error={descriptionError ?? result?.errors.description}
          />
          {source === "text" ? (
            <div>
              <input type="hidden" name="preview_offered" value="yes" />
              <label className="flex items-start gap-2.5 text-body">
                <input
                  type="checkbox"
                  name="preview"
                  value="yes"
                  checked={showPreview}
                  onChange={(event) => setShowPreview(event.target.checked)}
                  className="mt-1 size-4 shrink-0 accent-(--accent)"
                />
                <span>
                  Show a preview in the feed
                  <span className="block text-meta text-text-muted">The first link or picture in the text, on the post&apos;s card.</span>
                </span>
              </label>
            </div>
          ) : null}
          <fieldset hidden={source === "text"}>
            <legend className="sr-only">Where it came from</legend>
            <div className="flex flex-wrap gap-x-6">
              {(
                [
                  ["made", "I made this"],
                  ["found", "I found this"],
                ] as const
              ).map(([value, label]) => (
                <label key={value} className="flex h-9 items-center gap-2.5 text-body pointer-coarse:h-(--touch)">
                  <input
                    type="radio"
                    name="origin"
                    value={value}
                    checked={origin === value}
                    onChange={() => setOrigin(value)}
                    className="size-4 accent-(--accent)"
                  />
                  {label}
                </label>
              ))}
            </div>
            {result?.errors.origin ? (
              <p role="alert" className="text-meta text-danger">
                {result.errors.origin}
              </p>
            ) : null}
          </fieldset>
          <RepliesField
            name="replies"
            label="Who can comment"
            options={POST_CHOICES}
            value={replies}
            onChange={setReplies}
            entitled={entitled}
          />
          <div className="space-y-2">
            <label className="flex items-start gap-2.5 text-body">
              <input
                type="checkbox"
                name="attest"
                value="yes"
                checked={attest}
                onChange={(event) => setAttest(event.target.checked)}
                className="mt-1 size-4 shrink-0 accent-(--accent)"
              />
              This is made with AI or about AI, and safe for work.
            </label>
            {result?.errors.attest ? (
              <p role="alert" className="text-meta text-danger">
                {result.errors.attest}
              </p>
            ) : null}
            {/* Plainly worded, so an agent filling in the form can say what it is. */}
            <label className="flex items-start gap-2.5 text-meta text-text-muted">
              <input
                type="checkbox"
                name="agent"
                value="yes"
                checked={agent}
                onChange={(event) => setAgent(event.target.checked)}
                className="mt-0.5 size-4 shrink-0 accent-(--accent)"
              />
              I&apos;m an AI agent acting on this member&apos;s behalf.
            </label>
          </div>

          <div>
            {/* A fresh check after each attempt: a token works only once. */}
            <Turnstile key={JSON.stringify(result ?? null)} siteKey={loaderData.siteKey} action="submit" onToken={setToken} />
            <input type="hidden" name="cf-turnstile-response" value={token} />
            {result?.errors.turnstile ? (
              <p role="alert" className="mt-1 text-meta text-danger">
                {result.errors.turnstile}
              </p>
            ) : null}
          </div>

          <div className="space-y-2">
            <label className="flex items-start gap-2.5 text-body">
              <input
                type="checkbox"
                checked={later}
                onChange={(event) => setLater(event.target.checked)}
                className="mt-1 size-4 shrink-0 accent-(--accent)"
              />
              Publish later
            </label>
            {later ? (
              <div className="space-y-1 pl-6.5">
                <div className="flex flex-wrap gap-2">
                  <input
                    type="date"
                    aria-label="Date"
                    value={day}
                    min={days.min}
                    max={days.max}
                    onChange={(event) => setDay(event.target.value)}
                    className="h-9 rounded-lg border border-border-strong bg-surface px-2 text-body text-text"
                  />
                  <Select
                    aria-label="Time"
                    value={time}
                    onChange={(event) => setTime(event.target.value)}
                    className="h-9 rounded-lg border border-border-strong bg-surface pl-2 text-body text-text"
                  >
                    {QUARTER_HOURS.map((slot) => (
                      <option key={slot} value={slot}>
                        {slot}
                      </option>
                    ))}
                  </Select>
                </div>
                <p className="text-meta text-text-muted">
                  In your time zone, up to {SCHEDULE_DAYS} days ahead. It goes out as it is then, and the day&apos;s posting limit still applies.
                </p>
                {result?.errors.schedule ? (
                  <p role="alert" className="text-meta text-danger">
                    {result.errors.schedule}
                  </p>
                ) : null}
              </div>
            ) : null}
            <input type="hidden" name="scheduled_at" value={scheduledAt ?? ""} />
          </div>

          <div className="flex flex-wrap items-center justify-end gap-3">
            {source === "link" && !current?.receipt && !duplicate ? (
              <p className="text-meta text-text-muted">Check the link to publish.</p>
            ) : waiting ? (
              <p className="text-meta text-text-muted">Publish or save once the upload finishes.</p>
            ) : source === "upload" && uploaded.length === 0 ? (
              <p className="text-meta text-text-muted">Upload a file to publish.</p>
            ) : null}
            {/* A draft may be unfinished: the browser's own checks wait for publishing. */}
            <Button type="submit" name="intent" value="save-draft" formNoValidate disabled={submitting || waiting}>
              {saving ? "Saving…" : "Save draft"}
            </Button>
            {later ? (
              <Button variant="primary" type="submit" name="intent" value="schedule" disabled={!canSchedule}>
                {scheduling ? "Scheduling…" : "Schedule"}
              </Button>
            ) : (
              <Button variant="primary" type="submit" name="intent" value="publish" disabled={!canPublish}>
                {submitting && !saving ? "Publishing…" : "Publish"}
              </Button>
            )}
          </div>
        </div>
      </Form>
    </main>
  );
}
