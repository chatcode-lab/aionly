import { Award, Ban, Flag, Pencil, Pin, PinOff, ShieldX, Trash2, UserRoundX } from "lucide-react";
import { type ReactNode, useEffect, useRef, useState } from "react";
import { Link, useFetcher } from "react-router";

import type { AuthoringResult } from "~/lib/authoring";
import type { CommentData, PostCardData } from "~/lib/public-types";
import type { ReportTarget } from "~/lib/reports";
import { useModeration } from "~/lib/use-moderation";
import { useViewer } from "~/lib/use-viewer";

import { BanDialog } from "./ban-dialog";
import { PickDialog } from "./pick-dialog";
import { useNotify } from "./notify";
import { ReportDialog } from "./report-dialog";
import { useSignIn } from "./sign-in";
import { ConfirmDialog } from "./ui/confirm";
import { Menu, MenuItem, MenuSeparator } from "./ui/menu";
import { useModerate } from "./use-moderate";

/** Submits one deletion to the post page's action and reports the outcome. */
function useDeletion(postId: string, onDeleted?: () => void) {
  const fetcher = useFetcher<AuthoringResult>();
  const [open, setOpen] = useState(false);
  const [error, setError] = useState<string>();
  const handled = useRef<AuthoringResult | undefined>(undefined);

  useEffect(() => {
    const result = fetcher.data;
    if (fetcher.state !== "idle" || !result || handled.current === result) return;
    handled.current = result;
    if (result.ok) {
      setOpen(false);
      onDeleted?.();
    } else {
      setError(result.error);
    }
  }, [fetcher.state, fetcher.data, onDeleted]);

  return {
    open,
    setOpen: (next: boolean) => {
      setOpen(next);
      setError(undefined);
    },
    error,
    busy: fetcher.state !== "idle",
    submit: (fields: Record<string, string>) =>
      void fetcher.submit(fields, { method: "post", action: `/p/${postId}` }),
  };
}

/** Who is looking, and what they may do to something by `authorId`. */
function useRoles(authorId: string | undefined) {
  const viewer = useViewer();
  const active = viewer !== null && !viewer.ban;
  const own = viewer !== null && viewer.id === authorId;
  return {
    viewer,
    own,
    /** Editing and deleting: the author, while not banned. */
    author: own && active,
    /** Reporting: anyone else; signed out, it leads to sign-in. */
    reporter: !own && (viewer === null || active),
    admin: active && viewer.role === "admin",
    /** Picking posts: the guest editor of the running term. */
    editor: active && viewer.editor === true,
  };
}

/** Report, for anyone signed in; signed out, it opens sign-in. */
function useReporting(type: ReportTarget, id: string) {
  const viewer = useViewer();
  const signIn = useSignIn();
  const [open, setOpen] = useState(false);
  return {
    item: (label = "Report") => (
      <MenuItem
        onSelect={() => (viewer ? setOpen(true) : signIn({ title: "Sign in to report" }))}
      >
        <Flag size={16} aria-hidden /> {label}
      </MenuItem>
    ),
    dialog: viewer ? <ReportDialog type={type} id={id} open={open} onOpenChange={setOpen} /> : null,
  };
}

/** Ban, for admins, against an author who is not themselves or deleted. */
function useBanning(author: { id: string; username: string } | null) {
  const [open, setOpen] = useState(false);
  return {
    item: () =>
      author ? (
        <MenuItem danger onSelect={() => setOpen(true)}>
          <Ban size={16} aria-hidden /> Ban {author.username}
        </MenuItem>
      ) : null,
    dialog: author ? <BanDialog user={author} open={open} onOpenChange={setOpen} /> : null,
  };
}

function Sections({ sections }: { sections: ReactNode[][] }) {
  const shown = sections.map((items) => items.filter(Boolean)).filter((items) => items.length > 0);
  return (
    <>
      {shown.map((items, index) => (
        <div key={index}>
          {index > 0 ? <MenuSeparator /> : null}
          {items}
        </div>
      ))}
    </>
  );
}

/**
 * The ⋯ menu on a post: Edit and Delete for its author, Report for anyone
 * else, and pinning, removal, and banning for admins.
 */
