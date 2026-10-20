import { useEffect, useId, useRef, useState } from "react";
import { Link, useFetcher, useNavigate } from "react-router";

import { type AuthoringResult, commentDraftKey, pageOfComment, revealComment } from "~/lib/authoring";
import { cn } from "~/lib/cn";
import { COMMENT_MAX, commentProblem } from "~/lib/comments/rules";
import { clearDraft, readDraft, saveDraft } from "~/lib/drafts";
import { length } from "~/lib/submit/rules";
import { replaceMentions } from "~/lib/text/mentions";
import { useViewer } from "~/lib/use-viewer";

import { FormatToolbar } from "./format-toolbar";
import { useMentionNames } from "./mentions";
import { useSignIn } from "./sign-in";
import { Button } from "./ui/button";

// The counter appears once a comment nears its limit.
const COUNTER_FROM = COMMENT_MAX - 500;

const TEXTAREA =
  "block w-full resize-y rounded-lg border bg-surface px-3 py-2 text-body text-text placeholder:text-text-faint pointer-coarse:text-[length:max(1rem,var(--text-body))]";

/**
 * Comment text with its counter and error, sent with Ctrl or Cmd and Enter.
 * Shared by the comment box and the comment editor.
 */
export function CommentField({
  label,
  value,
  onChange,
  placeholder,
  error,
  autoFocus,
  rows = 3,
}: {
  label: string;
  value: string;
  onChange: (next: string) => void;
  placeholder?: string;
  error?: string;
  autoFocus?: boolean;
  rows?: number;
}) {
  const id = useId();
  const textarea = useRef<HTMLTextAreaElement>(null);
  const count = length(value);
  const over = count > COMMENT_MAX;
  return (
    <div>
      <label htmlFor={id} className="sr-only">
        {label}
      </label>
      <FormatToolbar textarea={textarea} onChange={onChange} />
      <textarea
        ref={textarea}
        id={id}
        name="body"
        rows={rows}
        value={value}
        placeholder={placeholder}
        autoFocus={autoFocus}
        aria-invalid={error || over ? true : undefined}
        aria-describedby={error ? `${id}-error` : undefined}
        onChange={(event) => onChange(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
            event.preventDefault();
            event.currentTarget.form?.requestSubmit();
          }
        }}
        className={cn(TEXTAREA, error || over ? "border-danger" : "border-border-strong")}
      />
      {error || count >= COUNTER_FROM ? (
        <div className="mt-1 flex justify-between gap-4 text-meta">
          <p id={`${id}-error`} role="alert" className="text-danger">
            {error}
          </p>
          {count >= COUNTER_FROM ? (
            <p className={cn("shrink-0 tabular-nums", over ? "text-danger" : "text-text-faint")}>
              {count}/{COMMENT_MAX}
            </p>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

/**
 * The box that adds a comment to a post, or a reply under a comment. Its
 * text is kept as a draft in this browser until it is sent. Signed out, it
 * is a single row that leads to sign-in and back.
 */
export function CommentBox({
  postId,
  parentId = null,
  onCancel,
  onDone,
  rule,
}: {
  postId: string;
  parentId?: string | null;
  /**
   * Who the post's author lets comment, in words, and whether that includes
   * this viewer: shown above the box, or in its place when it does not.
   */
  rule?: { text: string; open: boolean };
  /** Shown for a reply, which can be closed. */
  onCancel?: () => void;
  /** Called with the new comment's ID once it is added. */
  onDone?: (id: string) => void;
}) {
  const viewer = useViewer();
  const signIn = useSignIn();
  const fetcher = useFetcher<AuthoringResult>();
  const navigate = useNavigate();
  const draftKey = commentDraftKey(postId, parentId);
  const [body, setBody] = useState("");
  const [touched, setTouched] = useState(false);
  const loaded = useRef(false);
  const reply = parentId !== null;

  useEffect(() => {
    setBody(readDraft(draftKey)?.body ?? "");
    loaded.current = true;
  }, [draftKey]);

  useEffect(() => {
    if (loaded.current) saveDraft(draftKey, { body });
  }, [draftKey, body]);

  // Once the comment is added: start afresh, and show it. A refusal stays
  // until the text changes.
  const [refusal, setRefusal] = useState<string>();
  const handled = useRef<AuthoringResult | undefined>(undefined);
  useEffect(() => {
    const result = fetcher.data;
    if (fetcher.state !== "idle" || !result || handled.current === result) return;
    handled.current = result;
    if (!result.ok) {
      setRefusal(result.error);
      return;
    }
    if (!result.id) return;
    clearDraft(draftKey);
    setBody("");
    setTouched(false);
    const id = result.id;
    onDone?.(id);
    requestAnimationFrame(() => {
      if (!revealComment(id)) void navigate(pageOfComment(window.location.search, id));
    });
  }, [fetcher.state, fetcher.data, draftKey, onDone, navigate]);

  if (rule && !rule.open) return <p className="text-meta text-text-muted">{rule.text}</p>;
  const note = rule ? <p className="text-meta text-text-muted">{rule.text}</p> : null;

  if (!viewer) {
    const next = `/p/${postId}`;
    return (
      <div className="space-y-2">
        {note}
        <Link
          to={`/signin?${new URLSearchParams({ next })}`}
          onClick={(event) => {
            event.preventDefault();
            signIn({ title: "Sign in to comment" });
          }}
          className="flex h-11 items-center rounded-lg border border-border-strong bg-surface px-3 text-body text-text-muted hover:border-text-faint hover:text-text"
        >
          Sign in to comment
        </Link>
      </div>
    );
  }
  if (viewer.ban) {
    return reply ? null : (
      <p className="text-meta text-text-muted">
        Commenting is paused while your account is read-only.
        {/* The way back, where it is missed: a fresh start, an appeal, or votes. */}
        {viewer.ban.kind === "karma" ? (
          <>
            {" "}
            <Link to="/fresh-start" className="font-medium text-text underline underline-offset-4">
              How to take part again
            </Link>
          </>
        ) : null}
      </p>
    );
  }

  const sending = fetcher.state !== "idle";
  const problem = commentProblem(body);
  const error = refusal ?? (touched ? problem : null) ?? undefined;

  return (
    <fetcher.Form
      method="post"
      action={`/p/${postId}`}
      className="space-y-2"
      onSubmit={(event) => {
        setTouched(true);
        if (problem) event.preventDefault();
      }}
    >
      {note}
      <input type="hidden" name="intent" value="comment" />
      {parentId ? <input type="hidden" name="parent" value={parentId} /> : null}
      <CommentField
        label={reply ? "Reply" : "Comment"}
        value={body}
        onChange={(next) => {
          setBody(next);
          setRefusal(undefined);
        }}
        placeholder={reply ? "Write a reply, in your own words" : "Add a comment, in your own words"}
        error={error}
        autoFocus={reply}
        rows={reply ? 3 : 2}
      />
      <div className="flex justify-end gap-2">
        {onCancel ? (
          <Button variant="ghost" onClick={onCancel}>
            Cancel
          </Button>
        ) : null}
        <Button variant="primary" type="submit" disabled={sending}>
          {sending ? "Sending…" : reply ? "Reply" : "Comment"}
        </Button>
      </div>
    </fetcher.Form>
  );
}

/** Edits a comment in place of its text. */
export function CommentEditor({
  postId,
  commentId,
  body: initial,
  onDone,
}: {
  postId: string;
  commentId: string;
  body: string;
  /** Called when saved or cancelled. */
  onDone: () => void;
}) {
  const fetcher = useFetcher<AuthoringResult>();
  const names = useMentionNames();
  // Mentions are edited as "@name" and stored again as references on save.
  const [body, setBody] = useState(() =>
    replaceMentions(initial, names, (name) => (name.deleted ? "@[deleted]" : `@${name.username}`)),
  );
  const [refusal, setRefusal] = useState<string>();
  const handled = useRef<AuthoringResult | undefined>(undefined);

  useEffect(() => {
    const result = fetcher.data;
    if (fetcher.state !== "idle" || !result || handled.current === result) return;
    handled.current = result;
    if (result.ok) onDone();
    else setRefusal(result.error);
  }, [fetcher.state, fetcher.data, onDone]);

  const problem = commentProblem(body);
  return (
    <fetcher.Form
      method="post"
      action={`/p/${postId}`}
      className="mt-1 space-y-2"
      onSubmit={(event) => {
        if (problem) {
          event.preventDefault();
          setRefusal(problem);
        }
      }}
    >
      <input type="hidden" name="intent" value="edit-comment" />
      <input type="hidden" name="id" value={commentId} />
      <CommentField
        label="Edit comment"
        value={body}
        onChange={(next) => {
          setBody(next);
          setRefusal(undefined);
        }}
        error={refusal}
        autoFocus
        rows={4}
      />
      <div className="flex justify-end gap-2">
        <Button variant="ghost" onClick={onDone}>
          Cancel
        </Button>
        <Button variant="primary" type="submit" disabled={fetcher.state !== "idle"}>
          {fetcher.state !== "idle" ? "Saving…" : "Save"}
        </Button>
      </div>
    </fetcher.Form>
  );
}
