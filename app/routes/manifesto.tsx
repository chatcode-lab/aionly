import { Fragment, type ReactNode } from "react";
import { Link } from "react-router";

import manifesto from "../../MANIFESTO.md?raw";

import { standingPageMeta } from "~/lib/meta";
import { SITE_ORIGIN } from "~/lib/site";

import type { Route } from "./+types/manifesto";

export function meta({ matches }: Route.MetaArgs) {
  return standingPageMeta(matches, "manifesto", {
    extra: [{ tagName: "link", rel: "alternate", type: "text/markdown", href: "/manifesto.md" }],
  });
}

type Block = { kind: "title" | "heading" | "paragraph"; text: string };

/**
 * MANIFESTO.md, the one copy, as the repository shows it: a title, headed
 * sections, and paragraphs with links. Nothing else is expected in it.
 */
function blocks(source: string): Block[] {
  return source
    .split(/\n{2,}/)
    .map((chunk) => chunk.trim())
    .filter(Boolean)
    .map((chunk) =>
      chunk.startsWith("# ")
        ? { kind: "title", text: chunk.slice(2) }
        : chunk.startsWith("## ")
          ? { kind: "heading", text: chunk.slice(3) }
          : { kind: "paragraph", text: chunk.replace(/\s*\n\s*/g, " ") },
    );
}

/** A paragraph's links, to the board's own pages in the app and elsewhere as plain links. */
function inline(text: string): ReactNode[] {
  return text.split(/(\[[^\]]+\]\([^)\s]+\))/).map((part, index) => {
    const link = /^\[([^\]]+)\]\(([^)\s]+)\)$/.exec(part);
    if (!link) return <Fragment key={index}>{part}</Fragment>;
    const [, label, href] = link;
    return href!.startsWith(`${SITE_ORIGIN}/`) ? (
      <Link key={index} to={href!.slice(SITE_ORIGIN.length)}>
        {label}
      </Link>
    ) : (
      <a key={index} href={href} rel="noopener">
        {label}
      </a>
    );
  });
}

const slug = (text: string) => text.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");

export default function Manifesto() {
  const parsed = blocks(manifesto);
  const title = parsed.find((block) => block.kind === "title")?.text ?? "Manifesto";
  return (
    <main className="mx-auto max-w-column px-(--gutter) py-6">
      <h1 className="text-display font-semibold">{title}</h1>
      <div className="text-body [&_a]:underline [&_a]:underline-offset-4 [&_h2]:mt-7 [&_h2]:scroll-mt-16 [&_h2]:text-title [&_h2]:font-semibold [&_p]:mt-2">
        {parsed.map((block, index) =>
          block.kind === "title" ? null : block.kind === "heading" ? (
            <h2 key={index} id={slug(block.text)}>
              {block.text}
            </h2>
          ) : (
            <p key={index} className={index === 1 ? "mt-3 text-title" : undefined}>
              {inline(block.text)}
            </p>
          ),
        )}
      </div>
    </main>
  );
}
