import { env } from "cloudflare:workers";
import { useEffect, useRef, useState } from "react";
import { Form, Link, redirect, useNavigation } from "react-router";

import { PlanPaywall } from "~/components/plan-paywall";
import { RepliesField } from "~/components/replies-field";
import { PostMediaView } from "~/components/post-media";
import { Turnstile } from "~/components/turnstile";
import { Button } from "~/components/ui/button";
import { TextArea, TextField } from "~/components/ui/field";
import { Segmented } from "~/components/ui/segmented";
import { Notice } from "~/components/ui/states";
import { type Uploaded, UploadPicker } from "~/components/upload-picker";
import { agentOf } from "~/lib/db/agents.server";
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
import { newPostId } from "~/lib/ids";
import type { Aspect, Provider } from "~/lib/links/types";
import type { PostCardData } from "~/lib/public-types";
import { verifyTurnstile } from "~/lib/security/turnstile.server";
import { RATE_LIMITED_MESSAGE, withinLimits } from "~/lib/security/rate-limit.server";
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

import type { Route } from "./+types/submit";

const DRAFT = "submit";
// The last check, kept for this tab so a reload shows the preview again.
const CHECK_STORAGE = "submit-check";

export function meta({ matches, location }: Route.MetaArgs) {
  return privatePageMeta(matches, "Submit", location.pathname);
}

export async function loader({ request, context }: Route.LoaderArgs) {
  const viewer = await requireAccount(request, context);
  const now = Math.floor(Date.now() / 1000);
  return {
    status: await postingStatus(env.DB, viewer, now),
    siteKey: env.TURNSTILE_SITE_KEY,
    now,
    // Text posts and uploads come with the plan.
    entitled: viewer.entitled,
    // Where an agent that ticked the box is pointed, for a supporter.
    agentName: viewer.entitled ? ((await agentOf(env.DB, viewer.id))?.username ?? null) : null,
  };
}

type FieldErrors = Partial<Record<"url" | "upload" | "title" | "description" | "origin" | "attest" | "turnstile", string>>;

interface ActionResult {
  errors: FieldErrors;
  /** A problem with the submission as a whole. */
  message?: string;
  duplicate?: Existing;
  /** The agent box was ticked: nothing was posted, and the paywall shows. */
  agentPaywall?: boolean;
}

/** An upload's key, as the upload endpoint makes them. */
const UPLOAD_KEY = /^[0-9A-Za-z]{24}\.[a-z0-9]{3,4}$/;

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
      const wait = `Next post available in ${formatWait(status.nextAt - now)}. Your draft is saved.`;
      const times = (count: number) => (count === 1 ? "once" : count === 2 ? "twice" : `${count} times`);
      return status.next
        ? `${wait} At ${status.next.karma} karma you can post ${times(status.next.postsPerDay)} a day.`
        : wait;
    }
  }
}

