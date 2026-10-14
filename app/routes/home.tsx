import { env } from "cloudflare:workers";
import { useEffect, useRef, useState } from "react";
import { Link, type ShouldRevalidateFunctionArgs } from "react-router";

import { PostMenu } from "~/components/author-menus";
import { PostCard } from "~/components/post-card";
import { Button } from "~/components/ui/button";
import { EmptyState, Notice } from "~/components/ui/states";
import { defaultRange, newPage, postsByIds, topSnapshot } from "~/lib/db/feed.server";
import { viewerMarks } from "~/lib/db/marks.server";
import {
  feedPath,
  PAGE_SIZE,
  parseRange,
  parseSort,
  RANGE_LABEL,
  type Range,
  RANGES,
  SNAPSHOT_LIMIT,
} from "~/lib/feed";
import type { ViewerMarks } from "~/lib/participation";
import type { PostCardData } from "~/lib/public-types";
import { useParticipation } from "~/components/use-participation";
import { viewerOf } from "~/lib/viewer.server";

import type { Route } from "./+types/home";

export const handle = { feedToolbar: true };

export function meta(_: Route.MetaArgs) {
  return [
    { title: "aion.ly" },
    {
      name: "description",
      content:
        "A public board for things made with AI, and the AI news worth sharing.",
    },
  ];
}

export async function loader({ request, context }: Route.LoaderArgs) {
  const url = new URL(request.url);
  const viewer = await viewerOf(context);
  const now = Math.floor(Date.now() / 1000);
  const sort = parseSort(url.searchParams.get("sort"));
  const picked = parseRange(url.searchParams.get("range"));
  // With no range in the URL, the board picks the narrowest one that can
  // fill a first screen.
  const range = picked ?? (await defaultRange(env.DB, now));
  const base = { sort, range, rangePicked: picked !== null, now };

  const marks = (posts: PostCardData[]) =>
    viewerMarks(env.DB, viewer?.id ?? null, { posts: posts.map((post) => post.id) });

  if (sort === "new") {
    const page = await newPage(env.DB, range, now, null);
    return {
      ...base,
      posts: page.posts,
      marks: await marks(page.posts),
      snapshot: null,
      nextCursor: page.nextCursor,
    };
  }

  // Top is cut from a fixed ranking, so later votes cannot skip or repeat
  // posts while someone pages through it.
  const snapshot = await topSnapshot(env.DB, range, now);
  const posts = await postsByIds(env.DB, snapshot.slice(0, PAGE_SIZE));
  return { ...base, posts, marks: await marks(posts), snapshot, nextCursor: null };
}

type FeedData = Awaited<ReturnType<typeof loader>>;

/** What a visitor has loaded beyond the first page of one feed address. */
interface Loaded {
  data: FeedData;
  extra: PostCardData[];
  /** How many snapshot IDs Top has asked for. */
  offset: number;
  /** Where New continues from. */
  cursor: string | null;
  /** The viewer's votes and saves on the extra pages. */
  marks?: ViewerMarks;
}

// Loaded pages by feed address, so Back shows them again at once and the
// browser can restore the scroll position. Lives for the page session.
const loadedPages = new Map<string, Loaded>();
let lastPopAt = 0;
if (typeof window !== "undefined") {
  window.addEventListener("popstate", () => {
    lastPopAt = Date.now();
  });
}

// Deleting a post from the feed hides its card at once; loading the feed
// again would drop the pages added with Load more.
export function shouldRevalidate({ formAction, defaultShouldRevalidate }: ShouldRevalidateFunctionArgs) {
  if (formAction?.startsWith("/p/")) return false;
  return defaultShouldRevalidate;
}

export async function clientLoader({ request, serverLoader }: Route.ClientLoaderArgs) {
  const url = new URL(request.url);
  // Only a Back or Forward step reuses what was loaded. Any other arrival,
  // including Refresh, takes a new ranking.
  const restoring = Date.now() - lastPopAt < 1000;
  const loaded = restoring ? loadedPages.get(url.pathname + url.search) : undefined;
  return loaded ? loaded.data : await serverLoader();
}

