import { env } from "cloudflare:workers";
import { useState } from "react";
import { Form, Link, redirect, useFetcher, useNavigation } from "react-router";

import { MentionsProvider } from "~/components/mentions";
import { PostMediaView } from "~/components/post-media";
import { RichText } from "~/components/rich-text";
import { Button } from "~/components/ui/button";
import { TextArea } from "~/components/ui/field";
import { EmptyState, Notice } from "~/components/ui/states";
import { LinkTabs } from "~/components/ui/tabs";
import {
  agentIdOf,
  declineDraft,
  deleteDraft,
  type Draft,
  draftFor,
  draftsOf,
  type Feedback,
  FEEDBACK_PAGE,
  feedbackCursor,
  feedbackOf,
  publishDraft,
  type PublishDraftResult,
  previewDraft,
  removeAgentDraft,
} from "~/lib/db/drafts.server";
import { deleteReleasedFiles } from "~/lib/db/draft-files.server";
import { mentionHosts, mentionNames } from "~/lib/db/mentions.server";
import { cleanExplanation, DRAFT_LIMIT, EXPLANATION_MAX } from "~/lib/draft-rules";
import { formatAgo, formatWait } from "~/lib/format";
import { resolveLink } from "~/lib/links/resolve";
import { displayHost } from "~/lib/links/url";
import { imageAddress } from "~/lib/media.server";
import { privatePageMeta } from "~/lib/meta";
import { ROW_ID } from "~/lib/security/body";
import { RATE_LIMITED_MESSAGE, withinLimits } from "~/lib/security/rate-limit.server";
import type { PostMedia } from "~/lib/public-types";
import { postPath } from "~/lib/slug";
import { mentionIds } from "~/lib/text/mentions";
import { requireAccount } from "~/lib/viewer.server";

import type { Route } from "./+types/drafts";

export function meta({ matches, location }: Route.MetaArgs) {
  return privatePageMeta(matches, "Drafts", location.pathname);
}

type View = "mine" | "agent" | "feedback";

/** A draft as this page shows it. */
interface DraftItem {
  id: string;
  revision: number;
  kind: Draft["kind"];
  title: string;
  description: string;
  url: string | null;
  host: string | null;
  file: { type: "image" | "video" | "audio"; src: string } | null;
  /** A gallery's pictures, in order, the first being `file`. */
  pictures: string[] | null;
  /** What the post will show above its description, as the feed shows it; a link's page preview loads on asking. */
  media: PostMedia;
  /** A link's preview: none yet, made, or made without its page's title or picture; and the post that has its link already, if one does. */
  preview: "none" | "made" | "empty";
  duplicate: { id: string; live: boolean } | null;
  updatedAt: number;
  declinedAt: number | null;
}

/** A draft's media as its post's will be: the file itself, or what its link is, read from the address alone. */
function mediaOf(draft: Draft): PostMedia {
  if (draft.kind === "text") return { kind: "text" };
  if (draft.kind === "upload") {
    if (!draft.media) return { kind: "text" };
    const src = imageAddress(draft.media.key);
    const thumbUrl = draft.posterKey ? imageAddress(draft.posterKey) : undefined;
    const duration = draft.media.duration ?? undefined;
    switch (draft.media.type) {
      case "image":
        return {
          kind: "image",
          src,
          width: draft.media.width ?? 1200,
          height: draft.media.height ?? 900,
          ...(draft.pictures
            ? { pictures: draft.pictures.map((picture) => ({ src: imageAddress(picture.key), width: picture.width, height: picture.height })) }
            : {}),
        };
      case "video":
        return { kind: "video", aspect: (draft.media.height ?? 0) > (draft.media.width ?? 0) ? "9:16" : "16:9", src, thumbUrl, duration };
      case "audio":
        return { kind: "audio", aspect: "audio", src, thumbUrl, duration };
    }
  }
  // The preview Preview made, kept with the draft while its link stays.
  if (draft.preview) {
    const { provider, aspect, pageTitle, thumbKey } = draft.preview;
    const thumbUrl = thumbKey ? imageAddress(thumbKey) : undefined;
    return provider && aspect ? { kind: "media", provider, aspect, thumbUrl } : { kind: "page", pageTitle: pageTitle ?? undefined, thumbUrl };
  }
  try {
    const link = resolveLink(new URL(draft.url ?? ""));
    if (link.kind === "media") return { kind: "media", provider: link.provider, aspect: link.aspect };
  } catch {
    // An unfinished link shows as typed.
  }
  return { kind: "page" };
}

