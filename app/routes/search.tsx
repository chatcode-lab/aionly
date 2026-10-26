import { env } from "cloudflare:workers";
import { Fragment } from "react";
import { Link } from "react-router";

import { AuthorLine } from "~/components/post-card";
import { Button } from "~/components/ui/button";
import { EmptyState } from "~/components/ui/states";
import { searchPosts } from "~/lib/db/search.server";
import { formatCount } from "~/lib/format";
import { privatePageMeta } from "~/lib/meta";
import type { SearchHit } from "~/lib/public-types";
import { SEARCH_LIMIT, searchQuery } from "~/lib/search";

import type { Route } from "./+types/search";

// The top bar holds the search field, with what was searched for, in place
// of the feed's controls.
export const handle = { feedToolbar: true };

// Results are for visitors, not for search engines.
export function meta({ loaderData, matches }: Route.MetaArgs) {
  return privatePageMeta(matches, loaderData?.query ? `Search: ${loaderData.query}` : "Search", "/search");
}

export async function loader({ request }: Route.LoaderArgs) {
  const query = searchQuery(new URL(request.url).searchParams.get("q"));
  const now = Math.floor(Date.now() / 1000);
  const { hits, more } = query ? await searchPosts(env.DB, query, now) : { hits: [], more: false };
  return { query, hits, more, now };
}

/** Text with the words a search matched marked. */
function Marked({ pieces }: { pieces: string[] }) {
  return pieces.map((piece, index) =>
    index % 2 === 1 ? (
      <mark key={index} className="rounded-sm bg-accent-soft text-text">
        {piece}
      </mark>
    ) : (
      <Fragment key={index}>{piece}</Fragment>
    ),
  );
}

/** One post found: its title, who posted it and when, its points and comments, and where its text matched. */
function Hit({ hit, now }: { hit: SearchHit; now: number }) {
  const snippet = hit.snippet.join("") !== "";
  return (
    <article className="bleed rounded-xl border border-border bg-surface p-3 sm:p-4">
      <h2 className="text-title font-semibold [overflow-wrap:anywhere]">
        <Link to={hit.path} prefetch="intent" className="hover:underline">
          <Marked pieces={hit.title} />
        </Link>
        {hit.host ? (
          <>
            {" "}
            <span className="text-meta font-normal whitespace-nowrap text-text-faint">{hit.host}</span>
          </>
        ) : null}
      </h2>
      <div className="mt-1.5">
        <AuthorLine author={hit.author} createdAt={hit.createdAt} now={now} permalink={hit.path}>
          <span aria-hidden>·</span>
          <span>
            {formatCount(hit.score)} {Math.abs(hit.score) === 1 ? "point" : "points"}
          </span>
          <span aria-hidden>·</span>
          <span>
            {formatCount(hit.commentCount)} {hit.commentCount === 1 ? "comment" : "comments"}
          </span>
        </AuthorLine>
      </div>
      {snippet ? (
        <p className="mt-2 line-clamp-3 text-body text-text-muted [overflow-wrap:anywhere]">
          <Marked pieces={hit.snippet} />
        </p>
      ) : null}
    </article>
  );
}

/** The posts a search found, best match first, in place of the feed. */
export default function Search({ loaderData }: Route.ComponentProps) {
  const { query, hits, more, now } = loaderData;

  if (!query) {
    return (
      <main className="mx-auto max-w-column px-(--gutter) py-4">
        <h1 className="sr-only">Search</h1>
        <EmptyState title="Search posts">Find posts by the words in their title or text.</EmptyState>
      </main>
    );
  }

  if (hits.length === 0) {
    return (
      <main className="mx-auto max-w-column px-(--gutter) py-4">
        <h1 className="sr-only">Search: {query}</h1>
        <EmptyState
          title={`No posts match “${query}”`}
          action={
            <Button asChild>
              <Link to="/">Back to the feed</Link>
            </Button>
          }
        >
          Try other words, or fewer of them.
        </EmptyState>
      </main>
    );
  }

  return (
    <main className="mx-auto max-w-column px-(--gutter) py-4">
      <h1 className="mb-3 text-meta text-text-muted [overflow-wrap:anywhere]">
        {more
          ? `The ${SEARCH_LIMIT} best matches for “${query}”`
          : `${hits.length} ${hits.length === 1 ? "post matches" : "posts match"} “${query}”`}
      </h1>
      <ol className="space-y-3">
        {hits.map((hit) => (
          <li key={hit.id}>
            <Hit hit={hit} now={now} />
          </li>
        ))}
      </ol>
      {more ? (
        <p className="pt-4 text-center text-body text-text-muted">Add a word to narrow the search.</p>
      ) : null}
    </main>
  );
}
