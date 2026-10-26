import { env } from "cloudflare:workers";
import { useState } from "react";
import { data, Form, Link, redirect, useNavigation } from "react-router";

import { Button } from "~/components/ui/button";
import { TextArea, TextField } from "~/components/ui/field";
import { Notice } from "~/components/ui/states";
import { RepliesField } from "~/components/replies-field";
import { editablePost, editPost, setCommentsClosed, setPostReplies } from "~/lib/db/authoring.server";
import { deleteReleasedFiles } from "~/lib/db/draft-files.server";
import { linkMentions, mentionHosts, unlinkMentions } from "~/lib/db/mentions.server";
import { postPath } from "~/lib/slug";
import { formatWait } from "~/lib/format";
import {
  cleanDescription,
  cleanTitle,
  DESCRIPTION_MAX,
  descriptionProblem,
  TEXT_BODY_MAX,
  length,
  type Origin,
  parseOrigin,
  TITLE_EDIT_SECONDS,
  TITLE_MAX,
  titleProblem,
} from "~/lib/submit/rules";
import { RATE_LIMITED_MESSAGE, withinLimits } from "~/lib/security/rate-limit.server";
import { requireAccount, requireParticipant } from "~/lib/viewer.server";
import { privatePageMeta } from "~/lib/meta";
import { parsePostChoice, POST_CHOICES, type PostChoice } from "~/lib/replies";

import type { Route } from "./+types/post-edit";

export function meta({ matches, location }: Route.MetaArgs) {
  return privatePageMeta(matches, "Edit post", location.pathname);
}

/** The author's own live post; anyone else, or a gone post, is not found. */
export async function loader({ params, request, context }: Route.LoaderArgs) {
  const viewer = await requireAccount(request, context);
  const post = await editablePost(env.DB, params.id, viewer.id);
  if (!post) throw data("Not Found", { status: 404 });
  const now = Math.floor(Date.now() / 1000);
  // Mentions are edited as "@name".
  post.description = await unlinkMentions(env.DB, post.description);
  return {
    post,
    banned: viewer.ban !== null,
    entitled: viewer.entitled,
    titleOpenUntil: post.createdAt + TITLE_EDIT_SECONDS,
    now,
  };
}

type FieldErrors = Partial<Record<"title" | "description" | "origin", string>>;

export async function action({ params, request, context }: Route.ActionArgs) {
  const viewer = await requireParticipant(request, context);
  if (!(await withinLimits(request, "write", viewer.id))) return { errors: {}, message: RATE_LIMITED_MESSAGE };
  const form = await request.formData();
  const now = Math.floor(Date.now() / 1000);
  const post = await editablePost(env.DB, params.id, viewer.id);
  if (!post) throw data("Not Found", { status: 404 });

  // A title closed to changes is kept as it is, whatever the form sent.
  const titleOpen = now < post.createdAt + TITLE_EDIT_SECONDS;
  const title = titleOpen ? cleanTitle(String(form.get("title") ?? "")) : post.title;
  const origin = titleOpen ? parseOrigin(form.get("origin")) : post.origin;
  const description = cleanDescription(String(form.get("description") ?? ""));

  const errors: FieldErrors = {};
  const titleError = titleOpen ? titleProblem(title) : null;
  const descriptionError = descriptionProblem(description, post.kind === "text" ? TEXT_BODY_MAX : DESCRIPTION_MAX);
  if (titleError) errors.title = titleError;
  if (descriptionError) errors.description = descriptionError;
  if (!origin) errors.origin = "Say whether you made it or found it.";
  if (Object.keys(errors).length > 0 || !origin) return { errors };

  const stored = await linkMentions(env.DB, description, mentionHosts(request));
  const result = await editPost(env.DB, { id: post.id, authorId: viewer.id, title, origin, description: stored, now });
  // Who may comment, or closing comments, changes at any time with the
  // plan; a closed discussion can always be opened again, plan or not.
  const choice = parsePostChoice(form.get("replies"));
  if (result.ok && viewer.entitled && choice) {
    if (choice === "closed") {
      if (!post.closed) await setCommentsClosed(env.DB, { id: post.id, authorId: viewer.id, closed: true, now });
    } else {
      if (post.closed) await setCommentsClosed(env.DB, { id: post.id, authorId: viewer.id, closed: false, now });
      if (choice !== post.replies) await setPostReplies(env.DB, { id: post.id, authorId: viewer.id, replies: choice, now });
    }
  }
  if (result.ok && form.get("reopen") === "yes" && post.closed) {
    await setCommentsClosed(env.DB, { id: post.id, authorId: viewer.id, closed: false, now });
  }
  if (result.ok) {
    // The uploads its text no longer places go.
    await deleteReleasedFiles(env.DB, env.IMAGES, result.freed);
    throw redirect(postPath({ id: post.id, title }));
  }
  if (result.reason === "media") return { errors: { ...errors, description: result.problem } };
  return {
    errors,
    message:
      result.reason === "window"
        ? "The title and made or found can only change in the first hour. Your description was not saved; save it again."
        : "That did not save. Try again.",
  };
}