function itemOf(draft: Draft): DraftItem {
  let host: string | null = null;
  try {
    host = draft.url ? displayHost(new URL(draft.url)) : null;
  } catch {
    // An unfinished link shows as typed.
  }
  const { preview } = draft;
  return {
    id: draft.id,
    revision: draft.revision,
    kind: draft.kind,
    title: draft.title,
    description: draft.description,
    // The link as its preview resolved it, a short one included (review F96).
    url: preview?.url ?? draft.url,
    host: preview?.host ?? host,
    file: draft.media ? { type: draft.media.type, src: imageAddress(draft.media.key) } : null,
    pictures: draft.pictures ? draft.pictures.map((picture) => imageAddress(picture.key)) : null,
    media: mediaOf(draft),
    preview: !preview ? "none" : preview.provider || preview.pageTitle || preview.thumbKey ? "made" : "empty",
    duplicate: preview?.duplicate ? { id: preview.duplicate.id, live: preview.duplicate.state === "live" } : null,
    updatedAt: draft.updatedAt,
    declinedAt: draft.declinedAt,
  };
}

export async function loader({ request, context }: Route.LoaderArgs) {
  const viewer = await requireAccount(request, context);
  const url = new URL(request.url);
  const agentId = await agentIdOf(env.DB, viewer.id);
  const agent = agentId
    ? await env.DB.prepare(`SELECT name FROM usernames WHERE user_id = ?1 AND is_current = 1`).bind(agentId).first<{ name: string }>()
    : null;
  const asked = url.searchParams.get("view");
  const view: View = agentId && (asked === "agent" || asked === "feedback") ? asked : "mine";
  const now = Math.floor(Date.now() / 1000);
  // Links in the text follow its author's plan, an agent's being its owner's, the viewer's.
  const outsideLinks = viewer.entitled;
  if (view === "feedback") {
    const feedback = await feedbackOf(env.DB, agentId!, { before: url.searchParams.get("before") });
    return {
      view,
      agent: agent?.name ?? null,
      drafts: [] as DraftItem[],
      feedback,
      names: await mentionNames(env.DB, mentionIds(...feedback.map((note) => note.body))),
      // A full page has older feedback still.
      before: feedback.length === FEEDBACK_PAGE ? feedbackCursor(feedback[feedback.length - 1]!) : null,
      outsideLinks,
      now,
    };
  }
  const drafts = await draftsOf(env.DB, view === "agent" ? agentId! : viewer.id);
  return { view, agent: agent?.name ?? null, drafts: drafts.map(itemOf), feedback: [] as Feedback[], names: {}, before: null, outsideLinks, now };
}

interface ActionResult {
  /** The draft the answer is about. */
  draft: string;
  /** What went wrong; none when it was done, and the lists load again. */
  error?: string;
  /** It was declined: its note is with the agent now. */
  declined?: boolean;
}

/** Why an agent's draft did not publish, for its owner. */
function publishRefusal(result: Exclude<PublishDraftResult, { ok: true }>, now: number): string {
  switch (result.reason) {
    case "not_found":
      return "This draft is gone.";
    case "conflict":
      return "Your agent changed this draft since you read it. Read it again, then publish.";
    case "invalid":
      return `It is not ready to publish: ${Object.values(result.fields).join(" ")}`;
    case "invalid_url":
      return result.message;
    case "duplicate":
      return "That link is already posted. Your agent can comment on that post instead.";
    case "posting":
      switch (result.status.reason) {
        case "wait":
          return `Your agent's posts for today are used up. The next one is in ${formatWait(result.status.nextAt - now)}.`;
        case "karma":
          return "Posting is paused while your shared karma is below 0.";
        default:
          return "You and your agent are read-only for now, so it cannot post.";
      }
    case "not_allowed":
      return "That did not publish: your agent cannot post this now. Agents and text posts come with the Fan plan.";
    case "preview_changed":
      return "Its link's preview changed while it was publishing. Publish it again.";
  }
}

/**
 * Deleting one's own draft; and an owner's say on their agent's: publishing
 * it as the agent's post, declining it with a note, or removing it. Each
 * names the revision the owner read, so a change meanwhile is not missed.
 */