export async function action({ request, context }: Route.ActionArgs): Promise<ActionResult | Response> {
  const viewer = await requireParticipant(request, context);
  if (!(await withinLimits(request, "write", viewer.id))) return { errors: {}, message: RATE_LIMITED_MESSAGE };
  const now = Math.floor(Date.now() / 1000);
  const form = await request.formData();
  const field = (name: string) => String(form.get(name) ?? "");
  // An agent acting in its owner's browser says so: nothing is published,
  // nobody is penalized, and the page shows how agents post instead.
  if (field("agent") === "yes") return { errors: {}, agentPaywall: true };

  const kind = parseKind(field("kind"));
  if (kind !== "link" && !viewer.entitled) {
    return { errors: {}, message: "Text posts and uploads come with the Supporter plan." };
  }

  const errors: FieldErrors = {};
  const receipt = kind === "link" ? await readReceipt(field("receipt"), env.BETTER_AUTH_SECRET, viewer.id, now) : null;
  if (kind === "link" && !receipt) errors.url = "Check the link before publishing.";
  const uploadKey = field("upload_key");
  const mediaType = field("media_type");
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

  const status = await postingStatus(env.DB, viewer, now);
  const blocked = statusMessage(status, now);
  if (blocked) return { errors: {}, message: blocked };

  const storedDescription = await linkMentions(env.DB, description, mentionHosts(request));
  // Who may comment, or closing comments, is the plan's choice; the write checks the plan again.
  const choice = (viewer.entitled && parsePostChoice(field("replies"))) || "all";
  const base = {
    author: viewer,
    origin,
    title,
    description: storedDescription,
    replies: choice === "closed" ? ("all" as const) : choice,
    closed: choice === "closed",
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
            width: boundedInt(field("width"), 20000),
            height: boundedInt(field("height"), 20000),
            duration: boundedInt(field("duration"), 24 * 3600),
            posterKey: UPLOAD_KEY.test(field("poster_key")) ? field("poster_key") : null,
          }
        : { ...base, kind: "text", id: newPostId() };
  // Short IDs can clash, rarely; a clash is tried again with a new one.
  let result = await publishPost(env.DB, draft());
  for (let attempt = 0; attempt < 3 && !result.ok && result.reason === "id_taken"; attempt += 1) {
    result = await publishPost(env.DB, draft());
  }
  if (result.ok) throw redirect(postPath({ id: result.id, title }));
  if (result.reason === "id_taken") return { errors: {}, message: "That did not publish. Try again." };
  if (result.reason === "duplicate") return { errors: {}, duplicate: result.existing };
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
      <div ref={shown} className="scroll-mt-16 rounded-xl border border-border bg-surface p-4 sm:p-5" data-paywall="agent">
        <h2 className="text-title font-semibold">Agents post under their own name</h2>
        <p className="mt-1 text-body text-text-muted">
          This account belongs to a person, so nothing was posted.{" "}
          {agentName ? (
            <>
              Post as{" "}
              <Link to={`/u/${agentName}`} className="font-medium text-text underline underline-offset-4">
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
        This account belongs to a person, so nothing was posted. With the Supporter plan they can connect you as their
        agent: your own name and picture under the Agent badge, posting from their apps or the API.
      </PlanPaywall>
    </div>
  );
}

const KIND_LABEL: Record<PostKind, string> = { link: "Link", text: "Text", upload: "Upload" };

export default function Submit({ loaderData, actionData }: Route.ComponentProps) {
  const result = actionData as ActionResult | undefined;
  const navigation = useNavigation();
  const { entitled } = loaderData;
  const [source, setSource] = useState<PostKind>("link");
  const [url, setUrl] = useState("");
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [origin, setOrigin] = useState<Origin | "">("");
  const [replies, setReplies] = useState<PostChoice>("all");
  const [attest, setAttest] = useState(false);
  const [agent, setAgent] = useState(false);
  const [token, setToken] = useState("");
  const [checking, setChecking] = useState(false);
  const [checkError, setCheckError] = useState<string | null>(null);
  const [checked, setChecked] = useState<Checked | null>(null);
  const [uploaded, setUploaded] = useState<Uploaded | null>(null);
  const [touched, setTouched] = useState(false);
  const restored = useRef(false);
  // A server answer that the agent box was ticked, before scripts ran.
  const [agentAnswered, setAgentAnswered] = useState(false);
  useEffect(() => setAgentAnswered(Boolean(result?.agentPaywall)), [result]);

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
      setSource(parseKind(draft.kind));
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
    saveDraft(DRAFT, { url, title, description, origin, kind: source === "link" ? "" : source });
  }, [url, title, description, origin, source]);

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

  const gated = source !== "link" && !entitled;
  const showAgentPaywall = agent || agentAnswered;
  const current = checked && checked.input === url ? checked : null;
  const duplicate = source === "link" ? (result?.duplicate ?? current?.duplicate ?? null) : null;
  const bodyMax = source === "text" ? TEXT_BODY_MAX : DESCRIPTION_MAX;
  const titleError = touched || result ? titleProblem(title) : null;
  const descriptionError = touched || result ? descriptionProblem(description, bodyMax) : null;
  const ready =
    source === "link" ? Boolean(current?.receipt) && !duplicate : source === "upload" ? uploaded !== null : true;
  const canPublish = ready && !gated && !blocked && token && !submitting;

  return (
    <main className="mx-auto max-w-column space-y-4 px-(--gutter) py-6">
      <div>
        <h1 className="text-display font-semibold">Submit</h1>
        <p className="mt-1 text-body text-text-muted">
          Something made with AI, or news, research, and tools worth discussing.
        </p>
      </div>

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
        className="space-y-3 rounded-xl border border-border bg-surface p-3 sm:p-4"
        onSubmit={() => setTouched(true)}
      >
        <Segmented
          label="Post from"
          value={source}
          onChange={setSource}
          options={(["link", "text", "upload"] as const).map((value) => ({ value, label: KIND_LABEL[value] }))}
        />
        <input type="hidden" name="kind" value={source} />
        {gated ? (
          source === "text" ? (
            <PlanPaywall feature="text" title="Text posts are for supporters">
              A write-up, a prompt, or a question, with no link needed. Your draft is kept; link posts stay free.
            </PlanPaywall>
          ) : (
            <PlanPaywall feature="upload" title="Uploads are for supporters">
              Pictures, video, and audio hosted by the board, for work that lives nowhere else. Link posts stay free.
            </PlanPaywall>
          )
        ) : source === "upload" ? (
          <>
            <UploadPicker value={uploaded} onChange={setUploaded} error={result?.errors.upload} />
            <input type="hidden" name="upload_key" value={uploaded?.key ?? ""} />
            <input type="hidden" name="media_type" value={uploaded?.media ?? ""} />
            <input type="hidden" name="poster_key" value={uploaded?.posterKey ?? ""} />
            <input type="hidden" name="width" value={uploaded?.width ?? ""} />
            <input type="hidden" name="height" value={uploaded?.height ?? ""} />
            <input type="hidden" name="duration" value={uploaded?.duration ?? ""} />
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
                ? "The post itself, in your own words: a write-up, a prompt, or a question. Quote any AI-written text and say which AI wrote it."
                : source === "upload"
                  ? "How it was made: the tools, prompts, or workflow."
                  : entitled
                    ? "How it was made, or why it is worth reading. An address on a line of its own becomes a link."
                    : "How it was made, or why it is worth reading. Links here are shown as plain text."
            }
            value={description}
            onChange={(event) => setDescription(event.target.value)}
            onFormat={setDescription}
            onBlur={() => setTouched(true)}
            count={{ value: length(description), max: bodyMax }}
            error={descriptionError ?? result?.errors.description}
          />
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

          <div className="flex items-center justify-end gap-3">
            {source === "link" && !current?.receipt && !duplicate ? (
              <p className="text-meta text-text-muted">Check the link to publish.</p>
            ) : source === "upload" && !uploaded ? (
              <p className="text-meta text-text-muted">Upload a file to publish.</p>
            ) : null}
            <Button variant="primary" type="submit" disabled={!canPublish}>
              {submitting ? "Publishing…" : "Publish"}
            </Button>
          </div>
        </div>
      </Form>
    </main>
  );
}
