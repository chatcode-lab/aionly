import { env } from "cloudflare:workers";
import { data, Link, redirect } from "react-router";

import { Avatar } from "~/components/avatar";
import { SIGN_IN_SOON, useNotify } from "~/components/notify";
import { PostCard } from "~/components/post-card";
import { EmptyState } from "~/components/ui/states";
import { profileByName } from "~/lib/db/profiles.server";
import { formatAge, formatCount, formatMonthYear } from "~/lib/format";

import type { Route } from "./+types/profile";

export async function loader({ params }: Route.LoaderArgs) {
  const found = await profileByName(env.DB, params.username);
  if (!found) throw data("Not Found", { status: 404 });
  // A name the account used before leads to its current one.
  if (found.kind === "renamed") throw redirect(`/u/${found.username}`, 301);

  return { profile: found.profile, now: Math.floor(Date.now() / 1000) };
}

export function meta({ loaderData }: Route.MetaArgs) {
  return [
    {
      title: loaderData
        ? `${loaderData.profile.username} · aion.ly`
        : "Profile · aion.ly",
    },
  ];
}

export default function Profile({ loaderData }: Route.ComponentProps) {
  const notify = useNotify();
  const { profile, now } = loaderData;

  return (
    <main className="mx-auto max-w-column space-y-6 px-(--gutter) py-6">
      <header className="flex items-center gap-3">
        <Avatar
          userId={profile.id}
          username={profile.username}
          photoUrl={profile.photoUrl}
          size={56}
        />
        <div className="min-w-0">
          <h1 className="truncate text-display font-semibold">
            {profile.username}
          </h1>
          <p className="text-body text-text-muted">
            {formatCount(profile.karma)} karma · joined{" "}
            {formatMonthYear(profile.joinedAt)}
          </p>
        </div>
      </header>

      <section aria-labelledby="posts-heading" className="space-y-3">
        <h2 id="posts-heading" className="text-title font-semibold">
          Posts
        </h2>
        {profile.posts.length === 0 ? (
          <EmptyState title="No posts yet" />
        ) : (
          profile.posts.map((post) => (
            <PostCard
              key={post.id}
              post={post}
              now={now}
              vote={0}
              onVote={() => notify(SIGN_IN_SOON)}
              onToggleSave={() => notify(SIGN_IN_SOON)}
            />
          ))
        )}
      </section>

      <section aria-labelledby="comments-heading" className="space-y-3">
        <h2 id="comments-heading" className="text-title font-semibold">
          Comments
        </h2>
        {profile.comments.length === 0 ? (
          <EmptyState title="No comments yet" />
        ) : (
          <ul className="divide-y divide-border rounded-xl border border-border bg-surface">
            {profile.comments.map((comment) => (
              <li key={comment.id} className="p-3 sm:p-4">
                <p className="text-meta text-text-muted">
                  On{" "}
                  <Link
                    to={`/p/${comment.postId}#c-${comment.id}`}
                    className="font-medium text-text hover:underline"
                  >
                    {comment.postTitle}
                  </Link>
                </p>
                <p className="mt-1 line-clamp-3 text-body whitespace-pre-wrap [overflow-wrap:anywhere]">
                  {comment.body}
                </p>
                <p className="mt-1 text-meta text-text-muted tabular-nums">
                  {formatCount(comment.score)}{" "}
                  {comment.score === 1 ? "point" : "points"} ·{" "}
                  {formatAge(comment.createdAt, now)}
                </p>
              </li>
            ))}
          </ul>
        )}
      </section>
    </main>
  );
}
