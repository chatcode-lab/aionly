import { env } from "cloudflare:workers";
import { Link } from "react-router";

import { AdminHeader } from "~/components/admin-nav";
import { useNotify } from "~/components/notify";
import { Button } from "~/components/ui/button";
import { EmptyState } from "~/components/ui/states";
import { useModerate } from "~/components/use-moderate";
import { type LogEntry, type ModerationAction, moderationLog } from "~/lib/db/moderation.server";
import { formatAge } from "~/lib/format";
import { requireAdmin } from "~/lib/viewer.server";
import { privatePageMeta } from "~/lib/meta";

import type { Route } from "./+types/admin-log";

export function meta({ matches, location }: Route.MetaArgs) {
  return privatePageMeta(matches, "Log · Admin", location.pathname);
}

export async function loader({ request, context }: Route.LoaderArgs) {
  await requireAdmin(request, context);
  const before = Number(new URL(request.url).searchParams.get("before")) || undefined;
  return { entries: await moderationLog(env.DB, { before }), now: Math.floor(Date.now() / 1000) };
}

const VERB: Record<ModerationAction, string> = {
  remove_post: "removed the post",
  remove_comment: "removed a comment",
  remove_comments: "removed all comments by",
  discard_votes: "discarded the votes of",
  ban: "banned",
  unban: "unbanned",
  pin: "pinned",
  unpin: "unpinned",
  restore: "undid",
  set_limits: "set the posting limit of",
  reset_avatar: "reset the avatar of",
  fresh_start: "gave a fresh start to",
  purge_media: "deleted the files of",
  take_name: "took the name away from",
  pin_comment: "pinned a comment",
  unpin_comment: "took down the pinned comment of",
  set_setting: "changed the setting",
};

// What an undo undid, as a noun.
const NOUN: Partial<Record<ModerationAction, string>> = {
  remove_post: "a post removal",
  remove_comment: "a comment removal",
  remove_comments: "a removal of all of someone's comments",
  discard_votes: "a vote discard",
  ban: "a ban",
};

const UNDO_LABEL: Partial<Record<ModerationAction, string>> = {
  remove_post: "Restore post",
  remove_comment: "Restore comment",
  remove_comments: "Restore comments",
  discard_votes: "Restore votes",
  ban: "Lift this ban",
};

function Entry({ entry, now }: { entry: LogEntry; now: number }) {
  const { run, busy } = useModerate();
  const notify = useNotify();
  const target =
    entry.target.type === "action" ? (
      <span>{NOUN[entry.target.label as ModerationAction] ?? "an earlier action"}</span>
    ) : entry.target.link ? (
      <Link to={entry.target.link} className="font-medium text-text hover:underline [overflow-wrap:anywhere]">
        {entry.target.label}
      </Link>
    ) : (
      <span className="[overflow-wrap:anywhere]">{entry.target.label || "[deleted]"}</span>
    );

  return (
    <li className="flex flex-wrap items-center justify-between gap-2 p-3 sm:px-4">
      <div className="min-w-0 space-y-0.5">
        <p className="text-body">
          <span className="font-medium">{entry.actor ?? "someone"}</span> {VERB[entry.action]} {target}
        </p>
        <p className="text-meta text-text-muted">
          {formatAge(entry.at, now)}
          {entry.reason ? ` · ${entry.reason}` : ""}
          {entry.revertedAt ? ` · undone ${formatAge(entry.revertedAt, now)}` : ""}
        </p>
      </div>
      {entry.revertible ? (
        <Button
          disabled={busy}
          onClick={() => run({ action: "restore", actionId: entry.id }, () => notify("Undone."))}
        >
          {UNDO_LABEL[entry.action]}
        </Button>
      ) : null}
    </li>
  );
}

/** Every moderation step, newest first, each one undoable where it can be. */
export default function Log({ loaderData }: Route.ComponentProps) {
  const { entries, now } = loaderData;
  const last = entries.at(-1);
  return (
    <main className="mx-auto max-w-column space-y-4 px-(--gutter) py-6">
      <AdminHeader current="/admin/log" />
      {entries.length === 0 ? (
        <EmptyState title="Nothing yet">Every removal, ban, and pin is recorded here.</EmptyState>
      ) : (
        <ul className="divide-y divide-border rounded-xl border border-border bg-surface">
          {entries.map((entry) => (
            <Entry key={entry.id} entry={entry} now={now} />
          ))}
        </ul>
      )}
      {entries.length >= 100 && last ? (
        <div className="flex justify-center">
          <Button asChild>
            <Link to={`/admin/log?before=${last.at}`}>Older</Link>
          </Button>
        </div>
      ) : null}
    </main>
  );
}
