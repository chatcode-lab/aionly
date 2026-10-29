import { env } from "cloudflare:workers";
import { useEffect, useRef, useState } from "react";
import { Link, type ShouldRevalidateFunctionArgs, useLocation } from "react-router";

import { PostMenu } from "~/components/author-menus";
import { PinnedPost } from "~/components/pinned-post";
import { PostCard } from "~/components/post-card";
import { Button } from "~/components/ui/button";
import { EmptyState, Notice } from "~/components/ui/states";
import { defaultRange, newPage, postsByIds, topSnapshot } from "~/lib/db/feed.server";
import { editorPick } from "~/lib/db/editors.server";
import { announcement } from "~/lib/db/pins.server";
import { viewerMarks } from "~/lib/db/marks.server";
import {
  DEFAULT_SORT,
  feedPath,
  PAGE_SIZE,
  parseRange,
  parseSort,
  RANGE_LABEL,
  type Range,
  RANGES,
  SNAPSHOT_LIMIT,
  SORT_COOKIE,
} from "~/lib/feed";
import type { ViewerMarks } from "~/lib/participation";
import { canVoteOn } from "~/lib/participation";
import type { PostCardData } from "~/lib/public-types";
import { useParticipation } from "~/components/use-participation";
import { viewerOf } from "~/lib/viewer.server";
import { useViewer } from "~/lib/use-viewer";
import { formatDate } from "~/lib/format";
import { HOME_TITLE, pageMeta } from "~/lib/meta";
import { SITE_NAME, TAGLINE } from "~/lib/site";

import type { Route } from "./+types/home";
import { profilePath } from "~/lib/slug";

// The founder's invitation to the digest may show visitors here, as on posts.
export const handle = { feedToolbar: true, digestInvite: true };

export function meta({ matches }: Route.MetaArgs) {
  return pageMeta(matches, {
    title: HOME_TITLE,
    bare: true,
    description: `${TAGLINE.long} ${TAGLINE.promise}`,
    path: "/",
    imageAlt: `${SITE_NAME}: ${TAGLINE.long}`,
    extra: [{ tagName: "link", rel: "alternate", type: "text/markdown", href: "/index.md" }],
  });
}

export async function loader({ request, context }: Route.LoaderArgs) {
  const url = new URL(request.url);
  const now = Math.floor(Date.now() / 1000);
  const cookies = request.headers.get("Cookie") ?? "";
  const cookie = (name: string) => new RegExp(`(?:^|;\\s*)${name}=([^;]+)`).exec(cookies)?.[1];
  // The sort the address names, or the one this browser last picked.
  const sort = parseSort(url.searchParams.get("sort")) ?? parseSort(cookie(SORT_COOKIE)) ?? DEFAULT_SORT;
  const picked = parseRange(url.searchParams.get("range"));
  // Read at once, as none waits on another. With no range in the URL, the
  // board picks the narrowest one that can fill a first screen. The
  // announcement sits above the feed and is not repeated in it; a reader
  // who collapsed this pin gets it collapsed from the server, with no
  // shift. The guest editor of the running term comes with their focus and
  // latest pick.
  const [viewer, range, pin, editor] = await Promise.all([
    viewerOf(context),
    picked ?? defaultRange(env.DB, now),
    announcement(env.DB),
    editorPick(env.DB, now),
  ]);
  const pickedId = editor?.post?.id === pin?.post.id ? null : (editor?.post?.id ?? null);
  const collapsedOf = (name: string, id: string | null) => id !== null && cookie(name) === id;
  const pinnedId = pin?.post.id ?? null;
  const pinCollapsed = collapsedOf("pin_collapsed", pinnedId);
  const pickCollapsed = collapsedOf("pick_collapsed", pickedId);
  const base = { sort, range, rangePicked: picked !== null, now, pin, pinCollapsed, editor, pickedId, pickCollapsed };
  // Pinned posts are not repeated in the feed below them.
  const pinned = new Set([pinnedId, pickedId].filter((id): id is string => id !== null));

  const marks = (posts: PostCardData[]) =>
    viewerMarks(env.DB, viewer?.id ?? null, {
      posts: [...posts.map((post) => post.id), ...pinned],
    });

  if (sort === "new") {
    const page = await newPage(env.DB, range, now, null);
    const posts = page.posts.filter((post) => !pinned.has(post.id));
    return {
      ...base,
      posts,
      marks: await marks(posts),
      snapshot: null,
      nextCursor: page.nextCursor,
    };
  }

  // Top is cut from a fixed ranking, so later votes cannot skip or repeat
  // posts while someone pages through it.
  const snapshot = (await topSnapshot(env.DB, range, now)).filter((id) => !pinned.has(id));
  const posts = await postsByIds(env.DB, snapshot.slice(0, PAGE_SIZE));
  return { ...base, posts, marks: await marks(posts), snapshot, nextCursor: null };
}