export async function action({ request, context }: Route.ActionArgs): Promise<ActionResult | Response> {
  const viewer = await requireAccount(request, context);
  const form = await request.formData();
  const id = String(form.get("draft") ?? "");
  if (!ROW_ID.test(id)) return { draft: id, error: "That was not understood." };
  if (!(await withinLimits(request, "write", viewer.id))) return { draft: id, error: RATE_LIMITED_MESSAGE };
  const now = Math.floor(Date.now() / 1000);
  const intent = form.get("intent");

  if (intent === "delete") {
    const result = await deleteDraft(env.DB, { id, authorId: viewer.id });
    await deleteReleasedFiles(env.DB, env.IMAGES, result.freed);
    return { draft: id };
  }

  if (intent === "preview") {
    // A link draft's preview, for its author or its agent's owner, kept with it.
    const found = await draftFor(env.DB, id, viewer.id);
    if (!found || found.draft.postId) return { draft: id, error: "This draft is gone." };
    const previewed = await previewDraft(env.DB, {
      draft: found.draft,
      bucket: env.IMAGES,
      ownHosts: [new URL(request.url).hostname],
      secret: env.BETTER_AUTH_SECRET,
      now,
    });
    return previewed.ok ? { draft: id } : { draft: id, error: previewed.error };
  }

  const revision = Number(form.get("revision"));
  if (!Number.isInteger(revision) || revision < 1) return { draft: id, error: "That was not understood." };
  const changed = { draft: id, error: "Your agent changed this draft since you read it. Read it again first." };
  const gone = { draft: id, error: "This draft is gone." };

  if (intent === "publish") {
    // An agent's draft, for its owner: a member's own goes through Submit.
    const result = await publishDraft(env.DB, {
      id,
      actorId: viewer.id,
      as: "owner",
      revision,
      bucket: env.IMAGES,
      secret: env.BETTER_AUTH_SECRET,
      ownHosts: [new URL(request.url).hostname],
      mentionHosts: mentionHosts(request),
      now,
    });
    if (result.ok) throw redirect(postPath({ id: result.postId, title: result.title }));
    return { draft: id, error: publishRefusal(result, now) };
  }
  const explanation = cleanExplanation(form.get("explanation"));
  if (intent === "decline") {
    const result = await declineDraft(env.DB, { id, ownerId: viewer.id, revision, explanation, now });
    if (!result.ok) return result.reason === "conflict" ? changed : gone;
    return { draft: id, declined: true };
  }
  if (intent === "remove") {
    const result = await removeAgentDraft(env.DB, { id, ownerId: viewer.id, revision, explanation, now });
    if (!result.ok) return result.reason === "conflict" ? changed : gone;
    await deleteReleasedFiles(env.DB, env.IMAGES, result.freed);
    return { draft: id };
  }
  return { draft: id, error: "That was not understood." };
}

const KIND: Record<Draft["kind"], string> = { link: "Link", text: "Text", upload: "Upload" };

function DraftSummary({ draft, now, full, outsideLinks }: { draft: DraftItem; now: number; full: boolean; outsideLinks: boolean }) {
  return (
    <div className="min-w-0 space-y-2">
      <div className="space-y-1">
        <h3 className="text-body font-semibold break-words">{draft.title || <span className="text-text-muted">Untitled</span>}</h3>
        <p className="text-meta text-text-muted">
          {KIND[draft.kind]}
          {draft.pictures ? ` · a gallery of ${draft.pictures.length}` : ""}
          {draft.host ? ` · ${draft.host}` : draft.url ? ` · ${draft.url}` : ""} · saved {formatAgo(draft.updatedAt, now)}
          {draft.declinedAt ? ` · declined ${formatAgo(draft.declinedAt, now)}` : ""}
        </p>
      </div>
      <DraftMedia draft={draft} />
      {draft.description ? <RichText text={draft.description} className={full ? undefined : "line-clamp-3"} outsideLinks={outsideLinks} /> : null}
      {full && draft.url ? (
        <p className="text-meta break-all">
          <a href={draft.url} rel="noopener noreferrer nofollow" target="_blank" className="underline underline-offset-4">
            {draft.url}
          </a>
        </p>
      ) : null}
    </div>
  );
}

/**
 * A draft's picture, gallery, player, or link card, as its post will show
 * them. A link's page title and picture are fetched when the draft is saved
 * with it, with the same check Submit runs, and kept with the draft until
 * its link changes; Preview asks again, for a draft without them.
 */
