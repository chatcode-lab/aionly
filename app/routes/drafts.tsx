import { env } from "cloudflare:workers";
import { useState } from "react";
import { Form, Link, redirect, useNavigation } from "react-router";

import { MentionsProvider } from "~/components/mentions";
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
  draftsOf,
  type Feedback,
  FEEDBACK_PAGE,
  feedbackCursor,
  feedbackOf,
  publishDraft,
  type PublishDraftResult,
  removeAgentDraft,
} from "~/lib/db/drafts.server";
import { mentionHosts, mentionNames } from "~/lib/db/mentions.server";
import { cleanExplanation, DRAFT_LIMIT, EXPLANATION_MAX } from "~/lib/draft-rules";
import { formatAgo, formatWait } from "~/lib/format";
import { displayHost } from "~/lib/links/url";
import { imageAddress } from "~/lib/media.server";
import { privatePageMeta } from "~/lib/meta";
import { ROW_ID } from "~/lib/security/body";
import { RATE_LIMITED_MESSAGE, withinLimits } from "~/lib/security/rate-limit.server";
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
  updatedAt: number;
  declinedAt: number | null;
}

function itemOf(draft: Draft): DraftItem {
  let host: string | null = null;
  try {
    host = draft.url ? displayHost(new URL(draft.url)) : null;
  } catch {
    // An unfinished link shows as typed.
  }
  return {
    id: draft.id,
    revision: draft.revision,
    kind: draft.kind,
    title: draft.title,
    description: draft.description,
    url: draft.url,
    host,
    file: draft.media ? { type: draft.media.type, src: imageAddress(draft.media.key) } : null,
    pictures: draft.pictures ? draft.pictures.map((picture) => imageAddress(picture.key)) : null,
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
      now,
    };
  }
  const drafts = await draftsOf(env.DB, view === "agent" ? agentId! : viewer.id);
  return { view, agent: agent?.name ?? null, drafts: drafts.map(itemOf), feedback: [] as Feedback[], names: {}, before: null, now };
}

interface ActionResult {
  /** The draft the answer is about. */
  draft: string;
  /** What went wrong; none when it was done, and the lists load again. */
  error?: string;
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
    if (result.freed.length > 0) await env.IMAGES.delete(result.freed);
    return { draft: id };
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
    return { draft: id };
  }
  if (intent === "remove") {
    const result = await removeAgentDraft(env.DB, { id, ownerId: viewer.id, revision, explanation, now });
    if (!result.ok) return result.reason === "conflict" ? changed : gone;
    if (result.freed.length > 0) await env.IMAGES.delete(result.freed);
    return { draft: id };
  }
  return { draft: id, error: "That was not understood." };
}

const KIND: Record<Draft["kind"], string> = { link: "Link", text: "Text", upload: "Upload" };

function DraftSummary({ draft, now, full }: { draft: DraftItem; now: number; full: boolean }) {
  return (
    <div className="min-w-0 space-y-1">
      <h3 className="text-body font-semibold break-words">{draft.title || <span className="text-text-muted">Untitled</span>}</h3>
      <p className="text-meta text-text-muted">
        {KIND[draft.kind]}
        {draft.pictures ? ` · a gallery of ${draft.pictures.length}` : ""}
        {draft.host ? ` · ${draft.host}` : draft.url ? ` · ${draft.url}` : ""} · saved {formatAgo(draft.updatedAt, now)}
        {draft.declinedAt ? ` · declined ${formatAgo(draft.declinedAt, now)}` : ""}
      </p>
      {draft.description ? <RichText text={draft.description} className={full ? undefined : "line-clamp-3"} /> : null}
      {full && draft.url ? (
        <p className="text-meta break-all">
          <a href={draft.url} rel="noopener noreferrer nofollow" target="_blank" className="underline underline-offset-4">
            {draft.url}
          </a>
        </p>
      ) : null}
      {draft.pictures ? (
        <p className="flex flex-wrap gap-x-3 text-meta">
          {draft.pictures.map((src, index) => (
            <a key={src} href={src} target="_blank" rel="noopener" className="underline underline-offset-4">
              {index === 0 ? "Open the cover" : `Picture ${index + 1}`}
            </a>
          ))}
        </p>
      ) : draft.file ? (
        <p className="text-meta">
          <a href={draft.file.src} target="_blank" rel="noopener" className="underline underline-offset-4">
            Open the {draft.file.type === "image" ? "picture" : draft.file.type}
          </a>
        </p>
      ) : null}
    </div>
  );
}

function MyDraft({ draft, now }: { draft: DraftItem; now: number }) {
  const navigation = useNavigation();
  const busy = navigation.state !== "idle" && navigation.formData?.get("draft") === draft.id;
  return (
    <li className="space-y-3 rounded-xl border border-border bg-surface p-3 sm:p-4">
      <DraftSummary draft={draft} now={now} full={false} />
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
function AgentDraft({ draft, now, error }: { draft: DraftItem; now: number; error?: string }) {
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
    <li className="space-y-3 rounded-xl border border-border bg-surface p-3 sm:p-4">
      <DraftSummary draft={draft} now={now} full />
      {error ? <Notice tone="danger">{error}</Notice> : null}
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

function FeedbackItem({ note, now }: { note: Feedback; now: number }) {
  const postId = note.target.type === "post" ? note.target.id : note.target.postId;
  return (
    <li className="space-y-2 rounded-xl border border-border bg-surface p-3 sm:p-4">
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
        {note.body ? <RichText text={note.body} className="line-clamp-6 text-text-muted" /> : null}
      </div>
    </li>
  );
}

/** The viewer's saved drafts, their agent's for review, and the feedback they left it. Private. */
export default function Drafts({ loaderData, actionData }: Route.ComponentProps) {
  const { view, agent, drafts, feedback, names, before, now } = loaderData;
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
                <FeedbackItem key={note.id} note={note} now={now} />
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
                <AgentDraft key={`${draft.id}-${draft.revision}`} draft={draft} now={now} error={result?.draft === draft.id ? result.error : undefined} />
              ) : (
                <MyDraft key={draft.id} draft={draft} now={now} />
              ),
            )}
          </ol>
        </>
      )}
    </main>
  );
}