export default function EditPost({ loaderData, actionData }: Route.ComponentProps) {
  const { post, banned, entitled, titleOpenUntil, now } = loaderData;
  const navigation = useNavigation();
  const saving = navigation.state !== "idle" && navigation.formMethod === "POST";
  const titleOpen = now < titleOpenUntil;
  const [title, setTitle] = useState(post.title);
  const [description, setDescription] = useState(post.description);
  const [origin, setOrigin] = useState<Origin>(post.origin);
  const [replies, setReplies] = useState<PostChoice>(post.closed ? "closed" : post.replies);
  const errors: FieldErrors = actionData && "errors" in actionData ? actionData.errors : {};
  const message = actionData && "message" in actionData ? actionData.message : undefined;

  return (
    <main className="mx-auto max-w-column space-y-4 px-(--gutter) py-6">
      <h1 className="text-display font-semibold">Edit post</h1>
      {banned ? <Notice tone="danger">Your account is read-only for now, so it cannot edit.</Notice> : null}
      {message ? <Notice tone="danger">{message}</Notice> : null}

      <Form method="post" className="space-y-4">
        <TextField
          label="Title"
          name="title"
          value={title}
          onChange={(event) => setTitle(event.target.value)}
          disabled={!titleOpen}
          hint={
            titleOpen
              ? `The title and made or found can change for ${formatWait(titleOpenUntil - now)} more.${post.kind === "link" ? " The link never changes." : ""}`
              : `The title and made or found could change only in the first hour.${post.kind === "link" ? " The link never changes." : ""}`
          }
          count={titleOpen ? { value: length(title), max: TITLE_MAX } : undefined}
          error={errors.title}
        />
        <TextArea
          label={post.kind === "text" ? "Text" : "Description"}
          name="description"
          hint="Can change any time. Marked edited after the first 5 minutes."
          value={description}
          onChange={(event) => setDescription(event.target.value)}
          onFormat={setDescription}
          count={{ value: length(description), max: post.kind === "text" ? TEXT_BODY_MAX : DESCRIPTION_MAX }}
          error={errors.description}
          rows={post.kind === "text" ? 12 : 6}
        />
        <fieldset disabled={!titleOpen} hidden={post.kind === "text"}>
          <legend className="sr-only">Where it came from</legend>
          <div className="flex flex-wrap gap-x-6">
            {(
              [
                ["made", "I made this"],
                ["found", "I found this"],
              ] as const
            ).map(([value, label]) => (
              <label
                key={value}
                className="flex h-9 items-center gap-2.5 text-body has-disabled:text-text-muted pointer-coarse:h-(--touch)"
              >
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
          {errors.origin ? (
            <p role="alert" className="text-meta text-danger">
              {errors.origin}
            </p>
          ) : null}
        </fieldset>
        {!entitled && post.closed ? (
          // Closed with the plan, it stays closed after; opening needs no plan.
          <label className="flex items-start gap-2.5 text-body">
            <input type="checkbox" name="reopen" value="yes" className="mt-1 size-4 shrink-0 accent-(--accent)" />
            <span>Its comments are closed. Open them again to everyone.</span>
          </label>
        ) : (
          <RepliesField
            name="replies"
            label="Who can comment"
            options={POST_CHOICES}
            value={replies}
            onChange={setReplies}
            entitled={entitled}
          />
        )}

        <div className="flex items-center justify-end gap-2">
          <Button variant="ghost" asChild>
            <Link to={`/p/${post.id}`}>Cancel</Link>
          </Button>
          <Button variant="primary" type="submit" disabled={banned || saving}>
            {saving ? "Saving…" : "Save"}
          </Button>
        </div>
      </Form>
    </main>
  );
}