type FeedData = Awaited<ReturnType<typeof loader>>;

/**
 * The card whose picture loads ahead of the rest: the first of the first
 * two a visitor sees (the announcement or the editor's pick when open, then
 * the feed) that shows more than text, a text post's preview included, as a
 * text post without one leaves the next one's picture on the first screen.
 */
function leadOf(data: FeedData): string | undefined {
  const shown = [
    ...(data.pin && !data.pinCollapsed ? [data.pin.post] : []),
    ...(data.editor?.post && data.pickedId && !data.pickCollapsed ? [data.editor.post] : []),
    ...data.posts,
  ];
  return shown.slice(0, 2).find((post) => post.media.kind !== "text" || post.preview !== undefined)?.id;
}

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
// again would drop the pages added as the reader scrolled.
export function shouldRevalidate({ formAction, defaultShouldRevalidate }: ShouldRevalidateFunctionArgs) {
  if (formAction?.startsWith("/p/")) return false;
  return defaultShouldRevalidate;
}

export async function clientLoader({ request, serverLoader }: Route.ClientLoaderArgs) {
  const url = new URL(request.url);
  // Only a Back or Forward step reuses what was loaded. Any other arrival,
  // including a reload, takes a new ranking.
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
  /** A page on its way, so a second call does not ask for it again. */
  const busy = useRef(false);
  /** Just after the last card: nearing it loads the next page, which it says while it loads. */
  const sentinel = useRef<HTMLParagraphElement>(null);

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
    if (busy.current) return;
    busy.current = true;
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
        savedComments: current.savedComments,
      }));
      // Pinned posts above the feed are not repeated in it either.
      const seen = new Set([...posts.map((post) => post.id), ...(data.pin ? [data.pin.post.id] : []), ...(data.pickedId ? [data.pickedId] : [])]);
      setExtra((current) => [
        ...current,
        ...page.posts.filter((post) => !seen.has(post.id)),
      ]);
      setOffset((current) => current + PAGE_SIZE);
      setCursor(page.nextCursor);
    } catch {
      if (mounted.current) setFailed(true);
    } finally {
      busy.current = false;
      if (mounted.current) setLoading(false);
    }
  };

  // The next page loads as the reader nears the end, a screen and a half
  // ahead, with no button to press (owner's request, 2026-10-29). Watching
  // again after each page loads it at once while the end is still near, as
  // on a tall screen; a page that failed waits for Try again.
  const loadNext = useRef(loadMore);
  loadNext.current = loadMore;
  useEffect(() => {
    const element = sentinel.current;
    if (!element || !hasMore || loading || failed) return;
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) void loadNext.current();
      },
      { rootMargin: "0px 0px 150% 0px" },
    );
    observer.observe(element);
    return () => observer.disconnect();
  }, [hasMore, loading, failed, offset]);

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
          lead={post.id === leadOf(data)}
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
      ))}

      <p ref={sentinel} role="status" className="text-center text-body text-text-muted">
        {loading ? "Loading…" : null}
      </p>
      {failed ? (
        <>
          <Notice tone="danger">More posts did not load.</Notice>
          <div className="flex justify-center pt-1">
            <Button onClick={() => void loadMore()}>Try again</Button>
          </div>
        </>
      ) : null}
      {atLimit ? (
        <p className="pt-1 text-center text-body text-text-muted">
          That is the top {SNAPSHOT_LIMIT}. Narrow the range to see others.
        </p>
      ) : null}
    </div>
  );
}

