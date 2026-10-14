import { type ReactNode, useMemo } from "react";

import { cn } from "~/lib/cn";
import { type Block, type Inline, parseBlocks } from "~/lib/text/markdown";

function renderInline(nodes: Inline[]): ReactNode[] {
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
            {renderInline(node.children)}
          </strong>
        );
      case "em":
        return <em key={index}>{renderInline(node.children)}</em>;
    }
  });
}

function renderBlocks(blocks: Block[]): ReactNode[] {
  return blocks.map((block, index) => {
    switch (block.type) {
      case "paragraph":
        return <p key={index}>{renderInline(block.children)}</p>;
      case "code":
        return (
          <pre key={index} className="overflow-x-auto rounded-lg bg-surface-2 px-3 py-2 font-mono text-[0.9em] leading-snug">
            <code>{block.text}</code>
          </pre>
        );
      case "quote":
        return (
          <blockquote key={index} className="space-y-2 border-l-2 border-border-strong pl-3 text-text-muted">
            {renderBlocks(block.children)}
          </blockquote>
        );
      case "list": {
        const items = block.items.map((item, itemIndex) => <li key={itemIndex}>{renderInline(item)}</li>);
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
 * rendered as elements and text; links stay inert.
 */
export function RichText({ text, className }: { text: string; className?: string }) {
  const blocks = useMemo(() => parseBlocks(text), [text]);
  return (
    <div className={cn("space-y-2 text-body [overflow-wrap:anywhere]", className)}>
      {renderBlocks(blocks)}
    </div>
  );
}