function FeedList({ data, address }: { data: FeedData; address: string }) {
  const restored = loadedPages.get(address);
  const start: Loaded =
    restored && restored.data === data
      ? restored
      : { data, extra: [], offset: PAGE_SIZE, cursor: data.nextCursor, marks: data.marks };

  const participation = useParticipation(start.marks ?? data.marks, data.now);
  const [extra, setExtra] = useState(start.extra);
  const [offset, setOffset] = useState(start.offset);
  const [cursor, setCursor] = useState(start.cursor);
  const [loading, setLoading] = useState(false);
  const [failed, setFailed] = useState(false);
  const mounted = useRef(true);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const [marks, setMarks] = useState<ViewerMarks>(start.marks ?? data.marks);
  useEffect(() => {
    loadedPages.set(address, { data, extra, offset, cursor, marks });
  }, [address, data, extra, offset, cursor, marks]);

  const posts = [...data.posts, ...extra];
  const snapshot = data.snapshot;
  const hasMore = snapshot ? offset < snapshot.length : cursor !== null;
  const atLimit =
    snapshot !== null && !hasMore && snapshot.length >= SNAPSHOT_LIMIT;

  const loadMore = async () => {
    const query = snapshot
      ? new URLSearchParams({ ids: snapshot.slice(offset, offset + PAGE_SIZE).join(",") })
      : new URLSearchParams({ sort: "new", range: data.range, cursor: cursor ?? "" });

    setLoading(true);
    setFailed(false);
    try {
      const response = await fetch(`/feed/more?${query}`);
      if (!response.ok) throw new Error(String(response.status));
      const page = (await response.json()) as {
        posts: PostCardData[];
        nextCursor: string | null;
        marks: ViewerMarks;
      };
      if (!mounted.current) return;
      participation.absorb(page.marks);
      setMarks((current) => ({
        votes: { ...current.votes, ...page.marks.votes },
        saved: [...current.saved, ...page.marks.saved],
      }));
      const seen = new Set(posts.map((post) => post.id));
      setExtra((current) => [
        ...current,
        ...page.posts.filter((post) => !seen.has(post.id)),
      ]);
      setOffset((current) => current + PAGE_SIZE);
      setCursor(page.nextCursor);
    } catch {
      if (mounted.current) setFailed(true);
    } finally {
      if (mounted.current) setLoading(false);
    }
  };

  if (posts.length === 0) {
    const wider = RANGES[RANGES.indexOf(data.range) + 1] as Range | undefined;
    return (
      <EmptyState
        title={
          data.range === "all"
            ? "Nothing posted yet"
            : `Nothing posted ${data.range === "day" ? "today" : `this ${data.range}`}`
        }
        action={
          wider ? (
            <Button asChild>
              <Link to={feedPath(data.sort, wider)}>
                Show {RANGE_LABEL[wider].toLowerCase()}
              </Link>
            </Button>
          ) : undefined
        }
      >
        {wider ? "Try a wider range." : "The first posts will appear here."}
      </EmptyState>
    );
  }

  return (
    <div className="space-y-3">
      {posts.filter((post) => !participation.isGone(post.id)).map((post) => (
        <PostCard
          key={post.id}
          post={{ ...post, score: participation.scoreOf("post", post.id, post.score) }}
          now={data.now}
          vote={participation.voteOf("post", post.id)}
          onVote={(next) => void participation.vote("post", post.id, post.score, next)}
          canVote={participation.viewer?.id !== post.author.id}
          saved={participation.isSaved(post.id)}
          onToggleSave={() => void participation.toggleSave(post.id)}
          menu={<PostMenu post={post} onDeleted={() => participation.markGone(post.id)} />}
        />
      ))}

      {failed ? (
        <Notice tone="danger">More posts did not load. Try again.</Notice>
      ) : null}
      {hasMore ? (
        <div className="flex justify-center pt-1">
          <Button onClick={() => void loadMore()} disabled={loading}>
            {loading ? "Loading…" : "Load more"}
          </Button>
        </div>
      ) : null}
      {atLimit ? (
        <p className="pt-1 text-center text-body text-text-muted">
          That is the top {SNAPSHOT_LIMIT}. Narrow the range to see others.
        </p>
      ) : null}
    </div>
  );
}

export default function Feed({ loaderData }: Route.ComponentProps) {
  const address = feedPath(
    loaderData.sort,
    loaderData.rangePicked ? loaderData.range : null,
  ).slice(1);

  return (
    <main className="mx-auto max-w-column px-(--gutter) py-4">
      <h1 className="sr-only">
        {loaderData.sort === "top" ? "Top" : "New"} posts,{" "}
        {RANGE_LABEL[loaderData.range].toLowerCase()}
      </h1>
      {/* A new ranking or a different feed starts the list afresh. */}
      <FeedList
        key={`${address}:${loaderData.now}`}
        data={loaderData}
        address={`/${address}`}
      />
    </main>
  );
}
