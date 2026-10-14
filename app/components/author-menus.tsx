import { Pencil, Trash2 } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { Link, useFetcher } from "react-router";

import type { AuthoringResult } from "~/lib/authoring";
import type { CommentData, PostCardData } from "~/lib/public-types";
import { useViewer } from "~/lib/use-viewer";

import { ConfirmDialog } from "./ui/confirm";
import { Menu, MenuItem, MenuSeparator } from "./ui/menu";

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

/**
 * The ⋯ menu on a post, for now only on its author's own: Edit and Delete.
 * Reporting arrives with moderation.
 */
export function PostMenu({ post, onDeleted }: { post: PostCardData; onDeleted?: () => void }) {
  const viewer = useViewer();
  const deletion = useDeletion(post.id, onDeleted);
  if (!viewer || viewer.ban || viewer.id !== post.author.id) return null;

  return (
    <>
      <Menu label="Post actions">
        <MenuItem asChild>
          <Link to={`/p/${post.id}/edit`}>
            <Pencil size={16} aria-hidden /> Edit
          </Link>
        </MenuItem>
        <MenuSeparator />
        <MenuItem danger onSelect={() => deletion.setOpen(true)}>
          <Trash2 size={16} aria-hidden /> Delete
        </MenuItem>
      </Menu>
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
    </>
  );
}

/** The ⋯ menu on a comment, for now only on its author's own. */
export function CommentMenu({
  postId,
  comment,
  onEdit,
}: {
  postId: string;
  comment: CommentData;
  /** Absent where the thread is read-only: deleting is still possible. */
  onEdit?: () => void;
}) {
  const viewer = useViewer();
  const deletion = useDeletion(postId);
  if (!viewer || viewer.ban || !comment.author || viewer.id !== comment.author.id) return null;

  return (
    <>
      <Menu label="Comment actions">
        {onEdit ? (
          <>
            <MenuItem onSelect={onEdit}>
              <Pencil size={16} aria-hidden /> Edit
            </MenuItem>
            <MenuSeparator />
          </>
        ) : null}
        <MenuItem danger onSelect={() => deletion.setOpen(true)}>
          <Trash2 size={16} aria-hidden /> Delete
        </MenuItem>
      </Menu>
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
    </>
  );
}