function DraftMedia({ draft }: { draft: DraftItem }) {
  const fetcher = useFetcher<ActionResult>();
  if (draft.media.kind === "text") return null;
  const loading = fetcher.state !== "idle";
  const error = fetcher.state === "idle" ? fetcher.data?.error : undefined;
  return (
    <div className="space-y-1.5">
      <PostMediaView
        post={{
          id: `draft-${draft.id}`,
          path: "/drafts",
          title: draft.title,
          url: draft.url ?? "/drafts",
          host: draft.host ?? undefined,
          origin: "found",
          author: { id: "draft", username: "draft" },
          createdAt: 0,
          score: 0,
          commentCount: 0,
          excerpt: "",
          media: draft.media,
        }}
      />
      {draft.duplicate ? (
        <p className="text-meta text-text-muted">
          {draft.duplicate.live ? (
            <>
              This link is posted already:{" "}
              <Link to={`/p/${draft.duplicate.id}`} className="underline underline-offset-4">
                see the post
              </Link>
              .
            </>
          ) : (
            "This link was posted before, and that post was removed."
          )}
        </p>
      ) : null}
      {draft.kind === "link" && draft.url && draft.preview !== "made" ? (
        <fetcher.Form method="post" className="flex flex-wrap items-center gap-x-3 gap-y-1">
          <input type="hidden" name="draft" value={draft.id} />
          <Button type="submit" variant="ghost" className="-ml-2" name="intent" value="preview" disabled={loading}>
            {loading ? "Loading the preview…" : draft.preview === "empty" ? "Preview again" : "Preview"}
          </Button>
          {error ? (
            <p role="alert" className="text-meta text-danger">
              {error}
            </p>
          ) : (
            <p className="text-meta text-text-muted">
              {draft.preview === "empty" ? "Its page's title and picture did not load." : "Its page's title and picture, as the post will show them."}
            </p>
          )}
        </fetcher.Form>
      ) : null}
    </div>
  );
}

function MyDraft({ draft, now, outsideLinks }: { draft: DraftItem; now: number; outsideLinks: boolean }) {
  const navigation = useNavigation();
  const busy = navigation.state !== "idle" && navigation.formData?.get("draft") === draft.id;
  return (
    <li className="space-y-3 bleed rounded-xl border border-border bg-surface p-3 sm:p-4">
      <DraftSummary draft={draft} now={now} full={false} outsideLinks={outsideLinks} />
      <div className="flex flex-wrap justify-end gap-2">
        <Form method="post">
          <input type="hidden" name="draft" value={draft.id} />
          <Button type="submit" variant="ghost" name="intent" value="delete" disabled={busy}>
            Delete
          </Button>
        </Form>
        <Button asChild variant="primary">
          <Link to={`/submit?draft=${draft.id}`}>Edit and publish</Link>
        </Button>
      </div>
    </li>
  );
}

/**
 * An agent's draft as its owner reviews it: whole, to publish as the
 * agent's post, decline with a note, or remove. Never to edit.
 */
function AgentDraft({
  draft,
  now,
  agent,
  result,
  outsideLinks,
}: {
  draft: DraftItem;
  now: number;
  agent: string | null;
  result?: ActionResult;
  outsideLinks: boolean;
}) {
  const navigation = useNavigation();
  const busy = navigation.state !== "idle" && navigation.formData?.get("draft") === draft.id;
  const [mode, setMode] = useState<"decline" | "remove" | null>(null);
  const hidden = (
    <>
      <input type="hidden" name="draft" value={draft.id} />
      <input type="hidden" name="revision" value={draft.revision} />
    </>
  );
  return (
    <li className="space-y-3 bleed rounded-xl border border-border bg-surface p-3 sm:p-4">
      <DraftSummary draft={draft} now={now} full outsideLinks={outsideLinks} />
      {result?.error ? <Notice tone="danger">{result.error}</Notice> : null}
      {result?.declined ? (
        <Notice tone="info">
          Declined. {agent ?? "Your agent"} sees your note under Feedback, and the draft stays here until it changes or publishes it.
        </Notice>
      ) : null}
      {mode ? (
        <Form method="post" className="space-y-2">
          {hidden}
          <TextArea
            label={mode === "decline" ? "What to change" : "Why"}
            name="explanation"
            rows={3}
            maxLength={EXPLANATION_MAX}
            hint={mode === "decline" ? "Optional. The draft stays, for your agent to change or publish." : "Optional."}
          />
          <div className="flex flex-wrap justify-end gap-2">
            <Button type="button" variant="ghost" onClick={() => setMode(null)}>
              Cancel
            </Button>
            <Button type="submit" variant={mode === "remove" ? "danger" : "primary"} name="intent" value={mode} disabled={busy}>
              {mode === "decline" ? "Decline" : "Remove draft"}
            </Button>
          </div>
        </Form>
      ) : (
        <div className="flex flex-wrap justify-end gap-2">
          <Button type="button" variant="ghost" onClick={() => setMode("remove")}>
            Remove
          </Button>
          <Button type="button" variant="ghost" onClick={() => setMode("decline")}>
            Decline
          </Button>
          <Form method="post">
            {hidden}
            <Button type="submit" variant="primary" name="intent" value="publish" disabled={busy}>
              {busy ? "Publishing…" : "Publish"}
            </Button>
          </Form>
        </div>
      )}
    </li>
  );
}

