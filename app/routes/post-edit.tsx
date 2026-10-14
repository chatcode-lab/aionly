import { env } from "cloudflare:workers";
import { useState } from "react";
import { data, Form, Link, redirect, useNavigation } from "react-router";

import { Button } from "~/components/ui/button";
import { TextArea, TextField } from "~/components/ui/field";
import { Notice } from "~/components/ui/states";
import { editablePost, editPost } from "~/lib/db/authoring.server";
import { formatWait } from "~/lib/format";
import {
  cleanDescription,
  cleanTitle,
  DESCRIPTION_MAX,
  descriptionProblem,
  length,
  type Origin,
  parseOrigin,
  TITLE_EDIT_SECONDS,
  TITLE_MAX,
  titleProblem,
} from "~/lib/submit/rules";
import { requireAccount, requireParticipant } from "~/lib/viewer.server";

import type { Route } from "./+types/post-edit";

export function meta(_: Route.MetaArgs) {
  return [{ title: "Edit post · aion.ly" }, { name: "robots", content: "noindex" }];
}

/** The author's own live post; anyone else, or a gone post, is not found. */
export async function loader({ params, request, context }: Route.LoaderArgs) {
  const viewer = await requireAccount(request, context);
  const post = await editablePost(env.DB, params.id, viewer.id);
  if (!post) throw data("Not Found", { status: 404 });
  const now = Math.floor(Date.now() / 1000);
  return { post, banned: viewer.ban !== null, titleOpenUntil: post.createdAt + TITLE_EDIT_SECONDS, now };
}

type FieldErrors = Partial<Record<"title" | "description" | "origin", string>>;

export async function action({ params, request, context }: Route.ActionArgs) {
  const viewer = await requireParticipant(request, context);
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
  const descriptionError = descriptionProblem(description);
  if (titleError) errors.title = titleError;
  if (descriptionError) errors.description = descriptionError;
  if (!origin) errors.origin = "Say whether you made it or found it.";
  if (Object.keys(errors).length > 0 || !origin) return { errors };

  const result = await editPost(env.DB, { id: post.id, authorId: viewer.id, title, origin, description, now });
  if (result.ok) throw redirect(`/p/${post.id}`);
  return {
    errors,
    message:
      result.reason === "window"
        ? "The title and made or found can only change in the first hour. Your description was not saved; save it again."
        : "That did not save. Try again.",
  };
}

export default function EditPost({ loaderData, actionData }: Route.ComponentProps) {
  const { post, banned, titleOpenUntil, now } = loaderData;
  const navigation = useNavigation();
  const saving = navigation.state !== "idle" && navigation.formMethod === "POST";
  const titleOpen = now < titleOpenUntil;
  const [title, setTitle] = useState(post.title);
  const [description, setDescription] = useState(post.description);
  const [origin, setOrigin] = useState<Origin>(post.origin);
  const errors: FieldErrors = actionData && "errors" in actionData ? actionData.errors : {};
  const message = actionData && "message" in actionData ? actionData.message : undefined;

  return (
    <main className="mx-auto max-w-column space-y-4 px-(--gutter) py-6">
      <h1 className="text-display font-semibold">Edit post</h1>
      {banned ? <Notice tone="danger">Your account is read-only while the ban lasts.</Notice> : null}
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
              ? `The title and made or found can change for ${formatWait(titleOpenUntil - now)} more. The link never changes.`
              : "The title and made or found could change only in the first hour. The link never changes."
          }
          count={titleOpen ? { value: length(title), max: TITLE_MAX } : undefined}
          error={errors.title}
        />
        <TextArea
          label="Description"
          name="description"
          hint="Can change any time. Marked edited after the first 5 minutes."
          value={description}
          onChange={(event) => setDescription(event.target.value)}
          count={{ value: length(description), max: DESCRIPTION_MAX }}
          error={errors.description}
          rows={6}
        />
        <fieldset disabled={!titleOpen}>
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
