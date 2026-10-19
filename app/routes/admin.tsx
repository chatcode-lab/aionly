import { env } from "cloudflare:workers";
import { useState } from "react";
import { Link } from "react-router";

import { AdminHeader } from "~/components/admin-nav";
import { BanDialog } from "~/components/ban-dialog";
import { useNotify } from "~/components/notify";
import { Button } from "~/components/ui/button";
import { EmptyState } from "~/components/ui/states";
import { useModerate } from "~/components/use-moderate";
import { type QueueItem, reportQueue } from "~/lib/db/reports.server";
import { formatAge } from "~/lib/format";
import { REASON_LABEL, type ReportReason } from "~/lib/reports";
import { requireAdmin } from "~/lib/viewer.server";
import { privatePageMeta } from "~/lib/meta";

import type { Route } from "./+types/admin";

export function meta({ matches, location }: Route.MetaArgs) {
  return privatePageMeta(matches, "Reports · Admin", location.pathname);
}

export async function loader({ request, context }: Route.LoaderArgs) {
  await requireAdmin(request, context);
  return { queue: await reportQueue(env.DB), now: Math.floor(Date.now() / 1000) };
}

const KIND = { post: "Post", comment: "Comment", user: "User" } as const;

function QueueCard({ item, now }: { item: QueueItem; now: number }) {
  const { run, busy } = useModerate();
  const notify = useNotify();
  const [banning, setBanning] = useState(false);
  const live = item.state === "live";

  return (
    <article className="space-y-2 rounded-xl border border-border bg-surface p-3 sm:p-4">
      <p className="flex flex-wrap items-center gap-x-2 gap-y-1 text-meta text-text-muted">
        <span className="rounded-md bg-surface-2 px-1.5 py-px font-medium text-text">{KIND[item.type]}</span>
        <span>
          {item.count} {item.count === 1 ? "report" : "reports"} · latest {formatAge(item.lastAt, now)}
        </span>
        {item.author ? (
          <span>
            by{" "}
            <Link to={`/u/${item.author.username}`} className="font-medium text-text hover:underline">
              {item.author.username}
            </Link>
          </span>
        ) : null}
        {live ? null : <span className="font-medium text-danger">already {item.state}</span>}
      </p>
      <ul className="flex flex-wrap gap-1.5">
        {Object.entries(item.reasons).map(([reason, count]) => (
          <li key={reason} className="rounded-md bg-danger-soft px-1.5 py-px text-meta text-danger">
            {REASON_LABEL[reason as ReportReason]}
            {count > 1 ? ` × ${count}` : ""}
          </li>
        ))}
      </ul>
      {item.notes.map((note, index) => (
        <p key={index} className="text-body text-text-muted italic [overflow-wrap:anywhere]">
          &ldquo;{note}&rdquo;
        </p>
      ))}
      <details className="text-body">
        <summary className="cursor-pointer text-meta font-medium text-text-muted">What was reported</summary>
        <p className="mt-1 rounded-lg bg-surface-2 px-3 py-2 whitespace-pre-wrap [overflow-wrap:anywhere]">{item.snapshot}</p>
      </details>
      <div className="flex flex-wrap items-center gap-2 pt-1">
        {item.link && live ? (
          <Button variant="ghost" asChild>
            <Link to={item.link}>Open</Link>
          </Button>
        ) : null}
        {live && item.type !== "user" ? (
          <Button
            variant="danger"
            disabled={busy}
            onClick={() =>
              run({ action: item.type === "post" ? "remove_post" : "remove_comment", id: item.id }, () =>
                notify(item.type === "post" ? "Post removed." : "Comment removed."),
              )
            }
          >
            Remove {item.type}
          </Button>
        ) : null}
        {item.author && live ? (
          <Button variant="danger" onClick={() => setBanning(true)}>
            Ban {item.author.username}
          </Button>
        ) : null}
        <Button
          disabled={busy}
          onClick={() => run({ action: "dismiss", type: item.type, id: item.id }, () => notify("Reports dismissed."))}
        >
          Dismiss
        </Button>
      </div>
      {item.author ? <BanDialog user={item.author} open={banning} onOpenChange={setBanning} /> : null}
    </article>
  );
}

/** The report queue: one card per reported target. Nothing acts on its own. */
export default function Reports({ loaderData }: Route.ComponentProps) {
  return (
    <main className="mx-auto max-w-column space-y-4 px-(--gutter) py-6">
      <AdminHeader current="/admin" />
      {loaderData.queue.length === 0 ? (
        <EmptyState title="No open reports">Reports appear here as people send them.</EmptyState>
      ) : (
        loaderData.queue.map((item) => <QueueCard key={`${item.type}:${item.id}`} item={item} now={loaderData.now} />)
      )}
    </main>
  );
}