export function PostMenu({
  post,
  onDeleted,
  onRemoved,
}: {
  post: PostCardData;
  onDeleted?: () => void;
  /** An admin removed it: lists drop it at once. */
  onRemoved?: () => void;
}) {
  const roles = useRoles(post.author.id);
  const moderation = useModeration();
  const notify = useNotify();
  const deletion = useDeletion(post.id, onDeleted);
  const reporting = useReporting("post", post.id);
  const { run } = useModerate();
  const author = roles.admin && !roles.own && post.author.username !== "[deleted]" ? post.author : null;
  const banning = useBanning(author);
  const [picking, setPicking] = useState(false);
  const editor = roles.editor;
  if (!roles.author && !roles.reporter && !roles.admin && !editor) return null;
  const pinned = moderation?.pinnedPostId === post.id;

  return (
    <>
      <Menu label="Post actions">
        <Sections
          sections={[
            roles.author
              ? [
                  <MenuItem key="edit" asChild>
                    <Link to={`/p/${post.id}/edit`}>
                      <Pencil size={16} aria-hidden /> Edit
                    </Link>
                  </MenuItem>,
                ]
              : [],
            // The guest editor's pick, while their term runs.
            editor
              ? [
                  post.editorsPick ? (
                    <MenuItem
                      key="unpick"
                      onSelect={() =>
                        run({ action: "unpick", id: post.id }, () => notify("Pick taken back."), { endpoint: "/api/pick" })
                      }
                    >
                      <Award size={16} aria-hidden /> Take back the pick
                    </MenuItem>
                  ) : (
                    <MenuItem key="pick" onSelect={() => setPicking(true)}>
                      <Award size={16} aria-hidden /> Pick as editor
                    </MenuItem>
                  ),
                ]
              : [],
            roles.reporter ? [<div key="report">{reporting.item()}</div>] : [],
            roles.admin
              ? [
                  <MenuItem
                    key="pin"
                    onSelect={() =>
                      run(pinned ? { action: "unpin" } : { action: "pin", id: post.id }, () =>
                        notify(pinned ? "Unpinned." : "Pinned above the feed as the announcement."),
                      )
                    }
                  >
                    {pinned ? <PinOff size={16} aria-hidden /> : <Pin size={16} aria-hidden />}
                    {pinned ? "Unpin" : "Pin as announcement"}
                  </MenuItem>,
                  roles.own ? null : (
                    <MenuItem
                      key="remove"
                      danger
                      onSelect={() =>
                        run(
                          { action: "remove_post", id: post.id },
                          (answer) => {
                            onRemoved?.();
                            notify("Post removed.", {
                              label: "Undo",
                              onAction: () => void run({ action: "restore", actionId: String(answer.actionId) }),
                            });
                          },
                          // A list drops the card itself and keeps what it loaded.
                          { refresh: !onRemoved },
                        )
                      }
                    >
                      <ShieldX size={16} aria-hidden /> Remove post
                    </MenuItem>
                  ),
                  <div key="ban">{banning.item()}</div>,
                ]
              : [],
            roles.author
              ? [
                  <MenuItem key="delete" danger onSelect={() => deletion.setOpen(true)}>
                    <Trash2 size={16} aria-hidden /> Delete
                  </MenuItem>,
                ]
              : [],
          ]}
        />
      </Menu>
      {reporting.dialog}
      {banning.dialog}
      {editor ? <PickDialog postId={post.id} open={picking} onOpenChange={setPicking} /> : null}
      {roles.author ? (
        <ConfirmDialog
          open={deletion.open}
          onOpenChange={deletion.setOpen}
          title="Delete this post?"
          description="It leaves the feed and your profile for good, and its link can be posted again. Its comments stay, read-only."
          confirmLabel="Delete post"
          busy={deletion.busy}
          error={deletion.error}
          onConfirm={() => deletion.submit({ intent: "delete-post" })}
        />
      ) : null}
    </>
  );
}

/**
 * The ⋯ menu on a comment: Edit and Delete for its author, Report for anyone
 * else, and removal and banning for admins.
 */
