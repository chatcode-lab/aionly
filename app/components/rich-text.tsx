import { Check, Copy } from "lucide-react";
import { type ReactNode, useEffect, useMemo, useState } from "react";
import { Link, useRouteLoaderData } from "react-router";

import { copyText } from "~/lib/clipboard";
import { cn } from "~/lib/cn";
import { type Block, type Inline, parseBlocks } from "~/lib/text/markdown";

import { Mention } from "./mentions";

// The board's own addresses, followed as links wherever they appear.
const SITE_HOSTS = ["aion.ly", "www.aion.ly"];

/** The path for an address on the board itself, or null for anywhere else. */
export function sitePath(href: string, currentHost: string | undefined): string | null {
  if (href.startsWith("/") && !href.startsWith("//")) return href;
  try {
    const url = new URL(href);
    const own = SITE_HOSTS.includes(url.host) || url.host === currentHost;
    const secure = url.protocol === "https:" || (url.protocol === "http:" && url.host === currentHost);
    return own && secure ? `${url.pathname}${url.search}${url.hash}` : null;
  } catch {
    return null;
  }
}

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

function renderInline(nodes: Inline[], host: string | undefined): ReactNode[] {
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
            {renderInline(node.children, host)}
          </strong>
        );
      case "em":
        return <em key={index}>{renderInline(node.children, host)}</em>;
      case "strike":
        return <del key={index}>{renderInline(node.children, host)}</del>;
      case "mention":
        return <Mention key={index} id={node.id} />;
      case "url": {
        const path = sitePath(node.href, host);
        return path ? (
          <Link key={index} to={path} className={SITE_LINK}>
            {node.href}
          </Link>
        ) : (
          <CopyUrl key={index} href={node.href} />
        );
      }
      case "link": {
        const path = sitePath(node.href, host);
        if (path) {
          return (
            <Link key={index} to={path} className={SITE_LINK}>
              {renderInline(node.children, host)}
            </Link>
          );
        }
        if (!/^https?:\/\//.test(node.href)) {
          return <span key={index}>{renderInline(node.children, host)} ({node.href})</span>;
        }
        // The label, then the address it hides, so nothing is disguised.
        return (
          <span key={index}>
            {node.children.length > 0 ? <>{renderInline(node.children, host)} </> : null}
            <CopyUrl href={node.href} />
          </span>
        );
      }
    }
  });
}

function renderBlocks(blocks: Block[], host: string | undefined): ReactNode[] {
  return blocks.map((block, index) => {
    switch (block.type) {
      case "paragraph":
        return <p key={index}>{renderInline(block.children, host)}</p>;
      case "code":
        return (
          <pre key={index} className="overflow-x-auto rounded-lg bg-surface-2 px-3 py-2 font-mono text-[0.9em] leading-snug">
            <code>{block.text}</code>
          </pre>
        );
      case "quote":
        return (
          <blockquote key={index} className="space-y-2 border-l-2 border-border-strong pl-3 text-text-muted">
            {renderBlocks(block.children, host)}
          </blockquote>
        );
      case "list": {
        const items = block.items.map((item, itemIndex) => <li key={itemIndex}>{renderInline(item, host)}</li>);
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
 * any other address is shown and copied on a tap, never followed.
 */
export function RichText({ text, className }: { text: string; className?: string }) {
  const host = (useRouteLoaderData("root") as { host?: string } | undefined)?.host;
  const blocks = useMemo(() => parseBlocks(text), [text]);
  return (
    <div className={cn("space-y-2 text-body [overflow-wrap:anywhere]", className)}>
      {renderBlocks(blocks, host)}
    </div>
  );
}