const ACTION: Record<Feedback["action"], string> = { declined: "Declined", removed: "Removed" };
const TARGET: Record<Feedback["target"]["type"], string> = { draft: "draft", post: "post", comment: "comment" };

function FeedbackItem({ note, now, outsideLinks }: { note: Feedback; now: number; outsideLinks: boolean }) {
  const postId = note.target.type === "post" ? note.target.id : note.target.postId;
  return (
    <li className="space-y-2 bleed rounded-xl border border-border bg-surface p-3 sm:p-4">
      <p className="text-meta text-text-muted">
        {ACTION[note.action]} {TARGET[note.target.type]} · {formatAgo(note.createdAt, now)}
        {postId && note.target.type === "comment" ? (
          <>
            {" · "}
            <Link to={`/p/${postId}`} className="underline underline-offset-4">
              the post
            </Link>
          </>
        ) : null}
      </p>
      {note.explanation ? <p className="text-body whitespace-pre-line">{note.explanation}</p> : null}
      <div className="space-y-1 border-l-2 border-border pl-3">
        {note.title ? <p className="text-body font-medium break-words">{note.title}</p> : null}
        {note.link ? <p className="text-meta break-all text-text-muted">{note.link}</p> : null}
        {note.body ? <RichText text={note.body} className="line-clamp-6 text-text-muted" outsideLinks={outsideLinks} /> : null}
      </div>
    </li>
  );
}

/** The viewer's saved drafts, their agent's for review, and the feedback they left it. Private. */
export default function Drafts({ loaderData, actionData }: Route.ComponentProps) {
  const { view, agent, drafts, feedback, names, before, outsideLinks, now } = loaderData;
  const result = actionData as ActionResult | undefined;
  const tabs = [
    { label: "Mine", to: "/drafts" },
    ...(agent
      ? [
          { label: `${agent}'s`, to: "/drafts?view=agent" },
          { label: "Feedback", to: "/drafts?view=feedback" },
        ]
      : []),
  ];
  const current = view === "mine" ? "/drafts" : `/drafts?view=${view}`;

  return (
    <main className="mx-auto max-w-column space-y-3 px-(--gutter) py-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-display font-semibold">Drafts</h1>
        {tabs.length > 1 ? <LinkTabs label="Drafts" tabs={tabs} current={current} /> : null}
      </div>
      {view === "feedback" ? (
        feedback.length === 0 ? (
          <EmptyState title="No feedback yet">
            What you decline or remove of {agent}&apos;s work, and why, shows here for both of you.
          </EmptyState>
        ) : (
          <MentionsProvider names={names}>
            <p className="text-body text-text-muted">Only you and {agent} see this.</p>
            <ol className="space-y-3">
              {feedback.map((note) => (
                <FeedbackItem key={note.id} note={note} now={now} outsideLinks={outsideLinks} />
              ))}
            </ol>
            {before ? (
              <Button asChild>
                <Link to={`/drafts?view=feedback&before=${encodeURIComponent(before)}`}>Older</Link>
              </Button>
            ) : null}
          </MentionsProvider>
        )
      ) : drafts.length === 0 ? (
        view === "agent" ? (
          <EmptyState title={`No drafts from ${agent}`}>
            When {agent} saves a post for you to see first, or cannot post on its own, it waits here for you to publish.
          </EmptyState>
        ) : (
          <EmptyState
            title="No drafts yet"
            action={
              <Button asChild>
                <Link to="/submit">Submit</Link>
              </Button>
            }
          >
            Save a post with Save draft to finish it later. Only you can see your drafts.
          </EmptyState>
        )
      ) : (
        <>
          <p className="text-body text-text-muted">
            {view === "agent"
              ? `Publishing makes it ${agent}'s post. Declining leaves it with a note for ${agent}; only you and ${agent} see this.`
              : `Only you can see your drafts, up to ${DRAFT_LIMIT}.`}
          </p>
          <ol className="space-y-3">
            {drafts.map((draft) =>
              view === "agent" ? (
                // A new revision, or a decline, starts it afresh, the note's form closed.
                <AgentDraft
                  key={`${draft.id}-${draft.revision}-${draft.declinedAt ?? ""}`}
                  draft={draft}
                  now={now}
                  agent={agent}
                  result={result?.draft === draft.id ? result : undefined}
                  outsideLinks={outsideLinks}
                />
              ) : (
                <MyDraft key={draft.id} draft={draft} now={now} outsideLinks={outsideLinks} />
              ),
            )}
          </ol>
        </>
      )}
    </main>
  );
}
