import { Check, Copy } from "lucide-react";
import { type ReactNode, useEffect, useMemo, useState } from "react";
import { Link, useRouteLoaderData } from "react-router";

import { copyText } from "~/lib/clipboard";
import { cn } from "~/lib/cn";
import { labelIsAddress, labelNamesAddress } from "~/lib/links/label";
import { sitePath } from "~/lib/links/site-path";
import { type Block, type Inline, mailtoAddress, parseBlocks } from "~/lib/text/markdown";

import { Mention } from "./mentions";

/**
 * An outside address: shown, never followed. A tap copies it, so it can be
 * pasted somewhere on purpose. A long one is cut short with an ellipsis. With
 * `children`, a link's label of other words stands in for it.
 */
function CopyUrl({ href, email = false, words, children }: { href: string; email?: boolean; words?: string; children?: ReactNode }) {
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
      aria-label={`${words ? `${words}, copy` : "Copy"} ${email ? "email address" : "link"} ${href}`}
      onClick={async () => setCopied(await copyText(href))}
      className="inline-flex max-w-full items-baseline gap-1 rounded-sm align-bottom text-text-muted underline decoration-dotted decoration-border-strong underline-offset-4 hover:text-text"
    >
      {children === undefined ? <span className="truncate">{href.replace(/^https?:\/\//, "")}</span> : <span>{children}</span>}
      {copied ? (
        <Check size={13} aria-hidden className="shrink-0 self-center text-accent" />
      ) : (
        <Copy size={13} aria-hidden className="shrink-0 self-center" />
      )}
      <span role="status" className="sr-only">
        {copied ? (email ? "Email address copied" : "Link copied") : ""}
      </span>
    </button>
  );
}

const SITE_LINK = "underline decoration-border-strong underline-offset-4 hover:decoration-current";

/** A node's words, without their formatting. */
function plainText(nodes: Inline[]): string {
  return nodes
    .map((node) =>
      "children" in node
        ? plainText(node.children)
        : node.type === "url"
          ? node.href
          : node.type === "email"
            ? node.address
            : node.type === "text" || node.type === "code"
              ? node.text
              : "",
    )
    .join("");
}

/**
 * An outside address in a fan's text, written bare or as its own label: a
 * real link, shown in full or cut short, which search engines are told not
 * to follow.
 */
function OutsideLink({ href, children }: { href: string; children?: ReactNode }) {
  return (
    <a
      href={href}
      target="_blank"
      rel="nofollow ugc noopener"
      referrerPolicy="strict-origin-when-cross-origin"
      title={href}
      className={cn("inline-block max-w-full truncate align-bottom", SITE_LINK)}
    >
      {children ?? href.replace(/^https?:\/\//, "")}
    </a>
  );
}

/** An email address in a fan's text: a link that opens a new message to it. */
function MailLink({ address, children }: { address: string; children?: ReactNode }) {
  return (
    <a href={`mailto:${address}`} rel="nofollow ugc" title={address} className={cn("inline-block max-w-full truncate align-bottom", SITE_LINK)}>
      {children ?? address}
    </a>
  );
}

interface RenderOptions {
  host: string | undefined;
  /** A fan's outside addresses, bare or labelled with themselves, become real links. */
  outsideLinks: boolean;
  /** Inside a link: its words and formatting only, never a link or button within (review F97). */
  inLink?: boolean;
}

/**
 * A written link copied on a tap: its label of other words, which copies its
 * address (owner's request, 2026-10-20). A label that reads as an address
 * names some other one, so the real one is shown beside it to copy instead.
 */
function CopyText({ href, label, options, email = false }: { href: string; label: Inline[]; options: RenderOptions; email?: boolean }) {
  const words = plainText(label).trim();
  if (!words) return <CopyUrl href={href} email={email} />;
  if (!labelNamesAddress(words)) {
    return (
      <CopyUrl href={href} email={email} words={words}>
        {renderInline(label, { ...options, inLink: true })}
      </CopyUrl>
    );
  }
  return (
    <span>
      {renderInline(label, options)} <CopyUrl href={href} email={email} />
    </span>
  );
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
        return options.inLink ? null : <Mention key={index} id={node.id} />;
      case "email":
        if (options.inLink) return node.address;
        return options.outsideLinks ? <MailLink key={index} address={node.address} /> : <CopyUrl key={index} href={node.address} email />;
      case "url": {
        if (options.inLink) return node.href;
        const path = sitePath(node.href, host);
        if (path) {
          return (
            <Link key={index} to={path} className={SITE_LINK}>
              {node.href}
            </Link>
          );
        }
        return options.outsideLinks ? <OutsideLink key={index} href={node.href} /> : <CopyUrl key={index} href={node.href} />;
      }
      case "link": {
        if (options.inLink) return <span key={index}>{renderInline(node.children, options)}</span>;
        const path = sitePath(node.href, host);
        if (path) {
          return (
            <Link key={index} to={path} className={SITE_LINK}>
              {renderInline(node.children, { ...options, inLink: true })}
            </Link>
          );
        }
        // An email link: followed as an address is, by a fan, labelled with itself.
        const address = mailtoAddress(node.href);
        if (address) {
          const label = plainText(node.children).trim().toLowerCase();
          if (options.outsideLinks && (label === address.toLowerCase() || label === `mailto:${address.toLowerCase()}`)) {
            return (
              <MailLink key={index} address={address}>
                {renderInline(node.children, { ...options, inLink: true })}
              </MailLink>
            );
          }
          return <CopyText key={index} href={address} label={node.children} options={options} email />;
        }
        if (!/^https?:\/\//.test(node.href)) {
          return <span key={index}>{renderInline(node.children, options)} ({node.href})</span>;
        }
        // A fan's link labelled with its own address hides nothing.
        if (options.outsideLinks && labelIsAddress(plainText(node.children), node.href)) {
          return (
            <OutsideLink key={index} href={node.href}>
              {renderInline(node.children, { ...options, inLink: true })}
            </OutsideLink>
          );
        }
        return <CopyText key={index} href={node.href} label={node.children} options={options} />;
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
 * any other address, or a link's label of other words, is shown and copied
 * on a tap, never followed, except
 * that in a fan's text, with `outsideLinks`, a bare address, or a link
 * whose label is its own address, is a real link (owner's decision,
 * 2026-10-20, replacing the address alone on its line).
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