/** The announcement pinned above the feed, collapsible to one line. */
function Announcement({ data }: { data: FeedData }) {
  const pin = data.pin!;
  const participation = useParticipation(data.marks, data.now);
  const [collapsed, setCollapsed] = useState(data.pinCollapsed);
  const post = pin.post;
  return (
    <div className="mb-3">
      <PinnedPost
        label="Announcement"
        title={post.title}
        note={pin.note ?? undefined}
        collapsed={collapsed}
        onCollapsedChange={(next) => {
          setCollapsed(next);
          // Remembered per pin: a new announcement starts expanded.
          document.cookie = `pin_collapsed=${next ? post.id : ""}; path=/; max-age=31536000; samesite=lax`;
        }}
      >
        <PostCard
          post={{ ...post, score: participation.scoreOf("post", post.id, post.score) }}
          now={data.now}
          lead={post.id === leadOf(data)}
          vote={participation.voteOf("post", post.id)}
          onVote={(next) => void participation.vote("post", post.id, post.score, next)}
          canVote={canVoteOn(participation.viewer?.id, post.author)}
          saved={participation.isSaved(post.id)}
          onToggleSave={() => void participation.toggleSave(post.id)}
          menu={<PostMenu post={post} />}
        />
      </PinnedPost>
    </div>
  );
}

/**
 * The guest editor of the running term: who, until when, their focus, and
 * their latest pick, pinned and collapsible to one line.
 */
function EditorBlock({ data }: { data: FeedData }) {
  const editor = data.editor!;
  const participation = useParticipation(data.marks, data.now);
  const [collapsed, setCollapsed] = useState(data.pickCollapsed);
  const post = data.pickedId ? editor.post : null;
  return (
    <div className="mb-3 space-y-2">
      <p className="text-meta text-text-muted">
        Guest editor{" "}
        <Link to={profilePath(editor.term.username)} className="font-medium text-text hover:underline">
          {editor.term.username}
        </Link>
        , until {formatDate(editor.term.endsAt)}
        {editor.term.focus ? <span className="text-text">: {editor.term.focus}</span> : null}
      </p>
      {post ? (
        <PinnedPost
          label="Editor's pick"
          title={post.title}
          byline={editor.term.username}
          note={editor.note ?? undefined}
          collapsed={collapsed}
          onCollapsedChange={(next) => {
            setCollapsed(next);
            // Remembered per pick: a new pick starts expanded.
            document.cookie = `pick_collapsed=${next ? post.id : ""}; path=/; max-age=31536000; samesite=lax`;
          }}
        >
          <PostCard
            post={{ ...post, score: participation.scoreOf("post", post.id, post.score) }}
            now={data.now}
            lead={post.id === leadOf(data)}
            vote={participation.voteOf("post", post.id)}
            onVote={(next) => void participation.vote("post", post.id, post.score, next)}
            canVote={canVoteOn(participation.viewer?.id, post.author)}
            saved={participation.isSaved(post.id)}
            onToggleSave={() => void participation.toggleSave(post.id)}
            menu={<PostMenu post={post} />}
          />
        </PinnedPost>
      ) : null}
    </div>
  );
}

export default function Feed({ loaderData }: Route.ComponentProps) {
  // Loaded pages are kept by the address, as the client loader looks them up.
  const location = useLocation();
  const address = `${location.pathname}${location.search}`;
  const viewer = useViewer();
  // A sort the address names is the visitor's pick, kept for the bare address.
  const named = new URLSearchParams(location.search).has("sort");
  useEffect(() => {
    if (named) document.cookie = `${SORT_COOKIE}=${loaderData.sort}; path=/; max-age=31536000; samesite=lax`;
  }, [named, loaderData.sort]);

  return (
    <main className="mx-auto max-w-column px-(--gutter) py-4">
      <h1 className="sr-only">
        {loaderData.sort === "top" ? "Top" : "New"} posts,{" "}
        {RANGE_LABEL[loaderData.range].toLowerCase()}
      </h1>
      {/* What the board is, for a visitor who has not joined. */}
      {viewer ? null : (
        <p className="mb-3 text-meta text-text-muted">
          {TAGLINE.long}{" "}
          <Link to="/manifesto" className="underline underline-offset-4 hover:text-text">
            Read the manifesto
          </Link>
        </p>
      )}
      {loaderData.pin ? (
        <Announcement data={loaderData} />
      ) : null}
      {loaderData.editor ? <EditorBlock data={loaderData} /> : null}
      {/* A new ranking or a different feed starts the list afresh. */}
      <FeedList
        key={`${address}:${loaderData.now}`}
        data={loaderData}
        address={address}
      />
    </main>
  );
}
