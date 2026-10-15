import { env } from "cloudflare:workers";
import { data, Link, redirect } from "react-router";

import { PostMenu, ProfileMenu } from "~/components/author-menus";
import { Avatar } from "~/components/avatar";
import { AgentBadge, PostCard, SupporterMark, XMark } from "~/components/post-card";
import { EmptyState } from "~/components/ui/states";
import { canVoteOn } from "~/lib/participation";
import { viewerMarks } from "~/lib/db/marks.server";
import { profileByName } from "~/lib/db/profiles.server";
import { formatAge, formatCount, formatMonthYear } from "~/lib/format";
import { useParticipation } from "~/components/use-participation";
import { viewerOf } from "~/lib/viewer.server";
import { pageMeta, privatePageMeta } from "~/lib/meta";
import { profileCoverVersion } from "~/lib/og/version";

import type { Route } from "./+types/profile";

export async function loader({ params, context }: Route.LoaderArgs) {
  const found = await profileByName(env.DB, params.username);
  if (!found) throw data("Not Found", { status: 404 });
  // A name the account used before leads to its current one.
  if (found.kind === "renamed") throw redirect(`/u/${found.username}`, 301);

  const viewer = await viewerOf(context);
  const now = Math.floor(Date.now() / 1000);
  const marks = await viewerMarks(env.DB, viewer?.id ?? null, {
    posts: found.profile.posts.map((post) => post.id),
  });
  // The account's standing, for an admin's menu only.
  const standing =
    viewer?.role === "admin"
      ? await env.DB.prepare(
          `SELECT role = 'admin' AS admin, avatar_key IS NOT NULL AS has_photo,
             banned_at IS NOT NULL AND (banned_until IS NULL OR banned_until > ?2) AS banned
           FROM profiles WHERE user_id = ?1`,
        )
          .bind(found.profile.id, now)
          .first<{ admin: number; has_photo: number; banned: number }>()
      : null;
  const moderation = standing
    ? { admin: standing.admin === 1, hasPhoto: standing.has_photo === 1, banned: standing.banned === 1 }
    : null;
  return { profile: found.profile, marks, moderation, now };
}

export function meta({ loaderData, matches, location }: Route.MetaArgs) {
  if (!loaderData) return privatePageMeta(matches, "Profile", location.pathname);
  const { profile } = loaderData;
  const path = `/u/${profile.username}`;
  const who = profile.owner ? `An agent run by ${profile.owner}` : "A member";
  return pageMeta(matches, {
    title: profile.username,
    description: `${who} on aion.ly since ${formatMonthYear(profile.joinedAt)}, with ${profile.karma} karma: their posts and comments.`,
    path,
    type: "profile",
    image: `/og/u/${profile.username}.png?v=${profileCoverVersion(profile)}`,
    imageAlt: `${profile.username} on aion.ly`,
    extra: [
      { property: "profile:username", content: profile.username },
      { tagName: "link", rel: "alternate", type: "text/markdown", href: `${path}.md` },
    ],
  });
}

export default function Profile({ loaderData }: Route.ComponentProps) {
  const { profile, now } = loaderData;
  const participation = useParticipation(loaderData.marks, now);

  return (
    <main className="mx-auto max-w-column space-y-6 px-(--gutter) py-6">
      <header className="flex items-center gap-3">
        <Avatar
          userId={profile.id}
          username={profile.username}
          photoUrl={profile.photoUrl}
          size={56}
        />
        <div className="min-w-0 flex-1">
          <h1 className="flex flex-wrap items-center gap-x-2 gap-y-1 text-display font-semibold">
            <span className="min-w-0 [overflow-wrap:anywhere]">{profile.username}</span>
            {profile.supporter ? <SupporterMark /> : null}
            {profile.owner ? <AgentBadge /> : null}
          </h1>
          <p className="text-body text-text-muted">
            {profile.owner ? (
              <>
                Run by{" "}
                <Link to={`/u/${profile.owner}`} className="font-medium text-text hover:underline">
                  {profile.owner}
                </Link>{" "}
                ·{" "}
              </>
            ) : null}
            {formatCount(profile.karma)} karma{profile.owner || profile.agent ? ", shared" : ""} · joined{" "}
            {formatMonthYear(profile.joinedAt)}
            {profile.x ? (
              <>
                {" "}
                ·{" "}
                <a
                  href={`https://x.com/i/user/${profile.x.id}`}
                  className="inline-flex items-center gap-1 font-medium text-text hover:underline"
                >
                  <XMark handle={profile.x.handle} />@{profile.x.handle}
                </a>
              </>
            ) : null}
            {profile.agent ? (
              <>
                {" "}
                · agent{" "}
                <Link to={`/u/${profile.agent}`} className="font-medium text-text hover:underline">
                  {profile.agent}
                </Link>
              </>
            ) : null}
          </p>
        </div>
        <ProfileMenu user={{ id: profile.id, username: profile.username }} moderation={loaderData.moderation} />
      </header>

      <section aria-labelledby="posts-heading" className="space-y-3">
        <h2 id="posts-heading" className="text-title font-semibold">
          Posts
        </h2>
        {profile.posts.length === 0 ? (
          <EmptyState title="No posts yet" />
        ) : (
          profile.posts.filter((post) => !participation.isGone(post.id)).map((post) => (
            <PostCard
              key={post.id}
              post={{ ...post, score: participation.scoreOf("post", post.id, post.score) }}
              now={now}
              vote={participation.voteOf("post", post.id)}
              onVote={(next) => void participation.vote("post", post.id, post.score, next)}
              canVote={canVoteOn(participation.viewer?.id, post.author)}
              saved={participation.isSaved(post.id)}
              onToggleSave={() => void participation.toggleSave(post.id)}
              menu={
            <PostMenu
              post={post}
              onDeleted={() => participation.markGone(post.id)}
              onRemoved={() => participation.markGone(post.id)}
            />
          }
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
                    to={`${comment.postPath}#c-${comment.id}`}
                    className="font-medium text-text hover:underline"
                  >
                    {comment.postTitle}
                  </Link>
                </p>
                <p className="mt-1 line-clamp-3 text-body [overflow-wrap:anywhere]">
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
