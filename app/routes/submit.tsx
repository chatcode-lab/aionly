import { env } from "cloudflare:workers";
import { PenLine, Upload } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { Form, Link, redirect, useNavigation } from "react-router";

import { PostMediaView } from "~/components/post-media";
import { Turnstile } from "~/components/turnstile";
import { Button } from "~/components/ui/button";
import { TextArea, TextField } from "~/components/ui/field";
import { Segmented } from "~/components/ui/segmented";
import { Notice, SoonBadge } from "~/components/ui/states";
import { linkMentions, mentionHosts } from "~/lib/db/mentions.server";
import { type Existing, postingStatus, type PostingStatus, publishPost } from "~/lib/db/submit.server";
import { clearDraft, readDraft, saveDraft } from "~/lib/drafts";
import { formatWait } from "~/lib/format";
import { newPostId } from "~/lib/ids";
import type { Aspect, Provider } from "~/lib/links/types";
import type { PostCardData } from "~/lib/public-types";
import { verifyTurnstile } from "~/lib/security/turnstile.server";
import { postPath } from "~/lib/slug";
import type { CheckedLink, CheckResult } from "~/lib/submit/check.server";
import { readReceipt } from "~/lib/submit/receipt.server";
import {
  cleanDescription,
  cleanTitle,
  DESCRIPTION_MAX,
  descriptionProblem,
  length,
  type Origin,
  parseOrigin,
  TITLE_MAX,
  titleProblem,
} from "~/lib/submit/rules";
import { requireAccount, requireParticipant } from "~/lib/viewer.server";

import type { Route } from "./+types/submit";

const DRAFT = "submit";
// The last check, kept for this tab so a reload shows the preview again.
const CHECK_STORAGE = "submit-check";

export function meta(_: Route.MetaArgs) {
  return [{ title: "Submit · aion.ly" }, { name: "robots", content: "noindex" }];
}

export async function loader({ request, context }: Route.LoaderArgs) {
  const viewer = await requireAccount(request, context);
  const now = Math.floor(Date.now() / 1000);
  return {
    status: await postingStatus(env.DB, viewer, now),
    siteKey: env.TURNSTILE_SITE_KEY,
    now,
  };
}

type FieldErrors = Partial<Record<"url" | "title" | "description" | "origin" | "attest" | "turnstile", string>>;

interface ActionResult {
  errors: FieldErrors;
  /** A problem with the submission as a whole. */
  message?: string;
  duplicate?: Existing;
}

function statusMessage(status: PostingStatus, now: number): string | null {
  if (status.allowed) return null;
  switch (status.reason) {
    case "banned":
      return "Your account is read-only while the ban lasts.";
    case "karma":
      return "Posting is paused while your karma is below 0. Comments and votes still count.";
    case "wait":
      return `Next post available in ${formatWait(status.nextAt - now)}. Your draft is saved.`;
  }
}