export function CommentMenu({
  postId,
  comment,
  onEdit,
  pin,
}: {
  postId: string;
  comment: CommentData;
  /** Absent where the thread is read-only: deleting is still possible. */
  onEdit?: () => void;
  /** Pinning, for the post's author's side or an admin, on a top-level comment. */
  pin?: { pinned: boolean; onSelect: () => void };
}) {
  const roles = useRoles(comment.author?.id);
  const notify = useNotify();
  const deletion = useDeletion(postId);
  const reporting = useReporting("comment", comment.id);
  const { run } = useModerate();
  const author = roles.admin && !roles.own && comment.author && comment.author.username !== "[deleted]" ? comment.author : null;
  const banning = useBanning(author);
  if (!comment.author || (!roles.author && !roles.reporter && !roles.admin && !pin)) return null;

  return (
    <>
      <Menu label="Comment actions">
        <Sections
          sections={[
            roles.author && onEdit
              ? [
                  <MenuItem key="edit" onSelect={onEdit}>
                    <Pencil size={16} aria-hidden /> Edit
                  </MenuItem>,
                ]
              : [],
            pin
              ? [
                  <MenuItem key="pin" onSelect={pin.onSelect}>
                    {pin.pinned ? <PinOff size={16} aria-hidden /> : <Pin size={16} aria-hidden />}
                    {pin.pinned ? "Unpin" : "Pin to the top"}
                  </MenuItem>,
                ]
              : [],
            roles.reporter ? [<div key="report">{reporting.item()}</div>] : [],
            roles.admin && !roles.own
              ? [
                  <MenuItem
                    key="remove"
                    danger
                    onSelect={() =>
                      run({ action: "remove_comment", id: comment.id }, (answer) =>
                        notify("Comment removed.", {
                          label: "Undo",
                          onAction: () => void run({ action: "restore", actionId: String(answer.actionId) }),
                        }),
                      )
                    }
                  >
                    <ShieldX size={16} aria-hidden /> Remove comment
                  </MenuItem>,
                  <div key="ban">{banning.item()}</div>,
                ]
              : [],
            roles.author
              ? [
                  <MenuItem key="delete" danger onSelect={() => deletion.setOpen(true)}>
                    <Trash2 size={16} aria-hidden /> Delete
                  </MenuItem>,
                ]
              : [],
          ]}
        />
      </Menu>
      {reporting.dialog}
      {banning.dialog}
      {roles.author ? (
        <ConfirmDialog
          open={deletion.open}
          onOpenChange={deletion.setOpen}
          title="Delete this comment?"
          description="It is replaced by [deleted by author] for good. Replies to it stay."
          confirmLabel="Delete comment"
          busy={deletion.busy}
          error={deletion.error}
          onConfirm={() => deletion.submit({ intent: "delete-comment", id: comment.id })}
        />
      ) : null}
    </>
  );
}

/**
 * The ⋯ menu on a profile: Report for anyone else, and for admins banning
 * or unbanning, and resetting the avatar.
 */
export function ProfileMenu({
  user,
  moderation,
}: {
  user: { id: string; username: string };
  /** Only for admins: the account's standing. */
  moderation?: { banned: boolean; admin: boolean; hasPhoto: boolean } | null;
}) {
  const roles = useRoles(user.id);
  const notify = useNotify();
  const reporting = useReporting("user", user.id);
  const { run } = useModerate();
  const banning = useBanning(roles.admin && !roles.own && moderation && !moderation.admin && !moderation.banned ? user : null);
  if (!roles.reporter && !roles.admin) return null;

  return (
    <>
      <Menu label="Profile actions">
        <Sections
          sections={[
            roles.reporter ? [<div key="report">{reporting.item("Report user")}</div>] : [],
            roles.admin && moderation
              ? [
                  moderation.banned ? (
                    <MenuItem key="unban" onSelect={() => run({ action: "unban", userId: user.id }, () => notify(`${user.username} is unbanned.`))}>
                      <Ban size={16} aria-hidden /> Unban {user.username}
                    </MenuItem>
                  ) : (
                    <div key="ban">{banning.item()}</div>
                  ),
                  moderation.hasPhoto ? (
                    <MenuItem key="avatar" onSelect={() => run({ action: "reset_avatar", userId: user.id }, () => notify("Avatar reset to the letter."))}>
                      <UserRoundX size={16} aria-hidden /> Reset avatar
                    </MenuItem>
                  ) : null,
                ]
              : [],
          ]}
        />
      </Menu>
      {reporting.dialog}
      {banning.dialog}
    </>
  );
}
