import { Check, Copy } from "lucide-react";
import { type ReactNode, useEffect, useMemo, useState } from "react";
import { Link, useRouteLoaderData } from "react-router";

import { copyText } from "~/lib/clipboard";
import { cn } from "~/lib/cn";
import { sitePath } from "~/lib/links/site-path";
import { type Block, type Inline, parseBlocks } from "~/lib/text/markdown";

import { Mention } from "./mentions";

/**
 * An outside address: shown, never followed. A tap copies it, so it can be
 * pasted somewhere on purpose. A long one is cut short with an ellipsis.
 */
function CopyUrl({ href }: { href: string }) {
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (!copied) return;
    const timer = setTimeout(() => setCopied(false), 1500);
    return () => clearTimeout(timer);
  }, [copied]);

  return (
    <button
      type="button"
      title={href}
      aria-label={`Copy link ${href}`}
      onClick={async () => setCopied(await copyText(href))}
      className="inline-flex max-w-full items-baseline gap-1 rounded-sm align-bottom text-text-muted underline decoration-dotted decoration-border-strong underline-offset-4 hover:text-text"
    >
      <span className="truncate">{href.replace(/^https?:\/\//, "")}</span>
      {copied ? (
        <Check size={13} aria-hidden className="shrink-0 self-center text-accent" />
      ) : (
        <Copy size={13} aria-hidden className="shrink-0 self-center" />
      )}
      <span role="status" className="sr-only">
        {copied ? "Link copied" : ""}
      </span>
    </button>
  );
}

const SITE_LINK = "underline decoration-border-strong underline-offset-4 hover:decoration-current";

/** True when the node at `index` has a line to itself: nothing but space around it. */
function aloneOnLine(nodes: Inline[], index: number): boolean {
  const blank = (node: Inline | undefined) => node?.type === "text" && node.text.trim() === "";
  const edge = (node: Inline | undefined) => node === undefined || node.type === "break";
  let before = index - 1;
  while (blank(nodes[before])) before -= 1;
  let after = index + 1;
  while (blank(nodes[after])) after += 1;
  return edge(nodes[before]) && edge(nodes[after]);
}

/**
 * An outside address a supporter put on a line of its own: a real link,
 * shown in full or cut short, which search engines are told not to follow.
 */
function OutsideLink({ href }: { href: string }) {
  return (
    <a
      href={href}
      target="_blank"
      rel="nofollow ugc noopener"
      referrerPolicy="strict-origin-when-cross-origin"
      title={href}
      className={cn("inline-block max-w-full truncate align-bottom", SITE_LINK)}
    >
      {href.replace(/^https?:\/\//, "")}
    </a>
  );
}

interface RenderOptions {
  host: string | undefined;
  /** Bare outside addresses alone on a line become real links. */
  outsideLinks: boolean;
}

function renderInline(nodes: Inline[], options: RenderOptions): ReactNode[] {
  const { host } = options;
  return nodes.map((node, index) => {
    switch (node.type) {
      case "text":
        return node.text;
      case "break":
        return <br key={index} />;
      case "code":
        return (
          <code key={index} className="rounded bg-surface-2 px-1 py-px font-mono text-[0.9em]">
            {node.text}
          </code>
        );
      case "strong":
        return (
          <strong key={index} className="font-semibold">
            {renderInline(node.children, options)}
          </strong>
        );
      case "em":
        return <em key={index}>{renderInline(node.children, options)}</em>;
      case "strike":
        return <del key={index}>{renderInline(node.children, options)}</del>;
      case "mention":
        return <Mention key={index} id={node.id} />;
      case "url": {
        const path = sitePath(node.href, host);
        if (path) {
          return (
            <Link key={index} to={path} className={SITE_LINK}>
              {node.href}
            </Link>
          );
        }
        return options.outsideLinks && aloneOnLine(nodes, index) ? (
          <OutsideLink key={index} href={node.href} />
        ) : (
          <CopyUrl key={index} href={node.href} />
        );
      }
      case "link": {
        const path = sitePath(node.href, host);
        if (path) {
          return (
            <Link key={index} to={path} className={SITE_LINK}>
              {renderInline(node.children, options)}
            </Link>
          );
        }
        if (!/^https?:\/\//.test(node.href)) {
          return <span key={index}>{renderInline(node.children, options)} ({node.href})</span>;
        }
        // The label, then the address it hides, so nothing is disguised.
        return (
          <span key={index}>
            {node.children.length > 0 ? <>{renderInline(node.children, options)} </> : null}
            <CopyUrl href={node.href} />
          </span>
        );
      }
    }
  });
}

function renderBlocks(blocks: Block[], options: RenderOptions): ReactNode[] {
  return blocks.map((block, index) => {
    switch (block.type) {
      case "paragraph":
        return <p key={index}>{renderInline(block.children, options)}</p>;
      case "code":
        return (
          <pre key={index} className="overflow-x-auto rounded-lg bg-surface-2 px-3 py-2 font-mono text-[0.9em] leading-snug">
            <code>{block.text}</code>
          </pre>
        );
      case "quote":
        return (
          <blockquote key={index} className="space-y-2 border-l-2 border-border-strong pl-3 text-text-muted">
            {renderBlocks(block.children, options)}
          </blockquote>
        );
      case "list": {
        const items = block.items.map((item, itemIndex) => <li key={itemIndex}>{renderInline(item, options)}</li>);
        return block.ordered ? (
          <ol key={index} start={block.start} className="list-decimal space-y-0.5 pl-6">
            {items}
          </ol>
        ) : (
          <ul key={index} className="list-disc space-y-0.5 pl-5">
            {items}
          </ul>
        );
      }
    }
  });
}

/**
 * A description or comment in the board's limited Markdown. Everything is
 * rendered as elements and text. Links to the board itself are followed;
 * any other address is shown and copied on a tap, never followed, except
 * that a supporter's bare address on a line of its own, with `outsideLinks`,
 * is a real link.
 */
export function RichText({
  text,
  className,
  outsideLinks = false,
}: {
  text: string;
  className?: string;
  outsideLinks?: boolean;
}) {
  const host = (useRouteLoaderData("root") as { host?: string } | undefined)?.host;
  const blocks = useMemo(() => parseBlocks(text), [text]);
  return (
    <div className={cn("space-y-2 text-body [overflow-wrap:anywhere]", className)}>
      {renderBlocks(blocks, { host, outsideLinks })}
    </div>
  );
}