export async function action({ request, context }: Route.ActionArgs): Promise<ActionResult | Response> {
  const viewer = await requireParticipant(request, context);
  const now = Math.floor(Date.now() / 1000);
  const form = await request.formData();
  const field = (name: string) => String(form.get(name) ?? "");

  const errors: FieldErrors = {};
  const receipt = await readReceipt(field("receipt"), env.BETTER_AUTH_SECRET, viewer.id, now);
  if (!receipt) errors.url = "Check the link before publishing.";
  const title = cleanTitle(field("title"));
  const description = cleanDescription(field("description"));
  const origin = parseOrigin(field("origin"));
  const titleError = titleProblem(title);
  const descriptionError = descriptionProblem(description);
  if (titleError) errors.title = titleError;
  if (descriptionError) errors.description = descriptionError;
  if (!origin) errors.origin = "Say whether you made it or found it.";
  if (field("attest") !== "yes") errors.attest = "Confirm the post fits the board.";
  if (Object.keys(errors).length > 0 || !receipt || !origin) return { errors };

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

  const status = await postingStatus(env.DB, viewer, now);
  const blocked = statusMessage(status, now);
  if (blocked) return { errors: {}, message: blocked };

  const storedDescription = await linkMentions(env.DB, description, mentionHosts(request));
  const publish = () => publishPost(env.DB, {
    id: newPostId(),
    author: viewer,
    url: receipt.url,
    canonicalKey: receipt.canonicalKey,
    provider: receipt.provider,
    aspect: receipt.aspect,
    pageTitle: receipt.pageTitle,
    thumbKey: receipt.thumbKey,
    origin,
    title,
    description: storedDescription,
    now,
  });
  // Short IDs can clash, rarely; a clash is tried again with a new one.
  let result = await publish();
  for (let attempt = 0; attempt < 3 && !result.ok && result.reason === "id_taken"; attempt += 1) {
    result = await publish();
  }
  if (result.ok) throw redirect(postPath({ id: result.id, title }));
  if (result.reason === "id_taken") return { errors: {}, message: "That did not publish. Try again." };
  if (result.reason === "duplicate") return { errors: {}, duplicate: result.existing };
  // The allowance changed between the check and the write.
  const again = statusMessage(await postingStatus(env.DB, viewer, now), now);
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

export default function Submit({ loaderData, actionData }: Route.ComponentProps) {
  const result = actionData as ActionResult | undefined;
  const navigation = useNavigation();
  const [source, setSource] = useState<"link" | "text" | "upload">("link");
  const [url, setUrl] = useState("");
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [origin, setOrigin] = useState<Origin | "">("");
  const [attest, setAttest] = useState(false);
  const [token, setToken] = useState("");
  const [checking, setChecking] = useState(false);
  const [checkError, setCheckError] = useState<string | null>(null);
  const [checked, setChecked] = useState<Checked | null>(null);
  const [touched, setTouched] = useState(false);
  const restored = useRef(false);

  const blocked = statusMessage(loaderData.status, loaderData.now);
  const submitting = navigation.state === "submitting" && navigation.formAction === "/submit";

  // Bring back the draft, and the check that went with it.
  useEffect(() => {
    const draft = readDraft(DRAFT);
    if (draft) {
      setUrl(draft.url ?? "");
      setTitle(draft.title ?? "");
      setDescription(draft.description ?? "");
      setOrigin(parseOrigin(draft.origin) ?? "");
    }
    try {
      const saved = JSON.parse(sessionStorage.getItem(CHECK_STORAGE) ?? "null") as Checked | null;
      if (saved && saved.input === (draft?.url ?? "")) setChecked(saved);
    } catch {
      // A missing or broken stored check only means checking again.
    }
    restored.current = true;
  }, []);

  useEffect(() => {
    if (!restored.current) return;
    saveDraft(DRAFT, { url, title, description, origin });
  }, [url, title, description, origin]);

  // Leaving for the new post: the draft is done with.
  useEffect(() => {
    if (navigation.state === "loading" && navigation.formAction === "/submit" && navigation.location.pathname.startsWith("/p/")) {
      clearDraft(DRAFT);
      sessionStorage.removeItem(CHECK_STORAGE);
    }
  }, [navigation]);

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
      sessionStorage.setItem(CHECK_STORAGE, JSON.stringify(next));
      if (!title && data.link.suggestedTitle) setTitle(data.link.suggestedTitle.slice(0, TITLE_MAX));
    } catch {
      setCheckError("That link could not be checked. Try again.");
    } finally {
      setChecking(false);
    }
  };

  const current = checked && checked.input === url ? checked : null;
  const duplicate = result?.duplicate ?? current?.duplicate ?? null;
  const titleError = touched || result ? titleProblem(title) : null;
  const descriptionError = touched || result ? descriptionProblem(description) : null;
  const canPublish = source === "link" && current?.receipt && !duplicate && !blocked && token && !submitting;

  return (
    <main className="mx-auto max-w-column space-y-4 px-(--gutter) py-6">
      <div>
        <h1 className="text-display font-semibold">Submit</h1>
        <p className="mt-1 text-body text-text-muted">
          Something made with AI, or AI news worth reading. One post a day.
        </p>
      </div>

      {blocked && !loaderData.status.allowed ? (
        <Notice
          tone={
            loaderData.status.reason === "banned"
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

      <Form
        method="post"
        className="space-y-3 rounded-xl border border-border bg-surface p-3 sm:p-4"
        onSubmit={() => setTouched(true)}
      >
        <Segmented
          label="Post from"
          value={source}
          onChange={setSource}
          options={[
            { value: "link", label: "Link" },
            { value: "text", label: "Text" },
            { value: "upload", label: "Upload" },
          ]}
        />
        {source === "text" ? (
          <div className="rounded-xl border border-dashed border-border-strong px-4 py-6 text-center">
            <PenLine size={24} aria-hidden className="mx-auto text-text-faint" />
            <p className="mt-2 flex flex-wrap items-center justify-center gap-2 text-body font-medium">
              Write a text post
              <SoonBadge />
            </p>
            <p className="mx-auto mt-1 max-w-sm text-meta text-text-muted">
              A write-up, a prompt, or a question, with no link needed. Text posts will come with
              the supporter plan.
            </p>
          </div>
        ) : source === "upload" ? (
          <div className="rounded-xl border border-dashed border-border-strong px-4 py-6 text-center">
            <Upload size={24} aria-hidden className="mx-auto text-text-faint" />
            <p className="mt-2 flex flex-wrap items-center justify-center gap-2 text-body font-medium">
              Upload a picture, video, or audio
              <SoonBadge />
            </p>
            <p className="mx-auto mt-1 max-w-sm text-meta text-text-muted">
              For work that lives nowhere else. Uploads will come with the supporter plan.
            </p>
          </div>
        ) : (
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
                  error={checkError ?? result?.errors.url}
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
        )}

        <input type="hidden" name="receipt" value={current?.receipt ?? ""} />
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
          label="Description"
          name="description"
          hint="How it was made, or why it is worth reading. Links here are shown as plain text."
          value={description}
          onChange={(event) => setDescription(event.target.value)}
          onBlur={() => setTouched(true)}
          count={{ value: length(description), max: DESCRIPTION_MAX }}
          error={descriptionError ?? result?.errors.description}
        />
        <fieldset>
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
        <div>
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
            <p role="alert" className="mt-1 text-meta text-danger">
              {result.errors.attest}
            </p>
          ) : null}
        </div>

        {source === "link" ? (
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
        ) : null}

        <div className="flex items-center justify-end gap-3">
          {source === "link" && !current?.receipt && !duplicate ? (
            <p className="text-meta text-text-muted">Check the link to publish.</p>
          ) : null}
          <Button variant="primary" type="submit" disabled={!canPublish}>
            {submitting ? "Publishing…" : "Publish"}
          </Button>
        </div>
      </Form>
    </main>
  );
}
